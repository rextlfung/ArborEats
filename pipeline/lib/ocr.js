// Reads text out of images (deal flyers, happy-hour graphics) with Tesseract,
// which runs locally. Results are cached per image URL.
import fs from "node:fs";
import path from "node:path";
import * as cheerio from "cheerio";
import { createWorker } from "tesseract.js";
import { CACHE, USER_AGENT, sha1 } from "./util.js";

const LIKELY_DEAL_IMAGE = /happy|special|deal|promo|flyer|offer|menu|weekly|daily|discount/i;
const NEVER = /logo|icon|sprite|avatar|favicon|\.svg(\?|$)|\.gif(\?|$)/i;
const MAX_IMAGES_PER_PAGE = 4;
const MAX_BYTES = 8 * 1024 * 1024;
const MIN_USEFUL_CHARS = 25;

// Images worth reading: ones whose file name or alt text hints at a deal.
export function dealImages(html, baseUrl) {
  const $ = cheerio.load(html);
  const urls = new Set();
  $("img").each((_, img) => {
    const src = $(img).attr("src") ?? $(img).attr("data-src");
    if (!src || src.startsWith("data:")) return;
    const hint = `${src} ${$(img).attr("alt") ?? ""}`;
    if (!LIKELY_DEAL_IMAGE.test(hint) || NEVER.test(src)) return;
    try {
      urls.add(new URL(src, baseUrl).href);
    } catch {}
  });
  return [...urls].slice(0, MAX_IMAGES_PER_PAGE);
}

let worker;
let queue = Promise.resolve();

const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
// Flyers print day labels large and letter-spaced, which OCR returns as
// "M 0 N", "TH U" or "FR [". Returns the day and how many words the label used.
function leadingDay(words) {
  let joined = "";
  for (let n = 1; n <= Math.min(3, words.length); n++) {
    joined += words[n - 1].text;
    const label = joined.toUpperCase().replace(/0/g, "O").replace(/[\[\]|!1]$/, "I").replace(/[^A-Z]/g, "").replace(/(.)\1+/g, "$1");
    const m = label.match(/^(MON|TUE|WED|THU|FRI|SAT|SUN)(?:S|DAY|DAYS|SDAY|NESDAY|RSDAY|URDAY)?$/);
    if (m) return { day: m[1].toLowerCase(), used: n };
    if (label.length > 9) break;
  }
  return null;
}

const midY = (box) => (box.y0 + box.y1) / 2;
const isReadable = (l) => l.length >= 3 && (l.match(/[A-Za-z0-9$%]/g)?.length ?? 0) / l.length > 0.6;

// Turns OCR output into lines of text. Tesseract reads strictly top to bottom,
// which scrambles the common flyer layout of a column of day labels with each
// day's offers beside it (the label sits between two lines of offers, so offers
// end up attached to the wrong day or to none). When such a column is found,
// every line is assigned to the label it is vertically closest to and written
// out as "Monday: ...", so each offer carries its own day.
export function layoutText(blocks) {
  const lines = (blocks ?? [])
    .flatMap((b) => b.paragraphs ?? [])
    .flatMap((p) => p.lines ?? [])
    .map((l) => ({ text: l.text.trim(), bbox: l.bbox, words: l.words ?? [] }))
    .filter((l) => l.text);
  const plain = () => lines.map((l) => l.text).filter(isReadable).join("\n");

  const labels = [];
  for (const line of lines) {
    const found = leadingDay(line.words);
    if (!found) continue;
    const labelWords = line.words.slice(0, found.used);
    labels.push({
      day: found.day,
      line,
      used: found.used,
      x: labelWords[0].bbox.x0,
      right: labelWords.at(-1).bbox.x1,
      y: midY({ y0: Math.min(...labelWords.map((w) => w.bbox.y0)), y1: Math.max(...labelWords.map((w) => w.bbox.y1)) }),
    });
  }
  if (labels.length < 3) return plain();
  // A column: the labels start at about the same x.
  const width = Math.max(...lines.map((l) => l.bbox.x1));
  const xs = labels.map((l) => l.x).sort((a, b) => a - b);
  const column = labels.filter((l) => Math.abs(l.x - xs[Math.floor(xs.length / 2)]) < width * 0.08).sort((a, b) => a.y - b.y);
  if (column.length < 3) return plain();

  const gaps = column.slice(1).map((l, i) => l.y - column[i].y);
  const typicalGap = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)];
  const columnRight = Math.max(...column.map((l) => l.right));
  const dayFor = (line) => {
    const y = midY(line.bbox);
    let best = null;
    for (const label of column) if (!best || Math.abs(label.y - y) < Math.abs(best.y - y)) best = label;
    return Math.abs(best.y - y) <= typicalGap * 0.6 ? best : null;
  };

  const out = [];
  for (const line of lines) {
    const own = column.find((l) => l.line === line);
    const text = own ? line.words.slice(own.used).map((w) => w.text).join(" ") : line.text;
    if (!isReadable(text)) continue;
    // Only text beside the column belongs to a day; headers above it do not.
    const label = own ?? (line.bbox.x0 >= columnRight - width * 0.02 ? dayFor(line) : null);
    out.push(label ? `${DAY_NAMES[label.day]}: ${text}` : text);
  }
  return out.join("\n");
}

async function recognize(buffer) {
  worker ??= await createWorker("eng", 1, { cachePath: path.join(CACHE, "tesseract") });
  const { data } = await worker.recognize(buffer, {}, { blocks: true });
  return layoutText(data.blocks);
}

// Text found in the image, or "" if it could not be read. Never throws.
export function imageText(url) {
  const file = path.join(CACHE, "ocr-layout", sha1(url) + ".txt");
  if (fs.existsSync(file)) return Promise.resolve(fs.readFileSync(file, "utf8"));
  // Tesseract handles one image at a time.
  const job = queue.then(async () => {
    let text = "";
    try {
      const res = await fetch(url, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(20000) });
      const type = res.headers.get("content-type") ?? "";
      if (res.ok && /image\/(png|jpe?g|webp|bmp)/.test(type)) {
        const buffer = Buffer.from(await res.arrayBuffer());
        if (buffer.length <= MAX_BYTES) text = await recognize(buffer);
      }
    } catch {}
    if (text.replace(/\s/g, "").length < MIN_USEFUL_CHARS) text = "";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return text;
  });
  queue = job.catch(() => {});
  return job;
}

export async function stopOcr() {
  await queue;
  await worker?.terminate();
}
