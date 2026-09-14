import test from 'node:test';
import assert from 'node:assert/strict';
import { baseConfig, fakeAuthProvider, hospitalAuthUser, productionConfig, startApi } from './helpers.js';

const PASSWORD = 'operator-password-1';
const DONOR_PHONE = '+15550000001';
const DONOR_UID = 'uid-donor-1';
const DONOR_PROFILE = {
  fullName: 'Realtime Donor',
  bloodType: 'O+',
  dateOfBirth: '1996-05-05',
  weightKg: 70,
  lastDonationDate: '2024-01-01',
  sex: 'FEMALE',
  consentAccepted: true,
};

function donorRecord() {
  const record = hospitalAuthUser({ id: DONOR_UID, email: 'donor@example.com', role: null, hospitalId: null });
  return { ...record, phone: DONOR_PHONE, otp: '654321' };
}

async function loginDonor(harness) {
  const response = await harness.request('/auth/donor/verify', {
    method: 'POST',
    body: { phone: DONOR_PHONE, code: '654321', ...DONOR_PROFILE },
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.token;
}

test('realtime sync configuration', async (t) => {
  await t.test('an unauthenticated caller gets nothing', async () => {
    const h = await startApi({ config: productionConfig(), authProvider: fakeAuthProvider({ users: [] }) });
    try {
      assert.equal((await h.request('/sync/config')).status, 401);
    } finally {
      await h.close();
    }
  });

  await t.test('demo mode reports realtime as disabled and leaks no credentials', async () => {
    const h = await startApi({ config: baseConfig() });
    try {
      const token = (await h.loginHospital()).body.token;
      const config = await h.request('/sync/config', { token });
      assert.equal(config.status, 200);
      assert.equal(config.body.enabled, false);
      assert.equal(config.body.reason, 'demo-mode');
      assert.equal(config.body.accessToken, undefined);
      assert.equal(config.body.publishableKey, undefined);
      assert.equal(config.body.url, undefined);
      assert.equal(config.body.fallback, 'rest-polling');
    } finally {
      await h.close();
    }
  });

  await t.test('a hospital operator receives a private tenant topic and only its own token', async () => {
    const provider = fakeAuthProvider({ users: [hospitalAuthUser({ id: 'u-console', hospitalId: 'tenant-a' })] });
    // A non-configured tenant requires the multi-facility opt-in; the single-facility default
    // refuses it (see the tenant-mismatch test in auth-trust.test.js).
    const h = await startApi({ config: productionConfig({ multiTenant: true }), authProvider: provider });
    try {
      const login = await h.request('/auth/hospital', { method: 'POST', body: { email: 'ops@hospital.example', password: PASSWORD } });
      assert.equal(login.status, 200);

      const sync = await h.request('/sync/config', { token: login.body.token });
      assert.equal(sync.status, 200);
      assert.equal(sync.body.enabled, true);
      assert.equal(sync.body.private, true);
      assert.equal(sync.body.transport, 'realtime-broadcast-private');
      assert.equal(sync.body.topic, 'hospital:tenant-a');
      assert.equal(sync.body.event, 'changed');
      assert.equal(sync.body.url, h.config.supabaseUrl);
      assert.equal(sync.body.publishableKey, h.config.supabasePublishableKey);
      assert.equal(sync.body.accessToken, 'token-u-console', 'the caller receives only its own provider session token');

      const serialized = JSON.stringify(sync.body);
      assert.equal(serialized.includes(h.config.supabaseSecretKey), false, 'the service-role key is never exposed');
      assert.equal(serialized.includes('service-role-key'), false);
    } finally {
      await h.close();
    }
  });

  await t.test('two tenants never share a topic', async () => {
    const provider = fakeAuthProvider({
      users: [
        hospitalAuthUser({ id: 'u-a', email: 'a@hospital.example', hospitalId: 'tenant-a' }),
        hospitalAuthUser({ id: 'u-b', email: 'b@hospital.example', hospitalId: 'tenant-b' }),
      ],
    });
    const h = await startApi({ config: productionConfig({ multiTenant: true }), authProvider: provider });
    try {
      const a = await h.request('/auth/hospital', { method: 'POST', body: { email: 'a@hospital.example', password: PASSWORD } });
      const b = await h.request('/auth/hospital', { method: 'POST', body: { email: 'b@hospital.example', password: PASSWORD } });
      const syncA = await h.request('/sync/config', { token: a.body.token });
      const syncB = await h.request('/sync/config', { token: b.body.token });
      assert.equal(syncA.body.topic, 'hospital:tenant-a');
      assert.equal(syncB.body.topic, 'hospital:tenant-b');
      assert.notEqual(syncA.body.topic, syncB.body.topic);
      assert.notEqual(syncA.body.accessToken, syncB.body.accessToken);
    } finally {
      await h.close();
    }
  });

  await t.test('a donor receives only their own private topic', async () => {
    const provider = fakeAuthProvider({ users: [donorRecord()] });
    const h = await startApi({ config: productionConfig(), authProvider: provider });
    try {
      const donorToken = await loginDonor(h);
      const sync = await h.request('/sync/config', { token: donorToken });
      assert.equal(sync.status, 200);
      assert.equal(sync.body.enabled, true);
      assert.equal(sync.body.topic, `donor:${DONOR_UID}`);
      assert.equal(sync.body.topic.startsWith('hospital:'), false, 'a donor never receives a tenant topic');
      assert.equal(sync.body.accessToken, `token-${DONOR_UID}`);

      // The advertised polling endpoint is role-scoped, not hospital-only: a donor gets their own
      // alert count and none of the tenant data.
      const version = await h.request('/sync/version', { token: donorToken });
      assert.equal(version.status, 200);
      assert.equal(version.body.role, 'donor');
      assert.equal(typeof version.body.alertCount, 'number');
      assert.equal(version.body.requestCount, undefined, 'a donor never sees tenant counters');
      assert.equal(version.body.revision, undefined, 'a donor never sees a global write counter');

      // Cross-role: a donor session cannot reach hospital-only resources.
      assert.equal((await h.request('/hospital/requests', { token: donorToken })).status, 401);
      assert.equal((await h.request('/donor/devices/install-unknown', { method: 'DELETE', token: donorToken })).status, 404);
    } finally {
      await h.close();
    }
  });

  await t.test('a hospital session cannot act as a donor', async () => {
    const provider = fakeAuthProvider({ users: [hospitalAuthUser({ id: 'u-console' })] });
    const h = await startApi({ config: productionConfig(), authProvider: provider });
    try {
      const login = await h.request('/auth/hospital', { method: 'POST', body: { email: 'ops@hospital.example', password: PASSWORD } });
      assert.equal((await h.request('/donor/me', { token: login.body.token })).status, 401);
      assert.equal((await h.request('/donor/devices', { method: 'POST', token: login.body.token, body: { installationId: 'install-x', expoPushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxx]', platform: 'ios' } })).status, 401);
    } finally {
      await h.close();
    }
  });

  await t.test('a revoked provider session cannot obtain a realtime token', async () => {
    const provider = fakeAuthProvider({
      users: [hospitalAuthUser({ id: 'u-revoked' })],
      getUser: async () => ({ data: { user: null }, error: { message: 'session_not_found' } }),
    });
    const h = await startApi({ config: productionConfig(), authProvider: provider });
    try {
      const login = await h.request('/auth/hospital', { method: 'POST', body: { email: 'ops@hospital.example', password: PASSWORD } });
      assert.equal(login.status, 200);
      assert.equal((await h.request('/sync/config', { token: login.body.token })).status, 401);
    } finally {
      await h.close();
    }
  });

  await t.test('every disabled response still advertises the polling fallback', async () => {
    const h = await startApi({ config: baseConfig() });
    try {
      const token = (await h.loginHospital()).body.token;
      const sync = await h.request('/sync/config', { token });
      assert.equal(sync.body.enabled, false);
      assert.equal(sync.body.transport, 'poll');
      assert.equal(sync.body.syncEndpoint, '/sync/version');
      assert.equal(sync.body.event, 'changed');
    } finally {
      await h.close();
    }
  });
});
