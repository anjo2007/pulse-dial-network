import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import QRCode from 'react-native-qrcode-svg';
import * as Location from 'expo-location';

import { ALERT_POLL_INTERVAL_MS, LOCAL_ALERT_SIMULATOR_ENABLED } from './src/config.js';
import { api, getApiUrl, loadApiUrl, resetApiUrl, saveApiUrl } from './src/api.js';
import { donorView } from './src/lib/donor.js';
import { parseDeepLink, resolveAlertRoute } from './src/lib/alerts.js';
import {
  clearSession,
  loadDonorPhone,
  loadSession,
  saveDonorPhone,
  saveSession,
} from './src/services/sessionStore.js';
import { createDeviceRegistry } from './src/services/deviceRegistration.js';
import { AlertNotifications } from './src/services/notificationsClient.js';
import { createRealtimeSync } from './src/services/realtime.js';
import { useAlerting } from './src/hooks/useAlerting.js';

// Demo/debug affordances (prefilled demo OTP) only ever exist in development builds.
const DEMO_MODE = typeof __DEV__ !== 'undefined' && __DEV__;

const bloodTypes = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];

// The session token is kept in memory for the device-registration callback; persistence
// itself lives in the OS secure store (see src/services/sessionStore.js).
let activeToken = null;

const deviceRegistry = createDeviceRegistry({
  request: (method, path, body) =>
    api(path, { method, body: body ? JSON.stringify(body) : undefined }, activeToken),
  logger: { warn: (message) => console.warn(message) },
});

const Button = ({ title, onPress, variant = 'primary', disabled = false }) => (
  <Pressable
    disabled={disabled}
    onPress={onPress}
    style={[styles.button, styles[variant], disabled && styles.disabled]}
  >
    <Text style={[styles.buttonText, variant !== 'primary' && styles.darkButtonText]}>{title}</Text>
  </Pressable>
);

