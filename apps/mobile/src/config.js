/**
 * Central runtime configuration for the Pulse Dial donor app (@pulse/mobile).
 *
 * Rules enforced here:
 *  - No secrets are bundled. Only public, non-sensitive configuration lives in this file.
 *  - No Supabase URL/key is hardcoded. The donor app talks to the Pulse API only.
 *  - Every value can be overridden per build through EXPO_PUBLIC_* env vars (see .env.example).
 */

const env = (name, fallback = '') => {
  const value = process.env[name];
  return typeof value === 'string' ? value.trim() : fallback;
};

const bool = (name, fallback) => {
  const raw = env(name);
  if (!raw) return fallback;
  return raw !== 'false' && raw !== '0';
};

/** True only inside a development bundle; release bundles compile `__DEV__` to false. */
export const IS_DEV = typeof __DEV__ !== 'undefined' ? __DEV__ : false;

/** Cleartext HTTP is allowed for local Wi-Fi and development endpoints. */
export const ALLOW_INSECURE_API_URL = true;

/**
 * Single source of truth for API endpoint validation (pure, unit tested).
 * @returns {{ok: boolean, value?: string, reason?: 'missing'|'insecure'|'invalid'}}
 */
export function isAcceptableApiUrl(url, { allowInsecure = ALLOW_INSECURE_API_URL } = {}) {
  if (typeof url !== 'string' || !url.trim()) return { ok: false, reason: 'missing' };
  const value = url.trim().replace(/\/+$/, '');
  if (/^https:\/\/[^\s]+$/i.test(value)) return { ok: true, value };
  if (/^http:\/\/[^\s]+$/i.test(value)) {
    return allowInsecure ? { ok: true, value } : { ok: false, reason: 'insecure' };
  }
  return { ok: false, reason: 'invalid' };
}

export const API_URL_INVALID_MESSAGE =
  'Invalid API endpoint: enter an http:// or https:// URL, such as http://192.168.1.5:4000';
export const API_URL_INVALID_URL_MESSAGE =
  'Enter a full URL, for example http://192.168.1.5:4000 or https://your-domain.example/api';

/** API base URL. Defaults to the active local server address or environment override. */
export const DEFAULT_API_URL = (env('EXPO_PUBLIC_API_URL') || 'http://192.168.1.5:4000').replace(/\/+$/, '');

/**
 * Optional EAS project id. Only required to obtain an Expo push token (remote push).
 * Without it the app still works: alerts degrade to in-app polling + local notifications.
 */
export const EAS_PROJECT_ID = env('EXPO_PUBLIC_EAS_PROJECT_ID');

/** Set to 'false' to disable all push-token acquisition (e.g. privacy-restricted builds). */
export const PUSH_TOKEN_ENABLED = bool('EXPO_PUBLIC_PUSH_TOKEN_ENABLED', true);

/** Local-only notification simulator for device verification without any server. */
export const LOCAL_ALERT_SIMULATOR_ENABLED = bool(
  'EXPO_PUBLIC_LOCAL_ALERT_SIMULATOR',
  typeof __DEV__ !== 'undefined' ? __DEV__ : false
);

export const API_TIMEOUT_MS = 8000;
/** Poll cadence while the app is in the foreground (fallback for missed pushes). */
export const ALERT_POLL_INTERVAL_MS = 5000;

export const STORAGE_KEYS = Object.freeze({
  serverUrl: 'pulse-server-url',
  session: 'pulse.session.v2',
  donorPhone: 'pulse.donor.phone.v2',
  installationId: 'pulse.installation-id.v1',
  deviceOutbox: 'pulse.device-outbox.v1',
});

/** Single Android notification channel used for every emergency alert. */
export const NOTIFICATION_CHANNEL_ID = 'emergency-blood-alerts';
export const NOTIFICATION_CHANNEL_NAME = 'Emergency blood alerts';
export const NOTIFICATION_CHANNEL_DESCRIPTION =
  'Critical nearby blood requests. High importance so the alert can appear as a heads-up banner.';
