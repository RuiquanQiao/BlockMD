import { defineConfig } from 'vite';

/**
 * KaTeX's stylesheet lists every font three times (woff2, woff, ttf), and Vite ships
 * every file a stylesheet references — about 1.1 MB of fonts, where WebView2 and
 * WKWebView only ever load the woff2 (~300 KB). Keeping the installer small is P2, so
 * drop the other two formats from the stylesheet before Vite sees it.
 */
const katexWoff2Only = {
  name: 'katex-woff2-only',
  enforce: 'pre',
  transform(code, id) {
    if (!/katex[\\/]dist[\\/]katex(\.min)?\.css/.test(id)) return null;
    return code.replace(/,\s*url\([^)]+\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, '');
  },
};

export default defineConfig({
  root: 'app',
  plugins: [katexWoff2Only],
  // strictPort matters for the desktop build: src-tauri/tauri.conf.json hard-codes
  // devUrl http://localhost:5174. If Vite quietly moved to 5175 on a port clash, the
  // app window would load whatever stale server still holds 5174 — so fail loudly.
  server: { port: 5174, strictPort: true },
  build: { outDir: '../dist', emptyOutDir: true },
});
