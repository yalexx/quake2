#!/usr/bin/env node
// scripts/texture-fps.mjs -- the shipped archives on the box's real GPU: proof,
// diff pairs and an honest frame-time answer, measured in the Chrome window
// that is already open.
//
// texture-shots.mjs proves headless that the pak9 art reaches the screen; this
// proves it on the device the player uses, driving the open tab through
// control/bridge.mjs and raw CDP only for what the bridge lacks (navigation,
// cache bypass, JPEG capture).
//   NEW   <live>/?+map&<map>&+set&cl_gun&0&+set&crosshair&0 (r_retexturing 1)
//   OFF   the same URL plus &+set&r_retexturing&0
//   PREV  a scratch app folder whose baseq2 holds `git cat-file blob <rev>:
//         baseq2/pak0.pak` and ...:pak9.pak, served on a free port.
// The map is loaded by the URL, not by a console `map`: a map command races the
// level load and can leave the bridge's console model out of step.
//
// Three things this script is careful about:
//
// 1. It refuses to measure the software renderer. The hi-res pak9 art only
//    appears when the engine runs ref_gles3 on WebGL2, so a view where GLctx is
//    not a WebGL2RenderingContext, where the unmasked renderer does not name
//    ANGLE, where vid_renderer is not gles3, or where the canvas drawing buffer
//    is not 1366x768 is a hard error (exit 1). It never falls back to soft.
//
// 2. A diff pair is only a diff pair when the view settled. Each variant is
//    screenshotted frozen (timescale 0), and two consecutive frozen frames must
//    match within 0.5 mean |RGB diff| for the shot to count. demo2's spawn has a
//    live enemy and a damage flash, so its frames never settle and the map is
//    marked "not a diff pair" rather than compared. When a pair is settled the
//    run reports NEW-vs-OFF and PREV-vs-NEW mean |RGB diff|, changed pixels,
//    the frame-to-frame settle diff as the noise floor, and the ratio.
//    The freeze lands as soon as the level is up, before the cvars are read: a
//    demo's actors walk in real time, and two variants frozen a few seconds
//    apart differ by a Strogg's pose as much as by art. The console's own
//    "Dumped console text" notify is waited out before the shot for the same
//    reason -- it is not part of the view, and it shows in the evidence picture.
//
// 3. Capped fps cannot show a cost when every variant is pinned at the display
//    refresh rate. So the run also measures what a frame costs:
//      a. an uncapped loop: vid_maxfps 0 (the engine clamps it to 999) and the
//         MainLoop_runner rAF callback routed through a MessageChannel instead
//         of requestAnimationFrame, because Emscripten's timingMode 1 is rAF
//         even with r_vsync 0. GLctx.clear is counted per second.
//      b. work per frame at the normal cap: the same callback timed with
//         performance.now() before and after plus GLctx.finish() so GPU
//         completion is included; median and p95, and the headroom against the
//         measured display refresh.
//      c. GPU ms per frame from EXT_disjoint_timer_query_webgl2 when the
//         browser exposes it.
//    The page is reloaded between methods and between views, so no hook
//    survives into the next measurement. The report ends with one verdict:
//    headroom in ms/frame with NEW's cost against OFF, or "the display cap
//    hides it" with the evidence (e.g. the uncapped loop did not raise the
//    frame count).
//
// Load is recorded with os.loadavg() and the os.cpus() busy share over every
// sample window, and the report warns when the machine was busy: an earlier
// frame-rate reference was taken on a machine busy with a coding team and was
// withdrawn, so this report carries no such reference.
//
//   node scripts/texture-fps.mjs                    # demo1,demo2,demo3 on the live tab
//   node scripts/texture-fps.mjs --maps demo3 --prev 7e21a48 --out /tmp/fps
//
// Exit 0 when every measured variant produced samples and every renderer check
// held; 1 when the tab could not be driven or a renderer check failed (the
// message names the check). A down port is recorded and never restarted.
"use strict";

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { QuakeControl } from "../control/bridge.mjs";
import { decodePng } from "./texture-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "docs", "texture-review", "ingame", "real");
const CDP = "http://127.0.0.1:9222";
const LIVE = "http://127.0.0.1:4231";
const PREV_REV = "b6c2a4f";
const BANNED_PORTS = new Set([4231, 4233]);
const TARGET_W = 1366, TARGET_H = 768;
const WARMUP_MS = 5000, SAMPLE_MS = 10000, SAMPLES = 3;
const WORK_SAMPLE_MS = 6000;
const UNCAPPED_WARMUP_MS = 3000, UNCAPPED_SAMPLE_MS = 5000, UNCAPPED_SAMPLES = 2;
const JPEG_LIMIT = 1.5 * 1024 * 1024;
const SETTLE_EPS = 0.5;
// The bridge reads every cvar through the engine's own `condump`, and the engine
// prints "Dumped console text to ..." into its notify line (top left of the
// frame) each time. The notify fades on real time, and once the world is frozen
// the fade is the only thing still moving, so a shot taken straight after the
// last console read catches the text half faded -- in the diff pair and in the
// evidence picture. Q2's con_notifytime is 3 s: wait it out before freezing.
const NOTIFY_FADE_MS = 4000;
const CHANGED_PIXEL_DELTA = 8; // same threshold texture-shots.mjs calls a changed pixel
const APP_FILES = ["index.html", "app.js", "engine-state.js", "style.css", "server.js", "favicon.ico", "favicon.png"];
const WITHDRAWN_REFERENCE = {
  withdrawn: true,
  why: "an earlier frame-rate reference was measured while the machine was busy with a coding team; it did not reproduce and is not used in this report",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line) => process.stdout.write(line + "\n");
const ok = (what) => log("  ok    " + what);
const note = (what) => log("  note  " + what);
const step = (what) => log("\n== " + what);
const mb = (n) => (n / 1024 / 1024).toFixed(1) + " MB";
const medianOf = (numbers) => {
  const sorted = numbers.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
const percentileOf = (numbers, p) => {
  const sorted = numbers.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] : null;
};
const round = (n, digits = 3) => (n === null || n === undefined || !Number.isFinite(n) ? null : Number(n.toFixed(digits)));
// Report paths are repo-relative when the file is inside the checkout, and
// absolute otherwise (a smoke run into a scratch folder), never ../../../
const displayPath = (file) => {
  const relative = path.relative(ROOT, file);
  return relative.startsWith(".." + path.sep) || path.isAbsolute(relative) ? file : relative;
};

