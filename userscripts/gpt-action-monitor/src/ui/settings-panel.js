import { createProfileId, normalizeBackend, validateBackend } from '../profile/profile-store.js';
import { SETTINGS_CSS } from './styles.js';

function backendLabel(backend) {
  try {
    const parsed = new URL(backend);
    return parsed.host + (parsed.pathname === '/' ? '' : parsed.pathname);
  } catch (_) {
    return backend;
  }
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

export function createSettingsPanel({ getProfiles, onApplyProfiles }) {
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

    document.documentElement.appendChild(style);
    document.body.appendChild(overlay);

    const listView = overlay.querySelector('.gam-list-view');
    const list = overlay.querySelector('.gam-profile-list');
    const editor = overlay.querySelector('.gam-editor');
    const gptNameInput = overlay.querySelector('.gam-gpt-name');
    const backendInput = overlay.querySelector('.gam-backend');
    const tokenInput = overlay.querySelector('.gam-token');
    const enabledInput = overlay.querySelector('.gam-enabled');
    const formMessage = overlay.querySelector('.gam-form-message');
    const deleteButton = overlay.querySelector('.gam-delete');
    const testButton = overlay.querySelector('.gam-test');
    let editingId = null;

    function profiles() {
      return getProfiles();
    }

    function renderList() {
      list.replaceChildren();
      if (!profiles().length) {
        const empty = document.createElement('div');
        empty.className = 'gam-empty';
        empty.textContent = '还没有监控配置。添加一组 GPT、后端地址和 Bearer Token。';
        list.appendChild(empty);
        return;
      }

      for (const profile of profiles()) {
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
      overlay.querySelector('.gam-token-toggle').textContent = '显示';
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
      const duplicate = profiles().find(
        (item) => item.id !== editingId && item.gptName === profile.gptName,
      );
      if (duplicate) return `GPT 名称 “${profile.gptName}” 已存在。`;
      const backendValidation = validateBackend(profile.backend);
      if (!backendValidation.ok) return backendValidation.message;
      profile.backend = backendValidation.backend;
      return '';
    }

    overlay.querySelector('.gam-settings-close').addEventListener('click', close);
    overlay.querySelector('.gam-add-profile').addEventListener('click', () => showEditor());
    overlay.querySelector('.gam-cancel-edit').addEventListener('click', showList);
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
    deleteButton.addEventListener('click', () => {
      if (!editingId) return;
      const profile = profiles().find((item) => item.id === editingId);
      if (!profile || !confirm(`删除 “${profile.gptName}” 的监控配置？`)) return;
      onApplyProfiles(profiles().filter((item) => item.id !== editingId));
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
        ? profiles().map((item) => (item.id === editingId ? profile : item))
        : [...profiles(), profile];
      onApplyProfiles(next);
      showList();
    });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close();
    });
    overlay.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (!editor.hidden) showList();
        else close();
      }
    });

    renderList();
    overlay.querySelector('.gam-settings-close').focus();
  }

  return { open, close };
}
