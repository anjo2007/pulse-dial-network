import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/lib/api.js';
import {
  DEFAULT_COALESCE_MS,
  SYNC_STATUS,
  classifySyncFailure,
  createRealtimeInvalidator,
  parseSyncConfig,
  realtimeDetail,
  realtimeLabel,
} from '../src/lib/sync.js';

/** Deterministic virtual clock - identical approach to the poller tests. */
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
        await Promise.resolve();
      }
      time = target;
      await Promise.resolve();
    },
  };
}

/** A stand-in for the supabase client. Nothing here touches a network. */
function createMockSupabase({ subscribeState = 'SUBSCRIBED', throwOnCreate, throwOnSetAuth, throwOnChannel } = {}) {
  const calls = { createClient: [], setAuth: [], channel: [], on: [], subscribe: 0, removeChannel: [], unsubscribe: 0 };
  const channel = {
    on(event, filter, handler) {
      calls.on.push({ event, filter, handler });
      return channel;
    },
    subscribe(callback) {
      calls.subscribe += 1;
      if (subscribeState) callback?.(subscribeState, null);
      return channel;
    },
    unsubscribe() {
      calls.unsubscribe += 1;
      return Promise.resolve('ok');
    },
  };
  const client = {
    realtime: {
      async setAuth(token) {
        if (throwOnSetAuth) throw new Error('auth failed');
        calls.setAuth.push(token);
      },
    },
    channel(topic, options) {
      if (throwOnChannel) throw new Error('channel failed');
      calls.channel.push({ topic, options });
      return channel;
    },
    removeChannel(target) {
      calls.removeChannel.push(target);
      return Promise.resolve('ok');
    },
  };
  const createClient = (url, key, options) => {
    if (throwOnCreate) throw new Error('client failed');
    calls.createClient.push({ url, key, options });
    return client;
  };
  return { createClient, calls, channel, client };
}

const CONFIG = {
  enabled: true,
  url: 'https://project.supabase.co',
  publishableKey: 'publishable-key',
  accessToken: 'realtime-access-token',
  topic: 'pulse-dispatch:hospital-central',
};

function harness(overrides = {}) {
  const scheduler = createScheduler();
  const mock = createMockSupabase(overrides.mock);
  const events = { invalidations: [], statuses: [] };
  const invalidator = createRealtimeInvalidator({
    // `'createClient' in overrides` lets a test explicitly pass null (dependency absent).
    createClient: 'createClient' in overrides ? overrides.createClient : mock.createClient,
    scheduler,
    onInvalidate: (meta) => events.invalidations.push(meta),
    onStatus: (status) => events.statuses.push(status),
    coalesceMs: overrides.coalesceMs ?? DEFAULT_COALESCE_MS,
  });
  return { invalidator, scheduler, mock, events };
}

test('sync config parsing is fail-safe', async (t) => {
  await t.test('a demo response disables realtime', () => {
    for (const payload of [{ enabled: false }, {}, null, undefined, 'nope', [], 42]) {
      const config = parseSyncConfig(payload);
      assert.equal(config.enabled, false);
      assert.equal(config.topic, '');
      assert.equal(config.accessToken, '');
    }
  });

  await t.test('a complete response enables realtime and is trimmed', () => {
    const config = parseSyncConfig({
      url: '  https://project.supabase.co ',
      publishableKey: ' publishable-key ',
      accessToken: ' token ',
      topic: ' hospital ',
    });
    assert.deepEqual(config, {
      enabled: true,
      url: 'https://project.supabase.co',
      publishableKey: 'publishable-key',
      accessToken: 'token',
      topic: 'hospital',
    });
  });

  await t.test('a partially configured response is treated as disabled, not half-built', () => {
    for (const field of ['url', 'publishableKey', 'accessToken', 'topic']) {
      const config = parseSyncConfig({ ...CONFIG, [field]: '' });
      assert.equal(config.enabled, false, `missing ${field} must disable realtime`);
    }
    assert.equal(parseSyncConfig({ ...CONFIG, accessToken: 12345 }).enabled, false);
  });
});

