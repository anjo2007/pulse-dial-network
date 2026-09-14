import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createDeviceRegistry } from '../src/services/deviceRegistration.js';

function createStorage() {
  const map = new Map();
  return {
    getItem: async (key) => (map.has(key) ? map.get(key) : null),
    setItem: async (key, value) => void map.set(key, value),
    removeItem: async (key) => void map.delete(key),
    dump: () => map,
  };
}

const VALID = {
  installationId: 'ins-android-abc',
  expoPushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
  platform: 'android',
};

test('successful registration posts the contract body and clears the outbox', async () => {
  const calls = [];
  const storage = createStorage();
  const registry = createDeviceRegistry({
    storage,
    logger: { warn() {} },
    request: async (method, path, body) => {
      calls.push({ method, path, body });
    },
  });

  const result = await registry.register(VALID);
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].path, '/donor/devices');
  assert.deepEqual(calls[0].body, VALID);
  assert.equal(await registry.inspect(), null);
});

test('transient failures queue the operation for retry', async () => {
  const storage = createStorage();
  let attempts = 0;
  const registry = createDeviceRegistry({
    storage,
    logger: { warn() {} },
    request: async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error('offline');
        error.status = 0;
        throw error;
      }
    },
  });

  const first = await registry.register(VALID);
  assert.equal(first.ok, false);
  assert.equal(first.queued, true);
  assert.equal(first.reason, 'network');

  const queued = await registry.inspect();
  assert.equal(queued.kind, 'register');

  const flushed = await registry.flush();
  assert.equal(flushed.ok, true);
  assert.equal(flushed.flushed, true);
  assert.equal(await registry.inspect(), null);
});

test('permanent rejections are dropped instead of retried forever', async () => {
  const storage = createStorage();
  const registry = createDeviceRegistry({
    storage,
    logger: { warn() {} },
    request: async () => {
      const error = new Error('rejected');
      error.status = 401;
      throw error;
    },
  });

  const result = await registry.register(VALID);
  assert.equal(result.ok, false);
  assert.equal(result.queued, false);
  assert.equal(result.reason, 'rejected');
  assert.equal(await registry.inspect(), null);
});

test('invalid input never reaches the network', async () => {
  let called = false;
  const registry = createDeviceRegistry({
    storage: createStorage(),
    logger: { warn() {} },
    request: async () => {
      called = true;
    },
  });

  const result = await registry.register({ installationId: 'bad id', expoPushToken: null, platform: 'android' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'invalid-installation-id');
  assert.equal(called, false);
});

test('unregister issues a DELETE to the installation-scoped endpoint', async () => {
  const calls = [];
  const registry = createDeviceRegistry({
    storage: createStorage(),
    logger: { warn() {} },
    request: async (method, path) => {
      calls.push({ method, path });
    },
  });

  const result = await registry.unregister({ installationId: 'ins-ios-1' });
  assert.equal(result.ok, true);
  assert.deepEqual(calls, [{ method: 'DELETE', path: '/donor/devices/ins-ios-1' }]);
});

test('failed unregister stays queued and outlives an offline sign-out', async () => {
  const storage = createStorage();
  const registry = createDeviceRegistry({
    storage,
    logger: { warn() {} },
    request: async () => {
      const error = new Error('offline');
      error.status = 0;
      throw error;
    },
  });

  const result = await registry.unregister({ installationId: 'ins-ios-1' });
  assert.equal(result.queued, true);
  const queued = await registry.inspect();
  assert.equal(queued.kind, 'unregister');
  assert.equal(queued.payload.installationId, 'ins-ios-1');
  assert.equal(queued.attempts, 1);
});

test('flush with an empty outbox is a no-op', async () => {
  const registry = createDeviceRegistry({
    storage: createStorage(),
    logger: { warn() {} },
    request: async () => {
      throw new Error('should not be called');
    },
  });
  const result = await registry.flush();
  assert.equal(result.ok, true);
  assert.equal(result.flushed, false);
});
