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

/** @returns {Promise<string|null>} */
export async function pickOpenPath() {
  const { open } = await tauri();
  const picked = await open({ multiple: false, directory: false, filters: MD_FILTER });
  return typeof picked === 'string' ? picked : null;
}

/**
 * @param {string} defaultName
 * @returns {Promise<string|null>}
 */
export async function pickSavePath(defaultName) {
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
  if (!isDesktop) return window.confirm(message);
  const { ask } = await tauri();
  return ask(message, { title: 'BlockMD', kind: 'warning' });
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
