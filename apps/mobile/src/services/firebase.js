import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getFirestore,
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  query,
  where,
  onSnapshot
} from 'firebase/firestore';

export const firebaseConfig = {
  projectId: 'pulse-dial-emergency',
  appId: '1:18091795649:android:201d300e33b2ddc0cf6040',
  storageBucket: 'pulse-dial-emergency.firebasestorage.app',
  apiKey: 'AIzaSyA4jB52axmrEgma8TvHo1C444y6xCwZJc0',
  authDomain: 'pulse-dial-emergency.firebaseapp.com',
  messagingSenderId: '18091795649'
};

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app);

export function normalizePhoneDigits(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

/**
 * Streamlined Donor Sign-In or Registration without OTP friction.
 * Accepts donor phone and details, immediately sets up / restores the donor in Firestore.
 */
export async function signInOrCreateDonor({
  phone,
  fullName = 'Volunteer Donor',
  bloodType = 'O-',
  weightKg = 68,
  age = 26,
  medications = 'None',
  diseases = 'None',
  lastDonationDate = 'Never Donated',
  location = null
}) {
  const rawClean = String(phone || '').trim().replace(/[^0-9+]/g, '');
  const digits = normalizePhoneDigits(rawClean);
  if (!digits || digits.length < 6) {
    throw new Error('Please enter a valid mobile phone number.');
  }

  const donorsRef = collection(db, 'donors');
  const snap = await getDocs(donorsRef);

  let donorDocMatch = null;
  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    if (normalizePhoneDigits(data.phone) === digits) {
      donorDocMatch = docSnap;
      break;
    }
  }

  let donorId;
  let donorData;

  if (donorDocMatch) {
    donorId = donorDocMatch.id;
    donorData = donorDocMatch.data();
    // Update availability, blood type, phone digits, and location
    const updates = {
      is_available: true,
      phone_digits: digits,
    };
    if (bloodType) {
      updates.blood_type = bloodType;
      donorData.blood_type = bloodType;
    }
    if (fullName && fullName !== 'Volunteer Donor') {
      updates.full_name = fullName;
      donorData.full_name = fullName;
    }
    if (weightKg) updates.weight_kg = Number(weightKg) || donorData.weight_kg || 68;
    if (age) updates.age = Number(age) || donorData.age || 26;
    if (lastDonationDate) updates.last_donation_date = lastDonationDate;
    if (location?.latitude && location?.longitude) {
      updates.lat = Number(location.latitude);
      updates.lon = Number(location.longitude);
      donorData.lat = updates.lat;
      donorData.lon = updates.lon;
    }
    await updateDoc(doc(db, 'donors', donorId), updates);
    donorData.is_available = true;
    donorData.phone_digits = digits;
  } else {
    // Generate clean donor ID based on digits
    donorId = 'donor_' + digits;
    donorData = {
      id: donorId,
      full_name: fullName,
      phone: rawClean,
      phone_digits: digits,
      blood_type: bloodType,
      weight_kg: Number(weightKg) || 68,
      age: Number(age) || 26,
      medications,
      diseases,
      last_donation_date: lastDonationDate,
      is_available: true,
      reliability_score: 100,
      lat: location?.latitude ? Number(location.latitude) : 10.528,
      lon: location?.longitude ? Number(location.longitude) : 76.215,
      created_at: new Date().toISOString()
    };
    await setDoc(doc(db, 'donors', donorId), donorData);
  }

  const tokenPayload = {
    sub: donorId,
    role: 'donor',
    phone: rawClean,
    phone_digits: digits,
    bloodType: donorData.blood_type || bloodType,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 30 * 24 * 3600
  };
  const token = 'firebase.donor.' + btoa(JSON.stringify(tokenPayload));

  return {
    token,
    donor: {
      id: donorId,
      fullName: donorData.full_name || fullName,
      phone: donorData.phone || rawClean,
      phone_digits: digits,
      bloodType: donorData.blood_type || bloodType,
      weightKg: donorData.weight_kg || weightKg,
      age: donorData.age || age,
      medications: donorData.medications || medications,
      diseases: donorData.diseases || diseases,
      lastDonationDate: donorData.last_donation_date || lastDonationDate,
      isAvailable: donorData.is_available ?? true,
      reliabilityScore: donorData.reliability_score || 100,
      latitude: donorData.lat,
      longitude: donorData.lon,
      eligible: true
    }
  };
}

