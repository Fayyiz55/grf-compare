import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
/* respect PORT so the suite can run while a real server occupies 3020 —
   spawning on a busy port dies EADDRINUSE while up() probes the wrong process */
const PORT = Number(process.env.PORT) || 3120;

const proc = spawn('node', [join(ROOT, 'server.js')], { stdio: ['ignore', 'pipe', 'pipe'] });
proc.stderr.on('data', d => process.stderr.write('[srv] ' + d));

const wait = ms => new Promise(r => setTimeout(r, ms));
async function up() { for (let i = 0; i < 50; i++) { try { await fetch(`http://localhost:${PORT}/`); return; } catch { await wait(100); } } throw new Error('server did not start'); }

let pass = 0, fail = 0;
function ok(name, cond, extra = '') { if (cond) { pass++; console.log(`PASS ${name}`); } else { fail++; console.error(`FAIL ${name} ${extra}`); } }

await up();

try {
  // 1. static index
  const r1 = await fetch(`http://localhost:${PORT}/`);
  const h1 = await r1.text();
  ok('GET / serves html', r1.ok && h1.includes('<script'), `status ${r1.status}`);

  // 2. static traversal guard (encoded dots survive undici path-normalization)
  const r2 = await fetch(`http://localhost:${PORT}/%2e%2e%2fserver.js`);
  const r2body = String(await r2.text());
  ok('traversal guarded (encoded-dot → 403, no leak)', r2.status === 403 && !r2body.includes('createServer'), `status ${r2.status}`);

  // 3. sites proxy
  const r3 = await fetch(`http://localhost:${PORT}/api/sites`);
  const sites = await r3.json();
  ok('GET /api/sites returns site list', r3.ok && Array.isArray(sites) && sites.length > 100, `n=${sites?.length}`);
  ok('sites entries shaped (name/username/urlType)', !!sites.find(s => s.username === 'hbb' && s.urlType === 'subdomain'));

  // 4. book proxy (superreview IEMs)
  const r4 = await fetch(`http://localhost:${PORT}/api/fetch?u=` + encodeURIComponent('https://squig.link/data/phone_book.json'));
  const book = await r4.json();
  ok('GET /api/fetch phone_book', r4.ok && Array.isArray(book) && book.some(b => b.name === 'Tanchjim'), `brands=${book?.length}`);

  // 5. txt proxy
  const r5 = await fetch(`http://localhost:${PORT}/api/fetch?u=` + encodeURIComponent('https://squig.link/data/Tanchjim%20Kasier%20L.txt'));
  const txt = await r5.text();
  ok('GET /api/fetch measurement txt', r5.ok && txt.startsWith('*') && /\d/.test(txt), `len=${txt.length}`);

  // 6. whitelist denies non-squig hosts
  const r6 = await fetch(`http://localhost:${PORT}/api/fetch?u=` + encodeURIComponent('https://example.com/x.json'));
  ok('whitelist denies foreign host', r6.status >= 400, `status ${r6.status}`);

  // 7. cache roundtrip: second fetch succeeds and is served (implicit via cache file)
  const r7 = await fetch(`http://localhost:${PORT}/api/fetch?u=` + encodeURIComponent('https://squig.link/data/Tanchjim%20Kasier%20L.txt'));
  ok('cached re-fetch ok', r7.ok && (await r7.text()).startsWith('*'));

  // 8. CORS on our API (handy for the LAN mobile client)
  const r8 = await fetch(`http://localhost:${PORT}/api/sites`, { headers: { Origin: 'http://192.168.1.50:3020' } });
  ok('api sends access-control-allow-origin', r8.headers.get('access-control-allow-origin') === '*');

  // 9. /api/model aggregate — cached-books mode is primed by step 4's fetch
  const r9 = await fetch(`http://localhost:${PORT}/api/model?name=Tanchjim%20Kasier&books=cached&data=0`);
  const m9 = await r9.json();
  ok('api/model discovers a model across cached books',
    r9.ok && Array.isArray(m9.matches) && m9.matches.length >= 1 && m9.matches.every(x => x.reviewer && x.file),
    `returned=${m9?.returned} errs=${JSON.stringify(m9?.errors || []).slice(0, 80)}`);

  // 10. /api/model with curve data — freq/dB pairs per channel
  const r10 = await fetch(`http://localhost:${PORT}/api/model?name=Moondrop%20Variations&books=cached&limit=3`);
  const m10 = await r10.json();
  const withChan = (m10.matches || []).filter(x => x.channels && Object.keys(x.channels).length);
  const chanOk = withChan.length >= 1 && (() => {
    const pts = withChan[0].channels[Object.keys(withChan[0].channels)[0]];
    return Array.isArray(pts) && pts.length > 10 && Array.isArray(pts[0]) && pts[0].length === 2 && Number.isFinite(pts[0][1]);
  })();
  ok('api/model returns freq/dB curve data', r10.ok && chanOk,
    `withChan=${withChan.length} matched=${m10?.matched}`);
} catch (e) {
  fail++; console.error('SUITE ERROR', e);
}

proc.kill();
console.log(`\n${pass}/${pass + fail}`);
process.exit(fail ? 1 : 0);
