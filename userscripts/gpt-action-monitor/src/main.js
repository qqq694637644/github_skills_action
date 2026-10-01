import { createActivityStore } from './activity/activity-store.js';
import { compactActivity } from './activity/presentation.js';
import { createActionLogClient } from './api/action-log-client.js';
import { createSkillCatalogClient } from './api/skill-catalog-client.js';
import { createWorkspaceClient } from './api/workspace-client.js';
import { createComposerAdapter, loadSkillsCall } from './adapters/composer.js';
import { getEndpoint, loadConfig, saveConfig } from './profile/profile-store.js';
import { createMonitorPanel } from './ui/monitor-panel.js';
import { createSettingsPanel } from './ui/settings-panel.js';
import { createSkillsMenu } from './ui/skills-menu.js';
import { createWorkspaceMenu } from './ui/workspace-menu.js';

(function () {
  'use strict';

  let config = loadConfig();
  let localEndpointId = null;
  let activeWorkspaceId = null;
  let monitorMounted = false;
  let actionLogClient = null;
  let activitySessionKey = null;
  let activitySessionCursor = null;

  function getActiveEndpoint() {
    return getEndpoint(config, localEndpointId)
      || getEndpoint(config, config.selectedEndpointId)
      || config.endpoints[0]
      || null;
  }

  const composerAdapter = createComposerAdapter();
  const skillCatalogClient = createSkillCatalogClient({
    getProfile: getActiveEndpoint,
  });
  const workspaceClient = createWorkspaceClient({
    getProfile: getActiveEndpoint,
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

  function applySettings({ nextConfig, selectedEndpointId, scope }) {
    const previousEndpoint = getActiveEndpoint();
    const persisted = {
      ...nextConfig,
      selectedEndpointId: scope === 'global'
        ? selectedEndpointId
        : config.selectedEndpointId,
    };
    config = saveConfig(persisted);
    localEndpointId = scope === 'local' ? selectedEndpointId : null;
    const nextEndpoint = getActiveEndpoint();
    const endpointChanged = previousEndpoint?.id !== nextEndpoint?.id
      || previousEndpoint?.backend !== nextEndpoint?.backend;

    deactivateMonitor();
    if (endpointChanged) {
      activeWorkspaceId = null;
      activityStore.clear();
      activitySessionKey = null;
      activitySessionCursor = null;
      workspaceClient.clear();
      workspaceMenu.reset();
    }
    if (document.visibilityState === 'visible') activateMonitor();
  }

  const settingsPanel = createSettingsPanel({
    getState: () => ({
      config,
      activeEndpointId: getActiveEndpoint()?.id || '',
      localEndpointId,
    }),
    onApplySettings: applySettings,
  });

  function startActionLog() {
    const profile = getActiveEndpoint();
    if (!monitorMounted || actionLogClient || !profile?.backend || !activeWorkspaceId) return;

    const nextSessionKey = `${profile.id}:${profile.backend}:${activeWorkspaceId}`;
    if (activitySessionKey !== nextSessionKey) {
      activityStore.clear();
      activitySessionKey = nextSessionKey;
      activitySessionCursor = null;
    }

    actionLogClient = createActionLogClient({
      getProfile: getActiveEndpoint,
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
    const profile = getActiveEndpoint();
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
