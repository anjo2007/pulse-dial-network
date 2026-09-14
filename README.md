# Pulse Dial

Pulse Dial is a complete emergency blood-dispatch system with a hospital portal, a donor mobile client, and a shared API. It runs locally with seeded data, persists shared application state in Supabase for global syncing and authentication, and deploys directly to Vercel and Android devices.

## Quick Start (Local Development)

```powershell
npm install
npm run dev:api
npm run dev:portal
npm run dev:mobile
```

- **Hospital Portal**: `http://localhost:5173` (Demo credentials: `admin@centralhospital.demo` / `demo123`)
- **Donor Mobile App**: Start Expo Go or run the Android build. (Demo OTP: `123456` with test numbers `+919000000001` through `+919000000006`)
- **Shared API**: `http://localhost:4000`

Run automated tests:
```powershell
npm test
```

---

## Standalone Android APK

A fully compiled and signed Android application APK is generated and located at:
- **`pulse-dial-donor.apk`** (in project root)

To rebuild the APK at any time locally:
```powershell
npm run build:apk
```

### In-App Server Switching
The Android app includes a built-in **Server Settings** configuration button on the sign-in screen. You can point the installed APK to your live Vercel domain (`https://YOUR-VERCEL-DOMAIN.vercel.app/api`) or your computer's Wi-Fi LAN address without rebuilding the app.

---

## Deploy Web Portal on Vercel

1. Import this repository into **Vercel** with the repository root as the project root.
2. The included [`vercel.json`](vercel.json) automatically builds the portal into `apps/portal/dist` and routes `/api/*` to the serverless function.
3. Configure the following environment variables in **Vercel Project Settings → Environment Variables**:
   - `SUPABASE_URL`: Your Supabase Project URL (`https://xyz.supabase.co`)
   - `SUPABASE_SECRET_KEY` (or `SUPABASE_SERVICE_ROLE_KEY`): Supabase service_role secret key
   - `SUPABASE_PUBLISHABLE_KEY` (or `SUPABASE_ANON_KEY`): Supabase anon key
   - `APP_JWT_SECRET`: A long random secret key for session tokens
   - `HOSPITAL_NAME`: Name of your hospital / blood bank
   - `HOSPITAL_LICENSE`: Hospital medical registration number
   - `HOSPITAL_EMAIL`: Hospital administrator login email
   - `HOSPITAL_PASSWORD`: Hospital administrator login password
4. Deploy the project. The portal and API endpoints are now live globally.

---

## Supabase Setup for Global Syncing & Authentication

1. **Create Table**: In your [Supabase Dashboard](https://supabase.com/dashboard) → SQL Editor, run:
   ```sql
   create table if not exists public.app_state (
     id text primary key,
     state jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now()
   );

   alter table public.app_state enable row level security;
   revoke all on public.app_state from anon, authenticated;
   ```
   *(Also available in [`supabase/migrations/001_app_state.sql`](supabase/migrations/001_app_state.sql))*

2. **Validate Connection & Initialize State**:
   Fill in `SUPABASE_URL` and `SUPABASE_SECRET_KEY` in your `.env` file, then run:
   ```powershell
   npm run bootstrap:supabase
   ```
   This automated tool tests the database connection, verifies table permissions, seeds initial state if empty, and checks/provisions the hospital administrator user.

3. **Phone Authentication for Donors**:
   - For testing without SMS fees: In Supabase Dashboard → **Authentication** → **Providers** → **Phone**, enable Phone provider and add test phone numbers with fixed verification codes.
   - For real SMS delivery: Configure Twilio or MessageBird credentials under Supabase Auth Phone settings.

---

## Product Features

- **Hospital Emergency Dispatch**: Broadcast emergency blood requests by blood group, units required, and urgency.
- **Radial Geofenced Dispatch Engine**: Automatically scores and matches eligible, available nearby donors across 1 km → 5 km → 15 km tiers.
- **Donor Onboarding & Medical Safety**: Required screening (blood type, age 18-65, weight ≥ 50kg, 90-day whole blood donation cooldown, safety questionnaire).
- **Fast QR & Arrival Token Check-in**: One-click check-in at the hospital blood bank with reliability score tracking.
- **Global Synchronization**: Real-time state synchronization across all hospital dashboards and mobile donors backed by Supabase.
