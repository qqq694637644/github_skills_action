import {
  ENDPOINTS_KEY,
  GLOBAL_ACTIVE_ENDPOINT_KEY,
  MAX_PAGE_BINDINGS,
  PAGE_BINDINGS_KEY,
} from '../constants.js';

export function normalizeBackend(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function nextEndpointId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `endpoint-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeStoredEndpoint(endpoint) {
  if (!endpoint || typeof endpoint !== 'object') return null;
  const id = String(endpoint.id || '').trim();
  const name = String(endpoint.name || '').trim();
  const backend = normalizeBackend(endpoint.backend);
  const token = String(endpoint.token || '').trim();
  if (!id || !name || !backend) return null;
  return { id, name, backend, token };
}

export function createEndpoint(index = 0) {
  return {
    id: nextEndpointId(),
    name: `接口 ${index + 1}`,
    backend: '',
    token: '',
  };
}

export function loadEndpoints() {
  const stored = GM_getValue(ENDPOINTS_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored.map(normalizeStoredEndpoint).filter(Boolean);
}

export function saveEndpoints(endpoints) {
  const normalized = (Array.isArray(endpoints) ? endpoints : [])
    .map(normalizeStoredEndpoint)
    .filter(Boolean);
  GM_setValue(ENDPOINTS_KEY, normalized);
  return normalized;
}

export function loadGlobalActiveEndpointId() {
  return String(GM_getValue(GLOBAL_ACTIVE_ENDPOINT_KEY, '') || '').trim();
}

export function saveGlobalActiveEndpointId(endpointId) {
  const normalized = String(endpointId || '').trim();
  GM_setValue(GLOBAL_ACTIVE_ENDPOINT_KEY, normalized);
  return normalized;
}

function normalizePageBinding(binding) {
  if (!binding || typeof binding !== 'object') return null;
  const url = String(binding.url || '').trim();
  const endpointId = String(binding.endpointId || '').trim();
  const rawWorkspaceId = String(binding.workspaceId || '').trim();
  const workspaceId = /^ws_[0-9a-f]{16}$/.test(rawWorkspaceId) ? rawWorkspaceId : '';
  const workspaceEndpointId = String(binding.workspaceEndpointId || '').trim();
  const modifiedAt = Number(binding.modifiedAt);
  if (!url || !Number.isFinite(modifiedAt)) return null;
  return {
    url,
    endpointId,
    workspaceId,
    workspaceEndpointId: workspaceId ? workspaceEndpointId : '',
    modifiedAt,
  };
}

export function loadPageBindings() {
  const stored = GM_getValue(PAGE_BINDINGS_KEY, []);
  if (!Array.isArray(stored)) return [];
  return stored
    .map(normalizePageBinding)
    .filter(Boolean)
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, MAX_PAGE_BINDINGS);
}

export function loadPageBinding(url) {
  const key = String(url || '').trim();
  return loadPageBindings().find((binding) => binding.url === key) || null;
}

export function deletePageBinding(url) {
  const key = String(url || '').trim();
  if (!key) return loadPageBindings();
  const bindings = loadPageBindings();
  const next = bindings.filter((binding) => binding.url !== key);
  if (next.length !== bindings.length) GM_setValue(PAGE_BINDINGS_KEY, next);
  return next;
}

export function savePageBinding(url, binding, modifiedAt = Date.now()) {
  const key = String(url || '').trim();
  if (!key) return null;

  const endpointId = String(binding?.endpointId || '').trim();
  const workspaceId = String(binding?.workspaceId || '').trim();
  const workspaceEndpointId = String(binding?.workspaceEndpointId || '').trim();
  const stored = loadPageBindings();
  const current = stored.find((item) => item.url === key) || null;
  const existing = stored.filter((item) => item.url !== key);

  if (!endpointId && !workspaceId) {
    if (current) GM_setValue(PAGE_BINDINGS_KEY, existing);
    return null;
  }

  if (
    current
    && current.endpointId === endpointId
    && current.workspaceId === workspaceId
    && current.workspaceEndpointId === workspaceEndpointId
  ) {
    return current;
  }

  const next = normalizePageBinding({
    url: key,
    endpointId,
    workspaceId,
    workspaceEndpointId,
    modifiedAt,
  });
  if (!next) return null;

  const bindings = [next, ...existing]
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, MAX_PAGE_BINDINGS);
  GM_setValue(PAGE_BINDINGS_KEY, bindings);
  return next;
}

export function prunePageBindings(validEndpointIds, modifiedAt = Date.now()) {
  const validIds = new Set(validEndpointIds || []);
  const bindings = loadPageBindings();
  let changed = false;
  const next = [];

  for (const binding of bindings) {
    const item = { ...binding };
    let itemChanged = false;
    if (item.endpointId && !validIds.has(item.endpointId)) {
      item.endpointId = '';
      changed = true;
      itemChanged = true;
    }
    if (item.workspaceEndpointId && !validIds.has(item.workspaceEndpointId)) {
      item.workspaceId = '';
      item.workspaceEndpointId = '';
      changed = true;
      itemChanged = true;
    }
    if (!item.endpointId && !item.workspaceId) continue;
    if (itemChanged) item.modifiedAt = modifiedAt;
    next.push(item);
  }

  const limited = next
    .sort((left, right) => right.modifiedAt - left.modifiedAt)
    .slice(0, MAX_PAGE_BINDINGS);
  if (changed || limited.length !== bindings.length) {
    GM_setValue(PAGE_BINDINGS_KEY, limited);
  }
  return limited;
}

export function getEndpoint(endpoints, endpointId) {
  return endpoints.find((endpoint) => endpoint.id === endpointId) || null;
}

export function validateBackend(value) {
  const backend = normalizeBackend(value);
  let parsed;
  try {
    parsed = new URL(backend);
  } catch (_) {
    return { ok: false, message: '请输入有效的后端 URL。' };
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, message: '后端地址仅支持 http:// 或 https://。' };
  }
  return { ok: true, backend };
}
