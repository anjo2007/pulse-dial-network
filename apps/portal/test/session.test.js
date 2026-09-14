import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }
  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }
  setItem(key, value) {
    this.map.set(key, String(value));
  }
  removeItem(key) {
    this.map.delete(key);
  }
}

class ThrowingStorage {
  getItem() {
    throw new Error('storage disabled');
  }
  setItem() {
    throw new Error('storage disabled');
  }
  removeItem() {
    throw new Error('storage disabled');
  }
}

const token = (payload) => `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.signature`;

import {
  SESSION_STORAGE_KEY,
  LEGACY_SESSION_KEY,
  clearStoredSession,
  createSession,
  decodeSessionToken,
  formatRemaining,
  persistSession,
  readStoredSession,
  safeStorage,
  sanitizeHospital,
  sessionIsUsable,
  sessionRemainingMs,
} from '../src/lib/session.js';

test.beforeEach(() => {
  globalThis.localStorage = new MemoryStorage();
  globalThis.sessionStorage = new MemoryStorage();
});

test('token decoding and session creation', async (t) => {
  await t.test('decodes the signed payload', () => {
    const decoded = decodeSessionToken(token({ role: 'hospital', id: 'hospital-central', exp: 1893456000000 }));
    assert.equal(decoded.role, 'hospital');
    assert.equal(decoded.id, 'hospital-central');
  });

  await t.test('garbage tokens decode to null instead of throwing', () => {
    for (const bad of [null, '', 'nodot', 'a.b', '!!!.@@@', undefined]) {
      assert.equal(decodeSessionToken(bad), null);
    }
  });

  await t.test('a donor token can never open the hospital portal', () => {
    const donorToken = token({ role: 'donor', id: 'donor-1', exp: Date.now() + 60000 });
    assert.equal(createSession({ token: donorToken, hospital: { name: 'X' } }), null);
  });

  await t.test('a login response without a token is rejected', () => {
    assert.equal(createSession({ hospital: { name: 'X' } }), null);
    assert.equal(createSession(null), null);
  });

  await t.test('only the whitelisted hospital fields survive', () => {
    const session = createSession({
      token: token({ role: 'hospital', id: 'hospital-central', authUserId: 'internal-supabase-id', exp: Date.now() + 3600000 }),
      hospital: {
        id: 'hospital-central',
        name: 'Central City Medical Centre',
        licenseNumber: 'MH-EMR-2026-0021',
        password: 'demo123',
        email: 'admin@centralhospital.demo',
      },
    });
    assert.equal(session.role, 'hospital');
    assert.equal(session.subjectId, 'hospital-central');
    assert.deepEqual(Object.keys(session.hospital).sort(), ['id', 'licenseNumber', 'name']);
    assert.equal(JSON.stringify(session).includes('demo123'), false);
    assert.equal(JSON.stringify(session).includes('authUserId'), false);
  });

  await t.test('a token without an exp falls back to a bounded session', () => {
    const now = 1_000_000;
    const session = createSession({ token: token({ role: 'hospital', id: 'h' }), hospital: {} }, { now });
    assert.equal(session.expiresAtMs, now + 7 * 24 * 60 * 60 * 1000);
  });

  await t.test('sanitizeHospital never returns undefined fields', () => {
    assert.deepEqual(sanitizeHospital(undefined), { id: 'hospital', name: 'Hospital', licenseNumber: 'License not provided' });
  });
});

test('session validity and countdown', async (t) => {
  const future = Date.now() + 60 * 60 * 1000;
  const session = { token: 'x.y', role: 'hospital', expiresAtMs: future, hospital: { id: 'h', name: 'H', licenseNumber: 'L' } };

  await t.test('usable until the expiry instant, never after', () => {
    assert.equal(sessionIsUsable(session, future - 1), true);
    assert.equal(sessionIsUsable(session, future), false);
    assert.equal(sessionIsUsable(null), false);
    assert.equal(sessionIsUsable({ token: 'x.y' }), false);
  });

  await t.test('remaining time never goes negative', () => {
    assert.equal(sessionRemainingMs(session, future + 1000), 0);
    assert.equal(sessionRemainingMs(null), 0);
  });

  await t.test('countdown copy is readable', () => {
    assert.equal(formatRemaining(0), 'expired');
    assert.equal(formatRemaining(-5), 'expired');
    assert.equal(formatRemaining(45000), '45s');
    assert.equal(formatRemaining(90 * 60 * 1000), '1h 30m');
    assert.equal(formatRemaining(2 * 86400000 + 3 * 3600000), '2d 3h');
  });
});

