#!/usr/bin/env node
// control/server.mjs -- a small HTTP front door to control/bridge.mjs, for
// anything on the box that would rather speak HTTP than the Chrome DevTools
// Protocol (or MCP).
//
// Listens on 127.0.0.1:4233 (PORT), CORS *, and holds no state of its own: each
// request resolves the game frame afresh, so it survives the game page
// reloading under it. It never serves game files and never touches the game
// server on 4231 -- it only drives the browser that is already showing the game.
//
//   POST /control/key         {"key":"w"}  {"key":"w","down":true}  {"text":"map demo1","enter":true}
//   POST /control/mouse       {"dx":120,"dy":0}
//   POST /control/click       {"button":"left"}
//   POST /control/status      {}                     -> the game's state as JSON
//   GET  /control/screenshot.png                     -> image/png
//   OPTIONS on any of them                           -> 204 with the CORS headers
//
// Failures answer JSON: 400 for a bad request, 503 when no game is running,
// 502 when the browser cannot be reached, 500 otherwise.
//
// Zero dependencies (Node 22+ for the global WebSocket the bridge uses).
// ESM is strict by default, so no "use strict" pragma is needed.
import http from "node:http";
import { QuakeControl, ControlError, GameNotRunningError } from "./bridge.mjs";

// CONTROL_PORT, and never a bare PORT: the box sets PORT=4231 for the game
// server, and inheriting it would put this API on top of the game's port.
const PORT = Number(process.env.CONTROL_PORT || 4233);
// Big enough for any command an agent sends, small enough to bound memory.
const MAX_BODY = 64 * 1024;
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const NO_STORE = { ...CORS, "Cache-Control": "no-store" };

const game = new QuakeControl();

// The HTTP status that fits each failure the bridge can raise.
function statusOf(error) {
  if (error instanceof GameNotRunningError) return 503;
  switch (error.code) {
    case "BAD_REQUEST": return 400;
    case "CDP_UNREACHABLE":
    case "DISCONNECTED":
    case "TIMEOUT": return 502;
    default: return 500;
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { ...NO_STORE, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res, error) {
  const status = error instanceof ControlError ? statusOf(error) : 500;
  if (status >= 500) console.error("control " + error.code + ": " + error.message);
  sendJson(res, status, { error: error.message, code: error.code || "INTERNAL" });
}

// Reads a JSON body, refusing anything oversized or unparsable. An oversized
// body is drained rather than dropped on the floor, so the 400 is actually
// delivered instead of the connection just breaking (the same thing server.js
// does for /userdata); nothing over the limit is kept, so memory stays bounded.
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers["content-length"]) > MAX_BODY) {
      reject(new ControlError("body over " + MAX_BODY + " bytes", "BAD_REQUEST"));
      return;
    }
    let text = "";
    let over = false;
    req.on("data", (chunk) => {
      if (over) return;
      text += chunk;
      if (Buffer.byteLength(text) > MAX_BODY) {
        over = true;
        text = "";
      }
    });
    req.on("error", reject);
    req.on("end", () => {
      if (over) {
        reject(new ControlError("body over " + MAX_BODY + " bytes", "BAD_REQUEST"));
        return;
      }
      if (text.trim() === "") {
        resolve({});
        return;
      }
      try {
        const body = JSON.parse(text);
        if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
        resolve(body);
      } catch {
        reject(new ControlError("the body must be a JSON object", "BAD_REQUEST"));
      }
    });
  });
}

function requireString(value, what) {
  if (typeof value !== "string" || value === "") throw new ControlError(what + " must be a non-empty string", "BAD_REQUEST");
  return value;
}

async function handleKey(body) {
  // One key, held or tapped, or a whole string typed out for the console.
  if (body.text !== undefined) {
    const text = requireString(body.text, "text");
    await game.typeText(text);
    if (body.enter) await game.tap("Enter");
    return { typed: text.length, enter: !!body.enter };
  }
  const key = requireString(body.key, "key");
  // No "down" means the caller wants a tap: the common case.
  if (body.down === undefined) return game.tap(key);
  return game.key(key, !!body.down);
}

async function handleMouse(body) {
  const dx = Number(body.dx || 0);
  const dy = Number(body.dy || 0);
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new ControlError("dx and dy must be numbers", "BAD_REQUEST");
  return game.mouseMove(dx, dy);
}

async function route(req, res, pathname) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...NO_STORE, Allow: "GET, POST, OPTIONS" }).end();
    return;
  }

  if (pathname === "/control/screenshot.png") {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { ...NO_STORE, Allow: "GET, HEAD, OPTIONS" }).end();
      return;
    }
    const png = await game.screenshot();
    res.writeHead(200, { ...NO_STORE, "Content-Type": "image/png", "Content-Length": png.length });
    res.end(req.method === "HEAD" ? undefined : png);
    return;
  }

  const wantsBody = pathname === "/control/key" || pathname === "/control/mouse" || pathname === "/control/click";
  const isStatus = pathname === "/control/status";
  if (!wantsBody && !isStatus) {
    sendJson(res, 404, { error: "no such control route: " + pathname, code: "NOT_FOUND" });
    return;
  }
  // Status is read-only, so a browser (or curl) may GET it as well as POST it.
  if (isStatus && req.method === "GET") {
    sendJson(res, 200, await game.status());
    return;
  }
  if (req.method !== "POST") {
    res.writeHead(405, { ...NO_STORE, Allow: isStatus ? "GET, POST, OPTIONS" : "POST, OPTIONS" }).end();
    return;
  }

  const body = await readJsonBody(req);
  let answer;
  if (pathname === "/control/key") answer = await handleKey(body);
  else if (pathname === "/control/mouse") answer = await handleMouse(body);
  else if (pathname === "/control/click") answer = await game.click(body.button === undefined ? "left" : requireString(body.button, "button"));
  else answer = await game.status();
  sendJson(res, 200, { ok: true, ...(answer && typeof answer === "object" ? answer : { result: answer }) });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url.startsWith("/") ? "http://127.0.0.1" + req.url : req.url).pathname);
  } catch {
    sendJson(res, 400, { error: "bad request target", code: "BAD_REQUEST" });
    return;
  }
  route(req, res, pathname).catch((error) => {
    if (res.headersSent) res.end();
    else sendError(res, error);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Quake 2 control API on http://127.0.0.1:${PORT}/control/ (game frames from ${game.cdpUrl})`);
});

// A ControlError from the bridge is an answer to the caller, not a crash.
process.on("unhandledRejection", (error) => {
  console.error("control: unhandled rejection: " + (error && error.stack ? error.stack : error));
});
