// Dev server for the userscript's @require.
//
// Firefox extensions cannot read file:// URLs, so Tampermonkey has to pull the
// script over HTTP. Everything is served with no-store: Tampermonkey caches
// @require resources, and a 304 here means you would keep running the previous
// version after every edit.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname);
const PORT = Number(process.env.PORT || 8777);

const TYPES = {
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "") || "index.html";

  // Contain the path: a served dev tree should not expose the whole disk.
  const target = resolve(join(ROOT, normalize(rel)));
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  // .env holds the API key and lives in this directory.
  if (/(^|[\\/])\.env$/i.test(target)) {
    res.writeHead(403).end("forbidden");
    return;
  }

  try {
    const info = await stat(target);
    if (info.isDirectory()) {
      res.writeHead(403).end("no directory listing");
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": TYPES[extname(target).toLowerCase()] || "application/octet-stream",
      // The whole point: never let Tampermonkey reuse a stale @require.
      "cache-control": "no-store, no-cache, must-revalidate, max-age=0",
      pragma: "no-cache",
      expires: "0",
      "access-control-allow-origin": "*",
    });
    res.end(body);
    console.log(new Date().toISOString().slice(11, 19), req.method, rel, info.size + "b");
  } catch {
    res.writeHead(404).end("not found");
    console.log(new Date().toISOString().slice(11, 19), req.method, rel, "404");
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`dev server → http://127.0.0.1:${PORT}/  (root: ${ROOT})`);
  console.log(`require URL → http://127.0.0.1:${PORT}/claude-overview.user.js`);
});
