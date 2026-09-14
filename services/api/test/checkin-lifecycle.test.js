import test from 'node:test';
import assert from 'node:assert/strict';
import { baseConfig, loginDonor, startApi } from './helpers.js';

async function createRequestAndAccept(h, { unitsNeeded = 2 } = {}) {
  const hospitalToken = (await h.loginHospital()).body.token;
  const created = await h.request('/hospital/requests', { method: 'POST', token: hospitalToken, body: { bloodType: 'O-', unitsNeeded } });
  assert.equal(created.status, 201);
  const donor = (await loginDonor(h)).body;
  const alert = (await h.request('/donor/alerts', { token: donor.token })).body[0];
  const accepted = await h.request(`/donor/assignments/${alert.id}/respond`, { method: 'POST', token: donor.token, body: { response: 'ACCEPT' } });
  assert.equal(accepted.status, 200);
  assert.ok(accepted.body.checkinToken);
  return { hospitalToken, donorToken: donor.token, requestId: created.body.id, assignmentId: alert.id, checkinToken: accepted.body.checkinToken };
}

test('arrival tokens are only valid for a live, accepted assignment', async (t) => {
  await t.test('the accepted -> check-in workflow still works', async () => {
    const h = await startApi();
    try {
      const flow = await createRequestAndAccept(h, { unitsNeeded: 1 });
      const checkin = await h.request('/hospital/checkin', { method: 'POST', token: flow.hospitalToken, body: { token: flow.checkinToken } });
      assert.equal(checkin.status, 200);
      assert.equal(checkin.body.assignment.status, 'COMPLETED');
      assert.equal(checkin.body.request.status, 'FULFILLED');
    } finally {
      await h.close();
    }
  });

  await t.test('arriving first also allows check-in', async () => {
    const h = await startApi();
    try {
      const flow = await createRequestAndAccept(h);
      const arrived = await h.request(`/donor/assignments/${flow.assignmentId}/arrive`, { method: 'POST', token: flow.donorToken });
      assert.equal(arrived.status, 200);
      assert.equal(arrived.body.status, 'ARRIVED');
      assert.equal((await h.request('/hospital/checkin', { method: 'POST', token: flow.hospitalToken, body: { token: flow.checkinToken } })).status, 200);
    } finally {
      await h.close();
    }
  });

  await t.test('a withdrawn request cannot be completed with a surviving token', async () => {
    const h = await startApi();
    try {
      const flow = await createRequestAndAccept(h);
      const before = (await h.state()).donors.find(donor => donor.id === 'donor-1');

      const cancelled = await h.request(`/hospital/requests/${flow.requestId}/cancel`, { method: 'POST', token: flow.hospitalToken });
      assert.equal(cancelled.status, 200);

      const state = await h.state();
      const assignment = state.assignments.find(item => item.id === flow.assignmentId);
      assert.equal(assignment.status, 'CANCELLED');
      assert.equal(assignment.checkinToken, null, 'the token is cleared on withdrawal');

      const checkin = await h.request('/hospital/checkin', { method: 'POST', token: flow.hospitalToken, body: { token: flow.checkinToken } });
      assert.equal(checkin.status, 404, 'the withdrawn assignment is unreachable by its old token');

      const after = (await h.state()).donors.find(donor => donor.id === 'donor-1');
      assert.equal(after.lastDonationDate, before.lastDonationDate, 'a withdrawal records no donation');
      assert.equal(after.reliabilityScore, before.reliabilityScore, 'a withdrawal does not change reliability');
    } finally {
      await h.close();
    }
  });

  await t.test('an expired request cannot be completed with a surviving token', async () => {
    const h = await startApi({ config: baseConfig({ requestTtlMs: 1 }) });
    try {
      const flow = await createRequestAndAccept(h);
      await new Promise(resolve => setTimeout(resolve, 15));
      const tick = await h.api.runDispatchTick();
      assert.equal(tick.expired, 1);

      const state = await h.state();
      const assignment = state.assignments.find(item => item.id === flow.assignmentId);
      assert.equal(assignment.status, 'CANCELLED');
      assert.equal(assignment.checkinToken, null);
      assert.equal(state.requests.find(item => item.id === flow.requestId).status, 'EXPIRED');

      const checkin = await h.request('/hospital/checkin', { method: 'POST', token: flow.hospitalToken, body: { token: flow.checkinToken } });
      assert.equal(checkin.status, 404);
    } finally {
      await h.close();
    }
  });

  await t.test('closing a request invalidates outstanding tokens', async () => {
    const h = await startApi();
    try {
      const flow = await createRequestAndAccept(h);
      assert.equal((await h.request(`/hospital/requests/${flow.requestId}/close`, { method: 'POST', token: flow.hospitalToken })).status, 200);

      const assignment = (await h.state()).assignments.find(item => item.id === flow.assignmentId);
      assert.equal(assignment.status, 'CANCELLED');
      assert.equal(assignment.checkinToken, null);
      assert.equal((await h.request('/hospital/checkin', { method: 'POST', token: flow.hospitalToken, body: { token: flow.checkinToken } })).status, 404);
    } finally {
      await h.close();
    }
  });

  await t.test('a donor who already declined cannot be checked in', async () => {
    const h = await startApi();
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      await h.request('/hospital/requests', { method: 'POST', token: hospitalToken, body: { bloodType: 'O-', unitsNeeded: 2 } });
      const donor = (await loginDonor(h)).body;
      const alertId = (await h.request('/donor/alerts', { token: donor.token })).body[0].id;

      const declined = await h.request(`/donor/assignments/${alertId}/respond`, { method: 'POST', token: donor.token, body: { response: 'DECLINE' } });
      assert.equal(declined.status, 200);
      assert.equal(declined.body.checkinToken, null, 'declining never issues a token');
      assert.equal((await h.request('/hospital/checkin', { method: 'POST', token: hospitalToken, body: { token: `PULSE:${alertId}:forged` } })).status, 404);
      assert.equal((await h.state()).assignments[0].status, 'DECLINED');
    } finally {
      await h.close();
    }
  });

  await t.test('a completed assignment cannot be completed twice', async () => {
    const h = await startApi();
    try {
      const flow = await createRequestAndAccept(h, { unitsNeeded: 2 });
      assert.equal((await h.request('/hospital/checkin', { method: 'POST', token: flow.hospitalToken, body: { token: flow.checkinToken } })).status, 200);
      const again = await h.request('/hospital/checkin', { method: 'POST', token: flow.hospitalToken, body: { token: flow.checkinToken } });
      assert.equal(again.status, 409);
      assert.equal((await h.state()).assignments[0].status, 'COMPLETED');
    } finally {
      await h.close();
    }
  });
});
