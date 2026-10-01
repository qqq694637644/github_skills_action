import { PROFILE_KEY } from '../constants.js';

export function normalizeBackend(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

function nextEndpointId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `endpoint-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function normalizeEndpoint(endpoint, index = 0) {
  return {
    id: String(endpoint?.id || '').trim() || nextEndpointId(),
    name: String(endpoint?.name || endpoint?.gptName || '').trim() || `接口 ${index + 1}`,
    backend: normalizeBackend(endpoint?.backend),
    token: String(endpoint?.token || '').trim(),
  };
}

export function normalizeConfig(value) {
  let endpoints = [];
  let selectedEndpointId = '';

  if (Array.isArray(value)) {
    endpoints = value
      .filter((endpoint) => endpoint?.backend)
      .map((endpoint, index) => normalizeEndpoint(endpoint, index));
  } else if (Array.isArray(value?.endpoints)) {
    endpoints = value.endpoints.map((endpoint, index) => normalizeEndpoint(endpoint, index));
    selectedEndpointId = String(value.selectedEndpointId || '').trim();
  } else if (value?.backend) {
    endpoints = [normalizeEndpoint({ ...value, name: value.name || '默认接口' }, 0)];
  }

  endpoints = endpoints.filter((endpoint) => endpoint.backend);
  if (!endpoints.some((endpoint) => endpoint.id === selectedEndpointId)) {
    selectedEndpointId = endpoints[0]?.id || '';
  }

  return {
    version: 2,
    endpoints,
    selectedEndpointId,
  };
}

export function loadConfig() {
  return normalizeConfig(GM_getValue(PROFILE_KEY, null));
}

export function saveConfig(config) {
  const normalized = normalizeConfig(config);
  GM_setValue(PROFILE_KEY, normalized);
  return normalized;
}

export function createEndpoint(index = 0) {
  return normalizeEndpoint({ name: `接口 ${index + 1}` }, index);
}

export function getEndpoint(config, endpointId) {
  return config?.endpoints?.find((endpoint) => endpoint.id === endpointId) || null;
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
