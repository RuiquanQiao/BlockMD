/**
 * BlockMD application entry point: the document lifecycle, menus and shortcuts.
 *
 * What a desktop editor is expected to do lives here — new / open / recent / save /
 * save as / close, reopening the last file, noticing when another program changes the
 * file, recovering unsaved work after a crash, zoom, fullscreen, print. The list it is
 * checked against is parity/editor.json (`npm run parity`).
 *
 * The fidelity indicator in the status bar is deliberate: it turns the project's
 * central — and most easily broken — promise into something visible at all times.
 * With no edits it must read "byte-identical to disk".
 *
 * File I/O lives in `platform.js`; this file never touches the filesystem directly,
 * so the desktop and browser builds differ in exactly one module.
 */

import { createEditor, editorViewCtx } from './editor/create-editor.js';
import { TextSelection, NodeSelection } from '@milkdown/prose/state';
import { undo, redo } from '@milkdown/prose/history';
import { DocumentSession } from './session.js';
import * as platform from './platform.js';
import { startUpdateChecks, checkForUpdatesNow } from './updater.js';
import { setImageBase, insertImages, IMAGE_FILE } from './editor/image.js';
import { setUpPageStyle, pageStyle, setPageStyle } from './page-style.js';
import { setUpOutline } from './outline.js';
import { setUpAppMenu } from './app-menu.js';
import { openFind, openReplace } from './editor/find.js';
import { copyAsMarkdown } from './editor/clipboard-extras.js';
import { TEST_HOOKS } from './test-hooks.js';

const UNTITLED = 'Untitled.md';
const MARKDOWN_FILE = /\.(md|markdown|mdx|txt)$/i;

const el = {
  editor: document.getElementById('editor'),
  filename: document.getElementById('filename'),
  statusbar: document.getElementById('statusbar'),
  dot: document.getElementById('status-dot'),
  text: document.getElementById('status-text'),
  words: document.getElementById('stat-words'),
  blocks: document.getElementById('stat-blocks'),
  hidden: document.getElementById('stat-hidden'),
  sourcePane: document.getElementById('source-pane'),
  sourceBody: document.getElementById('source-body'),
  sourceNote: document.getElementById('source-note'),
  workspace: document.querySelector('.workspace'),
  btnMenu: document.getElementById('btn-menu'),
  btnSource: document.getElementById('btn-source'),
  btnOpen: document.getElementById('btn-open'),
  btnSave: document.getElementById('btn-save'),
  fileInput: document.getElementById('file-input'),
};

let session = null;
let editor = null;
let showSource = false;
/** Absolute path on disk, or null for an untitled document / a browser tab. */
let currentPath = null;
/** The file's modified time when we last read or wrote it (see watchDisk). */
let diskTime = null;
/** Set while a transient message is showing, so refresh() does not overwrite it. */
let flashTimer = null;

/* ------------------------------------------------------------ remembered state */

// Small per-app memory: recent files, the file to reopen, an unsaved draft, zoom.
// Local storage can be unavailable (private mode) — everything must work without it.
const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(`bmd.${key}`); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(`bmd.${key}`, JSON.stringify(value)); } catch { /* not remembered */ }
  },
  remove(key) {
    try { localStorage.removeItem(`bmd.${key}`); } catch { /* nothing to remove */ }
  },
};

const recentFiles = () => store.get('recent', []);
function remember(path) {
  if (!path) return;
  store.set('recent', [path, ...recentFiles().filter((p) => p !== path)].slice(0, 10));
  // Reopened next launch — as in Typora: the last file you opened or edited.
  store.set('lastFile', path);
}
function forget(path) {
  store.set('recent', recentFiles().filter((p) => p !== path));
}

/* --------------------------------------------------------------- status bar */

function view() {
  let v = null;
  editor?.action((ctx) => { v = ctx.get(editorViewCtx); });
  return v;
}

function isDirty() {
  if (session?.restored) return true;
  const s = session?.status();
  return Boolean(s?.ok && !s.identical);
}

