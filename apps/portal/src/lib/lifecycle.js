/**
 * Request lifecycle / roster derivation.
 *
 * Pure functions only. They take the server's RequestView shape:
 *   { id, bloodType, unitsNeeded, urgency, status, currentRadiusKm, createdAt,
 *     expiresAt, assignments: [{ id, donorId, donorName, donorBloodType, status,
 *     distanceKm, tier, notifiedAt, checkinToken, score }], pinged, accepted,
 *     fulfilledUnits }
 *
 * Two things happen here that matter for safety and correctness:
 *  1. every field is normalized defensively, so an unexpected/partial payload renders
 *     an honest empty state instead of crashing the whole dashboard
 *  2. donor identity is masked until the donor has actually arrived - the portal shows
 *     a stable non-identifying reference (Donor #A1B2) plus the clinically required
 *     blood group, and only reveals the legal name for ARRIVED/COMPLETED rows
 */

export const DEFAULT_RADIUS_STEPS = Object.freeze([1, 5, 15]);
export const REQUEST_TTL_MS = 60 * 60 * 1000;

export const ASSIGNMENT_STATUSES = Object.freeze(['PINGED', 'ACCEPTED', 'ARRIVED', 'COMPLETED', 'DECLINED']);
export const RESPONDING_STATUSES = Object.freeze(['ACCEPTED', 'ARRIVED', 'COMPLETED']);
export const IDENTITY_REVEALED_STATUSES = Object.freeze(['ARRIVED', 'COMPLETED']);

const num = (value, fallback = 0) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
const str = (value, fallback = '') => (typeof value === 'string' ? value : fallback);

export function normalizeAssignment(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const status = ASSIGNMENT_STATUSES.includes(source.status) ? source.status : 'PINGED';
  return {
    id: str(source.id, ''),
    donorId: str(source.donorId, ''),
    donorName: str(source.donorName, ''),
    donorBloodType: str(source.donorBloodType, ''),
    status,
    tier: num(source.tier, 1),
    distanceKm: num(source.distanceKm, 0),
    notifiedAt: str(source.notifiedAt, ''),
    respondedAt: str(source.respondedAt, ''),
    arrivedAt: str(source.arrivedAt, ''),
    completedAt: str(source.completedAt, ''),
    hasCheckinToken: Boolean(source.checkinToken),
  };
}

export function normalizeRequest(raw) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const assignments = Array.isArray(source.assignments) ? source.assignments.map(normalizeAssignment) : [];
  return {
    id: str(source.id, ''),
    bloodType: str(source.bloodType, ''),
    unitsNeeded: Math.max(0, num(source.unitsNeeded, 0)),
    urgency: str(source.urgency, 'URGENT'),
    status: str(source.status, 'DISPATCHING'),
    currentRadiusKm: num(source.currentRadiusKm, 0),
    createdAt: str(source.createdAt, ''),
    expiresAt: str(source.expiresAt, ''),
    assignments,
    // Trust our own derivation over the server counters; the server only sends them as a
    // convenience and an older payload may omit them.
    pinged: assignments.length,
    fulfilledUnits: assignments.filter((item) => item.status === 'COMPLETED').length,
    accepted: assignments.filter((item) => RESPONDING_STATUSES.includes(item.status)).length,
  };
}

export function normalizeRequests(data) {
  if (!Array.isArray(data)) return [];
  return data.map(normalizeRequest).filter((request) => request.id);
}

/**
 * Merge a single-request API response into the request already on screen.
 *
 * Escalate/close return a full RequestView, but a lifecycle-only response (for example
 * a cancellation that only echoes `{ id, status }`) must never blank out the roster the
 * clinician is looking at. Anything the response does not carry is taken from the
 * previous state.
 */
export function mergeRequestUpdate(previous, update) {
  const normalized = normalizeRequest(update);
  if (!previous || previous.id !== normalized.id || !normalized.id) return normalized;
  if (normalized.assignments.length) return normalized;
  return {
    ...previous,
    ...normalized,
    assignments: previous.assignments,
    pinged: previous.pinged,
    accepted: previous.accepted,
    fulfilledUnits: previous.fulfilledUnits,
  };
}

export function isActiveRequest(request) {
  return request?.status === 'DISPATCHING';
}

export function requestExpiryMs(request) {
  const parsed = Date.parse(String(request?.expiresAt ?? ''));
  if (Number.isFinite(parsed)) return parsed;
  const created = Date.parse(String(request?.createdAt ?? ''));
  return Number.isFinite(created) ? created + REQUEST_TTL_MS : 0;
}

export function summarize(request, now = Date.now()) {
  const expiresAtMs = requestExpiryMs(request);
  const expiresInMs = expiresAtMs ? expiresAtMs - now : 0;
  const needed = Math.max(0, Number(request?.unitsNeeded) || 0);
  // Every counter is derived from the roster itself, so a stale or missing server
  // counter (the API sends pinged/accepted/fulfilledUnits as a convenience) can never
  // disagree with what the roster actually shows.
  const assignments = Array.isArray(request?.assignments) ? request.assignments : [];
  const count = (status) => assignments.filter((item) => item.status === status).length;
  const collected = count('COMPLETED');
  const pct = needed > 0 ? Math.max(0, Math.min(100, Math.round((collected / needed) * 100))) : 0;
  return {
    pinged: assignments.length,
    responding: assignments.filter((item) => RESPONDING_STATUSES.includes(item.status)).length,
    declined: count('DECLINED'),
    enRoute: count('ACCEPTED'),
    arrived: count('ARRIVED'),
    collected,
    remaining: Math.max(0, needed - collected),
    needed,
    pct,
    expiresAtMs,
    expiresInMs,
    expired: isActiveRequest(request) && expiresAtMs > 0 && expiresInMs <= 0,
    fullyCollected: needed > 0 && collected >= needed,
  };
}

