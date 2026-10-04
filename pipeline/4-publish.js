// Step 4: turn the deals log into the single file the website reads.
// Writes site/data/deals.json and site/data/boundary.geojson.
import fs from "node:fs";
import path from "node:path";
import { DATA, ROOT, readJson, writeJson } from "./lib/util.js";

const OUT = path.join(ROOT, "site", "data");
const restaurants = readJson(path.join(DATA, "restaurants.json"), []);
const sources = readJson(path.join(DATA, "sources.json"), {});
const deals = readJson(path.join(DATA, "deals.json"), {});
const today = new Date().toISOString().slice(0, 10);

const published = [];
for (const r of restaurants) {
  if (sources[r.id]?.closed) continue;
  const seen = new Set();
  const list = [];
  for (const [url, page] of Object.entries(deals[r.id] ?? {})) {
    for (const d of page.deals) {
      if (d.valid_until && d.valid_until < today) continue;
      // Rule-extracted deals are published only when the extractor is confident.
      if (page.extracted_by === "rules" && d.confidence !== "high") continue;
      // The same deal often appears on the homepage and on the specials page.
      const key = `${d.quote.toLowerCase()}|${d.days.join()}|${d.start_time}`;
      if (seen.has(key)) continue;
      seen.add(key);
      list.push({ ...d, source_url: url, verified_at: page.verified_at, reviewed: page.extracted_by !== "rules" });
    }
  }
  if (!list.length) continue;
  const s = sources[r.id] ?? {};
  published.push({
    id: r.id,
    name: r.name,
    lat: r.lat,
    lon: r.lon,
    type: r.type,
    chain: Boolean(r.brand),
    cuisine: r.cuisine,
    address: r.address,
    website: s.website ?? r.website,
    instagram: s.instagram ?? r.instagram,
    deals: list,
  });
}

writeJson(path.join(OUT, "deals.json"), {
  generated_at: new Date().toISOString(),
  restaurants_checked: restaurants.length,
  restaurants: published,
});
fs.copyFileSync(path.join(DATA, "boundary.geojson"), path.join(OUT, "boundary.geojson"));
console.log(`published ${published.reduce((n, r) => n + r.deals.length, 0)} deals at ${published.length} restaurants`);
