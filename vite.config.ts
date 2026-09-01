import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  root: 'web',
  base: '/admin/',
  plugins: [react()],
  build: {
    // Must not collide with tsc's output for src/admin/*.ts (dist/admin/):
    // emptyOutDir would delete the server's auth/session modules.
    outDir: fileURLToPath(new URL('./dist/admin-ui', import.meta.url)),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
