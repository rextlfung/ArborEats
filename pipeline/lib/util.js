import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const DATA = path.join(ROOT, "data");
export const CACHE = path.join(DATA, "cache");

export const USER_AGENT = "ArborEatsBot/0.1 (local Ann Arbor food deals map)";

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Run fn over items with at most `limit` in flight.
export async function pool(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

// One request per host at a time, spaced out, so no restaurant site sees a burst.
const HOST_DELAY_MS = 1000;
const hostQueues = new Map();
function withHostSlot(host, fn) {
  const prev = hostQueues.get(host) ?? Promise.resolve();
  const run = prev.then(fn);
  hostQueues.set(host, run.catch(() => {}).then(() => sleep(HOST_DELAY_MS)));
  return run;
}

const robotsCache = new Map();
async function disallowedPaths(origin) {
  if (!robotsCache.has(origin)) {
    robotsCache.set(
      origin,
      rawFetch(origin + "/robots.txt", 10000)
        .then((r) => (r.ok && /text\/plain/.test(r.contentType) ? parseRobots(r.text) : []))
        .catch(() => []),
    );
  }
  return robotsCache.get(origin);
}

// Disallow rules from the groups that apply to us ("*" or our own name).
export function parseRobots(text) {
  const rules = [];
  let applies = false;
  let lastWasAgent = false;
  for (const line of text.split(/\r?\n/)) {
    const m = line.replace(/#.*/, "").match(/^\s*([A-Za-z-]+)\s*:\s*(.*?)\s*$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    if (key === "user-agent") {
      const agent = m[2].toLowerCase();
      const match = agent === "*" || "arboreatsbot".includes(agent);
      applies = lastWasAgent ? applies || match : match;
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (key === "disallow" && applies && m[2]) rules.push(m[2]);
    }
  }
  return rules;
}

async function rawFetch(url, timeout) {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,*/*;q=0.8" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeout),
  });
  const contentType = res.headers.get("content-type") ?? "";
  const text = /text|json|xml/.test(contentType) ? await res.text() : "";
  return { ok: res.ok, status: res.status, url: res.url, contentType, text };
}

// Polite page fetch: honours robots.txt, rate-limits per host, never throws.
export async function fetchPage(url, { timeout = 20000 } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, status: 0, url, error: "bad url" };
  }
  const rules = await disallowedPaths(u.origin);
  if (rules.some((rule) => (u.pathname + u.search).startsWith(rule))) {
    return { ok: false, status: 0, url, error: "disallowed by robots.txt" };
  }
  return withHostSlot(u.host, async () => {
    try {
      return await rawFetch(url, timeout);
    } catch (err) {
      return { ok: false, status: 0, url, error: err.cause?.code ?? err.name ?? String(err) };
    }
  });
}

// --- rendering -----------------------------------------------------------------
// Some sites (mostly chains) build the page in JavaScript, so the plain HTML has
// no text. Those are loaded in a headless browser instead. Playwright is
// optional: without it such pages simply stay empty.
const MAX_OPEN_TABS = 4;
let browserPromise;
let openTabs = 0;
const tabWaiters = [];

function getBrowser() {
  browserPromise ??= import("playwright")
    .then(async ({ chromium }) => {
      const browser = await chromium.launch();
      return { browser, context: await browser.newContext({ userAgent: USER_AGENT }) };
    })
    .catch((err) => {
      console.warn(`  browser rendering unavailable: ${err.message.split("\n")[0]}`);
      return null;
    });
  return browserPromise;
}

async function renderPage(url, timeout = 30000) {
  const b = await getBrowser();
  if (!b) return null;
  if (openTabs >= MAX_OPEN_TABS) await new Promise((resolve) => tabWaiters.push(resolve));
  openTabs++;
  const tab = await b.context.newPage();
  try {
    const res = await tab.goto(url, { waitUntil: "domcontentloaded", timeout });
    // Give scripts a moment to fill the page in; a busy site never goes idle.
    await tab.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    return { ok: res?.ok() ?? false, status: res?.status() ?? 0, url: tab.url(), contentType: "text/html", text: await tab.content() };
  } catch {
    return null;
  } finally {
    await tab.close().catch(() => {});
    openTabs--;
    tabWaiters.shift()?.();
  }
}

export async function closeBrowser() {
  const b = await browserPromise;
  await b?.browser.close();
}

const visibleChars = (html) =>
  html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, " ").replace(/\s+/g, " ").length;
const NEEDS_RENDER_BELOW = 300;

// fetchPage with an on-disk cache, so steps 2 and 3 (and reruns the same day)
// don't hit a site twice for the same URL. `render: true` always loads the page
// in a browser; otherwise that only happens when the plain HTML is nearly empty.
export async function cachedFetchPage(url, { maxAgeHours = 12, render = false } = {}) {
  const file = path.join(CACHE, "http", crypto.createHash("sha1").update(url).digest("hex") + ".json");
  const hit = readJson(file, null);
  const fresh = hit && Date.now() - Date.parse(hit.fetched_at) < maxAgeHours * 3600e3;
  if (fresh && (!render || hit.rendered !== undefined)) return hit;
  let page = fresh ? hit : await fetchPage(url);
  if (page.ok && (render || visibleChars(page.text) < NEEDS_RENDER_BELOW)) {
    // Same robots.txt check and per-host pacing as a plain fetch.
    const rendered = await withHostSlot(new URL(url).host, () => renderPage(url));
    page = rendered?.ok ? { ...rendered, rendered: true } : { ...page, rendered: false };
  }
  page = { ...page, fetched_at: new Date().toISOString() };
  writeJson(file, page);
  return page;
}

export const sha1 = (text) => crypto.createHash("sha1").update(text).digest("hex");
