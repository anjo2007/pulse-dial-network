// Shared operator-CLI helpers.
//
// Every operator script in this directory is READ-ONLY by default: it inspects the environment and
// prints what it found. Any mutation requires an explicit `--apply` acknowledgement, because these
// scripts talk to a live Supabase project (schema changes, auth users, trusted claims).
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function parseArgs(argv = process.argv.slice(2)) {
  const flags = new Set();
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=');
    const key = rawKey.trim();
    if (inlineValue !== undefined) {
      values[key] = inlineValue;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      values[key] = next;
      index += 1;
    } else {
      flags.add(key);
    }
  }
  return { flags, values };
}

export function applyRequested(flags) {
  return flags.has('apply');
}

export function printBanner(mode, title) {
  const line = '='.repeat(72);
  console.log(line);
  console.log(`${title}`);
  console.log(mode === 'apply'
    ? 'MODE: APPLY - this run WILL change the live project.'
    : 'MODE: READ-ONLY - this run inspects only and changes nothing. Re-run with --apply to write.');
  console.log(line);
}

export function fail(message, code = 1) {
  console.error(`\nERROR: ${message}`);
  process.exit(code);
}

export function requireValue(values, key, hint) {
  const value = String(values[key] || '').trim();
  if (!value) fail(`--${key} is required.${hint ? ` ${hint}` : ''}`);
  return value;
}

export function loadLocalEnv() {
  if (typeof process.loadEnvFile !== 'function') return null;
  const serviceDir = resolve(import.meta.dirname, '..', '..');
  const candidates = [resolve(serviceDir, '.env'), resolve(serviceDir, '../../.env')];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      process.loadEnvFile(envPath);
      return envPath;
    } catch {
      return null;
    }
  }
  return null;
}

export function mask(value) {
  const text = String(value || '');
  if (text.length <= 6) return '***';
  return `${text.slice(0, 3)}...${text.slice(-3)} (${text.length} chars)`;
}
