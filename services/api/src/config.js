// Central configuration loader.
//
// Fail-closed rules:
//  * In production (NODE_ENV=production, or any Vercel runtime) the API MUST be backed by
//    Supabase persistence and Supabase Auth, and MUST have a strong session secret and worker
//    secret. There is no demo fallback, ever.
//  * Missing production secrets are collected into `problems`. When `problems` is non-empty the
//    API answers every request with 503 (except GET /health, which reports the problems) instead
//    of silently degrading into an unauthenticated demo mode.
//  * Demo helpers (seeded accounts, fixed OTP, in-memory state) are EXPLICIT OPT-IN: they require
//    DEMO_MODE=true outside production. A local demo never talks to Supabase, even when live keys
//    are present in the environment.
//  * `warnings` are non-fatal deployment notes surfaced by /health (never secrets).

const DEFAULT_JWT_SECRET = 'local-development-only';
const DEFAULT_CRON_SECRET = 'dev-cron-secret-please-change';
const DEFAULT_DEV_OTP = '123456';

function isProductionRuntime(env) {
  return env.NODE_ENV === 'production' || Boolean(env.VERCEL) || Boolean(env.VERCEL_ENV);
}

function flag(value) {
  return String(value ?? '').trim().toLowerCase() === 'true';
}

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseOrigins(value) {
  return String(value || '')
    .split(',')
    .map(origin => origin.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function loadConfig(env = process.env) {
  const production = isProductionRuntime(env);
  const problems = [];
  const warnings = [];

  const supabaseUrl = env.SUPABASE_URL || null;
  const supabaseSecretKey = env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || null;
  const supabasePublishableKey = env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || null;
  const configuredJwtSecret = env.APP_JWT_SECRET || null;
  const configuredCronSecret = env.CRON_SECRET || null;

  // Explicit opt-in only: without DEMO_MODE=true the API runs in real (production-like) mode.
  const demoMode = !production && flag(env.DEMO_MODE);

  const corsOrigins = parseOrigins(env.CORS_ALLOWED_ORIGINS);

  const latitude = Number(env.HOSPITAL_LATITUDE);
  const longitude = Number(env.HOSPITAL_LONGITUDE);
  const validLatitude = Number.isFinite(latitude) && latitude >= -90 && latitude <= 90;
  const validLongitude = Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;

  if (production) {
    if (!supabaseUrl || !supabaseSecretKey) {
      problems.push('SUPABASE_URL and SUPABASE_SECRET_KEY are required in production: local/seed persistence is disabled.');
    }
    if (!supabaseUrl || !supabasePublishableKey) {
      problems.push('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required in production: demo authentication is disabled.');
    }
    if (!configuredJwtSecret || String(configuredJwtSecret).length < 32) {
      problems.push('APP_JWT_SECRET must be set to at least 32 characters in production.');
    }
    if (!configuredCronSecret || String(configuredCronSecret).length < 32) {
      problems.push('CRON_SECRET must be set to at least 32 random characters in production: the dispatch worker and request expiry depend on it.');
    }
    if (flag(env.DEMO_MODE)) {
      problems.push('DEMO_MODE=true is not permitted in production.');
    }
    if (flag(env.ALLOW_DEMO_CREDENTIALS)) {
      problems.push('ALLOW_DEMO_CREDENTIALS is not permitted in production.');
    }
    if (corsOrigins.length === 0) {
      warnings.push('CORS_ALLOWED_ORIGINS is not set: browser clients from other origins are blocked (native mobile requests are unaffected).');
    }
    if (corsOrigins.includes('*')) {
      problems.push('CORS_ALLOWED_ORIGINS must not contain "*" in production.');
    }
    // The configured facility is the ONLY facility this deployment serves (see `multiTenant`), so it
    // must be described with real values: no placeholder identity and no placeholder location may
    // silently become the hospital every donor is dispatched to.
    if (!String(env.HOSPITAL_ID || '').trim()) problems.push('HOSPITAL_ID is required in production: it is the tenant id operators must be provisioned with.');
    if (!String(env.HOSPITAL_NAME || '').trim()) problems.push('HOSPITAL_NAME is required in production: it is the facility name shown to donors.');
    if (!String(env.HOSPITAL_LICENSE || '').trim()) problems.push('HOSPITAL_LICENSE is required in production.');
    if (!validLatitude || !validLongitude) {
      problems.push('HOSPITAL_LATITUDE and HOSPITAL_LONGITUDE must be real, valid coordinates in production (placeholder locations are refused).');
    }
  }

  return {
    production,
    demoMode,
    problems,
    warnings,
    // Trusted-runtime flag: forwarded-IP headers are only honoured on Vercel.
    vercel: Boolean(env.VERCEL) || Boolean(env.VERCEL_ENV),
    // Single configured facility by default. A multi-tenant registry is not implemented, so a
    // production login whose trusted tenant differs from the configured one is rejected.
    multiTenant: flag(env.MULTI_TENANT),

    supabaseUrl,
    supabaseSecretKey,
    supabasePublishableKey,

    // Outside production a fixed development secret keeps local development and the test harness
    // working. In production both are null unless explicitly configured AND strong (see problems);
    // /health then reports the degraded capability instead of silently disabling the worker.
    jwtSecret: configuredJwtSecret || (production ? null : DEFAULT_JWT_SECRET),
    cronSecret: configuredCronSecret || (production ? null : DEFAULT_CRON_SECRET),
    // Fixed development OTP exists for local demo or when explicitly opted-in for local dev.
    devOtpCode: (!production && (demoMode || flag(env.ALLOW_DEV_OTP))) ? String(env.DEV_OTP_CODE || DEFAULT_DEV_OTP) : null,
    // Keys for the persistent rate limiter are HMACs; this secret makes them unforgeable.
    rateLimitSecret: env.RATE_LIMIT_SECRET || configuredJwtSecret || (production ? null : DEFAULT_JWT_SECRET),

    hospital: {
      id: env.HOSPITAL_ID || 'hospital-central',
      name: env.HOSPITAL_NAME || 'Central City Medical Centre',
      // The demo operator email exists only alongside demoMode; production has no default identity.
      email: String(env.HOSPITAL_EMAIL || (demoMode ? 'admin@centralhospital.demo' : '')).trim().toLowerCase(),
      // Only reachable while demoMode is enabled; there is no production password fallback.
      password: demoMode ? (env.HOSPITAL_PASSWORD || 'demo123') : null,
      licenseNumber: env.HOSPITAL_LICENSE || (production ? null : 'MH-EMR-2026-0021'),
      // null in production when unset: an invented location must never be used for dispatch.
      latitude: validLatitude ? latitude : (production ? null : 10.5276),
      longitude: validLongitude ? longitude : (production ? null : 76.2144),
    },
    hospitalId: String(env.HOSPITAL_ID || 'hospital-central'),

    corsOrigins: corsOrigins.length > 0 ? corsOrigins : (production ? [] : ['*']),

    sessionTtlMs: positiveInt(env.SESSION_TTL_MS, 7 * 24 * 60 * 60 * 1000),
    // How long a provider session check (getUser) may be cached per access token.
    authValidationCacheMs: positiveInt(env.AUTH_VALIDATION_CACHE_MS, 15000),
    requestTtlMs: positiveInt(env.REQUEST_TTL_MS, 60 * 60 * 1000),
    escalationSlaMs: positiveInt(env.ESCALATION_SLA_MS, 3 * 60 * 1000),
    stateRefreshMs: positiveInt(env.STATE_REFRESH_MS, 1000),
    storeMaxAttempts: positiveInt(env.STORE_MAX_ATTEMPTS, 5),

    // Worker envelope. The lease is always >= budget + 15s (enforced in drainOutbox) so a Vercel
    // invocation that is killed by the platform timeout can never leave a live lease behind.
    workerBatchSize: positiveInt(env.WORKER_BATCH_SIZE, 20),
    workerConcurrency: positiveInt(env.WORKER_CONCURRENCY, 5),
    workerBudgetMs: positiveInt(env.WORKER_BUDGET_MS, 45 * 1000),
    outboxMaxAttempts: positiveInt(env.OUTBOX_MAX_ATTEMPTS, 5),
    outboxBackoffMs: positiveInt(env.OUTBOX_BACKOFF_MS, 30 * 1000),
    outboxLeaseMs: positiveInt(env.OUTBOX_LEASE_MS, 60 * 1000),
    // Expo keeps receipts for ~24h; first check after a short delay, then back off.
    receiptPollDelayMs: positiveInt(env.EXPO_RECEIPT_DELAY_MS, 60 * 1000),
    receiptPollBackoffMs: positiveInt(env.EXPO_RECEIPT_BACKOFF_MS, 5 * 60 * 1000),
    receiptPollMaxAgeMs: positiveInt(env.EXPO_RECEIPT_MAX_AGE_MS, 24 * 60 * 60 * 1000),
    maxDevicesPerDonor: positiveInt(env.MAX_DEVICES_PER_DONOR, 5),

    expo: {
      endpoint: env.EXPO_PUSH_ENDPOINT || 'https://exp.host/--/api/v2/push/send',
      receiptEndpoint: env.EXPO_RECEIPT_ENDPOINT || 'https://exp.host/--/api/v2/push/getReceipts',
      accessToken: env.EXPO_ACCESS_TOKEN || null,
      // Contract: all emergency dispatch alerts use this Android notification channel.
      channelId: env.EXPO_CHANNEL_ID || 'emergency-blood-alerts',
      timeoutMs: positiveInt(env.EXPO_TIMEOUT_MS, 10000),
    },

    rateLimits: {
      hospitalLogin: positiveInt(env.RATE_LIMIT_HOSPITAL_LOGIN, 20),
      donorStart: positiveInt(env.RATE_LIMIT_DONOR_START, 10),
      donorVerify: positiveInt(env.RATE_LIMIT_DONOR_VERIFY, 20),
      worker: positiveInt(env.RATE_LIMIT_WORKER, 60),
      windowMs: positiveInt(env.RATE_LIMIT_WINDOW_MS, 60 * 1000),
      windowSeconds: Math.max(1, Math.round(positiveInt(env.RATE_LIMIT_WINDOW_MS, 60 * 1000) / 1000)),
    },
  };
}

export function describeAuthMode(config) {
  if (config.problems.length > 0) return 'misconfigured';
  if (config.demoMode) return 'development-demo';
  if (config.supabaseUrl && config.supabasePublishableKey) return 'supabase-auth';
  return 'supabase-auth-unavailable';
}

export { DEFAULT_JWT_SECRET };
