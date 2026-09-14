import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALERT_PAYLOAD_VERSION,
  CHANNEL_PRESET,
  DEVICE_ENDPOINTS,
  buildDeviceRegistrationPayload,
  classifyRegistrationError,
  computeAlertingStatus,
  describeAlertCapabilities,
  isExpoPushToken,
  isSafeId,
  parseDeepLink,
  resolveAlertRoute,
  sanitizeAlertPayload,
} from '../src/lib/alerts.js';

test('channel preset is high-importance and lock-screen private', () => {
  assert.equal(CHANNEL_PRESET.id, 'emergency-blood-alerts');
  assert.equal(CHANNEL_PRESET.importance, 'MAX');
  assert.equal(CHANNEL_PRESET.lockscreenVisibility, 'PRIVATE');
  assert.equal(CHANNEL_PRESET.bypassDnd, false, 'DND bypass requires a policy exemption we do not have');
  assert.ok(Array.isArray(CHANNEL_PRESET.vibrationPattern));
});

test('payload sanitizer accepts only a safe assignmentId and drops everything else', () => {
  const ok = sanitizeAlertPayload({ assignmentId: 'asg_123-abc', patientName: 'Jane', phone: '+91 90000 00000' });
  assert.equal(ok.ok, true);
  assert.deepEqual(Object.keys(ok.alert).sort(), ['assignmentId', 'type', 'version']);
  assert.equal(ok.alert.version, ALERT_PAYLOAD_VERSION);
  assert.equal(ok.alert.assignmentId, 'asg_123-abc');

  assert.equal(sanitizeAlertPayload(null).reason, 'missing-data');
  assert.equal(sanitizeAlertPayload({}).reason, 'missing-assignment-id');
  assert.equal(sanitizeAlertPayload({ assignmentId: '   ' }).reason, 'missing-assignment-id');
  assert.equal(sanitizeAlertPayload({ assignmentId: '../etc/passwd' }).reason, 'invalid-assignment-id');
  assert.equal(sanitizeAlertPayload({ assignmentId: 'a'.repeat(200) }).reason, 'invalid-assignment-id');
  assert.equal(sanitizeAlertPayload('assignmentId=1').reason, 'missing-data');
});

test('resolveAlertRoute maps a payload to the in-app route', () => {
  assert.deepEqual(resolveAlertRoute({ assignmentId: 'a1' }), { name: 'alert', assignmentId: 'a1' });
  assert.equal(resolveAlertRoute({ assignmentId: 'bad id!' }), null);
});

test('isSafeId / isExpoPushToken are conservative', () => {
  assert.equal(isSafeId('ins-android-1'), true);
  assert.equal(isSafeId(''), false);
  assert.equal(isSafeId('a b'), false);
  assert.equal(isExpoPushToken('ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]'), true);
  assert.equal(isExpoPushToken('ExpoPushToken[abc-123_XYZ]'), true);
  assert.equal(isExpoPushToken('fcm-token-raw'), false);
  assert.equal(isExpoPushToken(''), false);
});

test('deep links are restricted to our scheme and known routes', () => {
  assert.deepEqual(parseDeepLink('pulsedial://alert/asg-1'), { name: 'alert', assignmentId: 'asg-1' });
  assert.deepEqual(parseDeepLink('pulsedial://alerts'), { name: 'alerts' });
  assert.deepEqual(parseDeepLink('pulsedial://'), { name: 'home' });
  assert.equal(parseDeepLink('https://evil.example/alert/a1'), null);
  assert.equal(parseDeepLink('com.pulsedial.donor://alert/a1'), null);
  assert.equal(parseDeepLink('pulsedial://alert/../../secret'), null);
  assert.equal(parseDeepLink(undefined), null);
});

test('capabilities never claim overlay or full-screen intent', () => {
  for (const platform of ['android', 'ios']) {
    const caps = describeAlertCapabilities(platform);
    assert.equal(caps.headsUp, true);
    assert.equal(caps.fullScreenIntent, false);
    assert.equal(caps.overlay, false);
    assert.equal(caps.criticalAlerts, false);
  }
});

test('alerting status is permission-aware and honest about limits', () => {
  const paused = computeAlertingStatus({ permissionStatus: 'granted', channelReady: true, availabilityEnabled: false });
  assert.equal(paused.level, 'paused');
  assert.ok(paused.actions.includes('enable-availability'));
  assert.equal(paused.canAlertWhileClosed, false);

  const blocked = computeAlertingStatus({
    permissionStatus: 'denied',
    canAskAgain: false,
    channelReady: true,
    availabilityEnabled: true,
  });
  assert.equal(blocked.level, 'blocked');
  assert.ok(blocked.actions.includes('open-settings'));
  assert.ok(!blocked.actions.includes('request-permission'));

  const askable = computeAlertingStatus({
    permissionStatus: 'undetermined',
    canAskAgain: true,
    channelReady: true,
    availabilityEnabled: true,
  });
  assert.ok(askable.actions.includes('request-permission'));

  const noPush = computeAlertingStatus({
    permissionStatus: 'granted',
    channelReady: true,
    availabilityEnabled: true,
    tokenRegistered: false,
  });
  assert.equal(noPush.level, 'degraded');
  assert.equal(noPush.canAlertWhileClosed, false);

  const ok = computeAlertingStatus({
    platform: 'android',
    permissionStatus: 'granted',
    channelReady: true,
    availabilityEnabled: true,
    tokenRegistered: true,
  });
  assert.equal(ok.level, 'ok');
  assert.equal(ok.canAlertWhileClosed, true);
});

test('device registration payload matches the backend contract', () => {
  const result = buildDeviceRegistrationPayload({
    installationId: 'ins-android-abc',
    expoPushToken: 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]',
    platform: 'android',
  });
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.body).sort(), ['expoPushToken', 'installationId', 'platform']);
  assert.equal(result.body.platform, 'android');

  assert.equal(buildDeviceRegistrationPayload({ installationId: 'bad id', platform: 'android' }).reason, 'invalid-installation-id');
  assert.equal(buildDeviceRegistrationPayload({ installationId: 'ins-1', platform: 'windows' }).reason, 'unsupported-platform');

  // Token-less registration is allowed (permission granted, push credentials absent).
  const tokenless = buildDeviceRegistrationPayload({ installationId: 'ins-1', platform: 'ios' });
  assert.equal(tokenless.ok, true);
  assert.equal(tokenless.body.expoPushToken, null);
});

test('device endpoints follow the fixed contract', () => {
  assert.equal(DEVICE_ENDPOINTS.register, '/donor/devices');
  assert.equal(DEVICE_ENDPOINTS.unregister('ins/../x'), '/donor/devices/ins%2F..%2Fx');
});

test('registration errors are classified for retry decisions', () => {
  assert.deepEqual(classifyRegistrationError({ status: 0 }), { retryable: true, code: 'network' });
  assert.deepEqual(classifyRegistrationError({ status: 503 }), { retryable: true, code: 'transient' });
  assert.deepEqual(classifyRegistrationError({ status: 429 }), { retryable: true, code: 'transient' });
  assert.deepEqual(classifyRegistrationError({ status: 410 }), { retryable: false, code: 'gone' });
  assert.deepEqual(classifyRegistrationError({ status: 401 }), { retryable: false, code: 'rejected' });
  assert.equal(classifyRegistrationError(undefined).retryable, true);
});
