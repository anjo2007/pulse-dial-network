# Donor app alerts: architecture, contracts and limits

Scope: `apps/mobile/**` only. This document describes what the donor app implements, what it
deliberately does **not** do, and how to verify it. Nothing here requires a cloud build, a
credential read, or a live SMS/push send.

## 1. Alerting model (honest capabilities)

| Capability | Android | iOS |
| --- | --- | --- |
| High-priority notification | Yes (`emergency-blood-alerts`, importance MAX) | Yes |
| Heads-up banner above other apps | Yes, when permission is granted, channel importance is high, device is not in DND/silent, and the OEM does not suppress it | Banner only; Focus/silent can suppress |
| Sound / vibration | Yes | Yes |
| Lock-screen content | Private (no request detail rendered on the lock screen) | Private |
| Full-screen intent (take over the screen) | **Not used.** `USE_FULL_SCREEN_INTENT` is restricted by Android 14+/Play policy to calling and alarm apps. Pulse Dial must not impersonate either. | Not available |
| Overlay / "display over other apps" | **Not requested.** `SYSTEM_ALERT_WINDOW` was removed from the manifest. Overlay is a drawing permission, not an alert channel, cannot be granted programmatically, and is policy-risky for this use case. | N/A |
| Critical alerts bypassing DND | No (requires a vendor-granted entitlement) | No (requires an Apple entitlement) |

**No delivery guarantee.** OEM battery savers, force-stop, airplane mode, notification limits,
DND, silent mode and the push provider all sit outside the app. The in-app request list plus the
15s/5s polling loop is the authoritative fallback, and the UI says so explicitly.

User-authorized overlay was evaluated and rejected: even with `SYSTEM_ALERT_WINDOW` granted, an
overlay cannot appear over other apps from a killed process without also holding a foreground
service, it does not survive as a notification, it triggers Play policy review for apps without a
core overlay use case, and it cannot be requested via the normal runtime-permission flow. The safe,
OS-sanctioned path is a high-importance heads-up notification, which is what is implemented.

## 2. Backend contract (owned by the backend agent, consumed here)

```
POST   /donor/devices                    Authorization: Bearer <donor session token>
       { "installationId": string, "expoPushToken": string | null, "platform": "android" | "ios" }
       -> 200/201 idempotent upsert keyed on installationId (refresh token for that install)

DELETE /donor/devices/:installationId    Authorization: Bearer <donor session token>
       -> 200/204 (404/410 acceptable; the client then stops retrying)
```

Push payload sent by the backend (minimum viable, no PII):

```json
{
  "to": "<expoPushToken>",
  "title": "Critical blood alert",
  "body": "<generic, no patient or donor identifiers>",
  "priority": "high",
  "channelId": "emergency-blood-alerts",
  "data": { "assignmentId": "asg_123" }
}
```

Client rules enforced in `src/lib/alerts.js`:
- Only `data.assignmentId` is read. Every other key is ignored and never rendered or logged.
- `assignmentId` must match `[A-Za-z0-9._:~-]{1,128}` and must not be a `.`/`..` segment.
- A malformed payload still shows the notification, but performs no navigation.
- `channelId` must be `emergency-blood-alerts`; a different channel would change importance and
  could silently lose the heads-up behaviour.

Registration reliability: transient failures (network, 408, 429, 5xx) are queued in a single-slot
outbox and retried on next launch/sign-in/availability change; 4xx (except 408/429) and 404/410 are
treated as permanent and dropped so a rejected token is never retried forever.

## 3. Runtime behaviours

- Permission-aware UX: `computeAlertingStatus` produces `ok` / `paused` / `degraded` / `blocked`
  with the exact corrective actions (allow notifications, open system settings, enable
  availability, retry channel setup). The status card is always visible on the home screen.
- Token lifecycle: registered when availability is switched on (prompting for permission at that
  moment), re-registered on launch when permission is already granted, unregistered on
  availability off and on sign-out (queued if offline).
- Notification handling: foreground handler set at module load; receive listener triggers a refresh;
  response listener and cold-start response (`getLastNotificationResponseAsync`) route the donor to
  the matching alert; `clearLastNotificationResponseAsync` prevents duplicate routing.
- Deep links: `pulsedial://alert/<assignmentId>` and `pulsedial://alerts`; any other scheme/host is
  rejected (`parseDeepLink`).
- Secure session: token and phone number are stored with `expo-secure-store` (Keychain/Keystore).
  Legacy plaintext `pulse-dial-session` is migrated then deleted. Expired JWTs are rejected on
  restore. Write failures surface as a session-only warning rather than silently going plaintext.
