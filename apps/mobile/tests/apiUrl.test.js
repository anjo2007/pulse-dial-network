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

test('http endpoints are rejected outside development (release blocks cleartext)', () => {
  const release = isAcceptableApiUrl('http://10.0.2.2:4000', { allowInsecure: false });
  assert.equal(release.ok, false);
  assert.equal(release.reason, 'insecure');

  const dev = isAcceptableApiUrl('http://10.0.2.2:4000', { allowInsecure: true });
  assert.equal(dev.ok, true);
  assert.equal(dev.value, 'http://10.0.2.2:4000');

  // Emulator loopback and LAN dev servers behave identically: allowed only in development.
  assert.equal(isAcceptableApiUrl('http://192.168.1.20:4000', { allowInsecure: false }).ok, false);
  assert.equal(isAcceptableApiUrl('http://192.168.1.20:4000', { allowInsecure: true }).ok, true);
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
