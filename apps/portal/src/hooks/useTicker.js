import { useEffect, useState } from 'react';

/**
 * Coarse clock for countdowns ("expires in 12m 04s", "updated 4s ago").
 * A single timer per consumer, aligned to the interval so it does not drift, and
 * suspended while the tab is hidden - a background tab has no business waking up
 * every second to re-render a countdown nobody is looking at.
 */
export function useTicker(intervalMs = 1000, enabled = true) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!enabled) return undefined;
    let timer = null;
    let cancelled = false;

    const tick = () => {
      if (cancelled) return;
      setNow(Date.now());
      // Drift correction: keep ticks aligned to the interval boundary.
      const delay = intervalMs - (Date.now() % intervalMs);
      timer = setTimeout(tick, Math.max(250, delay));
    };

    const start = () => {
      if (timer === null) timer = setTimeout(tick, intervalMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const handleVisibility = () => {
      if (typeof document !== 'undefined' && document.hidden) stop();
      else {
        setNow(Date.now());
        start();
      }
    };

    start();
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      cancelled = true;
      stop();
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [intervalMs, enabled]);

  return now;
}
