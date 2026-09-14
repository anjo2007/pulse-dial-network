import { copyFileSync, existsSync, statSync, writeFileSync } from 'node:fs';
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

console.log('\nRunning Gradle assembleRelease / assembleDebug...');
const env = {
  ...process.env,
  JAVA_HOME: javaHome,
  ANDROID_HOME: androidHome,
  ANDROID_SDK_ROOT: androidHome,
  PATH: `${javaHome}\\bin;${androidHome}\\platform-tools;${process.env.PATH}`,
};

// Try assembleRelease first for compressed production APK, or fallback to assembleDebug
console.log('Building compressed Release APK via Gradle...');
let buildResult = spawnSync('cmd.exe', ['/c', 'gradlew.bat', 'assembleRelease', '--no-daemon'], {
  cwd: androidDir,
  env,
  stdio: 'inherit',
});

let apkPath = resolve(androidDir, 'app/build/outputs/apk/release/app-release.apk');
if (!existsSync(apkPath)) {
  console.log('\nassembleRelease did not produce APK, attempting assembleDebug...');
  buildResult = spawnSync('cmd.exe', ['/c', 'gradlew.bat', 'assembleDebug', '--no-daemon'], {
    cwd: androidDir,
    env,
    stdio: 'inherit',
  });
  apkPath = resolve(androidDir, 'app/build/outputs/apk/debug/app-debug.apk');
}

if (!existsSync(apkPath)) {
  console.error('\nError: APK file was not found after Gradle build.');
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
