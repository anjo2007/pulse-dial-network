/**
 * Dynamic Expo config for the donor app (@pulse/mobile).
 *
 * Responsibilities (everything else still comes from app.json, which is passed in as `config`):
 *  - Honour GOOGLE_SERVICES_FILE for native Firebase/FCM configuration on Android.
 *  - Honour an EAS project id from EXPO_PUBLIC_EAS_PROJECT_ID / EAS_PROJECT_ID / EXPO_PROJECT_ID
 *    and expose it as extra.eas.projectId, which expo-notifications needs to mint a push token.
 *  - Fail closed for production/EAS builds: a production build either has a complete push setup
 *    (EAS project id + Android Firebase config) or it must explicitly declare itself as a
 *    polling-only build. Development builds may run without push credentials.
 *
 * No secret is read or printed here: google-services.json stays a file path and the EAS project id
 * is a public identifier.
 */

const fs = require('node:fs');
const path = require('node:path');

const appJson = require('./app.json');

const APP_JSON_EXPO = appJson.expo || {};

function envValue(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function boolEnv(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  return !['false', '0', 'no'].includes(String(value).trim().toLowerCase());
}

/** A production-ish build: EAS build, explicit production env, or NODE_ENV=production. */
function isProductionBuild() {
  return (
    String(process.env.EAS_BUILD || '').toLowerCase() === 'true'
    || String(process.env.PULSE_ENV || '').toLowerCase() === 'production'
    || String(process.env.APP_ENV || '').toLowerCase() === 'production'
    || process.env.NODE_ENV === 'production'
  );
}

function fail(message) {
  throw new Error(`[pulse-dial] ${message}`);
}

module.exports = ({ config } = {}) => {
  // Expo passes the static app.json contents as `config`; fall back defensively if it is empty.
  const base = config && Object.keys(config).length > 0 ? config : APP_JSON_EXPO;
  const next = { ...base };

  const easProjectId = envValue('EXPO_PUBLIC_EAS_PROJECT_ID', 'EAS_PROJECT_ID', 'EXPO_PROJECT_ID');
  const googleServicesFile = envValue('GOOGLE_SERVICES_FILE');
  const pushEnabled = boolEnv(
    envValue('PUSH_TOKEN_ENABLED', 'EXPO_PUBLIC_PUSH_TOKEN_ENABLED'),
    true
  );
  const pollingOnlyAcknowledged = boolEnv(process.env.PULSE_ALLOW_POLLING_ONLY, false);
  const production = isProductionBuild();

  if (easProjectId) {
    next.extra = {
      ...(base.extra || {}),
      eas: { ...(base.extra && base.extra.eas ? base.extra.eas : {}), projectId: easProjectId },
    };
  }

  if (googleServicesFile) {
    const resolved = path.isAbsolute(googleServicesFile)
      ? googleServicesFile
      : path.resolve(__dirname, googleServicesFile);
    if (!fs.existsSync(resolved)) {
      fail(
        `GOOGLE_SERVICES_FILE is set to "${googleServicesFile}" but no file exists at ${resolved}. `
        + 'Android push requires a real Firebase google-services.json; unset the variable to build '
        + 'without push credentials (alerts then fall back to in-app polling).'
      );
    }
    next.android = { ...(base.android || {}), googleServicesFile: resolved };
  }

  // ------------------------------------------------------------------ production gate (fail closed)
  let alertMode = 'polling-only';
  if (production) {
    if (!pushEnabled) {
      if (!pollingOnlyAcknowledged) {
        fail(
          'PUSH_TOKEN_ENABLED=false in a production/EAS build. Without push credentials the app can '
          + 'only surface requests while it is open, which is not production-ready for emergency '
          + 'delivery. Set PULSE_ALLOW_POLLING_ONLY=true to acknowledge and ship a polling-only build '
          + 'explicitly.'
        );
      }
      alertMode = 'polling-only';
    } else {
      if (!easProjectId) {
        if (pollingOnlyAcknowledged) {
          alertMode = 'polling-only';
        } else {
          fail(
            'A production/EAS build requires EXPO_PUBLIC_EAS_PROJECT_ID (extra.eas.projectId): without '
            + 'it getExpoPushTokenAsync cannot mint a token. Set PUSH_TOKEN_ENABLED=false plus '
            + 'PULSE_ALLOW_POLLING_ONLY=true to build a polling-only app instead.'
          );
        }
      } else if (!googleServicesFile) {
        if (pollingOnlyAcknowledged) {
          alertMode = 'polling-only';
        } else {
          fail(
            'A production/EAS Android build requires GOOGLE_SERVICES_FILE (Firebase google-services.json). '
            + 'An EAS project id alone cannot deliver alerts: FCM V1 credentials for this application id '
            + 'must also be registered with the push service. Set PUSH_TOKEN_ENABLED=false plus '
            + 'PULSE_ALLOW_POLLING_ONLY=true to build a polling-only app instead.'
          );
        }
      } else {
        alertMode = 'push';
      }
    }
  }

  next.extra = { ...(next.extra || {}), pulseAlerts: alertMode };
  return next;
};
