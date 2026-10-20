/* GRF Compare — app.
   Loads public squig.link data through the local /api proxy, lets you
   toggle several reviewer databases at once, and overlays curves from
   DIFFERENT reviewers on one SVG graph. */
import { buildGrid, parseTsv, interpToGrid, valueOnGrid, avgPower, smoothCurve } from './fr-core.js';

/* ---------------- helpers ---------------- */
const $ = s => document.querySelector(s);
const el = (tag, attrs = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v);
  }
  for (const kid of kids) n.append(kid);
  return n;
};
/* escapes third-party reviewer data before it reaches any innerHTML sink */
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let toastTimer = null;
function toast(msg, err = false) {
  const t = $('#toast');
  t.hidden = false;
  t.textContent = msg;
  t.classList.toggle('err', err);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function busy(on) { $('#loadbar').hidden = !on; }

/* ---------------- constants ---------------- */
const CURVE_COLORS = [
  '#4d4dff', '#ff4438', '#0baa53', '#fb8b1e', '#a855f7',
  '#06b6d4', '#ec4899', '#84cc16', '#f5c51d', '#14b8a6',
  '#f97316', '#22d3ee', '#ef4444', '#8b5cf6',
];
const MAX_ACTIVE = 14;
/* per-category starter databases — the IEM four are the classic demo set */
const FEATURED = {
  IEM: [
    { name: 'Super* Review', type: 'IEMs' },
    { name: 'Hawaii Bad Boy', type: 'IEMs' },
    { name: 'Precogvision', type: 'IEMs' },
    { name: 'Hangout.Audio', type: 'IEMs' },
  ],
  HEADPHONE: [
    { name: 'Super* Review', type: 'Headphones' },
    { name: 'boizoff', type: 'Headphones' },
    { name: 'Earphones Archive (headphones)', type: '5128' },
  ],
  EARBUD: [
    { name: 'Super* Review', type: 'Earbuds' },
    { name: 'Hadoe', type: 'Earbuds' },
    { name: 'SilicaGel', type: 'Earbuds' },
  ],
};

/* reviewer chip colors stay consistent across the app */
const REV_COLORS = ['#4d4dff', '#ff4438', '#0baa53', '#fb8b1e', '#a855f7', '#06b6d4', '#ec4899', '#84cc16', '#14b8a6', '#f97316'];

/* ---------------- targets ----------------
   Reference targets are MULTI-SELECT chips (squig.link's "REFERENCE TARGETS"
   row): any combination can be on at once. A family may ship one file PER
   RIG: a 711 target drawn against raw 5128 measurements is meaningless
   (different ear simulator geometry), so when a family has both variants the
   chart splits — 711 curves get the 711 file, 5128 curves get the 5128 file,
   each labeled with its rig. 5128 variants come from Fox Told Me So's
   5128-rig squig instance; headphone variants from squig.link/data.
   `cats` limits which category's chip row offers the family. */
const TARGETS = [
  {
    id: 'harman-ie-2019', label: 'HARMAN IE 2019', cats: ['IEM', 'EARBUD'],
    rigs: {
      '711': ['Harman IE 2019 Target', 'https://squig.link/data/'],
      '5128': ['Harman IE 2019 for 5128 Target', 'https://foxtoldmeso.squig.link/data/'],
    },
  },
  {
    id: 'super22', label: 'SUPER 22', cats: ['IEM', 'EARBUD'],
    rigs: { '711': ['Super 22 Target', 'https://squig.link/data/'] },
  },
  {
    id: 'df-5128', label: '5128 DIFFUSE FIELD', cats: ['IEM', 'EARBUD'],
    rigs: { '5128': ['5128 DF Target', 'https://foxtoldmeso.squig.link/data/'] },
  },
  {
    id: 'jm1-df', label: 'JM-1 DF', cats: ['IEM', 'EARBUD'],
    rigs: { '5128': ['JM-1 DF Target', 'https://foxtoldmeso.squig.link/data/'] },
  },
  {
    id: 'harman-hp', label: 'HARMAN TARGET', cats: ['HEADPHONE'],
    rigs: { 'hp': ['Harman Target', 'https://squig.link/data/'] },
  },
  {
    id: 'df-hp', label: 'DIFFUSE FIELD', cats: ['HEADPHONE'],
    rigs: { 'hp': ['Diffuse Field Target', 'https://squig.link/data/'] },
  },
];
/* rig class of a db type: IEMs/Earbuds ride 711-style couplers, '5128' dbs
   ride the GRAS 5128, dedicated Headphones dbs get no IEM target */
const rigClass = t => t === '5128' ? '5128' : t === 'Headphones' ? 'hp' : '711';
/* does an active curve pass the current rig filter? ('all' shows everything,
   including headphone rigs; a specific rig hides the rest) */
const rigMatch = a => S.settings.rig === 'all' || rigClass(a.item.db.type) === S.settings.rig;

/* browse category — squig.link's IEM / HEADPHONES / EARBUDS split.
   '5128' dbs are in-ear rigs unless the folder path says headphones. */
const CATS = ['IEM', 'HEADPHONE', 'EARBUD'];
const dbCategory = db =>
  db.type === 'Earbuds' ? 'EARBUD' :
  db.type === 'Headphones' ? 'HEADPHONE' :
  db.type === '5128' ? (/headphone/i.test(db.folder || '') ? 'HEADPHONE' : 'IEM') :
  'IEM';

/* ---------------- state ---------------- */
const S = {
  sites: [],            // squigsites.json entries
  dbs: [],              // flattened db entries {si, di, name, type, folder, base, delta, hosts, revColor}
  books: new Map(),     // "si:di" -> book array (brands)
  itemIndex: new Map(), // itemId -> item
  enabled: new Set(),   // "si:di"
  active: new Map(),    // itemId -> {item, color, db: DB, num}
  settings: { nf: 1000, sm: 8, zm: 25, tgts: [], rig: 'all', cat: 'IEM' },
  tgtOff: new Set(),    // target family ids hidden via the legend eye
  focusNum: null,       // legend-hover focus
};

const GRID = buildGrid();

/* ---------------- data layer ---------------- */
async function apiJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`api ${r.status}`);
  return r.json();
}
async function apiText(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`api ${r.status}`);
  return r.text();
}

function baseUrlFor(site) {
  if (site.urlType === 'subdomain' && site.username) return `https://${site.username}.squig.link`;
  if (site.urlType === 'altDomain' && site.altDomain) return site.altDomain.replace(/\/$/, '');
  if (site.urlType === 'labFolder' && site.username) return `https://squig.link/lab/${site.username}`;
  return 'https://squig.link';
}