function flash(message, kind = 'err') {
  clearTimeout(flashTimer);
  el.dot.className = 'dot ' + kind;
  el.text.textContent = message;
  el.text.title = '';
  flashTimer = setTimeout(() => {
    flashTimer = null;
    refresh();
  }, 4000);
}

/** Words as a reader counts them: Latin words, plus each CJK character. */
function countWords(text) {
  const cjk = (text.match(/[぀-ヿ㐀-鿿豈-﫿가-힯]/g) || []).length;
  const latin = (text.replace(/[぀-ヿ㐀-鿿豈-﫿가-힯]/g, ' ').match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
  return cjk + latin;
}

function refresh() {
  if (!session) return;
  const s = session.status();

  setWindowTitle();
  // Blocks separated by a space: textContent runs them together ("Alpha" + "One" was
  // one word "AlphaOne").
  const doc = view()?.state.doc;
  const words = countWords(doc ? doc.textBetween(0, doc.content.size, ' ', ' ') : '');
  el.words.textContent = `${words} ${words === 1 ? 'word' : 'words'}`;
  outline?.update();

  if (flashTimer) return;

  if (!s.ok) {
    el.statusbar.classList.add('err');
    el.dot.className = 'dot err';
    el.text.textContent = 'Mapping check failed — incremental save disabled';
    el.text.title = s.message ?? '';
    el.blocks.textContent = '';
    el.hidden.textContent = '';
    return;
  }

  el.statusbar.classList.remove('err');
  const dirty = isDirty();
  el.dot.className = 'dot ' + (dirty ? 'edited' : 'ok');
  el.text.textContent = session.restored
    ? 'Recovered unsaved changes — save to keep them'
    : !currentPath && !dirty
      ? 'New document'
      : s.identical
        ? 'Byte-identical to disk'
        : `Modified · ${s.fresh} new block(s) to serialize, ${s.reused} kept verbatim`;
  el.text.title = '';

  const blocks = s.reused + s.fresh;
  el.blocks.textContent = `${blocks} ${blocks === 1 ? 'block' : 'blocks'}`;
  el.hidden.textContent = s.hidden > 0 ? `${s.hidden} hidden block(s) held by splice layer` : '';

  if (showSource) {
    const out = session.save();
    el.sourceBody.textContent = out;
    el.sourceNote.textContent = `${out.length} bytes${s.identical ? ' · unchanged' : ''}`;
  }
}

async function setWindowTitle() {
  const mark = isDirty() ? ' •' : '';
  const name = session?.name ?? 'BlockMD';
  el.filename.textContent = name + mark;
  el.filename.title = currentPath ?? '';
  document.title = `${name}${mark} — BlockMD`;
  if (platform.isDesktop) {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setTitle(`${name}${mark} — BlockMD`);
  }
}

/* ------------------------------------------------------------ unsaved drafts */

// While a document has unsaved changes, its current contents are kept as a draft. If
// BlockMD crashes or is killed, the next launch offers them back (Typora's "Recover
// Unsaved Drafts"). Saving, or choosing to discard, clears the draft.
let draftTimer = null;
function scheduleDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    if (!session) return;
    if (isDirty()) {
      store.set('draft', { path: currentPath, name: session.name, text: session.save(), time: Date.now() });
      // Editing a file makes it the one to reopen next time.
      if (currentPath) store.set('lastFile', currentPath);
    } else {
      store.remove('draft');
    }
  }, 600);
}
const clearDraft = () => { clearTimeout(draftTimer); store.remove('draft'); };

/* ------------------------------------------------------------------ loading */

