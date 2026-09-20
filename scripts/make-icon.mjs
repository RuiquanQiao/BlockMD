/**
 * Generate the application icon.
 *
 * Writes a 1024×1024 RGBA PNG that `tauri icon` fans out into every platform size.
 * Kept as code rather than a checked-in binary so the mark can be adjusted, and
 * written with no image dependency — a rounded rectangle has a closed-form signed
 * distance function, which gives cleaner edges than supersampling and needs nothing
 * but zlib.
 *
 *   node scripts/make-icon.mjs
 *   npx tauri icon src-tauri/icons/source.png
 *
 * The mark: three stacked bars — the document as a stack of blocks — with the middle
 * one in the accent blue and nudged right, because moving a block is the thing this
 * editor does that a plain Markdown editor does not.
 */

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../src-tauri/icons/source.png');

/* ----------------------------------------------------------------- geometry */

/**
 * Signed distance from point (px,py) to a rounded rectangle.
 * Negative inside, positive outside, in the same units as the inputs.
 */
function roundedRectDistance(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

/** Coverage in [0,1] for a distance, anti-aliased across one pixel. */
const coverage = (d) => Math.min(Math.max(0.5 - d, 0), 1);

/* -------------------------------------------------------------------- paint */

const px = (n) => (n * SIZE) / 100; // percentages of the canvas, for legibility

const INK_TOP = [0x3a, 0x37, 0x30];
const INK_BOTTOM = [0x21, 0x1f, 0x1c];
const WHITE = [0xff, 0xff, 0xff];
const ACCENT = [0x23, 0x83, 0xe2];

/** [centreX, centreY, halfWidth, halfHeight, colour] for each bar, in percent. */
const BARS = [
  [50 - 22 + 21, 34, 21, 5.2, WHITE],
  [50 - 22 + 16 + 6, 50, 16, 5.2, ACCENT], // nudged right: a block mid-move
  [50 - 22 + 18, 66, 18, 5.2, WHITE],
];

const rgba = new Uint8Array(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  // Vertical gradient across the plate, so the icon has a little depth at large sizes.
  const t = y / (SIZE - 1);
  const plate = [
    Math.round(INK_TOP[0] + (INK_BOTTOM[0] - INK_TOP[0]) * t),
    Math.round(INK_TOP[1] + (INK_BOTTOM[1] - INK_TOP[1]) * t),
    Math.round(INK_TOP[2] + (INK_BOTTOM[2] - INK_TOP[2]) * t),
  ];

  for (let x = 0; x < SIZE; x++) {
    // The plate: a squircle-ish rounded square inset from the edge, so the icon does
    // not touch the bounds of its own box at any size.
    const plateAlpha = coverage(
      roundedRectDistance(x, y, px(50), px(50), px(46), px(46), px(22)),
    );

    let r = plate[0];
    let g = plate[1];
    let b = plate[2];

    for (const [bx, by, bw, bh, colour] of BARS) {
      const a = coverage(
        roundedRectDistance(x, y, px(bx), px(by), px(bw), px(bh), px(5.2)),
      );
      if (a <= 0) continue;
      r = Math.round(r + (colour[0] - r) * a);
      g = Math.round(g + (colour[1] - g) * a);
      b = Math.round(b + (colour[2] - b) * a);
    }

    const i = (y * SIZE + x) * 4;
    rgba[i] = r;
    rgba[i + 1] = g;
    rgba[i + 2] = b;
    rgba[i + 3] = Math.round(plateAlpha * 255);
  }
}

/* ---------------------------------------------------------------- PNG output */

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// Each scanline is prefixed with its filter type; 0 means "none".
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  const at = y * (SIZE * 4 + 1);
  raw[at] = 0;
  Buffer.from(rgba.buffer, y * SIZE * 4, SIZE * 4).copy(raw, at + 1);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // colour type: RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`wrote ${OUT} — ${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} KB`);
