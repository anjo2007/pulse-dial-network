import test from 'node:test';
import assert from 'node:assert/strict';
import { baseConfig, DEMO_DONOR_PHONE, startApi } from './helpers.js';
import { hasMeasuredLocation } from '../src/domain.js';

const NEW_PHONE = '+919000099998';

function profile(extra = {}) {
  return {
    phone: NEW_PHONE,
    code: '123456',
    fullName: 'Unlocated Donor',
    bloodType: 'O-',
    dateOfBirth: '1996-05-05',
    weightKg: 70,
    lastDonationDate: '2024-01-01',
    consentAccepted: true,
    ...extra,
  };
}

test('donor coordinates are measured or absent, never invented', async (t) => {
  await t.test('hasMeasuredLocation rejects null, missing and malformed coordinates', () => {
    assert.equal(hasMeasuredLocation({ latitude: 10.5, longitude: 76.2 }), true);
    assert.equal(hasMeasuredLocation({ latitude: 10.5, longitude: 76.2, isAvailable: false }), true, 'location is independent of availability');
    assert.equal(hasMeasuredLocation({ latitude: null, longitude: 76.2 }), false);
    assert.equal(hasMeasuredLocation({ latitude: undefined, longitude: undefined }), false);
    assert.equal(hasMeasuredLocation({ latitude: 'north', longitude: 76.2 }), false);
    assert.equal(hasMeasuredLocation({ latitude: 999, longitude: 76.2 }), false);
    assert.equal(hasMeasuredLocation({ latitude: 10.5, longitude: 200 }), false);
    assert.equal(hasMeasuredLocation({}), false);
    assert.equal(hasMeasuredLocation(null), false);
  });

  await t.test('a registration without coordinates stores nulls instead of a hospital-relative guess', async () => {
    const h = await startApi();
    try {
      const created = await h.request('/auth/donor/verify', { method: 'POST', body: profile() });
      assert.equal(created.status, 200);
      assert.equal(created.body.donor.latitude, null);
      assert.equal(created.body.donor.longitude, null);

      const stored = (await h.state()).donors.find(donor => donor.phone === NEW_PHONE);
      assert.equal(stored.latitude, null);
      assert.equal(stored.longitude, null);
      assert.notEqual(stored.latitude, h.config.hospital.latitude + 0.01, 'the old fake offset is gone');
    } finally {
      await h.close();
    }
  });

  await t.test('an unlocated donor is never dispatched, while a measured one is', async () => {
    const h = await startApi();
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      const unlocated = await h.request('/auth/donor/verify', { method: 'POST', body: profile() });
      const located = await h.request('/auth/donor/verify', {
        method: 'POST',
        body: profile({ phone: '+919000099997', fullName: 'Located Donor', latitude: 10.5280, longitude: 76.2140 }),
      });
      assert.equal(unlocated.status, 200);
      assert.equal(located.status, 200);
      assert.equal(located.body.donor.latitude, 10.528);

      const created = await h.request('/hospital/requests', { method: 'POST', token: hospitalToken, body: { bloodType: 'O-', unitsNeeded: 2 } });
      assert.equal(created.status, 201);

      const pinged = created.body.assignments.map(assignment => assignment.donorName);
      assert.ok(pinged.includes('Located Donor'));
      assert.equal(pinged.includes('Unlocated Donor'), false, 'no location means no dispatch');
    } finally {
      await h.close();
    }
  });

  await t.test('a donor who is explicitly unavailable is not dispatched', async () => {
    const h = await startApi();
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      // The seeded donor-1 has real coordinates and is willing...
      const first = await h.request('/hospital/requests', { method: 'POST', token: hospitalToken, body: { bloodType: 'O-', unitsNeeded: 2 } });
      assert.ok(first.body.assignments.some(assignment => assignment.donorId === 'donor-1'));

      const donor = (await h.request('/auth/donor/verify', { method: 'POST', body: { phone: DEMO_DONOR_PHONE, code: '123456' } })).body;
      assert.equal((await h.request('/donor/me', { method: 'PATCH', token: donor.token, body: { isAvailable: false } })).status, 200);

      // ...but once opted out, a new request skips them.
      const second = await h.request('/hospital/requests', { method: 'POST', token: hospitalToken, body: { bloodType: 'O-', unitsNeeded: 2 } });
      assert.equal(second.body.assignments.some(assignment => assignment.donorId === 'donor-1'), false);
    } finally {
      await h.close();
    }
  });

  await t.test('partial or invalid coordinate pairs are rejected', async () => {
    const h = await startApi();
    try {
      const onlyLatitude = await h.request('/auth/donor/verify', { method: 'POST', body: profile({ latitude: 10.5 }) });
      assert.equal(onlyLatitude.status, 400);

      const onlyLongitude = await h.request('/auth/donor/verify', { method: 'POST', body: profile({ longitude: 76.2 }) });
      assert.equal(onlyLongitude.status, 400);

      const badLatitude = await h.request('/auth/donor/verify', { method: 'POST', body: profile({ latitude: 999, longitude: 76.2 }) });
      assert.equal(badLatitude.status, 400);

      const badLongitude = await h.request('/auth/donor/verify', { method: 'POST', body: profile({ latitude: 10.5, longitude: -999 }) });
      assert.equal(badLongitude.status, 400);

      assert.equal((await h.state()).donors.some(donor => donor.phone === NEW_PHONE), false, 'nothing invalid is persisted');
    } finally {
      await h.close();
    }
  });

  await t.test('the configured facility location is used for distance, not a default', async () => {
    const config = baseConfig({ hospital: { latitude: 10.9, longitude: 76.4 } });
    const h = await startApi({ config });
    try {
      const hospitalToken = (await h.loginHospital()).body.token;
      const created = await h.request('/hospital/requests', { method: 'POST', token: hospitalToken, body: { bloodType: 'O-', unitsNeeded: 2 } });
      // The seeded O- donors are ~40km from this configured facility, so a 1km tier finds nobody.
      assert.equal(created.body.pinged, 0);
    } finally {
      await h.close();
    }
  });
});
