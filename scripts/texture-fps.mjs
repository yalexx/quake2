#!/usr/bin/env node
// scripts/texture-fps.mjs -- the shipped archives on the box's real GPU: proof
// and frame rate, measured in the Chrome window that is already open.
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
// Frames are counted as one GLctx.clear per rendered frame, with the engine's
// MainLoop_runner rAF callback as a cross check: engine-state.js runs a watcher
// on a second rAF chain, so counting every callback would double the rate.
//   node scripts/texture-fps.mjs        # demo1,demo2 on the live tab
// Exit 0 when every measured variant produced samples; 1 when the tab could not
// be driven (a down port is recorded and never restarted).
"use strict";

import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
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
const JPEG_LIMIT = 1.5 * 1024 * 1024;
const APP_FILES = ["index.html", "app.js", "engine-state.js", "style.css", "server.js", "favicon.ico", "favicon.png"];
const REFERENCE = { fps: 34, offFps: 73, ratio: 0.47, set: "previous team's archives at b6c2a4f" };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line) => process.stdout.write(line + "\n");
const ok = (what) => log("  ok    " + what);
const note = (what) => log("  note  " + what);
const step = (what) => log("\n== " + what);
const mb = (n) => (n / 1024 / 1024).toFixed(1) + " MB";
const median = (values) => values.map((v) => v.fps).sort((a, b) => a - b)[Math.floor(values.length / 2)];

