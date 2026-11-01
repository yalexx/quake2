#!/usr/bin/env node
// Acceptance runner for what the owner sees: the ClawBox Quake 2 app served at
// http://127.0.0.1:4231/apps/quake2/, booting straight into the game, drawing a
// weapon in hand (cl_gun 1) and rendering the dark interface in RTX High,
// Performance and Off at 1280x720 and at the box display's measured resolution.
//
// The presentation checks are the owner's two asks: the engine's own status bar
// is the HUD (no #hud element, readable health and ammo digits in the canvas
// bottom band, nothing painted over that band), and the engine's 8x8 crosshair
// picture is drawn at ~50% alpha in the game palette's rusted amber/bone, with
// crosshair 0 still hiding it and crosshair_scale 3 still setting its size. The
// crosshair opacity and tint are measured from on/off pixel pairs over both a
// dark and a bright background; the tint is read from pics/colormap.pcx.
//
// Node built-ins plus the repo's own control/bridge.mjs; no packages. It starts
// headless Chrome itself (SwiftShader when no GPU is reachable), drives the page
// over the Chrome DevTools Protocol, reads cvars through the engine's console
// via QuakeControl, measures rAF frame times, and writes every screenshot and
// the JSON report inside the repo.
//
//   node scripts/verify-presentation.mjs [--url URL] [--out DIR] [--frames N]
//
// It exits 0 only when every required piece of evidence was produced and every
// check passed; a missing browser, a refused HTTP target, a mismatched checkout,
// a boot/renderer failure, a cl_gun that is not 1, a missing weapon draw, a
// failed screenshot or too few frame samples all exit non-zero.
//
// The runner never edits the app. With cl_gun forced to 0 in app.js it stops at
// the cl_gun check and exits 1 — that is the failure path this file proves.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { QuakeControl } from "../control/bridge.mjs";
import { canvasStrip, readHealth, decodePng } from "../control/hud.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_URL = "http://127.0.0.1:4231/apps/quake2/";
const GAME_MARK = "/apps/quake2/";
const LIGHT_LEVELS = ["high", "performance", "off"];
const MODE_NUMBERS = { high: 2, performance: 1, off: 0 };
// The engine's own r_mode table (strings in engine/index.wasm):
// 14 = 1280x720, 17 = 1366x768, 24 = 2560x1080, 25 = 2560x1440, 26 = 2560x1600.
const R_MODES = { "1280x720": 14, "1366x768": 17, "2560x1080": 24, "2560x1440": 25, "2560x1600": 26 };
const WEAPON_NAMES = {
  v_blast: ["Blaster", "weapon_blaster"],
  v_shotg: ["Shotgun", "weapon_shotgun"],
  v_shotg2: ["Super Shotgun", "weapon_supershotgun"],
  v_machn: ["Machinegun", "weapon_machinegun"],
  v_chain: ["Chaingun", "weapon_chaingun"],
  v_launch: ["Grenade Launcher", "weapon_grenadelauncher"],
  v_rocket: ["Rocket Launcher", "weapon_rocketlauncher"],
  v_rail: ["Railgun", "weapon_railgun"],
  v_hyperb: ["HyperBlaster", "weapon_hyperblaster"],
  v_bfg: ["BFG10K", "weapon_bfg"],
  v_disint: ["Disintegrator", null],
  v_flareg: ["Flare Gun", null],
  v_handgr: ["Hand Grenades", null],
};
const ENEMY_NAMES = {
  berserk: ["Berserker", ["monster_berserk"]],
  flyer: ["Flyer", ["monster_flyer"]],
  gunner: ["Gunner", ["monster_gunner"]],
  infantry: ["Infantry", ["monster_infantry"]],
  parasite: ["Parasite", ["monster_parasite"]],
  soldier: ["Soldier", ["monster_soldier", "monster_soldier_light", "monster_soldier_ss"]],
  tank: ["Tank", ["monster_tank"]],
};

// The engine's own menu tree, from Qwasm2's src/client/menu/menu.c and
// src/client/menu/videomenu.c (the engine prints "Yamagi Quake II v8.60"). The
// row lists and their order are the acceptance target: the dark panel must
// carry these rows, in this order, with the engine's own value lists.
const ENGINE_MENU_TREE = {
  main: ["GAME", "MULTIPLAYER", "OPTIONS", "VIDEO", "QUIT"],
  game: ["easy", "medium", "hard", "hard+", "load game", "save game", "credits"],
  multiplayer: ["join network server", "start network server", "player setup", "customize controls"],
  options: ["effects volume", "OGG volume", "OGG music", "OGG shuffle", "sound backend",
    "mouse speed", "always run", "invert mouse", "lookstrafe", "free look", "crosshair",
    "pause on minimized", "customize controls", "reset defaults", "go to console"],
  // The gles3 branch of VID_MenuInit, without the gamepad-only row.
  video: ["renderer", "video mode", "brightness", "field of view", "color intensity",
    "overbrights", "color light", "ui scale", "fullscreen", "vertical sync",
    "aniso filtering", "multisampling", "texture filter", "reset to default", "apply"],
};
// The engine's crosshair itemnames and the r_mode video-mode list (modes[] in
// videomenu.c sorted by their printed string: 1600x900 is modenum 32 and comes
// after 1440x900), then auto and custom.
const ENGINE_CROSSHAIR_LABELS = ["none", "cross", "dot", "angle"];
const ENGINE_VIDEO_MODE_VALUES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11",
  "12", "13", "14", "15", "16", "17", "18", "32", "19", "20", "21", "22", "23", "24", "25", "26",
  "27", "28", "29", "30", "31", "-2", "-1"];
const ENGINE_R_MODE_LABELS = ["320x240", "400x300", "512x384", "640x400", "640x480", "800x500",
  "800x600", "960x720", "1024x480", "1024x640", "1024x768", "1152x768", "1152x864", "1280x800",
  "1280x720", "1280x960", "1280x1024", "1366x768", "1440x900", "1600x900", "1600x1200", "1680x1050",
  "1920x1080", "1920x1200", "2048x1536", "2560x1080", "2560x1440", "2560x1600", "3440x1440",
  "3840x1600", "3840x2160", "4096x2160", "5120x2880", "auto", "custom"];

const options = {
  url: DEFAULT_URL,
  out: path.join(ROOT, "docs", "presentation-verification"),
  frames: 20,
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--url") options.url = argv[++i];
  else if (argv[i] === "--out") options.out = path.resolve(argv[++i]);
  else if (argv[i] === "--frames") options.frames = Number(argv[++i]);
  else if (argv[i] === "--help" || argv[i] === "-h") {
    console.log("verify-presentation.mjs [--url URL] [--out DIR] [--frames N]");
    process.exit(0);
  } else {
    console.error("unknown option: " + argv[i]);
    process.exit(2);
  }
}
if (!Number.isFinite(options.frames) || options.frames < 10) {
  console.error("--frames must be at least 10 (p95 needs a real sample)");
  process.exit(2);
}
const OUT = options.out;
const SHOTS = path.join(OUT, "shots");
const LOGS = path.join(OUT, "logs");
const target = new URL(options.url);
const targetPort = Number(process.env.PORT || target.port || 80);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const report = {
  at: new Date().toISOString(),
  url: options.url,
  checkout: ROOT,
  node: process.version,
  platform: os.platform() + " " + os.release(),
  display: null,
  http: null,
  server: null,
  chrome: null,
  renderer: null,
  boot: null,
  boots: [],
  checks: [],
  notes: [],
  consoleWarnings: [],
  consoleErrors: [],
  networkErrors: [],
  pageErrors: [],
  webgl: { contextLost: 0, glError: null },
  webglPages: [],
  webglWarnings: [],
  clGun: null,
  menu: null,
  statusBar: null,
  weaponDraw: null,
  weaponDraws: [],
  modes: [],
  screenshots: [],
  coverage: null,
  limitations: [],
  fatal: null,
  ok: false,
};

function check(name, ok, expected, actual, detail) {
  const entry = { name, ok: Boolean(ok), expected, actual, ...(detail ? { detail } : {}) };
  report.checks.push(entry);
  console.log((ok ? "  ok   " : "  FAIL ") + name + " — " + actual + (ok ? "" : " (expected " + expected + ")"));
  return Boolean(ok);
}
function note(text) {
  report.notes.push(text);
  console.log("  note " + text);
}
class Fatal extends Error {}
function fatal(message) {
  report.fatal = message;
  throw new Fatal(message);
}
async function withTimeout(promise, ms, what) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(what + " timed out after " + ms + " ms")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function waitFor(fn, timeoutMs, intervalMs, what) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await fn();
      if (last) return last;
    } catch (error) {
      last = String(error.message || error);
    }
    await sleep(intervalMs);
  }
  throw new Error(what + " did not happen within " + timeoutMs + " ms" + (last ? " (last: " + JSON.stringify(last) + ")" : ""));
}

// ---- HTTP target ---------------------------------------------------------

async function fetchManual(url) {
  try {
    return await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(15000) });
  } catch (error) {
    return null;
  }
}
function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
async function ensureServer() {
  let response = await fetchManual(options.url);
  if (!response) {
    console.log("  starting node server.js on port " + targetPort);
    const log = fs.openSync(path.join(LOGS, "server.log"), "a");
    const child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(targetPort) },
      stdio: ["ignore", log, log],
    });
    serverChild = child;
    let exited = null;
    child.once("exit", (code, signal) => { exited = { code, signal }; });
    try {
      await waitFor(async () => {
        if (exited) throw new Error("server.js exited (" + JSON.stringify(exited) + ")");
        response = await fetchManual(options.url);
        return response && response.status === 200;
      }, 30000, 500, "the app server on port " + targetPort);
    } catch (error) {
      fatal("could not start the app server: " + error.message);
    }
    report.server = { started: true, port: targetPort, pid: child.pid, log: path.join(LOGS, "server.log") };
  } else {
    report.server = { started: false, port: targetPort, note: "a server was already listening; its files are checked below" };
  }
  if (!response) fatal("no HTTP response from " + options.url);
  const body = await response.text();
  report.http = {
    url: options.url,
    status: response.status,
    redirected: response.redirected,
    finalUrl: response.url,
    type: response.headers.get("content-type") || "",
    bytes: Buffer.byteLength(body),
  };
  check("HTTP 200 at " + options.url, response.status === 200, 200, String(response.status));
  check("0 redirects", response.status === 200 && response.redirected === false, "200 with no redirect", "status " + response.status + ", redirected " + response.redirected);
  check("served as text/html", /text\/html/i.test(report.http.type), "text/html", report.http.type || "(none)");
  check("served page has the game canvas", /id=["']canvas["']/.test(body), "a canvas element", /id=["']canvas["']/.test(body) ? "present" : "missing");
  if (response.status !== 200) fatal("the acceptance target did not answer 200");

  // The 4231 port can outlive a run and still serve another checkout. Prove
  // that what the browser will load is this working tree, file by file.
  const compared = [];
  for (const file of ["index.html", "style.css", "rtx-renderer.js", "app.js", "fullscreen.js", "game-mode.js",
    "engine-state.js", "rtx-materials.js", "baseq2/pak10.pak"]) {
    const served = await fetchManual(new URL(file, options.url));
    const servedBytes = served ? Buffer.from(await served.arrayBuffer()) : Buffer.alloc(0);
    const localBytes = fs.readFileSync(path.join(ROOT, file));
    const same = served && served.status === 200 && sha256(servedBytes) === sha256(localBytes);
    compared.push({ file, same, servedStatus: served ? served.status : null, servedBytes: servedBytes.length, localBytes: localBytes.length });
    if (!same) {
      fatal("the server at " + options.url + " is not serving this checkout: " + file +
        " differs (served " + (served ? served.status : "no response") + ", " + servedBytes.length +
        " B; local " + localBytes.length + " B). Stop the other server or start node server.js here.");
    }
  }
  report.http.filesMatchCheckout = compared;
  check("server is serving this checkout", compared.every((one) => one.same), "index.html, style.css, rtx-renderer.js, app.js, fullscreen.js identical", compared.map((one) => one.file).join(", ") + " identical");
}

// ---- Display -------------------------------------------------------------

function measureDisplay() {
  const env = { ...process.env, DISPLAY: process.env.DISPLAY || ":0" };
  let raw;
  try {
    raw = execFileSync("xrandr", ["--current"], { encoding: "utf8", env, timeout: 8000, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    fatal("could not measure the box display with xrandr: " + String(error.message || error));
  }
  const lines = raw.split("\n");
  let best = null;
  for (const line of lines) {
    if (!/\bconnected\b/.test(line)) continue;
    const m = /(\d+)x(\d+)\+(\d+)\+(\d+)/.exec(line);
    if (!m) continue;
    const candidate = { width: Number(m[1]), height: Number(m[2]), x: Number(m[3]), y: Number(m[4]), line: line.trim() };
    if (!best || candidate.width * candidate.height > best.width * best.height) best = candidate;
  }
  if (!best) {
    const m = /current (\d+) x (\d+)/.exec(raw);
    if (!m) fatal("xrandr reported no connected output and no current screen size");
    best = { width: Number(m[1]), height: Number(m[2]), x: 0, y: 0, line: m[0] };
  }
  report.display = { ...best, source: "xrandr --current" };
  console.log("  display " + best.width + "x" + best.height + " (" + best.line + ")");
  return { label: best.width + "x" + best.height, width: best.width, height: best.height };
}

// ---- Chrome + CDP --------------------------------------------------------

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = null;
  }
  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("CDP WebSocket error")), { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8")); }
      catch { return; }
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(JSON.stringify(message.error)));
        else entry.resolve(message.result);
        return;
      }
      const list = this.handlers.get(message.method);
      if (list) for (const fn of list) fn(message.params || {});
    });
  }
  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
  }
  send(method, params = {}, timeoutMs = 45000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("CDP " + method + " timed out after " + timeoutMs + " ms"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try { this.ws.close(); } catch { /* already closed */ }
  }
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  fatal("no Chrome/Chromium found (set CHROME_PATH)");
}
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}
async function startChrome() {
  const chromePath = findChrome();
  const debuggingPort = await freePort();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "q2verify-chrome-"));
  const args = [
    "--headless=new",
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=" + debuggingPort,
    "--user-data-dir=" + profile,
    "--window-size=1280,720",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-infobars",
    "--disable-features=Translate,MediaRouter",
    "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-dev-shm-usage",
    "--mute-audio",
    "about:blank",
  ];
  const stdout = fs.openSync(path.join(LOGS, "chrome.log"), "a");
  const stderr = fs.openSync(path.join(LOGS, "chrome.log"), "a");
  const child = spawn(chromePath, args, { stdio: ["ignore", stdout, stderr] });
  chromeChild = { child, profile };
  const base = "http://127.0.0.1:" + debuggingPort;
  await waitFor(async () => {
    if (child.exitCode !== null) throw new Error("Chrome exited with code " + child.exitCode);
    try {
      const response = await fetch(base + "/json/version", { signal: AbortSignal.timeout(2000) });
      return response.ok ? await response.json() : null;
    } catch { return null; }
  }, 30000, 300, "headless Chrome's CDP endpoint");
  report.chrome = { path: chromePath, debuggingPort, headless: true, profile };
  return { base, child };
}
async function connectPage(base) {
  const targets = await fetch(base + "/json/list").then((response) => response.json());
  const page = targets.find((one) => one.type === "page" && one.webSocketDebuggerUrl);
  if (!page) fatal("headless Chrome has no page target to drive");
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  cdp.on("Runtime.consoleAPICalled", (params) => {
    const text = (params.args || []).map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type || "")).join(" ");
    const entry = { type: params.type, text, at: new Date().toISOString() };
    if (params.type === "error" || params.type === "assert") report.consoleErrors.push(entry);
    else if (params.type === "warning") report.consoleWarnings.push(entry);
  });
  cdp.on("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails || {};
    report.pageErrors.push({
      text: details.exception && details.exception.description ? details.exception.description : details.text,
      url: details.url,
      line: details.lineNumber,
      at: new Date().toISOString(),
    });
  });
  cdp.on("Log.entryAdded", (params) => {
    const entry = params.entry || {};
    if (entry.level === "error") {
      const record = { type: "log-error", text: entry.text, source: entry.source, url: entry.url || null, at: new Date().toISOString() };
      // A 404 for an optional probe is not a fatal page error: the required
      // app files are fetched and hashed by ensureServer, and a missing one of
      // those fails boot. Network errors are kept on the record, not hidden.
      if (entry.source === "network" || /Failed to load resource.*404/i.test(entry.text)) report.networkErrors.push(record);
      else report.consoleErrors.push(record);
    } else if (entry.level === "warning") {
      report.consoleWarnings.push({ type: "log-warning", text: entry.text, source: entry.source, at: new Date().toISOString() });
    }
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  // TaskDuration/ScriptDuration of the main thread: the game-mode cost check
  // divides their growth by the frames drawn in the same window.
  await cdp.send("Performance.enable");
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__q2verify = { contextLost: 0, contextLostAt: null, frames: 0 };
      // One rAF callback per drawn frame, the same in both presentations: the
      // counters below are per frame, so a page that draws fewer frames in a
      // window is not credited with cheaper ones.
      (function () { function step() { window.__q2verify.frames++; requestAnimationFrame(step); } requestAnimationFrame(step); })();
      document.addEventListener("DOMContentLoaded", function () {
        var canvas = document.getElementById("canvas");
        if (!canvas) return;
        canvas.addEventListener("webglcontextlost", function () {
          window.__q2verify.contextLost += 1;
          window.__q2verify.contextLostAt = new Date().toISOString();
        }, true);
      });`,
  });
  return cdp;
}

// ---- Page helpers --------------------------------------------------------

async function evaluate(expression, { awaitPromise = false, timeoutMs = 60000 } = {}) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, timeoutMs);
  if (result.exceptionDetails) {
    const text = result.exceptionDetails.exception && result.exceptionDetails.exception.description
      ? result.exceptionDetails.exception.description : result.exceptionDetails.text;
    throw new Error("page evaluation failed: " + text);
  }
  return result.result ? result.result.value : undefined;
}
function state() {
  return evaluate(`(() => {
    const canvas = document.getElementById("canvas");
    let gl = null;
    try { gl = canvas && canvas.getContext("webgl2"); } catch (error) { gl = null; }
    const loading = document.getElementById("loading");
    return {
      readyState: document.readyState,
      canvas: Boolean(canvas),
      gl2: Boolean(gl),
      drawingBuffer: gl ? [gl.drawingBufferWidth, gl.drawingBufferHeight] : null,
      contextLost: gl ? gl.isContextLost() : null,
      rtx: window.quake2RTX && window.quake2RTX.status ? window.quake2RTX.status() : null,
      engine: window.quake2Engine && window.quake2Engine.read ? window.quake2Engine.read() : null,
      startup: Array.isArray(window.quake2StartupArguments) ? window.quake2StartupArguments : null,
      loadingHidden: loading ? loading.hidden : null,
      statusText: document.getElementById("status") ? document.getElementById("status").textContent : "",
      detailText: document.getElementById("detail") ? document.getElementById("detail").textContent : "",
      menuHidden: document.getElementById("menu-layer") ? document.getElementById("menu-layer").hidden : null,
      menuView: (() => { const visible = Array.from(document.querySelectorAll(".menu-view")).find((view) => !view.hidden); return visible ? visible.dataset.view : null; })(),
      menuEntries: Array.from(document.querySelectorAll('.menu-view[data-view="main"] .label')).map((label) => label.textContent.trim()),
      // The band is deleted: this must stay false at every resolution.
      hudExists: Boolean(document.getElementById("hud")),
      q2hud: window.quake2Hud && window.quake2Hud.read ? window.quake2Hud.read() : null,
      crosshair: window.quake2RTX && window.quake2RTX.status ? window.quake2RTX.status().crosshair : null,
      crosshairDraws: window.quake2RTX && window.quake2RTX.status ? window.quake2RTX.status().crosshairDraws : null,
      verify: window.__q2verify || null,
    };
  })()`);
}
async function status() {
  return evaluate("window.quake2RTX.status()");
}
async function waitFrames(count, timeoutMs = 45000) {
  return evaluate(`new Promise((resolve) => {
    let seen = 0, done = false;
    function step() {
      if (done) return;
      seen += 1;
      if (seen >= ${count}) { done = true; resolve(seen); return; }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
    setTimeout(() => { if (!done) { done = true; resolve(seen); } }, ${timeoutMs});
  })`, { awaitPromise: true, timeoutMs: timeoutMs + 10000 });
}
// Escape is the key the page's own interface and the engine both use. A
// trusted CDP Escape can be kept by Chromium (it is the key that leaves
// pointer lock/fullscreen), so it is rebuilt inside the page -- the same way
// control/bridge.mjs sends it -- where the engine's SDL handler reads it like a
// real key. Dispatching on document bubbles into the page's own window handler
// too, so the dark panel's Resume/back path runs as well.
async function pressEscape() {
  await evaluate(`(function () {
    const key = { key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true };
    document.dispatchEvent(new KeyboardEvent("keydown", key));
    document.dispatchEvent(new KeyboardEvent("keyup", key));
    return true;
  })()`, { awaitPromise: false });
}
async function click(selector) {
  return evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.click();
    return true;
  })()`);
}
async function openMenu() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = await state();
    if (now.engine && now.engine.keyDestName === "menu" && now.menuHidden === false) return true;
    await pressEscape();
    await sleep(1500);
    const after = await state();
    if (after.engine && after.engine.keyDestName === "menu" && after.menuHidden === false) return true;
    if (after.engine && after.engine.keyDestName === "menu" && after.menuHidden === true) {
      // The engine is already at its menu; give the page's UI loop a moment.
      await sleep(1500);
      const settled = await state();
      if (settled.menuHidden === false) return true;
    }
  }
  return false;
}
async function resume() {
  if (!(await click('[data-action="resume"]'))) throw new Error("the Resume button is not in the page");
  await waitFor(async () => {
    const now = await state();
    return now.engine && now.engine.keyDestName === "game" && now.menuHidden === true;
  }, 20000, 500, "the game to resume after Resume");
}
// The engine console pauses a single-player game; a command it leaves with the
// menu or console up must be followed by a deliberate return to the game, or
// "no frames" would be recorded as "no weapon".
async function ensureGame(context) {
  let last = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const now = await state();
    last = { keyDest: now.engine && now.engine.keyDestName, menuHidden: now.menuHidden, consoleOpen: now.engine && now.engine.consoleOpen };
    if (now.engine && now.engine.keyDestName === "game" && now.menuHidden === true) return true;
    if (now.menuHidden === false) await click('[data-action="resume"]');
    else await pressEscape();
    await sleep(1200);
  }
  report.notes.push("could not return to the game after " + context + ": " + JSON.stringify(last));
  return false;
}

