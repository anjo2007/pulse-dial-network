import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Animated,
  AppState,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  Vibration,
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
import {
  signInOrCreateDonor,
  updateDonorProfile,
  updateDonorLocation,
  subscribeDonorAssignments,
  respondAssignment,
  markAssignmentArrived,
  db,
} from './src/services/firebase.js';
import { doc, getDoc } from 'firebase/firestore';
import { OverlayService } from './src/services/overlayPermission.js';

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

function DatePickerModal({ visible, value, onClose, onSelect, title = 'Select Date' }) {
  const parseVal = (str) => {
    if (!str || str === 'Never Donated') {
      const d = new Date();
      return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
    }
    const parts = String(str).split('-');
    if (parts.length === 3) {
      const y = parseInt(parts[0], 10) || 2026;
      const m = parseInt(parts[1], 10) || 1;
      const d = parseInt(parts[2], 10) || 1;
      return { y, m, d };
    }
    const d = new Date();
    return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
  };

  const initial = parseVal(value);
  const [year, setYear] = useState(initial.y);
  const [month, setMonth] = useState(initial.m);
  const [day, setDay] = useState(initial.d);

  useEffect(() => {
    if (visible) {
      const p = parseVal(value);
      setYear(p.y);
      setMonth(p.m);
      setDay(p.d);
    }
  }, [visible, value]);

  const pad = (n) => String(n).padStart(2, '0');
  const formatIso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

  const setPreset = (offsetMonths) => {
    if (offsetMonths === null) {
      onSelect('Never Donated');
      onClose();
      return;
    }
    const d = new Date();
    d.setMonth(d.getMonth() - offsetMonths);
    onSelect(formatIso(d.getFullYear(), d.getMonth() + 1, d.getDate()));
    onClose();
  };

  const applyCustom = () => {
    onSelect(formatIso(year, month, day));
    onClose();
  };

  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.pickerBackdrop}>
        <View style={styles.pickerCard}>
          <Text style={styles.pickerTitle}>{title}</Text>
          <Text style={styles.pickerSub}>Quick selection or customize below</Text>

          <View style={styles.presetRow}>
            <Pressable style={styles.presetBtn} onPress={() => setPreset(null)}>
              <Text style={styles.presetBtnText}>Never</Text>
            </Pressable>
            <Pressable style={styles.presetBtn} onPress={() => setPreset(0)}>
              <Text style={styles.presetBtnText}>Today</Text>
            </Pressable>
            <Pressable style={styles.presetBtn} onPress={() => setPreset(3)}>
              <Text style={styles.presetBtnText}>3 Mo Ago</Text>
            </Pressable>
            <Pressable style={styles.presetBtn} onPress={() => setPreset(6)}>
              <Text style={styles.presetBtnText}>6 Mo Ago</Text>
            </Pressable>
          </View>

          <View style={styles.stepperContainer}>
            <View style={styles.stepperCol}>
              <Text style={styles.stepperLabel}>Day</Text>
              <View style={styles.stepperRow}>
                <Pressable onPress={() => setDay((d) => Math.max(1, d - 1))} style={styles.stepBtn}>
                  <Text style={styles.stepBtnText}>-</Text>
                </Pressable>
                <Text style={styles.stepVal}>{pad(day)}</Text>
                <Pressable onPress={() => setDay((d) => Math.min(31, d + 1))} style={styles.stepBtn}>
                  <Text style={styles.stepBtnText}>+</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.stepperCol}>
              <Text style={styles.stepperLabel}>Month</Text>
              <View style={styles.stepperRow}>
                <Pressable onPress={() => setMonth((m) => Math.max(1, m - 1))} style={styles.stepBtn}>
                  <Text style={styles.stepBtnText}>-</Text>
                </Pressable>
                <Text style={styles.stepVal}>{months[month - 1]}</Text>
                <Pressable onPress={() => setMonth((m) => Math.min(12, m + 1))} style={styles.stepBtn}>
                  <Text style={styles.stepBtnText}>+</Text>
                </Pressable>
              </View>
            </View>

            <View style={styles.stepperCol}>
              <Text style={styles.stepperLabel}>Year</Text>
              <View style={styles.stepperRow}>
                <Pressable onPress={() => setYear((y) => Math.max(1950, y - 1))} style={styles.stepBtn}>
                  <Text style={styles.stepBtnText}>-</Text>
                </Pressable>
                <Text style={styles.stepVal}>{year}</Text>
                <Pressable onPress={() => setYear((y) => Math.min(2030, y + 1))} style={styles.stepBtn}>
                  <Text style={styles.stepBtnText}>+</Text>
                </Pressable>
              </View>
            </View>
          </View>

          <View style={styles.pickerActions}>
            <Pressable onPress={onClose} style={[styles.pickerBtn, styles.pickerCancel]}>
              <Text style={styles.pickerCancelText}>Cancel</Text>
            </Pressable>
            <Pressable onPress={applyCustom} style={[styles.pickerBtn, styles.pickerApply]}>
              <Text style={styles.pickerApplyText}>Confirm Date</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

