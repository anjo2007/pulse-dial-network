#!/usr/bin/env node
// Pulse Dial - Supabase schema CHECKER (read-only, always).
//
// This script never applies DDL. An automated migrator that runs arbitrary SQL against a live
// project from CI or a developer laptop is a foot-gun: it cannot ask for confirmation, it hides
// failures behind a retry, and it may run a destructive statement twice. Instead this script:
//   1. verifies EVERY migration artifact against the live project (not just the first one),
//   2. prints the exact files to run and the manual verification queries.
//
//   node scripts/init-supabase.js
//
// Apply migrations by pasting them into the Supabase SQL editor (or a reviewed migration step):
//   001_app_state.sql                  app_state table
//   002_app_state_version.sql          app_state.version + RLS
//   003_realtime_private_broadcast.sql private realtime topics + broadcast trigger
//   004_rate_limit.sql                 rate_limit_hit() - REQUIRED, the API fails closed without it
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { fail, loadLocalEnv, mask } from './lib/cli.js';

// Resolve the migrations directory by walking up from this file until it is found. Deriving it from
// a fixed "../../../" hop was fragile: one directory off and the checker inspected a non-existent
// path (and therefore reported everything as missing).
function findMigrationsDir(startDir = import.meta.dirname) {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = resolve(dir, 'supabase', 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const MANUAL_POLICY_QUERY = "select policyname from pg_policies where schemaname = 'realtime' and tablename = 'messages';";

async function main() {
  console.log('='.repeat(72));
  console.log('Pulse Dial - Supabase schema check (READ-ONLY: nothing is written)');
  console.log('='.repeat(72));

  const envPath = loadLocalEnv();
  if (envPath) console.log(`Local env loaded from ${envPath}`);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail('SUPABASE_URL and SUPABASE_SECRET_KEY must be set in the environment.');

  const migrationsDir = findMigrationsDir();
  if (!migrationsDir) fail('Could not locate supabase/migrations from this script location.');
  const migrations = readdirSync(migrationsDir).filter(file => file.endsWith('.sql')).sort();

  console.log(`Project: ${url}`);
  console.log(`Service key: ${mask(key)}`);
  console.log(`Migrations on disk (${migrationsDir}):\n  ${migrations.join('\n  ')}\n`);

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  const results = [];

  // --- 001 + 002: state row and its optimistic-concurrency column -------------------------------
  let stateRow = null;
  try {
    const { data, error } = await supabase.from('app_state').select('id, version, updated_at').eq('id', 'primary').maybeSingle();
    if (error) {
      if (error.code === '42P01') {
        results.push({ artifact: 'app_state table', file: '001_app_state.sql', ok: false, detail: 'table missing' });
      } else if (String(error.message || '').toLowerCase().includes('version')) {
        results.push({ artifact: 'app_state table', file: '001_app_state.sql', ok: true, detail: 'table present' });
        results.push({ artifact: 'app_state.version', file: '002_app_state_version.sql', ok: false, detail: 'column missing' });
      } else {
        fail(`Schema check failed: ${error.message}`);
      }
    } else {
      stateRow = data;
      results.push({ artifact: 'app_state table', file: '001_app_state.sql', ok: true, detail: 'table present' });
      const versionPresent = data ? data.version !== null && data.version !== undefined : true;
      results.push({
        artifact: 'app_state.version',
        file: '002_app_state_version.sql',
        ok: versionPresent,
        detail: data ? (versionPresent ? `primary row at version ${data.version}` : 'column missing on the existing row') : 'table empty; the API seeds version 1 on first boot',
      });
    }
  } catch (error) {
    fail(`Could not reach the project: ${error.message}`);
  }

  // --- 003: private realtime topics -------------------------------------------------------------
  try {
    const { error } = await supabase.schema('realtime').from('messages').select('id').limit(1);
    if (error) {
      results.push({ artifact: 'realtime.messages', file: '003_realtime_private_broadcast.sql', ok: false, detail: error.message });
    } else {
      results.push({
        artifact: 'realtime.messages policy',
        file: '003_realtime_private_broadcast.sql',
        ok: null,
        detail: `table reachable; confirm the private-topic policy manually: ${MANUAL_POLICY_QUERY}`,
      });
    }
  } catch (error) {
    results.push({ artifact: 'realtime.messages', file: '003_realtime_private_broadcast.sql', ok: false, detail: String(error?.message || error) });
  }

  // --- 004: read-only table probe. Never invoke rate_limit_hit: it writes counters.
  try {
    const { error } = await supabase.from('rate_limit_windows').select('bucket').limit(0);
    if (error) {
      results.push({
        artifact: 'rate_limit_hit()',
        file: '004_rate_limit.sql',
        ok: false,
        detail: error.code === 'PGRST202' ? 'function missing - authentication will fail closed (HTTP 503)' : error.message,
      });
    } else {
      results.push({ artifact: 'rate_limit_hit()', file: '004_rate_limit.sql', ok: null, detail: 'Counter table exists. Confirm function/ACL manually: select to_regprocedure(\'public.rate_limit_hit(text,integer,integer)\'); No counter was incremented.' });
    }
  } catch (error) {
    results.push({ artifact: 'rate_limit_hit()', file: '004_rate_limit.sql', ok: false, detail: String(error?.message || error) });
  }

  console.log('Artifact check');
  console.log('-'.repeat(72));
  const missing = [];
  for (const result of results) {
    const mark = result.ok === true ? 'OK   ' : result.ok === false ? 'MISS ' : 'CHECK';
    console.log(`${mark} ${result.artifact.padEnd(26)} ${result.file}${result.detail ? `\n      ${result.detail}` : ''}`);
    if (result.ok === false) missing.push(result);
  }

  if (missing.length === 0) {
    console.log('-'.repeat(72));
    console.log('\nAll automatically verifiable artifacts are present.');
    console.log('If realtime signals are needed, confirm the 003 policy with the query shown above.');
    console.log('Next: node scripts/create-hospital-user.js --email <operator email> --hospital-id <tenant id>');
    return;
  }

  console.log('-'.repeat(72));
  console.log(`\n${missing.length} artifact(s) missing. Apply these files in the Supabase SQL editor, in order:`);
  for (const file of migrations) {
    console.log(`  ${resolve(migrationsDir, file)}`);
  }
  console.log('\nThen re-run this checker. Do not point the API at an unmigrated project:');
  console.log('  * 004 missing  -> credential endpoints answer 503 (fail closed)');
  console.log('  * 002 missing  -> state writes cannot be fenced, the API reports unhealthy');
  if (stateRow) console.log(`\nCurrent state row: version=${stateRow.version ?? '(none)'} updated_at=${stateRow.updated_at ?? '(none)'}`);
  process.exitCode = 1;
}

main().catch(error => fail(error?.message || String(error)));