export function statusLabel(request, now = Date.now()) {
  if (request?.status === 'FULFILLED') return 'Fulfilled';
  if (request?.status === 'CANCELLED') return 'Cancelled';
  if (request?.status === 'EXPIRED') return 'Expired';
  if (isActiveRequest(request) && summarize(request, now).expired) return 'Dispatching - overdue';
  if (isActiveRequest(request)) return 'Dispatching';
  return request?.status ? String(request.status) : 'Unknown';
}

export function statusTone(request, now = Date.now()) {
  if (request?.status === 'FULFILLED') return 'green';
  if (request?.status === 'CANCELLED') return 'gray';
  if (summarize(request, now).expired) return 'red';
  return 'blue';
}

export function sortRequests(list) {
  const weight = (request) => (isActiveRequest(request) ? 0 : 1);
  return [...list].sort((a, b) => {
    const byState = weight(a) - weight(b);
    if (byState !== 0) return byState;
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
}

export function filterRequests(list, filter) {
  if (filter === 'active') return list.filter(isActiveRequest);
  if (filter === 'closed') return list.filter((request) => !isActiveRequest(request));
  return list;
}

export function nextRadiusStep(currentRadiusKm) {
  const index = DEFAULT_RADIUS_STEPS.findIndex((step) => step > num(currentRadiusKm, 0));
  return index === -1 ? null : DEFAULT_RADIUS_STEPS[index];
}

export function canEscalate(request) {
  return isActiveRequest(request) && nextRadiusStep(request?.currentRadiusKm) !== null;
}

export function canClose(request) {
  return isActiveRequest(request);
}

export function canCancel(request, capabilities) {
  return isActiveRequest(request) && capabilities?.cancelRequest === true;
}

/**
 * Privacy: a dispatch roster only needs an identity when the donor is physically
 * present. Until then the portal shows a stable, non-identifying reference.
 */
export function donorRef(donorId) {
  const source = String(donorId ?? '');
  if (!source) return '—';
  // FNV-1a over the id: stable for a given donor, but it does not leak the donor's
  // position in the roster or any part of the underlying identifier.
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 0x10000).toString(16).toUpperCase().padStart(4, '0');
}

export function identityVisible(entry) {
  return IDENTITY_REVEALED_STATUSES.includes(entry?.status);
}

export function displayDonorLabel(entry) {
  if (identityVisible(entry)) {
    return entry?.donorName?.trim() || `Donor #${donorRef(entry?.donorId)}`;
  }
  return `Donor #${donorRef(entry?.donorId)}`;
}

export function donorInitials(entry) {
  if (identityVisible(entry)) {
    const parts = String(entry?.donorName ?? '').trim().split(/\s+/).filter(Boolean);
    if (parts.length) return parts.slice(0, 2).map((part) => part[0]).join('').toUpperCase();
  }
  return `#${donorRef(entry?.donorId).slice(-2)}`;
}

export function assignmentStatusLabel(status) {
  const labels = {
    PINGED: 'Alerted',
    ACCEPTED: 'Responding',
    ARRIVED: 'On site',
    COMPLETED: 'Collected',
    DECLINED: 'Declined',
  };
  return labels[status] ?? String(status ?? 'Unknown').replace(/_/g, ' ').toLowerCase();
}

export function rosterSummary(entries) {
  const summary = { pinged: 0, responding: 0, arrived: 0, collected: 0, declined: 0 };
  for (const entry of entries ?? []) {
    if (entry.status === 'PINGED') summary.pinged += 1;
    else if (entry.status === 'ACCEPTED') summary.responding += 1;
    else if (entry.status === 'ARRIVED') summary.arrived += 1;
    else if (entry.status === 'COMPLETED') summary.collected += 1;
    else if (entry.status === 'DECLINED') summary.declined += 1;
  }
  return summary;
}

/**
 * Cheap structural comparison so a 4s poll that returns identical data does not
 * re-render (or re-announce) the whole dashboard. Covers every field the UI reads.
 */
export function sameRequest(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.id !== b.id || a.status !== b.status || a.currentRadiusKm !== b.currentRadiusKm) return false;
  if (a.fulfilledUnits !== b.fulfilledUnits || a.pinged !== b.pinged || a.accepted !== b.accepted) return false;
  if (a.assignments.length !== b.assignments.length) return false;
  for (let index = 0; index < a.assignments.length; index += 1) {
    const left = a.assignments[index];
    const right = b.assignments[index];
    if (left.id !== right.id || left.status !== right.status || left.hasCheckinToken !== right.hasCheckinToken) return false;
  }
  return true;
}

export function sameRequests(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((request, index) => sameRequest(request, b[index]));
}

export function formatClock(value) {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) return '—';
  return new Date(parsed).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function formatTime(value) {
  const parsed = Date.parse(String(value ?? ''));
  if (!Number.isFinite(parsed)) return '—';
  return new Date(parsed).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  if (minutes < 60) return `${minutes}m ${String(totalSeconds % 60).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Screen-reader description of a request card, used as an accessible summary. */
export function describeRequest(request, now = Date.now()) {
  const summary = summarize(request, now);
  const parts = [
    `${request.bloodType || 'Unspecified'} blood, ${request.unitsNeeded} unit${request.unitsNeeded === 1 ? '' : 's'} needed`,
    `${summary.responding} responding`,
    `${summary.collected} collected`,
    `perimeter ${request.currentRadiusKm} kilometres`,
    `raised ${formatClock(request.createdAt)}`,
  ];
  if (summary.expired) parts.push('past its dispatch window');
  if (request.status === 'FULFILLED') parts.push('fulfilled');
  return parts.join(', ');
}
