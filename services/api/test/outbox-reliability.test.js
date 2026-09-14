import test from 'node:test';
import assert from 'node:assert/strict';
import { baseConfig, DEMO_DONOR_PHONE, loginDonor, startApi } from './helpers.js';
import { OUTBOX_STATUS, cancelOutboxForAssignment, claimDue, outboxStats, settle } from '../src/outbox.js';

const DEVICE_A = { installationId: 'install-rel-a', expoPushToken: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]', platform: 'android' };
const DEVICE_B = { installationId: 'install-rel-b', expoPushToken: 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]', platform: 'ios' };

async function registerDevice(h, token, device) {
  const response = await h.request('/donor/devices', { method: 'POST', token, body: device });
  assert.equal(response.status, 201, JSON.stringify(response.body));
}

async function prepare(h, { requests = 1, devices = [DEVICE_A], unitsNeeded = 2 } = {}) {
  const hospitalToken = (await h.loginHospital()).body.token;
  const donor = (await loginDonor(h, DEMO_DONOR_PHONE)).body;
  for (const device of devices) await registerDevice(h, donor.token, device);
  for (let index = 0; index < requests; index += 1) {
    const created = await h.request('/hospital/requests', { method: 'POST', token: hospitalToken, body: { bloodType: 'O-', unitsNeeded } });
    assert.equal(created.status, 201);
  }
  return { hospitalToken, donorToken: donor.token };
}

