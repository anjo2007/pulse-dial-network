import cors from 'cors';
import 'express-async-errors';
import express from 'express';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

// Automatically load .env if present (root or service directory)
if (typeof process.loadEnvFile === 'function') {
  const candidatePaths = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(import.meta.dirname, '../../.env'),
    resolve(import.meta.dirname, '../.env'),
  ];
  for (const envPath of candidatePaths) {
    if (existsSync(envPath)) {
      try { process.loadEnvFile(envPath); break; } catch (_) {}
    }
  }
}

const app = express();
app.use(cors());
app.use(express.json());
app.use((req, _res, next) => {
  // Local development uses /auth; Vercel's catch-all function receives /api/auth.
  if (req.url === '/api') req.url = '/';
  else if (req.url.startsWith('/api/')) req.url = req.url.slice(4);
  next();
});

const hospital = {
  id: 'hospital-central', name: process.env.HOSPITAL_NAME || 'Central City Medical Centre',
  email: process.env.HOSPITAL_EMAIL || 'admin@centralhospital.demo',
  password: process.env.HOSPITAL_PASSWORD || 'demo123',
  licenseNumber: process.env.HOSPITAL_LICENSE || 'MH-EMR-2026-0021', latitude: 10.5276, longitude: 76.2144,
};

let donors = [
  ['+919000000001', 'Asha Menon', 'O-', 10.5292, 76.2156, 148, true],
  ['+919000000002', 'Ravi Nair', 'O+', 10.5311, 76.2080, 126, true],
  ['+919000000003', 'Devika Raj', 'A+', 10.5150, 76.2220, 113, true],
  ['+919000000004', 'Farhan Ali', 'B+', 10.5480, 76.2240, 138, true],
  ['+919000000005', 'Anjali Joseph', 'AB+', 10.4980, 76.1930, 109, true],
  ['+919000000006', 'Maya Thomas', 'O-', 10.6110, 76.2800, 142, true],
].map(([phone, fullName, bloodType, latitude, longitude, reliabilityScore, isAvailable], index) => ({
  id: `donor-${index + 1}`, phone, fullName, bloodType, latitude, longitude, reliabilityScore, isAvailable,
  dateOfBirth: ['1995-04-14', '1990-09-03', '1997-01-28', '1988-12-17', '1994-07-08', '1992-03-20'][index],
  sex: ['FEMALE', 'MALE', 'FEMALE', 'MALE', 'FEMALE', 'FEMALE'][index],
  weightKg: [61, 74, 58, 78, 63, 67][index],
  consentAccepted: true,
  lastDonationDate: index === 4 ? daysAgo(45) : daysAgo(120 + index * 5), lastSeenAt: new Date().toISOString(),
}));
let requests = [];
let assignments = [];

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabasePublishableKey = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;

const supabase = supabaseUrl && supabaseSecretKey
  ? createClient(supabaseUrl, supabaseSecretKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null;
const supabaseAuth = supabaseUrl && supabasePublishableKey
  ? createClient(supabaseUrl, supabasePublishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } })
  : null;
const useSupabaseAuth = Boolean(supabaseAuth && process.env.DEMO_MODE !== 'true');
const productionAuthRequired = Boolean(process.env.VERCEL && process.env.DEMO_MODE !== 'true');

