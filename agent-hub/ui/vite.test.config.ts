// Temporary config for the isolated test env (delete after the walkthrough).
// Mirrors vite.config.ts but proxies /api + /ws to the test backend on 4100
// instead of the live hub on 4000.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4100',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://127.0.0.1:4100',
        ws: true,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