async function load(source, name, path = null, { restored = false } = {}) {
  if (editor) {
    await editor.destroy();
    el.editor.textContent = '';
  }
  currentPath = path;
  setImageBase(path);
  session = new DocumentSession(source, name);
  session.restored = restored;
  el.filename.textContent = name;
  diskTime = await platform.fileModified(path);

  editor = await createEditor({
    root: el.editor,
    value: session.doc.body,
    tree: session.doc.tree, // parsed once, for both sides (editor/reuse-parse.js)
    onChange: () => { refresh(); scheduleDraft(); },
  });

  editor.action((ctx) => {
    const gate = session.attach(ctx);
    if (!gate.safe) console.warn('[BlockMD] ' + gate.message);
  });

  // Development hook for inspecting the save plan and fidelity state, and for driving
  // the app from outside (scripts/cdp.mjs, scripts/parity.mjs). Synthetic keystrokes
  // sent with Windows' SendInput never reach WebView2, so desktop checks go through
  // the debugging protocol instead.
  if (TEST_HOOKS) {
    window.__bmd = {
      get session() { return session; },
      get editor() { return editor; },
      get path() { return currentPath; },
      get dirty() { return isDirty(); },
      refresh,
      save: saveFile,
      open: openFile,
      /** Open a file by path without a dialog. */
      async openPath(p) { await load(await platform.readFile(p), platform.basename(p), p); },
      /** A new, empty, unsaved document — nothing on disk for the watcher to look at. */
      blank: () => load('', UNTITLED, null),
      /** The drop handler, minus the OS drag (which the debugging protocol can't make). */
      drop: handleDrop,
      checkDisk: watchDisk,
      pm: { TextSelection, NodeSelection },
      view,
    };
  }

  refresh();
}

/** Guarded load: refuses to throw away unsaved edits without asking. */
async function loadGuarded(source, name, path) {
  if (!(await confirmLeave())) return false;
  await load(source, name, path);
  // Ready to type, as after launch and Ctrl+N — every way of opening a file (Ctrl+O,
  // Open Recent, dropping one) comes through here. (A reload by the disk watcher
  // doesn't, so it never pulls focus from, say, the find bar.)
  view()?.focus();
  return true;
}

/** Ask before leaving a document with unsaved changes. true = go ahead. */
async function confirmLeave(verb = 'Discard them') {
  if (!isDirty()) return true;
  const ok = await platform.confirmDiscard(`${session.name} has unsaved changes. ${verb}?`);
  if (ok) clearDraft();
  return ok;
}

/* ------------------------------------------------------------ file commands */

async function newDocument() {
  if (!(await confirmLeave())) return;
  store.remove('lastFile');
  await load('', UNTITLED, null);
  view()?.focus();
}

async function openPath(path) {
  try {
    const text = await platform.readFile(path);
    if (await loadGuarded(text, platform.basename(path), path)) remember(path);
  } catch (err) {
    forget(path);
    flash(`Can't open ${platform.basename(path)} — ${String(err.message ?? err)}`);
  }
}

async function openFile() {
  if (!platform.isDesktop) {
    el.fileInput.click();
    return;
  }
  const path = await platform.pickOpenPath();
  if (path) await openPath(path);
}

async function saveFile({ saveAs = false } = {}) {
  if (!session) return;

  const s = session.status();
  if (!s.ok) {
    flash('Refusing to save: block mapping is unsafe. Reopen the file.');
    return;
  }

  const out = session.save();

  if (!platform.isDesktop) {
    // A browser tab cannot write back to where the file came from.
    platform.downloadText(session.name, out);
    return;
  }

  try {
    let path = currentPath;
    if (!path || saveAs) {
      path = await platform.pickSavePath(session.name);
      if (!path) return;
    }
    await platform.writeFile(path, out);
    currentPath = path;
    diskTime = await platform.fileModified(path);
    setImageBase(path);
    session.name = platform.basename(path);
    // Adopt what we just wrote as the new baseline, so the indicator goes back to
    // "byte-identical to disk" and the next save reuses these bytes verbatim.
    session.commit(out);
    session.restored = false;
    clearDraft();
    remember(path);
    refresh();
    flash(`Saved · ${out.length} bytes`, 'ok');
  } catch (err) {
    // A read-only file, a vanished folder, a full disk: the text stays, still unsaved.
    flash(`Save failed — ${String(err.message ?? err)}`);
  }
}

