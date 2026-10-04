// Step 2: for each restaurant, work out where it publishes things online:
// its website, its social accounts, and which pages on the site are likely to
// carry deals. Writes data/sources.json.
//
// Order of trust: data/overrides.json > the website and socials recorded in
// step 1 (OpenStreetMap, then Overture) > links found on the restaurant's own
// homepage. Restaurants with no working website need an entry in overrides.json.
import path from "node:path";
import * as cheerio from "cheerio";
import { OTHER_TOWN_RE } from "./lib/extract.js";
import { DATA, cachedFetchPage, closeBrowser, pool, readJson, writeJson } from "./lib/util.js";

const DEAL_LINK = /special|deal|happy[\s-]?hour|promo|offer|coupon|discount|weekly|daily|event/i;
const STRONG_DEAL_LINK = /special|deal|happy[\s-]?hour|promo|coupon|discount/i;
const MENU_LINK = /menu|drink|food/i;
const SKIP_LINK = /private|catering|gift|career|job|reserv|order|cart|login|account/i;
// A restaurant announcing its own closure on its homepage.
const CLOSURE_NOTICE =
  /permanently closed|closed (?:our|its) doors|(?:is|are|has|have) (?:now |officially )?closed (?:for good|permanently)|location (?:is|has) (?:now |permanently )closed|no longer in business|out of business/i;
const MAX_DEAL_PAGES = 4;
const MAX_MENU_PAGES = 2;

const IG_RESERVED = new Set(["p", "reel", "reels", "explore", "accounts", "stories", "tv", "share"]);
const FB_RESERVED = new Set(["sharer", "sharer.php", "share", "tr", "plugins", "dialog", "login", "profile.php", "pages", "people", "groups", "events", "watch", "hashtag"]);

const bareHost = (u) => new URL(u).hostname.replace(/^www\./, "");

function socialHandle(href, domain, reserved) {
  const m = href.match(new RegExp(`${domain}/([A-Za-z0-9_.-]+)`, "i"));
  return m && !reserved.has(m[1].toLowerCase()) ? m[1] : null;
}

// Pull socials and likely deal/menu pages out of a homepage.
function readHomepage(html, baseUrl) {
  const $ = cheerio.load(html);
  const found = { instagram: null, facebook: null, dealPages: [], menuPages: [] };
  const base = new URL(baseUrl);
  const seen = new Set([(base.origin + base.pathname).replace(/\/$/, "")]);
  $("a[href]").each((_, a) => {
    let url;
    try {
      url = new URL($(a).attr("href"), baseUrl);
    } catch {
      return;
    }
    if (!/^https?:$/.test(url.protocol)) return;
    const href = url.href;
    if (/instagram\.com/i.test(url.hostname)) {
      found.instagram ??= socialHandle(href, "instagram\\.com", IG_RESERVED);
      return;
    }
    if (/facebook\.com/i.test(url.hostname)) {
      found.facebook ??= socialHandle(href, "facebook\\.com", FB_RESERVED);
      return;
    }
    if (bareHost(href) !== bareHost(baseUrl)) return;
    if (/\.(pdf|jpe?g|png|webp|gif|zip)$/i.test(url.pathname)) return;
    url.hash = "";
    // Same page with different tracking parameters counts once.
    const clean = (url.origin + url.pathname).replace(/\/$/, "");
    if (seen.has(clean)) return;
    const label = `${url.pathname} ${$(a).text()}`;
    if (SKIP_LINK.test(label)) return;
    // Another branch's page ("Highland specials") on a multi-location site.
    if (OTHER_TOWN_RE.test(`${$(a).text()} ${url.pathname.replace(/ann[-_ ]?arbor/gi, "")}`.replace(/[-_/]/g, " "))) return;
    if (DEAL_LINK.test(label)) {
      seen.add(clean);
      found.dealPages.push(url.href);
    } else if (MENU_LINK.test(label)) {
      seen.add(clean);
      found.menuPages.push(url.href);
    }
  });
  // "Specials" and "happy hour" pages before generic "events" pages.
  const strong = (u) => (STRONG_DEAL_LINK.test(u) ? 0 : 1);
  found.dealPages.sort((a, b) => strong(a) - strong(b));
  return found;
}

const restaurants = readJson(path.join(DATA, "restaurants.json"), []);
const overrides = readJson(path.join(DATA, "overrides.json"), {});
const sourcesFile = path.join(DATA, "sources.json");
const now = new Date().toISOString();

async function resolve(r) {
  const override = overrides[r.name] ?? {};
  const source = {
    name: r.name,
    website: override.website ?? r.website,
    website_from: override.website ? "override" : r.website ? "osm" : null,
    website_status: null,
    instagram: override.instagram ?? r.instagram,
    facebook: override.facebook ?? r.facebook,
    pages: [],
    checked_at: now,
  };

  if (override.closed) return [r.id, { ...source, closed: "override" }];
  const home = source.website ? await cachedFetchPage(source.website) : null;

  if (home) source.website_status = home.ok ? "ok" : (home.error ?? `HTTP ${home.status}`);
  if (home?.ok && CLOSURE_NOTICE.test(cheerio.load(home.text)("body").text())) {
    return [r.id, { ...source, closed: "website says so" }];
  }
  if (home?.ok) {
    const found = readHomepage(home.text, home.url);
    source.instagram ??= found.instagram;
    source.facebook ??= found.facebook;
    source.pages = [
      home.url,
      ...found.dealPages.slice(0, MAX_DEAL_PAGES),
      ...found.menuPages.slice(0, MAX_MENU_PAGES),
    ];
  }
  for (const extra of override.pages ?? []) if (!source.pages.includes(extra)) source.pages.push(extra);
  return [r.id, source];
}

const entries = await pool(restaurants, 12, resolve);
await closeBrowser();
const sources = Object.fromEntries(entries);
writeJson(sourcesFile, sources);

const all = Object.values(sources);
const count = (pred) => all.filter(pred).length;
console.log(`${all.length} restaurants`);
console.log(`  marked closed:    ${count((s) => s.closed)} (${all.filter((s) => s.closed).map((s) => s.name).join("; ")})`);
console.log(`  working website:  ${count((s) => s.website_status === "ok")}`);
console.log(`  website failed:   ${count((s) => s.website && s.website_status !== "ok")}`);
console.log(`  no website known: ${count((s) => !s.website)}`);
console.log(`  instagram handle: ${count((s) => s.instagram)}`);
console.log(`  facebook page:    ${count((s) => s.facebook)}`);
console.log(`  pages to scrape:  ${all.reduce((n, s) => n + s.pages.length, 0)}`);
