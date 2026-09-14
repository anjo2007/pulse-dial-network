/**
 * Resilient polling controller.
 *
 * The dispatch API has no realtime transport, so the portal polls. A naive
 * setInterval poller silently degrades: it keeps hammering a down service, races
 * itself, updates unmounted components and never recovers from a laptop sleep.
 * This controller fixes that with explicit guarantees:
 *
 *  - never more than one in-flight request (overlapping ticks are coalesced)
 *  - exponential backoff (interval -> 2x -> 4x ... capped) that resets on success
 *  - pauses while the tab is hidden and resumes with an immediate refresh
 *  - reacts to browser offline/online instead of retrying pointlessly
 *  - ignores responses that arrive after stop()/restart (generation guard)
 *  - an aborted request is never reported as a failure
 *  - a 401 stops polling and hands off to the session-expiry flow
 *
 * The scheduler is injectable, so the whole state machine is unit tested without
 * fake timers or real waiting.
 */

import { isAbortError as defaultIsAbortError, isUnauthorizedError } from './api.js';

export const POLL_STATUS = Object.freeze({
  idle: 'idle',
  live: 'live',
  reconnecting: 'reconnecting',
  paused: 'paused',
  offline: 'offline',
  unauthorized: 'unauthorized',
  stopped: 'stopped',
});

export const DEFAULT_INTERVAL_MS = 4000;
export const DEFAULT_MAX_BACKOFF_MS = 30000;

const realScheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  now: () => Date.now(),
};

