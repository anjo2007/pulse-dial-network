import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOOD_TYPES,
  MAX_UNITS,
  URGENCY_LEVELS,
  collectionProgress,
  validateCheckinToken,
  validateCredentials,
  validateNewRequest,
} from '../src/lib/validation.js';

test('credentials validation', async (t) => {
  await t.test('rejects empty and malformed input with field-level messages', () => {
    const empty = validateCredentials({ email: '', password: '' });
    assert.equal(empty.valid, false);
    assert.ok(empty.errors.email);
    assert.ok(empty.errors.password);

    const malformed = validateCredentials({ email: 'not-an-email', password: 'short' });
    assert.equal(malformed.valid, false);
    assert.match(malformed.errors.email, /valid email/i);
    assert.match(malformed.errors.password, /6 characters/i);
  });

  await t.test('trims the email and accepts a valid pair', () => {
    const result = validateCredentials({ email: '  admin@centralhospital.demo ', password: 'demo123' });
    assert.equal(result.valid, true);
    assert.equal(result.value.email, 'admin@centralhospital.demo');
    assert.deepEqual(result.errors, {});
  });
});

test('new request validation', async (t) => {
  await t.test('accepts a valid dispatch request', () => {
    const result = validateNewRequest({ bloodType: 'O-', unitsNeeded: '2', urgency: 'CRITICAL' });
    assert.equal(result.valid, true);
    assert.deepEqual(result.value, { bloodType: 'O-', unitsNeeded: 2, urgency: 'CRITICAL' });
  });

  await t.test('rejects unknown blood group, urgency and non-integer units', () => {
    const result = validateNewRequest({ bloodType: 'XX', unitsNeeded: '1.5', urgency: 'SOMEDAY' });
    assert.equal(result.valid, false);
    assert.ok(result.errors.bloodType);
    assert.match(result.errors.unitsNeeded, /whole number/i);
    assert.ok(result.errors.urgency);
  });

  await t.test('enforces the unit bounds and treats blank input as missing', () => {
    assert.match(validateNewRequest({ bloodType: 'A+', unitsNeeded: '0', urgency: 'NORMAL' }).errors.unitsNeeded, /at least/i);
    assert.match(
      validateNewRequest({ bloodType: 'A+', unitsNeeded: String(MAX_UNITS + 1), urgency: 'NORMAL' }).errors.unitsNeeded,
      new RegExp(`caps a single request at ${MAX_UNITS}`),
    );
    assert.match(validateNewRequest({ bloodType: 'A+', unitsNeeded: '', urgency: 'NORMAL' }).errors.unitsNeeded, /how many units/i);
  });

  await t.test('every blood type offered by the UI is accepted by the validator', () => {
    for (const bloodType of BLOOD_TYPES) {
      assert.equal(validateNewRequest({ bloodType, unitsNeeded: 1, urgency: URGENCY_LEVELS[0] }).valid, true);
    }
  });
});

test('arrival token validation', async (t) => {
  await t.test('accepts a scanned token, tolerating whitespace, newlines and lower case', () => {
    const result = validateCheckinToken('  pulse:8a0d0f2e-1c3a-4f5b-9a11-2b3c4d5e6f70:AB12cd34\n');
    assert.equal(result.valid, true);
    assert.equal(result.value, 'PULSE:8a0d0f2e-1c3a-4f5b-9a11-2b3c4d5e6f70:AB12cd34');

    const hyphenated = validateCheckinToken('PULSE:974fb716-a926-4750-b81e-34b5de7c1932:6574b10f-815');
    assert.equal(hyphenated.valid, true);
    assert.equal(hyphenated.value, 'PULSE:974fb716-a926-4750-b81e-34b5de7c1932:6574b10f-815');
  });

  await t.test('rejects empty, truncated and unrelated text with a format hint', () => {
    for (const input of ['', '   ', 'PULSE:', 'PULSE:abc', 'https://example.com']) {
      const result = validateCheckinToken(input);
      assert.equal(result.valid, false, `expected ${JSON.stringify(input)} to be rejected`);
      assert.ok(result.errors.token);
    }
  });
});

test('collection progress is clamped and safe on bad data', () => {
  assert.deepEqual(collectionProgress(3, 2), { needed: 3, collected: 2, remaining: 1, pct: 67 });
  assert.deepEqual(collectionProgress(2, 5), { needed: 2, collected: 5, remaining: 0, pct: 100 });
  assert.deepEqual(collectionProgress(undefined, undefined), { needed: 0, collected: 0, remaining: 0, pct: 0 });
  assert.equal(collectionProgress(0, 0).pct, 0);
});