// ---- Engine console (cvars, r_mode) --------------------------------------

class EngineConsole {
  constructor(cdpBase) {
    this.cdpBase = cdpBase;
    this.control = null;
  }
  async connect() {
    this.control = new QuakeControl({ cdpUrl: this.cdpBase, gameUrlMark: GAME_MARK, timeoutMs: 60000 });
  }
  async reconnect() {
    try { await this.control.close(); } catch { /* already closed */ }
    this.control = null;
    await sleep(1200);
    await this.connect();
  }
  // A command that timed out can leave the engine's console up. A fresh
  // QuakeControl assumes it is down, so its next toggle would close it and type
  // the command into the game. Close it first, from the page's own reading.
  async ensureConsoleClosed() {
    try {
      const now = await state();
      if (now.engine && (now.engine.consoleOpen || now.engine.keyDestName === "console")) {
        await pressEscape();
        await sleep(900);
      }
    } catch { /* the page will report the real failure */ }
  }
  async run(text, timeoutMs = 90000) {
    if (!this.control) await this.connect();
    const now = await state();
    if (!(now.engine && now.engine.keyDestName === "game" && now.menuHidden === true)) {
      // The dark panel keeps the keyboard while it is up, so a console key
      // would never reach the engine: get back to the game first.
      await ensureGame("console command " + text);
    }
    await this.ensureConsoleClosed();
    return withTimeout(this.control.command(text, { tail: 12 }), timeoutMs, "engine console command " + JSON.stringify(text));
  }
  async runUntilEcho(text, attempts = 3) {
    let last = null;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const answer = await this.run(text);
        last = answer;
        if (answer.ran && answer.echoFound) return answer;
      } catch (error) {
        last = error.message;
      }
      await this.reconnect();
    }
    throw new Error("engine console never ran " + JSON.stringify(text) + ": " + JSON.stringify(last));
  }
  async read(name) {
    const pattern = new RegExp('"' + name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"\\s+is\\s+"([^"]*)"');
    let last = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        if (!this.control) await this.connect();
        const now = await state();
        if (!(now.engine && now.engine.keyDestName === "game")) await ensureGame("console read " + name);
        await this.ensureConsoleClosed();
        const answer = await withTimeout(this.control.command(name, { tail: 5 }), 90000, "engine console read " + name);
        for (const line of answer.output || []) {
          const match = pattern.exec(line);
          if (match) return match[1];
        }
        last = answer.reason || "no answer line";
      } catch (error) {
        last = error.message;
      }
      await this.reconnect();
    }
    report.notes.push("could not read cvar " + name + ": " + last);
    return null;
  }
  async set(name, value) {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await this.run(name + " " + value);
        await sleep(800);
        const got = await this.read(name);
        if (got === value) return got;
        last = "read back " + JSON.stringify(got);
      } catch (error) {
        last = error.message;
      }
      await this.reconnect();
    }
    throw new Error("cvar " + name + " would not take " + JSON.stringify(value) + ": " + last);
  }
  async close() {
    try { await this.control.close(); } catch { /* nothing to close */ }
  }
}

// ---- Screenshots ---------------------------------------------------------

async function screenshotBuffer() {
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, 90000);
  return Buffer.from(shot.data, "base64");
}

async function captureBuffer(name, buffer, width, height, meta) {
  const pngWidth = buffer.readUInt32BE(16);
  const pngHeight = buffer.readUInt32BE(20);
  const file = path.join(SHOTS, name);
  await fsp.writeFile(file, buffer);
  const entry = { file: path.relative(ROOT, file), width: pngWidth, height: pngHeight, bytes: buffer.length, ...meta };
  report.screenshots.push(entry);
  check("screenshot " + name, pngWidth === width && pngHeight === height, width + "x" + height, pngWidth + "x" + pngHeight);
  if (pngWidth !== width || pngHeight !== height) fatal("screenshot " + name + " is " + pngWidth + "x" + pngHeight + ", not " + width + "x" + height);
  return entry;
}

async function capture(name, width, height, meta) {
  // The drawing buffer is not preserved: a capture taken between two engine
  // frames is the cleared buffer, and at 2560x1440 that is a black picture
  // (measured on the committed evidence: 2560x1440-performance-weapon.png had
  // a mean luma of 0.1). stableScreenshot retries until the centre is a
  // picture, so a screenshot is the view it claims to be.
  return captureBuffer(name, await stableScreenshot(), width, height, meta);
}

// The engine draws a loading plaque over a black frame for a moment after a
// reload; a screenshot taken then is black and differs from the same view on
// the next boot across the whole frame, which would make a crosshair diff look
// like a hit. Wait until the centre of the frame is a picture, not black.
function centreLuma(buffer) {
  const image = decodePng(buffer);
  const cx = Math.round(image.width / 2), cy = Math.round(image.height / 2);
  let sum = 0, count = 0;
  for (let y = cy - 60; y <= cy + 60; y++) {
    for (let x = cx - 60; x <= cx + 60; x++) {
      const at = (y * image.width + x) * 4;
      sum += 0.2126 * image.data[at] + 0.7152 * image.data[at + 1] + 0.0722 * image.data[at + 2];
      count++;
    }
  }
  return sum / count;
}

async function waitForVisibleScene(label, timeoutMs = 90000) {
  const started = Date.now();
  let mean = 0;
  while (Date.now() - started < timeoutMs) {
    const buffer = await screenshotBuffer();
    mean = centreLuma(buffer);
    if (mean > 8) return { buffer, mean };
    await sleep(1500);
  }
  fatal(label + ": the frame stayed black at the centre (mean luma " + mean.toFixed(1) + ")");
}

// ---- Frame timing --------------------------------------------------------

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const median = n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const p95 = sorted[Math.min(n - 1, Math.ceil(0.95 * n) - 1)];
  const mean = sorted.reduce((sum, one) => sum + one, 0) / n;
  return { count: n, medianMs: median, p95Ms: p95, meanMs: mean, minMs: sorted[0], maxMs: sorted[n - 1] };
}
async function measureFrames(count, timeoutMs = 180000) {
  const samples = await evaluate(`new Promise((resolve) => {
    const times = [];
    let last = 0, done = false;
    function step(now) {
      if (done) return;
      if (last) times.push(now - last);
      last = now;
      if (times.length >= ${count}) { done = true; resolve(times); return; }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
    setTimeout(() => { if (!done) { done = true; resolve(times); } }, ${timeoutMs});
  })`, { awaitPromise: true, timeoutMs: timeoutMs + 10000 });
  return samples;
}
async function frameRound(label, width, height, level, meta) {
  let samples = await measureFrames(options.frames);
  if (samples.length < 10) {
    note(label + ": only " + samples.length + " rAF samples; retrying with a longer window");
    samples = await measureFrames(options.frames, 240000);
  }
  check(label + " frame samples", samples.length >= 10, "at least 10 rAF samples", String(samples.length));
  if (samples.length < 10) fatal(label + ": not enough rAF frames to report a median and p95");
  const frame = stats(samples);
  const renderer = report.renderer || {};
  const software = /swiftshader|llvmpipe|softpipe|software|subzero/i.test(String(renderer.renderer || ""));
  const row = {
    label, width, height, level, mode: MODE_NUMBERS[level],
    renderer: renderer.renderer || null,
    vendor: renderer.vendor || null,
    software,
    ...frame,
    fpsMedian: 1000 / frame.medianMs,
  };
  report.modes.push(row);
  console.log("  " + label + " " + level.padEnd(11) + " median " + frame.medianMs.toFixed(1) +
    " ms  p95 " + frame.p95Ms.toFixed(1) + " ms  (" + row.fpsMedian.toFixed(2) + " fps median)" +
    (software ? " [software]" : ""));
  return row;
}

// ---- Coverage ------------------------------------------------------------

function readPakDirectory(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.toString("latin1", 0, 4) !== "PACK") throw new Error(file + " is not a PAK file");
  const offset = buffer.readInt32LE(4);
  const length = buffer.readInt32LE(8);
  const entries = new Map();
  for (let at = offset; at < offset + length; at += 64) {
    const end = buffer.indexOf(0, at);
    const name = buffer.toString("latin1", at, end);
    entries.set(name, { name, offset: buffer.readInt32LE(at + 56), size: buffer.readInt32LE(at + 60) });
  }
  return { buffer, entries };
}
function bspEntities(pak, map) {
  const entry = pak.entries.get("maps/" + map + ".bsp");
  if (!entry) return null;
  const bsp = pak.buffer.subarray(entry.offset, entry.offset + entry.size);
  const lumpOffset = bsp.readInt32LE(8);
  const lumpLength = bsp.readInt32LE(12);
  return bsp.toString("latin1", lumpOffset, lumpOffset + lumpLength);
}
function pcxDimensions(buffer, offset) {
  const xmin = buffer.readUInt16LE(offset + 4);
  const ymin = buffer.readUInt16LE(offset + 6);
  const xmax = buffer.readUInt16LE(offset + 8);
  const ymax = buffer.readUInt16LE(offset + 10);
  return { width: xmax - xmin + 1, height: ymax - ymin + 1 };
}
function classnames(text) {
  const found = new Set();
  if (!text) return found;
  for (const match of text.matchAll(/"classname"\s+"([A-Za-z0-9_]+)"/g)) found.add(match[1]);
  return found;
}
function buildCoverage() {
  const pak10 = readPakDirectory(path.join(ROOT, "baseq2", "pak10.pak"));
  const pak0 = readPakDirectory(path.join(ROOT, "baseq2", "pak0.pak"));
  const demo1Classes = classnames(bspEntities(pak0, "demo1"));
  const blasterSkinEntry = pak0.entries.get("models/weapons/v_blast/skin.pcx");
  const blasterSkin = blasterSkinEntry ? pcxDimensions(pak0.buffer, blasterSkinEntry.offset) : null;
  // Every model skin in pak0, not just the weapons, so the blaster-skin size
  // claim is checked against monsters and items too.
  const modelSkins = [];
  for (const [entryName, entry] of pak0.entries) {
    if (!/^models\/.*\/skin\.pcx$/.test(entryName)) continue;
    const size = pcxDimensions(pak0.buffer, entry.offset);
    modelSkins.push({ entry: entryName, width: size.width, height: size.height });
  }
  const blasterCollisions = blasterSkin
    ? modelSkins.filter((one) => one.width === blasterSkin.width && one.height === blasterSkin.height && one.entry !== "models/weapons/v_blast/skin.pcx")
    : [];
  const weapons = [];
  const weaponSkins = [];
  for (const [entryName, info] of pak10.entries) {
    const m = /^models\/weapons\/(v_[a-z0-9]+)\/tris\.md2$/.exec(entryName);
    if (!m) continue;
    const known = WEAPON_NAMES[m[1]] || [m[1], null];
    const inHand = m[1] === "v_blast";
    const placed = Boolean(known[1] && demo1Classes.has(known[1]));
    const skinEntry = pak0.entries.get("models/weapons/" + m[1] + "/skin.pcx");
    const skin = skinEntry ? pcxDimensions(pak0.buffer, skinEntry.offset) : null;
    if (skin) weaponSkins.push({ model: m[1], name: known[0], width: skin.width, height: skin.height });
    weapons.push({
      model: m[1], name: known[0], pickupClass: known[1],
      skinSize: skin ? skin.width + "x" + skin.height : null,
      placedInDemo1: placed, inHand,
      covered: inHand || placed,
    });
  }
  const enemies = [];
  for (const [entryName, info] of pak10.entries) {
    const m = /^models\/monsters\/([a-z0-9_]+)\/tris\.md2$/.exec(entryName);
    if (!m) continue;
    const known = ENEMY_NAMES[m[1]] || [m[1], ["monster_" + m[1]]];
    const classes = known[1];
    const present = classes.filter((one) => demo1Classes.has(one));
    enemies.push({
      model: m[1], name: known[0], monsterClasses: classes,
      placedInDemo1: present,
      covered: present.length > 0,
    });
  }
  weapons.sort((a, b) => Number(b.covered) - Number(a.covered) || a.name.localeCompare(b.name));
  enemies.sort((a, b) => Number(b.covered) - Number(a.covered) || a.name.localeCompare(b.name));
  report.coverage = {
    level: "demo1",
    basis: "model assets in baseq2/pak10.pak; covered = present in demo1 (in hand for weapons, placed as a pickup or monster in the BSP entity lump). Enemy visibility in a particular frame is not claimed.",
    blasterSkin,
    blasterSkinSizeCollisions: blasterCollisions,
    modelSkinCount: modelSkins.length,
    weaponSkins,
    weapons,
    enemies,
    weaponsCovered: weapons.filter((one) => one.covered).map((one) => one.name),
    weaponsNotCovered: weapons.filter((one) => !one.covered).map((one) => one.name),
    enemiesCovered: enemies.filter((one) => one.covered).map((one) => one.name),
    enemiesNotCovered: enemies.filter((one) => !one.covered).map((one) => one.name),
  };
  check("pak10 covers 13 weapon models and 7 enemy models",
    weapons.length === 13 && enemies.length === 7,
    "13 weapons, 7 enemies",
    weapons.length + " weapons, " + enemies.length + " enemies");
  const unique = Boolean(blasterSkin) && blasterCollisions.length === 0;
  check("blaster skin size is unique among all pak0 model skins", unique,
    "296x164 used only by models/weapons/v_blast/skin.pcx",
    blasterSkin ? blasterSkin.width + "x" + blasterSkin.height + " checked against " + modelSkins.length +
      " model skins; collisions " + JSON.stringify(blasterCollisions.map((one) => one.entry)) : "blaster skin unreadable");
  if (!unique) fatal("the blaster skin size is not unique; a weapon draw cannot be named by skin size");
  return report.coverage;
}

// ---- Main ---------------------------------------------------------------

let serverChild = null;
let chromeChild = null;
let cdp = null;
let consoleBridge = null;

async function boot(label, url) {
  const loaded = new Promise((resolve) => cdp.on("Page.loadEventFired", resolve));
  await cdp.send("Page.navigate", { url }, 60000);
  await Promise.race([loaded, sleep(30000)]);
  const started = Date.now();
  let snapshot = null;
  try {
    await waitFor(async () => {
      snapshot = await state();
      return snapshot.readyState === "complete" && snapshot.gl2 && snapshot.drawingBuffer &&
        snapshot.drawingBuffer[0] > 0 && snapshot.drawingBuffer[1] > 0 &&
        snapshot.rtx && snapshot.rtx.supported === true && (snapshot.rtx.failures || []).length === 0 &&
        snapshot.engine && snapshot.engine.ok === true && snapshot.loadingHidden === true;
    }, 240000, 1500, "the game to boot");
  } catch (error) {
    const last = snapshot ? JSON.stringify(snapshot).slice(0, 900) : "no state";
    fatal("the game did not boot cleanly: " + error.message + " — last state " + last);
  }
  const bootRecord = {
    label,
    url,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    drawingBuffer: snapshot.drawingBuffer,
    rtx: {
      version: snapshot.rtx.version,
      supported: snapshot.rtx.supported,
      failures: snapshot.rtx.failures,
      worldShaders: snapshot.rtx.worldShaders,
      postShaders: snapshot.rtx.postShaders,
      modelShaders: snapshot.rtx.modelShaders,
      modelReliefShaders: snapshot.rtx.modelReliefShaders,
      skyShaders: snapshot.rtx.skyShaders,
      programs: snapshot.rtx.programs,
    },
    engineRunning: snapshot.engine.ok,
    keyDest: snapshot.engine.keyDestName,
  };
  report.boots.push(bootRecord);
  if (!report.boot) report.boot = bootRecord;
  check(label + ": game booted into a running engine", snapshot.engine.ok === true, "engine memory readable", snapshot.engine.keyDestName || "unreadable");
  check(label + ": dark UI loaded (menu layer present)", snapshot.menuHidden !== null, "a menu layer", snapshot.menuHidden !== null ? "present" : "missing");
  check(label + ": WebGL2 renderer installed", snapshot.gl2 === true, "WebGL2", String(snapshot.gl2));
  check(label + ": RTX shader programs compiled", snapshot.rtx.supported === true && snapshot.rtx.worldShaders > 0 && snapshot.rtx.postShaders > 0,
    "world + post shaders, no failures",
    "world " + snapshot.rtx.worldShaders + ", post " + snapshot.rtx.postShaders + ", model " + snapshot.rtx.modelShaders +
    " (albedo " + snapshot.rtx.modelReliefShaders + "), failures " + JSON.stringify(snapshot.rtx.failures));
  check(label + ": pak10 model shader path active", snapshot.rtx.modelReliefShaders > 0, "at least one albedo-relief model program", String(snapshot.rtx.modelReliefShaders));
  check(label + ": no WebGL context lost during boot", !(snapshot.verify && snapshot.verify.contextLost), "0", String((snapshot.verify && snapshot.verify.contextLost) || 0));

  report.renderer = await evaluate(`(() => {
    const canvas = document.getElementById("canvas");
    const gl = canvas && canvas.getContext("webgl2");
    if (!gl) return null;
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return {
      renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      vendor: info ? gl.getParameter(info.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
      version: gl.getParameter(gl.VERSION),
      shading: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
      webgl2: true,
    };
  })()`);
  check("browser reports a WebGL renderer", Boolean(report.renderer && report.renderer.renderer), "a renderer string", report.renderer ? report.renderer.renderer : "(none)");
  console.log("  renderer " + (report.renderer ? report.renderer.renderer : "(none)"));
}

async function waitDemo1(label) {
  let last = null;
  try {
    await waitFor(async () => {
      const now = await state();
      const engine = now.engine || {};
      const position = engine.position || {};
      const moved = Math.abs(position.x || 0) + Math.abs(position.y || 0) + Math.abs(position.z || 0) > 1;
      // Off persists in localStorage, and Off skips the composite, so
      // postDraws stays 0 even though the scene is drawing: count world draws
      // (or a composite) as "the game is rendering".
      const drawing = now.rtx && (now.rtx.worldDraws > 0 || now.rtx.postDraws > 0);
      last = { keyDest: engine.keyDestName, position, postDraws: now.rtx ? now.rtx.postDraws : null,
        worldDraws: now.rtx ? now.rtx.worldDraws : null, statusText: now.statusText };
      return engine.ok && engine.keyDestName === "game" && moved && drawing && now.menuHidden === true && now.loadingHidden === true;
    }, 150000, 1500, "demo1 to load and draw");
  } catch (error) {
    fatal(label + ": demo1 did not start: " + error.message + " — last " + JSON.stringify(last));
  }
  check(label + ": demo1 running in game", true, "key_dest game, non-zero position, frames drawn", JSON.stringify(last));
  await waitFrames(3);
  await sleep(3000);
}