function DatePickerField({ label, value, onChange, placeholder = 'Select date' }) {
  const [open, setOpen] = useState(false);
  return (
    <View style={{ marginBottom: 14 }}>
      <Text style={styles.label}>{label}</Text>
      <Pressable onPress={() => setOpen(true)} style={styles.datePickerInput}>
        <Text style={value ? styles.datePickerValueText : styles.datePickerPlaceholderText}>
          {value || placeholder}
        </Text>
        <Text style={styles.datePickerIcon}>📅</Text>
      </Pressable>
      <DatePickerModal
        visible={open}
        value={value}
        title={label}
        onClose={() => setOpen(false)}
        onSelect={(val) => {
          onChange(val);
          setOpen(false);
        }}
      />
    </View>
  );
}

function EditProfileModal({ visible, donor, onClose, onSave, onSaved }) {
  const [name, setName] = useState(donor?.fullName || donor?.name || '');
  const [bloodType, setBloodType] = useState(donor?.bloodType || 'O-');
  const [weightKg, setWeightKg] = useState(String(donor?.weightKg || '68'));
  const [age, setAge] = useState(String(donor?.age || '26'));
  const [lastDonationDate, setLastDonationDate] = useState(donor?.lastDonationDate || 'Never Donated');
  const [medications, setMedications] = useState(donor?.medications || 'None');
  const [diseases, setDiseases] = useState(donor?.diseases || 'None');
  const [isAvailable, setIsAvailable] = useState(donor?.isAvailable ?? true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (visible && donor) {
      setName(donor.fullName || donor.name || '');
      setBloodType(donor.bloodType || 'O-');
      setWeightKg(String(donor.weightKg || '68'));
      setAge(String(donor.age || '26'));
      setLastDonationDate(donor.lastDonationDate || 'Never Donated');
      setMedications(donor.medications || 'None');
      setDiseases(donor.diseases || 'None');
      setIsAvailable(donor.isAvailable ?? true);
    }
  }, [visible, donor]);

  async function handleSave() {
    if (!name.trim()) return Alert.alert('Required', 'Please enter your full name.');
    setSaving(true);
    try {
      const updates = {
        fullName: name.trim(),
        bloodType,
        weightKg: Number(weightKg) || 68,
        age: Number(age) || 26,
        lastDonationDate,
        medications: medications.trim() || 'None',
        diseases: diseases.trim() || 'None',
        isAvailable,
      };
      if (donor?.id) {
        await updateDonorProfile(donor.id, updates).catch((e) => console.warn('Firestore profile update error:', e));
      }
      if (onSave) await onSave(updates);
      if (onSaved) await onSaved(updates);
      onClose();
    } catch (err) {
      Alert.alert('Save Failed', err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={styles.safe}>
        <ExpoStatusBar style="dark" />
        <ScrollView contentContainerStyle={styles.editProfileContainer}>
          <View style={styles.editHeader}>
            <Text style={styles.editTitle}>✏️ Edit Donor Profile</Text>
            <Text style={styles.editSub}>Update your medical details and availability</Text>
          </View>

          <Text style={styles.label}>Full Legal Name</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="Your full name" />

          <Text style={styles.label}>Blood Group</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.typeRow}>
            {bloodTypes.map((type) => (
              <Pressable
                key={type}
                onPress={() => setBloodType(type)}
                style={[styles.typeChip, bloodType === type && styles.typeSelected]}
              >
                <Text style={[styles.typeText, bloodType === type && styles.typeTextSelected]}>{type}</Text>
              </Pressable>
            ))}
          </ScrollView>

          <View style={{ flexDirection: 'row', gap: 12 }}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Weight (kg)</Text>
              <TextInput style={styles.input} value={weightKg} onChangeText={setWeightKg} keyboardType="numeric" placeholder="68" />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>Age</Text>
              <TextInput style={styles.input} value={age} onChangeText={setAge} keyboardType="numeric" placeholder="26" />
            </View>
          </View>

          <DatePickerField label="Last Whole-Blood Donation" value={lastDonationDate} onChange={setLastDonationDate} />

          <Text style={styles.label}>Current Medications</Text>
          <TextInput style={styles.input} value={medications} onChangeText={setMedications} placeholder="None, or list medications" />

          <Text style={styles.label}>Medical Conditions / Infections</Text>
          <TextInput style={styles.input} value={diseases} onChangeText={setDiseases} placeholder="None, or specify" />

          <View style={[styles.availabilityRow, { marginVertical: 12 }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.availabilityTitle}>Available for Alerts</Text>
              <Text style={styles.availabilitySub}>Turn off temporarily if travelling or unwell</Text>
            </View>
            <Switch
              value={isAvailable}
              onValueChange={setIsAvailable}
              trackColor={{ false: '#dce2e8', true: '#f9a3a9' }}
              thumbColor={isAvailable ? '#e93f4e' : '#fff'}
            />
          </View>

          <View style={{ marginTop: 20, gap: 10 }}>
            <Button title={saving ? 'Saving...' : 'Save Profile Changes'} onPress={handleSave} disabled={saving} />
            <Button title="Cancel" variant="plain" onPress={onClose} disabled={saving} />
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

function OverlayPermissionModal({ visible, onClose, onOpenSettings }) {
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.pickerBackdrop}>
        <View style={styles.overlayModalCard}>
          <View style={styles.overlayIconCircle}>
            <Text style={{ fontSize: 32 }}>📲</Text>
          </View>
          <Text style={styles.overlayModalTitle}>Enable "Display Over Other Apps"</Text>
          <Text style={styles.overlayModalSubtitle}>
            Required for incoming emergency blood dispatch calls to hover and pop up while you are using other apps or when the screen is locked.
          </Text>

          <View style={styles.overlayStepsContainer}>
            <Text style={styles.overlayStepTitle}>Follow these quick steps:</Text>
            <Text style={styles.overlayStepText}>
              1. Tap <Text style={{ fontWeight: 'bold' }}>"Open Settings"</Text> below
            </Text>
            <Text style={styles.overlayStepText}>
              2. Find and select <Text style={{ fontWeight: 'bold' }}>Pulse Dial</Text> in the list
            </Text>
            <Text style={styles.overlayStepText}>
              3. Switch <Text style={{ fontWeight: 'bold' }}>"Allow display over other apps"</Text> to <Text style={{ color: '#2e7d32', fontWeight: 'bold' }}>ON</Text>
            </Text>
            <Text style={styles.overlayStepText}>
              4. Tap Back to return to Pulse Dial
            </Text>
          </View>

          <View style={{ gap: 10, marginTop: 18, width: '100%' }}>
            <Button
              title="Open Settings →"
              onPress={() => {
                onOpenSettings();
                onClose();
              }}
            />
            <Button title="Remind Me Later" variant="plain" onPress={onClose} />
          </View>
        </View>
      </View>
    </Modal>
  );
}

function SignIn({ onSignedIn }) {
  const [phone, setPhone] = useState('');
  const [name, setName] = useState('');
  const [bloodType, setBloodType] = useState('O-');
  const [dateOfBirth, setDateOfBirth] = useState('1998-05-12');
  const [weightKg, setWeightKg] = useState('68');
  const [lastDonationDate, setLastDonationDate] = useState('Never Donated');
  const [sex, setSex] = useState('UNSPECIFIED');
  const [consentAccepted, setConsentAccepted] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function fillPreset(pPhone, pName, pBlood) {
    setPhone(pPhone);
    setName(pName);
    setBloodType(pBlood);
    setError('');
  }

  async function submit() {
    const cleanPhone = phone.trim();
    if (!cleanPhone || cleanPhone.length < 6) {
      return setError('Please enter a valid mobile number.');
    }
    if (!consentAccepted) {
      return setError('Consent to emergency-alert matching is required before continuing.');
    }
    setBusy(true);
    setError('');
    try {
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced }).catch(() => null);
      const loc = pos?.coords ? { latitude: pos.coords.latitude, longitude: pos.coords.longitude } : null;

      const session = await signInOrCreateDonor({
        phone: cleanPhone,
        fullName: name.trim() || 'Volunteer Donor',
        bloodType,
        weightKg: Number(weightKg) || 68,
        age: 26,
        lastDonationDate: lastDonationDate || 'Never Donated',
        location: loc,
      });

      await saveDonorPhone(cleanPhone);
      await saveSession(session);
      activeToken = session.token;
      await onSignedIn(session);
    } catch (err) {
      setError(err.message || 'Sign in failed. Check your network connection.');
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
        </View>

        <View style={styles.signForm}>
          <Text style={styles.formTitle}>Instant Donor Sign-In</Text>
          <Text style={styles.formSub}>
            Direct Firebase authentication without SMS OTP delay. Enter your details to start.
          </Text>

          <Text style={styles.label}>Quick donor profiles</Text>
          <View style={[styles.typeRow, { marginBottom: 16 }]}>
            <Pressable
              style={styles.typeChip}
              onPress={() => fillPreset('+91-9900000001', 'Arjun Menon', 'O-')}
            >
              <Text style={styles.typeText}>Arjun (O-)</Text>
            </Pressable>
            <Pressable
              style={styles.typeChip}
              onPress={() => fillPreset('+91-9988776655', 'Dr. Preethi Nair', 'O+')}
            >
              <Text style={styles.typeText}>Preethi (O+)</Text>
            </Pressable>
            <Pressable
              style={styles.typeChip}
              onPress={() => fillPreset('+91-8714743183', 'Anjo M J', 'O-')}
            >
              <Text style={styles.typeText}>Anjo (O-)</Text>
            </Pressable>
          </View>

          <Text style={styles.label}>Mobile number *</Text>
          <TextInput
            value={phone}
            onChangeText={setPhone}
            style={styles.input}
            keyboardType="phone-pad"
            placeholder="+91 90000 00000"
            autoCapitalize="none"
          />

          <View style={styles.registration}>
            <Text style={styles.registrationTitle}>Donor details</Text>
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

            <DatePickerField
              label="Date of birth"
              value={dateOfBirth}
              onChange={setDateOfBirth}
              placeholder="Select birth date"
            />

            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Weight (kg)</Text>
                <TextInput
                  value={weightKg}
                  onChangeText={setWeightKg}
                  style={styles.input}
                  placeholder="68"
                  keyboardType="numeric"
                />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Sex</Text>
                <View style={[styles.sexRow, { marginTop: 4 }]}>
                  {['FEMALE', 'MALE'].map((value) => (
                    <Pressable
                      key={value}
                      onPress={() => setSex(value)}
                      style={[styles.sexChip, sex === value && styles.sexSelected]}
                    >
                      <Text style={[styles.sexText, sex === value && styles.sexTextSelected]}>
                        {value === 'FEMALE' ? 'F' : 'M'}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              </View>
            </View>

            <DatePickerField
              label="Last whole-blood donation"
              value={lastDonationDate}
              onChange={setLastDonationDate}
              placeholder="Select date or Never Donated"
            />

            <Pressable style={styles.consent} onPress={() => setConsentAccepted((value) => !value)}>
              <View style={[styles.check, consentAccepted && styles.checked]}>
                {consentAccepted && <Text style={styles.checkText}>✓</Text>}
              </View>
              <Text style={styles.consentText}>
                I confirm these details are accurate and consent to emergency blood matching.
              </Text>
            </Pressable>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button
            title={busy ? 'Connecting to network...' : 'Continue as donor →'}
            onPress={submit}
            disabled={busy}
          />
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

function IncomingCallAlert({ alertItem, onAccept, onDecline }) {
  const pulseAnim = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!alertItem) return undefined;
    const pattern = [0, 500, 200, 500, 200, 500];
    try {
      Vibration.vibrate(pattern, true);
    } catch (_) {}

    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.14,
          duration: 550,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 550,
          useNativeDriver: true,
        }),
      ])
    );
    pulse.start();

    return () => {
      pulse.stop();
      try {
        Vibration.cancel();
      } catch (_) {}
    };
  }, [alertItem, pulseAnim]);

  if (!alertItem) return null;

  const bloodType = alertItem.request?.bloodType || alertItem.donorBloodType || 'MATCH';
  const hospital = alertItem.request?.hospitalName || 'Central City Medical Centre';
  const units = alertItem.request?.unitsNeeded || 1;
  const distance = alertItem.distanceKm ?? '0.8';

  return (
    <Modal visible={Boolean(alertItem)} animationType="slide" transparent={false} statusBarTranslucent>
      <View style={styles.callShell}>
        <ExpoStatusBar style="light" />
        <View style={styles.callTop}>
          <Animated.View style={[styles.callBeacon, { transform: [{ scale: pulseAnim }] }]}>
            <Text style={styles.callBeaconIcon}>🚨</Text>
          </Animated.View>
          <Text style={styles.callBadge}>CRITICAL EMERGENCY DISPATCH</Text>
          <Text style={styles.callLive}>Incoming Alert • Live Response Requested</Text>
        </View>

        <View style={styles.callCenter}>
          <Animated.View style={[styles.callRadarCircle, { transform: [{ scale: pulseAnim }] }]}>
            <View style={styles.callBloodCircle}>
              <Text style={styles.callBloodType}>{bloodType}</Text>
              <Text style={styles.callBloodSub}>CRITICAL</Text>
            </View>
          </Animated.View>

          <Text style={styles.callHospital}>{hospital}</Text>
          <View style={styles.callMetaRow}>
            <View style={styles.callMetaPill}>
              <Text style={styles.callMetaText}>📍 {distance} km away</Text>
            </View>
            <View style={styles.callMetaPill}>
              <Text style={styles.callMetaText}>🩸 {units} unit{units > 1 ? 's' : ''} needed</Text>
            </View>
          </View>
          <Text style={styles.callUrgentCopy}>
            Urgent whole-blood transfusion needed immediately. Your blood group is an exact match.
          </Text>
        </View>

        <View style={styles.callBottom}>
          <Pressable
            style={styles.callAcceptButton}
            onPress={() => {
              try {
                Vibration.cancel();
              } catch (_) {}
              onAccept();
            }}
          >
            <Text style={styles.callAcceptIcon}>✓</Text>
            <Text style={styles.callAcceptText}>ACCEPT EMERGENCY</Text>
            <Text style={styles.callAcceptSub}>I can donate now</Text>
          </Pressable>

          <Pressable
            style={styles.callDeclineButton}
            onPress={() => {
              try {
                Vibration.cancel();
              } catch (_) {}
              onDecline();
            }}
          >
            <Text style={styles.callDeclineText}>Decline / Not Available</Text>
          </Pressable>
        </View>
      </View>
    </Modal>
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
      if (token?.startsWith('firebase.') || !token) {
        await respondAssignment(alertItem.id, 'ACCEPT');
      } else {
        await api(`/donor/assignments/${alertItem.id}/respond`, { method: 'POST', body: JSON.stringify({ response: 'ACCEPT' }) }, token);
      }
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
      if (token?.startsWith('firebase.') || !token) {
        await markAssignmentArrived(assignment.id);
      } else {
        await api(`/donor/assignments/${assignment.id}/arrive`, { method: 'POST' }, token);
      }
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
  const [incomingCallAlert, setIncomingCallAlert] = useState(null);
  const [dismissedAlertIds, setDismissedAlertIds] = useState(() => new Set());
  const [editProfileOpen, setEditProfileOpen] = useState(false);
  const [hasOverlayPermission, setHasOverlayPermission] = useState(true);
  const [showOverlayGuide, setShowOverlayGuide] = useState(false);

  const checkOverlay = useCallback(async () => {
    try {
      const granted = await OverlayService.canDrawOverlays();
      setHasOverlayPermission(granted);
      return granted;
    } catch (_) {
      return true;
    }
  }, []);

  useEffect(() => {
    (async () => {
      const granted = await checkOverlay();
      if (!granted) {
        setShowOverlayGuide(true);
      }
    })();
  }, [checkOverlay]);

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
      if (token?.startsWith('firebase.') || !token) {
        if (donor?.id) {
          const snap = await getDoc(doc(db, 'donors', donor.id));
          if (snap.exists()) {
            const data = snap.data();
            setDonor((prev) => ({ ...prev, ...data, fullName: data.full_name || prev.fullName }));
          }
        }
        return;
      }
      const [profile, nextAlerts] = await Promise.all([
        api('/donor/me', {}, token),
        api('/donor/alerts', {}, token),
      ]);
      if (profile) setDonor(donorView(profile));
      setAlerts(Array.isArray(nextAlerts) ? nextAlerts : []);
    } catch (err) {
      console.log(`Refresh skipped: ${err.message}`);
    }
  }, [token, donor?.id]);

  // Real-time Firestore sync for incoming emergency assignments
  useEffect(() => {
    if (!donor?.id && !donor?.phone) return undefined;
    const unsubscribe = subscribeDonorAssignments(donor, (firebaseAlerts) => {
      if (Array.isArray(firebaseAlerts)) {
        setAlerts((prev) => {
          const map = new Map();
          firebaseAlerts.forEach((a) => map.set(a.id, a));
          return Array.from(map.values());
        });
      }
    });
    return () => {
      unsubscribe?.();
    };
  }, [donor?.id, donor?.phone]);

  // Real-time high-accuracy GPS tracking when responding or en-route to an emergency
  useEffect(() => {
    const activeAssignment = alerts.find((item) => ['ACCEPTED', 'ARRIVED'].includes(item.status));
    if (!activeAssignment || !donor?.id) return undefined;
    let locationSub = null;
    let cancelled = false;
    (async () => {
      try {
        const { status: permStatus } = await Location.requestForegroundPermissionsAsync();
        if (permStatus !== 'granted' || cancelled) return;
        locationSub = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: 4000,
            distanceInterval: 10,
          },
          (loc) => {
            if (loc?.coords && !cancelled) {
              updateDonorLocation(donor.id, loc.coords.latitude, loc.coords.longitude).catch(() => {});
            }
          }
        );
      } catch (err) {
        console.warn('GPS tracking error:', err);
      }
    })();
    return () => {
      cancelled = true;
      locationSub?.remove?.();
    };
  }, [alerts, donor?.id]);

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
        checkOverlay();
        start();
      } else {
        stop();
      }
    });

    return () => {
      stop();
      subscription?.remove?.();
    };
  }, [refresh, syncLocation, refreshAlerting, registerDevice, checkOverlay]);

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

  // When a pending dispatch arrives, automatically launch the incoming emergency call alert and bring app to front
  useEffect(() => {
    const pendingAlert = alerts.find((item) => item.status === 'PINGED');
    if (pendingAlert && !dismissedAlertIds.has(pendingAlert.id) && !screening && !incomingCallAlert) {
      setIncomingCallAlert(pendingAlert);
      OverlayService.bringAppToForeground().catch(() => {});
    }
  }, [alerts, dismissedAlertIds, screening, incomingCallAlert]);

  // Route the donor to the alert the notification referred to (foreground + cold start).
  useEffect(() => {
    if (!route?.assignmentId) return;
    const match = alerts.find((item) => item.id === route.assignmentId);
    if (match) {
      if (match.status === 'PINGED') {
        setIncomingCallAlert(match);
      }
      onRouteHandled?.();
    }
  }, [route, alerts, onRouteHandled]);

  function handleAcceptCall(item) {
    setIncomingCallAlert(null);
    if (item?.isSimulated) {
      Alert.alert('Simulated Alert Accepted', 'You accepted the test emergency alert. Safety screening confirmed!');
    } else {
      setScreening(item);
    }
  }

  async function handleDeclineCall(item) {
    setIncomingCallAlert(null);
    if (!item) return;
    setDismissedAlertIds((prev) => new Set(prev).add(item.id));
    if (!item.isSimulated) {
      try {
        if (token?.startsWith('firebase.') || !token) {
          await respondAssignment(item.id, 'DECLINE');
        } else {
          await api(
            `/donor/assignments/${item.id}/respond`,
            { method: 'POST', body: JSON.stringify({ response: 'DECLINE' }) },
            token
          );
        }
      } catch (err) {
        console.warn('Decline error:', err.message);
      }
      refresh();
    }
  }

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

        {!hasOverlayPermission && (
          <Pressable style={styles.overlayBanner} onPress={() => setShowOverlayGuide(true)}>
            <View style={styles.overlayBannerIcon}>
              <Text style={{ fontSize: 20 }}>📲</Text>
            </View>
            <View style={styles.flex}>
              <Text style={styles.overlayBannerEyebrow}>ACTION REQUIRED FOR HOVER ALERTS</Text>
              <Text style={styles.overlayBannerTitle}>Enable "Display Over Other Apps"</Text>
              <Text style={styles.overlayBannerText}>
                Allow Pulse Dial to pop up emergency alert calls over other apps. Tap to configure.
              </Text>
            </View>
            <Text style={styles.overlayBannerAction}>&gt;</Text>
          </Pressable>
        )}

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
          <Pressable
            style={styles.editBadge}
            onPress={() => setEditProfileOpen(true)}
          >
            <Text style={styles.editBadgeText}>✏️ Edit</Text>
          </Pressable>
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
              ? 'Emergency blood dispatches trigger full-screen incoming call alerts with vibration and siren radar.'
              : 'Emergency alerts appear as incoming call screens and heads-up banners.'}
          </Text>
          <Text style={styles.noteText}>
            Delivery is high-priority: keep notifications enabled and battery optimization off for instantaneous dispatch.
          </Text>
        </View>

        <Pressable
          style={styles.callSimulatorButton}
          onPress={() => {
            setIncomingCallAlert({
              id: `sim-call-${Date.now()}`,
              isSimulated: true,
              distanceKm: 0.08,
              donorBloodType: donor?.bloodType || 'O-',
              request: {
                bloodType: donor?.bloodType || 'O-',
                unitsNeeded: 1,
                hospitalName: 'Central City Medical Centre',
              },
            });
          }}
        >
          <Text style={styles.callSimulatorButtonText}>🚨 Test Incoming Emergency Call Screen</Text>
        </Pressable>

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
            <Text style={styles.simulatorButtonText}>Send local test notification banner</Text>
          </Pressable>
        ) : null}

        <Pressable
          style={[
            styles.overlayStatusButton,
            hasOverlayPermission ? styles.overlayStatusButtonOn : styles.overlayStatusButtonOff,
          ]}
          onPress={() => setShowOverlayGuide(true)}
        >
          <Text
            style={
              hasOverlayPermission ? styles.overlayStatusButtonTextOn : styles.overlayStatusButtonTextOff
            }
          >
            {hasOverlayPermission
              ? '✓ Display Over Other Apps: Active (Hover Alert Ready)'
              : '⚙️ Configure "Display Over Other Apps" (Hover Alert)'}
          </Text>
        </Pressable>
      </ScrollView>

      <IncomingCallAlert
        alertItem={incomingCallAlert}
        onAccept={() => handleAcceptCall(incomingCallAlert)}
        onDecline={() => handleDeclineCall(incomingCallAlert)}
      />

      <EditProfileModal
        visible={editProfileOpen}
        donor={donor}
        onClose={() => setEditProfileOpen(false)}
        onSaved={(updated) => {
          setDonor((prev) => ({ ...prev, ...donorView(updated) }));
          refresh();
        }}
      />

      <OverlayPermissionModal
        visible={showOverlayGuide}
        onClose={() => setShowOverlayGuide(false)}
        onOpenSettings={() => OverlayService.openOverlaySettings()}
      />
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
  datePickerInput: { backgroundColor: '#fff', borderWidth: 1, borderColor: '#d3dde6', borderRadius: 8, paddingHorizontal: 14, paddingVertical: 13, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  datePickerValueText: { fontSize: 15, color: '#0e2433', fontWeight: '600' },
  datePickerPlaceholderText: { fontSize: 15, color: '#9bb2c5' },
  datePickerIcon: { fontSize: 18 },
  editBadge: { backgroundColor: '#edf2f7', paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8, borderWidth: 1, borderColor: '#d3dde6' },
  editBadgeText: { fontSize: 12, fontWeight: '700', color: '#17354c' },
  pickerBackdrop: { flex: 1, backgroundColor: 'rgba(0, 0, 0, 0.55)', justifyContent: 'center', alignItems: 'center', padding: 20 },
  pickerCard: { width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 16, padding: 20, elevation: 10 },
  pickerTitle: { fontSize: 18, fontWeight: '800', color: '#0e2433', textAlign: 'center' },
  pickerSub: { fontSize: 12.5, color: '#687d91', textAlign: 'center', marginTop: 3, marginBottom: 16 },
  presetRow: { flexDirection: 'row', gap: 6, marginBottom: 18, flexWrap: 'wrap', justifyContent: 'center' },
  presetBtn: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 14, backgroundColor: '#f0f4f8', borderWidth: 1, borderColor: '#d3dde6' },
  presetBtnText: { fontSize: 12, fontWeight: '700', color: '#273849' },
  stepperContainer: { flexDirection: 'row', justifyContent: 'space-between', marginVertical: 10 },
  stepperCol: { alignItems: 'center', flex: 1 },
  stepperLabel: { fontSize: 12, fontWeight: '700', color: '#687d91', marginBottom: 6 },
  stepperRow: { alignItems: 'center' },
  stepBtn: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#edf2f7', alignItems: 'center', justifyContent: 'center', marginVertical: 4 },
  stepBtnText: { fontSize: 20, fontWeight: '800', color: '#0e2433' },
  stepVal: { fontSize: 16, fontWeight: '800', color: '#0e2433', marginVertical: 4 },
  pickerActions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  pickerBtn: { flex: 1, paddingVertical: 12, borderRadius: 8, alignItems: 'center' },
  pickerCancel: { backgroundColor: '#f0f4f8' },
  pickerCancelText: { color: '#4a5b6d', fontWeight: '700', fontSize: 14 },
  pickerApply: { backgroundColor: '#e93f4e' },
  pickerApplyText: { color: '#fff', fontWeight: '700', fontSize: 14 },
  editProfileContainer: { padding: 20, paddingBottom: 40 },
  editHeader: { marginBottom: 20 },
  editTitle: { fontSize: 22, fontWeight: '800', color: '#0e2433' },
  editSub: { fontSize: 13, color: '#687d91', marginTop: 4 },
  availabilityRow: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff', padding: 14, borderRadius: 10, borderWidth: 1, borderColor: '#e1e8ef' },
  availabilityTitle: { fontSize: 15, fontWeight: '700', color: '#0e2433' },
  availabilitySub: { fontSize: 12, color: '#687d91', marginTop: 2 },
  callSimulatorButton: { backgroundColor: '#e93f4e', borderRadius: 12, paddingVertical: 14, alignItems: 'center', marginTop: 16, elevation: 4, shadowColor: '#e93f4e', shadowRadius: 8, shadowOpacity: 0.5 },
  callSimulatorButtonText: { color: '#ffffff', fontWeight: '800', fontSize: 13, letterSpacing: 0.5 },
  callShell: { flex: 1, backgroundColor: '#091824', justifyContent: 'space-between' },
  callTop: { alignItems: 'center', marginTop: 54, paddingHorizontal: 20 },
  callBeacon: { width: 68, height: 68, borderRadius: 34, backgroundColor: '#e93f4e', alignItems: 'center', justifyContent: 'center', elevation: 12, shadowColor: '#ff2e43', shadowRadius: 18, shadowOpacity: 0.8 },
  callBeaconIcon: { fontSize: 32 },
  callBadge: { color: '#ff6b78', fontSize: 13, fontWeight: '800', letterSpacing: 2, marginTop: 14, textAlign: 'center' },
  callLive: { color: '#9bb2c5', fontSize: 13, marginTop: 4, textAlign: 'center' },
  callCenter: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 24 },
  callRadarCircle: { width: 170, height: 170, borderRadius: 85, backgroundColor: 'rgba(233, 63, 78, 0.15)', borderWidth: 2, borderColor: 'rgba(233, 63, 78, 0.4)', alignItems: 'center', justifyContent: 'center', marginBottom: 20 },
  callBloodCircle: { width: 126, height: 126, borderRadius: 63, backgroundColor: '#e93f4e', alignItems: 'center', justifyContent: 'center', elevation: 10, shadowColor: '#e93f4e', shadowRadius: 16, shadowOpacity: 0.7 },
  callBloodType: { color: '#fff', fontSize: 44, fontWeight: '900' },
  callBloodSub: { color: '#ffe5e7', fontSize: 11, fontWeight: '800', letterSpacing: 1.2, marginTop: 2 },
  callHospital: { color: '#ffffff', fontSize: 22, fontWeight: '800', textAlign: 'center' },
  callMetaRow: { flexDirection: 'row', gap: 10, marginTop: 12, marginBottom: 14 },
  callMetaPill: { backgroundColor: 'rgba(255, 255, 255, 0.12)', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20, borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.18)' },
  callMetaText: { color: '#e2ecf5', fontSize: 13, fontWeight: '700' },
  callUrgentCopy: { color: '#8ba3b7', fontSize: 13.5, textAlign: 'center', lineHeight: 20, paddingHorizontal: 16 },
  callBottom: { paddingHorizontal: 24, paddingBottom: 42, gap: 12 },
  callAcceptButton: { backgroundColor: '#1fb854', borderRadius: 16, paddingVertical: 18, alignItems: 'center', justifyContent: 'center', elevation: 8, shadowColor: '#1fb854', shadowRadius: 14, shadowOpacity: 0.6 },
  callAcceptIcon: { color: '#fff', fontSize: 22, fontWeight: '900', marginBottom: 2 },
  callAcceptText: { color: '#fff', fontSize: 18, fontWeight: '900', letterSpacing: 1 },
  callAcceptSub: { color: '#e2f9ea', fontSize: 12, fontWeight: '600', marginTop: 2 },
  callDeclineButton: { backgroundColor: 'rgba(255, 255, 255, 0.08)', borderWidth: 1, borderColor: 'rgba(255, 255, 255, 0.16)', borderRadius: 14, paddingVertical: 14, alignItems: 'center' },
  callDeclineText: { color: '#ff8894', fontSize: 14, fontWeight: '700' },
  overlayBanner: { flexDirection: 'row', alignItems: 'center', backgroundColor: '#fff3cd', borderColor: '#ffeeba', borderWidth: 1, borderRadius: 14, padding: 14, marginTop: 12, marginBottom: 4, gap: 10 },
  overlayBannerIcon: { width: 38, height: 38, borderRadius: 19, backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' },
  overlayBannerEyebrow: { color: '#856404', fontSize: 9.5, fontWeight: '800', letterSpacing: 0.8 },
  overlayBannerTitle: { color: '#856404', fontSize: 14, fontWeight: '800', marginTop: 1 },
  overlayBannerText: { color: '#66512c', fontSize: 11.5, marginTop: 2, lineHeight: 16 },
  overlayBannerAction: { color: '#856404', fontSize: 18, fontWeight: '800' },
  overlayModalCard: { width: '100%', maxWidth: 360, backgroundColor: '#fff', borderRadius: 20, padding: 22, alignItems: 'center', elevation: 12 },
  overlayIconCircle: { width: 64, height: 64, borderRadius: 32, backgroundColor: '#fff1f2', alignItems: 'center', justifyContent: 'center', marginBottom: 14 },
  overlayModalTitle: { fontSize: 18, fontWeight: '800', color: '#17354c', textAlign: 'center' },
  overlayModalSubtitle: { fontSize: 13, color: '#57697a', textAlign: 'center', marginTop: 6, lineHeight: 18, marginBottom: 16 },
  overlayStepsContainer: { width: '100%', backgroundColor: '#f7fafc', borderRadius: 12, padding: 14, borderWidth: 1, borderColor: '#e2ecf5' },
  overlayStepTitle: { fontSize: 13, fontWeight: '800', color: '#17354c', marginBottom: 8 },
  overlayStepText: { fontSize: 12, color: '#3d5265', lineHeight: 20, marginBottom: 4 },
  overlayStatusButton: { borderRadius: 10, paddingVertical: 12, paddingHorizontal: 14, alignItems: 'center', marginTop: 12 },
  overlayStatusButtonOff: { backgroundColor: '#ffebee', borderWidth: 1, borderColor: '#ffcdd2' },
  overlayStatusButtonOn: { backgroundColor: '#e8f5e9', borderWidth: 1, borderColor: '#c8e6c9' },
  overlayStatusButtonTextOff: { color: '#c62828', fontWeight: '800', fontSize: 12.5 },
  overlayStatusButtonTextOn: { color: '#2e7d32', fontWeight: '800', fontSize: 12.5 },
});
