import { test } from 'node:test';
import assert from 'node:assert/strict';

import { donorView, daysAgo, isEligible, nextEligibleDate } from '../src/lib/donor.js';
import {
  decodeTokenPayload,
  isTokenExpired,
  normalizeSession,
  serializeSession,
  toEpochMs,
} from '../src/lib/session.js';

const NOW = Date.parse('2026-05-01T00:00:00Z');

function donor(overrides = {}) {
  return {
    id: 'donor-1',
    bloodType: 'O-',
    dateOfBirth: '1995-01-01',
    weightKg: 65,
    consentAccepted: true,
    lastDonationDate: daysAgo(120, NOW),
    ...overrides,
  };
}

test('eligibility requires consent, weight, age and cooldown', () => {
  assert.equal(isEligible(donor(), NOW), true);
  assert.equal(isEligible(donor({ consentAccepted: false }), NOW), false);
  assert.equal(isEligible(donor({ weightKg: 49 }), NOW), false);
  assert.equal(isEligible(donor({ dateOfBirth: '2015-01-01' }), NOW), false);
  assert.equal(isEligible(donor({ dateOfBirth: '1950-01-01' }), NOW), false);
  assert.equal(isEligible(donor({ lastDonationDate: daysAgo(10, NOW) }), NOW), false);
  assert.equal(isEligible(null, NOW), false);
});

test('nextEligibleDate is 90 days after the last donation', () => {
  const date = nextEligibleDate(donor({ lastDonationDate: '2026-01-01' }), NOW);
  assert.equal(date, '2026-04-01');
});

test('donorView exposes the eligibility projection', () => {
  const view = donorView(donor({ lastDonationDate: daysAgo(10, NOW) }), NOW);
  assert.equal(view.eligible, false);
  assert.equal(typeof view.nextEligibleDate, 'string');
  assert.equal(donorView(null, NOW), null);
});

function jwt(payload) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode(payload)}.signature`;
}

test('token payload can be decoded without Buffer on Hermes-style runtimes', () => {
  const token = jwt({ role: 'donor', id: 'donor-1', exp: Math.floor(NOW / 1000) + 3600 });
  const payload = decodeTokenPayload(token);
  assert.equal(payload.role, 'donor');
  assert.equal(payload.id, 'donor-1');
  assert.equal(isTokenExpired(token, NOW), false);
});

/** The Pulse API issues `base64url(payload).base64url(hmac)` with exp in milliseconds. */
function apiToken(payload) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  return `${encode(payload)}.${encode({ signature: 'opaque-hmac' })}`;
}

test('two-segment Pulse API tokens are decoded and their millisecond expiry enforced', () => {
  const live = apiToken({ role: 'donor', id: 'donor-1', iat: NOW, exp: NOW + 3600000 });
  const payload = decodeTokenPayload(live);
  assert.equal(payload.role, 'donor');
  assert.equal(payload.id, 'donor-1');
  assert.equal(toEpochMs(payload.exp), NOW + 3600000);
  assert.equal(isTokenExpired(live, NOW), false);
  assert.ok(normalizeSession({ token: live, donor: { id: 'donor-1' } }, NOW));

  const expired = apiToken({ role: 'donor', id: 'donor-1', exp: NOW - 60000 });
  assert.equal(isTokenExpired(expired, NOW), true);
  assert.equal(normalizeSession({ token: expired, donor: { id: 'donor-1' } }, NOW), null);
});

test('expiry units are normalised for both seconds and milliseconds', () => {
  assert.equal(toEpochMs(1700000000), 1700000000000);
  assert.equal(toEpochMs(1700000000000), 1700000000000);
  assert.equal(toEpochMs(0), null);
  assert.equal(toEpochMs('not-a-number'), null);
  assert.equal(isTokenExpired('opaque-token', NOW), false);
});

test('expired or opaque sessions are rejected on restore', () => {
  const expired = jwt({ role: 'donor', id: 'donor-1', exp: Math.floor(NOW / 1000) - 10 });
  assert.equal(isTokenExpired(expired, NOW), true);
  assert.equal(normalizeSession({ token: expired, donor: { id: 'donor-1' } }, NOW), null);

  const live = jwt({ role: 'donor', id: 'donor-1', exp: Math.floor(NOW / 1000) + 3600 });
  const session = normalizeSession({ token: live, donor: { id: 'donor-1', bloodType: 'O-' } }, NOW);
  assert.equal(session.donor.id, 'donor-1');
  assert.ok(session.savedAt);

  // Opaque (non-JWT) tokens cannot be expiry-checked, so they are kept.
  assert.ok(normalizeSession({ token: 'opaque-token', donor: { id: 'd1' } }, NOW));
});

test('malformed session records are rejected', () => {
  assert.equal(normalizeSession(null, NOW), null);
  assert.equal(normalizeSession('not json', NOW), null);
  assert.equal(normalizeSession({ donor: { id: 'd1' } }, NOW), null);
  assert.equal(normalizeSession({ token: 't', donor: {} }, NOW), null);
  assert.equal(normalizeSession([], NOW), null);
});

test('serializeSession round-trips through normalizeSession', () => {
  const token = jwt({ role: 'donor', id: 'donor-1', exp: Math.floor(NOW / 1000) + 3600 });
  const serialized = serializeSession({ token, donor: { id: 'donor-1' } }, NOW);
  assert.equal(typeof serialized, 'string');
  assert.equal(normalizeSession(serialized, NOW).donor.id, 'donor-1');
  assert.equal(serializeSession({ token: '', donor: null }, NOW), null);
});
