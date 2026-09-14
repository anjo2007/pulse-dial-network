/**
 * Thin, defensive wrapper around expo-notifications.
 *
 * Everything is wrapped so a missing/unavailable native module degrades the app instead of
 * crashing it: the donor can still see requests with the in-app polling fallback.
 *
 * Alerting model (see NOTIFICATIONS.md):
 *  - One high-importance Android channel -> heads-up banner above other apps when the OS allows it.
 *  - No SYSTEM_ALERT_WINDOW, no full-screen-intent abuse, no fake alarm/call impersonation.
 */

import { Linking, Platform } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';

import {
  EAS_PROJECT_ID,
  LOCAL_ALERT_SIMULATOR_ENABLED,
  PUSH_TOKEN_ENABLED,
  STORAGE_KEYS,
} from '../config.js';
import { CHANNEL_PRESET, isExpoPushToken, isSafeId } from '../lib/alerts.js';

const ANDROID_IMPORTANCE = () => Notifications?.AndroidImportance?.MAX ?? 7;
const ANDROID_VISIBILITY = () => Notifications?.AndroidNotificationVisibility?.PRIVATE ?? 2;

// Foreground presentation behaviour, registered once at module load.
// Both key sets are returned so the same code works on SDK 52 (shouldShowAlert) and 53+
// (shouldShowBanner / shouldShowList); unknown keys are ignored by the native layer.
try {
  Notifications?.setNotificationHandler?.({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
  });
} catch (_) {
  // Native module unavailable (e.g. web / test env): ignore.
}

