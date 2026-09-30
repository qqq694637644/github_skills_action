import { createActivityStore } from './activity/activity-store.js';
import { compactActivity } from './activity/presentation.js';
import { createActionLogClient } from './api/action-log-client.js';
import { createSkillCatalogClient } from './api/skill-catalog-client.js';
import { createComposerAdapter, loadSkillsCall } from './adapters/composer.js';
import { loadProfile, saveProfile } from './profile/profile-store.js';
import { createMonitorPanel } from './ui/monitor-panel.js';
import { createSettingsPanel } from './ui/settings-panel.js';
import { createSkillsMenu } from './ui/skills-menu.js';

(function () {
  'use strict';

  let profile = loadProfile();
  let monitorActive = false;
  let actionLogClient = null;
  let activitySessionKey = null;
  let activitySessionCursor = null;
  const composerAdapter = createComposerAdapter();
  const skillCatalogClient = createSkillCatalogClient({
    getProfile: () => profile,
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
  monitorUi = createMonitorPanel({
    activityStore,
    isActive: () => monitorActive,
    skillsMenu,
  });

  function deactivateMonitor() {
    if (!monitorActive) return;
    const cursor = actionLogClient?.getCursor?.();
    if (Number.isInteger(cursor)) activitySessionCursor = cursor;
    monitorActive = false;
    actionLogClient?.stop();
    actionLogClient = null;
    skillsMenu.close();
    monitorUi.unmount();
  }

  function applyProfile(nextProfile) {
    profile = saveProfile(nextProfile);
    deactivateMonitor();
    if (document.visibilityState === 'visible') activateMonitor();
  }

  const settingsPanel = createSettingsPanel({
    getProfile: () => profile,
    onApplyProfile: applyProfile,
  });

  function activateMonitor() {
    if (monitorActive || !profile?.backend) return;

    monitorActive = true;
    const nextSessionKey = profile.backend;
    if (activitySessionKey !== nextSessionKey) {
      activityStore.clear();
      activitySessionKey = nextSessionKey;
      activitySessionCursor = null;
    }
    monitorUi.mount();
    monitorUi.setStatus('idle');

    actionLogClient = createActionLogClient({
      getProfile: () => profile,
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

  function suspend() {
    actionLogClient?.suspend();
    monitorUi.suspendActivity();
  }

  function resume() {
    if (!monitorActive) {
      activateMonitor();
      return;
    }
    monitorUi.resumeActivity();
    const active = activityStore.snapshot().active.at(0);
    if (active) monitorUi.queueActivity(compactActivity(active));
    actionLogClient?.resume();
  }

  GM_registerMenuCommand('⚙ 监控配置...', settingsPanel.open);

  window.addEventListener('resize', () => {
    if (monitorActive) monitorUi.keepInViewport();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resume();
    else suspend();
  });

  if (document.visibilityState === 'visible') activateMonitor();
})();
