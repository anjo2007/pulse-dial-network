import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let app;
let server;
let baseUrl;

test.before(async () => {
  // This suite is the end-to-end contract baseline for the DEMO environment. Demo fixtures and the
  // fixed development OTP are explicit opt-in, so the environment is declared here BEFORE the app
  // is imported, because configuration is snapshotted at import time.
  process.env.NODE_ENV = 'test';
  process.env.DEMO_MODE = 'true';
  ({ app } = await import('../src/server.js'));
  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => {
    if (server) server.close(resolve);
    else resolve();
  });
});

async function api(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

test('API Test Suite', async (t) => {
  await t.test('GET /health returns 200 and operational status', async () => {
    const res = await api('/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.equal(res.body.service, 'pulse-dial-api');
    assert.ok(res.body.persistence);
  });

  let hospitalToken = null;
  await t.test('POST /auth/hospital with valid demo credentials', async () => {
    const res = await api('/auth/hospital', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@centralhospital.demo',
        password: 'demo123',
      }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(res.body.hospital.name, 'Central City Medical Centre');
    hospitalToken = res.body.token;
  });

  await t.test('POST /auth/hospital fails with invalid credentials', async () => {
    const res = await api('/auth/hospital', {
      method: 'POST',
      body: JSON.stringify({
        email: 'admin@centralhospital.demo',
        password: 'wrongpassword',
      }),
    });
    assert.equal(res.status, 401);
  });

  let donorToken = null;
  await t.test('POST /auth/donor/start sends verification code', async () => {
    const res = await api('/auth/donor/start', {
      method: 'POST',
      body: JSON.stringify({
        phone: '+919000000001',
      }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.delivery);
  });

  await t.test('POST /auth/donor/verify authenticates existing seeded donor', async () => {
    const res = await api('/auth/donor/verify', {
      method: 'POST',
      body: JSON.stringify({
        phone: '+919000000001',
        code: '123456',
      }),
    });
    assert.equal(res.status, 200);
    assert.ok(res.body.token);
    assert.equal(res.body.donor.phone, '+919000000001');
    assert.equal(res.body.donor.bloodType, 'O-');
    donorToken = res.body.token;
  });

  await t.test('GET /donor/me retrieves donor profile and eligibility', async () => {
    const res = await api('/donor/me', {
      headers: { Authorization: `Bearer ${donorToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.phone, '+919000000001');
    assert.equal(typeof res.body.eligible, 'boolean');
  });

  await t.test('PATCH /donor/me updates donor availability and coords', async () => {
    const res = await api('/donor/me', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${donorToken}` },
      body: JSON.stringify({ isAvailable: true, latitude: 10.528, longitude: 76.215 }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.isAvailable, true);
    assert.equal(res.body.latitude, 10.528);
  });

  let createdRequestId = null;
  await t.test('POST /hospital/requests creates emergency request and pings closest donors', async () => {
    const res = await api('/hospital/requests', {
      method: 'POST',
      headers: { Authorization: `Bearer ${hospitalToken}` },
      body: JSON.stringify({ bloodType: 'O-', unitsNeeded: 2, urgency: 'CRITICAL' }),
    });
    assert.equal(res.status, 201);
    assert.equal(res.body.bloodType, 'O-');
    assert.equal(res.body.unitsNeeded, 2);
    assert.ok(res.body.id);
    createdRequestId = res.body.id;
  });

  await t.test('GET /donor/alerts finds emergency dispatch alerts for donor', async () => {
    const res = await api('/donor/alerts', {
      headers: { Authorization: `Bearer ${donorToken}` },
    });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body));
    assert.ok(res.body.length > 0);
  });

  await t.test('POST /hospital/requests/:id/escalate expands dispatch radius', async () => {
    const res = await api(`/hospital/requests/${createdRequestId}/escalate`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${hospitalToken}` },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.currentRadiusKm, 5);
  });

  let checkinToken = null;
  await t.test('POST /donor/assignments/:id/respond accepts alert and gets token', async () => {
    const alertsRes = await api('/donor/alerts', {
      headers: { Authorization: `Bearer ${donorToken}` },
    });
    const alertItem = alertsRes.body[0];
    assert.ok(alertItem);

    const res = await api(`/donor/assignments/${alertItem.id}/respond`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${donorToken}` },
      body: JSON.stringify({ response: 'ACCEPT' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ACCEPTED');
    assert.ok(res.body.checkinToken);
    checkinToken = res.body.checkinToken;
  });

  await t.test('POST /hospital/checkin verifies donor arrival with token', async () => {
    const res = await api('/hospital/checkin', {
      method: 'POST',
      headers: { Authorization: `Bearer ${hospitalToken}` },
      body: JSON.stringify({ token: checkinToken }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.assignment.status, 'COMPLETED');
  });
});
