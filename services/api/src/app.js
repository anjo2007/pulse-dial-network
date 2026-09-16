// Pulse Dial API application factory.
//
// Security posture:
//  * Fail closed. If configuration is incomplete in production, every route answers 503 and only
//    /health explains why. There is no demo-credential and no fixed-OTP fallback in production.
//  * Tenant isolation. Every hospital request/assignment is scoped to the authenticated hospital
//    tenant; cross-tenant access returns 404 so existence is never leaked.
//  * Least data. Responses never include hospital passwords, session tokens for other roles or
//    push credentials; error payloads never echo provider internals.
import cors from 'cors';
import 'express-async-errors';
import express from 'express';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import {
  ACTIVE_ASSIGNMENT_STATUSES, CLOSED_REQUEST_STATUSES, COMPLETION_BONUS, DECLINE_PENALTY,
  checkinTokenFor, clampReliability, createSeedState, dispatchTier, donorView,
  isValidPhone, normalizePhone, requestHospitalId, requestView, validateDeviceInput,
  validateDonorRegistration, validateRequestInput,
} from './domain.js';
import {
  cancelOutboxForAssignment, claimDue, createExpoSender, drainOutbox, enqueueDispatchNotifications,
  outboxStats, settle,
} from './outbox.js';
import { describeAuthMode } from './config.js';
import { createRateLimiter } from './ratelimit.js';
import { createMemoryAdapter, createStore, createSupabaseAdapter, StateConflictError } from './store.js';

const noopLogger = { info() {}, warn() {}, error() {} };

