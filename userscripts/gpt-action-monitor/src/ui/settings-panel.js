import {
  createEndpoint,
  normalizeBackend,
  validateBackend,
} from '../profile/profile-store.js';
import { SETTINGS_CSS } from './styles.js';

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
    url: `${validation.backend}/v1/action-workspaces`,
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

function cloneEndpoints(endpoints) {
  return (endpoints || []).map((endpoint) => ({ ...endpoint }));
}

function endpointSnapshot(endpoints) {
  return JSON.stringify((endpoints || []).map((endpoint) => ({
    id: endpoint.id,
    name: String(endpoint.name || '').trim(),
    backend: normalizeBackend(endpoint.backend),
    token: String(endpoint.token || '').trim(),
  })));
}

function endpointName(endpoints, endpointId) {
  return endpoints.find((endpoint) => endpoint.id === endpointId)?.name || '';
}

export function createSettingsPanel({
  getState,
  onSaveEndpoints,
  onSetGlobalEndpoint,
  onUsePageEndpoint,
  onRestoreGlobalEndpoint,
  onSetSoundAlertEnabled,
  onSetSoundAlertDelayMinutes,
  onSetSoundAlertDurationSeconds,
  onTestSound,
}) {
  let overlay = null;
  let style = null;

  function close() {
    overlay?.remove();
    style?.remove();
    overlay = null;
    style = null;
  }

  function open() {
    if (overlay?.isConnected) return;

    const initialState = getState();
    let draftEndpoints = cloneEndpoints(initialState.endpoints);
    if (!draftEndpoints.length) draftEndpoints.push(createEndpoint(0));
    let persistedSnapshot = endpointSnapshot(initialState.endpoints);
    let editingEndpointId = draftEndpoints.some(
      (endpoint) => endpoint.id === initialState.effectiveEndpointId,
    )
      ? initialState.effectiveEndpointId
      : draftEndpoints.some((endpoint) => endpoint.id === initialState.globalActiveEndpointId)
        ? initialState.globalActiveEndpointId
        : draftEndpoints[0].id;

    style = document.createElement('style');
    style.textContent = SETTINGS_CSS;
    overlay = document.createElement('div');
    overlay.id = 'gam-settings-overlay';
    overlay.innerHTML = `
      <div class="gam-settings-card" role="dialog" aria-modal="true" aria-labelledby="gam-settings-title">
        <div class="gam-settings-header">
          <div class="gam-settings-title" id="gam-settings-title">Action Monitor 配置</div>
          <button class="gam-icon-button gam-settings-close" type="button" aria-label="关闭配置">×</button>
        </div>
        <div class="gam-settings-body">
          <p class="gam-settings-note">接口配置永久保存；保存配置不会改变当前使用的接口。全局默认用于未绑定网址；当前网址可单独绑定接口和 Workspace。最多保留 20 条网址记录，超出后自动删除最久未修改的记录。</p>
          <form class="gam-editor">
            <section class="gam-settings-section">
              <div class="gam-section-heading">接口配置</div>
              <div class="gam-field">
                <span>编辑接口</span>
                <div class="gam-endpoint-row">
                  <select class="gam-input gam-endpoint-select" aria-label="选择要编辑的接口"></select>
                  <button class="gam-button gam-add-endpoint" type="button">添加</button>
                  <button class="gam-button gam-delete-endpoint" type="button">删除</button>
                </div>
              </div>
              <label class="gam-field">
                <span>接口名称</span>
                <input class="gam-input gam-name" type="text" autocomplete="off" placeholder="例如 skill_action" required>
              </label>
              <label class="gam-field">
                <span>后端地址</span>
                <input class="gam-input gam-backend" type="url" autocomplete="off" placeholder="https://githubaction.giize.com/mcp-app" required>
              </label>
              <label class="gam-field">
                <span>Bearer Token</span>
                <div class="gam-token-row">
                  <input class="gam-input gam-token" type="password" autocomplete="off" placeholder="未启用认证可留空">
                  <button class="gam-button gam-token-toggle" type="button">显示</button>
                </div>
              </label>
              <div class="gam-config-actions">
                <button class="gam-button gam-test" type="button">测试连接</button>
                <button class="gam-button gam-button-primary gam-save" type="submit">保存配置</button>
              </div>
            </section>

            <section class="gam-settings-section gam-usage-section">
              <div class="gam-section-heading">使用状态</div>
              <div class="gam-usage-grid">
                <span>全局默认</span><strong class="gam-global-value"></strong>
                <span>当前网址</span><strong class="gam-current-value"></strong>
                <span>当前编辑</span><strong class="gam-editing-value"></strong>
              </div>
              <div class="gam-usage-actions">
                <button class="gam-button gam-set-global" type="button">设为全局默认</button>
                <button class="gam-button gam-use-page" type="button">绑定当前网址</button>
                <button class="gam-button gam-restore-global" type="button">恢复全局默认</button>
              </div>
              <div class="gam-usage-note"></div>
            </section>

            <section class="gam-settings-section gam-sound-section">
              <div class="gam-sound-heading-row">
                <div class="gam-section-heading">声音提醒</div>
                <label class="gam-sound-switch" title="全局开启或关闭声音提醒">
                  <input class="gam-sound-enabled" type="checkbox" aria-label="全局开启声音提醒">
                  <span class="gam-sound-switch-track" aria-hidden="true"></span>
                </label>
              </div>
              <div class="gam-sound-row">
                <label class="gam-sound-setting">
                  <input class="gam-sound-number gam-sound-delay" type="number" min="1" max="1440" step="1" inputmode="numeric">
                  <span>分钟无日志时播放提示音</span>
                </label>
              </div>
              <div class="gam-sound-row">
                <label class="gam-sound-setting">
                  <span>提醒持续</span>
                  <input class="gam-sound-number gam-sound-duration" type="number" min="1" max="60" step="1" inputmode="numeric">
                  <span>秒</span>
                </label>
                <button class="gam-button gam-test-sound" type="button">测试声音</button>
              </div>
              <div class="gam-sound-note">全局配置。已选择 Workspace 收到第一条日志后自动监测；有新日志会自动重新计时。</div>
            </section>

            <div class="gam-form-message" aria-live="polite"></div>
          </form>
        </div>
      </div>
    `;

    document.documentElement.appendChild(style);
    document.body.appendChild(overlay);

    const editor = overlay.querySelector('.gam-editor');
    const endpointSelect = overlay.querySelector('.gam-endpoint-select');
    const nameInput = overlay.querySelector('.gam-name');
    const backendInput = overlay.querySelector('.gam-backend');
    const tokenInput = overlay.querySelector('.gam-token');
    const deleteButton = overlay.querySelector('.gam-delete-endpoint');
    const formMessage = overlay.querySelector('.gam-form-message');
    const usageNote = overlay.querySelector('.gam-usage-note');
    const testButton = overlay.querySelector('.gam-test');
    const setGlobalButton = overlay.querySelector('.gam-set-global');
    const usePageButton = overlay.querySelector('.gam-use-page');
    const restoreGlobalButton = overlay.querySelector('.gam-restore-global');
    const globalValue = overlay.querySelector('.gam-global-value');
    const currentValue = overlay.querySelector('.gam-current-value');
    const editingValue = overlay.querySelector('.gam-editing-value');
    const soundEnabledInput = overlay.querySelector('.gam-sound-enabled');
    const soundDelayInput = overlay.querySelector('.gam-sound-delay');
    const soundDurationInput = overlay.querySelector('.gam-sound-duration');
    const testSoundButton = overlay.querySelector('.gam-test-sound');
    const soundNote = overlay.querySelector('.gam-sound-note');
    soundEnabledInput.checked = Boolean(initialState.soundAlertEnabled);
    soundDelayInput.value = String(initialState.soundAlertDelayMinutes);
    soundDurationInput.value = String(initialState.soundAlertDurationSeconds);

    function currentDraftEndpoint() {
      return draftEndpoints.find((endpoint) => endpoint.id === editingEndpointId) || null;
    }

    function clearMessage() {
      formMessage.textContent = '';
      delete formMessage.dataset.state;
    }

    function showError(message) {
      formMessage.textContent = message;
      formMessage.dataset.state = 'error';
    }

    function showSuccess(message) {
      formMessage.textContent = message;
      formMessage.dataset.state = 'success';
    }

    function commitFields() {
      const endpoint = currentDraftEndpoint();
      if (!endpoint) return;
      endpoint.name = nameInput.value.trim();
      endpoint.backend = normalizeBackend(backendInput.value);
      endpoint.token = tokenInput.value.trim();
    }

    function hasUnsavedChanges() {
      commitFields();
      return endpointSnapshot(draftEndpoints) !== persistedSnapshot;
    }

    function renderEndpointSelect() {
      const state = getState();
      endpointSelect.replaceChildren(...draftEndpoints.map((endpoint, index) => {
        const option = document.createElement('option');
        option.value = endpoint.id;
        const markers = [];
        if (endpoint.id === state.globalActiveEndpointId) markers.push('全局默认');
        if (endpoint.id === state.pageActiveEndpointId) markers.push('当前网址');
        const suffix = markers.length ? `（${markers.join(' / ')}）` : '';
        option.textContent = `${endpoint.name || `接口 ${index + 1}`}${suffix}`;
        return option;
      }));
      endpointSelect.value = editingEndpointId;
      deleteButton.disabled = draftEndpoints.length <= 1;
    }

    function renderUsageState() {
      const state = getState();
      const persistedEditing = state.endpoints.find(
        (endpoint) => endpoint.id === editingEndpointId,
      );
      const dirty = hasUnsavedChanges();
      const globalName = endpointName(state.endpoints, state.globalActiveEndpointId);
      const effectiveName = endpointName(state.endpoints, state.effectiveEndpointId);
      const editingName = currentDraftEndpoint()?.name || '未命名接口';

      globalValue.textContent = globalName || '未设置';
      currentValue.textContent = effectiveName
        ? `${effectiveName}${state.pageActiveEndpointId ? ' · 已绑定' : ' · 跟随全局'}`
        : '未设置';
      editingValue.textContent = `${editingName}${dirty ? ' · 未保存' : ''}`;

      const activationBlocked = dirty || !persistedEditing;
      setGlobalButton.disabled = activationBlocked
        || editingEndpointId === state.globalActiveEndpointId;
      usePageButton.disabled = activationBlocked
        || editingEndpointId === state.pageActiveEndpointId;
      restoreGlobalButton.disabled = !state.pageActiveEndpointId;

      if (dirty) {
        usageNote.textContent = '当前有未保存的配置更改。生效操作只针对已保存配置，请先保存配置。';
      } else if (!persistedEditing) {
        usageNote.textContent = '这是尚未保存的新接口，请先保存配置后再设置生效。';
      } else if (state.pageActiveEndpointId) {
        usageNote.textContent = `当前网址已绑定此接口，刷新或重新打开该网址仍会生效。`;
      } else {
        usageNote.textContent = '当前网址未绑定接口，使用全局默认。Workspace 选择仍会按网址保存。';
      }

      renderEndpointSelect();
    }

    function loadEditingEndpoint() {
      const endpoint = currentDraftEndpoint();
      if (!endpoint) return;
      nameInput.value = endpoint.name || '';
      backendInput.value = endpoint.backend || '';
      tokenInput.value = endpoint.token || '';
      clearMessage();
      renderUsageState();
    }

    function validateDraft() {
      const seenIds = new Set();
      for (let index = 0; index < draftEndpoints.length; index += 1) {
        const endpoint = draftEndpoints[index];
        endpoint.id = String(endpoint.id || '').trim();
        endpoint.name = String(endpoint.name || '').trim();
        if (!endpoint.id || seenIds.has(endpoint.id)) return `接口 ${index + 1} 的 ID 无效。`;
        seenIds.add(endpoint.id);
        if (!endpoint.name) return `接口 ${index + 1} 缺少名称。`;
        const validation = validateBackend(endpoint.backend);
        if (!validation.ok) return `${endpoint.name}：${validation.message}`;
        endpoint.backend = validation.backend;
        endpoint.token = String(endpoint.token || '').trim();
      }
      return '';
    }

    function syncDirtyUi() {
      const option = [...endpointSelect.options].find((item) => item.value === editingEndpointId);
      if (option) {
        const state = getState();
        const markers = [];
        if (editingEndpointId === state.globalActiveEndpointId) markers.push('全局默认');
        if (editingEndpointId === state.pageActiveEndpointId) markers.push('当前网址');
        const suffix = markers.length ? `（${markers.join(' / ')}）` : '';
        option.textContent = `${nameInput.value.trim() || '未命名接口'}${suffix}`;
      }
      renderUsageState();
    }

    overlay.querySelector('.gam-settings-close').addEventListener('click', close);
    overlay.querySelector('.gam-token-toggle').addEventListener('click', (event) => {
      const visible = tokenInput.type === 'text';
      tokenInput.type = visible ? 'password' : 'text';
      event.currentTarget.textContent = visible ? '显示' : '隐藏';
    });
    endpointSelect.addEventListener('change', () => {
      commitFields();
      editingEndpointId = endpointSelect.value;
      loadEditingEndpoint();
    });
    for (const input of [nameInput, backendInput, tokenInput]) {
      input.addEventListener('input', () => {
        clearMessage();
        syncDirtyUi();
      });
    }
    overlay.querySelector('.gam-add-endpoint').addEventListener('click', () => {
      commitFields();
      const endpoint = createEndpoint(draftEndpoints.length);
      draftEndpoints.push(endpoint);
      editingEndpointId = endpoint.id;
      loadEditingEndpoint();
      nameInput.select();
    });
    deleteButton.addEventListener('click', () => {
      commitFields();
      const state = getState();
      if (editingEndpointId === state.globalActiveEndpointId) {
        showError('不能删除当前全局默认接口，请先将其他接口设为全局默认。');
        return;
      }
      if (draftEndpoints.length <= 1) return;
      const index = draftEndpoints.findIndex((endpoint) => endpoint.id === editingEndpointId);
      if (index < 0) return;
      draftEndpoints.splice(index, 1);
      editingEndpointId = draftEndpoints[Math.min(index, draftEndpoints.length - 1)]?.id || '';
      loadEditingEndpoint();
    });
    testButton.addEventListener('click', () => {
      clearMessage();
      testProfileConnection({
        backend: normalizeBackend(backendInput.value),
        token: tokenInput.value.trim(),
      }, formMessage, testButton);
    });
    editor.addEventListener('submit', (event) => {
      event.preventDefault();
      commitFields();
      const error = validateDraft();
      if (error) {
        showError(error);
        return;
      }
      try {
        onSaveEndpoints(draftEndpoints);
        draftEndpoints = cloneEndpoints(getState().endpoints);
        persistedSnapshot = endpointSnapshot(draftEndpoints);
        if (!draftEndpoints.some((endpoint) => endpoint.id === editingEndpointId)) {
          editingEndpointId = draftEndpoints[0]?.id || '';
        }
        if (!editingEndpointId && !draftEndpoints.length) {
          const endpoint = createEndpoint(0);
          draftEndpoints.push(endpoint);
          editingEndpointId = endpoint.id;
        }
        loadEditingEndpoint();
        showSuccess('✓ 接口配置已保存，当前生效接口未改变。');
      } catch (error_) {
        showError(error_ instanceof Error ? error_.message : String(error_));
      }
    });
    setGlobalButton.addEventListener('click', () => {
      try {
        onSetGlobalEndpoint(editingEndpointId);
        clearMessage();
        renderUsageState();
      } catch (error) {
        showError(error instanceof Error ? error.message : String(error));
      }
    });
    usePageButton.addEventListener('click', () => {
      try {
        onUsePageEndpoint(editingEndpointId);
        clearMessage();
        renderUsageState();
      } catch (error) {
        showError(error instanceof Error ? error.message : String(error));
      }
    });
    restoreGlobalButton.addEventListener('click', () => {
      try {
        onRestoreGlobalEndpoint();
        clearMessage();
        renderUsageState();
      } catch (error) {
        showError(error instanceof Error ? error.message : String(error));
      }
    });
    soundEnabledInput.addEventListener('change', () => {
      const enabled = soundEnabledInput.checked;
      onSetSoundAlertEnabled(enabled);
      soundNote.textContent = enabled
        ? '已全局开启。已选择 Workspace 收到第一条日志后自动监测；有新日志会自动重新计时。'
        : '已全局关闭。关闭时后台继续使用原来的省电策略。';
    });
    soundDelayInput.addEventListener('change', () => {
      const value = onSetSoundAlertDelayMinutes(soundDelayInput.value);
      soundDelayInput.value = String(value);
      soundNote.textContent = `无日志提醒已设为 ${value} 分钟。`;
    });
    soundDurationInput.addEventListener('change', () => {
      const value = onSetSoundAlertDurationSeconds(soundDurationInput.value);
      soundDurationInput.value = String(value);
      soundNote.textContent = `提示音持续时间已设为 ${value} 秒。`;
    });
    testSoundButton.addEventListener('click', async () => {
      testSoundButton.disabled = true;
      const played = await onTestSound();
      testSoundButton.disabled = false;
      soundNote.textContent = played
        ? '✓ 已播放测试提示音。'
        : '浏览器未允许播放声音，请先与页面交互后重试。';
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });

    loadEditingEndpoint();
    window.setTimeout(() => endpointSelect.focus(), 0);
  }

  return { open, close };
}
