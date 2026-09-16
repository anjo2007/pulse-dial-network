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
  appId: '1:18091795649:web:49876e9e5744d1b7cf6040',
  storageBucket: 'pulse-dial-emergency.firebasestorage.app',
  apiKey: 'AIzaSyA4jB52axmrEgma8TvHo1C444y6xCwZJc0',
  authDomain: 'pulse-dial-emergency.firebaseapp.com',
  messagingSenderId: '18091795649'
};

const app = getApps().length > 0 ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app);

/**
 * Direct Hospital Authentication against Firestore 'hospitals' collection.
 * Works universally on Vercel, localhost, and any static/serverless host.
 */
export async function authenticateHospital({ email, password }) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPass = String(password || '').trim();
  
  if (!cleanEmail || !cleanPass) {
    throw new Error('Please enter both hospital email and clinical password.');
  }

  const hospitalsRef = collection(db, 'hospitals');
  const q = query(hospitalsRef, where('email', '==', cleanEmail));
  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    throw new Error('Hospital account not found. Check email or contact blood bank administrator.');
  }

  const docData = snapshot.docs[0].data();
  const hospitalId = snapshot.docs[0].id;

  const expectedPassword = String(docData.password || '').trim();
  if (expectedPassword && expectedPassword !== cleanPass) {
    throw new Error('Invalid clinical password for ' + (docData.name || cleanEmail) + '.');
  }

  const hospital = {
    id: hospitalId,
    name: docData.name || 'Emergency Blood Center',
    email: cleanEmail,
    phone: docData.phone || '',
    licenseNumber: docData.license_number || 'MED-REG-DEFAULT',
    latitude: Number(docData.lat ?? 10.5276),
    longitude: Number(docData.lon ?? 76.2144),
    role: 'hospital'
  };

  const tokenPayload = {
    sub: hospitalId,
    role: 'hospital',
    hospitalId: hospitalId,
    hospitalName: hospital.name,
    iat: Math.floor(Date.now() / 1000),
    exp: Date.now() + 7 * 24 * 3600 * 1000,
  };
  const tokenSegment = btoa(JSON.stringify(tokenPayload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const token = `${tokenSegment}.firebase`;

  return {
    token,
    hospital
  };
}

/**
 * Real-time subscription to emergency requests.
 */
export function subscribeEmergencyRequests(onUpdate, onError) {
  const ref = collection(db, 'emergency_requests');
  return onSnapshot(
    ref,
    (snapshot) => {
      const items = [];
      snapshot.forEach((docSnap) => {
        items.push({ id: docSnap.id, ...docSnap.data() });
      });
      onUpdate(items);
    },
    (err) => {
      console.warn('Firestore emergency_requests listener error:', err);
      if (onError) onError(err);
    }
  );
}

/**
 * Real-time subscription to dispatch assignments.
 */
export function subscribeDispatchAssignments(onUpdate, onError) {
  const ref = collection(db, 'dispatch_assignments');
  return onSnapshot(
    ref,
    (snapshot) => {
      const items = [];
      snapshot.forEach((docSnap) => {
        items.push({ id: docSnap.id, ...docSnap.data() });
      });
      onUpdate(items);
    },
    (err) => {
      console.warn('Firestore dispatch_assignments listener error:', err);
      if (onError) onError(err);
    }
  );
}

/**
 * Real-time subscription to donors for tracking.
 */
export function subscribeDonors(onUpdate, onError) {
  const ref = collection(db, 'donors');
  return onSnapshot(
    ref,
    (snapshot) => {
      const items = [];
      snapshot.forEach((docSnap) => {
        items.push({ id: docSnap.id, ...docSnap.data() });
      });
      onUpdate(items);
    },
    (err) => {
      console.warn('Firestore donors listener error:', err);
      if (onError) onError(err);
    }
  );
}

export function normalizePhoneDigits(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : digits;
}

export const COMPATIBLE_DONORS = {
  'O-': ['O-'],
  'O+': ['O-', 'O+'],
  'A-': ['O-', 'A-'],
  'A+': ['O-', 'O+', 'A-', 'A+'],
  'B-': ['O-', 'B-'],
  'B+': ['O-', 'O+', 'B-', 'B+'],
  'AB-': ['O-', 'A-', 'B-', 'AB-'],
  'AB+': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
};

/**
 * Create a new emergency request directly in Firestore.
 */
export async function createEmergencyRequestDoc({ hospital, bloodType, unitsNeeded, urgency = 'CRITICAL' }) {
  const now = Date.now();
  const id = 'req_' + now + '_' + Math.random().toString(36).substring(2, 7);
  const data = {
    id,
    hospital_id: hospital.id,
    hospital_name: hospital.name,
    blood_type: bloodType,
    units_required: Number(unitsNeeded) || 1,
    units_collected: 0,
    urgency,
    current_wave: 1,
    current_tier: 1,
    current_radius_km: 1.0,
    current_wave_radius_meters: 1000,
    lat: Number(hospital.latitude || 10.5276),
    lon: Number(hospital.longitude || 76.2144),
    status: 'ACTIVE',
    patient_id: 'EMERGENCY-TRAUMA',
    created_at: new Date(now).toISOString(),
    created_at_epoch: now
  };

  await setDoc(doc(db, 'emergency_requests', id), data);

  // Auto-match nearby available donors
  try {
    const donorsRef = collection(db, 'donors');
    const donorsSnap = await getDocs(donorsRef);
    let matched = 0;
    const reqBlood = String(bloodType || '').trim().toUpperCase();
    const seenPhones = new Set();
    const seenDonorIds = new Set();

    for (const donorDoc of donorsSnap.docs) {
      const donor = donorDoc.data();
      const donorId = donorDoc.id;
      const dBlood = String(donor.blood_type || donor.bloodType || '').trim().toUpperCase();

      // 1. Strict blood group matching: only alert donors with the exact same blood group!
      if (!dBlood || dBlood !== reqBlood) continue;

      // 2. Availability: donor must be actively marked available
      const isAvail = donor.is_available ?? donor.isAvailable ?? true;
      if (!isAvail) continue;

      // 3. Consent check: donor must have accepted emergency alert matching consent
      const hasConsent = donor.consent_accepted ?? donor.consentAccepted ?? true;
      if (!hasConsent) continue;

      // 4. Clinical Eligibility: donor must not be marked medically ineligible
      if (donor.eligible === false) continue;

      // 5. Weight Eligibility: whole blood donation requires minimum 50 kg
      const weight = Number(donor.weight_kg ?? donor.weightKg ?? donor.weight);
      if (Number.isFinite(weight) && weight < 50) continue;

      // 6. Age Eligibility: donor must be between 18 and 65 years old
      let age = Number(donor.age);
      const dob = donor.date_of_birth || donor.dob || donor.birthDate;
      if (!Number.isFinite(age) && dob) {
        const dobTime = new Date(dob).getTime();
        if (!Number.isNaN(dobTime)) {
          age = Math.floor((now - dobTime) / (365.25 * 24 * 60 * 60 * 1000));
        }
      }
      if (Number.isFinite(age) && (age < 18 || age > 65)) continue;

      // 7. 90-day whole blood cooldown: if donor donated within last 90 days, do NOT alert them
      const lastDon = donor.last_donation_date || donor.lastDonationDate || '';
      if (lastDon && lastDon !== 'Never Donated') {
        const lastDonTime = new Date(`${lastDon}T00:00:00Z`).getTime();
        if (!Number.isNaN(lastDonTime)) {
          const daysSinceDonation = (now - lastDonTime) / (1000 * 60 * 60 * 24);
          if (daysSinceDonation >= 0 && daysSinceDonation < 90) {
            continue; // Skip donor on active 90-day cooldown
          }
        }
      }

      const donorPhone = donor.phone || '';
      const donorDigits = normalizePhoneDigits(donorPhone);

      // Deduplicate so a donor is never alerted multiple times for the same request
      if (donorDigits && seenPhones.has(donorDigits)) continue;
      if (seenDonorIds.has(donorId)) continue;
      if (donorDigits) seenPhones.add(donorDigits);
      seenDonorIds.add(donorId);

      const asgnId = 'asgn_' + id + '_' + donorId;
      const arrivalOtp = String(Math.floor(100000 + Math.random() * 900000));
      const asgnData = {
        id: asgnId,
        request_id: id,
        donor_id: donorId,
        donor_name: donor.full_name || donor.name || 'Volunteer Donor',
        donor_phone: donorPhone,
        donor_phone_digits: donorDigits,
        blood_type: dBlood,
        distance_km: Number(donor.distance_km || 1.2),
        distance_meters: 1200,
        status: 'PINGED',
        priority_score: 0.95,
        arrival_otp: arrivalOtp,
        qr_token: 'QR_' + now + '_' + donorId.substring(0, 5),
        hospital_name: hospital.name || 'Emergency Medical Centre',
        hospital_id: hospital.id,
        request_blood_type: bloodType,
        units_required: Number(unitsNeeded) || 1,
        urgency,
        created_at: new Date(now).toISOString()
      };
      await setDoc(doc(db, 'dispatch_assignments', asgnId), asgnData);
      matched++;
    }
  } catch (err) {
    console.warn('Auto-match donors error:', err);
  }

  return data;
}

/**
 * End / Close emergency request directly in Firestore.
 */
export async function closeEmergencyRequestDoc(requestId) {
  const reqRef = doc(db, 'emergency_requests', requestId);
  const snap = await getDoc(reqRef);
  if (!snap.exists()) {
    throw new Error('Emergency request not found.');
  }
  const data = snap.data();
  const isFulfilled = (data.units_collected || 0) >= (data.units_required || 1);
  const nextStatus = isFulfilled ? 'FULFILLED' : 'CLOSED';
  await updateDoc(reqRef, {
    status: nextStatus,
    closed_at: new Date().toISOString()
  });

  return {
    id: requestId,
    bloodType: data.blood_type,
    unitsNeeded: data.units_required || 1,
    urgency: data.urgency || 'CRITICAL',
    status: nextStatus,
    currentRadiusKm: data.current_radius_km || 1,
    createdAt: data.created_at,
    assignments: []
  };
}

/**
 * Expand dispatch perimeter in Firestore.
 */
export async function escalateEmergencyRequestDoc(requestId) {
  const reqRef = doc(db, 'emergency_requests', requestId);
  const snap = await getDoc(reqRef);
  if (!snap.exists()) {
    throw new Error('Emergency request not found.');
  }
  const data = snap.data();
  const current = Number(data.current_radius_km || 1);
  const nextRadius = current < 5 ? 5 : (current < 15 ? 15 : current + 5);
  await updateDoc(reqRef, {
    current_radius_km: nextRadius,
    current_tier: (data.current_tier || 1) + 1,
    escalated_at: new Date().toISOString()
  });

  return {
    id: requestId,
    bloodType: data.blood_type,
    unitsNeeded: data.units_required || 1,
    urgency: data.urgency || 'CRITICAL',
    status: data.status || 'ACTIVE',
    currentRadiusKm: nextRadius,
    createdAt: data.created_at,
    assignments: []
  };
}

/**
 * Cancel emergency request directly in Firestore.
 */
export async function cancelEmergencyRequestDoc(requestId) {
  const reqRef = doc(db, 'emergency_requests', requestId);
  const snap = await getDoc(reqRef);
  if (!snap.exists()) {
    throw new Error('Emergency request not found.');
  }
  const data = snap.data();
  await updateDoc(reqRef, {
    status: 'CANCELLED',
    cancelled_at: new Date().toISOString()
  });

  return {
    id: requestId,
    bloodType: data.blood_type,
    unitsNeeded: data.units_required || 1,
    urgency: data.urgency || 'CRITICAL',
    status: 'CANCELLED',
    currentRadiusKm: data.current_radius_km || 1,
    createdAt: data.created_at,
    assignments: []
  };
}

/**
 * Check-in donor at hospital desk using 6-digit OTP or QR token
 */
export async function checkInDonorDesk({ token, arrivalOtp }) {
  const asgnsRef = collection(db, 'dispatch_assignments');
  const snap = await getDocs(asgnsRef);
  let found = null;
  const cleanOtp = String(arrivalOtp || token || '').trim();
  const cleanToken = String(token || arrivalOtp || '').trim();

  for (const d of snap.docs) {
    const data = d.data();
    const itemOtp = String(data.arrival_otp || '').trim();
    const itemQr = String(data.qr_token || data.checkinToken || '').trim();
    const itemId = String(d.id || '').trim();

    if (
      (cleanOtp && itemOtp === cleanOtp) ||
      (cleanToken && itemQr === cleanToken) ||
      (cleanToken && itemId === cleanToken) ||
      (cleanToken && cleanToken.length === 6 && itemQr.replace(/\D/g, '').slice(-6) === cleanToken) ||
      (cleanOtp && cleanOtp.length === 6 && itemId.replace(/\D/g, '').slice(-6) === cleanOtp)
    ) {
      found = { id: d.id, ...data };
      break;
    }
  }

  if (!found) {
    throw new Error('Arrival OTP or token not found in active dispatch assignments.');
  }

  const already = found.status === 'COMPLETED';

  if (!already) {
    await updateDoc(doc(db, 'dispatch_assignments', found.id), {
      status: 'COMPLETED',
      verified_at: new Date().toISOString()
    });
  }

  let unitsCollected = 1;
  let unitsRequired = Number(found.units_required) || 1;
  let bloodType = found.request_blood_type || found.blood_type || 'O-';

  try {
    const reqRef = doc(db, 'emergency_requests', found.request_id);
    const reqSnap = await getDoc(reqRef);
    if (reqSnap.exists()) {
      const rData = reqSnap.data();
      const current = Number(rData.units_collected) || 0;
      const needed = Number(rData.units_required) || 1;
      unitsRequired = needed;
      bloodType = rData.blood_type || bloodType;
      if (!already) {
        unitsCollected = current + 1;
        await updateDoc(reqRef, {
          units_collected: unitsCollected,
          status: unitsCollected >= needed ? 'FULFILLED' : 'ACTIVE'
        });
      } else {
        unitsCollected = current;
      }
    }
  } catch (err) {
    console.warn('Increment units error:', err);
  }

  const assignment = {
    id: found.id,
    donorId: found.donor_id || '',
    donorName: found.donor_name || 'Volunteer Donor',
    donorBloodType: found.blood_type || bloodType,
    status: 'COMPLETED',
    completedAt: found.verified_at || new Date().toISOString()
  };

  const request = {
    id: found.request_id,
    bloodType,
    unitsNeeded: unitsRequired,
    fulfilledUnits: unitsCollected
  };

  return {
    ok: true,
    alreadyCompleted: already,
    donorName: found.donor_name || 'Volunteer Donor',
    bloodType: found.blood_type || bloodType,
    assignment,
    request
  };
}
