/**
 * Platform layer: the only place that knows whether we are a desktop app or a browser tab.
 *
 * Everything else in `app/` calls these functions and stays identical on both.
 *
 * ## Why this file handles bytes rather than text
 *
 * The project's promise is byte fidelity, and two things in the ordinary text path
 * quietly break it:
 *
 *   1. `Blob.text()` performs "UTF-8 decode", which **strips a leading BOM**. A file
 *      that had one would come back without it and be saved without it — a one-byte
 *      diff the splice layer never gets a chance to prevent, because it never sees
 *      the BOM. `TextDecoder` with `ignoreBOM: true` keeps it as U+FEFF, which is
 *      exactly what `MdDoc` expects.
 *
 *   2. A file that is not valid UTF-8 cannot round-trip through a JavaScript string
 *      at all: the invalid bytes become U+FFFD and the original is unrecoverable.
 *      Decoding with `fatal: true` turns that into a refusal to open rather than
 *      silent corruption on save.
 */

const BOM = '﻿';

export const isDesktop =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

/**
 * Decode file bytes into the string the splice layer works on.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function decodeFile(bytes) {
  try {
    return new TextDecoder('utf-8', { ignoreBOM: true, fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      'This file is not valid UTF-8. BlockMD will not open it, because it could not ' +
        'guarantee the bytes back on save.',
    );
  }
}

/** @param {string} text @returns {Uint8Array} */
export function encodeFile(text) {
  return new TextEncoder().encode(text);
}

/** @param {string} p */
export function basename(p) {
  return p.split(/[\\/]/).pop() || p;
}

/* ------------------------------------------------------------------ desktop */

async function tauri() {
  const [core, dialog] = await Promise.all([
    import('@tauri-apps/api/core'),
    import('@tauri-apps/plugin-dialog'),
  ]);
  return { ...core, ...dialog };
}

const MD_FILTER = [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdx', 'txt'] }];

/**
 * Read a file from disk as text, preserving every byte that a string can hold.
 * @param {string} path
 */
export async function readFile(path) {
  return decodeFile(await readBytes(path));
}

/** @param {string} path @returns {Promise<Uint8Array>} */
async function readBytes(path) {
  const { invoke } = await tauri();
  const res = await invoke('read_file', { path });
  // A command returning `tauri::ipc::Response` arrives as an ArrayBuffer; older
  // shapes arrive as a plain number array. Accept both rather than depend on it.
  return res instanceof ArrayBuffer
    ? new Uint8Array(res)
    : ArrayBuffer.isView(res)
      ? new Uint8Array(res.buffer, res.byteOffset, res.byteLength)
      : Uint8Array.from(res);
}

/**
 * Content types for local files shown in the page. They matter: a blob without a real
 * type is `application/octet-stream`, and a frame given one *downloads* it — a PDF
 * preview once dropped a copy into Downloads on every render.
 */
const MEDIA_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', svg: 'image/svg+xml', avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime', ogv: 'video/ogg',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', m4a: 'audio/mp4',
  flac: 'audio/flac', aac: 'audio/aac', opus: 'audio/opus', pdf: 'application/pdf',
};
/** Absolute path → object URL, so re-rendering a block doesn't re-read the file. */
const imageUrls = new Map();

/**
 * A URL the page can display for an image reference found in a document.
 *
 * A relative `src` means "next to the .md file", but the webview resolves it against
 * the app's own address, where no such file exists — every local image rendered as a
 * broken icon. Local references are therefore read from disk (through the same
 * byte-level command as documents; no fs plugin) and shown as object URLs. The `src`
 * in the document is never touched: this only affects what is displayed.
 *
 * @param {string} src The reference exactly as written in the Markdown
 * @param {string|null} docPath Absolute path of the open document, if it has one
 * @returns {Promise<string>}
 */
