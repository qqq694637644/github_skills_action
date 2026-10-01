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

function cloneConfig(config) {
  return {
    version: 2,
    selectedEndpointId: config?.selectedEndpointId || '',
    endpoints: (config?.endpoints || []).map((endpoint) => ({ ...endpoint })),
  };
}

export function createSettingsPanel({ getState, onApplySettings }) {
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

    const state = getState();
    const draft = cloneConfig(state.config);
    if (!draft.endpoints.length) {
      const endpoint = createEndpoint(0);
      draft.endpoints.push(endpoint);
      draft.selectedEndpointId = endpoint.id;
    }
    let selectedEndpointId = state.activeEndpointId || draft.selectedEndpointId || draft.endpoints[0].id;

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
          <p class="gam-settings-note">可保存多个接口，但监控始终只使用一个。全局选择永久保存；局部选择只对当前页面有效，刷新后自动恢复全局接口。</p>
          <form class="gam-editor">
            <div class="gam-field">
              <span>接口</span>
              <div class="gam-endpoint-row">
                <select class="gam-input gam-endpoint-select" aria-label="选择接口"></select>
                <button class="gam-button gam-add-endpoint" type="button">添加</button>
                <button class="gam-button gam-delete-endpoint" type="button">删除</button>
              </div>
            </div>
            <label class="gam-field">
              <span>接口名称</span>
              <input class="gam-input gam-name" type="text" autocomplete="off" placeholder="例如 ChatGPT MCP" required>
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
            <fieldset class="gam-scope-group">
              <legend>生效范围</legend>
              <label class="gam-scope-option">
                <input type="radio" name="gam-scope" value="global">
                <span><strong>全局</strong><small>永久保存为默认接口，刷新和新页面继续使用。</small></span>
              </label>
              <label class="gam-scope-option">
                <input type="radio" name="gam-scope" value="local">
                <span><strong>局部</strong><small>只在当前页面临时使用，刷新页面后失效并恢复全局接口。</small></span>
              </label>
            </fieldset>
            <div class="gam-form-message" aria-live="polite"></div>
            <div class="gam-editor-footer">
              <span class="gam-spacer"></span>
              <button class="gam-button gam-test" type="button">测试连接</button>
              <button class="gam-button gam-button-primary gam-save" type="submit">保存</button>
            </div>
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
    const testButton = overlay.querySelector('.gam-test');
    const initialScope = state.localEndpointId ? 'local' : 'global';
    overlay.querySelector(`input[name="gam-scope"][value="${initialScope}"]`).checked = true;

    function currentEndpoint() {
      return draft.endpoints.find((endpoint) => endpoint.id === selectedEndpointId) || null;
    }

    function clearMessage() {
      formMessage.textContent = '';
      delete formMessage.dataset.state;
    }

    function commitFields() {
      const endpoint = currentEndpoint();
      if (!endpoint) return;
      endpoint.name = nameInput.value.trim();
      endpoint.backend = normalizeBackend(backendInput.value);
      endpoint.token = tokenInput.value.trim();
    }

    function renderEndpointSelect() {
      endpointSelect.replaceChildren(...draft.endpoints.map((endpoint, index) => {
        const option = document.createElement('option');
        option.value = endpoint.id;
        const label = endpoint.name || `接口 ${index + 1}`;
        option.textContent = endpoint.id === draft.selectedEndpointId
          ? `${label}（全局默认）`
          : label;
        return option;
      }));
      endpointSelect.value = selectedEndpointId;
      deleteButton.disabled = draft.endpoints.length <= 1;
    }

    function loadSelectedEndpoint() {
      const endpoint = currentEndpoint();
      if (!endpoint) return;
      nameInput.value = endpoint.name || '';
      backendInput.value = endpoint.backend || '';
      tokenInput.value = endpoint.token || '';
      renderEndpointSelect();
      clearMessage();
    }

    function validateDraft() {
      for (let index = 0; index < draft.endpoints.length; index += 1) {
        const endpoint = draft.endpoints[index];
        endpoint.name = String(endpoint.name || '').trim();
        if (!endpoint.name) return `接口 ${index + 1} 缺少名称。`;
        const validation = validateBackend(endpoint.backend);
        if (!validation.ok) return `${endpoint.name}：${validation.message}`;
        endpoint.backend = validation.backend;
        endpoint.token = String(endpoint.token || '').trim();
      }
      if (!draft.endpoints.some((endpoint) => endpoint.id === selectedEndpointId)) {
        return '请选择要使用的接口。';
      }
      return '';
    }

    overlay.querySelector('.gam-settings-close').addEventListener('click', close);
    overlay.querySelector('.gam-token-toggle').addEventListener('click', (event) => {
      const visible = tokenInput.type === 'text';
      tokenInput.type = visible ? 'password' : 'text';
      event.currentTarget.textContent = visible ? '显示' : '隐藏';
    });
    endpointSelect.addEventListener('change', () => {
      commitFields();
      selectedEndpointId = endpointSelect.value;
      loadSelectedEndpoint();
    });
    nameInput.addEventListener('input', () => {
      const endpoint = currentEndpoint();
      if (!endpoint) return;
      endpoint.name = nameInput.value;
      const option = [...endpointSelect.options].find((item) => item.value === endpoint.id);
      if (option) option.textContent = endpoint.name.trim() || '未命名接口';
    });
    overlay.querySelector('.gam-add-endpoint').addEventListener('click', () => {
      commitFields();
      const endpoint = createEndpoint(draft.endpoints.length);
      draft.endpoints.push(endpoint);
      selectedEndpointId = endpoint.id;
      loadSelectedEndpoint();
      nameInput.select();
    });
    deleteButton.addEventListener('click', () => {
      if (draft.endpoints.length <= 1) return;
      const index = draft.endpoints.findIndex((endpoint) => endpoint.id === selectedEndpointId);
      if (index < 0) return;
      draft.endpoints.splice(index, 1);
      if (draft.selectedEndpointId === selectedEndpointId) {
        draft.selectedEndpointId = draft.endpoints[0]?.id || '';
      }
      selectedEndpointId = draft.endpoints[Math.min(index, draft.endpoints.length - 1)]?.id || '';
      loadSelectedEndpoint();
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
        formMessage.textContent = error;
        formMessage.dataset.state = 'error';
        return;
      }
      const scope = overlay.querySelector('input[name="gam-scope"]:checked')?.value || 'global';
      onApplySettings({
        nextConfig: draft,
        selectedEndpointId,
        scope,
      });
      formMessage.textContent = scope === 'local'
        ? '✓ 当前页面已临时切换；刷新后恢复全局接口'
        : '✓ 已保存为全局默认接口';
      formMessage.dataset.state = 'success';
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });

    loadSelectedEndpoint();
    window.setTimeout(() => endpointSelect.focus(), 0);
  }

  return { open, close };
}
