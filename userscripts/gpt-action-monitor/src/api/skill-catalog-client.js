export function createSkillCatalogClient({ getProfile }) {
  const cache = new Map();
  const pending = new Map();

  function profileKey(profile) {
    return `${profile.id || ''}\u0000${profile.backend}`;
  }

  function requestCatalog(profile, key) {

    const headers = {};
    if (profile.token) headers.Authorization = `Bearer ${profile.token}`;

    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url: `${profile.backend}/v1/skills`,
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
            const skills = Array.isArray(body.skills) ? body.skills : [];
            const normalized = skills
              .filter((skill) => skill && typeof skill.skill_id === 'string')
              .map((skill) => ({
                skill_id: skill.skill_id,
                name: typeof skill.name === 'string' ? skill.name : skill.skill_id,
                description: typeof skill.description === 'string' ? skill.description : '',
              }));
            cache.set(key, normalized);
            resolve(normalized);
          } catch (error) {
            reject(new Error(`Skill 列表解析失败：${String(error)}`));
          }
        },
        onerror() {
          reject(new Error('无法连接后端。'));
        },
        ontimeout() {
          reject(new Error('读取 Skill 列表超时。'));
        },
      });
    });
  }

  async function list({ refresh = false } = {}) {
    const profile = getProfile();
    if (!profile) throw new Error('没有活动的后端配置。');
    const key = profileKey(profile);

    if (!refresh && cache.has(key)) return cache.get(key);
    if (pending.has(key)) return pending.get(key);

    const request = requestCatalog(profile, key).finally(() => {
      if (pending.get(key) === request) pending.delete(key);
    });
    pending.set(key, request);
    return request;
  }

  return { list };
}
