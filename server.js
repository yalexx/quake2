#!/usr/bin/env node
// Zero-dependency static server for the Quake 2 ClawBox app.
// Listens on 127.0.0.1:PORT (default 4231) and serves this folder both at "/"
// and under the ClawBox base path "/apps/quake2/" (the prefix is stripped).
// A static path with an empty or dot-leading segment ("//", "..", .git) is
// refused, and the save store below is never served as static files.
//
// It also keeps the files the game writes (saved games, config.cfg) under
// "/userdata/", stored in QUAKE2_DATA_DIR (default ./userdata), because the
// page runs in an opaque-origin sandbox where IndexedDB and localStorage are
// denied:
//   GET  /userdata/              -> {"files":[{"path":"baseq2/save/…","size":N},…]}
//   GET  /userdata/<path>        -> the file (404 if there is none)
//   POST /userdata/<path>        -> body replaces the file (204)
//   POST /userdata/<path>?delete -> removes the file and the folders it leaves
//                                   empty, so a wiped slot disappears (204,
//                                   also when there was nothing to remove)
// Writes are plain POSTs with no custom headers and any or no Content-Type,
// so the browser sends them without a CORS preflight; every /userdata
// response, errors included, carries the CORS headers. The client takes 2xx
// as done, 408, 429 and 5xx as transient (retried), any other 4xx as final:
//   403  <path> has an empty or dot-leading segment, a backslash or a control
//        character, or is over 240 bytes or 8 segments
//   409  <path> is a folder, or lies under something that is a file
//   413  the body is over 16 MiB
// A write goes to a dot-named temp file beside the target, is fsynced and then
// renamed over it, so readers and crashes never see half a file; temp files a
// crash left behind are deleted at startup. Writes and deletes run one at a
// time, in the order their bodies finished arriving: the last complete write
// to a path wins. Failed writes and deletes are logged to stderr.
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 4231);
const BASE = "/apps/quake2";
const USERDATA = "/userdata";
const DATA_DIR = path.resolve(process.env.QUAKE2_DATA_DIR || path.join(ROOT, "userdata"));
const MAX_UPLOAD = 16 * 1024 * 1024; // far above any Quake 2 save file
const MAX_PATH_BYTES = 240; // "baseq2/save/save15/q2dm1.sav" is 28
const MAX_PATH_SEGMENTS = 8;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Expose-Headers": "Content-Length",
};
const NO_STORE = { ...CORS, "Cache-Control": "no-store" };
let tmpCounter = 0;
let mutations = Promise.resolve(); // tail of the write/delete queue

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

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// True for dir itself and anything below it.
function isWithin(dir, p) {
  return p === dir || p.startsWith(dir + path.sep);
}

// A path segment neither route will touch: "", ".", "..", dot files (.git,
// upload temp files), backslashes and control characters.
function isBadSegment(part) {
  return part === "" || part.startsWith(".") || /[\\\x00-\x1f\x7f]/.test(part);
}

// Why a /userdata path is refused, or null when it is fine.
function userPathProblem(rel) {
  if (Buffer.byteLength(rel) > MAX_PATH_BYTES) return "path over " + MAX_PATH_BYTES + " bytes";
  const parts = rel.split("/");
  if (parts.length > MAX_PATH_SEGMENTS) return "path over " + MAX_PATH_SEGMENTS + " segments";
  if (parts.some(isBadSegment)) return "empty, dot-leading or invalid path segment";
  return null;
}

// Runs task after every write and delete queued before it, so two of them
// never interleave on the same files or folders.
function serialize(task) {
  const run = mutations.then(task);
  mutations = run.catch(() => {});
  return run;
}

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
    if (entry.isDirectory()) {
      await listUserData(full, prefix + entry.name + "/", out);
    } else if (entry.isFile()) {
      let st;
      try {
        st = await fs.promises.stat(full);
      } catch (err) {
        if (err.code === "ENOENT") continue; // deleted since the readdir
        throw err;
      }
      out.push({ path: prefix + entry.name, size: st.size });
    }
  }
  return out;
}

