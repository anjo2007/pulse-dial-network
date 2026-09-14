// Hermetic integration host: production-built UI + real API/domain with memory-only demo data.
// Intentionally never imports server.js, dotenv or ambient provider credentials.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createApi } from '../services/api/src/app.js';
import { loadConfig } from '../services/api/src/config.js';
const require = createRequire(new URL('../services/api/package.json', import.meta.url));
const express = require('express');
const config = loadConfig({ DEMO_MODE: 'true' });
const api = createApi({ config, dryRunPush: true, fetchImpl: () => { throw new Error('External networking forbidden in E2E host'); } });
await api.initialize();
const outer = express();
outer.use('/api', api.app);
const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
outer.use((_req, res, next) => {
  for (const header of vercel.headers[0].headers) {
    if (header.key === 'Strict-Transport-Security') continue;
    res.set(header.key, header.value.replace('; upgrade-insecure-requests', ''));
  }
  next();
});
const dist = fileURLToPath(new URL('../apps/portal/dist/', import.meta.url));
outer.use(express.static(dist));
outer.get('*', (_req, res) => res.sendFile('index.html', { root: dist }));
const server = outer.listen(4280, '127.0.0.1');
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
