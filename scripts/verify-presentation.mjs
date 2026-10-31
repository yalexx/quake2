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
  for (const file of ["index.html", "style.css", "rtx-renderer.js", "app.js", "fullscreen.js",
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
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: `window.__q2verify = { contextLost: 0, contextLostAt: null };
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
  return captureBuffer(name, await screenshotBuffer(), width, height, meta);
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
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: resolution.width, height: resolution.height, deviceScaleFactor: 1, mobile: false,
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
      strip = await canvasStrip(consoleBridge.control, { band: 40, waitMs: label === "2560x1440" ? 2500 : 1200 });
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
// The bright pair uses the menu maximum colour intensity with overbrights at
// 2: at the menu's default 1.3 the same spawn only reached a background luma
// median of 46.7, so the "brighter background" check had no pixels above 100
// and could not pass. Measured across boots at 2: the spawn lands around 80-90,
// which is far enough above the dark pair to prove the blend on a lit surface
// while staying far enough below the bone tint (#ddb589, luma 186) that the
// per-channel blend still has contrast to solve an alpha from.
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

async function crosshairBoot(resolution, name, crosshair, bright) {
  const label = resolution.label;
  const suffix = crosshair === "0" ? "-off" : "";
  const brightness = bright ? BRIGHT_STARTUP : DARK_STARTUP;
  await reloadGame(resolutionUrl(resolution, "+set&crosshair&" + crosshair + brightness),
    label + " crosshair " + name + " " + crosshair);
  if (!(await ensureGame("crosshair " + name + " " + crosshair + " capture"))) {
    fatal(label + ": the game did not resume for the crosshair-" + name + " " + crosshair + " capture");
  }
  await waitFrames(3);
  await waitForVisibleScene(label + " crosshair-" + name + " " + crosshair + " frame");
  // The engine's loading plaque fades out a moment after the first picture;
  // let it finish so the capture is the player's view, not the plaque.
  await sleep(10000);
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
  const off = await crosshairBoot(resolution, name, "0", bright);
  return { on: on.image, off: off.image, onEntry: on.entry, offEntry: off.entry,
    centreLumaOn: on.centreLuma, centreLumaOff: off.centreLuma,
    onDraws: on.draws, offDraws: off.draws };
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
        alphaStart === "0.5" && tintStart === tintHex,
      "tint " + JSON.stringify(tint) + " from pics/colormap.pcx entries 52 (" + JSON.stringify(palette.amber) +
        ") and 251 (" + JSON.stringify(palette.bone) + "), started as q2_crosshair_alpha 0.5 / q2_crosshair_tint " + tintHex,
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
  await reloadGame(resolutionUrl(resolution, DARK_STARTUP), label + " brightness defaults restored");
  if (!(await ensureGame("after restoring the brightness defaults"))) fatal(label + ": the game did not resume after restoring the brightness defaults");
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
    "Only demo1 (Outer Base) is driven and only the starting Blaster is in hand. Enemy coverage is level placement in demo1, not per-frame visibility.",
    "Audio, pointer lock, mouse look, saves and the fullscreen API are not exercised by this headless run.",
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
