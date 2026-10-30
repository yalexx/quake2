#!/usr/bin/env node
// scripts/texture-audit.mjs -- the twenty surfaces the player actually looks at,
// captured in the real game and compared against the untouched art.
//
// The review so far judged textures as tile sheets and by numbers. This script
// asks the other question: of every wall the three demo levels draw, which
// twenty get the most faces, and does each one read right standing in front of
// it? The answer is a NEW/OFF pair per entry -- NEW is r_retexturing 1 (the 4x
// pak9 art), OFF is r_retexturing 0 (the source pak0 picture) -- taken from the
// same face, the same eye and the same angles, so a defect can be attributed to
// the new art rather than to the level's lighting.
//
// 1. SELECT. Sum manifest maps[].textures[].uses per `wal` across demo1/demo2/
//    demo3, rank by that sum, break ties by name, and take the top twenty. An
//    entry the pak9 art archive has no picture for is skipped and the next one
//    taken; the audit records which and why. The manifest is keyed by the
//    texinfo's own spelling, so a few entries are case variants of a file that
//    already ranks (e1u1/FLAT1_2 against e1u1/flat1_2) and have no art of their
//    own -- those are the skips.
//
// 2. FIND THE VIEW. For each entry the largest drawn world face with that
//    texture (model 0, so trigger brushes and other inline models do not count)
//    is found in the BSP inside baseq2/pak0.pak, reading the lumps Quake 2
//    defines: planes (1), vertexes (2), texinfo (5), faces (6), edges (11),
//    surfedges (12) and models (13). SURF_SKY faces are skipped unless the entry
//    is a sky, and SURF_NODRAW faces always are -- neither is drawn. The eye is
//    placed 96-160 units off the face centroid along its normal (flipped when
//    the face's side is non-zero): straight out for a wall, offset sideways and
//    pitched 42 degrees for a floor or a ceiling, which is the only way a
//    neighbouring surface stays in frame. The eye and every sample along the
//    sight line must be in empty space (RouteMap.worldContentsAt == 0), so the
//    camera is never inside a brush and never looks through a wall. Yaw and
//    pitch are computed toward the centroid in Quake 2's own convention: yaw 0
//    is +X and grows anticlockwise, positive pitch looks down.
//
// 3. DRIVE THE OPEN CHROME TAB. The map is loaded once per (variant, map) by
//    URL, exactly as scripts/texture-fps.mjs does (+map <name> in the URL, never
//    a console `map`, which races the level load). Per entry the bridge sends
//    the single-player cheats `notarget`, `god`, `noclip` and the engine's
//    `teleport x y z`, then face(yaw), then aimPitch(), then checks position()
//    landed, waits out the console notify and captures a JPEG of the tab.
//
//    Pitch cannot go through the bridge's lookPitch(): this build ignores the
//    relative-motion mouse deltas it sends (a 400-count movement changed
//    nothing, while a 600 ms hold of ArrowLeft turned the view 89 degrees), and
//    it ignores its own keyboard look commands too (+lookup/+lookdown on a
//    letter or an arrow, with or without +klook, left the angle exactly where
//    it was). So the tool still tries the keyboard look once per view and
//    records what it achieved, but the views that need pitch are planned LEVEL:
//    a floor or a ceiling is looked at from H above (below) the plane and D
//    across it, which puts the surface about 20 degrees off the axis, in frame
//    with its neighbours. That deviation from "pitched 42 degrees" is a
//    measured limitation of this build, and audit.json says so per shot.
//
// The served build is checked before any shot is called current art: the pak9
// the URL serves must have the same sha1 as this checkout's baseq2/pak9.pak, and
// the engine must have it open at the same size. When the live app on :4231 is
// serving a different checkout the script starts a scratch server for THIS
// checkout on a free port (never :4231 or :4233) and records both identities, so
// the shots still show the art in the tree being reviewed.
//
// Every shot carries a hard renderer check: WebGL2, an ANGLE unmasked renderer,
// vid_renderer gles3 and a 1366x768 drawing buffer. The hi-res pak9 art only
// appears through ref_gles3, and a shot from the software renderer would be
// evidence of nothing.
//
//   node scripts/texture-audit.mjs --select          # the plan, no Chrome
//   node scripts/texture-audit.mjs                   # all twenty, NEW and OFF
//   node scripts/texture-audit.mjs --only sky1 --report /tmp/one.json
//
// Output: docs/texture-review/ingame/audit/<NN>-<name>-NEW.jpg and -OFF.jpg,
// plus audit.json carrying the per-map uses, the face, the camera, the exact
// teleport, the renderer and the load average. Exit 0 when every selected entry
// has both shots and every check held; 1 when the tab could not be driven or a
// check failed.
"use strict";

import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadMap, readBspHeader, readPakDirectory } from "../control/route.mjs";
import { QuakeControl } from "../control/bridge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MANIFEST = path.join(ROOT, "assets", "textures", "manifest.json");
const PAK0 = path.join(ROOT, "baseq2", "pak0.pak");
const PAK9 = path.join(ROOT, "baseq2", "pak9.pak");
const OUT_DIR = path.join(ROOT, "docs", "texture-review", "ingame", "audit");
const LIVE = "http://127.0.0.1:4231";
const CDP = "http://127.0.0.1:9222";
const BANNED_PORTS = new Set([4231, 4233]);
const TARGET_W = 1366, TARGET_H = 768;
const NOTIFY_FADE_MS = 4500; // Q2's con_notifytime is 3 s; the shot waits it out
const JPEG_QUALITY = 85;
const TOP_N = 20;
// Pitch: the engine's own keyboard look, held from here. `q` and `e` are spare
// keys on this build (q is unbound, e is not a movement or weapon key), and
// cl_pitchspeed is raised from 150 because the measured keyboard pitch rate at
// the default is about a degree a second -- 42 degrees would take half a
// minute per view.
const PITCH_UP_KEY = "q";
const PITCH_DOWN_KEY = "e";
const PITCH_SPEED = 2400;
const PITCH_TOLERANCE = 2.5;
const PITCH_HOLD_MS = { min: 120, max: 900, perDegree: 60, budget: 25000, maxSteps: 40 };
const MAP_ORDER = ["demo1", "demo2", "demo3"];

