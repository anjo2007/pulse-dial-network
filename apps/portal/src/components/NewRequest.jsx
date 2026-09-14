import React, { useId, useRef, useState } from 'react';
import { Field } from './ui.jsx';
import { BLOOD_TYPES, MAX_UNITS, URGENCY_LEVELS, validateNewRequest } from '../lib/validation.js';

const URGENCY_HINTS = {
  CRITICAL: 'Theatre or trauma case - donors are alerted immediately.',
  URGENT: 'Needed within the hour - alert the closest eligible donors.',
  NORMAL: 'Planned top-up - dispatched without an emergency escalation.',
};

/**
 * Emergency request form.
 *
 * Invalid input is blocked before it reaches the API (the server also validates it),
 * the submit control reflects the in-flight state, and a server-side rejection is
 * surfaced inline instead of being swallowed.
 */
export default function NewRequest({ onCreate, disabled = false, disabledReason = '' }) {
  const [bloodType, setBloodType] = useState('O-');
  const [unitsNeeded, setUnitsNeeded] = useState('1');
  const [urgency, setUrgency] = useState('CRITICAL');
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const bloodTypeRef = useRef(null);
  const unitsRef = useRef(null);
  const urgencyRef = useRef(null);
  const baseId = useId();

  async function submit(event) {
    event.preventDefault();
    if (submitting) return;
    setFormError('');
    const result = validateNewRequest({ bloodType, unitsNeeded, urgency });
    setErrors(result.errors);
    if (!result.valid) {
      if (result.errors.bloodType) bloodTypeRef.current?.focus();
      else if (result.errors.unitsNeeded) unitsRef.current?.focus();
      else urgencyRef.current?.focus();
      return;
    }
    setSubmitting(true);
    try {
      await onCreate(result.value);
      setUnitsNeeded('1');
      setErrors({});
    } catch (error) {
      setFormError(error?.message || 'The emergency request could not be created. Try again.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="request-form" onSubmit={submit} noValidate aria-busy={submitting || undefined}>
      <div>
        <Field id={`${baseId}-blood`} label="Blood group" error={errors.bloodType} required>
          {(controlProps) => (
            <select
              {...controlProps}
              ref={bloodTypeRef}
              value={bloodType}
              disabled={submitting || disabled}
              onChange={(event) => setBloodType(event.target.value)}
            >
              {BLOOD_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          )}
        </Field>

        <Field
          id={`${baseId}-units`}
          label="Units required"
          error={errors.unitsNeeded}
          hint={`1-${MAX_UNITS} units. Up to 3 donors are alerted per unit.`}
          required
        >
          {(controlProps) => (
            <input
              {...controlProps}
              ref={unitsRef}
              type="number"
              inputMode="numeric"
              min={1}
              max={MAX_UNITS}
              step={1}
              value={unitsNeeded}
              disabled={submitting || disabled}
              onChange={(event) => setUnitsNeeded(event.target.value)}
            />
          )}
        </Field>

        <Field id={`${baseId}-urgency`} label="Urgency" error={errors.urgency} hint={URGENCY_HINTS[urgency]} required>
          {(controlProps) => (
            <select
              {...controlProps}
              ref={urgencyRef}
              value={urgency}
              disabled={submitting || disabled}
              onChange={(event) => setUrgency(event.target.value)}
            >
              {URGENCY_LEVELS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>

      {disabled && disabledReason ? <p className="inline-hint">{disabledReason}</p> : null}
      {formError ? (
        <p className="inline-error" role="alert">
          {formError}
        </p>
      ) : null}

      <button type="submit" disabled={submitting || disabled}>
        {submitting ? 'Dispatching…' : 'Trigger emergency dispatch'}
      </button>
    </form>
  );
}
