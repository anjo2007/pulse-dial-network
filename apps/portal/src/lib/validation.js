/**
 * Client-side input validation and normalization.
 *
 * Mirrors the server rules in services/api/src/server.js so the user gets immediate,
 * specific feedback instead of a round trip that fails. The server remains the
 * authority; these helpers are defence in depth, never a substitute.
 */

export const BLOOD_TYPES = Object.freeze(['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+']);
export const URGENCY_LEVELS = Object.freeze(['CRITICAL', 'URGENT', 'NORMAL']);
export const MIN_UNITS = 1;
export const MAX_UNITS = 10;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// The donor app renders "PULSE:<assignmentId>:<token>"; the id is a UUID and the
// token is a short random suffix. Accept it case-insensitively but normalize to the
// exact server format, and tolerate surrounding whitespace from a copy/paste or scan.
const CHECKIN_PATTERN = /^PULSE:([A-Za-z0-9-]{4,}):([A-Za-z0-9-]{4,})$/i;

export function validateCredentials({ email, password } = {}) {
  const errors = {};
  const value = { email: String(email ?? '').trim(), password: typeof password === 'string' ? password : '' };
  if (!value.email) errors.email = 'Enter the email address registered with the hospital.';
  else if (!EMAIL_PATTERN.test(value.email)) errors.email = 'Enter a valid email address, for example name@hospital.org.';
  if (!value.password) errors.password = 'Enter your password.';
  else if (value.password.length < 6) errors.password = 'Passwords are at least 6 characters long.';
  return { valid: Object.keys(errors).length === 0, value, errors };
}

export function validateNewRequest({ bloodType, unitsNeeded, urgency } = {}) {
  const errors = {};
  const rawUnits = typeof unitsNeeded === 'string' ? unitsNeeded.trim() : unitsNeeded;
  const units = rawUnits === '' || rawUnits === null || rawUnits === undefined ? Number.NaN : Number(rawUnits);

  const type = BLOOD_TYPES.includes(bloodType) ? bloodType : '';
  if (!type) errors.bloodType = 'Select the blood group required.';

  if (!Number.isFinite(units)) errors.unitsNeeded = 'Enter how many units are required.';
  else if (!Number.isInteger(units)) errors.unitsNeeded = 'Units must be a whole number.';
  else if (units < MIN_UNITS) errors.unitsNeeded = `Request at least ${MIN_UNITS} unit.`;
  else if (units > MAX_UNITS) errors.unitsNeeded = `This portal caps a single request at ${MAX_UNITS} units - raise a second request for a larger draw.`;

  const level = URGENCY_LEVELS.includes(urgency) ? urgency : '';
  if (!level) errors.urgency = 'Select an urgency level.';

  return {
    valid: Object.keys(errors).length === 0,
    value: { bloodType: type, unitsNeeded: Number.isFinite(units) ? units : null, urgency: level },
    errors,
  };
}

export function validateCheckinToken(input) {
  const value = String(input ?? '').replace(/[\s\u200B]+/g, '').trim();
  if (!value) return { valid: false, value, errors: { token: 'Enter the 6-digit Arrival OTP or token shown in the donor app.' } };

  // Accept 6-digit numeric arrival OTP shown on donor phone
  if (/^\d{6}$/.test(value)) {
    return { valid: true, value, errors: {} };
  }

  const match = CHECKIN_PATTERN.exec(value);
  if (!match) {
    return {
      valid: false,
      value,
      errors: { token: 'Enter the 6-digit arrival OTP (e.g. 482915) or token format PULSE:<assignment-id>:<code>.' },
    };
  }
  return { valid: true, value: `PULSE:${match[1]}:${match[2]}`, errors: {} };
}

/** Units already collected vs requested, used for progress and follow-up hints. */
export function collectionProgress(unitsNeeded, fulfilledUnits) {
  const needed = Number.isFinite(Number(unitsNeeded)) ? Number(unitsNeeded) : 0;
  const collected = Number.isFinite(Number(fulfilledUnits)) ? Number(fulfilledUnits) : 0;
  const safeNeeded = needed > 0 ? needed : 0;
  const pct = safeNeeded === 0 ? 0 : Math.max(0, Math.min(100, Math.round((collected / safeNeeded) * 100)));
  return { needed: safeNeeded, collected, remaining: Math.max(0, safeNeeded - collected), pct };
}