export async function imageUrl(src, docPath) {
  if (!src || /^(https?:|data:|blob:)/i.test(src)) return src;
  if (!isDesktop || !docPath) return src;

  let path = src.replace(/^file:\/\/\/?/i, '').replace(/[?#].*$/, '');
  try { path = decodeURI(path); } catch { /* keep it as written */ }
  const absolute = /^([a-zA-Z]:[\\/]|[\\/])/.test(path);
  const dir = docPath.slice(0, Math.max(docPath.lastIndexOf('/'), docPath.lastIndexOf('\\')));
  const full = absolute ? path : `${dir}/${path.replace(/^\.[\\/]/, '')}`;

  if (!imageUrls.has(full)) {
    const ext = full.split('.').pop().toLowerCase();
    const type = MEDIA_TYPES[ext];
    // Never hand the page an untyped blob: it would be offered as a download.
    if (!type) throw new Error(`Unsupported file type: .${ext}`);
    const blob = new Blob([await readBytes(full)], { type });
    imageUrls.set(full, URL.createObjectURL(blob));
  }
  return imageUrls.get(full);
}

/**
 * @param {string} path
 * @param {string} text
 */
export async function writeFile(path, text) {
  const { invoke } = await tauri();
  await invoke('write_file', { path, contents: Array.from(encodeFile(text)) });
}

/**
 * Dev-only stand-ins for native dialogs and window actions. scripts/parity.mjs can't
 * click a system dialog, so it sets `window.__bmdStub.<name>` to answer for it.
 * Production builds never look (import.meta.env.DEV is false there).
 */
function stub(name) {
  if (!import.meta.env?.DEV) return undefined;
  if (window.__bmdStub?.[name]) return window.__bmdStub[name];
  // Questions asked during startup (restore a draft?) come before any script could
  // install a stub, so the answer can also be left in local storage.
  if (name === 'confirm') {
    let answer = null;
    try { answer = localStorage.getItem('bmd.devConfirm'); } catch { /* none */ }
    if (answer) return () => answer === 'yes';
  }
  // While scripts/parity.mjs runs, a native dialog must never open: nothing can click
  // it, and the page freezes behind it (it happened — a draft-restore question at
  // startup blocked every check after it). Answer with the safe default instead
  // (cancel / no / do nothing) and record the attempt, which fails that check.
  // The flag comes from the environment when parity.mjs launched the app itself (in
  // force before the first page load), or from local storage when it attached to one.
  let noDialogs = import.meta.env.VITE_BMD_NO_DIALOGS === '1';
  try { noDialogs ||= localStorage.getItem('bmd.devNoDialogs') === '1'; } catch { /* no storage */ }
  if (noDialogs && name in DIALOG_DEFAULTS) {
    return (...args) => {
      try {
        const log = JSON.parse(localStorage.getItem('bmd.devBlocked') || '[]');
        log.push([name, String(args[0] ?? '').slice(0, 120)]);
        localStorage.setItem('bmd.devBlocked', JSON.stringify(log));
      } catch { /* not recorded */ }
      return DIALOG_DEFAULTS[name];
    };
  }
  return undefined;
}

/** What each native dialog answers when dialogs are switched off (see stub). */
const DIALOG_DEFAULTS = {
  pickOpenPath: null, pickSavePath: null, confirm: false, message: undefined,
  print: undefined, closeWindow: undefined, openExternal: undefined,
};

/** @returns {Promise<string|null>} */
export async function pickOpenPath() {
  if (stub('pickOpenPath')) return stub('pickOpenPath')();
  const { open } = await tauri();
  const picked = await open({ multiple: false, directory: false, filters: MD_FILTER });
  return typeof picked === 'string' ? picked : null;
}

/**
 * @param {string} defaultName
 * @returns {Promise<string|null>}
 */
export async function pickSavePath(defaultName) {
  if (stub('pickSavePath')) return stub('pickSavePath')(defaultName);
  const { save } = await tauri();
  return (await save({ defaultPath: defaultName, filters: MD_FILTER })) ?? null;
}

/** The path the app was launched with (file association / command line), if any. */
export async function startupPath() {
  if (!isDesktop) return null;
  const { invoke } = await tauri();
  return (await invoke('startup_file')) ?? null;
}

/**
 * Ask before discarding unsaved work.
 * @param {string} message
 * @returns {Promise<boolean>} true to proceed
 */
export async function confirmDiscard(message) {
  if (stub('confirm')) return stub('confirm')(message);
  if (!isDesktop) return window.confirm(message);
  const { ask } = await tauri();
  return ask(message, { title: 'BlockMD', kind: 'warning' });
}

/** Show an informational message (About, update check results). */
export async function showMessage(message, title = 'BlockMD') {
  if (stub('message')) return stub('message')(message);
  if (!isDesktop) { window.alert(message); return; }
  const { message: show } = await tauri();
  await show(message, { title, kind: 'info' });
}

/** Last-modified time of a file in ms, or null — to notice changes made elsewhere. */
export async function fileModified(path) {
  if (!isDesktop || !path) return null;
  const { invoke } = await tauri();
  return (await invoke('file_modified', { path })) ?? null;
}

/** Open a web or mail link in the default browser / mail app. */
export async function openExternal(url) {
  if (stub('openExternal')) return stub('openExternal')(url);
  if (!isDesktop) { window.open(url, '_blank', 'noopener'); return; }
  const { invoke } = await tauri();
  await invoke('open_external', { url });
}

/** Close the window; the close guard in main.js still asks about unsaved changes. */
export async function closeWindow() {
  if (stub('closeWindow')) return stub('closeWindow')();
  if (!isDesktop) { window.close(); return; }
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await getCurrentWindow().close();
}

export async function toggleFullscreen() {
  if (!isDesktop) {
    if (document.fullscreenElement) await document.exitFullscreen(); else await document.documentElement.requestFullscreen();
    return;
  }
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  await win.setFullscreen(!(await win.isFullscreen()));
}

/**
 * Zoom the whole page. The webview's own zoom, not CSS `zoom`: with CSS zoom the
 * floating menus, which are positioned from getBoundingClientRect, land in the wrong
 * place by exactly the zoom factor.
 */
export async function setZoom(level) {
  if (!isDesktop) { document.documentElement.style.zoom = String(level); return; }
  const { getCurrentWebview } = await import('@tauri-apps/api/webview');
  await getCurrentWebview().setZoom(level);
}

export function print() {
  if (stub('print')) return stub('print')();
  window.print();
}

/** The app's version, e.g. "0.1.4". */
export async function appVersion() {
  if (!isDesktop) return 'web';
  const { getVersion } = await import('@tauri-apps/api/app');
  return getVersion();
}

/**
 * Files dropped onto the window, one call per file. Desktop delivers paths, the
 * browser delivers File objects; both become `{ path, name, x, y, bytes() }`, with the
 * drop point in CSS pixels and the contents read only if the caller wants them.
 * @param {(file: {path: string|null, name: string, x: number, y: number, bytes: () => Promise<Uint8Array>}) => void} onFile
 */
export async function onFileDropped(onFile) {
  if (isDesktop) {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    await getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== 'drop') return;
      // Tauri reports physical pixels; the page works in CSS pixels.
      const scale = window.devicePixelRatio || 1;
      const x = (event.payload.position?.x ?? 0) / scale;
      const y = (event.payload.position?.y ?? 0) / scale;
      for (const path of event.payload.paths ?? []) {
        onFile({ path, name: basename(path), x, y, bytes: () => readBytes(path) });
      }
    });
    return;
  }

  window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    const files = [...(e.dataTransfer?.files ?? [])];
    if (!files.length) return;
    e.preventDefault();
    for (const file of files) {
      onFile({ path: null, name: file.name, x: e.clientX, y: e.clientY, bytes: async () => new Uint8Array(await file.arrayBuffer()) });
    }
  });
}

