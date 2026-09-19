// ==UserScript==
// @name         GPT Action Monitor
// @namespace    https://github.com/qqq694637644/github_skills_action
// @version      0.2.1
// @description  Show github_skills_action activity as a compact, unobtrusive status indicator on ChatGPT.
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
  const POLL_WAIT_SECONDS = 25;
  const RETRY_MS = 2000;
  const IDLE_COLLAPSE_MS = 5000;
  const MAX_VISIBLE_LINES = 80;

  let lastId = 0;
  let stopped = false;
  let manualOpen = false;
  let collapseTimer = null;

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
  panel.className = 'gam-idle';
  panel.innerHTML = `
    <button class="gam-peek" type="button" title="拖动移动 · 点击展开" aria-label="展开 GPT Action 历史">
      <span class="gam-dot"></span>
      <span class="gam-peek-text" role="status" aria-live="polite">
        <strong class="gam-current-action">GPT Actions</strong>
        <span class="gam-current-detail">等待 Action</span>
      </span>
    </button>
    <section class="gam-expanded" aria-label="GPT Action 历史">
      <div class="gam-header">
        <span><span class="gam-dot gam-header-dot"></span>GPT Actions</span>
        <button class="gam-close" type="button" title="收起" aria-label="收起 Action 历史">−</button>
      </div>
      <div class="gam-log"></div>
    </section>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #gpt-action-monitor {
      position: fixed;
      right: 0;
      top: 36vh;
      z-index: 2147483647;
      color: CanvasText;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      font-size: 12px;
      line-height: 1.35;
      color-scheme: light dark;
    }
    #gpt-action-monitor button { font: inherit; }
    #gpt-action-monitor .gam-peek {
      box-sizing: border-box;
      width: 238px;
      height: 38px;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 0 11px;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
      border-radius: 19px;
      background: color-mix(in srgb, Canvas 90%, transparent);
      color: CanvasText;
      box-shadow: 0 4px 16px rgba(0, 0, 0, .10);
      backdrop-filter: blur(10px);
      -webkit-backdrop-filter: blur(10px);
      cursor: grab;
      text-align: left;
      transition: width .14s ease, padding .14s ease, box-shadow .14s ease;
    }
    #gpt-action-monitor .gam-peek:hover,
    #gpt-action-monitor .gam-peek:focus-visible {
      box-shadow: 0 6px 22px rgba(0, 0, 0, .15);
    }
    #gpt-action-monitor.gam-idle .gam-peek {
      width: 30px;
      height: 40px;
      padding: 0;
      justify-content: center;
      gap: 0;
      border-right: 0;
      border-radius: 13px 0 0 13px;
      box-shadow: 0 3px 12px rgba(0, 0, 0, .08);
    }
    #gpt-action-monitor.gam-idle .gam-peek:hover,
    #gpt-action-monitor.gam-idle .gam-peek:focus-visible {
      width: 238px;
      height: 38px;
      padding: 0 11px;
      justify-content: flex-start;
      gap: 8px;
      border-right: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
      border-radius: 19px;
    }
    #gpt-action-monitor .gam-peek-text {
      min-width: 0;
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      gap: 7px;
      align-items: baseline;
      white-space: nowrap;
      opacity: 1;
      transition: opacity .10s ease;
    }
    #gpt-action-monitor.gam-idle .gam-peek-text { display: none; }
    #gpt-action-monitor.gam-idle .gam-peek:hover .gam-peek-text,
    #gpt-action-monitor.gam-idle .gam-peek:focus-visible .gam-peek-text { display: grid; }
    #gpt-action-monitor.gam-detached.gam-idle .gam-peek {
      border-right: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
      border-radius: 13px;
    }
    #gpt-action-monitor.gam-dragging .gam-peek,
    #gpt-action-monitor.gam-dragging .gam-header { cursor: grabbing; }
    #gpt-action-monitor.gam-dragging.gam-idle .gam-peek,
    #gpt-action-monitor.gam-dragging.gam-idle .gam-peek:hover {
      width: 30px;
      height: 40px;
      padding: 0;
      justify-content: center;
      gap: 0;
    }
    #gpt-action-monitor.gam-dragging.gam-idle .gam-peek-text { display: none; }
    #gpt-action-monitor .gam-current-action {
      font-weight: 600;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #gpt-action-monitor .gam-current-detail {
      min-width: 0;
      opacity: .62;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #gpt-action-monitor .gam-dot {
      width: 8px;
      height: 8px;
      flex: 0 0 8px;
      display: inline-block;
      border-radius: 50%;
      background: #8b8b8b;
    }
    #gpt-action-monitor[data-status="online"] .gam-dot { background: #22a35a; }
    #gpt-action-monitor[data-status="error"] .gam-dot { background: #d84a4a; }
    #gpt-action-monitor .gam-expanded {
      width: min(320px, calc(100vw - 20px));
      height: min(300px, 54vh);
      display: none;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid color-mix(in srgb, CanvasText 16%, transparent);
      border-radius: 12px;
      background: color-mix(in srgb, Canvas 92%, transparent);
      color: CanvasText;
      box-shadow: 0 10px 30px rgba(0, 0, 0, .14);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    #gpt-action-monitor.gam-open .gam-peek { display: none; }
    #gpt-action-monitor.gam-open .gam-expanded { display: flex; }
    #gpt-action-monitor .gam-header {
      height: 38px;
      flex: 0 0 38px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 10px 0 12px;
      border-bottom: 1px solid color-mix(in srgb, CanvasText 11%, transparent);
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
    #gpt-action-monitor .gam-close:hover { background: color-mix(in srgb, CanvasText 8%, transparent); }
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
      #gpt-action-monitor .gam-peek,
      #gpt-action-monitor .gam-peek-text { transition: none; }
    }
  `;

  document.documentElement.appendChild(style);
  document.body.appendChild(panel);

  const peek = panel.querySelector('.gam-peek');
  const close = panel.querySelector('.gam-close');
  const logBox = panel.querySelector('.gam-log');
  const currentAction = panel.querySelector('.gam-current-action');
  const currentDetail = panel.querySelector('.gam-current-detail');
  const header = panel.querySelector('.gam-header');

  let suppressPeekClick = false;

  function savePosition() {
    const rect = panel.getBoundingClientRect();
    const docked = !panel.classList.contains('gam-detached');
    GM_setValue(POSITION_KEY, {
      top: Math.round(rect.top),
      left: docked ? null : Math.round(rect.left),
      docked,
    });
  }

  function keepInViewport() {
    const rect = panel.getBoundingClientRect();
    const maxTop = Math.max(8, window.innerHeight - rect.height - 8);
    const top = Math.min(Math.max(rect.top, 8), maxTop);
    panel.style.top = `${Math.round(top)}px`;

    if (panel.classList.contains('gam-detached')) {
      const maxLeft = Math.max(8, window.innerWidth - rect.width - 8);
      const left = Math.min(Math.max(rect.left, 8), maxLeft);
      panel.style.left = `${Math.round(left)}px`;
      panel.style.right = 'auto';
    } else {
      panel.style.left = 'auto';
      panel.style.right = '0';
    }
  }

  function restorePosition() {
    const saved = GM_getValue(POSITION_KEY, null);
    if (!saved || typeof saved !== 'object') return;
    if (Number.isFinite(saved.top)) panel.style.top = `${saved.top}px`;
    if (saved.docked === false && Number.isFinite(saved.left)) {
      panel.classList.add('gam-detached');
      panel.style.left = `${saved.left}px`;
      panel.style.right = 'auto';
    }
    keepInViewport();
  }

  function makeDraggable(handle, { suppressClick = false } = {}) {
    handle.style.touchAction = 'none';
    handle.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('.gam-close')) return;

      // Freeze the compact handle before measuring it so an idle :hover expansion
      // cannot make the panel jump when dragging starts.
      panel.classList.add('gam-dragging');
      const startRect = panel.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      let dragging = false;

      handle.setPointerCapture(event.pointerId);

      const onMove = (moveEvent) => {
        const dx = moveEvent.clientX - startX;
        const dy = moveEvent.clientY - startY;
        if (!dragging && Math.hypot(dx, dy) < 4) return;

        if (!dragging) {
          dragging = true;
          panel.classList.add('gam-detached');
          panel.style.right = 'auto';
        }

        const width = panel.getBoundingClientRect().width;
        const height = panel.getBoundingClientRect().height;
        const left = Math.min(Math.max(startRect.left + dx, 8), Math.max(8, window.innerWidth - width - 8));
        const top = Math.min(Math.max(startRect.top + dy, 8), Math.max(8, window.innerHeight - height - 8));
        panel.style.left = `${Math.round(left)}px`;
        panel.style.top = `${Math.round(top)}px`;
      };

      const onEnd = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);

        if (!dragging) {
          panel.classList.remove('gam-dragging');
          return;
        }
        const rect = panel.getBoundingClientRect();
        if (window.innerWidth - rect.right < 28) {
          panel.classList.remove('gam-detached');
          panel.style.left = 'auto';
          panel.style.right = '0';
        }
        panel.classList.remove('gam-dragging');
        keepInViewport();
        savePosition();
        if (suppressClick) suppressPeekClick = true;
      };

      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
    });
  }

  restorePosition();
  makeDraggable(peek, { suppressClick: true });
  makeDraggable(header);
  window.addEventListener('resize', keepInViewport);

  peek.addEventListener('click', () => {
    if (suppressPeekClick) {
      suppressPeekClick = false;
      return;
    }
    manualOpen = true;
    window.clearTimeout(collapseTimer);
    panel.classList.add('gam-open');
    panel.classList.remove('gam-idle');
    keepInViewport();
    logBox.scrollTop = logBox.scrollHeight;
  });

  close.addEventListener('click', () => {
    manualOpen = false;
    panel.classList.remove('gam-open');
    panel.classList.add('gam-idle');
    keepInViewport();
    savePosition();
    peek.focus();
  });

  function parseField(text, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(new RegExp(`(?:^|\\s)${escaped}=("(?:\\\\.|[^"\\\\])*"|\\[[^\\]]*\\]|[^\\s]+)`));
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
        ''
      );
    }

    return { action, detail: detail || 'completed', time, raw: text };
  }

  function appendEvent(summary) {
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
    logBox.appendChild(node);

    while (logBox.children.length > MAX_VISIBLE_LINES) {
      logBox.firstElementChild.remove();
    }
    logBox.scrollTop = logBox.scrollHeight;
  }

  function appendHint(message) {
    const node = document.createElement('div');
    node.className = 'gam-entry gam-hint';
    node.textContent = message;
    logBox.appendChild(node);
    while (logBox.children.length > MAX_VISIBLE_LINES) {
      logBox.firstElementChild.remove();
    }
    logBox.scrollTop = logBox.scrollHeight;
  }

  function showActivity(summary) {
    currentAction.textContent = summary.action;
    currentDetail.textContent = summary.detail;
    if (manualOpen) return;

    panel.classList.remove('gam-idle');
    window.clearTimeout(collapseTimer);
    collapseTimer = window.setTimeout(() => {
      if (!manualOpen) panel.classList.add('gam-idle');
    }, IDLE_COLLAPSE_MS);
  }

  function showAttention(action, detail) {
    currentAction.textContent = action;
    currentDetail.textContent = detail;
    if (!manualOpen) panel.classList.remove('gam-idle');
    window.clearTimeout(collapseTimer);
  }

  function setStatus(state) {
    if (state) panel.dataset.status = state;
    else delete panel.dataset.status;
  }

  function scheduleRetry(message) {
    setStatus('error');
    showAttention('连接异常', '2 秒后重试');
    if (message) appendHint(message);
    window.setTimeout(poll, RETRY_MS);
  }

  function poll() {
    if (stopped) return;

    const backend = GM_getValue(BACKEND_KEY, '').trim().replace(/\/+$/, '');
    const token = GM_getValue(TOKEN_KEY, '').trim();
    if (!backend) {
      setStatus('error');
      showAttention('需要配置后端', '点击后查看提示');
      if (!logBox.children.length) appendHint('请从篡改猴菜单设置后端地址。');
      return;
    }

    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;

    GM_xmlhttpRequest({
      method: 'GET',
      url: `${backend}/v1/action-logs?after=${lastId}&wait=${POLL_WAIT_SECONDS}&limit=50`,
      headers,
      timeout: (POLL_WAIT_SECONDS + 5) * 1000,
      onload(response) {
        if (response.status === 401) {
          stopped = true;
          setStatus('error');
          showAttention('认证失败', '检查 Bearer Token');
          appendHint('认证失败：请检查 Bearer Token。');
          return;
        }
        if (response.status < 200 || response.status >= 300) {
          scheduleRetry(`后端返回 HTTP ${response.status}，2 秒后重试。`);
          return;
        }

        try {
          const body = JSON.parse(response.responseText);
          let newest = null;
          for (const item of body.items || []) {
            newest = summarize(item.text);
            appendEvent(newest);
          }
          if (Number.isInteger(body.last_id)) lastId = body.last_id;
          setStatus('online');
          if (newest) showActivity(newest);
          window.setTimeout(poll, 30);
        } catch (error) {
          scheduleRetry(`响应解析失败：${String(error)}`);
        }
      },
      onerror() {
        scheduleRetry('连接后端失败，2 秒后重试。');
      },
      ontimeout() {
        window.setTimeout(poll, 30);
      },
    });
  }

  poll();
})();
