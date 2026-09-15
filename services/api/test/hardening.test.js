import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { baseConfig, fakeAuthProvider, productionConfig, productionEnv, startApi } from './helpers.js';
import { loadConfig } from '../src/config.js';
import { createSeedState } from '../src/domain.js';
import { createMemoryAdapter } from '../src/store.js';

const SERVICE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('deployment hardening', async (t) => {
  await t.test('production boots with an empty operational dataset', async () => {
    const h = await startApi({ config: productionConfig() });
    try {
      const state = await h.state();
      for (const collection of ['donors', 'requests', 'assignments', 'devices', 'outbox']) {
        assert.deepEqual(state[collection], [], `${collection} must not be seeded in production`);
      }
      const health = await h.request('/health');
      assert.equal(health.status, 200);
      assert.equal(health.body.demoMode, false);
      assert.equal(health.body.persistence, 'memory', 'no Supabase client is injected in this test');
      // /health is unauthenticated: no network size or dispatch volume may leak from it.
      assert.equal(health.body.donors, undefined);
      assert.equal(health.body.requests, undefined);
      assert.equal(health.body.revision, undefined);
      assert.equal(health.body.stateReadable, true);
    } finally {
      await h.close();
    }
  });

  await t.test('demo fixtures and the fixed OTP require an explicit DEMO_MODE opt-in', async () => {
    const implicit = loadConfig({ NODE_ENV: 'test' });
    assert.equal(implicit.demoMode, false, 'demo mode is off unless DEMO_MODE=true');
    assert.equal(implicit.devOtpCode, null);
    assert.equal(implicit.hospital.password, null, 'no demo password is even loaded');

    const explicitOff = loadConfig({ NODE_ENV: 'test', DEMO_MODE: 'false' });
    assert.equal(explicitOff.demoMode, false);
    assert.equal(explicitOff.devOtpCode, null);

    const explicit = loadConfig({ NODE_ENV: 'test', DEMO_MODE: 'true' });
    assert.equal(explicit.demoMode, true);
    assert.equal(explicit.devOtpCode, '123456');

    const h = await startApi({ config: explicit });
    try {
      const health = await h.request('/health');
      assert.equal(health.body.demoMode, true);
      assert.equal(health.body.persistence, 'memory');
      assert.ok((await h.state()).donors.length > 0, 'the demo seed is only used in demo mode');
    } finally {
      await h.close();
    }
  });

  await t.test('DEMO_MODE=false refuses the demo password and the fixed OTP', async () => {
    const config = loadConfig({ NODE_ENV: 'test', DEMO_MODE: 'false', HOSPITAL_EMAIL: 'admin@centralhospital.demo', HOSPITAL_PASSWORD: 'demo123' });
    assert.equal(config.devOtpCode, null);
    const h = await startApi({ config });
    try {
      const login = await h.request('/auth/hospital', { method: 'POST', body: { email: 'admin@centralhospital.demo', password: 'demo123' } });
      assert.equal(login.status, 401);
      const verify = await h.request('/auth/donor/verify', { method: 'POST', body: { phone: '+919000000001', code: '123456', fullName: 'Asha Menon', bloodType: 'O-', dateOfBirth: '1995-04-14', weightKg: 61, lastDonationDate: '2024-01-01', consentAccepted: true } });
      assert.notEqual(verify.status, 200, '123456 is not a valid code outside a local demo');
    } finally {
      await h.close();
    }
  });

  await t.test('demo mode never builds a Supabase service client, even with live keys present', async () => {
    const config = loadConfig({
      NODE_ENV: 'test',
      DEMO_MODE: 'true',
      SUPABASE_URL: 'https://live-project.supabase.co',
      SUPABASE_SECRET_KEY: 'service-role-key',
      SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
    });
    // raw: true -> the app resolves its own clients from the config instead of test injection.
    const h = await startApi({ config, raw: true, authProvider: fakeAuthProvider({ users: [] }) });
    try {
      assert.equal(h.store.adapterKind, 'memory', 'a demo must use ephemeral in-memory state');
      const health = await h.request('/health');
      assert.equal(health.body.persistence, 'memory');
      assert.equal(health.body.supabaseConfigured, false, 'no service-role client is constructed in demo mode');
      const start = await h.request('/auth/donor/start', { method: 'POST', body: { phone: '+919000000001' } });
      assert.equal(start.body.delivery, 'development', 'no SMS provider call is attempted');
    } finally {
      await h.close();
    }
  });

  await t.test('health performs a live store probe instead of reporting a static ok', async () => {
    const config = baseConfig();
    const seed = createSeedState({ hospital: config.hospital, demo: true });
    const healthy = createMemoryAdapter(seed);
    const brokenAdapter = { ...healthy, load: async () => { throw new Error('database offline'); } };

    const broken = await startApi({ config, adapter: brokenAdapter });
    try {
      const health = await broken.request('/health');
      assert.equal(health.status, 503);
      assert.equal(health.body.status, 'error');
      assert.equal(health.body.persistence, 'unavailable');
      assert.equal(health.body.misconfigured, false);
      assert.ok(health.body.error);
      assert.equal(JSON.stringify(health.body).includes('database offline'), false, 'internal errors are not echoed');
    } finally {
      await broken.close();
    }

    // A store whose collections are missing must also be reported unhealthy.
    const shapeAdapter = {
      ...healthy,
      load: async () => ({ state: { donors: [] }, version: 1, exists: true }),
    };
    const malformed = await startApi({ config, adapter: shapeAdapter });
    try {
      assert.equal((await malformed.request('/health')).status, 503);
    } finally {
      await malformed.close();
    }
  });

  await t.test('responses carry no-store and hardening headers', async () => {
    const h = await startApi({ config: productionConfig() });
    try {
      const health = await h.request('/health');
      assert.match(health.headers['cache-control'], /no-store/);
      assert.equal(health.headers['x-content-type-options'], 'nosniff');
      assert.equal(health.headers['x-frame-options'], 'DENY');
      assert.equal(health.headers['referrer-policy'], 'no-referrer');
      assert.match(health.headers['content-security-policy'], /default-src 'none'/);
      assert.ok(health.headers['strict-transport-security']);

      const denied = await h.request('/hospital/requests');
      assert.equal(denied.status, 401);
      assert.match(denied.headers['cache-control'], /no-store/);
    } finally {
      await h.close();
    }
  });

  await t.test('CORS is an explicit allowlist, never a wildcard in production', async () => {
    const h = await startApi({ config: productionConfig() });
    try {
      const allowed = await fetch(`${h.baseUrl}/health`, { headers: { Origin: 'https://console.example.com' } });
      assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://console.example.com');
      assert.equal(allowed.headers.get('access-control-allow-credentials'), null, 'credentials are never enabled');

      const denied = await fetch(`${h.baseUrl}/health`, { headers: { Origin: 'https://evil.example.com' } });
      assert.equal(denied.headers.get('access-control-allow-origin'), null);
      assert.equal(denied.status, 200, 'the request is not served cross-origin but is not an error either');

      const noOrigin = await fetch(`${h.baseUrl}/health`);
      assert.equal(noOrigin.status, 200, 'native clients and cron send no Origin header');
    } finally {
      await h.close();
    }
  });

  await t.test('a wildcard origin is a production misconfiguration', () => {
    const wildcard = productionConfig({ corsOrigins: ['*'] });
    assert.equal(wildcard.problems.some(problem => problem.includes('CORS_ALLOWED_ORIGINS')), false,
      'corsOrigins is a resolved config value; the check runs on the raw env input');

    const fromEnv = loadConfig(productionEnv({ CORS_ALLOWED_ORIGINS: '*' }));
    assert.equal(fromEnv.problems.some(problem => problem.includes('must not contain')), true);

    const missingOrigins = loadConfig(productionEnv({ CORS_ALLOWED_ORIGINS: undefined }));
    assert.deepEqual(missingOrigins.problems, [], 'a missing allowlist is a warning, not a hard failure');
    assert.equal(missingOrigins.warnings.some(warning => warning.includes('CORS_ALLOWED_ORIGINS')), true);
    assert.deepEqual(missingOrigins.corsOrigins, [], 'production falls back to no cross-origin access');
  });

  await t.test('CRON_SECRET and other production secrets must be strong', () => {
    const base = productionEnv({ CRON_SECRET: undefined, APP_JWT_SECRET: undefined });
    const short = loadConfig(productionEnv({ CRON_SECRET: 'tooshort', APP_JWT_SECRET: 'x'.repeat(40) }));
    assert.equal(short.problems.some(problem => problem.includes('CRON_SECRET')), true);

    const missing = loadConfig(base);
    assert.equal(missing.problems.some(problem => problem.includes('CRON_SECRET')), true);

    const strong = loadConfig(productionEnv({ APP_JWT_SECRET: 'x'.repeat(40), CRON_SECRET: 'c'.repeat(32) }));
    assert.deepEqual(strong.problems, []);
    assert.equal(strong.cronSecret.length, 32);

    const weakJwt = loadConfig(productionEnv({ APP_JWT_SECRET: 'short', CRON_SECRET: 'c'.repeat(32) }));
    assert.equal(weakJwt.problems.some(problem => problem.includes('APP_JWT_SECRET')), true);
  });

  await t.test('hospital environment variables are optional in production (stored in Supabase) and invalid coordinates are refused', () => {
    // When hospital env variables are omitted, production succeeds with zero problems because
    // facility details (name, license, coordinates) are managed dynamically in Supabase app_state.
    const noHospitalEnv = loadConfig(productionEnv({
      HOSPITAL_ID: undefined,
      HOSPITAL_NAME: undefined,
      HOSPITAL_LICENSE: undefined,
      HOSPITAL_LATITUDE: undefined,
      HOSPITAL_LONGITUDE: undefined,
    }));
    assert.deepEqual(noHospitalEnv.problems, []);
    assert.equal(noHospitalEnv.hospital.id, 'hospital-central');
    assert.equal(noHospitalEnv.hospital.name, 'Central City Medical Centre');
    assert.equal(noHospitalEnv.hospital.latitude, 10.5276);
    assert.equal(noHospitalEnv.hospital.longitude, 76.2144);

    const outOfRange = loadConfig(productionEnv({ HOSPITAL_LATITUDE: '999', HOSPITAL_LONGITUDE: '76.2' }));
    assert.equal(outOfRange.problems.some(problem => problem.includes('HOSPITAL_LATITUDE')), true);

    const outOfRangeLon = loadConfig(productionEnv({ HOSPITAL_LATITUDE: '10.5', HOSPITAL_LONGITUDE: '999' }));
    assert.equal(outOfRangeLon.problems.some(problem => problem.includes('HOSPITAL_LONGITUDE')), true);

    const real = loadConfig(productionEnv());
    assert.deepEqual(real.problems, []);
    assert.equal(real.hospital.latitude, 10.5276);
    assert.equal(real.hospital.longitude, 76.2144);
  });

  await t.test('a deployed runtime never loads a local .env file', () => {
    const script = [
      "import { config } from './src/server.js';",
      'console.log(JSON.stringify({ production: config.production, supabaseUrl: config.supabaseUrl, problems: config.problems.length }));',
    ].join(' ');
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      cwd: SERVICE_DIR,
      // VERCEL is set, exactly like a deployed function. The workspace .env exists and points at a
      // live project, so a leaked .env pickup would show up here immediately.
      env: { ...process.env, VERCEL: '1', NODE_ENV: '', NODE_TEST_CONTEXT: '' },
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output.trim().split('\n').pop());
    assert.equal(parsed.production, true);
    assert.equal(parsed.supabaseUrl, null, 'the .env file must not be read in a deployed runtime');
    assert.ok(parsed.problems > 0, 'missing platform env vars fail closed');
  });
});
