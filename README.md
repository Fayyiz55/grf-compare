# GRF Compare

One centralized web app to compare IEM, headphone and earbud frequency-response graphs — from ALL squig.link reviewers, on ONE chart.

No single reviewer owns every measurement rig, so each one publishes different gear. GRF Compare pulls every reviewer's published measurements into one searchable library and overlays them together: compare "IEM-X measured only by reviewer A" against "IEM-Y measured only by reviewer B" — one graph, no tab juggling.

## Run

```bash
node server.js
# → http://localhost:3020  (reachable from your phone on the same LAN)
```

Zero dependencies — Node ≥ 18 only. Installable PWA with offline support. `cache/` holds proxied data and is safe to delete.

## Features

- Toggle multiple reviewer databases at once (124 squig sites supported)
- One searchable library across every enabled database
- **Match Matrix**: which reviewers measured each model — `OVERLAY n` draws one curve per reviewer
- Rig filter (711 / 5128) + multi-select reference targets (Harman IE 2019, JM-1 DF, …)
- squig.link-style SVG chart: normalization for fair rig comparison, smoothing, ±dB zoom, crosshair inspector
- Share URLs, dark mode, persistent settings

## Data

Proxied and cached straight from squig.link: site list → catalog → L/R channel files → one normalized grid, fair across rigs.

## Tests

```bash
node test/fr-core.test.mjs && node test/icons.test.mjs && node test/server.smoke.mjs
```
