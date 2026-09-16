# Pulse Dial

Pulse Dial is an ultra-reliable, emergency blood-dispatch network connecting hospital trauma centres directly with nearby verified volunteer blood donors. It features a **Hospital Web Portal**, a **Donor Android Mobile Application**, and a shared real-time **Firebase** backend.

---

## Architecture & Real-Time Sync

Pulse Dial uses a synchronized real-time architecture:
- **Hospital Emergency Portal**: React 18 + Vite dashboard for trauma surgeons and blood bank dispatchers.
- **Donor Mobile App**: React Native (Expo bare workflow) with native Kotlin modules for hover alerts and audible emergency siren dispatch.
- **Firebase Firestore**: Real-time synchronization of emergency requests, donor assignments, and live status.
- **Optional REST API**: Node.js / Express backend with Supabase persistence for hybrid deployments.

---

## Standalone Android APK

A fully compiled and signed release APK is generated in the repository root:
- **`pulse-dial-donor.apk`** (Ready for direct installation on any Android phone)

### How to Rebuild APK:
```powershell
npm run build:apk
```

### In-App Server & Firebase Switching:
The mobile app features instant phone sign-in (no SMS delays) and a **Server Settings** configuration button on the sign-in screen to point to local LAN servers or custom API endpoints if needed.

---

## Key Product Features

### 1. 🚨 Pro Emergency Dispatch HUD & Siren Audio
- **Audible Siren**: Native Kotlin `MediaPlayer` with `AudioAttributes.USAGE_ALARM` plays an emergency two-tone dispatch siren on loop during incoming alerts.
- **In-App Mute Toggle**: Donors can silence the siren with a single tap while reading hospital details.
- **Tactical Radar HUD**: Concentric animated GPS radar waves, prominent exact-match blood group disk, and Code Red trauma badge.
- **Dispatch Logistics Intel**: Real-time proximity distance (km), required units, and calculated estimated drive time (ETA).
- **Hover / Overlay Alert**: Native Android "Display Over Other Apps" integration allows alerts to pop up immediately over any running application.

### 2. ⏳ 90-Day Whole-Blood Donation Cooldown Protection
- **Hospital Dispatch Filtering**: The dispatch engine automatically filters out any donor who donated blood within the past 90 days.
- **Mobile Alert Suppression**: If a donor has an active 90-day cooldown, emergency alert popups and notifications are automatically suppressed.
- **Live Countdown Display**: Profile card and standby dashboard display the exact days remaining until the cooldown period expires.

### 3. ✏️ Complete Profile Management
- **Full Legal Name & Phone**: Editable with phone digit normalization.
- **Blood Group**: Quick-select chips across all standard blood types (`O-`, `O+`, `A-`, `A+`, `B-`, `B+`, `AB-`, `AB+`).
- **Weight & Age / Date of Birth**: Includes integrated calendar date picker with automatic age calculation.
- **Biological Sex / Gender**: Selection for Male, Female, Other, or Unspecified.
- **Last Donation Date Picker**: Custom date picker with quick presets ("Never Donated", "Today", "1 Month Ago", "3 Months Ago", "6 Months Ago") and live cooldown status feedback.
- **Medical Conditions & Medications**: Detailed health screening fields.
- **GPS Coordinates**: Real-time GPS location display with a "Refresh to Current GPS Location" button.
- **Emergency Availability**: Instant toggle switch to pause alerts when traveling or unwell.

### 4. 🔢 6-Digit Arrival OTP Check-In
- When a donor accepts an emergency alert and completes the 4-point safety check, a clean **6-digit Arrival OTP** is displayed on their screen.
- Hospital staff enter this 6-digit code in the portal check-in modal to immediately confirm donor arrival and update inventory.

---

## Quick Start (Local Development)

### 1. Install Dependencies
```powershell
npm install
```

### 2. Run Applications
```powershell
# Run Hospital Web Portal (Vite on http://localhost:5173)
npm run dev:portal

# Run Donor Mobile App (Metro bundler)
npm run dev:mobile

# Run Shared API Service (http://localhost:4000)
npm run dev:api
```

### 3. Run Automated Tests
```powershell
# Run all workspace test suites
npm test

# Run mobile syntax checks and unit tests
npm run check:mobile
```

---

## Portal Deployment (Vercel)

1. Import this repository into **Vercel**.
2. [`vercel.json`](vercel.json) automatically configures the portal build (`apps/portal/dist`) and serverless routes.
3. Configure environment variables in **Vercel Project Settings → Environment Variables**:
   - `VITE_FIREBASE_API_KEY`: Firebase web API key
   - `VITE_FIREBASE_AUTH_DOMAIN`: Firebase auth domain
   - `VITE_FIREBASE_PROJECT_ID`: Firebase project ID (`pulse-dial-emergency`)
   - `VITE_FIREBASE_STORAGE_BUCKET`: Firebase storage bucket
   - `VITE_FIREBASE_MESSAGING_SENDER_ID`: Firebase sender ID
   - `VITE_FIREBASE_APP_ID`: Firebase app ID
4. Deploy the project. The portal is live globally.
