import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isAcceptableApiUrl } from '../src/config.js';

test('https endpoints are always accepted and trailing slashes are trimmed', () => {
  assert.deepEqual(isAcceptableApiUrl('https://pulse.example.com/api'), {
    ok: true,
    value: 'https://pulse.example.com/api',
  });
  assert.deepEqual(isAcceptableApiUrl('  https://pulse.example.com/api///  '), {
    ok: true,
    value: 'https://pulse.example.com/api',
  });
});

test('http endpoints are accepted and trailing slashes are trimmed', () => {
  const lan = isAcceptableApiUrl('http://192.168.1.5:4000///');
  assert.equal(lan.ok, true);
  assert.equal(lan.value, 'http://192.168.1.5:4000');

  const emulator = isAcceptableApiUrl('http://10.0.2.2:4000');
  assert.equal(emulator.ok, true);
  assert.equal(emulator.value, 'http://10.0.2.2:4000');

  const blockedWhenInsecureDisabled = isAcceptableApiUrl('http://10.0.2.2:4000', { allowInsecure: false });
  assert.equal(blockedWhenInsecureDisabled.ok, false);
  assert.equal(blockedWhenInsecureDisabled.reason, 'insecure');
});

test('empty, malformed and non-http schemes are rejected', () => {
  for (const value of ['', '   ', null, undefined, 42]) {
    assert.deepEqual(isAcceptableApiUrl(value, { allowInsecure: true }), { ok: false, reason: 'missing' });
  }
  for (const value of ['pulse.example.com/api', 'ftp://pulse.example.com', 'ws://pulse.example.com', 'https://']) {
    const result = isAcceptableApiUrl(value, { allowInsecure: true });
    assert.equal(result.ok, false, `${value} should be rejected`);
    assert.equal(result.reason, 'invalid');
  }
});
