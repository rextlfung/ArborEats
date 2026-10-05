# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ArborEats is a map of food and drink deals in Ann Arbor. A Node pipeline scrapes restaurants' own websites and writes one JSON file; a static site renders it on a MapLibre map. There is no backend, no build step, no test suite and no linter.

**Hard constraints from the owner:** the project must be entirely free to run and must run independently of Claude. Do not add the Anthropic SDK, `claude -p`, or any paid API or service to the pipeline. Deal extraction is rule-based and image reading is local OCR for this reason.

## Commands

```
npm install
npm run dev          # static server for site/ on http://localhost:5173 (PORT to change)

npm run restaurants  # step 1
npm run sources      # step 2
npm run scrape       # step 3   (node pipeline/3-scrape.js --force --limit N)
npm run publish      # step 4
npm run pipeline     # all four in order
```

`npm run scrape` accepts `--force` (re-extract every page) and `--no-ocr`. Running with `--no-ocr` changes each page's image fingerprint, so pages with deal images are re-extracted without them; rerun without the flag to restore.

`node --check site/app.js` is the only automated check available for the front end.

## Pipeline architecture

Each step is a standalone ESM script that reads the previous step's JSON from `data/` and writes its own. Scripts run top to bottom at import; there is no shared orchestrator beyond `npm run pipeline`.

| Step | Reads | Writes |
|---|---|---|
| `1-restaurants.js` | Overpass API (OpenStreetMap), Overture Maps (S3 via DuckDB) | `data/restaurants.json`, `data/boundary.geojson` |
| `2-sources.js` | `restaurants.json`, `overrides.json`, previous `sources.json` | `data/sources.json` |
| `3-scrape.js` | `sources.json`, previous `deals.json` | `data/pages.json`, `data/deals.json`, `data/deals-log.jsonl` (append) |
| `4-publish.js` | `restaurants.json`, `sources.json`, `deals.json` | `site/data/deals.json`, `site/data/boundary.geojson` |

Things that are not obvious from any one file:

