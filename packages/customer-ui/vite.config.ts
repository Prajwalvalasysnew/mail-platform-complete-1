import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_ORIGIN = process.env.CUSTOMER_API_ORIGIN ?? 'http://127.0.0.1:3000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '^/api(?:/|$)': {
        target: API_ORIGIN,
        changeOrigin: true,
        xfwd: true,
        rewrite: (path) => path.replace(/^\/api(?=\/|$)/, '/v1'),
      },
    },
  },
  build: { sourcemap: process.env.CUSTOMER_UI_SOURCEMAPS==='true', assetsDir: 'assets' },
});
