import { defineConfig } from 'vite';

export default defineConfig({
  root: 'app',
  // strictPort matters for the desktop build: src-tauri/tauri.conf.json hard-codes
  // devUrl http://localhost:5174. If Vite quietly moved to 5175 on a port clash, the
  // app window would load whatever stale server still holds 5174 — so fail loudly.
  server: { port: 5174, strictPort: true },
  build: { outDir: '../dist', emptyOutDir: true },
});
