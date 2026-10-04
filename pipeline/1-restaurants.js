// Step 1: list every food business inside the Ann Arbor highway ring
// (M-14 to the north, US-23 to the east, I-94 to the south and west).
// Sources: OpenStreetMap (via the Overpass API) for the list itself, and
// Overture Maps to fill in missing websites and socials and to add places
// OpenStreetMap lacks. Writes data/boundary.geojson and data/restaurants.json.
import path from "node:path";
import { fetchOverturePlaces } from "./lib/overture.js";
import { DATA, USER_AGENT, readJson, sleep, writeJson } from "./lib/util.js";

const CENTER = { lat: 42.2808, lon: -83.743 }; // Main St & Liberty, well inside the ring
const BBOX = "42.20,-83.87,42.35,-83.65";
const AMENITIES = ["restaurant", "fast_food", "cafe", "bar", "pub", "ice_cream", "biergarten", "food_court"];
const OVERPASS = "https://overpass-api.de/api/interpreter";

async function overpass(query) {
  let lastError;
  // The public server is often busy (429/504), so retry with a growing pause.
  // Mirrors are deliberately not used: one returned a different, incomplete copy of the data.
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      const res = await fetch(OVERPASS, {
        method: "POST",
        headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
        body: "data=" + encodeURIComponent(query),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()).elements;
    } catch (err) {
      lastError = err;
      console.warn(`  overpass attempt ${attempt + 1} failed: ${err.message}`);
      await sleep(5000 * (attempt + 1));
    }
  }
  throw lastError;
}

// The highways don't share nodes where they cross (bridges), so they can't be
// stitched into a polygon directly. Instead cast rays outward from downtown and
// keep the first highway each one hits: the region visible from the centre.
function highwayRing(ways) {
  const kx = Math.cos((CENTER.lat * Math.PI) / 180);
  const segments = [];
  for (const way of ways) {
    const pts = way.geometry.map((p) => [(p.lon - CENTER.lon) * kx, p.lat - CENTER.lat]);
    for (let i = 1; i < pts.length; i++) segments.push([pts[i - 1], pts[i]]);
  }
  const ring = [];
  for (let deg = 0; deg < 360; deg += 0.5) {
    const dx = Math.cos((deg * Math.PI) / 180);
    const dy = Math.sin((deg * Math.PI) / 180);
    let best = Infinity;
    for (const [[ax, ay], [bx, by]] of segments) {
      const ex = bx - ax;
      const ey = by - ay;
      const det = ex * dy - ey * dx;
      if (Math.abs(det) < 1e-15) continue;
      const t = (ex * ay - ey * ax) / det; // distance along the ray
      const u = (dx * ay - dy * ax) / det; // position along the segment
      if (t > 0 && u >= 0 && u <= 1 && t < best) best = t;
    }
    if (!isFinite(best)) throw new Error(`No highway found at bearing ${deg}: the ring is not closed`);
    ring.push([CENTER.lon + (best * dx) / kx, CENTER.lat + best * dy]);
  }
  ring.push(ring[0]);
  return ring;
}

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function normalizeUrl(value) {
  if (!value) return null;
  const first = value.split(";")[0].trim();
  if (!first) return null;
  return /^https?:\/\//i.test(first) ? first : "https://" + first;
}

// OSM stores socials as a full URL, "@handle" or a bare handle.
function handleFrom(value, domain) {
  if (!value) return null;
  const first = value.split(";")[0].trim();
  const m = first.match(new RegExp(domain.replace(".", "\\.") + "/([^/?#]+)", "i"));
  const handle = (m ? m[1] : first).replace(/^@/, "");
  return /^[\w.-]+$/.test(handle) ? handle : null;
}

function toRestaurant(el) {
  const t = el.tags ?? {};
  const street = [t["addr:housenumber"], t["addr:street"]].filter(Boolean).join(" ");
  return {
    id: `${el.type}/${el.id}`,
    name: t.name,
    lat: el.lat ?? el.center?.lat,
    lon: el.lon ?? el.center?.lon,
    type: t.amenity,
    brand: t.brand ?? null, // set for chains; step 3 treats their promos as national offers
    cuisine: t.cuisine ? t.cuisine.split(";").map((c) => c.trim().replace(/_/g, " ")) : [],
    address: street || null,
    phone: t.phone ?? t["contact:phone"] ?? null,
    opening_hours: t.opening_hours ?? null,
    website: normalizeUrl(t.website ?? t["contact:website"] ?? t.url),
    instagram: handleFrom(t["contact:instagram"] ?? t.instagram, "instagram.com"),
    facebook: handleFrom(t["contact:facebook"] ?? t.facebook, "facebook.com"),
    sources: ["osm"],
  };
}

// --- Overture merge ----------------------------------------------------------
const MATCH_METRES = 150;
const MIN_CONFIDENCE = 0.7;
// Providers that observe real storefronts. BrightQuery (company registrations)
// is excluded: it lists holding companies and long-closed businesses as restaurants.
const STOREFRONT_DATASETS = new Set(["meta", "Microsoft", "Foursquare", "AllThePlaces"]);
const FILLER = new Set(["the", "restaurant", "cafe", "bar", "grill", "and", "of", "ann", "arbor", "a2", "kitchen", "co", "company"]);

function nameTokens(name) {
  const tokens = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f'’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const meaningful = tokens.filter((t) => !FILLER.has(t));
  return new Set(meaningful.length ? meaningful : tokens);
}

