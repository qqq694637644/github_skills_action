import { createActivityStore } from './activity/activity-store.js';
import { compactActivity } from './activity/presentation.js';
import { createActionLogClient } from './api/action-log-client.js';
import { createSkillCatalogClient } from './api/skill-catalog-client.js';
import { createWorkspaceClient } from './api/workspace-client.js';
import { createComposerAdapter, loadSkillsCall } from './adapters/composer.js';
import {
  getEndpoint,
  loadEndpoints,
  loadGlobalActiveEndpointId,
  loadPageBinding,
  prunePageBindings,
  saveEndpoints,
  saveGlobalActiveEndpointId,
  savePageBinding,
} from './profile/profile-store.js';
import { createMonitorPanel } from './ui/monitor-panel.js';
import { createSettingsPanel } from './ui/settings-panel.js';
import { createSkillsMenu } from './ui/skills-menu.js';
import { createWorkspaceMenu } from './ui/workspace-menu.js';

(function () {
  'use strict';

  let endpoints = loadEndpoints();
  let globalActiveEndpointId = loadGlobalActiveEndpointId();
  let currentPageUrl = pageUrl();
  let pageActiveEndpointId = null;
  let activeWorkspaceId = null;
  let monitorMounted = false;
  let actionLogClient = null;
  let activitySessionKey = null;
  let activitySessionCursor = null;

  function pageUrl() {
    const pathname = window.location.pathname.length > 1
      ? window.location.pathname.replace(/\/+$/, '')
      : window.location.pathname;
    return `${window.location.origin}${pathname}`;
  }

  function getEffectiveEndpointId() {
    return pageActiveEndpointId || globalActiveEndpointId;
  }

  function getEffectiveEndpoint() {
    return getEndpoint(endpoints, getEffectiveEndpointId());
  }

  function connectionSignature(endpoint) {
    if (!endpoint) return '';
    return `${endpoint.id}\u0000${endpoint.backend}\u0000${endpoint.token}`;
  }

  function persistCurrentPageBinding() {
    const endpoint = getEffectiveEndpoint();
    savePageBinding(currentPageUrl, {
      endpointId: pageActiveEndpointId || '',
      workspaceId: activeWorkspaceId || '',
      workspaceEndpointId: activeWorkspaceId ? endpoint?.id || '' : '',
    });
  }

  function loadCurrentPageBinding() {
    const binding = loadPageBinding(currentPageUrl);
    pageActiveEndpointId = binding?.endpointId && getEndpoint(endpoints, binding.endpointId)
      ? binding.endpointId
      : null;
    const endpoint = getEffectiveEndpoint();
    activeWorkspaceId = binding?.workspaceId
      && binding.workspaceEndpointId === endpoint?.id
      ? binding.workspaceId
      : null;
  }

  loadCurrentPageBinding();

  const composerAdapter = createComposerAdapter();
  const skillCatalogClient = createSkillCatalogClient({
    getProfile: getEffectiveEndpoint,
  });
  const workspaceClient = createWorkspaceClient({
    getProfile: getEffectiveEndpoint,
  });

  const activityStore = createActivityStore();
  let monitorUi = null;
  const skillsMenu = createSkillsMenu({
    loadSkills: (options) => skillCatalogClient.list(options),
    onBeforeOpen: () => composerAdapter.captureSelection(),
    onSelect(skill) {
      const inserted = composerAdapter.insertText(loadSkillsCall(skill.skill_id));
      if (!inserted) {
        monitorUi?.showAttention('插入失败', '未找到 ChatGPT 输入框');
      }
      return inserted;
    },
  });
  const workspaceMenu = createWorkspaceMenu({
    loadWorkspaces: (options) => workspaceClient.list(options),
    getSelectedId: () => activeWorkspaceId,
    onSelect: selectWorkspace,
    onReset: resetWorkspaceSelection,
  });
  monitorUi = createMonitorPanel({
    activityStore,
    isActive: () => monitorMounted,
    skillsMenu,
    workspaceMenu,
    onSelectWorkspace: selectWorkspace,
  });

  function stopActionLog() {
    if (!actionLogClient) return;
    const cursor = actionLogClient.getCursor?.();
    if (Number.isInteger(cursor)) activitySessionCursor = cursor;
    actionLogClient.stop();
    actionLogClient = null;
  }

  function resetWorkspaceStream({ preserveCursor = false } = {}) {
    stopActionLog();
    activityStore.clear();
    activitySessionKey = null;
    if (!preserveCursor) activitySessionCursor = null;
    monitorUi.resetSession();
    monitorUi.clearLastActivityTime();
    monitorUi.clearAttention();
    monitorUi.setStatus('idle');
  }

  function latestEventTimestamp(items) {
    let latest = '';
    let latestTime = -Infinity;
    for (const item of items || []) {
      const timestamp = item?.event?.timestamp;
      if (!timestamp) continue;
      const parsed = Date.parse(timestamp);
      if (!Number.isFinite(parsed) || parsed < latestTime) continue;
      latest = timestamp;
      latestTime = parsed;
    }
    return latest;
  }

  function resetEffectiveEndpointContext() {
    resetWorkspaceStream();
    activeWorkspaceId = null;
    workspaceClient.clear();
    workspaceMenu.reset();
    skillsMenu.close();
  }

  function reconcileEffectiveEndpoint(previousSignature) {
    const nextEndpoint = getEffectiveEndpoint();
    const changed = connectionSignature(nextEndpoint) !== previousSignature;

    if (changed) resetEffectiveEndpointContext();

    if (!nextEndpoint?.backend) {
      deactivateMonitor();
      return;
    }
    if (document.visibilityState === 'visible') activateMonitor();
  }

  function selectWorkspace(workspaceId) {
    if (!/^ws_[0-9a-f]{16}$/.test(workspaceId)) return false;
    if (workspaceId === activeWorkspaceId) {
      workspaceMenu.updateTrigger();
      return true;
    }

    const fromDiscovery = !activeWorkspaceId;
    resetWorkspaceStream({ preserveCursor: fromDiscovery });
    activeWorkspaceId = workspaceId;
    persistCurrentPageBinding();
    workspaceMenu.updateTrigger();
    if (monitorMounted && document.visibilityState === 'visible') startActionLog();
    return true;
  }

  function resetWorkspaceSelection() {
    if (!activeWorkspaceId) return true;
    resetWorkspaceStream({ preserveCursor: true });
    activeWorkspaceId = null;
    persistCurrentPageBinding();
    workspaceMenu.updateTrigger();
    if (monitorMounted && document.visibilityState === 'visible') startActionLog();
    return true;
  }

  function deactivateMonitor() {
    stopActionLog();
    if (!monitorMounted) return;
    monitorMounted = false;
    skillsMenu.close();
    workspaceMenu.close();
    monitorUi.unmount();
  }

  function saveEndpointLibrary(nextEndpoints) {
    const previousSignature = connectionSignature(getEffectiveEndpoint());
    if (
      globalActiveEndpointId
      && !nextEndpoints.some((endpoint) => endpoint.id === globalActiveEndpointId)
    ) {
      throw new Error('不能删除当前全局默认接口，请先将其他接口设为全局默认。');
    }

    endpoints = saveEndpoints(nextEndpoints);
    prunePageBindings(endpoints.map((endpoint) => endpoint.id));
    if (
      pageActiveEndpointId
      && !endpoints.some((endpoint) => endpoint.id === pageActiveEndpointId)
    ) {
      pageActiveEndpointId = null;
    }
    reconcileEffectiveEndpoint(previousSignature);
    persistCurrentPageBinding();
  }

  function setGlobalActiveEndpoint(endpointId) {
    if (!getEndpoint(endpoints, endpointId)) throw new Error('请先保存这个接口配置。');
    const previousSignature = connectionSignature(getEffectiveEndpoint());
    globalActiveEndpointId = saveGlobalActiveEndpointId(endpointId);
    reconcileEffectiveEndpoint(previousSignature);
    persistCurrentPageBinding();
  }

  function usePageEndpoint(endpointId) {
    if (!getEndpoint(endpoints, endpointId)) throw new Error('请先保存这个接口配置。');
    const previousSignature = connectionSignature(getEffectiveEndpoint());
    pageActiveEndpointId = endpointId;
    reconcileEffectiveEndpoint(previousSignature);
    persistCurrentPageBinding();
  }

  function restoreGlobalEndpoint() {
    const previousSignature = connectionSignature(getEffectiveEndpoint());
    pageActiveEndpointId = null;
    reconcileEffectiveEndpoint(previousSignature);
    persistCurrentPageBinding();
  }

  const settingsPanel = createSettingsPanel({
    getState: () => ({
      endpoints,
      globalActiveEndpointId,
      pageActiveEndpointId,
      effectiveEndpointId: getEffectiveEndpointId(),
      pageUrl: currentPageUrl,
    }),
    onSaveEndpoints: saveEndpointLibrary,
    onSetGlobalEndpoint: setGlobalActiveEndpoint,
    onUsePageEndpoint: usePageEndpoint,
    onRestoreGlobalEndpoint: restoreGlobalEndpoint,
  });

  function handlePageNavigation() {
    const nextPageUrl = pageUrl();
    if (nextPageUrl === currentPageUrl) return;

    resetWorkspaceStream();
    activeWorkspaceId = null;
    workspaceClient.clear();
    workspaceMenu.reset();
    skillsMenu.close();
    settingsPanel.close();

    currentPageUrl = nextPageUrl;
    loadCurrentPageBinding();
    workspaceMenu.updateTrigger();

    if (!getEffectiveEndpoint()?.backend) {
      deactivateMonitor();
      return;
    }
    if (document.visibilityState === 'visible') activateMonitor();
  }

  function startActionLog() {
    const profile = getEffectiveEndpoint();
    if (!monitorMounted || actionLogClient || !profile?.backend) return;

    const nextSessionKey = `${profile.id}:${profile.backend}:${activeWorkspaceId || 'discovery'}`;
    if (activitySessionKey !== nextSessionKey) {
      activityStore.clear();
      activitySessionKey = nextSessionKey;
    }

    actionLogClient = createActionLogClient({
      getProfile: getEffectiveEndpoint,
      getWorkspaceId: () => activeWorkspaceId,
      initialCursor: activitySessionCursor,
      onCursor: (cursor) => { activitySessionCursor = cursor; },
      onItems(items) {
        const latestTimestamp = latestEventTimestamp(items);
        if (latestTimestamp) monitorUi.setLastActivityTimestamp(latestTimestamp);
        const newest = activityStore.ingest(items);
        if (newest) {
          monitorUi.clearHint();
          monitorUi.queueActivity(compactActivity(newest));
        }
        else if (monitorUi.getStatus() === 'error') monitorUi.clearAttention();
      },
      onHint: (message) => monitorUi.recordHint(message),
      onAttention: (action, detail) => monitorUi.showAttention(action, detail),
      onStatus(status) {
        monitorUi.setStatus(status);
      },
    });

    if (document.visibilityState === 'visible') actionLogClient.start();
  }

  function activateMonitor() {
    const profile = getEffectiveEndpoint();
    if (!profile?.backend) return;

    if (!monitorMounted) {
      monitorMounted = true;
      monitorUi.mount();
      monitorUi.setStatus('idle');
      workspaceMenu.updateTrigger();
    }
    startActionLog();
  }

  function suspend() {
    actionLogClient?.suspend();
    monitorUi.suspendActivity();
  }

  function resume() {
    if (!monitorMounted) {
      activateMonitor();
      return;
    }
    monitorUi.resumeActivity();
    const active = activityStore.snapshot().active.at(0);
    if (active) monitorUi.queueActivity(compactActivity(active));
    if (actionLogClient) actionLogClient.resume();
    else startActionLog();
  }

  GM_registerMenuCommand('⚙ 监控配置...', settingsPanel.open);

  window.addEventListener('resize', () => {
    if (monitorMounted) monitorUi.keepInViewport();
  });
  window.navigation?.addEventListener?.('navigatesuccess', handlePageNavigation);
  window.addEventListener('popstate', handlePageNavigation);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
    else suspend();
  });

  if (document.visibilityState === 'visible') activateMonitor();
})();
