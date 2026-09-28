/**
 * Self-update: a quiet bar in the bottom-right corner when a newer release exists.
 *
 * Releases are the only source of updates. The app fetches `latest.json` from the
 * newest *published* GitHub release (drafts are invisible to it), and the updater
 * plugin refuses any download whose signature doesn't match the public key in
 * tauri.conf.json — so only builds signed by our release workflow can install.
 *
 * Nothing installs without a click, and never over unsaved work: an update closes
 * the app, and the user must not lose edits to it.
 */

import * as platform from './platform.js';

/** Check again this often while the app stays open. */
const RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * @param {{ isDirty: () => boolean }} opts
 */
export function startUpdateChecks({ isDirty }) {
  const bar = document.createElement('div');
  bar.className = 'update-bar';
  bar.setAttribute('role', 'status');
  bar.hidden = true;
  document.body.append(bar);

  let offered = null;
  let busy = false;

  function show(html) {
    bar.innerHTML = html;
    bar.hidden = false;
  }

  function offer(update) {
    offered = update;
    show(
      `<span class="update-text">BlockMD ${escape(update.version)} is available</span>` +
      '<button class="btn" type="button" data-act="later">Later</button>' +
      '<button class="btn btn-primary" type="button" data-act="install">Update</button>',
    );
  }

  async function install() {
    if (busy || !offered) return;
    if (isDirty()) {
      show(
        '<span class="update-text">Save your changes first, then update.</span>' +
        '<button class="btn btn-primary" type="button" data-act="retry">OK</button>',
      );
      return;
    }
    busy = true;
    let total = 0;
    let done = 0;
    show('<span class="update-text">Downloading update…</span>');
    const text = () => bar.querySelector('.update-text');
    try {
      await offered.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0;
        if (event.event === 'Progress') {
          done += event.data.chunkLength;
          if (total) text().textContent = `Downloading update… ${Math.round((done / total) * 100)}%`;
        }
        if (event.event === 'Finished') text().textContent = 'Installing…';
      });
      // Windows exits during installation and the installer restarts the app; this
      // line is reached on macOS.
      await platform.relaunch();
    } catch (err) {
      busy = false;
      show(
        `<span class="update-text">Update failed: ${escape(String(err?.message ?? err))}</span>` +
        '<button class="btn" type="button" data-act="later">Close</button>',
      );
    }
  }

  bar.addEventListener('click', (e) => {
    const act = e.target.closest('button')?.dataset.act;
    if (act === 'later') { bar.hidden = true; }
    if (act === 'install') install();
    if (act === 'retry') offer(offered);
  });

  async function check() {
    if (busy) return;
    try {
      const update = await platform.checkForUpdate();
      if (update && update.version !== offered?.version) offer(update);
    } catch (err) {
      // Offline, rate-limited, or no release yet: not worth interrupting anyone for.
      console.warn('[BlockMD] update check failed:', err);
    }
  }

  check();
  setInterval(check, RECHECK_MS);

  // Help ▸ Check for Updates…: the same check, but it always answers.
  manualCheck = async () => {
    try {
      const update = await platform.checkForUpdate();
      if (update) { bar.hidden = true; offered = null; offer(update); return; }
      await platform.showMessage(`You're on the latest version (BlockMD ${await platform.appVersion()}).`, 'Check for Updates');
    } catch (err) {
      await platform.showMessage(`Couldn't check for updates: ${err?.message ?? err}`, 'Check for Updates');
    }
  };
}

let manualCheck = async () => {};
/** Check now and report the result, even when there is nothing new. */
export const checkForUpdatesNow = () => manualCheck();

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