- Android 13+: the channel is created before any permission request or token call, as required.
- Battery/network: polling is foreground-only and pauses in the background; pushes are expected to
  cover the closed-app case.

## 4. Configuration and dependencies

Dependencies added to `apps/mobile/package.json` (SDK 52 pins):
`expo-notifications ~0.29.14`, `expo-secure-store ~14.0.1`, `expo-device ~7.0.1`,
`expo-constants ~17.0.8`. For the optional realtime path only: `@supabase/supabase-js ^2.49.1`
(version aligned with the repo root) and `react-native-url-polyfill ^2.0.0` (URL/WebSocket globals
that supabase-js expects on React Native). Both are loaded lazily, so a build without them still
runs and simply keeps polling. The previous direct-Supabase write path remains removed (section 6).

Env (see `.env.example`): `EXPO_PUBLIC_API_URL`, `EXPO_PUBLIC_EAS_PROJECT_ID`,
`EXPO_PUBLIC_PUSH_TOKEN_ENABLED`, `EXPO_PUBLIC_LOCAL_ALERT_SIMULATOR`, plus the build-only
`GOOGLE_SERVICES_FILE` and the `PULSE_RELEASE_*` / `PULSE_ALLOW_DEBUG_SIGNING` signing variables.

### Dynamic app config (`app.config.js`)

`app.config.js` wraps `app.json` (which is passed in as `config`) and adds:

- `GOOGLE_SERVICES_FILE` -> `android.googleServicesFile`. **Fail closed**: if the variable is set
  and the file is missing, config resolution throws instead of producing an app that can never
  receive a push. Unset the variable to build without push credentials.
- `EXPO_PUBLIC_EAS_PROJECT_ID` (or `EAS_PROJECT_ID` / `EXPO_PROJECT_ID`) -> `extra.eas.projectId`,
  the public identifier `getExpoPushTokenAsync` requires.

Caveat: `scripts/build-apk.js` runs Gradle directly on the committed `android/` folder and does not
run `expo prebuild`. `android.googleServicesFile` is applied by prebuild (it adds the
`com.google.gms.google-services` plugin), so a real FCM setup requires `npx expo prebuild` /
`expo run:android` once, after which the reference APK script can be used again.

Config plugins (`app.json`): `expo-notifications` (color `#e94250`, defaultChannel
`emergency-blood-alerts`), `expo-secure-store` (`configureAndroidBackup: true`), plus the existing
`expo-location`. `android.blockedPermissions` removes `SYSTEM_ALERT_WINDOW` and the legacy
external-storage permissions; `scheme: "pulsedial"` enables deep links.

The committed `android/` project was updated by hand to match (it is built directly by
`scripts/build-apk.js` without a prebuild step): `POST_NOTIFICATIONS` added, `SYSTEM_ALERT_WINDOW`
and external-storage permissions removed, `@xml/secure_store_backup_rules` /
`@xml/secure_store_data_extraction_rules` set, and the `pulsedial://` intent-filter added.

**Remote push needs credentials that this workspace does not contain** (and must not read). The two
requirements are cumulative, not alternatives:

1. **An EAS project id** (`EXPO_PUBLIC_EAS_PROJECT_ID` -> `extra.eas.projectId`). This is required
   because the app calls `getExpoPushTokenAsync`, i.e. it uses Expo's push service as the transport.
2. **Native push credentials for the transport to actually work**:
   - Android: a Firebase project plus **FCM V1 service-account credentials** registered with the
     push service. On-device FCM also needs `google-services.json` wired into the native build
     (`GOOGLE_SERVICES_FILE` -> `android.googleServicesFile`, applied by prebuild as noted above).
   - iOS: an APNs key/certificate uploaded for the bundle id (`com.pulsedial.donor`).

The device token alone is not sufficient: an Expo push token is only meaningful once the push
service holds FCM V1 (and/or APNs) credentials for this application id. **Direct FCM sending is not
implemented** in this app or this repo - the backend targets the Expo push endpoint
(`EXPO_PUSH_ENDPOINT`, `EXPO_ACCESS_TOKEN`). `getDevicePushTokenAsync` was therefore not used: a raw
FCM token would be useless without the same Firebase/FCM V1 credentials and a sender for it.

Without (1) `acquirePushToken()` returns `missing-project-id`; without (2) tokens can be minted but
delivery fails at the provider. In both cases the app reports "Limited to in-app alerts" and keeps
working through polling. Nothing here is claimed as a delivery guarantee.

## 5. Verification

Local (no device/SDK needed) — `npm run check --workspace @pulse/mobile`:
- Babel/`babel-preset-expo` syntax gate over 21 files (`App.js`, `app.config.js`, `index.js`,
  `scripts/**`, `src/**`, `tests/**`).
