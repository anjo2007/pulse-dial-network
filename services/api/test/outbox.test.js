import test from 'node:test';
import assert from 'node:assert/strict';
import { baseConfig, DEMO_DONOR_PHONE, loginDonor, startApi } from './helpers.js';
import { enqueueDispatchNotifications } from '../src/outbox.js';

const DEVICE = {
  installationId: 'install-outbox-0001',
  expoPushToken: 'ExponentPushToken[outboxoutboxoutboxoutbox]',
  platform: 'android',
};

// Values that must never appear on a lockscreen notification. "hospital" is intentionally excluded:
// the generic word is part of the safe copy, the hospital's *identity* is not.
const PII = ['Asha', 'Menon', 'O-', DEMO_DONOR_PHONE, 'Central City', 'Central City Medical Centre'];

function ticketResponse() {
  return { ok: true, status: 200, json: async () => ({ data: { status: 'ok', id: 'ticket-1' } }) };
}

function recordingFetch(impl) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options, body: options?.body ? JSON.parse(options.body) : null });
    return impl ? impl(url, options) : ticketResponse();
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

async function registerDevice(h, token) {
  const response = await h.request('/donor/devices', { method: 'POST', token, body: DEVICE });
  assert.equal(response.status, 201);
  return response;
}

async function dispatchORequest(h, token, unitsNeeded = 2) {
  const response = await h.request('/hospital/requests', { method: 'POST', token, body: { bloodType: 'O-', unitsNeeded } });
  assert.equal(response.status, 201);
  return response.body;
}

