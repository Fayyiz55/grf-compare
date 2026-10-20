/* Squig Compare — app.
   Loads public squig.link data through the local /api proxy, lets you
   toggle several reviewer databases at once, and overlays curves from
   DIFFERENT reviewers on one SVG graph. */
import { buildGrid, parseTsv, interpToGrid, valueAt, valueOnGrid, avgPower, smoothCurve } from './fr-core.js';

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
const esc = s => String(s);

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
const FEATURED = [
  { name: 'Super* Review', type: 'IEMs' },
  { name: 'Hawaii Bad Boy', type: 'IEMs' },
  { name: 'Precogvision', type: 'IEMs' },
  { name: 'Hangout.Audio', type: 'IEMs' },
];
const TARGET_KEY = 'harman-2019';
const TARGET_LABEL = 'Harman IE 2019';

/* reviewer chip colors stay consistent across the app */
const REV_COLORS = ['#4d4dff', '#ff4438', '#0baa53', '#fb8b1e', '#a855f7', '#06b6d4', '#ec4899', '#84cc16', '#14b8a6', '#f97316'];

/* ---------------- state ---------------- */
const S = {
  sites: [],            // squigsites.json entries
  dbs: [],              // flattened db entries {si, di, name, type, folder, base, delta, hosts, revColor}
  books: new Map(),     // "si:di" -> book array (brands)
  itemIndex: new Map(), // itemId -> item
  enabled: new Set(),   // "si:di"
  active: new Map(),    // itemId -> {item, color, db: DB, num}
  settings: { nf: 1000, sm: 8, zm: 25, tg: false },
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
        // variants: squig's suffix/prefix rules
        let dns;
        if (ph.suffix) dns = f.map(sfx => ph.name + (sfx ? ' ' + sfx : ''));
        else if (ph.prefix) {
          const reg = new RegExp('^' + ph.prefix + '\\s*', 'i');
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
      txtBase: `${db.base}${db.folder === '/' ? '' : db.folder}data/${encodeURIComponent(file)}`,
    };
    S.itemIndex.set(it.id, it);
    return it;
  }
}

async function ensureBook(db) {
  if (S.books.has(db.key)) return S.books.get(db.key);
  const book = await apiJson(`/api/fetch?u=${encodeURIComponent(db.base + (db.folder === '/' ? '' : db.folder) + 'data/phone_book.json')}`);
  S.books.set(db.key, Array.isArray(book) ? book : []);
  return S.books.get(db.key);
}

