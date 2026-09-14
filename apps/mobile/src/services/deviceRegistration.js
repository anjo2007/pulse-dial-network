/**
 * Push-token registration/unregistration against the Pulse API.
 *
 * Contract (backend-owned, consumed here):
 *   POST   /donor/devices                       { installationId, expoPushToken, platform }
 *   DELETE /donor/devices/:installationId
 *
 * Reliability notes:
 *  - Registration is idempotent: re-registering the same installationId refreshes the token.
 *  - Transient failures (network / 5xx / 408 / 429) are queued in a single-slot outbox and retried
 *    on the next app start, sign-in or availability change.
 *  - Permanent failures (4xx / 410 / 404) drop the queue instead of retrying forever.
 *  - Nothing here is allowed to block the UI: every call resolves with a result object.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { STORAGE_KEYS } from '../config.js';
import {
  DEVICE_ENDPOINTS,
  buildDeviceRegistrationPayload,
  classifyRegistrationError,
} from '../lib/alerts.js';

export function createDeviceRegistry({ request, storage = AsyncStorage, logger = console } = {}) {
  if (typeof request !== 'function') throw new TypeError('createDeviceRegistry requires request()');

  async function readQueue() {
    try {
      const raw = await storage.getItem(STORAGE_KEYS.deviceOutbox);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (_) {
      return null;
    }
  }

  async function writeQueue(entry) {
    try {
      if (!entry) {
        await storage.removeItem(STORAGE_KEYS.deviceOutbox);
      } else {
        await storage.setItem(STORAGE_KEYS.deviceOutbox, JSON.stringify({ ...entry, attempts: (entry.attempts || 0) } ));
      }
    } catch (_) {
      // A failed queue write must never surface to the user.
    }
  }

  async function send(kind, payload) {
    if (kind === 'register') {
      await request('POST', DEVICE_ENDPOINTS.register, payload);
    } else {
      await request('DELETE', DEVICE_ENDPOINTS.unregister(payload.installationId), undefined);
    }
  }

  /** Register (or refresh) this installation's push token. */
  async function register({ installationId, expoPushToken, platform }) {
    const built = buildDeviceRegistrationPayload({ installationId, expoPushToken, platform });
    if (!built.ok) return { ok: false, queued: false, reason: built.reason };
    try {
      await send('register', built.body);
      await writeQueue(null);
      return { ok: true, queued: false, reason: null };
    } catch (error) {
      const classified = classifyRegistrationError(error);
      if (classified.retryable) {
        await writeQueue({ kind: 'register', payload: built.body, attempts: 1, at: new Date().toISOString() });
        return { ok: false, queued: true, reason: classified.code };
      }
      logger?.warn?.(`Device registration rejected (${classified.code}); token will not be retried.`);
      await writeQueue(null);
      return { ok: false, queued: false, reason: classified.code };
    }
  }

  /** Remove this installation so the backend stops targeting it (sign-out / availability off). */
  async function unregister({ installationId }) {
    if (typeof installationId !== 'string' || !installationId) {
      return { ok: false, queued: false, reason: 'invalid-installation-id' };
    }
    try {
      await send('unregister', { installationId });
      await writeQueue(null);
      return { ok: true, queued: false, reason: null };
    } catch (error) {
      const classified = classifyRegistrationError(error);
      if (classified.retryable) {
        await writeQueue({ kind: 'unregister', payload: { installationId }, attempts: 1, at: new Date().toISOString() });
        return { ok: false, queued: true, reason: classified.code };
      }
      await writeQueue(null);
      return { ok: false, queued: false, reason: classified.code };
    }
  }

  /** Retry a queued operation, if any. Safe to call on every app start. */
  async function flush() {
    const entry = await readQueue();
    if (!entry?.kind || !entry?.payload) return { ok: true, flushed: false, reason: 'empty' };
    try {
      await send(entry.kind, entry.payload);
      await writeQueue(null);
      return { ok: true, flushed: true, reason: null };
    } catch (error) {
      const classified = classifyRegistrationError(error);
      if (classified.retryable) {
        await writeQueue({ ...entry, attempts: (entry.attempts || 0) + 1, at: new Date().toISOString() });
        return { ok: false, flushed: false, reason: classified.code };
      }
      await writeQueue(null);
      return { ok: false, flushed: false, reason: classified.code };
    }
  }

  return { register, unregister, flush, inspect: readQueue };
}

export default createDeviceRegistry;
