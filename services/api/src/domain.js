// Pure domain logic: eligibility, compatibility, matching, validation and view shaping.
// Nothing in this module performs I/O, which keeps it directly unit-testable.
import { randomUUID } from 'node:crypto';

export const BLOOD_TYPES = new Set(['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+']);
export const URGENCIES = new Set(['CRITICAL', 'URGENT', 'NORMAL']);
export const SEXES = new Set(['FEMALE', 'MALE', 'OTHER', 'UNSPECIFIED']);
export const DEVICE_PLATFORMS = new Set(['ios', 'android', 'web', 'unknown']);

export const ACTIVE_ASSIGNMENT_STATUSES = ['PINGED', 'ACCEPTED', 'ARRIVED'];
export const ACCEPTED_ASSIGNMENT_STATUSES = ['ACCEPTED', 'ARRIVED', 'COMPLETED'];
export const CLOSED_REQUEST_STATUSES = ['FULFILLED', 'CANCELLED', 'EXPIRED', 'UNFULFILLED'];

export const RELIABILITY_MIN = 0;
export const RELIABILITY_MAX = 150;
export const RELIABILITY_START = 100;
export const COMPLETION_BONUS = 15;
export const DECLINE_PENALTY = 5;

export const ELIGIBILITY = {
  minimumAge: 18,
  maximumAge: 65,
  minimumWeightKg: 50,
  registrationWeightKg: [35, 250],
  cooldownDays: 90,
  maxUnitsPerRequest: 10,
  maxPingMultiplier: 3,
};

const DAY_MS = 86400000;
const YEAR_MS = 31557600000;

