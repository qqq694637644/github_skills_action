import {
  ENDPOINTS_KEY,
  GLOBAL_ACTIVE_ENDPOINT_KEY,
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
