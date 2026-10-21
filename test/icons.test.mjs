import { readFileSync } from 'node:fs';
import zlib from 'node:zlib';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('PASS ' + n); } else { fail++; console.error('FAIL ' + n + ' ' + e); } };

const SIG = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
/* og-image probe sits top-right, clear of the curves, chips and tagline */
for (const [name, w, h, px = null, py = null] of [
  ['icon-512.png', 512, 512], ['icon-192.png', 192, 192],
  ['apple-180.png', 180, 180], ['favicon-64.png', 64, 64],
  ['og-image.png', 1200, 630, 1160, 40],
]) {
  const buf = readFileSync(new URL(`../public/icons/${name}`, import.meta.url));
  ok(`${name} signature`, SIG.every((b, i) => buf[i] === b));
  ok(`${name} IHDR ${w}x${h}`, buf.readUInt32BE(16) === w && buf.readUInt32BE(20) === h, `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`);
  ok(`${name} colorType RGBA8`, buf[24] === 8 && buf[25] === 6, `${buf[24]}/${buf[25]}`);
  // inflate IDAT and confirm size
  let off = 8, idat = [], rawLen = h * (1 + w * 4);
  while (off < buf.length) {
    const len = buf.readUInt32BE(off), type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  ok(`${name} IDAT inflates to ${rawLen}`, raw.length === rawLen, `${raw.length}`);
  // background pixel near (w/2, h*0.18) must be ivory (below it lies the curve)
  const bOff = 1 + Math.floor(py ?? h * 0.14) * (1 + w * 4) + Math.floor(px ?? w / 2) * 4;
  ok(`${name} ivory bg`, raw[bOff] === 0xf0 && raw[bOff + 1] === 0xf0 && raw[bOff + 2] === 0xe8, `@${bOff}: ${raw[bOff]},${raw[bOff + 1]},${raw[bOff + 2]}`);
}

console.log(`\n${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