- `node:test` suites: payload sanitizer, capability matrix, alerting status branches, device
  registration/unregistration/outbox/error classification, donor eligibility, session model
  (including two-segment API tokens and expiry units), deep-link parsing (including traversal
  attempts), sync-config validation and API endpoint validation. Currently 33 tests, all passing.
- `npm test --workspace @pulse/mobile` runs just the unit suites.

On-device checks (must be run on a real release build; a debug build's splash behaviour when
launching from a notification is unreliable and is a known Expo issue):

1. First launch -> channel created, permission prompt appears (Android 13+).
2. Deny permission -> status card shows "blocked" with an Open system settings action; app still
   lists requests while open.
3. Grant permission, enable availability -> `POST /donor/devices` observed with the fixed body.
4. Background/closed app + backend test push -> heads-up banner, tap opens the matching alert.
5. Tap route: cold start and warm start both land on the correct assignment.
6. Disable availability -> `DELETE /donor/devices/:installationId`; sign-out while offline ->
   unregistration stays queued and flushes on next launch.
7. Local simulator button (dev builds) -> notification appears via the real channel with no server.
8. Relaunch -> session restored from secure storage; expired token forces sign-in.

Not verified here: native compile, Gradle build, and real delivery (no device/SDK/credentials).

## 6. Donor workflow fixes in this change

- Removed the bundled Supabase URL/publishable key and the direct-to-Supabase write fallback
  (it bypassed server authorisation). The app is API-only and errors are typed `ApiError`s.
- Removed the plaintext session/phone records; secure storage with migration and expiry checks.
- Removed prefilled demo phone/code defaults; the demo OTP hint appears only in `__DEV__` builds,
  and consent is now required before submitting registration.
- Availability toggle now drives the device registration lifecycle and warns when the donor is in
  a cooldown instead of silently failing.
- Polling moved to `AppState`-aware intervals (no background battery burn, no stale timers).
- Arrival/view guards for missing `request`/`checkinToken` payloads (previous code crashed on
  `alertItem.request.bloodType` when the request was missing).

## 7. Optional realtime "changed" hint

Contract (backend-owned; consumed fail-open by the client):

```
GET /sync/config        Authorization: Bearer <donor session token>
  -> { "enabled": true, "url": string, "publishableKey": string,
       "accessToken": string, "topic": string }
  -> { "enabled": false }                       // demo / not-configured answer
```

Client behaviour (`src/lib/sync.js` validates, `src/services/realtime.js` subscribes):

- The endpoint does not exist today; the agreed demo answer is `{ "enabled": false }`. A 404, an
  error, `enabled: false`, or any invalid field all resolve to "realtime inactive" and the app
  simply keeps polling. Realtime never replaces the polling loop.
- Validation is fail-closed: `url` must be `https://` (the socket carries an access token, so
  cleartext is refused), `publishableKey`/`accessToken` must be non-empty and bounded,
  `topic` must match `[A-Za-z0-9:_-]{1,128}`.
- Subscribed as a **private** channel: `client.realtime.setAuth(accessToken)` is called before
  `client.channel(topic, { config: { private: true } })`, and only the `broadcast` event `changed`
  is handled. The handler triggers a refetch of `/donor/me` + `/donor/alerts`; it never trusts
  payload content, and no realtime payload is rendered or logged.
- **Foreground only**: started when `AppState` becomes `active`, stopped when it leaves `active`.
  No background socket, no background battery/data cost.
- Values from `/sync/config` are never logged (only a redacted `describeSyncConfig` summary exists
  for diagnostics). A subscription error degrades to a warning and keeps polling.
- Independence: realtime is never required for correctness. Same-authority invariant as push - if
  push, realtime and the socket are all unavailable, the foreground polling loop still shows the
  request.

## 8. Release build hardening (fail-closed)

- **Signing**: `android/app/build.gradle` no longer signs release builds with the debug keystore.
  Release requires `PULSE_RELEASE_STORE_FILE`, `PULSE_RELEASE_STORE_PASSWORD`,
  `PULSE_RELEASE_KEY_ALIAS`, `PULSE_RELEASE_KEY_PASSWORD` (or `-Ppulse.release.*`); otherwise a
  `GradleException` fails `assembleRelease`/`bundleRelease` before an artifact is produced. The only
  way to get a debug-signed release is the explicit `PULSE_ALLOW_DEBUG_SIGNING=true` opt-in, which
  also logs a warning.
