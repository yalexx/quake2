#!/usr/bin/env node
// Zero-dependency static server for the Quake 2 ClawBox app.
// Listens on 127.0.0.1:PORT and serves this folder both at "/" and under
// the ClawBox base path "/apps/quake2/" (the prefix is stripped).
//
// It also keeps the files the game writes (saved games, config.cfg) under
// "/userdata/", because the page runs in an opaque-origin sandbox where
// IndexedDB and localStorage are denied:
//   GET  /userdata/              -> {"files":[{"path":"baseq2/save/…","size":N},…]}
//   GET  /userdata/<path>        -> the file
//   POST /userdata/<path>        -> body replaces the file
//   POST /userdata/<path>?delete -> removes the file
// Writes are plain POSTs with no custom headers, so the browser sends them
// without a CORS preflight.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4231);
const BASE = "/apps/quake2";
const USERDATA = "/userdata";
const DATA_DIR = path.resolve(process.env.QUAKE2_DATA_DIR || path.join(ROOT, "userdata"));
const MAX_UPLOAD = 64 * 1024 * 1024; // far above any Quake 2 save file
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "Content-Length",
};
let tmpCounter = 0;

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

// Every file under DATA_DIR as {path, size}, with "/"-separated relative paths.
async function listUserData(dir, prefix, out) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return out;
    throw err;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue; // uploads still being written
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await listUserData(full, prefix + entry.name + "/", out);
    else if (entry.isFile()) out.push({ path: prefix + entry.name, size: (await fs.promises.stat(full)).size });
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size <= MAX_UPLOAD) chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_UPLOAD) reject(Object.assign(new Error("Upload too large"), { status: 413 }));
      else resolve(Buffer.concat(chunks));
    });
    req.on("error", reject);
    req.on("close", () => reject(new Error("Upload aborted")));
  });
}

async function handleUserData(req, res, rel, remove) {
  const headers = { ...CORS, "Cache-Control": "no-store" };
  if (req.method === "OPTIONS") {
    res.writeHead(204, headers).end();
    return;
  }

  if (rel === "") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...headers, Allow: "GET, HEAD, OPTIONS" }).end();
      return;
    }
    const body = JSON.stringify({ files: await listUserData(DATA_DIR, "", []) });
    res.writeHead(200, { ...headers, "Content-Type": MIME[".json"], "Content-Length": Buffer.byteLength(body) });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }

  const filePath = path.resolve(DATA_DIR, rel);
  if (!filePath.startsWith(DATA_DIR + path.sep) || rel.split("/").some((part) => part === "" || part.startsWith("."))) {
    res.writeHead(403, { ...headers, "Content-Type": "text/plain" }).end("Forbidden");
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    let data;
    try {
      data = await fs.promises.readFile(filePath);
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "EISDIR" && err.code !== "ENOTDIR") throw err;
      res.writeHead(404, { ...headers, "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, { ...headers, "Content-Type": "application/octet-stream", "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
    return;
  }

  if (req.method === "POST") {
    if (remove) {
      await fs.promises.rm(filePath, { force: true });
      res.writeHead(204, headers).end();
      return;
    }
    const body = await readBody(req);
    const dir = path.dirname(filePath);
    // Write beside the target and rename over it, so a reader never sees half a file.
    const tmpPath = path.join(dir, "." + path.basename(filePath) + "." + process.pid + "." + ++tmpCounter + ".tmp");
    await fs.promises.mkdir(dir, { recursive: true });
    try {
      await fs.promises.writeFile(tmpPath, body);
      await fs.promises.rename(tmpPath, filePath);
    } catch (err) {
      await fs.promises.rm(tmpPath, { force: true });
      throw err;
    }
    res.writeHead(204, headers).end();
    return;
  }

  res.writeHead(405, { ...headers, Allow: "GET, HEAD, POST, OPTIONS" }).end();
}

const server = http.createServer((req, res) => {
  let url, urlPath;
  try {
    url = new URL(req.url, "http://127.0.0.1");
    urlPath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400).end("Bad request");
    return;
  }
  // fs calls throw synchronously on a NUL byte, which would take the server down.
  if (urlPath.includes("\0")) {
    res.writeHead(400).end("Bad request");
    return;
  }
  if (urlPath === BASE) urlPath = "/";
  else if (urlPath.startsWith(BASE + "/")) urlPath = urlPath.slice(BASE.length);

  if (urlPath === USERDATA || urlPath.startsWith(USERDATA + "/")) {
    handleUserData(req, res, urlPath.slice(USERDATA.length + 1), url.searchParams.has("delete")).catch((err) => {
      console.error("userdata " + req.method + " " + urlPath + ":", err.message);
      if (!res.headersSent) res.writeHead(err.status || 500, { ...CORS, "Content-Type": "text/plain" });
      res.end(err.status === 413 ? "Too large" : "Server error");
    });
    return;
  }

  if (urlPath.endsWith("/")) urlPath += "index.html";

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT + path.sep) || path.basename(filePath).startsWith(".")) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" }).end("Not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    // The box frames the app with `CSP: sandbox` (no allow-same-origin), so the
    // page's origin is opaque and every fetch() it makes is a CORS request.
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=3600",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "Content-Length",
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Quake 2 static server on http://127.0.0.1:${PORT}/ (also ${BASE}/)`);
});