test('client construction and subscription', async (t) => {
  await t.test('the client is created without persistence and the channel is private', async () => {
    const { invalidator, mock } = harness();
    await invalidator.connect(CONFIG);

    assert.equal(mock.calls.createClient.length, 1);
    const [{ url, key, options }] = mock.calls.createClient;
    assert.equal(url, CONFIG.url);
    assert.equal(key, CONFIG.publishableKey);
    assert.equal(options.auth.persistSession, false);
    assert.equal(options.auth.autoRefreshToken, false);

    assert.deepEqual(mock.calls.setAuth, [CONFIG.accessToken]);
    assert.equal(mock.calls.channel.length, 1);
    assert.equal(mock.calls.channel[0].topic, CONFIG.topic);
    assert.deepEqual(mock.calls.channel[0].options, { config: { private: true } });
    assert.equal(mock.calls.subscribe, 1);
    assert.deepEqual(mock.calls.on[0].event, 'broadcast');
    assert.deepEqual(mock.calls.on[0].filter, { event: 'changed' });
    assert.equal(typeof mock.calls.on[0].handler, 'function');
    assert.equal(invalidator.getState().status, SYNC_STATUS.subscribed);
    assert.equal(invalidator.getState().hasChannel, true);
  });

  await t.test('a disabled config never constructs a client', async () => {
    const { invalidator, mock } = harness();
    await invalidator.connect({ enabled: false });
    assert.equal(mock.calls.createClient.length, 0);
    assert.equal(invalidator.getState().status, SYNC_STATUS.disabled);
  });

  await t.test('a missing supabase dependency degrades to polling without throwing', async () => {
    const { invalidator, events } = harness({ createClient: null });
    await assert.doesNotReject(() => invalidator.connect({ ...CONFIG, enabled: true }));
    assert.equal(invalidator.getState().status, SYNC_STATUS.disabled);
    assert.equal(events.invalidations.length, 0);
  });

  await t.test('client / auth / channel failures are caught and reported as degraded', async () => {
    for (const failure of [{ throwOnCreate: true }, { throwOnSetAuth: true }, { throwOnChannel: true }]) {
      const { invalidator, events } = harness({ mock: failure });
      await assert.doesNotReject(() => invalidator.connect(CONFIG));
      assert.equal(invalidator.getState().status, SYNC_STATUS.error);
      assert.equal(invalidator.getState().hasChannel, false);
      assert.equal(events.invalidations.length, 0);
    }
  });

  await t.test('a channel error or close after subscribing is reflected in the status', async () => {
    const { invalidator, mock } = harness({ mock: { subscribeState: 'CHANNEL_ERROR' } });
    await invalidator.connect(CONFIG);
    assert.equal(invalidator.getState().status, SYNC_STATUS.error);
    assert.equal(mock.calls.createClient.length, 1);
  });
});

test('signals invalidate, never carry data', async (t) => {
  await t.test('a broadcast event triggers exactly one refresh request', async () => {
    const { invalidator, mock, events } = harness();
    await invalidator.connect(CONFIG);
    const handler = mock.calls.on[0].handler;

    handler({ event: 'changed', payload: { donorName: 'Asha Menon', phone: '+919000000001' } });

    assert.deepEqual(events.invalidations, [{ source: 'broadcast' }]);
    // The consumer must not receive the broadcast body: a signal is an invalidation only.
    assert.equal(JSON.stringify(events.invalidations).includes('Asha'), false);
    assert.equal(JSON.stringify(events.invalidations).includes('919000000001'), false);
  });

  await t.test('signals before subscription are ignored', async () => {
    const { invalidator, events } = harness();
    invalidator.signal('broadcast');
    assert.equal(events.invalidations.length, 0);
  });

  await t.test('a signal storm is coalesced into a single trailing refresh', async () => {
    const { invalidator, mock, scheduler, events } = harness();
    await invalidator.connect(CONFIG);
    const handler = mock.calls.on[0].handler;

    handler(); // forwarded immediately
    handler();
    handler();
    handler();
    assert.equal(events.invalidations.length, 1, 'bursts inside the window must not fetch-storm');
    assert.equal(invalidator.getState().hasTrailingRefresh, true);

    await scheduler.advance(DEFAULT_COALESCE_MS);
    assert.deepEqual(events.invalidations, [{ source: 'broadcast' }, { source: 'coalesced' }]);

    // A later signal outside the window is forwarded immediately again.
    await scheduler.advance(DEFAULT_COALESCE_MS);
    handler();
    assert.equal(events.invalidations.length, 3);
    assert.equal(events.invalidations.at(-1).source, 'broadcast');
  });
});

