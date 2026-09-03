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
    // No source maps in the served bundle (they would be public under
    // /admin/assets/*.map). Build with VITE_SOURCEMAP=1 locally to debug.
    sourcemap: process.env.VITE_SOURCEMAP === '1',
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8080',
    },
  },
});
