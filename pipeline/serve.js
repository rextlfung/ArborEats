// Minimal static server for the site/ folder: `npm run dev`.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { ROOT } from "./lib/util.js";

const SITE = path.join(ROOT, "site");
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".geojson": "application/json" };
const port = Number(process.env.PORT ?? 5173);

http
  .createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname);
    const file = path.join(SITE, rel.endsWith("/") ? rel + "index.html" : rel);
    if (!file.startsWith(SITE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(port, () => console.log(`ArborEats: http://localhost:${port}`));