function parseArguments(argv) {
  const options = { maps: ["demo1", "demo2", "demo3"], out: OUT_DIR, cdp: CDP, live: LIVE, prev: PREV_REV, keep: false };
  const keys = { "--maps": "maps", "--out": "out", "--cdp": "cdp", "--live": "live", "--prev": "prev" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      log("texture-fps.mjs [--maps demo1,demo2,demo3] [--out dir] [--cdp url] [--live url] [--prev rev] [--keep]");
      log("");
      log("Measures the live game in the open Chrome tab on the real GPU:");
      log("  * hard renderer checks (WebGL2, ANGLE, vid_renderer gles3, 1366x768 buffer) -- exit 1 on a miss");
      log("  * NEW-vs-OFF and PREV-vs-NEW diff pairs per map, with the settle noise floor and ratio;");
      log("    a map whose frames did not settle is flagged 'not a diff pair'");
      log("  * capped fps, work per frame at the cap (gl.finish included), an uncapped loop via a");
      log("    MessageChannel main loop, and GPU timer queries when available");
      log("  * load average and CPU busy share per sample window, warned about when the machine is busy");
      log("  * the served pak9 compared with this checkout by SHA-1 of its content");
      log("");
      log("--maps     comma-separated map names (default demo1,demo2,demo3)");
      log("--out      where fps.json, shots and the labelled pair PNGs go (default docs/texture-review/ingame/real)");
      log("--cdp      Chrome DevTools endpoint (default http://127.0.0.1:9222)");
      log("--live     the live game URL (default http://127.0.0.1:4231)");
      log("--prev     git revision whose baseq2/pak0.pak and pak9.pak are PREV (default " + PREV_REV + ")");
      log("--keep     keep the scratch app folders and servers' directories");
      process.exit(0);
    } else if (arg === "--keep") options.keep = true;
    else if (keys[arg]) options[keys[arg]] = argv[++i];
    else throw new Error("unknown argument " + arg);
  }
  options.maps = String(options.maps).split(",").map((s) => s.trim()).filter(Boolean);
  options.out = path.resolve(options.out);
  options.cdp = String(options.cdp).replace(/\/$/, "");
  options.live = String(options.live).replace(/\/$/, "");
  if (!options.maps.length) throw new Error("--maps is empty");
  return options;
}

// ---- Load evidence ---------------------------------------------------------
function cpuSnapshot() {
  let total = 0, idle = 0;
  for (const cpu of os.cpus()) {
    for (const value of Object.values(cpu.times)) total += value;
    idle += cpu.times.idle;
  }
  return { total, idle, at: Date.now() };
}

function loadReading() {
  const [one, five, fifteen] = os.loadavg();
  return { load1: round(one, 2), load5: round(five, 2), load15: round(fifteen, 2), cores: os.cpus().length };
}

// CPU busy share over the window between two snapshots, as a 0..1 fraction.
function busyShareBetween(before, after) {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  if (total <= 0) return null;
  return round(Math.max(0, Math.min(1, 1 - idle / total)), 3);
}

function loadWarning(load) {
  if (!load || load.load1 === null) return null;
  if (load.load1 <= load.cores / 2) return null;
  return "the machine was busy before Chrome work started: load average " + load.load1 + " (1 min) on " + load.cores +
    " cores, above half the core count; frame timings from this run are not representative of an idle box";
}

// ---- Tiny raw CDP session, for what the bridge does not offer --------------
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

// A booted engine is a visible canvas, the Emscripten filesystem, and a live
// WebGL context. engine-state.js is not required: the live tab at the live URL
// may be served from a checkout older than this one (it has no engine-state.js
// at all), and refusing to finish a run because the restore target lacks a
// reader would leave the tab wherever the last measurement put it. The renderer
// check and the map wait still fail loudly if the engine is not really running.
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

// ---- Scratch servers, never the live app's port ---------------------------
function pickPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { const { port } = server.address(); server.close(() => resolve(port)); });
  });
}

async function startServer(appRoot, dataDir) {
  const port = await pickPort();
  if (BANNED_PORTS.has(port)) throw new Error("picked banned port " + port);
  const child = spawn(process.execPath, [path.join(appRoot, "server.js")], {
    cwd: appRoot, env: { ...process.env, PORT: String(port), QUAKE2_DATA_DIR: dataDir }, stdio: ["ignore", "pipe", "pipe"],
  });
  const started = await new Promise((resolve) => {
    let settled = false, out = "";
    const finish = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } };
    const timer = setTimeout(() => finish({ error: new Error("server.js did not listen in 20 s") }), 20000);
    child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; if (out.includes(":" + port + "/")) finish({ child, port }); });
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

function makeAppRoot(rootDir) {
  fs.mkdirSync(path.join(rootDir, "baseq2"), { recursive: true });
  for (const name of APP_FILES) fs.copyFileSync(path.join(ROOT, name), path.join(rootDir, name));
  fs.symlinkSync(path.join(ROOT, "engine"), path.join(rootDir, "engine"), "dir");
}

function extractGitBlob(rev, entry, dest) {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(dest, "w");
    const child = spawn("git", ["-C", ROOT, "cat-file", "blob", rev + ":" + entry], { stdio: ["ignore", fd, "pipe"] });
    let err = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { err += chunk; });
    child.once("error", (error) => { fs.closeSync(fd); reject(error); });
    child.once("exit", (code) => {
      fs.closeSync(fd);
      const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      if (code === 0 && size > 0) return resolve(size);
      fs.rmSync(dest, { force: true });
      reject(new Error(rev + ":" + entry + " unavailable" + (err.trim() ? " (" + err.trim().split("\n").pop() + ")" : "")));
    });
  });
}

async function sha1File(file) {
  const buffer = await fsp.readFile(file);
  return { bytes: buffer.length, sha1: crypto.createHash("sha1").update(buffer).digest("hex") };
}

