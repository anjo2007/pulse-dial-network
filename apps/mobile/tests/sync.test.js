import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SYNC_CONFIG_ENDPOINT, describeSyncConfig, parseSyncConfig } from '../src/lib/sync.js';

const GOOD = {
  enabled: true,
  url: 'https://project.supabase.co',
  publishableKey: 'sb_publishable_example',
  accessToken: 'provider-access-token',
  topic: 'tenant:1:donor:alerts',
};

test('sync config endpoint matches the agreed contract', () => {
  assert.equal(SYNC_CONFIG_ENDPOINT, '/sync/config');
});

test('demo and malformed responses keep realtime disabled', () => {
  assert.deepEqual(parseSyncConfig({ enabled: false }), { enabled: false, reason: 'disabled' });
  assert.equal(parseSyncConfig(null).reason, 'no-config');
  assert.equal(parseSyncConfig(undefined).enabled, false);
  assert.equal(parseSyncConfig({}).enabled, false);
  assert.equal(parseSyncConfig([]).enabled, false);
  assert.equal(parseSyncConfig('enabled').enabled, false);
});

test('insecure or incomplete config is rejected fail-closed', () => {
  assert.equal(parseSyncConfig(GOOD).enabled, true);
  assert.equal(parseSyncConfig({ ...GOOD, url: 'http://project.supabase.co' }).reason, 'invalid-url');
  assert.equal(parseSyncConfig({ ...GOOD, url: 'ws://project.supabase.co' }).reason, 'invalid-url');
  assert.equal(parseSyncConfig({ ...GOOD, url: '' }).reason, 'invalid-url');
  assert.equal(parseSyncConfig({ ...GOOD, publishableKey: '' }).reason, 'invalid-publishable-key');
  assert.equal(parseSyncConfig({ ...GOOD, publishableKey: 'x'.repeat(513) }).reason, 'invalid-publishable-key');
  assert.equal(parseSyncConfig({ ...GOOD, accessToken: '   ' }).reason, 'invalid-access-token');
  assert.equal(parseSyncConfig({ ...GOOD, topic: 'bad topic!' }).reason, 'invalid-topic');
  assert.equal(parseSyncConfig({ ...GOOD, topic: 'x'.repeat(129) }).reason, 'invalid-topic');
  assert.equal(parseSyncConfig({ ...GOOD, url: 'https://project.supabase.co/' }).url, 'https://project.supabase.co');
});

test('diagnostics never echo secrets', () => {
  const config = parseSyncConfig({ ...GOOD, publishableKey: 'sb_publishable_secret', accessToken: 'super-secret' });
  const described = JSON.stringify(describeSyncConfig(config));
  assert.ok(!described.includes('super-secret'));
  assert.ok(!described.includes('sb_publishable_secret'));
  assert.deepEqual(describeSyncConfig(config), { enabled: true, secure: true, hasAccessToken: true });
  assert.deepEqual(describeSyncConfig({ enabled: false, reason: 'disabled' }), {
    enabled: false,
    reason: 'disabled',
  });
});