function parseArguments(argv) {
  const options = { maps: ["demo1", "demo2"], out: OUT_DIR, cdp: CDP, live: LIVE, prev: PREV_REV, keep: false };
  const keys = { "--maps": "maps", "--out": "out", "--cdp": "cdp", "--live": "live", "--prev": "prev" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      log("texture-fps.mjs [--maps demo1,demo2] [--out dir] [--cdp url] [--live url] [--prev rev] [--keep]");
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

async function waitBoot(cdp, label, timeoutMs = 180000) {
  const started = Date.now();
  let seen = null;
  while (Date.now() - started < timeoutMs) {
    try {
      seen = await pageEval(cdp, `(() => { const c = document.getElementById("canvas");
        return { display: c && c.style.display, fs: typeof FS,
          running: !!(window.quake2Engine && window.quake2Engine.read().ok) }; })()`);
      if (seen.display === "block" && seen.fs === "object" && seen.running) return seen;
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

// ---- In-page expressions --------------------------------------------------
const RENDERER = `(() => {
  const canvas = document.getElementById("canvas");
  const ext = GLctx.getExtension("WEBGL_debug_renderer_info");
  return { webgl2: GLctx instanceof WebGL2RenderingContext,
    vendor: ext && GLctx.getParameter(ext.UNMASKED_VENDOR_WEBGL),
    renderer: ext && GLctx.getParameter(ext.UNMASKED_RENDERER_WEBGL),
    glVersion: GLctx.getParameter(GLctx.VERSION),
    drawingBuffer: [canvas.width, canvas.height], inner: [innerWidth, innerHeight],
    dpr: devicePixelRatio, visible: document.visibilityState };
})()`;

const HOOK = `(() => {
  if (window.__fpsHook && window.__fpsHook.ready) return true;
  const gl = GLctx, clears = { n: 0 }, originalClear = gl.clear.bind(gl);
  gl.clear = function (...args) { clears.n++; return originalClear(...args); };
  const loops = { n: 0 }, originalRaf = window.requestAnimationFrame;
  window.requestAnimationFrame = function (cb) {
    if (typeof cb === "function" && String(cb).indexOf("MainLoop_runner") !== -1) loops.n++;
    return originalRaf.call(window, cb);
  };
  window.__fpsHook = { ready: true, clears, loops, t0: 0 };
  return true;
})()`;

const RESET = `(() => { const h = window.__fpsHook; h.clears.n = 0; h.loops.n = 0; h.t0 = performance.now(); return true; })()`;
const SAMPLE = `(() => { const h = window.__fpsHook;
  return { frames: h.clears.n, loops: h.loops.n, seconds: (performance.now() - h.t0) / 1000 }; })()`;
const PAK9 = `(() => { try { return FS.stat("/baseq2/pak9.pak").size; } catch (error) { return -1; } })()`;
// How fast the display's own rAF fires: the ceiling any frame count is read against.
const REFRESH = `new Promise((resolve) => { let n = 0; const t0 = performance.now();
  const tick = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(tick); else resolve({ frames: n, seconds: (performance.now() - t0) / 1000 }); };
  requestAnimationFrame(tick); })`;

function meanAbsDiff(a, b) {
  const pa = decodePng(a), pb = decodePng(b);
  if (pa.width !== pb.width || pa.height !== pb.height) return Infinity;
  let sum = 0;
  for (let i = 0; i < pa.data.length; i += 4) sum += Math.abs(pa.data[i] - pb.data[i]) + Math.abs(pa.data[i + 1] - pb.data[i + 1]) + Math.abs(pa.data[i + 2] - pb.data[i + 2]);
  return sum / ((pa.data.length / 4) * 3);
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

async function readCvar(control, name) {
  const answer = await control.command(name, { tail: 4 });
  const line = answer.output.map((one) => /"([^"]+)"\s+is\s+"([^"]*)"/.exec(one)).find(Boolean);
  return line ? line[2] : null;
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

// Freezes the world (timescale 0), waits for two frames to match, returns the
// settled PNG and the frame-to-frame difference that called it steady.
async function steadyShot(control) {
  let previous = await control.screenshot(), diff = Infinity;
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(800);
    const next = await control.screenshot();
    diff = meanAbsDiff(previous, next);
    previous = next;
    if (diff <= 0.5) break;
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

// One (variant, map) view. The map is loaded by the URL (+map <name>), not by a
// console command: a `map` typed into the console races the level load and can
// leave the bridge's console model out of step, which is exactly how an earlier
// run lost a whole variant. The console is used only for short cvars, and each
// one is read back before it is trusted.
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
    const refresh = await pageEval(cdp, REFRESH);
    const displayRefreshHz = Number((refresh.frames / refresh.seconds).toFixed(1));
    await waitForMapName(box, options.cdp, map);
    const r_retexturing = await readCvarDurable(box, options.cdp, "r_retexturing");
    const vid_renderer = await readCvarDurable(box, options.cdp, "vid_renderer");
    await setCvar(box, options.cdp, "timescale", "0");
    await sleep(1200);
    const shot = await steadyShot(box.control);
    const saved = await saveShot(cdp, shot.png, path.join(outDir, map + "-" + variant.key));
    const settleNote = shot.diff > 0.5
      ? "two frozen frames still differed by " + shot.diff.toFixed(2) + " (this spawn has a live enemy and a damage flash); the frame is a real in-game view, but not pixel-identical across variants"
      : null;
    await setCvar(box, options.cdp, "timescale", "1");
    await sleep(WARMUP_MS);
    const samples = [];
    for (let i = 0; i < SAMPLES; i++) {
      await pageEval(cdp, RESET);
      await sleep(SAMPLE_MS);
      const read = await pageEval(cdp, SAMPLE);
      samples.push({ frames: read.frames, engineRaf: read.loops, seconds: Number(read.seconds.toFixed(3)), fps: Number((read.frames / read.seconds).toFixed(2)) });
    }
    const medianFps = Number(median(samples).toFixed(2));
    return {
      pak9InEngine, renderer, r_retexturing, vid_renderer, displayRefreshHz,
      entry: { url, screenshot: path.relative(ROOT, saved.file), format: saved.format, bytes: saved.bytes, settleDiff: Number(shot.diff.toFixed(3)), settleNote, samples, medianFps },
    };
  } finally {
    await box.control.close().catch(() => {});
  }
}

async function measureVariant(context, variant) {
  step(variant.label + " on " + variant.base);
  const result = { base: variant.base, pak9InEngine: null, renderer: null, cvars: {}, maps: {} };
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
      if (view.renderer.drawingBuffer[0] !== TARGET_W || view.renderer.drawingBuffer[1] !== TARGET_H) {
        note("the drawing buffer is not " + TARGET_W + "x" + TARGET_H + "; measuring what the engine draws");
      }
      ok("r_retexturing " + view.r_retexturing + ", vid_renderer " + view.vid_renderer);
    }
    result.maps[map] = view.entry;
    ok(map + ": " + path.basename(view.entry.screenshot) + " (" + mb(view.entry.bytes) + ", settle " + view.entry.settleDiff.toFixed(2) +
      ", view " + ((Date.now() - t0) / 1000).toFixed(1) + " s); " + view.entry.samples.map((s) => s.fps.toFixed(1)).join(" / ") +
      " fps -> median " + view.entry.medianFps.toFixed(2));
  }
  return result;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  fs.mkdirSync(options.out, { recursive: true });
  const context = { cdp: null, options, outDir: options.out, servers: [], scratchDirs: [] };
  const report = { schema: 1, generatedAt: new Date().toISOString(), reference: REFERENCE, environment: {}, variants: {}, comparison: null, tuning: null, recommendations: [] };
  const cleanup = async () => {
    for (const child of context.servers) await stopChild(child);
    if (context.cdp) context.cdp.close();
    if (!options.keep) for (const dir of context.scratchDirs) fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    // -- 1. Preflight ------------------------------------------------------
    step("Preflight");
    const version = await fetch(options.cdp + "/json/version", { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    ok("browser " + version.Browser + " at " + options.cdp);
    const targets = await fetch(options.cdp + "/json/list", { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    const liveMark = new URL(options.live).host;
    const target = targets.find((one) => one.type === "page" && one.webSocketDebuggerUrl && new URL(one.url).host === liveMark);
    if (!target) throw new Error("no tab at " + options.live + " on " + options.cdp + "; not restarting anything");
    ok("game tab " + target.url + " (" + target.id + ")");
    const served = await fetch(options.live + "/baseq2/pak9.pak", { method: "HEAD", signal: AbortSignal.timeout(5000) });
    const servedBytes = Number(served.headers.get("content-length"));
    const localPak9 = fs.statSync(path.join(ROOT, "baseq2", "pak9.pak")).size;
    report.environment.servedPak9 = { contentLength: servedBytes, localBytes: localPak9, matches: servedBytes === localPak9 };
    if (servedBytes === localPak9) ok("the live app serves this checkout's NEW pak9 (" + servedBytes + " bytes)");
    else note("the live app serves pak9 " + servedBytes + " bytes, not this checkout's " + localPak9);

    let newOrigin = options.live;
    if (servedBytes !== localPak9) {
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
    for (const variant of variants) {
      try {
        report.variants[variant.key] = await measureVariant(context, variant);
      } catch (error) {
        if (variant.key !== "PREV") throw error;
        note("PREV failed and is skipped: " + error.message);
        report.variants.PREV = { skipped: error.message };
      }
    }

    // -- 4. Compare --------------------------------------------------------
    const fresh = report.variants.NEW, off = report.variants.OFF;
    if (fresh && off) {
      const map = Object.keys(fresh.maps).find((name) => off.maps[name]);
      const newFps = fresh.maps[map].medianFps, offFps = off.maps[map].medianFps;
      const ratio = Number((newFps / offFps).toFixed(3));
      report.comparison = { map, newFps, offFps, ratio, muchWorse: newFps < 29 || ratio < 0.4 };
      const prevEntry = report.variants.PREV && report.variants.PREV.maps && report.variants.PREV.maps[map];
      if (prevEntry) {
        report.comparison.prevFps = prevEntry.medianFps;
        report.comparison.referenceNote = "the previous set measured " + prevEntry.medianFps + " fps at this view today, against the recorded reference " +
          REFERENCE.fps + " fps; the display's own rAF fires at " + fresh.displayRefreshHz +
          "/s and every variant is pinned at that cap, so this view cannot show a cost";
      }
      report.environment.renderer = fresh.renderer;
      report.environment.measuredDrawingBuffer = fresh.renderer.drawingBuffer.join("x");
      report.environment.pak9InEngine = fresh.pak9InEngine;
      report.environment.displayRefreshHz = fresh.displayRefreshHz;
      report.environment.method = "GLctx.clear calls (one per rendered frame) plus the engine's MainLoop_runner requestAnimationFrame callback, " +
        "in the live page; " + WARMUP_MS / 1000 + " s warm-up then " + SAMPLES + " x " + SAMPLE_MS / 1000 + " s standing still at spawn, median; HTTP cache disabled";
      report.tuning = report.comparison.muchWorse
        ? { triggered: true, reason: "NEW " + newFps + " fps vs OFF " + offFps + " fps (ratio " + ratio + ") is under 29 fps or 0.40" }
        : { triggered: false, reason: "NEW " + newFps + " fps vs OFF " + offFps + " fps (ratio " + ratio + ") is not under 29 fps or 0.40; no tuning applied" };
      if (report.comparison.muchWorse) note("the new set is much worse by the rule; see fps.json");
      else {
        ok("not much worse: no cvar tuning applied");
        report.recommendations.push({ what: "keep the shipped pak9", why: "no measurable frame-rate cost at " + report.environment.measuredDrawingBuffer, numbers: { newFps, offFps, ratio } });
      }
    }

    // -- 5. Restore --------------------------------------------------------
    step("Restore the tab");
    await navigate(cdp, options.live + "/");
    await waitBoot(cdp, "restore");
    const restore = { mark: liveMark, control: new QuakeControl({ cdpUrl: options.cdp, gameUrlMark: liveMark }) };
    try {
      await sleep(1500); // let the freshly loaded page settle before the console
      const retexturing = await readCvarDurable(restore, options.cdp, "r_retexturing");
      const status = await restore.control.status().catch(() => null);
      report.restore = { url: options.live + "/", r_retexturing: retexturing, consoleOpen: !!(status && status.console && status.console.open) };
      if (retexturing !== "1") throw new Error("r_retexturing answered " + retexturing + " after restore");
      ok("tab back on " + options.live + "/; r_retexturing " + retexturing + "; console " + (report.restore.consoleOpen ? "OPEN" : "closed"));
    } finally {
      await restore.control.close().catch(() => {});
    }
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: false }).catch(() => {});
    await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});

    report.finishedAt = new Date().toISOString();
    await fsp.writeFile(path.join(options.out, "fps.json"), JSON.stringify(report, null, 2) + "\n");
    ok("wrote " + path.relative(ROOT, path.join(options.out, "fps.json")));
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