// Quake 2's lump numbers and record sizes (qfiles.h). The audit reads exactly
// what it needs to reconstruct a face: its plane, its vertices, its texinfo and
// which of those faces belong to the world (model 0) rather than to a brush
// entity's inline model.
const L_PLANES = 1, L_VERTEXES = 2, L_TEXINFO = 5, L_FACES = 6, L_EDGES = 11, L_SURFEDGES = 12, L_MODELS = 13;
const PLANE_BYTES = 20, VERTEX_BYTES = 12, TEXINFO_BYTES = 76, FACE_BYTES = 20, EDGE_BYTES = 4, MODEL_BYTES = 48;
const SURF_SKY = 0x4, SURF_NODRAW = 0x80;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line) => process.stdout.write(line + "\n");
const ok = (what) => log("  ok    " + what);
const note = (what) => log("  note  " + what);
const step = (what) => log("\n== " + what);
const round = (n, digits = 1) => (n === null || n === undefined || Number.isNaN(n) ? null : Number(n.toFixed(digits)));
const vec = (v) => ({ x: round(v.x, 2), y: round(v.y, 2), z: round(v.z, 2) });

// ---- 1. Selection ---------------------------------------------------------

// Every texture the three levels' texinfos name, with the faces each map draws
// with it. `uses` is the manifest's own face count; the sum across the maps is
// the ranking. Ties are broken by name so the list is stable run to run.
function tallyUses(manifest) {
  const rows = new Map();
  for (const key of Object.keys(manifest.maps)) {
    const map = manifest.maps[key];
    const short = String(map.name || "").replace(/^maps\//, "").replace(/\.bsp$/, "");
    if (!short) continue;
    for (const tex of map.textures || []) {
      if (!tex.wal) continue;
      let row = rows.get(tex.wal);
      if (!row) {
        row = { name: tex.name, wal: tex.wal, uses: Object.fromEntries(MAP_ORDER.map((m) => [m, 0])), total: 0 };
        rows.set(tex.wal, row);
      }
      const used = Number(tex.uses) || 0;
      row.uses[short] = (row.uses[short] || 0) + used;
      row.total += used;
    }
  }
  return [...rows.values()]
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
    .map((row, index) => ({ ...row, rank: index + 1 }));
}

// The entries the pak9 art archive actually holds pictures for. Its names come
// from manifest.entries[], which is the list of files in the pristine pak0 --
// so an uppercase texinfo spelling such as `e1u1/FLAT1_2` is not here even
// though the lowercase file it resolves to is. Such an entry has no art of its
// own and is skipped rather than auditing its twin twice.
function artNames(manifest, pak9) {
  const entries = new Set(manifest.entries.map((entry) => entry.name));
  return (wal) => {
    if (!entries.has(wal)) return { has: false, why: "the pak holds no " + wal + " (a case-variant texinfo spelling), so the 4x pass drew no picture for it" };
    const png = wal.replace(/\.wal$/i, ".png");
    if (!pak9.has(png.toLowerCase())) return { has: false, why: "pak9 holds no " + png };
    return { has: true };
  };
}

function mostUsedMap(uses) {
  return MAP_ORDER.slice().sort((a, b) => (uses[b] || 0) - (uses[a] || 0) || a.localeCompare(b))[0];
}

function selectEntries(manifest, pak9) {
  const haveArt = artNames(manifest, pak9);
  const rows = tallyUses(manifest);
  const withArt = [], skipped = [];
  for (const row of rows) {
    const art = haveArt(row.wal);
    if (art.has) withArt.push(row);
    else skipped.push({ name: row.name, wal: row.wal, rank: row.rank, uses: row.uses, total: row.total, why: art.why });
  }
  return { withArt, skipped, considered: rows.length };
}

// ---- 2. The BSP: the largest drawn world face with one texture -----------

function readLumps(bsp) {
  const { lumps } = readBspHeader(bsp);
  const need = [L_PLANES, L_VERTEXES, L_TEXINFO, L_FACES, L_EDGES, L_SURFEDGES, L_MODELS];
  for (const index of need) {
    if (!lumps[index] || lumps[index].length <= 0) throw new Error("BSP lump " + index + " is empty; the face cannot be read");
  }
  return lumps;
}

const texinfoName = (bsp, lumps, index) => {
  const at = lumps[L_TEXINFO].offset + index * TEXINFO_BYTES;
  return bsp.toString("latin1", at + 40, at + 72).replace(/\0.*$/, "").trim();
};

const texinfoFlags = (bsp, lumps, index) => bsp.readInt32LE(lumps[L_TEXINFO].offset + index * TEXINFO_BYTES + 32);

function worldFaceRange(bsp, lumps) {
  const at = lumps[L_MODELS].offset; // model 0, the world
  return { first: bsp.readInt32LE(at + 40), count: bsp.readInt32LE(at + 44) };
}

// A face's polygon: its edges are surfedges; a negative surfedge means take the
// edge's second vertex instead of its first.
function faceVertices(bsp, lumps, faceIndex) {
  const at = lumps[L_FACES].offset + faceIndex * FACE_BYTES;
  const firstedge = bsp.readInt32LE(at + 4);
  const numedges = bsp.readInt16LE(at + 8);
  const points = [];
  for (let i = 0; i < numedges; i++) {
    const se = bsp.readInt32LE(lumps[L_SURFEDGES].offset + (firstedge + i) * 4);
    const edgeAt = lumps[L_EDGES].offset + Math.abs(se) * EDGE_BYTES;
    const vertexIndex = se >= 0 ? bsp.readUInt16LE(edgeAt) : bsp.readUInt16LE(edgeAt + 2);
    const at3 = lumps[L_VERTEXES].offset + vertexIndex * VERTEX_BYTES;
    points.push({ x: bsp.readFloatLE(at3), y: bsp.readFloatLE(at3 + 4), z: bsp.readFloatLE(at3 + 8) });
  }
  return { points, firstedge, numedges };
}

// Newell's normal gives an area and a normal for an arbitrary polygon; the plane
// stays authoritative for where the face points, because a warped face has no
// single normal and Newell would be an average of it.
function polygonMetrics(points) {
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const area = Math.hypot(nx, ny, nz) / 2;
  const centroid = points.reduce((sum, p) => ({ x: sum.x + p.x, y: sum.y + p.y, z: sum.z + p.z }), { x: 0, y: 0, z: 0 });
  const n = points.length || 1;
  return { area, centroid: { x: centroid.x / n, y: centroid.y / n, z: centroid.z / n } };
}

function faceRecord(bsp, lumps, index) {
  const at = lumps[L_FACES].offset + index * FACE_BYTES;
  const plane = bsp.readUInt16LE(at);
  const side = bsp.readInt16LE(at + 2);
  const texinfo = bsp.readInt16LE(at + 10);
  const planeAt = lumps[L_PLANES].offset + plane * PLANE_BYTES;
  let normal = { x: bsp.readFloatLE(planeAt), y: bsp.readFloatLE(planeAt + 4), z: bsp.readFloatLE(planeAt + 8) };
  if (side !== 0) normal = { x: -normal.x, y: -normal.y, z: -normal.z };
  const flags = texinfo << 0;
  return {
    index, plane, side, texinfo, normal, flags: texinfoFlags(bsp, lumps, texinfo),
    texture: texinfoName(bsp, lumps, texinfo),
    distance: bsp.readFloatLE(planeAt + 12),
    _texinfo: flags,
  };
}

function largestFace(map, entryName) {
  const bsp = map.bsp;
  const lumps = readLumps(bsp);
  const range = worldFaceRange(bsp, lumps);
  if (range.first < 0 || range.count < 0) throw new Error("the world model has no face range");
  const wanted = entryName.toLowerCase();
  const isSky = /(^|\/)sky[0-9_]/i.test(entryName) || /(^|\/)sky\d/i.test(entryName);
  const candidates = [];
  for (let i = range.first; i < range.first + range.count; i++) {
    const face = faceRecord(bsp, lumps, i);
    if (face.texture.toLowerCase() !== wanted) continue;
    if (face.flags & SURF_NODRAW) continue;
    if ((face.flags & SURF_SKY) && !isSky) continue;
    const { points, firstedge, numedges } = faceVertices(bsp, lumps, i);
    if (points.length < 3) continue;
    const { area, centroid } = polygonMetrics(points);
    if (!(area > 0)) continue;
    candidates.push({ ...face, points, firstedge, numedges, area, centroid, isSky });
  }
  candidates.sort((a, b) => b.area - a.area || a.index - b.index);
  return { candidates: candidates.slice(0, 40), scanned: range.count, isSky };
}

// Points along the segment from a to b, every `stepUnits`, both ends included.
function sampleLine(a, b, stepUnits = 8) {
  const length = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
  const n = Math.max(2, Math.ceil(length / stepUnits));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t });
  }
  return out;
}

