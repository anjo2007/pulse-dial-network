// Pulse Dial API entry point.
//
// Resolves the fail-closed configuration, wires the application and exports the Express app for
// both the Node server and the Vercel catch-all function.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createApi } from './app.js';
import { loadConfig } from './config.js';

// A test run must stay hermetic: no .env pickup (which may point at live Supabase) and no listener.
function isTestRun() {
  return process.env.NODE_ENV === 'test'
    || Boolean(process.env.NODE_TEST_CONTEXT)
    || process.argv.includes('--test')
    || process.execArgv.includes('--test');
}

function isProductionRuntime() {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL) || Boolean(process.env.VERCEL_ENV);
}

// .env is a LOCAL DEVELOPMENT convenience only.
//
// It is never loaded in a deployed runtime or during tests. Platform environment variables are the
// single source of truth in production, so a stray `.env` file that ships inside the bundle, is
// present at the repository root, or happens to exist in the process working directory can never
// inject configuration or silently repoint the API at a different Supabase project.
// Outside production only two explicit, absolute paths are considered; the service directory wins.
function loadLocalEnv() {
  if (isProductionRuntime() || isTestRun()) return null;
  if (typeof process.loadEnvFile !== 'function') return null;
  if (String(process.env.APP_ALLOW_DOTENV || '').trim().toLowerCase() === 'false') return null;
  const serviceDir = resolve(import.meta.dirname, '..');
  const candidates = [resolve(serviceDir, '.env'), resolve(serviceDir, '../../.env')];
  for (const envPath of candidates) {
    if (!existsSync(envPath)) continue;
    try {
      process.loadEnvFile(envPath);
      return envPath;
    } catch {
      return null; // Configuration problems surface through loadConfig, not as a crash.
    }
  }
  return null;
}

const loadedEnvPath = loadLocalEnv();

const config = loadConfig(process.env);
const api = createApi({ config });

// Best-effort start-up normalization. A failure never crashes module load: /health performs a live
// store probe and reports unhealthy instead, so a bad deploy fails the platform health check.
api.initialize().catch(() => {
  if (!isTestRun()) {
    console.error('Pulse Dial API: application state initialization failed; GET /health will report unhealthy until the database is reachable and migrations are applied.');
  }
});

const app = api.app;
const port = process.env.PORT || 4000;
const isDirectRun = Boolean(process.argv[1]) && (process.argv[1].endsWith('server.js') || process.argv[1].endsWith('server'));
if (!process.env.VERCEL && !isTestRun() && isDirectRun) {
  if (loadedEnvPath) console.log(`Pulse Dial API: loaded local env from ${loadedEnvPath}`);
  app.listen(port, () => console.log(`Pulse Dial API listening on http://localhost:${port}`));
}

export { app, api, config, isTestRun, isProductionRuntime };
export default app;
