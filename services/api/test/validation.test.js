import test from 'node:test';
import assert from 'node:assert/strict';
import { loginDonor, mintToken, startApi } from './helpers.js';

test('request and profile validation', async (t) => {
  await t.test('hospital requests reject malformed input with 400', async () => {
    const h = await startApi();
    try {
      const token = (await h.loginHospital()).body.token;
      const invalid = [
        {},
        { bloodType: 'ZZ', unitsNeeded: 2 },
        { bloodType: 'o-', unitsNeeded: 2 },
        { bloodType: 'O-', unitsNeeded: 0 },
        { bloodType: 'O-', unitsNeeded: 11 },
        { bloodType: 'O-', unitsNeeded: 2.5 },
        { bloodType: 'O-', unitsNeeded: 'two' },
        { bloodType: 'O-', unitsNeeded: -3 },
        { bloodType: 'O-', unitsNeeded: 2, urgency: 'SOMETIME' },
      ];
      for (const body of invalid) {
        const response = await h.request('/hospital/requests', { method: 'POST', token, body });
        assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
        assert.ok(response.body.error);
      }
      assert.equal((await h.state()).requests.length, 0, 'no request may be persisted from invalid input');

      const valid = await h.request('/hospital/requests', { method: 'POST', token, body: { bloodType: 'O-', unitsNeeded: 2 } });
      assert.equal(valid.status, 201);
      assert.equal(valid.body.urgency, 'URGENT', 'urgency defaults to URGENT');
    } finally {
      await h.close();
    }
  });

  await t.test('escalation stops at the maximum dispatch radius', async () => {
    const h = await startApi();
    try {
      const token = (await h.loginHospital()).body.token;
      const created = await h.request('/hospital/requests', { method: 'POST', token, body: { bloodType: 'O-', unitsNeeded: 2 } });
      assert.equal(created.body.currentRadiusKm, 1);

      assert.equal((await h.request(`/hospital/requests/${created.body.id}/escalate`, { method: 'POST', token })).body.currentRadiusKm, 5);
      assert.equal((await h.request(`/hospital/requests/${created.body.id}/escalate`, { method: 'POST', token })).body.currentRadiusKm, 15);

      const capped = await h.request(`/hospital/requests/${created.body.id}/escalate`, { method: 'POST', token });
      assert.equal(capped.status, 409);
      assert.equal((await h.request('/hospital/requests/does-not-exist/escalate', { method: 'POST', token })).status, 404);
    } finally {
      await h.close();
    }
  });

  await t.test('donors must accept before arriving and cannot answer twice', async () => {
    const h = await startApi();
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      await h.request('/hospital/requests', { method: 'POST', token: hospitalToken, body: { bloodType: 'O-', unitsNeeded: 2 } });
      const donor = (await loginDonor(h)).body;
      const assignmentId = (await h.request('/donor/alerts', { token: donor.token })).body[0].id;

      const early = await h.request(`/donor/assignments/${assignmentId}/arrive`, { method: 'POST', token: donor.token });
      assert.equal(early.status, 409);

      assert.equal((await h.request(`/donor/assignments/${assignmentId}/respond`, { method: 'POST', token: donor.token, body: { response: 'MAYBE' } })).status, 400);
      assert.equal((await h.request(`/donor/assignments/${assignmentId}/respond`, { method: 'POST', token: donor.token, body: { response: 'DECLINE' } })).status, 200);

      const twice = await h.request(`/donor/assignments/${assignmentId}/respond`, { method: 'POST', token: donor.token, body: { response: 'ACCEPT' } });
      assert.equal(twice.status, 409);
    } finally {
      await h.close();
    }
  });

  await t.test('hospital check-in requires a valid, single-use arrival token', async () => {
    const h = await startApi();
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      await h.request('/hospital/requests', { method: 'POST', token: hospitalToken, body: { bloodType: 'O-', unitsNeeded: 2 } });
      const donor = (await loginDonor(h)).body;
      const assignmentId = (await h.request('/donor/alerts', { token: donor.token })).body[0].id;

      assert.equal((await h.request('/hospital/checkin', { method: 'POST', token: hospitalToken, body: {} })).status, 400);
      assert.equal((await h.request('/hospital/checkin', { method: 'POST', token: hospitalToken, body: { token: 'PULSE:unknown:unknown' } })).status, 404);

      const accepted = await h.request(`/donor/assignments/${assignmentId}/respond`, { method: 'POST', token: donor.token, body: { response: 'ACCEPT' } });
      const checkinToken = accepted.body.checkinToken;

      assert.equal((await h.request('/hospital/checkin', { method: 'POST', token: hospitalToken, body: { token: checkinToken } })).status, 200);
      assert.equal((await h.request('/hospital/checkin', { method: 'POST', token: hospitalToken, body: { token: checkinToken } })).status, 409);
    } finally {
      await h.close();
    }
  });

  await t.test('donor self-service validates coordinates, availability and identity', async () => {
    const h = await startApi();
    try {
      const donor = (await loginDonor(h)).body;

      assert.equal((await h.request('/donor/me', { method: 'PATCH', token: donor.token, body: { latitude: 999 } })).status, 400);
      assert.equal((await h.request('/donor/me', { method: 'PATCH', token: donor.token, body: { longitude: -400 } })).status, 400);
      assert.equal((await h.request('/donor/me', { method: 'PATCH', token: donor.token, body: { isAvailable: 'yes' } })).status, 400);
      assert.equal((await h.request('/donor/me', { method: 'PATCH', token: donor.token, body: { latitude: 'north' } })).status, 400);

      const updated = await h.request('/donor/me', { method: 'PATCH', token: donor.token, body: { isAvailable: false } });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.isAvailable, false);

      const ghost = mintToken(h.config, { role: 'donor', id: 'donor-does-not-exist' });
      assert.equal((await h.request('/donor/me', { token: ghost })).status, 404);
      assert.equal((await h.request('/donor/me', { method: 'PATCH', token: ghost, body: { isAvailable: true } })).status, 404);
      assert.deepEqual((await h.request('/donor/alerts', { token: ghost })).body, []);
    } finally {
      await h.close();
    }
  });

  await t.test('device registration validates identifiers and token format', async () => {
    const h = await startApi();
    try {
      const donor = (await loginDonor(h)).body;
      const valid = { installationId: 'install-cccccccc', expoPushToken: 'ExponentPushToken[cccccccccccccccccccccc]', platform: 'android' };

      const cases = [
        {},
        { ...valid, installationId: 'short' },
        { ...valid, installationId: 'has spaces here' },
        { ...valid, expoPushToken: 'not-a-token' },
        { ...valid, expoPushToken: 'ExponentPushToken[]' },
        { ...valid, platform: 'symbian' },
      ];
      for (const body of cases) {
        const response = await h.request('/donor/devices', { method: 'POST', token: donor.token, body });
        assert.equal(response.status, 400, `expected 400 for ${JSON.stringify(body)}`);
      }

      const registered = await h.request('/donor/devices', { method: 'POST', token: donor.token, body: valid });
      assert.equal(registered.status, 201);
      assert.equal(registered.body.platform, 'android');
      assert.equal(JSON.stringify(registered.body).includes('ExponentPushToken'), false, 'tokens are not echoed back');

      const reRegistered = await h.request('/donor/devices', { method: 'POST', token: donor.token, body: { ...valid, platform: 'ios' } });
      assert.equal(reRegistered.status, 201);
      assert.equal(reRegistered.body.platform, 'ios');
      assert.equal((await h.state()).devices.length, 1, 're-registering an installation updates it in place');

      assert.equal((await h.request('/donor/devices/unknown-installation', { method: 'DELETE', token: donor.token })).status, 404);
    } finally {
      await h.close();
    }
  });

  await t.test('donor registration profiles are validated on first sign-in', async () => {
    const h = await startApi();
    try {
      const phone = '+919000099999';
      const base = { phone, code: '123456', fullName: 'New Donor', bloodType: 'O+', dateOfBirth: '1996-05-05', weightKg: 70, lastDonationDate: '2024-01-01', consentAccepted: true };

      assert.equal((await h.request('/auth/donor/verify', { method: 'POST', body: { ...base, consentAccepted: false } })).status, 400);
      assert.equal((await h.request('/auth/donor/verify', { method: 'POST', body: { ...base, bloodType: 'X' } })).status, 400);
      assert.equal((await h.request('/auth/donor/verify', { method: 'POST', body: { ...base, dateOfBirth: '2020-05-05' } })).status, 400);
      assert.equal((await h.request('/auth/donor/verify', { method: 'POST', body: { ...base, lastDonationDate: '2999-01-01' } })).status, 400);
      assert.notEqual((await h.request('/auth/donor/verify', { method: 'POST', body: { ...base, code: '000000' } })).status, 200,
        'an unknown OTP never authenticates');

      const created = await h.request('/auth/donor/verify', { method: 'POST', body: base });
      assert.equal(created.status, 200);
      assert.equal(created.body.donor.phone, phone);
      assert.equal(typeof created.body.donor.eligible, 'boolean');
    } finally {
      await h.close();
    }
  });
});
