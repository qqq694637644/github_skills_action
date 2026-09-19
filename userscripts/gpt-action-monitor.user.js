// ==UserScript==
// @name         GPT Action Monitor
// @namespace    https://github.com/qqq694637644/github_skills_action
// @version      0.1.0
// @description  Show recent github_skills_action calls in a small scrolling panel on ChatGPT.
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
  const POLL_WAIT_SECONDS = 25;
  const RETRY_MS = 2000;
  const MAX_VISIBLE_LINES = 80;

  let lastId = 0;
  let stopped = false;

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
  panel.innerHTML = `
    <div class="gam-header">
      <span><span class="gam-dot"></span> GPT Actions</span>
      <button class="gam-toggle" title="收起">−</button>
    </div>
    <div class="gam-log"></div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #gpt-action-monitor {
      position: fixed;
      right: 12px;
      top: 92px;
      width: 310px;
      height: 260px;
      z-index: 2147483647;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      border: 1px solid rgba(127, 127, 127, .28);
      border-radius: 10px;
      background: rgba(24, 24, 27, .92);
      color: #e4e4e7;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .18);
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      backdrop-filter: blur(8px);
    }
    #gpt-action-monitor.gam-collapsed { height: 34px; }
    #gpt-action-monitor .gam-header {
      height: 34px;
      flex: 0 0 34px;
      box-sizing: border-box;
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 9px;
      border-bottom: 1px solid rgba(127, 127, 127, .2);
      font-family: system-ui, sans-serif;
      font-size: 12px;
      font-weight: 600;
    }
    #gpt-action-monitor .gam-dot {
      display: inline-block;
      width: 7px;
      height: 7px;
      margin-right: 5px;
      border-radius: 50%;
      background: #71717a;
      vertical-align: 1px;
    }
    #gpt-action-monitor .gam-dot.online { background: #22c55e; }
    #gpt-action-monitor .gam-dot.error { background: #ef4444; }
    #gpt-action-monitor .gam-toggle {
      border: 0;
      background: transparent;
      color: inherit;
      cursor: pointer;
      font-size: 17px;
      line-height: 1;
      padding: 2px 5px;
    }
    #gpt-action-monitor .gam-log {
      flex: 1;
      overflow-y: auto;
      padding: 8px 9px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    #gpt-action-monitor .gam-line { margin: 0 0 7px; opacity: .92; }
    #gpt-action-monitor .gam-hint { opacity: .62; }
  `;

  document.documentElement.appendChild(style);
  document.body.appendChild(panel);

  const logBox = panel.querySelector('.gam-log');
  const dot = panel.querySelector('.gam-dot');
  const toggle = panel.querySelector('.gam-toggle');

  toggle.addEventListener('click', () => {
    const collapsed = panel.classList.toggle('gam-collapsed');
    toggle.textContent = collapsed ? '+' : '−';
    toggle.title = collapsed ? '展开' : '收起';
  });

  function appendLine(text, className = 'gam-line') {
    const node = document.createElement('div');
    node.className = className;
    node.textContent = text;
    logBox.appendChild(node);
    while (logBox.children.length > MAX_VISIBLE_LINES) {
      logBox.firstElementChild.remove();
    }
    logBox.scrollTop = logBox.scrollHeight;
  }

  function setStatus(state) {
    dot.classList.remove('online', 'error');
    if (state) dot.classList.add(state);
  }

  function scheduleRetry(message) {
    setStatus('error');
    if (message) appendLine(message, 'gam-line gam-hint');
    window.setTimeout(poll, RETRY_MS);
  }

  function poll() {
    if (stopped) return;

    const backend = GM_getValue(BACKEND_KEY, '').trim().replace(/\/+$/, '');
    const token = GM_getValue(TOKEN_KEY, '').trim();
    if (!backend) {
      setStatus('error');
      if (!logBox.children.length) {
        appendLine('请从篡改猴菜单设置后端地址。', 'gam-line gam-hint');
      }
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
          appendLine('认证失败：请检查 Bearer Token。', 'gam-line gam-hint');
          return;
        }
        if (response.status < 200 || response.status >= 300) {
          scheduleRetry(`后端返回 HTTP ${response.status}，2 秒后重试。`);
          return;
        }

        try {
          const body = JSON.parse(response.responseText);
          for (const item of body.items || []) {
            appendLine(item.text);
          }
          if (Number.isInteger(body.last_id)) lastId = body.last_id;
          setStatus('online');
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
