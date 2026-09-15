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
  const cleanPhone = String(phone || '').trim().replace(/[^0-9+]/g, '');
  if (!cleanPhone || cleanPhone.length < 6) {
    throw new Error('Please enter a valid mobile phone number.');
  }

  const donorsRef = collection(db, 'donors');
  const q = query(donorsRef, where('phone', '==', cleanPhone));
  const snap = await getDocs(q);

  let donorId;
  let donorData;

  if (!snap.empty) {
    donorId = snap.docs[0].id;
    donorData = snap.docs[0].data();
    // Update location if available
    if (location?.latitude && location?.longitude) {
      await updateDoc(doc(db, 'donors', donorId), {
        lat: Number(location.latitude),
        lon: Number(location.longitude),
        is_available: true
      });
      donorData.lat = location.latitude;
      donorData.lon = location.longitude;
      donorData.is_available = true;
    }
  } else {
    // Generate clean donor ID based on phone or random key
    donorId = 'donor_' + cleanPhone.replace(/\+/g, '');
    donorData = {
      id: donorId,
      full_name: fullName,
      phone: cleanPhone,
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
    phone: cleanPhone,
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
      phone: cleanPhone,
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
 */
export function subscribeDonorAssignments(donorId, onAssignments) {
  const asgnsRef = collection(db, 'dispatch_assignments');
  const q = query(asgnsRef, where('donor_id', '==', donorId));

  return onSnapshot(
    q,
    (snapshot) => {
      const list = [];
      snapshot.forEach((d) => {
        const item = d.data();
        list.push({
          id: d.id,
          requestId: item.request_id,
          status: item.status,
          distanceKm: item.distance_km || 1.2,
          arrivalOtp: item.arrival_otp,
          checkinToken: item.qr_token || ('QR_' + d.id),
          tier: item.tier || 1,
          request: {
            bloodType: item.blood_type || 'O-',
            unitsNeeded: 1,
            hospitalName: item.hospital_name || 'Central City Medical Centre'
          }
        });
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