// The live app's pak9, by content: sizes can coincide, a SHA-1 cannot.
async function sha1Served(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!response.ok) return { status: response.status, bytes: buffer.length, sha1: null };
  return { status: response.status, bytes: buffer.length, sha1: crypto.createHash("sha1").update(buffer).digest("hex") };
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
    drawingBuffer: [canvas.width, canvas.height], inner: [innerWidth, innerHeight],
    dpr: devicePixelRatio, visible: document.visibilityState };
})()`;

// One wrapper for the whole capped phase. Work timing is off until the work
// sample turns it on, so the capped fps samples carry the same overhead they
// always did (one callback wrapper, no gl.finish).
const HOOK = `(() => {
  if (window.__fpsHook && window.__fpsHook.ready) return true;
  const gl = GLctx, clears = { n: 0 }, originalClear = gl.clear.bind(gl);
  gl.clear = function (...args) { clears.n++; return originalClear(...args); };
  const loops = { n: 0 }, originalRaf = window.requestAnimationFrame.bind(window);
  const isRunner = (cb) => typeof cb === "function" && String(cb).indexOf("MainLoop_runner") !== -1;
  const work = { on: false, durations: [], gpu: [], pending: [], gpuSkipped: 0, timer: null };
  try { work.timer = gl.getExtension("EXT_disjoint_timer_query_webgl2") || null; } catch (error) { work.timer = null; }
  const poll = () => {
    if (!work.timer) return;
    for (let i = work.pending.length - 1; i >= 0; i--) {
      let ready = false;
      try { ready = gl.getQueryParameter(work.pending[i], gl.QUERY_RESULT_AVAILABLE); } catch (error) { ready = true; }
      if (!ready) continue;
      const query = work.pending.splice(i, 1)[0];
      try {
        if (gl.getParameter(work.timer.GPU_DISJOINT_EXT)) work.gpuSkipped++;
        else work.gpu.push(gl.getQueryParameter(query, gl.QUERY_RESULT) / 1e6);
      } catch (error) { work.gpuSkipped++; }
      try { gl.deleteQuery(query); } catch (error) { /* already gone */ }
    }
  };
  window.requestAnimationFrame = function (cb) {
    if (!isRunner(cb)) return originalRaf(cb);
    loops.n++;
    return originalRaf(function (timestamp) {
      if (!work.on) return cb(timestamp);
      const started = performance.now();
      let query = null;
      if (work.timer && work.pending.length <= 32) {
        try { query = gl.createQuery(); gl.beginQuery(work.timer.TIME_ELAPSED_EXT, query); } catch (error) { query = null; }
      }
      try {
        cb(timestamp);
      } finally {
        if (query) {
          try { gl.endQuery(work.timer.TIME_ELAPSED_EXT); work.pending.push(query); }
          catch (error) { work.gpuSkipped++; try { gl.deleteQuery(query); } catch (ignored) { /* gone */ } }
        }
        // GPU completion inside the timed region: the engine queues GL calls, so
        // performance.now() alone would time submission, not the frame.
        try { gl.finish(); } catch (error) { /* context lost */ }
        work.durations.push(performance.now() - started);
        poll();
      }
    });
  };
  window.__fpsHook = { ready: true, clears, loops, work, t0: 0 };
  return true;
})()`;

const RESET = `(() => { const h = window.__fpsHook; h.clears.n = 0; h.loops.n = 0; h.t0 = performance.now(); return true; })()`;
const SAMPLE = `(() => { const h = window.__fpsHook;
  return { frames: h.clears.n, loops: h.loops.n, seconds: (performance.now() - h.t0) / 1000 }; })()`;
const WORK_START = `(() => { const w = window.__fpsHook.work;
  w.on = true; w.durations.length = 0; w.gpu.length = 0; w.pending.length = 0; w.gpuSkipped = 0;
  return { timer: !!w.timer, ext: w.timer ? "EXT_disjoint_timer_query_webgl2" : null }; })()`;
const WORK_STOP = `(() => { const w = window.__fpsHook.work; w.on = false;
  return { durations: w.durations.slice(), gpu: w.gpu.slice(), gpuSkipped: w.gpuSkipped, timer: !!w.timer }; })()`;
const PAK9 = `(() => { try { return FS.stat("/baseq2/pak9.pak").size; } catch (error) { return -1; } })()`;
// How fast the display's own rAF fires: the ceiling any frame count is read against.
const REFRESH = `new Promise((resolve) => { let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else resolve({ frames: n, seconds: (performance.now() - t0) / 1000 }); };
  requestAnimationFrame(tick); })`;

// The uncapped loop. Emscripten's MainLoop reads window.requestAnimationFrame on
// every schedule, so routing the MainLoop_runner callback through a MessageChannel
// drops the display refresh limit while leaving every other rAF (the engine-state
// watcher, the refresh measurement) alone. A nested setTimeout is clamped to 4 ms
// or more; a MessageChannel post is not.
const UNCAPPED_HOOK = `(() => {
  if (window.__uncapped && window.__uncapped.ready) return true;
  const gl = GLctx, clears = { n: 0 }, originalClear = gl.clear.bind(gl);
  gl.clear = function (...args) { clears.n++; return originalClear(...args); };
  const loops = { n: 0 }, originalRaf = window.requestAnimationFrame.bind(window);
  const isRunner = (cb) => typeof cb === "function" && String(cb).indexOf("MainLoop_runner") !== -1;
  const queue = [], channel = new MessageChannel();
  let stopped = false;
  channel.port1.onmessage = function () {
    if (stopped) return;
    const cb = queue.shift();
    if (!cb) return;
    loops.n++;
    cb(performance.now());
  };
  window.requestAnimationFrame = function (cb) {
    if (!isRunner(cb)) return originalRaf(cb);
    if (stopped) return 0;
    queue.push(cb);
    channel.port2.postMessage(0);
    return 0;
  };
  window.__uncapped = { ready: true, clears, loops, t0: 0, queue, stop() { stopped = true; queue.length = 0; } };
  return true;
})()`;
const URESET = `(() => { const u = window.__uncapped; u.clears.n = 0; u.loops.n = 0; u.t0 = performance.now(); return true; })()`;
const USAMPLE = `(() => { const u = window.__uncapped;
  return { frames: u.clears.n, loops: u.loops.n, seconds: (performance.now() - u.t0) / 1000, queued: u.queue.length }; })()`;
const USTOP = `(() => { if (window.__uncapped) window.__uncapped.stop(); return true; })()`;

function meanAbsDiff(a, b) {
  const pa = decodePng(a), pb = decodePng(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return Infinity;
  let sum = 0;
  for (let i = 0; i < pa.data.length; i += 4) sum += Math.abs(pa.data[i] - pb.data[i]) + Math.abs(pa.data[i + 1] - pb.data[i + 1]) + Math.abs(pa.data[i + 2] - pb.data[i + 2]);
  return sum / ((pa.data.length / 4) * 3);
}

// Full diff of two lossless screenshots: mean |RGB| difference, and how many
// pixels changed by more than the project's changed-pixel threshold.
function imageDiff(pngA, pngB) {
  const a = decodePng(pngA), b = decodePng(pngB);
  if (a.width !== b.width || a.height !== b.height) {
    return { comparable: false, reason: "the shots differ in size (" + a.width + "x" + a.height + " vs " + b.width + "x" + b.height + ")" };
  }
  let sum = 0, changed = 0;
  const pixels = a.width * a.height;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
    sum += delta;
    if (delta > CHANGED_PIXEL_DELTA) changed++;
  }
  return {
    comparable: true, pixels, width: a.width, height: a.height,
    meanAbsDiff: sum / pixels, changedPixels: changed,
    changedShare: changed / pixels,
  };
}

// ---- A PNG encoder and a 5x7 label font, Node built-ins only --------------
// texture-lib has decodePng but no encoder, and the side-by-side has to carry
// its labels; zlib + a CRC table + a tiny bitmap font is all that takes.
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

function encodePngRgb(width, height, rgb) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgb.copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", idat), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

const FONT = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "/": ["00001", "00001", "00010", "00100", "01000", "10000", "10000"],
  "|": ["00100", "00100", "00100", "00100", "00100", "00100", "00100"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "A": ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  "B": ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  "C": ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  "D": ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  "E": ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  "F": ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  "G": ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  "H": ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  "I": ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  "J": ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  "K": ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  "L": ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  "M": ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  "N": ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  "O": ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  "P": ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  "Q": ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  "R": ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  "S": ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  "T": ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  "U": ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  "V": ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  "W": ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  "X": ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  "Y": ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  "Z": ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
};

function drawText(rgb, width, height, text, x, y, scale, color) {
  let cursor = x;
  for (const char of String(text).toUpperCase()) {
    const glyph = FONT[char];
    if (!glyph) { cursor += 4 * scale; continue; }
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (glyph[row][col] !== "1") continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const px = cursor + col * scale + dx, py = y + row * scale + dy;
            if (px < 0 || py < 0 || px >= width || py >= height) continue;
            const at = (py * width + px) * 3;
            rgb[at] = color[0]; rgb[at + 1] = color[1]; rgb[at + 2] = color[2];
          }
        }
      }
    }
    cursor += 6 * scale;
  }
  return cursor;
}

// One labelled side-by-side: HEADER_PX of dark bar carrying "<MAP>  <A> | <B>",
// then the two screenshots with a 4 px separator.
function composePair(map, keyA, pngA, keyB, pngB) {
  const a = decodePng(pngA), b = decodePng(pngB);
  if (a.width !== b.width || a.height !== b.height) return null;
  const HEADER_PX = 34, GAP = 4;
  const width = a.width * 2 + GAP, height = a.height + HEADER_PX;
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < rgb.length; i += 3) { rgb[i] = 18; rgb[i + 1] = 18; rgb[i + 2] = 22; }
  for (let y = 0; y < a.height; y++) {
    const srcRow = y * a.width * 4;
    const leftAt = ((y + HEADER_PX) * width) * 3;
    const rightAt = ((y + HEADER_PX) * width + a.width + GAP) * 3;
    for (let x = 0; x < a.width; x++) {
      const src = srcRow + x * 4;
      const l = leftAt + x * 3;
      rgb[l] = a.data[src]; rgb[l + 1] = a.data[src + 1]; rgb[l + 2] = a.data[src + 2];
      const r = rightAt + x * 3;
      rgb[r] = b.data[src]; rgb[r + 1] = b.data[src + 1]; rgb[r + 2] = b.data[src + 2];
    }
  }
  for (let y = HEADER_PX; y < height; y++) {
    const at = (y * width + a.width) * 3;
    for (let dx = 0; dx < GAP; dx++) { rgb[at + dx * 3] = 120; rgb[at + dx * 3 + 1] = 120; rgb[at + dx * 3 + 2] = 128; }
  }
  const title = map.toUpperCase() + "  " + keyA + " | " + keyB;
  drawText(rgb, width, height, title, 10, 8, 2, [235, 235, 235]);
  drawText(rgb, width, height, keyA, 10, 22, 1, [140, 220, 255]);
  drawText(rgb, width, height, keyB, a.width + GAP + 10, 22, 1, [255, 200, 120]);
  return encodePngRgb(width, height, rgb);
}

async function waitForMapName(box, cdpUrl, map, timeoutMs = 60000) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try { last = await readCvar(box.control, "mapname"); } catch { last = null; }
    if (last === map) return last;
    await sleep(1200);
  }
  await box.control.close().catch(() => {});
  box.control = new QuakeControl({ cdpUrl, gameUrlMark: box.mark });
  try { last = await readCvar(box.control, "mapname"); } catch { last = null; }
  if (last === map) return last;
  throw new Error("map " + map + " never became active (mapname " + last + ")");
}

async function setCvar(box, cdpUrl, name, value) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await box.control.command(name + " " + value, { tail: 3 }).catch(() => {});
    let got = null;
    try { got = await readCvar(box.control, name); } catch { /* console missed */ }
    if (got === value) return;
    note("could not set " + name + " " + value + " (read back " + got + "); reconnecting the bridge");
    await box.control.close().catch(() => {});
    box.control = new QuakeControl({ cdpUrl, gameUrlMark: box.mark });
  }
  throw new Error("cvar " + name + " would not take the value " + value);
}

// Some cvars are clamped by the engine: vid_maxfps 0 reads back as 999. Set it,
// read it back, and let the caller decide whether the clamped value is the
// expected one.
async function setCvarClamped(box, cdpUrl, name, value, expected) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await box.control.command(name + " " + value, { tail: 3 }).catch(() => {});
    let got = null;
    try { got = await readCvar(box.control, name); } catch { /* console missed */ }
    const accepted = Array.isArray(expected) ? expected : [expected];
    if (accepted.includes(got)) return got;
    note("cvar " + name + " " + value + " read back " + JSON.stringify(got) + " (expected " + accepted.join(" or ") + "); reconnecting the bridge");
    await box.control.close().catch(() => {});
    box.control = new QuakeControl({ cdpUrl, gameUrlMark: box.mark });
    await sleep(1200);
  }
  throw new Error("cvar " + name + " did not take " + value + " (the engine clamps it; expected " + (Array.isArray(expected) ? expected.join(" or ") : expected) + ")");
}

async function readCvar(control, name) {
  const answer = await control.command(name, { tail: 4 });
  const line = answer.output.map((one) => /"([^"]+)"\s+is\s+"([^"]*)"/.exec(one)).find(Boolean);
  return line ? line[2] : null;
}

// A page can be visibly booted (canvas, FS, GLctx) while the game is still
// loading its paks and the console does not answer yet -- the live tab at the
// live URL may be an older app with a larger pak0, and on a busy box that wait
// is long. Poll a harmless cvar until the console answers, then hand the value
// back. Used by the restore, where "the console never answered" must not be
// mistaken for "the cvar is wrong".
async function waitConsole(box, cdpUrl, name, timeoutMs = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    let got = null;
    try { got = await readCvar(box.control, name); } catch { got = null; }
    if (got !== null) return got;
    await box.control.close().catch(() => {});
    box.control = new QuakeControl({ cdpUrl, gameUrlMark: box.mark });
    await sleep(1500);
  }
  return null;
}

// readCvar, but a miss (the bridge's console model went out of step, common
// right after a fresh page load) costs a fresh bridge instead of an answer of
// null. Returns null only when every attempt missed.
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

// Hard renderer checks. A view that reaches the software renderer or a buffer
// the report cannot compare is a failure, not a note: hi-res pak9 only appears
// with gles3, so measuring anything else would be measuring the wrong thing.
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

// Freezes the world (timescale 0), waits for two frames to match, returns the
// settled PNG and the frame-to-frame difference that called it steady.
async function steadyShot(control) {
  let previous = await control.screenshot(), diff = Infinity;
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(800);
    const next = await control.screenshot();
    diff = meanAbsDiff(previous, next);
    previous = next;
    if (diff <= SETTLE_EPS) break;
  }
  return { png: previous, diff };
}

async function saveShot(cdp, png, fileBase) {
  if (png.length <= JPEG_LIMIT) {
    await fsp.writeFile(fileBase + ".png", png);
    return { file: fileBase + ".png", format: "png", bytes: png.length };
  }
  const { data } = await cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 90 });
  const jpeg = Buffer.from(data, "base64");
  await fsp.writeFile(fileBase + ".jpg", jpeg);
  return { file: fileBase + ".jpg", format: "jpeg", bytes: jpeg.length };
}

// One CPU busy share and load reading around an upcoming sample window: the
// caller snapshots before the sleep and closes the window after it.
function sampleLoadWindow() {
  return { cpu: cpuSnapshot(), load: loadReading() };
}

function closeLoadWindow(window) {
  const after = cpuSnapshot();
  return { load1: window.load.load1, load5: window.load.load5, cores: window.load.cores, cpuBusy: busyShareBetween(window.cpu, after) };
}

function workSummary(durations, gpu, timerAvailable, gpuSkipped) {
  const values = Array.isArray(durations) ? durations : [];
  const gpuValues = Array.isArray(gpu) ? gpu : [];
  return {
    frames: values.length,
    medianMs: round(medianOf(values)),
    p95Ms: round(percentileOf(values, 0.95)),
    minMs: values.length ? round(Math.min(...values)) : null,
    maxMs: values.length ? round(Math.max(...values)) : null,
    gpu: {
      extension: timerAvailable ? "EXT_disjoint_timer_query_webgl2" : null,
      frames: gpuValues.length,
      skipped: gpuSkipped || 0,
      medianMs: round(medianOf(gpuValues)),
      p95Ms: round(percentileOf(gpuValues, 0.95)),
    },
  };
}

// One (variant, map) view at the normal cap: hard checks, the settled diff-pair
// screenshot, capped fps, and work per frame with GPU completion included.
// The map is loaded by the URL (+map <name>), not by a console command: a `map`
// typed into the console races the level load and can leave the bridge's
// console model out of step, which is exactly how an earlier run lost a whole
// variant. The console is used only for short cvars, and each one is read back
// before it is trusted.
async function measureView(context, variant, map) {
  const { cdp, options, outDir } = context;
  const mark = variant.base.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const tokens = ["+map", map, "+set", "cl_gun", "0", "+set", "crosshair", "0"].concat(variant.tokens || []);
  const url = variant.base + "?" + tokens.join("&");
  await navigate(cdp, url);
  await waitBoot(cdp, variant.label + " " + map);
  const box = { mark, control: new QuakeControl({ cdpUrl: options.cdp, gameUrlMark: mark }) };
  try {
    const pak9InEngine = await box.control.evaluate(PAK9);
    const renderer = await box.control.evaluate(RENDERER);
    await pageEval(cdp, HOOK);
    await waitForMapName(box, options.cdp, map);
    // Freeze as soon as the level is up, before the console reads below. The
    // demo runs on real time, and every second spent reading cvars walks its
    // soldiers further across the view: two variants frozen a few seconds apart
    // can show a Strogg in different poses (once, in one view and not the
    // other), and that lands in the NEW-vs-OFF pixel count as if it were art.
    await setCvar(box, options.cdp, "timescale", "0");
    const r_retexturing = await readCvarDurable(box, options.cdp, "r_retexturing");
    const vid_renderer = await readCvarDurable(box, options.cdp, "vid_renderer");
    checkRenderer(variant.label + " " + map, renderer, vid_renderer);
    // Let the condump notify from the console reads above fade before the shot:
    // otherwise the evidence picture and the diff pair carry the engine's
    // "Dumped console text to ..." line across the top left of the frame.
    await sleep(NOTIFY_FADE_MS);
    const shot = await steadyShot(box.control);
    const saved = await saveShot(cdp, shot.png, path.join(outDir, map + "-" + variant.key));
    const settleNote = shot.diff > SETTLE_EPS
      ? "two frozen frames still differed by " + shot.diff.toFixed(2) + " (this spawn has a live enemy and a damage flash); the frame is a real in-game view, but not pixel-identical across variants"
      : null;
    await setCvar(box, options.cdp, "timescale", "1");
    // The display rate is only needed to turn the capped fps into a budget;
    // measuring it here keeps it out of the window before the freeze, which is
    // where the two variants have to agree on a demo moment.
    const refresh = await pageEval(cdp, REFRESH);
    const displayRefreshHz = Number((refresh.frames / refresh.seconds).toFixed(1));
    await sleep(WARMUP_MS);
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      const window = sampleLoadWindow();
      await pageEval(cdp, RESET);
      await sleep(SAMPLE_MS);
      const read = await pageEval(cdp, SAMPLE);
      const load = closeLoadWindow(window);
      samples.push({
        frames: read.frames, engineRaf: read.loops, seconds: Number(read.seconds.toFixed(3)),
        fps: Number((read.frames / read.seconds).toFixed(2)), ...load,
      });
    }
    const medianFps = Number(medianOf(samples.map((one) => one.fps)).toFixed(2));

    // Work per frame at the cap, GPU completion included. This changes what the
    // frame costs (gl.finish is a sync point), so it runs after the capped fps
    // samples and is reported as its own number.
    const workWindow = sampleLoadWindow();
    const workStart = await pageEval(cdp, WORK_START);
    await sleep(WORK_SAMPLE_MS);
    const workRead = await pageEval(cdp, WORK_STOP);
    const workLoad = closeLoadWindow(workWindow);
    const work = workSummary(workRead.durations, workRead.gpu, workRead.timer, workRead.gpuSkipped);
    work.seconds = WORK_SAMPLE_MS / 1000;
    work.load = workLoad;

    return {
      pak9InEngine, renderer, r_retexturing, vid_renderer, displayRefreshHz,
      entry: {
        url, screenshot: displayPath(saved.file), format: saved.format, bytes: saved.bytes,
        settleDiff: Number(shot.diff.toFixed(3)), settleNote, samples, medianFps, work,
        checks: { webgl2: renderer.webgl2, renderer: renderer.renderer, vidRenderer: vid_renderer, drawingBuffer: renderer.drawingBuffer.join("x") },
      },
      // Kept in memory only: the diff pairs decode these, losslessly, before
      // any JPEG fallback could touch a file.
      png: shot.png,
    };
  } finally {
    await box.control.close().catch(() => {});
  }
}

// The uncapped pass, in a fresh page load so the work-timing hooks are gone.
// vid_maxfps 0 (clamped to 999) removes the engine's own frame limiter; routing
// MainLoop_runner through a MessageChannel removes the display's rAF limit.
// GLctx.clear per second is the frame count.
async function measureUncapped(context, variant, map) {
  const { cdp, options } = context;
  const mark = variant.base.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const tokens = ["+map", map, "+set", "cl_gun", "0", "+set", "crosshair", "0"].concat(variant.tokens || []);
  const url = variant.base + "?" + tokens.join("&");
  await navigate(cdp, url);
  await waitBoot(cdp, variant.label + " " + map + " uncapped");
  const box = { mark, control: new QuakeControl({ cdpUrl: options.cdp, gameUrlMark: mark }) };
  try {
    const renderer = await box.control.evaluate(RENDERER);
    await waitForMapName(box, options.cdp, map);
    const vid_renderer = await readCvarDurable(box, options.cdp, "vid_renderer");
    checkRenderer(variant.label + " " + map + " uncapped", renderer, vid_renderer);
    await setCvar(box, options.cdp, "timescale", "1");
    // The engine is documented to clamp vid_maxfps 0 to 999 (README); accept 0
    // too in case this build passes it through. Anything else is a command the
    // console missed, not an uncapped loop.
    const vidMaxFps = await setCvarClamped(box, options.cdp, "vid_maxfps", "0", ["999", "0"]);
    await pageEval(cdp, UNCAPPED_HOOK);
    await sleep(UNCAPPED_WARMUP_MS);
    const samples = [];
    for (let i = 0; i < UNCAPPED_SAMPLES; i++) {
      const window = sampleLoadWindow();
      await pageEval(cdp, URESET);
      await sleep(UNCAPPED_SAMPLE_MS);
      const read = await pageEval(cdp, USAMPLE);
      const load = closeLoadWindow(window);
      samples.push({
        frames: read.frames, loops: read.loops, seconds: Number(read.seconds.toFixed(3)),
        fps: Number((read.frames / read.seconds).toFixed(2)), queued: read.queued, ...load,
      });
    }
    await pageEval(cdp, USTOP);
    const fps = Number(medianOf(samples.map((one) => one.fps)).toFixed(2));
    return {
      vidMaxFps, visible: renderer.visible, samples, fps,
      msPerFrame: fps > 0 ? Number((1000 / fps).toFixed(3)) : null,
      method: "vid_maxfps 0 (engine clamps to 999) and MainLoop_runner routed through a MessageChannel; GLctx.clear per second",
    };
  } finally {
    await box.control.close().catch(() => {});
  }
}

async function measureVariant(context, variant) {
  step(variant.label + " on " + variant.base);
  const result = { base: variant.base, pak9InEngine: null, renderer: null, cvars: {}, maps: {} };
  const pngs = {};
  for (const map of context.options.maps) {
    const t0 = Date.now();
    const view = await measureView(context, variant, map);
    if (!result.pak9InEngine) {
      result.pak9InEngine = view.pak9InEngine;
      result.renderer = view.renderer;
      result.displayRefreshHz = view.displayRefreshHz;
      result.cvars = { r_retexturing: view.r_retexturing, vid_renderer: view.vid_renderer };
      ok("pak9 in the engine " + view.pak9InEngine + " bytes; drawing buffer " + view.renderer.drawingBuffer.join("x") +
        ", inner " + view.renderer.inner.join("x") + ", dpr " + view.renderer.dpr + ", " + view.renderer.visible);
      ok("r_retexturing " + view.r_retexturing + ", vid_renderer " + view.vid_renderer + ", renderer " + view.renderer.renderer);
    }
    // Reload for the uncapped pass: no hook from the capped phase survives. A
    // method that does not work is recorded, not fatal -- the task is to find
    // out which method works, and the capped and work numbers stand alone.
    let uncapped;
    try {
      uncapped = await measureUncapped(context, variant, map);
      ok(map + ": uncapped " + uncapped.fps + " fps (" + uncapped.msPerFrame + " ms/frame), vid_maxfps " + uncapped.vidMaxFps + ", " + uncapped.visible);
    } catch (error) {
      // A renderer check is never downgraded to "recorded": gles3/WebGL2 is the
      // condition for measuring at all, in every page load.
      if (String(error.message).startsWith("renderer check failed")) throw error;
      uncapped = { error: error.message };
      note(map + ": uncapped method failed and is recorded: " + error.message);
    }
    view.entry.uncapped = uncapped;
    result.maps[map] = view.entry;
    pngs[map] = view.png;
    ok(map + ": " + path.basename(view.entry.screenshot) + " (" + mb(view.entry.bytes) + ", settle " + view.entry.settleDiff.toFixed(2) +
      "); capped " + view.entry.samples.map((s) => s.fps.toFixed(1)).join(" / ") + " fps -> median " + view.entry.medianFps.toFixed(2) +
      "; work " + view.entry.work.medianMs + " ms (p95 " + view.entry.work.p95Ms + ")");
  }
  return { result, pngs };
}

// ---- Diff pairs ------------------------------------------------------------
function makePair(label, map, viewA, viewB, pngA, pngB, options) {
  const settled = viewA.settleDiff <= SETTLE_EPS && viewB.settleDiff <= SETTLE_EPS;
  const diff = imageDiff(pngA, pngB);
  const pair = {
    label, map, settled,
    diffPair: settled && diff.comparable,
    noiseFloor: Math.max(viewA.settleDiff, viewB.settleDiff),
    noiseFloorSource: "the larger of the two views' steadyShot settleDiff (two frozen frames, frame to frame)",
    settleDiff: { a: viewA.settleDiff, b: viewB.settleDiff },
  };
  if (!settled) pair.reason = "a view did not settle (settleDiff " + viewA.settleDiff.toFixed(3) + " / " + viewB.settleDiff.toFixed(3) +
    " > " + SETTLE_EPS + "); this is not a diff pair";
  if (!diff.comparable) {
    pair.reason = diff.reason;
    return pair;
  }
  pair.meanAbsDiff = Number(diff.meanAbsDiff.toFixed(3));
  pair.changedPixels = diff.changedPixels;
  pair.changedShare = Number(diff.changedShare.toFixed(4));
  pair.changedPixelThreshold = CHANGED_PIXEL_DELTA;
  pair.pixels = diff.pixels;
  pair.source = "lossless PNG screenshots held in memory, before any JPEG fallback";
  pair.screenshots = { a: viewA.screenshot, b: viewB.screenshot, formats: [viewA.format, viewB.format] };
  pair.ratio = pair.noiseFloor > 0 ? Number((diff.meanAbsDiff / pair.noiseFloor).toFixed(2)) : null;
  if (pair.noiseFloor === 0) pair.note = "the settle diff was 0, so no ratio is reported";
  if (pair.diffPair) {
    const composite = composePair(map, label.split("-vs-")[0], pngA, label.split("-vs-")[1], pngB);
    if (composite) {
      const file = path.join(options.out, map + "-" + label + ".png");
      fs.writeFileSync(file, composite);
      pair.sideBySide = displayPath(file);
      pair.sideBySideBytes = composite.length;
    }
  }
  return pair;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  fs.mkdirSync(options.out, { recursive: true });

  // Load evidence, taken before any Chrome work: a busy box produced a figure
  // this project had to withdraw, and the warning has to come first.
  const beforeCpu = cpuSnapshot();
  const loadBefore = loadReading();
  await sleep(1000);
  const busyBefore = busyShareBetween(beforeCpu, cpuSnapshot());

  const context = { cdp: null, options, outDir: options.out, servers: [], scratchDirs: [] };
  const report = {
    schema: 2, generatedAt: new Date().toISOString(), reference: WITHDRAWN_REFERENCE,
    environment: { load: { cores: loadBefore.cores, before: { ...loadBefore, cpuBusy: busyBefore }, windows: [], warning: loadWarning(loadBefore) } },
    variants: {}, pairs: {}, comparison: null, verdict: null, tuning: null, recommendations: [],
  };
  const cleanup = async () => {
    for (const child of context.servers) await stopChild(child);
    if (context.cdp) context.cdp.close();
    if (!options.keep) for (const dir of context.scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    // -- 1. Preflight ------------------------------------------------------
    step("Preflight");
    if (report.environment.load.warning) note(report.environment.load.warning);
    else ok("machine load " + loadBefore.load1 + " on " + loadBefore.cores + " cores, CPU busy " + (busyBefore === null ? "unknown" : (busyBefore * 100).toFixed(0) + "%"));
    const version = await fetch(options.cdp + "/json/version", { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    ok("browser " + version.Browser + " at " + options.cdp);
    const targets = await fetch(options.cdp + "/json/list", { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    const liveMark = new URL(options.live).host;
    const target = targets.find((one) => one.type === "page" && one.webSocketDebuggerUrl && new URL(one.url).host === liveMark);
    if (!target) throw new Error("no tab at " + options.live + " on " + options.cdp + "; not restarting anything");
    ok("game tab " + target.url + " (" + target.id + ")");

    // The live app's pak9 by content. Sizes can coincide; a SHA-1 cannot.
    const local = await sha1File(path.join(ROOT, "baseq2", "pak9.pak"));
    let served = null;
    try { served = await sha1Served(options.live + "/baseq2/pak9.pak"); }
    catch (error) { served = { status: 0, bytes: 0, sha1: null, error: error.message }; }
    report.environment.servedPak9 = {
      status: served.status, contentLength: served.bytes, localBytes: local.bytes,
      sha1Served: served.sha1, sha1Local: local.sha1,
      matches: !!served.sha1 && served.sha1 === local.sha1,
    };
    if (served.error) note("could not read the live pak9: " + served.error);
    if (report.environment.servedPak9.matches) ok("the live app serves this checkout's NEW pak9 by SHA-1 (" + local.sha1.slice(0, 12) + "…)");
    else note("the live app's pak9 does not match this checkout (" + (served.sha1 ? "sha1 " + served.sha1.slice(0, 12) + "…" : "status " + served.status) +
      " vs " + local.sha1.slice(0, 12) + "…); NEW is served from a scratch copy of this checkout");

    let newOrigin = options.live;
    if (!report.environment.servedPak9.matches) {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "quake2-fps-"));
      context.scratchDirs.push(scratch);
      const dataDir = path.join(scratch, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      const server = await startServer(ROOT, dataDir);
      context.servers.push(server.child);
      newOrigin = "http://127.0.0.1:" + server.port;
      report.environment.localServer = newOrigin;
      ok("serving this checkout on " + newOrigin);
    }

    const cdp = new RawCdp(target.webSocketDebuggerUrl);
    await cdp.open();
    context.cdp = cdp;
    for (const method of ["Page.enable", "Runtime.enable", "Network.enable"]) await cdp.send(method);
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    ok("CDP session open; HTTP cache bypassed for the PAK max-age=3600");

    // -- 2. PREV archives --------------------------------------------------
    step("PREV archives from " + options.prev);
    let prev = null;
    try {
      const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "quake2-fps-prev-"));
      context.scratchDirs.push(scratch);
      const appRoot = path.join(scratch, "app");
      const dataDir = path.join(scratch, "data");
      fs.mkdirSync(dataDir, { recursive: true });
      makeAppRoot(appRoot);
      for (const entry of ["pak0.pak", "pak9.pak"]) {
        ok(entry + " " + mb(await extractGitBlob(options.prev, "baseq2/" + entry, path.join(appRoot, "baseq2", entry))));
      }
      const server = await startServer(appRoot, dataDir);
      context.servers.push(server.child);
      prev = "http://127.0.0.1:" + server.port;
      ok("PREV served on " + prev);
    } catch (error) {
      note("PREV skipped: " + error.message);
      report.variants.PREV = { skipped: error.message };
    }

    // -- 3. Measure --------------------------------------------------------
    const variants = [
      { key: "NEW", label: "NEW (this checkout's archives)", base: newOrigin + "/" },
      { key: "OFF", label: "OFF (r_retexturing 0)", base: newOrigin + "/", tokens: ["+set", "r_retexturing", "0"] },
    ];
    if (prev) variants.push({ key: "PREV", label: "PREV (archives at " + options.prev + ")", base: prev + "/" });
    const pngs = {};
    for (const variant of variants) {
      try {
        const measured = await measureVariant(context, variant);
        pngs[variant.key] = measured.pngs;
        report.variants[variant.key] = measured.result;
      } catch (error) {
        if (variant.key === "NEW" || variant.key === "OFF") throw error; // hard checks and the pair both need them
        note("PREV failed and is skipped: " + error.message);
        report.variants.PREV = { skipped: error.message };
      }
    }

    // Every sample window's load and CPU busy share, gathered from the entries
    // above so the report can say whether the machine was busy while it was
    // measured, not only before.
    for (const [variantKey, measured] of Object.entries(report.variants)) {
      if (!measured || !measured.maps) continue;
      for (const [map, entry] of Object.entries(measured.maps)) {
        entry.samples.forEach((sample, index) => report.environment.load.windows.push({
          variant: variantKey, map, phase: "capped", sample: index + 1, load1: sample.load1, cpuBusy: sample.cpuBusy,
        }));
        if (entry.work && entry.work.load) {
          report.environment.load.windows.push({
            variant: variantKey, map, phase: "work", load1: entry.work.load.load1, cpuBusy: entry.work.load.cpuBusy,
          });
        }
        if (entry.uncapped && entry.uncapped.samples) {
          entry.uncapped.samples.forEach((sample, index) => report.environment.load.windows.push({
            variant: variantKey, map, phase: "uncapped", sample: index + 1, load1: sample.load1, cpuBusy: sample.cpuBusy,
          }));
        }
      }
    }
    const windows = report.environment.load.windows;
    const busyWindows = windows.filter((one) => one.cpuBusy !== null && one.cpuBusy > 0.5);
    report.environment.load.duringRun = {
      windows: windows.length,
      maxLoad1: windows.reduce((best, one) => (one.load1 !== null && one.load1 > best ? one.load1 : best), 0),
      maxCpuBusy: windows.reduce((best, one) => (one.cpuBusy !== null && one.cpuBusy > best ? one.cpuBusy : best), 0),
      busyWindows: busyWindows.length,
    };
    if (!report.environment.load.warning && busyWindows.length) {
      report.environment.load.warning = busyWindows.length + " of " + windows.length + " sample windows had the CPU more than half busy; frame timings are not representative of an idle box";
      note(report.environment.load.warning);
    }

    // -- 4. Diff pairs -----------------------------------------------------
    step("Diff pairs");
    for (const map of options.maps) {
      const fresh = report.variants.NEW && report.variants.NEW.maps[map];
      const off = report.variants.OFF && report.variants.OFF.maps[map];
      const previous = report.variants.PREV && report.variants.PREV.maps && report.variants.PREV.maps[map];
      const pair = { map, pairs: {} };
      if (fresh && off && pngs.NEW && pngs.OFF && pngs.NEW[map] && pngs.OFF[map]) {
        pair.pairs.NEWvsOFF = makePair("NEW-vs-OFF", map, fresh, off, pngs.NEW[map], pngs.OFF[map], options);
      }
      if (fresh && previous && pngs.PREV && pngs.PREV[map]) {
        pair.pairs.PREVvsNEW = makePair("PREV-vs-NEW", map, previous, fresh, pngs.PREV[map], pngs.NEW[map], options);
      }
      report.pairs[map] = pair;
      for (const [name, one] of Object.entries(pair.pairs)) {
        if (one.diffPair) {
          ok(map + " " + name + ": mean |RGB| diff " + one.meanAbsDiff + ", " + one.changedPixels + " changed pixels (" +
            (one.changedShare * 100).toFixed(1) + "%), noise floor " + one.noiseFloor.toFixed(3) + ", ratio " + one.ratio +
            (one.sideBySide ? "; " + path.basename(one.sideBySide) : ""));
        } else {
          note(map + " " + name + ": NOT A DIFF PAIR -- " + (one.reason || "the view did not settle"));
        }
      }
    }

    // -- 5. Comparison and verdict ----------------------------------------
    const fresh = report.variants.NEW, off = report.variants.OFF;
    if (fresh && off) {
      const maps = Object.keys(fresh.maps).filter((name) => off.maps[name]);
      const workNew = medianOf(maps.map((name) => fresh.maps[name].work.medianMs).filter((n) => n !== null));
      const workOff = medianOf(maps.map((name) => off.maps[name].work.medianMs).filter((n) => n !== null));
      const uncappedNew = medianOf(maps.map((name) => fresh.maps[name].uncapped && fresh.maps[name].uncapped.fps).filter((n) => n));
      const uncappedOff = medianOf(maps.map((name) => off.maps[name].uncapped && off.maps[name].uncapped.fps).filter((n) => n));
      const cappedNew = medianOf(maps.map((name) => fresh.maps[name].medianFps));
      const cappedOff = medianOf(maps.map((name) => off.maps[name].medianFps));
      const refresh = fresh.displayRefreshHz;
      const budgetMs = refresh ? Number((1000 / refresh).toFixed(3)) : null;

      const raised = uncappedNew !== null && cappedNew !== null && uncappedNew > cappedNew * 1.15;
      const uncappedError = maps.map((name) => fresh.maps[name].uncapped && fresh.maps[name].uncapped.error).find(Boolean) || null;
      const newMs = workNew !== null ? workNew : (uncappedNew ? 1000 / uncappedNew : null);
      const offMs = workOff !== null ? workOff : (uncappedOff ? 1000 / uncappedOff : null);
      const headroom = newMs !== null && budgetMs !== null ? Number((budgetMs - newMs).toFixed(2)) : null;
      const cost = newMs !== null && offMs !== null ? Number((newMs - offMs).toFixed(2)) : null;
      const costPercent = newMs !== null && offMs ? Number(((newMs - offMs) / offMs * 100).toFixed(1)) : null;

      const evidence = [
        "capped fps is pinned at the display: NEW " + cappedNew + " fps, OFF " + cappedOff + " fps, display rAF " + refresh + "/s",
        workNew !== null
          ? "work per frame at the cap, GPU completion included (gl.finish): NEW " + workNew + " ms (p95 " + medianOf(maps.map((n) => fresh.maps[n].work.p95Ms)) + "), OFF " + workOff + " ms"
          : "work per frame could not be measured at the cap",
        uncappedNew !== null
          ? (raised
            ? "the uncapped loop raised the frame count: NEW " + uncappedNew + " fps vs " + cappedNew + " capped"
            : "the uncapped loop did not raise the frame count (NEW " + uncappedNew + " fps against " + cappedNew + " capped at " + refresh + "/s)")
          : "the uncapped loop produced no samples" + (uncappedError ? " (" + uncappedError + ")" : ""),
        "display budget " + budgetMs + " ms/frame at " + refresh + " Hz",
      ];

      report.comparison = {
        maps, cappedNew, cappedOff, uncappedNew, uncappedOff,
        workNewMs: workNew, workOffMs: workOff,
        budgetMs, headroomMs: headroom, costMs: cost, costPercent,
        newVsOffCappedRatio: cappedOff ? Number((cappedNew / cappedOff).toFixed(3)) : null,
        uncappedRaised: raised,
      };
      report.environment.methods = {
        cappedFps: true,
        workPerFrame: workNew !== null,
        uncappedLoop: uncappedNew === null ? "failed" : (raised ? "raised the frame count" : "did not raise the frame count"),
        gpuTimerQueries: maps.map((name) => fresh.maps[name].work.gpu.extension).find(Boolean) || "unavailable",
      };

      // The verdict: an uncapped loop that raised the frame count is the proof
      // the cap was hiding headroom; so is a direct work-per-frame measurement
      // when the uncapped method itself failed. If the loop did not raise the
      // count, the cap is what the run saw and the report says so.
      if (raised || (uncappedNew === null && workNew !== null)) {
        const headroomText = headroom !== null && headroom >= 0
          ? headroom + " ms/frame"
          : (headroom === null ? "unknown" : "none (" + Math.abs(headroom) + " ms over the " + budgetMs + " ms budget)");
        report.verdict = {
          kind: "headroom",
          text: "headroom " + headroomText + "; NEW costs " + (cost === null ? "unknown" : cost + " ms/frame") +
            " vs OFF (" + (costPercent === null ? "unknown" : costPercent + "%") + ")",
          evidence,
        };
        ok("verdict: " + report.verdict.text);
      } else {
        report.verdict = {
          kind: "cap-hides",
          text: "the display cap hides it",
          evidence,
        };
        note("verdict: " + report.verdict.text + " -- " + evidence[2]);
      }

      report.tuning = {
        triggered: false,
        reason: "the measured question is frame work, not capped fps; no cvar tuning was applied",
      };
      report.recommendations.push({
        what: "use the work-per-frame numbers, not capped fps",
        why: "every variant is pinned at the display refresh, so capped fps cannot separate them; the uncapped loop and gl.finish timing can",
        numbers: { workNewMs: workNew, workOffMs: workOff, budgetMs, headroomMs: headroom, uncappedNew, uncappedOff },
      });
      report.environment.renderer = fresh.renderer;
      report.environment.measuredDrawingBuffer = fresh.renderer.drawingBuffer.join("x");
      report.environment.pak9InEngine = fresh.pak9InEngine;
      report.environment.displayRefreshHz = refresh;
      report.environment.method = "hard renderer checks; one settled screenshot per view (timescale 0); capped fps from GLctx.clear plus MainLoop_runner rAF; " +
        "work per frame from the runner timed with performance.now and gl.finish; uncapped fps from GLctx.clear with vid_maxfps 0 (clamped to 999) and " +
        "MainLoop_runner routed through a MessageChannel; GPU ms from EXT_disjoint_timer_query_webgl2 when available; " +
        WARMUP_MS / 1000 + " s warm-up then " + SAMPLES + " x " + SAMPLE_MS / 1000 + " s at the cap and " + UNCAPPED_SAMPLES + " x " + UNCAPPED_SAMPLE_MS / 1000 + " s uncapped; HTTP cache disabled";
    }

    // -- 6. Restore --------------------------------------------------------
    step("Restore the tab");
    await navigate(cdp, options.live + "/");
    await waitBoot(cdp, "restore");
    const restore = { mark: liveMark, control: new QuakeControl({ cdpUrl: options.cdp, gameUrlMark: liveMark }) };
    try {
      // The live app may be an older build with no engine-state.js and a slower
      // boot; wait until its console actually answers before asking for a cvar.
      await sleep(1500);
      let retexturing = await waitConsole(restore, options.cdp, "r_retexturing");
      if (retexturing === null) throw new Error("the live app's console did not answer within 90 s; cannot confirm r_retexturing 1");
      if (retexturing !== "1") {
        await setCvar(restore, options.cdp, "r_retexturing", "1");
        retexturing = await readCvarDurable(restore, options.cdp, "r_retexturing");
      }
      const scheduling = await pageEval(cdp, `(() => ({ fpsHook: typeof window.__fpsHook, uncapped: typeof window.__uncapped,
        nativeRaf: String(window.requestAnimationFrame).indexOf("[native code]") !== -1 }))()`);
      const status = await restore.control.status().catch(() => null);
      report.restore = {
        url: options.live + "/", r_retexturing: retexturing, scheduling,
        consoleOpen: !!(status && status.console && status.console.open),
      };
      if (retexturing !== "1") throw new Error("r_retexturing answered " + retexturing + " after restore");
      if (!scheduling.nativeRaf) throw new Error("window.requestAnimationFrame is not native after restore; a hook survived");
      ok("tab back on " + options.live + "/; r_retexturing " + retexturing + "; native rAF; console " + (report.restore.consoleOpen ? "OPEN" : "closed"));
    } finally {
      await restore.control.close().catch(() => {});
    }
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});

    report.environment.load.after = loadReading();
    report.finishedAt = new Date().toISOString();
    await fsp.writeFile(path.join(options.out, "fps.json"), JSON.stringify(report, null, 2) + "\n");
    ok("wrote " + displayPath(path.join(options.out, "fps.json")));
    if (report.verdict) log("\nVERDICT: " + report.verdict.text);
    log("\nDone.");
    return 0;
  } catch (error) {
    report.error = error.message;
    report.finishedAt = new Date().toISOString();
    try { await fsp.writeFile(path.join(options.out, "fps.json"), JSON.stringify(report, null, 2) + "\n"); } catch { /* out dir gone */ }
    log("\nFAILED: " + error.message);
    return 1;
  } finally {
    await cleanup();
  }
}

process.exitCode = await main();
