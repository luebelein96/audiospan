#!/usr/bin/env node
// Serves the built documentation site (apps/docs/dist) under its GitHub Pages
// base for tests/browser/docs.spec.ts. Starts even when the site is not built;
// the spec skips in that case.
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const port = Number(process.argv[2] ?? 8792);
const BASE = "/audiospan";
const dist = resolve(fileURLToPath(new URL("../../apps/docs/dist", import.meta.url)));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".xml": "application/xml",
};

http
  .createServer((req, res) => {
    const url = decodeURIComponent(new URL(req.url ?? "/", "http://localhost").pathname);
    if (url === "/__health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(existsSync(dist) ? "ok" : "ok (apps/docs/dist is not built)");
      return;
    }
    if (url !== BASE && !url.startsWith(`${BASE}/`)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    let file = normalize(join(dist, url.slice(BASE.length) || "/"));
    if (!file.startsWith(dist)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = join(file, "index.html");
    if (!existsSync(file)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(res);
  })
  .listen(port, "127.0.0.1", () => {
    console.log(`docs: http://127.0.0.1:${port}${BASE}/ (${existsSync(dist) ? dist : "apps/docs/dist is not built"})`);
  });