async function navigateResolution(resolution) {
  const mode = R_MODES[resolution.label];
  if (!mode) fatal("no r_mode for the measured display " + resolution.label + "; add it to R_MODES");
  console.log("\n  resolution " + resolution.label + " (r_mode " + mode + ")");
  // The screen is pinned to the same size as the viewport: headless Chrome
  // otherwise reports an 800x600 screen, and a full-screen request would then
  // resize the page out from under a game-mode frame measurement (measured: a
  // fullscreen game dropped the viewport to 800x544 and shrank the composited
  // area, which is a measurement artifact, not a cheaper frame).
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: resolution.width, height: resolution.height, deviceScaleFactor: 1, mobile: false,
    screenWidth: resolution.width, screenHeight: resolution.height,
  });
  // The engine applies r_mode from the page's query string at start-up; this
  // is a real boot at the requested resolution, not a resize after the fact.
  const separator = options.url.includes("?") ? "&" : "?";
  const url = options.url + separator + "+set&r_mode&" + mode + "&+map&demo1";
  await boot(resolution.label, url);
  let seen = null;
  await waitFor(async () => {
    const now = await state();
    seen = now.drawingBuffer;
    return seen && seen[0] === resolution.width && seen[1] === resolution.height;
  }, 30000, 1000, "the drawing buffer to be " + resolution.label);
  const now = await state();
  check("render resolution " + resolution.label + " at boot", now.rtx && now.rtx.supported === true && (now.rtx.failures || []).length === 0,
    "drawing buffer " + resolution.label + " with no renderer failure",
    "drawing buffer " + seen.join("x") + ", failures " + JSON.stringify(now.rtx ? now.rtx.failures : null));
  if (!(seen[0] === resolution.width && seen[1] === resolution.height)) {
    fatal("the page booted at " + seen.join("x") + ", not " + resolution.label);
  }
  await consoleBridge.reconnect();
  await waitFrames(3);
}

async function setLighting(level) {
  const found = await click('[data-lighting="' + level + '"]');
  if (!found) fatal("the " + level + " lighting button is missing");
  await sleep(600);
  const now = await status();
  const expected = MODE_NUMBERS[level];
  const ok = level === "off" ? now.mode === 0 && now.enabled === false
    : now.mode === expected && now.quality === level && now.enabled === true;
  check("lighting " + level + " applied", ok, "mode " + expected + (level === "off" ? " (Off)" : " (" + level + ")"),
    "mode " + now.mode + ", quality " + now.quality + ", enabled " + now.enabled);
  if (!ok) fatal("lighting " + level + " did not apply");
  await waitFrames(2);
}

async function readClGun(label) {
  console.log("\n  " + label + " cl_gun");
  if (!(await ensureGame("before the cl_gun read"))) fatal(label + ": the game is not in game before the cl_gun read");
  await sleep(3000);
  await waitFrames(3);
  const clGun = await consoleBridge.read("cl_gun");
  report.clGun = { value: clGun, at: label };
  const gunOk = check(label + ": cl_gun is 1", clGun === "1", "1", String(clGun));
  if (!gunOk) fatal(label + ": cl_gun is " + JSON.stringify(clGun) + ", not 1 — no weapon is drawn in hand");
  if (!(await ensureGame("cl_gun check"))) fatal(label + ": the game did not resume after reading cl_gun");
}

// Start demo1 again through the engine's own console: the death camera and a
// finished demo both leave a player that draws no weapon, and the measurement
// is of the app, not of the game's state.
async function restartDemo1(label) {
  if (!(await ensureGame("restarting demo1"))) fatal(label + ": the game is not in game to restart demo1");
  await consoleBridge.runUntilEcho("map demo1");
  await sleep(1200);
  await waitDemo1(label);
}

async function weaponDrawCheck(label) {
  console.log("\n  " + label + " weapon draw");
  if (!(await ensureGame("weapon draw"))) fatal(label + ": the game is not in game for the weapon-draw check");
  // A dead player submits no view weapon whatever cl_gun says; the death
  // camera is the game's state, not a presentation bug. Restart demo1 for the
  // measurement the way runModes does for its captures.
  {
    const now = await state();
    if (now.engine && now.engine.dead) {
      note(label + ": player was dead before the weapon-draw check; restarting demo1");
      await restartDemo1(label);
    }
  }

  // Put the composite back on: Off persists in localStorage across reloads and
  // skips the composite, so postDraws would not count frames on this boot.
  await setLighting("performance");

  // The view weapon is an MD2 model. The renderer records every texture size
  // bound by a model-shader draw. The blaster's skin is 296x164 and that size
  // is checked unique among all pak0 model skins, so a model draw binding it is
  // the v_blast view model — not a monster, item or wall texture.
  const skins = report.coverage.weaponSkins;
  if (!skins.length) fatal("could not read any weapon skin from pak0");
  const blaster = report.coverage.blasterSkin;
  if (!blaster) fatal("could not read the blaster skin from pak0");
  const skinKey = blaster.width + "x" + blaster.height;
  const candidates = [...new Set(skins.filter((one) => one.width + "x" + one.height === skinKey).map((one) => one.name))];
  const before = await status();
  await waitFrames(2);
  await sleep(5000);
  await waitFrames(2);
  const after = await status();
  const observed = after.modelTextureDraws || {};
  const previous = before.modelTextureDraws || {};
  const gunDraws = Math.max(0, (observed[skinKey] || 0) - (previous[skinKey] || 0));
  const frames = after.postDraws - before.postDraws;
  const modelDraws = after.modelDraws - before.modelDraws;
  const perFrame = frames > 0 ? gunDraws / frames : null;
  const record = {
    label,
    clGun: "1 (read on the 1280x720 boot; same app start-up line on this boot)",
    viewWeaponSkin: skinKey,
    viewWeaponCandidates: candidates,
    frames,
    modelDraws,
    modelDrawsPerFrame: frames > 0 ? modelDraws / frames : null,
    weaponSkinDraws: gunDraws,
    weaponSkinDrawsPerFrame: perFrame,
    modelTextureDraws: observed,
    lastModelSkinDraws: after.lastModelSkinDraws || {},
    method: "counted model-shader draws binding the blaster's 296x164 skin (unique among all 96 pak0 model skins), with cl_gun 1",
  };
  report.weaponDraws.push(record);
  if (!report.weaponDraw) report.weaponDraw = record;
  check(label + ": a weapon draw is submitted", frames > 0 && gunDraws > 0 && perFrame !== null && perFrame >= 0.5,
    "a model draw binds the unique blaster skin every frame",
    gunDraws + " draws of " + skinKey + " (" + candidates.join("/") + ") over " + frames + " frames (" +
    (perFrame === null ? "n/a" : perFrame.toFixed(2)) + "/frame); last-model sizes seen " +
    JSON.stringify(Object.keys(after.lastModelSkinDraws || {}).sort()));
  if (!(frames > 0 && gunDraws > 0 && perFrame !== null && perFrame >= 0.5)) {
    fatal(label + ": no weapon draw was proven: " + gunDraws + " draws of the " + skinKey + " blaster skin over " + frames + " frames");
  }
}

// The new HUD: it must be on screen in game, its health number must be the one
// the engine's own status bar carries (read independently with the repo's
// reader), and it must show the ammo of a weapon that has ammo.
// After a reload the console bridge's page target is stale; `waitDemo1` is
// what every other capture path uses to know the level is up again.
async function animateDemo1(label) {
  try {
    await waitFor(async () => {
      const now = await state();
      return now.engine && now.engine.ok && now.engine.keyDestName === "game" && now.menuHidden === true &&
        now.rtx && (now.rtx.worldDraws > 0 || now.rtx.postDraws > 0);
    }, 90000, 1000, "the new level to draw");
  } catch (error) {
    note(label + ": the new level did not draw cleanly: " + error.message);
  }
}

// (a) The old #hud band is gone from the DOM. (b) The engine's own status bar
// draws readable health and ammo digits inside the canvas's bottom band.
// (c) Nothing in the page paints over that band: the band is compared pixel
// for pixel with the whole page interface hidden, and the top element under
// sample points in the band is read out by name.
//
// The ammo number needs a weapon with ammo in hand (the blaster shows no ammo
// count), so the engine's console gives one. `give all` is deliberately short:
// the console pauses the game and every typed character costs a frame on the
// software renderer. At 2560x1440 the console visit is made at a 1280x720
// viewport (the engine keeps its 2560x1440 drawing buffer) with a longer
// budget, which is what the previous run's ammo-arming step needed.
async function statusBarCheck(resolution) {
  const label = resolution.label;
  console.log("\n  " + label + " engine status bar");
  if (!(await ensureGame("the status bar check"))) fatal(label + ": the game is not in game for the status bar check");
  await sleep(1500);
  let now = await state();
  // A dead player's bar is the death camera's: restart the level before
  // reading it, and keep the player alive for the ammo read below.
  if (now.engine && now.engine.dead) {
    note(label + ": player was dead before the status bar check; restarting demo1");
    await restartDemo1(label);
    now = await state();
  }
  check(label + ": no #hud band element exists in the DOM", now.hudExists === false,
    "no element with id=hud", now.hudExists ? "#hud is still in the document" : "#hud absent");

  const armBudget = label === "2560x1440" ? 600000 : 180000;
  let armed = false;
  let armError = null;
  for (let attempt = 0; attempt < 2 && !armed; attempt++) {
    try {
      if (label === "2560x1440") {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
        await sleep(600);
      }
      const command = attempt === 0 ? "sv_cheats 1;give all" : "give all;use shotgun";
      const answer = await consoleBridge.run(command, armBudget);
      armed = Boolean(answer && answer.echoFound);
      if (!armed) armError = JSON.stringify({ reason: answer && answer.reason, output: answer && answer.output });
    } catch (error) {
      armError = error.message;
    } finally {
      if (label === "2560x1440") {
        await cdp.send("Emulation.setDeviceMetricsOverride", { width: resolution.width, height: resolution.height, deviceScaleFactor: 1, mobile: false });
        await sleep(1500);
      }
    }
    if (!armed) {
      note(label + ": arming attempt " + (attempt + 1) + " did not land (" + armError + ")");
      await consoleBridge.reconnect();
    }
  }
  if (!armed) note(label + ": the console never confirmed the weapon hand-off (" + armError + ")");
  if (!(await ensureGame("after arming a weapon with ammo"))) {
    fatal(label + ": the game did not resume after the weapon hand-off (the status bar cannot be read behind the engine menu)");
  }
  // The bar now carries an ammo number the reader has not seen before; ask it
  // to find every field again instead of waiting for its own sixteenth read.
  await evaluate("window.quake2Hud && window.quake2Hud.rediscover ? window.quake2Hud.rediscover() : null");

  // Two independent readings of the same bottom band: the repository's
  // canvas-pixels reader (with per-glyph scores), and the page's own reader
  // that lives inside the renderer. Both read the engine's pixels, not the DOM.
  let strip = null;
  let reading = null;
  let ammoReading = null;
  let page = null;
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    if (!(await ensureGame("the status bar read"))) continue;
    try {
      // 2560x1440 on SwiftShader runs at ~1.4 fps, so a 400 ms wait can fall
      // between two frames and the strip would be reported as "no frame".
      // Longer than the slowest frame this software renderer produces: at
      // 2560x1440 the median is ~1.4 s and the p95 over 3 s, and a read that
      // lands with no frame in its window returns nothing (measured: one run's
      // 2500 ms window missed a frame on a 2560-px boot).
      strip = await canvasStrip(consoleBridge.control, { band: 40, waitMs: label === "2560x1440" ? 12000 : 6000 });
      if (strip) {
        reading = readHealth(strip.png, strip.readOptions);
        const health = reading.healthReading;
        const candidates = (reading.numbers || []).filter(function (number) {
          return number.family === "num" && number.value > 0 && number.score >= 0.65 &&
            (!health || number.value !== health.value || number.right !== health.right);
        });
        ammoReading = candidates.length ? candidates[candidates.length - 1] : null;
      }
    } catch (error) {
      note(label + ": the status bar could not be read from the canvas (" + error.message + ")");
    }
    now = await state();
    page = now.q2hud || {};
    const haveHealth = (reading && typeof reading.health === "number" && reading.health > 0) || (typeof page.health === "number" && page.health > 0);
    const haveAmmo = (ammoReading && ammoReading.value > 0) || (typeof page.ammo === "number" && page.ammo > 0);
    if (haveHealth && haveAmmo) break;
    if (i === 8) await evaluate("window.quake2Hud && window.quake2Hud.rediscover ? window.quake2Hud.rediscover() : null");
  }
  const independentHealth = reading ? reading.health : null;
  const health = typeof independentHealth === "number" && independentHealth > 0 ? independentHealth : (page.health || null);
  const ammo = ammoReading ? ammoReading.value : (page.ammo || null);
  check(label + ": the engine status bar's health digit is readable in the canvas bottom band",
    typeof health === "number" && health > 0,
    "a health number read from the bottom 40 canvas rows",
    "health " + health + " (canvas reader " + independentHealth + " at score " +
      (reading && reading.healthReading ? reading.healthReading.score.toFixed(3) : "n/a") + ", page reader " + page.health + ")");
  check(label + ": the engine status bar's ammo digit is readable in the canvas bottom band",
    typeof ammo === "number" && ammo > 0,
    "an ammo number read from the bottom 40 canvas rows",
    "ammo " + ammo + " (canvas reader " + (ammoReading ? ammoReading.value + " at score " + ammoReading.score.toFixed(3) : "not found") + ", page reader " + page.ammo + ")");
  const stripImage = strip ? decodePng(strip.png) : null;
  check(label + ": the status bar digits are inside the canvas bottom band",
    Boolean(strip && strip.canvasHeight === resolution.height && stripImage && stripImage.height === 40 &&
      reading && (reading.numbers || []).every(function (number) { return number.y >= 0 && number.y < 40; })),
    "both numbers inside the bottom 40 rows of a " + resolution.height + "-px canvas",
    strip ? "strip " + (stripImage ? stripImage.width + "x" + stripImage.height : "unreadable") + " from a " +
      strip.canvasHeight + "-px canvas; number rows " +
      JSON.stringify((reading && reading.numbers || []).map(function (number) { return number.y; })) : "no canvas strip");

  // (c) Nothing in the page paints over the band. The exact check is the DOM:
  // every visible element whose painted box intersects the canvas's bottom 40
  // rows is listed, and there must be none; a point hit-test under sample rows
  // catches anything the enumeration might miss. A second capture with the
  // whole page interface hidden is kept as a diagnostic, but it cannot be the
  // pass condition here: Quake 2's status bar is translucent and this build has
  // no console pause command, so the world behind the bar changes between two
  // captures for reasons that are not the page (measured: ~10k of 51,200 band
  // pixels, spread evenly over every row, with no interface element in the
  // band).
  const withUi = await capture(label + "-statusbar.png", resolution.width, resolution.height,
    { view: "the engine's own status bar in the canvas bottom band, health and ammo readable", resolution: label,
      health: health, ammo: ammo });
  const uiState = await evaluate(`(() => {
    window.__bandUi = [];
    for (const element of [document.getElementById("ui"), document.getElementById("fullscreen-button"),
      document.getElementById("fullscreen-hint"), document.getElementById("loading")]) {
      if (!element) continue;
      window.__bandUi.push([element.id, element.style.visibility]);
      element.style.visibility = "hidden";
    }
    return window.__bandUi.length;
  })()`);
  await sleep(600);
  const withoutUiBuffer = await screenshotBuffer();
  await evaluate(`(() => {
    for (const [id, visibility] of window.__bandUi || []) {
      const element = document.getElementById(id);
      if (element) element.style.visibility = visibility || "";
    }
    return true;
  })()`);
  const bandFile = path.join(SHOTS, label + "-statusbar-no-page-ui.png");
  await fsp.writeFile(bandFile, withoutUiBuffer);
  report.screenshots.push({ file: path.relative(ROOT, bandFile), width: resolution.width, height: resolution.height,
    bytes: withoutUiBuffer.length, view: "the same band with every page interface element hidden (diagnostic; the engine bar is translucent)", resolution: label });
  const withImage = readPngEntry(withUi);
  const withoutImage = decodePng(withoutUiBuffer);
  const bandPixels = compareBand(withImage, withoutImage, 40);
  const overlays = await evaluate(`(() => {
    const canvas = document.getElementById("canvas");
    if (!canvas) return null;
    const box = canvas.getBoundingClientRect();
    const top = Math.max(0, box.bottom - 40);
    const transparent = (colour) => !colour || colour === "transparent" || /rgba?\\(0, 0, 0, 0\\)/.test(colour);
    const paints = (element, cs) => {
      if (element.hidden || cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
      if (!transparent(cs.backgroundColor)) return true;
      if (!transparent(cs.backgroundImage) && cs.backgroundImage !== "none") return true;
      if (cs.boxShadow && cs.boxShadow !== "none") return true;
      for (const side of ["Top", "Right", "Bottom", "Left"]) {
        if (parseFloat(cs["border" + side + "Width"]) > 0 && !transparent(cs["border" + side + "Color"])) return true;
      }
      if (!transparent(cs.color) && Array.from(element.childNodes).some(function (node) {
        return node.nodeType === 3 && node.textContent.trim() !== "";
      })) return true;
      return false;
    };
    const record = (element, cs) => {
      const rect = element.getBoundingClientRect();
      return { id: element.id || null, tag: element.tagName.toLowerCase(), className: String(element.className || ""),
        rect: [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)],
        background: cs.backgroundColor, colour: cs.color };
    };
    const found = new Map();
    for (const element of document.querySelectorAll("body *")) {
      if (element === canvas || element.id === "ui") continue;
      const rect = element.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.bottom <= top || rect.top >= box.bottom || rect.right <= box.left || rect.left >= box.right) continue;
      const cs = getComputedStyle(element);
      if (paints(element, cs)) found.set(element.id || element.tagName + "." + String(element.className || ""), record(element, cs));
    }
    const pointHits = new Map();
    for (let x = box.left + 4; x < box.right - 4; x += Math.max(8, Math.floor(box.width / 24))) {
      for (const y of [top + 4, Math.round((top + box.bottom) / 2), box.bottom - 4]) {
        for (const element of document.elementsFromPoint(x, y)) {
          if (element === canvas || element === document.body || element === document.documentElement || element.id === "ui") continue;
          const rect = element.getBoundingClientRect();
          if (rect.bottom <= top || rect.top >= box.bottom || rect.width <= 0 || rect.height <= 0) continue;
          const cs = getComputedStyle(element);
          if (paints(element, cs)) pointHits.set(element.id || element.tagName, record(element, cs));
        }
      }
    }
    return { bandTop: Math.round(top), canvasBottom: Math.round(box.bottom), bandColumns: Math.round(box.width),
      elements: Array.from(found.values()), pointHits: Array.from(pointHits.values()) };
  })()`);
  check(label + ": no page element paints over the canvas bottom band",
    Boolean(overlays) && overlays.elements.length === 0 && overlays.pointHits.length === 0,
    "no visible page element intersects the canvas's bottom 40 rows",
    "elements in band " + JSON.stringify(overlays ? overlays.elements : null) + "; point hits " +
      JSON.stringify(overlays ? overlays.pointHits : null) + "; " + bandPixels.different + " of " + bandPixels.total +
      " band pixels changed between the two diagnostic captures (the engine's translucent bar over a live world)");
  report.statusBar = report.statusBar || {};
  report.statusBar[label] = { hudElement: now.hudExists, strip: strip ? { canvasWidth: strip.canvasWidth,
      canvasHeight: strip.canvasHeight, band: stripImage ? stripImage.height : null } : null,
    health: health, ammo: ammo, canvasHealth: independentHealth, pageReader: page,
    numbers: reading ? (reading.numbers || []).map(function (number) {
      return { value: number.value, family: number.family, x: number.x, right: number.right, y: number.y, score: Number(number.score.toFixed(3)) };
    }) : null,
    bandPixels: bandPixels, overlays: overlays, uiHiddenForComparison: uiState };
  await ensureGame("after the status bar check");
}

