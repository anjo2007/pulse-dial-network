/**
 * Hospital session handling.
 *
 * Hardening rules implemented here:
 *  - the raw login response is never trusted: the token is decoded and must carry
 *    role === "hospital" before a session is created (a donor token can never open
 *    the hospital portal, even if a caller hands one over)
 *  - the token expiry (server issued `exp`) is tracked client side so an expired or
 *    tampered session is discarded instead of showing a broken dashboard
 *  - nothing except { token, role, subjectId, expiresAtMs, hospital:{id,name,licenseNumber} }
 *    is kept, so leftover secrets (a password echoed by a proxy, an internal auth user id)
 *    are dropped before they reach any storage
 *  - storage access is wrapped: private mode / disabled cookies degrade to an
 *    in-memory session rather than crashing the app
 */

export const SESSION_STORAGE_KEY = 'pulseHospital.session';
export const LEGACY_SESSION_KEY = 'pulseHospital';
const FALLBACK_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

function decodeBase64UrlJson(segment) {
  try {
    const normalized = String(segment).replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
    const decoder = globalThis.atob;
    if (typeof decoder !== 'function' || typeof globalThis.JSON === 'undefined') return null;
    return JSON.parse(decoder(padded));
  } catch {
    return null;
  }
}

/** Decode the (signed) session payload. Signature verification belongs to the server. */
export function decodeSessionToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const payload = decodeBase64UrlJson(token.split('.')[0]);
  return payload && typeof payload === 'object' ? payload : null;
}

export function sanitizeHospital(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const text = (value, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  return {
    id: text(source.id, 'hospital'),
    name: text(source.name, 'Hospital'),
    licenseNumber: text(source.licenseNumber, 'License not provided'),
  };
}

/**
 * Build the app session from a POST /auth/hospital response.
 * Returns null when the response is unusable so callers can surface a clear error.
 */
export function createSession(loginResult, { now = Date.now() } = {}) {
  const token = typeof loginResult?.token === 'string' ? loginResult.token.trim() : '';
  if (!token) return null;
  const payload = decodeSessionToken(token);
  if (!payload || payload.role !== 'hospital') return null;
  const exp = Number(payload.exp);
  return {
    token,
    role: 'hospital',
    subjectId: typeof payload.id === 'string' ? payload.id : null,
    expiresAtMs: Number.isFinite(exp) && exp > 0 ? exp : now + FALLBACK_SESSION_MS,
    hospital: sanitizeHospital(loginResult?.hospital),
  };
}

export function sessionIsUsable(session, now = Date.now()) {
  return Boolean(session?.token) && Number.isFinite(session.expiresAtMs) && session.expiresAtMs > now;
}

export function sessionRemainingMs(session, now = Date.now()) {
  if (!session) return 0;
  const expiresAt = Number(session.expiresAtMs);
  return Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now) : 0;
}

export function formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000));
  if (totalSeconds <= 0) return 'expired';
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

const SESSION_KEYS = [SESSION_STORAGE_KEY, LEGACY_SESSION_KEY];

/** Storage that may be unavailable (private browsing, disabled cookies) returns null. */
export function safeStorage(kind) {
  try {
    const store = kind === 'local' ? globalThis.localStorage : globalThis.sessionStorage;
    if (!store) return null;
    const probe = '__pulse_probe__';
    store.setItem(probe, '1');
    store.removeItem(probe);
    return store;
  } catch {
    return null;
  }
}

function readJson(store, key) {
  if (!store) return null;
  try {
    const raw = store.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function serializeSession(session, persistent = false) {
  return {
    token: session.token,
    role: 'hospital',
    subjectId: session.subjectId ?? null,
    expiresAtMs: session.expiresAtMs,
    hospital: sanitizeHospital(session.hospital),
    persistent: Boolean(persistent),
  };
}

/**
 * Restore a stored session for this origin.
 * Anything malformed, expired, non-hospital or belonging to a legacy format that we
 * cannot validate is deleted rather than resurrected.
 */
export function readStoredSession({ now = Date.now() } = {}) {
  const stores = [safeStorage('session'), safeStorage('local')].filter(Boolean);
  for (const store of stores) {
    for (const key of SESSION_KEYS) {
      const stored = readJson(store, key);
      if (!stored || typeof stored.token !== 'string' || !stored.token) {
        if (stored) {
          try { store.removeItem(key); } catch { /* ignore */ }
        }
        continue;
      }
      // The stored wrapper is not signed, so its claims are never trusted: role and
      // expiry are always re-derived from the signed token. This also migrates legacy
      // records (the old `pulseHospital` key) that carried no expiry at all.
      const payload = decodeSessionToken(stored.token);
      if (payload?.role !== 'hospital' || !Number.isFinite(Number(payload?.exp))) {
        try { store.removeItem(key); } catch { /* ignore */ }
        continue;
      }
      const candidate = { ...stored, expiresAtMs: Number(payload.exp), role: 'hospital' };
      if (!sessionIsUsable(candidate, now)) {
        try { store.removeItem(key); } catch { /* ignore */ }
        continue;
      }
      return serializeSession(candidate, stored.persistent === true);
    }
  }
  return null;
}

export function persistSession(session, { persistent = false } = {}) {
  const record = JSON.stringify(serializeSession(session, persistent));
  const target = safeStorage(persistent ? 'local' : 'session');
  const other = safeStorage(persistent ? 'session' : 'local');
  let saved = false;
  try {
    if (target) {
      target.setItem(SESSION_STORAGE_KEY, record);
      saved = true;
    }
    if (other) other.removeItem(SESSION_STORAGE_KEY);
    for (const store of [target, other]) {
      try { store?.removeItem(LEGACY_SESSION_KEY); } catch { /* ignore */ }
    }
  } catch {
    return false;
  }
  return saved;
}

export function clearStoredSession() {
  for (const kind of ['session', 'local']) {
    const store = safeStorage(kind);
    if (!store) continue;
    for (const key of SESSION_KEYS) {
      try { store.removeItem(key); } catch { /* ignore */ }
    }
  }
}
