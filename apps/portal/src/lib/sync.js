/**
 * Optional Supabase Realtime invalidation.
 *
 * Design contract with the API:
 *   GET /sync/config  (Authorization: Bearer <app session token>)
 *     -> { url, publishableKey, accessToken, topic }   // realtime available
 *     -> { enabled: false }                            // demo / realtime disabled
 *
 * How the portal uses it:
 *  - the broadcast channel carries NO payloads. A signal only means
 *    "something changed, re-read the authoritative REST feed". No donor or hospital
 *    data ever travels over the channel, so a compromised channel leaks nothing.
 *  - realtime is strictly an optimisation. Polling remains the guaranteed transport:
 *    every failure here (disabled, missing dependency, bad config, expired sync token,
 *    channel error) degrades to polling and NEVER ends the session. The /sync/config
 *    access token expires after about an hour, and re-authenticating the portal is the
 *    intended recovery - we do not try to keep a realtime session alive forever.
 *
 * Everything in this module is pure/injected so it can be unit tested without a
 * network, a browser or the supabase dependency.
 */

import { isOfflineError, isUnauthorizedError } from './api.js';

export const SYNC_CONFIG_PATH = '/sync/config';

export const SYNC_STATUS = Object.freeze({
  disabled: 'disabled',
  connecting: 'connecting',
  subscribed: 'subscribed',
  error: 'error',
  closed: 'closed',
});

/** Minimum gap between two forwarded invalidations (a signal storm must not fetch-storm). */
export const DEFAULT_COALESCE_MS = 750;

const DISABLED_CONFIG = Object.freeze({ enabled: false, url: '', publishableKey: '', accessToken: '', topic: '' });

const asText = (value) => (typeof value === 'string' && value.trim() ? value.trim() : '');

/**
 * Parse GET /sync/config defensively. A partially configured response is treated as
 * "disabled" rather than handed to the client: a half-built client is worse than none.
 */
export function parseSyncConfig(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ...DISABLED_CONFIG };
  if (payload.enabled === false) return { ...DISABLED_CONFIG };

  const config = {
    url: asText(payload.url),
    publishableKey: asText(payload.publishableKey),
    accessToken: asText(payload.accessToken),
    topic: asText(payload.topic),
  };
  if (!config.url || !config.publishableKey || !config.accessToken || !config.topic) {
    return { ...DISABLED_CONFIG };
  }
  return { enabled: true, ...config };
}

/**
 * Classify a /sync/config failure.
 *
 * The important guarantee: this can never produce a sign-out. An expired sync token
 * (about one hour in production) or an unreachable sync endpoint means "poll instead",
 * because the REST feed is authenticated by the main session token, not by this one.
 */
export function classifySyncFailure(error) {
  if (isUnauthorizedError(error)) {
    return {
      mode: 'polling',
      reason: 'unauthorized',
      message: 'Realtime sync session ended. Live polling continues - sign in again for instant updates.',
    };
  }
  if (isOfflineError(error)) {
    return {
      mode: 'polling',
      reason: 'offline',
      message: 'Realtime sync is unreachable. Live polling continues and will recover automatically.',
    };
  }
  return {
    mode: 'polling',
    reason: 'unavailable',
    message: 'Realtime sync is unavailable. Live polling continues and will recover automatically.',
  };
}

/** Short transport label shown next to the connection pill. */
export function realtimeLabel(status) {
  if (status === SYNC_STATUS.subscribed) return 'Realtime';
  if (status === SYNC_STATUS.connecting) return 'Connecting';
  return 'Polling';
}

export const realtimeDetail = (status) =>
  status === SYNC_STATUS.subscribed
    ? 'Instant invalidation from the dispatch service, with polling as a safety net.'
    : 'Polling the dispatch feed on a timer.';

const realScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  now: () => Date.now(),
};

/**
 * Realtime bridge: owns exactly one private broadcast channel and translates signals
 * into (coalesced) refresh requests.
 */
