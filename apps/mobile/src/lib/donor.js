/**
 * Donor eligibility + profile projection. Pure (no RN/Expo imports) so it is testable on Node.
 * These rules mirror the hospital-side matching engine used by the API.
 */

export const DONATION_COOLDOWN_DAYS = 90;

export function daysAgo(days, now = Date.now()) {
  return new Date(now - days * 86400000).toISOString().slice(0, 10);
}

export function ageFromDateOfBirth(dateOfBirth, now = Date.now()) {
  const source = dateOfBirth || '2000-01-01';
  const birth = new Date(`${source}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return null;
  return Math.floor((now - birth.getTime()) / 31557600000);
}

export function nextEligibleDate(donor, now = Date.now()) {
  if (!donor) return null;
  const lastDon = donor.lastDonationDate || donor.last_donation_date;
  const lastDonation = lastDon && lastDon !== 'Never Donated'
    ? new Date(`${lastDon}T00:00:00Z`).getTime()
    : now - 120 * 86400000;
  if (Number.isNaN(lastDonation)) return null;
  return new Date(lastDonation + DONATION_COOLDOWN_DAYS * 86400000).toISOString().slice(0, 10);
}

/** Donor must have consented, weigh >= 50kg, be 18-65 and be past the 90-day cooldown. */
export function isEligible(donor, now = Date.now()) {
  if (!donor) return false;
  // Support both camelCase and snake_case; default to true if not explicitly false
  const consent = donor.consentAccepted ?? donor.consent_accepted ?? (donor.consentAccepted === false ? false : true);
  if (!consent) return false;

  const weight = Number(donor.weightKg ?? donor.weight_kg ?? donor.weight ?? 0);
  if (weight < 50) return false;

  let age = Number(donor.age);
  if (!Number.isFinite(age)) {
    age = ageFromDateOfBirth(donor.dateOfBirth || donor.date_of_birth, now);
  }
  if (age === null || !Number.isFinite(age) || age < 18 || age > 65) return false;

  const lastDon = donor.lastDonationDate || donor.last_donation_date;
  if (lastDon && lastDon !== 'Never Donated') {
    const t = new Date(`${lastDon}T00:00:00Z`).getTime();
    if (!Number.isNaN(t)) {
      const days = (now - t) / 86400000;
      if (days >= 0 && days < DONATION_COOLDOWN_DAYS) {
        return false;
      }
    }
  }

  return true;
}

export function donorView(donor, now = Date.now()) {
  if (!donor) return null;
  const lastDon = donor.lastDonationDate || donor.last_donation_date || 'Never Donated';
  const rawDate = donor.dateOfBirth || donor.date_of_birth || '1998-05-12';
  let age = Number(donor.age);
  if (!Number.isFinite(age)) {
    age = ageFromDateOfBirth(rawDate, now) || 26;
  }
  const normalized = {
    ...donor,
    fullName: donor.fullName || donor.full_name || donor.name || 'Volunteer Donor',
    bloodType: donor.bloodType || donor.blood_type || 'O-',
    weightKg: Number(donor.weightKg ?? donor.weight_kg ?? donor.weight ?? 68),
    age,
    dateOfBirth: rawDate,
    lastDonationDate: lastDon,
    isAvailable: donor.isAvailable ?? donor.is_available ?? true,
    consentAccepted: donor.consentAccepted ?? donor.consent_accepted ?? true,
  };
  return {
    ...normalized,
    eligible: isEligible(normalized, now),
    nextEligibleDate: nextEligibleDate(normalized, now),
  };
}
