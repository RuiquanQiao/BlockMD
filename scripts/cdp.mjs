/**
 * Evaluate JavaScript inside a running BlockMD window over the DevTools protocol.
 *
 * Why this exists: the desktop build's webview is WebView2, and synthetic keystrokes
 * from the Windows input APIs do not reach its content — which rules out driving the
 * app the way a UI test normally would. WebView2 does expose the standard debugging
 * protocol, so end-to-end checks of the *desktop* path go through here.
 *
 * Launch the app with debugging enabled, then talk to it:
 *
 *   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222 npm run desktop
 *   node scripts/cdp.mjs "__bmd.session.status()"
 *
 * On macOS and Linux the equivalent switch is passed through the webview's own
 * configuration; this script only needs the port to be listening.
 */

const PORT = process.env.BMD_CDP_PORT ?? '9222';
const expression = process.argv.slice(2).join(' ');

if (!expression) {
  console.error('usage: node scripts/cdp.mjs "<javascript expression>"');
  process.exit(2);
}

/** Find the first page target that is actually the app. */
async function pageTarget() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  const targets = await res.json();
  // The app's own page — not an embedded viewer (a PDF preview is a target of its own).
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl && !t.url.startsWith('chrome-extension:'));
  if (!page) throw new Error('no debuggable page found — is the app running with --remote-debugging-port?');
  return page;
}

const page = await pageTarget();
const ws = new WebSocket(page.webSocketDebuggerUrl);

const result = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('timed out waiting for the page to answer')), 15_000);

  ws.addEventListener('error', reject);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      id: 1,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }));
  });
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id !== 1) return;
    clearTimeout(timer);
    if (msg.result?.exceptionDetails) {
      reject(new Error(msg.result.exceptionDetails.exception?.description ?? 'evaluation threw'));
    } else {
      resolve(msg.result?.result?.value);
    }
  });
});

ws.close();
console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
