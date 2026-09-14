import { useCallback, useEffect, useRef, useState } from 'react';
import { POLL_STATUS, createPoller } from '../lib/poller.js';

/**
 * React binding for the resilient poller.
 *
 * The poller instance owns the request loop; this hook only:
 *  - keeps the latest callbacks in refs so the loop never restarts on re-render
 *  - wires browser visibility / connectivity into the loop
 *  - stops (and aborts) the loop on unmount so no state is written after teardown
 */
export function usePolling({ fetch: fetchFn, onData, onError, onUnauthorized, intervalMs, enabled = true }) {
  const fetchRef = useRef(fetchFn);
  const handlersRef = useRef({ onData, onError, onUnauthorized });
  fetchRef.current = fetchFn;
  handlersRef.current = { onData, onError, onUnauthorized };

  const pollerRef = useRef(null);
  const [state, setState] = useState({
    status: POLL_STATUS.stopped,
    consecutiveFailures: 0,
    inFlight: false,
    lastSuccessAt: 0,
    lastError: null,
  });

  useEffect(() => {
    if (!enabled) {
      setState((previous) => (previous.status === POLL_STATUS.stopped ? previous : { ...previous, status: POLL_STATUS.stopped }));
      return undefined;
    }

    const poller = createPoller({
      intervalMs,
      fetchFn: (context) => fetchRef.current(context),
      onData: (data, meta) => handlersRef.current.onData?.(data, meta),
      onError: (error, meta) => handlersRef.current.onError?.(error, meta),
      onUnauthorized: (error) => handlersRef.current.onUnauthorized?.(error),
      onStatus: (next) => setState(next),
    });
    pollerRef.current = poller;

    const doc = typeof document === 'undefined' ? null : document;
    const win = typeof window === 'undefined' ? null : window;
    const handleVisibility = () => poller.setVisible(!doc.hidden);
    const handleOnline = () => poller.setOnline(true);
    const handleOffline = () => poller.setOnline(false);

    doc?.addEventListener('visibilitychange', handleVisibility);
    win?.addEventListener('online', handleOnline);
    win?.addEventListener('offline', handleOffline);
    if (win?.navigator) poller.setOnline(win.navigator.onLine !== false);
    if (doc) poller.setVisible(!doc.hidden);
    poller.start();

    return () => {
      doc?.removeEventListener('visibilitychange', handleVisibility);
      win?.removeEventListener('online', handleOnline);
      win?.removeEventListener('offline', handleOffline);
      poller.stop();
      pollerRef.current = null;
    };
  }, [enabled, intervalMs]);

  const refreshNow = useCallback(() => {
    const poller = pollerRef.current;
    return poller ? poller.refreshNow() : false;
  }, []);

  return { ...state, refreshNow };
}