export function createRealtimeInvalidator({
  createClient,
  onInvalidate,
  onStatus,
  scheduler = realScheduler,
  coalesceMs = DEFAULT_COALESCE_MS,
  logger,
} = {}) {
  let client = null;
  let channel = null;
  let status = SYNC_STATUS.disabled;
  let pendingTrailing = null;
  // -Infinity so the very first signal after connecting is forwarded at once.
  let lastForwardedAt = Number.NEGATIVE_INFINITY;
  let generation = 0;

  function setStatus(next) {
    if (next === status) return;
    status = next;
    onStatus?.(next);
  }

  function clearTrailing() {
    if (pendingTrailing !== null) {
      scheduler.clearTimeout(pendingTrailing);
      pendingTrailing = null;
    }
  }

  function forward(source) {
    lastForwardedAt = scheduler.now();
    // No payload is forwarded: the consumer only ever refetches.
    onInvalidate?.({ source });
  }

  /** A realtime signal. Data received on the channel is deliberately ignored. */
  function signal(source = 'broadcast') {
    if (status !== SYNC_STATUS.subscribed) return false;
    const elapsed = scheduler.now() - lastForwardedAt;
    if (elapsed >= coalesceMs) {
      forward(source);
      return true;
    }
    if (pendingTrailing === null) {
      pendingTrailing = scheduler.setTimeout(() => {
        pendingTrailing = null;
        forward('coalesced');
      }, coalesceMs - elapsed);
    }
    return true;
  }

  function teardown() {
    generation += 1;
    clearTrailing();
    const previousClient = client;
    const previousChannel = channel;
    client = null;
    channel = null;
    // removeChannel/setAuth are async: a rejected promise must be swallowed here too,
    // otherwise a teardown during sign-out produces an unhandled rejection.
    if (previousClient && previousChannel) {
      try {
        Promise.resolve(previousClient.removeChannel(previousChannel)).catch((error) =>
          logger?.warn?.('realtime: channel removal failed', error?.message),
        );
      } catch (error) {
        logger?.warn?.('realtime: channel removal failed', error?.message);
      }
    }
    if (previousClient?.realtime?.setAuth) {
      try {
        Promise.resolve(previousClient.realtime.setAuth(null)).catch((error) =>
          logger?.warn?.('realtime: auth reset failed', error?.message),
        );
      } catch (error) {
        logger?.warn?.('realtime: auth reset failed', error?.message);
      }
    }
  }

  async function connect(config) {
    if (!config?.enabled) {
      setStatus(SYNC_STATUS.disabled);
      return status;
    }
    if (typeof createClient !== 'function') {
      // The optional dependency is not installed: polling only, no crash.
      logger?.warn?.('realtime: supabase client factory unavailable, falling back to polling');
      setStatus(SYNC_STATUS.disabled);
      return status;
    }

    teardown(); // restart-safe: an existing channel is never leaked
    const myGeneration = generation;
    setStatus(SYNC_STATUS.connecting);

    try {
      const created = await createClient(config.url, config.publishableKey, {
        auth: {
          persistSession: false,
          autoRefreshToken: false,
          detectSessionInUrl: false,
        },
      });
      if (myGeneration !== generation) return status;
      client = created;

      if (typeof created?.realtime?.setAuth === 'function') {
        await created.realtime.setAuth(config.accessToken);
      }
      if (myGeneration !== generation) return status;

      const nextChannel = created.channel(config.topic, { config: { private: true } });
      if (myGeneration !== generation) return status;
      channel = nextChannel;

      nextChannel.on('broadcast', { event: 'changed' }, () => signal('broadcast'));
      nextChannel.subscribe((channelStatus) => {
        if (channelStatus === 'SUBSCRIBED') setStatus(SYNC_STATUS.subscribed);
        else if (channelStatus === 'CHANNEL_ERROR' || channelStatus === 'TIMED_OUT') setStatus(SYNC_STATUS.error);
        else if (channelStatus === 'CLOSED') setStatus(SYNC_STATUS.closed);
      });

      return status;
    } catch (error) {
      // Any failure here is non-fatal: polling is still running.
      logger?.warn?.('realtime: subscription failed, falling back to polling', error?.message);
      teardown();
      setStatus(SYNC_STATUS.error);
      return status;
    }
  }

  function disconnect() {
    teardown();
    if (status !== SYNC_STATUS.disabled) setStatus(SYNC_STATUS.closed);
    return status;
  }

  return {
    connect,
    disconnect,
    signal,
    getState: () => ({
      status,
      hasClient: Boolean(client),
      hasChannel: Boolean(channel),
      hasTrailingRefresh: pendingTrailing !== null,
    }),
  };
}
