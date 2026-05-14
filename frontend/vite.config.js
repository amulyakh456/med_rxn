import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Frontend talks to backend on :3001 — proxy /api so the React app can use
// relative URLs (which is how it'd integrate into recordrx in production).
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
});
