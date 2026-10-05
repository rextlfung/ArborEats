# ArborEats

A map of food and drink deals in Ann Arbor, scraped from restaurants' own websites.

## Run the site

```
npm install
npx playwright install chromium   # once; lets the scraper read JavaScript-built chain sites
npm run dev        # http://localhost:5173
```

## Refresh the data

```
npm run pipeline
```

Everything runs locally and for free: no API keys, no accounts.

| Step | Script | What it does | Output |
|---|---|---|---|
| 1 | `pipeline/1-restaurants.js` | Lists food businesses inside the M-14 / US-23 / I-94 ring from OpenStreetMap, enriched with Overture Maps | `data/restaurants.json`, `data/boundary.geojson` |
| 2 | `pipeline/2-sources.js` | Finds each one's website, Instagram and Facebook, and the pages likely to carry deals | `data/sources.json` |
| 3 | `pipeline/3-scrape.js` | Fetches those pages, reads text out of deal images (Tesseract OCR), and extracts deals with rules | `data/pages.json`, `data/deals.json`, `data/deals-log.jsonl` |
| 4 | `pipeline/4-publish.js` | Builds the file the site reads | `site/data/deals.json` |

## Hosting

The site is published with GitHub Pages at https://rextlfung.github.io/ArborEats/.
A scheduled GitHub Actions workflow (`.github/workflows/refresh.yml`) reruns the
pipeline every day at midnight Ann Arbor time, commits the new data and
redeploys. It can also be started by hand from the Actions tab.

## Correcting the data

`data/overrides.json`, keyed by restaurant name, holds manual corrections:
a better `website`, extra `pages` to scrape, or `"closed": true` to remove a
restaurant that has shut. The map datasets lag behind closures, so this file is
the fix when a closed place still shows up.

Extraction is rule-based (`pipeline/lib/extract.js`). Only deals it is confident
about are published; the rest stay in `data/deals.json` marked `low`. It still
makes mistakes in both directions. Every deal links to the
page it came from.

The scraper identifies itself, honours robots.txt and makes at most one request
per second per site.