/* ------------------------------------------------ changes made by other programs */

// Another program (git checkout, a sync client, another editor) may change the open
// file. With no unsaved changes here, BlockMD quietly shows the new version; with
// unsaved changes it asks, and keeps yours unless you choose to reload.
let checkingDisk = false;
async function watchDisk() {
  if (!currentPath || checkingDisk) return;
  checkingDisk = true;
  // The file this check is about. Another document can be opened while it waits; the
  // answer about the old file must then not be applied to the new one (it once recorded
  // the old file's time against the new document, and the next check "saw" a change).
  const path = currentPath;
  try {
    const now = await platform.fileModified(path);
    if (path !== currentPath || now == null || diskTime == null || now === diskTime) return;
    diskTime = now;
    if (isDirty()) {
      const reload = await platform.confirmDiscard(
        `${session.name} was changed by another program. Reload it and lose your unsaved changes here?`,
      );
      if (!reload || path !== currentPath) return;
      clearDraft();
    }
    await load(await platform.readFile(path), session.name, path);
    flash('Reloaded — the file was changed outside BlockMD', 'ok');
  } catch (err) {
    console.warn('[BlockMD] disk check failed:', err);
  } finally {
    checkingDisk = false;
  }
}

/* ------------------------------------------------------------------- dropping */

// A dropped Markdown file is opened; dropped images go into the document where they
// were dropped (saved beside it, see editor/image.js).
async function handleDrop(file) {
  try {
    if (IMAGE_FILE.test(file.name)) {
      await insertImages(view(), [file], { x: file.x, y: file.y });
    } else if (MARKDOWN_FILE.test(file.name)) {
      if (file.path) await openPath(file.path);
      else await loadGuarded(platform.decodeFile(await file.bytes()), file.name, null);
    } else {
      flash(`${file.name}: BlockMD opens Markdown files and inserts images.`);
    }
  } catch (err) {
    flash(String(err.message ?? err));
  }
}

/* ------------------------------------------------------------------- view */

const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];
let zoom = store.get('zoom', 1);
async function setZoom(next) {
  zoom = Math.min(2, Math.max(0.5, next));
  store.set('zoom', zoom);
  await platform.setZoom(zoom);
}
const zoomBy = (dir) => {
  const i = ZOOM_STEPS.findIndex((z) => z >= zoom - 0.001);
  return setZoom(ZOOM_STEPS[Math.max(0, Math.min(ZOOM_STEPS.length - 1, (i < 0 ? 5 : i) + dir))]);
};

function toggleSource() {
  showSource = !showSource;
  el.btnSource.setAttribute('aria-pressed', String(showSource));
  el.sourcePane.hidden = !showSource;
  el.workspace.classList.toggle('with-source', showSource);
  refresh();
}

/* ------------------------------------------------------------------- help */

async function showAbout() {
  await platform.showMessage(
    `BlockMD ${await platform.appVersion()}\n\nA Notion-style block editor whose files are just plain .md.\nMIT License · github.com/RuiquanQiao/BlockMD`,
    'About BlockMD',
  );
}

/* ------------------------------------------------------------------- menus */

const withView = (fn) => () => { const v = view(); if (v) fn(v); };
const editCommand = (cmd) => () => { view()?.focus(); document.execCommand(cmd); };

