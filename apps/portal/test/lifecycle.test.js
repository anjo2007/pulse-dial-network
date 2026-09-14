import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canCancel,
  canClose,
  canEscalate,
  displayDonorLabel,
  donorInitials,
  donorRef,
  filterRequests,
  formatDuration,
  identityVisible,
  mergeRequestUpdate,
  nextRadiusStep,
  normalizeAssignment,
  normalizeRequest,
  normalizeRequests,
  sameRequests,
  sortRequests,
  statusLabel,
  summarize,
} from '../src/lib/lifecycle.js';

const NOW = Date.parse('2026-01-01T12:00:00.000Z');
const UUID_A = '8a0d0f2e-1c3a-4f5b-9a11-2b3c4d5e6f70';
const UUID_B = '11112222-3333-4444-5555-666677778888';

const assignment = (overrides = {}) => ({
  id: 'asg-1',
  donorId: UUID_A,
  donorName: 'Asha Menon',
  donorBloodType: 'O-',
  status: 'PINGED',
  tier: 1,
  distanceKm: 1.2,
  notifiedAt: new Date(NOW - 60000).toISOString(),
  checkinToken: null,
  ...overrides,
});

const request = (overrides = {}) => ({
  id: 'req-1',
  bloodType: 'O-',
  unitsNeeded: 2,
  urgency: 'CRITICAL',
  status: 'DISPATCHING',
  currentRadiusKm: 1,
  createdAt: new Date(NOW - 5 * 60000).toISOString(),
  expiresAt: new Date(NOW + 30 * 60000).toISOString(),
  assignments: [assignment()],
  ...overrides,
});

test('normalization survives partial and hostile payloads', async (t) => {
  await t.test('non-array responses become an empty feed instead of crashing', () => {
    assert.deepEqual(normalizeRequests(null), []);
    assert.deepEqual(normalizeRequests({ error: 'nope' }), []);
    assert.deepEqual(normalizeRequests([{ id: '' }, null]), []);
  });

  await t.test('an assignment with an unknown status degrades to PINGED', () => {
    const normalized = normalizeAssignment({ id: 'a', status: 'WAT', distanceKm: '3.5' });
    assert.equal(normalized.status, 'PINGED');
    assert.equal(normalized.distanceKm, 3.5);
  });

  await t.test('server counters are recomputed from the roster, never trusted', () => {
    const normalized = normalizeRequest(
      request({
        pinged: 99,
        fulfilledUnits: 42,
        assignments: [assignment({ id: 'a', status: 'COMPLETED' }), assignment({ id: 'b', donorId: UUID_B, status: 'ACCEPTED' })],
      }),
    );
    assert.equal(normalized.pinged, 2);
    assert.equal(normalized.fulfilledUnits, 1);
    assert.equal(normalized.accepted, 2);
  });
});

test('request summary and lifecycle gates', async (t) => {
  await t.test('counts roster states and the collected percentage', () => {
    const summary = summarize(
      request({
        unitsNeeded: 4,
        assignments: [
          assignment({ id: 'a', status: 'COMPLETED' }),
          assignment({ id: 'b', status: 'ARRIVED' }),
          assignment({ id: 'c', status: 'ACCEPTED' }),
          assignment({ id: 'd', status: 'DECLINED' }),
          assignment({ id: 'e', status: 'PINGED' }),
        ],
      }),
      NOW,
    );
    assert.equal(summary.pinged, 5);
    assert.equal(summary.collected, 1);
    assert.equal(summary.arrived, 1);
    assert.equal(summary.enRoute, 1);
    assert.equal(summary.declined, 1);
    assert.equal(summary.responding, 3);
    assert.equal(summary.pct, 25);
    assert.equal(summary.expired, false);
  });

  await t.test('a request past expiresAt is flagged overdue and labelled as such', () => {
    const stale = request({ expiresAt: new Date(NOW - 60000).toISOString() });
    assert.equal(summarize(stale, NOW).expired, true);
    assert.match(statusLabel(stale, NOW), /overdue/i);
  });

  await t.test('escalation walks 1 -> 5 -> 15 km and then stops', () => {
    assert.equal(nextRadiusStep(1), 5);
    assert.equal(nextRadiusStep(5), 15);
    assert.equal(nextRadiusStep(15), null);
    assert.equal(canEscalate(request({ currentRadiusKm: 15 })), false);
    assert.equal(canEscalate(request({ currentRadiusKm: 1 })), true);
    assert.equal(canEscalate(request({ status: 'FULFILLED' })), false);
  });

  await t.test('closing requires an active request', () => {
    assert.equal(canClose(request()), true);
    assert.equal(canClose(request({ status: 'FULFILLED' })), false);
  });

  await t.test('cancellation is only offered when the API advertises the capability', () => {
    assert.equal(canCancel(request(), { cancelRequest: false }), false);
    assert.equal(canCancel(request(), undefined), false);
    assert.equal(canCancel(request(), { cancelRequest: true }), true);
    assert.equal(canCancel(request({ status: 'CANCELLED' }), { cancelRequest: true }), false);
  });
});