/* measurement txt fetch + channel pipeline (memoized on item) */
const measCache = new Map();
async function measurementFor(it) {
  if (measCache.has(it.id)) return measCache.get(it.id);
  const load = (async () => {
    const [l, r] = await Promise.all([
      apiText(`/api/fetch?u=${encodeURIComponent(it.txtBase + '%20L.txt')}`).catch(() => null),
      apiText(`/api/fetch?u=${encodeURIComponent(it.txtBase + '%20R.txt')}`).catch(() => null),
    ]);
    let curves = [];
    if (l) curves.push(interpToGrid(parseTsv(l), GRID));
    if (r) curves.push(interpToGrid(parseTsv(r), GRID));
    if (!curves.length) {
      const bare = await apiText(`/api/fetch?u=${encodeURIComponent(it.txtBase + '.txt')}`).catch(() => null);
      if (bare) curves.push(interpToGrid(parseTsv(bare), GRID));
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
  for (const [, it] of S.itemIndex) if (S.enabled.has(it.db.key)) pool.push(it);
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
    body.append(el('div', { class: 'lib-more', text: 'NO MATCHES IN ENABLED DATABASES.' }));
  } else if (!openSome) {
    body.prepend(el('div', { class: 'lib-more', text: 'TAP A BRAND TO OPEN, THEN “+” TO OVERLAY A CURVE.' }));
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
    if (!S.enabled.has(it.db.key)) continue;
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
  const table = $('#legend'), tbody = $('#leg-body');
  $('#leg-count').textContent = String(actives.length);
  $('#empty').hidden = actives.length > 0;
  table.hidden = actives.length === 0;
  $('#leg-empty').hidden = actives.length > 0;
  tbody.textContent = '';

  const rigs = [...new Set(actives.map(a => a.item.db.type === 'IEMs' ? '711' : a.item.db.type))];
  $('#badge-rig').textContent = actives.length ? [...new Set(actives.map(a => a.item.db.name))].slice(0, 3).join(' + ') + (actives.length > 3 ? ` +${actives.length - 3}` : '') : '—';

  for (const a of actives) {
    const tr = el('tr', {
      class: '', dataset: {},
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

/* ---------------- chart ---------------- */
const XTICKS = [20, 30, 50, 70, 100, 200, 300, 500, 700, 1000, 2000, 3000, 5000, 7000, 10000, 20000];
const fmtHz = f => f >= 1000 ? (f / 1000).toString().replace(/\.0$/, '') + 'k' : String(f);

function renderChart() {
  const svg = $('#chart');
  const W = svg.clientWidth || 800;
  const H = svg.clientHeight || 400;
  const PAD = { l: 38, r: 14, t: 10, b: 24 };
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

  /* grid */
  for (const f of XTICKS) {
    const strong = [100, 1000, 10000].includes(f);
    svg.append(mk('line', { x1: x(f), y1: PAD.t, x2: x(f), y2: H - PAD.b, stroke: strong ? 'var(--grid-strong)' : 'var(--grid-line)', 'stroke-width': 1 }));
    svg.append(mkt({ x: x(f), y: H - 8, 'text-anchor': 'middle', 'font-size': 9, fill: 'var(--ink-soft)', 'font-family': "'Space Grotesk',monospace", 'font-weight': 700 }, fmtHz(f)));
  }
  for (let db = -zm; db <= zm; db += 5) {
    if (db === 0) continue;
    svg.append(mk('line', { x1: PAD.l, y1: y(db), x2: W - PAD.r, y2: y(db), stroke: 'var(--grid-line)', 'stroke-width': 1 }));
    svg.append(mkt({ x: PAD.l - 6, y: y(db) + 3, 'text-anchor': 'end', 'font-size': 9, fill: 'var(--ink-soft)', 'font-family': "'Space Grotesk',monospace" }, String(db)));
  }
  /* zero line (normalization frequency level) */
  svg.append(mk('line', { x1: PAD.l, y1: y(0), x2: W - PAD.r, y2: y(0), stroke: 'var(--grid-strong)', 'stroke-width': 2 }));
  svg.append(mkt({ x: PAD.l + 4, y: y(0) - 4, 'font-size': 8.5, fill: 'var(--ink-soft)', 'font-family': "'Space Grotesk',monospace", 'font-weight': 700 }, `NORMALIZED @ ${fmtHz(S.settings.nf)}`));

  /* curves */
  const normals = [];
  for (const a of S.active.values()) {
    if (a.off) continue;
    const v = curveFor(a.item.id);
    if (!v) continue;
    normals.push(v);
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
    svg.append(mk('path', {
      d, fill: 'none', stroke: a.color, 'stroke-width': dim ? 1.6 : 3,
      'stroke-opacity': dim ? 0.35 : 1, 'stroke-linejoin': 'round',
      id: `curve-${a.num}`,
    }));
  }

  /* optional target */
  if (S.settings.tg) drawTarget(svg, mk, x, y);

  wirePointer(svg, x, y, W, PAD);
}

let targetCache = null;
async function drawTarget(svg, mk, x, y) {
  if (!targetCache) {
    try {
      const txt = await apiText(`/api/fetch?u=${encodeURIComponent('https://squig.link/data/' + encodeURIComponent('Harman IE 2019 Target') + '.txt')}`);
      targetCache = interpToGrid(parseTsv(txt), GRID);
    } catch { targetCache = []; }
  }
  if (!targetCache.length) return;
  const norm = valueOnGrid(targetCache, GRID, S.settings.nf);
  let d = '', pen = false;
  for (let i = 0; i < GRID.length; i++) {
    const dbv = targetCache[i] - norm;
    if (!Number.isFinite(dbv)) { pen = false; continue; }
    d += (pen ? 'L' : 'M') + x(GRID[i]).toFixed(1) + ' ' + y(dbv).toFixed(1);
    pen = true;
  }
  svg.append(mk('path', { d, fill: 'none', stroke: 'var(--ink-soft)', 'stroke-width': 2, 'stroke-dasharray': '6 5', opacity: 0.85 }));
}

/* pointer inspector: crosshair + per-curve readouts */
function wirePointer(svg, x, y, W, PAD) {
  const tip = $('#tip');
  const NS = 'http://www.w3.org/2000/svg';
  const move = ev => {
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
    nf: S.settings.nf, sm: S.settings.sm, zm: S.settings.zm, tg: S.settings.tg,
  })))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function applyShare() {
  const s = new URL(location.href).searchParams.get('s');
  if (!s) return false;
  try {
    const st = JSON.parse(decodeURIComponent(escape(atob(s.replace(/-/g, '+').replace(/_/g, '/')))));
    st.e?.forEach(k => S.enabled.add(k));
    Object.assign(S.settings, { nf: st.nf ?? 1000, sm: st.sm ?? 8, zm: st.zm ?? 25, tg: !!st.tg });
    S._shareActive = st.a || null;
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
    if (st) Object.assign(S.settings, st);
  } catch {}
}

/* ---------------- controls ---------------- */
$('#nf').addEventListener('change', e => { S.settings.nf = +e.target.value; renderChart(); persist(); });
$('#sm').addEventListener('input', e => { S.settings.sm = +e.target.value; $('#sm-v').textContent = e.target.value; renderChart(); persist(); });
$('#zm').addEventListener('input', e => { S.settings.zm = +e.target.value; $('#zm-v').textContent = e.target.value; renderChart(); persist(); });
$('#tg').addEventListener('change', e => { S.settings.tg = e.target.checked; renderChart(); persist(); });

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

/* ---------------- boot ---------------- */
function syncControls() {
  const nfSel = $('#nf');
  if ([...nfSel.options].some(o => o.value === String(S.settings.nf))) nfSel.value = String(S.settings.nf);
  $('#sm').value = String(S.settings.sm); $('#sm-v').textContent = String(S.settings.sm);
  $('#zm').value = String(S.settings.zm); $('#zm-v').textContent = String(S.settings.zm);
  $('#tg').checked = !!S.settings.tg;
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
  const feat = S.dbs.filter(db => FEATURED.some(f => f.name === db.name && f.type === db.type));
  for (const db of feat) {
    if (S.enabled.size >= 8) break;
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
  /* NOTE: display names differ per reviewer — crinacle drops brand
     prefixes: hangout name is "Variations", super* review and precog
     publish "Moondrop Variations". Match by display name per db. */
  const wish = [
    { db: 'Super* Review', disp: 'Tanchjim Kasier' },
    { db: 'Hawaii Bad Boy', disp: 'Variations' },
    { db: 'Precogvision', disp: 'Moondrop Variations' },
    { db: 'Hangout.Audio', disp: 'Variations' },
  ];
  for (const w of wish) {
    if (S.active.size >= 4) break;
    const db = S.dbs.find(d => d.name === w.db && S.enabled.has(d.key));
    if (!db) continue;
    const it = [...S.itemIndex.values()].find(i => i.db.key === db.key && i.disp === w.disp)
      || [...S.itemIndex.values()].find(i => i.db.key === db.key && i.disp.includes(w.disp));
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
  syncControls();

  busy(true);
  try {
    await loadSites();
    const shared = applyShare();
    if (!shared) restore();
    syncControls(); // share/localStorage may have overridden settings — keep sliders honest
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
