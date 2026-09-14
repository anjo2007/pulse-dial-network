// Durable notification outbox + Expo push sender.
//
// DELIVERY SEMANTICS (do not overclaim)
//  * This is an AT-LEAST-ONCE pipeline. A crash between "provider accepted" and "settle" re-sends the
//    notification, and a donor may therefore see a duplicate ping. That is the deliberate trade-off:
//    a missed emergency alert is worse than a repeated one. Every item carries a stable dedupeKey so
//    a *replay of the same assignment* is naturally de-duplicated.
//  * `ACCEPTED_BY_PROVIDER` means Expo issued a ticket. It does NOT mean the device displayed
//    anything. Only a receipt (or `RECEIPT_OK`) shows the push service accepted it, and even that is
//    not proof a human saw it. Nothing in this module ever reports "delivered".
//
// PRIVACY CONTRACT (locked screens)
//  * The push payload never contains donor names, blood types, patient or hospital details.
//  * `data` carries only the assignment id so the app can fetch details after authentication.
//
// RELIABILITY CONTRACT
//  * Enqueue happens inside the same atomic state mutation that creates the assignment.
//  * Claims are leased with a unique leaseId and settled with fencing: a stale worker (expired lease,
//    a newer lease, or a cancellation that raced the send) can never overwrite the current state.
//  * Worker work is bounded: batch size, concurrency and a wall-clock budget that stays below the
//    lease duration, so a Vercel invocation cannot be killed mid-flight while holding a lease.
//  * A malformed 200 from the provider is NOT a success: `status: "ok"` plus a ticket id is required.
//  * Permanent provider errors (for example DeviceNotRegistered) disable the device and cancel its
//    queued notifications instead of retrying forever.
import { randomUUID } from 'node:crypto';