test('donor privacy', async (t) => {
  await t.test('identity is masked until the donor is on site', () => {
    const pinged = assignment({ status: 'PINGED' });
    const accepted = assignment({ status: 'ACCEPTED' });
    assert.equal(identityVisible(pinged), false);
    assert.equal(identityVisible(accepted), false);
    assert.equal(displayDonorLabel(pinged), `Donor #${donorRef(UUID_A)}`);
    assert.doesNotMatch(displayDonorLabel(pinged), /Asha/);
    assert.doesNotMatch(displayDonorLabel(accepted), /Asha/);
  });

  await t.test('identity is revealed for ARRIVED and COMPLETED donors', () => {
    assert.equal(displayDonorLabel(assignment({ status: 'ARRIVED' })), 'Asha Menon');
    assert.equal(displayDonorLabel(assignment({ status: 'COMPLETED' })), 'Asha Menon');
    assert.equal(donorInitials(assignment({ status: 'ARRIVED' })), 'AM');
  });

  await t.test('the reference is stable, opaque and non-sequential', () => {
    assert.match(donorRef(UUID_A), /^[0-9A-F]{4}$/);
    assert.equal(donorRef(UUID_A), donorRef(UUID_A));
    assert.notEqual(donorRef(UUID_A), donorRef(UUID_B));
    assert.equal(donorRef(''), '—');
    assert.doesNotMatch(donorRef('donor-1'), /DONOR/i);
  });

  await t.test('a masked avatar is a hex reference, never initials of a real name', () => {
    const masked = donorInitials(assignment({ status: 'PINGED' }));
    assert.match(masked, /^#[0-9A-F]{2}$/);
    assert.doesNotMatch(masked, /Asha|Menon/);
  });
});

test('feed ordering and filtering', async (t) => {
  const older = request({ id: 'req-old', createdAt: new Date(NOW - 60 * 60000).toISOString() });
  const newer = request({ id: 'req-new', createdAt: new Date(NOW - 1000).toISOString() });
  const closed = request({ id: 'req-closed', status: 'FULFILLED' });

  await t.test('active requests lead, newest first', () => {
    const sorted = sortRequests([closed, older, newer]);
    assert.deepEqual(
      sorted.map((item) => item.id),
      ['req-new', 'req-old', 'req-closed'],
    );
  });

  await t.test('filters split active from closed', () => {
    assert.deepEqual(filterRequests([older, closed], 'active').map((item) => item.id), ['req-old']);
    assert.deepEqual(filterRequests([older, closed], 'closed').map((item) => item.id), ['req-closed']);
    assert.equal(filterRequests([older, closed], 'all').length, 2);
  });

  await t.test('an unchanged poll payload is detected so the UI does not re-render', () => {
    const a = normalizeRequests([request()]);
    const b = normalizeRequests([request()]);
    assert.equal(sameRequests(a, b), true);
    assert.equal(sameRequests(a, normalizeRequests([request({ currentRadiusKm: 5 })])), false);
    assert.equal(
      sameRequests(a, normalizeRequests([request({ assignments: [assignment({ status: 'ACCEPTED' })] })])),
      false,
    );
  });
});

test('a lifecycle-only response cannot blank out the roster', () => {
  const previous = normalizeRequest(
    request({ assignments: [assignment({ id: 'a', status: 'ACCEPTED' }), assignment({ id: 'b', donorId: UUID_B, status: 'PINGED' })] }),
  );

  const cancelled = mergeRequestUpdate(previous, { id: 'req-1', status: 'CANCELLED' });
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.assignments.length, 2, 'the roster survives a status-only response');
  assert.equal(cancelled.pinged, 2);
  assert.equal(cancelled.accepted, 1);
  assert.equal(statusLabel(cancelled, NOW), 'Cancelled');
  assert.equal(canCancel(cancelled, { cancelRequest: true }), false, 'a cancelled request offers no further cancellation');

  const fullView = mergeRequestUpdate(previous, normalizeRequest(request({ status: 'FULFILLED', currentRadiusKm: 15 })));
  assert.equal(fullView.status, 'FULFILLED');
  assert.equal(fullView.currentRadiusKm, 15);

  const unknown = mergeRequestUpdate(previous, { id: 'other', status: 'CANCELLED' });
  assert.equal(unknown.id, 'other');
  assert.deepEqual(unknown.assignments, []);
});

test('duration formatting is human readable', () => {
  assert.equal(formatDuration(45000), '45s');
  assert.equal(formatDuration(125000), '2m 05s');
  assert.equal(formatDuration(3 * 3600000 + 5 * 60000), '3h 05m');
});
