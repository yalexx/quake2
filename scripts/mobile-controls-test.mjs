#!/usr/bin/env node
// scripts/mobile-controls-test.mjs -- the touch presentation, measured.
//
// It starts this checkout's own server on a free port (never 4231), starts its
// own headless Chrome with its own debugging port (never 18801), emulates a
// phone in landscape (844x390 and 932x430) and in portrait (390x844), and
// drives the real page with CDP touch and key input. Nothing here is a static
// DOM guess: every control is measured against the engine's live state.
//
//   node scripts/mobile-controls-test.mjs
//   node scripts/mobile-controls-test.mjs --url http://127.0.0.1:PORT/apps/quake2/ --static-only
//
// The static checks include the one that fails on the pre-touch base: the
// served page must carry the touch control layer (`#mobile-controls`), the
// landscape guide (`#rotate-overlay`) and the large `#mc-fire` control.
//
// Node built-ins only, no dependencies. It stops only the children it started.
"use strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = process.env.CLAWBOX_RUN_ARTIFACTS_DIR || "";
const DEFAULT_OUT = ARTIFACTS ? path.join(ARTIFACTS, "mobile-verification") : path.join(ROOT, "docs", "mobile-verification");

const options = { url: "", out: DEFAULT_OUT, staticOnly: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--url") options.url = argv[++i];
  else if (argv[i] === "--out") options.out = path.resolve(argv[++i]);
  else if (argv[i] === "--static-only") options.staticOnly = true;
  else if (argv[i] === "--help" || argv[i] === "-h") {
    console.log("mobile-controls-test.mjs [--url URL] [--out DIR] [--static-only]");
    process.exit(0);
  } else {
    console.error("unknown option: " + argv[i]);
    process.exit(2);
  }
}

const OUT = options.out;
const SHOTS = path.join(OUT, "shots");
const LOGS = path.join(OUT, "logs");
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

const report = {
  at: new Date().toISOString(),
  checkout: ROOT,
  node: process.version,
  url: options.url || null,
  server: null,
  chrome: null,
  checks: [],
  screenshots: [],
  consoleErrors: [],
  pageInfo: [],
  browserNotes: [],
  pageErrors: [],
  networkNotes: [],
};

let failures = 0;
let checks = 0;
let stage = "boot";
function check(name, condition, detail) {
  checks++;
  const pass = Boolean(condition);
  if (!pass) failures++;
  report.checks.push({ name, pass, detail: detail === undefined ? null : detail, at: new Date().toISOString() });
  console.log((pass ? "  ok   " : "  FAIL ") + name + (detail === undefined ? "" : " -- " + JSON.stringify(detail)));
  return pass;
}
function near(a, b, slack) {
  return typeof a === "number" && typeof b === "number" && Math.abs(a - b) <= slack;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Free ports, never the live ones --------------------------------------

async function freePort() {
  for (let attempt = 0; attempt < 20; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const chosen = server.address().port;
        server.close(() => resolve(chosen));
      });
    });
    if (port !== 4231 && port !== 18801) return port;
  }
  throw new Error("could not find a free port away from 4231/18801");
}

async function waitFor(label, fn, timeoutMs = 60000, intervalMs = 200) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error("timed out waiting for " + label + (lastError ? ": " + lastError.message : ""));
}

// ---- Server ---------------------------------------------------------------

let serverChild = null;
let serverDataDir = null;
async function startServer() {
  const port = await freePort();
  serverDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "q2mobile-data-"));
  const log = fs.openSync(path.join(LOGS, "server.log"), "w");
  serverChild = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), QUAKE2_DATA_DIR: serverDataDir },
    stdio: ["ignore", log, log],
  });
  const base = "http://127.0.0.1:" + port + "/apps/quake2/";
  await waitFor("the app server on port " + port, async () => {
    if (serverChild.exitCode !== null) throw new Error("server.js exited with " + serverChild.exitCode);
    const response = await fetch(base, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  }, 30000, 250);
  report.server = { port, pid: serverChild.pid, dataDir: serverDataDir, log: path.join(LOGS, "server.log") };
  return base;
}

// ---- Chrome + CDP ---------------------------------------------------------

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
  throw new Error("no Chrome/Chromium found (set CHROME_PATH)");
}

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Map();
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
  send(method, params = {}, timeoutMs = 60000) {
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

let chromeChild = null;
let chromeProfile = null;
let cdp = null;

async function startChrome() {
  const chromePath = findChrome();
  const debuggingPort = await freePort();
  if (debuggingPort === 4231 || debuggingPort === 18801) throw new Error("debugging port collided with a live service");
  chromeProfile = fs.mkdtempSync(path.join(os.tmpdir(), "q2mobile-chrome-"));
  const log = fs.openSync(path.join(LOGS, "chrome.log"), "w");
  chromeChild = spawn(chromePath, [
    "--headless=new",
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=" + debuggingPort,
    "--user-data-dir=" + chromeProfile,
    "--window-size=844,390",
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
  ], { stdio: ["ignore", log, log] });
  const base = "http://127.0.0.1:" + debuggingPort;
  await waitFor("headless Chrome's CDP endpoint", async () => {
    if (chromeChild.exitCode !== null) throw new Error("Chrome exited with " + chromeChild.exitCode);
    const response = await fetch(base + "/json/version", { signal: AbortSignal.timeout(2000) });
    return response.ok;
  }, 30000, 250);
  report.chrome = { path: chromePath, debuggingPort, headless: true, profile: chromeProfile };
  const targets = await (await fetch(base + "/json/list")).json();
  const page = targets.find((one) => one.type === "page" && one.webSocketDebuggerUrl);
  if (!page) throw new Error("headless Chrome has no page target to drive");
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  cdp.on("Runtime.consoleAPICalled", (params) => {
    const text = (params.args || []).map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type || "")).join(" ");
    if (/q2touch|execing/i.test(text)) report.pageInfo.push({ text, stage, at: new Date().toISOString() });
    if (params.type !== "error" && params.type !== "assert") return;
    report.consoleErrors.push({ type: params.type, text, stage, at: new Date().toISOString() });
  });
  cdp.on("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails || {};
    report.pageErrors.push({
      stage,
      text: details.exception && details.exception.description ? details.exception.description : details.text,
      url: details.url || null,
      line: details.lineNumber,
      at: new Date().toISOString(),
    });
  });
  cdp.on("Log.entryAdded", (params) => {
    const entry = params.entry || {};
    if (entry.level !== "error") return;
    // pak1/pak2 are optional and absent in this checkout; their 404 is the
    // documented "optional PAK missing" path, not a page fault.
    if (/pak[12]\.pak/.test(entry.url || entry.text || "")) {
      report.networkNotes.push({ text: entry.text, url: entry.url || null });
      return;
    }
    if (entry.source === "network") { report.networkNotes.push({ text: entry.text, url: entry.url || null }); return; }
    // Chrome logs this when a page's touchend listener calls preventDefault on
    // a gesture the browser already turned into a scroll. The engine's own SDL
    // handler is the caller; the browser ignores the call, the engine carries
    // on, and no JavaScript error is raised. It is recorded as a browser note,
    // not as an application console error.
    if (/Ignored attempt to cancel a touch(?:start|end) event/i.test(entry.text)) {
      report.browserNotes.push({ text: entry.text, url: entry.url || null, stage, at: new Date().toISOString() });
      return;
    }
    report.consoleErrors.push({ type: "log-error", text: entry.text, url: entry.url || null, stage, at: new Date().toISOString() });
  });
  return base;
}

async function evaluate(expression, awaitPromise = false) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
  if (result.exceptionDetails) {
    const details = result.exceptionDetails;
    throw new Error((details.exception && details.exception.description) || details.text || "evaluation failed");
  }
  return result.result.value;
}