test('durable notification outbox', async (t) => {
  await t.test('a dispatch with no registered device queues nothing', async () => {
    const h = await startApi();
    try {
      const token = (await h.loginHospital()).body.token;
      await dispatchORequest(h, token);
      const state = await h.state();
      assert.equal(state.outbox.length, 0, 'no device means no delivery work');
      assert.ok(state.assignments.length > 0, 'the assignment is still created');
    } finally {
      await h.close();
    }
  });

  await t.test('a registered device gets one privacy-safe queued push per assignment', async () => {
    const h = await startApi();
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      const donor = (await loginDonor(h, DEMO_DONOR_PHONE)).body;
      await registerDevice(h, donor.token);
      const request = await dispatchORequest(h, hospitalToken);

      const state = await h.state();
      assert.equal(state.outbox.length, 1);
      const item = state.outbox[0];
      assert.equal(item.status, 'PENDING');
      assert.equal(item.channel, 'expo');
      assert.equal(item.template, 'DISPATCH_PING');
      assert.equal(item.channelId, 'emergency-blood-alerts');
      assert.equal(item.recipient, DEVICE.expoPushToken);
      assert.equal(item.assignmentId, request.assignments[0].id);
      assert.deepEqual(Object.keys(item.data).sort(), ['assignmentId', 'type']);

      // Lockscreen privacy: nothing that identifies the donor, the blood type or the hospital.
      const lockscreen = JSON.stringify({ title: item.title, body: item.body, data: item.data });
      for (const value of PII) {
        assert.equal(lockscreen.includes(value), false, `push payload must not include "${value}"`);
      }
    } finally {
      await h.close();
    }
  });

  await t.test('the outbox de-duplicates by assignment and installation', async () => {
    const h = await startApi();
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      const donor = (await loginDonor(h, DEMO_DONOR_PHONE)).body;
      await registerDevice(h, donor.token);
      const request = await dispatchORequest(h, hospitalToken);

      await h.store.mutate(state => {
        const assignment = state.assignments.find(item => item.requestId === request.id);
        const persisted = state.requests.find(item => item.id === request.id);
        enqueueDispatchNotifications({ state, assignment, request: persisted, config: h.config });
        enqueueDispatchNotifications({ state, assignment, request: persisted, config: h.config });
        return true;
      });

      assert.equal((await h.state()).outbox.length, 1, 'a re-dispatch must not double-notify the same device');
    } finally {
      await h.close();
    }
  });

  await t.test('the worker delivers through the Expo endpoint on the emergency channel', async () => {
    const fetchImpl = recordingFetch();
    const h = await startApi({ fetchImpl });
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      const donor = (await loginDonor(h, DEMO_DONOR_PHONE)).body;
      await registerDevice(h, donor.token);
      const request = await dispatchORequest(h, hospitalToken);

      const summary = await h.api.runDispatchTick();
      assert.equal(summary.outboxClaimed, 1);
      assert.equal(summary.outboxAccepted, 1, 'the provider issued a ticket');
      assert.equal(summary.receiptsChecked, 0, 'no receipt is expected yet');

      assert.equal(fetchImpl.calls.length, 1);
      const call = fetchImpl.calls[0];
      assert.equal(call.url, h.config.expo.endpoint);
      assert.equal(call.options.method, 'POST');
      assert.equal(call.body.to, DEVICE.expoPushToken);
      assert.equal(call.body.channelId, 'emergency-blood-alerts');
      assert.equal(call.body.priority, 'high');
      assert.deepEqual(Object.keys(call.body.data).sort(), ['assignmentId', 'type']);
      assert.equal(call.body.data.assignmentId, request.assignments[0].id);
      for (const value of PII) {
        assert.equal(JSON.stringify(call.body).includes(value), false, `push payload must not include "${value}"`);
      }

      const item = (await h.state()).outbox[0];
      // ACCEPTED_BY_PROVIDER, deliberately not "SENT": a ticket is not a delivery.
      assert.equal(item.status, 'ACCEPTED_BY_PROVIDER');
      assert.ok(item.acceptedAt);
      assert.equal(item.ticketId, 'ticket-1');
      assert.equal(item.receiptStatus, 'pending');
      assert.equal(item.attempts, 1);
      assert.equal(item.leaseUntil, null);
      assert.equal(item.leaseId, null, 'the lease is released at settle');
    } finally {
      await h.close();
    }
  });

  await t.test('a dry-run sender never touches the network', async () => {
    let called = false;
    const h = await startApi({ fetchImpl: async () => { called = true; return ticketResponse(); }, dryRunPush: true });
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      const donor = (await loginDonor(h, DEMO_DONOR_PHONE)).body;
      await registerDevice(h, donor.token);
      await dispatchORequest(h, hospitalToken);

      const summary = await h.api.runDispatchTick();
      assert.equal(summary.outboxAccepted, 1);
      assert.equal(called, false, 'dry-run must not perform network I/O');
      assert.equal((await h.state()).outbox[0].status, 'ACCEPTED_BY_PROVIDER');
    } finally {
      await h.close();
    }
  });

  await t.test('failed deliveries back off, retry and eventually dead-letter', async () => {
    const failing = recordingFetch(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const config = baseConfig({ outboxMaxAttempts: 2, outboxBackoffMs: 60000 });
    const h = await startApi({ config, fetchImpl: failing });
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      const donor = (await loginDonor(h, DEMO_DONOR_PHONE)).body;
      await registerDevice(h, donor.token);
      await dispatchORequest(h, hospitalToken);

      const first = await h.api.runDispatchTick();
      assert.equal(first.outboxFailed, 0);
      let item = (await h.state()).outbox[0];
      assert.equal(item.status, 'PENDING', 'a transient failure stays queued');
      assert.equal(item.attempts, 1);
      assert.ok(new Date(item.nextAttemptAt).getTime() > Date.now(), 'retry is scheduled in the future');
      assert.ok(item.lastError);

      // Not due yet: the worker must not hammer the provider.
      await h.api.runDispatchTick();
      assert.equal((await h.state()).outbox[0].attempts, 1);
      assert.equal(failing.calls.length, 1);

      // Force the retry to become due, then exhaust the attempt budget.
      await h.store.mutate(state => {
        state.outbox[0].nextAttemptAt = new Date(Date.now() - 1000).toISOString();
        return true;
      });
      const second = await h.api.runDispatchTick();
      assert.equal(second.outboxFailed, 1);
      item = (await h.state()).outbox[0];
      assert.equal(item.status, 'FAILED', 'attempts are bounded, so the item is dead-lettered');
      assert.equal(item.attempts, 2);
      assert.ok(item.failedAt);
    } finally {
      await h.close();
    }
  });

  await t.test('provider errors are recorded without leaking provider internals to donors', async () => {
    const hostile = recordingFetch(async () => ({ ok: true, status: 200, json: async () => ({ data: { status: 'error', message: 'DeviceNotRegistered', details: { error: 'DeviceNotRegistered' } } }) }));
    const config = baseConfig({ outboxMaxAttempts: 1 });
    const h = await startApi({ config, fetchImpl: hostile });
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      const donor = (await loginDonor(h, DEMO_DONOR_PHONE)).body;
      await registerDevice(h, donor.token);
      await dispatchORequest(h, hospitalToken);

      const summary = await h.api.runDispatchTick();
      assert.equal(summary.outboxFailed, 1);
      const item = (await h.state()).outbox[0];
      assert.equal(item.status, 'FAILED');
      assert.equal(JSON.stringify(item.lastError).includes('DeviceNotRegistered'), true, 'server-side diagnostics keep the provider reason');
      const donorAlerts = await h.request('/donor/alerts', { token: donor.token });
      assert.equal(JSON.stringify(donorAlerts.body).includes('DeviceNotRegistered'), false, 'donor-facing payloads stay clean');
    } finally {
      await h.close();
    }
  });

  await t.test('withdrawing a request cancels its queued notifications', async () => {
    const fetchImpl = recordingFetch();
    const h = await startApi({ fetchImpl });
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      const donor = (await loginDonor(h, DEMO_DONOR_PHONE)).body;
      await registerDevice(h, donor.token);
      const request = await dispatchORequest(h, hospitalToken);

      const cancelled = await h.request(`/hospital/requests/${request.id}/cancel`, { method: 'POST', token: hospitalToken });
      assert.equal(cancelled.status, 200);

      const state = await h.state();
      assert.equal(state.outbox[0].status, 'CANCELLED');
      assert.equal(state.assignments.every(assignment => assignment.status === 'CANCELLED'), true);

      const summary = await h.api.runDispatchTick();
      assert.equal(summary.outboxClaimed, 0, 'cancelled notifications are never leased again');
      assert.equal(fetchImpl.calls.length, 0, 'a withdrawn request sends nothing');
    } finally {
      await h.close();
    }
  });

  await t.test('removing a device cancels its queued notifications', async () => {
    const fetchImpl = recordingFetch();
    const h = await startApi({ fetchImpl });
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      const donor = (await loginDonor(h, DEMO_DONOR_PHONE)).body;
      await registerDevice(h, donor.token);
      await dispatchORequest(h, hospitalToken);

      assert.equal((await h.request(`/donor/devices/${DEVICE.installationId}`, { method: 'DELETE', token: donor.token })).status, 200);
      assert.equal((await h.state()).outbox[0].status, 'CANCELLED');

      await h.api.runDispatchTick();
      assert.equal(fetchImpl.calls.length, 0);
    } finally {
      await h.close();
    }
  });

  await t.test('a hospital can close a request and expired requests stop dispatching', async () => {
    const fetchImpl = recordingFetch();
    const config = baseConfig({ requestTtlMs: 1 });
    const h = await startApi({ config, fetchImpl });
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      const donor = (await loginDonor(h, DEMO_DONOR_PHONE)).body;
      await registerDevice(h, donor.token);
      const request = await dispatchORequest(h, hospitalToken);

      await new Promise(resolve => setTimeout(resolve, 10));
      const summary = await h.api.runDispatchTick();
      assert.equal(summary.expired, 1);

      const state = await h.state();
      const stored = state.requests.find(item => item.id === request.id);
      assert.equal(stored.status, 'EXPIRED');
      assert.ok(stored.expiredAt);
      assert.equal(state.assignments.every(assignment => assignment.status !== 'PINGED'), true);
      assert.equal(state.outbox[0].status, 'CANCELLED');
      assert.equal(fetchImpl.calls.length, 0);
    } finally {
      await h.close();
    }
  });

  await t.test('an unaccepted request is escalated automatically once the SLA lapses', async () => {
    const config = baseConfig({ escalationSlaMs: 1 });
    const h = await startApi({ config });
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      const request = await dispatchORequest(h, hospitalToken);

      await new Promise(resolve => setTimeout(resolve, 10));
      const first = await h.api.runDispatchTick();
      assert.equal(first.escalated, 1);
      assert.equal((await h.state()).requests.find(item => item.id === request.id).currentRadiusKm, 5);

      await new Promise(resolve => setTimeout(resolve, 10));
      const second = await h.api.runDispatchTick();
      assert.equal(second.escalated, 1);
      assert.equal((await h.state()).requests.find(item => item.id === request.id).currentRadiusKm, 15);

      await new Promise(resolve => setTimeout(resolve, 10));
      const third = await h.api.runDispatchTick();
      assert.equal(third.exhausted, 1);
      assert.equal((await h.state()).requests.find(item => item.id === request.id).status, 'UNFULFILLED');
    } finally {
      await h.close();
    }
  });

  await t.test('a fulfilled request stops pinging and pulls back the remaining alerts', async () => {
    const h = await startApi();
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      const donor = (await loginDonor(h, DEMO_DONOR_PHONE)).body;
      const request = await dispatchORequest(h, hospitalToken, 1);
      const alertId = (await h.request('/donor/alerts', { token: donor.token })).body[0].id;
      const accepted = await h.request(`/donor/assignments/${alertId}/respond`, { method: 'POST', token: donor.token, body: { response: 'ACCEPT' } });

      const checkin = await h.request('/hospital/checkin', { method: 'POST', token: hospitalToken, body: { token: accepted.body.checkinToken } });
      assert.equal(checkin.status, 200);
      assert.equal(checkin.body.request.status, 'FULFILLED');

      const stored = (await h.state()).requests.find(item => item.id === request.id);
      assert.equal(stored.status, 'FULFILLED');
      assert.deepEqual((await h.request('/donor/alerts', { token: donor.token })).body, []);

      const state = await h.state();
      assert.equal(state.assignments.every(assignment => ['COMPLETED', 'CANCELLED', 'DECLINED'].includes(assignment.status)), true);
    } finally {
      await h.close();
    }
  });
});
