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
  onUseLocalEndpoint,
  onRestoreGlobalEndpoint,
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
          <p class="gam-settings-note">接口配置永久保存；保存配置不会改变当前使用的接口。全局默认永久生效，当前页面接口只在本次页面加载期间临时覆盖。</p>
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
                <span>当前页面</span><strong class="gam-current-value"></strong>
                <span>当前编辑</span><strong class="gam-editing-value"></strong>
              </div>
              <div class="gam-usage-actions">
                <button class="gam-button gam-set-global" type="button">设为全局默认</button>
                <button class="gam-button gam-use-local" type="button">仅当前页面使用</button>
                <button class="gam-button gam-restore-global" type="button">恢复全局默认</button>
              </div>
              <div class="gam-usage-note"></div>
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
    const useLocalButton = overlay.querySelector('.gam-use-local');
    const restoreGlobalButton = overlay.querySelector('.gam-restore-global');
    const globalValue = overlay.querySelector('.gam-global-value');
    const currentValue = overlay.querySelector('.gam-current-value');
    const editingValue = overlay.querySelector('.gam-editing-value');

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
        if (endpoint.id === state.localActiveEndpointId) markers.push('当前页面');
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
        ? `${effectiveName}${state.localActiveEndpointId ? ' · 临时' : ' · 跟随全局'}`
        : '未设置';
      editingValue.textContent = `${editingName}${dirty ? ' · 未保存' : ''}`;

      const activationBlocked = dirty || !persistedEditing;
      setGlobalButton.disabled = activationBlocked
        || editingEndpointId === state.globalActiveEndpointId;
      useLocalButton.disabled = activationBlocked
        || editingEndpointId === state.localActiveEndpointId;
      restoreGlobalButton.disabled = !state.localActiveEndpointId;

      if (dirty) {
        usageNote.textContent = '当前有未保存的配置更改。生效操作只针对已保存配置，请先保存配置。';
      } else if (!persistedEditing) {
        usageNote.textContent = '这是尚未保存的新接口，请先保存配置后再设置生效。';
      } else if (state.localActiveEndpointId) {
        usageNote.textContent = '当前页面正在使用临时接口；刷新页面后局部覆盖自动失效。';
      } else {
        usageNote.textContent = '当前页面跟随全局默认接口。';
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
        if (editingEndpointId === state.localActiveEndpointId) markers.push('当前页面');
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
    useLocalButton.addEventListener('click', () => {
      try {
        onUseLocalEndpoint(editingEndpointId);
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