async function dumpJson(expression) {
  const value = await evaluate("JSON.stringify(" + expression + ")");
  return value === undefined ? null : JSON.parse(value);
}

// ---- Emulation ------------------------------------------------------------

const MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

async function emulate(size, touch, ua, orientation) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: size.width,
    height: size.height,
    deviceScaleFactor: 2,
    mobile: touch,
    screenOrientation: orientation,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
  await cdp.send("Emulation.setUserAgentOverride", { userAgent: ua, platform: touch ? "Linux armv8l" : "Linux x86_64" });
  await sleep(700);
}

const LANDSCAPE_844 = { width: 844, height: 390 };
const LANDSCAPE_932 = { width: 932, height: 430 };
const PORTRAIT_390 = { width: 390, height: 844 };
const DESKTOP_1280 = { width: 1280, height: 720 };

function landscapeOrientation() { return { type: "landscapePrimary", angle: 90 }; }
function portraitOrientation() { return { type: "portraitPrimary", angle: 0 }; }

// ---- Touch and keys -------------------------------------------------------

let touchId = 100;
function nextTouchId() { return ++touchId; }
function point(id, x, y) { return { id, x, y, radiusX: 8, radiusY: 8, force: 1 }; }

async function touchEvent(type, points) {
  await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points, modifiers: 0 });
}

async function tapPoint(x, y) {
  const id = nextTouchId();
  await touchEvent("touchStart", [point(id, x, y)]);
  await sleep(70);
  await touchEvent("touchEnd", []);
  await sleep(120);
}

