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
  const lastDonation = donor.lastDonationDate
    ? new Date(`${donor.lastDonationDate}T00:00:00Z`).getTime()
    : now - 120 * 86400000;
  if (Number.isNaN(lastDonation)) return null;
  return new Date(lastDonation + DONATION_COOLDOWN_DAYS * 86400000).toISOString().slice(0, 10);
}

/** Donor must have consented, weigh >= 50kg, be 18-65 and be past the 90-day cooldown. */
export function isEligible(donor, now = Date.now()) {
  if (!donor) return false;
  const age = ageFromDateOfBirth(donor.dateOfBirth, now);
  if (age === null) return false;
  const nextDate = nextEligibleDate(donor, now);
  const cooldownDone = nextDate ? new Date(`${nextDate}T00:00:00Z`).getTime() <= now : true;
  return (
    Boolean(donor.consentAccepted)
    && Number(donor.weightKg ?? 0) >= 50
    && age >= 18
    && age <= 65
    && cooldownDone
  );
}

export function donorView(donor, now = Date.now()) {
  if (!donor) return null;
  return {
    ...donor,
    eligible: isEligible(donor, now),
    nextEligibleDate: nextEligibleDate(donor, now),
  };
}
