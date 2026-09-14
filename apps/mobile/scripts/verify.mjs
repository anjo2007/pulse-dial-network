/**
 * Local verification for the donor app: no device, no Android SDK, no network required.
 *
 *  1. Syntax gate - every mobile source file (JS + JSX) is parsed through the same Babel preset
 *     Metro uses, so `App.js` and the ESM modules are both validated.
 *  2. Unit tests - pure-logic coverage for the alert payload contract, deep links,
 *     permission-aware status, device registration/unregistration and the session model.
 *
 * Run with:  npm run check --workspace @pulse/mobile
 * Native build + on-device checks are still required; see NOTIFICATIONS.md.
 */

import { readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const mobileDir = resolve(import.meta.dirname, '..');
const monorepoRoot = resolve(mobileDir, '..', '..');
const SKIP_DIRS = new Set(['node_modules', 'android', 'ios', 'build', '.expo', '.git']);

const require = createRequire(import.meta.url);

function loadBabel() {
  for (const base of [monorepoRoot, mobileDir]) {
    try {
      const corePath = require.resolve('@babel/core', { paths: [base] });
      const presetPath = require.resolve('babel-preset-expo', { paths: [base] });
      return { core: require(corePath), preset: presetPath };
    } catch (_) {
      // try next root
    }
  }
  return null;
}

function collect(dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) collect(full, acc);
    else if (entry.endsWith('.js')) acc.push(full);
  }
  return acc;
}

const files = collect(mobileDir).sort();
const babel = loadBabel();
let failures = 0;

if (babel) {
  console.log(`Syntax gate via babel-preset-expo (${files.length} files):`);
  for (const file of files) {
    try {
      babel.core.transformFileSync(file, {
        filename: file,
        babelrc: false,
        configFile: false,
        sourceType: 'unambiguous',
        presets: [babel.preset],
        caller: { name: 'pulse-verify', supportsStaticESM: true },
      });
      console.log(`  ok   ${relative(mobileDir, file)}`);
    } catch (error) {
      failures += 1;
      console.error(`  FAIL ${relative(mobileDir, file)}`);
      console.error(`       ${String(error.message).split('\n').slice(0, 3).join('\n       ')}`);
    }
  }
} else {
  console.warn('babel-preset-expo not resolvable; falling back to node --check for plain JS only.');
  for (const file of files) {
    if (file.endsWith('App.js')) {
      console.warn(`  skip ${relative(mobileDir, file)} (JSX, requires Babel)`);
      continue;
    }
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (result.status !== 0) {
      failures += 1;
      console.error(`  FAIL ${relative(mobileDir, file)}`);
      console.error(`       ${(result.stderr || '').trim().split('\n').slice(0, 3).join('\n       ')}`);
    } else {
      console.log(`  ok   ${relative(mobileDir, file)}`);
    }
  }
}

console.log('\nUnit tests (node:test):');
const tests = spawnSync(process.execPath, ['--test', 'tests/*.test.js'], { cwd: mobileDir, stdio: 'inherit' });
if (tests.status !== 0) failures += 1;

if (failures > 0) {
  console.error(`\nVerification FAILED (${failures} step(s)).`);
  process.exit(1);
}
console.log('\nVerification passed (syntax + pure-logic tests).');
console.log('Not covered here: native compile, notification delivery and device behaviour.');
