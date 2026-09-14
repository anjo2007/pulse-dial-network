import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/lib/api.js';
import { POLL_STATUS, connectionCopy, createPoller } from '../src/lib/poller.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

/** Deterministic virtual clock: the whole poller state machine runs with no real waiting. */
function createScheduler() {
  let time = 0;
  let sequence = 1;
  const timers = new Map();
  return {
    setTimeout(fn, ms) {
      const id = sequence++;
      timers.set(id, { fn, at: time + ms });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    now: () => time,
    pending: () => timers.size,
    nextDelay: () => {
      let min = Infinity;
      for (const timer of timers.values()) min = Math.min(min, timer.at - time);
      return min;
    },
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        let nextId = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (nextId === null || timer.at < timers.get(nextId).at)) nextId = id;
        }
        if (nextId === null) break;
        const timer = timers.get(nextId);
        timers.delete(nextId);
        time = timer.at;
        timer.fn();
        await flush();
      }
      time = target;
      await flush();
    },
  };
}

function createFetchStub() {
  const calls = [];
  const state = { mode: 'ok', payload: [{ id: 'req-1' }], signals: [], resolve: null };
  const fetchFn = ({ signal }) => {
    calls.push(1);
    state.signals.push(signal);
    switch (state.mode) {
      case 'fail':
        return Promise.reject(new ApiError('Cannot reach the dispatch service.', { code: 'network', retryable: true }));
      case 'unauthorized':
        return Promise.reject(new ApiError('Your session has expired. Please sign in again.', { code: 'unauthorized', status: 401 }));
      case 'deferred':
        return new Promise((resolve, reject) => {
          state.resolve = resolve;
          signal.addEventListener('abort', () => reject(new ApiError('Request cancelled.', { code: 'aborted' })));
        });
      case 'ignore-abort':
        return new Promise((resolve) => {
          state.resolve = resolve;
        });
      default:
        return Promise.resolve(state.payload);
    }
  };
  return { fetchFn, calls, state };
}

function harness(overrides = {}) {
  const scheduler = createScheduler();
  const fetch = createFetchStub();
  const events = { data: [], errors: [], statuses: [], states: [], unauthorized: 0 };
  const poller = createPoller({
    fetchFn: fetch.fetchFn,
    scheduler,
    intervalMs: 4000,
    maxBackoffMs: 30000,
    onData: (data) => events.data.push(data),
    onError: (error, meta) => events.errors.push({ message: error.message, consecutiveFailures: meta.consecutiveFailures }),
    onStatus: (state) => {
      events.statuses.push(state.status);
      events.states.push(state);
    },
    onUnauthorized: () => {
      events.unauthorized += 1;
    },
    ...overrides,
  });
  return { poller, scheduler, fetch, events };
}

test('happy path', async (t) => {
  await t.test('start() polls once, delivers data and schedules the next tick', async () => {
    const { poller, scheduler, fetch, events } = harness();
    poller.start();
    await flush();
    assert.equal(fetch.calls.length, 1);
    assert.deepEqual(events.data, [[{ id: 'req-1' }]]);
    assert.equal(poller.getState().status, POLL_STATUS.live);
    assert.equal(scheduler.nextDelay(), 4000);
    poller.stop();
  });

  await t.test('start() is idempotent - StrictMode double effects cannot double-poll', async () => {
    const { poller, fetch } = harness();
    poller.start();
    poller.start();
    await flush();
    assert.equal(fetch.calls.length, 1);
    poller.stop();
  });

  await t.test('ticks never overlap: a slow response blocks the next tick', async () => {
    const { poller, scheduler, fetch, events } = harness();
    fetch.state.mode = 'deferred';
    poller.start();
    await flush();
    await scheduler.advance(60000);
    assert.equal(fetch.calls.length, 1, 'no second request while the first is in flight');
    assert.equal(poller.isInFlight(), true);

    fetch.state.resolve([{ id: 'req-1' }]);
    await flush();
    assert.equal(events.data.length, 1);
    assert.equal(scheduler.nextDelay(), 4000);
    poller.stop();
  });
});

