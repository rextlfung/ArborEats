// Step 3: fetch every page listed in data/sources.json, reduce it to text
// (including text read out of deal images), and extract the deals on it.
// Writes data/pages.json (what was fetched) and data/deals.json (the deals log,
// keyed by restaurant and source page).
//
// A page is only re-extracted when its text or its images changed since the
// last run, so entries corrected by hand survive until the page itself changes.
//
//   node pipeline/3-scrape.js [--force] [--no-ocr]
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { extractDeals } from "./lib/extract.js";
import { dealImages, imageText, stopOcr } from "./lib/ocr.js";
import { CACHE, DATA, cachedFetchPage, closeBrowser, pool, readJson, sha1, writeJson } from "./lib/util.js";

const MAX_PAGE_CHARS = 60000;
const args = process.argv.slice(2);
const force = args.includes("--force");
const useOcr = !args.includes("--no-ocr");

function pageText(html) {
  const $ = cheerio.load(html);
  $("script, style, noscript, svg, iframe, template").remove();
  // Sites often describe a deal graphic in its alt text.
  $("img[alt]").each((_, img) => {
    const alt = $(img).attr("alt").trim();
    if (alt.length > 15) $(img).replaceWith(`\n${alt}\n`);
  });
  $("br, p, div, li, tr, h1, h2, h3, h4, h5, h6, section, article").each((_, el) => {
    $(el).append("\n");
  });
  return $("body")
    .text()
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

const sources = readJson(path.join(DATA, "sources.json"), {});
// Chains: their sites are JavaScript-heavy and their promos are national offers.
const isChain = Object.fromEntries(readJson(path.join(DATA, "restaurants.json"), []).map((r) => [r.id, Boolean(r.brand)]));
const dealsFile = path.join(DATA, "deals.json");
const deals = readJson(dealsFile, {});
const now = new Date().toISOString();

// --- fetch -------------------------------------------------------------------
const jobs = Object.entries(sources).flatMap(([id, s]) => s.pages.map((url) => ({ id, url })));
const pages = await pool(jobs, 12, async ({ id, url }) => {
  const res = await cachedFetchPage(url, { render: isChain[id] });
  const record = { restaurant_id: id, url, fetched_at: res.fetched_at, status: res.ok ? "ok" : (res.error ?? `HTTP ${res.status}`) };
  if (!res.ok) return record;
  let text = pageText(res.text);
  if (text.length > MAX_PAGE_CHARS) {
    console.warn(`  ${url}: ${text.length} chars, keeping the first ${MAX_PAGE_CHARS}`);
    text = text.slice(0, MAX_PAGE_CHARS);
  }
  const hash = sha1(text);
  const file = path.join(CACHE, "text", hash + ".txt");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  const images = useOcr ? dealImages(res.text, res.url) : [];
  return { ...record, hash, chars: text.length, images, images_hash: sha1(images.join("\n")) };
});
await closeBrowser();
writeJson(path.join(DATA, "pages.json"), pages);

// --- extract -----------------------------------------------------------------
// Forget pages step 2 no longer lists (a closed restaurant, a dropped link).
for (const [id, byUrl] of Object.entries(deals)) {
  for (const url of Object.keys(byUrl)) if (!sources[id]?.pages.includes(url)) delete byUrl[url];
  if (!Object.keys(byUrl).length) delete deals[id];
}

const ok = pages.filter((p) => p.hash);
const log = fs.createWriteStream(path.join(DATA, "deals-log.jsonl"), { flags: "a" });
let extracted = 0;
let unchanged = 0;
let fromImages = 0;

for (const p of ok) {
  const stored = deals[p.restaurant_id]?.[p.url];
  // Entries written before image reading existed have no images_hash; the page
  // text alone decides for those.
  const same = stored && stored.hash === p.hash && (stored.images_hash ?? p.images_hash) === p.images_hash;
  if (same && !force) {
    stored.verified_at = now; // the site still says what we recorded
    unchanged++;
    continue;
  }
  const text = fs.readFileSync(path.join(CACHE, "text", p.hash + ".txt"), "utf8");
  const chain = isChain[p.restaurant_id];
  const found = extractDeals(text, { chain }).map((d) => ({ ...d, from_image: null }));
  for (const image of p.images) {
    const ocr = await imageText(image);
    if (!ocr) continue;
    const inImage = extractDeals(ocr, { chain }).filter((d) => !found.some((f) => f.quote === d.quote));
    fromImages += inImage.length;
    found.push(...inImage.map((d) => ({ ...d, from_image: image })));
  }
  const before = stored?.deals.length ?? 0;
  (deals[p.restaurant_id] ??= {})[p.url] = { hash: p.hash, images_hash: p.images_hash, verified_at: now, extracted_by: "rules", deals: found };
  if (found.length || before) {
    log.write(JSON.stringify({ at: now, restaurant: sources[p.restaurant_id].name, url: p.url, before, deals: found }) + "\n");
  }
  extracted += found.length;
}
log.end();
await stopOcr();
writeJson(dealsFile, deals);

console.log(`${pages.length} pages: ${ok.length} fetched, ${pages.length - ok.length} failed`);
console.log(`  unchanged since last run: ${unchanged}`);
console.log(`  extracted ${extracted} deals from ${ok.length - unchanged} new or changed pages (${fromImages} read from images)`);