export function createPoller({
  fetchFn,
  intervalMs = DEFAULT_INTERVAL_MS,
  maxBackoffMs = DEFAULT_MAX_BACKOFF_MS,
  scheduler = realScheduler,
  onData,
  onError,
  onStatus,
  onUnauthorized,
  isAbortError = defaultIsAbortError,
} = {}) {
  if (typeof fetchFn !== 'function') throw new TypeError('createPoller requires a fetchFn');

  let running = false;
  let inFlight = false;
  let timer = null;
  let controller = null;
  let failures = 0;
  let lastSuccessAt = 0;
  let lastError = null;
  let hasSucceeded = false;
  let visible = true;
  let online = true;
  let generation = 0;
  let lastEmitted = null;
  let stopReason = POLL_STATUS.stopped;

  function computeStatus() {
    if (!running) return stopReason;
    if (!online) return POLL_STATUS.offline;
    if (!visible) return POLL_STATUS.paused;
    if (failures > 0) return POLL_STATUS.reconnecting;
    if (!hasSucceeded) return POLL_STATUS.idle;
    return POLL_STATUS.live;
  }

  function snapshot() {
    return {
      status: computeStatus(),
      consecutiveFailures: failures,
      inFlight,
      lastSuccessAt,
      lastError,
      online,
      visible,
      nextRetryInMs: failures > 0 ? Math.min(intervalMs * 2 ** (failures - 1), maxBackoffMs) : intervalMs,
    };
  }

  function emit(force = false) {
    const state = snapshot();
    const signature = `${state.status}|${state.consecutiveFailures}|${state.inFlight}|${state.lastSuccessAt}|${state.online}|${state.visible}`;
    if (!force && signature === lastEmitted) return;
    lastEmitted = signature;
    onStatus?.(state);
  }

  function clearTimer() {
    if (timer !== null) {
      scheduler.clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(delay) {
    clearTimer();
    if (!running || !visible || !online) return;
    timer = scheduler.setTimeout(() => {
      timer = null;
      void run();
    }, Math.max(250, delay));
  }

  async function run() {
    if (!running) return;
    if (inFlight) return; // coalesce: the current cycle will schedule the next one
    const myGeneration = generation;
    inFlight = true;
    controller = new AbortController();
    emit();

    try {
      const data = await fetchFn({ signal: controller.signal });
      if (myGeneration !== generation || !running) return;
      failures = 0;
      lastError = null;
      hasSucceeded = true;
      lastSuccessAt = scheduler.now();
      onData?.(data, { at: lastSuccessAt });
    } catch (error) {
      if (myGeneration !== generation || !running) return;
      if (isAbortError(error)) return; // cancelled on purpose - not a failure
      failures += 1;
      lastError = error;
      if (isUnauthorizedError(error)) {
        onUnauthorized?.(error);
        stop(POLL_STATUS.unauthorized);
        return;
      }
      onError?.(error, { consecutiveFailures: failures });
    } finally {
      inFlight = false;
      controller = null;
      if (running && myGeneration === generation) {
        emit();
        schedule(failures > 0 ? Math.min(intervalMs * 2 ** (failures - 1), maxBackoffMs) : intervalMs);
      }
    }
  }

  function start() {
    if (running) return snapshot();
    running = true;
    stopReason = POLL_STATUS.stopped;
    generation += 1;
    failures = 0;
    lastError = null;
    hasSucceeded = false;
    lastEmitted = null;
    emit(true);
    void run();
    return snapshot();
  }

  function stop(reason = POLL_STATUS.stopped) {
    const wasRunning = running;
    running = false;
    stopReason = reason;
    generation += 1; // invalidates any response that is still in flight
    clearTimer();
    if (controller) {
      controller.abort();
      controller = null;
    }
    inFlight = false;
    if (wasRunning || reason === POLL_STATUS.unauthorized) {
      lastEmitted = null;
      emit(true);
    }
    return snapshot();
  }

  function refreshNow() {
    if (!running || inFlight) return false;
    clearTimer();
    void run();
    return true;
  }

  function setVisible(next) {
    const value = next !== false;
    if (value === visible) return snapshot();
    visible = value;
    if (!visible) {
      clearTimer();
    } else if (running) {
      clearTimer();
      void run();
    }
    emit();
    return snapshot();
  }

  function setOnline(next) {
    const value = next !== false;
    if (value === online) return snapshot();
    online = value;
    if (!online) {
      clearTimer();
    } else if (running) {
      // A fresh connection deserves a fresh budget: drop the accumulated backoff.
      failures = 0;
      hasSucceeded = false;
      clearTimer();
      void run();
    }
    emit();
    return snapshot();
  }

  return {
    start,
    stop,
    refreshNow,
    setVisible,
    setOnline,
    getState: snapshot,
    isRunning: () => running,
    isInFlight: () => inFlight,
    hasTimer: () => timer !== null,
  };
}

/** Map a poll status to the connection copy shown in the UI. */
export function connectionCopy(status, { lastSuccessAt = 0, now = Date.now() } = {}) {
  const age = lastSuccessAt ? Math.max(0, now - lastSuccessAt) : null;
  const stale = age === null ? 'never' : age < 6000 ? 'just now' : `${Math.round(age / 1000)}s ago`;
  switch (status) {
    case POLL_STATUS.live:
      return { tone: 'green', title: 'Live', detail: `Dispatch feed updated ${stale}.` };
    case POLL_STATUS.idle:
      return { tone: 'blue', title: 'Connecting', detail: 'Fetching the live dispatch feed.' };
    case POLL_STATUS.reconnecting:
      return { tone: 'amber', title: 'Reconnecting', detail: `Dispatch feed last updated ${stale}. Retrying automatically.` };
    case POLL_STATUS.paused:
      return { tone: 'gray', title: 'Paused', detail: 'Polling resumes when this tab is visible again.' };
    case POLL_STATUS.offline:
      return { tone: 'red', title: 'Offline', detail: 'No network connection. The feed will refresh when you are back online.' };
    case POLL_STATUS.unauthorized:
      return { tone: 'red', title: 'Signed out', detail: 'Your session ended. Sign in again to resume dispatch.' };
    default:
      return { tone: 'gray', title: 'Stopped', detail: 'Live updates are paused.' };
  }
}
