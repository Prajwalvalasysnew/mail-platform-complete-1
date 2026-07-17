import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The admin console never talks to the API origin directly. In production a
// same-origin gateway maps admin.<domain>/api/* -> core API /admin/* (see
// docs/frontend-architecture). The dev server mirrors that exact contract so
// browser code only ever fetches relative /api/* paths.
const API_ORIGIN = process.env.ADMIN_API_ORIGIN ?? 'http://localhost:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: API_ORIGIN,
        changeOrigin: true,
        // Forward X-Forwarded-Host so the API's cookie-session Origin check
        // compares against the browser-facing host (5174), not the target.
        xfwd: true,
        rewrite: (path) => path.replace(/^\/api/, '/admin'),
      },
    },
  },
  build: {
    sourcemap: true,
    // Immutable, content-hashed assets per the deployment contract.
    assetsDir: 'assets',
  },
});
