import test from 'node:test';
import assert from 'node:assert/strict';
import { baseConfig, fakeAuthProvider, productionConfig, startApi } from './helpers.js';
import { createRateLimiter, RATE_LIMIT_RPC } from '../src/ratelimit.js';
import { createMemoryAdapter } from '../src/store.js';
import { createSeedState } from '../src/domain.js';

const PHONE = '+919000000001';
const EMAIL = 'admin@centralhospital.demo';

// Offline stand-in for the Postgres counting function: one atomic counter per key + window.
function fakeCountingBackend({ fail = null } = {}) {
  const counters = new Map();
  const calls = [];
  return {
    counters,
    calls,
    rpc(name, args) {
      calls.push({ name, args });
      if (fail) return Promise.resolve({ data: null, error: fail });
      if (name !== RATE_LIMIT_RPC) return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `Could not find the function ${name}` } });
      const key = `${args.p_key}|${args.p_window_seconds}`;
      const hits = (counters.get(key) || 0) + 1;
      counters.set(key, hits);
      return Promise.resolve({ data: hits <= args.p_limit, error: null });
    },
  };
}

function fakeRequest({ headers = {}, remoteAddress = '10.0.0.9', body = {} } = {}) {
  return { headers, socket: { remoteAddress }, body, requestId: 'test' };
}