/**
 * Update Donor Profile details in Firestore.
 */
export async function updateDonorProfile(donorId, updates) {
  const ref = doc(db, 'donors', donorId);
  const data = {};
  if (updates.fullName !== undefined) data.full_name = updates.fullName;
  if (updates.bloodType !== undefined) data.blood_type = updates.bloodType;
  if (updates.weightKg !== undefined) data.weight_kg = Number(updates.weightKg);
  if (updates.age !== undefined) data.age = Number(updates.age);
  if (updates.medications !== undefined) data.medications = updates.medications;
  if (updates.diseases !== undefined) data.diseases = updates.diseases;
  if (updates.lastDonationDate !== undefined) data.last_donation_date = updates.lastDonationDate;
  if (updates.isAvailable !== undefined) data.is_available = Boolean(updates.isAvailable);
  if (updates.latitude !== undefined) data.lat = Number(updates.latitude);
  if (updates.longitude !== undefined) data.lon = Number(updates.longitude);

  await updateDoc(ref, data);
  return data;
}

/**
 * Real-time GPS location tracking updater for en-route donor.
 */
export async function updateDonorLocation(donorId, lat, lon) {
  try {
    await updateDoc(doc(db, 'donors', donorId), {
      lat: Number(lat),
      lon: Number(lon),
      last_location_at: new Date().toISOString()
    });
  } catch (err) {
    console.warn('Location update error:', err);
  }
}

/**
 * Real-time listener for incoming assignments for this donor.
 * Robustly matches by donor ID or normalized phone digits.
 */
export function subscribeDonorAssignments(donorOrId, onAssignments) {
  const donorId = typeof donorOrId === 'string' ? donorOrId : donorOrId?.id;
  const donorPhone = typeof donorOrId === 'object' ? donorOrId?.phone : '';
  const donorDigits = normalizePhoneDigits(donorPhone);

  const asgnsRef = collection(db, 'dispatch_assignments');

  return onSnapshot(
    asgnsRef,
    (snapshot) => {
      const list = [];
      snapshot.forEach((d) => {
        const item = d.data();
        const asgnDonorId = item.donor_id;
        const asgnPhoneDigits = normalizePhoneDigits(item.donor_phone || item.donor_phone_digits);

        const isMatch =
          (donorId && asgnDonorId === donorId) ||
          (donorDigits && asgnPhoneDigits && asgnPhoneDigits === donorDigits);

        if (isMatch) {
          list.push({
            id: d.id,
            requestId: item.request_id,
            status: item.status,
            distanceKm: item.distance_km || 1.2,
            arrivalOtp: item.arrival_otp,
            checkinToken: item.qr_token || ('QR_' + d.id),
            tier: item.tier || 1,
            request: {
              bloodType: item.request_blood_type || item.blood_type || 'O-',
              unitsNeeded: item.units_required || 1,
              hospitalName: item.hospital_name || 'Emergency Medical Centre'
            }
          });
        }
      });
      onAssignments(list);
    },
    (err) => {
      console.warn('Assignments subscription error:', err);
    }
  );
}

/**
 * Respond to an assignment (ACCEPT -> EN_ROUTE, or DECLINE).
 */
export async function respondAssignment(assignmentId, response) {
  const ref = doc(db, 'dispatch_assignments', assignmentId);
  const status = response === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED';
  await updateDoc(ref, {
    status,
    responded_at: new Date().toISOString()
  });
  return { ok: true, status };
}

/**
 * Mark arrival at hospital
 */
export async function markAssignmentArrived(assignmentId) {
  const ref = doc(db, 'dispatch_assignments', assignmentId);
  await updateDoc(ref, {
    status: 'ARRIVED',
    arrived_at: new Date().toISOString()
  });
  return { ok: true, status: 'ARRIVED' };
}