export const OUTBOX_STATUS = {
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  // Provider issued a ticket. Not a delivery.
  ACCEPTED_BY_PROVIDER: 'ACCEPTED_BY_PROVIDER',
  // Provider receipt reported success. Still not proof a human saw it.
  RECEIPT_OK: 'RECEIPT_OK',
  RECEIPT_FAILED: 'RECEIPT_FAILED',
  // Receipt never arrived inside the retention window: unknown, never reported as success.
  RECEIPT_UNKNOWN: 'RECEIPT_UNKNOWN',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

export const OUTBOX_TEMPLATES = {
  DISPATCH_PING: 'DISPATCH_PING',
};

// Errors that will never succeed on retry: the installation is gone or the credentials are wrong.
export const PERMANENT_PROVIDER_ERRORS = new Set([
  'DeviceNotRegistered',
  'InvalidCredentials',
  'MismatchSenderId',
]);

const TERMINAL_STATUSES = new Set([
  OUTBOX_STATUS.ACCEPTED_BY_PROVIDER,
  OUTBOX_STATUS.RECEIPT_OK,
  OUTBOX_STATUS.RECEIPT_FAILED,
  OUTBOX_STATUS.RECEIPT_UNKNOWN,
  OUTBOX_STATUS.FAILED,
  OUTBOX_STATUS.CANCELLED,
]);

export function isTerminal(status) {
  return TERMINAL_STATUSES.has(status);
}

// Lockscreen-safe copy. No PII, no blood type, no hospital identity.
const DISPATCH_COPY = {
  title: 'Emergency blood request nearby',
  body: 'A hospital near you needs blood. Open Pulse Dial to view and respond.',
};

export function createMemorySender({ receipts = true } = {}) {
  const sent = [];
  return {
    kind: 'memory',
    sent,
    async send(notification) {
      sent.push({ id: notification.id, recipient: notification.recipient, data: notification.data, channelId: notification.channelId });
      return { ok: true, provider: 'memory', ticketId: `memory-${sent.length}` };
    },
    async getReceipts(ticketIds) {
      if (!receipts) return { ok: false, error: 'Receipt endpoint unavailable.' };
      const result = {};
      for (const ticketId of ticketIds) result[ticketId] = { status: 'ok' };
      return { ok: true, receipts: result };
    },
  };
}

export function createExpoSender({ config, fetchImpl = globalThis.fetch, logger, dryRun = false } = {}) {
  const endpoint = config.expo.endpoint;
  const receiptEndpoint = config.expo.receiptEndpoint;

  function pushBody(notification) {
    return {
      to: notification.recipient,
      title: notification.title,
      body: notification.body,
      data: notification.data,
      sound: 'default',
      priority: 'high',
      channelId: notification.channelId,
    };
  }

  async function post(url, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.expo.timeoutMs);
    try {
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
      if (config.expo.accessToken) headers.Authorization = `Bearer ${config.expo.accessToken}`;
      const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal });
      const payload = await response.json().catch(() => null);
      return { response, payload };
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    kind: dryRun ? 'dry-run' : 'expo',

    async send(notification) {
      if (dryRun) return { ok: true, provider: 'dry-run', ticketId: 'dry-run' };
      if (typeof fetchImpl !== 'function') return { ok: false, error: 'No HTTP client is available for push delivery.' };
      try {
        const { response, payload } = await post(endpoint, pushBody(notification));
        if (!response.ok) return { ok: false, error: `Push provider responded with ${response.status}.` };
        const rawTicket = payload?.data;
        const ticket = Array.isArray(rawTicket) ? rawTicket[0] : rawTicket;
        // A 200 with a missing/invalid ticket is NOT an acceptance: treat it as a retryable failure
        // instead of silently marking the notification sent.
        if (!ticket || typeof ticket !== 'object') return { ok: false, error: 'Push provider returned a malformed response.' };
        if (ticket.status !== 'ok' || !ticket.id) {
          const errorCode = ticket?.details?.error || ticket?.error || null;
          if (errorCode && PERMANENT_PROVIDER_ERRORS.has(errorCode)) {
            return { ok: false, error: `Push provider rejected the device (${errorCode}).`, errorCode, permanent: true };
          }
          return { ok: false, error: `Push provider rejected the message (${errorCode || 'unknown'}).`, errorCode };
        }
        return { ok: true, provider: 'expo', ticketId: ticket.id };
      } catch (error) {
        if (error?.name === 'AbortError') return { ok: false, error: 'Push provider timed out.' };
        logger?.warn?.({ event: 'push_delivery_error' });
        return { ok: false, error: 'Push provider request failed.' };
      }
    },

    // Receipt polling: separate endpoint, separate failure domain. A failure here must never be
    // reported as a delivery failure - the item simply stays "accepted, receipt pending".
    async getReceipts(ticketIds) {
      if (dryRun) {
        const result = {};
        for (const ticketId of ticketIds) result[ticketId] = { status: 'ok' };
        return { ok: true, receipts: result };
      }
      if (typeof fetchImpl !== 'function') return { ok: false, error: 'No HTTP client is available.' };
      if (ticketIds.length === 0) return { ok: true, receipts: {} };
      try {
        const { response, payload } = await post(receiptEndpoint, { ids: ticketIds });
        if (!response.ok) return { ok: false, error: `Receipt endpoint responded with ${response.status}.` };
        const raw = payload?.data;
        if (!raw || typeof raw !== 'object') return { ok: false, error: 'Receipt endpoint returned a malformed response.' };
        const receipts = {};
        for (const ticketId of ticketIds) {
          const entry = raw[ticketId];
          if (!entry) continue; // still pending at the provider
          receipts[ticketId] = {
            status: entry.status,
            errorCode: entry?.details?.error || entry?.error || null,
            message: entry?.message || null,
          };
        }
        return { ok: true, receipts };
      } catch {
        logger?.warn?.({ event: 'push_receipt_error' });
        return { ok: false, error: 'Receipt endpoint request failed.' };
      }
    },
  };
}

function isoAt(ms) {
  return new Date(ms).toISOString();
}

