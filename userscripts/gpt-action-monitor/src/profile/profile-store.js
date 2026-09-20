import { PROFILES_KEY } from '../constants.js';

export function createProfileId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `profile-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function normalizeBackend(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

export function normalizeProfile(profile) {
  return {
    id: String(profile?.id || createProfileId()),
    gptName: String(profile?.gptName || '').trim(),
    backend: normalizeBackend(profile?.backend),
    token: String(profile?.token || '').trim(),
    enabled: profile?.enabled !== false,
  };
}

export function loadProfiles() {
  const stored = GM_getValue(PROFILES_KEY, null);
  if (!Array.isArray(stored)) return [];
  return stored.map(normalizeProfile).filter((profile) => profile.gptName && profile.backend);
}

export function saveProfiles(profiles) {
  const normalized = profiles.map(normalizeProfile);
  GM_setValue(PROFILES_KEY, normalized);
  return normalized;
}

export function profileForName(profiles, name) {
  return profiles.find((profile) => profile.enabled && profile.gptName === name) || null;
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