- `scripts/build-apk.js` no longer silently downgrades: it tries the release build, and only falls
  back to `assembleDebug` when `PULSE_ALLOW_DEBUG_SIGNING=true`; otherwise it exits non-zero with
  ready-to-paste instructions. It also never writes the root/repo APK on failure.
- **Cleartext / API endpoint**: the release manifest does not set `usesCleartextTraffic`
  (debug-only override), so `targetSdk 34` blocks plain HTTP in release. This is enforced in the app
  too, not just advertised:
  - `isAcceptableApiUrl()` (in `src/config.js`) is the single validator: `https://` is always
    accepted, `http://` only when `__DEV__` is true, and a malformed/other scheme is always
    rejected.
  - A rejected compile-time `EXPO_PUBLIC_API_URL` (e.g. `http://…` in a release build) leaves the
    app **unconfigured** instead of pointing at an endpoint that cannot work, and the sign-in screen
    shows the HTTPS warning.
  - `saveApiUrl()` refuses to store an `http://` endpoint outside development, and `loadApiUrl()`
    deletes a stored `http://` record rather than reusing it - so a debug build's dev-server URL
    cannot leak into a release build.
  - Consequence for device testing: point release builds at an `https://` endpoint.
- **Permissions**: `SYSTEM_ALERT_WINDOW` and the legacy external-storage permissions are not
  granted; `USE_FULL_SCREEN_INTENT` is never declared. Notification content stays generic and the
  channel is lock-screen private, so no blood type, hospital, distance or identifier is exposed on
  the lock screen (this also applies to the local test simulator).

## 9. Session token format (as used by the current API)

The API issues `base64url(JSON payload).base64url(hmac-sha256)` - a **two-segment** token, not a
JWT - with `{ role, id, iat, exp }` and `exp` in **milliseconds**. `src/lib/session.js` therefore
reads the payload from segment 1 for two-segment tokens and segment 2 for three-segment (JWT)
tokens, treats anything else as opaque, and normalises the expiry unit (values below `1e12` are
seconds). A 3-segment JWT from a future API version keeps working; an expired token is rejected on
restore instead of being silently reused.

## 10. Production readiness and known limitations

### What a production build must satisfy

`app.config.js` fails before the build when a production/eas build is inconsistent (production is
detected via `EAS_BUILD=true`, `PULSE_ENV=production`, `APP_ENV=production` or `NODE_ENV=production`):

| Situation | Result |
| --- | --- |
| Production, push enabled, no EAS project id | Build fails: `getExpoPushTokenAsync` could never mint a token |
| Production, push enabled, no `GOOGLE_SERVICES_FILE` (Android) | Build fails: an EAS project id alone cannot deliver FCM alerts |
| Production, `PUSH_TOKEN_ENABLED=false`, no acknowledgement | Build fails |
| Production, push disabled **and** `PULSE_ALLOW_POLLING_ONLY=true` | Builds, and `extra.pulseAlerts = "polling-only"` records the intent |
| Development | No requirement: push credentials may be absent |

### Explicitly not production-ready

**A build with no Firebase/EAS credentials is not production-ready and must never be described as
such.** It is a development or explicitly acknowledged polling-only build: alerts appear only while
the app is open, there is no closed-app or above-app alert path, and no delivery guarantee exists.
`extra.pulseAlerts` in the resolved config states which mode a build is in, so this cannot be
misrepresented later.

Even a fully configured build is best-effort: FCM/APNs delivery, OEM battery savers, DND, silent
mode and OS notification limits remain outside the app's control.

### Known limitations / outstanding risk

- **Native code is uncompiled.** Java and the Android SDK were unavailable in the authoring
  environment, so the Gradle/signing changes and the manifest edits are reviewed but have never
  been executed. `assembleRelease`/`bundleRelease` and the new fail-closed `GradleException` path
  are unverified until a real build runs. The reference APK was not rebuilt (no root writes).
- **Stale SDK risk remains.** The app is pinned to Expo SDK 52 / React Native 0.76.3, which is
  behind current releases; the newest `expo-notifications` line changes the foreground handler API
  (`shouldShowBanner`/`shouldShowList` instead of `shouldShowAlert` - this app returns both keys so
  it survives the upgrade). A dependency audit of this tree still reports outstanding findings
  (audit19: 6 high, 13 moderate); none were introduced by this change, and no dependency was
  upgraded as part of it.
- **Push delivery, realtime and device behaviour are unverified live** - no device, no Android SDK
  and no credentials here. Section 5 lists the on-device checks that must still be run.
- **Realtime depends on a backend endpoint that does not exist yet** (`GET /sync/config`). The
  client is fail-open, so this is a non-blocker, but the private-channel path is untested end to end.