function buildItem({ assignment, device, request, config, now }) {
  return {
    id: `${assignment.id}:${device.installationId}`,
    dedupeKey: `${assignment.id}:${device.installationId}`,
    channel: 'expo',
    template: OUTBOX_TEMPLATES.DISPATCH_PING,
    recipient: device.expoPushToken,
    channelId: config.expo.channelId,
    title: DISPATCH_COPY.title,
    body: DISPATCH_COPY.body,
    // Privacy-safe: identifier only.
    data: { assignmentId: assignment.id, type: 'DISPATCH_PING' },
    requestId: request.id,
    assignmentId: assignment.id,
    donorId: assignment.donorId,
    status: OUTBOX_STATUS.PENDING,
    attempts: 0,
    maxAttempts: config.outboxMaxAttempts,
    nextAttemptAt: isoAt(now),
    leaseId: null,
    leaseUntil: null,
    ticketId: null,
    receiptStatus: null,
    receiptAttempts: 0,
    receiptCheckedAt: null,
    receiptNextCheckAt: null,
    lastError: null,
    createdAt: isoAt(now),
    acceptedAt: null,
    failedAt: null,
  };
}

// Enqueues one notification per active device of the pinged donor. De-duplicated by key, so a
// retried dispatch can never double-notify the same installation.
export function enqueueDispatchNotifications({ state, assignment, request, config, now = Date.now() }) {
  const devices = state.devices.filter(device => device.donorId === assignment.donorId && device.active !== false);
  let enqueued = 0;
  for (const device of devices) {
    const item = buildItem({ assignment, device, request, config, now });
    if (state.outbox.some(existing => existing.dedupeKey === item.dedupeKey)) continue;
    state.outbox.push(item);
    enqueued += 1;
  }
  return enqueued;
}

// Terminal cleanup when a dispatch is withdrawn (request cancelled, alert declined).
export function cancelOutboxForAssignment(state, assignmentId, reason, now = Date.now()) {
  let cancelled = 0;
  for (const item of state.outbox) {
    if (item.assignmentId !== assignmentId) continue;
    if (isTerminal(item.status)) continue;
    item.status = OUTBOX_STATUS.CANCELLED;
    item.lastError = reason;
    item.cancelledAt = isoAt(now);
    item.leaseId = null;
    item.leaseUntil = null;
    cancelled += 1;
  }
  return cancelled;
}

// A permanently invalid installation: stop notifying it entirely.
export function disableDeviceForToken(state, recipient, reason, now = Date.now()) {
  let disabled = 0;
  for (const device of state.devices) {
    if (device.expoPushToken !== recipient || device.active === false) continue;
    device.active = false;
    device.disabledAt = isoAt(now);
    device.disabledReason = reason;
    disabled += 1;
  }
  let cancelled = 0;
  for (const item of state.outbox) {
    if (item.recipient !== recipient) continue;
    if (item.status !== OUTBOX_STATUS.PENDING && item.status !== OUTBOX_STATUS.SENDING) continue;
    item.status = OUTBOX_STATUS.CANCELLED;
    item.lastError = reason;
    item.cancelledAt = isoAt(now);
    cancelled += 1;
  }
  return { disabled, cancelled };
}

export function outboxStats(state) {
  const byStatus = {};
  for (const item of state.outbox) byStatus[item.status] = (byStatus[item.status] || 0) + 1;
  const count = status => byStatus[status] || 0;
  return {
    total: state.outbox.length,
    byStatus,
    pending: count(OUTBOX_STATUS.PENDING),
    sending: count(OUTBOX_STATUS.SENDING),
    acceptedByProvider: count(OUTBOX_STATUS.ACCEPTED_BY_PROVIDER),
    receiptOk: count(OUTBOX_STATUS.RECEIPT_OK),
    receiptFailed: count(OUTBOX_STATUS.RECEIPT_FAILED),
    receiptUnknown: count(OUTBOX_STATUS.RECEIPT_UNKNOWN),
    failed: count(OUTBOX_STATUS.FAILED),
    cancelled: count(OUTBOX_STATUS.CANCELLED),
    // There is no delivery confirmation anywhere in this system, so this is always zero.
    delivered: 0,
  };
}