export function isoDate(timestamp) {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export function daysAgo(days, now = Date.now()) {
  return isoDate(now - days * DAY_MS);
}

export function ageOn(dateOfBirth, now = Date.now()) {
  const birth = new Date(`${dateOfBirth}T00:00:00Z`);
  if (Number.isNaN(birth.getTime())) return NaN;
  return Math.floor((now - birth.getTime()) / YEAR_MS);
}

export function isEligible(donor, now = Date.now()) {
  const age = ageOn(donor?.dateOfBirth, now);
  const lastDonation = new Date(`${donor?.lastDonationDate}T00:00:00Z`);
  if (!donor || donor.consentAccepted !== true) return false;
  if (!Number.isFinite(Number(donor.weightKg)) || Number(donor.weightKg) < ELIGIBILITY.minimumWeightKg) return false;
  if (!Number.isFinite(age) || age < ELIGIBILITY.minimumAge || age > ELIGIBILITY.maximumAge) return false;
  if (Number.isNaN(lastDonation.getTime())) return false;
  return lastDonation.getTime() <= now - ELIGIBILITY.cooldownDays * DAY_MS;
}

export function nextEligibleDate(donor) {
  const lastDonation = new Date(`${donor?.lastDonationDate}T00:00:00Z`).getTime();
  if (Number.isNaN(lastDonation)) return null;
  return isoDate(lastDonation + ELIGIBILITY.cooldownDays * DAY_MS);
}

export function attentionLevel(reliabilityScore) {
  const score = Number(reliabilityScore);
  if (!Number.isFinite(score)) return 'UNKNOWN';
  if (score >= 110) return 'RELIABLE';
  if (score >= 80) return 'STANDARD';
  return 'AT_RISK';
}

export function clampReliability(value) {
  const score = Number(value);
  if (!Number.isFinite(score)) return RELIABILITY_START;
  return Math.min(RELIABILITY_MAX, Math.max(RELIABILITY_MIN, score));
}

export function donorView(donor, now = Date.now()) {
  if (!donor) return null;
  return {
    ...donor,
    eligible: isEligible(donor, now),
    nextEligibleDate: nextEligibleDate(donor),
    attentionLevel: attentionLevel(donor.reliabilityScore),
  };
}

export function normalizePhone(value) {
  return String(value || '').replace(/[\s()-]/g, '');
}

export function isValidPhone(phone) {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

export function distanceKm(aLat, aLon, bLat, bLon) {
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}

export function compatible(donorType, requestedType) {
  const table = {
    'O-': ['O-'], 'O+': ['O-', 'O+'], 'A-': ['O-', 'A-'], 'A+': ['O-', 'O+', 'A-', 'A+'],
    'B-': ['O-', 'B-'], 'B+': ['O-', 'O+', 'B-', 'B+'], 'AB-': ['O-', 'A-', 'B-', 'AB-'],
    'AB+': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
  };
  return table[requestedType]?.includes(donorType) ?? donorType === requestedType;
}

// Arrival tokens are unguessable and scoped to a single assignment.
// The hospital scanner matches the full token, so a leaked prefix is useless on its own.
export function checkinTokenFor(assignment, uuid = randomUUID) {
  return `PULSE:${assignment.id}:${uuid().slice(0, 12)}`;
}

export function requestHospitalId(request, config) {
  // Legacy rows created before multi-tenant isolation fall back to the configured tenant.
  return request?.hospitalId || config?.hospitalId || null;
}

// A donor is only a dispatch candidate when we have a MEASURED, finite location and an EXPLICIT
// opt-in. Unset coordinates (null) never fall back to a hospital-relative guess, and `isAvailable`
// must be literally true - a missing flag is not consent.
export function hasMeasuredLocation(donor) {
  return donor?.latitude !== null && donor?.latitude !== undefined && donor?.longitude !== null && donor?.longitude !== undefined
    && Number.isFinite(Number(donor.latitude)) && Number.isFinite(Number(donor.longitude))
    && Number(donor.latitude) >= -90 && Number(donor.latitude) <= 90
    && Number(donor.longitude) >= -180 && Number(donor.longitude) <= 180;
}

export function match({ state, request, radius, hospital, now = Date.now() }) {
  const alreadyPinged = new Set(state.assignments.filter(a => a.requestId === request.id).map(a => a.donorId));
  return state.donors
    .filter(donor => donor.isAvailable === true && hasMeasuredLocation(donor))
    .map(donor => ({ donor, distanceKm: distanceKm(Number(hospital.latitude), Number(hospital.longitude), Number(donor.latitude), Number(donor.longitude)) }))
    .filter(({ donor, distanceKm: km }) => donor.isAvailable === true
      && isEligible(donor, now)
      && compatible(donor.bloodType, request.bloodType)
      && km <= radius
      && !alreadyPinged.has(donor.id))
    .map(candidate => ({
      ...candidate,
      score: 0.45 / Math.max(candidate.distanceKm, 0.1) + 0.4 * (clampReliability(candidate.donor.reliabilityScore) / RELIABILITY_MAX) + 0.15,
    }))
    .sort((a, b) => b.score - a.score);
}

// Creates PINGED assignments for one dispatch tier.
// `onAssignment(assignment, donor)` lets the caller enqueue durable notifications in the same
// atomic state mutation that created the assignment.
export function dispatchTier({ state, request, radius, tier, hospital, now = Date.now(), onAssignment }) {
  const numberToPing = request.unitsNeeded * ELIGIBILITY.maxPingMultiplier;
  const candidates = match({ state, request, radius, hospital, now }).slice(0, numberToPing);
  const created = [];
  for (const { donor, distanceKm: km, score } of candidates) {
    const assignment = {
      id: randomUUID(),
      requestId: request.id,
      donorId: donor.id,
      donorName: donor.fullName,
      donorBloodType: donor.bloodType,
      tier,
      status: 'PINGED',
      distanceKm: Number(km.toFixed(2)),
      score: Number(score.toFixed(2)),
      notifiedAt: new Date(now).toISOString(),
      checkinToken: null,
    };
    state.assignments.push(assignment);
    created.push(assignment);
    if (typeof onAssignment === 'function') onAssignment(assignment, donor);
  }
  request.currentRadiusKm = radius;
  request.lastDispatchAt = new Date(now).toISOString();
  return created;
}

export function requestView(state, request) {
  const roster = state.assignments.filter(a => a.requestId === request.id);
  const accepted = roster.filter(a => ACCEPTED_ASSIGNMENT_STATUSES.includes(a.status)).length;
  return {
    ...request,
    assignments: roster,
    accepted,
    pinged: roster.length,
    fulfilledUnits: roster.filter(a => a.status === 'COMPLETED').length,
  };
}

export function validateDonorRegistration(profile, now = Date.now()) {
  const fullName = String(profile?.fullName || '').trim();
  const birthDate = new Date(`${profile?.dateOfBirth || ''}T00:00:00Z`);
  const donationDate = new Date(`${profile?.lastDonationDate || ''}T00:00:00Z`);
  const weight = Number(profile?.weightKg);
  const age = ageOn(profile?.dateOfBirth, now);

  if (fullName.length < 2 || fullName.length > 120) return 'Enter your full legal name.';
  if (!BLOOD_TYPES.has(profile?.bloodType)) return 'Select a valid blood group.';
  if (!Number.isFinite(weight) || weight < ELIGIBILITY.registrationWeightKg[0] || weight > ELIGIBILITY.registrationWeightKg[1]) return 'Enter a valid weight in kilograms.';
  if (Number.isNaN(birthDate.getTime()) || !Number.isFinite(age) || age < ELIGIBILITY.minimumAge || age > ELIGIBILITY.maximumAge) return 'Donors must be between 18 and 65 years old.';
  if (Number.isNaN(donationDate.getTime()) || donationDate.getTime() > now) return 'Enter a valid last donation date.';
  if (profile?.sex !== undefined && !SEXES.has(String(profile.sex).toUpperCase())) return 'Select a valid sex.';
  if (profile?.consentAccepted !== true) return 'Consent is required to join the emergency donor network.';
  return null;
}

export function validateRequestInput(input) {
  const bloodType = String(input?.bloodType || '').trim();
  const unitsNeeded = Number(input?.unitsNeeded);
  const urgency = String(input?.urgency ?? 'URGENT').trim().toUpperCase();
  if (!BLOOD_TYPES.has(bloodType)) return { error: 'Select a valid blood group.' };
  if (!Number.isInteger(unitsNeeded) || unitsNeeded < 1 || unitsNeeded > ELIGIBILITY.maxUnitsPerRequest) {
    return { error: `Enter how many units are needed (1-${ELIGIBILITY.maxUnitsPerRequest}).` };
  }
  if (!URGENCIES.has(urgency)) return { error: 'Urgency must be CRITICAL, URGENT or NORMAL.' };
  return { value: { bloodType, unitsNeeded, urgency } };
}

export function validateDeviceInput(input) {
  const installationId = String(input?.installationId || '').trim();
  const expoPushToken = String(input?.expoPushToken || '').trim();
  const platform = String(input?.platform || 'unknown').trim().toLowerCase();
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(installationId)) return { error: 'installationId must be 8-128 url-safe characters.' };
  if (!/^(ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9._~:/?#[\]@!$&'()*+,;=%-]{8,}\]$/.test(expoPushToken)) return { error: 'expoPushToken is not a valid Expo push token.' };
  if (!DEVICE_PLATFORMS.has(platform)) return { error: 'platform must be ios, android, web or unknown.' };
  return { value: { installationId, expoPushToken, platform } };
}

// `demo: false` (always the case in production) yields a completely EMPTY operational dataset: no
// seeded donors, requests, assignments, devices or notifications. Demo fixtures exist only for an
// explicit DEMO_MODE=true local environment.
export function createSeedState({ hospital, now = Date.now(), demo = false }) {
  if (!demo) {
    return {
      donors: [],
      requests: [],
      assignments: [],
      devices: [],
      outbox: [],
      hospitalConfig: { id: hospital.id, name: hospital.name, latitude: hospital.latitude, longitude: hospital.longitude },
      updatedAt: new Date(now).toISOString(),
    };
  }

  const donors = [
    ['+919000000001', 'Asha Menon', 'O-', 10.5292, 76.2156, 148, true],
    ['+919000000002', 'Ravi Nair', 'O+', 10.5311, 76.2080, 126, true],
    ['+919000000003', 'Devika Raj', 'A+', 10.5150, 76.2220, 113, true],
    ['+919000000004', 'Farhan Ali', 'B+', 10.5480, 76.2240, 138, true],
    ['+919000000005', 'Anjali Joseph', 'AB+', 10.4980, 76.1930, 109, true],
    ['+919000000006', 'Maya Thomas', 'O-', 10.6110, 76.2800, 142, true],
  ].map(([phone, fullName, bloodType, latitude, longitude, reliabilityScore, isAvailable], index) => ({
    id: `donor-${index + 1}`,
    phone,
    fullName,
    bloodType,
    latitude,
    longitude,
    reliabilityScore,
    isAvailable,
    dateOfBirth: ['1995-04-14', '1990-09-03', '1997-01-28', '1988-12-17', '1994-07-08', '1992-03-20'][index],
    sex: ['FEMALE', 'MALE', 'FEMALE', 'MALE', 'FEMALE', 'FEMALE'][index],
    weightKg: [61, 74, 58, 78, 63, 67][index],
    consentAccepted: true,
    lastDonationDate: index === 4 ? daysAgo(45, now) : daysAgo(120 + index * 5, now),
    lastSeenAt: new Date(now).toISOString(),
  }));

  return {
    donors,
    requests: [],
    assignments: [],
    devices: [],
    outbox: [],
    hospitalConfig: { id: hospital.id, name: hospital.name, latitude: hospital.latitude, longitude: hospital.longitude },
    updatedAt: new Date(now).toISOString(),
  };
}
