/**
 * Secure session + donor phone storage.
 *
 *  - Session token and donor phone live in the OS keystore/Keychain via expo-secure-store.
 *  - Non-sensitive preferences stay in AsyncStorage.
 *  - If SecureStore is unavailable, writes are refused rather than degrading to plaintext:
 *    a donor can always sign in again, but a leaked keychain-less token is unrecoverable.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';

import { STORAGE_KEYS } from '../config.js';
import { normalizeSession, serializeSession } from '../lib/session.js';

function secureStoreAvailable() {
  return typeof SecureStore?.getItemAsync === 'function';
}

async function readSecure(key) {
  if (!secureStoreAvailable()) return null;
  try {
    return await SecureStore.getItemAsync(key);
  } catch (_) {
    return null;
  }
}

async function writeSecure(key, value) {
  if (!secureStoreAvailable()) return false;
  try {
    await SecureStore.setItemAsync(key, value);
    return true;
  } catch (_) {
    return false;
  }
}

async function deleteSecure(key) {
  if (!secureStoreAvailable()) return;
  try {
    await SecureStore.deleteItemAsync(key);
  } catch (_) {
    // ignore: key may not exist
  }
}

/** @returns {{session: object|null, secure: boolean}} */
export async function loadSession(now = Date.now()) {
  const raw = await readSecure(STORAGE_KEYS.session);
  if (raw) {
    const session = normalizeSession(raw, now);
    if (session) return { session, secure: true };
    // Expired/corrupt secure record: drop it so the user is prompted to sign in again.
    await deleteSecure(STORAGE_KEYS.session);
    return { session: null, secure: true };
  }

  // One-time migration from the legacy plaintext AsyncStorage record.
  const legacy = await AsyncStorage.getItem('pulse-dial-session');
  if (legacy) {
    const session = normalizeSession(legacy, now);
    await AsyncStorage.removeItem('pulse-dial-session');
    if (session) {
      const stored = await writeSecure(STORAGE_KEYS.session, serializeSession(session, now));
      return { session, secure: stored };
    }
  }
  return { session: null, secure: secureStoreAvailable() };
}

/** @returns {boolean} true when the session was persisted to the OS secure store. */
export async function saveSession(session, now = Date.now()) {
  const serialized = serializeSession(session, now);
  if (!serialized) return false;
  // Never keep a plaintext copy around, even as a fallback.
  await AsyncStorage.removeItem('pulse-dial-session');
  return writeSecure(STORAGE_KEYS.session, serialized);
}

export async function clearSession() {
  await deleteSecure(STORAGE_KEYS.session);
  await AsyncStorage.removeItem('pulse-dial-session');
  await deleteSecure(STORAGE_KEYS.donorPhone);
}

export async function loadDonorPhone() {
  return readSecure(STORAGE_KEYS.donorPhone);
}

export async function saveDonorPhone(phone) {
  if (!phone) return;
  await writeSecure(STORAGE_KEYS.donorPhone, String(phone));
}
