/**
 * Pure alert-domain logic shared by the mobile UI, the notification layer and local tests.
 *
 * This module MUST stay free of React Native / Expo imports so it can be executed and unit
 * tested on plain Node. Everything platform specific is injected by the caller.
 *
 * Design constraints (see apps/mobile/NOTIFICATIONS.md):
 *  - Notification payloads carry the minimum possible data: only `assignmentId`.
 *  - No patient/donor identifiers, phone numbers or medical details are accepted or forwarded.
 *  - The app never asks for SYSTEM_ALERT_WINDOW and never fakes an alarm/call for
 *    full-screen intent. Alerts are permission-aware heads-up notifications only.
 */

import { NOTIFICATION_CHANNEL_ID } from '../config.js';

export const ALERT_TYPE = 'emergency_blood_alert';
export const ALERT_PAYLOAD_VERSION = 1;
export const CHANNEL_ID = NOTIFICATION_CHANNEL_ID;

/** Lock screen behaviour for the channel: never render request detail on the lock screen. */
export const CHANNEL_PRESET = Object.freeze({
  id: CHANNEL_ID,
  name: 'Emergency blood alerts',
  description:
    'Critical nearby blood requests. High importance so the alert can appear as a heads-up banner.',
  importance: 'MAX',
  vibrationPattern: [0, 250, 250, 250],
  lightColor: '#e94250',
  lockscreenVisibility: 'PRIVATE',
  enableVibrate: true,
  showBadge: true,
  bypassDnd: false,
  sound: 'default',
});

/** Backend contract (owned by the backend agent, consumed here). */
export const DEVICE_ENDPOINTS = Object.freeze({
  register: '/donor/devices',
  unregister: (installationId) => `/donor/devices/${encodeURIComponent(String(installationId))}`,
});

export const SUPPORTED_PLATFORMS = Object.freeze(['android', 'ios']);

/** Conservative identifier pattern: prevents header/URL injection and oversized payloads. */
const ID_PATTERN = /^[A-Za-z0-9._:~-]{1,128}$/;
const EXPO_PUSH_TOKEN_PATTERN = /^Expo(nent)?PushToken\[[A-Za-z0-9._~\-]{1,512}\]$/;

export function isSafeId(value) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  // Reject path-traversal-only segments such as "." / ".." even though dots are otherwise allowed.
  if (/^\.+$/.test(trimmed)) return false;
  return ID_PATTERN.test(trimmed);
}

export function isExpoPushToken(value) {
  return typeof value === 'string' && EXPO_PUSH_TOKEN_PATTERN.test(value.trim());
}

/**
 * Reduce an untrusted push payload to the only field the app reacts to.
 * Unknown/extra keys (and anything resembling PII) are dropped, never logged, never rendered.
 */
export function sanitizeAlertPayload(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, reason: 'missing-data', alert: null };
  }
  const assignmentId = typeof data.assignmentId === 'string' ? data.assignmentId.trim() : '';
  if (!assignmentId) return { ok: false, reason: 'missing-assignment-id', alert: null };
  if (!isSafeId(assignmentId)) return { ok: false, reason: 'invalid-assignment-id', alert: null };
  return {
    ok: true,
    reason: null,
    alert: { type: ALERT_TYPE, version: ALERT_PAYLOAD_VERSION, assignmentId },
  };
}

/** Map a notification payload to an in-app route, or null when nothing should be opened. */
export function resolveAlertRoute(data) {
  const result = sanitizeAlertPayload(data);
  if (!result.ok) return null;
  return { name: 'alert', assignmentId: result.alert.assignmentId };
}

/**
 * Validate an inbound deep link. Only our own scheme and a known, parameterless-safe
 * route set is accepted, so a malicious link can never steer the app elsewhere.
 */
export function parseDeepLink(url) {
  if (typeof url !== 'string' || url.length > 512) return null;
  let parsed;
  try {
    // Minimal parser: avoids depending on a URL polyfill inside tests.
    const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)/.exec(url.trim());
    if (!match) return null;
    const [, scheme, host, pathname] = match;
    if (scheme !== 'pulsedial') return null;
    const segments = `${host}${pathname}`.split('/').filter(Boolean);
    if (segments.length === 0) return { name: 'home' };
    if (segments[0] === 'alert' && segments[1] && isSafeId(segments[1])) {
      return { name: 'alert', assignmentId: segments[1] };
    }
    if (segments[0] === 'alerts') return { name: 'alerts' };
    return null;
  } catch (_) {
    parsed = null;
    return null;
  }
}