// Deletes the temp files of uploads that a crash or a restart cut short.
async function removeStaleUploads(dir) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return 0;
    throw err;
  }
  let removed = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory() && !entry.name.startsWith(".")) {
      removed += await removeStaleUploads(full);
    } else if (entry.isFile() && entry.name.startsWith(".") && entry.name.endsWith(".tmp")) {
      await fs.promises.rm(full, { force: true });
      removed++;
    }
  }
  return removed;
}

// Makes a rename or unlink in dir durable. Best effort: the file data itself
// is already synced, and not every platform can fsync a folder.
async function syncDir(dir) {
  let handle;
  try {
    handle = await fs.promises.open(dir, "r");
    await handle.sync();
  } catch {
    // nothing more to do
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

// Removes dir and each parent it leaves empty, up to but not including DATA_DIR.
async function pruneEmptyDirs(dir) {
  for (; dir !== DATA_DIR && isWithin(DATA_DIR, dir); dir = path.dirname(dir)) {
    try {
      await fs.promises.rmdir(dir);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      if (err.code !== "ENOTEMPTY" && err.code !== "EEXIST") console.error("userdata prune " + dir + ": " + err.message);
      break;
    }
  }
  await syncDir(dir); // makes the unlink or rmdir just below it durable
}

// The lstat of filePath, null if there is nothing there, 409 if a parent is a file.
async function lstatUserFile(filePath) {
  try {
    return await fs.promises.lstat(filePath);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err.code === "ENOTDIR") throw httpError(409, "a parent folder is a file");
    throw err;
  }
}

// Replaces filePath with data through a synced temp file renamed over it, so
// the target always holds either the old or the new file, whole.
async function writeUserFile(filePath, data) {
  const existing = await lstatUserFile(filePath);
  if (existing && existing.isDirectory()) throw httpError(409, "the path is a folder");
  const dir = path.dirname(filePath);
  try {
    await fs.promises.mkdir(dir, { recursive: true });
  } catch (err) {
    if (err.code === "EEXIST" || err.code === "ENOTDIR") throw httpError(409, "a parent folder is a file");
    throw err;
  }
  const tmpPath = path.join(dir, "." + process.pid + "." + ++tmpCounter + ".tmp");
  let handle;
  try {
    handle = await fs.promises.open(tmpPath, "wx");
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
    await pruneEmptyDirs(dir); // folders this write created for nothing
    throw err;
  }
  await syncDir(dir);
}

// Removes filePath and then the folders that leaves empty.
async function deleteUserFile(filePath) {
  const existing = await lstatUserFile(filePath);
  if (existing && existing.isDirectory()) throw httpError(409, "the path is a folder");
  if (existing) await fs.promises.rm(filePath, { force: true });
  await pruneEmptyDirs(path.dirname(filePath));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => httpError(413, "body over " + MAX_UPLOAD + " bytes");
    // Answered before the body is read; Node discards the rest of it.
    if (Number(req.headers["content-length"]) > MAX_UPLOAD) {
      reject(tooLarge());
      return;
    }
    let chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      if (!chunks) return; // over the limit: drain the rest, keep nothing
      size += chunk.length;
      if (size <= MAX_UPLOAD) {
        chunks.push(chunk);
      } else {
        chunks = null;
        reject(tooLarge());
      }
    });
    req.on("end", () => {
      if (chunks) resolve(Buffer.concat(chunks, size));
    });
    req.on("error", reject);
    req.on("close", () => reject(new Error("upload aborted")));
  });
}

