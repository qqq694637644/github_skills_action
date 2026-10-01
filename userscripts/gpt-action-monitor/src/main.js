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
  saveEndpoints,
  saveGlobalActiveEndpointId,
} from './profile/profile-store.js';
import { createMonitorPanel } from './ui/monitor-panel.js';
import { createSettingsPanel } from './ui/settings-panel.js';
import { createSkillsMenu } from './ui/skills-menu.js';
import { createWorkspaceMenu } from './ui/workspace-menu.js';

(function () {
  'use strict';

  let endpoints = loadEndpoints();
  let globalActiveEndpointId = loadGlobalActiveEndpointId();
  let localActiveEndpointId = null;
  let activeWorkspaceId = null;
  let monitorMounted = false;
  let actionLogClient = null;
  let activitySessionKey = null;
  let activitySessionCursor = null;

  function getEffectiveEndpointId() {
    return localActiveEndpointId ?? globalActiveEndpointId;
  }

  function getEffectiveEndpoint() {
    return getEndpoint(endpoints, getEffectiveEndpointId());
  }

  function connectionSignature(endpoint) {
    if (!endpoint) return '';
    return `${endpoint.id}\u0000${endpoint.backend}\u0000${endpoint.token}`;
  }

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
  });
  monitorUi = createMonitorPanel({
    activityStore,
    isActive: () => monitorMounted && Boolean(activeWorkspaceId),
    skillsMenu,
    workspaceMenu,
  });

  function stopActionLog() {
    if (!actionLogClient) return;
    const cursor = actionLogClient.getCursor?.();
    if (Number.isInteger(cursor)) activitySessionCursor = cursor;
    actionLogClient.stop();
    actionLogClient = null;
  }

  function resetWorkspaceStream() {
    stopActionLog();
    activityStore.clear();
    activitySessionKey = null;
    activitySessionCursor = null;
    monitorUi.resetSession();
    monitorUi.clearAttention();
    monitorUi.setStatus('idle');
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

    resetWorkspaceStream();
    activeWorkspaceId = workspaceId;
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
    if (
      localActiveEndpointId
      && !endpoints.some((endpoint) => endpoint.id === localActiveEndpointId)
    ) {
      localActiveEndpointId = null;
    }
    reconcileEffectiveEndpoint(previousSignature);
  }

  function setGlobalActiveEndpoint(endpointId) {
    if (!getEndpoint(endpoints, endpointId)) throw new Error('请先保存这个接口配置。');
    const previousSignature = connectionSignature(getEffectiveEndpoint());
    globalActiveEndpointId = saveGlobalActiveEndpointId(endpointId);
    localActiveEndpointId = null;
    reconcileEffectiveEndpoint(previousSignature);
  }

  function useLocalEndpoint(endpointId) {
    if (!getEndpoint(endpoints, endpointId)) throw new Error('请先保存这个接口配置。');
    const previousSignature = connectionSignature(getEffectiveEndpoint());
    localActiveEndpointId = endpointId;
    reconcileEffectiveEndpoint(previousSignature);
  }

  function restoreGlobalEndpoint() {
    const previousSignature = connectionSignature(getEffectiveEndpoint());
    localActiveEndpointId = null;
    reconcileEffectiveEndpoint(previousSignature);
  }

  const settingsPanel = createSettingsPanel({
    getState: () => ({
      endpoints,
      globalActiveEndpointId,
      localActiveEndpointId,
      effectiveEndpointId: getEffectiveEndpointId(),
    }),
    onSaveEndpoints: saveEndpointLibrary,
    onSetGlobalEndpoint: setGlobalActiveEndpoint,
    onUseLocalEndpoint: useLocalEndpoint,
    onRestoreGlobalEndpoint: restoreGlobalEndpoint,
  });

  function startActionLog() {
    const profile = getEffectiveEndpoint();
    if (!monitorMounted || actionLogClient || !profile?.backend || !activeWorkspaceId) return;

    const nextSessionKey = `${profile.id}:${profile.backend}:${activeWorkspaceId}`;
    if (activitySessionKey !== nextSessionKey) {
      activityStore.clear();
      activitySessionKey = nextSessionKey;
      activitySessionCursor = null;
    }

    actionLogClient = createActionLogClient({
      getProfile: getEffectiveEndpoint,
      getWorkspaceId: () => activeWorkspaceId,
      initialCursor: activitySessionCursor,
      onCursor: (cursor) => { activitySessionCursor = cursor; },
      onItems(items) {
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

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
    else suspend();
  });

  if (document.visibilityState === 'visible') activateMonitor();
})();
