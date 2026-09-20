/**
 * BlockMD application entry point.
 *
 * The fidelity indicator in the status bar is deliberate: it turns the project's
 * central — and most easily broken — promise into something visible at all times.
 * With no edits it must read "byte-identical to disk". The moment a refactor breaks
 * open-then-save, whoever is working on it sees it immediately.
 */

import { createEditor, editorViewCtx } from './editor/create-editor.js';
import { DocumentSession } from './session.js';

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

function refresh() {
  if (!session) return;
  const s = session.status();

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

async function load(source, name) {
  if (editor) {
    await editor.destroy();
    el.editor.textContent = '';
  }
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

  // Development hook for inspecting the save plan and fidelity state from the console.
  if (import.meta.env?.DEV) {
    window.__bmd = {
      get session() { return session; },
      get editor() { return editor; },
      refresh,
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

el.btnSource.addEventListener('click', () => {
  showSource = !showSource;
  el.btnSource.setAttribute('aria-pressed', String(showSource));
  el.sourcePane.hidden = !showSource;
  el.workspace.classList.toggle('with-source', showSource);
  refresh();
});

el.btnOpen.addEventListener('click', () => el.fileInput.click());

el.fileInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  await load(text, file.name);
  e.target.value = '';
});

el.btnSave.addEventListener('click', () => {
  if (!session) return;
  const out = session.save();
  // Browser build downloads the file. Once wrapped in Tauri this becomes a write back
  // to the original path — it is the only layer that has to change.
  const blob = new Blob([out], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = session.name;
  a.click();
  URL.revokeObjectURL(a.href);
});

load(DEMO, 'demo.md');
