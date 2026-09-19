// ==UserScript==
// @name         GPT Action Monitor
// @namespace    https://github.com/qqq694637644/github_skills_action
// @version      0.3.1
// @description  Show github_skills_action activity as a calm, energy-conscious status indicator on ChatGPT.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

(function () {
  'use strict';

  const BACKEND_KEY = 'gptActionMonitorBackend';
  const TOKEN_KEY = 'gptActionMonitorToken';
  const POSITION_KEY = 'gptActionMonitorPosition';
  const TARGET_GPT_NAME = 'github_skill';
  const GPT_TITLE_SELECTOR = 'div[type="button"][aria-haspopup="menu"]';
  const POLL_WAIT_SECONDS = 55;
  const RETRY_MS = 3000;
  const ACTIVITY_VISIBLE_MS = 4000;
  const UI_COALESCE_MS = 200;
  const MAX_HISTORY = 100;
  const COMPACT_WIDTH = 30;

  let lastId = 0;
  let needsCursorPrime = true;
  let stopped = false;
  let monitorActive = false;
  let activeTitleElement = null;
  let gateObserver = null;
  let manualOpen = false;
  let suppressHandleClick = false;
  let requestHandle = null;
  let requestGeneration = 0;
  let pollTimer = null;
  let activityTimer = null;
  let uiTimer = null;
  let pendingLatest = null;
  const history = [];

  GM_registerMenuCommand('设置后端地址', () => {
    const current = GM_getValue(BACKEND_KEY, '');
    const value = prompt('后端地址，例如 https://skills.example.com', current);
    if (value !== null) {
      GM_setValue(BACKEND_KEY, value.trim().replace(/\/+$/, ''));
      location.reload();
    }
  });

  GM_registerMenuCommand('设置 Bearer Token', () => {
    const current = GM_getValue(TOKEN_KEY, '');
    const value = prompt('Bearer Token（后端未启用认证可留空）', current);
    if (value !== null) {
      GM_setValue(TOKEN_KEY, value.trim());
      location.reload();
    }
  });

  const panel = document.createElement('div');
  panel.id = 'gpt-action-monitor';
  panel.dataset.status = 'idle';
  panel.innerHTML = `
    <div class="gam-compact">
      <div class="gam-chip" role="status" aria-live="polite" aria-atomic="true">
        <strong class="gam-current-action">GPT Actions</strong>
        <span class="gam-current-detail">等待 Action</span>
      </div>
      <button class="gam-handle" type="button" title="拖动移动 · 点击展开" aria-label="展开 GPT Action 历史">
        <span class="gam-dot"></span>
      </button>
    </div>
    <section class="gam-expanded" aria-label="GPT Action 历史">
      <div class="gam-header">
        <span><span class="gam-dot gam-header-dot"></span>GPT Actions</span>
        <button class="gam-close" type="button" title="收起" aria-label="收起 Action 历史">−</button>
      </div>
      <div class="gam-log" role="log" aria-label="Action 历史"></div>
    </section>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #gpt-action-monitor {
      position: fixed;
      right: 0;
      top: 36vh;
      width: 30px;
      height: 40px;
      z-index: 2147483647;
      color: CanvasText;
      color-scheme: light dark;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      line-height: 1.35;
    }
    #gpt-action-monitor button { font: inherit; }
    #gpt-action-monitor .gam-compact {
      position: relative;
      width: 30px;
      height: 40px;
    }
    #gpt-action-monitor .gam-handle {
      box-sizing: border-box;
      width: 30px;
      height: 40px;
      display: grid;
      place-items: center;
      padding: 0;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-right: 0;
      border-radius: 13px 0 0 13px;
      background: color-mix(in srgb, Canvas 97%, CanvasText 3%);
      color: CanvasText;
      box-shadow: 0 3px 10px rgba(0, 0, 0, .08);
      cursor: grab;
      touch-action: none;
    }
    #gpt-action-monitor.gam-detached .gam-handle {
      border-right: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 13px;
    }
    #gpt-action-monitor .gam-handle:hover,
    #gpt-action-monitor .gam-handle:focus-visible {
      background: color-mix(in srgb, Canvas 92%, CanvasText 8%);
    }
    #gpt-action-monitor .gam-dot {
      width: 8px;
      height: 8px;
      display: inline-block;
      flex: 0 0 8px;
      border-radius: 50%;
      background: #8b8b8b;
    }
    #gpt-action-monitor[data-status="active"] .gam-dot { background: #22a35a; }
    #gpt-action-monitor[data-status="error"] .gam-dot { background: #d84a4a; }
    #gpt-action-monitor .gam-chip {
      position: absolute;
      right: 36px;
      top: 2px;
      width: min(250px, calc(100vw - 54px));
      height: 36px;
      box-sizing: border-box;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      gap: 7px;
      padding: 0 11px;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, CanvasText 13%, transparent);
      border-radius: 18px;
      background: color-mix(in srgb, Canvas 97%, CanvasText 3%);
      box-shadow: 0 3px 12px rgba(0, 0, 0, .08);
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transform: translateX(6px);
      transition: opacity .12s ease, transform .12s ease;
    }
    #gpt-action-monitor.gam-chip-right .gam-chip {
      right: auto;
      left: 36px;
      transform: translateX(-6px);
    }
    #gpt-action-monitor.gam-chip-visible .gam-chip,
    #gpt-action-monitor .gam-compact:hover .gam-chip,
    #gpt-action-monitor .gam-compact:focus-within .gam-chip {
      opacity: 1;
      transform: translateX(0);
    }
    #gpt-action-monitor .gam-current-action {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      font-weight: 600;
    }
    #gpt-action-monitor .gam-current-detail {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      opacity: .62;
    }
    #gpt-action-monitor.gam-dragging .gam-chip { opacity: 0; }
    #gpt-action-monitor.gam-dragging .gam-handle,
    #gpt-action-monitor.gam-dragging .gam-header { cursor: grabbing; }
    #gpt-action-monitor .gam-expanded { display: none; }
    #gpt-action-monitor.gam-open {
      width: min(320px, calc(100vw - 16px));
      height: min(300px, 54vh);
    }
    #gpt-action-monitor.gam-open .gam-compact { display: none; }
    #gpt-action-monitor.gam-open .gam-expanded {
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-sizing: border-box;
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 12px;
      background: color-mix(in srgb, Canvas 98%, CanvasText 2%);
      color: CanvasText;
      box-shadow: 0 8px 24px rgba(0, 0, 0, .12);
    }
    #gpt-action-monitor .gam-header {
      height: 38px;
      flex: 0 0 38px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px 0 12px;
      border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
      font-size: 12px;
      font-weight: 600;
      cursor: grab;
      user-select: none;
      touch-action: none;
    }
    #gpt-action-monitor .gam-header > span {
      display: flex;
      align-items: center;
      gap: 7px;
    }
    #gpt-action-monitor .gam-close {
      width: 28px;
      height: 28px;
      border: 0;
      border-radius: 7px;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 17px;
      line-height: 1;
    }
    #gpt-action-monitor .gam-close:hover { background: color-mix(in srgb, CanvasText 7%, transparent); }
    #gpt-action-monitor .gam-log {
      flex: 1;
      overflow-y: auto;
      padding: 6px 8px 8px;
      scrollbar-width: thin;
    }
    #gpt-action-monitor .gam-entry {
      padding: 7px 8px;
      border-radius: 8px;
    }
    #gpt-action-monitor .gam-entry:hover { background: color-mix(in srgb, CanvasText 5%, transparent); }
    #gpt-action-monitor .gam-entry-top {
      display: flex;
      gap: 8px;
      align-items: baseline;
      min-width: 0;
    }
    #gpt-action-monitor .gam-time {
      flex: 0 0 auto;
      opacity: .48;
      font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
    #gpt-action-monitor .gam-action {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 600;
    }
    #gpt-action-monitor .gam-detail {
      margin: 2px 0 0 42px;
      opacity: .62;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #gpt-action-monitor .gam-hint { opacity: .58; }
    @media (prefers-reduced-motion: reduce) {
      #gpt-action-monitor .gam-chip { transition: none; }
    }
  `;

  const handle = panel.querySelector('.gam-handle');
  const close = panel.querySelector('.gam-close');
  const header = panel.querySelector('.gam-header');
  const logBox = panel.querySelector('.gam-log');
  const currentAction = panel.querySelector('.gam-current-action');
  const currentDetail = panel.querySelector('.gam-current-detail');

  function setStatus(state) {
    panel.dataset.status = state;
  }

  function mountUi() {
    if (!style.isConnected) document.documentElement.appendChild(style);
    if (!panel.isConnected) document.body.appendChild(panel);
    restorePosition();
  }

  function unmountUi() {
    if (panel.isConnected) savePosition();
    panel.classList.remove('gam-open', 'gam-chip-visible', 'gam-dragging');
    manualOpen = false;
    logBox.replaceChildren();
    panel.remove();
    style.remove();
  }

  function updateChipSide() {
    if (panel.classList.contains('gam-open')) return;
    const rect = panel.getBoundingClientRect();
    panel.classList.toggle('gam-chip-right', rect.left < 275);
  }

  function savePosition() {
    const rect = panel.getBoundingClientRect();
    const docked = !panel.classList.contains('gam-detached');
    const compactLeft = panel.classList.contains('gam-open')
      ? rect.right - COMPACT_WIDTH
      : rect.left;
    GM_setValue(POSITION_KEY, {
      top: Math.round(rect.top),
      left: docked ? null : Math.round(compactLeft),
      docked,
    });
  }

  function keepInViewport() {
    const rect = panel.getBoundingClientRect();
    const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
    panel.style.top = `${Math.round(Math.min(Math.max(rect.top, 8), maxTop))}px`;

    if (panel.classList.contains('gam-detached')) {
      const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
      panel.style.left = `${Math.round(Math.min(Math.max(rect.left, 8), maxLeft))}px`;
      panel.style.right = 'auto';
    } else {
      panel.style.left = 'auto';
      panel.style.right = '0';
    }
    updateChipSide();
  }

  function restorePosition() {
    const saved = GM_getValue(POSITION_KEY, null);
    if (!saved || typeof saved !== 'object') {
      updateChipSide();
      return;
    }
    if (Number.isFinite(saved.top)) panel.style.top = `${saved.top}px`;
    if (saved.docked === false && Number.isFinite(saved.left)) {
      panel.classList.add('gam-detached');
      panel.style.left = `${saved.left}px`;
      panel.style.right = 'auto';
    }
    keepInViewport();
  }

  function makeDraggable(dragHandle, { suppressClick = false } = {}) {
    dragHandle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || event.target.closest('.gam-close')) return;

      const startRect = panel.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;
      panel.classList.add('gam-dragging');
      dragHandle.setPointerCapture(event.pointerId);

      const onMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) < 4) return;

        if (!dragging) {
          dragging = true;
          panel.classList.add('gam-detached');
          panel.style.left = `${Math.round(startRect.left)}px`;
          panel.style.right = 'auto';
        }

        const width = panel.getBoundingClientRect().width;
        const height = panel.getBoundingClientRect().height;
        const left = Math.min(
          Math.max(startRect.left + dx, 8),
          Math.max(8, window.innerWidth - width - 8),
        );
        const top = Math.min(
          Math.max(startRect.top + dy, 8),
          Math.max(8, window.innerHeight - height - 8),
        );
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(top)}px`;
        updateChipSide();
      };

      const onEnd = () => {
        dragHandle.removeEventListener('pointermove', onMove);
        dragHandle.removeEventListener('pointerup', onEnd);
        dragHandle.removeEventListener('pointercancel', onEnd);
        panel.classList.remove('gam-dragging');

        if (!dragging) return;
        const rect = panel.getBoundingClientRect();
        if (window.innerWidth - rect.right < 28) {
          panel.classList.remove('gam-detached');
          panel.style.left = 'auto';
          panel.style.right = '0';
        }
        keepInViewport();
        savePosition();
        if (suppressClick) suppressHandleClick = true;
      };

      dragHandle.addEventListener('pointermove', onMove);
      dragHandle.addEventListener('pointerup', onEnd);
      dragHandle.addEventListener('pointercancel', onEnd);
    });
  }

  function createEventNode(summary) {
    const node = document.createElement('div');
    node.className = 'gam-entry';
    node.title = summary.raw;

    const top = document.createElement('div');
    top.className = 'gam-entry-top';

    const time = document.createElement('span');
    time.className = 'gam-time';
    time.textContent = summary.time || '--:--';

    const action = document.createElement('span');
    action.className = 'gam-action';
    action.textContent = summary.action;

    const detail = document.createElement('div');
    detail.className = 'gam-detail';
    detail.textContent = summary.detail;

    top.append(time, action);
    node.append(top, detail);
    return node;
  }

  function createHintNode(message) {
    const node = document.createElement('div');
    node.className = 'gam-entry gam-hint';
    node.textContent = message;
    return node;
  }

  function trimHistory() {
    while (history.length > MAX_HISTORY) {
      history.shift();
      if (manualOpen && logBox.firstElementChild) logBox.firstElementChild.remove();
    }
  }

  function recordEvent(summary) {
    history.push({ kind: 'event', summary });
    if (manualOpen) {
      logBox.appendChild(createEventNode(summary));
      logBox.scrollTop = logBox.scrollHeight;
    }
    trimHistory();
  }

  function recordHint(message) {
    const previous = history[history.length - 1];
    if (previous?.kind === 'hint' && previous.message === message) return;
    history.push({ kind: 'hint', message });
    if (manualOpen) {
      logBox.appendChild(createHintNode(message));
      logBox.scrollTop = logBox.scrollHeight;
    }
    trimHistory();
  }

  function renderHistory() {
    const fragment = document.createDocumentFragment();
    for (const item of history) {
      fragment.appendChild(
        item.kind === 'event' ? createEventNode(item.summary) : createHintNode(item.message),
      );
    }
    logBox.replaceChildren(fragment);
    logBox.scrollTop = logBox.scrollHeight;
  }

  function openHistory() {
    if (suppressHandleClick) {
      suppressHandleClick = false;
      return;
    }
    const compactRect = panel.getBoundingClientRect();
    const rightEdge = compactRect.right;
    manualOpen = true;
    panel.classList.remove('gam-chip-visible');
    panel.classList.add('gam-open');
    if (panel.classList.contains('gam-detached')) {
      const width = panel.getBoundingClientRect().width;
      panel.style.left = `${Math.round(rightEdge - width)}px`;
    }
    keepInViewport();
    renderHistory();
  }

  function closeHistory() {
    const openRect = panel.getBoundingClientRect();
    const rightEdge = openRect.right;
    manualOpen = false;
    panel.classList.remove('gam-open');
    if (panel.classList.contains('gam-detached')) {
      panel.style.left = `${Math.round(rightEdge - COMPACT_WIDTH)}px`;
    }
    logBox.replaceChildren();
    keepInViewport();
    savePosition();
    handle.focus();
  }

  function parseField(text, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(
      new RegExp(`(?:^|\\s)${escaped}=("(?:\\\\.|[^"\\\\])*"|\\[[^\\]]*\\]|[^\\s]+)`),
    );
    if (!match) return null;
    const raw = match[1];
    try {
      return JSON.parse(raw);
    } catch (_) {
      return raw;
    }
  }

  function baseName(path) {
    if (!path || typeof path !== 'string') return '';
    const parts = path.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1] || path;
  }

  function compactList(value, max = 2) {
    if (!Array.isArray(value) || !value.length) return '';
    const names = value.slice(0, max).map((item) => baseName(String(item)));
    return value.length > max ? `${names.join(', ')} +${value.length - max}` : names.join(', ');
  }

  function shorten(value, limit = 72) {
    if (value === null || value === undefined) return '';
    const oneLine = String(value).replace(/\s+/g, ' ').trim();
    return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
  }

  function summarize(text) {
    const action = text.match(/\bACTION\s+([\w-]+)/)?.[1] || 'Action';
    const time = text.match(/^\[\d{4}-\d{2}-\d{2}\s+(\d{2}:\d{2})\]/)?.[1] || '';
    let detail = '';

    if (action === 'loadSkills') {
      detail = compactList(parseField(text, 'skill_ids'));
    } else if (action === 'readSkillContent') {
      detail = baseName(parseField(text, 'path'));
    } else if (action === 'workspaceReadFiles') {
      detail = compactList(parseField(text, 'paths')) || `${parseField(text, 'files') || ''} files`;
    } else if (action === 'workspaceSearch') {
      detail = shorten(parseField(text, 'query'));
    } else if (action === 'workspaceInspect') {
      detail = compactList(parseField(text, 'paths'));
    } else if (action === 'workspaceWriteFile') {
      detail = baseName(parseField(text, 'path'));
    } else if (action === 'workspaceApplyPatch') {
      const files = parseField(text, 'changed_files');
      detail = Array.isArray(files) ? `${files.length} files · ${compactList(files)}` : '';
    } else if (action === 'workspaceCommand') {
      const commandAction = parseField(text, 'action');
      const command = parseField(text, 'command');
      const state = parseField(text, 'state');
      if (command) detail = shorten(command);
      else if (state && commandAction) detail = `${commandAction} · ${state}`;
      else detail = shorten(state || commandAction || '');
    } else {
      detail = shorten(
        parseField(text, 'path') ||
        parseField(text, 'query') ||
        compactList(parseField(text, 'paths')) ||
        parseField(text, 'state') ||
        '',
      );
    }

    return { action, detail: detail || 'completed', time, raw: text };
  }

  function hideActivity() {
    panel.classList.remove('gam-chip-visible');
    if (panel.dataset.status === 'active') setStatus('idle');
  }

  function flushActivity() {
    uiTimer = null;
    if (!pendingLatest) return;
    const summary = pendingLatest;
    pendingLatest = null;
    currentAction.textContent = summary.action;
    currentDetail.textContent = summary.detail;
    setStatus('active');
    if (!manualOpen) panel.classList.add('gam-chip-visible');
    window.clearTimeout(activityTimer);
    activityTimer = window.setTimeout(hideActivity, ACTIVITY_VISIBLE_MS);
  }

  function queueActivity(summary) {
    pendingLatest = summary;
    if (!monitorActive || uiTimer !== null || document.visibilityState !== 'visible') return;
    uiTimer = window.setTimeout(flushActivity, UI_COALESCE_MS);
  }

  function showAttention(action, detail) {
    pendingLatest = null;
    if (uiTimer !== null) {
      window.clearTimeout(uiTimer);
      uiTimer = null;
    }
    window.clearTimeout(activityTimer);
    currentAction.textContent = action;
    currentDetail.textContent = detail;
    setStatus('error');
    if (!manualOpen) panel.classList.add('gam-chip-visible');
  }

  function clearPollTimer() {
    if (pollTimer !== null) {
      window.clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  function schedulePoll(delay = 30) {
    clearPollTimer();
    if (!monitorActive || stopped || document.visibilityState !== 'visible') return;
    pollTimer = window.setTimeout(() => {
      pollTimer = null;
      poll();
    }, delay);
  }

  function abortRequest() {
    if (!requestHandle) return;
    const active = requestHandle;
    requestHandle = null;
    if (typeof active.abort === 'function') {
      try {
        active.abort();
      } catch (_) {
        // The request may already have completed between visibility events.
      }
    }
  }

  function suspendPolling() {
    requestGeneration += 1;
    clearPollTimer();
    abortRequest();
    if (uiTimer !== null) {
      window.clearTimeout(uiTimer);
      uiTimer = null;
    }
    window.clearTimeout(activityTimer);
    panel.classList.remove('gam-chip-visible');
    if (panel.dataset.status === 'active') setStatus('idle');
  }

  function resumePolling() {
    if (!monitorActive || stopped || document.visibilityState !== 'visible') return;
    if (pendingLatest) queueActivity(pendingLatest);
    schedulePoll(0);
  }

  function scheduleRetry(message) {
    recordHint(message);
    showAttention('连接异常', '3 秒后重试');
    schedulePoll(RETRY_MS);
  }

  function poll() {
    if (!monitorActive || stopped || requestHandle || document.visibilityState !== 'visible') return;

    const backend = GM_getValue(BACKEND_KEY, '').trim().replace(/\/+$/, '');
    const token = GM_getValue(TOKEN_KEY, '').trim();
    if (!backend) {
      showAttention('需要配置后端', '点击后查看提示');
      recordHint('请从篡改猴菜单设置后端地址。');
      return;
    }

    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    const generation = ++requestGeneration;
    const priming = needsCursorPrime;
    const requestAfter = priming ? Number.MAX_SAFE_INTEGER : lastId;
    const requestWait = priming ? 0 : POLL_WAIT_SECONDS;
    const requestLimit = priming ? 1 : 50;
    requestHandle = GM_xmlhttpRequest({
      method: 'GET',
      url: `${backend}/v1/action-logs?after=${requestAfter}&wait=${requestWait}&limit=${requestLimit}`,
      headers,
      timeout: (requestWait + 5) * 1000,
      onload(response) {
        if (generation !== requestGeneration) return;
        requestHandle = null;
        if (document.visibilityState !== 'visible') return;

        if (response.status === 401) {
          stopped = true;
          showAttention('认证失败', '检查 Bearer Token');
          recordHint('认证失败：请检查 Bearer Token。');
          return;
        }
        if (response.status < 200 || response.status >= 300) {
          scheduleRetry(`后端返回 HTTP ${response.status}，3 秒后重试。`);
          return;
        }

        try {
          const body = JSON.parse(response.responseText);
          if (Number.isInteger(body.last_id)) lastId = body.last_id;
          if (priming) {
            needsCursorPrime = false;
            setStatus('idle');
            schedulePoll(0);
            return;
          }
          let newest = null;
          for (const item of body.items || []) {
            newest = summarize(item.text);
            recordEvent(newest);
          }
          if (newest) {
            queueActivity(newest);
          } else if (panel.dataset.status === 'error') {
            panel.classList.remove('gam-chip-visible');
            setStatus('idle');
          }
          schedulePoll();
        } catch (error) {
          scheduleRetry(`响应解析失败：${String(error)}`);
        }
      },
      onerror() {
        if (generation !== requestGeneration) return;
        requestHandle = null;
        if (document.visibilityState === 'visible') {
          scheduleRetry('连接后端失败，3 秒后重试。');
        }
      },
      ontimeout() {
        if (generation !== requestGeneration) return;
        requestHandle = null;
        schedulePoll(100);
      },
      onabort() {
        if (generation === requestGeneration) requestHandle = null;
      },
    });
  }

  function isTargetTitle(element) {
    return Boolean(
      element &&
      element.nodeType === Node.ELEMENT_NODE &&
      element.matches(GPT_TITLE_SELECTOR) &&
      (element.textContent || '').replace(/\s+/g, ' ').trim() === TARGET_GPT_NAME
    );
  }

  function findTargetTitle(root = document) {
    if (root.nodeType === Node.ELEMENT_NODE && isTargetTitle(root)) return root;
    if (typeof root.querySelectorAll !== 'function') return null;
    for (const element of root.querySelectorAll(GPT_TITLE_SELECTOR)) {
      if (isTargetTitle(element)) return element;
    }
    return null;
  }

  function resetSessionState() {
    history.length = 0;
    lastId = 0;
    needsCursorPrime = true;
    stopped = false;
    pendingLatest = null;
    if (uiTimer !== null) {
      window.clearTimeout(uiTimer);
      uiTimer = null;
    }
    window.clearTimeout(activityTimer);
  }

  function activateMonitor(titleElement) {
    if (monitorActive) {
      activeTitleElement = titleElement;
      return;
    }
    monitorActive = true;
    activeTitleElement = titleElement;
    resetSessionState();
    mountUi();
    setStatus('idle');
    if (document.visibilityState === 'visible') schedulePoll(0);
  }

  function deactivateMonitor() {
    if (!monitorActive) return;
    monitorActive = false;
    activeTitleElement = null;
    suspendPolling();
    resetSessionState();
    unmountUi();
  }

  function evaluateActivation() {
    const target = findTargetTitle(document);
    if (target) activateMonitor(target);
    else deactivateMonitor();
  }

  function targetFromMutation(mutation) {
    const mutationElement = mutation.target.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation.target.parentElement;
    const containingTitle = mutationElement?.closest?.(GPT_TITLE_SELECTOR);
    if (isTargetTitle(containingTitle)) return containingTitle;

    for (const node of mutation.addedNodes) {
      const target = findTargetTitle(node);
      if (target) return target;
    }
    return null;
  }

  function startGateObserver() {
    if (gateObserver || !document.body) return;
    gateObserver = new MutationObserver((mutations) => {
      if (monitorActive) {
        if (activeTitleElement?.isConnected && isTargetTitle(activeTitleElement)) return;
        evaluateActivation();
        return;
      }

      for (const mutation of mutations) {
        const target = targetFromMutation(mutation);
        if (target) {
          activateMonitor(target);
          return;
        }
      }
    });
    gateObserver.observe(document.body, {
      childList: true,
      characterData: true,
      subtree: true,
    });
  }

  function stopGateObserver() {
    if (!gateObserver) return;
    gateObserver.disconnect();
    gateObserver = null;
  }

  makeDraggable(handle, { suppressClick: true });
  makeDraggable(header);
  handle.addEventListener('click', openHistory);
  close.addEventListener('click', closeHistory);
  window.addEventListener('resize', () => {
    if (monitorActive) keepInViewport();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      startGateObserver();
      evaluateActivation();
      resumePolling();
    } else {
      stopGateObserver();
      suspendPolling();
    }
  });

  if (document.visibilityState === 'visible') {
    startGateObserver();
    evaluateActivation();
  }
})();
