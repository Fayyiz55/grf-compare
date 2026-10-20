/* fr-core.js — shared pure DSP for Squig Compare.
   Works in the browser (ES module) and under node (fr-core.test.mjs).
   Grid mirrors squig.link: 48 points per octave from 20 Hz to 20 kHz,
   curves averaged across channels as power (20*log10(mean(10^(dB/20)))). */

export const F_LO = 20;
export const F_HI = 20000;
export const PPO = 48; // points per octave

export function buildGrid() {
  const n = Math.round(PPO * Math.log2(F_HI / F_LO));
  const g = new Array(n + 1);
  for (let i = 0; i <= n; i++) g[i] = F_LO * Math.pow(2, i / PPO);
  g[n] = F_HI; // float accumulation lands at 19896.97 — snap the endpoint
  return g;
}

/* Parse squig measurement .txt: '*' comment header lines, then TSV rows
   "freq<whitespace or comma>dB". Returns ascending [[freq, dB], ...]. */
export function parseTsv(text) {
  if (!text) return [];
  const out = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('*') || line.startsWith('#')) continue;
    const parts = line.split(/[\t,;\s]+/);
    if (parts.length < 2) continue;
    const f = parseFloat(parts[0]);
    const v = parseFloat(parts[1]);
    if (!Number.isFinite(f) || !Number.isFinite(v) || f <= 0) continue;
    out.push([f, v]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
}

/* Log-space linear interpolation of source curve onto target grid.
   Flat-clamps outside the source range. Returns dB array (may contain
   NaN only if source is empty). */
export function interpToGrid(src, grid) {
  const out = new Array(grid.length);
  if (!src.length) { out.fill(NaN); return out; }
  let j = 0;
  const lo0 = Math.log(src[0][0]), hi0 = Math.log(src[src.length - 1][0]);
  for (let i = 0; i < grid.length; i++) {
    const lf = Math.log(grid[i]);
    if (lf <= lo0) { out[i] = src[0][1]; continue; }
    if (lf >= hi0) { out[i] = src[src.length - 1][1]; continue; }
    while (j < src.length - 2 && Math.log(src[j + 1][0]) < lf) j++;
    while (j > 0 && Math.log(src[j][0]) > lf) j--;
    const f0 = Math.log(src[j][0]), f1 = Math.log(src[j + 1][0]);
    const t = f1 === f0 ? 0 : (lf - f0) / (f1 - f0);
    out[i] = src[j][1] + t * (src[j + 1][1] - src[j][1]);
  }
  return out;
}

/* dB value of a source curve ([[f,v],...]) at frequency f (log interp). */
export function valueAt(src, f) {
  if (!src.length) return NaN;
  if (f <= src[0][0]) return src[0][1];
  if (f >= src[src.length - 1][0]) return src[src.length - 1][1];
  let j = 0;
  while (j < src.length - 2 && src[j + 1][0] < f) j++;
  const f0 = Math.log(src[j][0]), f1 = Math.log(src[j + 1][0]);
  const t = f1 === f0 ? 0 : (Math.log(f) - f0) / (f1 - f0);
  return src[j][1] + t * (src[j + 1][1] - src[j][1]);
}

/* Power-average N channels (already on the same grid) into one dB array.
   Mirrors squig's avgCurves: 20*log10(mean(10^(dB/20))). */
export function avgPower(channels) {
  const chans = channels.filter(c => c && c.length);
  if (!chans.length) return null;
  if (chans.length === 1) return chans[0].slice();
  const len = chans[0].length;
  const out = new Array(len);
  for (let i = 0; i < len; i++) {
    let sum = 0, n = 0;
    for (const c of chans) {
      const v = c[i];
      if (Number.isFinite(v)) { sum += Math.pow(10, v / 20); n++; }
    }
    out[i] = n ? 20 * Math.log10(sum / n) : NaN;
  }
  return out;
}

/* Moving-average smoothing over +-w points (uniform window). */
export function smoothCurve(arr, w) {
  const n = arr.length;
  if (!w || n < 3) return arr.slice();
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - w), b = Math.min(n - 1, i + w);
    let s = 0;
    for (let k = a; k <= b; k++) s += arr[k];
    out[i] = s / (b - a + 1);
  }
  return out;
}
