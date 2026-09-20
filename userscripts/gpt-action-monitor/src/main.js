// ==UserScript==
// @name         GPT Action Monitor
// @namespace    https://github.com/qqq694637644/github_skills_action
// @version      0.4.1
// @description  Show github_skills_action activity as a calm, energy-conscious status indicator on ChatGPT.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      *
// ==/UserScript==

import * as MonitorConstants from './constants.js';
import { summarize } from './formatter/action-formatter.js';
import { loadProfiles, profileForName, validateBackend } from './profile/profile-store.js';
import { createActionLogClient } from './api/action-log-client.js';
import { createEventStore } from './store/event-store.js';

(function () {
  'use strict';

  const {
    PROFILES_KEY,
    POSITION_KEY,
    GPT_TITLE_SELECTOR,
    ACTIVITY_VISIBLE_MS,
    UI_COALESCE_MS,
    MAX_HISTORY,
    COMPACT_WIDTH,
  } = MonitorConstants;

  let stopped = false;
  let monitorActive = false;
  let activeTitleElement = null;
  let activeProfile = null;
  let gateObserver = null;
  let manualOpen = false;
  let suppressHandleClick = false;
  let activityTimer = null;
  let uiTimer = null;
  let pendingLatest = null;
  const eventStore = createEventStore();
  let profiles = loadProfiles();
  let settingsOverlay = null;
  let settingsStyle = null;
  let actionLogClient = null;

  function titleName(element) {
    return (element?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  GM_registerMenuCommand('⚙ 监控配置...', openSettings);

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

  function backendLabel(backend) {
    try {
      const parsed = new URL(backend);
      return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
    } catch (_) {
      return backend;
    }
  }

  function applyProfiles(nextProfiles) {
    profiles = nextProfiles.map(normalizeProfile);
    GM_setValue(PROFILES_KEY, profiles);
    if (monitorActive) deactivateMonitor();
    if (document.visibilityState === 'visible') evaluateActivation();
  }

  function closeSettings() {
    settingsOverlay?.remove();
    settingsStyle?.remove();
    settingsOverlay = null;
    settingsStyle = null;
  }

  function testProfileConnection(profile, statusElement, button) {
    const validation = validateBackend(profile.backend);
    if (!validation.ok) {
      statusElement.textContent = validation.message;
      statusElement.dataset.state = 'error';
      return;
    }

    button.disabled = true;
    statusElement.textContent = '正在测试连接…';
    statusElement.dataset.state = 'pending';
    const headers = {};
    if (profile.token) headers.Authorization = `Bearer ${profile.token}`;

    GM_xmlhttpRequest({
      method: 'GET',
      url: `${validation.backend}/v1/action-logs?after=${Number.MAX_SAFE_INTEGER}&wait=0&limit=1`,
      headers,
      timeout: 7000,
      onload(response) {
        button.disabled = false;
        if (response.status >= 200 && response.status < 300) {
          statusElement.textContent = '✓ 连接成功';
          statusElement.dataset.state = 'success';
        } else if (response.status === 401) {
          statusElement.textContent = '认证失败，请检查 Bearer Token。';
          statusElement.dataset.state = 'error';
        } else {
          statusElement.textContent = `后端返回 HTTP ${response.status}。`;
          statusElement.dataset.state = 'error';
        }
      },
      onerror() {
        button.disabled = false;
        statusElement.textContent = '无法连接后端。';
        statusElement.dataset.state = 'error';
      },
      ontimeout() {
        button.disabled = false;
        statusElement.textContent = '连接超时。';
        statusElement.dataset.state = 'error';
      },
    });
  }

  function openSettings() {
    if (settingsOverlay?.isConnected) return;

    settingsStyle = document.createElement('style');
    settingsStyle.textContent = `
      #gam-settings-overlay {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: grid;
        place-items: center;
        padding: 20px;
        box-sizing: border-box;
        background: rgba(0, 0, 0, .28);
        color-scheme: light dark;
        font: 13px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #gam-settings-overlay * { box-sizing: border-box; }
      #gam-settings-overlay .gam-settings-card {
        width: min(620px, 100%);
        max-height: min(720px, calc(100vh - 40px));
        display: flex;
        flex-direction: column;
        overflow: hidden;
        border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
        border-radius: 14px;
        background: Canvas;
        color: CanvasText;
        box-shadow: 0 18px 48px rgba(0, 0, 0, .22);
      }
      #gam-settings-overlay .gam-settings-header {
        height: 52px;
        flex: 0 0 52px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0 14px 0 18px;
        border-bottom: 1px solid color-mix(in srgb, CanvasText 10%, transparent);
      }
      #gam-settings-overlay .gam-settings-title { font-size: 15px; font-weight: 650; }
      #gam-settings-overlay button,
      #gam-settings-overlay input { font: inherit; }
      #gam-settings-overlay button { color: inherit; }
      #gam-settings-overlay .gam-icon-button {
        width: 30px;
        height: 30px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        cursor: pointer;
        font-size: 19px;
      }
      #gam-settings-overlay .gam-icon-button:hover { background: color-mix(in srgb, CanvasText 7%, transparent); }
      #gam-settings-overlay .gam-settings-body {
        min-height: 0;
        overflow-y: auto;
        padding: 14px 16px 16px;
      }
      #gam-settings-overlay .gam-settings-note {
        margin: 0 0 12px;
        color: color-mix(in srgb, CanvasText 62%, transparent);
        font-size: 12px;
      }
      #gam-settings-overlay .gam-profile-list { display: grid; gap: 8px; }
      #gam-settings-overlay .gam-profile-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 12px;
        align-items: center;
        min-height: 58px;
        padding: 9px 10px 9px 12px;
        border: 1px solid color-mix(in srgb, CanvasText 11%, transparent);
        border-radius: 10px;
      }
      #gam-settings-overlay .gam-profile-main { min-width: 0; }
      #gam-settings-overlay .gam-profile-name-line {
        display: flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
      }
      #gam-settings-overlay .gam-profile-state {
        width: 7px;
        height: 7px;
        flex: 0 0 7px;
        border-radius: 50%;
        background: #22a35a;
      }
      #gam-settings-overlay .gam-profile-row[data-enabled="false"] .gam-profile-state { background: #8b8b8b; }
      #gam-settings-overlay .gam-profile-name {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-weight: 620;
      }
      #gam-settings-overlay .gam-profile-backend {
        margin: 3px 0 0 14px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: color-mix(in srgb, CanvasText 58%, transparent);
        font-size: 12px;
      }
      #gam-settings-overlay .gam-button {
        min-height: 32px;
        padding: 5px 11px;
        border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
        border-radius: 8px;
        background: color-mix(in srgb, Canvas 96%, CanvasText 4%);
        cursor: pointer;
      }
      #gam-settings-overlay .gam-button:hover { background: color-mix(in srgb, Canvas 91%, CanvasText 9%); }
      #gam-settings-overlay .gam-button:disabled { cursor: default; opacity: .5; }
      #gam-settings-overlay .gam-button-primary {
        border-color: #2f7d4b;
        background: #237a42;
        color: white;
      }
      #gam-settings-overlay .gam-button-primary:hover { background: #1d6938; }
      #gam-settings-overlay .gam-list-footer {
        display: flex;
        justify-content: flex-start;
        margin-top: 12px;
      }
      #gam-settings-overlay .gam-empty {
        padding: 34px 18px;
        border: 1px dashed color-mix(in srgb, CanvasText 18%, transparent);
        border-radius: 10px;
        text-align: center;
        color: color-mix(in srgb, CanvasText 58%, transparent);
      }
      #gam-settings-overlay .gam-editor { display: grid; gap: 13px; }
      #gam-settings-overlay .gam-editor[hidden],
      #gam-settings-overlay .gam-list-view[hidden] { display: none; }
      #gam-settings-overlay .gam-field { display: grid; gap: 6px; }
      #gam-settings-overlay .gam-field > span { font-weight: 600; }
      #gam-settings-overlay .gam-input {
        width: 100%;
        height: 36px;
        padding: 0 10px;
        border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
        border-radius: 8px;
        background: Canvas;
        color: CanvasText;
        outline: none;
      }
      #gam-settings-overlay .gam-input:focus { border-color: #4f8e68; box-shadow: 0 0 0 2px rgba(35, 122, 66, .12); }
      #gam-settings-overlay .gam-token-row { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 7px; }
      #gam-settings-overlay .gam-check-row { display: flex; gap: 8px; align-items: center; }
      #gam-settings-overlay .gam-form-message { min-height: 19px; font-size: 12px; }
      #gam-settings-overlay .gam-form-message[data-state="error"] { color: #c53e3e; }
      #gam-settings-overlay .gam-form-message[data-state="success"] { color: #238349; }
      #gam-settings-overlay .gam-form-message[data-state="pending"] { color: color-mix(in srgb, CanvasText 60%, transparent); }
      #gam-settings-overlay .gam-editor-footer {
        display: flex;
        gap: 8px;
        align-items: center;
        margin-top: 2px;
      }
      #gam-settings-overlay .gam-editor-footer .gam-spacer { flex: 1; }
      #gam-settings-overlay .gam-delete { color: #b63c3c; }
      @media (max-width: 520px) {
        #gam-settings-overlay { padding: 8px; }
        #gam-settings-overlay .gam-settings-card { max-height: calc(100vh - 16px); }
        #gam-settings-overlay .gam-editor-footer { flex-wrap: wrap; }
      }
    `;

    settingsOverlay = document.createElement('div');
    settingsOverlay.id = 'gam-settings-overlay';
    settingsOverlay.innerHTML = `
      <div class="gam-settings-card" role="dialog" aria-modal="true" aria-labelledby="gam-settings-title">
        <div class="gam-settings-header">
          <div class="gam-settings-title" id="gam-settings-title">Action Monitor 配置</div>
          <button class="gam-icon-button gam-settings-close" type="button" aria-label="关闭配置">×</button>
        </div>
        <div class="gam-settings-body">
          <section class="gam-list-view">
            <p class="gam-settings-note">当前 GPT 名称会精确匹配一条已启用配置；没有匹配时监控不会运行。</p>
            <div class="gam-profile-list"></div>
            <div class="gam-list-footer">
              <button class="gam-button gam-add-profile" type="button">＋ 添加监控目标</button>
            </div>
          </section>
          <form class="gam-editor" hidden>
            <label class="gam-field">
              <span>GPT 名称</span>
              <input class="gam-input gam-gpt-name" type="text" autocomplete="off" placeholder="例如 github_skill" required>
            </label>
            <label class="gam-field">
              <span>后端地址</span>
              <input class="gam-input gam-backend" type="url" autocomplete="off" placeholder="https://skills.example.com" required>
            </label>
            <label class="gam-field">
              <span>Bearer Token</span>
              <div class="gam-token-row">
                <input class="gam-input gam-token" type="password" autocomplete="off" placeholder="未启用认证可留空">
                <button class="gam-button gam-token-toggle" type="button">显示</button>
              </div>
            </label>
            <label class="gam-check-row">
              <input class="gam-enabled" type="checkbox" checked>
              <span>启用此监控</span>
            </label>
            <div class="gam-form-message" aria-live="polite"></div>
            <div class="gam-editor-footer">
              <button class="gam-button gam-delete" type="button">删除</button>
              <span class="gam-spacer"></span>
              <button class="gam-button gam-test" type="button">测试连接</button>
              <button class="gam-button gam-cancel-edit" type="button">取消</button>
              <button class="gam-button gam-button-primary gam-save" type="submit">保存</button>
            </div>
          </form>
        </div>
      </div>
    `;

    document.documentElement.appendChild(settingsStyle);
    document.body.appendChild(settingsOverlay);

    const listView = settingsOverlay.querySelector('.gam-list-view');
    const list = settingsOverlay.querySelector('.gam-profile-list');
    const editor = settingsOverlay.querySelector('.gam-editor');
    const gptNameInput = settingsOverlay.querySelector('.gam-gpt-name');
    const backendInput = settingsOverlay.querySelector('.gam-backend');
    const tokenInput = settingsOverlay.querySelector('.gam-token');
    const enabledInput = settingsOverlay.querySelector('.gam-enabled');
    const formMessage = settingsOverlay.querySelector('.gam-form-message');
    const deleteButton = settingsOverlay.querySelector('.gam-delete');
    const testButton = settingsOverlay.querySelector('.gam-test');
    let editingId = null;

    function renderList() {
      list.replaceChildren();
      if (!profiles.length) {
        const empty = document.createElement('div');
        empty.className = 'gam-empty';
        empty.textContent = '还没有监控配置。添加一组 GPT、后端地址和 Bearer Token。';
        list.appendChild(empty);
        return;
      }

      for (const profile of profiles) {
        const row = document.createElement('div');
        row.className = 'gam-profile-row';
        row.dataset.enabled = String(profile.enabled);

        const main = document.createElement('div');
        main.className = 'gam-profile-main';
        const nameLine = document.createElement('div');
        nameLine.className = 'gam-profile-name-line';
        const dot = document.createElement('span');
        dot.className = 'gam-profile-state';
        const name = document.createElement('span');
        name.className = 'gam-profile-name';
        name.textContent = profile.gptName;
        const backend = document.createElement('div');
        backend.className = 'gam-profile-backend';
        backend.textContent = `${profile.enabled ? '已启用' : '已停用'} · ${backendLabel(profile.backend)}`;
        nameLine.append(dot, name);
        main.append(nameLine, backend);

        const edit = document.createElement('button');
        edit.className = 'gam-button';
        edit.type = 'button';
        edit.textContent = '编辑';
        edit.addEventListener('click', () => showEditor(profile));
        row.append(main, edit);
        list.appendChild(row);
      }
    }

    function clearMessage() {
      formMessage.textContent = '';
      delete formMessage.dataset.state;
    }

    function showEditor(profile = null) {
      editingId = profile?.id || null;
      gptNameInput.value = profile?.gptName || '';
      backendInput.value = profile?.backend || '';
      tokenInput.value = profile?.token || '';
      tokenInput.type = 'password';
      settingsOverlay.querySelector('.gam-token-toggle').textContent = '显示';
      enabledInput.checked = profile?.enabled !== false;
      deleteButton.hidden = !profile;
      clearMessage();
      listView.hidden = true;
      editor.hidden = false;
      window.setTimeout(() => gptNameInput.focus(), 0);
    }

    function showList() {
      editor.hidden = true;
      listView.hidden = false;
      editingId = null;
      renderList();
    }

    function formProfile() {
      return {
        id: editingId || createProfileId(),
        gptName: gptNameInput.value.trim(),
        backend: normalizeBackend(backendInput.value),
        token: tokenInput.value.trim(),
        enabled: enabledInput.checked,
      };
    }

    function validateProfile(profile) {
      if (!profile.gptName) return '请输入 GPT 名称。';
      const duplicate = profiles.find(
        (item) => item.id !== editingId && item.gptName === profile.gptName,
      );
      if (duplicate) return `GPT 名称 “${profile.gptName}” 已存在。`;
      const backendValidation = validateBackend(profile.backend);
      if (!backendValidation.ok) return backendValidation.message;
      profile.backend = backendValidation.backend;
      return '';
    }

    settingsOverlay.querySelector('.gam-settings-close').addEventListener('click', closeSettings);
    settingsOverlay.querySelector('.gam-add-profile').addEventListener('click', () => showEditor());
    settingsOverlay.querySelector('.gam-cancel-edit').addEventListener('click', showList);
    settingsOverlay.querySelector('.gam-token-toggle').addEventListener('click', (event) => {
      const visible = tokenInput.type === 'text';
      tokenInput.type = visible ? 'password' : 'text';
      event.currentTarget.textContent = visible ? '显示' : '隐藏';
    });
    testButton.addEventListener('click', () => {
      const profile = formProfile();
      clearMessage();
      testProfileConnection(profile, formMessage, testButton);
    });
    deleteButton.addEventListener('click', () => {
      if (!editingId) return;
      const profile = profiles.find((item) => item.id === editingId);
      if (!profile || !confirm(`删除 “${profile.gptName}” 的监控配置？`)) return;
      applyProfiles(profiles.filter((item) => item.id !== editingId));
      showList();
    });
    editor.addEventListener('submit', (event) => {
      event.preventDefault();
      const profile = formProfile();
      const error = validateProfile(profile);
      if (error) {
        formMessage.textContent = error;
        formMessage.dataset.state = 'error';
        return;
      }

      const next = editingId
        ? profiles.map((item) => (item.id === editingId ? profile : item))
        : [...profiles, profile];
      applyProfiles(next);
      showList();
    });
    settingsOverlay.addEventListener('click', (event) => {
      if (event.target === settingsOverlay) closeSettings();
    });
    settingsOverlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!editor.hidden) showList();
        else closeSettings();
      }
    });

    renderList();
    settingsOverlay.querySelector('.gam-settings-close').focus();
  }

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

  function recordEvent(summary) {
    eventStore.add(summary);
    if (manualOpen) {
      logBox.appendChild(createEventNode(summary));
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  function recordHint(message) {
    const previous = eventStore.all().at(-1);
    if (previous?.kind === 'hint' && previous.message === message) return;
    eventStore.addHint(message);
    if (manualOpen) {
      logBox.appendChild(createHintNode(message));
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  function renderHistory() {
    const fragment = document.createDocumentFragment();
    for (const item of eventStore.all()) {
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

  function suspendPolling() {
    actionLogClient?.suspend();
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
    actionLogClient?.resume();
  }

  function matchingProfile(element) {
    if (
      !element ||
      element.nodeType !== Node.ELEMENT_NODE ||
      !element.matches(GPT_TITLE_SELECTOR)
    ) {
      return null;
    }
    return profileForName(profiles, titleName(element));
  }

  function findTargetTitle(root = document) {
    if (root.nodeType === Node.ELEMENT_NODE) {
      const profile = matchingProfile(root);
      if (profile) return { element: root, profile };
    }
    if (typeof root.querySelectorAll !== 'function') return null;
    for (const element of root.querySelectorAll(GPT_TITLE_SELECTOR)) {
      const profile = matchingProfile(element);
      if (profile) return { element, profile };
    }
    return null;
  }

  function resetSessionState() {
    eventStore.clear();
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

  function activateMonitor(titleElement, profile) {
    if (monitorActive && activeProfile?.id === profile.id) {
      activeTitleElement = titleElement;
      activeProfile = profile;
      return;
    }
    if (monitorActive) deactivateMonitor();
    monitorActive = true;
    activeTitleElement = titleElement;
    activeProfile = profile;
    actionLogClient = createActionLogClient({
      getProfile: () => activeProfile,
      onItems(items) {
        let newest = null;
        for (const item of items) {
          newest = summarize(item.text);
          recordEvent(newest);
        }
        if (newest) queueActivity(newest);
        else if (panel.dataset.status === 'error') {
          panel.classList.remove('gam-chip-visible');
          setStatus('idle');
        }
      },
      onHint(message) {
        recordHint(message);
        showAttention('连接异常', '3 秒后重试');
      },
      onStatus(status) {
        if (status === 'idle' && panel.dataset.status === 'error') setStatus('idle');
      },
    });
    resetSessionState();
    mountUi();
    setStatus('idle');
    if (document.visibilityState === 'visible') actionLogClient.start();
  }

  function deactivateMonitor() {
    if (!monitorActive) return;
    monitorActive = false;
    activeTitleElement = null;
    activeProfile = null;
    actionLogClient?.stop();
    actionLogClient = null;
    suspendPolling();
    resetSessionState();
    unmountUi();
  }

  function evaluateActivation() {
    const target = findTargetTitle(document);
    if (target) activateMonitor(target.element, target.profile);
    else deactivateMonitor();
  }

  function targetFromMutation(mutation) {
    const mutationElement = mutation.target.nodeType === Node.ELEMENT_NODE
      ? mutation.target
      : mutation.target.parentElement;
    const containingTitle = mutationElement?.closest?.(GPT_TITLE_SELECTOR);
    const containingProfile = matchingProfile(containingTitle);
    if (containingProfile) return { element: containingTitle, profile: containingProfile };

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
        const currentProfile = activeTitleElement?.isConnected
          ? matchingProfile(activeTitleElement)
          : null;
        if (currentProfile?.id === activeProfile?.id) return;
        evaluateActivation();
        return;
      }

      for (const mutation of mutations) {
        const target = targetFromMutation(mutation);
        if (target) {
          activateMonitor(target.element, target.profile);
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