// The view for one face. A wall is looked at square on from 96-160 units out
// along its normal. A floor or a ceiling is looked at from above/below and to
// one side, pitched 42 degrees, so the surface and its neighbours share the
// frame -- looking straight down at a floor shows one texture and nothing to
// compare it against, which is exactly what an in-level audit is for.
function placeCamera(map, face) {
  const n = face.normal;
  const centroid = face.centroid;
  const empty = (p) => map.worldContentsAt(p.x, p.y, p.z) === 0;
  const losClear = (eye) => sampleLine(eye, centroid, 8).slice(1, -2).every(empty);
  const upright = Math.abs(n.z) > 0.7;
  const axisX = { x: 1, y: 0, z: 0 }, axisY = { x: 0, y: 1, z: 0 };
  const side = Math.hypot(n.x, n.y) > 1e-3 ? { x: -n.y / Math.hypot(n.x, n.y), y: n.x / Math.hypot(n.x, n.y), z: 0 } : axisX;
  const tries = [];
  if (!upright) {
    for (const d of [128, 112, 144, 96, 160]) {
      for (const sideways of [0, 48, -48, 88, -88]) {
        const eye = { x: centroid.x + n.x * d + side.x * sideways, y: centroid.y + n.y * d + side.y * sideways, z: centroid.z + n.z * d + side.z * sideways };
        if (Math.hypot(eye.x - centroid.x, eye.y - centroid.y, eye.z - centroid.z) > 160) continue;
        tries.push({ kind: "wall", eye, distance: d });
      }
    }
  } else {
    // A floor or a ceiling is looked at with a LEVEL view on this build: its
    // keyboard pitch input does not move the view (see aimPitch), so the eye is
    // stood back across the plane by D and held H above it (below it, for a
    // ceiling). The surface then sits about atan(H/D) -- 20 degrees or so --
    // below (above) the view axis: in frame, with the room and its neighbours
    // around it, which is what an in-level audit is for.
    const sign = n.z > 0 ? 1 : -1;
    const dirs = [side, axisX, { x: -1, y: 0, z: 0 }, axisY, { x: 0, y: -1, z: 0 },
      { x: Math.SQRT1_2, y: Math.SQRT1_2, z: 0 }, { x: -Math.SQRT1_2, y: Math.SQRT1_2, z: 0 },
      { x: Math.SQRT1_2, y: -Math.SQRT1_2, z: 0 }, { x: -Math.SQRT1_2, y: -Math.SQRT1_2, z: 0 }];
    for (const H of [56, 64, 48, 72, 40]) {
      for (const D of [150, 140, 160, 120, 180]) {
        for (const dir of dirs) {
          const eye = { x: centroid.x + dir.x * D, y: centroid.y + dir.y * D, z: centroid.z + sign * H };
          if (Math.hypot(D, H) > 160.5) continue;
          tries.push({ kind: sign > 0 ? "floor" : "ceiling", eye, distance: D, pitchDeg: 0 });
        }
      }
    }
  }
  for (const attempt of tries) {
    if (!empty(attempt.eye)) continue;
    if (!losClear(attempt.eye)) continue;
    const dx = centroid.x - attempt.eye.x, dy = centroid.y - attempt.eye.y, dz = centroid.z - attempt.eye.z;
    const yaw = (Math.atan2(dy, dx) * 180) / Math.PI;
    // level for a floor or a ceiling (the surface is below/above the axis); a
    // wall is aimed at its centroid, which is what the eye was placed for
    const pitch = attempt.kind === "wall"
      ? (Math.asin(Math.max(-1, Math.min(1, -dz / Math.hypot(dx, dy, dz)))) * 180) / Math.PI
      : 0;
    return {
      origin: attempt.eye, yaw: round(yaw, 2), pitch: round(pitch, 2), kind: attempt.kind,
      distance: round(Math.hypot(dx, dy, dz), 1), attempts: tries.length,
    };
  }
  return null;
}

// ---- Tiny raw CDP session (the bridge owns the game; this is navigation and
// the screenshot, which it does not offer) --------------------------------
class RawCdp {
  constructor(url) { this.url = url; this.nextId = 1; this.calls = new Map(); this.handlers = new Set(); this.closed = null; }

  async open() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("CDP WebSocket error")), { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id === undefined) return [...this.handlers].forEach((handler) => handler(message));
      const call = this.calls.get(message.id);
      if (!call) return;
      this.calls.delete(message.id);
      clearTimeout(call.timer);
      message.error ? call.reject(new Error(call.method + ": " + message.error.message)) : call.resolve(message.result);
    });
    this.ws.addEventListener("close", () => {
      this.closed = new Error("the CDP socket closed");
      for (const call of this.calls.values()) { clearTimeout(call.timer); call.reject(this.closed); }
      this.calls.clear();
    });
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new Error(method + ": no answer in " + timeoutMs / 1000 + " s")); }, timeoutMs);
      this.calls.set(id, { method, resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  waitFor(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const handler = (message) => { if (message.method !== method) return; clearTimeout(timer); this.handlers.delete(handler); resolve(message.params); };
      const timer = setTimeout(() => { this.handlers.delete(handler); reject(new Error(method + " did not arrive")); }, timeoutMs);
      this.handlers.add(handler);
    });
  }

  close() { try { this.ws.close(); } catch { /* already gone */ } }
}

