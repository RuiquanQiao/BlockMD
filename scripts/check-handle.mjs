/**
 * Assert that the drag handle never covers block content.
 *
 * This exists because eyeballing screenshots missed it twice. The handle is
 * positioned by floating-ui from an async callback, against whatever node the block
 * plugin resolved — which for a list item is the `li`, whose left edge is where the
 * *text* starts. Both times the symptom was the handle sitting on a bullet.
 *
 * The check sweeps every top-level block at several window widths and asserts two
 * invariants per block:
 *
 *   1. the handle is entirely left of the text column, and
 *   2. it is vertically on the block it belongs to (a stale async position lands on
 *      the previously hovered block instead).
 *
 * These are the same invariants app/editor/handle-guard.js enforces at runtime; this
 * script is what proves the guard is never the thing keeping the handle hidden.
 *
 * Usage — the app must be running with the debugging port open, which needs a config
 * override rather than a committed setting:
 *
 *   npm run desktop:debug        # in one terminal
 *   npm run check:handle         # in another
 *
 * A browser tab cannot stand in for the real window here: plugin-block mounts inside
 * requestAnimationFrame, and rAF does not fire in a hidden tab.
 */

const PORT = process.env.BMD_CDP_PORT ?? '9222';
const WIDTHS = (process.env.BMD_WIDTHS ?? '1400,1000,760,620').split(',').map(Number);

async function connect() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const page = (await res.json()).find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('chrome-extension:'));
  if (!page) throw new Error('no debuggable page — start the app with npm run desktop:debug');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });

  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    const entry = pending.get(msg.id);
    if (!entry) return;
    pending.delete(msg.id);
    if (msg.error) entry.reject(new Error(msg.error.message));
    else entry.resolve(msg.result);
  });

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mine = ++id;
      pending.set(mine, { resolve, reject });
      ws.send(JSON.stringify({ id: mine, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'evaluation threw');
    }
    return r.result?.value;
  };

  return { send, evaluate, close: () => ws.close() };
}

/** Runs inside the page: report where every top-level block is. */
const BLOCK_RECTS = `(() => {
  const dom = window.__bmd.view().dom;
  if (!document.querySelector('.bmd-handle')) return { error: 'handle element is not mounted' };
  return {
    width: window.innerWidth,
    blocks: [...dom.children].map((el, i) => {
      const r = el.getBoundingClientRect();
      return { index: i, tag: el.tagName.toLowerCase(),
               left: r.left, top: r.top, bottom: r.bottom, height: r.height };
    }).filter(b => b.height > 0),
  };
})()`;

/** Runs inside the page: measure the handle against the block just hovered. */
const measure = (block) => `(() => {
  const handle = document.querySelector('.bmd-handle');
  const dom = window.__bmd.view().dom;
  const el = dom.children[${block.index}];
  const h = handle.getBoundingClientRect();
  const b = el.getBoundingClientRect();
  const col = dom.getBoundingClientRect();
  const centre = h.top + h.height / 2;
  return {
    shown: handle.dataset.show === 'true',
    valid: handle.dataset.valid === '1',
    // Reported from raw geometry, so a handle the guard hid is still measured.
    overlapsText: h.right > col.left + 1,
    offBlock: !(centre >= b.top - 2 && centre <= b.bottom + 2),
    handleRight: Math.round(h.right),
    columnLeft: Math.round(col.left),
    gap: Math.round(col.left - h.right),
  };
})()`;

/**
 * Hover a point with real browser input.
 *
 * Synthetic `new MouseEvent(...)` does not work here: plugin-block listens for
 * `pointermove`, and dispatching the wrong event type made an earlier version of this
 * script pass without the handle ever appearing. Trusted CDP input exercises the same
 * path a hand on the mouse does.
 */
async function hover(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
}

const cdp = await connect();
let failures = 0;
let checked = 0;

for (const width of WIDTHS) {
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width,
    height: 900,
    deviceScaleFactor: 0,
    mobile: false,
  });
  // Give the layout and the guard a frame to settle after the resize.
  await cdp.evaluate('new Promise(r => setTimeout(r, 400))');

  const layout = await cdp.evaluate(BLOCK_RECTS);
  if (layout?.error) {
    console.error(`  width ${width}: ${layout.error}`);
    failures++;
    continue;
  }

  const results = [];
  for (const listed of layout.blocks) {
    // Bring the block on screen first and re-measure it. A document taller than the
    // viewport otherwise sends the pointer below the window, where it hovers nothing,
    // and the handle reports as "not on this block" while still showing the last one.
    const block = {
      ...listed,
      ...(await cdp.evaluate(`(() => {
        const el = window.__bmd.view().dom.children[${listed.index}];
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { left: r.left, top: r.top, bottom: r.bottom, height: r.height };
      })()`)),
    };
    // Two moves: the plugin throttles pointermove, so a lone event can be dropped.
    const y = block.top + Math.min(8, block.height / 2);
    await hover(cdp, block.left + 24, y);
    await cdp.evaluate('new Promise(r => setTimeout(r, 120))');
    await hover(cdp, block.left + 25, y);
    await cdp.evaluate('new Promise(r => setTimeout(r, 200))');
    results.push({ ...block, ...(await cdp.evaluate(measure(block))) });
  }

  const shown = results.filter((r) => r.shown);
  const bad = shown.filter((r) => r.overlapsText || r.offBlock);
  const refused = shown.filter((r) => !r.valid);
  const gaps = results.filter((r) => r.valid).map((r) => r.gap);
  checked += results.length;

  console.log(
    `width ${String(width).padStart(4)}  blocks ${String(results.length).padStart(2)}  ` +
      `handle shown ${shown.length}  overlaps ${bad.length}  ` +
      `refused-by-guard ${refused.length}  ` +
      `min gap to text ${gaps.length ? Math.min(...gaps) + 'px' : 'n/a'}`,
  );

  // A sweep where the handle never appeared proves nothing. Treat it as a failure
  // rather than a pass — the first version of this script "passed" that way.
  if (shown.length === 0) {
    console.error(`    the handle never appeared at width ${width}; the sweep is vacuous`);
    failures++;
  }

  for (const r of bad) {
    console.error(
      `    block ${r.index} <${r.tag}>: ` +
        (r.overlapsText ? `handle right ${r.handleRight} > column left ${r.columnLeft}` : '') +
        (r.offBlock ? ' handle is not on this block' : ''),
    );
  }
  failures += bad.length;
}

await cdp.send('Emulation.clearDeviceMetricsOverride');
cdp.close();

console.log(`\n${checked} block/width combinations checked, ${failures} overlapping.`);
process.exit(failures === 0 ? 0 : 1);
