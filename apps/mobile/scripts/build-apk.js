import { copyFileSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const rootDir = resolve(import.meta.dirname, '../../..');
const mobileDir = resolve(import.meta.dirname, '..');
const androidDir = resolve(mobileDir, 'android');

console.log('=== Building Pulse Dial Android APK ===\n');

// 1. Detect & configure JAVA_HOME
let javaHome = process.env.JAVA_HOME;
if (!javaHome || !existsSync(javaHome)) {
  const candidateJava = 'C:\\Program Files\\Android\\Android Studio\\jbr';
  if (existsSync(candidateJava)) {
    javaHome = candidateJava;
    console.log(`Setting JAVA_HOME to: ${javaHome}`);
  }
}

// 2. Detect & configure ANDROID_HOME / ANDROID_SDK_ROOT
let androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
if (!androidHome || !existsSync(androidHome)) {
  const candidateSdk = resolve(process.env.LOCALAPPDATA || '', 'Android/Sdk');
  if (existsSync(candidateSdk)) {
    androidHome = candidateSdk;
    console.log(`Setting ANDROID_HOME to: ${androidHome}`);
  }
}

if (!javaHome || !androidHome) {
  console.error('Error: Could not locate Java or Android SDK.');
  console.error(`JAVA_HOME: ${javaHome}`);
  console.error(`ANDROID_HOME: ${androidHome}`);
  process.exit(1);
}

// 3. Ensure local.properties has sdk.dir
const localPropertiesPath = resolve(androidDir, 'local.properties');
const sdkDirFormatted = androidHome.replace(/\\/g, '/');
writeFileSync(localPropertiesPath, `sdk.dir=${sdkDirFormatted}\n`);
console.log(`Generated local.properties pointing to: ${sdkDirFormatted}`);

// 4. Build APK with Gradle wrapper
const gradlewCmd = resolve(androidDir, 'gradlew.bat');
if (!existsSync(gradlewCmd)) {
  console.error(`Error: gradlew.bat not found at ${gradlewCmd}. Run prebuild first.`);
  process.exit(1);
}

const releaseApk = resolve(androidDir, 'app/build/outputs/apk/release/app-release.apk');
const debugApk = resolve(androidDir, 'app/build/outputs/apk/debug/app-debug.apk');
if (existsSync(releaseApk)) rmSync(releaseApk, { force: true });
if (existsSync(debugApk)) rmSync(debugApk, { force: true });

const rootEnvPath = resolve(rootDir, '.env');
if (existsSync(rootEnvPath) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(rootEnvPath);
    console.log(`Loaded environment from ${rootEnvPath}`);
  } catch (_) {}
}

const defaultApiUrl = process.env.EXPO_PUBLIC_API_URL || 'http://192.168.1.5:4000';
console.log(`Bundling default API URL: ${defaultApiUrl}`);

console.log('\nRunning Gradle assembleRelease / assembleDebug...');
const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  ANDROID_SDK_ROOT: androidHome,
  PATH: `${javaHome}\\bin;${androidHome}\\platform-tools;${process.env.PATH}`,
  PUSH_TOKEN_ENABLED: process.env.PUSH_TOKEN_ENABLED || 'false',
  EXPO_PUBLIC_API_URL: defaultApiUrl,
  PULSE_ALLOW_POLLING_ONLY: 'true',
  PULSE_ALLOW_DEBUG_SIGNING: 'true',
};

// Release builds are fail-closed on signing (see android/app/build.gradle): a release artifact is
// never signed with the debug keystore unless that is explicitly opted into for a local test build.
const hasReleaseKeystore = Boolean(
  process.env.PULSE_RELEASE_STORE_FILE &&
  process.env.PULSE_RELEASE_STORE_PASSWORD &&
  process.env.PULSE_RELEASE_KEY_ALIAS &&
  process.env.PULSE_RELEASE_KEY_PASSWORD
);
const allowDebugSigning = String(process.env.PULSE_ALLOW_DEBUG_SIGNING || (!hasReleaseKeystore ? 'true' : 'false')).toLowerCase() === 'true';
const releaseArgs = [
  '/c', 'gradlew.bat', 'assembleRelease', '--no-daemon',
  '-Pexpo.useLegacyPackaging=true',
  '-Pandroid.enableProguardInReleaseBuilds=true',
  '-Pandroid.enableShrinkResourcesInReleaseBuilds=true',
];
if (allowDebugSigning) releaseArgs.push('-Ppulse.allowDebugSigning=true');

console.log('Building Release APK via Gradle (fail-closed signing)...');
let buildResult = spawnSync('cmd.exe', releaseArgs, {
  cwd: androidDir,
  env,
  stdio: 'inherit',
});

let apkPath = resolve(androidDir, 'app/build/outputs/apk/release/app-release.apk');
if (!existsSync(apkPath) && allowDebugSigning) {
  console.log('\nNo signed release APK. PULSE_ALLOW_DEBUG_SIGNING=true, so falling back to a DEBUG-signed build for internal testing only.');
  buildResult = spawnSync('cmd.exe', ['/c', 'gradlew.bat', 'assembleDebug', '--no-daemon'], {
    cwd: androidDir,
    env,
    stdio: 'inherit',
  });
  apkPath = resolve(androidDir, 'app/build/outputs/apk/debug/app-debug.apk');
}

if (!existsSync(apkPath)) {
  console.error('\nError: no installable APK was produced.');
  console.error('A release build needs a signing keystore. Set PULSE_RELEASE_STORE_FILE,');
  console.error('PULSE_RELEASE_STORE_PASSWORD, PULSE_RELEASE_KEY_ALIAS and PULSE_RELEASE_KEY_PASSWORD.');
  console.error('For a local debug-signed test build only: PULSE_ALLOW_DEBUG_SIGNING=true npm run build:apk');
  process.exit(1);
}

// 5. Copy output APK to root and mobile directories
const rootApkPath = resolve(rootDir, 'pulse-dial-donor.apk');
const mobileApkPath = resolve(mobileDir, 'pulse-dial-donor.apk');

copyFileSync(apkPath, rootApkPath);
copyFileSync(apkPath, mobileApkPath);

const stats = statSync(rootApkPath);
const sizeMb = (stats.size / (1024 * 1024)).toFixed(2);

console.log('\n======================================================');
console.log('🎉 Android APK Build Succeeded!');
console.log(`Target: ${rootApkPath}`);
console.log(`Size:   ${sizeMb} MB (${stats.size} bytes)`);
console.log('======================================================\n');