test('failure handling and backoff', async (t) => {
  await t.test('consecutive failures back off 4s, 8s, 16s, 30s and stay capped', async () => {
    const { poller, scheduler, fetch, events } = harness();
    fetch.state.mode = 'fail';
    poller.start();
    await flush();

    const observed = [];
    assert.equal(poller.getState().status, POLL_STATUS.reconnecting);
    observed.push(scheduler.nextDelay());

    await scheduler.advance(3999);
    assert.equal(fetch.calls.length, 1, 'must not retry before the backoff elapses');
    await scheduler.advance(1);
    assert.equal(fetch.calls.length, 2);
    observed.push(scheduler.nextDelay());

    await scheduler.advance(8000);
    observed.push(scheduler.nextDelay());
    await scheduler.advance(16000);
    observed.push(scheduler.nextDelay());
    await scheduler.advance(30000);
    observed.push(scheduler.nextDelay());

    assert.deepEqual(observed, [4000, 8000, 16000, 30000, 30000]);
    assert.equal(fetch.calls.length, 5);
    assert.equal(events.errors.length, 5);
    assert.deepEqual(
      events.errors.map((entry) => entry.consecutiveFailures),
      [1, 2, 3, 4, 5],
    );
    poller.stop();
  });

  await t.test('a successful cycle clears the backoff and restores the normal interval', async () => {
    const { poller, scheduler, fetch, events } = harness();
    fetch.state.mode = 'fail';
    poller.start();
    await flush();
    await scheduler.advance(4000);
    assert.equal(poller.getState().consecutiveFailures, 2);
    assert.equal(scheduler.nextDelay(), 8000);

    fetch.state.mode = 'ok';
    await scheduler.advance(8000);
    assert.equal(poller.getState().consecutiveFailures, 0);
    assert.equal(poller.getState().status, POLL_STATUS.live);
    assert.equal(events.data.length, 1);
    assert.equal(scheduler.nextDelay(), 4000);
    poller.stop();
  });

  await t.test('a synchronous throw from the fetch function is a failure, not a crash', async () => {
    const scheduler = createScheduler();
    const errors = [];
    const poller = createPoller({
      fetchFn: () => {
        throw new Error('boom');
      },
      scheduler,
      onError: (error, meta) => errors.push({ message: error.message, failures: meta.consecutiveFailures }),
    });
    poller.start();
    await flush();
    assert.deepEqual(errors, [{ message: 'boom', failures: 1 }]);
    assert.equal(poller.getState().status, POLL_STATUS.reconnecting);
    poller.stop();
  });
});

