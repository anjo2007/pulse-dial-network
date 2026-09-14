/**
 * Pure session-record helpers (no RN/Expo imports) used by the secure session store.
 *
 * The stored record only ever contains what the API returns: an opaque session token plus the
 * donor profile projection. Expiry is read from the token itself so a stale token can never be
 * silently reused after the fact.
 */

const REQUIRED_FIELDS = ['token', 'donor'];

const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Dependency-free base64/base64url -> bytes. Buffer is not available on Hermes. */
function base64ToBytes(input) {
  const clean = input.replace(/[^A-Za-z0-9+/=]/g, '');
  const bytes = [];
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = BASE64_ALPHABET.indexOf(clean[i]);
    const c1 = BASE64_ALPHABET.indexOf(clean[i + 1] ?? '=');
    const c2 = clean[i + 2] === undefined || clean[i + 2] === '=' ? -1 : BASE64_ALPHABET.indexOf(clean[i + 2]);
    const c3 = clean[i + 3] === undefined || clean[i + 3] === '=' ? -1 : BASE64_ALPHABET.indexOf(clean[i + 3]);
    if (c0 < 0 || c1 < 0) break;
    bytes.push(((c0 << 2) | (c1 >> 4)) & 0xff);
    if (c2 >= 0) bytes.push(((c1 << 4) | (c2 >> 2)) & 0xff);
    if (c3 >= 0) bytes.push(((c2 << 6) | c3) & 0xff);
  }
  return bytes;
}

function utf8Decode(bytes) {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if (b0 < 0xe0) {
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (bytes[i++] & 0x3f));
    } else if (b0 < 0xf0) {
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f));
    } else {
      const codePoint =
        ((b0 & 0x07) << 18) | ((bytes[i++] & 0x3f) << 12) | ((bytes[i++] & 0x3f) << 6) | (bytes[i++] & 0x3f);
      out += String.fromCodePoint(codePoint);
    }
  }
  return out;
}

/**
 * Decode the session payload without any dependency.
 *
 * The Pulse API issues a two-segment HMAC token (`base64url(payload).base64url(hmac)`), while a
 * standard JWT has three segments (`header.payload.signature`). Both are supported; anything else
 * is treated as opaque and its expiry cannot be verified here.
 */
export function decodeTokenPayload(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (!parts[0]) return null;
  const candidates = parts.length >= 3 ? [parts[1]] : [parts[0]];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const normalized = candidate.replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(utf8Decode(base64ToBytes(normalized)));
      if (payload && typeof payload === 'object' && !Array.isArray(payload)) return payload;
    } catch (_) {
      // Try the next candidate; a malformed token must never throw here.
    }
  }
  return null;
}

/**
 * Normalise an expiry claim to epoch milliseconds.
 * The Pulse API writes `exp` in milliseconds (`Date.now() + ttl`); JWT convention is seconds.
 */
export function toEpochMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num > 1e12 ? num : num * 1000;
}

export function isTokenExpired(token, now = Date.now(), skewMs = 30000) {
  const payload = decodeTokenPayload(token);
  const expiresAtMs = payload ? toEpochMs(payload.exp) : null;
  if (expiresAtMs === null) return false; // opaque token: cannot verify expiry here
  return expiresAtMs <= now + skewMs;
}

/**
 * Validate + normalise persisted session state.
 * Returns null for anything that is not a usable, unexpired session.
 */
export function normalizeSession(raw, now = Date.now()) {
  const value = typeof raw === 'string' ? safeParse(raw) : raw;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!REQUIRED_FIELDS.every((field) => value[field])) return null;
  if (typeof value.token !== 'string' || typeof value.donor !== 'object') return null;
  if (!value.donor.id) return null;
  if (isTokenExpired(value.token, now)) return null;
  return {
    token: value.token,
    donor: { ...value.donor },
    savedAt: typeof value.savedAt === 'string' ? value.savedAt : new Date(now).toISOString(),
  };
}

export function serializeSession(session, now = Date.now()) {
  const normalized = normalizeSession({ ...session, savedAt: undefined }, now);
  if (!normalized) return null;
  return JSON.stringify({ ...normalized, savedAt: new Date(now).toISOString() });
}

function safeParse(raw) {
  try {
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}
