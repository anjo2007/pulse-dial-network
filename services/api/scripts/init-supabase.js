import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createClient } from '@supabase/supabase-js';

// Automatically load .env if present
if (typeof process.loadEnvFile === 'function') {
  const candidatePaths = [
    resolve(process.cwd(), '.env'),
    resolve(process.cwd(), '../../.env'),
    resolve(import.meta.dirname, '../../.env'),
    resolve(import.meta.dirname, '../.env'),
  ];
  for (const envPath of candidatePaths) {
    if (existsSync(envPath)) {
      try { process.loadEnvFile(envPath); break; } catch (_) {}
    }
  }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_PUBLISHABLE_KEY = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY;
const HOSPITAL_EMAIL = process.env.HOSPITAL_EMAIL || 'admin@centralhospital.demo';
const HOSPITAL_PASSWORD = process.env.HOSPITAL_PASSWORD || 'demo123';

async function main() {
  console.log('=== Pulse Dial Supabase Initializer & Health Check ===\n');

  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
    console.error('Error: Missing Supabase credentials in environment.');
    console.error('Please configure SUPABASE_URL and SUPABASE_SECRET_KEY in your .env file or environment variables.\n');
    process.exitCode = 1;
    return;
  }

  console.log(`Connecting to Supabase at: ${SUPABASE_URL}`);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });

  try {
    console.log('1. Checking database connection and public.app_state table...');
    const { data, error } = await supabase.from('app_state').select('id, updated_at').eq('id', 'primary').maybeSingle();

    if (error) {
      if (error.code === '42P01' || error.code === 'PGRST205' || (error.message && error.message.includes('schema cache'))) {
        console.error('\nTable public.app_state was NOT found in your Supabase database.');
        console.error('Please run the following SQL in your Supabase Dashboard SQL Editor:\n');
        console.log('----------------------------------------------------');
        console.log(`create table if not exists public.app_state (
  id text primary key,
  state jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.app_state enable row level security;
revoke all on public.app_state from anon, authenticated;`);
        console.log('----------------------------------------------------\n');
        process.exitCode = 1;
        return;
      }
      throw error;
    }

    console.log('   ✓ public.app_state table is present and accessible.');
    if (data) {
      console.log(`   ✓ Found existing application state record (last updated: ${data.updated_at}).`);
    } else {
      console.log('   ✓ Initializing primary state record...');
      const { error: initError } = await supabase.from('app_state').upsert({
        id: 'primary',
        state: { donors: [], requests: [], assignments: [] },
        updated_at: new Date().toISOString(),
      });
      if (initError) throw initError;
      console.log('   ✓ Primary state record created.');
    }

    console.log('\n2. Verifying hospital administrator authentication user...');
    const { data: usersData, error: listError } = await supabase.auth.admin.listUsers();
    if (listError) {
      console.warn(`   Notice: Could not list users: ${listError.message}`);
    } else {
      const existing = usersData.users.find(u => u.email === HOSPITAL_EMAIL);
      if (existing) {
        console.log(`   ✓ Verified hospital user exists: ${existing.email} (id: ${existing.id})`);
      } else {
        console.log(`   Creating hospital user: ${HOSPITAL_EMAIL}...`);
        const { data: created, error: createError } = await supabase.auth.admin.createUser({
          email: HOSPITAL_EMAIL,
          password: HOSPITAL_PASSWORD,
          email_confirm: true,
          app_metadata: { role: 'hospital' },
        });
        if (createError) {
          console.warn(`   Could not create hospital user automatically: ${createError.message}`);
        } else {
          console.log(`   ✓ Created hospital user ${created.user.id} for ${created.user.email}`);
        }
      }
    }

    console.log('\n=== Supabase configuration is fully verified and ready for global syncing! ===\n');
  } catch (err) {
    console.error('\nError initializing Supabase:', err.message);
    process.exitCode = 1;
  }
}

main();