// Leases due items (including abandoned leases) for delivery under a fresh, unique leaseId.
export function claimDue(state, { now = Date.now(), limit = 50, leaseMs = 60000, leaseId = randomUUID() } = {}) {
  const nowMs = Number(now);
  const claimed = [];
  const candidates = state.outbox
    .filter(item => {
      if (isTerminal(item.status)) return false;
      if (item.status === OUTBOX_STATUS.SENDING) return new Date(item.leaseUntil || 0).getTime() <= nowMs;
      if (item.status !== OUTBOX_STATUS.PENDING) return false;
      return new Date(item.nextAttemptAt || 0).getTime() <= nowMs;
    })
    .sort((a, b) => new Date(a.nextAttemptAt || 0).getTime() - new Date(b.nextAttemptAt || 0).getTime())
    .slice(0, limit);
  for (const item of candidates) {
    item.status = OUTBOX_STATUS.SENDING;
    item.leaseId = leaseId;
    item.leaseUntil = isoAt(nowMs + leaseMs);
    item.attempts += 1;
    item.lastAttemptAt = isoAt(nowMs);
    claimed.push({ ...structuredClone(item), leaseId });
  }
  return claimed;
}

export function backoffDelay(attempts, baseMs, maxMs = 30 * 60 * 1000) {
  return Math.min(baseMs * 2 ** Math.max(0, attempts - 1), maxMs);
}

// FENCED settle.
// A result is applied only if the item is still SENDING under exactly the lease that produced it.
// This single check covers three races: an expired lease reclaimed by another worker, a newer lease
// from a concurrent worker, and a cancellation (request withdrawn / device removed) that landed
// while the HTTP call was in flight.
export function settle(state, results, { now = Date.now(), backoffMs = 30000, maxAttempts, preserveTtlMs = 0 } = {}) {
  const summary = { accepted: 0, retried: 0, failed: 0, fenced: 0, devicesDisabled: 0, queueCancelled: 0 };
  for (const result of results) {
    const item = state.outbox.find(entry => entry.id === result.id);
    if (!item) continue;
    if (item.status !== OUTBOX_STATUS.SENDING || item.leaseId !== result.leaseId) {
      summary.fenced += 1; // stale worker: never touch a newer state
      continue;
    }
    item.leaseId = null;
    item.leaseUntil = null;

    if (result.ok) {
      item.status = OUTBOX_STATUS.ACCEPTED_BY_PROVIDER;
      item.ticketId = result.ticketId || result.providerId || null;
      item.acceptedAt = isoAt(now);
      item.receiptStatus = 'pending';
      item.receiptNextCheckAt = isoAt(now + Math.max(0, preserveTtlMs));
      item.lastError = null;
      summary.accepted += 1;
      continue;
    }

    item.lastError = result.error || 'Push delivery failed.';
    const limit = maxAttempts ?? item.maxAttempts ?? 5;
    if (result.permanent || item.attempts >= limit) {
      item.status = OUTBOX_STATUS.FAILED;
      item.failedAt = isoAt(now);
      item.permanent = Boolean(result.permanent);
      summary.failed += 1;
      if (result.permanent && result.permanentDisable !== false && item.recipient) {
        const outcome = disableDeviceForToken(state, item.recipient, `Permanent push failure (${result.errorCode || 'unknown'}).`, now);
        summary.devicesDisabled += outcome.disabled;
        summary.queueCancelled += outcome.cancelled;
      }
    } else {
      item.status = OUTBOX_STATUS.PENDING;
      item.nextAttemptAt = isoAt(now + backoffDelay(item.attempts, backoffMs));
      summary.retried += 1;
    }
  }
  return summary;
}

