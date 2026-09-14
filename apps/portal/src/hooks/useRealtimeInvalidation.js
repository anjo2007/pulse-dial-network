import { useEffect, useRef, useState } from 'react';
import { isAbortError } from '../lib/api.js';
import { createSupabaseClient } from '../lib/realtime.js';
import { SYNC_STATUS, classifySyncFailure, createRealtimeInvalidator, parseSyncConfig, realtimeDetail, realtimeLabel } from '../lib/sync.js';

/**
 * Optional realtime invalidation for the hospital feed.
 *
 * Lifecycle:
 *  1. ask GET /sync/config for the (short lived) realtime credentials
 *  2. if the API says enabled, open one private broadcast channel and turn every signal
 *     into a feed refresh
 *  3. on unmount / sign-out, unsubscribe and reset the realtime auth
 *
 * Failure is always non-fatal: the caller keeps polling. The sync token lives about an
 * hour, so an expired one simply means "poll until the next sign-in" - it must never
 * sign the user out, which `classifySyncFailure` guarantees.
 */
export function useRealtimeInvalidation({ api, token, onInvalidate, enabled = true }) {
  const [status, setStatus] = useState(SYNC_STATUS.disabled);
  const [hint, setHint] = useState('');
  const invalidateRef = useRef(onInvalidate);
  invalidateRef.current = onInvalidate;

  useEffect(() => {
    if (!enabled || !api || typeof api.syncConfig !== 'function' || !token) {
      setStatus(SYNC_STATUS.disabled);
      setHint('');
      return undefined;
    }

    const controller = new AbortController();
    const invalidator = createRealtimeInvalidator({
      createClient: createSupabaseClient,
      onInvalidate: () => invalidateRef.current?.(),
      onStatus: (next) => setStatus(next),
    });
    let active = true;

    api
      .syncConfig(token, { signal: controller.signal, timeoutMs: 6000 })
      .then((payload) => {
        if (!active) return;
        const config = parseSyncConfig(payload);
        if (!config.enabled) {
          // Demo or realtime-disabled deployment: polling is the intended transport.
          setStatus(SYNC_STATUS.disabled);
          return;
        }
        setHint('');
        return invalidator.connect(config);
      })
      .catch((error) => {
        if (!active || isAbortError(error)) return;
        const failure = classifySyncFailure(error);
        setStatus(SYNC_STATUS.disabled);
        setHint(failure.message);
      });

    return () => {
      active = false;
      controller.abort();
      invalidator.disconnect(); // also resets realtime auth and removes the channel
    };
  }, [api, token, enabled]);

  return {
    status,
    hint,
    label: realtimeLabel(status),
    detail: realtimeDetail(status),
    enabled: status === SYNC_STATUS.subscribed,
  };
}
