import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Dashboard from './components/Dashboard.jsx';
import Login from './components/Login.jsx';
import { createApiClient, resolveApiBase } from './lib/api.js';
import { createPortalApi } from './lib/endpoints.js';
import { authenticateHospital } from './lib/firebase.js';
import {
  clearStoredSession,
  createSession,
  persistSession,
  readStoredSession,
  sessionIsUsable,
} from './lib/session.js';

const SESSION_CHECK_INTERVAL_MS = 30000;

/**
 * Application shell: it owns exactly one thing - the hospital session.
 *
 *  - a stored session is restored only if its token is still valid and carries the
 *    hospital role, otherwise it is deleted before the first render of the dashboard
 *  - a server 401 (from any call) and the client-side expiry timer both funnel into the
 *    same sign-out path, so the UI can never sit on a dead token
 *  - re-entrant sign-outs are impossible: the first one wins and the rest are ignored
 */
export default function App() {
  const api = useMemo(() => createPortalApi(createApiClient({ baseUrl: resolveApiBase(import.meta.env) })), []);
  const [session, setSession] = useState(() => readStoredSession());
  const [notice, setNotice] = useState('');
  const signingOutRef = useRef(false);

  const signOut = useCallback((message = '') => {
    if (signingOutRef.current) return;
    signingOutRef.current = true;
    clearStoredSession();
    setSession(null);
    setNotice(message);
    // Allow a future sign-in to warn again.
    setTimeout(() => {
      signingOutRef.current = false;
    }, 0);
  }, []);

  const handleUnauthorized = useCallback(() => {
    signOut('Your session ended or was revoked. Sign in again to keep dispatching.');
  }, [signOut]);

  // Drop a session that expired while the tab sat open.
  useEffect(() => {
    if (!session) return undefined;
    if (!sessionIsUsable(session)) {
      signOut('Your session expired. Sign in again to keep dispatching.');
      return undefined;
    }
    const msUntilExpiry = Math.max(0, session.expiresAtMs - Date.now());
    const timer = setTimeout(() => {
      signOut('Your session expired. Sign in again to keep dispatching.');
    }, Math.min(msUntilExpiry + 1000, 2147483647));
    return () => clearTimeout(timer);
  }, [session, signOut]);

  // Belt and braces: re-validate on an interval in case the device slept through it.
  useEffect(() => {
    if (!session) return undefined;
    const timer = setInterval(() => {
      if (!sessionIsUsable(session)) signOut('Your session expired. Sign in again to keep dispatching.');
    }, SESSION_CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [session, signOut]);

  const handleLogin = useCallback(
    async ({ email, password, persistent }) => {
      let result;
      try {
        result = await authenticateHospital({ email, password });
      } catch (fbErr) {
        try {
          result = await api.login({ email, password });
        } catch (apiErr) {
          throw fbErr?.message ? fbErr : apiErr;
        }
      }
      const next = createSession(result);
      if (!next) {
        throw new Error('The service returned a session this portal cannot use. Contact your platform administrator.');
      }
      persistSession(next, { persistent });
      setNotice('');
      setSession(next);
      return next;
    },
    [api],
  );

  if (!session) {
    return <Login api={api} notice={notice} onSubmit={handleLogin} />;
  }

  return (
    <Dashboard
      key={`${session.subjectId ?? 'hospital'}-${session.expiresAtMs}`}
      api={api}
      session={session}
      onSignOut={signOut}
      onUnauthorized={handleUnauthorized}
    />
  );
}