function createLogger(base = {}) {
  return {
    info: payload => console.log(JSON.stringify({ level: 'info', ...base, ...payload })),
    warn: payload => console.warn(JSON.stringify({ level: 'warn', ...base, ...payload })),
    error: payload => console.error(JSON.stringify({ level: 'error', ...base, ...payload })),
  };
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

const TRUSTED_HOSPITAL_ROLE = 'hospital';
const TENANT_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

// TRUSTED claims only. `app_metadata` is service-controlled (admin API / service role), so it is
// the only place a hospital role and tenant may come from. `user_metadata` is editable by the user
// themselves and is deliberately never read: a self-signup email account can never obtain hospital
// access, and a user cannot move themselves into another tenant.
export function readTrustedHospitalClaims(user) {
  const metadata = user?.app_metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  if (metadata.role !== TRUSTED_HOSPITAL_ROLE) return null;
  const hospitalId = typeof metadata.hospital_id === 'string' ? metadata.hospital_id.trim() : '';
  if (!TENANT_PATTERN.test(hospitalId)) return null;
  return { hospitalId };
}

// Credential rate limiting lives in ./ratelimit.js: it counts in Postgres (shared across serverless
// instances), keys on a keyed HMAC instead of a raw email/phone/credential, and fails closed in
// production when the counting backend is missing.

export function createApi(options = {}) {
  const { config } = options;
  const clock = options.clock || (() => Date.now());
  const logger = options.logger || (config.production ? createLogger({ service: 'pulse-dial-api' }) : noopLogger);
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  // Persistence client: service role, used ONLY for state I/O. It is never used to represent an
  // end user and never carries a caller's session.
  const supabase = options.supabase !== undefined ? options.supabase
    : (config.supabaseUrl && config.supabaseSecretKey && !config.demoMode
      ? createClient(config.supabaseUrl, config.supabaseSecretKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
      : null);

  // Auth provider is a FACTORY, not a shared client. A single mutable auth client would let
  // concurrent requests observe each other's session; every sign-in / OTP / getUser call gets its
  // own scoped client that never persists a session.
  const authProvider = (() => {
    // Demo mode is fully offline: it never consults a provider, so a local demo cannot sign in
    // against, or leak traffic to, a live Supabase project.
    if (config.demoMode) return null;
    if (options.authProvider !== undefined) return options.authProvider;
    if (options.supabaseAuth) return { create: () => options.supabaseAuth };
    if (config.supabaseUrl && config.supabasePublishableKey && !config.demoMode) {
      return {
        create: () => createClient(config.supabaseUrl, config.supabasePublishableKey, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        }),
      };
    }
    return null;
  })();
  const supabaseAuthAvailable = Boolean(authProvider);

  // A production process must never start on demo fixtures, whatever a caller injects.
  if (config.production && options.seed) {
    const collections = ['donors', 'requests', 'assignments', 'devices', 'outbox'];
    if (collections.some(key => Array.isArray(options.seed[key]) && options.seed[key].length > 0)) {
      throw new Error('Refusing to start: a production process was given seeded demo data.');
    }
  }
  const seed = config.production
    ? createSeedState({ hospital: config.hospital, now: clock(), demo: false })
    : (options.seed || createSeedState({ hospital: config.hospital, now: clock(), demo: config.demoMode }));
  // A demo environment is ALWAYS in-memory: even if live Supabase keys are present in the
  // environment, an explicit local demo must never read or write a real project.
  const adapter = options.adapter
    || (supabase && !config.demoMode ? createSupabaseAdapter(supabase) : createMemoryAdapter(seed));
  const store = options.store || createStore({ adapter, seed, maxAttempts: config.storeMaxAttempts, logger });

  const sender = options.sender === undefined
    ? createExpoSender({ config, fetchImpl, logger, dryRun: options.dryRunPush === true })
    : options.sender;

  const limiter = options.rateLimiter || createRateLimiter({
    config,
    supabase,
    clock,
    logger,
    // Only a local (non-production) environment may fall back to an in-process counter.
    memoryFallback: !config.production,
  });

  const misconfigured = config.problems.length > 0;

  /* ---------------------------------------------------------------- session helpers */

  function issueSession(subject, ttlMs = config.sessionTtlMs) {
    const payload = Buffer.from(JSON.stringify({ ...subject, iat: clock(), exp: clock() + ttlMs })).toString('base64url');
    const signature = createHmac('sha256', config.jwtSecret).update(payload).digest('base64url');
    return `${payload}.${signature}`;
  }

  // Provider-session validation (production protected routes). Cached briefly per access token so a
  // burst of requests does not hammer the auth provider; a revoked session is rejected as soon as
  // the cache entry expires.
  const providerSessionCache = new Map();

  async function verifyHospitalProviderSession(providerToken) {
    if (!authProvider) return { ok: false, reason: 'no-provider' };
    const key = createHash('sha256').update(providerToken).digest('base64url');
    const nowMs = clock();
    const cached = providerSessionCache.get(key);
    if (cached && cached.expiresAtMs > nowMs) return cached.result;

    let result;
    try {
      const client = authProvider.create();
      const { data, error } = await client.auth.getUser(providerToken);
      if (error || !data?.user) {
        result = { ok: false, reason: 'revoked' };
      } else {
        const claims = readTrustedHospitalClaims(data.user);
        result = claims ? { ok: true, tenantId: claims.hospitalId } : { ok: false, reason: 'claims' };
      }
    } catch {
      result = { ok: false, reason: 'provider-error' };
    }
    if (providerSessionCache.size > 500) providerSessionCache.clear();
    providerSessionCache.set(key, { result, expiresAtMs: nowMs + config.authValidationCacheMs });
    return result;
  }

  function readSession(token) {
    if (!config.jwtSecret || typeof token !== 'string' || !token.includes('.')) return null;
    const [payload, signature] = token.split('.');
    const expected = createHmac('sha256', config.jwtSecret).update(payload).digest('base64url');
    if (!safeEqual(signature, expected)) return null;
    try {
      const subject = JSON.parse(Buffer.from(payload, 'base64url').toString());
      return Number(subject.exp) > clock() ? subject : null;
    } catch {
      return null;
    }
  }

  function authAny(...roles) {
    return async (req, res, next) => {
      const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const subject = readSession(token);
      if (!subject || !roles.includes(subject.role)) return res.status(401).json({ error: 'Please sign in to continue.' });
      if (subject.role === 'hospital' && !config.demoMode) {
        // Production: the provider session must still be alive and still carry trusted claims, so a
        // revoked or demoted operator loses access immediately even with a valid signed cookie.
        if (!subject.providerToken) return res.status(401).json({ error: 'Please sign in to continue.' });
        const verification = await verifyHospitalProviderSession(subject.providerToken);
        if (!verification.ok) return res.status(401).json({ error: 'Please sign in to continue.' });
        subject.tenantId = verification.tenantId;
      }
      if (subject.role === 'hospital' && !subject.tenantId) subject.tenantId = config.hospitalId;
      req.subject = subject;
      return next();
    };
  }

  const auth = role => authAny(role);

  /* ---------------------------------------------------------------- middlewares */

  const app = express();
  app.disable('x-powered-by');

  // Security headers. This is a JSON API holding auth tokens and medical dispatch data, so nothing
  // may be cached and nothing may be framed or sniffed.
  app.use((_req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'no-referrer');
    res.set('X-Frame-Options', 'DENY');
    res.set('Cross-Origin-Resource-Policy', 'same-site');
    res.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    if (config.production) res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });

  // Explicit CORS allowlist. Production never uses a wildcard and never sends credentials.
  const allowedOrigins = new Set(config.corsOrigins.map(origin => origin.replace(/\/$/, '')));
  app.use(cors({
    origin(origin, callback) {
      // No Origin header (native apps, curl, cron) is not a cross-origin browser request.
      if (!origin) return callback(null, true);
      const normalized = origin.replace(/\/$/, '');
      if (allowedOrigins.has('*') && !config.production) return callback(null, true);
      return callback(null, allowedOrigins.has(normalized));
    },
    credentials: false,
    allowedHeaders: ['Content-Type', 'Authorization'],
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    maxAge: 600,
  }));
  app.use(express.json({ limit: '64kb' }));

  // Local development uses /auth; Vercel's catch-all function receives /api/auth.
  app.use((req, _res, next) => {
    if (req.url === '/api') req.url = '/';
    else if (req.url.startsWith('/api/')) req.url = req.url.slice(4);
    next();
  });

  app.use((req, res, next) => {
    req.requestId = randomUUID();
    const startedAt = clock();
    res.on('finish', () => {
      // Never log request bodies: they can contain credentials, OTPs and push tokens.
      logger.info({ event: 'http_request', requestId: req.requestId, method: req.method, path: req.baseUrl + req.path.split('?')[0], status: res.statusCode, durationMs: clock() - startedAt });
    });
    next();
  });

  const healthCapabilities = {
    cancelRequest: true,
    requestExpiry: true,
    dispatchWorker: Boolean(config.cronSecret),
    donorDevices: true,
    providerSessionValidation: supabaseAuthAvailable && !config.demoMode,
    tenantIsolation: true,
  };

  // Liveness AND readiness: a reachable process with a broken/missing database is reported as
  // unhealthy, so a deploy with unapplied migrations fails the platform health check instead of
  // serving 500s behind a green light.
  app.get('/health', async (_req, res) => {
    if (misconfigured) {
      return res.status(503).json({
        status: 'error',
        misconfigured: true,
        service: 'pulse-dial-api',
        persistence: 'unavailable',
        problems: config.problems,
        warnings: config.warnings,
        capabilities: healthCapabilities,
      });
    }
    let state;
    try {
      state = await store.read({ maxAgeMs: 0 });
      if (!Array.isArray(state?.donors) || !Array.isArray(state?.requests) || !Array.isArray(state?.outbox) || !Array.isArray(state?.devices)) {
        throw new Error('Application state is missing expected collections.');
      }
    } catch {
      logger.error({ event: 'health_state_probe_failed' });
      return res.status(503).json({
        status: 'error',
        misconfigured: false,
        service: 'pulse-dial-api',
        persistence: 'unavailable',
        error: 'Application state is unavailable. Check the database and applied migrations.',
        capabilities: healthCapabilities,
      });
    }
    return res.json({
      status: 'ok',
      service: 'pulse-dial-api',
      persistence: store.adapterKind,
      demoMode: config.demoMode,
      supabaseConfigured: Boolean(supabase),
      authentication: describeAuthMode(config),
      // No global counters: /health is unauthenticated, so it must not leak network size or
      // dispatch volume. Callers use the authenticated, tenant-scoped endpoints for that.
      stateReadable: true,
      capabilities: healthCapabilities,
      warnings: config.warnings,
    });
  });

  // Fail closed: a misconfigured production deployment refuses all work.
  app.use((req, res, next) => {
    if (!misconfigured) return next();
    return res.status(503).json({ error: 'The service is not configured for production use.', problems: config.problems });
  });

  /* ---------------------------------------------------------------- auth routes */

  app.post('/auth/hospital', limiter.limit('hospital-login', {
    limit: config.rateLimits.hospitalLogin,
    // Keyed on the submitted email (hashed), falling back to the caller address when absent.
    identify: req => ({ kind: 'email', value: req.body?.email }),
  }), async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (!email || !password) return res.status(400).json({ error: 'Enter your hospital email and password.' });

    let authUserId = null;
    let tenantId = null;
    let authenticated = false;

    let providerToken = null;
    let providerExpiresAtMs = null;

    if (authProvider) {
      try {
        // A fresh, non-persisting client per sign-in: no shared mutable auth state across requests.
        const client = authProvider.create();
        const { data, error } = await client.auth.signInWithPassword({ email, password });
        const claims = data?.user ? readTrustedHospitalClaims(data.user) : null;
        if (!error && data?.user?.id && claims) {
          const state = await store.read({ maxAgeMs: config.stateRefreshMs });
          const currentHospital = state?.hospital || state?.hospitalConfig || config.hospital;
          const expectedHospitalId = currentHospital.id || config.hospitalId;
          // This deployment serves exactly ONE configured facility (no per-tenant registry). A
          // trusted operator from a different facility is refused outright rather than being served
          // the wrong facility name and location.
          if (config.production && !config.multiTenant && claims.hospitalId !== expectedHospitalId) {
            logger.warn({ event: 'hospital_tenant_mismatch', requestId: req.requestId });
            return res.status(401).json({ error: 'Invalid hospital credentials.' });
          }
          authUserId = data.user.id;
          tenantId = claims.hospitalId;
          providerToken = data.session?.access_token || null;
          const expiresAtSeconds = Number(data.session?.expires_at);
          if (Number.isFinite(expiresAtSeconds) && expiresAtSeconds > 0) providerExpiresAtMs = expiresAtSeconds * 1000;
          authenticated = true;
        } else if (!error && data?.user) {
          // Valid Supabase account without trusted service-side claims (for example a self-signup
          // email user): never hospital access.
          logger.warn({ event: 'hospital_login_untrusted_principal', requestId: req.requestId });
        }
      } catch {
        logger.warn({ event: 'hospital_auth_provider_error', requestId: req.requestId });
      }
    }

    // Demo credentials exist only for an explicit local demo (DEMO_MODE=true outside production).
    if (!authenticated && config.demoMode) {
      const state = await store.read({ maxAgeMs: config.stateRefreshMs });
      const currentHospital = state?.hospital || state?.hospitalConfig || config.hospital;
      const demoEmail = currentHospital.email || config.hospital.email;
      const demoPassword = currentHospital.password || config.hospital.password;
      if (demoEmail && demoPassword && email === demoEmail && password === demoPassword) {
        authenticated = true;
        tenantId = currentHospital.id || config.hospitalId;
      }
    }

    if (!authenticated) return res.status(401).json({ error: 'Invalid hospital credentials.' });

    // The application session may not outlive the provider session it was derived from.
    const ttlMs = providerExpiresAtMs
      ? Math.min(config.sessionTtlMs, providerExpiresAtMs - clock())
      : config.sessionTtlMs;
    if (ttlMs <= 0) return res.status(401).json({ error: 'Invalid hospital credentials.' });

    const state = await store.read({ maxAgeMs: config.stateRefreshMs });
    const currentHospital = state?.hospital || state?.hospitalConfig || config.hospital;
    const token = issueSession({ role: 'hospital', id: currentHospital.id || config.hospitalId, tenantId, authUserId, providerToken }, ttlMs);
    res.json({
      token,
      hospital: {
        id: currentHospital.id || config.hospital.id,
        name: currentHospital.name || config.hospital.name,
        email: currentHospital.email || email,
        licenseNumber: currentHospital.licenseNumber || config.hospital.licenseNumber,
        latitude: currentHospital.latitude ?? config.hospital.latitude,
        longitude: currentHospital.longitude ?? config.hospital.longitude,
      },
    });
  });

  app.post('/auth/donor/start', limiter.limit('donor-start', {
    limit: config.rateLimits.donorStart,
    identify: req => ({ kind: 'phone', value: normalizePhone(req.body?.phone) }),
  }), async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    if (!isValidPhone(phone)) return res.status(400).json({ error: 'Enter an international phone number, such as +919000000001.' });

    if (authProvider) {
      try {
        const client = authProvider.create();
        const { error } = await client.auth.signInWithOtp({ phone });
        if (!error) return res.json({ delivery: 'sms', message: 'A verification code was sent to your phone.' });
      } catch {
        logger.warn({ event: 'donor_otp_provider_error', requestId: req.requestId });
      }
      if (!config.devOtpCode) return res.status(502).json({ error: 'We could not send a verification code right now. Please try again.' });
    }

    if (config.devOtpCode) return res.json({ delivery: 'development', message: `Verification code sent (use ${config.devOtpCode}).` });
    return res.status(503).json({ error: 'SMS verification is not configured for this environment.' });
  });

  app.post('/auth/donor/verify', limiter.limit('donor-verify', {
    limit: config.rateLimits.donorVerify,
    identify: req => ({ kind: 'phone', value: normalizePhone(req.body?.phone) }),
  }), async (req, res) => {
    const phone = normalizePhone(req.body?.phone);
    const code = String(req.body?.code ?? '').trim();
    if (!isValidPhone(phone)) return res.status(400).json({ error: 'Enter an international phone number, such as +919000000001.' });
    if (!/^\d{4,8}$/.test(code)) return res.status(400).json({ error: 'Enter the verification code from your SMS.' });

    let authUserId = null;
    let providerToken = null;
    let providerExpiresAtMs = null;
    const isDevCode = Boolean(config.devOtpCode) && code === config.devOtpCode;
    if (!isDevCode) {
      if (!authProvider) return res.status(503).json({ error: 'SMS verification is not configured for this environment.' });
      try {
        const client = authProvider.create();
        const { data, error } = await client.auth.verifyOtp({ phone, token: code, type: 'sms' });
        if (error || !data?.user) return res.status(401).json({ error: 'The verification code is invalid or expired.' });
        authUserId = data.user.id;
        providerToken = data.session?.access_token || null;
        const expiresAtSeconds = Number(data.session?.expires_at);
        if (Number.isFinite(expiresAtSeconds) && expiresAtSeconds > 0) providerExpiresAtMs = expiresAtSeconds * 1000;
      } catch {
        logger.warn({ event: 'donor_otp_verify_error', requestId: req.requestId });
        return res.status(401).json({ error: 'The verification code is invalid or expired.' });
      }
    }

    // Location is optional and NEVER invented. Without a measured, valid coordinate pair the donor is
    // stored with nulls and is simply not dispatchable (match() requires a measured location), rather
    // than being placed at a hospital-relative guess that would misroute an emergency.
    const rawLatitude = req.body?.latitude;
    const rawLongitude = req.body?.longitude;
    const hasLatitude = rawLatitude !== undefined && rawLatitude !== null && rawLatitude !== '';
    const hasLongitude = rawLongitude !== undefined && rawLongitude !== null && rawLongitude !== '';
    if (hasLatitude !== hasLongitude) return res.status(400).json({ error: 'Provide both a latitude and a longitude, or neither.' });
    let registrationLatitude = null;
    let registrationLongitude = null;
    if (hasLatitude) {
      const latitudeValue = Number(rawLatitude);
      const longitudeValue = Number(rawLongitude);
      if (!Number.isFinite(latitudeValue) || latitudeValue < -90 || latitudeValue > 90) return res.status(400).json({ error: 'Latitude is invalid.' });
      if (!Number.isFinite(longitudeValue) || longitudeValue < -180 || longitudeValue > 180) return res.status(400).json({ error: 'Longitude is invalid.' });
      registrationLatitude = latitudeValue;
      registrationLongitude = longitudeValue;
    }

    const outcome = await store.mutate(state => {
      const donor = state.donors.find(item => (authUserId && item.authUserId === authUserId) || item.phone === phone);
      if (donor) {
        if (authUserId && donor.authUserId !== authUserId) donor.authUserId = authUserId;
        donor.lastSeenAt = new Date(clock()).toISOString();
        return { donor: structuredClone(donor), created: false };
      }
      const profileError = validateDonorRegistration(req.body, clock());
      if (profileError) return { error: profileError };
      const created = {
        id: randomUUID(),
        phone,
        authUserId,
        fullName: String(req.body.fullName).trim(),
        bloodType: req.body.bloodType,
        dateOfBirth: req.body.dateOfBirth,
        sex: String(req.body.sex || 'UNSPECIFIED').toUpperCase(),
        weightKg: Number(req.body.weightKg),
        consentAccepted: true,
        latitude: registrationLatitude,
        longitude: registrationLongitude,
        reliabilityScore: 100,
        isAvailable: true,
        lastDonationDate: req.body.lastDonationDate,
        lastSeenAt: new Date(clock()).toISOString(),
      };
      state.donors.push(created);
      return { donor: structuredClone(created), created: true };
    });

    if (outcome.error) return res.status(400).json({ error: outcome.error });
    // Donor sessions may not outlive the provider session they were derived from either.
    const donorTtlMs = providerExpiresAtMs
      ? Math.min(config.sessionTtlMs, providerExpiresAtMs - clock())
      : config.sessionTtlMs;
    if (donorTtlMs <= 0) return res.status(401).json({ error: 'The verification code is invalid or expired.' });
    const token = issueSession({ role: 'donor', id: outcome.donor.id, authUserId, providerToken }, donorTtlMs);
    res.json({ token, donor: donorView(outcome.donor, clock()) });
  });

  /* ---------------------------------------------------------------- hospital routes */

  function findTenantRequest(req, state) {
    const tenantId = req.subject.tenantId || req.subject.id;
    return state.requests.find(item => item.id === req.params.id && requestHospitalId(item, config) === tenantId) || null;
  }

  // Withdraws every still-live assignment of a request: the arrival token is cleared so a scanned
  // or replayed token can never complete a request that was cancelled, expired or closed, and the
  // donor's own history is left untouched (no donation is recorded for a withdrawal).
  function withdrawAssignments(state, request, reason, now, { exceptAssignmentId = null } = {}) {
    let withdrawn = 0;
    for (const assignment of state.assignments) {
      if (assignment.requestId !== request.id) continue;
      if (exceptAssignmentId && assignment.id === exceptAssignmentId) continue;
      if (!ACTIVE_ASSIGNMENT_STATUSES.includes(assignment.status)) continue;
      assignment.status = 'CANCELLED';
      assignment.cancelledAt = new Date(now).toISOString();
      assignment.checkinToken = null;
      assignment.withdrawnReason = reason;
      cancelOutboxForAssignment(state, assignment.id, reason, now);
      withdrawn += 1;
    }
    return withdrawn;
  }

  app.get('/hospital/profile', auth('hospital'), async (req, res) => {
    const state = await store.read({ maxAgeMs: config.stateRefreshMs });
    const hospital = state.hospital || state.hospitalConfig || config.hospital;
    res.json({
      id: hospital.id || config.hospitalId,
      name: hospital.name || config.hospital.name,
      email: hospital.email || config.hospital.email,
      licenseNumber: hospital.licenseNumber || config.hospital.licenseNumber,
      latitude: hospital.latitude ?? config.hospital.latitude,
      longitude: hospital.longitude ?? config.hospital.longitude,
    });
  });

  app.patch('/hospital/profile', auth('hospital'), async (req, res) => {
    const { name, licenseNumber, latitude, longitude } = req.body || {};
    if (name !== undefined && (!name || typeof name !== 'string' || !name.trim())) {
      return res.status(400).json({ error: 'Hospital name cannot be empty.' });
    }
    if (licenseNumber !== undefined && (!licenseNumber || typeof licenseNumber !== 'string' || !licenseNumber.trim())) {
      return res.status(400).json({ error: 'License number cannot be empty.' });
    }
    if (latitude !== undefined && (!Number.isFinite(Number(latitude)) || Number(latitude) < -90 || Number(latitude) > 90)) {
      return res.status(400).json({ error: 'Latitude is invalid.' });
    }
    if (longitude !== undefined && (!Number.isFinite(Number(longitude)) || Number(longitude) < -180 || Number(longitude) > 180)) {
      return res.status(400).json({ error: 'Longitude is invalid.' });
    }

    const now = clock();
    const result = await store.mutate(state => {
      if (!state.hospital) {
        state.hospital = structuredClone(state.hospitalConfig || config.hospital);
      }
      if (name !== undefined) state.hospital.name = name.trim();
      if (licenseNumber !== undefined) state.hospital.licenseNumber = licenseNumber.trim();
      if (latitude !== undefined) state.hospital.latitude = Number(latitude);
      if (longitude !== undefined) state.hospital.longitude = Number(longitude);

      state.hospitalConfig = {
        id: state.hospital.id,
        name: state.hospital.name,
        latitude: state.hospital.latitude,
        longitude: state.hospital.longitude,
      };

      state.updatedAt = new Date(now).toISOString();
      return { status: 200, hospital: state.hospital };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.hospital);
  });

  app.get('/hospital/requests', auth('hospital'), async (req, res) => {
    const state = await store.read({ maxAgeMs: config.stateRefreshMs });
    const tenantId = req.subject.tenantId || req.subject.id;
    const list = state.requests.filter(item => requestHospitalId(item, config) === tenantId).map(item => requestView(state, item));
    res.json(list);
  });

  app.post('/hospital/requests', auth('hospital'), async (req, res) => {
    const parsed = validateRequestInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const now = clock();
    const tenantId = req.subject.tenantId || req.subject.id;
    const created = await store.mutate(state => {
      const request = {
        id: randomUUID(),
        hospitalId: tenantId,
        bloodType: parsed.value.bloodType,
        unitsNeeded: parsed.value.unitsNeeded,
        urgency: parsed.value.urgency,
        status: 'DISPATCHING',
        currentRadiusKm: 1,
        createdAt: new Date(now).toISOString(),
        lastDispatchAt: null,
        expiresAt: new Date(now + config.requestTtlMs).toISOString(),
        cancelledAt: null,
      };
      state.requests.unshift(request);
      const hospitalProfile = state.hospital || state.hospitalConfig || config.hospital;
      dispatchTier({
        state, request, radius: 1, tier: 1, hospital: hospitalProfile, now,
        onAssignment: (assignment) => enqueueDispatchNotifications({ state, assignment, request, config, now }),
      });
      state.updatedAt = new Date(now).toISOString();
      return requestView(state, request);
    });
    return res.status(201).json(created);
  });

  app.post('/hospital/requests/:id/escalate', auth('hospital'), async (req, res) => {
    const now = clock();
    const result = await store.mutate(state => {
      const request = findTenantRequest(req, state);
      if (!request) return { status: 404, error: 'Request not found.' };
      if (CLOSED_REQUEST_STATUSES.includes(request.status)) return { status: 409, error: 'This request is already closed.' };
      if (request.currentRadiusKm >= 15) return { status: 409, error: 'This request has already reached the maximum dispatch radius.' };
      const radius = request.currentRadiusKm === 1 ? 5 : 15;
      const hospitalProfile = state.hospital || state.hospitalConfig || config.hospital;
      dispatchTier({
        state, request, radius, tier: radius === 5 ? 2 : 3, hospital: hospitalProfile, now,
        onAssignment: (assignment) => enqueueDispatchNotifications({ state, assignment, request, config, now }),
      });
      state.updatedAt = new Date(now).toISOString();
      return { status: 200, request: requestView(state, request) };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.request);
  });

  app.post('/hospital/requests/:id/cancel', auth('hospital'), async (req, res) => {
    const now = clock();
    const result = await store.mutate(state => {
      const request = findTenantRequest(req, state);
      if (!request) return { status: 404, error: 'Request not found.' };
      if (CLOSED_REQUEST_STATUSES.includes(request.status)) return { status: 409, error: 'This request is already closed.' };
      request.status = 'CANCELLED';
      request.cancelledAt = new Date(now).toISOString();
      request.cancelledBy = req.subject.tenantId || req.subject.id;
      withdrawAssignments(state, request, 'The hospital withdrew this request.', now);
      state.updatedAt = new Date(now).toISOString();
      return { status: 200, request: requestView(state, request) };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.request);
  });

  app.post('/hospital/requests/:id/close', auth('hospital'), async (req, res) => {
    const now = clock();
    const result = await store.mutate(state => {
      const request = findTenantRequest(req, state);
      if (!request) return { status: 404, error: 'Request not found.' };
      if (CLOSED_REQUEST_STATUSES.includes(request.status)) return { status: 409, error: 'This request is already closed.' };
      const completedUnits = state.assignments.filter(item => item.requestId === request.id && item.status === 'COMPLETED').length;
      request.status = completedUnits >= request.unitsNeeded ? 'FULFILLED' : 'UNFULFILLED';
      request.closedAt = new Date(now).toISOString();
      // Closing ends the request, so any live arrival token is invalidated. Units are checked in
      // BEFORE closing, which is the existing accepted -> check-in -> close workflow.
      withdrawAssignments(state, request, 'The request was closed by the hospital.', now);
      state.updatedAt = new Date(now).toISOString();
      return { status: 200, request: requestView(state, request) };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.request);
  });

  app.post('/hospital/checkin', auth('hospital'), async (req, res) => {
    const token = String(req.body?.token || '').trim();
    if (token.length < 6 || token.length > 256) return res.status(400).json({ error: 'Provide the arrival token shown in the donor app.' });
    const now = clock();
    const result = await store.mutate(state => {
      const assignment = state.assignments.find(item =>
        (item.checkinToken && item.checkinToken === token) ||
        (item.arrivalOtp && item.arrivalOtp === token) ||
        (token.length === 6 && item.checkinToken && item.checkinToken.replace(/\D/g, '').slice(-6) === token)
      );
      if (!assignment) return { status: 404, error: 'Arrival token was not found.' };
      const request = state.requests.find(item => item.id === assignment.requestId);
      if (!request) return { status: 404, error: 'Arrival token was not found.' };
      if (requestHospitalId(request, config) !== (req.subject.tenantId || req.subject.id)) return { status: 404, error: 'Arrival token was not found.' };
      if (assignment.status === 'COMPLETED') return { status: 409, error: 'This donor has already been checked in.' };
      // Only a donor who accepted (or already arrived) may be checked in, and only while the request
      // is still active. A token that survived a withdrawal is worthless.
      if (assignment.status !== 'ACCEPTED' && assignment.status !== 'ARRIVED') {
        return { status: 409, error: 'This alert is no longer active. The donor must accept the request again.' };
      }
      if (CLOSED_REQUEST_STATUSES.includes(request.status)) return { status: 409, error: 'This request is already closed.' };
      const donor = state.donors.find(item => item.id === assignment.donorId);
      assignment.status = 'COMPLETED';
      assignment.completedAt = new Date(now).toISOString();
      if (donor) {
        donor.reliabilityScore = clampReliability(Number(donor.reliabilityScore) + COMPLETION_BONUS);
        donor.lastDonationDate = new Date(now).toISOString().slice(0, 10);
      }
      const completed = state.assignments.filter(item => item.requestId === request.id && item.status === 'COMPLETED').length;
      if (completed >= request.unitsNeeded && !CLOSED_REQUEST_STATUSES.includes(request.status)) {
        request.status = 'FULFILLED';
        request.closedAt = new Date(now).toISOString();
        // Withdraw any alert that is no longer needed (the checked-in donor keeps its record).
        withdrawAssignments(state, request, 'The request was already fulfilled.', now, { exceptAssignmentId: assignment.id });
      }
      state.updatedAt = new Date(now).toISOString();
      return { status: 200, body: { assignment: structuredClone(assignment), request: requestView(state, request) } };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.body);
  });

  /* ---------------------------------------------------------------- donor routes */

  app.get('/donor/me', auth('donor'), async (req, res) => {
    const state = await store.read({ maxAgeMs: config.stateRefreshMs });
    const donor = state.donors.find(item => item.id === req.subject.id);
    if (!donor) return res.status(404).json({ error: 'Donor profile not found.' });
    return res.json(donorView(donor, clock()));
  });

  app.patch('/donor/me', auth('donor'), async (req, res) => {
    const { isAvailable, latitude, longitude } = req.body || {};
    if (isAvailable !== undefined && typeof isAvailable !== 'boolean') return res.status(400).json({ error: 'Availability must be true or false.' });
    if (latitude !== undefined && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) return res.status(400).json({ error: 'Latitude is invalid.' });
    if (longitude !== undefined && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) return res.status(400).json({ error: 'Longitude is invalid.' });
    const now = clock();
    const result = await store.mutate(state => {
      const donor = state.donors.find(item => item.id === req.subject.id);
      if (!donor) return { status: 404, error: 'Donor profile not found.' };
      if (isAvailable !== undefined) donor.isAvailable = isAvailable;
      if (latitude !== undefined) donor.latitude = Number(latitude);
      if (longitude !== undefined) donor.longitude = Number(longitude);
      donor.lastSeenAt = new Date(now).toISOString();
      state.updatedAt = new Date(now).toISOString();
      return { status: 200, donor: donorView(donor, now) };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.donor);
  });

  app.get('/donor/alerts', auth('donor'), async (req, res) => {
    const state = await store.read({ maxAgeMs: config.stateRefreshMs });
    const alerts = state.assignments
      .filter(item => item.donorId === req.subject.id && ACTIVE_ASSIGNMENT_STATUSES.includes(item.status))
      .map(item => ({ ...item, request: state.requests.find(request => request.id === item.requestId) || null }))
      .filter(item => item.request && !CLOSED_REQUEST_STATUSES.includes(item.request.status));
    res.json(alerts);
  });

  app.post('/donor/assignments/:id/respond', auth('donor'), async (req, res) => {
    const response = String(req.body?.response || '').toUpperCase();
    if (!['ACCEPT', 'DECLINE'].includes(response)) return res.status(400).json({ error: 'Invalid response.' });
    const now = clock();
    const result = await store.mutate(state => {
      const assignment = state.assignments.find(item => item.id === req.params.id && item.donorId === req.subject.id);
      if (!assignment) return { status: 404, error: 'Alert not found.' };
      const request = state.requests.find(item => item.id === assignment.requestId);
      if (assignment.status !== 'PINGED') return { status: 409, error: 'You have already responded to this alert.' };
      if (request && CLOSED_REQUEST_STATUSES.includes(request.status)) return { status: 409, error: 'This request is no longer active.' };
      const donor = state.donors.find(item => item.id === req.subject.id);
      if (response === 'ACCEPT') {
        assignment.status = 'ACCEPTED';
        assignment.checkinToken = checkinTokenFor(assignment, randomUUID);
        assignment.arrivalOtp = String(Math.floor(100000 + Math.random() * 900000));
      } else {
        assignment.status = 'DECLINED';
        cancelOutboxForAssignment(state, assignment.id, 'The donor declined this alert.', now);
        if (donor) donor.reliabilityScore = clampReliability(Number(donor.reliabilityScore) - DECLINE_PENALTY);
      }
      assignment.respondedAt = new Date(now).toISOString();
      state.updatedAt = new Date(now).toISOString();
      return { status: 200, assignment: structuredClone(assignment) };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.assignment);
  });

  app.post('/donor/assignments/:id/arrive', auth('donor'), async (req, res) => {
    const now = clock();
    const result = await store.mutate(state => {
      const assignment = state.assignments.find(item => item.id === req.params.id && item.donorId === req.subject.id);
      if (!assignment) return { status: 404, error: 'Alert not found.' };
      if (assignment.status !== 'ACCEPTED') return { status: 409, error: 'Accept the alert before confirming your arrival.' };
      assignment.status = 'ARRIVED';
      assignment.arrivedAt = new Date(now).toISOString();
      state.updatedAt = new Date(now).toISOString();
      return { status: 200, assignment: structuredClone(assignment) };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json(result.assignment);
  });

  app.post('/donor/devices', auth('donor'), async (req, res) => {
    const parsed = validateDeviceInput(req.body);
    if (parsed.error) return res.status(400).json({ error: parsed.error });
    const { installationId, expoPushToken, platform } = parsed.value;
    const now = clock();
    const result = await store.mutate(state => {
      let device = state.devices.find(item => item.installationId === installationId);
      if (!device) {
        const owned = state.devices.filter(item => item.donorId === req.subject.id);
        if (owned.length >= config.maxDevicesPerDonor) {
          const oldest = owned.sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime())[0];
          state.devices = state.devices.filter(item => item.installationId !== oldest.installationId);
        }
        device = { installationId, donorId: req.subject.id, expoPushToken, platform, active: true, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
        state.devices.push(device);
      } else {
        // Re-binding an installation to a new donor is allowed (device handover / re-login) but the
        // previous owner loses the token immediately.
        device.donorId = req.subject.id;
        device.expoPushToken = expoPushToken;
        device.platform = platform;
        device.active = true;
        device.updatedAt = new Date(now).toISOString();
      }
      state.updatedAt = new Date(now).toISOString();
      return { status: 201, device: { installationId: device.installationId, platform: device.platform, active: device.active, updatedAt: device.updatedAt } };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.status(201).json(result.device);
  });

  app.delete('/donor/devices/:installationId', auth('donor'), async (req, res) => {
    const installationId = String(req.params.installationId || '');
    const now = clock();
    const result = await store.mutate(state => {
      const device = state.devices.find(item => item.installationId === installationId && item.donorId === req.subject.id);
      if (!device) return { status: 404, error: 'Device not found.' };
      device.active = false;
      device.updatedAt = new Date(now).toISOString();
      // Stop any queued push for this installation.
      for (const item of state.outbox) {
        if (item.recipient !== device.expoPushToken) continue;
        if (item.status !== 'PENDING' && item.status !== 'SENDING') continue;
        item.status = 'CANCELLED';
        item.lastError = 'The donor disabled notifications for this device.';
        item.cancelledAt = new Date(now).toISOString();
      }
      state.updatedAt = new Date(now).toISOString();
      return { status: 200, removed: true };
    });
    if (result.error) return res.status(result.status).json({ error: result.error });
    res.json({ installationId, removed: true });
  });

  /* ---------------------------------------------------------------- sync + worker */

  // Realtime bootstrap for the web console and the donor app.
  //
  // The server returns only the public project URL, the publishable (anon) key and the caller's OWN
  // provider session token: the service-role key never leaves the server. The topic is derived from
  // the caller's trusted claims, never from the request, and RLS on realtime.messages decides
  // whether that token may subscribe to it. Broadcasts are a change SIGNAL only - an empty payload -
  // so clients always refetch their tenant-scoped REST resources, with polling as the fallback.
  app.get('/sync/config', authAny('hospital', 'donor'), async (req, res) => {
    const base = { enabled: false, transport: 'poll', event: 'changed', syncEndpoint: '/sync/version', fallback: 'rest-polling' };
    if (config.demoMode) return res.json({ ...base, reason: 'demo-mode' });
    if (!config.supabaseUrl || !config.supabasePublishableKey) return res.json({ ...base, reason: 'realtime-not-configured' });
    const providerToken = req.subject.providerToken || null;
    if (!providerToken) return res.json({ ...base, reason: 'missing-provider-session' });

    const topic = req.subject.role === 'hospital'
      ? `hospital:${req.subject.tenantId || config.hospitalId}`
      : `donor:${req.subject.authUserId || ''}`;
    if (topic.endsWith(':')) return res.json({ ...base, reason: 'missing-provider-session' });

    return res.json({
      enabled: true,
      transport: 'realtime-broadcast-private',
      url: config.supabaseUrl,
      publishableKey: config.supabasePublishableKey,
      accessToken: providerToken,
      topic,
      event: 'changed',
      private: true,
      fallback: 'rest-polling',
      syncEndpoint: '/sync/version',
    });
  });

  // Polling fallback advertised by GET /sync/config. It is role-scoped, never global: a hospital
  // sees only its own tenant's counters, a donor sees only their own alert count.
  app.get('/sync/version', authAny('hospital', 'donor'), async (req, res) => {
    const state = await store.read({ maxAgeMs: config.stateRefreshMs });
    const serverTime = new Date(clock()).toISOString();

    if (req.subject.role === 'donor') {
      const active = state.assignments.filter(item => {
        if (item.donorId !== req.subject.id || !ACTIVE_ASSIGNMENT_STATUSES.includes(item.status)) return false;
        const request = state.requests.find(entry => entry.id === item.requestId);
        return Boolean(request) && !CLOSED_REQUEST_STATUSES.includes(request.status);
      }).length;
      // No revision counter and no network-wide counters: a donor only learns about their own queue.
      return res.json({ role: 'donor', updatedAt: state.updatedAt || null, alertCount: active, serverTime, syncEndpoint: '/sync/version' });
    }

    const tenantId = req.subject.tenantId || req.subject.id;
    const visible = state.requests.filter(item => requestHospitalId(item, config) === tenantId);
    return res.json({
      role: 'hospital',
      updatedAt: state.updatedAt || null,
      requestCount: visible.length,
      openRequests: visible.filter(item => !CLOSED_REQUEST_STATUSES.includes(item.status)).length,
      serverTime,
      syncEndpoint: '/sync/version',
    });
  });

  async function runDispatchTick(now = clock()) {
    const outcome = await store.mutate(state => {
      const summary = { escalated: 0, exhausted: 0, expired: 0, cancelled: 0 };
      for (const request of state.requests) {
        if (CLOSED_REQUEST_STATUSES.includes(request.status)) continue;
        const expiresAt = new Date(request.expiresAt || 0).getTime();
        if (Number.isFinite(expiresAt) && expiresAt > 0 && expiresAt <= now) {
          request.status = 'EXPIRED';
          request.expiredAt = new Date(now).toISOString();
          summary.expired += 1;
          summary.cancelled += withdrawAssignments(state, request, 'The request expired before dispatch completed.', now);
          continue;
        }
        const accepted = state.assignments.filter(item => item.requestId === request.id && (item.status === 'ACCEPTED' || item.status === 'ARRIVED' || item.status === 'COMPLETED')).length;
        if (accepted >= request.unitsNeeded) continue;
        const lastDispatchAt = new Date(request.lastDispatchAt || request.createdAt || 0).getTime();
        if (!Number.isFinite(lastDispatchAt) || now - lastDispatchAt < config.escalationSlaMs) continue;
        if (request.currentRadiusKm >= 15) {
          request.status = 'UNFULFILLED';
          request.unfulfilledAt = new Date(now).toISOString();
          summary.exhausted += 1;
          // The request is over: no arrival token may remain redeemable.
          summary.cancelled += withdrawAssignments(state, request, 'Dispatch was exhausted without a match.', now);
          continue;
        }
        const radius = request.currentRadiusKm === 1 ? 5 : 15;
        const hospitalProfile = state.hospital || state.hospitalConfig || config.hospital;
        dispatchTier({
          state, request, radius, tier: radius === 5 ? 2 : 3, hospital: hospitalProfile, now,
          onAssignment: (assignment) => enqueueDispatchNotifications({ state, assignment, request, config, now }),
        });
        summary.escalated += 1;
      }
      state.updatedAt = new Date(now).toISOString();
      return summary;
    });

    const delivery = await drainOutbox({ store, sender, config, now });
    const state = await store.read();
    return { at: new Date(now).toISOString(), ...outcome, ...delivery, outbox: outboxStats(state, now) };
  }

  app.get('/internal/dispatch', limiter.limit('worker', {
    limit: config.rateLimits.worker,
    // The shared secret is the credential; the bucket key is a constant, never the secret itself.
    identify: () => ({ kind: 'worker', value: 'dispatch' }),
  }), async (req, res) => {
    if (!config.cronSecret) return res.status(503).json({ error: 'The dispatch worker is not configured for this environment.' });
    const provided = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!safeEqual(provided, config.cronSecret)) return res.status(401).json({ error: 'Unauthorized.' });
    const summary = await runDispatchTick();
    res.json(summary);
  });

  /* ---------------------------------------------------------------- footer */

  app.use((req, res) => res.status(404).json({ error: 'Not found.' }));

  app.use((error, _req, res, _next) => {
    if (error instanceof StateConflictError || error?.statusCode === 409) {
      return res.status(409).json({ error: 'Another update happened at the same time. Please retry.' });
    }
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'That payload is too large.' });
    if (error instanceof SyntaxError && 'body' in error) return res.status(400).json({ error: 'That request body is not valid JSON.' });
    logger.error({ event: 'unhandled_error', requestId: _req?.requestId });
    return res.status(500).json({ error: 'The server could not complete that operation. Please try again.' });
  });

  return {
    app,
    store,
    config,
    sender,
    runDispatchTick,
    // Exposed for the worker/outbox unit tests.
    outboxInternals: { claimDue, settle },
    async initialize() {
      try {
        await store.mutate(state => {
          if (!Array.isArray(state.devices)) state.devices = [];
          if (!Array.isArray(state.outbox)) state.outbox = [];
          if (!Array.isArray(state.donors)) state.donors = [];
          if (!Array.isArray(state.requests)) state.requests = [];
          if (!Array.isArray(state.assignments)) state.assignments = [];
          if (!state.hospital) {
            state.hospital = {
              id: state.hospitalConfig?.id || config.hospital.id,
              name: state.hospitalConfig?.name || config.hospital.name,
              email: config.hospital.email || 'admin@centralhospital.demo',
              licenseNumber: config.hospital.licenseNumber || 'MH-EMR-2026-0021',
              latitude: state.hospitalConfig?.latitude ?? config.hospital.latitude ?? 10.5276,
              longitude: state.hospitalConfig?.longitude ?? config.hospital.longitude ?? 76.2144,
            };
          }
          return true;
        });
      } catch (error) {
        logger.warn({ event: 'state_initialization_failed' });
        if (config.production) throw error;
      }
      return true;
    },
  };
}
