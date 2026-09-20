import { summarize } from './formatter/action-formatter.js';
import { createActionLogClient } from './api/action-log-client.js';
import { createChatGPTAdapter } from './adapters/chatgpt.js';
import { createEventStore } from './store/event-store.js';
import { loadProfiles, saveProfiles } from './profile/profile-store.js';
import { createMonitorPanel } from './ui/monitor-panel.js';
import { createSettingsPanel } from './ui/settings-panel.js';

(function () {
  'use strict';

  let profiles = loadProfiles();
  let monitorActive = false;
  let activeProfile = null;
  let actionLogClient = null;
  let chatAdapter = null;

  const eventStore = createEventStore();
  const monitorUi = createMonitorPanel({
    eventStore,
    isActive: () => monitorActive,
  });

  function deactivateMonitor() {
    if (!monitorActive) return;
    monitorActive = false;
    activeProfile = null;
    actionLogClient?.stop();
    actionLogClient = null;
    eventStore.clear();
    monitorUi.unmount();
  }

  function applyProfiles(nextProfiles) {
    profiles = saveProfiles(nextProfiles);
    deactivateMonitor();
    if (document.visibilityState === 'visible') chatAdapter?.evaluateActivation();
  }

  const settingsPanel = createSettingsPanel({
    getProfiles: () => profiles,
    onApplyProfiles: applyProfiles,
  });

  function activateMonitor(_titleElement, profile) {
    if (monitorActive && activeProfile?.id === profile.id) {
      activeProfile = profile;
      return;
    }
    if (monitorActive) deactivateMonitor();

    monitorActive = true;
    activeProfile = profile;
    eventStore.clear();
    monitorUi.mount();
    monitorUi.setStatus('idle');

    actionLogClient = createActionLogClient({
      getProfile: () => activeProfile,
      onItems(items) {
        let newest = null;
        for (const item of items) {
          newest = summarize(item.text);
          monitorUi.recordEvent(newest);
        }
        if (newest) monitorUi.queueActivity(newest);
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

  chatAdapter = createChatGPTAdapter({
    getProfiles: () => profiles,
    onActivate: activateMonitor,
    onDeactivate: deactivateMonitor,
  });

  function suspend() {
    actionLogClient?.suspend();
    monitorUi.suspendActivity();
  }

  function resume() {
    if (!monitorActive) return;
    monitorUi.resumeActivity();
    actionLogClient?.resume();
  }

  GM_registerMenuCommand('⚙ 监控配置...', settingsPanel.open);

  window.addEventListener('resize', () => {
    if (monitorActive) monitorUi.keepInViewport();
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      chatAdapter.start();
      resume();
    } else {
      chatAdapter.stop();
      suspend();
    }
  });

  if (document.visibilityState === 'visible') chatAdapter.start();
})();