- **Restaurant ids** are OSM ids (`node/123`, `way/456`), or `overture/<id>` for the few places only Overture has, and are the join key across every data file. `overrides.json` is the exception: it is keyed by restaurant **name**.
- **The boundary** is not a hand-drawn polygon. Step 1 downloads motorway geometry and ray-casts from downtown to the first highway hit in each direction (the highways cross on bridges and share no nodes, so they can't be polygonized). It throws if the ring isn't closed.
- **Overture Maps is an enrichment, not a second list.** Step 1 matches Overture places to OSM ones by name tokens within 150 m and fills missing website/social/phone fields. Overture-only places are added only if they have a website and two storefront providers (Meta, Microsoft, Foursquare, AllThePlaces) agree; a looser filter lets in closed restaurants and unrelated companies. If the Overture query fails, step 1 continues with OSM alone. Only the main Overpass server is used: a mirror returned a different, incomplete copy of the data.
- **Source trust order** in step 2: `overrides.json` > website/socials from step 1 > links found on the restaurant's homepage. There is no web search; restaurants without a working site need an override.
- **Closures:** the map datasets lag (a restaurant can be closed while OSM, Overture and its own website all say open). `"closed": true` in `overrides.json` removes one; step 2 also marks a restaurant closed if its homepage carries a closure notice. Step 1 only flags `overture_says_closed` for a person to confirm.
- **`deals.json` is keyed `restaurant id -> page URL -> { hash, images_hash, verified_at, extracted_by, deals }`.** `hash` is the SHA-1 of the page's extracted text and `images_hash` of its deal-image URLs. Step 3 re-extracts a page only when either changed (`--force` overrides). Unchanged pages just get `verified_at` bumped; pages that fail to fetch keep their old deals and old `verified_at`. Changing `pageText()` in step 3 changes every hash and so re-extracts everything, overwriting hand-reviewed entries.
- **Extraction** (`pipeline/lib/extract.js`) is line-based rules: it tracks a "when" context (day headings, happy-hour blocks, time ranges) and emits lines that state an offer inside one. Each deal's `quote` is verbatim page text. Each deal gets `confidence`. `high` means one of: the line names its own weekday; it sits under a single undated weekday heading (at most 6 offers); it belongs to a labelled block (`BLOCK_LABEL_RE`: happy hour, late night, specials, deals...) whose days and hours are both stated within a few lines and span under 8 hours; it is a limited-time offer (`LIMITED_RE`); or, on a chain's page (`chain: true`), it is a promo line with a cue word (`PROMO_CUE_RE`), published as an every-day national offer. Everything else is `low`. Step 4 publishes only `high` rule-extracted deals; `low` ones stay in `deals.json`. The owner wants real deals recovered but few junk entries, so check a change against the whole published list, not one restaurant. Lines and headings naming another town (`OTHER_TOWN_RE`) are skipped, since chains list every branch on one site. Entries with `extracted_by` other than `"rules"` were reviewed by hand and are published with `reviewed: true`.
- **Image reading** (`pipeline/lib/ocr.js`) runs Tesseract locally on images whose file name or alt text hints at a deal (max 4 per page), caching by URL in `data/cache/ocr-layout/`. `layoutText()` uses word bounding boxes: when it finds a column of day labels (the usual weekly-specials flyer), each line is assigned to the vertically nearest label and written as "Monday: ...", because Tesseract's top-to-bottom order otherwise attaches offers to the wrong day. Such deals carry `from_image`.
- **Chains** are restaurants with an OSM `brand` tag (Overture's brand field is set for independents too, so it is not used). Step 3 renders their pages in headless Chromium via Playwright (`render: true`), and any page whose plain HTML has under 300 visible characters is rendered as well. Playwright is optional at runtime: without it those pages stay empty. Some chains (Domino's) publish prices only as images or scripts and still yield nothing.
- **Step 4 dedupes** deals by quote + days + start time across a restaurant's pages and drops ones past `valid_until`. Only restaurants with at least one deal are published.
- **Deal schema** is defined by `makeDeal()` in `pipeline/lib/extract.js`. `site/app.js` depends on its field names (`days` as `mon`..`sun`, `start_time`/`end_time` as 24h `HH:MM`, `category` of `food`/`drink`/`both`).

### Fetching

All page fetches go through `fetchPage` / `cachedFetchPage` in `pipeline/lib/util.js`, which identify as `ArborEatsBot`, honour robots.txt, serialize requests per host with a 1 s gap, and never throw (failures come back as `{ ok: false, error }`). `cachedFetchPage` caches responses in `data/cache/http/` for 12 hours, so steps 2 and 3 don't double-fetch and reruns are fast; delete `data/cache/` to force fresh fetches. `data/cache/` is gitignored and large.

Do not change the user agent to imitate a browser or crawler to get past 403s or login walls. Instagram and Facebook are deliberately not scraped (Instagram serves a login shell to scripted requests); step 2 records the handles only.

## Deployment

The site is on GitHub Pages at https://rextlfung.github.io/ArborEats/. Two workflows:

- `pages.yml` deploys `site/` on any push to `main` that touches it.
- `refresh.yml` runs the whole pipeline daily at midnight Ann Arbor time, commits `data/` and `site/data/`, and deploys Pages itself (a push made with the workflow token does not trigger `pages.yml`). It has two UTC cron entries, one per daylight/standard offset, and a first step that skips the one that does not apply. Step 1 is allowed to fail there (the Overpass server is often busy); the previous `restaurants.json` is then used.

CI starts with an empty `data/cache/` apart from OCR results, and its IP is blocked by more sites than a home connection. Step 2 therefore keeps a restaurant's previously found pages when its homepage fails to load, so step 3 does not prune that restaurant's deals. `data/pages.json` is a per-run report and is gitignored.

## Site

`site/` is plain HTML/CSS/JS with MapLibre GL from unpkg and OpenFreeMap tiles (no API key). The look (ink `#0e1b2e` on white, maize `#ffcb05` price tags and selected marker, Bricolage Grotesque headings over Instrument Sans) was designed on a Claude Design canvas and hand-ported to `style.css`; the canvas is not a build input. `app.js` holds one `state` object (day, category, local/chain, "on right now", search, selection); `visible()` derives the filtered restaurant list, and `render()` redraws both the sidebar and the map's GeoJSON source from it. "Today" and "now" are computed in `America/Detroit` regardless of the visitor's time zone. Deals with an empty `days` array are shown on every day rather than hidden. Map markers are a dot layer plus a name-label layer; overlapping names are dropped by MapLibre's collision handling, the dots never are.

Theme: `data-theme` on `<html>` (set by an inline script before paint from `localStorage`, else the device setting) switches the CSS variables in `style.css`; `THEMES` in `app.js` holds the matching map style and marker colours. Switching calls `map.setStyle(..., { diff: false })`, which discards our layers, so `addLayers()` runs again on every `style.load`.

Phone layout (under 760px): map on the top half, list on the bottom half, and `.filters` becomes a sheet over the list toggled by the `#filters-open` button via the `filters-open` class on `<body>`. "Now" is the first cell of the day bar, not a separate control.
