/**
 * Checks for parity/feel.json — how the app feels, not just whether features work.
 * Loaded by scripts/parity.mjs, which owns the app, the harness (`t`) and the report.
 *
 * Numbers are measured from outside the page, through the debugging protocol, the way
 * input really arrives: a pointer move is dispatched, then the page is polled until
 * the row changes. That round trip is a few milliseconds, so the budgets have room
 * for it and still catch a real lag (0.1.6's menu waited 220 ms on every switch).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const J = JSON.stringify;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** In-page helpers: style fingerprints, hit-testable targets, contrast. */
export const FEEL = `window.__feel = {
  els(sel) { return [...document.querySelectorAll(sel)].filter((e) => this.hittable(e)); },
  hittable(e) {
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    if (s.visibility === 'hidden' || s.display === 'none' || r.width < 2 || r.height < 2) return false;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    const at = document.elementFromPoint(x, y);
    return !!at && (at === e || e.contains(at));
  },
  list(sel) {
    return this.els(sel).map((e, i) => {
      const r = e.getBoundingClientRect();
      return { i, x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: e.disabled || e.getAttribute('aria-disabled') === 'true' || e.classList.contains('is-disabled'),
        name: (e.getAttribute('aria-label') || e.textContent || e.title || e.className).trim().replace(/\\s+/g, ' ').slice(0, 40) };
    });
  },
  sig(sel, i) {
    const e = this.els(sel)[i];
    if (!e) return 'gone';
    const one = (x) => { const s = getComputedStyle(x); return [s.backgroundColor, s.color, s.borderTopColor, s.boxShadow, s.opacity, s.outlineStyle, s.outlineColor, s.textDecorationLine, s.filter].join('|'); };
    return [e, ...[...e.children].slice(0, 4)].map(one).join('#');
  },
  focusSig(e) { const s = getComputedStyle(e); return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.backgroundColor, s.borderTopColor].join('|'); },
  pad(sel) { const e = [...document.querySelectorAll(sel)].find((x) => this.hittable(x) || getComputedStyle(x).visibility === 'visible'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + 3, y: r.top + 3 }; },
  rect(sel) { const e = typeof sel === 'string' ? document.querySelector(sel) : sel; if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; },
  /* WCAG relative luminance and contrast, compositing translucent colours over what's behind. */
  rgba(c) { const m = c.match(/[\\d.]+/g)?.map(Number) ?? [0, 0, 0, 0]; return [m[0], m[1], m[2], m[3] ?? 1]; },
  over(top, under) { const a = top[3]; return [0, 1, 2].map((k) => top[k] * a + under[k] * (1 - a)).concat(1); },
  background(e) {
    const layers = [];
    for (let x = e; x; x = x.parentElement) { const c = this.rgba(getComputedStyle(x).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
    let bg = [255, 255, 255, 1];
    if (layers.length && layers[layers.length - 1][3] >= 1) bg = layers.pop();
    for (const l of layers.reverse()) bg = this.over(l, bg);
    return bg;
  },
  lum([r, g, b]) { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); },
  contrast(e) {
    const s = getComputedStyle(e), bg = this.background(e);
    let fg = this.rgba(s.color); fg[3] *= Number(s.opacity);
    for (let x = e.parentElement; x; x = x.parentElement) fg[3] *= Number(getComputedStyle(x).opacity);
    fg = this.over(fg, bg);
    const [a, b] = [this.lum(fg), this.lum(bg)].sort((p, q) => q - p);
    return (a + 0.05) / (b + 0.05);
  },
  /** Every element that directly holds visible text, with its contrast and the ratio it needs. */
  texts(root = document.body, hintSel = null) {
    const out = [], seen = new Set();
    const walk = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let n; (n = walk.nextNode());) {
      const e = n.parentElement;
      if (!e || seen.has(e) || !n.textContent.trim()) continue;
      seen.add(e);
      if (e.closest('[hidden], script, style, .katex-mathml, [aria-hidden="true"], .ProseMirror code .hljs-comment')) continue;
      const r = e.getBoundingClientRect(), s = getComputedStyle(e);
      if (r.width < 1 || r.height < 1 || s.visibility !== 'visible' || r.bottom < 0 || r.top > innerHeight) continue;
      if (e.closest('button:disabled, [aria-disabled="true"], .is-disabled')) continue; // WCAG 1.4.3: inactive UI is exempt
      const size = parseFloat(s.fontSize), bold = Number(s.fontWeight) >= 700;
      const need = size >= 24 || (bold && size >= 18.66) ? 3 : 4.5;
      out.push({ text: n.textContent.trim().slice(0, 30), ratio: Math.round(this.contrast(e) * 100) / 100, need, cls: (e.className?.baseVal ?? e.className ?? '') + '', tag: e.tagName, hint: hintSel ? !!e.closest(hintSel) : false });
    }
    return out;
  },
  name(e) {
    const by = e.getAttribute('aria-labelledby');
    if (by) return by.split(' ').map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim();
    return (e.getAttribute('aria-label') || e.textContent || e.getAttribute('title') || e.querySelector('img[alt]')?.alt || e.placeholder || '').trim();
  },
}; true`;

/**
 * Text that is deliberately faint the way Notion makes it: shortcut and other hints,
 * word count, the code language label, finished tasks, inline code's red, a callout's
 * `[!` `]`. Below WCAG AA on purpose; whether to keep that is the owner's call
 * (parity/feel.json: contrast-hints). Everything else must pass.
 */
const NOTION_FAINT = [
  '.bmd-app-key', '.bmd-app-arrow', '.bmd-slash-hint', '.bmd-menu-tail', '.statusbar .stat', '.source-note',
  '.bmd-code-lang', '.bmd-callout-punct', '.bmd-callout-marker', '.milkdown li[data-checked="true"]',
  '.milkdown :not(pre) > code', '.bmd-find-count', '[data-placeholder]', '.bmd-math-hint',
].join(', ');