setUpAppMenu(el.btnMenu, {
  File: () => [
    { label: 'New', shortcut: 'Mod+N', run: newDocument },
    { label: 'Open…', shortcut: 'Mod+O', run: openFile },
    {
      label: 'Open Recent',
      submenu: () => {
        const recent = recentFiles();
        if (!recent.length) return [{ label: 'No recent files', disabled: true }];
        return [
          ...recent.map((p) => ({ label: p, run: () => openPath(p) })),
          'sep',
          { label: 'Clear Recently Opened', run: () => store.set('recent', []) },
        ];
      },
    },
    'sep',
    { label: 'Save', shortcut: 'Mod+S', run: () => saveFile() },
    { label: 'Save As…', shortcut: 'Mod+Shift+S', run: () => saveFile({ saveAs: true }) },
    'sep',
    { label: 'Print / Export PDF…', shortcut: 'Mod+P', run: () => platform.print() },
    'sep',
    { label: 'Close Window', shortcut: 'Mod+W', run: () => platform.closeWindow() },
  ],
  Edit: () => [
    { label: 'Undo', shortcut: 'Mod+Z', run: withView((v) => undo(v.state, v.dispatch)) },
    { label: 'Redo', shortcut: 'Mod+Y', run: withView((v) => redo(v.state, v.dispatch)) },
    'sep',
    { label: 'Cut', shortcut: 'Mod+X', run: editCommand('cut') },
    { label: 'Copy', shortcut: 'Mod+C', run: editCommand('copy') },
    { label: 'Copy as Markdown', shortcut: 'Mod+Shift+C', run: withView((v) => copyAsMarkdown(v)) },
    // A web page can't read the clipboard from a menu click without a permission
    // prompt; the keyboard paste is native and needs none.
    { label: 'Paste', shortcut: 'Mod+V', run: () => flash('Press Ctrl+V to paste (Ctrl+Shift+V for plain text)', 'ok') },
    { label: 'Select All', shortcut: 'Mod+A', run: withView((v) => { v.focus(); document.execCommand('selectAll'); }) },
    'sep',
    { label: 'Find…', shortcut: 'Mod+F', run: () => openFind() },
    { label: 'Replace…', shortcut: 'Mod+H', run: () => openReplace() },
  ],
  View: () => [
    { label: 'Show Source', checked: showSource, run: toggleSource },
    {
      label: 'Page Style',
      submenu: () => {
        const s = pageStyle();
        return [
          { label: 'Default font', checked: s.font === 'default', run: () => setPageStyle({ font: 'default' }) },
          { label: 'Serif', checked: s.font === 'serif', run: () => setPageStyle({ font: 'serif' }) },
          { label: 'Mono', checked: s.font === 'mono', run: () => setPageStyle({ font: 'mono' }) },
          'sep',
          { label: 'Small text', checked: s.small, run: () => setPageStyle({ small: !s.small }) },
          { label: 'Full width', checked: s.wide, run: () => setPageStyle({ wide: !s.wide }) },
          { label: 'Table of contents', checked: s.toc !== false, run: () => setPageStyle({ toc: s.toc === false }) },
        ];
      },
    },
    'sep',
    { label: 'Zoom In', shortcut: 'Mod+=', run: () => zoomBy(1) },
    { label: 'Zoom Out', shortcut: 'Mod+-', run: () => zoomBy(-1) },
    { label: 'Actual Size', shortcut: 'Mod+0', run: () => setZoom(1) },
    { label: 'Toggle Full Screen', shortcut: 'F11', run: () => platform.toggleFullscreen() },
  ],
  Help: () => [
    { label: 'Check for Updates…', run: () => checkForUpdatesNow() },
    'sep',
    { label: 'BlockMD Website', run: () => platform.openExternal('https://ruiquanqiao.github.io/BlockMD/') },
    { label: 'Report a Problem', run: () => platform.openExternal('https://github.com/RuiquanQiao/BlockMD/issues') },
    'sep',
    { label: 'About BlockMD', run: showAbout },
  ],
});

/* ------------------------------------------------------------------- wiring */

el.btnSource.addEventListener('click', toggleSource);
el.btnOpen.addEventListener('click', openFile);
setUpPageStyle(document.getElementById('btn-style'));
const outline = setUpOutline({ pane: document.querySelector('.pane-editor'), getView: () => view() });
el.btnSave.addEventListener('click', () => saveFile());

