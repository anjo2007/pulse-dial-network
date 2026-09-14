#!/usr/bin/env node
// Pulse Dial - hospital operator account provisioning.
//
// READ-ONLY BY DEFAULT: it lists the project's auth users, finds the requested email and reports
// whether the account carries the TRUSTED claims the API requires (`app_metadata.role = "hospital"`
// and a non-empty `app_metadata.hospital_id`). A valid password alone proves nothing: the API
// refuses hospital access to any Supabase email account without those service-side claims, so a
// self-signup can never become an operator.
//
//   node scripts/create-hospital-user.js --email ops@hospital.example        # inspect only
//   node scripts/create-hospital-user.js --email ops@hospital.example \
//        --hospital-id hospital-central --apply                             # provision
//
// Notes:
//  * No default/demo password. If --password is omitted a random one is generated and printed once.
//  * Claims are written to app_metadata only. user_metadata is user-editable and is never set.
import { randomBytes } from 'node:crypto';
import { createClient } from '@supabase/supabase-js';
import { applyRequested, fail, loadLocalEnv, mask, parseArgs, printBanner, requireValue } from './lib/cli.js';

const TENANT_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;

function generatePassword() {
  // 24 random bytes -> url-safe, no ambiguous default password anywhere in the repo.
  return `Pd-${randomBytes(24).toString('base64url')}`;
}

// Paginated lookup. Reading only the first page silently reported "not found" for any project with
// more than one page of users, which could lead an operator to re-create an existing account.
async function listAllUsers(supabase, { perPage = 200, maxPages = 25 } = {}) {
  const users = [];
  for (let page = 1; page <= maxPages; page += 1) {
    const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
    if (error) return { error };
    const batch = data?.users || [];
    users.push(...batch);
    if (batch.length < perPage) return { users, truncated: false };
  }
  return { users, truncated: true };
}

async function main() {
  const { flags, values } = parseArgs();
  const apply = applyRequested(flags);
  printBanner(apply ? 'apply' : 'read', 'Pulse Dial - hospital operator account');

  const envPath = loadLocalEnv();
  if (envPath) console.log(`Local env loaded from ${envPath}`);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) fail('SUPABASE_URL and SUPABASE_SECRET_KEY must be set in the environment.');

  const email = String(values.email || process.env.HOSPITAL_EMAIL || '').trim().toLowerCase();
  if (!email) fail('--email is required (the operator login).');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail(`"${email}" is not a valid email address.`);

  const hospitalId = String(values['hospital-id'] || process.env.HOSPITAL_ID || '').trim();
  const requestedPassword = String(values.password || '').trim();

  const supabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  console.log(`Project: ${url}`);
  console.log(`Operator email: ${email}\n`);

  const listed = await listAllUsers(supabase);
  if (listed.error) fail(`Could not list auth users: ${listed.error.message}`);
  if (listed.truncated) {
    console.log('WARNING: user listing was truncated at the page cap; an existing account may not have been found.\n');
  }
  const users = listed.users;
  const existing = users.find(user => String(user.email || '').toLowerCase() === email) || null;

  const describe = (user) => {
    if (!user) return 'missing';
    const trusted = user.app_metadata || {};
    const untrusted = user.user_metadata || {};
    const role = trusted.role ?? '(none)';
    const tenant = trusted.hospital_id ?? '(none)';
    const lines = [`app_metadata.role=${role}`, `app_metadata.hospital_id=${tenant}`];
    if (untrusted.role !== undefined || untrusted.hospital_id !== undefined) {
      lines.push('WARNING: user_metadata carries role/hospital_id, which the API ignores; remove it to avoid confusion.');
    }
    return lines.join(' | ');
  };

  console.log(`Account status: ${existing ? `found (${existing.id})` : 'not found'}`);
  console.log(`Trusted claims: ${describe(existing)}\n`);

  const claimsOk = Boolean(existing)
    && existing.app_metadata?.role === 'hospital'
    && TENANT_PATTERN.test(String(existing.app_metadata?.hospital_id || ''));

  if (!apply) {
    console.log(claimsOk
      ? 'READ-ONLY: this account already has the trusted hospital claims the API requires.'
      : 'READ-ONLY: this account is NOT yet a valid hospital operator.');
    console.log('Nothing was changed. To provision, re-run with:');
    console.log(`  --apply --email ${email} --hospital-id <tenant id>${requestedPassword ? ' --password <password>' : ''}`);
    if (!claimsOk) process.exitCode = 1;
    return;
  }

  if (!hospitalId) fail('--hospital-id is required with --apply (it becomes the tenant id used for isolation).');
  if (hospitalId.startsWith('user:') || !TENANT_PATTERN.test(hospitalId)) {
    fail(`--hospital-id "${hospitalId}" is invalid: use 1-64 characters of A-Z a-z 0-9 . _ : - and never a "user:" prefixed id.`);
  }

  // Service-controlled claims only; user_metadata is deliberately never written.
  const appMetadata = { role: 'hospital', hospital_id: hospitalId };

  if (existing) {
    const update = { app_metadata: appMetadata };
    if (requestedPassword) update.password = requestedPassword;
    const { error: updateError } = await supabase.auth.admin.updateUserById(existing.id, update);
    if (updateError) fail(`Could not update the operator account: ${updateError.message}`);
    console.log(`Updated ${email}: app_metadata.role=hospital, app_metadata.hospital_id=${hospitalId}`);
    if (!requestedPassword) console.log('Password unchanged.');
  } else {
    const password = requestedPassword || generatePassword();
    const { error: createError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      app_metadata: appMetadata,
    });
    if (createError) fail(`Could not create the operator account: ${createError.message}`);
    console.log(`Created ${email}`);
    console.log(`  app_metadata.role=hospital, app_metadata.hospital_id=${hospitalId}`);
    if (!requestedPassword) {
      console.log(`  Generated password (shown once): ${password}`);
      console.log('  Store it in a password manager now; it is not recoverable from this output.');
    }
  }

  const verified = await listAllUsers(supabase);
  if (verified.error) fail(`Applies may have succeeded, but verification failed: ${verified.error.message}`);
  const after = verified.users.find(user => String(user.email || '').toLowerCase() === email) || null;
  if (!after || after.app_metadata?.role !== 'hospital' || after.app_metadata?.hospital_id !== hospitalId) {
    fail('Verification failed: trusted claims are not present after the write. Do not use this account.');
  }
  console.log('\nVerified: trusted claims are present. The account can now sign in to the hospital console.');
  console.log(`Service key used: ${mask(key)}`);
}

main().catch(error => fail(error?.message || String(error)));