/** Per-platform statement of what this app can and cannot do. Used by UI + docs. */
export function describeAlertCapabilities(platform) {
  if (platform === 'ios') {
    return {
      platform,
      headsUp: true,
      sound: true,
      vibration: true,
      lockscreenPrivate: true,
      criticalAlerts: false,
      fullScreenIntent: false,
      overlay: false,
      notes: [
        'Banners/sound only; iOS Focus and silent mode can suppress them.',
        'Critical Alerts (bypass DND/silent) require an Apple-granted entitlement that this app does not declare.',
        'There is no supported API to launch the app above other apps from a notification.',
      ],
    };
  }
  return {
    platform: 'android',
    headsUp: true,
    sound: true,
    vibration: true,
    lockscreenPrivate: true,
    criticalAlerts: false,
    fullScreenIntent: false,
    overlay: false,
    notes: [
      'Heads-up banner requires a HIGH/MAX importance channel plus a high-priority push.',
      'Android 13+ requires the POST_NOTIFICATIONS runtime permission.',
      'Full-screen intent is restricted to calling/alarm apps and must not be abused; the app does not use it.',
      'SYSTEM_ALERT_WINDOW ("display over other apps") is not requested and is not used.',
      'Do Not Disturb, silent mode, battery optimisation and OEM task-killers can delay or suppress alerts.',
    ],
  };
}

/**
 * Single source of truth for the alerting UX: turns raw platform facts into a
 * status the UI can render plus the next corrective actions a user can take.
 */
export function computeAlertingStatus(input = {}) {
  const {
    platform = 'android',
    permissionStatus = 'undetermined',
    canAskAgain = true,
    channelReady = false,
    tokenRegistered = null,
    pushAvailable = true,
    availabilityEnabled = false,
  } = input;

  const capabilities = describeAlertCapabilities(platform);
  const actions = [];
  let level = 'ok';
  let headline = 'Emergency alerts are active';
  let detail = 'You can receive high-priority alerts while the app is closed.';

  if (!availabilityEnabled) {
    level = 'paused';
    headline = 'Alerts paused';
    detail = 'Turn on emergency availability to receive critical blood alerts.';
    actions.push('enable-availability');
  } else if (permissionStatus !== 'granted') {
    level = 'blocked';
    headline = 'Notifications are off';
    detail =
      'The system is blocking notifications, so alerts cannot appear above other apps. '
      + 'You will only see requests while the app is open.';
    if (canAskAgain) actions.push('request-permission');
    actions.push('open-settings');
  } else if (!channelReady) {
    level = 'degraded';
    headline = 'Alert channel not ready';
    detail = 'The high-importance alert channel is missing. Reopen the app or reinstall from the latest build.';
    actions.push('retry-channel');
  } else if (tokenRegistered === false || !pushAvailable) {
    level = 'degraded';
    headline = 'Limited to in-app alerts';
    detail =
      'This build has no push credentials, so closed-app alerts cannot be delivered. '
      + 'Requests still appear in the app while it is open.';
    actions.push('open-settings');
  }

  return {
    level,
    headline,
    detail,
    actions,
    canAlertWhileClosed: level === 'ok',
    capabilities,
  };
}

/** Validate + normalise the device registration body sent to POST /donor/devices. */
export function buildDeviceRegistrationPayload({ installationId, expoPushToken, platform }) {
  if (!isSafeId(installationId)) return { ok: false, reason: 'invalid-installation-id', body: null };
  if (!SUPPORTED_PLATFORMS.includes(platform)) {
    return { ok: false, reason: 'unsupported-platform', body: null };
  }
  return {
    ok: true,
    reason: null,
    body: {
      installationId: installationId.trim(),
      platform,
      expoPushToken: isExpoPushToken(expoPushToken) ? expoPushToken.trim() : null,
    },
  };
}

/**
 * Classify a registration failure so the caller knows whether retrying later can help.
 * 4xx (except 408/429) are permanent: the token/installation was rejected and must be dropped.
 */
export function classifyRegistrationError(error) {
  const status = Number(error?.status) || 0;
  if (status === 0) return { retryable: true, code: 'network' };
  if (status === 408 || status === 429 || status >= 500) return { retryable: true, code: 'transient' };
  if (status === 404 || status === 410) return { retryable: false, code: 'gone' };
  if (status >= 400) return { retryable: false, code: 'rejected' };
  return { retryable: false, code: 'unknown' };
}
