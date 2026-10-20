import { buildGrid, parseTsv, interpToGrid, valueAt, valueOnGrid, avgPower, smoothCurve } from '../public/fr-core.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`PASS ${name}`); }
  catch (e) { fail++; console.error(`FAIL ${name}: ${e.message}`); }
}
function eq(a, b, eps = 1e-9) { if (Number.isNaN(a) && Number.isNaN(b)) return; if (!(Math.abs(a - b) <= eps)) throw new Error(`${a} != ${b}`); }

const fixture = readFileSync(join(__dirname, 'fixtures-kasier-l.txt'), 'utf8');

t('buildGrid: length 48/oct over 20..20k', () => {
  const g = buildGrid();
  const n = Math.round(48 * Math.log2(20000 / 20));
  if (g.length !== n + 1) throw new Error(`len ${g.length} vs ${n + 1}`);
  eq(g[0], 20, 1e-6); eq(g[g.length - 1], 20000, 1e-6);
});

t('buildGrid: ascending, positive', () => {
  const g = buildGrid();
  for (let i = 1; i < g.length; i++) if (!(g[i] > g[i - 1])) throw new Error(`not ascending at ${i}`);
});

t('parseTsv: strips * comments, parses freq\\tdB pairs', () => {
  const c = parseTsv(fixture);
  if (c.length < 400) throw new Error(`too few points: ${c.length}`);
  for (const [f, v] of c) {
    if (!(f > 0) || !Number.isFinite(v)) throw new Error('bad point');
  }
  for (let i = 1; i < c.length; i++) if (!(c[i][0] > c[i - 1][0])) throw new Error('freq not ascending');
});

t('parseTsv: tolerates comma-separated rows', () => {
  const c = parseTsv('* hdr\n20.1,\t-12.5\n21.0,\t-12.4\n'.replace(',', ''), ); // mixed: row1 tab, row2 comma+tab
  const c2 = parseTsv('* hdr\n20.1,-12.5\n21.0,-12.4\n');
  if (c.length !== 2) throw new Error(`mixed len ${c.length}`);
  eq(c[0][1], -12.5);
  eq(c[1][1], -12.4);
  if (c2.length !== 2) throw new Error(`len ${c2.length}`);
  eq(c2[0][1], -12.5);
});

t('parseTsv: drops empty and invalid lines', () => {
  const c = parseTsv('\n* c\n\nabc\n20\t1\n\nzzz\t2\n21\t2\n');
  if (c.length !== 2) throw new Error(`len ${c.length}`);
});

t('interpToGrid: exact grid ends', () => {
  const g = buildGrid();
  const src = [[20, 60], [20000, 80]];
  const out = interpToGrid(src, g);
  eq(out[0], 60); eq(out[out.length - 1], 80);
});

t('interpToGrid: log-space midpoint', () => {
  const g = buildGrid();
  const src = [[100, 60], [10000, 80]];
  const out = interpToGrid(src, g);
  // 1000 Hz: log midway between 100 and 10000 → expect 70
  const idx = g.findIndex(f => f >= 999);
  const v = out[idx];
  if (!(Math.abs(v - 70) < 0.05)) throw new Error(`@~1kHz got ${v}`);
});

t('valueAt: exact source point', () => {
  const src = [[100, 60.5], [200, 61.5], [1000, 63]];
  eq(valueAt(src, 200), 61.5, 1e-6);
});

t('avgPower: geometric RMS of two channels', () => {
  // 60 and 80 dB → mean power → 20*log10((10^3+10^4)/2)
  const expected = 20 * Math.log10((10 ** 3 + 10 ** 4) / 2);
  const out = avgPower([[60], [80]]);
  eq(out[0], expected, 1e-6);
  // identical channels average to themselves
  eq(avgPower([[63, 70], [63, 70]])[1], 70, 1e-6);
});

t('smoothCurve: preserves DC level, reduces wiggle', () => {
  const arr = new Array(100).fill(60); arr[50] = 90;
  const out = smoothCurve(arr, 4);
  eq(out[0], 60, 1e-6);
  const peak = Math.max(...out);
  if (!(peak < 90 && peak > 62)) throw new Error(`peak ${peak}`);
});

t('valueOnGrid: exact grid point', () => {
  const grid = buildGrid();
  const vals = grid.map((f, i) => 50 + i * 0.01); // slope fixture
  const i = Math.floor(grid.length / 2);
  eq(valueOnGrid(vals, grid, grid[i]), vals[i], 1e-9);
});

t('valueOnGrid: log-linear interpolation between points', () => {
  const grid = buildGrid();
  const i = Math.floor(grid.length / 2);
  const vals = grid.map((f, j) => j); // v == index
  const midF = Math.sqrt(grid[i] * grid[i + 1]); // geometric midpoint
  const got = valueOnGrid(vals, grid, midF);
  const want = i + 0.5;
  if (Math.abs(got - want) > 1e-6) throw new Error(`mid ${got} vs ${want}`);
});

t('valueOnGrid: clamps outside range, handles empty', () => {
  const grid = buildGrid();
  const vals = grid.map(() => 42);
  eq(valueOnGrid(vals, grid, 5), 42, 1e-9);   // below 20 Hz
  eq(valueOnGrid(vals, grid, 99999), 42, 1e-9); // above 20 kHz
  eq(valueOnGrid([], grid, 100), NaN, 1e-9);
});

console.log(`\n${pass}/${pass + fail}`);
if (fail) process.exit(1);
