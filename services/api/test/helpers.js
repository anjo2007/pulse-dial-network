// Shared test helpers. Every app instance built here is fully offline: Supabase clients are forced
// to null, state lives in an in-memory adapter and push delivery is either mocked or dry-run.
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { createApi } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createSeedState } from '../src/domain.js';
import { createMemorySender } from '../src/outbox.js';
import { createMemoryAdapter } from '../src/store.js';

const silentLogger = { info() {}, warn() {}, error() {} };

// Offline stand-in for the 004 counting function: a real (in-process) counter with the same
// call shape, used only to keep production-config tests from tripping the fail-closed path.
export function createCountingBackend() {
  const counters = new Map();
  return {
    counters,
    rpc(name, args) {
      if (name !== 'rate_limit_hit') {
        return Promise.resolve({ data: null, error: { code: 'PGRST202', message: `Could not find the function ${name}` } });
      }
      const key = `${args.p_key}|${args.p_window_seconds}`;
      const hits = (counters.get(key) || 0) + 1;
      counters.set(key, hits);
      return Promise.resolve({ data: hits <= args.p_limit, error: null });
    },
  };
}

export function baseConfig(overrides = {}) {
  // Demo fixtures are explicit opt-in, so the harness opts in exactly like a developer would.
  const base = loadConfig({ NODE_ENV: 'test', DEMO_MODE: 'true' });
  return {
    ...base,
    ...overrides,
    hospital: { ...base.hospital, ...(overrides.hospital || {}) },
    expo: { ...base.expo, ...(overrides.expo || {}) },
    rateLimits: { ...base.rateLimits, ...(overrides.rateLimits || {}) },
  };
}

// A complete production environment. Production refuses placeholder facilities, so every test that
// wants a healthy production config must describe a real one.
export function productionEnv(extra = {}) {
  return {
    NODE_ENV: 'production',
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SECRET_KEY: 'service-role-key',
    SUPABASE_PUBLISHABLE_KEY: 'publishable-key',
    APP_JWT_SECRET: 'p'.repeat(40),
    CRON_SECRET: 'c'.repeat(32),
    CORS_ALLOWED_ORIGINS: 'https://console.example.com',
    HOSPITAL_ID: 'hospital-central',
    HOSPITAL_NAME: 'Central City Medical Centre',
    HOSPITAL_LICENSE: 'MH-EMR-2026-0021',
    HOSPITAL_LATITUDE: '10.5276',
    HOSPITAL_LONGITUDE: '76.2144',
    ...extra,
  };
}

export function productionConfig(overrides = {}) {
  const base = loadConfig(productionEnv());
  const merged = { ...base, ...overrides };
  return {
    ...merged,
    hospital: { ...base.hospital, ...(overrides.hospital || {}) },
    expo: { ...base.expo, ...(overrides.expo || {}) },
    rateLimits: { ...base.rateLimits, ...(overrides.rateLimits || {}) },
  };
}

