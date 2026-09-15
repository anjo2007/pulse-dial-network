import { NativeModules, Platform, Linking } from 'react-native';

const { OverlayPermission } = NativeModules;

export const OverlayService = {
  /**
   * Check if 'Display over other apps' is granted on Android.
   * On iOS or non-Android, returns true.
   */
  async canDrawOverlays() {
    if (Platform.OS !== 'android') return true;
    try {
      if (OverlayPermission?.canDrawOverlays) {
        return await OverlayPermission.canDrawOverlays();
      }
      return false;
    } catch (_) {
      return false;
    }
  },

  /**
   * Open the exact system settings page for 'Display over other apps' / Appear on top.
   */
  async openOverlaySettings() {
    if (Platform.OS !== 'android') {
      return Linking.openSettings?.();
    }
    try {
      if (OverlayPermission?.openOverlaySettings) {
        return await OverlayPermission.openOverlaySettings();
      }
      return Linking.openSettings?.();
    } catch (_) {
      return Linking.openSettings?.();
    }
  },

  /**
   * When an emergency incoming call arrives, bring the Pulse Dial activity to the front.
   */
  async bringAppToForeground() {
    if (Platform.OS !== 'android') return;
    try {
      if (OverlayPermission?.bringAppToForeground) {
        await OverlayPermission.bringAppToForeground();
      }
    } catch (_) {
      // ignore
    }
  }
};

export default OverlayService;