test('outbox reliability: bounded work, fenced leases, tickets and receipts', async (t) => {
  await t.test('sends are bounded by batch size and concurrency', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const sender = {
      async send() {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise(resolve => setTimeout(resolve, 40));
        inFlight -= 1;
        return { ok: true, ticketId: `ticket-${Math.random().toString(36).slice(2)}` };
      },
      async getReceipts(ids) {
        return { ok: true, receipts: Object.fromEntries(ids.map(id => [id, { status: 'ok' }])) };
      },
    };
    const h = await startApi({ sender, config: baseConfig({ receiptPollDelayMs: 3600000 }) });
    try {
      await prepare(h, { requests: 5, devices: [DEVICE_A, DEVICE_B] });
      const summary = await h.api.runDispatchTick();

      assert.equal(summary.outboxClaimed, 10, 'five assignments x two installations');
      assert.equal(summary.outboxAccepted, 10);
      assert.ok(maxInFlight <= h.config.workerConcurrency, `in-flight ${maxInFlight} must stay within ${h.config.workerConcurrency}`);
      assert.ok(maxInFlight > 1, 'work is actually parallel');
      const state = await h.state();
      assert.equal(state.outbox.every(item => item.status === OUTBOX_STATUS.ACCEPTED_BY_PROVIDER), true);
      assert.equal(outboxStats(state).delivered, 0, 'the system never claims delivery');
    } finally {
      await h.close();
    }
  });

  await t.test('a worker budget below the lease prevents work from being started', async () => {
    let calls = 0;
    const sender = {
      async send() { calls += 1; return { ok: true, ticketId: 't' }; },
      async getReceipts() { return { ok: true, receipts: {} }; },
    };
    const h = await startApi({ sender, config: baseConfig({ workerBudgetMs: 1 }) });
    try {
      await prepare(h, { requests: 1 });
      const summary = await h.api.runDispatchTick();
      assert.equal(summary.budgetExhausted, true);
      assert.equal(summary.outboxClaimed, 1, 'the item is leased...');
      assert.equal(summary.outboxAccepted, 0);
      assert.equal(calls, 0, '...but no send is started without budget');
      const item = (await h.state()).outbox[0];
      assert.equal(item.status, OUTBOX_STATUS.SENDING, 'the lease is held and recovered later, never silently dropped');
      assert.ok(new Date(item.leaseUntil).getTime() > Date.now(), 'the lease outlives the worker budget');
    } finally {
      await h.close();
    }
  });

  await t.test('a stale lease cannot overwrite a newer lease', async () => {
    const h = await startApi({ sender: { async send() { return { ok: true, ticketId: 'x' }; } } });
    try {
      await prepare(h, { requests: 1 });
      const claimed = await h.store.mutate(state => claimDue(state, { now: Date.now(), limit: 5, leaseMs: 1000, leaseId: 'lease-old' }));
      assert.equal(claimed.length, 1);

      // A second worker takes the lease over (as it would after a timeout).
      await h.store.mutate(state => {
        const item = state.outbox.find(entry => entry.id === claimed[0].id);
        item.leaseId = 'lease-new';
        item.leaseUntil = new Date(Date.now() + 5000).toISOString();
        return true;
      });

      const applied = await h.store.mutate(state => settle(state, [{ id: claimed[0].id, leaseId: 'lease-old', ok: true, ticketId: 'ticket-stale' }], { now: Date.now() }));
      assert.equal(applied.fenced, 1);
      assert.equal(applied.accepted, 0);

      const item = (await h.state()).outbox.find(entry => entry.id === claimed[0].id);
      assert.equal(item.status, OUTBOX_STATUS.SENDING);
      assert.equal(item.leaseId, 'lease-new');
      assert.equal(item.ticketId, null, 'a stale acceptance is discarded');
    } finally {
      await h.close();
    }
  });

  await t.test('a cancellation that races the send is never overwritten by the acceptance', async () => {
    const h = await startApi({
      sender: {
        async send(notification) {
          // The hospital withdraws the request while the HTTP call is in flight.
          await h.store.mutate(state => cancelOutboxForAssignment(state, notification.assignmentId, 'withdrawn during send'));
          return { ok: true, ticketId: 'ticket-race' };
        },
      },
    });
    try {
      await prepare(h, { requests: 1 });
      const summary = await h.api.runDispatchTick();
      assert.equal(summary.outboxAccepted, 0);
      assert.equal(summary.outboxFenced, 1, 'the acceptance is rejected by the fence');
      const item = (await h.state()).outbox[0];
      assert.equal(item.status, OUTBOX_STATUS.CANCELLED);
      assert.equal(item.ticketId, null);
    } finally {
      await h.close();
    }
  });

  await t.test('an already-cancelled notification is never even claimed', async () => {
    const h = await startApi({ sender: { async send() { return { ok: true, ticketId: 't' }; } } });
    try {
      await prepare(h, { requests: 1 });
      await h.store.mutate(state => cancelOutboxForAssignment(state, state.outbox[0].assignmentId, 'withdrawn'));
      const summary = await h.api.runDispatchTick();
      assert.equal(summary.outboxClaimed, 0);
      assert.equal((await h.state()).outbox[0].status, OUTBOX_STATUS.CANCELLED);
    } finally {
      await h.close();
    }
  });

  await t.test('a malformed 200 is retried, never accepted', async () => {
    const bodies = [];
    const responses = [
      { ok: true, status: 200, json: async () => ({ data: {} }) },
      { ok: true, status: 200, json: async () => ({ data: { status: 'ok' } }) },
      { ok: true, status: 200, json: async () => ({ data: [{ status: 'ok', id: 'ticket-array' }] }) },
    ];
    let index = 0;
    const h = await startApi({
      fetchImpl: async (url, options) => {
        bodies.push({ url, body: JSON.parse(options.body) });
        const response = responses[Math.min(index, responses.length - 1)];
        index += 1;
        return response;
      },
      config: baseConfig({ outboxBackoffMs: 0, receiptPollDelayMs: 3600000 }),
    });
    try {
      await prepare(h, { requests: 1 });

      let summary = await h.api.runDispatchTick();
      assert.equal(summary.outboxAccepted, 0, 'a 200 without a ticket is not an acceptance');
      assert.equal(summary.outboxRetried, 1);
      assert.equal((await h.state()).outbox[0].status, OUTBOX_STATUS.PENDING);

      summary = await h.api.runDispatchTick();
      assert.equal(summary.outboxAccepted, 0, 'a status without an id is not an acceptance');

      summary = await h.api.runDispatchTick();
      assert.equal(summary.outboxAccepted, 1, 'the documented array shape is accepted');
      const item = (await h.state()).outbox[0];
      assert.equal(item.status, OUTBOX_STATUS.ACCEPTED_BY_PROVIDER);
      assert.equal(item.ticketId, 'ticket-array');
      assert.equal(bodies[0].url, h.config.expo.endpoint);
    } finally {
      await h.close();
    }
  });

  await t.test('a permanently invalid device is disabled and its queue withdrawn', async () => {
    const sender = {
      async send(notification) {
        if (notification.recipient === DEVICE_B.expoPushToken) {
          return { ok: false, error: 'Push provider rejected the device (DeviceNotRegistered).', errorCode: 'DeviceNotRegistered', permanent: true };
        }
        return { ok: true, ticketId: 'ticket-ok' };
      },
      async getReceipts() { return { ok: true, receipts: {} }; },
    };
    const h = await startApi({ sender, config: baseConfig({ receiptPollDelayMs: 3600000 }) });
    try {
      await prepare(h, { requests: 2, devices: [DEVICE_A, DEVICE_B] });
      const summary = await h.api.runDispatchTick();

      assert.equal(summary.outboxClaimed, 4);
      assert.equal(summary.outboxAccepted, 2, 'the healthy device still gets its tickets');
      assert.equal(summary.outboxDeviceDisabled, 1);
      assert.equal(summary.outboxQueueCancelled, 1, 'the dead installation stops being retried');

      const state = await h.state();
      const deviceB = state.devices.find(device => device.installationId === DEVICE_B.installationId);
      assert.equal(deviceB.active, false);
      assert.match(deviceB.disabledReason, /DeviceNotRegistered/);

      const forB = state.outbox.filter(item => item.recipient === DEVICE_B.expoPushToken);
      assert.equal(forB.some(item => item.status === OUTBOX_STATUS.FAILED), true);
      assert.equal(forB.every(item => item.status === OUTBOX_STATUS.FAILED || item.status === OUTBOX_STATUS.CANCELLED), true);

      // The disabled device receives nothing on later dispatches either.
      const hospitalToken = (await h.loginHospital()).body.token;
      await h.request('/hospital/requests', { method: 'POST', token: hospitalToken, body: { bloodType: 'O-', unitsNeeded: 2 } });
      const after = await h.state();
      assert.equal(after.outbox.filter(item => item.recipient === DEVICE_B.expoPushToken && item.status === OUTBOX_STATUS.PENDING).length, 0);
    } finally {
      await h.close();
    }
  });

  await t.test('provider acceptance is confirmed by a receipt, never assumed', async () => {
    const sender = {
      async send() { return { ok: true, ticketId: 'ticket-receipt-1' }; },
      async getReceipts(ids) {
        assert.deepEqual(ids, ['ticket-receipt-1']);
        return { ok: true, receipts: { 'ticket-receipt-1': { status: 'ok' } } };
      },
    };
    const h = await startApi({ sender, config: baseConfig({ receiptPollDelayMs: 0 }) });
    try {
      await prepare(h, { requests: 1 });
      const summary = await h.api.runDispatchTick();
      assert.equal(summary.outboxAccepted, 1);
      assert.equal(summary.receiptsChecked, 1);
      assert.equal(summary.receiptsOk, 1);

      const item = (await h.state()).outbox[0];
      assert.equal(item.status, OUTBOX_STATUS.RECEIPT_OK);
      assert.equal(item.receiptStatus, 'ok');
      assert.equal(item.receiptAttempts, 1);
      assert.equal(outboxStats(await h.state()).delivered, 0, 'a receipt is still not proof a human saw it');
    } finally {
      await h.close();
    }
  });

  await t.test('a receipt error is terminal and a dead device is disabled', async () => {
    const sender = {
      async send() { return { ok: true, ticketId: 'ticket-receipt-2' }; },
      async getReceipts() {
        return { ok: true, receipts: { 'ticket-receipt-2': { status: 'error', errorCode: 'DeviceNotRegistered' } } };
      },
    };
    const h = await startApi({ sender, config: baseConfig({ receiptPollDelayMs: 0 }) });
    try {
      await prepare(h, { requests: 1 });
      const summary = await h.api.runDispatchTick();
      assert.equal(summary.receiptsFailed, 1);
      assert.equal(summary.outboxDeviceDisabled, 1);

      const state = await h.state();
      assert.equal(state.outbox[0].status, OUTBOX_STATUS.RECEIPT_FAILED);
      assert.equal(state.devices[0].active, false);
    } finally {
      await h.close();
    }
  });

  await t.test('a missing receipt ends as unknown, never as success', async () => {
    const sender = {
      async send() { return { ok: true, ticketId: 'ticket-receipt-3' }; },
      async getReceipts() { return { ok: true, receipts: {} }; },
    };
    const h = await startApi({ sender, config: baseConfig({ receiptPollDelayMs: 0, receiptPollMaxAgeMs: 0 }) });
    try {
      await prepare(h, { requests: 1 });
      const summary = await h.api.runDispatchTick();
      assert.equal(summary.outboxAccepted, 1);
      assert.equal(summary.receiptsUnknown, 1);
      const item = (await h.state()).outbox[0];
      assert.equal(item.status, OUTBOX_STATUS.RECEIPT_UNKNOWN);
      assert.equal(item.receiptStatus, 'unknown');
    } finally {
      await h.close();
    }
  });

  await t.test('a receipt endpoint outage leaves accepted items pending, not failed', async () => {
    const sender = {
      async send() { return { ok: true, ticketId: 'ticket-receipt-4' }; },
      async getReceipts() { return { ok: false, error: 'Receipt endpoint responded with 503.' }; },
    };
    const h = await startApi({ sender, config: baseConfig({ receiptPollDelayMs: 0 }) });
    try {
      await prepare(h, { requests: 1 });
      const summary = await h.api.runDispatchTick();
      assert.equal(summary.outboxAccepted, 1);
      assert.equal(summary.receiptsPending, 1);
      assert.equal(summary.receiptsFailed, 0);
      assert.equal(summary.outboxFailed, 0);
      assert.equal((await h.state()).outbox[0].status, OUTBOX_STATUS.ACCEPTED_BY_PROVIDER);
    } finally {
      await h.close();
    }
  });
});
