/**
 * BlockMD application entry point.
 *
 * The fidelity indicator in the status bar is deliberate: it turns the project's
 * central — and most easily broken — promise into something visible at all times.
 * With no edits it must read "byte-identical to disk". The moment a refactor breaks
 * open-then-save, whoever is working on it sees it immediately.
 *
 * File I/O lives in `platform.js`; this file never touches the filesystem directly,
 * so the desktop and browser builds differ in exactly one module.
 */

import { createEditor, editorViewCtx } from './editor/create-editor.js';
import { TextSelection, NodeSelection } from '@milkdown/prose/state';
import { DocumentSession } from './session.js';
import * as platform from './platform.js';
import { startUpdateChecks } from './updater.js';
import { setImageBase, insertImages, IMAGE_FILE } from './editor/image.js';
import { setUpPageStyle } from './page-style.js';

const DEMO = `# BlockMD demo

Hover any block to reveal its drag handle on the left, then drag to reorder. Type \`/\`
on an empty line to open the insert menu.

## What makes this different

- Reordering blocks re-serializes **nothing** — the original bytes are carried along
- The non-canonical spellings below survive editing untouched

This paragraph uses _underscores_ for emphasis rather than asterisks.

- A dash-bulleted item
- Instead of asterisks

~~~python
# A tilde fence, not backticks
print("hello")
~~~

A setext-style heading
======================

> Open "Show source" on the right to watch the actual bytes that hit the disk.

Link definitions are invisible in the editor, but they are never lost[^1].

[^1]: Footnotes survive too.

[ref]: https://example.com/ref
`;

const el = {
  editor: document.getElementById('editor'),
  filename: document.getElementById('filename'),
  statusbar: document.getElementById('statusbar'),
  dot: document.getElementById('status-dot'),
  text: document.getElementById('status-text'),
  blocks: document.getElementById('stat-blocks'),
  hidden: document.getElementById('stat-hidden'),
  sourcePane: document.getElementById('source-pane'),
  sourceBody: document.getElementById('source-body'),
  sourceNote: document.getElementById('source-note'),
  workspace: document.querySelector('.workspace'),
  btnSource: document.getElementById('btn-source'),
  btnOpen: document.getElementById('btn-open'),
  btnSave: document.getElementById('btn-save'),
  fileInput: document.getElementById('file-input'),
};

let session = null;
let editor = null;
let showSource = false;
/** Absolute path on disk, or null for the demo / a browser tab. */
let currentPath = null;
/** Set while a transient message is showing, so refresh() does not overwrite it. */
let flashTimer = null;

/* --------------------------------------------------------------- status bar */