// Receipts are due a while after acceptance (Expo keeps them for ~24h).
export function dueReceipts(state, { now = Date.now(), limit = 50 } = {}) {
  return state.outbox
    .filter(item => item.status === OUTBOX_STATUS.ACCEPTED_BY_PROVIDER
      && item.ticketId
      && new Date(item.receiptNextCheckAt || 0).getTime() <= now)
    .sort((a, b) => new Date(a.receiptNextCheckAt).getTime() - new Date(b.receiptNextCheckAt).getTime())
    .slice(0, limit);
}

export function applyReceipts(state, receipts, { now = Date.now(), backoffMs = 300000, maxAgeMs = 86400000 } = {}) {
  const summary = { receiptsOk: 0, receiptsFailed: 0, receiptsUnknown: 0, receiptsPending: 0, devicesDisabled: 0, queueCancelled: 0 };
  for (const [ticketId, receipt] of Object.entries(receipts || {})) {
    const item = state.outbox.find(entry => entry.ticketId === ticketId);
    if (!item || item.status !== OUTBOX_STATUS.ACCEPTED_BY_PROVIDER) continue;
    item.receiptAttempts += 1;
    item.receiptCheckedAt = isoAt(now);
    if (receipt.status === 'ok') {
      item.status = OUTBOX_STATUS.RECEIPT_OK;
      item.receiptStatus = 'ok';
      item.receiptNextCheckAt = null;
      summary.receiptsOk += 1;
      continue;
    }
    const errorCode = receipt.errorCode || null;
    item.status = OUTBOX_STATUS.RECEIPT_FAILED;
    item.receiptStatus = 'error';
    item.receiptNextCheckAt = null;
    item.lastError = `Push receipt reported an error (${errorCode || 'unknown'}).`;
    summary.receiptsFailed += 1;
    if (errorCode && PERMANENT_PROVIDER_ERRORS.has(errorCode) && item.recipient) {
      const outcome = disableDeviceForToken(state, item.recipient, `Permanent push failure (${errorCode}).`, now);
      summary.devicesDisabled += outcome.disabled;
      summary.queueCancelled += outcome.cancelled;
    }
  }

  // No receipt yet: keep waiting inside the retention window, then record it as UNKNOWN. An absent
  // receipt is never upgraded to success.
  for (const item of state.outbox) {
    if (item.status !== OUTBOX_STATUS.ACCEPTED_BY_PROVIDER) continue;
    const acceptedAt = new Date(item.acceptedAt || item.createdAt || 0).getTime();
    if (now - acceptedAt >= maxAgeMs) {
      item.status = OUTBOX_STATUS.RECEIPT_UNKNOWN;
      item.receiptStatus = 'unknown';
      item.receiptNextCheckAt = null;
      item.lastError = 'No delivery receipt was returned by the push provider.';
      summary.receiptsUnknown += 1;
      continue;
    }
    if (new Date(item.receiptNextCheckAt || 0).getTime() > now) {
      summary.receiptsPending += 1;
      continue;
    }
    item.receiptNextCheckAt = isoAt(now + backoffMs);
    summary.receiptsPending += 1;
  }
  return summary;
}

