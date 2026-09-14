// Persistent, distributed rate limiting for the credential endpoints.
//
// Why not an in-process counter: on Vercel every request may land on a different instance, so a
// per-instance Map gives an attacker effectively `limit × instances` attempts. Counting lives in
// Postgres (`rate_limit_hit`, migration 004) as a single atomic upsert per window.
//
// Hardening rules:
//  * Keys are a keyed HMAC of the identity - a raw email, phone number or credential is NEVER a key
//    and never reaches the database or the logs.
//  * `x-forwarded-for` is attacker-controlled. It is only consulted when the runtime is trusted
//    Vercel (`VERCEL`/`VERCEL_ENV` present); otherwise the socket address is used.
//  * FAIL CLOSED: in production a missing or broken counting backend refuses the request (503)
//    rather than allowing unlimited credential attempts.
//  * An in-process counter exists only as a local-development fallback.
import { createHmac } from 'node:crypto';

export const RATE_LIMIT_RPC = 'rate_limit_hit';

export function createRateLimiter({ config, supabase, clock = () => Date.now(), logger, memoryFallback = !config.production } = {}) {
  const memory = new Map();
  let backendFailure = null; // { reason, missing } once the durable backend is unusable

  const secret = config.rateLimitSecret || 'local-development-only';

  // Stable, non-reversible identity for keys. Truncated: 128 bits is far beyond what is needed to
  // avoid collisions while keeping keys short.
  function identityKey(bucket, identity) {
    const material = `${bucket}|${identity.kind}|${String(identity.value ?? '').trim().toLowerCase()}`;
    return createHmac('sha256', secret).update(material).digest('base64url').slice(0, 32);
  }

  function clientIp(req) {
    if (config.vercel) {
      const forwarded = req.headers['x-vercel-forwarded-for'] || req.headers['x-real-ip'];
      if (typeof forwarded === 'string' && forwarded.trim().length > 0) {
        return forwarded.split(',')[0].trim();
      }
    }
    // Outside a trusted runtime the socket address is the only trustworthy source.
    return req.socket?.remoteAddress || req.ip || 'unknown';
  }

  function identityFrom(req, identify) {
    if (typeof identify === 'function') {
      const candidate = identify(req);
      if (candidate && candidate.value) return candidate;
    }
    return { kind: 'ip', value: clientIp(req) };
  }

  async function hit(key, windowSeconds, limit) {
    if (supabase && !backendFailure) {
      try {
        const { data, error } = await supabase.rpc(RATE_LIMIT_RPC, { p_key: key, p_window_seconds: windowSeconds, p_limit: limit });
        if (!error && typeof data === 'boolean') return { allowed: data, degraded: false };
        const missing = error?.code === 'PGRST202' || String(error?.message || '').includes(RATE_LIMIT_RPC);
        backendFailure = { reason: missing ? 'rpc-missing' : 'rpc-error', missing };
        logger?.error?.({ event: 'rate_limit_backend_unavailable', missing });
      } catch {
        backendFailure = { reason: 'rpc-error', missing: false };
        logger?.error?.({ event: 'rate_limit_backend_unavailable', missing: false });
      }
    }

    if (!memoryFallback) {
      // Fail closed: no counting backend means no credential attempts are served.
      return { allowed: false, degraded: true, reason: backendFailure?.reason || 'no-backend' };
    }

    const windowMs = Math.max(1, windowSeconds) * 1000;
    const nowMs = clock();
    const windowStart = Math.floor(nowMs / windowMs) * windowMs;
    const entry = memory.get(key);
    const count = (!entry || entry.windowStart !== windowStart) ? 1 : entry.count + 1;
    memory.set(key, { windowStart, count });
    if (memory.size > 5000) memory.clear();
    return { allowed: count <= limit, degraded: false, remaining: Math.max(0, limit - count) };
  }

  // Middleware factory: `limit('donor-verify', { limit: 20, windowSeconds: 60, identify: req => ... })`
  function limit(bucket, { limit: max, windowSeconds, identify } = {}) {
    return async (req, res, next) => {
      const identity = identityFrom(req, identify);
      const key = identityKey(bucket, identity);
      const outcome = await hit(key, windowSeconds ?? config.rateLimits.windowSeconds, max ?? 10);
      if (outcome.degraded) {
        logger?.error?.({ event: 'rate_limit_failed_closed', bucket, requestId: req.requestId });
        return res.status(503).json({ error: 'Request screening is unavailable, so this request was refused. Please try again shortly.' });
      }
      if (!outcome.allowed) {
        res.set('Retry-After', String(Math.max(1, windowSeconds ?? config.rateLimits.windowSeconds)));
        return res.status(429).json({ error: 'Too many attempts. Please wait a moment and try again.' });
      }
      return next();
    };
  }

  return {
    limit,
    hit,
    identityKey,
    clientIp,
    isDegraded: () => backendFailure,
  };
}
