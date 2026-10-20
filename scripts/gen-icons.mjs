/* Generates brutalist PWA icons as real PNGs using node's zlib — no image deps.
   Draws: ivory canvas, thick ink border, outlined electric-blue FR-style curve, gold end dot. */
import zlib from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, '..', 'public', 'icons');
fs.mkdirSync(OUT, { recursive: true });

/* ---- minimal PNG encoder (RGBA8, filter 0) ---- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 8 + data.length);
  return out;
}
function encodePng(width, height, pixels /* Buffer RGBA rows interleaved */) {
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    pixels.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ---- drawing ---- */
const IVORY = [0xf0, 0xf0, 0xe8];
const INK = [0x00, 0x00, 0x00];
const BLUE = [0x4D, 0x4D, 0xFF];
const GOLD = [0xF5, 0xC5, 0x1D];

// FR-wave silhouette (fractions of inner box, y from top): bass bloom → dip → treble air
const PTS = [[0.06, 0.64], [0.16, 0.30], [0.36, 0.55], [0.55, 0.44], [0.74, 0.50], [0.92, 0.36]];

function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);
  const border = Math.max(2, Math.round(size * 0.033));
  const inner = size - 2 * border;
  const rStroke = size * 0.030;           // blue stroke radius
  const rOutline = rStroke + size * 0.012; // ink outline radius
  const rDot = size * 0.024;
  const maskPad = size * 0.06;            // keep curve inside safe zone (maskable)

  const setPx = (x, y, [r, g, b]) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const o = (y * size + x) * 4;
    px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = 255;
  };
  const disc = (cx, cy, rad, col) => {
    const ri = Math.ceil(rad);
    for (let dy = -ri; dy <= ri; dy++)
      for (let dx = -ri; dx <= ri; dx++)
        if (dx * dx + dy * dy <= rad * rad) setPx(cx + dx, cy + dy, col);
  };

  // ivory canvas
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    px[o] = IVORY[0]; px[o + 1] = IVORY[1]; px[o + 2] = IVORY[2]; px[o + 3] = 255;
  }
  // ink border
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++)
      if (x < border || x >= size - border || y < border || y >= size - border) setPx(x, y, INK);

  // curve points in pixels (inside border + mask pad)
  const x0 = border + maskPad, x1 = size - border - maskPad;
  const y0 = border + maskPad, y1 = size - border - maskPad;
  const pts = PTS.map(([fx, fy]) => [x0 + fx * (x1 - x0), y0 + fy * (y1 - y0)]);

  const strokeAlong = (pts, rad, col) => {
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay)) * 2;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        disc(ax + (bx - ax) * t, ay + (by - ay) * t, rad, col);
      }
    }
  };

  // ink outline pass, then blue stroke
  strokeAlong(pts, rOutline, INK);
  strokeAlong(pts, rStroke, BLUE);
  // gold end dot with ink outline
  const [ex, ey] = pts[pts.length - 1];
  disc(ex, ey, rDot + size * 0.007, INK);
  disc(ex, ey, rDot, GOLD);

  return encodePng(size, size, px);
}

for (const [size, name] of [[512, 'icon-512.png'], [192, 'icon-192.png'], [180, 'apple-180.png'], [64, 'favicon-64.png']]) {
  fs.writeFileSync(path.join(OUT, name), drawIcon(size));
  console.log('wrote', name, size + 'px');
}