el.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = platform.decodeFile(new Uint8Array(await file.arrayBuffer()));
    await loadGuarded(text, file.name, null);
  } catch (err) {
    flash(String(err.message ?? err));
  }
});

// Application shortcuts. Editing shortcuts (Ctrl+B, Ctrl+Shift+1, …) live with the
// editor (editor/keymap.js); Ctrl+F / Ctrl+H with find (editor/find.js).
window.addEventListener('keydown', (e) => {
  if (e.key === 'F11') { e.preventDefault(); platform.toggleFullscreen(); return; }
  const mod = e.ctrlKey || e.metaKey;
  if (!mod || e.altKey || e.defaultPrevented) return; // the editor already used this key
  const run = (fn) => { e.preventDefault(); fn(); };
  switch (e.code) {
    case 'KeyS': return run(() => saveFile({ saveAs: e.shiftKey }));
    case 'KeyO': return e.shiftKey ? undefined : run(openFile);
    case 'KeyN': return e.shiftKey ? undefined : run(newDocument);
    case 'KeyW': return e.shiftKey ? undefined : run(() => platform.closeWindow());
    case 'KeyP': return e.shiftKey ? undefined : run(() => platform.print());
    case 'Equal': case 'NumpadAdd': return run(() => zoomBy(1));
    case 'Minus': case 'NumpadSubtract': return run(() => zoomBy(-1));
    case 'Digit0': case 'Numpad0': return e.shiftKey ? undefined : run(() => setZoom(1));
    default: return undefined;
  }
});

platform.onFileDropped(handleDrop);

// Ctrl+click on a link to another .md file (editor/clipboard-extras.js).
window.addEventListener('bmd-open-path', (e) => openPath(e.detail));

// Editor modules report problems here (e.g. an image pasted into an unsaved document).
window.addEventListener('bmd-flash', (e) => flash(e.detail, e.detail?.startsWith?.('Copied') ? 'ok' : 'err'));

// Changes made by other programs: checked when the window regains focus, and every
// few seconds while it has it.
window.addEventListener('focus', watchDisk);
setInterval(() => { if (document.hasFocus()) watchDisk(); }, 3000);

/** Desktop only: do not let the window close on top of unsaved edits. */
async function guardWindowClose() {
  if (!platform.isDesktop) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  await win.onCloseRequested(async (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    if (await confirmLeave('Close without saving')) await win.destroy();
  });
}

/* --------------------------------------------------------------------- boot */

// Like Typora: a file you launch with opens; otherwise the last file you opened or
// edited reopens. If you then close without doing anything, the next launch starts
// with a new, empty document — reopening is a one-time offer, not a trap.
async function boot() {
  if (zoom !== 1) platform.setZoom(zoom).catch(() => {});

  // 1. Unsaved work from a session that didn't end normally.
  const draft = store.get('draft', null);
  if (draft?.text != null) {
    const when = new Date(draft.time).toLocaleString();
    const restore = await platform.confirmDiscard(
      `BlockMD closed with unsaved changes to ${draft.name} (${when}). Restore them?`,
    );
    if (restore) {
      await load(draft.text, draft.name, draft.path ?? null, { restored: true });
      return;
    }
    clearDraft();
  }

  // 2. A file passed on launch (double-click, "Open with").
  try {
    const path = await platform.startupPath();
    if (path) {
      await load(await platform.readFile(path), platform.basename(path), path);
      remember(path);
      return;
    }
  } catch (err) {
    console.warn('[BlockMD] could not open launch file:', err);
  }

  // 3. The last file — once. Opening or editing something sets it again.
  const last = store.get('lastFile', null);
  store.remove('lastFile');
  if (last) {
    try {
      await load(await platform.readFile(last), platform.basename(last), last);
      return;
    } catch {
      forget(last);
    }
  }

  // 4. A new, empty document.
  await load('', UNTITLED, null);
}

(async () => {
  await boot();
  guardWindowClose();
  startUpdateChecks({ isDirty });
  view()?.focus();
})();
