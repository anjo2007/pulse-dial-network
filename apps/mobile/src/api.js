/**
 * Pulse API client used by the donor app.
 *
 * Deliberately API-only: the previous build silently fell back to writing Supabase rows directly
 * from the device with a bundled publishable key. That bypassed server-side authorisation and
 * bundled environment-specific configuration, so it has been removed.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  API_TIMEOUT_MS,
  API_URL_INVALID_MESSAGE,
  API_URL_INVALID_URL_MESSAGE,
  DEFAULT_API_URL,
  STORAGE_KEYS,
  isAcceptableApiUrl,
} from './config.js';

const initialApiUrl = isAcceptableApiUrl(DEFAULT_API_URL);
// A rejected compile-time endpoint (missing, malformed, or http:// in a release build) leaves the
// app unconfigured rather than pointed at something that can never work.
let currentApiUrl = initialApiUrl.ok ? initialApiUrl.value : '';

/** True when this build ships a usable (https in release) API endpoint. */
export const API_URL_CONFIGURED = initialApiUrl.ok;
/** Why the compile-time endpoint was rejected, when applicable. */
export const API_URL_CONFIG_REASON = initialApiUrl.ok ? null : initialApiUrl.reason;

export class ApiError extends Error {
  constructor(message, status = 0, code = 'request-failed') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function getApiUrl() {
  return currentApiUrl;
}

export async function loadApiUrl() {
  try {
    const saved = await AsyncStorage.getItem(STORAGE_KEYS.serverUrl);
    if (saved) {
      const accepted = isAcceptableApiUrl(saved);
      if (accepted.ok) {
        currentApiUrl = accepted.value;
      } else {
        await AsyncStorage.removeItem(STORAGE_KEYS.serverUrl);
        currentApiUrl = initialApiUrl.ok ? initialApiUrl.value : '';
      }
    } else {
      currentApiUrl = initialApiUrl.ok ? initialApiUrl.value : '';
    }
  } catch (_) {
    // Non-fatal: keep the compile-time default.
  }
  return currentApiUrl;
}

export async function saveApiUrl(url) {
  const accepted = isAcceptableApiUrl(url);
  if (!accepted.ok) {
    const insecure = accepted.reason === 'insecure';
    throw new ApiError(
      insecure ? API_URL_INVALID_MESSAGE : API_URL_INVALID_URL_MESSAGE,
      0,
      insecure ? 'insecure-url' : 'invalid-url'
    );
  }
  await AsyncStorage.setItem(STORAGE_KEYS.serverUrl, accepted.value);
  currentApiUrl = accepted.value;
  return accepted.value;
}

export async function resetApiUrl() {
  await AsyncStorage.removeItem(STORAGE_KEYS.serverUrl);
  currentApiUrl = initialApiUrl.ok ? initialApiUrl.value : '';
  return currentApiUrl;
}

/**
 * Perform an authenticated API request.
 * Always throws ApiError (never a bare Error) so callers can classify status codes.
 */
export async function api(path, options = {}, token) {
  if (!currentApiUrl) {
    throw new ApiError(
      'No server is configured. Open Server Settings and enter the Pulse API URL.',
      0,
      'missing-api-url'
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), API_TIMEOUT_MS);
  try {
    const response = await fetch(`${currentApiUrl}${path}`, {
      ...options,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...options.headers,
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new ApiError(body.error || `Request failed (${response.status})`, response.status, 'http-error');
    }
    return body;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error?.name === 'AbortError') {
      throw new ApiError('The server did not respond in time.', 0, 'timeout');
    }
    throw new ApiError(error?.message || 'Network request failed.', 0, 'network');
  } finally {
    clearTimeout(timer);
  }
}
