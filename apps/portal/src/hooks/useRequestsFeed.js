import { useCallback, useState } from 'react';
import { usePolling } from './usePolling.js';
import { normalizeRequests, sameRequests } from '../lib/lifecycle.js';

/**
 * The hospital request feed.
 *
 * Polling is the explicit, supported fallback while the API has no authorized
 * realtime channel. `sameRequests` keeps a steady 4s poll from re-rendering the whole
 * dashboard: state only changes when something actually changed.
 */
export function useRequestsFeed({ api, token, onUnauthorized, intervalMs }) {
  const [requests, setRequests] = useState([]);
  const [initialLoaded, setInitialLoaded] = useState(false);
  const [pollError, setPollError] = useState(null);

  const fetchFn = useCallback(({ signal }) => api.listRequests(token, { signal }), [api, token]);

  const handleData = useCallback((data) => {
    const next = normalizeRequests(data);
    setRequests((previous) => (sameRequests(previous, next) ? previous : next));
    setInitialLoaded(true);
    setPollError(null);
  }, []);

  const handleError = useCallback((error) => {
    setPollError(error);
  }, []);

  const handleUnauthorized = useCallback(() => {
    onUnauthorized?.();
  }, [onUnauthorized]);

  const poll = usePolling({
    fetch: fetchFn,
    onData: handleData,
    onError: handleError,
    onUnauthorized: handleUnauthorized,
    intervalMs,
  });

  return {
    requests,
    setRequests,
    initialLoaded,
    pollError,
    status: poll.status,
    lastSuccessAt: poll.lastSuccessAt,
    inFlight: poll.inFlight,
    refreshNow: poll.refreshNow,
  };
}