function daysAgo(days) { return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10); }
async function loadState() {
  if (!supabase) return;
  const { data, error } = await supabase.from('app_state').select('state').eq('id', 'primary').maybeSingle();
  if (error) {
    if (error.code === '42P01') {
      throw new Error("Supabase table 'public.app_state' does not exist. Please run migration 'supabase/migrations/001_app_state.sql' in Supabase SQL editor or run 'npm run bootstrap:supabase'.");
    }
    throw new Error(`Supabase could not load application state: ${error.message}`);
  }
  if (data?.state) {
    if (Array.isArray(data.state.donors) && data.state.donors.length > 0) {
      donors = data.state.donors;
    } else {
      await supabase.from('app_state').upsert({ id: 'primary', state: { donors, requests, assignments } });
    }
    if (Array.isArray(data.state.requests)) requests = data.state.requests;
    if (Array.isArray(data.state.assignments)) assignments = data.state.assignments;
  } else {
    const { error: insertError } = await supabase.from('app_state').upsert({ id: 'primary', state: { donors, requests, assignments } });
    if (insertError) throw new Error(`Supabase could not initialize application state: ${insertError.message}`);
  }
}
async function saveState() {
  if (!supabase) return;
  const { error } = await supabase.from('app_state').upsert({ id: 'primary', state: { donors, requests, assignments }, updated_at: new Date().toISOString() });
  if (error) throw new Error(`Supabase could not save application state: ${error.message}`);
}
function issueSession(subject) {
  const payload = Buffer.from(JSON.stringify({ ...subject, exp: Date.now() + 7 * 86400000 })).toString('base64url');
  const signature = createHmac('sha256', process.env.APP_JWT_SECRET || 'local-development-only').update(payload).digest('base64url');
  return `${payload}.${signature}`;
}
function readSession(token) {
  if (!token?.includes('.')) return null;
  const [payload, signature] = token.split('.');
  const expected = createHmac('sha256', process.env.APP_JWT_SECRET || 'local-development-only').update(payload).digest('base64url');
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try { const subject = JSON.parse(Buffer.from(payload, 'base64url').toString()); return subject.exp > Date.now() ? subject : null; } catch { return null; }
}
function auth(role) {
  return (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    const subject = readSession(token);
    if (!subject || subject.role !== role) return res.status(401).json({ error: 'Please sign in to continue.' });
    req.subject = subject; next();
  };
}
function donorView(donor) {
  const nextEligibleDate = new Date(new Date(donor.lastDonationDate).getTime() + 90 * 86400000).toISOString().slice(0, 10);
  return { ...donor, eligible: isEligible(donor), nextEligibleDate };
}
function ageOn(dateOfBirth) {
  const birth = new Date(`${dateOfBirth}T00:00:00Z`);
  return Math.floor((Date.now() - birth.getTime()) / 31557600000);
}
function isEligible(donor) {
  return Boolean(donor.consentAccepted)
    && Number(donor.weightKg) >= 50
    && ageOn(donor.dateOfBirth) >= 18
    && ageOn(donor.dateOfBirth) <= 65
    && new Date(donor.lastDonationDate) <= new Date(Date.now() - 90 * 86400000);
}
function validateDonorRegistration(profile) {
  const bloodTypes = new Set(['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+']);
  const birthDate = new Date(`${profile.dateOfBirth || ''}T00:00:00Z`);
  const donationDate = new Date(`${profile.lastDonationDate || ''}T00:00:00Z`);
  if (!profile.fullName || String(profile.fullName).trim().length < 2) return 'Enter your full legal name.';
  if (!bloodTypes.has(profile.bloodType)) return 'Select a valid blood group.';
  if (!Number.isFinite(Number(profile.weightKg)) || Number(profile.weightKg) < 35 || Number(profile.weightKg) > 250) return 'Enter a valid weight in kilograms.';
  if (Number.isNaN(birthDate.getTime()) || ageOn(profile.dateOfBirth) < 18 || ageOn(profile.dateOfBirth) > 65) return 'Donors must be between 18 and 65 years old.';
  if (Number.isNaN(donationDate.getTime()) || donationDate > new Date()) return 'Enter a valid last donation date.';
  if (profile.consentAccepted !== true) return 'Consent is required to join the emergency donor network.';
  return null;
}
function distanceKm(aLat, aLon, bLat, bLon) {
  const toRad = value => value * Math.PI / 180;
  const dLat = toRad(bLat - aLat), dLon = toRad(bLon - aLon);
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1 - x));
}
function compatible(donorType, requestedType) {
  const table = {
    'O-': ['O-'], 'O+': ['O-', 'O+'], 'A-': ['O-', 'A-'], 'A+': ['O-', 'O+', 'A-', 'A+'],
    'B-': ['O-', 'B-'], 'B+': ['O-', 'O+', 'B-', 'B+'], 'AB-': ['O-', 'A-', 'B-', 'AB-'],
    'AB+': ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'],
  };
  return table[requestedType]?.includes(donorType) ?? donorType === requestedType;
}
function match(request, radius) {
  const existing = new Set(assignments.filter(a => a.requestId === request.id).map(a => a.donorId));
  return donors.map(donor => ({ donor, distanceKm: distanceKm(hospital.latitude, hospital.longitude, donor.latitude, donor.longitude) }))
    .filter(({ donor, distanceKm }) => donor.isAvailable && donorView(donor).eligible && compatible(donor.bloodType, request.bloodType) && distanceKm <= radius && !existing.has(donor.id))
    .map(candidate => ({ ...candidate, score: .45 / Math.max(candidate.distanceKm, .1) + .40 * (candidate.donor.reliabilityScore / 150) + .15 }))
    .sort((a, b) => b.score - a.score);
}
function dispatchTier(request, radius, tier) {
  const numberToPing = request.unitsNeeded * 3;
  const matched = match(request, radius).slice(0, numberToPing);
  matched.forEach(({ donor, distanceKm, score }) => assignments.push({
    id: randomUUID(), requestId: request.id, donorId: donor.id, donorName: donor.fullName, donorBloodType: donor.bloodType,
    tier, status: 'PINGED', distanceKm: Number(distanceKm.toFixed(2)), score: Number(score.toFixed(2)), notifiedAt: new Date().toISOString(), checkinToken: null,
  }));
  request.currentRadiusKm = radius; request.lastDispatchAt = new Date().toISOString();
  return matched.length;
}
function requestView(request) {
  const roster = assignments.filter(a => a.requestId === request.id);
  const accepted = roster.filter(a => ['ACCEPTED', 'ARRIVED', 'COMPLETED'].includes(a.status)).length;
  return { ...request, assignments: roster, accepted, pinged: roster.length, fulfilledUnits: roster.filter(a => a.status === 'COMPLETED').length };
}