export const AlertNotifications = {
  channelId: CHANNEL_PRESET.id,

  /** Create/refresh the single high-importance alert channel. Android 13+ also needs this
   *  to exist before the notification-permission prompt can be shown. */
  async ensureChannel() {
    if (Platform.OS !== 'android') return { ready: true, reason: null };
    try {
      await Notifications.setNotificationChannelAsync(CHANNEL_PRESET.id, {
        name: CHANNEL_PRESET.name,
        description: CHANNEL_PRESET.description,
        importance: ANDROID_IMPORTANCE(),
        vibrationPattern: CHANNEL_PRESET.vibrationPattern,
        lightColor: CHANNEL_PRESET.lightColor,
        lockscreenVisibility: ANDROID_VISIBILITY(),
        enableVibrate: CHANNEL_PRESET.enableVibrate,
        showBadge: CHANNEL_PRESET.showBadge,
        bypassDnd: CHANNEL_PRESET.bypassDnd,
        sound: CHANNEL_PRESET.sound,
      });
      const channel = await Notifications.getNotificationChannelAsync?.(CHANNEL_PRESET.id);
      const ready = channel ? channel.importance >= 6 : true;
      return {
        ready,
        reason: ready ? null : 'channel-importance-downgraded-by-user',
        importance: channel?.importance ?? null,
      };
    } catch (error) {
      return { ready: false, reason: error?.message || 'channel-error' };
    }
  },

  async getPermission() {
    try {
      if (Platform.OS === 'android') await this.ensureChannel();
      const settings = await Notifications.getPermissionsAsync();
      const iosStatus = settings?.ios?.status ?? null;
      const provisional =
        iosStatus !== null && iosStatus === (Notifications?.IosAuthorizationStatus?.PROVISIONAL ?? 3);
      return {
        status: provisional ? 'granted' : settings?.status ?? 'undetermined',
        granted: Boolean(settings?.granted) || provisional,
        canAskAgain: settings?.canAskAgain !== false,
        iosStatus,
      };
    } catch (error) {
      return { status: 'undetermined', granted: false, canAskAgain: true, iosStatus: null, error: error?.message };
    }
  },

  async requestPermission() {
    try {
      if (Platform.OS === 'android') await this.ensureChannel();
      const settings = await Notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowBadge: false, allowSound: true },
      });
      return {
        status: settings?.status ?? 'undetermined',
        granted: Boolean(settings?.granted),
        canAskAgain: settings?.canAskAgain !== false,
        iosStatus: settings?.ios?.status ?? null,
      };
    } catch (error) {
      return { status: 'undetermined', granted: false, canAskAgain: true, iosStatus: null, error: error?.message };
    }
  },

  /** Stable, opaque per-installation identifier (not a secret, no PII). */
  async getInstallationId() {
    try {
      const existing = await AsyncStorage.getItem(STORAGE_KEYS.installationId);
      if (existing && isSafeId(existing)) return existing;
      const generated = `ins-${Platform.OS}-${Date.now().toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 10)}`;
      await AsyncStorage.setItem(STORAGE_KEYS.installationId, generated);
      return generated;
    } catch (_) {
      return `ins-${Platform.OS}-ephemeral`;
    }
  },

  /**
   * Acquire an Expo push token.
   * Returns ok:false with a reason instead of throwing when credentials are missing, which is the
   * expected state for local builds without an EAS project / google-services.json.
   */
  async acquirePushToken() {
    if (!PUSH_TOKEN_ENABLED) return { ok: false, reason: 'push-disabled' };
    if (Platform.OS === 'web') return { ok: false, reason: 'unsupported-platform' };
    if (Device && Device.isDevice === false) return { ok: false, reason: 'not-a-physical-device' };
    const projectId =
      EAS_PROJECT_ID
      || Constants?.expoConfig?.extra?.eas?.projectId
      || Constants?.easConfig?.projectId
      || '';
    if (!projectId) return { ok: false, reason: 'missing-project-id' };
    try {
      if (Platform.OS === 'android') await this.ensureChannel();
      const result = await Notifications.getExpoPushTokenAsync({ projectId });
      const token = result?.data;
      if (!isExpoPushToken(token)) return { ok: false, reason: 'invalid-token' };
      return { ok: true, token, projectId };
    } catch (error) {
      return { ok: false, reason: 'token-error', message: error?.message };
    }
  },

  /** Subscribe to receive + tap events. Returns a single disposer. */
  addListeners({ onReceive, onResponse, onDropped } = {}) {
    const subscriptions = [];
    try {
      if (onReceive) subscriptions.push(Notifications.addNotificationReceivedListener(onReceive));
      if (onResponse) subscriptions.push(Notifications.addNotificationResponseReceivedListener(onResponse));
      if (onDropped && Notifications.addNotificationsDroppedListener) {
        subscriptions.push(Notifications.addNotificationsDroppedListener(onDropped));
      }
    } catch (_) {
      // Native module unavailable.
    }
    return {
      remove() {
        subscriptions.forEach((subscription) => {
          try {
            subscription?.remove?.();
          } catch (_) {
            // ignore
          }
        });
      },
    };
  },

  /** Response that launched the app from a cold start (tap on a notification). */
  async getInitialResponse() {
    try {
      return await Notifications.getLastNotificationResponseAsync?.();
    } catch (_) {
      return null;
    }
  },

  async clearInitialResponse() {
    try {
      await Notifications.clearLastNotificationResponseAsync?.();
    } catch (_) {
      // ignore
    }
  },

  /** Deep link delivered while the app is not running (scheme: pulsedial://). */
  getInitialUrl() {
    return Linking.getInitialURL?.() ?? Promise.resolve(null);
  },

  addUrlListener(handler) {
    try {
      const subscription = Linking.addEventListener('url', ({ url }) => handler(url));
      return { remove: () => subscription?.remove?.() };
    } catch (_) {
      return { remove: () => {} };
    }
  },

  async openSystemSettings() {
    try {
      if (Platform.OS === 'ios') {
        await Linking.openURL('app-settings:');
      } else {
        await Linking.openSettings?.();
      }
      return true;
    } catch (_) {
      return false;
    }
  },

  /**
   * Development-only local notification that exercises the real channel, importance and
   * routing path without contacting any server. Never sends anything off-device.
   */
  async simulateLocalAlert({ assignmentId = `local-sim-${Date.now()}` } = {}) {
    if (!LOCAL_ALERT_SIMULATOR_ENABLED) {
      return { ok: false, reason: 'simulator-disabled' };
    }
    try {
      await this.ensureChannel();
      const trigger = { seconds: 1, channelId: CHANNEL_PRESET.id };
      const timeIntervalType = Notifications?.SchedulableTriggerInputTypes?.TIME_INTERVAL;
      if (timeIntervalType) trigger.type = timeIntervalType;
      const id = await Notifications.scheduleNotificationAsync({
        content: {
          title: 'Test alert (local only)',
          // Privacy: the same generic wording as a real alert. Never place blood type, hospital,
          // distance or any identifier in notification text - it renders on the lock screen.
          body: 'A nearby emergency request needs a donor. Tap to review. Test only - no server was contacted.',
          data: { assignmentId, type: 'emergency_blood_alert', version: 1 },
          sound: 'default',
        },
        trigger: Platform.OS === 'android' ? trigger : null,
      });
      return { ok: true, identifier: id };
    } catch (error) {
      return { ok: false, reason: error?.message || 'simulation-failed' };
    }
  },

  async dismissAll() {
    try {
      await Notifications.dismissAllNotificationsAsync();
    } catch (_) {
      // ignore
    }
  },
};

export default AlertNotifications;