test('session and lifecycle transitions', async (t) => {
  await t.test('a 401 stops the loop and routes to the session-expiry handler', async () => {
    const { poller, scheduler, fetch, events } = harness();
    fetch.state.mode = 'unauthorized';
    poller.start();
    await flush();
    assert.equal(events.unauthorized, 1);
    assert.equal(poller.isRunning(), false);
    assert.equal(poller.getState().status, POLL_STATUS.unauthorized);
    assert.equal(scheduler.pending(), 0);
    await scheduler.advance(120000);
    assert.equal(fetch.calls.length, 1, 'must not keep polling with a dead token');
  });

  await t.test('stop() aborts the in-flight request and reports stopped', async () => {
    const { poller, fetch, events } = harness();
    fetch.state.mode = 'deferred';
    poller.start();
    await flush();
    poller.stop();
    await flush();
    assert.equal(fetch.state.signals[0].aborted, true);
    assert.equal(events.errors.length, 0, 'cancellation must not be reported as a failure');
    assert.equal(events.data.length, 0);
    assert.equal(poller.getState().status, POLL_STATUS.stopped);
  });

  await t.test('a response that arrives after stop() is discarded', async () => {
    const { poller, fetch, events } = harness();
    fetch.state.mode = 'ignore-abort';
    poller.start();
    await flush();
    poller.stop();
    fetch.state.resolve([{ id: 'late' }]);
    await flush();
    assert.equal(events.data.length, 0);
    assert.equal(poller.getState().lastSuccessAt, 0);
  });

  await t.test('a hidden tab pauses polling and resumes with an immediate refresh', async () => {
    const { poller, scheduler, fetch, events } = harness();
    poller.start();
    await flush();
    assert.equal(fetch.calls.length, 1);

    poller.setVisible(false);
    assert.equal(poller.getState().status, POLL_STATUS.paused);
    assert.equal(scheduler.pending(), 0, 'no timers while the tab is hidden');
    await scheduler.advance(300000);
    assert.equal(fetch.calls.length, 1);

    poller.setVisible(true);
    await flush();
    assert.equal(fetch.calls.length, 2, 'resume refreshes immediately instead of waiting');
    assert.equal(poller.getState().status, POLL_STATUS.live);
    assert.equal(events.data.length, 2);
    poller.stop();
  });

  await t.test('offline suspends polling; reconnect clears the backoff and retries at once', async () => {
    const { poller, scheduler, fetch } = harness();
    fetch.state.mode = 'fail';
    poller.start();
    await flush();
    await scheduler.advance(4000);
    assert.equal(poller.getState().consecutiveFailures, 2);

    poller.setOnline(false);
    assert.equal(poller.getState().status, POLL_STATUS.offline);
    assert.equal(scheduler.pending(), 0);
    await scheduler.advance(120000);
    assert.equal(fetch.calls.length, 2);

    poller.setOnline(true);
    await flush();
    assert.equal(fetch.calls.length, 3, 'reconnect retries immediately');
    assert.equal(poller.getState().consecutiveFailures, 1, 'backoff budget resets on a fresh connection');
    assert.equal(scheduler.nextDelay(), 4000);
    poller.stop();
  });

  await t.test('refreshNow is refused during a request and honoured when idle', async () => {
    const { poller, fetch } = harness();
    fetch.state.mode = 'deferred';
    poller.start();
    await flush();
    assert.equal(poller.refreshNow(), false);
    fetch.state.resolve([]);
    await flush();
    assert.equal(poller.refreshNow(), true);
    await flush();
    assert.equal(fetch.calls.length, 2);
    poller.stop();
  });

  await t.test('status callbacks are deduplicated so the UI is not re-rendered needlessly', async () => {
    const { poller, scheduler, events, fetch } = harness();
    poller.start();
    await flush();
    await scheduler.advance(4000); // cycle 2
    await scheduler.advance(4000); // cycle 3
    assert.equal(fetch.calls.length, 3);

    // No two consecutive notifications may describe an identical state, otherwise a
    // steady 4s poll would re-render the dashboard forever.
    for (let index = 1; index < events.states.length; index += 1) {
      assert.notDeepEqual(events.states[index], events.states[index - 1]);
    }
    // ...and three successful cycles may not produce a notification storm.
    assert.ok(events.states.length <= 10, `unexpected notification volume: ${events.states.length}`);
    assert.ok(events.statuses.includes(POLL_STATUS.live));
    poller.stop();
  });
});

test('connection copy covers every state', () => {
  const now = 100000;
  for (const status of Object.values(POLL_STATUS)) {
    const copy = connectionCopy(status, { lastSuccessAt: now - 4000, now });
    assert.ok(copy.title, `missing title for ${status}`);
    assert.ok(copy.detail, `missing detail for ${status}`);
    assert.ok(['green', 'amber', 'red', 'blue', 'gray'].includes(copy.tone), `bad tone for ${status}`);
  }
  assert.match(connectionCopy(POLL_STATUS.reconnecting, { lastSuccessAt: now - 9000, now }).detail, /Retrying automatically/);
  assert.match(connectionCopy(POLL_STATUS.live, { lastSuccessAt: now - 500, now }).detail, /updated just now/);
});
