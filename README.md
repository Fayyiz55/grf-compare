# Squig Compare

Cross-reviewer frequency-response overlay for squig.link data. Compare "IEM-X that only
reviewer 1 measured" with "IEM-Y that only reviewer 2 measured" — on ONE graph, no tab juggling.

## Run

```bash
node server.js
# → http://localhost:3020  (binds 0.0.0.0, reachable from your phone on LAN)
```

Zero dependencies — node ≥ 18 only. `cache/` holds proxied data (safe to delete).

## What it does

- Toggles MULTIPLE reviewer databases simultaneously (featured four preloaded; all 124 squig sites supported)
- One searchable library across every enabled database, with reviewer chips + rig badges (711 / 5128)
- **MATCH MATRIX** view: per model, which reviewers have it — `OVERLAY n` draws one curve per reviewer in one chart
- Hand-rolled SVG graph: normalize @ frequency (fair across rigs), smoothing, ±dB zoom, Harman 2019 target, crosshair inspector
- Share URLs (`COPY URL`), dark mode, everything persists in localStorage
- PWA: installable, offline app shell + cached last data via service worker

## Data pipeline (reverse-engineered from squig.link)

1. `https://squig.link/squigsites.json` — 124 sites / 149 DBs (`urlType`, `folder`, rig type)
2. `<base><folder>data/phone_book.json` — catalog: brand → model → measurement file
3. `<base><folder>data/<file> L.txt` / `R.txt` — comment headers + TSV `freq<ws>dB`
4. Grid: 48 pts/octave 20 Hz–20 kHz, L/R power-averaged (mirrors squig `avgCurves`)

## Tests

```bash
node test/fr-core.test.mjs   # DSP: grid, TSV parse, log-interp, channel RMS average, smoothing
node test/icons.test.mjs     # PWA icon PNG integrity
node test/server.smoke.mjs   # spawns server, exercises static + proxy + whitelist + CORS
```
