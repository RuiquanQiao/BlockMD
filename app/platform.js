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
  const { invoke } = await tauri();
  const res = await invoke('read_file', { path });
  // A command returning `tauri::ipc::Response` arrives as an ArrayBuffer; older
  // shapes arrive as a plain number array. Accept both rather than depend on it.
  const bytes =
    res instanceof ArrayBuffer
      ? new Uint8Array(res)
      : ArrayBuffer.isView(res)
        ? new Uint8Array(res.buffer, res.byteOffset, res.byteLength)
        : Uint8Array.from(res);
  return decodeFile(bytes);
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
 * Files dropped onto the window. Desktop delivers paths, the browser delivers File
 * objects, so both are normalised to `{ path, name, text }`.
 * @param {(file: {path: string|null, name: string, text: string}) => void} onFile
 */
export async function onFileDropped(onFile) {
  if (isDesktop) {
    const { getCurrentWebview } = await import('@tauri-apps/api/webview');
    await getCurrentWebview().onDragDropEvent(async (event) => {
      if (event.payload.type !== 'drop') return;
      const path = event.payload.paths?.[0];
      if (!path) return;
      onFile({ path, name: basename(path), text: await readFile(path) });
    });
    return;
  }

  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (!file) return;
    onFile({
      path: null,
      name: file.name,
      text: decodeFile(new Uint8Array(await file.arrayBuffer())),
    });
  });
}

/**
 * A newer published release, or null. Desktop release builds only: a browser tab has
 * nothing to update, and a dev build would always find the last release "newer" or
 * try to replace itself with an installer.
 * @returns {Promise<import('@tauri-apps/plugin-updater').Update|null>}
 */
export async function checkForUpdate() {
  if (!isDesktop || import.meta.env?.DEV) return null;
  const { check } = await import('@tauri-apps/plugin-updater');
  return check();
}

/** Restart the app after an update has been installed (macOS; Windows restarts by itself). */
export async function relaunch() {
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
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
