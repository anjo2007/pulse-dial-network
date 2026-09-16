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
  },

  /**
   * Play high-urgency emergency dispatch siren looping in background.
   */
  async playEmergencyAlertSound() {
    if (Platform.OS !== 'android') return false;
    try {
      if (OverlayPermission?.playEmergencyAlertSound) {
        return await OverlayPermission.playEmergencyAlertSound();
      }
      return false;
    } catch (_) {
      return false;
    }
  },

  /**
   * Stop emergency alert siren audio immediately.
   */
  async stopEmergencyAlertSound() {
    if (Platform.OS !== 'android') return true;
    try {
      if (OverlayPermission?.stopEmergencyAlertSound) {
        return await OverlayPermission.stopEmergencyAlertSound();
      }
      return true;
    } catch (_) {
      return true;
    }
  }
};

export default OverlayService;
