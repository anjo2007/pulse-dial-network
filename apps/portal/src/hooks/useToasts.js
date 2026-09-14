import { useCallback, useEffect, useRef, useState } from 'react';

let nextId = 1;

/**
 * Small toast queue.
 *  - errors stay longer than confirmations
 *  - the queue is capped so a failing backend cannot bury the dashboard
 *  - timers are cleared on unmount (no state update after logout/unmount)
 */
export function useToasts({ ttl = 6000, errorTtl = 10000, max = 3 } = {}) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());

  const dismiss = useCallback((id) => {
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
    setToasts((previous) => previous.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback(
    (message, { tone = 'info' } = {}) => {
      if (!message) return null;
      const id = nextId++;
      setToasts((previous) => [...previous, { id, message: String(message), tone }].slice(-max));
      const timer = setTimeout(() => dismiss(id), tone === 'error' ? errorTtl : ttl);
      timers.current.set(id, timer);
      return id;
    },
    [dismiss, errorTtl, max, ttl],
  );

  const clear = useCallback(() => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear();
    setToasts([]);
  }, []);

  useEffect(
    () => () => {
      for (const timer of timers.current.values()) clearTimeout(timer);
      timers.current.clear();
    },
    [],
  );

  return { toasts, push, dismiss, clear };
}