test('teardown on sign-out / unmount', async (t) => {
  await t.test('disconnect removes the channel, resets realtime auth and clears timers', async () => {
    const { invalidator, mock, scheduler, events } = harness();
    await invalidator.connect(CONFIG);
    const handler = mock.calls.on[0].handler;
    handler();
    handler(); // queues a trailing refresh
    assert.equal(scheduler.pending(), 1);

    invalidator.disconnect();

    assert.equal(mock.calls.removeChannel.length, 1);
    assert.equal(mock.calls.removeChannel[0], mock.channel);
    assert.deepEqual(mock.calls.setAuth, [CONFIG.accessToken, null], 'realtime auth must be reset on teardown');
    assert.equal(scheduler.pending(), 0, 'no refresh may fire after logout');
    assert.equal(invalidator.getState().status, SYNC_STATUS.closed);
    assert.equal(invalidator.getState().hasChannel, false);
    assert.equal(invalidator.getState().hasClient, false);
    assert.equal(events.invalidations.length, 1, 'the queued trailing refresh is cancelled');
  });

  await t.test('disconnect is idempotent and safe on a never-connected invalidator', () => {
    const { invalidator, mock } = harness();
    assert.doesNotThrow(() => invalidator.disconnect());
    assert.doesNotThrow(() => invalidator.disconnect());
    assert.equal(mock.calls.removeChannel.length, 0);
    assert.equal(invalidator.getState().status, SYNC_STATUS.disabled);
  });

  await t.test('reconnecting does not leak the previous channel', async () => {
    const { invalidator, mock } = harness();
    await invalidator.connect(CONFIG);
    await invalidator.connect(CONFIG);
    assert.equal(mock.calls.removeChannel.length, 1, 'the first channel is torn down before the second is opened');
    assert.equal(mock.calls.createClient.length, 2);
    assert.equal(invalidator.getState().hasChannel, true);
  });

  await t.test('signals after disconnect are ignored', async () => {
    const { invalidator, mock, events } = harness();
    await invalidator.connect(CONFIG);
    const handler = mock.calls.on[0].handler;
    invalidator.disconnect();
    handler();
    assert.equal(events.invalidations.length, 0);
  });
});

test('an expired sync token degrades to polling and never signs the user out', () => {
  const unauthorized = classifySyncFailure(new ApiError('Your session has expired. Please sign in again.', { code: 'unauthorized', status: 401 }));
  assert.equal(unauthorized.mode, 'polling');
  assert.equal(unauthorized.reason, 'unauthorized');
  assert.match(unauthorized.message, /polling continues/i);
  assert.match(unauthorized.message, /sign in again/i);

  const offline = classifySyncFailure(new ApiError('Cannot reach the dispatch service.', { code: 'network', retryable: true }));
  assert.equal(offline.mode, 'polling');
  assert.equal(offline.reason, 'offline');

  const server = classifySyncFailure(new ApiError('Boom', { code: 'server', status: 500 }));
  assert.equal(server.mode, 'polling');

  for (const failure of [unauthorized, offline, server]) {
    assert.notEqual(failure.mode, 'signout');
    assert.notEqual(failure.mode, 'fatal');
  }
});

test('transport labels stay honest about what is actually running', () => {
  assert.equal(realtimeLabel(SYNC_STATUS.subscribed), 'Realtime');
  assert.equal(realtimeLabel(SYNC_STATUS.connecting), 'Connecting');
  for (const status of [SYNC_STATUS.disabled, SYNC_STATUS.error, SYNC_STATUS.closed]) {
    assert.equal(realtimeLabel(status), 'Polling', `${status} must advertise polling, not realtime`);
  }
  assert.match(realtimeDetail(SYNC_STATUS.subscribed), /polling as a safety net/i);
  assert.match(realtimeDetail(SYNC_STATUS.disabled), /polling the dispatch feed/i);
});