async function pageEval(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "page exception");
  return result.result.value;
}

async function navigate(cdp, url) {
  const loaded = cdp.waitFor("Page.loadEventFired", 120000).catch(() => null);
  await cdp.send("Page.navigate", { url }, 60000);
  await loaded;
}

async function waitBoot(cdp, label, timeoutMs = 180000) {
  const started = Date.now();
  let seen = null;
  while (Date.now() - started < timeoutMs) {
    try {
      seen = await pageEval(cdp, `(() => { const c = document.getElementById("canvas");
        return { display: c && c.style.display, fs: typeof FS, gl: typeof GLctx,
          running: !!(window.quake2Engine && window.quake2Engine.read().ok) }; })()`);
      if (seen.display === "block" && seen.fs === "object" && (seen.running || seen.gl === "object")) return seen;
    } catch { /* context torn down mid-reload */ }
    await sleep(1500);
  }
  throw new Error(label + ": the engine did not boot in " + timeoutMs / 1000 + " s (" + JSON.stringify(seen) + ")");
}

async function pageTarget() {
  let list;
  try {
    const response = await fetch(CDP + "/json/list", { signal: AbortSignal.timeout(5000) });
    list = await response.json();
  } catch (error) {
    throw new Error("cannot reach the browser at " + CDP + " (" + error.message + "). Is the ClawBox browser running?");
  }
  const pages = (Array.isArray(list) ? list : []).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
  const game = pages.find((t) => t.url && t.url.includes("127.0.0.1:4231"));
  if (game) return game;
  if (pages.length === 1) return pages[0];
  const seen = pages.map((t) => t.url).join("\n  ");
  throw new Error("no game tab on the CDP endpoint (looked for 127.0.0.1:4231; saw " + pages.length + " page(s)):\n  " + seen);
}

// ---- Identity of what is being served ------------------------------------
async function servedIdentity(base) {
  const out = {};
  for (const name of ["pak0.pak", "pak9.pak"]) {
    try {
      const response = await fetch(base + "/baseq2/" + name, { signal: AbortSignal.timeout(120000) });
      const bytes = Buffer.from(await response.arrayBuffer());
      out[name] = {
        status: response.status, bytes: bytes.length,
        sha1: response.ok ? crypto.createHash("sha1").update(bytes).digest("hex") : null,
      };
    } catch (error) {
      out[name] = { status: null, error: error.message };
    }
  }
  return out;
}

function fileIdentity(file) {
  const bytes = fs.readFileSync(file);
  return { bytes: bytes.length, sha1: crypto.createHash("sha1").update(bytes).digest("hex") };
}

// ---- A scratch server for THIS checkout ----------------------------------
function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function startServer() {
  const port = await pickPort();
  if (BANNED_PORTS.has(port)) throw new Error("picked a banned port " + port);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "texture-audit-data-"));
  const child = spawn(process.execPath, [path.join(ROOT, "server.js")], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), QUAKE2_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"],
  });
  const started = await new Promise((resolve) => {
    let settled = false, out = "";
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish({ error: new Error("server.js did not listen in 20 s") }), 20000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; if (out.includes(":" + port + "/")) finish({ child, port, dataDir }); });
    child.once("error", (error) => finish({ error }));
    child.once("exit", (code) => finish({ error: new Error("server.js exited (" + code + ")") }));
  });
  if (started.error) { child.kill("SIGKILL"); throw started.error; }
  return started;
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", resolve);
    child.kill("SIGTERM");
    setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 3000).unref();
  });
}

// ---- In-page expressions --------------------------------------------------
const RENDERER = `(() => {
  const canvas = document.getElementById("canvas");
  if (typeof GLctx === "undefined" || !GLctx) {
    return { error: "GLctx is not defined (the engine exposes no WebGL context)", webgl2: false };
  }
  const ext = GLctx.getExtension("WEBGL_debug_renderer_info");
  return { webgl2: GLctx instanceof WebGL2RenderingContext,
    vendor: ext && GLctx.getParameter(ext.UNMASKED_VENDOR_WEBGL),
    renderer: ext && GLctx.getParameter(ext.UNMASKED_RENDERER_WEBGL),
    glVersion: GLctx.getParameter(GLctx.VERSION),
    drawingBuffer: [canvas.width, canvas.height], inner: [innerWidth, innerHeight] };
})()`;
const PAK9_SIZE = `(() => { try { return FS.stat("/baseq2/pak9.pak").size; } catch (error) { return -1; } })()`;

function checkRenderer(label, renderer, vidRenderer) {
  const problems = [];
  if (!renderer || renderer.error) problems.push(renderer && renderer.error ? renderer.error : "the renderer could not be read");
  else {
    if (renderer.webgl2 !== true) problems.push("GLctx is not a WebGL2RenderingContext");
    if (!/ANGLE/.test(String(renderer.renderer || ""))) problems.push("the unmasked renderer does not contain ANGLE (got " + JSON.stringify(renderer.renderer) + ")");
    if (!Array.isArray(renderer.drawingBuffer) || renderer.drawingBuffer[0] !== TARGET_W || renderer.drawingBuffer[1] !== TARGET_H) {
      problems.push("the canvas drawing buffer is " + (renderer.drawingBuffer ? renderer.drawingBuffer.join("x") : "unknown") + ", not " + TARGET_W + "x" + TARGET_H);
    }
  }
  if (vidRenderer !== "gles3") problems.push("vid_renderer reads " + JSON.stringify(vidRenderer) + ", not \"gles3\"");
  if (problems.length) {
    throw new Error("renderer check failed (" + label + "): " + problems.join("; ") +
      ". The hi-res pak9 is only drawn by ref_gles3 on WebGL2; this run will not fall back to the software renderer.");
  }
}

async function readCvar(control, name) {
  const answer = await control.command(name, { tail: 4 });
  const line = answer.output.map((one) => /"([^"]+)"\s+is\s+"([^"]*)"/.exec(one)).find(Boolean);
  return line ? line[2] : null;
}

async function readCvarDurable(box, cdpUrl, name, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let got = null;
    try { got = await readCvar(box.control, name); } catch { /* console missed */ }
    if (got !== null) return got;
    note("read " + name + " missed (attempt " + (attempt + 1) + "); reconnecting the bridge");
    await box.control.close().catch(() => {});
    box.control = new QuakeControl({ cdpUrl, gameUrlMark: box.mark });
    await sleep(1200);
  }
  return null;
}

function buildUrl(base, map, tokens) {
  return base.replace(/\/$/, "") + "/?" + ["+map", map, "+set", "cl_gun", "0", "+set", "crosshair", "0"].concat(tokens || []).join("&");
}

