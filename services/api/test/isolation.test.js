import test from 'node:test';
import assert from 'node:assert/strict';
import { loginDonor, mintToken, startApi } from './helpers.js';

const OTHER_TENANT = { role: 'hospital', id: 'hospital-other', tenantId: 'hospital:other' };

test('tenant and donor isolation', async (t) => {
  await t.test('a hospital cannot list or mutate another tenant request', async () => {
    const h = await startApi();
    try {
      const token = (await h.loginHospital()).body.token;
      const created = await h.request('/hospital/requests', {
        method: 'POST',
        token,
        body: { bloodType: 'O-', unitsNeeded: 2, urgency: 'CRITICAL' },
      });
      assert.equal(created.status, 201);
      const requestId = created.body.id;
      assert.equal(created.body.hospitalId, h.config.hospitalId);

      const other = mintToken(h.config, OTHER_TENANT);
      assert.deepEqual((await h.request('/hospital/requests', { token: other })).body, []);
      assert.equal((await h.request('/sync/version', { token: other })).body.requestCount, 0);

      for (const path of [`/hospital/requests/${requestId}/escalate`, `/hospital/requests/${requestId}/cancel`, `/hospital/requests/${requestId}/close`]) {
        const response = await h.request(path, { method: 'POST', token: other });
        assert.equal(response.status, 404, `${path} must be invisible to another tenant`);
      }

      const own = await h.request('/hospital/requests', { token });
      assert.equal(own.body.length, 1);
      assert.equal(own.body[0].id, requestId);
    } finally {
      await h.close();
    }
  });

  await t.test('an arrival token cannot be redeemed by another tenant', async () => {
    const h = await startApi();
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      await h.request('/hospital/requests', { method: 'POST', token: hospitalToken, body: { bloodType: 'O-', unitsNeeded: 1 } });

      const donor = await loginDonor(h);
      const alerts = await h.request('/donor/alerts', { token: donor.body.token });
      assert.ok(alerts.body.length > 0);

      const accepted = await h.request(`/donor/assignments/${alerts.body[0].id}/respond`, {
        method: 'POST',
        token: donor.body.token,
        body: { response: 'ACCEPT' },
      });
      assert.equal(accepted.status, 200);
      const checkinToken = accepted.body.checkinToken;
      assert.ok(checkinToken);

      const other = mintToken(h.config, OTHER_TENANT);
      assert.equal((await h.request('/hospital/checkin', { method: 'POST', token: other, body: { token: checkinToken } })).status, 404);

      const own = await h.request('/hospital/checkin', { method: 'POST', token: hospitalToken, body: { token: checkinToken } });
      assert.equal(own.status, 200);
      assert.equal(own.body.assignment.status, 'COMPLETED');
      assert.equal(own.body.request.status, 'FULFILLED');
    } finally {
      await h.close();
    }
  });

  await t.test('a donor can only answer their own alerts', async () => {
    const h = await startApi();
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      await h.request('/hospital/requests', { method: 'POST', token: hospitalToken, body: { bloodType: 'O-', unitsNeeded: 2 } });

      const donorA = (await loginDonor(h, '+919000000001')).body;
      const donorB = (await loginDonor(h, '+919000000002')).body;

      const alertsA = await h.request('/donor/alerts', { token: donorA.token });
      const alertsB = await h.request('/donor/alerts', { token: donorB.token });
      assert.ok(alertsA.body.length > 0);
      assert.deepEqual(alertsB.body, [], 'an O+ donor must not receive an O- alert at 1 km');

      const assignmentId = alertsA.body[0].id;
      assert.equal((await h.request(`/donor/assignments/${assignmentId}/respond`, { method: 'POST', token: donorB.token, body: { response: 'ACCEPT' } })).status, 404);
      assert.equal((await h.request(`/donor/assignments/${assignmentId}/arrive`, { method: 'POST', token: donorB.token })).status, 404);

      const accepted = await h.request(`/donor/assignments/${assignmentId}/respond`, {
        method: 'POST',
        token: donorA.token,
        body: { response: 'ACCEPT' },
      });
      assert.equal(accepted.status, 200);
      assert.equal((await h.request(`/donor/assignments/${assignmentId}/arrive`, { method: 'POST', token: donorA.token })).status, 200);
    } finally {
      await h.close();
    }
  });

  await t.test('push devices are scoped to the donor that registered them', async () => {
    const h = await startApi();
    try {
      const donorA = (await loginDonor(h, '+919000000001')).body;
      const donorB = (await loginDonor(h, '+919000000002')).body;
      const installationId = 'install-aaaaaaaa';

      const registered = await h.request('/donor/devices', {
        method: 'POST',
        token: donorA.token,
        body: { installationId, expoPushToken: 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]', platform: 'android' },
      });
      assert.equal(registered.status, 201);

      // Another donor cannot hijack the registration or delete it.
      const hijack = await h.request('/donor/devices', {
        method: 'POST',
        token: donorB.token,
        body: { installationId: 'install-bbbbbbbb', expoPushToken: 'ExponentPushToken[bbbbbbbbbbbbbbbbbbbbbb]', platform: 'ios' },
      });
      assert.equal(hijack.status, 201);
      assert.equal((await h.request(`/donor/devices/${installationId}`, { method: 'DELETE', token: donorB.token })).status, 404);
      assert.equal((await h.request(`/donor/devices/${installationId}`, { method: 'DELETE', token: donorA.token })).status, 200);

      const state = await h.state();
      const devices = state.devices.filter(device => device.installationId === installationId);
      assert.equal(devices.length, 1);
      assert.equal(devices[0].donorId, 'donor-1');
      assert.equal(devices[0].active, false);
    } finally {
      await h.close();
    }
  });

  await t.test('alerts disappear for the donor once the hospital withdraws the request', async () => {
    const h = await startApi();
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      const created = await h.request('/hospital/requests', { method: 'POST', token: hospitalToken, body: { bloodType: 'O-', unitsNeeded: 2 } });
      const donor = await loginDonor(h);
      assert.ok((await h.request('/donor/alerts', { token: donor.body.token })).body.length > 0);

      const cancelled = await h.request(`/hospital/requests/${created.body.id}/cancel`, { method: 'POST', token: hospitalToken });
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.body.status, 'CANCELLED');

      assert.deepEqual((await h.request('/donor/alerts', { token: donor.body.token })).body, []);
      assert.equal((await h.request(`/hospital/requests/${created.body.id}/cancel`, { method: 'POST', token: hospitalToken })).status, 409);
    } finally {
      await h.close();
    }
  });
});
