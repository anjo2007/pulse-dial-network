import React, { useEffect, useId, useRef, useState } from 'react';
import { Badge, Field } from './ui.jsx';
import { validateCredentials } from '../lib/validation.js';
import { isAbortError } from '../lib/api.js';

const DEMO_EMAIL = 'admin@centralhospital.demo';
const DEMO_PASSWORD = 'demo123';

/**
 * Hospital sign-in.
 *
 * Hardening decisions:
 *  - no credentials are prefilled: a demo helper button fills them on request, so a
 *    shared clinical workstation never shows a password in the DOM on load
 *  - client-side validation runs before the network call so the user gets immediate,
 *    field-level feedback; the server remains authoritative
 *  - "Keep me signed in" is opt-in. Off (the default) keeps the session in
 *    sessionStorage, so closing the tab ends the session on a shared device.
 *  - the health probe is best effort: it only adds an honest "demo auth" warning and
 *    never blocks sign-in.
 */
export default function Login({ api, notice = '', onSubmit }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [persistent, setPersistent] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [demoAuth, setDemoAuth] = useState(false);

  const emailRef = useRef(null);
  const passwordRef = useRef(null);
  const emailId = useId();
  const passwordId = useId();

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    api
      ?.health({ signal: controller.signal, timeoutMs: 4000 })
      .then((health) => {
        if (!active) return;
        setDemoAuth(health?.authentication === 'development-demo');
      })
      .catch((error) => {
        if (!active || isAbortError(error)) return;
        setDemoAuth(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [api]);

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    setSubmitError('');
    const result = validateCredentials({ email, password });
    setErrors(result.errors);
    if (!result.valid) {
      if (result.errors.email) emailRef.current?.focus();
      else if (result.errors.password) passwordRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit({ email: result.value.email, password: result.value.password, persistent });
      setPassword('');
    } catch (error) {
      setSubmitError(error?.message || 'Sign in failed. Please try again.');
      passwordRef.current?.focus();
      passwordRef.current?.select?.();
    } finally {
      setSubmitting(false);
    }
  }

  function useDemoCredentials() {
    setEmail(DEMO_EMAIL);
    setPassword(DEMO_PASSWORD);
    setErrors({});
    setSubmitError('');
    passwordRef.current?.focus();
  }

  return (
    <main className="login-shell">
      <section className="brand-panel">
        <div className="mark" aria-hidden="true">
          +
        </div>
        <p className="eyebrow">PULSE DIAL / HOSPITAL NETWORK</p>
        <h1>Every second counts.</h1>
        <p>Coordinate verified, nearby donors during critical blood emergencies.</p>
        <div className="signal" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </div>
      </section>
      <form className="login-card" onSubmit={submit} noValidate aria-busy={submitting || undefined}>
        <Badge tone="red">SECURE CLINICAL PORTAL</Badge>
        <h2>Sign in to dispatch</h2>
        <p className="muted">Use the hospital account issued by your blood bank administrator.</p>

        {notice ? (
          <p className="notice" role="status">
            {notice}
          </p>
        ) : null}
        {demoAuth ? (
          <p className="notice warn" role="status">
            Development demo authentication is active on this API. Do not use it with real patient or donor data.
          </p>
        ) : null}

        <Field id={emailId} label="Email" error={errors.email} required>
          {(controlProps) => (
            <input
              {...controlProps}
              ref={emailRef}
              type="email"
              name="email"
              autoComplete="username"
              inputMode="email"
              autoFocus
              value={email}
              disabled={submitting}
              onChange={(event) => setEmail(event.target.value)}
            />
          )}
        </Field>

        <Field id={passwordId} label="Password" error={errors.password} required>
          {(controlProps) => (
            <span className="password-row">
              <input
                {...controlProps}
                ref={passwordRef}
                type={showPassword ? 'text' : 'password'}
                name="password"
                autoComplete="current-password"
                value={password}
                disabled={submitting}
                onChange={(event) => setPassword(event.target.value)}
              />
              <button
                type="button"
                className="text-button password-toggle"
                aria-pressed={showPassword}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </span>
          )}
        </Field>

        <div className="checkbox-row">
          <input
            id={`${emailId}-persist`}
            type="checkbox"
            checked={persistent}
            disabled={submitting}
            onChange={(event) => setPersistent(event.target.checked)}
          />
          <label htmlFor={`${emailId}-persist`}>
            Keep me signed in on this device
            <small>Leave this off on a shared workstation - the session then ends when the tab closes.</small>
          </label>
        </div>

        {submitError ? (
          <p className="error" role="alert">
            {submitError}
          </p>
        ) : null}

        <button type="submit" disabled={submitting}>
          {submitting ? 'Signing in…' : 'Access emergency dashboard →'}
        </button>
        <button type="button" className="text-button demo-fill" onClick={useDemoCredentials} disabled={submitting}>
          Fill demo credentials
        </button>
        <small>Demo accounts exist only in the local development seed. Never use them with real donor data.</small>
      </form>
    </main>
  );
}