async function waitForMapName(box, cdpUrl, map, timeoutMs = 90000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try { last = await readCvar(box.control, "mapname"); } catch { last = null; }
    if (last === map) return last;
    await sleep(1500);
  }
  throw new Error("map " + map + " never became active (mapname " + JSON.stringify(last) + ")");
}

async function ensureCheats(box) {
  let cheats = await readCvarDurable(box, CDP, "cheats");
  if (cheats === "1") return { cheats, via: "already 1" };
  await box.control.command("cheats 1", { tail: 4 }).catch(() => {});
  cheats = await readCvarDurable(box, CDP, "cheats", 2);
  return { cheats, via: "console" };
}

// ---- The capture ---------------------------------------------------------
// The player's view origin, read the cheap way first: engine-state.js answers
// straight out of the wasm heap with no console. A page that has no engine-state
// hook (the live app served from a checkout older than this one) is asked on its
// console instead with `viewpos`, which costs a round trip but always answers.
async function readView(control) {
  let direct = null;
  try { direct = await control.position(); } catch { direct = null; }
  if (direct && direct.position) return { position: direct.position, angles: direct.angles, source: "wasm-memory" };
  const viaConsole = await control.position({ console: true }).catch(() => null);
  if (viaConsole && viaConsole.position) return { position: viaConsole.position, angles: viaConsole.angles, source: "console" };
  return { position: null, angles: null, source: "none" };
}

const teleportCommand = (at) => "teleport " + [at.x, at.y, at.z].map((value) => Math.round(value)).join(" ");

// Pitch, closed-loop on the engine's keyboard look. The two keys are bound
// once per page (the binding lives in the running engine, not in the URL), the
// key is held for a time estimated from the last step's measured degrees per
// millisecond, and the angle is read straight back out of the engine between
// holds -- never with a console probe, which clears the key states and would
// stop the movement it is about to measure.
//
// On this build the keyboard look moves nothing: a key bound to +lookup or
// +lookdown, held 0.9 s, on a letter or on an arrow, with or without +klook,
// leaves the angle exactly where it was, while the same keys bound to
// +left/+right turn the yaw 89 degrees in 0.6 s. The bridge's mouse turns
// nothing either. So the loop tries once, records what it achieved, and the
// views that need pitch are planned level in the first place (see
// placeCamera); a pitched view reached this way is kept, a declined one is
// reported honestly in audit.json.
async function aimPitch(context, targetPitch) {
  const { box } = context;
  const control = box.control;
  if (!context.pitchReady) {
    const answer = await control.command([
      "bind " + PITCH_UP_KEY + " +lookup",
      "bind " + PITCH_DOWN_KEY + " +lookdown",
      "cl_pitchspeed " + PITCH_SPEED,
    ], { tail: 6 }).catch(() => null);
    context.pitchReady = true;
    context.pitchBinds = answer ? answer.output.filter((line) => /bind|pitchspeed/.test(line)).slice(0, 4) : null;
  }
  let view = await readView(control);
  let pitch = view.angles ? view.angles.pitch : null;
  const start = pitch;
  let steps = 0;
  const attempts = [];
  const deadline = Date.now() + PITCH_HOLD_MS.budget;
  while (pitch !== null && Math.abs(targetPitch - pitch) > PITCH_TOLERANCE && Date.now() < deadline && steps < PITCH_HOLD_MS.maxSteps) {
    const delta = targetPitch - pitch;
    const key = delta < 0 ? PITCH_UP_KEY : PITCH_DOWN_KEY; // positive pitch looks down
    const perDegree = context.pitchMsPerDegree || PITCH_HOLD_MS.perDegree;
    const holdMs = Math.round(Math.max(PITCH_HOLD_MS.min, Math.min(PITCH_HOLD_MS.max, Math.abs(delta) * perDegree)));
    await control.hold([key]);
    await sleep(holdMs);
    await control.hold([]);
    await sleep(140);
    const before = pitch;
    view = await readView(control);
    pitch = view.angles ? view.angles.pitch : null;
    steps += 1;
    if (pitch !== null && Math.abs(pitch - before) > 0.15) {
      context.pitchMsPerDegree = holdMs / Math.abs(pitch - before);
    } else {
      attempts.push({ key, holdMs, moved: false });
      break; // the keys do not move this build's pitch; stop spending the budget on them
    }
  }
  const reached = pitch !== null && Math.abs(targetPitch - pitch) <= PITCH_TOLERANCE;
  return {
    view, start: round(start, 2), pitch: round(pitch, 2), steps, reached,
    msPerDegree: context.pitchMsPerDegree ? round(context.pitchMsPerDegree, 1) : null,
    binds: context.pitchBinds,
  };
}