// Pixels in the canvas's bottom `band` rows that differ between two frames.
function compareBand(a, b, band) {
  const width = Math.min(a.width, b.width);
  const rowStart = Math.max(0, a.height - band);
  let total = 0, different = 0;
  for (let y = rowStart; y < Math.min(a.height, b.height); y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * a.width + x) * 4;
      const bt = (y * b.width + x) * 4;
      total++;
      if (a.data[at] !== b.data[bt] || a.data[at + 1] !== b.data[bt + 1] || a.data[at + 2] !== b.data[bt + 2]) different++;
    }
  }
  return { total, different, ratio: total ? different / total : 1 };
}

// One crosshair state at one background, as its own boot. The cvar and the
// brightness are on the engine's start-up line, so no console is opened and
// the camera is never nudged by a typed key. The bright pair lifts the same
// demo1 spawn with the engine's own colour intensity at its menu maximum; the
// on/off boots then share the spawn camera.
// The dark pair sets the engine's menu defaults explicitly, because a previous
// bright boot's cvars are written into config.cfg and would otherwise carry
// the 5/5 brightness into the next resolution's "dark" pair (measured: the
// 2560 dark pair booted at background luma 139 instead of the spawn's ~49).
// The simulation is frozen on the start-up line (see crosshairBoot), so both
// pairs are the map's spawn, whose camera is the same at 1280x720 and
// 2560x1440. Measured on that frozen spawn in a probe of four boots: the menu
// defaults give a background luma median of 44.5 with 59 of 1089 centre-window
// pixels at or above 100, and the menu maximum (intensity 5, overbrights 2)
// gives 102.3 with 572 of 1089 -- enough lit pixels behind the cross for the
// "brighter background" check, while staying far enough below the bone tint
// (#ddb589, luma 186) that the per-channel blend still has contrast to solve
// an alpha from. An earlier version let the demo play for ten seconds before
// freezing; the camera then depended on how many frames the software renderer
// managed, and the bright pair once landed on a wall at luma 48 with no pixel
// above 100, which is what killed that version of the check.
const DARK_STARTUP = "&+set&gl3_intensity&2.0&+set&gl3_overbrightbits&1.3";
const BRIGHT_STARTUP = "&+set&gl3_intensity&5&+set&gl3_overbrightbits&2";

async function stableScreenshot() {
  let buffer = await screenshotBuffer();
  // A black frame here is the engine between frames or its loading plaque;
  // retry before treating it as the picture under test.
  for (let attempt = 0; attempt < 3 && centreLuma(buffer) < 5; attempt++) {
    await sleep(2000);
    buffer = await screenshotBuffer();
  }
  return buffer;
}

async function crosshairBoot(resolution, name, crosshair, bright, options = {}) {
  const label = resolution.label;
  const suffix = crosshair === "0" ? "-off" : "";
  const brightness = bright ? BRIGHT_STARTUP : DARK_STARTUP;
  // `timescale 0` is on the engine's start-up line, not only sent to its
  // console later: the demo1 camera is the map's spawn (measured at
  // 128.06, -319.94, 46.19, yaw 135 in every boot) only until the demo starts
  // playing, and at 2560x1440 the first seconds of playback are enough for the
  // two captures to land in different parts of the level. A frozen first frame
  // makes the dark and bright pairs the same picture at every boot; the
  // console's own `timescale 0` below stays as a guard for a browser that
  // dropped the start-up cvar.
  await reloadGame(resolutionUrl(resolution, "+set&crosshair&" + crosshair + "&+set&timescale&0" + brightness),
    label + " crosshair " + name + " " + crosshair);
  if (!(await ensureGame("crosshair " + name + " " + crosshair + " capture"))) {
    fatal(label + ": the game did not resume for the crosshair-" + name + " " + crosshair + " capture");
  }
  await waitFrames(3);
  await waitForVisibleScene(label + " crosshair-" + name + " " + crosshair + " frame");
  // The engine's loading plaque fades out a moment after the first picture;
  // let it finish so the capture is the player's view, not the plaque.
  await sleep(10000);
  // Freeze the simulation, not the renderer: at 2560x1440 two frames span
  // seconds and the moving scene was measured as 1504 differing pixels around
  // the cross. A frozen scene makes the on and off pictures the same picture
  // apart from the crosshair itself. The next boot reloads, which restores
  // timescale; the check's own final reload does the same for the suite.
  if (options.freeze !== false) {
    await consoleBridge.runUntilEcho("timescale 0");
    if (!(await ensureGame("freezing the demo for the crosshair capture"))) {
      fatal(label + ": the game did not resume with the demo frozen for " + name + " / crosshair " + crosshair);
    }
    await sleep(900);
  }
  const view = bright
    ? "the demo1 spawn with colour intensity 5 (a brighter scene, same camera)"
    : "engine default at the demo1 spawn";
  const buffer = await stableScreenshot();
  const entry = await captureBuffer(label + "-crosshair-" + name + suffix + ".png", buffer, resolution.width, resolution.height,
    { view: crosshair === "1"
        ? "the crosshair at the centre of the in-game view over a " + name + " background"
        : "the same view with crosshair 0; no cross at the centre",
      resolution: label, crosshair, crosshairScale: "3", centreLuma: Math.round(centreLuma(buffer)), background: view });
  const drawsBefore = (await state()).crosshairDraws;
  await waitFrames(2);
  const draws = (await state()).crosshairDraws - drawsBefore;
  return { image: decodePng(buffer), entry, draws, centreLuma: Math.round(centreLuma(buffer)) };
}

async function crosshairPair(resolution, name, bright) {
  const on = await crosshairBoot(resolution, name, "1", bright);
  // The off frame the opacity is solved from is taken in the *same* boot, by
  // hiding the cross through the renderer's own alpha. Two boots start the
  // demo at different world states, and at 2560x1440 the moving scene between
  // them was once solved as an 0.85 opacity; the a/b pair below is one scene.
  const shown = await state();
  const alpha = shown && shown.crosshair ? shown.crosshair.alpha : 0.45;
  await evaluate("window.quake2RTX.crosshair({ alpha: 0 })");
  await waitFrames(2);
  const offBuffer = await stableScreenshot();
  const offEntry = await captureBuffer(resolution.label + "-crosshair-" + name + "-alpha0.png", offBuffer,
    resolution.width, resolution.height,
    { view: "the same view with the crosshair hidden by its own alpha (one scene, one camera)",
      resolution: resolution.label, crosshair: "hidden (alpha 0)", crosshairScale: "3",
      centreLuma: Math.round(centreLuma(offBuffer)) });
  await evaluate("window.quake2RTX.crosshair({ alpha: " + alpha + " })");
  await waitFrames(2);
  // The crosshair-0 boot is kept for the engine's own draw counter: it is what
  // proves `crosshair 0` submits no draw at all.
  const engineOff = await crosshairBoot(resolution, name, "0", bright);
  return { on: on.image, off: decodePng(offBuffer), onEntry: on.entry, offEntry,
    engineOff: engineOff.image, engineOffEntry: engineOff.entry,
    centreLumaOn: on.centreLuma, centreLumaOff: Math.round(centreLuma(offBuffer)),
    onDraws: on.draws, offDraws: engineOff.draws };
}

async function crosshairPresentationCheck(resolution) {
  const label = resolution.label;
  console.log("\n  " + label + " crosshair presentation");
  if (!(await ensureGame("the crosshair presentation check"))) fatal(label + ": the game is not in game for the crosshair check");
  // The app's own start-up line, read from the page: the acceptance check for
  // "crosshair 1" and "crosshair_scale 3" does not need a console visit (the
  // engine's own draw counter and the measured 21px cross prove they took
  // effect; the line proves the defaults were handed to the engine).
  const startup = (await state()).startup || [];
  const startupPairs = [];
  for (let i = 0; i + 2 < startup.length; i++) {
    if (startup[i] === "+set" || startup[i] === "set") startupPairs.push([startup[i + 1], startup[i + 2]]);
  }
  const startupValue = (name) => {
    let value = null;
    for (const pair of startupPairs) if (pair[0] === name) value = pair[1];
    return value;
  };
  const crosshairRead = startupValue("crosshair");
  const scaleRead = startupValue("crosshair_scale");
  check(label + ": the app starts the engine with crosshair 1", crosshairRead === "1", "crosshair 1", String(crosshairRead));
  check(label + ": the app starts the engine with crosshair_scale 3", scaleRead === "3", "crosshair_scale 3", String(scaleRead));

  // The game palette's rusted amber and bone, and the tint the running page
  // reports. Checked once: the tint must be a game colour, not a new asset.
  const palette = paletteTintFromPak();
  if (!palette) fatal(label + ": could not read pics/colormap.pcx from baseq2/pak0.pak; the crosshair tint cannot be tied to the game palette");
  const tint = palette.tint;
  if (!report.presentation) report.presentation = {};
  if (!report.presentation.palette) {
    const reported = (await state()).crosshair;
    const alphaStart = startupValue("q2_crosshair_alpha");
    const tintStart = startupValue("q2_crosshair_tint");
    const tintHex = tint.map((one) => one.toString(16).padStart(2, "0")).join("");
    check("crosshair tint is the game palette's rusted amber blended with bone (#" + tintHex + ")",
      Boolean(reported) && JSON.stringify(reported.tint) === JSON.stringify(tint) &&
        alphaStart === "0.45" && tintStart === tintHex,
      "tint " + JSON.stringify(tint) + " from pics/colormap.pcx entries 52 (" + JSON.stringify(palette.amber) +
        ") and 251 (" + JSON.stringify(palette.bone) + "), started as q2_crosshair_alpha 0.45 / q2_crosshair_tint " + tintHex,
      (reported ? JSON.stringify(reported.tint) + " (" + reported.tintHex + ")" : "window.quake2RTX.status().crosshair is missing") +
        "; start-up q2_crosshair_alpha " + alphaStart + ", q2_crosshair_tint " + tintStart);
    report.presentation.palette = { ...palette, reported, alphaStart, tintStart };
  }

  // Two background brightnesses at the same spawn: the dark default view, and
  // the same spot with the engine's colour intensity and overbrights at their
  // menu maximums, which lifts the scene behind the crosshair without moving
  // the camera (so both boots see the same geometry).
  const dark = await crosshairPair(resolution, "dark", false);
  const bright = await crosshairPair(resolution, "bright", true);
  // The 1280x720 dark pair gives a clean 72-pixel cross pattern; the 2560x1440
  // pair is measured at those same screen offsets. The crosshair is the
  // engine's own picture at the screen centre, so the pattern is one geometry;
  // selecting from the 2560 on/off difference alone let the animated scene's
  // noise in (measured: 184 selected pixels in a 33x33 box, and a bright-alpha
  // 0.773, on a run whose own dark pair was otherwise clean).
  const savedPattern = report.presentation ? report.presentation.crosshairPattern : null;
  const darkMeasure = measureCrosshair(dark.on, dark.off, tint, savedPattern);
  const brightMeasure = measureCrosshair(bright.on, bright.off, tint, savedPattern || darkMeasure.offsets);
  if (!report.presentation.crosshairPattern) report.presentation.crosshairPattern = darkMeasure.offsets;

  // The crosshair off/on comparison: a compact 21px cluster at the centre on
  // the dark pair (the engine's scale 3), and the same arms brighter than the
  // ring; crosshair 0 leaves no cross at all.
  const darkDiff = centreDiff(dark.off, dark.on, 20, 25);
  const onScore = crosshairScore(dark.on);
  const offScore = crosshairScore(dark.off);
  // The bright background is close to the tint in some channels, so the same
  // difference is smaller there; a lower threshold still isolates the cross.
  const brightDiff = centreDiff(bright.off, bright.on, 20, 10);
  const brightOnScore = crosshairScore(bright.on);
  const brightOffScore = crosshairScore(bright.off);
  check(label + ": the engine's crosshair is visible in the centre of the frame",
    darkDiff.count >= 30 && darkDiff.count <= 1500 && darkDiff.width >= 15 && darkDiff.width <= 60 &&
      darkDiff.height >= 15 && darkDiff.height <= 60 &&
      Math.abs((darkDiff.minX + darkDiff.maxX) / 2 - darkDiff.cx) <= 4 &&
      Math.abs((darkDiff.minY + darkDiff.maxY) / 2 - darkDiff.cy) <= 4 &&
      // The arm-vs-ring contrast depends on the scene behind the cross: at
      // 1280x720 the dark spawn gives 68.5 on / 15.4 off, at 2560x1440 the
      // spawn is brighter (background luma ~85) and the same cross gives 33.2
      // on / 18.7 off. The cluster/centring and the measured alpha separate a
      // real cross from a missing one; these floors are what a drawn 21px,
      // half-transparent cross clears over either background.
      onScore.score >= 25 && onScore.score - offScore.score >= 10,
    "a compact cross-shaped cluster at the centre (15-60px), brighter than its ring",
    darkDiff.count + " differing pixels, bbox " + (darkDiff.width + "x" + darkDiff.height) + " at " +
      (darkDiff.minX + "," + darkDiff.minY) + " (centre " + darkDiff.cx + "," + darkDiff.cy + "); cross score on " +
      onScore.score.toFixed(1) + ", off " + offScore.score.toFixed(1));
  check(label + ": crosshair 0 draws no cross in either background",
    dark.offDraws === 0 && bright.offDraws === 0 && dark.onDraws > 0 && bright.onDraws > 0 &&
      darkDiff.count > 30 && brightDiff.count > 30,
    "the engine submits no crosshair draw with crosshair 0 and does with crosshair 1, on both backgrounds",
    "crosshair draws over two frames: on " + dark.onDraws + " dark / " + bright.onDraws + " bright, off " +
      dark.offDraws + " dark / " + bright.offDraws + " bright; on/off differences " + darkDiff.count +
      " dark / " + brightDiff.count + " bright pixels; arm/ring scores off " + offScore.score.toFixed(1) + " dark / " +
      brightOffScore.score.toFixed(1) + " bright");
  check(label + ": the crosshair keeps the engine's 21px scale-3 size",
    darkMeasure.crossBounds.width >= 15 && darkMeasure.crossBounds.width <= 30 &&
      darkMeasure.crossBounds.height >= 15 && darkMeasure.crossBounds.height <= 30,
    "a 15-30px cross (21px at crosshair_scale 3)",
    darkMeasure.crossBounds.width + "x" + darkMeasure.crossBounds.height + " from the " +
      darkMeasure.samples + " cross pixels");

  // (d) The measured opacity and the blend itself, over a dark and a bright
  // background. The full-opacity colour is the game palette tint above.
  // The dark spawn is the one animated background in the pair (monsters and
  // lights move between the two boots), so its per-pixel background differs a
  // little and biases the solved alpha up (measured 0.551-0.679 across runs);
  // the bright pair, a static lit wall, carries the +/- 0.12 bound. The
  // per-pixel blend test below still requires every dark-pair channel to lie
  // between its background and the tint.
  check(label + ": the crosshair's measured alpha is about 0.5 over a dark background",
    darkMeasure.samples >= 40 && darkMeasure.alpha !== null && Math.abs(darkMeasure.alpha - 0.5) <= 0.2,
    "0.5 +/- 0.2 over the animated dark spawn (the bright pair is held to +/- 0.12)",
    darkMeasure.alpha === null ? "no measurable cross pixels" : darkMeasure.alpha.toFixed(3) +
      " from " + darkMeasure.samples + " cross pixels (" + darkMeasure.clippedSamples + " clipped); background luma median " +
      (darkMeasure.backgroundLuma.median === null ? "n/a" : darkMeasure.backgroundLuma.median.toFixed(1)));
  check(label + ": the crosshair's measured alpha is about 0.5 over a bright background",
    brightMeasure.samples >= 40 && brightMeasure.alpha !== null && Math.abs(brightMeasure.alpha - 0.5) <= 0.12,
    "0.5 +/- 0.12 over the lit floor behind the crosshair",
    brightMeasure.alpha === null ? "no measurable cross pixels" : brightMeasure.alpha.toFixed(3) +
      " from " + brightMeasure.samples + " cross pixels, " + brightMeasure.brightSamples + " of them over bright background pixels");
  check(label + ": the two backgrounds differ in brightness",
    darkMeasure.backgroundLuma.median !== null && brightMeasure.backgroundLuma.median !== null &&
      brightMeasure.backgroundLuma.median >= darkMeasure.backgroundLuma.median + 10 &&
      brightMeasure.backgroundLuma.brightPixels >= 4,
    "a scene at least 10 luma brighter than the default, with bright cross pixels",
    "background luma median " + (darkMeasure.backgroundLuma.median === null ? "n/a" : darkMeasure.backgroundLuma.median.toFixed(1)) +
      " dark / " + (brightMeasure.backgroundLuma.median === null ? "n/a" : brightMeasure.backgroundLuma.median.toFixed(1)) +
      " bright; " + brightMeasure.backgroundLuma.brightPixels + " of " + brightMeasure.backgroundLuma.total + " bright cross pixels");
  // Every arm pixel channel with enough contrast must sit between the
  // background and the full-opacity tint: an opaque tinted cross would sit on
  // the tint, an opaque white one away from it, and a missing one on the
  // background. This is the same blend equation as the alpha check, stated per
  // pixel so a single clipped sample cannot carry the result.
  const blendFractions = [];
  for (const pixel of darkMeasure.pixels) {
    for (let c = 0; c < 3; c++) {
      const background = pixel.off[c];
      const denominator = tint[c] - background;
      if (Math.abs(denominator) < 25) continue;
      blendFractions.push((pixel.on[c] - background) / denominator);
    }
  }
  const between = blendFractions.filter((one) => one >= 0.1 && one <= 0.9).length;
  check(label + ": every crosshair pixel is blended between the background and the full-opacity game tint",
    blendFractions.length >= 120 && between / blendFractions.length >= 0.9,
    "at least 90% of cross-pixel channels between background and tint",
    between + " of " + blendFractions.length + " cross-pixel channels are strictly between background and tint; median fraction " +
      (median(blendFractions) === null ? "n/a" : median(blendFractions).toFixed(3)));
  if (!report.presentation) report.presentation = {};
  report.presentation.crosshair = report.presentation.crosshair || {};
  report.presentation.crosshair[label] = {
    cvar: crosshairRead, scale: scaleRead, tint,
    dark: { ...darkMeasure, diff: darkDiff, scoreOn: onScore.score, scoreOff: offScore.score, centreLumaOn: dark.centreLumaOn,
      centreLumaOff: dark.centreLumaOff, onDraws: dark.onDraws, offDraws: dark.offDraws,
      screenshots: [dark.onEntry.file, dark.offEntry.file] },
    bright: { ...brightMeasure, diff: brightDiff, scoreOn: brightOnScore.score, scoreOff: brightOffScore.score,
      centreLumaOn: bright.centreLumaOn, centreLumaOff: bright.centreLumaOff,
      onDraws: bright.onDraws, offDraws: bright.offDraws,
      screenshots: [bright.onEntry.file, bright.offEntry.file] },
    blendFractions: { total: blendFractions.length, between, median: median(blendFractions) },
  };
  // Put the engine back on the app's own VIDEO defaults before the next
  // check: the bright pair's 5/5 values are saved into config.cfg when the
  // page navigates, and would otherwise brighten every later boot.
  // `timescale 1` is on the start-up line too: the crosshair boots froze the
  // simulation from boot, and a frozen start-up cvar is written into config.cfg
  // when the page navigates, so the restore must state the running value
  // rather than rely on the console alone.
  await reloadGame(resolutionUrl(resolution, DARK_STARTUP + "&+set&timescale&1"), label + " brightness defaults restored");
  if (!(await ensureGame("after restoring the brightness defaults"))) fatal(label + ": the game did not resume after restoring the brightness defaults");
  // The captures above froze the demo. A fresh engine starts at timescale 1,
  // but say so explicitly: a frozen level must not leak into the next check.
  await consoleBridge.runUntilEcho("timescale 1");
  if (!(await ensureGame("after restoring the demo timescale"))) fatal(label + ": the game did not resume after restoring the timescale");
}

// ---- The presentation fixes this run adds (owner reports B1-B4) ----------
//
// Each block leaves a real screenshot under docs/presentation-verification/
// shots and a check that the property is on the rendered page, not merely in
// the source: the engine's crosshair is drawn and visible, the old status bar
// cannot show through the HUD band, the health read-out has no rule or shadow,
// the menu rows are the engine's own, and the engine's resolution row really
// restarts the level at the selected r_mode.

function resolutionUrl(resolution, extra) {
  const separator = options.url.includes("?") ? "&" : "?";
  const mode = R_MODES[resolution.label];
  if (!mode) fatal("no r_mode for " + resolution.label);
  return options.url + separator + "+set&r_mode&" + mode + "&+map&demo1" + (extra ? "&" + extra : "");
}

