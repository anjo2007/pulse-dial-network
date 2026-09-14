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
const HOSPITAL_EMAIL = process.env.HOSPITAL_EMAIL || 'admin@centralhospital.demo';
const HOSPITAL_PASSWORD = process.env.HOSPITAL_PASSWORD || 'demo123';

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY before creating the hospital user.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SECRET_KEY, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
});

const { data, error } = await supabase.auth.admin.createUser({
  email: HOSPITAL_EMAIL,
  password: HOSPITAL_PASSWORD,
  email_confirm: true,
  app_metadata: { role: 'hospital' },
  user_metadata: { role: 'hospital' },
});

if (error) {
  if (error.message.includes('already exists') || error.message.includes('unique constraint')) {
    console.log(`Hospital user ${HOSPITAL_EMAIL} already exists in Supabase Auth.`);
  } else {
    throw error;
  }
} else {
  console.log(`Created verified hospital user ${data.user.id} for ${data.user.email}.`);
}