test('persistent rate limiting', async (t) => {
  await t.test('keys are keyed HMACs: no email, phone or credential ever appears in a key', async () => {
    const backend = fakeCountingBackend();
    const limiter = createRateLimiter({ config: baseConfig({ rateLimitSecret: 'k'.repeat(32) }), supabase: backend });

    const phoneKey = limiter.identityKey('donor-verify', { kind: 'phone', value: PHONE });
    const emailKey = limiter.identityKey('hospital-login', { kind: 'email', value: EMAIL });

    assert.equal(phoneKey.includes('919000000001'), false);
    assert.equal(phoneKey.includes(PHONE), false);
    assert.equal(emailKey.includes('centralhospital'), false);
    assert.match(phoneKey, /^[A-Za-z0-9_-]{32}$/);

    // Deterministic for the same identity, distinct across identities and across buckets.
    assert.equal(limiter.identityKey('donor-verify', { kind: 'phone', value: PHONE }), phoneKey);
    assert.notEqual(limiter.identityKey('donor-start', { kind: 'phone', value: PHONE }), phoneKey);
    assert.notEqual(limiter.identityKey('donor-verify', { kind: 'phone', value: '+919000000002' }), phoneKey);

    // A different deployment secret produces a different key space, so keys are not portable.
    const other = createRateLimiter({ config: baseConfig({ rateLimitSecret: 'z'.repeat(32) }), supabase: backend });
    assert.notEqual(other.identityKey('donor-verify', { kind: 'phone', value: PHONE }), phoneKey);

    await limiter.hit(phoneKey, 60, 3);
    assert.equal(backend.calls[0].args.p_key, phoneKey);
    assert.equal(JSON.stringify(backend.calls).includes('919000000001'), false, 'the backend never sees the raw identity');
  });

  await t.test('the durable backend is the shared counter and denies past the limit', async () => {
    const backend = fakeCountingBackend();
    const limiter = createRateLimiter({ config: baseConfig({ rateLimitSecret: 'k'.repeat(32) }), supabase: backend });
    const key = limiter.identityKey('donor-verify', { kind: 'phone', value: PHONE });

    assert.equal((await limiter.hit(key, 60, 3)).allowed, true);
    assert.equal((await limiter.hit(key, 60, 3)).allowed, true);
    assert.equal((await limiter.hit(key, 60, 3)).allowed, true);
    const denied = await limiter.hit(key, 60, 3);
    assert.equal(denied.allowed, false);
    assert.equal(denied.degraded, false, 'a denial is a real limit decision, not a degraded backend');

    // A second limiter instance shares the same backend, i.e. the same budget (the fix for
    // per-instance counters on Vercel).
    const second = createRateLimiter({ config: baseConfig({ rateLimitSecret: 'k'.repeat(32) }), supabase: backend });
    assert.equal((await second.hit(key, 60, 3)).allowed, false);
  });

  await t.test('production fails closed when the counting function is missing', async () => {
    const missing = fakeCountingBackend({ fail: { code: 'PGRST202', message: 'Could not find the function public.rate_limit_hit' } });
    const absent = createRateLimiter({ config: productionConfig(), supabase: missing, memoryFallback: false });
    const key = absent.identityKey('worker', { kind: 'worker', value: 'dispatch' });
    const outcome = await absent.hit(key, 60, 10);
    assert.equal(outcome.allowed, false, 'no counting backend means no request is served');
    assert.equal(outcome.degraded, true);
    assert.equal(absent.isDegraded().reason, 'rpc-missing');
  });

  await t.test('a broken backend also fails closed in production', async () => {
    const broken = fakeCountingBackend({ fail: { code: '57014', message: 'canceling statement due to statement timeout' } });
    const limiter = createRateLimiter({ config: productionConfig(), supabase: broken, memoryFallback: false });
    const outcome = await limiter.hit('key', 60, 10);
    assert.equal(outcome.allowed, false);
    assert.equal(outcome.degraded, true);
    assert.equal(limiter.isDegraded().reason, 'rpc-error');
  });

  await t.test('development falls back to an in-process window instead of refusing everything', async () => {
    const limiter = createRateLimiter({ config: baseConfig(), supabase: null, memoryFallback: true });
    assert.equal((await limiter.hit('dev-key', 60, 2)).allowed, true);
    assert.equal((await limiter.hit('dev-key', 60, 2)).allowed, true);
    assert.equal((await limiter.hit('dev-key', 60, 2)).allowed, false);
  });

  await t.test('forwarded addresses are only trusted on the Vercel runtime', () => {
    const spoofed = fakeRequest({ headers: { 'x-forwarded-for': '1.2.3.4' }, remoteAddress: '10.0.0.9' });
    const outsideVercel = createRateLimiter({ config: baseConfig({ vercel: false }), supabase: null });
    assert.equal(outsideVercel.clientIp(spoofed), '10.0.0.9', 'an attacker-controlled header is ignored');

    const vercelConfig = baseConfig({ vercel: true });
    const onVercel = createRateLimiter({ config: vercelConfig, supabase: null });
    assert.equal(onVercel.clientIp(fakeRequest({ headers: { 'x-vercel-forwarded-for': '1.2.3.4, 10.0.0.1' } })), '1.2.3.4');
    assert.equal(onVercel.clientIp(fakeRequest({ headers: { 'x-real-ip': '5.6.7.8' } })), '5.6.7.8');
    assert.equal(onVercel.clientIp(fakeRequest({ remoteAddress: '10.0.0.9' })), '10.0.0.9', 'falls back to the socket');
  });

  await t.test('login and OTP endpoints are budgeted end to end', async () => {
    const backend = fakeCountingBackend();
    const config = baseConfig({ rateLimitSecret: 'k'.repeat(32), rateLimits: { ...baseConfig().rateLimits, donorVerify: 2, hospitalLogin: 2, donorStart: 2, windowSeconds: 60 } });
    const h = await startApi({ config, supabase: backend });
    try {
      const body = { phone: PHONE, code: '123456' };
      assert.equal((await h.request('/auth/donor/verify', { method: 'POST', body })).status, 200);
      assert.equal((await h.request('/auth/donor/verify', { method: 'POST', body })).status, 200);
      const limited = await h.request('/auth/donor/verify', { method: 'POST', body });
      assert.equal(limited.status, 429);
      assert.ok(limited.headers['retry-after']);

      // A different phone has its own budget: the limiter keys on identity, not on the instance.
      assert.equal((await h.request('/auth/donor/verify', { method: 'POST', body: { phone: '+919000000002', code: '123456' } })).status, 200);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await h.request('/auth/hospital', { method: 'POST', body: { email: 'admin@centralhospital.demo', password: 'wrong' } });
      }
      assert.equal((await h.request('/auth/hospital', { method: 'POST', body: { email: 'admin@centralhospital.demo', password: 'wrong' } })).status, 429);

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await h.request('/auth/donor/start', { method: 'POST', body: { phone: PHONE } });
      }
      assert.equal((await h.request('/auth/donor/start', { method: 'POST', body: { phone: PHONE } })).status, 429);
      // No raw phone number is stored in the backend.
      assert.equal(JSON.stringify(backend.calls).includes('919000000001'), false);
    } finally {
      await h.close();
    }
  });

  await t.test('a production deployment refuses credential traffic when counting is unavailable', async () => {
    const broken = fakeCountingBackend({ fail: { code: 'PGRST202', message: 'Could not find the function public.rate_limit_hit' } });
    const config = productionConfig();
    // The counting fake is not a database: state stays in memory for this test.
    const seed = createSeedState({ hospital: config.hospital, now: Date.now(), demo: false });
    const h = await startApi({
      config,
      supabase: broken,
      adapter: createMemoryAdapter(seed),
      seed,
      authProvider: fakeAuthProvider({ users: [] }),
    });
    try {
      const response = await h.request('/auth/hospital', { method: 'POST', body: { email: 'ops@hospital.example', password: 'x' } });
      assert.equal(response.status, 503);
      assert.match(response.body.error, /unavailable/i);
      assert.equal((await h.request('/auth/donor/verify', { method: 'POST', body: { phone: PHONE, code: '123456' } })).status, 503);
    } finally {
      await h.close();
    }
  });
});
