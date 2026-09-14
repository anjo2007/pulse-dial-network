import test from 'node:test';
import assert from 'node:assert/strict';
import { fakeAuthProvider, hospitalAuthUser, productionConfig, startApi } from './helpers.js';
import { readTrustedHospitalClaims } from '../src/app.js';

const PASSWORD = 'operator-password-1';

test('hospital access requires trusted service-side claims', async (t) => {
  await t.test('claims are read from app_metadata only, and must be complete', () => {
    assert.deepEqual(readTrustedHospitalClaims({ app_metadata: { role: 'hospital', hospital_id: 'tenant-a' } }), { hospitalId: 'tenant-a' });
    assert.deepEqual(readTrustedHospitalClaims({ app_metadata: { role: 'hospital', hospital_id: '  tenant-a  ' } }), { hospitalId: 'tenant-a' });

    assert.equal(readTrustedHospitalClaims({ app_metadata: { role: 'donor', hospital_id: 'tenant-a' } }), null);
    assert.equal(readTrustedHospitalClaims({ app_metadata: { role: 'hospital' } }), null);
    assert.equal(readTrustedHospitalClaims({ app_metadata: { role: 'hospital', hospital_id: '   ' } }), null);
    assert.equal(readTrustedHospitalClaims({ app_metadata: { role: 'hospital', hospital_id: 42 } }), null);
    assert.equal(readTrustedHospitalClaims({ app_metadata: { role: 'hospital', hospital_id: 'a'.repeat(65) } }), null);
    assert.equal(readTrustedHospitalClaims({ app_metadata: { role: 'hospital', hospital_id: 'bad tenant!' } }), null);
    assert.equal(readTrustedHospitalClaims({ app_metadata: null }), null);
    assert.equal(readTrustedHospitalClaims({ app_metadata: [] }), null);
    assert.equal(readTrustedHospitalClaims({}), null);
    assert.equal(readTrustedHospitalClaims(null), null);

    // user_metadata is user-editable and is NEVER trusted, even when it looks authoritative.
    assert.equal(readTrustedHospitalClaims({ user_metadata: { role: 'hospital', hospital_id: 'tenant-a' } }), null);
    assert.equal(readTrustedHospitalClaims({ app_metadata: {}, user_metadata: { role: 'hospital', hospital_id: 'tenant-a' } }), null);
  });

  await t.test('a self-signup account that self-declares a hospital role is rejected', async () => {
    const provider = fakeAuthProvider({
      users: [hospitalAuthUser({
        role: null,
        hospitalId: null,
        userMetadata: { role: 'hospital', hospital_id: 'hospital-central' },
      })],
    });
    const h = await startApi({ config: productionConfig(), authProvider: provider });
    try {
      const login = await h.request('/auth/hospital', { method: 'POST', body: { email: 'ops@hospital.example', password: PASSWORD } });
      assert.equal(login.status, 401);
      assert.equal(JSON.stringify(login.body).includes('hospital-central'), false);
      assert.deepEqual((await h.state()).requests, []);
    } finally {
      await h.close();
    }
  });

  await t.test('a valid password with the wrong role or no tenant is rejected', async () => {
    const cases = [
      hospitalAuthUser({ id: 'u-donor-role', email: 'donor-role@example.com', role: 'donor', hospitalId: 'hospital-central' }),
      hospitalAuthUser({ id: 'u-no-tenant', email: 'no-tenant@example.com', role: 'hospital', hospitalId: null }),
      hospitalAuthUser({ id: 'u-blank-tenant', email: 'blank@example.com', role: 'hospital', hospitalId: '   ' }),
      hospitalAuthUser({ id: 'u-no-role', email: 'no-role@example.com', role: null, hospitalId: 'hospital-central' }),
    ];
    const provider = fakeAuthProvider({ users: cases });
    const h = await startApi({ config: productionConfig(), authProvider: provider });
    try {
      for (const record of cases) {
        const login = await h.request('/auth/hospital', { method: 'POST', body: { email: record.email, password: PASSWORD } });
        assert.equal(login.status, 401, `${record.email} must not obtain a hospital session`);
        assert.equal(login.body.error, 'Invalid hospital credentials.');
      }
    } finally {
      await h.close();
    }
  });

  await t.test('a trusted operator is scoped to its app_metadata tenant', async () => {
    const provider = fakeAuthProvider({
      users: [
        hospitalAuthUser({ id: 'u-a', email: 'a@hospital.example', hospitalId: 'tenant-a' }),
        hospitalAuthUser({ id: 'u-b', email: 'b@hospital.example', hospitalId: 'tenant-b' }),
      ],
    });
    // A per-tenant registry is not implemented, so multi-facility serving must be opted into.
    const h = await startApi({ config: productionConfig({ multiTenant: true }), authProvider: provider });
    try {
      const a = await h.request('/auth/hospital', { method: 'POST', body: { email: 'a@hospital.example', password: PASSWORD } });
      const b = await h.request('/auth/hospital', { method: 'POST', body: { email: 'b@hospital.example', password: PASSWORD } });
      assert.equal(a.status, 200);
      assert.equal(b.status, 200);

      const created = await h.request('/hospital/requests', { method: 'POST', token: a.body.token, body: { bloodType: 'O-', unitsNeeded: 1 } });
      assert.equal(created.status, 201);
      assert.equal(created.body.hospitalId, 'tenant-a', 'the tenant comes from app_metadata, not the request body');

      assert.deepEqual((await h.request('/hospital/requests', { token: b.body.token })).body, []);
      assert.equal((await h.request(`/hospital/requests/${created.body.id}/cancel`, { method: 'POST', token: b.body.token })).status, 404);
      assert.equal((await h.request(`/hospital/requests/${created.body.id}/escalate`, { method: 'POST', token: b.body.token })).status, 404);
      assert.equal((await h.request('/hospital/requests', { token: a.body.token })).status, 200);
    } finally {
      await h.close();
    }
  });

  await t.test('the service-role client is never reused as the caller identity', async () => {
    const provider = fakeAuthProvider({ users: [hospitalAuthUser({ id: 'u-scoped' })] });
    const h = await startApi({ config: productionConfig(), authProvider: provider });
    try {
      assert.equal((await h.request('/auth/hospital', { method: 'POST', body: { email: 'ops@hospital.example', password: PASSWORD } })).status, 200);
      assert.equal((await h.request('/auth/hospital', { method: 'POST', body: { email: 'ops@hospital.example', password: PASSWORD } })).status, 200);
      const distinct = new Set(provider.clients);
      assert.equal(provider.clients.length, 2, 'one scoped auth client per sign-in');
      assert.equal(distinct.size, 2, 'no auth client instance is shared between requests');
    } finally {
      await h.close();
    }
  });

  await t.test('sessions expire with the provider session', async () => {
    const expired = fakeAuthProvider({ users: [hospitalAuthUser({ id: 'u-expired', sessionSeconds: -60 })] });
    const expiredHarness = await startApi({ config: productionConfig(), authProvider: expired });
    try {
      const login = await expiredHarness.request('/auth/hospital', { method: 'POST', body: { email: 'ops@hospital.example', password: PASSWORD } });
      assert.equal(login.status, 401, 'an already-expired provider session yields no application session');
    } finally {
      await expiredHarness.close();
    }

    const shortLived = fakeAuthProvider({ users: [hospitalAuthUser({ id: 'u-short', sessionSeconds: 2 })] });
    const harness = await startApi({ config: productionConfig(), authProvider: shortLived });
    try {
      const login = await harness.request('/auth/hospital', { method: 'POST', body: { email: 'ops@hospital.example', password: PASSWORD } });
      assert.equal(login.status, 200);
      const payload = JSON.parse(Buffer.from(login.body.token.split('.')[0], 'base64url').toString());
      const ttl = payload.exp - payload.iat;
      assert.ok(ttl <= 2000, `session ttl ${ttl}ms must not outlive the provider session`);
    } finally {
      await harness.close();
    }
  });

  await t.test('revoking the provider session ends API access immediately', async () => {
    const revoked = fakeAuthProvider({
      users: [hospitalAuthUser({ id: 'u-revoked' })],
      getUser: async () => ({ data: { user: null }, error: { message: 'session_not_found' } }),
    });
    const h = await startApi({ config: productionConfig(), authProvider: revoked });
    try {
      const login = await h.request('/auth/hospital', { method: 'POST', body: { email: 'ops@hospital.example', password: PASSWORD } });
      assert.equal(login.status, 200);
      assert.equal((await h.request('/hospital/requests', { token: login.body.token })).status, 401);
      assert.equal((await h.request('/sync/version', { token: login.body.token })).status, 401);
      assert.equal((await h.request('/internal/dispatch', { token: login.body.token })).status, 401);
    } finally {
      await h.close();
    }
  });

  await t.test('a demotion in app_metadata removes access on the next request', async () => {
    let role = 'hospital';
    const provider = fakeAuthProvider({
      users: [hospitalAuthUser({ id: 'u-demoted' })],
      getUser: async () => ({ data: { user: { id: 'u-demoted', app_metadata: { role, hospital_id: 'hospital-central' } } }, error: null }),
    });
    // The validation cache is deliberately short: use a 1ms window so the demotion is observed on
    // the very next request instead of up to 15s later.
    const h = await startApi({ config: productionConfig({ authValidationCacheMs: 1 }), authProvider: provider });
    try {
      const login = await h.request('/auth/hospital', { method: 'POST', body: { email: 'ops@hospital.example', password: PASSWORD } });
      assert.equal(login.status, 200);
      assert.equal((await h.request('/hospital/requests', { token: login.body.token })).status, 200);

      role = 'donor';
      await new Promise(resolve => setTimeout(resolve, 5));
      assert.equal((await h.request('/hospital/requests', { token: login.body.token })).status, 401,
        'a demoted operator loses access without waiting for the local session to expire');
    } finally {
      await h.close();
    }
  });

  await t.test('single-facility production refuses an operator from another facility', async () => {
    // No per-tenant registry is implemented, so an operator whose trusted tenant is not the
    // configured facility must not be served this facility's name and location.
    const foreign = fakeAuthProvider({ users: [hospitalAuthUser({ id: 'u-other', email: 'other@hospital.example', hospitalId: 'other-facility' })] });
    const h = await startApi({ config: productionConfig(), authProvider: foreign });
    try {
      assert.equal(h.config.multiTenant, false, 'single facility by default');
      const login = await h.request('/auth/hospital', { method: 'POST', body: { email: 'other@hospital.example', password: PASSWORD } });
      assert.equal(login.status, 401);
      assert.equal(JSON.stringify(login.body).includes('other-facility'), false);
    } finally {
      await h.close();
    }

    const own = fakeAuthProvider({ users: [hospitalAuthUser({ id: 'u-own', email: 'own@hospital.example', hospitalId: 'hospital-central' })] });
    const matching = await startApi({ config: productionConfig(), authProvider: own });
    try {
      const login = await matching.request('/auth/hospital', { method: 'POST', body: { email: 'own@hospital.example', password: PASSWORD } });
      assert.equal(login.status, 200, 'an operator provisioned with the configured tenant signs in');
    } finally {
      await matching.close();
    }
  });
});
