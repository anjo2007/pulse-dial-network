/**
 * Portal HTTP client.
 *
 * Responsibilities:
 *  - one place that knows how to talk to the dispatch API (base URL, headers, JSON)
 *  - hard timeouts so a hung socket can never freeze the UI
 *  - cancellation that is distinguishable from a real failure
 *  - normalized, human readable errors (never leaking tokens or raw payloads)
 *
 * No React, no DOM access at module scope: safe to unit test and to render on the server.
 */

export const DEFAULT_TIMEOUT_MS = 12000;

export const ERROR_CODES = {
  aborted: 'aborted',
  timeout: 'timeout',
  network: 'network',
  unauthorized: 'unauthorized',
  forbidden: 'forbidden',
  notFound: 'notFound',
  validation: 'validation',
  conflict: 'conflict',
  rateLimited: 'rateLimited',
  server: 'server',
  unsupported: 'unsupported',
  unknown: 'unknown',
};

export class ApiError extends Error {
  constructor(message, { status = 0, code = ERROR_CODES.unknown, retryable = false, path = '' } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    this.path = path;
  }
}

/** The caller asked us to stop (unmount, sign-out, navigation) - not a user visible failure. */
export function isAbortError(error) {
  return error?.code === ERROR_CODES.aborted;
}

export function isUnauthorizedError(error) {
  return error?.code === ERROR_CODES.unauthorized || error?.status === 401;
}

export function isOfflineError(error) {
  return error?.code === ERROR_CODES.network || error?.code === ERROR_CODES.timeout;
}

const FALLBACK_MESSAGES = {
  400: 'That request could not be processed. Check the details and try again.',
  401: 'Your session has expired. Please sign in again.',
  403: 'You do not have permission to perform that action.',
  404: 'That record could not be found.',
  409: 'That action conflicts with the current state. Refresh and try again.',
  429: 'Too many requests. Please slow down and try again shortly.',
  500: 'The dispatch service could not complete that operation. Please try again.',
  502: 'The dispatch service is temporarily unavailable.',
  503: 'The dispatch service is starting up or under maintenance. Retrying usually helps.',
  504: 'The dispatch service took too long to respond.',
};

function statusCodeToCode(status) {
  if (status === 400) return ERROR_CODES.validation;
  if (status === 401) return ERROR_CODES.unauthorized;
  if (status === 403) return ERROR_CODES.forbidden;
  if (status === 404) return ERROR_CODES.notFound;
  if (status === 409) return ERROR_CODES.conflict;
  if (status === 429) return ERROR_CODES.rateLimited;
  if (status >= 500) return ERROR_CODES.server;
  return ERROR_CODES.unknown;
}

function isRetryableStatus(status) {
  return status === 408 || status === 429 || status >= 500;
}

/**
 * Resolve the API base URL.
 * - VITE_API_URL wins when explicitly configured (staging / separate API host).
 * - Otherwise the portal calls its own origin under /api, which is what both the
 *   Vite dev server proxy and the Vercel rewrite in production expose.
 */
export function resolveApiBase(env) {
  const configured = typeof env?.VITE_API_URL === 'string' ? env.VITE_API_URL.trim() : '';
  if (configured) return configured.replace(/\/+$/, '');
  return '/api';
}

async function readJson(response) {
  let text = '';
  try {
    text = await response.text();
  } catch {
    return undefined;
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function httpError(status, payload, path) {
  const serverMessage = typeof payload?.error === 'string' && payload.error.trim() ? payload.error.trim() : '';
  const message = serverMessage || FALLBACK_MESSAGES[status] || `The dispatch service returned an unexpected response (HTTP ${status}).`;
  const code = statusCodeToCode(status);
  // A server provided validation message is useful to the user; keep it.
  return new ApiError(message, { status, code, retryable: isRetryableStatus(status), path });
}

function normalizeError(error, { timedOut, path }) {
  if (error instanceof ApiError) {
    if (timedOut && error.code === ERROR_CODES.aborted) {
      return new ApiError('The dispatch service took too long to respond. Check your connection and try again.', {
        code: ERROR_CODES.timeout, retryable: true, path,
      });
    }
    return error;
  }
  if (error?.name === 'AbortError' || error?.code === 20 || error?.name === 'TimeoutError') {
    if (timedOut) {
      return new ApiError('The dispatch service took too long to respond. Check your connection and try again.', {
        code: ERROR_CODES.timeout, retryable: true, path,
      });
    }
    return new ApiError('Request cancelled.', { code: ERROR_CODES.aborted, retryable: false, path });
  }
  // fetch() rejects with TypeError for DNS/connection/TLS failures.
  return new ApiError('Cannot reach the dispatch service. Check your network connection and try again.', {
    code: ERROR_CODES.network, retryable: true, path,
  });
}

export function createApiClient({ baseUrl = '/api', fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const doFetch = fetchImpl || (typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : null);
  const base = String(baseUrl || '/api').replace(/\/+$/, '');

  async function request(path, { method = 'GET', body, token, signal, timeoutMs: requestTimeout } = {}) {
    if (!doFetch) {
      throw new ApiError('This browser cannot reach the dispatch service. Update your browser and try again.', {
        code: ERROR_CODES.unsupported, path,
      });
    }
    if (signal?.aborted) throw new ApiError('Request cancelled.', { code: ERROR_CODES.aborted, path });

    const controller = new AbortController();
    const relayAbort = () => controller.abort();
    let timedOut = false;
    const limit = Number(requestTimeout) > 0 ? Number(requestTimeout) : timeoutMs;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, limit);
    if (signal) signal.addEventListener('abort', relayAbort, { once: true });

    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    try {
      const response = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      const payload = await readJson(response);
      if (!response.ok) throw httpError(response.status, payload, path);
      return payload;
    } catch (error) {
      throw normalizeError(error, { timedOut, path });
    } finally {
      clearTimeout(timeoutId);
      if (signal) signal.removeEventListener('abort', relayAbort);
    }
  }

  return {
    baseUrl: base,
    request,
    get: (path, options) => request(path, { ...options, method: 'GET' }),
    post: (path, options) => request(path, { ...options, method: 'POST' }),
    patch: (path, options) => request(path, { ...options, method: 'PATCH' }),
  };
}