async function captureEntry(context, entry, variant) {
  const { box, cdp, outDir, mapName } = context;
  const control = box.control;
  const camera = entry.view.camera;
  // The cheat sets the player's origin; the camera looks from the player's eye,
  // which on this build sits 32 units above it (`teleport z=0` then `viewpos`
  // reads z 32). So the teleport is aimed low by whatever the engine reports as
  // the offset, measured from this same teleport rather than assumed, and the
  // eye is then checked against the planned camera instead of the origin.
  let teleport = teleportCommand(camera.origin);
  let commands = ["notarget", "god", "noclip", teleport];
  const answer = await control.command(commands, { tail: 10 });
  if (!answer.echoFound) throw new Error("the console did not echo the cheat block (" + (answer.reason || "no answer") + "): " + JSON.stringify(answer.output.slice(0, 6)));
  const refused = answer.output.filter((line) => /not enabled|cheat/i.test(line));
  await sleep(700);
  let view = await readView(control);
  let offset = null, corrected = null;
  if (view.position) {
    offset = { x: view.position.x - camera.origin.x, y: view.position.y - camera.origin.y, z: view.position.z - camera.origin.z };
    if (Math.hypot(offset.x, offset.y, offset.z) > 2) {
      const aim = { x: camera.origin.x - offset.x, y: camera.origin.y - offset.y, z: camera.origin.z - offset.z };
      corrected = teleportCommand(aim);
      await control.command(corrected, { tail: 3 }).catch(() => {});
      await sleep(600);
      view = await readView(control);
      teleport = corrected;
    }
  }
  // Aim: yaw closed-loop through the bridge's face() (arrow keys), pitch on the
  // engine's keyboard look (see aimPitch) -- the mouse turns neither here.
  const facing = await control.face(camera.yaw, { rounds: 6 });
  const pitchAim = await aimPitch(context, camera.pitch);
  view = pitchAim.view || view;
  // A shot with the developer console half-drawn over the level is not a
  // picture of the level. The page's hook reports cls.key_dest (0 in game, 1
  // console), and the bridge's Escape is rebuilt inside the page -- Chromium
  // keeps a trusted one -- so it shuts the console exactly as the key does.
  let consoleShut = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const dest = await control.evaluate("(function () { try { var r = quake2Engine.read(); return r && r.ok ? r.keyDest : null; } catch (e) { return null; } })()").catch(() => null);
    consoleShut = dest;
    if (dest === null || dest === 0) break;
    await control.tap("Escape").catch(() => {});
    await sleep(450);
  }
  const origin = view.position;
  const landedOk = !!(origin && Math.hypot(origin.x - camera.origin.x, origin.y - camera.origin.y, origin.z - camera.origin.z) <= 8);
  const anglesOk = !!(view.angles && Math.abs(((view.angles.yaw - camera.yaw + 540) % 360) - 180) <= 8 && Math.abs(view.angles.pitch - camera.pitch) <= 8);
  await sleep(NOTIFY_FADE_MS);
  const shot = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: JPEG_QUALITY }, 60000);
  const buffer = Buffer.from(shot.data, "base64");
  const name = String(entry.index).padStart(2, "0") + "-" + entry.name.replace(/\//g, "_");
  const file = path.join(outDir, name + "-" + variant + ".jpg");
  fs.writeFileSync(file, buffer);
  const rel = path.relative(ROOT, file).split(path.sep).join("/");
  ok(entry.name + " " + variant + "  " + rel + "  " + (buffer.length / 1024).toFixed(0) + " KB" +
    (landedOk && anglesOk && facing.facing ? "" : "  (eye " + (landedOk ? "ok" : "DRIFTED") + ", angles " + (anglesOk ? "ok" : "DRIFTED") + ", face " + (facing.facing ? "ok" : "NOT CONVERGED") + ")"));
  if (refused.length) note("the engine printed " + JSON.stringify(refused[0]));
  return {
    variant, map: mapName, url: context.url,
    file: rel, bytes: buffer.length,
    teleport, teleportFirst: teleportCommand(camera.origin), teleportOffset: offset ? vec(offset) : null,
    commandsRan: answer.echoFound ? commands : [], echoFound: answer.echoFound, refused: refused.slice(0, 3),
    viewSource: view.source, keyDest: consoleShut, positionAfter: origin ? vec(origin) : null,
    anglesAfter: view.angles ? { yaw: round(view.angles.yaw, 2), pitch: round(view.angles.pitch, 2) } : null,
    landed: !!(landedOk && anglesOk),
    facing: { ok: !!facing.facing, residual: facing.error === undefined ? null : round(facing.error, 2), rounds: facing.rounds, method: facing.method || null },
    pitchTarget: camera.pitch, pitchAfter: pitchAim.pitch,
    pitchDriver: { reached: pitchAim.reached, keys: PITCH_UP_KEY + "/" + PITCH_DOWN_KEY, cl_pitchspeed: PITCH_SPEED, steps: pitchAim.steps, from: pitchAim.start, binds: pitchAim.binds },
    renderer: context.renderer,
  };
}