app.use(async (_req, res, next) => {
  try { await loadState(); next(); } catch (error) { res.status(503).json({ error: error.message }); }
});

app.get('/health', (_, res) => res.json({
  status: 'ok',
  service: 'pulse-dial-api',
  persistence: supabase ? 'supabase' : 'local-demo',
  supabaseConfigured: Boolean(supabase),
  authentication: useSupabaseAuth ? 'supabase-auth' : 'development-demo',
}));
app.post('/auth/hospital', async (req, res) => {
  if (productionAuthRequired && !useSupabaseAuth) return res.status(503).json({ error: 'Supabase Auth must be configured before production sign-in can be used.' });
  let authUserId = null;
  if (useSupabaseAuth) {
    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email: req.body.email, password: req.body.password });
    if (error || !data.user) return res.status(401).json({ error: 'Invalid hospital credentials.' });
    const isHospital = data.user.app_metadata?.role === 'hospital' || data.user.user_metadata?.role === 'hospital';
    if (!isHospital) return res.status(403).json({ error: 'This account is not approved for hospital dispatch access.' });
    authUserId = data.user.id;
  } else if (req.body.email !== hospital.email || req.body.password !== hospital.password) return res.status(401).json({ error: 'Invalid hospital credentials.' });
  const token = issueSession({ role: 'hospital', id: hospital.id, authUserId });
  res.json({ token, hospital: { ...hospital, password: undefined } });
});
app.post('/auth/donor/start', async (req, res) => {
  const phone = String(req.body.phone || '').replace(/\s/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) return res.status(400).json({ error: 'Enter an international phone number, such as +919000000001.' });
  if (productionAuthRequired && !useSupabaseAuth) return res.status(503).json({ error: 'Supabase Auth must be configured before production sign-in can be used.' });
  if (!useSupabaseAuth) return res.json({ delivery: 'development', message: 'Use development code 123456.' });
  const { error } = await supabaseAuth.auth.signInWithOtp({ phone });
  if (error) return res.status(400).json({ error: `SMS could not be sent: ${error.message}` });
  res.json({ delivery: 'sms', message: 'A verification code was sent to your phone.' });
});
app.post('/auth/donor/verify', async (req, res) => {
  const { code, fullName, bloodType } = req.body;
  const phone = String(req.body.phone || '').replace(/\s/g, '');
  let authUserId = null;
  if (productionAuthRequired && !useSupabaseAuth) return res.status(503).json({ error: 'Supabase Auth must be configured before production sign-in can be used.' });
  if (useSupabaseAuth) {
    const { data, error } = await supabaseAuth.auth.verifyOtp({ phone, token: String(code || ''), type: 'sms' });
    if (error || !data.user) return res.status(401).json({ error: error?.message || 'The verification code is invalid or expired.' });
    authUserId = data.user.id;
  } else if (code !== '123456') return res.status(401).json({ error: 'Use development code 123456.' });
  let donor = donors.find(item => item.authUserId === authUserId || item.phone === phone);
  if (!donor) {
    const profileError = validateDonorRegistration(req.body);
    if (profileError) return res.status(400).json({ error: profileError });
    donor = { id: randomUUID(), phone, fullName: String(fullName).trim(), bloodType, dateOfBirth: req.body.dateOfBirth, sex: req.body.sex || 'UNSPECIFIED', weightKg: Number(req.body.weightKg), consentAccepted: true, latitude: hospital.latitude + .01, longitude: hospital.longitude + .01, reliabilityScore: 100, isAvailable: true, lastDonationDate: req.body.lastDonationDate, lastSeenAt: new Date().toISOString() };
    donors.push(donor);
    await saveState();
  }
  if (authUserId && donor.authUserId !== authUserId) { donor.authUserId = authUserId; await saveState(); }
  const token = issueSession({ role: 'donor', id: donor.id, authUserId });
  res.json({ token, donor: donorView(donor) });
});
app.get('/hospital/requests', auth('hospital'), (_, res) => res.json(requests.map(requestView)));
app.post('/hospital/requests', auth('hospital'), async (req, res) => {
  const { bloodType, unitsNeeded, urgency = 'URGENT' } = req.body;
  if (!bloodType || !Number.isInteger(Number(unitsNeeded)) || Number(unitsNeeded) < 1) return res.status(400).json({ error: 'Blood type and a positive number of units are required.' });
  const request = { id: randomUUID(), bloodType, unitsNeeded: Number(unitsNeeded), urgency, status: 'DISPATCHING', currentRadiusKm: 1, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60 * 60000).toISOString() };
  requests.unshift(request); dispatchTier(request, 1, 1); await saveState(); res.status(201).json(requestView(request));
});
app.post('/hospital/requests/:id/escalate', auth('hospital'), async (req, res) => {
  const request = requests.find(item => item.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  const radius = request.currentRadiusKm === 1 ? 5 : 15;
  dispatchTier(request, radius, radius === 5 ? 2 : 3); await saveState(); res.json(requestView(request));
});
app.post('/hospital/requests/:id/close', auth('hospital'), async (req, res) => {
  const request = requests.find(item => item.id === req.params.id);
  if (!request) return res.status(404).json({ error: 'Request not found.' });
  request.status = 'FULFILLED'; await saveState(); res.json(requestView(request));
});
app.post('/hospital/checkin', auth('hospital'), async (req, res) => {
  const assignment = assignments.find(item => item.checkinToken === req.body.token);
  if (!assignment) return res.status(404).json({ error: 'Arrival token was not found.' });
  assignment.status = 'COMPLETED'; assignment.completedAt = new Date().toISOString();
  const donor = donors.find(item => item.id === assignment.donorId); donor.reliabilityScore += 15;
  const request = requests.find(item => item.id === assignment.requestId);
  if (assignments.filter(item => item.requestId === request.id && item.status === 'COMPLETED').length >= request.unitsNeeded) request.status = 'FULFILLED';
  await saveState();
  res.json({ assignment, request: requestView(request) });
});
app.get('/donor/me', auth('donor'), (req, res) => res.json(donorView(donors.find(item => item.id === req.subject.id))));
app.patch('/donor/me', auth('donor'), async (req, res) => {
  const donor = donors.find(item => item.id === req.subject.id);
  if (!donor) return res.status(404).json({ error: 'Donor profile not found.' });
  const { isAvailable, latitude, longitude } = req.body;
  if (isAvailable !== undefined && typeof isAvailable !== 'boolean') return res.status(400).json({ error: 'Availability must be true or false.' });
  if (latitude !== undefined && (!Number.isFinite(latitude) || latitude < -90 || latitude > 90)) return res.status(400).json({ error: 'Latitude is invalid.' });
  if (longitude !== undefined && (!Number.isFinite(longitude) || longitude < -180 || longitude > 180)) return res.status(400).json({ error: 'Longitude is invalid.' });
  if (isAvailable !== undefined) donor.isAvailable = isAvailable;
  if (latitude !== undefined) donor.latitude = Number(latitude);
  if (longitude !== undefined) donor.longitude = Number(longitude);
  donor.lastSeenAt = new Date().toISOString(); await saveState(); res.json(donorView(donor));
});
app.get('/donor/alerts', auth('donor'), (req, res) => {
  const alerts = assignments.filter(item => item.donorId === req.subject.id && ['PINGED', 'ACCEPTED', 'ARRIVED'].includes(item.status)).map(item => ({ ...item, request: requests.find(request => request.id === item.requestId) }));
  res.json(alerts);
});
app.post('/donor/assignments/:id/respond', auth('donor'), async (req, res) => {
  const assignment = assignments.find(item => item.id === req.params.id && item.donorId === req.subject.id);
  if (!assignment) return res.status(404).json({ error: 'Alert not found.' });
  if (!['ACCEPT', 'DECLINE'].includes(req.body.response)) return res.status(400).json({ error: 'Invalid response.' });
  assignment.status = req.body.response === 'ACCEPT' ? 'ACCEPTED' : 'DECLINED'; assignment.respondedAt = new Date().toISOString();
  if (assignment.status === 'ACCEPTED') assignment.checkinToken = `PULSE:${assignment.id}:${randomUUID().slice(0, 8)}`;
  await saveState();
  res.json(assignment);
});
app.post('/donor/assignments/:id/arrive', auth('donor'), async (req, res) => {
  const assignment = assignments.find(item => item.id === req.params.id && item.donorId === req.subject.id);
  if (!assignment) return res.status(404).json({ error: 'Alert not found.' });
  assignment.status = 'ARRIVED'; assignment.arrivedAt = new Date().toISOString(); await saveState(); res.json(assignment);
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ error: 'The server could not complete that operation. Please try again.' });
});

const port = process.env.PORT || 4000;
const isDirectRun = process.argv[1] && (process.argv[1].endsWith('server.js') || process.argv[1].endsWith('server'));
if (!process.env.VERCEL && process.env.NODE_ENV !== 'test' && isDirectRun) {
  app.listen(port, () => console.log(`Pulse Dial API listening on http://localhost:${port}`));
}
export { app };
export default app;