function loadSites() {
  return apiJson('/api/sites').then(rows => {
    S.sites = rows;
    S.dbs = [];
    let si = 0;
    for (const site of rows) {
      const base = baseUrlFor(site);
      let di = 0;
      for (const db of site.dbs || []) {
        S.dbs.push({
          key: `${si}:${di}`,
          name: site.name,
          type: db.type,
          folder: (db.folder === '/' ? '' : (db.folder || '')).replace(/^\//, ''), // no leading slash — base carries the trailing one
          base: baseUrlFor(site).replace(/\/*$/, '/'), // ALWAYS trailing slash — folder '/' contributes ''
          delta: !!db.deltaReady,
          revColor: REV_COLORS[si % REV_COLORS.length],
        });
        di++;
      }
      si++;
    }
  });
}

/* expand phone_book into flat item list for one db */
function itemsForDb(db, book) {
  const out = [];
  for (const brand of book) {
    if (!brand || !brand.name || !Array.isArray(brand.phones)) continue;
    for (const ph of brand.phones) {
      if (!ph || !ph.name) continue;
      const f = ph.file || ph.name;
      if (Array.isArray(f)) {
        // variants: squig's suffix/prefix rules — suffix[i] pairs with file[i]
        let dns;
        if (ph.suffix) {
          const sx = ph.suffix;
          dns = f.map((_, i) => {
            const s = Array.isArray(sx) ? (sx[i] || '') : String(sx);
            return ph.name + (s ? ' ' + s : '');
          });
        } else if (ph.prefix) {
          const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const reg = new RegExp('^' + escRe(String(ph.prefix)) + String.fromCharCode(92) + 's*', 'i');
          dns = f.map(n => ph.name + (n.replace(reg, '').length ? ' ' + n.replace(reg, '') : ''));
        } else dns = f;
        f.forEach((fn, i) => out.push(mkItem(db, brand.name, dns[i] || ph.name, fn)));
      } else {
        out.push(mkItem(db, brand.name, ph.name, f));
      }
    }
  }
  return out;

  function mkItem(db, brand, disp, file) {
    const it = {
      id: `${db.key}|${file}`,
      db,
      brand,
      disp,
      fullName: `${brand} ${disp}`,
      file,
      txtBase: `${db.base}${db.folder}data/${encodeURIComponent(file)}`,
    };
    S.itemIndex.set(it.id, it);
    return it;
  }
}

async function ensureBook(db) {
  if (S.books.has(db.key)) return S.books.get(db.key);
  const book = await apiJson(`/api/fetch?u=${encodeURIComponent(db.base + db.folder + 'data/phone_book.json')}`);
  S.books.set(db.key, Array.isArray(book) ? book : []);
  return S.books.get(db.key);
}

/* measurement txt fetch + channel pipeline (memoized on item) */
const measCache = new Map();
async function measurementFor(it) {
  if (measCache.has(it.id)) return measCache.get(it.id);
  const load = (async () => {
    const txt = suffix => apiText(`/api/fetch?u=${encodeURIComponent(it.txtBase + suffix)}`).catch(() => null);
    const [l, r] = await Promise.all([txt('%20L.txt'), txt('%20R.txt')]);
    let curves = [];
    if (l) curves.push(interpToGrid(parseTsv(l), GRID));
    if (r) curves.push(interpToGrid(parseTsv(r), GRID));
    if (!curves.length) {
      const bare = await txt('.txt');
      if (bare) curves.push(interpToGrid(parseTsv(bare), GRID));
    }
    if (!curves.length) {
      /* squig's headphone stores differ: multi-sample {file} R1..R5/L1..L5 (squig.link main,
         therollo9, aden) vs plain L/R (boizoff, Earphones Archive) — average whatever exists */
      const found = (await Promise.all(
        ['R1', 'L1', 'R2', 'L2', 'R3', 'L3', 'R4', 'L4', 'R5', 'L5'].map(s => txt(`%20${s}.txt`))
      )).filter(Boolean);
      for (const t of found) curves.push(interpToGrid(parseTsv(t), GRID));
    }
    if (!curves.length) throw new Error('no data');
    return avgPower(curves);
  })();
  measCache.set(it.id, load);
  try { return await load; } catch (e) { measCache.delete(it.id); throw e; }
}

/* ---------------- curve rendering pipeline ---------------- */
function curveFor(itemId) {
  const a = S.active.get(itemId);
  if (!a || !a.grid) return null;
  const { nf, sm } = S.settings;
  const norm = valueOnGrid(a.grid, GRID, nf);
  let v = a.grid.map(x => x - norm);
  if (sm > 0) v = smoothCurve(v, Math.round(sm / 2));
  a.normLevel = norm;
  return v;
}

/* ---------------- reviewer panel ---------------- */
const RIG_CHIP = t => t === '5128' ? 'chip-gold' : t === 'Headphones' ? 'chip-green' : t === 'Earbuds' ? 'chip-warn' : 'chip-blue';

function renderReviewers() {
  const body = $('#rev-body');
  body.textContent = '';
  const byName = new Map();
  for (const db of S.dbs) {
    /* category filter — but always list enabled dbs so they can be switched off */
    if (dbCategory(db) !== S.settings.cat && !S.enabled.has(db.key)) continue;
    if (!byName.has(db.name)) byName.set(db.name, []);
    byName.get(db.name).push(db);
  }
  for (const [name, dbs] of byName) {
    const wrapEl = el('div', { class: 'rev-db' });
    for (const db of dbs) {
      const on = S.enabled.has(db.key);
      const cnt = S.books.has(db.key) ? countItems(db) : null;
      const row = el('button', {
        class: 'rev-row', role: 'checkbox', 'aria-checked': String(on), 'data-state': on ? 'on' : 'off',
        onclick: () => toggleDb(db),
      }, [
        el('span', { class: 'rev-check' }),
        el('span', { class: 'sw', style: `background:${db.revColor}` }),
        el('span', { class: 'rev-name', text: name }),
        el('span', { class: `chip ${RIG_CHIP(db.type)} shadow-sw-1`, text: db.type === '5128' ? '5128' : db.type.toUpperCase() }),
        db.delta ? el('span', { class: 'chip chip-ink shadow-sw-1', text: 'Δ' }) : null,
        cnt != null ? el('span', { class: 'count', text: String(cnt) }) : null,
      ].filter(Boolean));
      wrapEl.append(row);
    }
    body.append(wrapEl);
  }
  renderBrandIndex();
}

function countItems(db) {
  let n = 0;
  for (const [, it] of S.itemIndex) if (it.db.key === db.key) n++;
  return n;
}

async function toggleDb(db) {
  const wasOn = S.enabled.has(db.key);
  if (wasOn) {
    S.enabled.delete(db.key);
    // deactivate its curves
    for (const [id, a] of [...S.active]) if (a.item.db.key === db.key) S.active.delete(id);
    renderReviewers(); renderLibrary($('#q').value); renderLegend(); renderChart();
    persist();
    return;
  }
  if (S.enabled.size >= 8) { toast('MAX 8 DATABASES — CLEAR ONE FIRST', true); return; }
  busy(true);
  try {
    const book = await ensureBook(db);
    itemsForDb(db, book); // fills S.itemIndex
    S.enabled.add(db.key);
    renderReviewers(); renderLibrary($('#q').value); renderLegend(); renderChart();
    persist();
  } catch (e) {
    toast(`FAILED TO LOAD ${db.name.toUpperCase()} — RETRY`, true);
    renderReviewers();
  } finally { busy(false); }
}

/* ---------------- library panel ---------------- */
function filteredItems(q) {
  const terms = (q || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  const pool = [];
  for (const [, it] of S.itemIndex) {
    if (!S.enabled.has(it.db.key) || dbCategory(it.db) !== S.settings.cat) continue;
    pool.push(it);
  }
  if (!terms.length) return pool.sort((a, b) => a.fullName.localeCompare(b.fullName)).slice(0, 250);
  return pool
    .filter(it => terms.every(t => (it.fullName + ' ' + it.db.name).toLowerCase().includes(t)))
    .sort((a, b) => a.fullName.localeCompare(b.fullName))
    .slice(0, 250);
}

function renderLibrary(q) {
  const body = $('#lib-body');
  body.textContent = '';

  if (!$('#btn-matrix').getAttribute('aria-pressed') || $('#btn-matrix').getAttribute('aria-pressed') === 'false') {
    renderFlatList(q, body);
  } else {
    renderMatrix(q, body);
  }
}

function renderFlatList(q, body) {
  const items = filteredItems(q);
  $('#lib-count').textContent = items.length >= 250 ? '250+ MATCHES' : `${items.length} SHOWN`;

  // group by brand; render collapsibles, but render rows only for open groups
  const groups = new Map();
  for (const it of items) {
    if (!groups.has(it.brand)) groups.set(it.brand, []);
    groups.get(it.brand).push(it);
  }
  let openSome = false;
  for (const [brand, its] of groups) {
    const isOpen = q && q.trim().length > 1 && its.length <= 40;
    if (isOpen) openSome = true;
    const det = el('details', { class: 'lib-group', ...(isOpen ? { open: '' } : {}) }, [
      el('summary', {}, [
        el('span', { text: brand.toUpperCase() }),
        el('span', { class: 'count', text: String(its.length) }),
      ]),
    ]);
    if (isOpen) det.append(renderRows(its));
    else {
      det.addEventListener('toggle', () => {
        if (det.open && !det.dataset.done) { det.append(renderRows(its)); det.dataset.done = '1'; }
      });
    }
    body.append(det);
  }
  if (!items.length) {
    const anyInCat = S.dbs.some(db => S.enabled.has(db.key) && dbCategory(db) === S.settings.cat);
    body.append(el('div', { class: 'lib-more', text: anyInCat
      ? 'NO MATCHES IN ENABLED DATABASES.'
      : `NO ${S.settings.cat} DATABASE ENABLED — OPEN THE REVIEWERS TAB.` }));
  } else if (!openSome) {
    body.prepend(el('div', { class: 'lib-more', text: 'TAP A BRAND TO OPEN, THEN “+” TO OVERLAY A CURVE.' }));
  }
}

/* Brands tab: flat index of every brand in the current category pool */
function renderBrandIndex() {
  const host = $('#brand-index');
  host.textContent = '';
  const counts = new Map();
  for (const [, it] of S.itemIndex) {
    if (!S.enabled.has(it.db.key) || dbCategory(it.db) !== S.settings.cat) continue;
    counts.set(it.brand, (counts.get(it.brand) || 0) + 1);
  }
  for (const [brand, n] of [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    host.append(el('button', { class: 'bix-row', onclick: () => jumpToBrand(brand) }, [
      el('span', { class: 'bix-name', text: brand.toUpperCase() }),
      el('span', { class: 'count', text: String(n) }),
    ]));
  }
  if (!counts.size) host.append(el('div', { class: 'lib-more', text: 'NOTHING HERE YET — ENABLE A DATABASE.' }));
}

function jumpToBrand(brand) {
  setTab('models');
  const want = brand.toLowerCase();
  const det = [...$('#lib-body').querySelectorAll('details.lib-group')]
    .find(d => (d.querySelector('summary span')?.textContent || '').toLowerCase() === want);
  if (det) {
    det.open = true; // fires the lazy row render
    det.scrollIntoView({ block: 'start' });
  } else { // brand beyond the 250-item preview cap — search it instead
    $('#q').value = brand;
    renderLibrary(brand);
  }
}

function renderRows(its) {
  const frag = document.createDocumentFragment();
  for (const it of its) {
    const act = S.active.has(it.id);
    const busyRow = act && act.busy;
    const row = el('div', { class: 'lib-item' }, [
      el('button', {
        class: 'lib-add' + (busyRow ? ' busy' : ''),
        title: `Overlay ${it.fullName} (${it.db.name})`,
        'aria-label': `Overlay ${it.fullName} from ${it.db.name}`,
        text: act ? '✓' : '+',
        onclick: e => activateItem(it, e.currentTarget),
      }),
      el('span', { class: 'lib-name', text: it.disp }),
      el('span', { class: 'sw', style: `background:${it.db.revColor}`, title: it.db.name }),
      el('span', { class: `chip ${RIG_CHIP(it.db.type)}`, text: it.db.type === '5128' ? '5128' : it.db.type === 'IEMs' ? '711' : it.db.type.slice(0, 3).toUpperCase() }),
    ]);
    frag.append(row);
  }
  return frag;
}

/* matrix view: group by normalized model name, show which reviewers have it */
const normKey = s => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function renderMatrix(q, body) {
  const terms = (q || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
  const groups = new Map();
  for (const [, it] of S.itemIndex) {
    if (!S.enabled.has(it.db.key) || dbCategory(it.db) !== S.settings.cat) continue;
    const key = normKey(it.fullName);
    if (terms.length && !terms.every(t => (key + ' ' + it.db.name.toLowerCase()).includes(t))) continue;
    if (!groups.has(key)) groups.set(key, new Map());
    const byRev = groups.get(key);
    if (!byRev.has(it.db.name)) byRev.set(it.db.name, it);
  }
  const rows = [...groups.entries()]
    .filter(([, m]) => m.size >= 1)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
    .slice(0, 120);

  $('#lib-count').textContent = `${rows.length} MODELS`;
  if (!rows.length) { body.append(el('div', { class: 'lib-more', text: 'NO MATCHES.' })); return; }

  for (const [key, byRev] of rows) {
    const rep = [...byRev.values()][0];
    const chipEls = [...byRev.values()].map(it =>
      el('span', { class: 'sw', style: `background:${it.db.revColor}; width:12px; height:12px`, title: `${it.db.name} · ${it.disp}` }));
    body.append(el('div', { class: 'mx-group' }, [
      el('div', { class: 'mx-head' }, [
        el('span', { class: 'mx-name', text: rep.fullName.toUpperCase() }),
        el('button', {
          class: 'btn btn-mini shadow-sw-1',
          title: 'Overlay one curve per reviewer — mixed-reviewer comparison',
          text: `OVERLAY ${byRev.size}`,
          onclick: () => overlayAll([...byRev.values()]),
        }),
      ]),
      el('div', { class: 'mx-revs' }, [
        ...[...byRev.entries()].map(([rev, it]) =>
          el('span', { class: 'chip shadow-sw-1', text: `${rev} · ${it.db.type === '5128' ? '5128' : it.db.type === 'IEMs' ? '711' : it.db.type.slice(0, 3).toUpperCase()}` })),
      ]),
      el('div', { class: 'mx-revs' }, chipEls),
    ]));
  }
}

async function overlayAll(items) {
  busy(true);
  let added = 0, failed = 0;
  for (const it of items) {
    if (added >= MAX_ACTIVE) { failed += items.length - added - failed; break; }
    try {
      const grid = await measurementFor(it);
      if (S.active.has(it.id)) { added++; continue; }
      const color = nextColor();
      S.active.set(it.id, { item: it, color, grid, num: S.active.size + 1 });
      added++;
    } catch { failed++; }
  }
  busy(false);
  renderLibrary($('#q').value); renderLegend(); renderChart();
  if (failed) toast(`${added} OVERLAID · ${failed} FAILED`, failed && !added);
  else toast(`${added} CURVES FROM ${new Set(items.map(i => i.db.name)).size} REVIEWERS`);
}

function nextColor() {
  const used = new Set([...S.active.values()].map(a => a.color));
  return CURVE_COLORS.find(c => !used.has(c)) || CURVE_COLORS[S.active.size % CURVE_COLORS.length];
}

async function activateItem(it, btn) {
  if (S.active.has(it.id)) { // toggle off
    S.active.delete(it.id);
    renormalizeNums();
    renderLibrary($('#q').value); renderLegend(); renderChart();
    persist();
    return;
  }
  if (S.active.size >= MAX_ACTIVE) { toast(`MAX ${MAX_ACTIVE} CURVES`, true); return; }
  if (btn) btn.classList.add('busy');
  try {
    const grid = await measurementFor(it);
    S.active.set(it.id, { item: it, color: nextColor(), grid, num: S.active.size + 1 });
    if (btn) btn.textContent = '✓';
  } catch (e) {
    toast(`NO MEASUREMENT FOR ${it.disp.toUpperCase()} @ ${it.db.name.toUpperCase()}`, true);
  } finally {
    if (btn) btn.classList.remove('busy');
    renderLibrary($('#q').value); renderLegend(); renderChart();
    persist();
  }
}

function renormalizeNums() {
  let i = 1;
  for (const [, a] of S.active) a.num = i++;
}

/* ---------------- legend ---------------- */
function renderLegend() {
  const actives = [...S.active.values()];
  const selT = TARGETS.filter(f => S.settings.tgts.includes(f.id));
  const visible = actives.filter(a => !a.off && rigMatch(a));
  const table = $('#legend'), tbody = $('#leg-body');
  $('#leg-count').textContent = String(actives.length);
  /* a selected target counts as chart content — no "pick a curve" veil over it */
  $('#empty').hidden = visible.length > 0 || selT.length > 0;
  table.hidden = actives.length === 0 && !selT.length;
  $('#leg-empty').hidden = actives.length > 0 || selT.length > 0;
  tbody.textContent = '';
  syncRigSeg();

  /* target rows first — squig.link lists reference targets above measurements */
  for (const fam of selT) {
    const off = S.tgtOff.has(fam.id);
    tbody.append(el('tr', { class: off ? 'dim' : '' }, [
      el('td', {}, [el('span', { class: 'sw sw-dash', title: 'Reference target' })]),
      el('td', { class: 'lg-num' }),
      el('td', { text: 'TARGET' }),
      el('td', { text: fam.label }),
      el('td', {}, Object.keys(fam.rigs).map(r => el('span', {
        class: `chip shadow-sw-1 ${r === '5128' ? 'chip-gold' : r === 'hp' ? 'chip-green' : 'chip-blue'}`,
        text: r === 'hp' ? 'HP' : r.toUpperCase(),
      }))),
      el('td', {}, [
        el('button', {
          class: 'lg-eye' + (off ? ' off' : ''), title: 'Show / hide target',
          text: off ? '○' : '●',
          onclick: () => {
            if (S.tgtOff.has(fam.id)) S.tgtOff.delete(fam.id); else S.tgtOff.add(fam.id);
            renderLegend(); renderChart();
          },
        }),
        el('button', {
          class: 'lg-x', title: 'Remove target',
          text: '✕',
          onclick: () => toggleTarget(fam.id),
          style: 'margin-left:6px',
        }),
      ]),
    ]));
  }

  for (const a of actives) {
    const tr = el('tr', {
      class: rigMatch(a) ? '' : 'dim', // hidden by the rig filter, still listed
      onmouseenter: () => setFocus(a.num, true),
      onmouseleave: () => setFocus(a.num, false),
    }, [
      el('td', {}, [el('span', { class: 'sw', style: `background:${a.color}` })]),
      el('td', { class: 'lg-num', text: String(a.num) }),
      el('td', { text: a.item.db.name }),
      el('td', { text: a.item.disp }),
      el('td', {}, [el('span', { class: `chip ${RIG_CHIP(a.item.db.type)}`, text: a.item.db.type === 'IEMs' ? '711' : a.item.db.type })]),
      el('td', {}, [
        el('button', {
          class: 'lg-eye' + (a.off ? ' off' : ''), title: 'Show / hide',
          text: a.off ? '○' : '●',
          onclick: () => { a.off = !a.off; renderLegend(); renderChart(); },
        }),
        el('button', {
          class: 'lg-x', title: 'Remove',
          text: '✕',
          onclick: () => { S.active.delete(a.item.id); renormalizeNums(); renderLibrary($('#q').value); renderLegend(); renderChart(); persist(); },
          style: 'margin-left:6px',
        }),
      ]),
    ]);
    tbody.append(tr);
  }
}

function setFocus(num, on) {
  S.focusNum = on ? num : null;
  renderChart();
  const rows = $('#leg-body').querySelectorAll('tr');
  rows.forEach((r, i) => r.classList.toggle('hl', on && [...S.active.values()][i]?.num === num));
}

/* rig filter segmented control (ALL / 711 / 5128). Button labels carry live
   counts so the split is visible at a glance — e.g. "711 ×2 · 5128 ×1". */
function syncRigSeg() {
  const counts = new Map();
  let on = 0;
  for (const a of S.active.values()) {
    if (a.off) continue;
    on++;
    const r = rigClass(a.item.db.type);
    counts.set(r, (counts.get(r) || 0) + 1);
  }
  for (const b of document.querySelectorAll('#rig-seg button')) {
    const r = b.dataset.rig;
    b.classList.toggle('on', S.settings.rig === r);
    const n = r === 'all' ? on : (counts.get(r) || 0);
    b.textContent = r === 'all'
      ? `ALL${n ? ` · ${n}` : ''}`
      : `${r.toUpperCase()}${n ? ` ×${n}` : ''}`;
  }
}

/* ---------------- chart ---------------- */
/* squig.link-style axis: fine vertical lines at every tick (20/30/40/50…),
   stronger lines at band boundaries and decades; labels adapt to width */
const XTICKS = [20, 30, 40, 50, 60, 80, 100, 150, 200, 300, 400, 500, 600, 800, 1000, 1500, 2000, 3000, 4000, 5000, 6000, 8000, 10000, 15000, 20000];
const XTICKS_SM = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
/* frequency-band strip under the plot — squig.link's Sub bass…Air row */
const BANDS = [
  [20, 80, 'SUB BASS', 'SUB'], [80, 300, 'MID BASS', 'MID'],
  [300, 600, 'LOWER MID', 'LOW'], [600, 1500, 'UPPER MID', 'UP MID'],
  [1500, 3000, 'PRESENCE', 'PRES'], [3000, 6000, 'MID TREBLE', 'TREB'],
  [6000, 20000, 'AIR', 'AIR'],
];
const fmtHz = f => f >= 1000 ? (f / 1000).toString().replace(/\.0$/, '') + 'k' : String(f);

function renderChart() {
  const gen = ++chartGen; // async target draws from older renders abort on this
  const svg = $('#chart');
  const W = svg.clientWidth || 800;
  const H = svg.clientHeight || 400;
  const PAD = { l: 40, r: 14, t: 16, b: 26 };
  const zm = S.settings.zm;

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.textContent = '';

  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };
  const mkt = (attrs, str) => { const n = mk('text', attrs); n.textContent = str; return n; };

  const x = f => PAD.l + (Math.log10(f) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20)) * (W - PAD.l - PAD.r);
  const y = db => PAD.t + (zm - db) / (2 * zm) * (H - PAD.t - PAD.b);
  const plotW = W - PAD.l - PAD.r, plotH = H - PAD.t - PAD.b;

  /* framed plot + faint monogram watermark, like squig.link's canvas */
  svg.append(mk('rect', { x: PAD.l, y: PAD.t, width: plotW, height: plotH, fill: 'var(--plot-bg)' }));
  svg.append(mkt({
    x: PAD.l + plotW / 2, y: PAD.t + plotH / 2 + Math.min(60, plotH / 6),
    'text-anchor': 'middle', 'font-size': Math.max(24, Math.min(110, plotH / 2.6, plotW / 7)),
    fill: 'var(--ink)', opacity: 0.05,
    'font-family': "'Space Grotesk',monospace", 'font-weight': 700, 'letter-spacing': '0.08em',
  }, 'GRF Compare'));

  /* x grid: a line at every squig tick; band edges + decades read stronger */
  const bandEdge = new Set([20, 80, 300, 600, 1500, 3000, 6000, 20000]);
  const decade = new Set([100, 1000, 10000]);
  for (const f of XTICKS) {
    const strong = bandEdge.has(f) || decade.has(f);
    svg.append(mk('line', { x1: x(f), y1: PAD.t, x2: x(f), y2: H - PAD.b, stroke: strong ? 'var(--grid-strong)' : 'var(--grid-line)', 'stroke-width': 1 }));
  }
  const labelTicks = plotW >= 620 ? XTICKS : XTICKS_SM;
  for (const f of labelTicks) {
    const lab = f === 20 ? '20Hz' : f === 20000 ? '20kHz' : fmtHz(f);
    svg.append(mkt({ x: x(f), y: H - 8, 'text-anchor': 'middle', 'font-size': 9, fill: 'var(--ink-soft)', 'font-family': "'Space Grotesk',monospace", 'font-weight': 700 }, lab));
  }

  /* y grid: a line every 5 dB, a label every 10 (squig.link's rhythm) */
  for (let db = Math.ceil(-zm / 5) * 5; db <= zm; db += 5) {
    if (db === 0) continue;
    svg.append(mk('line', { x1: PAD.l, y1: y(db), x2: W - PAD.r, y2: y(db), stroke: 'var(--grid-line)', 'stroke-width': 1 }));
  }
  for (let db = Math.ceil(-zm / 10) * 10; db <= zm; db += 10) {
    svg.append(mkt({ x: PAD.l - 6, y: y(db) + 3, 'text-anchor': 'end', 'font-size': 9, fill: 'var(--ink-soft)', 'font-family': "'Space Grotesk',monospace" }, String(db)));
  }
  /* zero line (normalization frequency level) */
  svg.append(mk('line', { x1: PAD.l, y1: y(0), x2: W - PAD.r, y2: y(0), stroke: 'var(--grid-strong)', 'stroke-width': 2 }));
  svg.append(mkt({ x: PAD.l + 4, y: y(0) - 4, 'font-size': 8.5, fill: 'var(--ink-soft)', 'font-family': "'Space Grotesk',monospace", 'font-weight': 700 }, `NORMALIZED @ ${fmtHz(S.settings.nf)}`));

  /* "measured on" tag, top-right like squig.link */
  const rigsInPlay = new Set();
  for (const a of S.active.values()) if (!a.off && rigMatch(a)) rigsInPlay.add(rigClass(a.item.db.type));
  const rigName = r => r === '711' ? 'CLONE IEC 711' : r === '5128' ? 'GRAS 5128' : 'HEADPHONE RIGS';
  const rigTag =
    S.settings.rig !== 'all' ? rigName(S.settings.rig) :
    rigsInPlay.size > 1 ? 'CLONE IEC 711 + GRAS 5128' :
    rigsInPlay.size ? rigName([...rigsInPlay][0]) :
    rigName(S.settings.cat === 'HEADPHONE' ? 'hp' : '711');
  svg.append(mkt({ x: W - PAD.r - 4, y: PAD.t + 10, 'text-anchor': 'end', 'font-size': 8.5, fill: 'var(--ink-soft)', 'font-family': "'Space Grotesk',monospace", 'font-weight': 700 }, `MEASURED ON: ${rigTag}`));

  /* targets render UNDER the curves — dedicated group placed first; the
     async fetches fill it in later without reordering */
  const gT = mk('g');
  const gC = mk('g');
  svg.append(gT);
  svg.append(gC);

  /* curves (respect the rig filter) */
  for (const a of S.active.values()) {
    if (a.off || !rigMatch(a)) continue;
    const v = curveFor(a.item.id);
    if (!v) continue;
    let d = '';
    let pen = false;
    for (let i = 0; i < GRID.length; i++) {
      const dbv = v[i];
      if (!Number.isFinite(dbv)) { pen = false; continue; }
      const px = x(GRID[i]), py = Math.max(PAD.t - 4, Math.min(H - PAD.b + 4, y(dbv)));
      d += (pen ? 'L' : 'M') + px.toFixed(1) + ' ' + py.toFixed(1);
      pen = true;
    }
    const dim = S.focusNum != null && a.num !== S.focusNum;
    gC.append(mk('path', {
      d, fill: 'none', stroke: a.color, 'stroke-width': dim ? 1.6 : 2.6,
      'stroke-opacity': dim ? 0.35 : 1, 'stroke-linejoin': 'round', 'stroke-linecap': 'round',
      id: `curve-${a.num}`,
    }));
  }

  /* selected reference targets — drawn even with zero curves on the chart */
  if (S.settings.tgts.length) drawTargets(gT, mk, mkt, x, y, W, H, PAD, gen);

  /* frequency-band strip under the plot (squig.link's Sub bass…Air row) */
  const bands = $('#bands');
  bands.textContent = '';
  const span = Math.log10(20000) - Math.log10(20);
  for (const [a, b, full, short] of BANDS) {
    bands.append(el('span', {
      class: 'band',
      style: `width:${((Math.log10(b) - Math.log10(a)) / span * 100).toFixed(2)}%`,
      title: full,
      text: plotW >= 620 ? full : short,
    }));
  }

  wirePointer(svg, x, y, W, PAD);
}

/* monotonically bumped per render; async target fetches must not paint into
   a chart that has already been re-rendered */
let chartGen = 0;

/* multi-select reference targets — squig.link-style chips; any combination
   can be on at once, offered per category */
function renderTargetChips() {
  const host = $('#tg-chips');
  host.textContent = '';
  for (const fam of TARGETS) {
    if (!fam.cats.includes(S.settings.cat)) continue;
    host.append(el('button', {
      class: 'tg-chip shadow-sw-1', type: 'button',
      'aria-pressed': String(S.settings.tgts.includes(fam.id)),
      text: fam.label,
      onclick: () => toggleTarget(fam.id),
    }));
  }
}

function toggleTarget(id) {
  const i = S.settings.tgts.indexOf(id);
  if (i >= 0) S.settings.tgts.splice(i, 1);
  else { S.settings.tgts.push(id); S.tgtOff.delete(id); } // re-select → visible again
  renderTargetChips(); renderLegend(); renderChart(); persist();
}

const targetCache = new Map(); // url -> Promise<grid dB[]>
function targetGrid(url) {
  if (targetCache.has(url)) return targetCache.get(url);
  const load = apiText(`/api/fetch?u=${encodeURIComponent(url)}`)
    .then(t => interpToGrid(parseTsv(t), GRID))
    .catch(() => []);
  targetCache.set(url, load);
  return load;
}

async function drawTargets(gT, mk, mkt, x, y, W, H, PAD, gen) {
  /* which rig variants does this chart call for?
     - an explicit rig filter wins,
     - else the rigs of the visible curves,
     - else the category's default rig — a selected target must appear even
       on an empty chart (it never did before: that was the reported bug) */
  const present = new Set();
  for (const a of S.active.values()) if (!a.off && rigMatch(a)) present.add(rigClass(a.item.db.type));
  const want = S.settings.rig !== 'all' ? new Set([S.settings.rig])
    : present.size ? present
    : new Set([S.settings.cat === 'HEADPHONE' ? 'hp' : '711']);

  let lastLabelY = null;
  for (const fam of TARGETS) {
    if (!S.settings.tgts.includes(fam.id) || S.tgtOff.has(fam.id)) continue;
    /* variants matching the chart first; a family with NO matching variant
       still draws what it has (labeled with its rig) so a reference never
       silently disappears — e.g. JM-1 DF (5128-only) over a 711 curve */
    let rigs = Object.keys(fam.rigs).filter(r => want.has(r));
    if (!rigs.length) rigs = Object.keys(fam.rigs);
    for (const rig of rigs) {
      const spec = fam.rigs[rig];
      const vals = await targetGrid(spec[1] + spec[0] + '.txt');
      if (gen !== chartGen) return; // superseded by a newer render
      if (!vals.length) continue;
      const norm = valueOnGrid(vals, GRID, S.settings.nf);
      let d = '', pen = false;
      for (let i = 0; i < GRID.length; i++) {
        const dbv = vals[i] - norm;
        if (!Number.isFinite(dbv)) { pen = false; continue; }
        d += (pen ? 'L' : 'M') + x(GRID[i]).toFixed(1) + ' ' + y(dbv).toFixed(1);
        pen = true;
      }
      gT.append(mk('path', { d, fill: 'none', stroke: 'var(--ink-soft)', 'stroke-width': 2, 'stroke-dasharray': '6 5', opacity: 0.85 }));
      /* in-graph label just above the line in the calm low band, squig.link
         style; collision-nudged downward like the old right-edge tags */
      let ly = y(valueOnGrid(vals, GRID, 30) - norm) - 6;
      ly = Math.max(PAD.t + 9, Math.min(H - PAD.b - 5, ly));
      if (lastLabelY != null && Math.abs(ly - lastLabelY) < 12) ly = Math.min(H - PAD.b - 5, lastLabelY + 12);
      lastLabelY = ly;
      gT.append(mkt({
        x: x(30) + 4, y: ly, 'text-anchor': 'start', 'font-size': 8.5,
        fill: 'var(--ink-soft)', 'font-family': "'Space Grotesk',monospace", 'font-weight': 700,
      }, `${fam.label} · ${rig === 'hp' ? 'HP' : rig.toUpperCase()}`));
    }
  }
}

/* pointer inspector: crosshair + per-curve readouts.
   Listeners attach ONCE to the persistent #chart svg; render-time geometry
   (scale fns, width, pads) rides in GEO so handlers never go stale and
   re-renders don't pile up duplicate listeners. */
const GEO = { svg: null, x: null, y: null, W: 0, PAD: null };
function wirePointer(svg, x, y, W, PAD) {
  Object.assign(GEO, { svg, x, y, W, PAD });
  if (svg.dataset.wired) return;
  svg.dataset.wired = '1';
  const tip = $('#tip');
  const NS = 'http://www.w3.org/2000/svg';
  const move = ev => {
    const { svg, x, y, W, PAD } = GEO;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const clientX = (ev.touches ? ev.touches[0].clientX : ev.clientX);
    const cx = clientX - r.left;
    if (cx < PAD.l || cx > W - PAD.r) { tip.hidden = true; svg.querySelectorAll('.insp').forEach(n => n.remove()); return; }
    const logF = Math.log10(20) + (cx - PAD.l) / (W - PAD.l - PAD.r) * (Math.log10(20000) - Math.log10(20));
    const f = Math.pow(10, logF);

    svg.querySelectorAll('.insp').forEach(n => n.remove());
    const mk2 = (tag, attrs) => {
      const n = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
      n.setAttribute('class', 'insp');
      return n;
    };
    svg.append(mk2('line', { x1: cx, y1: PAD.t, x2: cx, y2: svg.clientHeight - PAD.b, stroke: 'var(--ink)', 'stroke-width': 1, 'stroke-dasharray': '3 4', opacity: 0.7 }));

    const rows = [];
    for (const a of S.active.values()) {
      if (a.off) continue;
      const v = curveFor(a.item.id);
      if (!v) continue;
      const i = Math.min(GRID.length - 1, Math.max(0, Math.round((Math.log2(f / 20)) * 48)));
      const dbv = v[i];
      if (!Number.isFinite(dbv)) continue;
      const py = y(dbv);
      svg.append(mk2('circle', { cx, cy: py, r: 3.5, fill: a.color, stroke: 'var(--ink)', 'stroke-width': 1.2 }));
      rows.push(`<div class="tip-r"><span class="sw" style="background:${a.color}"></span>${esc(a.item.db.name)} · ${esc(a.item.disp)} <b>${dbv.toFixed(1)} dB</b></div>`);
    }
    if (!rows.length) { tip.hidden = true; return; }
    tip.innerHTML = `<div class="tip-f">${fmtHz(Math.round(f))} HZ</div>` + rows.join('');
    tip.hidden = false;
    const tw = tip.offsetWidth, flip = cx + 14 + tw > W - PAD.r;
    tip.style.left = (flip ? cx - tw - 14 : cx + 14) + 'px';
    tip.style.top = Math.max(4, Math.min(svg.clientHeight - tip.offsetHeight - 4, (ev.touches ? ev.touches[0].clientY : ev.clientY) - r.top + 12)) + 'px';
  };
  const leave = () => { tip.hidden = true; svg.querySelectorAll('.insp').forEach(n => n.remove()); };
  svg.addEventListener('mousemove', move);
  svg.addEventListener('touchmove', move, { passive: true });
  svg.addEventListener('touchstart', move, { passive: true });
  svg.addEventListener('mouseleave', leave);
  svg.addEventListener('touchend', () => { /* keep last readout */ });
}

/* ---------------- URL share ---------------- */
function encodeState() {
  return btoa(unescape(encodeURIComponent(JSON.stringify({
    e: [...S.enabled],
    a: [...S.active.keys()],
    nf: S.settings.nf, sm: S.settings.sm, zm: S.settings.zm,
    gt: S.settings.tgts, rg: S.settings.rig, cat: S.settings.cat,
  })))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
/* settings arriving via share URL or localStorage are untrusted — coerce+clamp
   so a crafted link can't flatten curves (negative smoothing) or hide them
   (zero/negative y-range). Keeps sliders honest about what's adopted. */
function adoptSettings(o) {
  if (!o || typeof o !== 'object') return;
  const nf = Number(o.nf);
  if (nf === 200 || nf === 500 || nf === 1000) S.settings.nf = nf;
  const sm = Math.round(Number(o.sm));
  if (Number.isFinite(sm)) S.settings.sm = Math.min(24, Math.max(0, sm));
  const zm = Math.round(Number(o.zm));
  if (Number.isFinite(zm)) S.settings.zm = Math.min(40, Math.max(10, zm));
  /* targets: share links carry gt; localStorage carries the live tgts array;
     older shares carry a single tgt id, pre-dropdown ones only the tg
     boolean — every shape migrates into the validated id list */
  const gtIn = Array.isArray(o.gt) ? o.gt : Array.isArray(o.tgts) ? o.tgts : null;
  if (gtIn) S.settings.tgts = [...new Set(gtIn.filter(id => TARGETS.some(t => t.id === id)))];
  else if (typeof o.tgt === 'string' && TARGETS.some(t => t.id === o.tgt)) S.settings.tgts = [o.tgt];
  else if ('tgt' in o || 'tgts' in o) S.settings.tgts = [];
  else if ('tg' in o) S.settings.tgts = o.tg ? ['harman-ie-2019'] : [];
  /* rig filter: share links carry rg, localStorage carries rig: all|711|5128 */
  const rgIn = 'rg' in o ? o.rg : 'rig' in o ? o.rig : undefined;
  if (rgIn === 'all' || rgIn === '711' || rgIn === '5128') S.settings.rig = rgIn;
  else if ('rg' in o || 'rig' in o) S.settings.rig = 'all';
  if (typeof o.cat === 'string' && CATS.includes(o.cat)) S.settings.cat = o.cat;
  else if ('cat' in o) S.settings.cat = 'IEM';
}
function applyShare() {
  const s = new URL(location.href).searchParams.get('s');
  if (!s) return false;
  try {
    const st = JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))));
    if (Array.isArray(st.e)) st.e.forEach(k => S.enabled.add(k));
    adoptSettings(st);
    S._shareActive = Array.isArray(st.a) ? st.a : null;
    return true;
  } catch { return false; }
}
function shareUrl() {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set('s', encodeState());
  return u.href;
}

/* ---------------- persistence ---------------- */
function persist() {
  try {
    localStorage.setItem('sq-en', JSON.stringify([...S.enabled]));
    localStorage.setItem('sq-settings', JSON.stringify(S.settings));
  } catch {}
}
function restore() {
  try {
    const en = JSON.parse(localStorage.getItem('sq-en') || 'null');
    if (Array.isArray(en) && en.length) en.forEach(k => S.enabled.add(k));
    const st = JSON.parse(localStorage.getItem('sq-settings') || 'null');
    if (st) adoptSettings(st);
  } catch {}
}

/* ---------------- controls ---------------- */
$('#nf').addEventListener('change', e => { S.settings.nf = +e.target.value; renderChart(); persist(); });
$('#sm').addEventListener('input', e => { S.settings.sm = +e.target.value; $('#sm-v').textContent = e.target.value; renderChart(); persist(); });
$('#zm').addEventListener('input', e => { S.settings.zm = +e.target.value; $('#zm-v').textContent = e.target.value; renderChart(); persist(); });
/* rig filter buttons (target chips carry their own onclick) */
for (const b of document.querySelectorAll('#rig-seg button')) {
  b.addEventListener('click', () => {
    S.settings.rig = b.dataset.rig;
    syncRigSeg(); renderLegend(); renderChart(); persist();
  });
}

$('#q').addEventListener('input', e => { renderLibrary(e.target.value); });
$('#btn-matrix').addEventListener('click', e => {
  const b = e.currentTarget;
  const on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', String(on));
  renderLibrary($('#q').value);
});
$('#btn-feat').addEventListener('click', () => enableFeatured(true));
$('#btn-none').addEventListener('click', () => enableFeatured(false));
$('#btn-clear').addEventListener('click', () => {
  S.active.clear(); measCache.clear();
  renderLibrary($('#q').value); renderLegend(); renderChart(); persist();
});
$('#btn-dark').addEventListener('click', () => {
  const dark = document.documentElement.classList.toggle('dark');
  try { localStorage.setItem('sq-theme', dark ? 'dark' : 'light'); } catch {}
  $('#btn-dark').textContent = dark ? 'LIGHT' : 'DARK';
});
$('#btn-copy').addEventListener('click', async () => {
  const url = shareUrl();
  try { await navigator.clipboard.writeText(url); toast('SHARE URL COPIED — ' + S.active.size + ' CURVES'); }
  catch { location.href = url; toast('URL UPDATED — COPY FROM ADDRESS BAR'); }
});

/* ---------------- mobile: bottom drawer + category menu ----------------
   squig.link PWA pattern: the graph stays on top, browsing lives in a
   drag-able bottom sheet with Brands / Models / Reviewers tabs. */
const drawer = document.querySelector('.col-side');
const menuEl = $('#menu');

function setDrawer(open) {
  drawer.classList.toggle('open', open);
  drawer.style.height = ''; // drop any inline drag height — CSS takes over
}
const drawerOpen = () => drawer.classList.contains('open');
const drawerMax = () => Math.min(window.innerHeight * 0.78, 720);

function setTab(tab) {
  for (const b of document.querySelectorAll('#drawer-tabs button'))
    b.classList.toggle('on', b.dataset.tab === tab);
  $('#panel-rev').classList.toggle('tab-hide', tab !== 'reviewers');
  $('#panel-lib').classList.toggle('tab-hide', tab !== 'models');
  $('#brand-index').classList.toggle('tab-hide', tab !== 'brands');
}

for (const b of document.querySelectorAll('#drawer-tabs button')) {
  b.addEventListener('click', () => { setTab(b.dataset.tab); setDrawer(true); });
}

/* grip: tap toggles, drag snaps (down = close, up = open) */
const grip = $('#drawer-grip');
let gd = null;
let lastGrip = 0; // timestamp of the last handled pointer flow
grip.addEventListener('pointerdown', e => {
  gd = { y: e.clientY, h: drawer.getBoundingClientRect().height, moved: false };
  grip.setPointerCapture(e.pointerId);
  drawer.style.transition = 'none';
  e.preventDefault();
});
grip.addEventListener('pointermove', e => {
  if (!gd) return;
  const dy = e.clientY - gd.y;
  if (Math.abs(dy) > 6) gd.moved = true;
  drawer.style.height = Math.max(64, Math.min(drawerMax(), gd.h - dy)) + 'px';
});
const gripRelease = () => {
  if (!gd) return;
  lastGrip = Date.now(); // mark the pointer flow so the follow-up click is ignored
  const h = parseFloat(drawer.style.height);
  drawer.style.transition = '';
  drawer.style.height = '';
  setDrawer(!gd.moved ? !drawerOpen() : h > drawerMax() * 0.42);
  gd = null;
};
grip.addEventListener('pointerup', gripRelease);
grip.addEventListener('pointercancel', gripRelease);
/* click fallback (fires when no pointer flow handled the tap) */
grip.addEventListener('click', () => {
  if (Date.now() - lastGrip < 500) return;
  setDrawer(!drawerOpen());
});

/* hamburger — category picker only; insights/merch don't apply here */
$('#btn-menu').addEventListener('click', () => { menuEl.hidden = !menuEl.hidden; syncCat(); });
menuEl.addEventListener('click', e => { if (e.target === menuEl) menuEl.hidden = true; });
for (const b of document.querySelectorAll('#menu .menu-item')) {
  b.addEventListener('click', () => {
    setCat(b.dataset.cat);
    menuEl.hidden = true;
    setTab('models');
    setDrawer(true);
  });
}
for (const b of document.querySelectorAll('#cat-seg button'))
  b.addEventListener('click', () => setCat(b.dataset.cat));

let catJob = 0;
async function setCat(cat) {
  if (!CATS.includes(cat)) return;
  const job = ++catJob;
  S.settings.cat = cat;
  syncCat();
  renderReviewers(); // also rebuilds the brand index
  renderLibrary($('#q').value);
  persist();
  /* empty category → pull in its starter databases so the library has data */
  if (S.dbs.some(db => S.enabled.has(db.key) && dbCategory(db) === cat)) return;
  busy(true);
  for (const f of FEATURED[cat] || []) {
    const db = S.dbs.find(d => d.name === f.name && d.type === f.type);
    if (db && !S.enabled.has(db.key)) await toggleDbQuiet(db);
    if (job !== catJob) { busy(false); return; } // user switched again mid-load
  }
  /* every curated name missing (renamed site)? fall back to the category's first db */
  if (job === catJob && !S.dbs.some(db => S.enabled.has(db.key) && dbCategory(db) === cat)) {
    const first = S.dbs.find(db => dbCategory(db) === cat);
    if (first) await toggleDbQuiet(first);
  }
  if (job !== catJob) { busy(false); return; }
  renderReviewers(); renderLibrary($('#q').value); persist();
  busy(false);
}
function syncCat() {
  for (const b of document.querySelectorAll('#cat-seg button'))
    b.classList.toggle('on', b.dataset.cat === S.settings.cat);
  for (const b of document.querySelectorAll('#menu .menu-item'))
    b.classList.toggle('on', b.dataset.cat === S.settings.cat);
  const n = (FEATURED[S.settings.cat] || []).length;
  const bf = $('#btn-feat');
  if (bf) bf.textContent = S.settings.cat === 'IEM' ? 'FEATURED FOUR' : `FEATURED ×${n}`;
  renderTargetChips(); // the reference-target chip row follows the category
}

/* ---------------- boot ---------------- */
function syncControls() {
  const nfSel = $('#nf');
  if ([...nfSel.options].some(o => o.value === String(S.settings.nf))) nfSel.value = String(S.settings.nf);
  $('#sm').value = String(S.settings.sm); $('#sm-v').textContent = String(S.settings.sm);
  $('#zm').value = String(S.settings.zm); $('#zm-v').textContent = String(S.settings.zm);
  syncRigSeg();
  $('#btn-dark').textContent = document.documentElement.classList.contains('dark') ? 'LIGHT' : 'DARK';
}

async function enableFeatured(add) {
  busy(true);
  if (!add) {
    for (const k of [...S.enabled]) {
      S.enabled.delete(k);
      for (const [id, a] of [...S.active]) if (a.item.db.key === k) S.active.delete(id);
    }
    renderReviewers(); renderLibrary($('#q').value); renderLegend(); renderChart(); persist();
    busy(false); return;
  }
  const picks = FEATURED[S.settings.cat] || FEATURED.IEM;
  const feat = S.dbs.filter(db => picks.some(f => f.name === db.name && f.type === db.type));
  for (const db of feat) {
    if (!S.enabled.has(db.key)) await toggleDbQuiet(db);
  }
  renderReviewers(); renderLibrary($('#q').value); persist();
  await defaultDemo();
  busy(false);
}

async function toggleDbQuiet(db) {
  try {
    const book = await ensureBook(db);
    itemsForDb(db, book);
    S.enabled.add(db.key);
  } catch { /* per-db failure tolerated */ }
}

async function defaultDemo() {
  if (S.active.size) return;
  /* Demonstrate the cross-reviewer overlay with one physical earphone
     seen through different reviewers' books. Match by FILE NAME first
     (stable identifier), then display name — display conventions differ
     per reviewer and shifted when suffix pairing was fixed. */
  const wish = [
    { db: 'Super* Review', file: 'Tanchjim Kasier', disp: 'Kasier' },
    { db: 'Hawaii Bad Boy', file: 'Moondrop Variations', disp: 'Variations' },
    { db: 'Precogvision', file: 'Moondrop Variations', disp: 'Variations' },
    { db: 'Hangout.Audio', file: 'Variations', disp: 'Variations' },
  ];
  for (const w of wish) {
    if (S.active.size >= 4) break;
    /* a reviewer may run several dbs (IEMs + Headphones + Earbuds) and more
       than one can be enabled — pick the one that actually has the item,
       not just the first name match (Headphones books have no IEM files) */
    const cands = S.dbs.filter(d => d.name === w.db && S.enabled.has(d.key));
    let it = null;
    for (const db of cands) {
      const idx = [...S.itemIndex.values()].filter(i => i.db.key === db.key);
      it = idx.find(i => i.file === w.file)
        || idx.find(i => i.file.startsWith(w.file))
        || idx.find(i => i.disp === w.disp)
        || idx.find(i => i.disp.includes(w.disp));
      if (it) break;
    }
    if (!it) continue;
    try {
      const grid = await measurementFor(it);
      S.active.set(it.id, { item: it, color: nextColor(), grid, num: S.active.size + 1 });
    } catch {}
  }
  renderLibrary($('#q').value); renderLegend(); renderChart();
}

async function boot() {
  /* reflect restored settings into controls */
  renderTargetChips();
  syncControls();
  syncCat();
  setTab('models');

  busy(true);
  try {
    await loadSites();
    const shared = applyShare();
    if (!shared) restore();
    syncControls(); // share/localStorage may have overridden settings — keep sliders honest
    syncCat();
    // enabled dbs from share/localStorage: ensure their books
    const want = S.dbs.filter(db => S.enabled.has(db.key));
    for (const db of want) { await toggleDbQuiet(db); }
    if (!want.length) {
      await enableFeatured(true);
    } else {
      renderReviewers(); renderLibrary(''); 
      if (S._shareActive?.length) {
        for (const id of S._shareActive.slice(0, MAX_ACTIVE)) {
          const it = S.itemIndex.get(id);
          if (!it) continue;
          try { const grid = await measurementFor(it); S.active.set(it.id, { item: it, color: nextColor(), grid, num: 0 }); renormalizeNums(); } catch {}
        }
      } else if (!S.active.size) await defaultDemo();
      renderReviewers(); renderLegend(); renderChart();
    }
  } catch (e) {
    toast('BOOT FAILED — CHECK CONNECTION & RELOAD', true);
  } finally { busy(false); }

  /* resize → redraw */
  let rt = null;
  new ResizeObserver(() => { clearTimeout(rt); rt = setTimeout(renderChart, 80); }).observe($('#wrap'));

  /* service worker (localhost / https only) */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname))) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