test('storage hardening', async (t) => {
  await t.test('unavailable storage degrades instead of throwing', () => {
    globalThis.localStorage = new ThrowingStorage();
    globalThis.sessionStorage = new ThrowingStorage();
    assert.equal(safeStorage('local'), null);
    assert.equal(safeStorage('session'), null);
    assert.equal(persistSession({ token: 'x.y', expiresAtMs: Date.now() + 1000 }), false);
    assert.equal(readStoredSession(), null);
    assert.doesNotThrow(() => clearStoredSession());
  });

  await t.test('an ephemeral session lands in sessionStorage only', () => {
    const session = createSession(
      { token: token({ role: 'hospital', id: 'h', exp: Date.now() + 60000 }), hospital: { name: 'Central' } },
    );
    assert.equal(persistSession(session, { persistent: false }), true);
    assert.ok(globalThis.sessionStorage.getItem(SESSION_STORAGE_KEY));
    assert.equal(globalThis.localStorage.getItem(SESSION_STORAGE_KEY), null);
    const restored = readStoredSession();
    assert.equal(restored.hospital.name, 'Central');
    assert.equal(restored.persistent, false);
  });

  await t.test('an opt-in session lands in localStorage and clears the ephemeral copy', () => {
    const session = createSession(
      { token: token({ role: 'hospital', id: 'h', exp: Date.now() + 60000 }), hospital: { name: 'Central' } },
    );
    persistSession(session, { persistent: false });
    assert.equal(persistSession(session, { persistent: true }), true);
    assert.ok(globalThis.localStorage.getItem(SESSION_STORAGE_KEY));
    assert.equal(globalThis.sessionStorage.getItem(SESSION_STORAGE_KEY), null);
    assert.equal(readStoredSession().persistent, true);
  });

  await t.test('a legacy record is migrated, and an expired legacy record is deleted', () => {
    const liveToken = token({ role: 'hospital', id: 'h', exp: Date.now() + 60000 });
    globalThis.localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify({ token: liveToken, hospital: { name: 'Legacy' } }));
    const migrated = readStoredSession();
    assert.equal(migrated.hospital.name, 'Legacy');
    assert.ok(migrated.expiresAtMs > Date.now());

    globalThis.localStorage.setItem(
      LEGACY_SESSION_KEY,
      JSON.stringify({ token: token({ role: 'hospital', id: 'h', exp: Date.now() - 1000 }) }),
    );
    globalThis.sessionStorage.map.clear();
    assert.equal(readStoredSession(), null);
    assert.equal(globalThis.localStorage.getItem(LEGACY_SESSION_KEY), null);
  });

  await t.test('expired, tampered and non-hospital records are purged on read', () => {
    const expired = token({ role: 'hospital', id: 'h', exp: Date.now() - 5000 });
    globalThis.sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ token: expired, role: 'hospital', expiresAtMs: Date.now() - 5000, hospital: { name: 'Gone' } }),
    );
    assert.equal(readStoredSession(), null);
    assert.equal(globalThis.sessionStorage.getItem(SESSION_STORAGE_KEY), null);

    globalThis.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: 'a.b' }));
    assert.equal(readStoredSession(), null);
    assert.equal(globalThis.sessionStorage.getItem(SESSION_STORAGE_KEY), null);

    globalThis.sessionStorage.setItem(
      SESSION_STORAGE_KEY,
      JSON.stringify({ token: token({ role: 'donor', id: 'd', exp: Date.now() + 60000 }), role: 'hospital', expiresAtMs: Date.now() + 60000 }),
    );
    assert.equal(readStoredSession(), null);
  });

  await t.test('sign-out clears every key in every store', () => {
    globalThis.sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: 'a.b' }));
    globalThis.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ token: 'a.b' }));
    globalThis.localStorage.setItem(LEGACY_SESSION_KEY, JSON.stringify({ token: 'a.b' }));
    clearStoredSession();
    assert.equal(globalThis.sessionStorage.getItem(SESSION_STORAGE_KEY), null);
    assert.equal(globalThis.localStorage.getItem(SESSION_STORAGE_KEY), null);
    assert.equal(globalThis.localStorage.getItem(LEGACY_SESSION_KEY), null);
    assert.equal(readStoredSession(), null);
  });
});
