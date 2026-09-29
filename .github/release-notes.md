Download the installer for your platform below. BlockMD 0.1.1, 0.1.2 and 0.1.6 or
later offer new versions by themselves when you open them. **0.1.3 and 0.1.4 can't**
(a bug fixed in 0.1.6): if you have one of those, install this version by hand once.

**Windows** — two installers are published and they register BlockMD
identically; pick either. `-setup.exe` (NSIS) is the smaller one and the
normal choice. `.msi` is for unattended or managed deployment
(`msiexec /i BlockMD_x64_en-US.msi /qn`).

Both register BlockMD as a handler for `.md` and `.markdown`. Windows will
not let an installer take the default file association, so to get
double-click opening: right-click any `.md` → Open with → Choose another
app → BlockMD → *Always use this app*.

Two things worth knowing before you install:

- **The installer needs an internet connection** if the Microsoft Edge
  WebView2 runtime is not already present. It is preinstalled on Windows 11
  and on most Windows 10 machines. Bundling it offline would add ~130 MB to
  a 2 MB installer, which is not a trade we are willing to make.
- **After uninstalling**, if you had set BlockMD as your default `.md` app,
  Windows may still point `.md` at it. That choice lives in a hash-protected
  per-user key that belongs to you, not to our uninstaller, so we do not
  touch it. Pick a new default under Settings → Apps → Default apps.

**macOS** — the build is unsigned, so the first launch needs
right-click → Open.
