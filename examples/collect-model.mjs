/* Demo: collect the SAME model's graph data from MULTIPLE reviewers
   using only the app's API on port 3020. */
const BASE = 'http://localhost:3020';

const j = async p => (await fetch(BASE + p)).json();
const t = async p => (await fetch(BASE + p)).text();

/* base ALWAYS ends with '/' — folders never start with one */
function baseOf(s) {
  if (s.urlType === 'subdomain' && s.username) return `https://${s.username}.squig.link/`;
  if (s.urlType === 'altDomain' && s.altDomain) return s.altDomain.replace(/\/+$/, '') + '/';
  if (s.urlType === 'labFolder' && s.username) return `https://squig.link/lab/${s.username}/`;
  return 'https://squig.link/';
}

const MODEL = 'Moondrop Variations';
const sites = await j('/api/sites');
const PICK = ['Super* Review', 'Hawaii Bad Boy', 'Precogvision', 'Hangout.Audio', 'Timmy (Gizaudio)', 'VSG', 'Akros', 'Bass Head Club', 'Dynalo', 'Icon'];
const rows = [];

for (const name of PICK) {
  const site = sites.find(s => s.name === name);
  if (!site) { rows.push({ rev: name, note: 'not in index' }); continue; }
  const base = baseOf(site);
  for (const db of site.dbs || []) {
    if (db.type !== 'IEMs') continue;
    const folder = (db.folder === '/' ? '' : db.folder).replace(/^\//, '');
    const re = new RegExp(MODEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    try {
      const book = JSON.parse(await t(`/api/fetch?u=${encodeURIComponent(base + folder + 'data/phone_book.json')}`));
      let hit = null;
      for (const b of book) {
        if (!b?.phones) continue;
        const p = b.phones.find(x => x && (re.test(x.file || '') || re.test(x.name || '')));
        if (p) { hit = { ...p, _brand: b.name }; break; }
      }
      if (!hit) { rows.push({ rev: name, note: 'model not in catalog' }); continue; }
      const file = Array.isArray(hit.file) ? hit.file[0] : hit.file;
      /* try L then R then bare — some reviewers publish only one channel */
      let txt = null;
      const attempts = [];
      for (const sfx of ['%20L.txt', '%20R.txt', '.txt']) {
        try {
          const inner = base + folder + 'data/' + file + sfx;
          const r = await fetch(`${BASE}/api/fetch?u=${encodeURIComponent(inner)}`);
          const body = r.ok ? await r.text() : '';
          const num = /^\d/m.test(body);
          attempts.push(`${sfx}->${r.status}${num ? '+num' : ''}`);
          if (num) { txt = body; break; }
        } catch (e) { attempts.push(`${sfx}->throw:${e.message.slice(0, 30)}`); }
      }
      if (!txt) { rows.push({ rev: name, file, note: 'no channel data [' + attempts.join(' | ') + ']' }); continue; }
      {
        const pts = txt.split('\n').filter(l => /^\d/.test(l.trim()))
          .map(l => l.trim().split(/[\s,\t]+/).map(Number))
          .filter(([f, v]) => f > 0 && Number.isFinite(v));
        if (!pts.length) { rows.push({ rev: name, file, note: 'no numeric rows' }); continue; }
        const at = hz => { let best = pts[0]; for (const p of pts) if (Math.abs(p[0] - hz) < Math.abs(best[0] - hz)) best = p; return best[1]; };
        rows.push({ rev: name, file, n: pts.length, db20: at(20).toFixed(1), db1k: at(1000).toFixed(1), db10k: at(10000).toFixed(1) });
      }
    } catch (e) {
      rows.push({ rev: name, note: 'book fetch failed: ' + e.message });
    }
  }
}

console.log(`MODEL: "${MODEL}" — data collected from ${rows.filter(r => r.n).length} of ${PICK.length} reviewers\n`);
for (const r of rows) {
  if (r.n) console.log(`${r.rev.padEnd(16)} ${String(r.n).padStart(5)} pts  20Hz ${r.db20} dB | 1kHz ${r.db1k} dB | 10kHz ${r.db10k} dB   (${r.file})`);
  else console.log(`${r.rev.padEnd(16)} — ${r.note}${r.file ? ` (${r.file})` : ''}`);
}
