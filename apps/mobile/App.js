import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, SafeAreaView, ScrollView, StatusBar, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { StatusBar as ExpoStatusBar } from 'expo-status-bar';
import QRCode from 'react-native-qrcode-svg';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Location from 'expo-location';

let currentApiUrl = process.env.EXPO_PUBLIC_API_URL || 'http://10.0.2.2:4000';
const bloodTypes = ['O-', 'O+', 'A-', 'A+', 'B-', 'B+', 'AB-', 'AB+'];

async function getApiUrl() {
  try {
    const saved = await AsyncStorage.getItem('pulse-server-url');
    if (saved) currentApiUrl = saved;
  } catch (_) {}
  return currentApiUrl;
}

async function api(path, options = {}, token) {
  const base = await getApiUrl();
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || 'Connection failed.');
  return body;
}

const Button = ({ title, onPress, variant = 'primary', disabled = false }) => (
  <Pressable disabled={disabled} onPress={onPress} style={[styles.button, styles[variant], disabled && styles.disabled]}>
    <Text style={[styles.buttonText, variant !== 'primary' && styles.darkButtonText]}>{title}</Text>
  </Pressable>
);

function SignIn({ onSignedIn }) {
  const [phone, setPhone] = useState('+919000000001');
  const [code, setCode] = useState('123456');
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
  const [serverUrl, setServerUrl] = useState(currentApiUrl);
  const [showConfig, setShowConfig] = useState(false);

  useEffect(() => {
    getApiUrl().then(url => setServerUrl(url));
  }, []);

  async function saveServer() {
    const clean = serverUrl.trim().replace(/\/+$/, '');
    await AsyncStorage.setItem('pulse-server-url', clean);
    currentApiUrl = clean;
    Alert.alert('Server Configured', `Connected to: ${clean}`);
    setShowConfig(false);
  }

  async function resetServer() {
    const defaultUrl = process.env.EXPO_PUBLIC_API_URL || 'http://10.0.2.2:4000';
    await AsyncStorage.removeItem('pulse-server-url');
    currentApiUrl = defaultUrl;
    setServerUrl(defaultUrl);
    Alert.alert('Server Reset', `Restored default: ${defaultUrl}`);
    setShowConfig(false);
  }

  async function sendCode() {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api('/auth/donor/start', { method: 'POST', body: JSON.stringify({ phone }) });
      setNotice(result.message);
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  async function submit() {
    setBusy(true); setError('');
    try {
      onSignedIn(await api('/auth/donor/verify', {
        method: 'POST',
        body: JSON.stringify({ phone, code, fullName: name || undefined, bloodType, dateOfBirth, weightKg: Number(weightKg), lastDonationDate, sex, consentAccepted }),
      }));
    } catch (err) { setError(err.message); } finally { setBusy(false); }
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ExpoStatusBar style="light"/>
      <ScrollView>
        <View style={styles.signTop}>
          <View style={styles.cross}><Text style={styles.crossText}>+</Text></View>
          <Text style={styles.brand}>PULSE DIAL</Text>
          <Text style={styles.signTitle}>Give time. Save a life.</Text>
          <Text style={styles.signText}>Join a verified local donor network ready to help in a critical emergency.</Text>
        </View>
        <View style={styles.signForm}>
          <Text style={styles.formTitle}>Donor sign in or register</Text>
          <Text style={styles.formSub}>Existing donors need only their phone and verification code. New donors complete their safety profile below.</Text>
          
          <Text style={styles.label}>Mobile number</Text>
          <TextInput value={phone} onChangeText={setPhone} style={styles.input} keyboardType="phone-pad" placeholder="+91 90000 00000" autoCapitalize="none"/>
          <Button title={busy ? 'Sending…' : 'Send verification code'} variant="outline" onPress={sendCode} disabled={busy}/>
          
          <Text style={styles.label}>One-time code</Text>
          <TextInput value={code} onChangeText={setCode} style={styles.input} keyboardType="number-pad"/>
          <Text style={styles.hint}>Local demo code: 123456</Text>
          {notice ? <Text style={styles.notice}>{notice}</Text> : null}

          <View style={styles.registration}>
            <Text style={styles.registrationTitle}>New donor medical profile</Text>
            <Text style={styles.label}>Full legal name</Text>
            <TextInput value={name} onChangeText={setName} style={styles.input} placeholder="Your full name"/>
            <Text style={styles.label}>Blood group</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.typeRow}>
              {bloodTypes.map(type => (
                <Pressable onPress={() => setBloodType(type)} key={type} style={[styles.typeChip, bloodType === type && styles.typeSelected]}>
                  <Text style={[styles.typeText, bloodType === type && styles.typeTextSelected]}>{type}</Text>
                </Pressable>
              ))}
            </ScrollView>
            <Text style={styles.label}>Date of birth</Text>
            <TextInput value={dateOfBirth} onChangeText={setDateOfBirth} style={styles.input} placeholder="YYYY-MM-DD"/>
            <Text style={styles.label}>Weight in kilograms</Text>
            <TextInput value={weightKg} onChangeText={setWeightKg} style={styles.input} placeholder="e.g. 62" keyboardType="decimal-pad"/>
            <Text style={styles.label}>Last whole-blood donation</Text>
            <TextInput value={lastDonationDate} onChangeText={setLastDonationDate} style={styles.input} placeholder="YYYY-MM-DD"/>
            <Text style={styles.label}>Sex</Text>
            <View style={styles.sexRow}>
              {['FEMALE', 'MALE', 'UNSPECIFIED'].map(value => (
                <Pressable key={value} onPress={() => setSex(value)} style={[styles.sexChip, sex === value && styles.sexSelected]}>
                  <Text style={[styles.sexText, sex === value && styles.sexTextSelected]}>{value[0] + value.slice(1).toLowerCase()}</Text>
                </Pressable>
              ))}
            </View>
            <Pressable style={styles.consent} onPress={() => setConsentAccepted(value => !value)}>
              <View style={[styles.check, consentAccepted && styles.checked]}>{consentAccepted && <Text style={styles.checkText}>✓</Text>}</View>
              <Text style={styles.consentText}>I consent to emergency-alert matching and confirm these medical details are accurate.</Text>
            </Pressable>
          </View>

          {error ? <Text style={styles.error}>{error}</Text> : null}
          <Button title={busy ? 'Signing in…' : 'Continue as donor'} onPress={submit} disabled={busy}/>

          <Pressable onPress={() => setShowConfig(v => !v)} style={{ marginTop: 16, alignItems: 'center' }}>
            <Text style={{ fontSize: 12, color: '#4a6d88', fontWeight: '700' }}>
              ⚙ {showConfig ? 'Hide Server Settings' : `Server: ${serverUrl}`}
            </Text>
          </Pressable>

          {showConfig && (
            <View style={{ marginTop: 12, padding: 14, backgroundColor: '#f0f4f8', borderRadius: 10 }}>
              <Text style={{ fontSize: 12, fontWeight: '700', color: '#273b4e', marginBottom: 6 }}>Custom API Endpoint</Text>
              <TextInput value={serverUrl} onChangeText={setServerUrl} style={[styles.input, { backgroundColor: '#fff' }]} autoCapitalize="none" placeholder="https://your-domain.vercel.app/api"/>
              <View style={{ flexDirection: 'row', gap: 8, marginTop: 10 }}>
                <View style={{ flex: 1 }}><Button title="Save" onPress={saveServer}/></View>
                <View style={{ flex: 1 }}><Button title="Reset" variant="outline" onPress={resetServer}/></View>
              </View>
            </View>
          )}

          <Text style={styles.privacy}>Your information is screened by the matching engine. Hospital staff conduct final clinical eligibility assessment.</Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}
function Screening({ alertItem, token, onDone, onCancel }) {
  const [answers, setAnswers] = useState([false, false, false, false]); const [busy, setBusy] = useState(false);
  const questions = ['I have been free of fever or infection for 14 days', 'I have not consumed alcohol within 24 hours', 'I am not currently taking antibiotics', 'I weigh at least 50 kg'];
  async function accept() { if (answers.some(value => !value)) return Alert.alert('Please confirm eligibility', 'All four safety checks must be confirmed before accepting.'); setBusy(true); try { await api(`/donor/assignments/${alertItem.id}/respond`, { method: 'POST', body: JSON.stringify({ response: 'ACCEPT' }) }, token); onDone(); } catch (err) { Alert.alert('Unable to accept', err.message); } finally { setBusy(false); } }
  return <SafeAreaView style={styles.safe}><ExpoStatusBar style="light"/><ScrollView contentContainerStyle={styles.screening}><View style={styles.critical}><Text style={styles.criticalLabel}>CRITICAL BLOOD ALERT</Text><Text style={styles.criticalType}>{alertItem.request.bloodType}</Text><Text style={styles.criticalCopy}>Central City Medical Centre needs {alertItem.request.unitsNeeded} unit{alertItem.request.unitsNeeded > 1 ? 's' : ''} now.</Text><View style={styles.distance}><Text style={styles.distanceText}>≈ {alertItem.distanceKm} km away · Tier {alertItem.tier}</Text></View></View><View style={styles.screenPanel}><Text style={styles.formTitle}>Quick safety check</Text><Text style={styles.formSub}>Please confirm before accepting this emergency request.</Text>{questions.map((question, index) => <Pressable key={question} style={styles.question} onPress={() => setAnswers(current => current.map((answer, i) => i === index ? !answer : answer))}><View style={[styles.check, answers[index] && styles.checked]}>{answers[index] && <Text style={styles.checkText}>✓</Text>}</View><Text style={styles.questionText}>{question}</Text></Pressable>)}<Button title={busy ? 'Confirming…' : 'I am eligible — accept request'} onPress={accept} disabled={busy}/><Button title="I can’t donate now" variant="plain" onPress={onCancel}/></View></ScrollView></SafeAreaView>;
}
function Arrival({ assignment, token, refresh }) {
  const [arrived, setArrived] = useState(assignment.status === 'ARRIVED');
  async function markArrival() { try { await api(`/donor/assignments/${assignment.id}/arrive`, { method: 'POST' }, token); setArrived(true); refresh(); } catch (err) { Alert.alert('Unable to update arrival', err.message); } }
  return <View style={styles.arrival}><View style={styles.arrivalHead}><Text style={styles.arrivalTitle}>{arrived ? 'You have arrived' : 'You’re on your way'}</Text><Text style={styles.arrivalSub}>Central City Medical Centre · {assignment.distanceKm} km</Text></View><View style={styles.qrBox}><QRCode value={assignment.checkinToken} size={175} color="#14344c"/><Text style={styles.qrHint}>Show this QR pass to the blood bank officer</Text></View><Text style={styles.token}>{assignment.checkinToken}</Text>{!arrived && <Button title="I’ve arrived at hospital" onPress={markArrival}/>}<Text style={styles.caution}>Bring a government photo ID. Hospital staff will complete the clinical eligibility assessment.</Text></View>;
}
function Home({ session, signOut }) {
  const [donor, setDonor] = useState(session.donor); const [alerts, setAlerts] = useState([]); const [screening, setScreening] = useState(null); const token = session.token;
  const refresh = async () => { try { const [profile, nextAlerts] = await Promise.all([api('/donor/me', {}, token), api('/donor/alerts', {}, token)]); setDonor(profile); setAlerts(nextAlerts); } catch (err) { console.log(err.message); } };
  const syncLocation = async () => {
    try {
      const permission = await Location.requestForegroundPermissionsAsync();
      if (permission.status !== 'granted') return;
      const current = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const updated = await api('/donor/me', { method: 'PATCH', body: JSON.stringify({ latitude: current.coords.latitude, longitude: current.coords.longitude }) }, token);
      setDonor(updated);
    } catch (error) { console.log(`Location update skipped: ${error.message}`); }
  };
  useEffect(() => { refresh(); syncLocation(); const id = setInterval(refresh, 4000); return () => clearInterval(id); }, []);
  async function setAvailable(value) { setDonor(previous => ({ ...previous, isAvailable: value })); try { setDonor(await api('/donor/me', { method: 'PATCH', body: JSON.stringify({ isAvailable: value }) }, token)); } catch (err) { Alert.alert('Unable to update', err.message); refresh(); } }
  const pending = alerts.find(item => item.status === 'PINGED'); const active = alerts.find(item => ['ACCEPTED', 'ARRIVED'].includes(item.status));
  if (screening) return <Screening alertItem={screening} token={token} onDone={() => { setScreening(null); refresh(); }} onCancel={async () => { await api(`/donor/assignments/${screening.id}/respond`, { method: 'POST', body: JSON.stringify({ response: 'DECLINE' }) }, token); setScreening(null); refresh(); }}/>;
  return <SafeAreaView style={styles.safe}><ExpoStatusBar style="dark"/><ScrollView contentContainerStyle={styles.home}><View style={styles.topbar}><View><Text style={styles.smallBrand}>PULSE <Text>DIAL</Text></Text><Text style={styles.greeting}>Hello, {donor.fullName.split(' ')[0]}</Text></View><Pressable onPress={signOut}><Text style={styles.signOut}>Sign out</Text></Pressable></View>{pending && <Pressable style={styles.alertBanner} onPress={() => setScreening(pending)}><View><Text style={styles.alertEyebrow}>NEW EMERGENCY ALERT</Text><Text style={styles.alertTitle}>{pending.request.bloodType} blood urgently needed</Text><Text style={styles.alertText}>Central City Medical Centre · {pending.distanceKm} km away</Text></View><Text style={styles.alertArrow}>›</Text></Pressable>}<View style={styles.profileCard}><View style={styles.bloodCircle}><Text>{donor.bloodType}</Text></View><View style={styles.profileInfo}><Text style={styles.profileName}>{donor.fullName}</Text><Text style={styles.profileMeta}>Reliability score <Text style={styles.score}>{donor.reliabilityScore}</Text></Text><Text style={[styles.eligibility, donor.eligible ? styles.eligible : styles.ineligible]}>{donor.eligible ? '● Eligible to donate' : '● Donation cooldown active'}</Text></View></View><View style={styles.availability}><View><Text style={styles.availTitle}>Emergency availability</Text><Text style={styles.availText}>{donor.isAvailable ? 'You can receive nearby critical alerts.' : 'Alerts are paused until you enable availability.'}</Text></View><Switch value={donor.isAvailable} onValueChange={setAvailable} trackColor={{ false: '#dce2e8', true: '#f9a3a9' }} thumbColor={donor.isAvailable ? '#e93f4e' : '#fff'}/></View>{active ? <Arrival assignment={active} token={token} refresh={refresh}/> : <View style={styles.waiting}><Text style={styles.waitingIcon}>⌁</Text><Text style={styles.waitingTitle}>{donor.isAvailable ? 'You’re ready to help' : 'Availability is paused'}</Text><Text style={styles.waitingText}>{donor.isAvailable ? 'We’ll notify you if a compatible, nearby emergency request needs your help.' : 'Turn on availability when you are able to donate.'}</Text></View>}<View style={styles.info}><Text style={styles.infoTitle}>Your privacy is protected</Text><Text style={styles.infoText}>Your exact location is only shared after you choose to accept an emergency request.</Text></View></ScrollView></SafeAreaView>;
}
export default function App() {
  const [session, setSession] = useState(null); const [restoring, setRestoring] = useState(true);
  useEffect(() => { AsyncStorage.getItem('pulse-dial-session').then(value => { if (value) setSession(JSON.parse(value)); }).catch(() => {}).finally(() => setRestoring(false)); }, []);
  const signedIn = async value => { await AsyncStorage.setItem('pulse-dial-session', JSON.stringify(value)); setSession(value); };
  const signOut = async () => { await AsyncStorage.removeItem('pulse-dial-session'); setSession(null); };
  if (restoring) return <SafeAreaView style={styles.loading}><ActivityIndicator size="large" color="#e94250"/><Text style={styles.loadingText}>Preparing Pulse Dial…</Text></SafeAreaView>;
  return session ? <Home session={session} signOut={signOut}/> : <SignIn onSignedIn={signedIn}/>;
}

const styles = StyleSheet.create({
  safe:{flex:1,backgroundColor:'#f5f7fa'},loading:{flex:1,alignItems:'center',justifyContent:'center',backgroundColor:'#f5f7fa'},loadingText:{marginTop:14,color:'#566f82',fontWeight:'700'},signTop:{backgroundColor:'#12364e',padding:34,paddingTop:56,paddingBottom:48},cross:{width:42,height:42,borderRadius:13,backgroundColor:'#ec4250',alignItems:'center',justifyContent:'center'},crossText:{color:'#fff',fontSize:28,fontWeight:'800'},brand:{fontWeight:'800',letterSpacing:1.3,color:'#fff',marginTop:16},signTitle:{fontSize:31,fontWeight:'800',color:'#fff',marginTop:26},signText:{color:'#cbdbe5',fontSize:15,lineHeight:23,marginTop:10},signForm:{backgroundColor:'#fff',marginTop:-20,borderTopLeftRadius:24,borderTopRightRadius:24,padding:26,flex:1},formTitle:{fontSize:21,fontWeight:'800',color:'#17354c'},formSub:{fontSize:13,color:'#718195',lineHeight:20,marginTop:5,marginBottom:22},label:{fontSize:12,fontWeight:'700',color:'#4d5d70',marginTop:13,marginBottom:7},input:{borderWidth:1,borderColor:'#dce3ea',borderRadius:9,padding:12,color:'#22364a',fontSize:15},hint:{fontSize:11,color:'#dc3e4c',marginTop:5},notice:{fontSize:12,color:'#278555',fontWeight:'700',marginTop:8},registration:{borderTopWidth:1,borderColor:'#e7ebef',marginTop:22,paddingTop:4},registrationTitle:{fontSize:15,fontWeight:'800',color:'#23445b',marginTop:15},typeRow:{gap:7,paddingVertical:3},typeChip:{borderWidth:1,borderColor:'#dce3ea',borderRadius:8,paddingVertical:8,paddingHorizontal:10},typeSelected:{backgroundColor:'#e94250',borderColor:'#e94250'},typeText:{fontWeight:'800',color:'#526174'},typeTextSelected:{color:'#fff'},sexRow:{flexDirection:'row',gap:7},sexChip:{borderWidth:1,borderColor:'#dce3ea',borderRadius:8,paddingVertical:9,paddingHorizontal:10},sexSelected:{backgroundColor:'#eaf4f8',borderColor:'#4b93b4'},sexText:{fontSize:11,fontWeight:'700',color:'#596b7b'},sexTextSelected:{color:'#286985'},consent:{flexDirection:'row',gap:10,alignItems:'flex-start',marginTop:17},consentText:{flex:1,fontSize:11,color:'#68788a',lineHeight:16},button:{borderRadius:10,padding:15,alignItems:'center',marginTop:19},primary:{backgroundColor:'#e94250'},outline:{backgroundColor:'#fff',borderWidth:1,borderColor:'#d66771',marginTop:10},plain:{backgroundColor:'transparent',marginTop:1},buttonText:{fontWeight:'800',color:'#fff'},darkButtonText:{color:'#c73341'},disabled:{opacity:.55},privacy:{fontSize:11,lineHeight:16,color:'#8794a4',textAlign:'center',margin:17},error:{color:'#d92a3a',fontSize:12,fontWeight:'700',marginTop:12},screening:{flexGrow:1},critical:{backgroundColor:'#d93949',padding:30,paddingTop:50},criticalLabel:{fontSize:11,color:'#ffe4e6',fontWeight:'800',letterSpacing:1.2},criticalType:{fontSize:66,fontWeight:'800',color:'#fff',marginTop:7},criticalCopy:{color:'#fff',fontSize:17,lineHeight:24},distance:{alignSelf:'flex-start',backgroundColor:'#ffffff24',borderRadius:99,paddingVertical:8,paddingHorizontal:12,marginTop:18},distanceText:{color:'#fff'},screenPanel:{marginTop:-15,borderTopLeftRadius:20,borderTopRightRadius:20,backgroundColor:'#fff',padding:25,flex:1},question:{flexDirection:'row',alignItems:'center',borderBottomWidth:1,borderColor:'#edf0f3',paddingVertical:15,gap:12},check:{width:23,height:23,borderWidth:1.5,borderColor:'#bdc9d4',borderRadius:6,alignItems:'center',justifyContent:'center'},checkText:{color:'#fff',fontWeight:'800'},checked:{backgroundColor:'#e94250',borderColor:'#e94250'},questionText:{flex:1,fontSize:13,color:'#38495c',lineHeight:19},home:{padding:21,paddingBottom:36},topbar:{flexDirection:'row',justifyContent:'space-between',alignItems:'flex-start',marginTop:8,marginBottom:26},smallBrand:{fontWeight:'800',letterSpacing:1,color:'#1c415a',fontSize:11},greeting:{fontSize:25,fontWeight:'800',color:'#18374f',marginTop:7},signOut:{fontSize:12,color:'#6e7d8e',fontWeight:'700',marginTop:8},alertBanner:{backgroundColor:'#df3e4d',borderRadius:15,padding:20,flexDirection:'row',justifyContent:'space-between',alignItems:'center',marginBottom:17,shadowColor:'#d53647',shadowOpacity:.25,shadowRadius:15,elevation:5},alertEyebrow:{fontSize:10,fontWeight:'800',letterSpacing:1,color:'#ffe6e8'},alertTitle:{fontSize:19,fontWeight:'800',color:'#fff',marginTop:5},alertText:{fontSize:12,color:'#ffe6e8',marginTop:5},alertArrow:{fontSize:38,color:'#fff'},profileCard:{backgroundColor:'#fff',borderWidth:1,borderColor:'#e1e7ed',borderRadius:14,padding:18,flexDirection:'row',alignItems:'center'},bloodCircle:{height:61,width:61,borderRadius:31,alignItems:'center',justifyContent:'center',backgroundColor:'#fff0f1'},profileInfo:{marginLeft:15},profileName:{fontSize:18,fontWeight:'800',color:'#1e3a51'},profileMeta:{fontSize:12,color:'#7b8997',marginTop:4},score:{fontWeight:'800',color:'#d13343'},eligibility:{fontSize:11,fontWeight:'700',marginTop:7},eligible:{color:'#26945c'},ineligible:{color:'#c48216'},availability:{marginTop:15,backgroundColor:'#fff',borderWidth:1,borderColor:'#e1e7ed',borderRadius:14,padding:18,flexDirection:'row',justifyContent:'space-between',alignItems:'center'},availTitle:{fontWeight:'800',fontSize:15,color:'#263f55'},availText:{fontSize:11,color:'#778698',marginTop:5,width:240,lineHeight:16},waiting:{alignItems:'center',backgroundColor:'#edf7fb',borderRadius:14,padding:29,marginTop:15},waitingIcon:{fontSize:36,color:'#4b92b4'},waitingTitle:{fontSize:17,fontWeight:'800',color:'#28495f',marginTop:9},waitingText:{textAlign:'center',fontSize:12,lineHeight:18,color:'#728293',marginTop:7},info:{marginTop:17,padding:17,borderRadius:12,backgroundColor:'#fff8e8'},infoTitle:{fontSize:12,fontWeight:'800',color:'#8b6417'},infoText:{fontSize:11,lineHeight:16,color:'#8b7547',marginTop:4},arrival:{marginTop:15,backgroundColor:'#fff',borderRadius:15,borderWidth:1,borderColor:'#e0e7ed',overflow:'hidden'},arrivalHead:{backgroundColor:'#163d57',padding:20},arrivalTitle:{color:'#fff',fontSize:20,fontWeight:'800'},arrivalSub:{color:'#cbdde8',fontSize:12,marginTop:5},qrBox:{alignItems:'center',padding:22},qrHint:{fontSize:12,color:'#6f7e90',marginTop:14,textAlign:'center'},token:{fontSize:9,color:'#98a4af',textAlign:'center',paddingHorizontal:15},caution:{fontSize:11,lineHeight:16,color:'#8b7547',backgroundColor:'#fff8e7',padding:14,marginTop:16}
});