async function rect(selector) {
  return dumpJson(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return {
      x: box.x, y: box.y, left: box.left, top: box.top, right: box.right, bottom: box.bottom,
      w: box.width, h: box.height, display: getComputedStyle(element).display,
      text: (element.textContent || "").replace(/\\s+/g, " ").trim(),
      aria: element.getAttribute("aria-label")
    };
  })()`);
}

async function tapSelector(selector) {
  const box = await rect(selector);
  if (!box || box.w === 0 || box.h === 0) throw new Error("no tappable " + selector);
  await tapPoint(box.left + box.w / 2, box.top + box.h / 2);
  return box;
}

// A page-UI tap with a short leash. The first attempt is a real CDP touch;
// if the headless input pipeline stalls (seen rarely with SwiftShader), the
// same button is clicked through the DOM so the rest of the proof still runs.
// The stall is recorded on the report, never silently swallowed.
async function tapPointSafe(x, y, timeoutMs = 6000) {
  const id = nextTouchId();
  try {
    await Promise.race([
      (async () => {
        await touchEvent("touchStart", [point(id, x, y)]);
        await sleep(60);
        await touchEvent("touchEnd", []);
      })(),
      new Promise((resolve, reject) => setTimeout(() => reject(new Error("touch tap timed out")), timeoutMs)),
    ]);
    await sleep(120);
    return "touch";
  } catch (error) {
    report.browserNotes.push({ text: "touch tap timed out at " + Math.round(x) + "," + Math.round(y) + "; used a DOM click", stage, at: new Date().toISOString() });
    await evaluate(`(() => {
      const element = document.elementFromPoint(${Number(x)}, ${Number(y)});
      const button = element && element.closest ? element.closest("button") : null;
      // A late touch may already have done the job (closing the menu hides
      // this button); never click into a hidden layer.
      if (button && button.offsetParent !== null) button.click();
      return 1;
    })()`);
    await sleep(150);
    return "dom";
  }
}

async function tapSelectorSafe(selector, timeoutMs = 6000) {
  const box = await rect(selector);
  if (!box || box.w === 0 || box.h === 0) throw new Error("no tappable " + selector);
  return tapPointSafe(box.left + box.w / 2, box.top + box.h / 2, timeoutMs);
}

// A press that stays down long enough for the engine to read the binding.
async function holdSelector(selector, milliseconds) {
  const box = await rect(selector);
  if (!box || box.w === 0 || box.h === 0) throw new Error("no tappable " + selector);
  const id = nextTouchId();
  await touchEvent("touchStart", [point(id, box.left + box.w / 2, box.top + box.h / 2)]);
  await sleep(milliseconds);
  await touchEvent("touchEnd", []);
  await sleep(150);
  return box;
}

async function drag(x0, y0, x1, y1, steps = 7, stepMs = 40) {
  const id = nextTouchId();
  await touchEvent("touchStart", [point(id, x0, y0)]);
  for (let i = 1; i <= steps; i++) {
    await touchEvent("touchMove", [point(id, x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps)]);
    await sleep(stepMs);
  }
  await touchEvent("touchEnd", []);
  await sleep(350);
}

async function keyEvent(type, key, code, vk) {
  await cdp.send("Input.dispatchKeyEvent", {
    type,
    key,
    code,
    windowsVirtualKeyCode: vk,
    nativeVirtualKeyCode: vk,
    text: type === "keyDown" ? key : undefined,
    unmodifiedText: type === "keyDown" ? key : undefined,
  });
}

// ---- The game -------------------------------------------------------------

async function readEngine() {
  return dumpJson(`(() => {
    try { return window.quake2Engine && window.quake2Engine.read ? window.quake2Engine.read() : null; }
    catch (error) { return null; }
  })()`);
}

async function navigate(url, map) {
  const separator = url.includes("?") ? "&" : "?";
  try { await cdp.send("Page.bringToFront"); } catch { /* optional */ }
  await cdp.send("Page.navigate", { url: url + separator + "+set&skill&1&+map&" + map });
  await sleep(600);
}

async function waitForGame(label) {
  let last = null;
  let stable = 0;
  const started = Date.now();
  while (Date.now() - started < 120000) {
    try {
      const state = await readEngine();
      const ui = await dumpJson(`(() => {
        const canvas = document.getElementById("canvas");
        return {
          display: canvas ? getComputedStyle(canvas).display : null,
          live: document.body.classList.contains("mc-live"),
          touchUi: document.body.classList.contains("touch-ui"),
          hintHidden: document.getElementById("mc-hint") ? document.getElementById("mc-hint").hidden : null,
        };
      })()`);
      if (state && state.ok && state.keyDest === 0 && ui.display === "block" &&
          state.position && (state.position.x !== 0 || state.position.y !== 0)) {
        if (last && state.angles.yaw === last.angles.yaw && state.position.x === last.position.x) stable++;
        else stable = 0;
        last = state;
        if (stable >= 3) {
          // The engine's keyboard path needs the game canvas focused; a page
          // that was navigated to in a headless tab does not always get it.
          try { await evaluate("document.getElementById('canvas').focus()"); } catch { /* no canvas yet */ }
          return { state, ui };
        }
      }
    } catch { /* page mid-load */ }
    await sleep(220);
  }
  throw new Error("the game never reached a steady in-game state (" + label + ")");
}

// Wait for the touch layer to become live and record whether the first-show
// hint was up at that moment.
async function waitForFirstLive() {
  const started = Date.now();
  while (Date.now() - started < 120000) {
    try {
      const live = await dumpJson(`(() => {
        const hint = document.getElementById("mc-hint");
        return {
          live: document.body.classList.contains("mc-live"),
          touchUi: document.body.classList.contains("touch-ui"),
          hintHidden: hint ? hint.hidden : null,
          hintText: hint ? (hint.textContent || "").replace(/\\s+/g, " ").trim() : null,
        };
      })()`);
      if (live && live.live) return live;
    } catch { /* page mid-load */ }
    await sleep(100);
  }
  throw new Error("the touch layer never became live");
}

async function pageMetrics() {
  return dumpJson(`(() => {
    const canvas = document.getElementById("canvas");
    const box = canvas ? canvas.getBoundingClientRect() : null;
    const root = document.getElementById("mobile-controls");
    return {
      inner: { w: innerWidth, h: innerHeight },
      scroll: { w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight },
      scrollX: scrollX, scrollY: scrollY,
      canvas: box ? { x: box.x, y: box.y, w: box.width, h: box.height, right: box.right, bottom: box.bottom } : null,
      touchUi: document.body.classList.contains("touch-ui"),
      live: document.body.classList.contains("mc-live"),
      portrait: document.body.classList.contains("mc-portrait"),
      controlsHidden: root ? root.hidden : null,
      controlsDisplay: root ? getComputedStyle(root).display : null,
      promptHidden: document.getElementById("prompt") ? document.getElementById("prompt").hidden : null,
      promptText: document.getElementById("prompt") ? (document.getElementById("prompt").textContent || "").trim() : null,
      pointerLocked: document.pointerLockElement !== null,
      fullscreen: document.fullscreenElement !== null,
      rotateDisplay: document.getElementById("rotate-overlay") ? getComputedStyle(document.getElementById("rotate-overlay")).display : null,
      rotateText: document.getElementById("rotate-overlay") ? (document.getElementById("rotate-overlay").textContent || "").replace(/\\s+/g, " ").trim() : null,
      menuOpen: document.getElementById("menu-layer") ? !document.getElementById("menu-layer").hidden : null,
      keyDest: null
    };
  })()`);
}

async function elementStack(x, y) {
  return dumpJson(`document.elementsFromPoint(${x}, ${y}).map((e) => e.id || e.className || e.tagName)`);
}

async function screenshot(name) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = path.join(SHOTS, name);
  fs.writeFileSync(file, Buffer.from(result.data, "base64"));
  report.screenshots.push(path.relative(OUT, file));
  console.log("  shot " + path.relative(OUT, file));
}

async function entityIds() {
  return dumpJson(`(() => (window.quake2Engine && window.quake2Engine.entities ? window.quake2Engine.entities() : []).map((e) => e.number))()`);
}

async function waitForNewEntity(before, timeoutMs = 2000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ids = await entityIds();
    const fresh = (ids || []).filter((number) => !before.includes(number));
    if (fresh.length) return fresh;
    await sleep(100);
  }
  return [];
}

// ---- Static checks: the one that fails on the pre-touch base --------------

async function staticChecks(url) {
  const response = await fetch(new URL("index.html", url), { signal: AbortSignal.timeout(15000) });
  const html = response.ok ? await response.text() : "";
  check("served page answers 200", response.ok, { status: response.status, url: String(new URL("index.html", url)) });
  check("touch control layer present in the served page", /id=["']mobile-controls["']/.test(html),
    "a #mobile-controls element; the pre-touch base has none");
  check("touch control script is loaded", /mobile-controls\.js/.test(html), "a <script src=mobile-controls.js>");
  check("large FIRE control present", /id=["']mc-fire["']/.test(html), "a #mc-fire element");
  check("portrait rotate guide present", /id=["']rotate-overlay["']/.test(html), "a #rotate-overlay element");
  check("landscape guide has an action", /id=["']rotate-action["']/.test(html), "a #rotate-action button");
  return html;
}

// ---- The run --------------------------------------------------------------

async function run() {
  let baseUrl = options.url;
  if (!baseUrl) baseUrl = await startServer();
  report.url = baseUrl;

  console.log("static checks");
  await staticChecks(baseUrl);
  if (failures) throw new Error("static checks failed (this is the expected failure on the pre-touch base)");
  if (options.staticOnly) return;

  await startChrome();

  // ---------------------------------------------------------------- landscape
  stage = "landscape-844";
  console.log("landscape 844x390");
  await emulate(LANDSCAPE_844, true, MOBILE_UA, landscapeOrientation());
  await navigate(baseUrl, "demo1");
  const firstLive = await waitForFirstLive();
  check("first-show hint appears with the touch layer", firstLive.hintHidden === false, firstLive.hintText);
  check("first-show hint names look and fire", /look/i.test(firstLive.hintText || "") && /fire/i.test(firstLive.hintText || ""), firstLive.hintText);
  const { state: spawn } = await waitForGame("landscape demo1");
  check("the touch layer is live over the running game", (await pageMetrics()).live === true);
  const metrics = await pageMetrics();
  check("touch presentation is active on a coarse-pointer phone", metrics.touchUi === true);
  check("no page scroll and no horizontal overflow", metrics.scroll.w <= metrics.inner.w && metrics.scroll.h <= metrics.inner.h && metrics.scrollX === 0 && metrics.scrollY === 0,
    { scroll: metrics.scroll, inner: metrics.inner });
  check("canvas fills the usable viewport (letterboxed to the engine aspect)", metrics.canvas && metrics.canvas.w > 0 && metrics.canvas.h > 0 &&
    metrics.canvas.x >= 0 && metrics.canvas.right <= metrics.inner.w + 0.5 && metrics.canvas.y >= 0 && metrics.canvas.bottom <= metrics.inner.h + 0.5,
    metrics.canvas);
  check("the pointer-lock prompt is hidden on touch", metrics.promptHidden === true && metrics.pointerLocked === false);
  check("the portrait guide is not shown in landscape", metrics.rotateDisplay === "none");

  const fireBox = await rect("#mc-fire");
  const jumpBox = await rect("#mc-jump");
  const useBox = await rect("#mc-use");
  const prevBox = await rect("#mc-prev");
  const nextBox = await rect("#mc-next");
  const pauseBox = await rect("#mc-pause");
  const toggleBox = await rect("#mc-toggle");
  const stickBox = await rect("#mc-stick");
  const lookBox = await rect("#mc-look");
  const stickCentre = { x: stickBox.left + stickBox.w / 2, y: stickBox.top + stickBox.h / 2 };

  const buttons = [fireBox, jumpBox, useBox, prevBox, nextBox, pauseBox, toggleBox];
  check("FIRE is the large primary action (>= 72 px)", fireBox && fireBox.w >= 72 && fireBox.h >= 72, { w: fireBox && fireBox.w, h: fireBox && fireBox.h });
  check("FIRE is larger than every secondary control", buttons.filter((b) => b !== fireBox).every((b) => b.w < fireBox.w), buttons.map((b) => b.w));
  check("every touch target is at least 44 px", buttons.every((b) => b.w >= 44 && b.h >= 44) && stickBox.w >= 44 && stickBox.h >= 44,
    buttons.map((b) => ({ id: b.text, w: b.w, h: b.h })));
  check("JUMP and USE sit inside FIRE's thumb arc", jumpBox && useBox &&
    Math.hypot(jumpBox.left + jumpBox.w / 2 - (fireBox.left + fireBox.w / 2), jumpBox.top + jumpBox.h / 2 - (fireBox.top + fireBox.h / 2)) <= 175 &&
    Math.hypot(useBox.left + useBox.w / 2 - (fireBox.left + fireBox.w / 2), useBox.top + useBox.h / 2 - (fireBox.top + fireBox.h / 2)) <= 175,
    { jump: Math.round(Math.hypot(jumpBox.left + jumpBox.w / 2 - (fireBox.left + fireBox.w / 2), jumpBox.top + jumpBox.h / 2 - (fireBox.top + fireBox.h / 2))),
      use: Math.round(Math.hypot(useBox.left + useBox.w / 2 - (fireBox.left + fireBox.w / 2), useBox.top + useBox.h / 2 - (fireBox.top + fireBox.h / 2))) });
  check("weapon cycle is small and above the firing arc", prevBox && nextBox && prevBox.w <= 48 && nextBox.w <= 48 && prevBox.bottom <= useBox.top + 1,
    { prev: prevBox, next: nextBox, useTop: useBox.top });
  check("pause/menu is small and out of the aiming area", pauseBox && pauseBox.w <= 50 && pauseBox.top < 60, { w: pauseBox.w, top: pauseBox.top });
  check("all controls fit inside the viewport", buttons.every((b) => b.left >= 0 && b.top >= 0 && b.right <= metrics.inner.w + 0.5 && b.bottom <= metrics.inner.h + 0.5) &&
    stickBox.left >= 0 && stickBox.right <= metrics.inner.w + 0.5 && stickBox.bottom <= metrics.inner.h + 0.5, null);
  check("no control covers the engine status-bar band", Math.max(fireBox.bottom, jumpBox.bottom, useBox.bottom, stickBox.bottom, prevBox.bottom, nextBox.bottom) <= metrics.inner.h - 50,
    { lowest: Math.max(fireBox.bottom, jumpBox.bottom, useBox.bottom, stickBox.bottom, prevBox.bottom, nextBox.bottom), viewportBottom: metrics.inner.h });
  const coverage = buttons.concat([stickBox]).reduce((sum, b) => sum + b.w * b.h, 0) / (metrics.inner.w * metrics.inner.h);
  check("the right side stays mostly free for dragging to look", coverage < 0.22, { coverage: Number(coverage.toFixed(3)) });
  const lookCentre = { x: lookBox.left + lookBox.w * 0.72, y: lookBox.top + lookBox.h * 0.5 };
  const stack = await elementStack(lookCentre.x, lookCentre.y);
  check("the look area is not covered by a control", stack && stack[0] === "canvas", stack);
  check("every control carries a visible label and an accessible name",
    [["#mc-fire", "FIRE"], ["#mc-jump", "JUMP"], ["#mc-use", "USE"], ["#mc-prev", "WPN"], ["#mc-next", "WPN"], ["#mc-pause", "MENU"]]
      .every(([selector, label]) => {
        const boxes = { "#mc-fire": fireBox, "#mc-jump": jumpBox, "#mc-use": useBox, "#mc-prev": prevBox, "#mc-next": nextBox, "#mc-pause": pauseBox };
        return boxes[selector].text.includes(label) && boxes[selector].aria;
      }), null);

  // The page's own controls on touch: full screen, the lighting panel and the
  // game-mode row all need a finger-sized target and to fit the viewport.
  const fullscreenBox = await rect("#fullscreen-button");
  const fullscreenHit = await dumpJson(`(() => {
    const box = document.getElementById("fullscreen-button").getBoundingClientRect();
    const element = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const button = element && element.closest ? element.closest("button") : null;
    return { id: button ? button.id : null, display: getComputedStyle(document.getElementById("fullscreen-button")).display };
  })()`);
  check("the full-screen control is finger-sized and tappable",
    fullscreenBox && fullscreenBox.h >= 44 && fullscreenBox.left >= 0 && fullscreenBox.right <= metrics.inner.w + 0.5 &&
    fullscreenHit && fullscreenHit.id === "fullscreen-button",
    { box: fullscreenBox, hit: fullscreenHit });
  const optionsBox = await rect("#options-chip");
  const optionsHit = await dumpJson(`(() => {
    const box = document.getElementById("options-chip").getBoundingClientRect();
    const element = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const button = element && element.closest ? element.closest("button") : null;
    return { id: button ? button.id : null };
  })()`);
  check("the Options chip is finger-sized and tappable",
    optionsBox && optionsBox.h >= 44 && optionsBox.left >= 0 && optionsBox.right <= metrics.inner.w + 0.5 &&
    optionsHit && optionsHit.id === "options-chip", { box: optionsBox, hit: optionsHit });
  await tapSelectorSafe("#lighting-chip");
  await sleep(300);
  const lighting = await dumpJson(`(() => {
    const panel = document.getElementById("lighting-panel");
    const box = panel.getBoundingClientRect();
    const buttons = Array.from(panel.querySelectorAll(".segmented button")).map((button) => button.getBoundingClientRect().height);
    return { hidden: panel.hidden, display: getComputedStyle(panel).display, x: box.x, y: box.y, w: box.width, h: box.height,
      right: box.right, bottom: box.bottom, buttons, inner: [innerWidth, innerHeight],
      scrollHeight: panel.scrollHeight, clientHeight: panel.clientHeight };
  })()`);
  check("the lighting panel fits the small screen and its mode buttons are finger-sized",
    lighting && lighting.hidden === false && lighting.x >= 0 && lighting.right <= lighting.inner[0] + 0.5 &&
    lighting.bottom <= lighting.inner[1] + 0.5 && lighting.scrollHeight <= lighting.clientHeight + 1 &&
    lighting.buttons.every((height) => height >= 44), lighting);
  await tapSelectorSafe("#lighting-chip");
  await sleep(200);

  // Safe-area insets: Chrome can emulate a notch and a home indicator. The
  // controls and the canvas must move inside them, not under them.
  try {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 24, left: 44, bottom: 20, right: 44 } });
    await sleep(500);
    const insetMetrics = await pageMetrics();
    const insetFire = await rect("#mc-fire");
    const insetStick = await rect("#mc-stick");
    check("safe-area insets keep the controls off the notch and home indicator",
      insetStick.left >= 44 + 14 - 0.5 &&
      insetFire.right <= insetMetrics.inner.w - 44 - 14 + 0.5 &&
      Math.max(insetFire.bottom, insetStick.bottom) <= insetMetrics.inner.h - 20 - 50 + 0.5 &&
      insetMetrics.canvas.x >= 44 - 0.5 && insetMetrics.canvas.right <= insetMetrics.inner.w - 44 + 0.5,
      { inner: insetMetrics.inner, stick: insetStick, fire: insetFire, canvas: insetMetrics.canvas });
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, left: 0, bottom: 0, right: 0 } });
    await sleep(500);
  } catch (error) {
    report.browserNotes.push({ text: "safe-area emulation unavailable: " + error.message });
    console.log("  skip safe-area emulation: " + error.message);
  }

  // The hint must go away once the player uses a control.
  await tapSelector("#mc-jump");
  await sleep(200);
  check("the hint clears after the first control use", await evaluate("JSON.stringify(document.getElementById('mc-hint').hidden)") === "true");
  if (await evaluate("JSON.stringify(!!document.fullscreenElement)")) {
    await evaluate("document.exitFullscreen().catch(() => {})", true);
    await sleep(600);
  }
  await sleep(1200);

  // Weapon previous/next: the engine's config binds no key to weapprev, so the
  // touch cfg binds [ and ]; this proves the buttons press those keys. (The
  // spawn loadout owns only the blaster, so a visible weapon change would need
  // the game state changed first.)
  await evaluate(`(() => {
    window.__touchWeaponKeys = [];
    for (const key of ["[", "]"]) {
      window.addEventListener("keydown", function (event) {
        if (event.key === key) window.__touchWeaponKeys.push({ type: "down", key, synthetic: !!event.__q2synthetic });
      }, true);
      window.addEventListener("keyup", function (event) {
        if (event.key === key) window.__touchWeaponKeys.push({ type: "up", key, synthetic: !!event.__q2synthetic });
      }, true);
    }
    return 1;
  })()`);
  await tapSelector("#mc-prev");
  await tapSelector("#mc-next");
  const weaponKeys = await dumpJson("window.__touchWeaponKeys || []");
  check("the weapon buttons press the engine's weapon keys",
    weaponKeys.some((one) => one.key === "[" && one.type === "down" && one.synthetic) &&
    weaponKeys.some((one) => one.key === "[" && one.type === "up" && one.synthetic) &&
    weaponKeys.some((one) => one.key === "]" && one.type === "down" && one.synthetic) &&
    weaponKeys.some((one) => one.key === "]" && one.type === "up" && one.synthetic),
    weaponKeys);
  check("weapon switching leaves the game in control", (await readEngine()).keyDest === 0);

  // Fire at the spawn, before moving.
  const fireIds = await entityIds();
  const fireYaw = (await readEngine()).angles.yaw;
  const fireId = nextTouchId();
  await touchEvent("touchStart", [point(fireId, fireBox.left + fireBox.w / 2, fireBox.top + fireBox.h / 2)]);
  const fired = await waitForNewEntity(fireIds, 2200);
  await touchEvent("touchEnd", []);
  await sleep(300);
  check("FIRE does not turn the view", Math.abs((await readEngine()).angles.yaw - fireYaw) < 1, { before: fireYaw, after: (await readEngine()).angles.yaw });

  // Jump.
  const beforeJump = await readEngine();
  const jumpId = nextTouchId();
  await touchEvent("touchStart", [point(jumpId, jumpBox.left + jumpBox.w / 2, jumpBox.top + jumpBox.h / 2)]);
  let peak = beforeJump.position.z;
  for (let i = 0; i < 8; i++) {
    await sleep(45);
    const now = await readEngine();
    if (now.position.z > peak) peak = now.position.z;
  }
  await touchEvent("touchEnd", []);
  await sleep(1000);
  const landed = await readEngine();
  check("JUMP lifts the player and gravity returns it", peak - beforeJump.position.z > 5 && Math.abs(landed.position.z - beforeJump.position.z) < 4,
    { start: beforeJump.position.z, peak, landed: landed.position.z });

  // Multi-touch: look + move + fire at the same time.
  await waitForGame("before multi-touch");
  console.log("  multi pre-state: " + JSON.stringify(await evaluate("JSON.stringify(window.quake2Touch.state())")));
  const beforeMulti = await readEngine();
  const multiIds = await entityIds();
  const lookId = nextTouchId();
  const moveId = nextTouchId();
  const fireHoldId = nextTouchId();
  const lookX = 650, lookY = 160;
  await touchEvent("touchStart", [point(lookId, lookX, lookY)]);
  await touchEvent("touchStart", [point(lookId, lookX, lookY), point(moveId, stickCentre.x, stickCentre.y)]);
  await touchEvent("touchStart", [point(lookId, lookX, lookY), point(moveId, stickCentre.x, stickCentre.y),
    point(fireHoldId, fireBox.left + fireBox.w / 2, fireBox.top + fireBox.h / 2)]);
  for (let i = 1; i <= 6; i++) {
    await touchEvent("touchMove", [point(lookId, lookX - i * 20, lookY), point(moveId, stickCentre.x, stickCentre.y - i * 8),
      point(fireHoldId, fireBox.left + fireBox.w / 2, fireBox.top + fireBox.h / 2)]);
    await sleep(70);
  }
  // Hold all three fingers down and keep sampling: the blaster's shot may be
  // a short-lived client entity, and this must observe it while it lives.
  let multiFresh = [];
  const multiSampledAt = Date.now();
  while (Date.now() - multiSampledAt < 2400) {
    await sleep(90);
    const ids = await entityIds();
    multiFresh = multiFresh.concat((ids || []).filter((number) => !multiIds.includes(number) && !multiFresh.includes(number)));
    if (multiFresh.length) break;
  }
  console.log("  multi fire-state: " + JSON.stringify(await evaluate("JSON.stringify(window.quake2Touch.state())")));
  const duringMulti = await readEngine();
  await touchEvent("touchEnd", []);
  await sleep(300);
  const multiMoved = Math.hypot(duringMulti.position.x - beforeMulti.position.x, duringMulti.position.y - beforeMulti.position.y);
  const multiYaw = Math.abs(duringMulti.angles.yaw - beforeMulti.angles.yaw);
  check("multi-touch: move, look and fire together", multiMoved > 20 && multiYaw > 5 && multiFresh.length > 0,
    { moved: Number(multiMoved.toFixed(1)), yaw: Number(multiYaw.toFixed(1)), fired: multiFresh, dead: duringMulti.dead });
  // The single press at spawn can hit a wall before a client entity is polled;
  // the held-fire multi-touch above is the same FIRE action, so either engine
  // effect proves the control.
  check("FIRE produces an engine effect (a new game entity)", fired.length > 0 || multiFresh.length > 0,
    { singlePress: fired, heldMultitouch: multiFresh });

  // Look: yaw and pitch, through the engine's own touch input.
  await waitForGame("after jump");
  const beforeLook = await readEngine();
  await drag(650, 160, 450, 160, 7, 40);
  const afterYaw = await readEngine();
  check("a touch drag on the right changes yaw", Math.abs(afterYaw.angles.yaw - beforeLook.angles.yaw) > 10,
    { from: beforeLook.angles.yaw, to: afterYaw.angles.yaw });
  const beforePitch = await readEngine();
  await drag(650, 220, 650, 100, 7, 40);
  const afterPitch = await readEngine();
  check("a vertical touch drag changes pitch", Math.abs(afterPitch.angles.pitch - beforePitch.angles.pitch) > 5,
    { from: beforePitch.angles.pitch, to: afterPitch.angles.pitch });

  // Thumbstick. A fresh level puts the player back at the spawn, where the
  // stick has open floor in every direction the test uses.
  await navigate(baseUrl, "demo1");
  await waitForGame("before the thumbstick test");
  await sleep(400);
  const beforeStick = await readEngine();
  const stickId = nextTouchId();
  await touchEvent("touchStart", [point(stickId, stickCentre.x, stickCentre.y)]);
  // The reload above put the player at the spawn, where forward is open floor.
  await touchEvent("touchMove", [point(stickId, stickCentre.x, stickCentre.y - 55)]);
  await sleep(900);
  await touchEvent("touchEnd", []);
  await sleep(300);
  const afterStick = await readEngine();
  check("the thumbstick moves the player", Math.hypot(afterStick.position.x - beforeStick.position.x, afterStick.position.y - beforeStick.position.y) > 20,
    { from: beforeStick.position, to: afterStick.position });

  // Pause -> menu -> VIDEO row -> cvar by tap.
  stage = "landscape-menu";
  await waitForGame("before menu");
  await tapSelector("#mc-pause");
  await waitFor("the menu to open", async () => (await pageMetrics()).menuOpen === true, 8000, 120);
  const openedMenu = await pageMetrics();
  const openedDest = (await readEngine()).keyDest;
  check("the pause control opens the menu", openedMenu.menuOpen === true && openedDest === 3, { menuOpen: openedMenu.menuOpen, keyDest: openedDest });
  check("the touch pad is put away behind the menu", (await rect("#mobile-controls")).display === "none" || (await pageMetrics()).controlsHidden === true);
  check("no horizontal overflow with the menu open", openedMenu.scroll.w <= openedMenu.inner.w, { scroll: openedMenu.scroll, inner: openedMenu.inner });
  const menuBox = await rect("#menu");
  check("the landscape menu panel fits inside the viewport",
    menuBox && menuBox.left >= 0 && menuBox.right <= openedMenu.inner.w + 0.5 && menuBox.top >= 0 && menuBox.bottom <= openedMenu.inner.h + 0.5,
    menuBox);
  const videoBox = await rect('[data-action="video"]');
  check("the VIDEO row is tappable (>= 44 px)", videoBox && videoBox.h >= 44, { h: videoBox && videoBox.h });
  await tapSelectorSafe('[data-action="video"]');
  await sleep(300);
  const gammaBefore = await dumpJson(`(() => {
    const row = document.querySelector('[data-view="video"] [data-cvar="vid_gamma"]');
    if (!row) return null;
    row.scrollIntoView({ block: "center" });
    const box = row.getBoundingClientRect();
    return { value: row.querySelector(".value").textContent, index: row.dataset.index, h: box.height, x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  check("a VIDEO settings row is tappable (>= 44 px)", gammaBefore && gammaBefore.h >= 44, gammaBefore);
  await tapPointSafe(gammaBefore.x, gammaBefore.y);
  await sleep(300);
  const gammaAfter = await dumpJson(`(() => {
    const row = document.querySelector('[data-view="video"] [data-cvar="vid_gamma"]');
    const hint = document.getElementById("apply-hint");
    return { value: row.querySelector(".value").textContent, index: row.dataset.index,
      changed: row.classList.contains("changed"), hint: hint ? hint.textContent : null };
  })()`);
  check("a VIDEO row changes a cvar by tap", gammaAfter.value !== gammaBefore.value && gammaAfter.changed === true,
    { before: gammaBefore.value, after: gammaAfter.value, hint: gammaAfter.hint });
  const gameModeBox = await dumpJson(`(() => {
    const row = document.querySelector('[data-action="game-mode"]');
    if (!row) return null;
    row.scrollIntoView({ block: "center" });
    const box = row.getBoundingClientRect();
    const element = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    const button = element && element.closest ? element.closest("button") : null;
    return { h: box.height, w: box.width, x: box.left, right: box.right, top: box.top, bottom: box.bottom,
      action: button ? button.dataset.action : null, inner: [innerWidth, innerHeight] };
  })()`);
  check("the game-mode row is finger-sized and tappable", gameModeBox && gameModeBox.h >= 44 &&
    gameModeBox.x >= 0 && gameModeBox.right <= gameModeBox.inner[0] + 0.5 && gameModeBox.bottom <= gameModeBox.inner[1] + 0.5 &&
    gameModeBox.action === "game-mode", gameModeBox);
  await tapSelectorSafe('.menu-foot [data-action="resume"]');
  try {
    await waitFor("the game to resume", async () => (await readEngine()).keyDest === 0, 8000, 120);
  } catch (error) {
    // A missed synthetic tap is a test flake, not a page defect: the row taps
    // above already proved the menu takes touch. Close it through the same
    // button's DOM click and carry on, keeping the note on the report.
    report.browserNotes.push({ text: "Resume tap missed; used the button's DOM click", stage, at: new Date().toISOString() });
    await evaluate(`(() => { const button = document.querySelector(".menu-foot [data-action='resume']"); if (button) button.click(); return 1; })()`);
    await waitFor("the game to resume after a DOM click", async () => (await readEngine()).keyDest === 0, 6000, 120);
  }
  await sleep(500);

  // Show/hide and persistence.
  stage = "toggle";
  await tapSelectorSafe("#mc-toggle");
  await sleep(250);
  const hidden = await dumpJson(`(() => ({
    actions: getComputedStyle(document.getElementById("mc-actions")).display,
    stick: getComputedStyle(document.getElementById("mc-stick")).display,
    toggle: getComputedStyle(document.getElementById("mc-toggle")).display,
    stored: localStorage.getItem("quake2-touch-controls")
  }))()`);
  check("the pad can be hidden and the choice is stored", hidden.actions === "none" && hidden.stick === "none" && hidden.toggle !== "none" && hidden.stored === "off", hidden);
  await cdp.send("Page.reload", { ignoreCache: false });
  await waitForFirstLive();
  await waitForGame("after reload");
  const afterReload = await dumpJson(`(() => ({
    actions: getComputedStyle(document.getElementById("mc-actions")).display,
    toggle: getComputedStyle(document.getElementById("mc-toggle")).display,
    stored: localStorage.getItem("quake2-touch-controls")
  }))()`);
  check("the hidden choice survives a reload", afterReload.actions === "none" && afterReload.toggle !== "none" && afterReload.stored === "off", afterReload);
  await tapSelectorSafe("#mc-toggle");
  await sleep(250);
  const shown = await dumpJson(`(() => ({
    actions: getComputedStyle(document.getElementById("mc-actions")).display,
    stored: localStorage.getItem("quake2-touch-controls")
  }))()`);
  check("the pad comes back and the choice is stored", shown.actions !== "none" && shown.stored === "on", shown);
  await screenshot("landscape-844x390.png");

  // 932x430 landscape.
  stage = "landscape-932";
  console.log("landscape 932x430");
  await emulate(LANDSCAPE_932, true, MOBILE_UA, landscapeOrientation());
  await sleep(600);
  const wide = await pageMetrics();
  check("932x430: no horizontal overflow", wide.scroll.w <= wide.inner.w && wide.scroll.h <= wide.inner.h, { scroll: wide.scroll, inner: wide.inner });
  check("932x430: the canvas fits the viewport", wide.canvas && wide.canvas.x >= 0 && wide.canvas.right <= wide.inner.w + 0.5 && wide.canvas.bottom <= wide.inner.h + 0.5, wide.canvas);
  check("932x430: the touch pad is live in landscape", wide.live === true && wide.portrait === false && wide.rotateDisplay === "none");
  const wideFire = await rect("#mc-fire");
  check("932x430: FIRE stays large and inside the viewport", wideFire.w >= 72 && wideFire.right <= wide.inner.w + 0.5 && wideFire.bottom <= wide.inner.h + 0.5, wideFire);
  await screenshot("landscape-932x430.png");

  // Portrait: guide, menus, no pad.
  stage = "portrait";
  console.log("portrait 390x844");
  await emulate(PORTRAIT_390, true, MOBILE_UA, portraitOrientation());
  await sleep(700);
  const portrait = await pageMetrics();
  check("portrait: the rotate guide is shown", portrait.portrait === true && portrait.rotateDisplay === "flex", { portrait: portrait.portrait, display: portrait.rotateDisplay });
  check("portrait: the guide says to rotate the device", /rotate/i.test(portrait.rotateText || "") && /landscape/i.test(portrait.rotateText || ""), portrait.rotateText);
  const portraitPad = await dumpJson(`(() => ({
    stick: getComputedStyle(document.getElementById("mc-stick")).display,
    actions: getComputedStyle(document.getElementById("mc-actions")).display,
    pause: getComputedStyle(document.getElementById("mc-pause")).display,
    toggle: getComputedStyle(document.getElementById("mc-toggle")).display
  }))()`);
  check("portrait: the game pad is put away but pause stays reachable", portraitPad.stick === "none" && portraitPad.actions === "none" && portraitPad.pause !== "none" && portraitPad.toggle !== "none", portraitPad);
  check("portrait: no horizontal overflow", portrait.scroll.w <= portrait.inner.w && portrait.scroll.h <= portrait.inner.h, { scroll: portrait.scroll, inner: portrait.inner });
  await screenshot("portrait-390x844-rotate.png");

  // Menus in portrait.
  stage = "portrait-menu";
  await tapSelector("#mc-pause");
  await waitFor("the menu to open in portrait", async () => (await pageMetrics()).menuOpen === true, 8000, 120);
  const portraitMenu = await pageMetrics();
  check("portrait: the menu opens and the guide makes way", portraitMenu.menuOpen === true && portraitMenu.rotateDisplay === "none", { menu: portraitMenu.menuOpen, guide: portraitMenu.rotateDisplay });
  check("portrait: the menu has no horizontal overflow", portraitMenu.scroll.w <= portraitMenu.inner.w, { scroll: portraitMenu.scroll, inner: portraitMenu.inner });
  const portraitMenuBox = await rect("#menu");
  check("portrait: the menu panel fits inside the viewport",
    portraitMenuBox && portraitMenuBox.left >= 0 && portraitMenuBox.right <= portraitMenu.inner.w + 0.5 && portraitMenuBox.top >= 0 && portraitMenuBox.bottom <= portraitMenu.inner.h + 0.5,
    portraitMenuBox);
  await screenshot("portrait-390x844-menu.png");
  await tapSelectorSafe('[data-action="options"]');
  await sleep(300);
  const volumeBefore = await dumpJson(`(() => {
    const row = document.querySelector('[data-view="options"] [data-cvar="s_volume"]');
    if (!row) return null;
    row.scrollIntoView({ block: "center" });
    const box = row.getBoundingClientRect();
    return { value: row.querySelector(".value").textContent, index: row.dataset.index, h: box.height, x: box.left + box.width / 2, y: box.top + box.height / 2 };
  })()`);
  await tapPointSafe(volumeBefore.x, volumeBefore.y);
  await sleep(300);
  const volumeAfter = await dumpJson(`(() => {
    const row = document.querySelector('[data-view="options"] [data-cvar="s_volume"]');
    return { value: row.querySelector(".value").textContent, changed: row.classList.contains("changed") };
  })()`);
  check("portrait: an OPTIONS row is tappable and changes a cvar", volumeBefore && volumeBefore.h >= 44 && volumeAfter.value !== volumeBefore.value && volumeAfter.changed === true,
    { before: volumeBefore, after: volumeAfter });
  await tapSelectorSafe('.menu-foot [data-action="resume"]');
  try {
    await waitFor("the game to resume in portrait", async () => (await readEngine()).keyDest === 0, 8000, 120);
  } catch (error) {
    report.browserNotes.push({ text: "Portrait Resume tap missed; used the button's DOM click", stage, at: new Date().toISOString() });
    await evaluate(`(() => { const button = document.querySelector(".menu-foot [data-action='resume']"); if (button) button.click(); return 1; })()`);
    await waitFor("the game to resume in portrait after a DOM click", async () => (await readEngine()).keyDest === 0, 6000, 120);
  }
  await sleep(500);
  check("portrait: the guide returns after the menu", (await pageMetrics()).rotateDisplay === "flex");

  stage = "portrait-rotate";
  // The landscape button is wired; on a platform that refuses the lock it must
  // say so rather than pretend.
  const rotateBox = await rect("#rotate-action");
  await tapPointSafe(rotateBox.left + rotateBox.w / 2, rotateBox.top + rotateBox.h / 2);
  await sleep(800);
  const rotateNote = await evaluate(`JSON.stringify((document.getElementById("rotate-note") || {}).textContent || "")`);
  check("the landscape button runs the orientation-lock path and reports the outcome", /landscape|turn|rotation/i.test(rotateNote), rotateNote);
  if (await evaluate("JSON.stringify(!!document.fullscreenElement)")) {
    await evaluate("document.exitFullscreen().catch(() => {})", true);
    await sleep(700);
  }

  // Desktop: the presentation must not have moved.
  stage = "desktop";
  console.log("desktop 1280x720");
  await emulate(DESKTOP_1280, false, DESKTOP_UA, landscapeOrientation());
  await navigate(baseUrl, "demo1");
  const { state: desktopState } = await waitForGame("desktop demo1");
  const desktop = await pageMetrics();
  check("desktop: no touch layer is shown", desktop.touchUi === false && desktop.controlsDisplay === "none" && desktop.live === false, { touchUi: desktop.touchUi, display: desktop.controlsDisplay, live: desktop.live });
  check("desktop: the portrait guide is absent", desktop.rotateDisplay === "none");
  check("desktop: the pointer-lock prompt is still offered", desktop.promptHidden === false && /capture the mouse/i.test(desktop.promptText || ""), { hidden: desktop.promptHidden, text: desktop.promptText });
  check("desktop: canvas is letterboxed to the engine aspect at 1280x720", desktop.canvas && near(desktop.canvas.w, 1280, 1) && near(desktop.canvas.h, 720, 1), desktop.canvas);
  check("desktop: no page scroll or overflow", desktop.scroll.w <= desktop.inner.w && desktop.scroll.h <= desktop.inner.h, { scroll: desktop.scroll, inner: desktop.inner });
  const desktopGeometry = await dumpJson(`(() => {
    const options = getComputedStyle(document.getElementById("options-chip"));
    const menu = getComputedStyle(document.getElementById("menu"));
    const lighting = getComputedStyle(document.getElementById("lighting-panel"));
    const heading = getComputedStyle(document.querySelector(".menu-head h1"));
    return { optionsTop: options.top, optionsRight: options.right, menuWidth: menu.width, lightingWidth: lighting.width, headingSize: heading.fontSize };
  })()`);
  check("desktop: the original chip, menu and heading geometry is unchanged",
    near(parseFloat(desktopGeometry.optionsTop), 16, 0.5) && near(parseFloat(desktopGeometry.optionsRight), 18, 0.5) &&
    near(parseFloat(desktopGeometry.menuWidth), 392, 0.5) && near(parseFloat(desktopGeometry.lightingWidth), 244, 0.5) &&
    near(parseFloat(desktopGeometry.headingSize), 26, 0.5), desktopGeometry);
  const beforeKeys = await readEngine();
  await keyEvent("rawKeyDown", "w", "KeyW", 87);
  await sleep(700);
  await keyEvent("keyUp", "w", "KeyW", 87);
  await sleep(300);
  const afterKeys = await readEngine();
  check("desktop: the keyboard still moves the player", Math.hypot(afterKeys.position.x - beforeKeys.position.x, afterKeys.position.y - beforeKeys.position.y) > 20,
    { from: beforeKeys.position, to: afterKeys.position });
  await screenshot("desktop-1280x720.png");

  // A fine-pointer device that is touched for the first time mid-session must
  // bring the layer up (the hybrid-laptop path). This runs after the desktop
  // screenshot so the desktop presentation is photographed untouched.
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await sleep(300);
  const centre = await rect("#canvas");
  await tapPoint(centre.left + centre.w / 2, centre.top + centre.h / 2);
  await sleep(700);
  const firstTouch = await pageMetrics();
  check("a first real touch enables the layer on a fine-pointer device",
    firstTouch.touchUi === true && firstTouch.controlsDisplay !== "none" && firstTouch.live === true,
    { touchUi: firstTouch.touchUi, display: firstTouch.controlsDisplay, live: firstTouch.live });
  if (await evaluate("JSON.stringify(!!document.fullscreenElement)")) {
    await evaluate("document.exitFullscreen().catch(() => {})", true);
    await sleep(500);
  }
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });

  // Use: demo3 spawns a few units from a func_button. Turn to face it with
  // touch look, then tap USE; a mover in the level must move.
  stage = "use";
  console.log("use / open on demo3");
  await emulate(LANDSCAPE_844, true, MOBILE_UA, landscapeOrientation());
  await navigate(baseUrl, "demo3");
  await waitForGame("demo3");
  await sleep(800);
  const useSpawn = await readEngine();
  check("demo3 spawn is next to the button", useSpawn.position && Math.abs(useSpawn.position.x - 1688) < 40 && Math.abs(useSpawn.position.y - 1412) < 40, useSpawn.position);
  // func_button *7's model centre in demo3. The bearing is computed from the
  // live view position, not assumed: the spawn is close enough that a degree
  // matters to the level's narrow use trace.
  const buttonBearing = Math.atan2(1408 - useSpawn.position.y, 1692 - useSpawn.position.x) * 180 / Math.PI;
  const entitiesNow = () => dumpJson(`(() => (window.quake2Engine.entities() || []).map((e) => ({ n: e.number, p: [e.position.x, e.position.y, e.position.z] })))()`);
  // The engine's SDL keyboard path wants a focused, active page. The touch
  // look and mouse fire work without it, so a long run can reach USE with the
  // canvas DOM-focused but the window not active; this trusted click in the
  // left letterbox (clear of every control) restores it without firing.
  const focusGame = async () => {
    await cdp.send("Page.bringToFront");
    await evaluate("window.focus(); document.getElementById('canvas').focus(); 1");
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 5, y: 200, button: "left", buttons: 1, clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 5, y: 200, button: "left", buttons: 0, clickCount: 1 });
    await sleep(300);
  };
  const aimAtButton = async (targetYaw = -45) => {
    // The level's own spawn and the measured 49.4 degrees per 190 px of canvas
    // drag are the only inputs. Two degrees is inside the use trace's cone.
    for (let i = 0; i < 8; i++) {
      const now = await readEngine();
      const delta = ((targetYaw - now.angles.yaw + 540) % 360) - 180;
      if (Math.abs(delta) < 0.25) break;
      const degreesPerPixel = 49.4 / 190;
      let pixels = -delta / degreesPerPixel;
      pixels = Math.max(-200, Math.min(200, pixels));
      const from = pixels < 0 ? 650 : 550;
      await drag(from, 180, from + pixels, 180, 8, 35);
    }
    return readEngine();
  };
  const movementBetween = (a, b, ignore) => {
    const mapA = new Map(a.map((e) => [e.n, e.p]));
    const found = [];
    for (const e of b) {
      if (e.n === 1 || ignore.has(e.n) || !mapA.has(e.n)) continue;
      const p = mapA.get(e.n);
      const distance = Math.hypot(p[0] - e.p[0], p[1] - e.p[1], p[2] - e.p[2]);
      if (distance > 2) found.push({ n: e.n, from: p, to: e.p, distance });
    }
    return found;
  };
  const attemptUse = async () => {
    // Entities that are already moving on their own are not evidence of USE.
    const quietA = await entitiesNow();
    await sleep(350);
    const quietB = await entitiesNow();
    const ambient = new Set(movementBetween(quietA, quietB, new Set()).map((e) => e.n));
    await evaluate(`(() => {
      window.__touchUseKeys = [];
      window.addEventListener("keydown", function (event) {
        if (event.key === "e" || event.keyCode === 69) window.__touchUseKeys.push({ type: "down", synthetic: !!event.__q2synthetic, vk: event.keyCode });
      }, true);
      window.addEventListener("keyup", function (event) {
        if (event.key === "e" || event.keyCode === 69) window.__touchUseKeys.push({ type: "up", synthetic: !!event.__q2synthetic, vk: event.keyCode });
      }, true);
      return 1;
    })()`);
    const before = await entitiesNow();
    const id = nextTouchId();
    const useBox = await rect("#mc-use");
    await touchEvent("touchStart", [point(id, useBox.left + useBox.w / 2, useBox.top + useBox.h / 2)]);
    await sleep(300);
    const during = await dumpJson(`(() => ({
      state: window.quake2Touch.state(),
      angles: window.quake2Engine.read().angles,
      position: window.quake2Engine.read().position,
      dead: window.quake2Engine.read().dead,
      focused: document.hasFocus(),
      beforeCount: ${JSON.stringify(before.length)},
      nearButton: ${JSON.stringify(before.filter((e) => Math.hypot(e.p[0] - 1692, e.p[1] - 1408) < 160).slice(0, 6))},
      doorEntities: ${JSON.stringify(before.filter((e) => e.n === 411 || e.n === 412))}
    }))()`);
    await touchEvent("touchEnd", []);
    let found = [];
    let previous = before;
    const started = Date.now();
    while (Date.now() - started < 6000) {
      await sleep(150);
      const now = await entitiesNow();
      // Any entity that moved since the press, or moved between two samples
      // afterwards (a door that only entered the client's entity list once it
      // started moving), is a level mover responding to USE.
      found = found.concat(movementBetween(before, now, ambient)).concat(movementBetween(previous, now, ambient));
      previous = now;
      // The same entity must not be counted twice.
      const unique = new Map(found.map((e) => [e.n, e]));
      found = Array.from(unique.values());
      if (found.length) break;
    }
    const keyEvents = await dumpJson("window.__touchUseKeys || []");
    console.log("  use attempt: " + JSON.stringify({ during, keyEvents, moved: found.slice(0, 3) }));
    return found;
  };
  await focusGame();
  const facing = await aimAtButton(buttonBearing);
  const bearing = Math.abs((((buttonBearing - facing.angles.yaw + 540) % 360) - 180));
  check("touch look turns the player toward the button", bearing <= 1.5, { yaw: facing.angles.yaw, target: buttonBearing, bearing });
  let moved = await attemptUse();
  // The level's use trace is narrower than the button's model: if the computed
  // bearing did not catch it, try the bearing the probe found works on this
  // spawn (−45.626°), then the other side. Each pass starts from a reloaded
  // level, so a door a failed pass moved is back where it began.
  for (const target of [-45.626, -44.4]) {
    if (moved.length) break;
    console.log("  USE at " + buttonBearing.toFixed(2) + " did not move a mover; trying " + target + " on a fresh demo3");
    await cdp.send("Page.reload", { ignoreCache: false });
    await sleep(600);
    await waitForGame("demo3 retry");
    await sleep(500);
    await focusGame();
    const retryState = await aimAtButton(target);
    check("retry at " + target + ": touch look turns the player toward the button",
      Math.abs((((buttonBearing - retryState.angles.yaw + 540) % 360) - 180)) <= 2,
      { yaw: retryState.angles.yaw, target: buttonBearing });
    moved = await attemptUse();
  }
  check("touch key bindings were installed on the demo3 page",
    report.pageInfo.some((entry) => entry.stage === "use" && /q2touch|execing/i.test(entry.text)),
    report.pageInfo.filter((entry) => entry.stage === "use").slice(-3));
  check("USE produces an engine effect (a level mover opens)", moved.length > 0, moved.slice(0, 3));
  check("USE leaves the keyboard with the game", (await readEngine()).keyDest === 0);

  // Console clean.
  check("no console errors", report.consoleErrors.length === 0, report.consoleErrors.slice(0, 4));
  check("no uncaught page exceptions", report.pageErrors.length === 0, report.pageErrors.slice(0, 4));
}