async function mapWithConcurrency(items, concurrency, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await task(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

// One worker tick: claim (bounded) -> pre-send guard -> bounded-concurrency send -> fenced settle ->
// receipt poll, all inside a wall-clock budget that stays below the lease duration so a function
// timeout can never leave a lease held by a dead invocation.
export async function drainOutbox({ store, sender, config, now = Date.now(), limit, deadline } = {}) {
  const budgetMs = config.workerBudgetMs;
  const deadlineMs = deadline ?? now + budgetMs;
  const batchSize = Math.min(limit ?? config.workerBatchSize, config.workerBatchSize);
  const leaseMs = Math.max(config.outboxLeaseMs, budgetMs + 15000);
  const concurrency = Math.max(1, Math.min(config.workerConcurrency, batchSize));

  const summary = {
    outboxClaimed: 0,
    outboxAccepted: 0,
    outboxRetried: 0,
    outboxFailed: 0,
    outboxFenced: 0,
    outboxDeviceDisabled: 0,
    outboxQueueCancelled: 0,
    outboxPending: 0,
    outboxDue: 0,
    receiptsChecked: 0,
    receiptsOk: 0,
    receiptsFailed: 0,
    receiptsUnknown: 0,
    receiptsPending: 0,
    budgetExhausted: false,
  };

  const leaseId = randomUUID();
  const claimed = await store.mutate(state => claimDue(state, { now, limit: batchSize, leaseMs, leaseId }));
  summary.outboxClaimed = claimed.length;

  if (claimed.length > 0) {
    // Pre-send cancellation guard: one fresh read proves the lease is still ours and the item was
    // not withdrawn between claiming and sending.
    const snapshot = await store.read({ maxAgeMs: 0 });
    const sendable = claimed.filter(item => {
      const live = snapshot.outbox.find(entry => entry.id === item.id);
      return Boolean(live) && live.status === OUTBOX_STATUS.SENDING && live.leaseId === leaseId;
    });

    // Never start a send that the remaining budget cannot plausibly cover: the reserve is the
    // provider timeout (its own worst case), floored at 1s so a tiny budget deterministically
    // starts nothing instead of racing the millisecond boundary.
    const sendReserveMs = Math.max(1000, Math.min(config.expo.timeoutMs, budgetMs - 1));
    const toSend = sendable.filter(() => Date.now() + sendReserveMs <= deadlineMs);
    if (toSend.length < sendable.length) summary.budgetExhausted = true;

    const results = await mapWithConcurrency(toSend, concurrency, async item => {
      let outcome;
      try {
        outcome = await sender.send(item);
      } catch (error) {
        outcome = { ok: false, error: String(error?.message || error) };
      }
      return { id: item.id, leaseId, ...outcome };
    });

    const settled = await store.mutate(state => settle(state, results, {
      now: Date.now(),
      backoffMs: config.outboxBackoffMs,
      maxAttempts: config.outboxMaxAttempts,
      preserveTtlMs: config.receiptPollDelayMs,
    }));
    summary.outboxAccepted = settled.accepted;
    summary.outboxRetried = settled.retried;
    summary.outboxFailed = settled.failed;
    summary.outboxFenced = settled.fenced;
    summary.outboxDeviceDisabled = settled.devicesDisabled;
    summary.outboxQueueCancelled = settled.queueCancelled;
  }

  // Receipts only when there is budget left for the call plus its settle.
  if (typeof sender?.getReceipts === 'function' && Date.now() + 3000 < deadlineMs) {
    const due = await store.mutate(state => dueReceipts(state, { now: Date.now(), limit: batchSize }));
    if (due.length > 0) {
      const ticketIds = due.map(item => item.ticketId);
      let outcome;
      try {
        outcome = await sender.getReceipts(ticketIds);
      } catch {
        outcome = { ok: false, error: 'Receipt request failed.' };
      }
      if (outcome?.ok) {
        summary.receiptsChecked = ticketIds.length;
        const applied = await store.mutate(state => applyReceipts(state, outcome.receipts, {
          now: Date.now(),
          backoffMs: config.receiptPollBackoffMs,
          maxAgeMs: config.receiptPollMaxAgeMs,
        }));
        summary.receiptsOk = applied.receiptsOk;
        summary.receiptsFailed = applied.receiptsFailed;
        summary.receiptsUnknown = applied.receiptsUnknown;
        summary.receiptsPending = applied.receiptsPending;
        summary.outboxDeviceDisabled += applied.devicesDisabled;
        summary.outboxQueueCancelled += applied.queueCancelled;
      } else {
        summary.receiptsPending = ticketIds.length;
      }
    }
  } else if (Date.now() + 3000 >= deadlineMs) {
    summary.budgetExhausted = true;
  }

  const after = await store.read();
  const stats = outboxStats(after);
  summary.outboxPending = stats.pending;
  summary.outboxDue = stats.pending;
  return summary;
}