function isDirty() {
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

function refresh() {
  if (!session) return;
  const s = session.status();

  setWindowTitle();

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
  el.dot.className = 'dot ' + (s.identical ? 'ok' : 'edited');
  el.text.textContent = s.identical
    ? 'Byte-identical to disk'
    : `Modified · ${s.fresh} new block(s) to serialize, ${s.reused} kept verbatim`;
  el.text.title = '';

  el.blocks.textContent = `${s.reused + s.fresh} blocks`;
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

/* ------------------------------------------------------------------ loading */

async function load(source, name, path = null) {
  if (editor) {
    await editor.destroy();
    el.editor.textContent = '';
  }
  currentPath = path;
  setImageBase(path);
  session = new DocumentSession(source, name);
  el.filename.textContent = name;

  editor = await createEditor({
    root: el.editor,
    value: session.doc.body,
    onChange: () => refresh(),
  });

  editor.action((ctx) => {
    const gate = session.attach(ctx);
    if (!gate.safe) console.warn('[BlockMD] ' + gate.message);
  });

  // Development hook for inspecting the save plan and fidelity state from the console,
  // and for driving the app from outside — see scripts/cdp.mjs. Synthetic keystrokes
  // sent with the Windows SendInput API do not reach WebView2's content, so end-to-end
  // checks of the desktop build go through the debugging protocol instead.
  if (import.meta.env?.DEV) {
    window.__bmd = {
      get session() { return session; },
      get editor() { return editor; },
      get path() { return currentPath; },
      get dirty() { return isDirty(); },
      refresh,
      save: saveFile,
      open: openFile,
      /** Open a file by path without a dialog — used by scripts/parity.mjs. */
      async openPath(path) {
        await load(await platform.readFile(path), platform.basename(path), path);
      },
      pm: { TextSelection, NodeSelection },
      /** Direct access to the ProseMirror view, for driving interactions by hand. */
      view() {
        let v = null;
        editor.action((ctx) => { v = ctx.get(editorViewCtx); });
        return v;
      },
    };
  }

  refresh();
}

/** Guarded load: refuses to throw away unsaved edits without asking. */
async function loadGuarded(source, name, path) {
  if (isDirty()) {
    const ok = await platform.confirmDiscard(
      `${session.name} has unsaved changes. Discard them?`,
    );
    if (!ok) return;
  }
  await load(source, name, path);
}

/* -------------------------------------------------------------- open / save */

async function openFile() {
  if (!platform.isDesktop) {
    el.fileInput.click();
    return;
  }
  try {
    const path = await platform.pickOpenPath();
    if (!path) return;
    const text = await platform.readFile(path);
    await loadGuarded(text, platform.basename(path), path);
  } catch (err) {
    flash(String(err.message ?? err));
  }
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
    setImageBase(path);
    session.name = platform.basename(path);
    // Adopt what we just wrote as the new baseline, so the indicator goes back to
    // "byte-identical to disk" and the next save reuses these bytes verbatim.
    session.commit(out);
    refresh();
    flash(`Saved · ${out.length} bytes`, 'ok');
  } catch (err) {
    flash(`Save failed — ${String(err.message ?? err)}`);
  }
}

/* ------------------------------------------------------------------- wiring */

el.btnSource.addEventListener('click', () => {
  showSource = !showSource;
  el.btnSource.setAttribute('aria-pressed', String(showSource));
  el.sourcePane.hidden = !showSource;
  el.workspace.classList.toggle('with-source', showSource);
  refresh();
});

el.btnOpen.addEventListener('click', openFile);
setUpPageStyle(document.getElementById('btn-style'));
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

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  const key = e.key.toLowerCase();
  if (key === 's') {
    e.preventDefault();
    saveFile({ saveAs: e.shiftKey });
  } else if (key === 'o') {
    e.preventDefault();
    openFile();
  }
});

// A dropped Markdown file is opened; dropped images go into the document where they
// were dropped (saved beside it, see editor/image.js).
platform.onFileDropped(async (file) => {
  try {
    if (IMAGE_FILE.test(file.name)) {
      let view = null;
      editor.action((ctx) => { view = ctx.get(editorViewCtx); });
      await insertImages(view, [file], { x: file.x, y: file.y });
    } else if (/\.(md|markdown|mdx|txt)$/i.test(file.name)) {
      await loadGuarded(platform.decodeFile(await file.bytes()), file.name, file.path);
    } else {
      flash(`${file.name}: BlockMD opens Markdown files and inserts images.`);
    }
  } catch (err) {
    flash(String(err.message ?? err));
  }
});

// Editor modules report problems here (e.g. an image pasted into an unsaved document).
window.addEventListener('bmd-flash', (e) => flash(e.detail));

/** Desktop only: do not let the window close on top of unsaved edits. */
async function guardWindowClose() {
  if (!platform.isDesktop) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const win = getCurrentWindow();
  await win.onCloseRequested(async (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    const ok = await platform.confirmDiscard(
      `${session.name} has unsaved changes. Close without saving?`,
    );
    if (ok) await win.destroy();
  });
}

/* --------------------------------------------------------------------- boot */

(async () => {
  let booted = false;
  try {
    const path = await platform.startupPath();
    if (path) {
      await load(await platform.readFile(path), platform.basename(path), path);
      booted = true;
    }
  } catch (err) {
    console.warn('[BlockMD] could not open launch file:', err);
  }
  if (!booted) await load(DEMO, 'demo.md');
  guardWindowClose();
  startUpdateChecks({ isDirty });
})();
