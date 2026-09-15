import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeFunctionUrl } from '../../../api/index.js';

test('Vercel Entrypoint URL Normalization', async (t) => {
  await t.test('handles standard /api route without query', () => {
    assert.equal(normalizeFunctionUrl('/api'), '/api');
    assert.equal(normalizeFunctionUrl('/api/'), '/api/');
  });

  await t.test('handles /api/index.js without route query', () => {
    assert.equal(normalizeFunctionUrl('/api/index.js'), '/api');
    assert.equal(normalizeFunctionUrl('/api/index'), '/api');
  });

  await t.test('normalizes /api/index.js with __route parameter', () => {
    assert.equal(normalizeFunctionUrl('/api/index.js?__route=/auth/hospital'), '/api/auth/hospital');
    assert.equal(normalizeFunctionUrl('/api/index?__route=/health'), '/api/health');
  });

  await t.test('normalizes /api with __route parameter', () => {
    assert.equal(normalizeFunctionUrl('/api?__route=/auth/hospital'), '/api/auth/hospital');
    assert.equal(normalizeFunctionUrl('/api/?__route=/health'), '/api/health');
  });

  await t.test('preserves direct sub-paths from catch-all router', () => {
    assert.equal(normalizeFunctionUrl('/api/auth/hospital'), '/api/auth/hospital');
    assert.equal(normalizeFunctionUrl('/api/health'), '/api/health');
    assert.equal(normalizeFunctionUrl('/api/auth/donor/request-otp'), '/api/auth/donor/request-otp');
  });

  await t.test('preserves existing query parameters alongside __route', () => {
    assert.equal(normalizeFunctionUrl('/api/index.js?__route=/health&verbose=true'), '/api/health?verbose=true');
  });

  await t.test('rejects malicious routes', () => {
    assert.equal(normalizeFunctionUrl('/api?__route=//evil.com'), null);
    assert.equal(normalizeFunctionUrl('/api?__route=relative/path'), null);
    assert.equal(normalizeFunctionUrl('/api?__route=/with\\backslash'), null);
  });
});
