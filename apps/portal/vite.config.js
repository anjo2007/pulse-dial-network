import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
    // The portal always talks to a same-origin /api path (Vercel rewrites it in
    // production), so dev proxies to the local API instead of hardcoding a host.
    // This removes the CORS/mixed-content class of bug entirely.
    proxy: {
      '/api': {
        target: process.env.VITE_DEV_API_TARGET || 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
});
