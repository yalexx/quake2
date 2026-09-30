#!/usr/bin/env node
// Zero-dependency static server for the Quake 2 ClawBox app.
// Listens on 127.0.0.1:PORT and serves this folder both at "/" and under
// the ClawBox base path "/apps/quake2/" (the prefix is stripped).
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4231);
const BASE = "/apps/quake2";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".data": "application/octet-stream",
  ".pak": "application/octet-stream",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

const server = http.createServer((req, res) => {
  let urlPath;
  try {
    urlPath = decodeURIComponent(new URL(req.url, "http://127.0.0.1").pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (urlPath === BASE) urlPath = "/";
  else if (urlPath.startsWith(BASE + "/")) urlPath = urlPath.slice(BASE.length);
  if (urlPath.endsWith("/")) urlPath += "index.html";

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT + path.sep) || path.basename(filePath).startsWith(".")) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Quake 2 static server on http://127.0.0.1:${PORT}/ (also ${BASE}/)`);
});