/**
 * Save a pasted or dropped file into an `assets` folder next to the document and
 * return the relative path to write into the Markdown. A taken name gets -1, -2, …;
 * the desktop command refuses to overwrite, so two images can never collide.
 * @param {string} docPath Absolute path of the open document
 * @param {string} name Suggested file name
 * @param {Uint8Array} bytes
 * @returns {Promise<string>} e.g. `assets/screenshot-1.png`
 */
export async function saveAsset(docPath, name, bytes) {
  const { invoke } = await tauri();
  const dir = docPath.slice(0, Math.max(docPath.lastIndexOf('/'), docPath.lastIndexOf('\\')));
  const clean = name.replace(/[\\/:*?"<>|#%]+/g, '-').replace(/\s+/g, '-') || 'image.png';
  const dot = clean.lastIndexOf('.');
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : '';
  for (let n = 0; n < 1000; n++) {
    const file = n ? `${stem}-${n}${ext}` : `${stem}${ext}`;
    try {
      await invoke('write_asset', bytes, { headers: { path: encodeURIComponent(`${dir}/assets/${file}`) } });
      return `assets/${file}`;
    } catch (err) {
      if (!/exist/i.test(String(err))) throw new Error(String(err));
    }
  }
  throw new Error('Could not find a free file name in the assets folder.');
}

/* ------------------------------------------------------------------ browser */

/**
 * Browser fallback for saving: hand the bytes to the download manager.
 * @param {string} name
 * @param {string} text
 */
export function downloadText(name, text) {
  const blob = new Blob([encodeFile(text)], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

export { BOM };
