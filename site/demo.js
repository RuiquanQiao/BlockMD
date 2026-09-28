// The home page demo: a few blocks on the left, the file they came from on the right.
// Dragging a block moves its original text in the file unchanged, and that's the point:
// the `====` heading, `_italic_` and `*` bullets survive because BlockMD copies the
// bytes of each block rather than regenerating Markdown from the editor.
(function () {
  var blocksEl = document.getElementById('blocks');
  var fileEl = document.getElementById('file');
  if (!blocksEl || !fileEl) return;

  var blocks = [
    { id: 'h', kind: 'h', raw: 'Trip notes\n==========', html: '<h4>Trip notes</h4>' },
    { id: 'p', kind: 'p', raw: 'Pack the _good_ camera.', html: '<p>Pack the <em>good</em> camera.</p>' },
    { id: 'l', kind: 'l', raw: '* passport\n* charger\n* umbrella', html: '<ul><li>passport</li><li>charger</li><li>umbrella</li></ul>' },
    { id: 'c', kind: 'c', raw: '> [!NOTE]\n> Train leaves at 7:40.', html: '<div class="callout-box"><span aria-hidden="true">💡</span><span>Train leaves at 7:40.</span></div>' },
    { id: 't', kind: 't', raw: '- [ ] Book the hostel', html: '<div class="todo"><span class="box" aria-hidden="true"></span><span>Book the hostel</span></div>' }
  ];

  var GRIP = '<svg viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">' +
    '<circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/>' +
    '<circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/>' +
    '<circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></svg>';

  function renderBlocks() {
    blocksEl.innerHTML = blocks.map(function (b) {
      return '<li class="block" data-id="' + b.id + '" data-kind="' + b.kind + '">' +
        '<button class="handle" type="button" aria-label="Move block">' + GRIP + '</button>' +
        '<div class="block-body">' + b.html + '</div></li>';
    }).join('');
  }

  function renderFile(flashId) {
    var n = 0;
    fileEl.innerHTML = blocks.map(function (b, i) {
      var lines = b.raw.split('\n');
      if (i < blocks.length - 1) lines.push('');
      return lines.map(function (line, j) {
        n++;
        var owned = j < b.raw.split('\n').length;
        var cls = 'ln' + (owned && b.id === flashId ? ' flash' : '');
        return '<span class="' + cls + '" data-n="' + n + '">' + escape(line) + '</span>';
      }).join('');
    }).join('');
  }

  function escape(s) {
    return s.replace(/[&<>]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]; }) || ' ';
  }

  function flash(id) {
    renderFile(id);
    var el = blocksEl.querySelector('[data-id="' + id + '"]');
    if (el) el.classList.add('flash');
    // Remove the class on the next frame so the background fades out through its transition.
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        document.querySelectorAll('.flash').forEach(function (e) { e.classList.remove('flash'); });
      });
    });
  }

  function move(from, to) {
    if (to === from || to === from + 1) return false;
    var b = blocks.splice(from, 1)[0];
    blocks.splice(to > from ? to - 1 : to, 0, b);
    renderBlocks();
    flash(b.id);
    return true;
  }

  // ——— Pointer drag: a blue line shows where the block will land, like Notion ———
  var drag = null;
  var line = document.createElement('div');
  line.className = 'drop-line';
  line.hidden = true;

  function slotAt(y) {
    var items = blocksEl.querySelectorAll('.block');
    for (var i = 0; i < items.length; i++) {
      var r = items[i].getBoundingClientRect();
      if (y < r.top + r.height / 2) return i;
    }
    return items.length;
  }

  function placeLine(slot) {
    var items = blocksEl.querySelectorAll('.block');
    var host = blocksEl.getBoundingClientRect();
    var y = slot < items.length
      ? items[slot].getBoundingClientRect().top
      : items[items.length - 1].getBoundingClientRect().bottom;
    line.style.top = (y - host.top) + 'px';
    line.hidden = false;
  }

  blocksEl.addEventListener('pointerdown', function (e) {
    var handle = e.target.closest('.handle');
    if (!handle || e.button !== 0) return;
    e.preventDefault();
    blocksEl.classList.remove('hint');
    var li = handle.closest('.block');
    drag = { el: li, from: Array.prototype.indexOf.call(blocksEl.children, li), slot: null };
    li.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    blocksEl.appendChild(line);
  });

  blocksEl.addEventListener('pointermove', function (e) {
    if (!drag) return;
    drag.slot = slotAt(e.clientY);
    placeLine(drag.slot);
  });

  function endDrag() {
    if (!drag) return;
    var d = drag;
    drag = null;
    line.hidden = true;
    if (line.parentNode) line.parentNode.removeChild(line);
    d.el.classList.remove('dragging');
    if (d.slot != null) move(d.from, d.slot);
  }
  blocksEl.addEventListener('pointerup', endDrag);
  blocksEl.addEventListener('pointercancel', function () { if (drag) { drag.slot = null; endDrag(); } });

  // ——— Keyboard: Alt+↑/↓ on a focused handle moves the block ———
  blocksEl.addEventListener('keydown', function (e) {
    var handle = e.target.closest('.handle');
    if (!handle || !e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    var from = Array.prototype.indexOf.call(blocksEl.children, handle.closest('.block'));
    var id = blocks[from].id;
    if (move(from, e.key === 'ArrowUp' ? from - 1 : from + 2)) {
      blocksEl.querySelector('[data-id="' + id + '"] .handle').focus();
    }
  });

  renderBlocks();
  renderFile();
})();
