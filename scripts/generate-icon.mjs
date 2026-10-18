#!/usr/bin/env node
// Generates build-resources/icon.png (1024x1024) without external dependencies.
// The icon is a dark rounded square with a 2x2 grid of "AI panel" tiles.
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const __dirname = dirname(fileURLToPath(import.meta.url));
const outDir = join(__dirname, '..', 'build-resources');
const outFile = join(outDir, 'icon.png');

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (edge0, edge1, x) => {
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
};

/** Signed distance to a rounded rectangle centered at (cx, cy). Negative inside. */
function sdRoundRect(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

/** Coverage in [0,1] from a signed distance, 1px antialias band. */
const coverage = (sd) => clamp01(0.5 - sd);

function mix(a, b, t) {
  return [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t
  ];
}

function over(dst, src, alpha) {
  dst[0] = src[0] * alpha + dst[0] * (1 - alpha);
  dst[1] = src[1] * alpha + dst[1] * (1 - alpha);
  dst[2] = src[2] * alpha + dst[2] * (1 - alpha);
  dst[3] = alpha + dst[3] * (1 - alpha);
}

const bgTop = [23, 33, 47];
const bgBottom = [8, 12, 18];

// Three chat bubbles of different widths, like a stacked conversation list.
const bubbles = [
  { x0: 0.17, x1: 0.63, y0: 0.255, y1: 0.375, from: [16, 185, 129], to: [5, 150, 105] },
  { x0: 0.37, x1: 0.83, y0: 0.44, y1: 0.56, from: [249, 115, 22], to: [217, 119, 87] },
  { x0: 0.17, x1: 0.57, y0: 0.625, y1: 0.745, from: [96, 165, 250], to: [59, 130, 246] }
];

const bgHalf = SIZE / 2;
const bgRadius = SIZE * 0.2237;

const pixels = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5;
    const py = y + 0.5;

    // Rounded background.
    const bgAlpha = coverage(sdRoundRect(px, py, bgHalf, bgHalf, bgHalf, bgHalf, bgRadius));
    if (bgAlpha <= 0) continue;

    const bg = mix(bgTop, bgBottom, y / SIZE);
    // Subtle radial highlight in the upper-left corner.
    const hl = Math.hypot(px - SIZE * 0.3, py - SIZE * 0.22) / (SIZE * 0.75);
    const lit = mix(bg, [70, 90, 125], (1 - clamp01(hl)) * 0.35);
    const color = [lit[0], lit[1], lit[2], bgAlpha];

    for (const bubble of bubbles) {
      const cx = ((bubble.x0 + bubble.x1) / 2) * SIZE;
      const cy = ((bubble.y0 + bubble.y1) / 2) * SIZE;
      const halfW = ((bubble.x1 - bubble.x0) / 2) * SIZE;
      const halfH = ((bubble.y1 - bubble.y0) / 2) * SIZE;
      const sd = sdRoundRect(px, py, cx, cy, halfW, halfH, SIZE * 0.045);
      const a = coverage(sd);
      if (a <= 0) continue;
      const grad = mix(bubble.from, bubble.to, (py - bubble.y0 * SIZE) / ((bubble.y1 - bubble.y0) * SIZE));
      over(color, grad, a);
    }

    // Small accent dot in the lower-right bubble's tail area.
    const dotSd = Math.hypot(px - SIZE * 0.7, py - SIZE * 0.735) - SIZE * 0.058;
    const dotAlpha = coverage(dotSd);
    if (dotAlpha > 0) over(color, [124, 58, 237], dotAlpha);

    const i = (y * SIZE + x) * 4;
    pixels[i] = Math.round(color[0]);
    pixels[i + 1] = Math.round(color[1]);
    pixels[i + 2] = Math.round(color[2]);
    pixels[i + 3] = Math.round(color[3] * 255);
  }
}

// ── Minimal PNG encoder ──────────────────────────────────────────────
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8;  // bit depth
ihdr[9] = 6;  // RGBA
ihdr[10] = 0; // deflate
ihdr[11] = 0; // adaptive filtering
ihdr[12] = 0; // no interlace

// Prefix every scanline with filter type 0.
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
]);

mkdirSync(outDir, { recursive: true });
writeFileSync(outFile, png);
console.log(`wrote ${outFile} (${(png.length / 1024).toFixed(1)} kB)`);
