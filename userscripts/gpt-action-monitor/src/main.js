import { createActivityStore } from './activity/activity-store.js';
import { compactActivity } from './activity/presentation.js';
import { createActionLogClient } from './api/action-log-client.js';
import { createActionLogSessionState } from './api/action-log-session.js';
import { createSkillCatalogClient } from './api/skill-catalog-client.js';
import { createWorkspaceClient } from './api/workspace-client.js';
import { createComposerAdapter, loadSkillsCall } from './adapters/composer.js';
import { createSoundAlert } from './alert/sound-alert.js';
import { debugLog, debugWarn, summarizeActionItems } from './debug.js';
import {
  DEFAULT_SOUND_ALERT_DELAY_MINUTES,
  DEFAULT_SOUND_ALERT_DURATION_SECONDS,
  MAX_SOUND_ALERT_DELAY_MINUTES,
  MAX_SOUND_ALERT_DURATION_SECONDS,
  MIN_SOUND_ALERT_DELAY_MINUTES,
  MIN_SOUND_ALERT_DURATION_SECONDS,
  SOUND_ALERT_DELAY_MINUTES_KEY,
  SOUND_ALERT_DURATION_SECONDS_KEY,
  SOUND_ALERT_ENABLED_KEY,
} from './constants.js';
import {
  deletePageBinding,
  getEndpoint,
  loadEndpoints,
  loadGlobalActiveEndpointId,
  loadPageBinding,
  loadPageBindings,
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
  const activitySessions = createActionLogSessionState();
  let soundAlertEnabled = Boolean(GM_getValue(SOUND_ALERT_ENABLED_KEY, false));

  function boundedInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  let soundAlertDelayMinutes = boundedInteger(
    GM_getValue(SOUND_ALERT_DELAY_MINUTES_KEY, DEFAULT_SOUND_ALERT_DELAY_MINUTES),
    DEFAULT_SOUND_ALERT_DELAY_MINUTES,
    MIN_SOUND_ALERT_DELAY_MINUTES,
    MAX_SOUND_ALERT_DELAY_MINUTES,
  );
  let soundAlertDurationSeconds = boundedInteger(
    GM_getValue(SOUND_ALERT_DURATION_SECONDS_KEY, DEFAULT_SOUND_ALERT_DURATION_SECONDS),
    DEFAULT_SOUND_ALERT_DURATION_SECONDS,
    MIN_SOUND_ALERT_DURATION_SECONDS,
    MAX_SOUND_ALERT_DURATION_SECONDS,
  );

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
  debugLog('main', 'boot state', {
    pageUrl: currentPageUrl,
    visibility: document.visibilityState,
    globalActiveEndpointId,
    pageActiveEndpointId,
    effectiveEndpointId: getEffectiveEndpointId(),
    backend: getEffectiveEndpoint()?.backend || null,
    activeWorkspaceId,
    soundAlertEnabled,
  });

  const composerAdapter = createComposerAdapter();
  const skillCatalogClient = createSkillCatalogClient({
    getProfile: getEffectiveEndpoint,
  });
  const workspaceClient = createWorkspaceClient({
    getProfile: getEffectiveEndpoint,
  });

  const activityStore = createActivityStore();
  let monitorUi = null;
  const soundAlert = createSoundAlert({
    isEnabled: () => soundAlertEnabled,
    canArm: () => Boolean(activeWorkspaceId && monitorUi?.hasLastActivityTime()),
    getDelayMs: () => soundAlertDelayMinutes * 60 * 1000,
    getDurationMs: () => soundAlertDurationSeconds * 1000,
  });
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
    if (!actionLogClient) {
      debugLog('main', 'stopActionLog skipped: no client');
      return;
    }
    const cursor = actionLogClient.getCursor?.();
    if (Number.isInteger(cursor) && activitySessionKey) {
      activitySessions.setCursor(activitySessionKey, cursor);
    }
    actionLogClient.stop();
    actionLogClient = null;
    debugLog('main', 'action-log client stopped', {
      sessionKey: activitySessionKey,
      cursor: Number.isInteger(cursor) ? cursor : null,
    });
  }

  function resetWorkspaceStream({ preserveSessions = false } = {}) {
    debugLog('main', 'reset workspace stream', {
      preserveSessions,
      activeWorkspaceId,
      sessionKey: activitySessionKey,
    });
    stopActionLog();
    activityStore.clear();
    soundAlert.reset();
    activitySessionKey = null;
    if (!preserveSessions) activitySessions.clearAll();
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
    if (!/^ws_[0-9a-f]{16}$/.test(workspaceId)) {
      debugWarn('main', 'reject invalid workspace selection', { workspaceId });
      return false;
    }
    debugLog('main', 'select workspace', {
      previousWorkspaceId: activeWorkspaceId,
      nextWorkspaceId: workspaceId,
    });
    if (workspaceId === activeWorkspaceId) {
      workspaceMenu.updateTrigger();
      return true;
    }

    resetWorkspaceStream({ preserveSessions: true });
    activeWorkspaceId = workspaceId;
    persistCurrentPageBinding();
    workspaceMenu.updateTrigger();
    if (monitorMounted && document.visibilityState === 'visible') startActionLog();
    return true;
  }

  function resetWorkspaceSelection() {
    if (!activeWorkspaceId) {
      debugLog('main', 'reset workspace skipped: already discovery');
      return true;
    }
    debugLog('main', 'reset workspace selection', { previousWorkspaceId: activeWorkspaceId });
    resetWorkspaceStream({ preserveSessions: true });
    activeWorkspaceId = null;
    workspaceClient.clear();
    workspaceMenu.invalidate();
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

  function deleteStoredPageBinding(url) {
    const key = String(url || '').trim();
    if (!key) return loadPageBindings();
    const deletingCurrentPage = key === currentPageUrl;
    debugLog('main', 'delete page binding', {
      url: key,
      deletingCurrentPage,
    });
    const bindings = deletePageBinding(key);
    if (!deletingCurrentPage) return bindings;

    resetWorkspaceStream();
    pageActiveEndpointId = null;
    activeWorkspaceId = null;
    workspaceClient.clear();
    workspaceMenu.reset();
    skillsMenu.close();
    workspaceMenu.updateTrigger();

    if (!getEffectiveEndpoint()?.backend) {
      deactivateMonitor();
    } else if (document.visibilityState === 'visible') {
      activateMonitor();
    }
    return bindings;
  }

  function setSoundAlertEnabled(enabled) {
    soundAlertEnabled = Boolean(enabled);
    GM_setValue(SOUND_ALERT_ENABLED_KEY, soundAlertEnabled);
    soundAlert.settingsChanged();
    if (soundAlertEnabled) soundAlert.unlock();
  }

  function setSoundAlertDelayMinutes(value) {
    soundAlertDelayMinutes = boundedInteger(
      value,
      soundAlertDelayMinutes,
      MIN_SOUND_ALERT_DELAY_MINUTES,
      MAX_SOUND_ALERT_DELAY_MINUTES,
    );
    GM_setValue(SOUND_ALERT_DELAY_MINUTES_KEY, soundAlertDelayMinutes);
    soundAlert.settingsChanged();
    return soundAlertDelayMinutes;
  }

  function setSoundAlertDurationSeconds(value) {
    soundAlertDurationSeconds = boundedInteger(
      value,
      soundAlertDurationSeconds,
      MIN_SOUND_ALERT_DURATION_SECONDS,
      MAX_SOUND_ALERT_DURATION_SECONDS,
    );
    GM_setValue(SOUND_ALERT_DURATION_SECONDS_KEY, soundAlertDurationSeconds);
    return soundAlertDurationSeconds;
  }

  const settingsPanel = createSettingsPanel({
    getState: () => ({
      endpoints,
      globalActiveEndpointId,
      pageActiveEndpointId,
      effectiveEndpointId: getEffectiveEndpointId(),
      pageUrl: currentPageUrl,
      pageBindings: loadPageBindings(),
      soundAlertEnabled,
      soundAlertDelayMinutes,
      soundAlertDurationSeconds,
    }),
    onSaveEndpoints: saveEndpointLibrary,
    onSetGlobalEndpoint: setGlobalActiveEndpoint,
    onUsePageEndpoint: usePageEndpoint,
    onRestoreGlobalEndpoint: restoreGlobalEndpoint,
    onDeletePageBinding: deleteStoredPageBinding,
    onSetSoundAlertEnabled: setSoundAlertEnabled,
    onSetSoundAlertDelayMinutes: setSoundAlertDelayMinutes,
    onSetSoundAlertDurationSeconds: setSoundAlertDurationSeconds,
    onTestSound: () => soundAlert.test(),
  });

  function handlePageNavigation() {
    const nextPageUrl = pageUrl();
    if (nextPageUrl === currentPageUrl) return;
    debugLog('main', 'page navigation', {
      previousPageUrl: currentPageUrl,
      nextPageUrl,
    });

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
    if (!monitorMounted || actionLogClient || !profile?.backend) {
      debugLog('main', 'startActionLog skipped', {
        monitorMounted,
        hasClient: Boolean(actionLogClient),
        hasBackend: Boolean(profile?.backend),
        endpointId: profile?.id || null,
        backend: profile?.backend || null,
        activeWorkspaceId,
      });
      return;
    }

    const nextSessionKey = `${profile.id}:${profile.backend}:${activeWorkspaceId || 'discovery'}`;
    if (activitySessionKey !== nextSessionKey) {
      activityStore.clear();
      activitySessionKey = nextSessionKey;
    }

    const sessionKey = nextSessionKey;
    const initialCursor = activitySessions.getCursor(sessionKey);
    const initialStreamId = activitySessions.getStreamId();
    debugLog('main', 'create action-log client', {
      endpointId: profile.id,
      backend: profile.backend,
      activeWorkspaceId,
      mode: activeWorkspaceId ? 'workspace' : 'discovery',
      sessionKey,
      initialCursor,
      initialStreamId,
      visibility: document.visibilityState,
    });

    actionLogClient = createActionLogClient({
      getProfile: getEffectiveEndpoint,
      getWorkspaceId: () => activeWorkspaceId,
      initialCursor,
      initialStreamId,
      onCursor: (cursor) => {
        activitySessions.setCursor(sessionKey, cursor);
        debugLog('main', 'cursor updated', { sessionKey, cursor });
      },
      onStreamId: (streamId) => {
        activitySessions.setStreamId(streamId);
        debugLog('main', 'stream id updated', { streamId });
      },
      onStreamReset() {
        debugWarn('main', 'server stream reset: clearing active state', {
          sessionKey,
          activeWorkspaceId,
        });
        activitySessions.clearCursors();
        activitySessions.setCursor(sessionKey, 0);
        activityStore.clearActive();
        soundAlert.reset();
        monitorUi.clearLastActivityTime();
      },
      onConnectionRestored() {
        debugLog('main', 'action-log connection restored', {
          sessionKey,
          activeWorkspaceId,
        });
        monitorUi.clearHint();
        monitorUi.clearAttention();
        monitorUi.setStatus('idle');
      },
      shouldPollWhenHidden: () => soundAlertEnabled && Boolean(activeWorkspaceId),
      onItems(items) {
        debugLog('main', 'onItems', {
          count: items?.length || 0,
          activeWorkspaceId,
          items: summarizeActionItems(items),
        });
        if (!activeWorkspaceId) {
          const preparedWorkspace = (items || []).some((item) => (
            item?.event?.phase === 'completed'
            && item?.event?.payload?.operation === 'prepare_workspace'
            && /^ws_[0-9a-f]{16}$/.test(item?.event?.payload?.workspace_id || '')
          ));
          if (preparedWorkspace) {
            workspaceClient.clear();
            workspaceMenu.invalidate();
          }
        }
        const latestTimestamp = latestEventTimestamp(items);
        if (latestTimestamp) monitorUi.setLastActivityTimestamp(latestTimestamp);
        if (latestTimestamp && activeWorkspaceId) soundAlert.observe(latestTimestamp);
        soundAlert.check();
        const newest = activityStore.ingest(items);
        const snapshot = activityStore.snapshot();
        debugLog('main', 'activity store updated', {
          newestId: newest?.id || null,
          activeCount: snapshot.active.length,
          recentCount: snapshot.recent.length,
        });
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
    if (!profile?.backend) {
      debugWarn('main', 'activate monitor skipped: no backend');
      return;
    }
    debugLog('main', 'activate monitor', {
      endpointId: profile.id,
      backend: profile.backend,
      activeWorkspaceId,
      mounted: monitorMounted,
    });

    if (!monitorMounted) {
      monitorMounted = true;
      monitorUi.mount();
      monitorUi.setStatus('idle');
      workspaceMenu.updateTrigger();
    }
    startActionLog();
  }

  function suspend() {
    debugLog('main', 'page hidden: suspend', {
      soundAlertEnabled,
      activeWorkspaceId,
      keepPolling: soundAlertEnabled && Boolean(activeWorkspaceId),
    });
    monitorUi.suspendActivity();
    if (soundAlertEnabled && activeWorkspaceId) {
      soundAlert.check();
      return;
    }
    actionLogClient?.suspend();
  }

  function resume() {
    debugLog('main', 'page visible: resume', {
      monitorMounted,
      hasClient: Boolean(actionLogClient),
      activeWorkspaceId,
    });
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

  const unlockSound = () => {
    if (soundAlertEnabled) soundAlert.unlock();
  };
  document.addEventListener('pointerdown', unlockSound, { capture: true });
  document.addEventListener('keydown', unlockSound, { capture: true });

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
