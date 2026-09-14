/**
 * Single source of truth for the hospital-side HTTP contract.
 *
 * Everything here mirrors services/api/src/server.js as it exists today, so the UI can
 * never silently drift from the backend. Anything that is NOT yet implemented by the
 * backend is marked PROPOSED and is only used behind a capability flag (see below).
 */

/** Existing: GET /health */
export const HEALTH_PATH = '/health';
/** Existing: POST /auth/hospital  { email, password } -> { token, hospital } */
export const LOGIN_PATH = '/auth/hospital';
/** Existing: GET /hospital/requests -> RequestView[] */
export const REQUESTS_PATH = '/hospital/requests';
/** Existing: POST /hospital/checkin { token } -> { assignment, request } */
export const CHECKIN_PATH = '/hospital/checkin';

/**
 * GET /sync/config  (Authorization: Bearer <app session token>)
 *   -> { url, publishableKey, accessToken, topic }  or  { enabled: false }
 * The accessToken is short lived (~1 hour in production), so the portal treats an
 * expired one as "poll instead" and recovers on the next sign-in - never as a sign-out.
 */
export const SYNC_CONFIG_PATH = '/sync/config';

export const requestEscalatePath = (id) => `/hospital/requests/${encodeURIComponent(id)}/escalate`;
export const requestClosePath = (id) => `/hospital/requests/${encodeURIComponent(id)}/close`;

/**
 * PROPOSED CONTRACT (not implemented by services/api yet):
 *   POST /hospital/requests/:id/cancel  -> RequestView with status "CANCELLED"
 * The UI only offers cancellation when the API advertises
 * `capabilities.cancelRequest === true` from GET /health, so this portal keeps working
 * against the current backend and starts working the moment the endpoint ships.
 */
export const requestCancelPath = (id) => `/hospital/requests/${encodeURIComponent(id)}/cancel`;

export const DEFAULT_CAPABILITIES = Object.freeze({
  cancelRequest: false,
  requestExpiry: false,
});

/** Read optional capability flags from GET /health without requiring them to exist. */
export function parseCapabilities(health) {
  const raw = health && typeof health === 'object' ? health.capabilities : null;
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_CAPABILITIES };
  return {
    cancelRequest: raw.cancelRequest === true,
    requestExpiry: raw.requestExpiry === true,
  };
}

export function createPortalApi(client) {
  if (!client || typeof client.request !== 'function') throw new TypeError('createPortalApi requires an api client');
  return {
    baseUrl: client.baseUrl,
    health: (options) => client.get(HEALTH_PATH, { ...options, token: undefined }),
    login: ({ email, password }, options) => client.post(LOGIN_PATH, { ...options, body: { email, password } }),
    listRequests: (token, options) => client.get(REQUESTS_PATH, { ...options, token }),
    createRequest: (token, payload, options) => client.post(REQUESTS_PATH, { ...options, token, body: payload }),
    escalateRequest: (token, id, options) => client.post(requestEscalatePath(id), { ...options, token }),
    closeRequest: (token, id, options) => client.post(requestClosePath(id), { ...options, token }),
    cancelRequest: (token, id, options) => client.post(requestCancelPath(id), { ...options, token, body: {} }),
    checkIn: (token, checkinToken, options) => client.post(CHECKIN_PATH, { ...options, token, body: { token: checkinToken } }),
    // Optional realtime bootstrap; a 404/401/disabled response means "keep polling".
    syncConfig: (token, options) => client.get(SYNC_CONFIG_PATH, { ...options, token }),
  };
}
