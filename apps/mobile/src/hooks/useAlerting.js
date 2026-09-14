/**
 * Permission-aware alerting state for the donor app.
 *
 * Exposes the platform facts (permission / channel / token registration) plus the corrective
 * actions the UI can offer. Nothing here claims guaranteed delivery: the status object only says
 * whether the app has done everything the OS allows.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { PUSH_TOKEN_ENABLED } from '../config.js';
import { computeAlertingStatus } from '../lib/alerts.js';
import { AlertNotifications } from '../services/notificationsClient.js';

const INITIAL_STATE = {
  installationId: null,
  permissionStatus: 'undetermined',
  canAskAgain: true,
  channelReady: false,
  channelReason: null,
  tokenRegistered: null,
  pushReason: null,
  expoPushToken: null,
};

export function useAlerting({ availabilityEnabled, registry }) {
  const [state, setState] = useState(INITIAL_STATE);
  const [busy, setBusy] = useState(false);
  const registryRef = useRef(registry);
  registryRef.current = registry;

  const refresh = useCallback(async () => {
    const installationId = await AlertNotifications.getInstallationId();
    const channel = await AlertNotifications.ensureChannel();
    const permission = await AlertNotifications.getPermission();
    setState((previous) => ({
      ...previous,
      installationId,
      channelReady: channel.ready,
      channelReason: channel.reason ?? null,
      permissionStatus: permission.status,
      canAskAgain: permission.canAskAgain,
    }));
    return { installationId, channel, permission };
  }, []);

  /**
   * Ask for permission (when allowed) and register this installation with the API.
   * Always resolves; failures are reflected in `state.pushReason`.
   */
  const registerDevice = useCallback(async ({ prompt = false } = {}) => {
    setBusy(true);
    try {
      const installationId = await AlertNotifications.getInstallationId();
      const channel = await AlertNotifications.ensureChannel();
      let permission = await AlertNotifications.getPermission();
      if (prompt && !permission.granted && permission.canAskAgain) {
        permission = await AlertNotifications.requestPermission();
      }

      const tokenResult = permission.granted
        ? await AlertNotifications.acquirePushToken()
        : { ok: false, reason: 'permission-not-granted' };

      let registration = { ok: false, queued: false, reason: 'skipped' };
      if (tokenResult.ok && registryRef.current) {
        registration = await registryRef.current.register({
          installationId,
          expoPushToken: tokenResult.token,
          platform: Platform.OS,
        });
      }

      setState((previous) => ({
        ...previous,
        installationId,
        channelReady: channel.ready,
        channelReason: channel.reason ?? null,
        permissionStatus: permission.status,
        canAskAgain: permission.canAskAgain,
        expoPushToken: tokenResult.ok ? tokenResult.token : null,
        tokenRegistered: tokenResult.ok ? registration.ok : false,
        pushReason: tokenResult.ok ? registration.reason ?? null : tokenResult.reason,
      }));
      return { permission, tokenResult, registration };
    } finally {
      setBusy(false);
    }
  }, []);

  /** Stop this installation from being targeted (availability off / sign-out). */
  const unregisterDevice = useCallback(async () => {
    setBusy(true);
    try {
      const installationId = await AlertNotifications.getInstallationId();
      const result = registryRef.current
        ? await registryRef.current.unregister({ installationId })
        : { ok: false, queued: false, reason: 'no-registry' };
      setState((previous) => ({
        ...previous,
        tokenRegistered: false,
        pushReason: result.ok ? null : result.reason,
      }));
      return result;
    } finally {
      setBusy(false);
    }
  }, []);

  const openSettings = useCallback(() => AlertNotifications.openSystemSettings(), []);
  const simulateLocalAlert = useCallback((options) => AlertNotifications.simulateLocalAlert(options ?? {}), []);

  const status = useMemo(
    () =>
      computeAlertingStatus({
        platform: Platform.OS,
        permissionStatus: state.permissionStatus,
        canAskAgain: state.canAskAgain,
        channelReady: state.channelReady,
        tokenRegistered: state.tokenRegistered,
        pushAvailable: PUSH_TOKEN_ENABLED,
        availabilityEnabled,
      }),
    [state, availabilityEnabled]
  );

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { state, status, busy, refresh, registerDevice, unregisterDevice, openSettings, simulateLocalAlert };
}

export default useAlerting;
