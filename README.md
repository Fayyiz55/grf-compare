# GRF Compare

One centralized web app to compare IEM, headphone and earbud frequency-response graphs — from ALL squig.link reviewers, on ONE chart.

No single reviewer owns every measurement rig, so each one publishes different gear. GRF Compare pulls every reviewer's published measurements into one searchable library and overlays them together: compare "IEM-X measured only by reviewer A" against "IEM-Y measured only by reviewer B" — one graph, no tab juggling.

## Run

Only requirement: [Node.js](https://nodejs.org) 18+. No `npm install` — zero dependencies. It really is just:

```bash
# 1. get the code
git clone https://github.com/Fayyiz55/grf-compare.git
cd grf-compare

# 2. start the server
node server.js
```

Then open **http://localhost:3020** in your browser — done.

On the same Wi-Fi, your phone can open it too: `http://<your-pc-ip>:3020` (find the IP with `ipconfig` on Windows or `hostname -I` on Linux). The page is installable as a PWA from your browser menu and works offline. `cache/` holds proxied data and is safe to delete.

## Features

- Toggle multiple reviewer databases at once (124 squig sites supported)
- One searchable library across every enabled database
- **Match Matrix**: which reviewers measured each model — `OVERLAY n` draws one curve per reviewer
- Rig filter (711 / 5128) + multi-select reference targets (Harman IE 2019, JM-1 DF, …)
- squig.link-style SVG chart: normalization for fair rig comparison, smoothing, ±dB zoom, crosshair inspector
- Share URLs, dark mode, persistent settings

## Data

Proxied and cached straight from squig.link: site list → catalog → L/R channel files → one normalized grid, fair across rigs.

### HTTP API

Grab the underlying data yourself — everything the app shows is available as JSON:

```bash
# reviewer/database index — 124 reviewers, their db folders and rigs
curl http://localhost:3020/api/sites

# raw proxy for any squig-ecosystem URL (whitelisted, disk-cached, CORS *)
curl "http://localhost:3020/api/fetch?u=$(python3 -m urllib.parse \
  <<< 'https://hbb.squig.link/data/Moondrop Variations R.txt' \
  | python3 -c 'import sys,urllib.parse;print(urllib.parse.quote(sys.stdin.read().strip(),safe=""))')"

# aggregate: one model, EVERY reviewer — scans all 149 catalogs
curl "http://localhost:3020/api/model?name=Moondrop Variations"
```

`/api/model` returns per match: reviewer, rig, brand/model/display name, the measurement file, and `channels.L`/`channels.R` as `[[freq, dB], …]` pairs. Options: `&data=0` metadata only (instant), `&limit=n` (default 40, max 200), `&types=IEMs,Headphones` filter, `&books=cached` to scan only already-cached catalogs (zero upstream, deterministic). The first full scan warms the disk cache (~30 s); afterwards it's memory-speed.

## Tests

```bash
node test/fr-core.test.mjs && node test/icons.test.mjs && node test/server.smoke.mjs
```
