import React from 'react';

export function Badge({ children, tone = 'blue' }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}

export function Spinner({ label = 'Working' }) {
  return (
    <span className="spinner" aria-hidden="true">
      <span className="sr-only">{label}</span>
    </span>
  );
}

/**
 * Accessible form field. The render prop receives the exact attributes the control
 * must spread, so label / hint / error wiring can never be forgotten.
 */
export function Field({ id, label, error, hint, required = false, children }) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(' ') || undefined;
  const controlProps = {
    id,
    'aria-describedby': describedBy,
    'aria-invalid': error ? true : undefined,
    'aria-required': required || undefined,
  };
  return (
    <div className={`field${error ? ' field-invalid' : ''}`}>
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      {children(controlProps)}
      {hint ? (
        <small id={hintId} className="field-hint">
          {hint}
        </small>
      ) : null}
      {error ? (
        <span id={errorId} className="field-error">
          <span aria-hidden="true">! </span>
          {error}
        </span>
      ) : null}
    </div>
  );
}

export function ProgressBar({ value, max, label, tone = 'blue' }) {
  const safeMax = Number(max) > 0 ? Number(max) : 0;
  const numericValue = Number(value) > 0 ? Number(value) : 0;
  const safeValue = Math.min(numericValue, safeMax > 0 ? safeMax : numericValue);
  const pct = safeMax > 0 ? Math.round((safeValue / safeMax) * 100) : 0;
  return (
    <div className={`progress progress-${tone}`}>
      <div
        className="progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={safeMax || 1}
        aria-valuenow={safeValue}
        aria-label={label}
      >
        <span className="progress-fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="progress-caption" aria-hidden="true">
        {label}
      </span>
    </div>
  );
}

export function SkeletonBlock({ lines = 3, label = 'Loading dispatch data' }) {
  return (
    <div className="skeleton" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="skeleton-line" aria-hidden="true" />
      ))}
    </div>
  );
}

export function InlineError({ id, message, onRetry, busy, retryLabel = 'Retry now' }) {
  if (!message) return null;
  return (
    <div className="inline-error" id={id} role="alert">
      <span>{message}</span>
      {onRetry ? (
        <button type="button" className="text-button" onClick={onRetry} disabled={busy}>
          {busy ? 'Retrying…' : retryLabel}
        </button>
      ) : null}
    </div>
  );
}