async function handleUserData(req, res, rel, remove) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, NO_STORE).end();
    return;
  }

  if (rel === "") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...NO_STORE, Allow: "GET, HEAD, OPTIONS" }).end();
      return;
    }
    const body = JSON.stringify({ files: await listUserData(DATA_DIR, "", []) });
    res.writeHead(200, { ...NO_STORE, "Content-Type": MIME[".json"], "Content-Length": Buffer.byteLength(body) });
    res.end(req.method === "HEAD" ? undefined : body);
    return;
  }

  const filePath = path.resolve(DATA_DIR, rel);
  const problem = userPathProblem(rel) || (isWithin(DATA_DIR, filePath) ? null : "path outside the store");
  if (problem) throw httpError(403, problem);

  if (req.method === "GET" || req.method === "HEAD") {
    let data;
    try {
      data = await fs.promises.readFile(filePath);
    } catch (err) {
      if (err.code !== "ENOENT" && err.code !== "EISDIR" && err.code !== "ENOTDIR") throw err;
      res.writeHead(404, { ...NO_STORE, "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, { ...NO_STORE, "Content-Type": "application/octet-stream", "Content-Length": data.length });
    res.end(req.method === "HEAD" ? undefined : data);
    return;
  }

  if (req.method === "POST") {
    if (remove) {
      await serialize(() => deleteUserFile(filePath));
    } else {
      const body = await readBody(req); // outside the queue: a slow upload holds up nobody
      await serialize(() => writeUserFile(filePath, body));
    }
    res.writeHead(204, NO_STORE).end();
    return;
  }

  res.writeHead(405, { ...NO_STORE, Allow: "GET, HEAD, POST, OPTIONS" }).end();
}

const server = http.createServer((req, res) => {
  let url, urlPath;
  try {
    // Prefixing the origin keeps a leading "//" in the path instead of taking it for a host.
    url = new URL(req.url.startsWith("/") ? "http://127.0.0.1" + req.url : req.url);
    urlPath = decodeURIComponent(url.pathname);
  } catch {
    res.writeHead(400, { ...NO_STORE, "Content-Type": "text/plain" }).end("Bad request");
    return;
  }
  if (urlPath === BASE) urlPath = "/";
  else if (urlPath.startsWith(BASE + "/")) urlPath = urlPath.slice(BASE.length);

  if (urlPath === USERDATA || urlPath.startsWith(USERDATA + "/")) {
    const remove = url.searchParams.has("delete");
    handleUserData(req, res, urlPath.slice(USERDATA.length + 1), remove).catch((err) => {
      const status = err.status || 500;
      if (req.method === "POST" || status >= 500) {
        console.error("userdata " + req.method + " " + JSON.stringify(urlPath + (remove ? "?delete" : "")) + " failed (" + status + "): " + err.message);
      }
      if (res.headersSent) res.end();
      else res.writeHead(status, { ...NO_STORE, "Content-Type": "text/plain" }).end(http.STATUS_CODES[status]);
    });
    return;
  }

  if (urlPath.endsWith("/")) urlPath += "index.html";

  // Only plain names all the way down (this also keeps NUL bytes, which make
  // fs calls throw synchronously, away from fs), and never the save store.
  const filePath = path.join(ROOT, urlPath);
  if (urlPath.slice(1).split("/").some(isBadSegment) || !isWithin(ROOT, filePath) ||
      isWithin(DATA_DIR, filePath) || isWithin(path.join(ROOT, "userdata"), filePath)) {
    res.writeHead(403, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" }).end("Forbidden");
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
    // Without a listener, a read error (file removed since the stat) would crash the server.
    fs.createReadStream(filePath).on("error", () => res.destroy()).pipe(res);
  });
});

// A store holding the app folder would let POST /userdata/ overwrite the app itself.
if (isWithin(DATA_DIR, ROOT)) {
  console.error("QUAKE2_DATA_DIR " + DATA_DIR + " must not contain the app folder " + ROOT);
  process.exit(1);
}

removeStaleUploads(DATA_DIR)
  .then((removed) => {
    if (removed) console.log("Removed " + removed + " unfinished upload(s) from " + DATA_DIR);
  }, (err) => console.error("userdata cleanup in " + DATA_DIR + ": " + err.message))
  .then(() => {
    server.listen(PORT, "127.0.0.1", () => {
      console.log(`Quake 2 static server on http://127.0.0.1:${PORT}/ (also ${BASE}/), saves in ${DATA_DIR}`);
    });
  });
