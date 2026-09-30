import { PROFILE_KEY } from '../constants.js';

export function normalizeBackend(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function apiBaseFromBackend(value) {
  const backend = normalizeBackend(value);
  if (!backend) return '';

  try {
    const parsed = new URL(backend);
    const pathname = parsed.pathname.replace(/\/+$/, '');
    parsed.pathname = pathname.replace(/\/mcp$/i, '') || '/';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
  } catch (_) {
    return backend.replace(/\/mcp$/i, '');
  }
}

export function normalizeProfile(profile) {
  return {
    backend: normalizeBackend(profile?.backend),
    token: String(profile?.token || '').trim(),
  };
}

export function loadProfile() {
  const stored = GM_getValue(PROFILE_KEY, null);
  const source = Array.isArray(stored)
    ? stored.find((profile) => profile?.enabled !== false && profile?.backend) || stored.find((profile) => profile?.backend)
    : stored;
  const normalized = normalizeProfile(source);
  return normalized.backend ? normalized : null;
}

export function saveProfile(profile) {
  const normalized = normalizeProfile(profile);
  GM_setValue(PROFILE_KEY, normalized);
  return normalized;
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
