/**
 * Optional realtime sync configuration (pure, testable).
 *
 * Contract:
 *   GET /sync/config        Authorization: Bearer <donor session token>
 *   200 -> { "enabled": boolean, "url": string, "publishableKey": string,
 *            "accessToken": string, "topic": string }
 *   The demo/unconfigured answer is { "enabled": false } - the app then keeps polling only.
 *
 * Security posture: the payload is fully validated before use, values are never logged, and the
 * defaults are fail-closed (any missing/invalid field disables realtime rather than degrading to
 * an unauthenticated or insecure connection).
 */

export const SYNC_CONFIG_ENDPOINT = '/sync/config';

const TOPIC_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const MAX_SECRET_LENGTH = 4096;

function isNonEmptyString(value, maxLength = MAX_SECRET_LENGTH) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= maxLength;
}

export function parseSyncConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: false, reason: 'no-config' };
  }
  if (raw.enabled !== true) {
    return { enabled: false, reason: 'disabled' };
  }

  const url = typeof raw.url === 'string' ? raw.url.trim().replace(/\/+$/, '') : '';
  // Realtime carries an access token: require TLS so the credential cannot travel in clear text.
  if (!/^https:\/\/[^\s]+$/i.test(url)) {
    return { enabled: false, reason: 'invalid-url' };
  }
  if (!isNonEmptyString(raw.publishableKey, 512)) {
    return { enabled: false, reason: 'invalid-publishable-key' };
  }
  if (!isNonEmptyString(raw.accessToken)) {
    return { enabled: false, reason: 'invalid-access-token' };
  }
  const topic = typeof raw.topic === 'string' ? raw.topic.trim() : '';
  if (!TOPIC_PATTERN.test(topic)) {
    return { enabled: false, reason: 'invalid-topic' };
  }

  return {
    enabled: true,
    reason: null,
    url,
    publishableKey: raw.publishableKey.trim(),
    accessToken: raw.accessToken.trim(),
    topic,
  };
}

/** Redacted description for diagnostics: never exposes the token, key or topic payload. */
export function describeSyncConfig(config) {
  if (!config?.enabled) return { enabled: false, reason: config?.reason ?? 'no-config' };
  return { enabled: true, secure: config.url.startsWith('https://'), hasAccessToken: true };
}
