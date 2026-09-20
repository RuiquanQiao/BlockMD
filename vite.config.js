import { defineConfig } from 'vite';

export default defineConfig({
  root: 'app',
  server: { port: 5174, strictPort: false },
  build: { outDir: '../dist', emptyOutDir: true },
});