// Same business if one name's words are contained in the other's, or they
// share at least half their words ("Zingerman's Deli" vs "Zingerman's Delicatessen").
function sameName(a, b) {
  const A = nameTokens(a);
  const B = nameTokens(b);
  const shared = [...A].filter((t) => B.has(t)).length;
  return shared === Math.min(A.size, B.size) || shared / new Set([...A, ...B]).size >= 0.5;
}

function metresApart(a, b) {
  return Math.hypot((a.lon - b.lon) * Math.cos((CENTER.lat * Math.PI) / 180), a.lat - b.lat) * 111000;
}

const OVERTURE_TYPE = { alcoholic_beverage_venue: "bar", non_alcoholic_beverage_venue: "cafe", casual_eatery: "fast_food" };

function mergeOverture(restaurants, places) {
  const stats = { matched: 0, websitesFilled: 0, added: 0 };
  for (const p of places) {
    if (p.operating_status === "permanently_closed" && p.confidence >= MIN_CONFIDENCE) {
      // Recorded, not acted on: OpenStreetMap still lists the place, so a person
      // should confirm and set "closed" in data/overrides.json.
      const hit = restaurants.find((r) => metresApart(r, p) < MATCH_METRES && sameName(r.name, p.name));
      if (hit) hit.overture_says_closed = true;
      continue;
    }
    if (p.operating_status !== "open" || p.confidence < MIN_CONFIDENCE) continue;
    const website = normalizeUrl(p.websites?.[0]);
    const social = (domain) => handleFrom(p.socials?.find((u) => u.includes(domain)), domain);
    const match = restaurants.find((r) => metresApart(r, p) < MATCH_METRES && sameName(r.name, p.name));
    if (match) {
      stats.matched++;
      if (!match.website && website) stats.websitesFilled++;
      match.website ??= website;
      match.instagram ??= social("instagram.com");
      match.facebook ??= social("facebook.com");
      match.phone ??= p.phones?.[0] ?? null;
      match.address ??= p.address ?? null;
      if (!match.sources.includes("overture")) match.sources.push("overture");
      continue;
    }
    // Not in OpenStreetMap: only trust it if it has a website and either two
    // storefront providers agree or it comes from a chain's own store locator.
    const storefront = p.datasets.filter((d) => STOREFRONT_DATASETS.has(d));
    if (!website || !(storefront.length >= 2 || storefront.includes("AllThePlaces"))) continue;
    stats.added++;
    restaurants.push({
      id: `overture/${p.id}`,
      name: p.name,
      lat: p.lat,
      lon: p.lon,
      type: OVERTURE_TYPE[p.hierarchy[1]] ?? "restaurant",
      // Overture fills "brand" for independents too, so it can't mark a chain.
      brand: null,
      cuisine: [],
      address: p.address ?? null,
      phone: p.phones?.[0] ?? null,
      opening_hours: null,
      website,
      instagram: social("instagram.com"),
      facebook: social("facebook.com"),
      sources: ["overture"],
    });
  }
  return stats;
}

const highways = await overpass(
  `[out:json][timeout:90];way["highway"~"^motorway(_link)?$"](${BBOX});out geom;`,
);
const ring = highwayRing(highways);
writeJson(path.join(DATA, "boundary.geojson"), {
  type: "Feature",
  properties: { name: "Ann Arbor highway ring (M-14 / US-23 / I-94)" },
  geometry: { type: "Polygon", coordinates: [ring.map(([lon, lat]) => [+lon.toFixed(5), +lat.toFixed(5)])] },
});

const elements = await overpass(
  `[out:json][timeout:90];nwr["amenity"~"^(${AMENITIES.join("|")})$"]["name"](${BBOX});out center tags;`,
);
const seen = new Set();
const restaurants = elements
  .map(toRestaurant)
  .filter((r) => r.lat && inRing(r.lon, r.lat, ring))
  // A place mapped as both a point and a building outline shows up twice.
  .filter((r) => {
    const key = `${r.name.toLowerCase()}|${r.lat.toFixed(3)}|${r.lon.toFixed(3)}`;
    return seen.has(key) ? false : seen.add(key);
  });

// Overture is an enrichment, not a requirement: carry on with OSM alone if it fails.
let overture = null;
try {
  const { release, places } = await fetchOverturePlaces(BBOX.split(",").map(Number));
  const inside = places.filter((p) => inRing(p.lon, p.lat, ring));
  overture = { release, ...mergeOverture(restaurants, inside) };
} catch (err) {
  console.warn(`Overture skipped: ${err.message}`);
}
restaurants.sort((a, b) => a.name.localeCompare(b.name));

const file = path.join(DATA, "restaurants.json");
const before = readJson(file, []).length;
writeJson(file, restaurants);

const count = (pred) => restaurants.filter(pred).length;
console.log(`${restaurants.length} places inside the ring (was ${before})`);
if (overture) {
  console.log(
    `  Overture ${overture.release}: matched ${overture.matched}, filled ${overture.websitesFilled} missing websites, added ${overture.added} new places`,
  );
}
console.log(`  with website:   ${count((r) => r.website)}`);
console.log(`  with instagram: ${count((r) => r.instagram)}`);
console.log(`  with facebook:  ${count((r) => r.facebook)}`);
const doubtful = restaurants.filter((r) => r.overture_says_closed);
if (doubtful.length) console.log(`  Overture says closed (check, then set "closed" in overrides.json): ${doubtful.map((r) => r.name).join("; ")}`);
for (const a of AMENITIES) console.log(`  ${a}: ${count((r) => r.type === a)}`);