export function feelChecks({ t, ev, send, expect, file, grip, FIXTURE, ROOT, WORK, approve }) {
  const inject = () => ev(FEEL);
  const mouse = (x, y) => t.mouse('mouseMoved', x, y);

  /**
   * Hover every hittable element matching `sel`, from a neutral point that keeps the
   * surface open, and time how long until it looks different. Returns the problems.
   */
  async function sweep(surface, sel, neutral) {
    await inject();
    const items = await ev(`__feel.list(${J(sel)})`);
    if (!items.length) return [`${surface}: nothing to hover (${sel})`];
    const bad = [];
    for (const it of items) {
      await mouse(neutral.x, neutral.y);
      await sleep(260); // let a leaving transition settle
      const before = await ev(`__feel.sig(${J(sel)}, ${it.i})`);
      await mouse(it.x, it.y);
      const t0 = performance.now();
      let ms = null;
      while (performance.now() - t0 < 200) {
        if ((await ev(`__feel.sig(${J(sel)}, ${it.i})`)) !== before) { ms = Math.round(performance.now() - t0); break; }
      }
      // Already the highlighted row (the keyboard cursor starts on the first item): it is
      // lit, and pointing at it rightly changes nothing.
      const lit = ms === null && await ev(`__feel.els(${J(sel)})[${it.i}]?.matches('.is-active, .is-open, [aria-selected="true"]')`);
      if (it.disabled) { if (ms !== null) bad.push(`${surface} "${it.name}" is disabled but lights up`); }
      else if (ms === null && !lit) bad.push(`${surface} "${it.name}": no hover feedback`);
      else if (ms > 50) bad.push(`${surface} "${it.name}": hover feedback took ${ms} ms`);
    }
    return bad;
  }
  const centre = async (sel, text) => ev(`(() => { const e = [...document.querySelectorAll(${J(sel)})].find((x) => ${text ? `x.textContent.includes(${J(text)})` : 'true'} && __parity.visible(x)); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const openMenu = async () => { const b = await centre('#btn-menu'); await t.click(b.x, b.y); await inject(); };
  const flyLabels = () => ev(`[...document.querySelectorAll('.bmd-app-sub:not(.bmd-app-deep) .bmd-app-label')].filter((e) => __parity.visible(e)).map((e) => e.textContent)`);
  /** Wait until `fn` (page expression) is truthy; returns elapsed ms or null. */
  async function until(expr, limit) {
    const t0 = performance.now();
    while (performance.now() - t0 < limit) { if (await ev(expr)) return Math.round(performance.now() - t0); }
    return null;
  }

  /* A big, realistic document: headings, paragraphs, lists, quotes, code — ~1 MB at n=10,000. */
  function bigDoc(blocks) {
    const out = [];
    for (let i = 0; i < blocks; i++) {
      switch (i % 10) {
        case 0: out.push(`## Section ${i}`); break;
        case 3: out.push(`- item ${i} with **bold** and \`code\`\n- another item ${i}`); break;
        case 6: out.push(`> A quote in block ${i}, with a [link](https://example.com/${i}).`); break;
        case 8: out.push('```js\nconst x' + i + ' = ' + i + ';\nconsole.log(x' + i + ');\n```'); break;
        default: out.push(`Paragraph ${i}: the quick brown fox jumps over the lazy dog, then keeps running across the field while the author keeps typing more words to make this a realistic line of prose.`);
      }
    }
    return out.join('\n\n') + '\n';
  }

  /** IME: compose `pinyin`, press the Enter that confirms it (keyCode 229), commit `text`. */
  async function imeEnter(pinyin, text = pinyin, { after = true } = {}) {
    for (let i = 1; i <= pinyin.length; i++) await send('Input.imeSetComposition', { text: pinyin.slice(0, i), selectionStart: i, selectionEnd: i });
    await sleep(60);
    // The confirming Enter, both ways a webview delivers it: during the composition
    // (Chromium, Windows) and — the one handlers trip on — after it has ended, with
    // isComposing false and keyCode 229 (WebKit, macOS). Sent only during, a mistake
    // was hidden: find re-searches on the committed text, which undid the jump.
    const enter229 = () => send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 229, nativeVirtualKeyCode: 229 });
    await enter229();
    await send('Input.insertText', { text });
    if (after) await enter229();
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(200);
  }
  async function ime(pinyin, text) {
    for (let i = 1; i <= pinyin.length; i++) { await send('Input.imeSetComposition', { text: pinyin.slice(0, i), selectionStart: i, selectionEnd: i }); await sleep(15); }
    await send('Input.insertText', { text });
    await sleep(150);
  }

  const checks = {
    /* ——— Interaction states ——— */
    async 'hover-feedback'() {
      const bad = [];
      // Top bar
      await t.open('# Hover\n\nhello world\n\n```js\nx\n```\n\n<details>\n<summary>Toggle</summary>\n\nbody\n\n</details>\n');
      await inject();
      const gap = await ev(`(() => { const f = __feel.rect('#filename'), a = __feel.rect('.topbar-actions'); return { x: (f.right + a.x) / 2, y: f.y + f.h / 2 }; })()`);
      bad.push(...await sweep('Top bar', '.topbar button', gap));
      // App menu: every level
      await openMenu();
      bad.push(...await sweep('App menu', '.bmd-app-menu .bmd-app-item', await ev(`__feel.pad('.bmd-app-menu')`)));
      for (const section of ['File', 'Edit', 'View', 'Help']) {
        await t.key('Escape'); await openMenu();
        const s = await centre(`.bmd-app-menu [data-section="${section}"]`);
        await t.hover(s.x, s.y);
        bad.push(...await sweep(`${section} menu`, '.bmd-app-sub:not(.bmd-app-deep) .bmd-app-item', await ev(`__feel.pad('.bmd-app-sub:not(.bmd-app-deep)')`)));
      }
      for (const [section, parent] of [['File', 'Open Recent'], ['View', 'Page Style']]) {
        await t.key('Escape'); await openMenu();
        const s = await centre(`.bmd-app-menu [data-section="${section}"]`);
        await t.hover(s.x, s.y);
        const p = await centre('.bmd-app-sub:not(.bmd-app-deep) .bmd-app-item', parent);
        if (!p) { bad.push(`${section} menu has no ${parent}`); continue; }
        await t.glide(s, p, 4);
        bad.push(...await sweep(`${section} ▸ ${parent}`, '.bmd-app-deep .bmd-app-item', await ev(`__feel.pad('.bmd-app-deep')`)));
      }
      await t.key('Escape');
      // Page style menu (···)
      { const b = await centre('#btn-style'); await t.click(b.x, b.y);
        bad.push(...await sweep('Page style menu', '.bmd-style-menu button', await ev(`__feel.pad('.bmd-style-menu')`)));
        await t.click(b.x, b.y); }
      // Drag handle
      { await t.open('first block\n\nsecond\n'); await grip(0);
        const r = await ev('__parity.blockRect(0)');
        bad.push(...await sweep('Drag handle', '.bmd-handle-add, .bmd-handle-grip', { x: r.x + 30, y: r.y + 8 })); }
      // Block menu
      { await t.open('first block\n\nsecond\n'); const g = await grip(0); await t.click(g.x, g.y); await sleep(200);
        bad.push(...await sweep('Block menu', '.bmd-menu:not(.bmd-app-menu):not(.bmd-app-sub):not(.bmd-style-menu) .bmd-menu-item', await ev(`__feel.pad('.bmd-menu:not(.bmd-app-menu):not(.bmd-app-sub):not(.bmd-style-menu)')`)));
        await t.key('Escape'); }
      // Slash menu
      { await t.newLine(); await t.type('/'); await sleep(300);
        bad.push(...await sweep('Slash menu', '.bmd-slash-item', await ev(`__feel.pad('.bmd-slash')`)));
        await t.key('Escape'); }
      // Format toolbar
      { await t.open('hello world\n'); await t.select('world'); await sleep(300);
        bad.push(...await sweep('Format toolbar', '.bmd-toolbar button', await ev(`__feel.pad('.bmd-toolbar')`))); }
      // Find / replace bar
      { await t.open('cat\n'); await t.caret('cat'); await t.key('Ctrl+H'); await sleep(200);
        bad.push(...await sweep('Find bar', '.bmd-find button', await ev(`__feel.pad('.bmd-find')`)));
        await t.key('Escape'); }
      // Code language button, then its menu
      { await t.open('```js\nconst x = 1;\n```\n'); await inject();
        const c = await ev(`(() => { const r = __feel.rect('.bmd-code'); return { x: r.x + 40, y: r.y + r.h / 2 }; })()`);
        await t.hover(c.x, c.y);
        bad.push(...await sweep('Code block', '.bmd-code-lang', c));
        const b = await centre('.bmd-code-lang'); await t.click(b.x, b.y); await sleep(200);
        bad.push(...await sweep('Language menu', '.bmd-lang-menu .bmd-menu-item', await ev(`__feel.pad('.bmd-lang-menu')`)));
        await t.key('Escape'); }
      // Emoji picker
      { await t.newLine(); await t.type(':smi'); await sleep(300);
        bad.push(...await sweep('Emoji picker', '.bmd-emoji-item', await ev(`__feel.pad('.bmd-emoji')`)));
        await t.key('Escape'); }
      // Toggle arrow
      { await t.open('<details>\n<summary>Toggle</summary>\n\nbody\n\n</details>\n'); await inject();
        const s = await ev(`(() => { const r = __feel.rect('.bmd-toggle-head'); return { x: r.x + r.w - 20, y: r.y + r.h / 2 }; })()`);
        await t.hover(s.x, s.y);
        bad.push(...await sweep('Toggle', '.bmd-toggle-arrow', s)); }
      expect(!bad.length, bad.join('; '));
    },

    async 'focus-visible'() {
      const bad = [];
      const probe = async (surface, sel) => {
        await inject();
        // Tag them once: focusing one can change which others are hittable.
        const n = await ev(`__feel.els(${J(sel)}).map((e, i) => e.dataset.feelFocus = i).length`);
        if (!n) { bad.push(`${surface}: no controls (${sel})`); return; }
        const pick = (i) => `document.querySelector('[data-feel-focus="${i}"]')`;
        for (let i = 0; i < n; i++) {
          // Keyboard modality first (a key press), so :focus-visible applies as for a user.
          const r = await ev(`(() => { const e = ${pick(i)}; if (!e) return null; e.blur(); return { a: __feel.focusSig(e), name: __feel.name(e) || e.className }; })()`);
          if (!r) { bad.push(`${surface}: control ${i} disappeared while tabbing`); continue; }
          await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
          await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 });
          const b = await ev(`(() => { const e = ${pick(i)}; e.focus(); return document.activeElement === e ? __feel.focusSig(e) : null; })()`);
          if (b === null) continue; // not focusable by design (tabindex=-1 inside a menu is reached with arrows)
          if (b === r.a) bad.push(`${surface} "${r.name}": no visible focus`);
        }
      };
      await t.open('hello world\n');
      await probe('Top bar', '.topbar button');
      await t.caret('hello'); await t.key('Ctrl+H'); await sleep(200);
      await probe('Find bar', '.bmd-find button, .bmd-find input');
      await t.key('Escape');
      await t.select('world'); await t.key('Ctrl+K'); await sleep(200);
      await probe('Link box', '.bmd-link-editor input');
      await t.key('Escape');
      { const b = await centre('#btn-style'); await t.click(b.x, b.y); await probe('Page style menu', '.bmd-style-menu button'); await t.key('Escape'); }
      await openMenu();
      await t.key('ArrowDown');
      const f = await ev(`document.activeElement?.classList.contains('bmd-app-item') ? __feel.focusSig(document.activeElement) : null`);
      if (!f) bad.push('App menu: arrow keys do not focus a row');
      else if (f === (await ev(`__feel.focusSig([...document.querySelectorAll('.bmd-app-menu .bmd-app-item')].find((e) => e !== document.activeElement))`))) bad.push('App menu: the focused row looks like the others');
      await t.key('Escape');
      expect(!bad.length, bad.join('; '));
    },

    /* ——— Responsiveness ——— */
    async 'menu-switch'() {
      await t.open('x\n');
      await openMenu();
      const rows = {};
      for (const s of ['File', 'Edit', 'View', 'Help']) rows[s] = await ev(`(() => { const r = __feel.rect('.bmd-app-menu [data-section="${s}"]'); return { x: r.x + 40, y: r.y + r.h / 2 }; })()`);
      await t.hover(rows.File.x, rows.File.y);
      expect((await flyLabels()).includes('New'), 'hovering File did not open it');
      const expectOf = { Edit: 'Undo', View: 'Zoom In', Help: 'About BlockMD' };
      // Straight down, the way a person scans a menu.
      let from = rows.File;
      for (const s of ['Edit', 'View', 'Help']) {
        for (let i = 1; i <= 5; i++) { await mouse(from.x, from.y + ((rows[s].y - from.y) * i) / 5); await sleep(10); }
        const ms = await until(`[...document.querySelectorAll('.bmd-app-sub:not(.bmd-app-deep) .bmd-app-label')].some((e) => e.textContent === ${J(expectOf[s])} && __parity.visible(e))`, 600);
        expect(ms !== null && ms <= 100, `moving down onto ${s}: its menu appeared after ${ms ?? '>600'} ms (budget 100 ms)`);
        from = rows[s];
      }
      // Diagonally from File into the bottom of its submenu, crossing Edit/View/Help.
      for (let i = 1; i <= 5; i++) { await mouse(from.x, from.y + ((rows.File.y - from.y) * i) / 5); await sleep(10); }
      await until(`[...document.querySelectorAll('.bmd-app-sub:not(.bmd-app-deep) .bmd-app-label')].some((e) => e.textContent === 'New' && __parity.visible(e))`, 600);
      const target = await centre('.bmd-app-sub:not(.bmd-app-deep) .bmd-app-item', 'Close Window');
      await ev(`window.__switches = []; window.__swObs?.disconnect(); window.__swObs = new MutationObserver(() => __switches.push(document.querySelector('.bmd-app-sub .bmd-app-label')?.textContent)); __swObs.observe(document.querySelector('.bmd-app-sub'), { childList: true }); true`);
      await t.glide(rows.File, target, 14);
      const switches = await ev("window.__swObs.disconnect(), __switches");
      expect((await flyLabels()).includes('Close Window'), `heading diagonally from File (${Math.round(rows.File.x)},${Math.round(rows.File.y)}) into its submenu (${Math.round(target.x)},${Math.round(target.y)}) switched it away: ${J(switches)}`);
      // Resting on another section switches it, without the pointer having to wiggle.
      for (let i = 1; i <= 6; i++) { await mouse(target.x + ((rows.View.x - target.x) * i) / 6, target.y + ((rows.View.y - target.y) * i) / 6); await sleep(10); }
      const rest = await until(`[...document.querySelectorAll('.bmd-app-sub:not(.bmd-app-deep) .bmd-app-label')].some((e) => e.textContent === 'Zoom In' && __parity.visible(e))`, 1200);
      expect(rest !== null && rest <= 500, `resting on View: its menu appeared after ${rest ?? '>1200'} ms (budget 500 ms)`);
      await t.key('Escape');
    },

    async 'typing-latency'() {
      await t.open(bigDoc(3000));
      await sleep(1000);
      await ev(`(() => { const p = __parity.find('Paragraph 1501'); __parity.select(p + 14); })()`);
      await ev(`(() => {
        window.__lat = []; window.__long = [];
        window.__latObs?.disconnect();
        try { window.__latObs = new PerformanceObserver((l) => l.getEntries().forEach((e) => __long.push(Math.round(e.duration)))); __latObs.observe({ type: 'longtask' }); } catch {}
        window.__latOn?.();
        const on = (e) => { const t0 = performance.now(); requestAnimationFrame(() => setTimeout(() => __lat.push(performance.now() - t0), 0)); };
        __bmd.view().dom.addEventListener('beforeinput', on, true);
        window.__latOn = () => __bmd.view().dom.removeEventListener('beforeinput', on, true);
      })()`);
      for (const ch of 'the quick brown fox jumps over the lazy dog ') { await send('Input.insertText', { text: ch }); await sleep(80); }
      await sleep(800);
      const { lat, long } = await ev(`({ lat: __lat.slice().sort((a, b) => a - b), long: __long })`);
      await ev('window.__latOn?.(); window.__latObs?.disconnect(); true');
      expect(lat.length >= 40, `only ${lat.length} keystrokes measured`);
      const p95 = Math.round(lat[Math.floor(lat.length * 0.95)]), worst = Math.max(0, ...long);
      console.log(`    typing in 3,000 blocks: p50 ${Math.round(lat[lat.length >> 1])} ms, p95 ${p95} ms, longest task ${worst} ms`);
      expect(p95 <= 50, `keystroke to screen p95 is ${p95} ms (budget 50 ms)`);
      expect(worst <= 100, `a ${worst} ms frozen frame while typing (budget 100 ms)`);
    },

    async 'large-file'() {
      const text = bigDoc(10000);
      const p = file('large.md', text);
      await ev('__bmd.view()?.dom.blur?.(); true');
      const t0 = performance.now();
      await ev(`__bmd.openPath(${J(p)})`);
      await ev('new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)))');
      const open = Math.round(performance.now() - t0);
      const t1 = performance.now();
      const saved = await t.save();
      const save = Math.round(performance.now() - t1);
      console.log(`    ${(text.length / 1e6).toFixed(2)} MB: open ${open} ms, save ${save} ms`);
      expect(saved === text, 'the large file did not save byte-identical');
      expect(await ev('__bmd.editor.parseReused'), 'the editor parsed the file a second time (editor/reuse-parse.js was not used)');
      expect(open <= 3000, `opening took ${open} ms (budget 3000 ms)`);
      expect(save <= 1000, `saving took ${save} ms (budget 1000 ms)`);
    },

    async 'memory'() {
      await send('HeapProfiler.enable');
      const measure = async () => {
        await t.open('x\n'); await sleep(300);
        await send('HeapProfiler.collectGarbage'); await sleep(200); await send('HeapProfiler.collectGarbage');
        const heap = (await send('Runtime.getHeapUsage')).usedSize;
        const dom = await send('Memory.getDOMCounters');
        return { heap, nodes: dom.nodes, listeners: dom.jsEventListeners };
      };
      const round = async () => {
        await t.open(FIXTURE); await sleep(150);
        await t.caret('Toggle', 'end').catch(() => {});
        await t.type('ab');
        await t.select('ab').catch(() => {});
        await t.key('Escape');
      };
      for (let i = 0; i < 5; i++) await round(); // warm-up: caches, lazy modules, JIT
      const a = await measure();
      for (let i = 0; i < 30; i++) await round();
      const b = await measure();
      const d = { heap: ((b.heap - a.heap) / 1e6).toFixed(1), nodes: b.nodes - a.nodes, listeners: b.listeners - a.listeners };
      console.log(`    after 30 more documents: heap ${d.heap} MB, DOM nodes ${d.nodes >= 0 ? '+' : ''}${d.nodes}, listeners ${d.listeners >= 0 ? '+' : ''}${d.listeners}`);
      expect(b.heap - a.heap <= 5e6, `heap grew ${d.heap} MB over 30 documents`);
      expect(d.nodes <= 300, `DOM nodes grew by ${d.nodes} over 30 documents (something is left behind each time)`);
      expect(d.listeners <= 30, `event listeners grew by ${d.listeners} over 30 documents`);
    },

    /* ——— Keyboard ——— */
    async 'menu-keyboard'() {
      await t.open('abc\n'); await t.caret('abc'); await t.type('d');
      await t.key('F10'); await sleep(100);
      const focused = () => ev(`document.activeElement?.closest?.('.bmd-app-menu, .bmd-app-sub') ? document.activeElement.textContent.trim() : null`);
      expect((await focused())?.startsWith('File'), 'F10 did not open the menu on File: ' + J(await focused()));
      await t.key('ArrowDown');
      expect((await focused())?.startsWith('Edit'), '↓ did not move to Edit');
      await t.key('ArrowRight');
      expect((await focused())?.startsWith('Undo'), '→ did not open Edit on its first item: ' + J(await focused()));
      await t.key('ArrowLeft');
      expect((await focused())?.startsWith('Edit') && !(await ev(`__parity.visible('.bmd-app-sub:not(.bmd-app-deep)')`)), '← did not go back to Edit');
      await t.key('ArrowRight'); await t.key('Enter'); await sleep(150);
      expect((await ev('__bmd.view().state.doc.textContent')) === 'abc', 'Enter on Edit ▸ Undo did not undo');
      expect(!(await ev(`__parity.visible('.bmd-app-menu')`)), 'the menu stayed open after Enter');
      await t.type('x');
      expect((await ev('__bmd.view().state.doc.textContent')) === 'abcx', 'focus did not return to the text after the menu');
      // Alt on its own, then Esc.
      await t.key('Alt'); await sleep(100);
      expect((await focused())?.startsWith('File'), 'Alt did not open the menu');
      await t.key('Escape');
      await t.type('y');
      expect((await ev('__bmd.view().state.doc.textContent')) === 'abcxy', 'Esc did not return to the text');
      // Deep level: File ▸ Open Recent ▸ with →.
      await t.key('F10'); await t.key('ArrowRight');
      for (let i = 0; i < 4 && !(await focused())?.startsWith('Open Recent'); i++) await t.key('ArrowDown');
      await t.key('ArrowRight');
      expect(await ev(`__parity.visible('.bmd-app-deep') && document.activeElement.closest('.bmd-app-deep') !== null`), '→ on Open Recent did not open it');
      await t.key('Escape');
    },

    async 'menus-keyboard'() {
      const bad = [];
      const text = () => ev('__bmd.view().state.doc.textContent');
      // Slash menu: ↓ Enter picks the second item.
      await t.newLine(); await t.type('/'); await sleep(300);
      const second = await ev(`document.querySelectorAll('.bmd-slash-item')[1]?.textContent`);
      await t.key('ArrowDown'); await t.key('Enter'); await sleep(150);
      if (await t.vis('.bmd-slash')) bad.push('slash menu: Enter left it open');
      if ((await t.top()).length !== 2 || (await t.top())[1] === 'paragraph') bad.push(`slash menu: ↓ Enter did not insert "${second}": ${J(await t.top())}`);
      // Slash menu: Esc keeps what was typed and the caret.
      await t.newLine(); await t.type('/he'); await sleep(300); await t.key('Escape'); await t.type('z');
      if (!(await text()).endsWith('/hez')) bad.push('slash menu: Esc lost the caret: ' + J(await text()));
      // Block menu (Ctrl+/): ↓ to Duplicate, Enter.
      await t.open('one\n'); await t.caret('one'); await t.key('Ctrl+/'); await sleep(150);
      const labels = await ev(`[...document.querySelectorAll('.bmd-menu .bmd-menu-item')].filter((e) => __parity.visible(e)).map((e) => e.textContent.trim())`);
      const dup = labels.findIndex((l) => l.startsWith('Duplicate'));
      for (let i = 0; i < dup; i++) await t.key('ArrowDown');
      await t.key('Enter'); await sleep(150);
      if ((await t.save()) !== 'one\n\none\n') bad.push('block menu: arrows + Enter on Duplicate gave ' + J(await t.save()));
      await t.key('Ctrl+/'); await sleep(150); await t.key('Escape'); await t.type('!');
      if (!(await text()).includes('!')) bad.push('block menu: Esc did not return to the text');
      // Emoji picker: → Enter.
      await t.newLine(); await t.type(':smi'); await sleep(300);
      const pick = await ev(`document.querySelectorAll('.bmd-emoji-item')[1]?.textContent`);
      await t.key('ArrowRight'); await t.key('Enter'); await sleep(150);
      if (!(await text()).endsWith(pick ?? '??')) bad.push(`emoji picker: → Enter did not insert ${pick}: ${J(await text())}`);
      // Code language menu: type, ↓, Enter; Esc returns to the code.
      await t.open('```\nx\n```\n'); await inject();
      const b = await ev(`(() => { const r = __feel.rect('.bmd-code'); return { x: r.x + 40, y: r.y + r.h / 2 }; })()`);
      await t.hover(b.x, b.y);
      const lang = await centre('.bmd-code-lang'); await t.click(lang.x, lang.y); await sleep(200);
      await t.type('pyth'); await t.key('Enter'); await sleep(150);
      if (!(await t.save()).startsWith('```python')) bad.push('language menu: typing + Enter did not choose: ' + J(await t.save()));
      // Find: Esc returns the caret to the match.
      await t.open('alpha beta gamma\n'); await t.caret('alpha', 'start'); await t.key('Ctrl+F'); await t.type('beta'); await t.key('Escape'); await t.type('X');
      // Back where it was, or on the match (as in VS Code) — either is "back in the text".
      if (!['Xalpha beta gamma', 'alpha Xgamma', 'alpha betaX gamma', 'alpha Xbeta gamma'].includes(await text())) bad.push('find: Esc did not return to the text: ' + J(await text()));
      expect(!bad.length, bad.join('; '));
    },

    /* ——— Input methods ——— */
    async 'ime-enter'() {
      const bad = [];
      const text = () => ev('__bmd.view().state.doc.textContent');
      // Plain paragraph: one block, text once.
      // (ProseMirror itself recognises WebKit's after-the-fact Enter; Chromium never sends it.)
      await t.newLine(); await imeEnter('nihao', 'nihao', { after: false });
      if ((await t.top()).length !== 2) bad.push('paragraph: the confirming Enter also split the block: ' + J(await t.top()));
      if (!(await text()).endsWith('nihao')) bad.push('paragraph: text ' + J(await text()));
      // Slash menu: the filter is composed; confirming must not pick an item.
      await t.newLine(); await t.type('/'); await sleep(300); await imeEnter('biaoti', 'biaoti', { after: false });
      if (last(await t.top()) !== 'paragraph' || !(await text()).endsWith('/biaoti')) bad.push('slash menu: confirming the IME picked an item: ' + J(await t.top()) + ' ' + J(await text()));
      await t.key('Escape');
      // Emoji picker.
      await t.newLine(); await t.type(':'); await sleep(200); await imeEnter('smile', 'smile', { after: false });
      if (!(await text()).endsWith(':smile')) bad.push('emoji picker: confirming the IME inserted an emoji: ' + J(await text()));
      await t.key('Escape');
      // Find: confirming must not jump to the next match.
      await t.open('ab ab ab\n'); await t.caret('ab', 'start'); await t.key('Ctrl+F'); await imeEnter('ab');
      const count = await ev(`document.querySelector('.bmd-find-count')?.textContent`);
      if (count !== '1/3') bad.push('find: confirming the IME jumped to ' + count);
      // Replace: confirming must not replace.
      await t.key('Escape'); await t.key('Ctrl+H'); await t.type('ab'); await ev(`document.querySelector('.bmd-replace-input').focus()`);
      await imeEnter('cd');
      if ((await t.save()) !== 'ab ab ab\n') bad.push('replace: confirming the IME replaced: ' + J(await t.save()));
      await t.key('Escape');
      // Link box.
      await t.open('word\n'); await t.select('word'); await t.key('Ctrl+K'); await sleep(200);
      await imeEnter('lianjie');
      if (!(await t.vis('.bmd-link-editor'))) bad.push('link box: confirming the IME submitted the link');
      await t.key('Escape');
      // Inline equation editor.
      await t.newLine(); await t.type('$x$ '); await sleep(200);
      const m = await centre('.ProseMirror .bmd-math, .ProseMirror [data-type="math_inline"], .ProseMirror .katex');
      if (m) {
        await t.click(m.x, m.y); await sleep(200);
        if (await t.vis('.bmd-math-editor')) {
          await ev(`document.querySelector('.bmd-math-editor input, .bmd-math-editor textarea').focus()`);
          await imeEnter('pingfang');
          if (!(await t.vis('.bmd-math-editor'))) bad.push('equation editor: confirming the IME saved and closed it');
          await t.key('Escape');
        } else bad.push('equation editor did not open');
      } else bad.push('no inline equation rendered');
      // Toggle title: Enter normally opens the body and moves into it.
      await t.open('<details>\n<summary>T</summary>\n\nbody\n\n</details>\n'); await inject();
      await ev(`(() => { const s = document.querySelector('.bmd-toggle-summary, .bmd-toggle-head [contenteditable]'); s.focus(); const r = document.createRange(); r.selectNodeContents(s); r.collapse(false); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
      await imeEnter('biaoti');
      if (!(await ev(`document.activeElement?.closest?.('.bmd-toggle-head') !== null`))) bad.push('toggle title: confirming the IME jumped into the body');
      if ((await t.save()) !== '<details>\n<summary>Tbiaoti</summary>\n\nbody\n\n</details>\n') bad.push('toggle title: saved ' + J(await t.save()));
      // Code language search.
      await t.open('```\nx\n```\n'); await inject();
      const b = await ev(`(() => { const r = __feel.rect('.bmd-code'); return { x: r.x + 40, y: r.y + r.h / 2 }; })()`);
      await t.hover(b.x, b.y);
      const lang = await centre('.bmd-code-lang'); await t.click(lang.x, lang.y); await sleep(200);
      await imeEnter('py');
      if (!(await t.save()).startsWith('```\n')) bad.push('language menu: confirming the IME chose a language: ' + J(await t.save()));
      await t.key('Escape');
      expect(!bad.length, bad.join('; '));
    },

    async 'ime-text'() {
      const bad = [];
      const cases = [
        ['empty line', 'start\n', async () => { await t.caret('start'); await t.key('Enter'); }, 'start\n\n你好\n'],
        ['middle of text', 'ab\n', () => t.caret('a'), 'a你好b\n'],
        ['list item', '- one\n', () => t.caret('one'), '- one你好\n'],
        ['new list item', '- one\n', async () => { await t.caret('one'); await t.key('Enter'); }, '- one\n- 你好\n'],
        ['heading', '# Title\n', () => t.caret('Title'), '# Title你好\n'],
        ['start of heading', '# Title\n', () => t.caret('Title', 'start'), '# 你好Title\n'],
        ['inside a toggle', '<details>\n<summary>T</summary>\n\nbody\n\n</details>\n', async () => {
          await ev(`(() => { const d = document.querySelector('.bmd-toggle'); if (d && !d.classList.contains('is-open')) d.querySelector('.bmd-toggle-arrow')?.click(); })()`);
          await sleep(200);
          // Click to the right of "body", as a person does to reach the end of a line.
          const p = await ev(`(() => { const e = [...document.querySelectorAll('.bmd-toggle-body .ProseMirror p')].find((x) => x.textContent === 'body'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.right - 8, y: b.top + b.height / 2 }; })()`);
          if (!p) throw new Error('toggle body did not open');
          await t.click(p.x, p.y);
        }, '<details>\n<summary>T</summary>\n\nbody你好\n\n</details>\n'],
      ];
      for (const [label, md, place, want] of cases) {
        await t.open(md); await place();
        const where = await ev(`(() => { const a = document.activeElement; return (a?.className || a?.tagName) + ' in ' + (a?.parentElement?.className || '') ; })()`);
        await ime('nihao', '你好');
        const got = await t.save();
        if (got !== want) bad.push(`${label}: saved ${J(got)}, expected ${J(want)} (typing into ${where}; page text ${J(await ev('document.querySelector(".ProseMirror").innerText'))})`);
      }
      expect(!bad.length, bad.join('; '));
    },

    async 'ime-colon'() {
      // The owner's rule: the full-width ： (Chinese mode) never opens the emoji picker —
      // the keyboard is still in Chinese mode after it — while the ASCII : does.
      await t.newLine(); await ime('maohao', '：'); await t.type('smi'); await sleep(300);
      expect(!(await t.vis('.bmd-emoji')), 'the full-width ： opened the emoji picker');
      await t.newLine(); await t.type(':smi'); await sleep(300);
      expect(await t.vis('.bmd-emoji'), 'the ASCII : no longer opens the emoji picker');
      await t.key('Escape');
    },

    /* ——— Visual regression ——— */
    async 'visual-regression'() {
      const dir = join(ROOT, 'parity', 'baselines');
      const out = join(WORK, 'visual');
      mkdirSync(dir, { recursive: true }); mkdirSync(out, { recursive: true });
      const still = async () => {
        await mouse(1090, 790); // park the pointer in the status bar corner
        await ev(`(() => { let s = document.getElementById('__feel-still'); if (!s) { s = document.createElement('style'); s.id = '__feel-still'; document.head.append(s); } s.textContent = '*, *::before, *::after { caret-color: transparent !important; transition: none !important; animation: none !important; }'; })()`);
        await sleep(500);
      };
      const states = {
        'document-light': async () => { await t.open(); await sleep(1200); },
        'document-dark': async () => { await t.open(); await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }); await sleep(1200); },
        'app-menu': async () => { await t.open('x\n'); await openMenu(); const s = await centre('.bmd-app-menu [data-section="File"]'); await t.hover(s.x, s.y); },
        'slash-menu': async () => { await t.newLine(); await t.type('/'); await sleep(400); },
        'block-menu': async () => { await t.open('first block\n\nsecond\n'); const g = await grip(0); await t.click(g.x, g.y); await sleep(250); },
        'toolbar': async () => { await t.open('hello world\n'); await t.select('world'); await sleep(300); },
        'find-replace': async () => { await t.open('cat and cat\n'); await t.caret('cat'); await t.key('Ctrl+H'); await t.type('cat'); },
        'narrow-window': async () => { await send('Emulation.setDeviceMetricsOverride', { width: 560, height: 420, deviceScaleFactor: 1, mobile: false }); await t.open(); await sleep(1000); },
      };
      const bad = [];
      for (const [name, setUp] of Object.entries(states)) {
        await setUp(); await still();
        if (name === 'app-menu' || name === 'block-menu' || name === 'slash-menu' || name === 'toolbar') {
          // The pointer parks away from menus; keep them open by not moving over the editor.
        }
        const { data } = await send('Page.captureScreenshot', { format: 'png' });
        await ev(`document.getElementById('__feel-still')?.remove(); true`);
        const base = join(dir, `${name}.png`);
        writeFileSync(join(out, `${name}.png`), Buffer.from(data, 'base64'));
        if (approve || !existsSync(base)) {
          if (!approve) { bad.push(`${name}: no approved screenshot (run with --approve-visuals after looking at .cache/parity/visual/${name}.png)`); }
          else writeFileSync(base, Buffer.from(data, 'base64'));
        } else {
          const b64 = readFileSync(base).toString('base64');
          const r = await ev(`(async () => {
            const load = (s) => new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = no; i.src = 'data:image/png;base64,' + s; });
            const [a, b] = await Promise.all([load(${J(b64)}), load(${J(data)})]);
            if (a.width !== b.width || a.height !== b.height) return { size: [a.width, a.height, b.width, b.height] };
            const c = document.createElement('canvas'); c.width = a.width; c.height = a.height;
            const x = c.getContext('2d', { willReadFrequently: true });
            x.drawImage(a, 0, 0); const A = x.getImageData(0, 0, c.width, c.height);
            x.drawImage(b, 0, 0); const B = x.getImageData(0, 0, c.width, c.height);
            const D = x.createImageData(c.width, c.height);
            // Anti-aliasing tolerance: text edges render a little differently from one
            // launch of the app to the next. A pixel only counts as changed if nothing
            // within one pixel of it in the other image matches — a real change (a row
            // moved, a colour changed) still does.
            const W = c.width, H = c.height;
            const near = (X, Y, p) => {
              const x0 = (p / 4) % W, y0 = Math.floor(p / 4 / W);
              for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                const x = x0 + dx, y = y0 + dy;
                if (x < 0 || y < 0 || x >= W || y >= H) continue;
                const q = (y * W + x) * 4;
                if (Math.max(Math.abs(X.data[q] - Y.data[p]), Math.abs(X.data[q + 1] - Y.data[p + 1]), Math.abs(X.data[q + 2] - Y.data[p + 2])) <= 40) return true;
              }
              return false;
            };
            let diff = 0;
            for (let p = 0; p < A.data.length; p += 4) {
              const d = Math.max(Math.abs(A.data[p] - B.data[p]), Math.abs(A.data[p + 1] - B.data[p + 1]), Math.abs(A.data[p + 2] - B.data[p + 2]));
              if (d > 40 && !(near(A, B, p) && near(B, A, p))) { diff++; D.data[p] = 255; D.data[p + 3] = 255; } else { D.data[p] = D.data[p + 1] = D.data[p + 2] = B.data[p]; D.data[p + 3] = 60; }
            }
            x.putImageData(D, 0, 0);
            return { diff, total: A.data.length / 4, png: diff ? c.toDataURL('image/png').split(',')[1] : null };
          })()`);
          if (r.size) bad.push(`${name}: size changed ${r.size[0]}×${r.size[1]} → ${r.size[2]}×${r.size[3]}`);
          else if (r.diff / r.total > 0.001) {
            writeFileSync(join(out, `${name}-diff.png`), Buffer.from(r.png, 'base64'));
            bad.push(`${name}: ${(100 * r.diff / r.total).toFixed(2)}% of pixels changed (see .cache/parity/visual/${name}-diff.png)`);
          }
        }
        await t.key('Escape');
        await send('Emulation.setEmulatedMedia', { features: [] });
        await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: 1, mobile: false });
      }
      expect(!bad.length, bad.join('; '));
    },

    /* ——— Window sizes ——— */
    async 'narrow-window'() {
      await send('Emulation.setDeviceMetricsOverride', { width: 560, height: 420, deviceScaleFactor: 1, mobile: false });
      expect(!(await layoutProblems()).length, (await layoutProblems()).join('; '));
    },
    async 'display-scaling'() {
      const bad = [];
      for (const dpr of [1.5, 2]) {
        await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 800, deviceScaleFactor: dpr, mobile: false });
        await t.open(FIXTURE); await sleep(600); await inject();
        bad.push(...(await layoutProblems()).map((p) => `${dpr * 100}%: ${p}`));
        const blurry = await ev(`[...document.querySelectorAll('img')].filter((i) => __parity.visible(i) && i.naturalWidth && i.naturalWidth < i.getBoundingClientRect().width * ${dpr} - 1 && !i.closest('.ProseMirror')).map((i) => i.src.split('/').pop() + ' ' + i.naturalWidth + 'px shown at ' + Math.round(i.getBoundingClientRect().width * ${dpr}) + 'px')`);
        if (blurry.length) bad.push(`${dpr * 100}%: blurry icons: ${blurry.join(', ')}`);
      }
      expect(!bad.length, bad.join('; '));
    },

    /* ——— Accessibility ——— */
    async 'contrast'() {
      const bad = [], hints = [];
      const scan = async (where) => {
        await inject();
        const low = await ev(`__feel.texts(document.body, ${J(NOTION_FAINT)}).filter((x) => x.ratio < x.need)`);
        for (const x of low) (x.hint ? hints : bad).push(`${where}: "${x.text}" ${x.ratio}:1 (needs ${x.need}) .${x.cls.split(' ')[0] || x.tag}`);
      };
      for (const scheme of ['light', 'dark']) {
        await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
        await t.open(FIXTURE); await sleep(600); await scan(`${scheme} document`);
        await openMenu(); const s = await centre('.bmd-app-menu [data-section="File"]'); await t.hover(s.x, s.y); await scan(`${scheme} app menu`); await t.key('Escape');
        await t.newLine(); await t.type('/'); await sleep(300); await scan(`${scheme} slash menu`); await t.key('Escape');
        await t.open('hello world\n'); await t.caret('hello'); await t.key('Ctrl+H'); await scan(`${scheme} find bar`); await t.key('Escape');
      }
      await send('Emulation.setEmulatedMedia', { features: [] });
      // One line per distinct problem, not one per occurrence.
      const uniq = (list) => [...new Set(list.map((b) => b.replace(/"[^"]*" /, '')))];
      if (hints.length) console.log(`    Notion-faint text below AA (feel.json: contrast-hints, kept by the owner's decision): ${uniq(hints).length} kinds`);
      expect(!uniq(bad).length, `${uniq(bad).length} low-contrast kinds of text: ${uniq(bad).slice(0, 12).join('; ')}`);
    },

    async 'names'() {
      const bad = [];
      const scan = async (where) => {
        await inject();
        const r = await ev(`(() => {
          const out = [];
          for (const e of document.querySelectorAll('button, input, select, textarea, [role="menuitem"], [role="menuitemcheckbox"], a[href]')) {
            if (!__parity.visible(e) || e.closest('.ProseMirror [contenteditable="false"] a')) continue;
            if (e.type === 'hidden' || e.type === 'file') continue;
            if (!__feel.name(e)) out.push(e.tagName.toLowerCase() + '.' + (e.className?.baseVal ?? e.className).toString().split(' ')[0]);
          }
          for (const m of document.querySelectorAll('.bmd-menu, .bmd-slash, .bmd-emoji')) {
            if (__parity.visible(m) && !['menu', 'listbox', 'dialog', 'grid'].includes(m.getAttribute('role'))) out.push('menu without a role: .' + m.className.split(' ').join('.'));
          }
          return out;
        })()`);
        for (const x of r) bad.push(`${where}: ${x}`);
      };
      await t.open(FIXTURE); await sleep(400); await scan('document');
      await openMenu(); const s = await centre('.bmd-app-menu [data-section="File"]'); await t.hover(s.x, s.y); await scan('app menu'); await t.key('Escape');
      await t.newLine(); await t.type('/'); await sleep(300); await scan('slash menu'); await t.key('Escape');
      await t.open('a\n'); const g = await grip(0); await scan('drag handle'); await t.click(g.x, g.y); await sleep(200); await scan('block menu'); await t.key('Escape');
      await t.open('hello world\n'); await t.select('world'); await sleep(300); await scan('toolbar');
      await t.caret('hello'); await t.key('Ctrl+H'); await scan('find bar'); await t.key('Escape');
      await t.newLine(); await t.type(':smi'); await sleep(300); await scan('emoji picker'); await t.key('Escape');
      const uniq = [...new Set(bad)];
      expect(!uniq.length, uniq.slice(0, 15).join('; '));
    },
  };
  checks['hover-feedback'].timeout = 240000;
  checks['visual-regression'].timeout = 120000;
  checks['memory'].timeout = 180000;
  checks['ime-enter'].timeout = 90000;
  checks['contrast'].timeout = 90000;
  checks['display-scaling'].timeout = 60000;
  checks['large-file'].timeout = 60000;
  checks['typing-latency'].timeout = 90000;

  const last = (a) => a[a.length - 1];

  /** Things wrong with the layout at the current window size. */
  async function layoutProblems() {
    const bad = [];
    await t.open(FIXTURE); await sleep(500); await inject();
    const w = await ev('innerWidth');
    const sw = await ev('document.documentElement.scrollWidth');
    if (sw > w + 1) bad.push(`the page scrolls sideways (${sw} px wide in a ${w} px window)`);
    const overlaps = await ev(`(() => {
      const out = [];
      for (const bar of ['.topbar', '.statusbar']) {
        const kids = [...document.querySelectorAll(bar + ' > *, ' + bar + ' .topbar-actions > *')].filter((e) => __parity.visible(e) && !e.classList.contains('topbar-actions') && !e.classList.contains('spacer'));
        for (const e of kids) { const r = e.getBoundingClientRect(); if (r.left < -1 || r.right > innerWidth + 1) out.push(bar + ' ' + (e.id || e.className) + ' is cut off'); }
        for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) {
          const a = kids[i].getBoundingClientRect(), b = kids[j].getBoundingClientRect();
          if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) out.push(bar + ': ' + (kids[i].id || kids[i].className) + ' overlaps ' + (kids[j].id || kids[j].className));
        }
      }
      const f = document.getElementById('filename');
      if (f.scrollWidth > f.clientWidth + 1 && getComputedStyle(f).textOverflow !== 'ellipsis') out.push('a long file name is clipped without …');
      return out;
    })()`);
    bad.push(...overlaps);
    const inView = (sel, label) => ev(`(() => { const out = []; for (const e of document.querySelectorAll(${J(sel)})) { if (!__parity.visible(e)) continue; const r = e.getBoundingClientRect(); if (r.left < 0 || r.top < 0 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) out.push(${J(label)} + ' goes off screen (' + [r.left, r.top, r.right, r.bottom].map(Math.round) + ')'); } return out; })()`);
    // App menu, three levels deep.
    await openMenu();
    const s = await centre('.bmd-app-menu [data-section="File"]'); await t.hover(s.x, s.y);
    const p = await centre('.bmd-app-sub:not(.bmd-app-deep) .bmd-app-item', 'Open Recent');
    if (p) { await t.glide(s, p, 4); }
    bad.push(...await inView('.bmd-app-menu, .bmd-app-sub', 'the app menu'));
    await t.key('Escape');
    // Slash menu on the last visible line.
    await t.open('start\n'); await t.caret('start'); await t.key('Enter'); await t.type('/'); await sleep(300);
    bad.push(...await inView('.bmd-slash', 'the slash menu'));
    await t.key('Escape');
    // Block menu.
    await t.open('a\n'); const g = await grip(0); await t.click(g.x, g.y); await sleep(200);
    bad.push(...await inView('.bmd-menu', 'the block menu'));
    await t.key('Escape');
    // Toolbar at the right edge.
    await t.open('some words at the very end of a line here\n'); await t.select('here'); await sleep(300);
    bad.push(...await inView('.bmd-toolbar', 'the toolbar'));
    return bad;
  }

  return checks;
}