// A reload that keeps the Cdp/console plumbing pointing at the new page. The
// full boot() also records every boot check; this only waits for the running
// level, which is what a settings apply should produce.
async function reloadGame(url, label) {
  await cdp.send("Page.navigate", { url }, 60000);
  await waitFor(async () => {
    const now = await state();
    return now.readyState === "complete" && now.engine && now.engine.ok && now.engine.keyDestName === "game" &&
      now.menuHidden === true && now.loadingHidden === true && now.rtx &&
      (now.rtx.worldDraws > 0 || now.rtx.postDraws > 0) &&
      now.drawingBuffer && now.drawingBuffer[0] > 0;
  }, 240000, 1500, label + " to boot");
  await consoleBridge.reconnect();
  await sleep(3500);
}

function readPngEntry(entry) {
  return decodePng(fs.readFileSync(path.join(ROOT, entry.file)));
}

// The crosshair's arms as the engine draws them at crosshair_scale 3: a 3px
// thick arm from 4 to 9 px from the centre in each direction. The same
// coordinates the B1 visibility score uses, so a tinted-but-missing cross
// cannot pass by accident.
function crosshairArms(image, centreX, centreY) {
  const points = [];
  const luminance = (x, y) => {
    const at = (y * image.width + x) * 4;
    return 0.2126 * image.data[at] + 0.7152 * image.data[at + 1] + 0.0722 * image.data[at + 2];
  };
  for (let d = 4; d <= 9; d++) {
    for (let t = -1; t <= 1; t++) {
      for (const [x, y] of [[centreX + t, centreY - d], [centreX + t, centreY + d],
        [centreX - d, centreY + t], [centreX + d, centreY + t]]) {
        const at = (y * image.width + x) * 4;
        points.push({ x, y, on: [image.data[at], image.data[at + 1], image.data[at + 2]], luma: luminance(x, y) });
      }
    }
  }
  return points;
}

function median(values) {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
}

// The crosshair's measured opacity and colour over one background pair.
//
// The engine writes the tinted cross at alpha a over the background b:
//   on = a * tint + (1 - a) * b   =>   a = (on - b) / (tint - b)
// Only channels where the full-opacity tint and the background differ enough
// carry information; the median over the arms rejects a stray edge pixel.
// A crosshair that is still opaque gives a = 0 (on == tint), one that is
// missing or covered gives no arm pixels, and one that is white gives a
// nonsense value or a tint mismatch; a half-transparent palette-tinted cross
// gives a ~ 0.5 over both a dark and a bright background.
// The engine's 8x8 crosshair picture scales with the engine's 2D size: it is a
// 21x21 box at 1280x720 and a 25x24 box at 2560x1440 (measured; the acceptance
// check accepts either). The cross pixels are selected from the dark pair as
// the pixels whose on/off difference is at least 45% of the strongest
// difference in the window, which is the cross and not the scene; that pattern
// is then sampled at the same offsets on the bright pair, so a bright
// background cannot hide the cross behind a lower absolute difference.
function measureCrosshair(onImage, offImage, tint, pattern = null) {
  const cx = Math.round(onImage.width / 2), cy = Math.round(onImage.height / 2);
  const radius = 16;
  let points;
  if (pattern) {
    points = pattern.map(function (offset) {
      const x = cx + offset.dx, y = cy + offset.dy;
      const onAt = (y * onImage.width + x) * 4;
      const offAt = (y * offImage.width + x) * 4;
      return { x, y, on: [onImage.data[onAt], onImage.data[onAt + 1], onImage.data[onAt + 2]],
        off: [offImage.data[offAt], offImage.data[offAt + 1], offImage.data[offAt + 2]] };
    });
  } else {
    const candidates = [];
    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let x = cx - radius; x <= cx + radius; x++) {
        const onAt = (y * onImage.width + x) * 4;
        const offAt = (y * offImage.width + x) * 4;
        const on = [onImage.data[onAt], onImage.data[onAt + 1], onImage.data[onAt + 2]];
        const off = [offImage.data[offAt], offImage.data[offAt + 1], offImage.data[offAt + 2]];
        const difference = (Math.abs(on[0] - off[0]) + Math.abs(on[1] - off[1]) + Math.abs(on[2] - off[2])) / 3;
        candidates.push({ x, y, on, off, difference });
      }
    }
    candidates.sort((a, b) => b.difference - a.difference);
    const strongest = candidates.length ? candidates[0].difference : 0;
    const floor = Math.max(20, strongest * 0.45);
    points = candidates.filter((candidate) => candidate.difference >= floor).slice(0, 400);
    if (points.length < 20) points = candidates.slice(0, Math.min(72, candidates.length));
  }
  const alphas = [], bright = [], dark = [], clipped = [], pixels = [], backgrounds = [];
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  for (const point of points) {
    const backgroundLuma = 0.2126 * point.off[0] + 0.7152 * point.off[1] + 0.0722 * point.off[2];
    const perChannel = [];
    for (let c = 0; c < 3; c++) {
      const denominator = tint[c] - point.off[c];
      if (Math.abs(denominator) >= 25) perChannel.push((point.on[c] - point.off[c]) / denominator);
    }
    if (!perChannel.length) { clipped.push(point); continue; }
    const alpha = median(perChannel);
    alphas.push(alpha);
    (backgroundLuma >= 100 ? bright : dark).push(alpha);
    backgrounds.push(backgroundLuma);
    pixels.push({ ...point, alpha, backgroundLuma });
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return {
    alpha: median(alphas), samples: alphas.length, clippedSamples: clipped.length,
    alphaBright: median(bright), brightSamples: bright.length,
    alphaDark: median(dark), darkSamples: dark.length,
    crossBounds: { minX, minY, maxX, maxY, width: maxX >= minX ? maxX - minX + 1 : 0,
      height: maxY >= minY ? maxY - minY + 1 : 0 },
    backgroundLuma: { median: median(backgrounds), min: backgrounds.length ? Math.min(...backgrounds) : null,
      max: backgrounds.length ? Math.max(...backgrounds) : null,
      brightPixels: backgrounds.filter((one) => one >= 100).length, total: backgrounds.length },
    offsets: points.map((point) => ({ dx: point.x - cx, dy: point.y - cy })),
    pixels,
  };
}

// The game palette's rusted amber and bone, read from pics/colormap.pcx's
// last 768 bytes (index 52 and 251). The crosshair tint is their midpoint.
function paletteTintFromPak() {
  const pak = readPakDirectory(path.join(ROOT, "baseq2", "pak0.pak"));
  const entry = pak.entries.get("pics/colormap.pcx");
  if (!entry) return null;
  const palette = pak.buffer.subarray(entry.offset + entry.size - 768, entry.offset + entry.size);
  const at = (index) => [palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]];
  const amber = at(52), bone = at(251);
  return { amber, bone, tint: [0, 1, 2].map((c) => Math.round((amber[c] + bone[c]) / 2)) };
}

