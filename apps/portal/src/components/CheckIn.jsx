import React, { useId, useRef, useState } from 'react';
import { Field } from './ui.jsx';
import { collectionProgress, validateCheckinToken } from '../lib/validation.js';
import { displayDonorLabel, formatTime } from '../lib/lifecycle.js';

/**
 * Fast donor check-in.
 *
 * The donor app displays `PULSE:<assignment-id>:<code>`; the desk scans or pastes it.
 * Guard rails:
 *  - the token format is validated locally so a typo gives an immediate, specific hint
 *  - a token can only be submitted once per session; the server independently rejects
 *    duplicate completion and tokens belonging to withdrawn assignments
 *  - while the call is in flight the field and button lock, which prevents the classic
 *    double-paste double-credit
 */
export default function CheckIn({ onCheckIn, disabled = false, disabledReason = '' }) {
  const [value, setValue] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState([]);
  const submittedRef = useRef(new Set());
  const inputRef = useRef(null);
  const baseId = useId();

  async function submit(event) {
    event.preventDefault();
    if (submitting || disabled) return;
    setNotice('');
    const result = validateCheckinToken(value);
    if (!result.valid) {
      setError(result.errors.token);
      inputRef.current?.focus();
      return;
    }
    if (submittedRef.current.has(result.value)) {
      setError('That arrival token was already verified in this session. Ask the donor to show a fresh token.');
      return;
    }
    setError('');
    setSubmitting(true);
    try {
      const response = await onCheckIn(result.value);
      submittedRef.current.add(result.value);
      const assignment = response?.assignment ?? {};
      const request = response?.request ?? {};
      const progress = collectionProgress(request.unitsNeeded, request.fulfilledUnits);
      const already = response?.alreadyCompleted === true;
      setHistory((previous) =>
        [
          {
            id: assignment.id ?? result.value,
            label: displayDonorLabel(assignment),
            bloodType: request.bloodType ?? assignment.donorBloodType ?? '',
            at: assignment.completedAt ?? new Date().toISOString(),
            progress,
          },
          ...previous,
        ].slice(0, 4),
      );
      setValue('');
      setNotice(
        already
          ? 'That arrival was already recorded by the API. No duplicate credit was applied.'
          : `${displayDonorLabel(assignment)} checked in${request.bloodType ? ` for ${request.bloodType}` : ''} - ${progress.collected} of ${progress.needed} units collected.`,
      );
    } catch (submitError) {
      setError(submitError?.message || 'The arrival could not be verified. Try again.');
    } finally {
      setSubmitting(false);
      inputRef.current?.focus();
    }
  }

  return (
    <form className="panel checkin" onSubmit={submit} noValidate aria-busy={submitting || undefined}>
      <h2>Fast donor check-in</h2>
      <p>Scan or paste the arrival token displayed in the donor app.</p>
      <Field id={`${baseId}-token`} label="Arrival token" error={error} hint="Format: PULSE:assignment-id:code">
        {(controlProps) => (
          <input
            {...controlProps}
            ref={inputRef}
            value={value}
            placeholder="PULSE:assignment-id:token"
            autoComplete="off"
            spellCheck={false}
            disabled={submitting || disabled}
            onChange={(event) => {
              setValue(event.target.value);
              if (error) setError('');
            }}
          />
        )}
      </Field>
      <button
        type="submit"
        className="checkin-submit"
        disabled={submitting || disabled || !value.trim()}
        aria-busy={submitting || undefined}
      >
        {submitting ? 'Verifying…' : 'Verify arrival'}
      </button>

      {disabled && disabledReason ? <p className="inline-hint">{disabledReason}</p> : null}
      {notice ? (
        <p className="notice" role="status">
          {notice}
        </p>
      ) : null}

      {history.length ? (
        <div className="checkin-history">
          <h3>Recent check-ins</h3>
          <ul>
            {history.map((entry) => (
              <li key={entry.id}>
                <b>{entry.label}</b>
                {entry.bloodType ? <span>{entry.bloodType}</span> : null}
                <span>
                  {entry.progress.collected}/{entry.progress.needed} units
                </span>
                <span>{formatTime(entry.at)}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </form>
  );
}
