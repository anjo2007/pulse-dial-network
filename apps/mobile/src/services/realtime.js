/**
 * Optional realtime "changed" broadcast, used only to trigger an immediate refetch.
 *
 * Design:
 *  - Realtime is strictly an optimisation. If anything about it fails (endpoint missing, feature
 *    disabled, client module unavailable, subscription error) the app falls back to the existing
 *    polling loop and stays fully functional.
 *  - Foreground only: the caller starts it when the app becomes active and stops it when it is
 *    backgrounded, so there is no background socket, no battery cost and no background data use.
 *  - Private channel: the server-provided access token is set on the client before subscribing.
 *  - Nothing here is ever logged with its values (no url, key, token or topic echoed to logs).
 */

import { SYNC_CONFIG_ENDPOINT, parseSyncConfig } from '../lib/sync.js';

export function createRealtimeSync({ request, onChanged, logger = console } = {}) {
  if (typeof request !== 'function') throw new TypeError('createRealtimeSync requires request()');

  let client = null;
  let channel = null;
  let moduleCache = null; // undefined = not tried, false = unavailable, object = loaded

  function loadClientModule() {
    if (moduleCache !== undefined) return moduleCache;
    try {
      // react-native-url-polyfill supplies the URL/WebSocket globals supabase-js expects on RN.
      require('react-native-url-polyfill/auto');
    } catch (_) {
      // Not fatal: newer runtimes may already provide the required globals.
    }
    try {
      moduleCache = require('@supabase/supabase-js');
    } catch (_) {
      moduleCache = false;
    }
    return moduleCache;
  }

  function stop() {
    try {
      if (client && channel) client.removeChannel(channel);
    } catch (_) {
      // ignore
    }
    channel = null;
  }

  async function start() {
    if (channel) return { ok: true, active: true, reason: null };

    let raw;
    try {
      raw = await request('GET', SYNC_CONFIG_ENDPOINT, undefined);
    } catch (error) {
      return {
        ok: false,
        active: false,
        reason: Number(error?.status) === 404 ? 'endpoint-missing' : 'config-unavailable',
      };
    }

    const config = parseSyncConfig(raw);
    if (!config.enabled) return { ok: false, active: false, reason: config.reason };

    const supabaseModule = loadClientModule();
    if (!supabaseModule) return { ok: false, active: false, reason: 'client-module-unavailable' };

    try {
      client = supabaseModule.createClient(config.url, config.publishableKey, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        realtime: { params: { eventsPerSecond: 2 } },
      });
      // Required for a private channel: authorise the socket with the server-issued token.
      if (typeof client?.realtime?.setAuth === 'function') {
        await client.realtime.setAuth(config.accessToken);
      }
      channel = client
        .channel(config.topic, { config: { private: true } })
        .on('broadcast', { event: 'changed' }, () => {
          try {
            onChanged?.({ source: 'realtime' });
          } catch (_) {
            // A listener error must never break the subscription.
          }
        })
        .subscribe((status) => {
          // Polling remains the source of truth; subscription problems are only surfaced as a hint.
          if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            logger?.warn?.(`Realtime subscription degraded (${status}); continuing with polling.`);
          }
        });
      return { ok: true, active: true, reason: null };
    } catch (_) {
      stop();
      return { ok: false, active: false, reason: 'subscribe-failed' };
    }
  }

  return { start, stop, isActive: () => Boolean(channel) };
}

export default createRealtimeSync;