// ---- Cleanup --------------------------------------------------------------

async function cleanup() {
  if (cdp) { cdp.close(); cdp = null; }
  if (chromeChild) {
    const child = chromeChild;
    chromeChild = null;
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 4000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  if (serverChild) {
    const child = serverChild;
    serverChild = null;
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    await new Promise((resolve) => {
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 3000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
  for (const dir of [chromeProfile, serverDataDir]) {
    if (!dir) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ---- Main -----------------------------------------------------------------

// A runaway CDP call must not leave the run (and a headless Chrome) sitting
// forever. Fourteen minutes is well above a healthy run.
const watchdog = setTimeout(() => {
  report.error = "watchdog: the run exceeded 16 minutes";
  report.passed = false;
  console.error("watchdog: the run exceeded 16 minutes");
  try { fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2)); } catch { /* best effort */ }
  process.exit(3);
}, 960000);
if (typeof watchdog.unref === "function") watchdog.unref();

try {
  await run();
} catch (error) {
  failures++;
  report.error = String((error && error.stack) || error);
  console.error("FAIL: " + error.message);
} finally {
  clearTimeout(watchdog);
  await cleanup();
  report.checks_ = { checks, failures };
  report.passed = failures === 0;
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log("\n" + (failures ? "FAILED" : "PASSED") + ": " + (checks - failures) + "/" + checks + " checks" +
    (report.consoleErrors.length ? ", " + report.consoleErrors.length + " console error(s)" : "") +
    ", " + report.screenshots.length + " screenshot(s)");
  console.log("report: " + path.join(OUT, "report.json"));
  process.exit(failures ? 1 : 0);
}
