// Release data for the website: which versions exist, and which file each platform
// should download.
//
// The list comes from releases.json, which the Pages workflow writes from the GitHub
// API at deploy time and again whenever a release is published. Reading a file from
// our own origin avoids the API's limit of 60 requests an hour per visitor IP. If the
// file is missing (running locally, or a deploy that failed), fall back to the live API.
(function () {
  var REPO = 'RuiquanQiao/BlockMD';
  var RELEASES_PAGE = 'https://github.com/' + REPO + '/releases';

  // Installer names carry the version (BlockMD_0.1.0_x64-setup.exe), so files are
  // recognised by pattern rather than by name. Order within a platform is display order;
  // the first file is the one the big button downloads.
  var PLATFORMS = [
    {
      id: 'windows', os: 'windows', name: 'Windows', short: 'Windows',
      desc: 'Windows 10 and 11, 64-bit.',
      files: [
        { test: /_x64-setup\.exe$/i, label: 'Installer', ext: '.exe' },
        { test: /\.msi$/i, label: 'MSI', ext: '.msi', hint: 'For managed or unattended installs' }
      ]
    },
    {
      id: 'mac-arm', os: 'mac', name: 'macOS — Apple silicon', short: 'Mac',
      desc: 'Macs with an M1 chip or newer.',
      files: [{ test: /_aarch64\.dmg$/i, label: 'Disk image', ext: '.dmg' }]
    },
    {
      id: 'mac-intel', os: 'mac', name: 'macOS — Intel', short: 'Intel Mac',
      desc: 'Macs with an Intel processor.',
      files: [{ test: /_x64\.dmg$/i, label: 'Disk image', ext: '.dmg' }]
    }
  ];

  // Tauri's updater bundles and signatures: not something a person downloads by hand.
  var HIDDEN = /\.app\.tar\.gz(\.sig)?$|\.sig$|^latest\.json$/i;

  function normalise(r) {
    return {
      tag: r.tag_name,
      version: String(r.tag_name).replace(/^v/, ''),
      name: r.name || r.tag_name,
      date: r.published_at,
      prerelease: !!r.prerelease,
      notes: r.body || '',
      url: r.html_url,
      assets: (r.assets || []).map(function (a) {
        return { name: a.name, size: a.size, url: a.browser_download_url };
      })
    };
  }

  function fetchJSON(url) {
    return fetch(url, { headers: { Accept: 'application/vnd.github+json' } }).then(function (res) {
      if (!res.ok) throw new Error(url + ' → HTTP ' + res.status);
      return res.json();
    });
  }

  var cached = null;
  function all() {
    if (cached) return cached;
    cached = fetchJSON('releases.json')
      .catch(function () { return fetchJSON('https://api.github.com/repos/' + REPO + '/releases?per_page=100'); })
      .then(function (list) {
        return list
          .filter(function (r) { return !r.draft; })
          .map(normalise)
          .sort(function (a, b) { return new Date(b.date) - new Date(a.date); });
      });
    return cached;
  }

  // "Latest" is the newest stable release; a pre-release only wins if nothing else exists.
  function latest() {
    return all().then(function (list) {
      return list.find(function (r) { return !r.prerelease; }) || list[0] || null;
    }).catch(function () { return null; });
  }

  // Sort a release's files into platforms. Anything unrecognised lands in `other`,
  // so a new kind of file still shows up somewhere instead of silently vanishing.
  function group(rel) {
    var used = {};
    var platforms = PLATFORMS.map(function (p) {
      var files = [];
      p.files.forEach(function (f) {
        rel.assets.forEach(function (a) {
          if (!used[a.name] && f.test.test(a.name)) {
            used[a.name] = true;
            files.push({ asset: a, label: f.label, ext: f.ext, hint: f.hint });
          }
        });
      });
      return { platform: p, files: files };
    }).filter(function (g) { return g.files.length; });
    var other = rel.assets.filter(function (a) { return !used[a.name] && !HIDDEN.test(a.name); });
    return { platforms: platforms, other: other };
  }

  function detectOS() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) ||
             navigator.platform || navigator.userAgent || '').toLowerCase();
    if (/win/.test(p)) return 'windows';
    if (/iphone|ipad|ipod|android/.test((navigator.userAgent || '').toLowerCase())) return 'mobile';
    if (/mac/.test(p)) return 'mac';
    if (/linux|x11|cros/.test(p)) return 'linux';
    return 'other';
  }

  // The file the big button should download. On a Mac this is Apple silicon: browsers
  // report "Intel" on every Mac, so the architecture can't be read; the Intel build is
  // offered right beside it on the download page.
  function primaryFor(rel, os) {
    var g = group(rel);
    for (var i = 0; i < g.platforms.length; i++) {
      if (g.platforms[i].platform.os === os) {
        return { platform: g.platforms[i].platform, asset: g.platforms[i].files[0].asset };
      }
    }
    return null;
  }

  function size(bytes) {
    // Decimal units, as macOS and download pages generally report them.
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(1) + ' MB';
    return Math.max(1, Math.round(bytes / 1e3)) + ' KB';
  }

  function date(iso) {
    return new Date(iso).toLocaleDateString(document.documentElement.lang || 'en',{ year: 'numeric', month: 'long', day: 'numeric' });
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // Just enough Markdown for release notes: paragraphs, "-" lists, **bold**, *em*, `code`.
  // Everything is escaped first, so a release body can't inject markup.
  function notes(md) {
    function inline(s) {
      return esc(s)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\*([^*]+)\*/g, '<em>$1</em>');
    }
    return md.replace(/\r\n/g, '\n').split(/\n{2,}/).map(function (block) {
      var lines = block.split('\n');
      if (/^\s*[-*] /.test(lines[0])) {
        var items = [];
        lines.forEach(function (l) {
          if (/^\s*[-*] /.test(l)) items.push(l.replace(/^\s*[-*] /, ''));
          else if (items.length) items[items.length - 1] += ' ' + l.trim();
        });
        return '<ul>' + items.map(function (i) { return '<li>' + inline(i) + '</li>'; }).join('') + '</ul>';
      }
      return '<p>' + inline(lines.map(function (l) { return l.trim(); }).join(' ')) + '</p>';
    }).join('');
  }

  window.BMD = {
    REPO: REPO, RELEASES_PAGE: RELEASES_PAGE,
    all: all, latest: latest, group: group, detectOS: detectOS, primaryFor: primaryFor,
    size: size, date: date, esc: esc, notes: notes
  };
})();
