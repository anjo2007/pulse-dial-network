import { useEffect, useState } from 'react';
import { DEFAULT_CAPABILITIES, parseCapabilities } from '../lib/endpoints.js';

/**
 * Probe GET /health for optional server capabilities.
 *
 * The endpoint is public and additive: if the API advertises
 * `capabilities.cancelRequest` the portal enables cancellation, otherwise the action
 * is simply not offered. A failed probe keeps the safe defaults (everything off) so
 * the portal never calls an endpoint that may not exist.
 */
export function useCapabilities({ api, refreshKey }) {
  const [capabilities, setCapabilities] = useState(DEFAULT_CAPABILITIES);
  const [probed, setProbed] = useState(false);

  useEffect(() => {
    if (!api) return undefined;
    const controller = new AbortController();
    let active = true;

    api
      .health({ signal: controller.signal, timeoutMs: 5000 })
      .then((health) => {
        if (!active) return;
        setCapabilities(parseCapabilities(health));
        setProbed(true);
      })
      .catch(() => {
        // Keep the defaults; a missing/failed probe must never block dispatch.
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [api, refreshKey]);

  return { capabilities, probed };
}
