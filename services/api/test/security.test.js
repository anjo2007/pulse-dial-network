import test from 'node:test';
import assert from 'node:assert/strict';
import { baseConfig, mintToken, productionConfig, startApi } from './helpers.js';
import { loadConfig } from '../src/config.js';

test('authentication fails closed', async (t) => {
  await t.test('an unconfigured production deployment refuses all work and never serves demo auth', async () => {
    const config = loadConfig({ NODE_ENV: 'production' });
    assert.ok(config.problems.length >= 3, 'missing production secrets must be reported');
    assert.equal(config.devOtpCode, null, 'no fixed development OTP in production');
    assert.equal(config.jwtSecret, null, 'no development session secret in production');

    const h = await startApi({ config });
    try {
      const health = await h.request('/health');
      assert.equal(health.status, 503);
      assert.equal(health.body.status, 'error');
      assert.ok(health.body.problems.some(problem => problem.includes('APP_JWT_SECRET')));
      assert.ok(health.body.problems.some(problem => problem.includes('SUPABASE')));
      assert.equal(health.body.capabilities.dispatchWorker, false);

      const login = await h.request('/auth/hospital', {
        method: 'POST',
        body: { email: 'admin@centralhospital.demo', password: 'demo123' },
      });
      assert.equal(login.status, 503, 'the demo password must not authenticate');
      assert.equal((await h.request('/hospital/requests')).status, 503);
      assert.equal((await h.request('/donor/me')).status, 503);
      assert.equal((await h.request('/internal/dispatch')).status, 503);
    } finally {
      await h.close();
    }
  });

  await t.test('a fully configured production deployment still rejects demo credentials and the dev OTP', async () => {
    const config = productionConfig();
    assert.deepEqual(config.problems, [], 'a fully configured production env has no problems');
    const h = await startApi({ config });
    try {
      const login = await h.request('/auth/hospital', {
        method: 'POST',
        body: { email: 'admin@centralhospital.demo', password: 'demo123' },
      });
      assert.equal(login.status, 401, 'without Supabase Auth there is no hospital fallback');

      const start = await h.request('/auth/donor/start', { method: 'POST', body: { phone: '+919000000001' } });
      assert.equal(start.status, 503, 'without an SMS provider the API must not pretend to send');

      const verify = await h.request('/auth/donor/verify', { method: 'POST', body: { phone: '+919000000001', code: '123456' } });
      assert.notEqual(verify.status, 200, 'the fixed development OTP must never authenticate in production');
      assert.equal(verify.status, 503);
      assert.equal(h.config.devOtpCode, null);
    } finally {
      await h.close();
    }
  });

  await t.test('forged, expired and wrong-role tokens are rejected', async () => {
    const h = await startApi();
    try {
      const subject = { role: 'hospital', id: h.config.hospitalId, tenantId: h.config.hospitalId };
      const forged = mintToken(h.config, subject, { secret: 'not-the-real-secret' });
      assert.equal((await h.request('/hospital/requests', { token: forged })).status, 401);

      const expired = mintToken(h.config, subject, { ttlMs: -1000 });
      assert.equal((await h.request('/hospital/requests', { token: expired })).status, 401);

      const donorToken = mintToken(h.config, { role: 'donor', id: 'donor-1' });
      assert.equal((await h.request('/hospital/requests', { token: donorToken })).status, 401);

      const hospitalToken = mintToken(h.config, subject);
      assert.equal((await h.request('/donor/me', { token: hospitalToken })).status, 401);
      assert.equal((await h.request('/hospital/requests')).status, 401);
      assert.equal((await h.request('/internal/dispatch', { token: hospitalToken })).status, 401);
    } finally {
      await h.close();
    }
  });

  await t.test('sessions signed with the development default are invalid once a real secret is set', async () => {
    const h = await startApi({ config: baseConfig({ jwtSecret: 'x'.repeat(40) }) });
    try {
      const legacy = mintToken(h.config, { role: 'hospital', id: h.config.hospitalId, tenantId: h.config.hospitalId }, { secret: 'local-development-only' });
      assert.equal((await h.request('/hospital/requests', { token: legacy })).status, 401);

      const real = await h.loginHospital();
      assert.equal(real.status, 200);
      assert.equal((await h.request('/hospital/requests', { token: real.body.token })).status, 200);
    } finally {
      await h.close();
    }
  });

  await t.test('the dispatch worker requires CRON_SECRET and reports its capability', async () => {
    const dev = await startApi();
    // Production without a strong CRON_SECRET is a misconfiguration: request expiry and the
    // dispatch worker depend on it, so the whole deployment fails closed. `problems` is computed
    // from the raw environment, so it must be checked against a real load rather than an override.
    const prodConfig = loadConfig({
      NODE_ENV: 'production',
      SUPABASE_URL: 'https://example.supabase.co',
      SUPABASE_SECRET_KEY: 'service-role-key',
      SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
      APP_JWT_SECRET: 'x'.repeat(40),
    });
    assert.ok(prodConfig.problems.some(problem => problem.includes('CRON_SECRET')));
    assert.equal(prodConfig.cronSecret, null, 'no development worker secret leaks into production');
    assert.equal(prodConfig.devOtpCode, null);
    assert.equal(prodConfig.demoMode, false);
    const prod = await startApi({ config: prodConfig });
    try {
      const health = await dev.request('/health');
      assert.equal(health.status, 200);
      assert.equal(health.body.status, 'ok');
      assert.equal(health.body.capabilities.cancelRequest, true);
      assert.equal(health.body.capabilities.requestExpiry, true);
      assert.equal(health.body.capabilities.dispatchWorker, true);
      assert.equal(health.body.authentication, 'development-demo');

      assert.equal((await dev.request('/internal/dispatch')).status, 401);
      assert.equal((await dev.request('/internal/dispatch', { headers: { Authorization: 'Bearer wrong-secret' } })).status, 401);

      const ok = await dev.request('/internal/dispatch', { headers: { Authorization: `Bearer ${dev.config.cronSecret}` } });
      assert.equal(ok.status, 200);
      assert.equal(typeof ok.body.escalated, 'number');
      assert.equal(typeof ok.body.outboxClaimed, 'number');

      assert.equal((await prod.request('/internal/dispatch', { headers: { Authorization: `Bearer ${'c'.repeat(32)}` } })).status, 503);
      const prodHealth = await prod.request('/health');
      assert.equal(prodHealth.status, 503);
      assert.equal(prodHealth.body.problems.some(problem => problem.includes('CRON_SECRET')), true);
    } finally {
      await dev.close();
      await prod.close();
    }
  });

  await t.test('test runs are hermetic and never pick up live .env credentials', async () => {
    const { config } = await import('../src/server.js');
    assert.equal(config.supabaseUrl, null, 'the test runner must not load the workspace .env');
    assert.equal(config.supabaseSecretKey, null);
    assert.equal(config.production, false);
    assert.deepEqual(config.problems, []);
  });

  await t.test('malformed request bodies are rejected without leaking internals', async () => {
    const h = await startApi();
    try {
      const response = await fetch(`${h.baseUrl}/auth/hospital`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{not json',
      });
      assert.equal(response.status, 400);
      const body = await response.json();
      assert.equal(body.error, 'That request body is not valid JSON.');

      const missing = await h.request('/auth/hospital', { method: 'POST', body: {} });
      assert.equal(missing.status, 400);
      const wrong = await h.request('/auth/hospital', { method: 'POST', body: { email: 'nobody@example.com', password: 'nope' } });
      assert.equal(wrong.status, 401);
      assert.equal(wrong.body.error, 'Invalid hospital credentials.');
      assert.equal(JSON.stringify(wrong.body).includes('password'), false);
    } finally {
      await h.close();
    }
  });
});
