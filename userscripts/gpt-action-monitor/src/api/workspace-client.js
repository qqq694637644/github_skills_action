export function createWorkspaceClient({ getProfile }) {
  let cachedKey = '';
  let cached = null;
  let pending = null;
  let generation = 0;

  function profileKey(profile) {
    return `${profile?.id || ''}\u0000${profile?.backend || ''}`;
  }

  function requestWorkspaces(profile) {
    const headers = {};
    if (profile.token) headers.Authorization = `Bearer ${profile.token}`;

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `${profile.backend}/v1/action-workspaces`,
        headers,
        timeout: 7000,
        onload(response) {
          if (response.status === 401) {
            reject(new Error('认证失败，请检查 Bearer Token。'));
            return;
          }
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`后端返回 HTTP ${response.status}。`));
            return;
          }
          try {
            const body = JSON.parse(response.responseText);
            const workspaces = Array.isArray(body.workspaces) ? body.workspaces : [];
            resolve(workspaces
              .map((item) => String(item?.workspace_id || '').trim())
              .filter((workspaceId) => /^ws_[0-9a-f]{16}$/.test(workspaceId)));
          } catch (error) {
            reject(new Error(`Workspace 列表解析失败：${String(error)}`));
          }
        },
        onerror() {
          reject(new Error('无法连接后端。'));
        },
        ontimeout() {
          reject(new Error('读取 Workspace 列表超时。'));
        },
      });
    });
  }

  async function list({ refresh = false } = {}) {
    const profile = getProfile();
    if (!profile) throw new Error('没有活动的后端配置。');
    const key = profileKey(profile);

    if (!refresh && cachedKey === key && cached) return cached;
    if (!refresh && pending?.key === key) return pending.promise;

    const requestGeneration = generation;
    const request = requestWorkspaces(profile).then((workspaces) => {
      if (generation === requestGeneration) {
        cachedKey = key;
        cached = workspaces;
      }
      return workspaces;
    }).finally(() => {
      if (pending?.promise === request) pending = null;
    });
    pending = { key, promise: request };
    return request;
  }

  function clear() {
    generation += 1;
    cachedKey = '';
    cached = null;
    pending = null;
  }

  return { list, clear };
}
