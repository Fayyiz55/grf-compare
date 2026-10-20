#!/usr/bin/env node
'use strict';
/* Squig Compare server — zero dependencies. Port 3020.
   - static files from public/
   - /api/sites  → squig.link site index (cached)
   - /api/fetch?u=<https url> → cached proxy for squig.link data
     (hosts whitelisted to *.squig.link / squig.link / *.hangout.audio /
      altDomains announced in the sites index), disk-cached, stale-serving */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3020;
const PUB = path.join(__dirname, 'public');
const CACHE = path.join(__dirname, 'cache');
const SITES_URL = 'https://squig.link/squigsites.json';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

fs.mkdirSync(CACHE, { recursive: true });

/* ---------- cache ---------- */
const sha1 = s => crypto.createHash('sha1').update(s).digest('hex');
const cachePath = url => path.join(CACHE, sha1(url) + '.cache');

function cacheRead(url) {
  try { return JSON.parse(fs.readFileSync(cachePath(url), 'utf8')); } catch { return null; }
}
function cacheWrite(url, obj) {
  try { fs.writeFileSync(cachePath(url), JSON.stringify(obj)); } catch {}
}

/* ---------- whitelist ---------- */
let allowedHosts = new Set(['squig.link']);

function hostAllowed(hostname) {
  if (allowedHosts.has(hostname)) return true;
  for (const suffix of ['squig.link', 'hangout.audio']) {
    if (hostname === suffix || hostname.endsWith('.' + suffix)) return true;
  }
  return false;
}

function refreshWhitelist() {
  return proxyFetch(SITES_URL, 60 * 60 * 1000).then(({ body }) => {
    const sites = JSON.parse(body.toString('utf8'));
    const set = new Set(['squig.link']);
    for (const s of sites) {
      if (s.altDomain) { try { set.add(new URL(s.altDomain).hostname); } catch {} }
      if (s.urlType === 'subdomain' && s.username) set.add(s.username + '.squig.link');
      if (s.urlType === 'root') set.add('squig.link');
    }
    allowedHosts = set;
    console.log(`[whitelist] ${set.size} hosts`);
  }).catch(e => console.warn('[whitelist] refresh failed:', e.message));
}
refreshWhitelist();
setInterval(refreshWhitelist, 60 * 60 * 1000).unref();

/* ---------- upstream fetch (redirect-following, timeout) ---------- */
function getOnce(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36' },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

async function upstream(url, { timeout = 15000 } = {}) {
  let target = url;
  for (let hop = 0; hop < 4; hop++) {
    const r = await getOnce(target, timeout);
    if (r.status >= 300 && r.status < 400 && r.headers.location) {
      target = new URL(r.headers.location, target).href;
      continue;
    }
    if (r.status < 200 || r.status >= 400) throw new Error(`upstream ${r.status} for ${target}`);
    return r.body;
  }
  throw new Error('too many redirects');
}

async function proxyFetch(url, ttlMs) {
  const hit = cacheRead(url);
  if (hit && Date.now() - hit.t < ttlMs) return { body: Buffer.from(hit.b64, 'base64'), ct: hit.ct, cached: true };
  try {
    const body = await upstream(url);
    const ct = (ct => ct)(url.endsWith('.txt') ? 'text/plain; charset=utf-8' :
      /\.json($|\?)/.test(url) ? 'application/json; charset=utf-8' :
      (hit && hit.ct) || 'application/octet-stream');
    cacheWrite(url, { t: Date.now(), ct, b64: body.toString('base64') });
    return { body, ct, cached: false };
  } catch (e) {
    if (hit) return { body: Buffer.from(hit.b64, 'base64'), ct: hit.ct, cached: true, stale: true };
    throw e;
  }
}

/* concise request log for /api routes */
function logApi(method, p, status, extra = '') {
  console.log(`[api] ${method} ${p} ${status}${extra}`);
}

/* ---------- http server ---------- */
function send(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(body);
}

const TTL_SITES = 6 * 60 * 60 * 1000;
const TTL_BOOK = 6 * 60 * 60 * 1000;
const TTL_TXT = 7 * 24 * 60 * 60 * 1000;

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = u.pathname;

    if (p === '/api/sites') {
      const { body, ct, cached, stale } = await proxyFetch(SITES_URL, TTL_SITES);
      logApi(req.method, p, 200, cached ? ` (${stale ? 'stale' : 'cache'})` : '');
      return send(res, 200, body, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
    }

    if (p === '/api/fetch') {
      const target = u.searchParams.get('u');
      if (!target) return send(res, 400, 'missing u', { 'Content-Type': 'text/plain' });
      let parsed;
      try { parsed = new URL(target); } catch { return send(res, 400, 'bad u', { 'Content-Type': 'text/plain' }); }
      if (parsed.protocol !== 'https:')
        return send(res, 400, 'https only', { 'Content-Type': 'text/plain' });
      if (!hostAllowed(parsed.hostname))
        return send(res, 403, 'host not allowed', { 'Content-Type': 'text/plain' });
      const ttl = /\.txt($|\?)/.test(parsed.pathname) ? TTL_TXT : TTL_BOOK;
      const { body, ct, cached, stale } = await proxyFetch(target, ttl);
      logApi(req.method, p, 200, ` ${decodeURIComponent(parsed.pathname.split('/').pop() || '')}${cached ? ` (${stale ? 'stale' : 'cache'})` : ''}`);
      return send(res, 200, body, { 'Content-Type': ct, 'Cache-Control': 'no-cache' });
    }

    if (p === '/healthz') return send(res, 200, 'ok', { 'Content-Type': 'text/plain' });

    /* static */
    let rel = decodeURIComponent(p);
    if (rel === '/') rel = '/index.html';
    const abs = path.normalize(path.join(PUB, rel));
    if (!abs.startsWith(PUB)) return send(res, 403, 'forbidden', { 'Content-Type': 'text/plain' });
    let stat;
    try { stat = fs.statSync(abs); } catch { return send(res, 404, 'not found', { 'Content-Type': 'text/plain' }); }
    if (stat.isDirectory()) { return send(res, 404, 'not found', { 'Content-Type': 'text/plain' }); }
    const ext = path.extname(abs).toLowerCase();
    const cc = ext === '.html' ? 'no-cache' : 'public, max-age=3600';
    const body = fs.readFileSync(abs);
    send(res, 200, body, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cc });
  } catch (e) {
    console.error('[err]', e.message);
    send(res, 502, 'upstream error: ' + e.message, { 'Content-Type': 'text/plain' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Squig Compare → http://localhost:${PORT}`);
});