export function mintToken(config, subject, { ttlMs = 3600000, secret } = {}) {
  const key = secret || config.jwtSecret;
  const payload = Buffer.from(JSON.stringify({ iat: Date.now(), exp: Date.now() + ttlMs, ...subject })).toString('base64url');
  const signature = createHmac('sha256', key).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export async function startApi(options = {}) {
  const config = options.config || baseConfig();
  // The harness never fabricates demo fixtures implicitly: the same demo flag the app uses.
  const seed = options.seed || createSeedState({ hospital: config.hospital, now: Date.now(), demo: config.demoMode });
  const adapter = options.adapter || createMemoryAdapter(seed);
  const deps = {
    config,
    adapter,
    seed,
    logger: silentLogger,
    dryRunPush: options.dryRunPush === true,
  };
  if (options.rateLimiter) deps.rateLimiter = options.rateLimiter;
  if (options.raw !== true) {
    // Force offline: never construct real Supabase clients in tests, even when the config carries a
    // Supabase URL (which would otherwise build a live client). A fake may be injected explicitly.
    // A production config also needs a reachable counting backend, because the API refuses
    // credential traffic without one (fail closed); this stands in for migration 004.
    deps.supabase = options.supabase === undefined
      ? (config.production ? createCountingBackend() : null)
      : options.supabase;
    deps.authProvider = options.authProvider === undefined ? null : options.authProvider;
  } else if (options.authProvider !== undefined) {
    deps.authProvider = options.authProvider;
  }
  if (options.sender) deps.sender = options.sender;
  else if (!options.fetchImpl) deps.sender = createMemorySender();
  else deps.fetchImpl = options.fetchImpl;

  const api = createApi(deps);
  await api.initialize();

  const server = http.createServer(api.app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function request(path, { method = 'GET', token, body, headers = {} } = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await response.json().catch(() => null);
    const responseHeaders = {};
    response.headers.forEach((value, key) => { responseHeaders[key] = value; });
    return { status: response.status, body: parsed, headers: responseHeaders };
  }

  return {
    api,
    config,
    store: api.store,
    sender: api.sender,
    baseUrl,
    request,
    async state() {
      return api.store.read();
    },
    async loginHospital(body = { email: config.hospital.email, password: config.hospital.password }) {
      const result = await request('/auth/hospital', { method: 'POST', body });
      return result;
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
    },
  };
}

// Minimal offline stand-in for a Supabase auth provider. `clients` records every scoped client the
// API created, which is how the tests prove one client is never shared between callers.
export function fakeAuthProvider({ users = [], getUser } = {}) {
  const clients = [];
  return {
    clients,
    create() {
      const client = {
        auth: {
          signInWithPassword: async ({ email, password }) => {
            const record = users.find(user => user.email === email && user.password === password);
            if (!record) return { data: { user: null, session: null }, error: { message: 'Invalid login credentials' } };
            return { data: { user: record.user, session: record.session }, error: null };
          },
          signInWithOtp: async () => ({ error: null }),
          verifyOtp: async ({ phone, token }) => {
            const record = users.find(user => user.phone === phone);
            if (!record || record.otp !== token) return { data: { user: null }, error: { message: 'invalid' } };
            return { data: { user: record.user, session: record.session }, error: null };
          },
          getUser: async (accessToken) => {
            if (getUser) return getUser(accessToken);
            const record = users.find(user => user.session?.access_token === accessToken);
            if (!record) return { data: { user: null }, error: { message: 'invalid token' } };
            return { data: { user: record.user }, error: null };
          },
        },
      };
      clients.push(client);
      return client;
    },
  };
}

export function hospitalAuthUser({
  id = 'user-1',
  email = 'ops@hospital.example',
  password = 'operator-password-1',
  role = 'hospital',
  hospitalId = 'hospital-central',
  userMetadata = {},
  appMetadata = {},
  sessionSeconds = 3600,
} = {}) {
  // Pass null (not undefined) to OMIT a claim: destructuring defaults would otherwise restore the
  // default value for an explicit `undefined`.
  const claims = {};
  if (role) claims.role = role;
  if (hospitalId) claims.hospital_id = hospitalId;
  return {
    email,
    password,
    phone: `+1555${String(id).replace(/\D/g, '').padStart(7, '0')}`,
    otp: '654321',
    user: {
      id,
      email,
      user_metadata: userMetadata,
      app_metadata: { ...claims, ...appMetadata },
    },
    session: {
      access_token: `token-${id}`,
      expires_at: Math.floor(Date.now() / 1000) + sessionSeconds,
    },
  };
}

export const DEMO_DONOR_PHONE = '+919000000001';
export const INVALID_DONOR_PHONE = '+919000099999';

export async function loginDonor(harness, phone = DEMO_DONOR_PHONE) {
  return harness.request('/auth/donor/verify', { method: 'POST', body: { phone, code: harness.config.devOtpCode || '123456' } });
}