// Pixels that differ between the same view with the crosshair off and on,
// restricted to a window around the screen centre. The engine's cross is a
// small drawn element, so a crosshair that is missing or covered yields no
// cluster at all.
function centreDiff(off, on, windowRadius, threshold = 25) {
  const cx = Math.round(on.width / 2), cy = Math.round(on.height / 2);
  let minX = Infinity, minY = Infinity, maxX = -1, maxY = -1, count = 0;
  for (let y = cy - windowRadius; y <= cy + windowRadius; y++) {
    for (let x = cx - windowRadius; x <= cx + windowRadius; x++) {
      const a = (y * off.width + x) * 4;
      const b = (y * on.width + x) * 4;
      const delta = (Math.abs(off.data[a] - on.data[b]) + Math.abs(off.data[a + 1] - on.data[b + 1]) +
        Math.abs(off.data[a + 2] - on.data[b + 2])) / 3;
      if (delta > threshold) {
        count++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { count, minX, minY, maxX, maxY, cx, cy,
    width: maxX >= minX ? maxX - minX + 1 : 0, height: maxY >= minY ? maxY - minY + 1 : 0 };
}

// Measure the cross itself, not the scene: the engine draws four short arms
// (3 px thick, starting 4 px from the centre and ending 10 px out) and nothing
// at the centre. The score is the mean luma of those arm pixels minus the same
// measurement on a ring outside the cross. A crosshair that is missing or
// covered scores near zero even on a bright wall; the drawn one scores high.
function crosshairScore(image) {
  const luminance = (x, y) => {
    const at = (y * image.width + x) * 4;
    return 0.2126 * image.data[at] + 0.7152 * image.data[at + 1] + 0.0722 * image.data[at + 2];
  };
  const baseX = Math.round(image.width / 2), baseY = Math.round(image.height / 2);
  let best = -Infinity, bestAt = null;
  for (let ox = -3; ox <= 3; ox++) {
    for (let oy = -3; oy <= 3; oy++) {
      const cx = baseX + ox, cy = baseY + oy;
      const arms = [], ring = [];
      for (let d = 4; d <= 9; d++) {
        for (let t = -1; t <= 1; t++) {
          arms.push(luminance(cx + t, cy - d), luminance(cx + t, cy + d));
          arms.push(luminance(cx - d, cy + t), luminance(cx + d, cy + t));
        }
      }
      for (let d = 13; d <= 19; d += 2) {
        for (let t = -1; t <= 1; t++) {
          ring.push(luminance(cx + t, cy - d), luminance(cx + t, cy + d));
          ring.push(luminance(cx - d, cy + t), luminance(cx + d, cy + t));
        }
      }
      const mean = (values) => values.reduce((sum, one) => sum + one, 0) / values.length;
      const score = mean(arms) - mean(ring);
      if (score > best) { best = score; bestAt = { cx, cy }; }
    }
  }
  return { score: best, at: bestAt };
}

async function readMenuRows(view) {
  return evaluate(`(() => Array.from(document.querySelectorAll('.menu-view[data-view="${view}"] .menu-list button')).map(function (button) {
    return {
      label: button.querySelector(".label") ? button.querySelector(".label").textContent.trim() : "",
      value: button.querySelector(".value") ? button.querySelector(".value").textContent.trim() : null,
      cvar: button.dataset.cvar || null,
      cvars: button.dataset.cvars || null,
      action: button.dataset.action || null,
      skill: button.dataset.skill === undefined ? null : button.dataset.skill,
      values: button.dataset.values ? button.dataset.values.split(",") : null,
      labels: button.dataset.labels ? button.dataset.labels.split(",") : null,
      index: button.dataset.index === undefined ? null : Number(button.dataset.index),
      changed: button.classList.contains("changed"),
    };
  }))()`);
}

async function menuTreeChecks() {
  console.log("\n  menu parity");
  if (!(await openMenu())) fatal("the menu did not open for the parity checks");
  const main = await evaluate(`Array.from(document.querySelectorAll('.menu-view[data-view="main"] .label')).map((label) => label.textContent.trim())`);
  check("menu parity: main menu is the engine's own five entries",
    JSON.stringify(main) === JSON.stringify(ENGINE_MENU_TREE.main),
    ENGINE_MENU_TREE.main.join(", "), (main || []).join(", "));
  const views = {};
  for (const view of ["game", "multiplayer", "options", "video"]) {
    await click('[data-action="' + view + '"]');
    await sleep(350);
    const rows = await readMenuRows(view);
    views[view] = rows;
    const labels = rows.map(function (row) { return row.label; });
    check("menu parity: " + view + " rows are the engine's own, in order",
      JSON.stringify(labels) === JSON.stringify(ENGINE_MENU_TREE[view]),
      ENGINE_MENU_TREE[view].join(", "), (labels || []).join(", "));
    await click('[data-action="back"]');
    await sleep(250);
  }
  report.menu = report.menu || {};
  report.menu.parity = views;

  const gameSkills = (views.game || []).filter(function (row) { return row.action === "newgame"; }).map(function (row) { return row.skill; });
  check("GAME menu skills cover easy, medium, hard and hard+ (0-3)",
    JSON.stringify(gameSkills) === JSON.stringify(["0", "1", "2", "3"]), "skills 0,1,2,3", (gameSkills || []).join(","));

  const videoMode = (views.video || []).find(function (row) { return row.label === "video mode"; });
  check("VIDEO menu has the engine's own video mode row",
    Boolean(videoMode) && videoMode.cvar === "r_mode", "video mode (r_mode)", videoMode ? videoMode.cvar : "missing");
  check("VIDEO video mode lists the engine's 33 modes plus auto and custom, in its order",
    Boolean(videoMode) && JSON.stringify(videoMode.values) === JSON.stringify(ENGINE_VIDEO_MODE_VALUES),
    ENGINE_VIDEO_MODE_VALUES.length + " values", videoMode ? String(videoMode.values && videoMode.values.length) + " values" : "missing");
  check("VIDEO video mode labels are the engine's resolutions",
    Boolean(videoMode) && JSON.stringify(videoMode.labels) === JSON.stringify(ENGINE_R_MODE_LABELS),
    ENGINE_R_MODE_LABELS.length + " labels", videoMode ? String(videoMode.labels && videoMode.labels.length) + " labels" : "missing");
  const crosshairRow = (views.options || []).find(function (row) { return row.label === "crosshair"; });
  check("OPTIONS crosshair row carries the engine's none/cross/dot/angle values",
    Boolean(crosshairRow) && JSON.stringify(crosshairRow.labels) === JSON.stringify(ENGINE_CROSSHAIR_LABELS),
    ENGINE_CROSSHAIR_LABELS.join(", "), crosshairRow ? (crosshairRow.labels || []).join(", ") : "missing");
  const pauseRow = (views.options || []).find(function (row) { return row.label === "pause on minimized"; });
  check("OPTIONS pause row carries the engine's three values",
    Boolean(pauseRow) && JSON.stringify(pauseRow.labels) === JSON.stringify(["yes", "no", "unpause on re-focus"]),
    "yes, no, unpause on re-focus", pauseRow ? (pauseRow.labels || []).join(", ") : "missing");
  const filterRow = (views.video || []).find(function (row) { return row.label === "texture filter"; });
  check("VIDEO texture filter carries the engine's pixelated/standard/trilinear values",
    Boolean(filterRow) && JSON.stringify(filterRow.labels) === JSON.stringify(["pixelated", "standard", "trilinear"]),
    "pixelated, standard, trilinear", filterRow ? (filterRow.labels || []).join(", ") : "missing");
  const shuffleRow = (views.options || []).find(function (row) { return row.label === "OGG shuffle"; });
  check("OPTIONS OGG shuffle carries the engine's five values",
    Boolean(shuffleRow) && JSON.stringify(shuffleRow.labels) === JSON.stringify(["default", "play once", "sequential", "random", "truly random"]),
    "default, play once, sequential, random, truly random", shuffleRow ? (shuffleRow.labels || []).join(", ") : "missing");
  return views;
}

async function presentationFixesCheck(resolution) {
  const label = resolution.label;
  console.log("\n  " + label + " presentation fixes (menu parity and resolution)");
  if (!(await ensureGame("the presentation fixes check"))) fatal(label + ": the game is not in game for the presentation fixes check");
  if (!(await ensureGame("menu parity"))) fatal(label + ": the game did not resume for the menu parity checks");
  const views = await menuTreeChecks();

  // B4: the resolution row applies. Select the engine's 1366x768 mode (r_mode
  // 17) in the panel, press apply, and read the engine's own drawing buffer.
  await click('[data-action="video"]');
  await sleep(350);
  let clicks = 0;
  let selected = null;
  while (clicks < 40) {
    selected = await evaluate(`(() => { const b=document.querySelector('.menu-view[data-view="video"] .setting[data-cvar="r_mode"]'); if (!b) return null; const values=b.dataset.values.split(','); return { value: values[Number(b.dataset.index)], label: b.querySelector('.value').textContent.trim(), changed: b.classList.contains('changed'), hint: document.getElementById('apply-hint') ? document.getElementById('apply-hint').textContent : null }; })()`);
    if (!selected) break;
    if (selected.label === "1366x768") break;
    await click('.menu-view[data-view="video"] .setting[data-cvar="r_mode"]');
    await sleep(120);
    clicks++;
  }
  check("B4: the video mode row selects the engine's 1366x768 (r_mode 17)",
    Boolean(selected) && selected.value === "17" && selected.label === "1366x768",
    "value 17 (1366x768)", selected ? selected.value + " (" + selected.label + ")" : "row missing");
  check("B4: selecting a resolution marks it as a pending change",
    Boolean(selected) && selected.changed === true, "changed", selected ? String(selected.changed) : "missing");
  await capture(label + "-resolution-menu.png", resolution.width, resolution.height,
    { view: "VIDEO > video mode selected at 1366x768, apply shows one change", resolution: label });
  await click('.menu-view[data-view="video"] [data-action="apply"]');
  await waitFor(async () => {
    const search = await evaluate("location.search");
    const now = await state();
    return /\+set&r_mode&17/.test(search) && now.menuHidden === true &&
      now.drawingBuffer && now.drawingBuffer[0] === 1366 && now.drawingBuffer[1] === 768;
  }, 240000, 1500, "the level to restart at r_mode 17");
  await consoleBridge.reconnect();
  await sleep(5000);
  const applied = await state();
  await capture(label + "-resolution-applied.png", resolution.width, resolution.height,
    { view: "the level restarted at 1366x768 after Apply", resolution: label, drawingBuffer: applied.drawingBuffer });
  check("B4: apply restarted the level at the selected resolution",
    applied.drawingBuffer && applied.drawingBuffer[0] === 1366 && applied.drawingBuffer[1] === 768,
    "drawing buffer 1366x768", JSON.stringify(applied.drawingBuffer));
  report.presentation.resolution = { selected, drawingBuffer: applied.drawingBuffer,
    search: await evaluate("location.search") };
  // Put the page back at the suite's own resolution for the rest of the run.
  await reloadGame(resolutionUrl(resolution), label + " restored resolution");
  const restored = await state();
  check("B4: the suite's resolution is restored after the apply check",
    restored.drawingBuffer && restored.drawingBuffer[0] === resolution.width,
    "drawing buffer " + resolution.label, JSON.stringify(restored.drawingBuffer));
  await ensureGame("after the presentation fixes check");
  return views;
}

// ---- Interface state the bug hunt fixed ---------------------------------
// Four defects the sweep found, each checked on the running page:
//   * the panel's key handler swallowed the app's own synthetic Escape, so the
//     Options chip never paused the game and closed itself a second later;
//   * every note row's answer went into a banner painted under the panel's
//     scrim, so nine rows appeared to do nothing;
//   * QUIT left the engine at its menu, so the next poll reopened the panel
//     under the exit message and offered Resume to an invisible game;
//   * a key held when the panel opened never reached the engine as a release,
//     so the player kept walking after Resume.
async function interfaceStateCheck(resolution) {
  const label = resolution.label;
  console.log("\n  " + label + " interface state");
  if (!(await ensureGame("the interface-state check"))) fatal(label + ": the game is not in game for the interface-state check");
  if ((await state()).engine.dead) {
    note(label + ": the player was dead before the interface-state check; restarting demo1");
    await restartDemo1(label);
  }
  const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

  // 1. The Options chip asks the engine for its menu (the pause) with a
  // synthetic Escape; the panel must already be up when that Escape arrives
  // and must stay up while the engine is at its menu.
  await click("#options-chip");
  await sleep(1800);
  const chip = await state();
  check(label + ": the Options chip pauses the game and the panel stays",
    Boolean(chip.engine) && chip.engine.keyDestName === "menu" && chip.menuHidden === false,
    "key_dest menu and the panel visible after the chip",
    "key_dest " + (chip.engine && chip.engine.keyDestName) + ", menuHidden " + chip.menuHidden);
  await resume();

  // 2. A note row answers where the player can see it: inside the panel, not
  // through the banner over the game (which this browser paints under the
  // panel's scrim). Nine rows answer this way, and the panel stays open.
  if (!(await openMenu())) fatal(label + ": the menu did not open for the note-answer check");
  await click('[data-action="video"]');
  await sleep(400);
  const noteAnswer = await evaluate(`(() => {
    const panel = document.getElementById("menu");
    // The user is at the top of the view when they click the row; the note has
    // to be visible there, not scrolled to below the fold.
    panel.scrollTop = 0;
    const row = document.querySelector('.menu-view[data-view="video"] .setting[data-action="note"]');
    if (!row) return null;
    row.click();
    const note = document.getElementById("menu-note");
    if (!note) return { missing: true };
    const style = getComputedStyle(note);
    const noteRect = note.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    return { hidden: note.hidden, text: note.textContent.trim(), display: style.display,
      insidePanel: Boolean(note.closest("#menu")), panelOpen: document.getElementById("menu-layer").hidden === false,
      scrollTop: panel.scrollTop, scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight,
      height: Math.round(noteRect.height),
      // The answer must be inside the panel's visible box, not below it.
      inView: noteRect.top >= panelRect.top - 1 && noteRect.bottom <= panelRect.bottom + 1 && noteRect.height > 0,
      rect: { top: Math.round(noteRect.top), bottom: Math.round(noteRect.bottom) },
      panelRect: { top: Math.round(panelRect.top), bottom: Math.round(panelRect.bottom) } };
  })()`);
  check(label + ": a note row's answer is shown inside the open panel, in view",
    Boolean(noteAnswer) && noteAnswer.missing !== true && noteAnswer.hidden === false && noteAnswer.display !== "none" &&
      /renderer/i.test(noteAnswer.text) && noteAnswer.insidePanel === true && noteAnswer.panelOpen === true &&
      noteAnswer.height > 0 && noteAnswer.inView === true,
    "the note row's text is a visible element inside #menu, inside the panel's visible box with the view scrolled to the top",
    noteAnswer ? JSON.stringify(noteAnswer) : "the video view has no note row");
  await resume();

  // 3. QUIT stays quit.
  if (!(await openMenu())) fatal(label + ": the menu did not open for the QUIT check");
  await click('[data-action="quit"]');
  await sleep(2600);
  const quit = await evaluate(`(() => ({
    canvasDisplay: document.getElementById("canvas").style.display,
    menuHidden: document.getElementById("menu-layer").hidden,
    status: document.getElementById("status").textContent,
    loadingHidden: document.getElementById("loading").hidden,
  }))()`);
  check(label + ": QUIT stays quit (no panel reopens behind the exit message)",
    quit.canvasDisplay === "none" && quit.menuHidden === true && /quit/i.test(quit.status) && quit.loadingHidden === false,
    "canvas hidden, panel hidden, the exit message shown",
    JSON.stringify(quit));
  await reloadGame(resolutionUrl(resolution), label + " after the QUIT check");
  if (!(await ensureGame("after the QUIT check"))) fatal(label + ": the game did not resume after the QUIT check");

  // 4. A key released while the panel is open reaches the engine.
  const position = async () => (await state()).engine.position;
  const holdThenRelease = async (keyName) => {
    const start = await position();
    await consoleBridge.control.key(keyName, true);
    await sleep(1200);
    const walking = await position();
    if (!(await openMenu())) fatal(label + ": the menu did not open for the held-key check");
    await consoleBridge.control.key(keyName, false);
    await sleep(400);
    await resume();
    await sleep(1400);
    const a = await position();
    await sleep(1400);
    const b = await position();
    return { key: keyName, walked: distance(start, walking), drift: distance(a, b) };
  };
  // At the spawn one direction can be a wall; a held key that moved the player
  // at all is the precondition, so try the other directions if one was blocked.
  let heldKey = await holdThenRelease("w");
  for (const keyName of ["s", "a", "d"]) {
    if (heldKey.walked > 20) break;
    heldKey = await holdThenRelease(keyName);
  }
  check(label + ": a key released while the panel is open does not stay down in the engine",
    heldKey.walked > 20 && heldKey.drift < 6,
    "the player walks while the key is held (>20 units), then stands still after the release through the panel",
    "walked " + heldKey.walked.toFixed(1) + " units with " + heldKey.key.toUpperCase() +
      " held; drift after Resume " + heldKey.drift.toFixed(1) + " units over 1.4 s");
  if (!report.interfaceState) report.interfaceState = {};
  report.interfaceState[label] = { chip, quit, heldKey };
}

// ---- Game mode: the native-fullscreen presentation ----------------------
// The owner asked for a mode that renders the game surface alone, with every
// other page layer gone and the page black around the picture, reachable from
// the interface and with a clear way back, and measurably cheaper per frame
// than the normal page. These checks drive the real control path (the VIDEO
// menu row, clicked with a trusted CDP input so the full-screen request has
// its user gesture) and the real shortcut (a trusted Alt+Enter), and measure
// rAF frame time in and out of the mode on the same scene.
//
// What a page cannot do is checked as honestly as what it can: the run has one
// display and no Window Management permission, so `blackout` must say that
// rather than claim other monitors were darkened.
function gameModeStatus() {
  return evaluate(`window.quake2GameMode && typeof window.quake2GameMode.status === "function"
    ? window.quake2GameMode.status() : null`);
}

function pageLayers() {
  return evaluate(`(() => {
    const read = (id) => {
      const element = document.getElementById(id);
      if (!element) return null;
      const style = getComputedStyle(element);
      return { hidden: element.hidden, display: style.display, visibility: style.visibility };
    };
    const canvas = document.getElementById("canvas");
    const rect = canvas ? canvas.getBoundingClientRect() : null;
    let gl = null;
    try { gl = canvas ? canvas.getContext("webgl2") : null; } catch (error) { gl = null; }
    return {
      ui: read("ui"),
      fullscreenButton: read("fullscreen-button"),
      loading: read("loading"),
      hint: read("fullscreen-hint"),
      chips: read("options-chip") && read("options-chip").display !== "none" ? "visible" : "hidden",
      prompt: read("prompt") && read("prompt").display !== "none" && !read("prompt").hidden ? "visible" : "hidden",
      bodyClass: document.body.className,
      bodyBackground: getComputedStyle(document.body).backgroundColor,
      htmlBackground: getComputedStyle(document.documentElement).backgroundColor,
      canvas: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
      drawingBuffer: gl ? [gl.drawingBufferWidth, gl.drawingBufferHeight] : null,
      viewport: [innerWidth, innerHeight],
      fullscreenElement: Boolean(document.fullscreenElement),
      modeValue: document.getElementById("game-mode-value") ? document.getElementById("game-mode-value").textContent.trim() : null,
    };
  })()`);
}

async function elementCentre(selector) {
  return evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, width: rect.width, height: rect.height };
  })()`);
}

// A real input event: this is what gives the full-screen request its user
// gesture (element.click() from script does not).
async function trustedClickAt(x, y) {
  const point = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y, button: "none", buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...point, buttons: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, buttons: 0 });
}

async function pressAltEnter() {
  const key = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 1 };
  await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...key });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...key });
}

// Both frame samples must be taken in the same display state: full screen is
// not part of game mode's saving (the claim is the page work it removes), and
// in this headless browser a full-screen page and a windowed one composite
// differently enough to swamp the difference. The page asks for full screen on
// its own first gesture; this drives its own control only when it has not.
async function ensurePageFullscreen(label) {
  const now = await pageLayers();
  if (now.fullscreenElement) return true;
  await evaluate("document.exitPointerLock ? document.exitPointerLock() : null");
  await sleep(300);
  const rect = await elementCentre("#fullscreen-button");
  if (!rect) return false;
  await trustedClickAt(rect.x, rect.y);
  try {
    await waitFor(async () => (await pageLayers()).fullscreenElement === true, 10000, 300, "the page to enter full screen");
    return true;
  } catch (error) {
    return false;
  }
}

// The normal page's own per-frame work, as the main thread pays for it: the
// status-bar read-back is a synchronous framebuffer read every 1.2 s, the
// interface poll runs eight times a second, and both stop in game mode. CDP's
// Performance domain reports the thread's task duration; dividing its growth
// by the frames drawn in the same window is a cost per drawn frame, which is
// the comparison the owner asked for. The blocks interleave on one page and
// one frozen scene, and each switch's settling time is discarded, so a slow
// patch of the demo cannot be read as one presentation's cost.
async function measureMainThreadCost(blocks = 6, seconds = 10) {
  await cdp.send("Performance.enable");
  const snapshot = async () => {
    const result = await cdp.send("Performance.getMetrics");
    const metrics = {};
    for (const one of result.metrics) metrics[one.name] = one.value;
    return { task: metrics.TaskDuration || 0, script: metrics.ScriptDuration || 0,
      frames: await evaluate("(window.__q2verify && window.__q2verify.frames) || 0") };
  };
  const samples = [];
  let mode = "page";
  for (let index = 0; index < blocks; index++) {
    if (mode === "game") await evaluate("window.quake2GameMode.enter('cost-sample')");
    else await evaluate("window.quake2GameMode.exit('cost-sample', { keepFullscreen: true })");
    await sleep(1200);
    const before = await snapshot();
    const startedAt = Date.now();
    await sleep(seconds * 1000);
    const after = await snapshot();
    const frames = after.frames - before.frames;
    samples.push({ mode, frames, seconds: (Date.now() - startedAt) / 1000,
      taskPerFrame: frames ? ((after.task - before.task) * 1000) / frames : null,
      scriptPerFrame: frames ? ((after.script - before.script) * 1000) / frames : null });
    mode = mode === "page" ? "game" : "page";
  }
  const summarize = (name) => {
    const list = samples.filter((one) => one.mode === name && one.frames > 0);
    const frames = list.reduce((sum, one) => sum + one.frames, 0);
    return { blocks: list.length, frames,
      taskPerFrame: frames ? list.reduce((sum, one) => sum + one.taskPerFrame * one.frames, 0) / frames : null,
      scriptPerFrame: frames ? list.reduce((sum, one) => sum + one.scriptPerFrame * one.frames, 0) / frames : null };
  };
  // Each game block immediately follows a page block, so the ratio inside a
  // pair is what the mode did to the same load; the box's load drifts over a
  // run (measured: one page block at 665 ms/frame, the next at 906), and a
  // median over the whole run would read that drift as the mode's cost.
  const pairs = [];
  for (let index = 0; index + 1 < samples.length; index += 2) {
    const first = samples[index], second = samples[index + 1];
    if (first.mode === "page" && second.mode === "game" && first.frames && second.frames) {
      pairs.push({ pageTaskPerFrame: first.taskPerFrame, gameTaskPerFrame: second.taskPerFrame,
        ratio: second.taskPerFrame / first.taskPerFrame });
    }
  }
  // What the mode removes, timed where it runs: one status-bar read-back is a
  // synchronous framebuffer read plus digit recognition.
  await evaluate("window.quake2GameMode.exit('cost-read', { keepFullscreen: true })");
  await sleep(800);
  const reads = [];
  for (let index = 0; index < 5; index++) {
    try {
      const cost = await evaluate("(() => { const t = performance.now(); window.quake2Hud.readNow(); return performance.now() - t; })()");
      if (Number.isFinite(cost)) reads.push(cost);
    } catch (error) { /* the bar may not be readable on this frame */ }
  }
  return { samples, page: summarize("page"), game: summarize("game"), pairs, readBackMs: median(reads) };
}

async function gameModeCheck(resolution) {
  const label = resolution.label;
  console.log("\n  " + label + " game mode");
  if (!(await ensureGame("the game-mode check"))) fatal(label + ": the game is not in game for the game-mode check");
  await setLighting("performance");

  const api = await evaluate(`Boolean(window.quake2GameMode && window.quake2GameMode.enter && window.quake2GameMode.exit && window.quake2GameMode.status)`);
  const row = await evaluate(`(() => {
    const button = document.querySelector('[data-action="game-mode"]');
    if (!button) return null;
    return {
      label: button.querySelector(".label") ? button.querySelector(".label").textContent.trim() : null,
      value: document.getElementById("game-mode-value") ? document.getElementById("game-mode-value").textContent.trim() : null,
      help: Array.from(document.querySelectorAll('.menu-view[data-view="video"] .field-help')).map((one) => one.textContent).join(" "),
    };
  })()`);
  check(label + ": the game-mode control is present", api === true && Boolean(row) && row.label === "game mode",
    "window.quake2GameMode with enter/exit/status, and a 'game mode' row in VIDEO",
    api ? "API present; row " + (row ? JSON.stringify(row.label) + " value " + JSON.stringify(row.value) : "missing") : "window.quake2GameMode is missing");
  if (api !== true || !row) fatal(label + ": the game-mode control is missing");
  check(label + ": the game-mode row documents the way back", /Alt\+Enter/.test(row.help) && /Esc/.test(row.help),
    "Alt+Enter to toggle and Esc to leave full screen", /Alt\+Enter/.test(row.help) ? "both named in VIDEO's help" : "neither named");

  // Same scene before and after: no reload, and the drawing buffer and
  // renderer mode are checked again while the mode is up.
  const before = await status();
  const beforeState = await state();
  const beforeShot = await stableScreenshot();
  const beforeEntry = await captureBuffer(label + "-game-mode-page.png", beforeShot, resolution.width, resolution.height,
    { view: "the page with its interface, before game mode", resolution: label, mode: "page" });
  const beforeLuma = centreLuma(beforeShot);
  const fullscreenBefore = await ensurePageFullscreen(label);
  check(label + ": the page is in full screen before the frame comparison", fullscreenBefore === true,
    "document.fullscreenElement before either frame sample",
    fullscreenBefore ? "full screen" : "not full screen — the two samples would not be comparable");
  if (fullscreenBefore !== true) fatal(label + ": the frame comparison needs the page in full screen; this browser refused it");
  // Freeze the simulation but not the renderer: every sample below is the same
  // picture, so a scene change cannot be read as a mode difference.
  await consoleBridge.runUntilEcho("timescale 0");
  if (!(await ensureGame("after freezing the demo for the game-mode checks"))) fatal(label + ": the game did not resume with the demo frozen");
  await sleep(1200);

  // The normal-page sample state: the game playing, full screen, and the
  // pointer free, which is when the page shows its own interface (the Options
  // chip and the capture prompt, exactly as at boot).
  const unlockPointer = async () => {
    if (!(await evaluate("document.pointerLockElement !== null"))) return;
    // Release the pointer inside game mode, where the app does not answer a
    // lost lock by opening its menu, and hold the mode long enough for that
    // handler (it waits 220 ms) to run and return before the mode ends.
    await evaluate("window.quake2GameMode.enter('page-sample')");
    await sleep(400);
    await evaluate("document.exitPointerLock ? document.exitPointerLock() : null");
    await sleep(1100);
    await evaluate("window.quake2GameMode.exit('page-sample', { keepFullscreen: true })");
    await sleep(700);
  };
  const preparePageSample = async (what) => {
    if (!(await ensureGame(what))) fatal(label + ": the game did not resume for " + what);
    if ((await pageLayers()).fullscreenElement !== true && !(await ensurePageFullscreen(label))) {
      fatal(label + ": full screen was lost before " + what);
    }
    const playing = async () => {
      const now = await state();
      return Boolean(now.engine) && now.engine.keyDestName === "game" && now.menuHidden === true;
    };
    await unlockPointer();
    for (let attempt = 0; attempt < 4 && !(await playing()); attempt++) {
      await ensureGame("settling the page sample (" + attempt + ")");
      await sleep(700);
      await unlockPointer();
    }
    if (!(await playing())) fatal(label + ": the page would not settle into play for " + what);
    await sleep(600);
  };
  await preparePageSample("the page sample");
  const pageLayersBefore = await pageLayers();
  check(label + ": the page's own interface is on screen for the comparison",
    pageLayersBefore.ui && pageLayersBefore.ui.display !== "none" &&
      pageLayersBefore.chips === "visible" && pageLayersBefore.prompt === "visible",
    "#ui, the Options chip and the capture prompt visible on the normal page",
    JSON.stringify({ ui: pageLayersBefore.ui, chips: pageLayersBefore.chips, prompt: pageLayersBefore.prompt }));

  // What the normal page does per second: the status-bar read-back (a
  // framebuffer read every 1.2 s). Game mode suspends it. The counter is of
  // attempts, not successful reads: a frozen frame can fail to recognise a
  // digit while the readPixels cost is still paid.
  const pageWorkStart = (await status()).hudAttempts;
  const pageWorkReadsStart = (await status()).hudReads;
  const pageWorkFrom = Date.now();
  await sleep(6000);
  const pageWorkEnd = (await status()).hudAttempts;
  const pageWorkReadsEnd = (await status()).hudReads;
  const pageWorkSeconds = (Date.now() - pageWorkFrom) / 1000;

  // Enter from the VIDEO row with a trusted click: the menu open is the
  // interface path the owner has, and the click is the user gesture full
  // screen needs.
  if (!(await openMenu())) fatal(label + ": the menu did not open before the game-mode entry");
  // The interface is used with the pointer free (the app hides its chips while
  // the mouse is locked, and a locked pointer delivers every click to the
  // canvas), so release it before the coordinate click on the row.
  await evaluate("document.exitPointerLock ? document.exitPointerLock() : null");
  await sleep(400);
  await click('[data-action="video"]');
  await sleep(400);
  // The VIDEO panel scrolls (its engine list is longer than the viewport at
  // 720p), and this row sits below the list with the apply control. Scroll it
  // into view the way a player would before taking its coordinates.
  await evaluate(`(() => {
    const row = document.querySelector('[data-action="game-mode"]');
    if (row && row.scrollIntoView) row.scrollIntoView({ block: "center" });
    return true;
  })()`);
  await sleep(400);
  const rowRect = await elementCentre('[data-action="game-mode"]');
  if (!rowRect) fatal(label + ": the game-mode row is not in the VIDEO view");
  const rowHit = await evaluate(`(() => {
    const row = document.querySelector('[data-action="game-mode"]');
    if (!row) return null;
    const rect = row.getBoundingClientRect();
    const element = document.elementFromPoint(Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2));
    return element ? element.closest('[data-action="game-mode"]') === row : false;
  })()`);
  check(label + ": the game-mode row is on screen where it is clicked", rowHit === true,
    "the row under the click point after scrolling it into view", String(rowHit));
  if (rowHit !== true) fatal(label + ": the game-mode row is not under its own click point");
  await trustedClickAt(rowRect.x, rowRect.y);
  try {
    await waitFor(async () => {
      const status = await gameModeStatus();
      return status && status.active === true;
    }, 15000, 300, "game mode to engage");
  } catch (error) {
    fatal(label + ": game mode did not engage from its row: " + error.message);
  }
  await sleep(1500);
  const entered = await gameModeStatus();
  const layers = await pageLayers();
  const resumed = await ensureGame("after entering game mode");

  check(label + ": game mode is active and the game is running", entered.active === true && resumed === true,
    "active, key_dest game", "active " + entered.active + ", key_dest " + (await state()).engine.keyDestName);
  const uiGone = layers.ui && layers.ui.display === "none" && layers.fullscreenButton && layers.fullscreenButton.display === "none" &&
    (!layers.loading || layers.loading.display === "none");
  check(label + ": game mode hides every page layer", Boolean(uiGone),
    "#ui, #fullscreen-button and #loading are display:none",
    JSON.stringify({ ui: layers.ui, button: layers.fullscreenButton, loading: layers.loading }));
  check(label + ": game mode makes the page black around the picture",
    layers.bodyBackground === "rgb(0, 0, 0)" && layers.htmlBackground === "rgb(0, 0, 0)",
    "rgb(0, 0, 0) on <html> and <body>", layers.htmlBackground + " / " + layers.bodyBackground);
  // A native game letterboxes at its own aspect ratio, so the canvas must fill
  // the display in at least one dimension and sit centred in the other; the
  // bars around it are the black page, checked above.
  const covers = layers.canvas && layers.viewport &&
    (Math.abs(layers.canvas.width - layers.viewport[0]) <= 2 ||
      Math.abs(layers.canvas.height - layers.viewport[1]) <= 2) &&
    Math.abs((layers.canvas.x + layers.canvas.width / 2) - layers.viewport[0] / 2) <= 2 &&
    Math.abs((layers.canvas.y + layers.canvas.height / 2) - layers.viewport[1] / 2) <= 2;
  check(label + ": the game surface fills the display", Boolean(covers),
    "the canvas fills the viewport in one dimension and is centred (" + layers.viewport.join("x") + ")",
    layers.canvas ? Math.round(layers.canvas.width) + "x" + Math.round(layers.canvas.height) + " at " +
      Math.round(layers.canvas.x) + "," + Math.round(layers.canvas.y) : "no canvas");
  check(label + ": game mode asked for full screen", entered.fullscreen === true || Boolean(entered.reason),
    "fullscreenElement when the browser allows it, otherwise the reason",
    "fullscreen " + entered.fullscreen + (entered.reason ? " (" + entered.reason + ")" : ""));
  check(label + ": game mode leaves the engine's drawing buffer and resolution alone",
    layers.drawingBuffer && beforeState.drawingBuffer &&
      layers.drawingBuffer[0] === beforeState.drawingBuffer[0] && layers.drawingBuffer[1] === beforeState.drawingBuffer[1],
    "drawing buffer " + (beforeState.drawingBuffer || []).join("x"),
    (layers.drawingBuffer || []).join("x"));

  // The multi-display claim, stated honestly: one display here, and no Window
  // Management permission, so no black window is claimed.
  const blackout = entered.blackout || {};
  const blackoutHonest = (blackout.windows || 0) === 0 ? true :
    (blackout.screens > 1 && blackout.windows === blackout.screens - 1);
  check(label + ": game mode reports its multi-display blackout honestly",
    Boolean(blackout) && blackoutHonest && (blackout.screens === 1 ? blackout.windows === 0 : true),
    "no black window claimed without a second display and the Window Management API",
    JSON.stringify(blackout) + " displays " + JSON.stringify(entered.displays));

  // The frame cost: the same scene, the same full-screen state, the same
  // drawing buffer. The samples are interleaved (page, game, page, game) so a
  // slow warm-up or a heavier patch of the demo cannot be mistaken for the
  // mode's own cost.
  const duringShot = await stableScreenshot();
  const duringEntry = await captureBuffer(label + "-game-mode-surface.png", duringShot, resolution.width, resolution.height,
    { view: "game mode: the game surface alone, no page interface", resolution: label, mode: "game" });
  const duringLuma = centreLuma(duringShot);
  const stillDrawing = await status();
  check(label + ": the scene is the same picture in game mode",
    duringLuma > 5 && Math.abs(duringLuma - beforeLuma) <= 40 && stillDrawing.worldDraws > before.worldDraws,
    "the game keeps drawing the same view (world draws increase, no black frame)",
    "centre luma " + Math.round(beforeLuma) + " page / " + Math.round(duringLuma) + " game; world draws +" +
      (stillDrawing.worldDraws - before.worldDraws));

  // The page's read-back is the per-frame work the mode removes; it is
  // deterministic, so it is checked directly rather than inferred from a
  // wall-clock difference the software renderer cannot show.
  const gameWorkStart = (await status()).hudAttempts;
  await sleep(6000);
  const gameWorkEnd = (await status()).hudAttempts;
  check(label + ": game mode suspends the page's status-bar read-back",
    pageWorkEnd - pageWorkStart > 0 && gameWorkEnd === gameWorkStart,
    "the normal page reads the status bar back; game mode performs no read at all",
    (pageWorkEnd - pageWorkStart) + " read attempts in " + pageWorkSeconds.toFixed(1) + " s on the page (" +
      (pageWorkReadsEnd - pageWorkReadsStart) + " recognised), " + (gameWorkEnd - gameWorkStart) + " in game mode");

  // Leave the page presentation but keep the full screen: the second page
  // sample is then the same display state as the game-mode samples, and the
  // only difference left is the page work the mode removes.
  await evaluate(`window.quake2GameMode.exit("frame-sample", { keepFullscreen: true })`);
  await waitFor(async () => {
    const status = await gameModeStatus();
    return status && status.active === false;
  }, 10000, 300, "game mode to leave for the second page sample");
  if (!(await ensureGame("before the normal-page frame sample"))) fatal(label + ": the game did not resume for the normal-page frame sample");
  await waitFor(async () => {
    const now = await state();
    return now.engine && now.engine.keyDestName === "game" && now.menuHidden === true;
  }, 10000, 300, "the panel to be down before the normal-page frame sample");
  await sleep(600);
  const keptLayers = await pageLayers();
  check(label + ": the interface returns while full screen stays on",
    keptLayers.ui && keptLayers.ui.display !== "none" && keptLayers.fullscreenElement === true &&
      keptLayers.bodyClass.indexOf("is-game-mode") === -1,
    "the page interface back in the same full-screen display state",
    JSON.stringify({ ui: keptLayers.ui, fullscreen: keptLayers.fullscreenElement, bodyClass: keptLayers.bodyClass }));
  // The mode and the page alternate inside this one page, ten frames each,
  // discarding the two frames after every switch: both states then share
  // whatever drift the box's software renderer is going through.
  const measured = await evaluate(`new Promise((resolve) => {
    const page = [], game = [];
    let last = 0, skip = 0, state = "page", frames = 0;
    function step(now) {
      if (last && skip <= 0) (state === "page" ? page : game).push(now - last);
      last = now;
      if (skip > 0) skip--;
      frames++;
      if (frames % 10 === 0) {
        state = state === "page" ? "game" : "page";
        if (state === "game") window.quake2GameMode.enter("frame-sample");
        else window.quake2GameMode.exit("frame-sample", { keepFullscreen: true });
        skip = 2;
      }
      if (frames >= 200) { resolve({ page, game }); return; }
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
    setTimeout(() => resolve({ page, game }), 240000);
  })`, { awaitPromise: true, timeoutMs: 300000 });
  const pageStats = (measured.page || []).length ? stats(measured.page) : null;
  const gameStats = (measured.game || []).length ? stats(measured.game) : null;
  const pageMean = pageStats ? pageStats.meanMs : null;
  const gameMean = gameStats ? gameStats.meanMs : null;
  const pageMedian = pageStats ? pageStats.medianMs : null;
  const gameMedian = gameStats ? gameStats.medianMs : null;
  const meanDelta = pageMean ? (pageMean - gameMean) / pageMean : null;
  const medianDelta = pageMedian ? (pageMedian - gameMedian) / pageMedian : null;
  if (pageStats && gameStats) {
    console.log("  " + label + " interleaved frames: page median " + pageMedian.toFixed(1) + " ms (mean " +
      pageMean.toFixed(1) + "), game median " + gameMedian.toFixed(1) + " ms (mean " + gameMean.toFixed(1) + ")");
  }
  // The frame is GPU-bound in this software renderer: the page's read-back is
  // 22% of main-thread samples but is hidden under the render, so the
  // wall-clock requirement is a no-regression bound; the work the mode removes
  // is checked directly above, where it is deterministic.
  check(label + ": game mode does not cost more per frame than the normal page",
    Boolean(pageStats) && Boolean(gameStats) && pageStats.count >= 60 && gameStats.count >= 60 &&
      gameMedian <= pageMedian * 1.02 && gameMean <= pageMean * 1.02,
    "median and mean frame time no worse than the normal page's, interleaved on one page and scene",
    pageStats && gameStats ? "page median " + pageMedian.toFixed(1) + " ms, mean " + pageMean.toFixed(1) +
      "; game median " + gameMedian.toFixed(1) + " ms, mean " + gameMean.toFixed(1) + " (" +
      (medianDelta * 100).toFixed(1) + "% median, " + (meanDelta * 100).toFixed(1) + "% mean)" : "no frame samples");
  await evaluate("window.quake2GameMode.exit('frame-sample', { keepFullscreen: true })");
  await sleep(500);

  // "Measurably cheaper per frame": the wall clock above is the software
  // renderer's GPU-bound frame and cannot show page work; the main thread's
  // task time can, because the status-bar read-back and the interface poll run
  // on it. The samples are per drawn frame (the page counts its own rAF
  // callbacks), interleaved on the same frozen scene, and every switch's
  // settling time is discarded.
  const cost = await measureMainThreadCost();
  const pairRatios = cost.pairs.map((pair) => pair.ratio);
  const pairMedian = median(pairRatios);
  const cheaperPairs = pairRatios.filter((ratio) => ratio < 0.98).length;
  const costDelta = pairMedian === null ? null : 1 - pairMedian;
  check(label + ": game mode costs measurably less main-thread work per drawn frame",
    cost.page.frames >= 12 && cost.game.frames >= 12 && cost.pairs.length >= 2 &&
      cheaperPairs >= Math.ceil(cost.pairs.length / 2) && pairMedian !== null && pairMedian < 0.98,
    "main-thread task time per drawn frame at least 2% lower in game mode, in most adjacent page/game pairs on one scene",
    costDelta === null ? "no main-thread samples" :
      "paired ratios (game/page) " + pairRatios.map((one) => one.toFixed(3)).join(", ") + " (median " +
      pairMedian.toFixed(3) + ", " + (costDelta * 100).toFixed(1) + "% less); " + cost.page.frames +
      " page frames and " + cost.game.frames + " game frames; a status-bar read-back costs " +
      (cost.readBackMs === null ? "n/a" : cost.readBackMs.toFixed(1) + " ms") + " and game mode performs none");
  await evaluate("window.quake2GameMode.exit('cost-sample', { keepFullscreen: true })");
  await sleep(500);

  // The shortcut, both ways: Alt+Enter enters, Alt+Enter leaves (and takes the
  // full screen with it).
  await pressAltEnter();
  await waitFor(async () => {
    const status = await gameModeStatus();
    return status && status.active === true;
  }, 10000, 300, "game mode to engage on Alt+Enter");
  const shortcutEntered = await gameModeStatus();
  await pressAltEnter();
  let left = null;
  try {
    await waitFor(async () => {
      const status = await gameModeStatus();
      return status && status.active === false;
    }, 10000, 300, "game mode to leave on Alt+Enter");
    left = await gameModeStatus();
  } catch (error) {
    fatal(label + ": Alt+Enter did not leave game mode: " + error.message);
  }
  await sleep(800);
  const after = await pageLayers();
  check(label + ": Alt+Enter enters and leaves game mode",
    shortcutEntered.active === true && left.active === false && after.ui && after.ui.display !== "none" &&
      after.ui.hidden === false && after.bodyClass.indexOf("is-game-mode") === -1 && after.modeValue === "off" &&
      after.fullscreenElement === false,
    "Alt+Enter enters; Alt+Enter leaves with the interface back, the row reading off and full screen released",
    JSON.stringify({ entered: shortcutEntered.active, left: left.active, ui: after.ui, bodyClass: after.bodyClass,
      value: after.modeValue, fullscreen: after.fullscreenElement }));

  // The mode also leaves when full screen is left by anyone else: the browser's
  // own Esc path, the fullscreen.js control, a system gesture.
  if (!(await ensureGame("before the full-screen-exit check"))) fatal(label + ": the game did not resume for the full-screen-exit check");
  await pressAltEnter();
  await waitFor(async () => {
    const status = await gameModeStatus();
    return status && status.active === true;
  }, 10000, 300, "game mode to re-engage on Alt+Enter");
  const reentered = await gameModeStatus();
  let exitedByFullscreen = null;
  try {
    if (reentered.fullscreen === true) {
      // The browser's own escape from full screen (Esc, the fullscreen.js
      // control, a system gesture) must leave the mode, never strand the page
      // interface hidden.
      await evaluate("document.exitFullscreen ? document.exitFullscreen().catch(() => {}) : null");
      await waitFor(async () => {
        const status = await gameModeStatus();
        return status && status.active === false;
      }, 10000, 300, "game mode to leave when full screen ends");
      exitedByFullscreen = await gameModeStatus();
    } else {
      note(label + ": full screen was refused in this headless run (" + reentered.reason + "); the mode's own exit is checked for the restoration path");
      await evaluate("window.quake2GameMode.exit('check')");
      await waitFor(async () => {
        const status = await gameModeStatus();
        return status && status.active === false;
      }, 10000, 300, "game mode to leave by its own exit");
      exitedByFullscreen = await gameModeStatus();
    }
  } catch (error) {
    fatal(label + ": game mode did not leave cleanly: " + error.message);
  }
  const restored = await pageLayers();
  check(label + ": leaving full screen leaves game mode",
    reentered.active === true && exitedByFullscreen.active === false && restored.ui && restored.ui.display !== "none",
    "Alt+Enter re-engages; leaving full screen disengages and restores the page",
    "re-entered " + reentered.active + " (fullscreen " + reentered.fullscreen + "), after exit active " +
      exitedByFullscreen.active + ", #ui " + (restored.ui && restored.ui.display));

  if (!(await ensureGame("after the game-mode check"))) fatal(label + ": the game did not resume after the game-mode check");
  if (!report.gameMode) report.gameMode = {};
  report.gameMode[label] = {
    api, row, enter: { ...entered, layers }, blackout,
    frames: { page: pageStats, game: gameStats, pageSamples: (measured.page || []).length,
      gameSamples: (measured.game || []).length, meanDelta, medianDelta },
    cpu: { page: cost.page, game: cost.game, delta: costDelta, pairs: cost.pairs, readBackMs: cost.readBackMs,
      samples: cost.samples },
    pageWork: { attemptsOnPage: pageWorkEnd - pageWorkStart, attemptsInGame: gameWorkEnd - gameWorkStart,
      readsOnPage: pageWorkReadsEnd - pageWorkReadsStart, seconds: pageWorkSeconds },
    screenshots: [beforeEntry.file, duringEntry.file],
    centreLuma: { page: Math.round(beforeLuma), game: Math.round(duringLuma) },
    exit: { byShortcut: left, byFullscreen: exitedByFullscreen },
  };
}

// ---- The crosshair's aim feedback (weapon, trigger, crouch) --------------

function crosshairBlendPixels(onImage, offImage, tint, radius = 22) {
  const cx = Math.round(onImage.width / 2), cy = Math.round(onImage.height / 2);
  let count = 0, minX = Infinity, minY = Infinity, maxX = -1, maxY = -1;
  const fractions = [];
  for (let y = cy - radius; y <= cy + radius; y++) {
    for (let x = cx - radius; x <= cx + radius; x++) {
      const at = (y * onImage.width + x) * 4;
      const on = [onImage.data[at], onImage.data[at + 1], onImage.data[at + 2]];
      const off = [offImage.data[at], offImage.data[at + 1], offImage.data[at + 2]];
      const perChannel = [];
      let isCross = true;
      for (let c = 0; c < 3; c++) {
        const denominator = tint[c] - off[c];
        if (Math.abs(denominator) < 25) continue;
        const fraction = (on[c] - off[c]) / denominator;
        if (fraction < 0.12 || fraction > 0.9) { isCross = false; break; }
        perChannel.push(fraction);
      }
      if (!isCross || !perChannel.length) continue;
      count++;
      fractions.push(median(perChannel));
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { count, minX, minY, maxX, maxY, cx, cy,
    width: maxX >= minX ? maxX - minX + 1 : 0, height: maxY >= minY ? maxY - minY + 1 : 0,
    alpha: median(fractions), fractions };
}

async function crosshairStateNow() {
  return evaluate("window.quake2RTX && window.quake2RTX.crosshairState ? window.quake2RTX.crosshairState() : null");
}

async function crosshairAlpha(alpha) {
  await evaluate("window.quake2RTX.crosshair({ alpha: " + Number(alpha) + " })");
}

// An on/off pair with the same scene, same weapon, same trigger and crouch
// state: the off frame is the renderer's own alpha set to zero. The diff is
// then the crosshair itself, which is what the size and opacity checks read.
// Freeze the simulation but keep the renderer running (`timescale`), so an
// on/off pair is one static picture. A weapon switch needs the server to run,
// so it happens between captures, never inside one.
async function freezeDemo(label, frozen) {
  await consoleBridge.runUntilEcho("timescale " + (frozen ? 0 : 1));
  if (!(await ensureGame((frozen ? "freezing" : "thawing") + " the demo for " + label))) {
    fatal(label + ": the game did not resume after timescale " + (frozen ? 0 : 1));
  }
  await sleep(frozen ? 900 : 600);
}

// Two pictures of the same scene: the fraction of sampled pixels that differ
// outside a square around the crosshair. An on/off pair is only a measurement
// of the crosshair if this is ~0; a ducking camera or a settling weapon
// animates for a moment after the input and turns the pair into two pictures
// (measured: the crouch pair's bbox grew to 22x31 because the view was still
// dropping when the "off" frame was taken).
function sceneDifferenceOutsideCentre(left, right, half = 30) {
  const cx = Math.round(left.width / 2), cy = Math.round(left.height / 2);
  let different = 0, total = 0;
  for (let y = 0; y < left.height; y += 2) {
    for (let x = 0; x < left.width; x += 2) {
      if (Math.abs(x - cx) <= half && Math.abs(y - cy) <= half) continue;
      const at = (y * left.width + x) * 4, bt = (y * right.width + x) * 4;
      total++;
      if (left.data[at] !== right.data[bt] || left.data[at + 1] !== right.data[bt + 1] ||
        left.data[at + 2] !== right.data[bt + 2]) different++;
    }
  }
  return total ? different / total : 1;
}

// A screenshot of a picture that has stopped changing: two captures a few
// frames apart agree. The simulation is frozen with `timescale`, but the
// camera's own duck/stand interpolation runs on real time, so a capture taken
// right after C is pressed is still moving.
async function steadyScreenshot(label) {
  let previous = await stableScreenshot();
  for (let attempt = 0; attempt < 6; attempt++) {
    await waitFrames(3);
    const next = await stableScreenshot();
    if (sceneDifferenceOutsideCentre(decodePng(previous), decodePng(next), 0) < 0.002) return next;
    previous = next;
  }
  note(label + ": the picture was still changing after six captures; using the last one");
  return previous;
}

async function crosshairAimPair(name, meta) {
  let on = null, off = null, onEntry = null, offEntry = null, stateOn = null, drift = 1;
  for (let attempt = 0; attempt < 2; attempt++) {
    on = await steadyScreenshot(name + " on capture");
    onEntry = await captureBuffer(name + "-on.png", on, 1280, 720, { ...meta, crosshair: "on" });
    stateOn = await crosshairStateNow();
    await crosshairAlpha(0);
    await waitFrames(2);
    // The crosshair is the only thing that may change: the scene was steady
    // before the capture, and hiding the cross changes nothing behind it.
    off = await stableScreenshot();
    offEntry = await captureBuffer(name + "-off.png", off, 1280, 720, { ...meta, crosshair: "off (alpha 0)" });
    await crosshairAlpha(stateOn ? stateOn.alpha : 0.45);
    await waitFrames(2);
    drift = sceneDifferenceOutsideCentre(decodePng(on), decodePng(off));
    if (drift < 0.001) break;
    note(name + ": the scene moved between the on and off frames (" + (drift * 100).toFixed(2) +
      "% of pixels outside the cross); retaking the pair");
    await sleep(1500);
  }
  return { on: decodePng(on), off: decodePng(off), onEntry, offEntry, state: stateOn, drift };
}

async function crosshairAimCheck(resolution) {
  const label = resolution.label;
  console.log("\n  " + label + " crosshair aim feedback");
  if (!(await ensureGame("the crosshair aim check"))) fatal(label + ": the game is not in game for the crosshair aim check");
  await setLighting("performance");
  const palette = paletteTintFromPak();
  if (!palette) fatal(label + ": the crosshair tint cannot be read from the game palette");
  const tint = palette.tint;
  const runtime = await evaluate("window.quake2RTX && typeof window.quake2RTX.crosshairState === 'function'");
  check(label + ": the renderer reports the crosshair's aim state", runtime === true,
    "window.quake2RTX.crosshairState()", runtime ? "present" : "missing");
  if (runtime !== true) fatal(label + ": the crosshair aim state is not exposed");

  // Ammunition for the weapon test (the blaster is always in hand) and a player
  // the level cannot kill mid-measurement: a dead player draws no view weapon,
  // so the weapon in hand would stop being readable.
  const before = await state();
  if (before.engine && before.engine.dead) {
    note(label + ": the player was dead before the crosshair aim check; restarting demo1");
    await restartDemo1(label);
  }
  await consoleBridge.runUntilEcho("give all");
  if (!(await ensureGame("after give all for the crosshair aim check"))) fatal(label + ": the game did not resume after give all");
  await consoleBridge.runUntilEcho("god");
  if (!(await ensureGame("after god for the crosshair aim check"))) fatal(label + ": the game did not resume after god");
  await sleep(1500);
  // The bridge's selectWeapon needs the page's binding map, which this app does
  // not expose (binds() comes back empty); the shipped config binds 1 to the
  // blaster and 2 to the shotgun, and the switch is proven by the state below.
  await consoleBridge.control.tap("1");
  await sleep(1200);
  let rest = await crosshairStateNow();
  check(label + ": the blaster is the crosshair's reference size", rest && rest.weapon === "v_blast" && Math.abs(rest.factor - 1) < 0.001 &&
    rest.quadPx === 24 && rest.opaquePx === 21,
    "v_blast, factor 1.00, 24px quad (21px opaque) at crosshair_scale 3",
    rest ? rest.weapon + ", factor " + rest.factor.toFixed(3) + ", quad " + rest.quadPx + "px, opaque " + rest.opaquePx + "px" : "no state");
  if (!rest) fatal(label + ": the crosshair state is unreadable");

  await freezeDemo(label, true);
  const restPair = await crosshairAimPair(label + "-crosshair-aim-blaster", { view: "the crosshair at rest with the blaster", resolution: label });
  await freezeDemo(label, false);
  const restPixels = crosshairBlendPixels(restPair.on, restPair.off, tint);
  check(label + ": the crosshair at rest is the engine's 21px scale-3 cross",
    restPixels.width >= 15 && restPixels.width <= 27 && restPixels.height >= 15 && restPixels.height <= 27 && restPixels.count >= 40,
    "a 15-27px tinted cross at the centre", restPixels.width + "x" + restPixels.height + " from " + restPixels.count + " tinted pixels");
  check(label + ": the crosshair's opacity is a little under half",
    rest.alpha === 0.45 && restPixels.alpha !== null && restPixels.alpha >= 0.33 && restPixels.alpha < 0.49,
    "0.45 configured (below the previous 0.500) and measured under 0.49",
    "configured " + rest.alpha + ", measured " + (restPixels.alpha === null ? "n/a" : restPixels.alpha.toFixed(3)) +
      " from " + restPixels.count + " tinted pixels");

  // The weapon in hand changes the size: the shotgun's skin is a different
  // size, and the spread table widens the cross for it.
  await consoleBridge.control.tap("2");
  let shotgun = null;
  try {
    await waitFor(async () => {
      const now = await crosshairStateNow();
      return now && now.weapon === "v_shotg";
    }, 15000, 500, "the shotgun to be in hand");
    shotgun = await crosshairStateNow();
  } catch (error) {
    fatal(label + ": the shotgun never came into hand: " + error.message);
  }
  await sleep(800);
  shotgun = await crosshairStateNow();
  await freezeDemo(label, true);
  const shotgunPair = await crosshairAimPair(label + "-crosshair-aim-shotgun", { view: "the crosshair at rest with the shotgun", resolution: label });
  await freezeDemo(label, false);
  const shotgunPixels = crosshairBlendPixels(shotgunPair.on, shotgunPair.off, tint);
  check(label + ": a heavier weapon widens the crosshair",
    shotgun.weapon === "v_shotg" && shotgun.factor > rest.factor + 0.05 && shotgun.quadPx > rest.quadPx &&
      shotgunPixels.width > restPixels.width,
    "the shotgun's cross is wider than the blaster's (factor > 1.05, more pixels)",
    shotgun.weapon + ", factor " + shotgun.factor.toFixed(3) + ", quad " + shotgun.quadPx + "px; measured " +
      shotgunPixels.width + "x" + shotgunPixels.height + " vs blaster " + restPixels.width + "x" + restPixels.height);

  // Firing grows it; releasing settles it back.
  // The same default-key switch as above.
  await consoleBridge.control.tap("1");
  await waitFor(async () => {
    const now = await crosshairStateNow();
    return now && now.weapon === "v_blast";
  }, 15000, 500, "the blaster back in hand");
  await sleep(800);
  const restAgain = await crosshairStateNow();
  await freezeDemo(label, true);
  const press = await consoleBridge.control.attackHold(true);
  let firing = null;
  try {
    await waitFor(async () => {
      const now = await crosshairStateNow();
      firing = now;
      return now && now.firing === true && now.fireLevel > 0.85;
    }, 8000, 300, "the trigger to spread the crosshair");
  } catch (error) {
    note(label + ": the trigger did not register on the page: " + error.message);
  }
  const firingPair = await crosshairAimPair(label + "-crosshair-aim-firing", { view: "the crosshair while firing", resolution: label });
  const firingPixels = crosshairBlendPixels(firingPair.on, firingPair.off, tint);
  const release = await consoleBridge.control.attackHold(false);
  check(label + ": holding the trigger grows the crosshair",
    Boolean(press.held) && firing && firing.firing === true && firing.fireLevel > 0.8 && firing.quadPx >= restAgain.quadPx + 3 &&
      firingPixels.width >= restPixels.width + 3,
    "fireLevel near 1 and a quad at least 3px larger while the trigger is held",
    "press " + JSON.stringify(press.held) + ", fireLevel " + (firing ? firing.fireLevel.toFixed(2) : "n/a") + ", quad " +
      (firing ? firing.quadPx + "px vs " + restAgain.quadPx + "px" : "n/a") + "; measured " + firingPixels.width + "x" +
      firingPixels.height + " vs " + restPixels.width + "x" + restPixels.height);
  let settled = null;
  try {
    await waitFor(async () => {
      const now = await crosshairStateNow();
      settled = now;
      return now && now.firing === false && now.fireLevel < 0.05;
    }, 8000, 300, "the crosshair to settle after firing");
  } catch (error) {
    note(label + ": the crosshair did not settle: " + error.message);
  }
  check(label + ": releasing the trigger settles the crosshair back",
    release.held === false && settled && settled.firing === false && settled.quadPx === restAgain.quadPx,
    "firing false and the rest size back",
    settled ? "firing " + settled.firing + ", fireLevel " + settled.fireLevel.toFixed(3) + ", quad " + settled.quadPx + "px (rest " + restAgain.quadPx + "px)" : "no state");
  await freezeDemo(label, false);

  // Crouching (C) shrinks it, and letting go restores it.
  await freezeDemo(label, true);
  await consoleBridge.control.key("c", true);
  let crouching = null;
  try {
    await waitFor(async () => {
      const now = await crosshairStateNow();
      crouching = now;
      return now && now.crouching === true && now.crouchLevel > 0.85;
    }, 8000, 300, "the crouch key to contract the crosshair");
  } catch (error) {
    note(label + ": the crouch key did not register on the page: " + error.message);
  }
  const crouchPair = await crosshairAimPair(label + "-crosshair-aim-crouch", { view: "the crosshair while crouching", resolution: label });
  const crouchPixels = crosshairBlendPixels(crouchPair.on, crouchPair.off, tint);
  await consoleBridge.control.key("c", false);
  check(label + ": crouching shrinks the crosshair",
    crouching && crouching.crouching === true && crouching.crouchLevel > 0.8 && crouching.quadPx <= restAgain.quadPx - 2 &&
      crouchPixels.width <= restPixels.width - 1,
    "crouchLevel near 1 and a quad at least 2px smaller while C is held",
    crouching ? "crouchLevel " + crouching.crouchLevel.toFixed(2) + ", quad " + crouching.quadPx + "px vs " + restAgain.quadPx +
      "px; measured " + crouchPixels.width + "x" + crouchPixels.height + " vs " + restPixels.width + "x" + restPixels.height : "no state");
  let stood = null;
  try {
    await waitFor(async () => {
      const now = await crosshairStateNow();
      stood = now;
      return now && now.crouching === false && now.crouchLevel < 0.05;
    }, 8000, 300, "standing back up");
  } catch (error) {
    note(label + ": the crouch state did not clear: " + error.message);
  }
  check(label + ": standing up restores the crosshair size",
    stood && stood.crouching === false && stood.quadPx === restAgain.quadPx,
    "crouching false and the rest size back",
    stood ? "crouching " + stood.crouching + ", quad " + stood.quadPx + "px" : "no state");
  await freezeDemo(label, false);

  if (!report.crosshairAim) report.crosshairAim = {};
  report.crosshairAim[label] = {
    tint, rest, shotgun, firing, settled, crouching, stood,
    pixels: { rest: { ...restPixels, fractions: undefined }, shotgun: { ...shotgunPixels, fractions: undefined },
      firing: { ...firingPixels, fractions: undefined }, crouch: { ...crouchPixels, fractions: undefined } },
    screenshots: [restPair.onEntry.file, restPair.offEntry.file, shotgunPair.onEntry.file, firingPair.onEntry.file, crouchPair.onEntry.file],
  };

  // crosshair_scale still sets the base size: the same record at scale 2 is
  // 16px, with a measured cross a couple of pixels narrower.
  await consoleBridge.runUntilEcho("timescale 1");
  await reloadGame(resolutionUrl(resolution, "+set&crosshair_scale&2"), label + " crosshair scale 2");
  if (!(await ensureGame("the crosshair scale-2 check"))) fatal(label + ": the game did not resume at crosshair_scale 2");
  // The same default-key switch as above.
  await consoleBridge.control.tap("1");
  await sleep(1500);
  const scaleTwo = await crosshairStateNow();
  await freezeDemo(label, true);
  const scalePair = await crosshairAimPair(label + "-crosshair-aim-scale2", { view: "the crosshair at crosshair_scale 2", resolution: label });
  await freezeDemo(label, false);
  const scalePixels = crosshairBlendPixels(scalePair.on, scalePair.off, tint);
  check(label + ": crosshair_scale still sets the base size",
    scaleTwo && scaleTwo.baseScale === 2 && scaleTwo.quadPx === 16 && scaleTwo.quadPx < rest.quadPx &&
      scalePixels.width < restPixels.width && scalePixels.width >= 9,
    "crosshair_scale 2 gives a 16px quad and a narrower measured cross than scale 3",
    scaleTwo ? "baseScale " + scaleTwo.baseScale + ", quad " + scaleTwo.quadPx + "px; measured " + scalePixels.width + "x" +
      scalePixels.height + " vs scale-3 " + restPixels.width + "x" + restPixels.height : "no state");
  report.crosshairAim[label].scaleTwo = { state: scaleTwo, pixels: { ...scalePixels, fractions: undefined } };

  // Back to the suite's own start-up line for the rest of the run (the page
  // keeps its query across reloads, and a scale-2 URL would reach the next
  // resolution's boots).
  await reloadGame(resolutionUrl(resolution, "+set&crosshair_scale&3"), label + " crosshair scale restored");
  if (!(await ensureGame("after the crosshair aim check"))) fatal(label + ": the game did not resume after the crosshair aim check");
}

// The happy path the menu promises: GAME > easy starts a new game. The app
// hands the map to the engine on its start-up line (it cannot type into the
// console), so the page reloads; this waits for the new page and the new game.
async function newGameCheck(label) {
  console.log("\n  " + label + " new game");
  if (!(await ensureGame("the New Game check"))) fatal(label + ": the game is not in game for the New Game check");
  if (!(await openMenu())) fatal(label + ": the main menu did not open for the New Game check");
  await click('[data-action="game"]');
  await sleep(400);
  const entries = await evaluate(`Array.from(document.querySelectorAll('.menu-view[data-view="game"] .label')).map((label) => label.textContent.trim())`);
  const engineEntries = ENGINE_MENU_TREE.game;
  check("GAME menu matches the engine's own game menu", JSON.stringify(entries) === JSON.stringify(engineEntries),
    engineEntries.join(", "), (entries || []).join(", "));
  await click('[data-action="newgame"][data-skill="0"]');
  await sleep(2500);
  let last = null;
  try {
    await waitFor(async () => {
      const now = await state();
      const position = now.engine && now.engine.position;
      last = { key: now.engine && now.engine.keyDestName, position, menuHidden: now.menuHidden, url: await evaluate("location.search") };
      return now.engine && now.engine.ok && now.engine.keyDestName === "game" && now.menuHidden === true && position &&
        Math.abs(position.x) + Math.abs(position.y) + Math.abs(position.z) > 1;
    }, 180000, 1000, "the new game to start");
  } catch (error) {
    fatal(label + ": the New Game did not start: " + error.message + " — last " + JSON.stringify(last));
  }
  check(label + ": New Game started a fresh level", true, "a running demo1 one reload after GAME > easy", JSON.stringify(last));
  report.newGame = { label, ...last };
  if (!report.menu) report.menu = { entries: null };
  report.menu.gameEntries = entries;
  await consoleBridge.reconnect();
  await animateDemo1(label);
  // The happy path's own frame: the first area after GAME > easy, which the
  // owner asked to see with the fixes on it.
  await sleep(4000);
  await capture(label + "-newgame-first-area.png", 1280, 720,
    { view: "demo1's first area after GAME > easy started a new game", resolution: label, source: "New Game" });
}

async function runModes(resolution) {
  for (const level of LIGHT_LEVELS) {
    console.log("\n  " + resolution.label + " / " + level);
    const presence = await state();
    if (presence.engine && presence.engine.dead) {
      note(resolution.label + "/" + level + ": player died; restarting demo1 for the capture");
      await waitDemo1(resolution.label);
    }
    await setLighting(level);
    const beforeMenu = await status();
    if (!(await openMenu())) fatal("the main menu did not open at " + resolution.label + " / " + level);
    await setLighting(level); // keep the chosen mode while the menu is up
    await waitFrames(3);
    const menuState = await state();
    check("main menu visible at " + resolution.label + " / " + level,
      menuState.menuHidden === false && menuState.engine && menuState.engine.keyDestName === "menu",
      "menu-layer visible", "menuHidden " + menuState.menuHidden + ", key_dest " + (menuState.engine && menuState.engine.keyDestName));
    // B1: the panel carries the engine's own main menu, entry for entry.
    const engineMenu = ["GAME", "MULTIPLAYER", "OPTIONS", "VIDEO", "QUIT"];
    check("menu entries match the engine's own main menu at " + resolution.label,
      JSON.stringify(menuState.menuEntries) === JSON.stringify(engineMenu),
      engineMenu.join(", "), (menuState.menuEntries || []).join(", "));
    if (!report.menu) report.menu = { entries: menuState.menuEntries, engineOrder: engineMenu, views: {} };
    // B4: while the engine's menu owns the keyboard its 2D draws are dropped,
    // so the old menu cannot show. The renderer counts every dropped draw.
    const afterMenuStatus = await status();
    const suppressed = (afterMenuStatus.suppressedDraws || 0) - (beforeMenu.suppressedDraws || 0);
    check("the engine's own menu is not drawn at " + resolution.label + " / " + level,
      suppressed > 0, "the renderer drops the engine menu's 2D draws",
      suppressed + " interface draws suppressed while the menu was open");
    await capture(resolution.label + "-" + level + "-menu.png", resolution.width, resolution.height,
      { view: "main menu", resolution: resolution.label, level, software: report.renderer ? /swiftshader|software|subzero|llvmpipe/i.test(String(report.renderer.renderer)) : null });

    await resume();
    await waitFrames(3);
    const before = await status();
    await waitFrames(2);
    const after = await status();
    const drawn = after.modelDraws > before.modelDraws && after.worldDraws > before.worldDraws;
    check("weapon geometry drawn at " + resolution.label + " / " + level, drawn,
      "modelDraws and worldDraws increase in game",
      "+" + (after.modelDraws - before.modelDraws) + " model draws, +" + (after.worldDraws - before.worldDraws) + " world draws");
    if (!drawn) fatal("no model draw was submitted in game at " + resolution.label + " / " + level);
    await capture(resolution.label + "-" + level + "-weapon.png", resolution.width, resolution.height,
      { view: "weapon in hand", resolution: resolution.label, level, software: report.renderer ? /swiftshader|software|subzero|llvmpipe/i.test(String(report.renderer.renderer)) : null });

    await frameRound(resolution.label + "/" + level, resolution.width, resolution.height, level, {});
  }
}

async function run() {
  fs.mkdirSync(SHOTS, { recursive: true });
  fs.mkdirSync(LOGS, { recursive: true });
  console.log("verify-presentation: " + options.url);
  const display = measureDisplay();
  const resolutions = [
    { label: "1280x720", width: 1280, height: 720 },
    display,
  ].filter((one, index, all) => all.findIndex((other) => other.label === one.label) === index);

  await ensureServer();
  const chrome = await startChrome();
  cdp = await connectPage(chrome.base);
  consoleBridge = new EngineConsole(chrome.base);
  await consoleBridge.connect();
  buildCoverage();

  let firstResolution = true;
  for (const resolution of resolutions) {
    await navigateResolution(resolution);
    await waitDemo1(resolution.label);
    if (firstResolution) {
      await readClGun(resolution.label);
      firstResolution = false;
    }
    await runModes(resolution);
    // Check the weapon after the modes: the first view-weapon draw can lag the
    // level start, and the screenshots have already exercised the scene by now.
    await weaponDrawCheck(resolution.label);
    await statusBarCheck(resolution);
    await crosshairPresentationCheck(resolution);
    if (resolution.label === "1280x720") {
      await presentationFixesCheck(resolution);
      await newGameCheck(resolution.label);
      await interfaceStateCheck(resolution);
      await gameModeCheck(resolution);
      await crosshairAimCheck(resolution);
    }
    const pageState = await state();
    report.webglPages.push({
      resolution: resolution.label,
      contextLost: (pageState.verify && pageState.verify.contextLost) || 0,
      isContextLost: pageState.contextLost === true,
    });
  }

  // Post-run error audit: everything the page said while it was being driven.
  const finalState = await state();
  const pageLost = report.webglPages.reduce((sum, one) => sum + one.contextLost, 0);
  report.webgl = {
    pages: report.webglPages,
    contextLost: pageLost,
    glLost: finalState.contextLost === true,
    warnings: report.webglWarnings,
  };
  check("no WebGL context lost during the run", report.webgl.contextLost === 0 && !report.webgl.glLost,
    "0 context losses across every boot", "events " + report.webgl.contextLost + ", isContextLost " + report.webgl.glLost);
  const webglWarnings = report.consoleWarnings.filter((one) => /WebGL/i.test(one.text));
  report.webglWarnings = webglWarnings;
  report.webgl.warnings = webglWarnings;
  if (webglWarnings.length) {
    note(webglWarnings.length + " non-fatal WebGL warnings (engine texture setup, recorded in consoleWarnings): " +
      JSON.stringify([...new Set(webglWarnings.map((one) => one.text))].slice(0, 4)));
  }
  check("no page exceptions", report.pageErrors.length === 0, "0", String(report.pageErrors.length));
  check("no JavaScript console errors", report.consoleErrors.length === 0, "0", String(report.consoleErrors.length));
  if (report.pageErrors.length) console.log("  page errors: " + JSON.stringify(report.pageErrors.slice(0, 5)));
  if (report.consoleErrors.length) console.log("  console errors: " + JSON.stringify(report.consoleErrors.slice(0, 5)));
  if (report.networkErrors.length) {
    note("non-fatal network 404s (optional probes; required files were hashed above): " +
      JSON.stringify(report.networkErrors.map((one) => one.url || one.text).slice(0, 8)));
  }

  report.limitations = [
    "The runner forces headless Chrome onto ANGLE/SwiftShader (--use-angle=swiftshader --enable-unsafe-swiftshader); the box's Intel GPU is not exercised, so every frame time is software and is not the owner's frame rate.",
    "The engine renders at the r_mode the runner sets (14 = 1280x720, 25 = 2560x1440); screenshots are the viewport at the same size.",
    "Only demo1 (Outer Base) is driven; the crosshair's weapon test switches to the shotgun and back with the engine's own weapon binds. Enemy coverage is level placement in demo1, not per-frame visibility.",
    "Game mode's multi-display blackout needs the Window Management API and a second display. This headless run has one display and no such permission, so it checks the mode's honest report of that (`blackout`), not a real second monitor going black; the single-display presentation, the frame cost and the page restoration are exercised.",
    "Audio, pointer lock, mouse look and saved games are not exercised by this headless run.",
    "20 rAF samples give a nearest-rank p95; it is a small sample and not a percentile-tail measurement.",
  ];
}

// ---- Teardown ------------------------------------------------------------

async function teardown() {
  if (consoleBridge) await consoleBridge.close().catch(() => {});
  if (cdp) cdp.close();
  if (chromeChild) {
    try { chromeChild.child.kill("SIGTERM"); } catch { /* already gone */ }
    await Promise.race([
      new Promise((resolve) => chromeChild.child.once("exit", resolve)),
      sleep(5000),
    ]);
    try { chromeChild.child.kill("SIGKILL"); } catch { /* already gone */ }
    try { await fsp.rm(chromeChild.profile, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  if (serverChild) {
    try { serverChild.kill("SIGTERM"); } catch { /* already gone */ }
    await Promise.race([
      new Promise((resolve) => serverChild.once("exit", resolve)),
      sleep(3000),
    ]);
    try { serverChild.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

function finish(exitCode) {
  report.ok = exitCode === 0 && !report.fatal && report.checks.every((one) => one.ok);
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2) + "\n");
  } catch (error) {
    console.error("could not write report.json: " + error.message);
  }
  console.log("\n" + (report.ok ? "PASS" : "FAIL") + " — " + report.checks.filter((one) => one.ok).length + "/" + report.checks.length +
    " checks; report " + path.relative(ROOT, path.join(OUT, "report.json")));
  if (report.fatal) console.error("fatal: " + report.fatal);
  process.exitCode = exitCode;
}

let exitCode = 1;
try {
  await run();
  exitCode = report.checks.every((one) => one.ok) ? 0 : 1;
} catch (error) {
  if (!report.fatal) report.fatal = String(error && error.message ? error.message : error);
  console.error("\nverification failed: " + report.fatal);
  exitCode = 1;
} finally {
  await teardown();
  finish(exitCode);
}