// ---- main ---------------------------------------------------------------
function parseOptions(argv) {
  const options = { out: OUT_DIR, base: LIVE, cdp: CDP, only: [], report: null, select: false, limit: null, variant: null };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => argv[++i];
    if (flag === "--out") options.out = path.resolve(value());
    else if (flag === "--base") options.base = value();
    else if (flag === "--cdp") options.cdp = value();
    else if (flag === "--only") options.only.push(value().toLowerCase());
    else if (flag === "--report") options.report = path.resolve(value());
    else if (flag === "--limit") options.limit = Number(value());
    else if (flag === "--variant") options.variant = value().toUpperCase();
    else if (flag === "--select") options.select = true;
    else if (flag === "--help" || flag === "-h") { log("usage: node scripts/texture-audit.mjs [--select] [--only <text>] [--limit n] [--variant NEW|OFF] [--out dir] [--report file] [--base url] [--cdp url]"); process.exit(0); }
    else throw new Error("unknown flag " + flag);
  }
  return options;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const pak9 = readPakDirectory(fs.readFileSync(PAK9));
  const selection = selectEntries(manifest, pak9);
  const maps = {};
  for (const mapName of MAP_ORDER) maps[mapName] = await loadMap(mapName, { pak: PAK0 });

  // The view for one ranked entry: the largest drawn world face with its
  // texture, in the map that draws the most of it -- and, when that map only
  // draws it on an inline brush-entity model (a func_wall or a trigger volume,
  // never model 0), in the next map that does draw it on the world. A texture
  // that is only ever drawn on an invisible trigger brush has no view at all
  // and is skipped rather than shot into a wall.
  const planEntry = (row) => {
    const byUse = MAP_ORDER.slice().sort((a, b) => (row.uses[b] || 0) - (row.uses[a] || 0) || a.localeCompare(b));
    const tried = [];
    for (const mapName of byUse) {
      if (!(row.uses[mapName] > 0)) continue;
      const found = largestFace(maps[mapName], row.name);
      tried.push({ map: mapName, worldFaces: found.candidates.length, worldScan: found.scanned });
      for (const candidate of found.candidates) {
        const camera = placeCamera(maps[mapName], candidate);
        if (camera) {
          return {
            view: {
              map: mapName, face: candidate, camera,
              scan: { worldFaces: found.scanned, matching: found.candidates.length, isSky: found.isSky },
            },
            tried,
          };
        }
      }
    }
    return { view: null, tried };
  };
  const noViewWhy = (row, tried) => {
    const drawn = tried.reduce((sum, one) => sum + one.worldFaces, 0);
    if (!drawn) {
      return "not drawn on a world face in " + tried.map((one) => one.map).join("/") +
        " (its faces are on inline brush-entity models only -- trigger volumes and the like -- or it has none)";
    }
    return drawn + " drawn world face(s) across " + tried.map((one) => one.map + " " + one.worldFaces).join(", ") +
      ", none with an empty camera position and a clear sight line";
  };

  const entries = [];
  const skippedView = [];
  for (const row of selection.withArt) {
    if (entries.length === TOP_N) break;
    const plan = planEntry(row);
    if (!plan.view) { skippedView.push({ ...row, why: noViewWhy(row, plan.tried), tried: plan.tried }); continue; }
    const mostUsed = mostUsedMap(row.uses);
    entries.push({
      ...row, index: entries.length + 1, view: plan.view, tried: plan.tried,
      mapNote: plan.view.map === mostUsed ? null
        : "most uses are in " + mostUsed + ", which draws it only on inline brush-entity models; captured in " + plan.view.map,
    });
  }
  const wanted = options.only.length ? entries.filter((e) => options.only.some((text) => e.name.toLowerCase().includes(text) || e.wal.toLowerCase().includes(text))) : entries;
  if (options.limit) wanted.length = Math.min(wanted.length, options.limit);
  if (!wanted.length) throw new Error("no selected entry matches " + JSON.stringify(options.only));

  step("Select the most-drawn textures");
  log("  " + selection.considered + " texinfo wals across " + MAP_ORDER.join(", ") + "; " + entries.length + " entries with pak9 art and a drawable world face");
  for (const entry of entries) {
    log("  " + String(entry.index).padStart(2) + "  " + entry.name.padEnd(24) + " rank " + String(entry.rank).padStart(2) + "  faces " + String(entry.total).padStart(5) +
      "  (" + MAP_ORDER.map((m) => m + " " + entry.uses[m]).join(", ") + ")  -> " + entry.view.map + (entry.mapNote ? "  [" + entry.mapNote + "]" : ""));
  }
  for (const skip of selection.skipped) {
    log("  --  " + skip.name.padEnd(24) + " rank " + String(skip.rank).padStart(2) + "  faces " + String(skip.total).padStart(5) + "  SKIPPED: " + skip.why);
  }
  for (const skip of skippedView) {
    log("  --  " + skip.name.padEnd(24) + " rank " + String(skip.rank).padStart(2) + "  faces " + String(skip.total).padStart(5) + "  SKIPPED: " + skip.why);
  }

  step("The face and the camera in the BSP");
  for (const entry of entries) {
    const { face, camera, map } = entry.view;
    log("  " + entry.index + "  " + entry.name.padEnd(24) + " " + map + "  face #" + face.index + "  " + face.area.toFixed(0) + " u^2  " +
      camera.kind + "  eye (" + [camera.origin.x, camera.origin.y, camera.origin.z].map((v) => Math.round(v)).join(" ") + ")  " +
      "yaw " + camera.yaw + "  pitch " + camera.pitch);
  }
  const captureable = wanted;

  if (options.select) {
    const plan = {
      selection: {
        rule: "sum manifest maps[].textures[].uses per wal across demo1/demo2/demo3; ties by name; entries with no pak9 art skipped",
        considered: selection.considered,
        entries: entries.map((entry) => ({
          index: entry.index, rank: entry.rank, name: entry.name, wal: entry.wal, uses: entry.uses, total: entry.total,
          map: entry.view.map, mapNote: entry.mapNote,
          faceScan: entry.view.scan,
          face: {
            index: entry.view.face.index, area: round(entry.view.face.area, 1),
            flags: entry.view.face.flags, side: entry.view.face.side,
            normal: vec(entry.view.face.normal), centroid: vec(entry.view.face.centroid),
          },
          camera: {
            origin: vec(entry.view.camera.origin), yaw: entry.view.camera.yaw,
            pitch: entry.view.camera.pitch, kind: entry.view.camera.kind,
            distance: entry.view.camera.distance,
          },
        })),
        skipped: selection.skipped.map((skip) => ({ name: skip.name, wal: skip.wal, rank: skip.rank, uses: skip.uses, total: skip.total, kind: "no-pak9-art", why: skip.why }))
          .concat(skippedView.map((skip) => ({ name: skip.name, wal: skip.wal, rank: skip.rank, uses: skip.uses, total: skip.total, kind: "no-drawn-world-face", why: skip.why })))
          .sort((a, b) => a.rank - b.rank),
      },
    };
    process.stdout.write("\n" + JSON.stringify(plan, null, 1) + "\n");
    return;
  }
  if (!captureable.length) throw new Error("no selected entry has a placeable camera");

  // What the live URL serves, against what this checkout holds. The live app is
  // only usable as evidence when it is the same pak9; otherwise the shots come
  // from a scratch server on this checkout and both identities are recorded.
  step("Check the served build");
  const local = { pak0: fileIdentity(PAK0), pak9: fileIdentity(PAK9) };
  const live = await servedIdentity(options.base);
  let base = options.base;
  let scratch = null;
  const samePak9 = live["pak9.pak"] && live["pak9.pak"].sha1 === local.pak9.sha1 && live["pak9.pak"].bytes === local.pak9.bytes;
  if (!samePak9 && !process.env.TEXTURE_AUDIT_ALLOW_MISMATCH) {
    note((options.base === LIVE ? "the live app" : options.base) + " serves pak9 " +
      (live["pak9.pak"] ? live["pak9.pak"].status + " " + live["pak9.pak"].bytes + " B sha1 " + (live["pak9.pak"].sha1 || "-") : "no answer") +
      ", not this checkout's " + local.pak9.bytes + " B sha1 " + local.pak9.sha1);
    scratch = await startServer();
    base = "http://127.0.0.1:" + scratch.port;
    ok("scratch server for this checkout: " + base + " (port " + scratch.port + ", userdata in " + scratch.dataDir + ")");
  } else {
    ok("served pak9 matches this checkout (" + local.pak9.bytes + " B, sha1 " + local.pak9.sha1 + ")");
  }
  const served = await servedIdentity(base);
  if (served["pak9.pak"].sha1 !== local.pak9.sha1 || served["pak9.pak"].bytes !== local.pak9.bytes) {
    throw new Error("the server actually used does not serve this checkout's pak9 (got " + JSON.stringify(served["pak9.pak"]) + ")");
  }
  ok("served pak9 equals baseq2/pak9.pak (" + local.pak9.bytes + " B)");

  const load = { cores: os.cpus().length, start: os.loadavg().map((v) => round(v, 2)) };
  const target = await pageTarget();
  const mark = base.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const cdp = new RawCdp(target.webSocketDebuggerUrl);
  await cdp.open();
  const outDir = path.resolve(options.out);
  fs.mkdirSync(outDir, { recursive: true });
  const report = {
    generatedAt: new Date().toISOString(),
    generator: "scripts/texture-audit.mjs",
    selection: {
      rule: "sum manifest maps[].textures[].uses per wal across demo1/demo2/demo3; ties by name; an entry with no pak9 art is skipped and the next taken; an entry with no drawable world face is skipped the same way",
      considered: selection.considered,
      entries: entries.map((entry) => ({
        index: entry.index, rank: entry.rank, name: entry.name, uses: entry.uses, total: entry.total,
        map: entry.view.map, mapNote: entry.mapNote,
      })),
      skipped: selection.skipped.map((skip) => ({ name: skip.name, wal: skip.wal, rank: skip.rank, uses: skip.uses, total: skip.total, kind: "no-pak9-art", why: skip.why }))
        .concat(skippedView.map((skip) => ({ name: skip.name, wal: skip.wal, rank: skip.rank, uses: skip.uses, total: skip.total, kind: "no-drawn-world-face", why: skip.why })))
        .sort((a, b) => a.rank - b.rank),
    },
    identity: { checkout: { pak0: local.pak0, pak9: local.pak9 }, live: { base: options.base, ...live }, served: { base, ...served }, scratch: !!scratch },
    load, entries: [], checks: {}, renderer: null,
  };
  const shots = new Map();
  try {
    for (const variant of [{ key: "NEW", tokens: [] }, { key: "OFF", tokens: ["+set", "r_retexturing", "0"] }].filter((one) => !options.variant || one.key === options.variant)) {
      for (const mapName of MAP_ORDER) {
        const group = captureable.filter((entry) => entry.view.map === mapName);
        if (!group.length) continue;
        let tokens = ["+set", "cheats", "1"].concat(variant.tokens);
        let url = buildUrl(base, mapName, tokens);
        step(variant.key + "  " + mapName + "  (" + group.length + " entr" + (group.length === 1 ? "y" : "ies") + ")");
        await navigate(cdp, url);
        await waitBoot(cdp, variant.key + " " + mapName);
        const box = { mark, control: new QuakeControl({ cdpUrl: options.cdp, gameUrlMark: mark }) };
        try {
          let pak9Bytes = await box.control.evaluate(PAK9_SIZE);
          let renderer = await box.control.evaluate(RENDERER);
          if (pak9Bytes !== local.pak9.bytes) throw new Error(mapName + " " + variant.key + ": the engine has pak9 at " + pak9Bytes + " B, not " + local.pak9.bytes + " B");
          await waitForMapName(box, options.cdp, mapName);
          let cheats = await ensureCheats(box);
          if (cheats.cheats !== "1") {
            note("cheats read " + JSON.stringify(cheats.cheats) + " after `cheats 1`; reloading with +set cheats 1 before +map");
            tokens = ["+set", "cheats", "1"].concat(tokens);
            url = buildUrl(base, mapName, tokens);
            await box.control.close().catch(() => {});
            await navigate(cdp, url);
            await waitBoot(cdp, variant.key + " " + mapName + " cheats");
            box.control = new QuakeControl({ cdpUrl: options.cdp, gameUrlMark: mark });
            await waitForMapName(box, options.cdp, mapName);
            pak9Bytes = await box.control.evaluate(PAK9_SIZE);
            renderer = await box.control.evaluate(RENDERER);
            cheats = await ensureCheats(box);
            if (cheats.cheats !== "1") throw new Error(mapName + " " + variant.key + ": cheats would not enable (read " + JSON.stringify(cheats.cheats) + " with +set cheats 1 on the URL)");
          }
          const r_retexturing = await readCvarDurable(box, options.cdp, "r_retexturing");
          const vid_renderer = await readCvarDurable(box, options.cdp, "vid_renderer");
          checkRenderer(mapName + " " + variant.key, renderer, vid_renderer);
          if (variant.key === "NEW" && r_retexturing !== "1") throw new Error("r_retexturing reads " + JSON.stringify(r_retexturing) + " on the NEW URL");
          if (variant.key === "OFF" && r_retexturing !== "0") throw new Error("r_retexturing reads " + JSON.stringify(r_retexturing) + " on the OFF URL");
          const context = { box, cdp, outDir, mapName, url, renderer: { webgl2: renderer.webgl2, renderer: renderer.renderer, drawingBuffer: renderer.drawingBuffer.join("x"), vidRenderer: vid_renderer } };
          report.renderer = context.renderer;
          report.checks[mapName + "-" + variant.key] = { pak9Bytes, vid_renderer, r_retexturing, webgl2: renderer.webgl2, unmasked: renderer.renderer, drawingBuffer: renderer.drawingBuffer.join("x") };
          ok(mapName + " " + variant.key + ": WebGL2, " + renderer.renderer + ", vid_renderer " + vid_renderer + ", buffer " + renderer.drawingBuffer.join("x") +
            ", r_retexturing " + r_retexturing + ", pak9 " + pak9Bytes + " B, cheats " + cheats.cheats);
          for (const entry of group) {
            const shot = await captureEntry(context, entry, variant.key);
            const slot = shots.get(entry.name) || {};
            slot[variant.key] = shot;
            shots.set(entry.name, slot);
          }
        } finally {
          await box.control.close().catch(() => {});
        }
      }
    }
    load.end = os.loadavg().map((v) => round(v, 2));
    report.entries = captureable.map((entry) => {
      const pair = shots.get(entry.name) || {};
      const face = entry.view.face, camera = entry.view.camera;
      return {
        index: entry.index, rank: entry.rank, entry: entry.name, wal: entry.wal, uses: entry.uses, totalUses: entry.total,
        map: entry.view.map, mapNote: entry.mapNote, faceScan: entry.view.scan,
        face: {
          index: face.index, texinfo: face.texinfo, area: round(face.area, 1), flags: face.flags, side: face.side,
          normal: vec(face.normal), centroid: vec(face.centroid), numedges: face.numedges,
        },
        camera: {
          origin: vec(camera.origin), yaw: camera.yaw, pitch: camera.pitch, kind: camera.kind,
          distance: camera.distance, pitchNote: camera.kind === "wall" ? "toward the centroid" : "42 degrees at the face, neighbours in frame",
        },
        teleportCommand: (pair.NEW && pair.NEW.teleport) || (pair.OFF && pair.OFF.teleport) || null,
        files: { NEW: pair.NEW ? pair.NEW.file : null, OFF: pair.OFF ? pair.OFF.file : null },
        landed: !!(pair.NEW && pair.NEW.landed && pair.OFF && pair.OFF.landed),
        variants: { NEW: pair.NEW || null, OFF: pair.OFF || null },
        verdict: null,
      };
    });
    report.complete = report.entries.every((entry) => entry.files.NEW && entry.files.OFF);
    report.method = "NEW r_retexturing 1 vs OFF r_retexturing 0, same face, eye, yaw and pitch; JPEG q" + JPEG_QUALITY;
    const reportPath = options.report || (options.only.length ? null : path.join(outDir, "audit.json"));
    if (reportPath) {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 1) + "\n");
      ok("wrote " + path.relative(ROOT, reportPath));
    } else {
      note("partial run (--only): audit.json not overwritten; pass --report <file> for a partial report");
    }
    log("\n  load average " + load.start.join(" / ") + " -> " + load.end.join(" / ") + " on " + load.cores + " cores");
  } finally {
    cdp.close();
    if (scratch) await stopChild(scratch.child);
    // Always leave the tab on the live app, whatever this run did.
    try {
      const back = new RawCdp(target.webSocketDebuggerUrl);
      await back.open();
      await navigate(back, LIVE + "/");
      back.close();
      ok("tab back on " + LIVE + "/");
    } catch (error) {
      note("could not put the tab back on " + LIVE + "/ (" + error.message + ")");
    }
  }
}


main().catch((error) => {
  process.stderr.write("\nFAILED: " + error.message + "\n");
  process.exit(1);
});