function SignIn({ onSignedIn }) {
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [bloodType, setBloodType] = useState('O-');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [weightKg, setWeightKg] = useState('');
  const [lastDonationDate, setLastDonationDate] = useState('');
  const [sex, setSex] = useState('UNSPECIFIED');
  const [consentAccepted, setConsentAccepted] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [serverUrl, setServerUrl] = useState(getApiUrl());
  const [showConfig, setShowConfig] = useState(false);

  useEffect(() => {
    loadApiUrl().then((url) => setServerUrl(url));
    deviceRegistry.flush().catch(() => {});
  }, []);

  async function saveServer() {
    try {
      const clean = await saveApiUrl(serverUrl);
      setServerUrl(clean);
      Alert.alert('Server configured', `Connected to: ${clean}`);
      setShowConfig(false);
    } catch (err) {
      Alert.alert('Invalid URL', err.message);
    }
  }

  async function resetServer() {
    const restored = await resetApiUrl();
    setServerUrl(restored);
    Alert.alert(
      'Server reset',
      restored ? `Restored default: ${restored}` : 'Cleared. Enter the Pulse API URL to continue.'
    );
    setShowConfig(false);
  }

  async function sendCode() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await api('/auth/donor/start', {
        method: 'POST',
        body: JSON.stringify({ phone: phone.trim() }),
      });
      setNotice(result.message);
      if (result.message && result.message.includes('123456') && !code) {
        setCode('123456');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!phone.trim()) return setError('Enter your mobile number.');
    if (!code.trim()) return setError('Enter the one-time code sent to your phone.');
    if (!consentAccepted) {
      return setError('Consent to emergency-alert matching is required before continuing.');
    }
    setBusy(true);
    setError('');
    try {
      const session = await api('/auth/donor/verify', {
        method: 'POST',
        body: JSON.stringify({
          phone: phone.trim(),
          code: code.trim(),
          fullName: name || undefined,
          bloodType,
          dateOfBirth,
          weightKg: Number(weightKg) || undefined,
          lastDonationDate,
          sex,
          consentAccepted,
        }),
      });
      await saveDonorPhone(phone.trim());
      await onSignedIn(session);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ExpoStatusBar style="light" />
      <ScrollView>
        <View style={styles.signTop}>
          <View style={styles.cross}>
            <Text style={styles.crossText}>+</Text>
          </View>
          <Text style={styles.brand}>PULSE DIAL</Text>
          <Text style={styles.signTitle}>Give time. Save a life.</Text>
          <Text style={styles.signText}>
            Join a verified local donor network ready to help in a critical emergency.
          </Text>
          {serverUrl ? null : (
            <View style={styles.warningBadge}>
              <Text style={styles.warningBadgeText}>
                No API endpoint configured for this build. Open Server Settings below to enter your Pulse API URL.
              </Text>
            </View>
          )}
        </View>

        <View style={styles.signForm}>
          <Text style={styles.formTitle}>Donor sign in or register</Text>
          <Text style={styles.formSub}>
            Existing donors need only their phone and verification code. New donors complete their
            safety profile below.
          </Text>

          <Text style={styles.label}>Mobile number</Text>
          <TextInput
            value={phone}
            onChangeText={setPhone}
            style={styles.input}
            keyboardType="phone-pad"
            placeholder="+91 90000 00000"
            autoCapitalize="none"
          />
          <Button
            title={busy ? 'Sending...' : 'Send verification code'}
            variant="outline"
            onPress={sendCode}
            disabled={busy}
          />

          <Text style={styles.label}>One-time code</Text>
          <TextInput
            value={code}
            onChangeText={setCode}
            style={styles.input}
            keyboardType="number-pad"
            placeholder="6-digit code"
          />
          {DEMO_MODE ? (
            <Text style={styles.hint}>
              Development build: the API accepts the fixed demo code 123456 for test numbers.
            </Text>
          ) : null}
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}

          <View style={styles.registration}>
            <Text style={styles.registrationTitle}>New donor medical profile</Text>
            <Text style={styles.label}>Full legal name</Text>
            <TextInput
              value={name}
              onChangeText={setName}
              style={styles.input}
              placeholder="Your full name"
            />
            <Text style={styles.label}>Blood group</Text>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={styles.typeRow}
            >
              {bloodTypes.map((type) => (
                <Pressable
                  onPress={() => setBloodType(type)}
                  key={type}
                  style={[styles.typeChip, bloodType === type && styles.typeSelected]}
                >
                  <Text style={[styles.typeText, bloodType === type && styles.typeTextSelected]}>
                    {type}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
            <Text style={styles.label}>Date of birth</Text>
            <TextInput
              value={dateOfBirth}
              onChangeText={setDateOfBirth}
              style={styles.input}
              placeholder="YYYY-MM-DD"
            />
            <Text style={styles.label}>Weight in kilograms</Text>
            <TextInput
              value={weightKg}
              onChangeText={setWeightKg}
              style={styles.input}
              placeholder="e.g. 62"
              keyboardType="decimal-pad"
            />
            <Text style={styles.label}>Last whole-blood donation</Text>
            <TextInput
              value={lastDonationDate}
              onChangeText={setLastDonationDate}
              style={styles.input}
              placeholder="YYYY-MM-DD"
            />
            <Text style={styles.label}>Sex</Text>
            <View style={styles.sexRow}>
              {['FEMALE', 'MALE', 'UNSPECIFIED'].map((value) => (
                <Pressable
                  key={value}
                  onPress={() => setSex(value)}
                  style={[styles.sexChip, sex === value && styles.sexSelected]}
                >
                  <Text style={[styles.sexText, sex === value && styles.sexTextSelected]}>
                    {value[0] + value.slice(1).toLowerCase()}
                  </Text>
                </Pressable>
              ))}
            </View>
            <Pressable style={styles.consent} onPress={() => setConsentAccepted((value) => !value)}>
              <View style={[styles.check, consentAccepted && styles.checked]}>
                {consentAccepted && <Text style={styles.checkText}>+</Text>}
              </View>
              <Text style={styles.consentText}>
                I consent to emergency-alert matching and confirm these medical details are accurate.
              </Text>
            </Pressable>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button
            title={busy ? 'Signing in...' : 'Continue as donor'}
            onPress={submit}
            disabled={busy}
          />

          <Pressable onPress={() => setShowConfig((value) => !value)} style={styles.configToggle}>
            <Text style={styles.configToggleText}>
              {showConfig ? 'Hide Server Settings' : 'Server Settings'}
            </Text>
          </Pressable>

          {showConfig && (
            <View style={styles.configPanel}>
              <Text style={styles.configTitle}>Pulse API endpoint</Text>
              <TextInput
                value={serverUrl}
                onChangeText={setServerUrl}
                style={[styles.input, styles.configInput]}
                autoCapitalize="none"
                placeholder="http://192.168.1.5:4000"
              />
              <Text style={[styles.label, { marginTop: 4, marginBottom: 6 }]}>Quick presets</Text>
              <View style={[styles.typeRow, { marginBottom: 12 }]}>
                <Pressable
                  onPress={() => setServerUrl('http://192.168.1.5:4000')}
                  style={[styles.typeChip, serverUrl === 'http://192.168.1.5:4000' && styles.typeSelected]}
                >
                  <Text style={[styles.typeText, serverUrl === 'http://192.168.1.5:4000' && styles.typeTextSelected]}>
                    Wi-Fi (192.168.1.5)
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => setServerUrl('http://10.0.2.2:4000')}
                  style={[styles.typeChip, serverUrl === 'http://10.0.2.2:4000' && styles.typeSelected]}
                >
                  <Text style={[styles.typeText, serverUrl === 'http://10.0.2.2:4000' && styles.typeTextSelected]}>
                    Emulator (10.0.2.2)
                  </Text>
                </Pressable>
              </View>
              <View style={styles.configButtons}>
                <View style={styles.flex}>
                  <Button title="Save" onPress={saveServer} />
                </View>
                <View style={styles.flex}>
                  <Button title="Reset" variant="outline" onPress={resetServer} />
                </View>
              </View>
            </View>
          )}

          <Text style={styles.privacy}>
            Your information is screened by the matching engine. Hospital staff conduct the final
            clinical eligibility assessment.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function AlertStatusCard({ status, busy, onAction }) {
  const tone =
    status.level === 'ok'
      ? styles.statusOk
      : status.level === 'blocked'
        ? styles.statusBlocked
        : styles.statusWarn;
  return (
    <View style={[styles.statusCard, tone]}>
      <Text style={styles.statusTitle}>{status.headline}</Text>
      <Text style={styles.statusDetail}>{status.detail}</Text>
      <View style={styles.statusActions}>
        {status.actions.map((action) => (
          <Pressable key={action} disabled={busy} onPress={() => onAction(action)} style={styles.statusAction}>
            <Text style={styles.statusActionText}>
              {action === 'request-permission'
                ? 'Allow notifications'
                : action === 'open-settings'
                  ? 'Open system settings'
                  : action === 'enable-availability'
                    ? 'Turn availability on'
                    : 'Retry setup'}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function Screening({ alertItem, token, onDone, onCancel }) {
  const [answers, setAnswers] = useState([false, false, false, false]);
  const [busy, setBusy] = useState(false);
  const questions = [
    'I have been free of fever or infection for 14 days',
    'I have not consumed alcohol within 24 hours',
    'I am not currently taking antibiotics',
    'I weigh at least 50 kg',
  ];

  async function accept() {
    if (answers.some((value) => !value)) {
      return Alert.alert('Please confirm eligibility', 'All four safety checks must be confirmed before accepting.');
    }
    setBusy(true);
    try {
      await api(`/donor/assignments/${alertItem.id}/respond`, { method: 'POST', body: JSON.stringify({ response: 'ACCEPT' }) }, token);
      onDone();
    } catch (err) {
      Alert.alert('Unable to accept', err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ExpoStatusBar style="light" />
      <ScrollView contentContainerStyle={styles.screening}>
        <View style={styles.critical}>
          <Text style={styles.criticalLabel}>CRITICAL BLOOD ALERT</Text>
          <Text style={styles.criticalType}>{alertItem.request?.bloodType || 'MATCH'}</Text>
          <Text style={styles.criticalCopy}>
            Central City Medical Centre needs {alertItem.request?.unitsNeeded || 1} unit
            {(alertItem.request?.unitsNeeded || 1) > 1 ? 's' : ''} now.
          </Text>
          <View style={styles.distance}>
            <Text style={styles.distanceText}>
              about {alertItem.distanceKm} km away - tier {alertItem.tier}
            </Text>
          </View>
        </View>
        <View style={styles.screenPanel}>
          <Text style={styles.formTitle}>Quick safety check</Text>
          <Text style={styles.formSub}>Please confirm before accepting this emergency request.</Text>
          {questions.map((question, index) => (
            <Pressable
              key={question}
              style={styles.question}
              onPress={() =>
                setAnswers((current) => current.map((answer, i) => (i === index ? !answer : answer)))
              }
            >
              <View style={[styles.check, answers[index] && styles.checked]}>
                {answers[index] && <Text style={styles.checkText}>+</Text>}
              </View>
              <Text style={styles.questionText}>{question}</Text>
            </Pressable>
          ))}
          <Button
            title={busy ? 'Confirming...' : 'I am eligible - accept request'}
            onPress={accept}
            disabled={busy}
          />
          <Button title="I cannot donate now" variant="plain" onPress={onCancel} disabled={busy} />
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function Arrival({ assignment, token, refresh }) {
  const [arrived, setArrived] = useState(assignment.status === 'ARRIVED');

  async function markArrival() {
    try {
      await api(`/donor/assignments/${assignment.id}/arrive`, { method: 'POST' }, token);
      setArrived(true);
      refresh();
    } catch (err) {
      Alert.alert('Unable to update arrival', err.message);
    }
  }

  return (
    <View style={styles.arrival}>
      <View style={styles.arrivalHead}>
        <Text style={styles.arrivalTitle}>{arrived ? 'You have arrived' : 'You are on your way'}</Text>
        <Text style={styles.arrivalSub}>
          Central City Medical Centre - {assignment.distanceKm} km
        </Text>
      </View>
      {assignment.checkinToken ? (
        <View style={styles.qrBox}>
          <QRCode value={assignment.checkinToken} size={175} color="#14344c" />
          <Text style={styles.qrHint}>Show this QR pass to the blood bank officer</Text>
        </View>
      ) : (
        <Text style={styles.qrHint}>Your check-in pass appears once the hospital confirms acceptance.</Text>
      )}
      {!arrived && <Button title="I have arrived at the hospital" onPress={markArrival} />}
      <Text style={styles.caution}>
        Bring a government photo ID. Hospital staff will complete the clinical eligibility assessment.
      </Text>
    </View>
  );
}

function Home({ session, signOut, route, onRouteHandled, receiveNonce }) {
  const token = session.token;
  const [donor, setDonor] = useState(session.donor);
  const [alerts, setAlerts] = useState([]);
  const [screening, setScreening] = useState(null);

  const [realtimeNonce, setRealtimeNonce] = useState(0);
  const realtimeRef = useRef(null);
  if (!realtimeRef.current) {
    // Optional realtime "changed" hint. Fail-open: when GET /sync/config is missing or disabled,
    // start() simply reports inactive and the polling loop below remains the source of truth.
    realtimeRef.current = createRealtimeSync({
      request: (method, path) => api(path, { method }, token),
      onChanged: () => setRealtimeNonce((value) => value + 1),
      logger: { warn: (message) => console.warn(message) },
    });
  }

  const availabilityEnabled = Boolean(donor?.isAvailable);
  const {
    status,
    busy: alertingBusy,
    registerDevice,
    unregisterDevice,
    openSettings,
    refresh: refreshAlerting,
    simulateLocalAlert,
  } = useAlerting({ availabilityEnabled, registry: deviceRegistry });

  const refresh = useCallback(async () => {
    try {
      const [profile, nextAlerts] = await Promise.all([
        api('/donor/me', {}, token),
        api('/donor/alerts', {}, token),
      ]);
      if (profile) setDonor(donorView(profile));
      setAlerts(Array.isArray(nextAlerts) ? nextAlerts : []);
    } catch (err) {
      console.log(`Refresh skipped: ${err.message}`);
    }
  }, [token]);

  const syncLocation = useCallback(async () => {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') return;
      const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const updated = await api(
        '/donor/me',
        {
          method: 'PATCH',
          body: JSON.stringify({
            latitude: current.coords.latitude,
            longitude: current.coords.longitude,
          }),
        },
        token
      );
      if (updated) setDonor(donorView(updated));
    } catch (error) {
      console.log(`Location update skipped: ${error.message}`);
    }
  }, [token]);

  // Foreground polling only: it is the fallback for missed pushes and pauses in the background.
  useEffect(() => {
    let timer = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(refresh, ALERT_POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };

    refresh();
    syncLocation();
    refreshAlerting();
    registerDevice().catch(() => {});
    start();

    const subscription = AppState?.addEventListener?.('change', (next) => {
      if (next === 'active') {
        refresh();
        start();
      } else {
        stop();
      }
    });

    return () => {
      stop();
      subscription?.remove?.();
    };
  }, [refresh, syncLocation, refreshAlerting, registerDevice]);

  // Realtime is a foreground-only optimisation: no background socket, and it never replaces polling.
  useEffect(() => {
    const sync = realtimeRef.current;
    if (!sync) return undefined;
    const apply = () => {
      if (AppState?.currentState === 'active') {
        sync.start().catch(() => {});
      } else {
        sync.stop();
      }
    };
    apply();
    const subscription = AppState?.addEventListener?.('change', apply);
    return () => {
      sync.stop();
      subscription?.remove?.();
    };
  }, []);

  // A tapped notification, deep link or realtime "changed" hint requests a refresh straight away.
  useEffect(() => {
    if (receiveNonce > 0 || realtimeNonce > 0) refresh();
  }, [receiveNonce, realtimeNonce, refresh]);

  // Route the donor to the alert the notification referred to (foreground + cold start).
  useEffect(() => {
    if (!route?.assignmentId) return;
    const match = alerts.find((item) => item.id === route.assignmentId);
    if (match) {
      if (match.status === 'PINGED') setScreening(match);
      onRouteHandled?.();
    }
  }, [route, alerts, onRouteHandled]);

  async function setAvailable(value) {
    setDonor((previous) => ({ ...previous, isAvailable: value }));
    try {
      const updated = await api(
        '/donor/me',
        { method: 'PATCH', body: JSON.stringify({ isAvailable: value }) },
        token
      );
      if (updated) setDonor(donorView(updated));
      if (value) {
        await syncLocation();
        await registerDevice({ prompt: true });
      } else {
        await unregisterDevice();
      }
      await refreshAlerting();
    } catch (err) {
      Alert.alert('Unable to update availability', err.message);
      refresh();
    }
  }

  async function handleStatusAction(action) {
    if (action === 'request-permission') {
      await registerDevice({ prompt: true });
      await refreshAlerting();
      return;
    }
    if (action === 'open-settings') {
      await openSettings();
      return;
    }
    if (action === 'enable-availability') {
      if (!donor?.eligible) {
        Alert.alert(
          'Donation cooldown active',
          `You are medically eligible again from ${donor?.nextEligibleDate || 'a later date'}.`
        );
        return;
      }
      await setAvailable(true);
      return;
    }
    await registerDevice();
    await refreshAlerting();
  }

  const pending = alerts.find((item) => item.status === 'PINGED');
  const active = alerts.find((item) => ['ACCEPTED', 'ARRIVED'].includes(item.status));

  if (screening) {
    return (
      <Screening
        alertItem={screening}
        token={token}
        onDone={() => {
          setScreening(null);
          refresh();
          refreshAlerting();
        }}
        onCancel={async () => {
          try {
            await api(
              `/donor/assignments/${screening.id}/respond`,
              { method: 'POST', body: JSON.stringify({ response: 'DECLINE' }) },
              token
            );
          } catch (err) {
            Alert.alert('Unable to decline', err.message);
          }
          setScreening(null);
          refresh();
        }}
      />
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ExpoStatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.home}>
        <View style={styles.topbar}>
          <View>
            <Text style={styles.smallBrand}>PULSE DIAL</Text>
            <Text style={styles.greeting}>Hello, {(donor?.fullName || 'donor').split(' ')[0]}</Text>
          </View>
          <Pressable onPress={signOut}>
            <Text style={styles.signOut}>Sign out</Text>
          </Pressable>
        </View>

        <AlertStatusCard status={status} busy={alertingBusy} onAction={handleStatusAction} />

        {pending && (
          <Pressable style={styles.alertBanner} onPress={() => setScreening(pending)}>
            <View style={styles.flex}>
              <Text style={styles.alertEyebrow}>NEW EMERGENCY ALERT</Text>
              <Text style={styles.alertTitle}>
                {pending.request?.bloodType || 'Matched'} blood urgently needed
              </Text>
              <Text style={styles.alertText}>
                Central City Medical Centre - {pending.distanceKm} km away
              </Text>
            </View>
            <Text style={styles.alertArrow}>&gt;</Text>
          </Pressable>
        )}

        <View style={styles.profileCard}>
          <View style={styles.bloodCircle}>
            <Text style={styles.bloodText}>{donor?.bloodType || '--'}</Text>
          </View>
          <View style={styles.profileInfo}>
            <Text style={styles.profileName}>{donor?.fullName || 'Donor profile'}</Text>
            <Text style={styles.profileMeta}>
              Reliability score <Text style={styles.score}>{donor?.reliabilityScore ?? '--'}</Text>
            </Text>
            <Text style={[styles.eligibility, donor?.eligible ? styles.eligible : styles.ineligible]}>
              {donor?.eligible ? 'Eligible to donate' : 'Donation cooldown active'}
            </Text>
          </View>
        </View>

        <View style={styles.availability}>
          <View style={styles.flex}>
            <Text style={styles.availTitle}>Emergency availability</Text>
            <Text style={styles.availText}>
              {donor?.isAvailable
                ? 'You can receive nearby critical alerts.'
                : 'Alerts are paused until you enable availability.'}
            </Text>
          </View>
          <Switch
            value={Boolean(donor?.isAvailable)}
            onValueChange={setAvailable}
            trackColor={{ false: '#dce2e8', true: '#f9a3a9' }}
            thumbColor={donor?.isAvailable ? '#e93f4e' : '#fff'}
          />
        </View>

        {active ? (
          <Arrival assignment={active} token={token} refresh={() => { refresh(); refreshAlerting(); }} />
        ) : (
          <View style={styles.waiting}>
            <Text style={styles.waitingIcon}>~</Text>
            <Text style={styles.waitingTitle}>Standing by</Text>
            <Text style={styles.waitingText}>
              Keep this app installed and notifications allowed. When a matching request is raised,
              the hospital dispatch engine will contact you.
            </Text>
          </View>
        )}

        <View style={styles.notes}>
          <Text style={styles.sectionTitle}>How alerts reach you</Text>
          <Text style={styles.noteText}>
            Alerts are normal high-priority notifications. On Android they can appear as a heads-up
            banner above other apps when notification permission is granted, the alert channel is set
            to high importance and the device is not in Do Not Disturb or silent mode.
          </Text>
          <Text style={styles.noteText}>
            {status.capabilities.fullScreenIntent
              ? ''
              : 'This app never takes over your screen, never requests the overlay permission and never pretends to be a phone call or alarm.'}
          </Text>
          <Text style={styles.noteText}>
            Delivery is best-effort: OEM battery savers, airplane mode, force-stop and OS notification
            limits can suppress or delay an alert. The in-app list remains the source of truth.
          </Text>
        </View>

        {LOCAL_ALERT_SIMULATOR_ENABLED ? (
          <Pressable
            style={styles.simulatorButton}
            onPress={async () => {
              const result = await simulateLocalAlert({});
              Alert.alert(
                result.ok ? 'Test alert scheduled' : 'Test alert unavailable',
                result.ok
                  ? 'A local notification will appear in about a second. No server was contacted.'
                  : String(result.reason)
              );
            }}
          >
            <Text style={styles.simulatorButtonText}>Send local test alert (development only)</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

async function unregisterInstallation() {
  const installationId = await AlertNotifications.getInstallationId();
  return deviceRegistry.unregister({ installationId });
}

export default function App() {
  const [session, setSession] = useState(null);
  const [restoring, setRestoring] = useState(true);
  const [route, setRoute] = useState(null);
  const [receiveNonce, setReceiveNonce] = useState(0);

  const applyRoute = useCallback((nextRoute) => {
    if (!nextRoute) return;
    setRoute({ ...nextRoute, nonce: Date.now() });
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      await loadApiUrl();
      await loadDonorPhone();
      const restored = await loadSession();
      if (!mounted) return;
      if (restored.session) {
        activeToken = restored.session.token;
        setSession({ ...restored.session, donor: donorView(restored.session.donor) });
      }
      setRestoring(false);
      deviceRegistry.flush().catch(() => {});
    })();
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const listeners = AlertNotifications.addListeners({
      onReceive: (notification) => {
        setReceiveNonce((value) => value + 1);
        applyRoute(resolveAlertRoute(notification?.request?.content?.data));
      },
      onResponse: (response) => {
        applyRoute(resolveAlertRoute(response?.notification?.request?.content?.data));
        AlertNotifications.clearInitialResponse();
      },
      onDropped: () => {
        console.warn('Push service dropped messages; falling back to in-app polling.');
      },
    });
    const urlListener = AlertNotifications.addUrlListener((url) => applyRoute(parseDeepLink(url)));

    let cancelled = false;
    (async () => {
      const initial = await AlertNotifications.getInitialResponse();
      if (!cancelled && initial) {
        applyRoute(resolveAlertRoute(initial?.notification?.request?.content?.data));
        await AlertNotifications.clearInitialResponse();
      }
      const initialUrl = await AlertNotifications.getInitialUrl();
      if (!cancelled && initialUrl) applyRoute(parseDeepLink(initialUrl));
    })();

    return () => {
      cancelled = true;
      listeners.remove();
      urlListener.remove();
    };
  }, [applyRoute]);

  const signedIn = useCallback(async (nextSession) => {
    activeToken = nextSession?.token || null;
    const persisted = await saveSession(nextSession);
    if (!persisted) {
      Alert.alert(
        'Secure storage unavailable',
        'You are signed in for this session only. Alerts while the app is closed may not reach this device.'
      );
    }
    setSession({ ...nextSession, donor: donorView(nextSession.donor) });
  }, []);

  const signOut = useCallback(async () => {
    try {
      await unregisterInstallation();
    } catch (_) {
      // Best effort: a queued unregister is retried on the next launch.
    }
    activeToken = null;
    await clearSession();
    setRoute(null);
    setSession(null);
  }, []);

  if (restoring) {
    return (
      <SafeAreaView style={styles.loading}>
        <ActivityIndicator size="large" color="#e94250" />
        <Text style={styles.loadingText}>Preparing Pulse Dial...</Text>
      </SafeAreaView>
    );
  }

  return session ? (
    <Home
      session={session}
      signOut={signOut}
      route={route}
      onRouteHandled={() => setRoute(null)}
      receiveNonce={receiveNonce}
    />
  ) : (
    <SignIn onSignedIn={signedIn} />
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: '#f5f7fa' },
  flex: { flex: 1 },
  loading: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#f5f7fa' },
  loadingText: { marginTop: 14, color: '#566f82', fontWeight: '700' },
  signTop: { backgroundColor: '#12364e', padding: 34, paddingTop: 56, paddingBottom: 48 },
  cross: { width: 42, height: 42, borderRadius: 13, backgroundColor: '#ec4250', alignItems: 'center', justifyContent: 'center' },
  crossText: { color: '#fff', fontSize: 28, fontWeight: '800' },
  brand: { fontWeight: '800', letterSpacing: 1.3, color: '#fff', marginTop: 16 },
  signTitle: { fontSize: 31, fontWeight: '800', color: '#fff', marginTop: 26 },
  signText: { color: '#cbdbe5', fontSize: 15, lineHeight: 23, marginTop: 10 },
  warningBadge: { marginTop: 14, backgroundColor: '#7a2c33', borderRadius: 10, padding: 10 },
  warningBadgeText: { color: '#ffe3e6', fontSize: 11, fontWeight: '700', lineHeight: 16 },
  signForm: { backgroundColor: '#fff', marginTop: -20, borderTopLeftRadius: 24, borderTopRightRadius: 24, padding: 26, flex: 1 },
  formTitle: { fontSize: 21, fontWeight: '800', color: '#17354c' },
  formSub: { fontSize: 13, color: '#718195', lineHeight: 20, marginTop: 5, marginBottom: 22 },
  label: { fontSize: 12, fontWeight: '700', color: '#4d5d70', marginTop: 13, marginBottom: 7 },
  input: { borderWidth: 1, borderColor: '#dce3ea', borderRadius: 9, padding: 12, color: '#22364a', fontSize: 15 },
  hint: { fontSize: 11, color: '#dc3e4c', marginTop: 5 },
  notice: { fontSize: 12, color: '#278555', fontWeight: '700', marginTop: 8 },
  registration: { borderTopWidth: 1, borderColor: '#e7ebef', marginTop: 22, paddingTop: 4 },
  registrationTitle: { fontSize: 15, fontWeight: '800', color: '#23445b', marginTop: 15 },
  typeRow: { gap: 7, paddingVertical: 3 },
  typeChip: { borderWidth: 1, borderColor: '#dce3ea', borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10 },
  typeSelected: { backgroundColor: '#e94250', borderColor: '#e94250' },
  typeText: { fontWeight: '800', color: '#526174' },
  typeTextSelected: { color: '#fff' },
  sexRow: { flexDirection: 'row', gap: 7 },
  sexChip: { borderWidth: 1, borderColor: '#dce3ea', borderRadius: 8, paddingVertical: 9, paddingHorizontal: 10 },
  sexSelected: { backgroundColor: '#eaf4f8', borderColor: '#4b93b4' },
  sexText: { fontSize: 11, fontWeight: '700', color: '#596b7b' },
  sexTextSelected: { color: '#286985' },
  consent: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginTop: 17 },
  consentText: { flex: 1, fontSize: 12, color: '#5c6f80', lineHeight: 18 },
  check: { width: 20, height: 20, borderRadius: 5, borderWidth: 1.5, borderColor: '#c3ced8', alignItems: 'center', justifyContent: 'center' },
  checked: { backgroundColor: '#e94250', borderColor: '#e94250' },
  checkText: { color: '#fff', fontSize: 13, fontWeight: '800' },
  error: { marginTop: 14, color: '#c62f3d', fontSize: 13, fontWeight: '700' },
  button: { borderRadius: 10, paddingVertical: 14, alignItems: 'center', marginTop: 14 },
  primary: { backgroundColor: '#e94250' },
  outline: { backgroundColor: '#fff', borderWidth: 1.5, borderColor: '#e94250' },
  plain: { backgroundColor: 'transparent' },
  disabled: { opacity: 0.55 },
  buttonText: { color: '#fff', fontWeight: '800', fontSize: 15 },
  darkButtonText: { color: '#c62f3d' },
  privacy: { fontSize: 11, color: '#8b98a5', lineHeight: 17, marginTop: 20 },
  configToggle: { marginTop: 16, alignItems: 'center' },
  configToggleText: { fontSize: 12, color: '#4a6d88', fontWeight: '700' },
  configPanel: { marginTop: 12, padding: 14, backgroundColor: '#f0f4f8', borderRadius: 10 },
  configTitle: { fontSize: 12, fontWeight: '700', color: '#273b4e', marginBottom: 6 },
  configInput: { backgroundColor: '#fff' },
  configButtons: { flexDirection: 'row', gap: 8, marginTop: 2 },
  statusCard: { borderRadius: 14, padding: 16, marginBottom: 16, borderWidth: 1 },
  statusOk: { backgroundColor: '#eafaf1', borderColor: '#9fd9b8' },
  statusWarn: { backgroundColor: '#fff8e8', borderColor: '#f0cf8a' },
  statusBlocked: { backgroundColor: '#fdecee', borderColor: '#f0a9b1' },
  statusTitle: { fontSize: 15, fontWeight: '800', color: '#1d3c4f' },
  statusDetail: { fontSize: 12, color: '#4f6272', lineHeight: 18, marginTop: 5 },
  statusActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 12 },
  statusAction: { backgroundColor: '#12364e', borderRadius: 8, paddingVertical: 9, paddingHorizontal: 12 },
  statusActionText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  home: { padding: 20, paddingTop: 30, paddingBottom: 48 },
  topbar: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 18 },
  smallBrand: { fontSize: 12, fontWeight: '800', letterSpacing: 1, color: '#e94250' },
  greeting: { fontSize: 20, fontWeight: '800', color: '#17354c', marginTop: 4 },
  signOut: { fontSize: 12, fontWeight: '700', color: '#4a6d88', paddingTop: 4 },
  alertBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#12364e', borderRadius: 14, padding: 16, marginBottom: 16, gap: 10 },
  alertEyebrow: { color: '#f7a6ad', fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  alertTitle: { color: '#fff', fontSize: 17, fontWeight: '800', marginTop: 4 },
  alertText: { color: '#cbdbe5', fontSize: 12, marginTop: 3 },
  alertArrow: { color: '#fff', fontSize: 22, fontWeight: '800' },
  profileCard: { flexDirection: 'row', alignItems: 'center', gap: 14, backgroundColor: '#fff', borderRadius: 14, padding: 16 },
  bloodCircle: { width: 58, height: 58, borderRadius: 29, backgroundColor: '#e94250', alignItems: 'center', justifyContent: 'center' },
  bloodText: { color: '#fff', fontWeight: '800', fontSize: 18 },
  profileInfo: { flex: 1 },
  profileName: { fontSize: 16, fontWeight: '800', color: '#1d3c4f' },
  profileMeta: { fontSize: 12, color: '#6c7f90', marginTop: 3 },
  score: { fontWeight: '800', color: '#2f7d55' },
  eligibility: { fontSize: 11, fontWeight: '800', marginTop: 5 },
  eligible: { color: '#2f7d55' },
  ineligible: { color: '#b4791d' },
  availability: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: '#fff', borderRadius: 14, padding: 16, marginTop: 14 },
  availTitle: { fontSize: 14, fontWeight: '800', color: '#1d3c4f' },
  availText: { fontSize: 12, color: '#6c7f90', marginTop: 3, lineHeight: 17 },
  waiting: { backgroundColor: '#fff', borderRadius: 14, padding: 22, marginTop: 14, alignItems: 'center' },
  waitingIcon: { fontSize: 26, color: '#9fb2c1', fontWeight: '800' },
  waitingTitle: { fontSize: 16, fontWeight: '800', color: '#1d3c4f', marginTop: 6 },
  waitingText: { fontSize: 12, color: '#6c7f90', lineHeight: 18, marginTop: 6, textAlign: 'center' },
  notes: { backgroundColor: '#eef3f7', borderRadius: 14, padding: 16, marginTop: 14 },
  sectionTitle: { fontSize: 13, fontWeight: '800', color: '#1d3c4f', marginBottom: 6 },
  noteText: { fontSize: 11.5, color: '#57697a', lineHeight: 17, marginBottom: 8 },
  simulatorButton: { borderWidth: 1.5, borderColor: '#4a6d88', borderRadius: 10, paddingVertical: 12, alignItems: 'center', marginTop: 14 },
  simulatorButtonText: { color: '#325a76', fontWeight: '800', fontSize: 12 },
  screening: { padding: 22, paddingTop: 40 },
  critical: { backgroundColor: '#12364e', borderRadius: 18, padding: 22, alignItems: 'center' },
  criticalLabel: { color: '#f7a6ad', fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },
  criticalType: { color: '#fff', fontSize: 46, fontWeight: '800', marginTop: 8 },
  criticalCopy: { color: '#cbdbe5', fontSize: 13, textAlign: 'center', marginTop: 8 },
  distance: { marginTop: 12, backgroundColor: '#1d4a66', borderRadius: 20, paddingVertical: 6, paddingHorizontal: 14 },
  distanceText: { color: '#e6f0f6', fontSize: 11, fontWeight: '800' },
  screenPanel: { backgroundColor: '#fff', borderRadius: 18, padding: 22, marginTop: 16 },
  question: { flexDirection: 'row', gap: 10, alignItems: 'flex-start', marginBottom: 14 },
  questionText: { flex: 1, fontSize: 13, color: '#40566a', lineHeight: 19 },
  arrival: { backgroundColor: '#fff', borderRadius: 14, padding: 20, marginTop: 14, alignItems: 'center' },
  arrivalHead: { alignItems: 'center', marginBottom: 14 },
  arrivalTitle: { fontSize: 17, fontWeight: '800', color: '#1d3c4f' },
  arrivalSub: { fontSize: 12, color: '#6c7f90', marginTop: 4 },
  qrBox: { alignItems: 'center', padding: 14, backgroundColor: '#f7fafc', borderRadius: 12, marginBottom: 12 },
  qrHint: { fontSize: 11, color: '#6c7f90', marginTop: 8, textAlign: 'center' },
  caution: { fontSize: 11, color: '#8b98a5', lineHeight: 17, marginTop: 12, textAlign: 'center' },
});
