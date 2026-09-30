import { normalizeBackend, validateBackend } from '../profile/profile-store.js';
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

export function createSettingsPanel({ getProfile, onApplyProfile }) {
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
          <p class="gam-settings-note">监控始终使用这一组后端配置。</p>
          <form class="gam-editor">
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
    const backendInput = overlay.querySelector('.gam-backend');
    const tokenInput = overlay.querySelector('.gam-token');
    const formMessage = overlay.querySelector('.gam-form-message');
    const testButton = overlay.querySelector('.gam-test');
    const current = getProfile();

    backendInput.value = current?.backend || '';
    tokenInput.value = current?.token || '';

    function clearMessage() {
      formMessage.textContent = '';
      delete formMessage.dataset.state;
    }

    function formProfile() {
      return {
        backend: normalizeBackend(backendInput.value),
        token: tokenInput.value.trim(),
      };
    }

    function validateProfile(profile) {
      const backendValidation = validateBackend(profile.backend);
      if (!backendValidation.ok) return backendValidation.message;
      profile.backend = backendValidation.backend;
      return '';
    }

    overlay.querySelector('.gam-settings-close').addEventListener('click', close);
    overlay.querySelector('.gam-token-toggle').addEventListener('click', (event) => {
      const visible = tokenInput.type === 'text';
      tokenInput.type = visible ? 'password' : 'text';
      event.currentTarget.textContent = visible ? '显示' : '隐藏';
    });
    testButton.addEventListener('click', () => {
      const profile = formProfile();
      clearMessage();
      testProfileConnection(profile, formMessage, testButton);
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
      onApplyProfile(profile);
      formMessage.textContent = '✓ 已保存';
      formMessage.dataset.state = 'success';
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') close();
    });

    window.setTimeout(() => backendInput.focus(), 0);
  }

  return { open, close };
}
