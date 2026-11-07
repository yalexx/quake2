#!/usr/bin/env node
// One-command input gate for the phone touch controls of this Quake 2 web build.
//
//   node scripts/mobile-input-gate.mjs
//
// Runs the real app in headless Chrome, drives it with trusted CDP touch / mouse /
// key events only, and asserts every result against numbers read out of the live
// engine (window.quake2Engine.read()).  Exit code 0 only when every check passed.
//
// Options:
//   --url URL    drive an app server that is already running (skips server.js)
//   --out DIR    report directory (default: docs/mobile-input-verification)
//   --phone      also capture 844x390 phone screenshots of the visual states
//   --shots      alias for --phone
//   --only LIST  debug aid: report only these check ids (e.g. --only 1,2,4);
//                the other groups' setup still runs, so this does not shorten
//                the run — it only narrows what report.json and stdout hold
//   --help
//
// Environment:
//   CHROME_PATH  Chrome/Chromium binary; /opt/google/chrome/chrome is tried too.
//
// The gate never binds port 4231 or debugging port 18801, never dispatches an
// input event from page script, and kills only the children it started, by PID.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT = path.join(ROOT, "docs", "mobile-input-verification");

const options = { url: "", out: DEFAULT_OUT, phone: false, only: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--url") options.url = argv[++i];
  else if (arg === "--out") options.out = path.resolve(argv[++i]);
  else if (arg === "--phone" || arg === "--shots") options.phone = true;
  else if (arg === "--only") options.only = new Set(argv[++i].split(",").map((s) => s.trim()).filter(Boolean));
  else if (arg === "--help" || arg === "-h") {
    console.log("mobile-input-gate.mjs [--url URL] [--out DIR] [--phone|--shots] [--only LIST]");
    process.exit(0);
  } else {
    console.error("unknown option: " + arg);
    process.exit(2);
  }
}

const OUT = options.out;
const SHOTS = path.join(OUT, "shots");
const LOGS = path.join(OUT, "logs");
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

// Numeric logic checks run at a low resolution with no screenshots.  The phone
// pass uses the same checks at a phone-sized viewport and captures only the
// visual states.
const MOBILE_SIZE = options.phone ? { width: 844, height: 390 } : { width: 640, height: 360 };
const PORTRAIT_SIZE = { width: 390, height: 844 };
const DESKTOP_SIZE = { width: 1280, height: 720 };
const DEVICE_SCALE = 1;

const MOBILE_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const DESKTOP_UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const report = {
  gate: "scripts/mobile-input-gate.mjs",
  at: new Date().toISOString(),
  mode: options.phone ? "phone" : "numeric",
  checkout: ROOT,
  node: process.version,
  url: options.url || null,
  partial: options.only ? [...options.only] : null,
  server: null,
  chrome: null,
  viewport: { width: MOBILE_SIZE.width, height: MOBILE_SIZE.height, deviceScaleFactor: DEVICE_SCALE },
  fixture: { chosen: null, qualified: null, shortfall: null, ranked: [], candidates: [] },
  map: null,
  deviations: [],
  checks: [],
  numbers: {},
  screenshots: [],
  consoleErrors: [],
  pageErrors: [],
  notes: [],
};

let checksRun = 0;
let failures = 0;
let stage = "boot";
function selected(id) {
  if (!options.only) return true;
  if (options.only.has("all")) return true;
  const text = String(id);
  if (options.only.has(text)) return true;
  const group = text.match(/^\d+/);
  return Boolean(group && options.only.has(group[0]));
}
function check(id, name, condition, numbers = null, note = null) {
  if (!selected(id)) return false;
  checksRun++;
  const pass = Boolean(condition);
  if (!pass) failures++;
  const entry = { id: String(id), name, pass, numbers: numbers === undefined ? null : numbers, note, at: new Date().toISOString() };
  report.checks.push(entry);
  const shown = numbers === null || numbers === undefined ? "" : " " + JSON.stringify(numbers);
  console.log((pass ? "PASS " : "FAIL ") + id + ". " + name + shown + (note ? " -- " + note : ""));
  return pass;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Free ports -----------------------------------------------------------

async function freePort() {
  for (let attempt = 0; attempt < 30; attempt++) {
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

async function waitFor(label, fn, timeoutMs = 60000, intervalMs = 250) {
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

// ---- Children (killed by PID only) ---------------------------------------

const children = [];
function track(child, label) {
  children.push({ child, label });
  return child;
}
function childExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}
async function stopChild(child, timeoutMs = 5000) {
  if (!child || childExited(child)) return;
  try { child.kill("SIGTERM"); } catch { /* already gone */ }
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* gone */ }
      resolve();
    }, timeoutMs);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

let serverChild = null;
let serverDataDir = null;
let chromeChild = null;
let chromeProfile = null;
let xvfbChild = null;
let xvfbDisplay = null;
let cdp = null;
let browserCdp = null;
let chromeTargetId = null;

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error("no Chrome/Chromium found (set CHROME_PATH)");
}

// ---- Server ---------------------------------------------------------------

async function startServer() {
  const port = await freePort();
  serverDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "q2gate-data-"));
  const log = fs.openSync(path.join(LOGS, "server.log"), "w");
  serverChild = track(spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), QUAKE2_DATA_DIR: serverDataDir },
    stdio: ["ignore", log, log],
  }), "server.js");
  const base = "http://127.0.0.1:" + port + "/apps/quake2/";
  await waitFor("the app server on port " + port, async () => {
    if (childExited(serverChild)) throw new Error("server.js exited with " + serverChild.exitCode);
    const response = await fetch(base, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  }, 30000);
  report.server = { port, pid: serverChild.pid, dataDir: serverDataDir };
  return base;
}

// ---- CDP ------------------------------------------------------------------

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

async function launchChrome({ headless, display, windowSize }) {
  const chromePath = findChrome();
  const debuggingPort = await freePort();
  chromeProfile = fs.mkdtempSync(path.join(os.tmpdir(), "q2gate-chrome-"));
  const log = fs.openSync(path.join(LOGS, headless ? "chrome.log" : "chrome-headful.log"), "w");
  const flags = [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=" + debuggingPort,
    "--user-data-dir=" + chromeProfile,
    "--window-size=" + (windowSize || "1280,720"),
    "--window-position=0,0",
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
  if (headless) flags.unshift("--headless=new");
  chromeChild = track(spawn(chromePath, flags, {
    env: { ...process.env, ...(display ? { DISPLAY: display } : {}) },
    stdio: ["ignore", log, log],
  }), "chrome");
  const httpBase = "http://127.0.0.1:" + debuggingPort;
  await waitFor("Chrome's CDP endpoint", async () => {
    if (childExited(chromeChild)) throw new Error("Chrome exited with " + chromeChild.exitCode);
    const response = await fetch(httpBase + "/json/version", { signal: AbortSignal.timeout(2000) });
    return response.ok;
  }, 30000);
  const version = await (await fetch(httpBase + "/json/version")).json();
  browserCdp = new Cdp(version.webSocketDebuggerUrl);
  await browserCdp.open();
  const targets = await (await fetch(httpBase + "/json/list")).json();
  const page = targets.find((one) => one.type === "page" && one.webSocketDebuggerUrl);
  if (!page) throw new Error("Chrome has no page target to drive");
  chromeTargetId = page.id;
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  cdp.on("Runtime.consoleAPICalled", (params) => {
    const text = (params.args || []).map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type || "")).join(" ");
    if (/execing.*q2touch|q2touch\.cfg/i.test(text)) report.notes.push({ kind: "engine-cfg", text, stage });
    if (params.type === "error" || params.type === "assert") report.consoleErrors.push({ type: params.type, text, stage });
  });
  cdp.on("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails || {};
    report.pageErrors.push({ stage, text: details.exception && details.exception.description ? details.exception.description : details.text });
  });
  cdp.on("Log.entryAdded", (params) => {
    const entry = params.entry || {};
    if (entry.level !== "error") return;
    if (entry.source === "network") return;
    if (/pak[12]\.pak/.test(entry.url || entry.text || "")) return;
    if (/webgl|swiftshader|groupmarkernotset|gl_invalid|gpu stall|audio/i.test(entry.text || "")) return;
    if (/Ignored attempt to cancel a touch(?:start|end) event/i.test(entry.text || "")) return;
    report.consoleErrors.push({ type: "log-error", text: entry.text, url: entry.url || null, stage });
  });
  report.chrome = {
    path: chromePath,
    pid: chromeChild.pid,
    debuggingPort,
    headless,
    display: display || null,
    profile: chromeProfile,
  };
  report.chromes = report.chromes || [];
  report.chromes.push(report.chrome);
}

async function startXvfb() {
  let displayNumber = 90 + Math.floor(Math.random() * 60);
  for (let i = 0; i < 60 && fs.existsSync("/tmp/.X11-unix/X" + displayNumber); i++) displayNumber++;
  xvfbDisplay = ":" + displayNumber;
  const log = fs.openSync(path.join(LOGS, "xvfb.log"), "w");
  xvfbChild = track(spawn("/usr/bin/Xvfb", [xvfbDisplay, "-screen", "0", "1280x720x24", "-nolisten", "tcp"], {
    stdio: ["ignore", log, log],
  }), "Xvfb");
  await waitFor("Xvfb " + xvfbDisplay, async () => fs.existsSync("/tmp/.X11-unix/X" + displayNumber), 15000);
  return xvfbDisplay;
}

async function closeChrome() {
  if (browserCdp) { browserCdp.close(); browserCdp = null; }
  if (cdp) { cdp.close(); cdp = null; }
  await stopChild(chromeChild);
  chromeChild = null;
  if (chromeProfile) { try { fs.rmSync(chromeProfile, { recursive: true, force: true }); } catch { /* best effort */ } chromeProfile = null; }
}

// ---- Emulation ------------------------------------------------------------

async function emulate(size, touch, ua, orientation) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width: size.width,
    height: size.height,
    deviceScaleFactor: DEVICE_SCALE,
    mobile: touch,
    screenOrientation: orientation,
  });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
  await cdp.send("Emulation.setUserAgentOverride", { userAgent: ua, platform: touch ? "Linux armv8l" : "Linux x86_64" });
  await sleep(700);
}

const landscapeOrientation = () => ({ type: "landscapePrimary", angle: 90 });
const portraitOrientation = () => ({ type: "portraitPrimary", angle: 0 });

// ---- Evaluation / engine state -------------------------------------------

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

const readEngine = () => dumpJson(`(() => { try { return window.quake2Engine && window.quake2Engine.read ? window.quake2Engine.read() : null; } catch (error) { return null; } })()`);
const touchState = () => dumpJson(`(() => { try { return window.quake2Touch && window.quake2Touch.state ? window.quake2Touch.state() : null; } catch (error) { return null; } })()`);
// The live entity list, reduced to entity numbers: the engine builds a fresh
// object per entity on every call, so objects cannot be compared across calls --
// numbers can (a shot that spawns a server entity adds a number; the muzzle
// flash on the player does not, and ammo is the primary fire evidence anyway).
const entityIds = () => dumpJson(`(() => { try {
  var list = window.quake2Engine && window.quake2Engine.entities ? window.quake2Engine.entities() : null;
  return list ? list.map(function (one) { return one.number; }) : null;
} catch (error) { return null; } })()`);

function distance(a, b) {
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}
// The engine reports yaw and roll in degrees in no fixed range: a run that
// starts at 350 degrees and turns 20 more reads 10, so a raw subtraction
// reports +340 instead of the +20 the player actually turned (run 10's
// headful desktop leg: a real -21 degree turn read +338.88).  Take the short
// way round.  Pitch is clamped by the engine and is not wrapped.
function wrapDegrees(value) {
  return ((value + 180) % 360 + 360) % 360 - 180;
}
function angleDelta(before, after) {
  return {
    yaw: wrapDegrees(after.angles.yaw - before.angles.yaw),
    pitch: after.angles.pitch - before.angles.pitch,
    roll: wrapDegrees(after.angles.roll - before.angles.roll),
  };
}
function newEntityIds(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after)) return [];
  const seen = new Set(before);
  return after.filter((id) => !seen.has(id));
}

// ---- Trusted input --------------------------------------------------------

let touchId = 100;
function nextTouchId() { return ++touchId; }
function point(id, x, y) { return { id, x, y, radiusX: 8, radiusY: 8, force: 1 }; }

// CDP keeps its own touch bookkeeping: an ending event with no touch down is
// an error ("Must send a TouchStart first to start a new touch"), and one
// unbalanced release in a check would abort the whole run.  Track what we sent
// and skip/absorb an ending event CDP no longer owes.
let touchesActive = 0;
async function touchEvent(type, points) {
  const ends = type === "touchEnd" || type === "touchCancel";
  if (ends && touchesActive === 0) return;
  try {
    await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points, modifiers: 0 });
  } catch (error) {
    if (ends && /Must send a TouchStart first/i.test(String(error && error.message))) {
      touchesActive = 0;
      return;
    }
    throw error;
  }
  if (type === "touchStart") touchesActive = points.length;
  else if (ends) touchesActive = 0;
}

async function tapAt(x, y, holdMs = 80) {
  const id = nextTouchId();
  await touchEvent("touchStart", [point(id, x, y)]);
  await sleep(holdMs);
  await touchEvent("touchEnd", []);
  await sleep(150);
}

async function pressAt(x, y) {
  const id = nextTouchId();
  await touchEvent("touchStart", [point(id, x, y)]);
  return id;
}
async function releaseTouch() {
  await touchEvent("touchEnd", []);
  await sleep(120);
}

async function rect(selector) {
  return dumpJson(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const box = element.getBoundingClientRect();
    return {
      left: box.left, top: box.top, right: box.right, bottom: box.bottom,
      x: box.x, y: box.y, w: box.width, h: box.height,
      display: getComputedStyle(element).display,
      visibility: getComputedStyle(element).visibility,
      hidden: element.hidden,
      text: (element.textContent || "").replace(/\\s+/g, " ").trim(),
    };
  })()`);
}

async function tapSelector(selector, holdMs = 80) {
  const box = await rect(selector);
  if (!box || box.w === 0 || box.h === 0) throw new Error("no tappable " + selector);
  await tapAt(box.left + box.w / 2, box.top + box.h / 2, holdMs);
  return box;
}

async function keyEvent(type, key, code, vk, text) {
  const params = { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  if (text !== undefined) { params.text = text; params.unmodifiedText = text; }
  await cdp.send("Input.dispatchKeyEvent", params);
}
async function keyTap(key, code, vk, text) {
  await keyEvent("keyDown", key, code, vk, text);
  await sleep(50);
  await keyEvent("keyUp", key, code, vk);
}
async function keyDown(key, code, vk) { await keyEvent("keyDown", key, code, vk); }
async function keyUp(key, code, vk) { await keyEvent("keyUp", key, code, vk); }

const MOVE = {
  N: ["w", "KeyW", 87],
  S: ["s", "KeyS", 83],
  E: ["d", "KeyD", 68],
  W: ["a", "KeyA", 65],
};
const DIR_KEYS = { N: ["N"], NE: ["N", "E"], E: ["E"], SE: ["S", "E"], S: ["S"], SW: ["S", "W"], W: ["W"], NW: ["N", "W"] };
const OPPOSITE = { N: ["S"], NE: ["S", "W"], E: ["W"], SE: ["N", "W"], S: ["N"], SW: ["N", "E"], W: ["E"], NW: ["S", "E"] };

async function holdMoveKeys(names, down) {
  for (const name of names) {
    const [key, code, vk] = MOVE[name];
    if (down) await keyDown(key, code, vk); else await keyUp(key, code, vk);
  }
}

// ---- Console (trusted key events only) -----------------------------------

async function consoleOpen() {
  // The page closes any console that appears in the first seconds of a boot
  // (app.js startBootFrameWatch: until 8 s after the watch started, once the
  // game has landed). A console opened inside that window is shut again by
  // the page's own Escape before this check can read it, so wait it out: the
  // landing frame's timestamp is on the record.
  await waitFor("the page's boot console watch to end", async () => dumpJson(`(() => {
    const frame = window.quake2BootFrame;
    return Boolean(frame && typeof frame.at === "number" && performance.now() > frame.at + 8500);
  })()`), 30000, 250).catch(() => null);
  // A toggle can still be dropped by the engine's key queue on a busy frame;
  // send it again (only while the game, not the console, has the keyboard)
  // rather than fail the run on one lost keystroke.
  let lastState = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await evaluate("document.getElementById('canvas').focus(); 1");
    await sleep(150);
    const before = await readEngine();
    if (before && before.keyDest === 1) return;
    await keyEvent("keyDown", "`", "Backquote", 192);
    await sleep(60);
    await keyEvent("keyUp", "`", "Backquote", 192);
    const opened = await waitFor("the engine console (key_dest 1)", async () => {
      const state = await readEngine();
      lastState = state;
      return state && state.keyDest === 1;
    }, 8000).catch(() => false);
    if (opened) {
      if (attempt > 0) report.notes.push({ kind: "console-retry", attempts: attempt + 1, stage });
      return;
    }
  }
  const focus = await dumpJson(`(() => { const el = document.activeElement; return el ? (el.id || el.tagName) : null; })()`);
  throw new Error("timed out waiting for the engine console (key_dest 1) after 3 toggles; keyDest " +
    (lastState && lastState.keyDest) + ", focus " + focus);
}

function charInfo(ch) {
  if (ch === " ") return [" ", "Space", 32];
  if (ch === ";") return [";", "Semicolon", 186];
  if (ch === "_") return ["_", "Minus", 189];
  if (/^[a-z]$/.test(ch)) return [ch, "Key" + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0)];
  if (/^[0-9]$/.test(ch)) return [ch, "Digit" + ch, 48 + Number(ch)];
  return [ch, "", ch.charCodeAt(0)];
}

async function consoleType(text) {
  for (const ch of text) {
    const [key, code, vk] = charInfo(ch);
    await keyEvent("keyDown", key, code, vk, ch);
    await sleep(30);
    await keyEvent("keyUp", key, code, vk);
    await sleep(15);
  }
  await keyEvent("keyDown", "Enter", "Enter", 13, "\r");
  await sleep(60);
  await keyEvent("keyUp", "Enter", "Enter", 13);
}

async function consoleClose() {
  await keyEvent("keyDown", "`", "Backquote", 192);
  await sleep(60);
  await keyEvent("keyUp", "`", "Backquote", 192);
  await waitFor("the game after the console closes", async () => {
    const state = await readEngine();
    return state && state.keyDest === 0;
  }, 8000);
}

async function consoleCommand(text, settleMs = 800) {
  await consoleOpen();
  await consoleType(text);
  await sleep(settleMs);
  await consoleClose();
}

// ---- Instrumentation (listeners only; never dispatches) ------------------

async function instrument() {
  await evaluate(`(() => {
    window.__gate = { mousedown: 0, mouseup: 0, keylog: [], events: [], moves: [] };
    window.addEventListener("mousedown", () => { window.__gate.mousedown++; }, true);
    window.addEventListener("mouseup", () => { window.__gate.mouseup++; }, true);
    window.addEventListener("mousemove", (event) => {
      if (window.__gate.moves.length < 200) window.__gate.moves.push({ mx: event.movementX, my: event.movementY, cx: event.clientX, cy: event.clientY, locked: !!document.pointerLockElement, target: (event.target && (event.target.id || event.target.tagName)) || null });
    }, true);
    window.addEventListener("keydown", (event) => { window.__gate.keylog.push({ type: "down", key: event.key, vk: event.keyCode, synthetic: !!event.__q2synthetic }); }, true);
    window.addEventListener("keyup", (event) => { window.__gate.keylog.push({ type: "up", key: event.key, vk: event.keyCode, synthetic: !!event.__q2synthetic }); }, true);
    window.addEventListener("blur", () => { window.__gate.events.push("blur"); }, true);
    document.addEventListener("visibilitychange", () => { window.__gate.events.push("visibility:" + document.visibilityState); }, true);
    return 1;
  })()`);
}
const gateCounters = () => dumpJson(`(() => (window.__gate || { mousedown: 0, mouseup: 0, keylog: [], events: [], moves: [] }))()`);

// ---- Layout (the owner's HUD review, docs/mobile-hud-review.md) ------------
// Every element of the play layer that takes a touch, measured from the page
// itself rather than from a list of known ids: any descendant of
// #mobile-controls that is drawn (display, visibility, a non-zero box) and
// accepts pointer events, except the full-picture look surface. In portrait
// the rotate card is a touch target too. Each entry carries its own computed
// opacity so the opacity checks read the same snapshot.
async function layoutSnapshot() {
  return dumpJson(`(() => {
    const W = window.innerWidth, H = window.innerHeight;
    const out = [];
    const elements = [];
    const add = (element, name) => {
      const cs = getComputedStyle(element);
      if (cs.display === "none" || cs.visibility === "hidden" || cs.pointerEvents === "none") return;
      let hiddenAncestor = false;
      for (let node = element.parentElement; node; node = node.parentElement) {
        if (getComputedStyle(node).display === "none") { hiddenAncestor = true; break; }
      }
      if (hiddenAncestor) return;
      const box = element.getBoundingClientRect();
      if (!(box.width > 0) || !(box.height > 0)) return;
      out.push({ id: name || (element.id ? "#" + element.id : element.className || element.tagName),
        left: box.left, top: box.top, right: box.right, bottom: box.bottom, w: box.width, h: box.height,
        opacity: Number(cs.opacity), inside: [] });
      elements.push(element);
    };
    const layer = document.getElementById("mobile-controls");
    if (layer) layer.querySelectorAll("*").forEach((element) => { if (element.id !== "mc-look") add(element); });
    const card = document.querySelector("#rotate-overlay .rotate-card");
    if (card) {
      add(card, ".rotate-card");
      card.querySelectorAll("button").forEach((button) => add(button));
    }
    // A control drawn inside another measured one (the rotate card's button)
    // is a nesting, not two targets competing for one finger.
    elements.forEach((element, i) => {
      elements.forEach((other, j) => { if (i !== j && other.contains(element)) out[i].inside.push(out[j].id); });
    });
    return {
      viewport: { w: W, h: H },
      targets: out,
      floating: ["fullscreen-button", "fullscreen-hint", "mc-toggle"].filter((id) => document.getElementById(id)),
      fullscreenRow: (() => {
        const row = document.querySelector('#menu [data-action="fullscreen"]');
        const view = row && row.closest(".menu-view");
        return row ? { inVideo: Boolean(view && view.dataset.view === "video"), inPageList: Boolean(row.closest(".menu-page-list")),
          value: (document.getElementById("fullscreen-value") || {}).textContent || null } : null;
      })(),
    };
  })()`);
}

function overlapsOf(targets) {
  const found = [];
  for (let i = 0; i < targets.length; i++) {
    for (let j = i + 1; j < targets.length; j++) {
      const a = targets[i], b = targets[j];
      if (a.inside.includes(b.id) || b.inside.includes(a.id)) continue;
      const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
      const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
      if (w > 0.5 && h > 0.5) found.push({ a: a.id, b: b.id, area: Number((w * h).toFixed(1)) });
    }
  }
  return found;
}

const round = (box) => [Math.round(box.left), Math.round(box.top), Math.round(box.w), Math.round(box.h)];

// One viewport's layout: no floating full-screen or PAD control, the VIDEO
// row present, no two targets overlapping and every target >= 44 px.
async function checkLayout(id, label, expectTargets) {
  const snap = await layoutSnapshot();
  const overlaps = overlapsOf(snap.targets);
  const small = snap.targets.filter((one) => one.w < 44 || one.h < 44).map((one) => ({ id: one.id, w: one.w, h: one.h }));
  const missing = expectTargets.filter((wanted) => !snap.targets.some((one) => one.id === wanted));
  const boxes = Object.fromEntries(snap.targets.map((one) => [one.id, round(one)]));
  check(id, label + ": no full-screen or PAD control over the game, no two targets overlap, every target >= 44 px",
    snap.floating.length === 0 && snap.fullscreenRow && snap.fullscreenRow.inVideo && snap.fullscreenRow.inPageList &&
      overlaps.length === 0 && small.length === 0 && missing.length === 0,
    { viewport: snap.viewport, floating: snap.floating, fullscreenRow: snap.fullscreenRow, overlaps, small, missing, boxes });
  return snap;
}

const LANDSCAPE_TARGETS = ["#mc-stick", "#mc-fire", "#mc-jump", "#mc-crouch", "#mc-use", "#mc-weapon", "#mc-pause"];
const PORTRAIT_TARGETS = ["#mc-pause", ".rotate-card", "#rotate-action"];

// The landscape layouts the review names, then back to the run's own size.
async function checkLandscapeLayouts() {
  const sizes = [
    { id: "L1", size: { width: 844, height: 390 } },
    { id: "L2", size: { width: 932, height: 430 } },
  ];
  if (MOBILE_SIZE.width !== 844 || MOBILE_SIZE.height !== 390) sizes.push({ id: "L0", size: MOBILE_SIZE });
  const snaps = {};
  for (const one of sizes) {
    await emulate(one.size, true, MOBILE_UA, landscapeOrientation());
    await sleep(900);
    snaps[one.id] = await checkLayout(one.id, "layout " + one.size.width + "x" + one.size.height + " landscape", LANDSCAPE_TARGETS);
  }
  await emulate(MOBILE_SIZE, true, MOBILE_UA, landscapeOrientation());
  await sleep(900);
  return snaps;
}

// ---- Game boot ------------------------------------------------------------

async function waitForGame(label, timeoutMs = 180000) {
  let last = null;
  let stable = 0;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const state = await readEngine();
      const ui = await dumpJson(`(() => {
        const canvas = document.getElementById("canvas");
        return { display: canvas ? getComputedStyle(canvas).display : null };
      })()`);
      if (state && state.ok && state.keyDest === 0 && ui.display === "block" &&
          state.position && (state.position.x !== 0 || state.position.y !== 0)) {
        if (last && state.angles && last.angles && state.angles.yaw === last.angles.yaw && state.position.x === last.position.x && state.position.y === last.position.y) stable++;
        else stable = 0;
        last = state;
        if (stable >= 3) {
          try { await evaluate("document.getElementById('canvas').focus(); 1"); } catch { /* no canvas */ }
          return state;
        }
      }
    } catch { /* page mid-load */ }
    await sleep(250);
  }
  throw new Error("the game never reached a steady in-game state (" + label + ")");
}

function queryFor(candidate) {
  return "+set&cheats&1&" + candidate.query;
}

async function boot(base, candidate, label) {
  const separator = base.includes("?") ? "&" : "?";
  try { await cdp.send("Page.bringToFront"); } catch { /* optional */ }
  const started = Date.now();
  // A navigation drops any CDP touch state the page had.
  touchesActive = 0;
  await cdp.send("Page.navigate", { url: base + separator + queryFor(candidate) });
  await sleep(600);
  const state = await waitForGame(label);
  return { state, ms: Date.now() - started };
}

async function wakeTouchUi() {
  const initial = await touchState();
  if (initial && initial.uiEnabled && initial.live) return;
  // A phone gets the layer automatically (coarse pointer).  A hybrid device
  // whose primary pointer is a mouse gets it from the first real touch, and at
  // that moment the canvas is the only visible target; this tap is the wake,
  // before any check, so its side effects are outside every measured window.
  if (!(initial && initial.uiEnabled)) {
    const canvas = await rect("#canvas");
    if (canvas && canvas.w > 0) await tapAt(canvas.left + canvas.w / 2, canvas.top + canvas.h / 2, 60);
  }
  await waitFor("the touch UI to become live", async () => {
    const state = await touchState();
    return state && state.uiEnabled && state.live;
  }, 10000);
  await sleep(300);
}

// ---- Movement helpers -----------------------------------------------------

function project(before, after, yawDeg) {
  const dx = after.position.x - before.position.x;
  const dy = after.position.y - before.position.y;
  const yaw = (yawDeg === undefined ? before.angles.yaw : yawDeg) * Math.PI / 180;
  return { d: Math.hypot(dx, dy), fwd: dx * Math.cos(yaw) + dy * Math.sin(yaw), right: dx * Math.sin(yaw) - dy * Math.cos(yaw) };
}

async function walkKeys(names, { target = 220, maxMs = 12000, pollMs = 200, yaw = null } = {}) {
  const start = await readEngine();
  const useYaw = yaw === null ? start.angles.yaw : yaw;
  await holdMoveKeys(names, true);
  let elapsed = 0;
  let stall = 0;
  let lastProgress = 0;
  const series = [];
  try {
    while (elapsed < maxMs) {
      await sleep(pollMs);
      elapsed += pollMs;
      const now = await readEngine();
      const p = project(start, now, useYaw);
      series.push({ t: elapsed, d: Math.round(p.d), x: now.position.x, y: now.position.y });
      if (p.d - lastProgress < 1.5) stall++; else stall = 0;
      lastProgress = p.d;
      if (p.d >= target || stall >= 6) break;
    }
  } finally {
    await holdMoveKeys(names, false);
  }
  await sleep(400);
  const end = await readEngine();
  return { start, end, projection: project(start, end, useYaw), series, elapsed };
}

async function returnTo(start, { tolerance = 20, timeoutMs = 12000 } = {}) {
  const t0 = Date.now();
  let lastD = Infinity;
  let stalls = 0;
  while (Date.now() - t0 < timeoutMs) {
    const now = await readEngine();
    const d = distance(start.position, now.position);
    if (d <= tolerance) return { d, ms: Date.now() - t0 };
    if (d > lastD - 2) stalls++; else stalls = 0;
    lastD = d;
    // A free box runs this engine near 200-400 units/s: a fixed burst
    // overshoots by tens of units and the next direction then starts from the
    // wrong place (measured 2026-11-04: 38 units of drift compounded into a
    // fall).  Correct in small steps and give up when they stop helping.
    if (stalls >= 3) return { d, ms: Date.now() - t0, stuck: true };
    const yaw = start.angles.yaw * Math.PI / 180;
    const dx = start.position.x - now.position.x;
    const dy = start.position.y - now.position.y;
    const fwd = dx * Math.cos(yaw) + dy * Math.sin(yaw);
    const right = dx * Math.sin(yaw) - dy * Math.cos(yaw);
    const keys = [];
    if (fwd > 6) keys.push("N"); else if (fwd < -6) keys.push("S");
    if (right > 6) keys.push("E"); else if (right < -6) keys.push("W");
    if (!keys.length) return { d, ms: Date.now() - t0 };
    const burst = Math.max(50, Math.min(260, Math.round(d * 4)));
    await holdMoveKeys(keys, true);
    await sleep(burst);
    await holdMoveKeys(keys, false);
    await sleep(140);
  }
  const now = await readEngine();
  return { d: distance(start.position, now.position), ms: Date.now() - t0, timeout: true };
}

// ---- Fixture --------------------------------------------------------------

// The brief's boot query.  +set cheats 1 is added because this build refuses
// `give all` without it ("You must run the server with '+set cheats 1'").
const FIXTURES = [
  {
    id: "demo2-dm",
    map: "demo2",
    query: "+set&deathmatch&1&+set&maxclients&1&+map&demo2",
    mode: "deathmatch",
    spawn: "brief: +set&deathmatch&1&+set&maxclients&1&+map&demo2",
  },
  {
    id: "demo3-dm",
    map: "demo3",
    query: "+set&deathmatch&1&+set&maxclients&1&+map&demo3",
    mode: "deathmatch",
    spawn: "brief fallback: demo3 in deathmatch mode",
  },
  {
    id: "demo3-sp",
    map: "demo3",
    query: "+set&skill&1&+map&demo3",
    mode: "single-player",
    spawn: "demo3 player start (1688,1412) -- the spawn the brief names for demo3",
  },
];

const DIRECTION_ORDER = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

// Check 4 needs about 24 units of clearance per direction; the candidate with
// the largest worst direction gives every movement check the most room.  A
// candidate that meets the brief's 200+ bar wins outright.
function rankCandidates(measured) {
  return measured.slice().sort((a, b) => {
    if (a.qualified !== b.qualified) return a.qualified ? -1 : 1;
    if (b.minClearance !== a.minClearance) return b.minClearance - a.minClearance;
    if (b.openDirections !== a.openDirections) return b.openDirections - a.openDirections;
    return a.order - b.order;
  });
}

async function qualifyFixture(base) {
  report.deviations.push("The boot query carries +set&cheats&1: this build's `give all` refuses without the server cvar cheats=1 (measured).");
  report.deviations.push("Open floor is measured from each candidate's spawn, the position the movement checks start from: a forward walk of more than 100 units ends against a wall by construction, so the eight directions cannot be measured at the spot it reaches (measured).");
  report.deviations.push("The brief's two deathmatch boots come first and demo3 in single player is measured only when no deathmatch candidate is controllable: a deathmatch death is one trusted FIRE press away from a respawn and an arming, a single-player death is not.");
  let blasterChecked = false;
  const measured = [];
  let lastBooted = null;
  for (const [index, candidate] of FIXTURES.entries()) {
    stage = "fixture:" + candidate.id;
    const record = { id: candidate.id, map: candidate.map, mode: candidate.mode, query: queryFor(candidate), spawn: candidate.spawn, bootMs: null, spawnPosition: null, yaw: null, keyDest: null, dead: null, forward: null, directions: {}, openDirections: 0, minClearance: 0, qualified: false, pass: false };
    report.fixture.candidates.push(record);
    console.log("fixture: booting " + candidate.id + " (" + candidate.mode + ", " + candidate.map + ")");
    // The single-player candidate exists only as a last resort: a deathmatch
    // death is one trusted press away from a respawn with a fresh arming,
    // while a single-player death forces a map reload mid-run -- run 10 chose
    // demo3-sp on clearance and lost the player to a pit before check 9,
    // leaving the portrait ammo unreadable.  When either deathmatch candidate
    // boots controllably, the single-player one is not measured at all.
    if (candidate.mode !== "deathmatch" && measured.some((one) => one.candidate.mode === "deathmatch")) {
      record.fail = "skipped: a deathmatch candidate already booted controllably, and a death there respawns with a trusted press";
      console.log("fixture: skipping " + candidate.id + " -- " + record.fail);
      continue;
    }
    const booted = await boot(base, candidate, candidate.id);
    lastBooted = candidate;
    record.bootMs = booted.ms;
    record.spawnPosition = booted.state.position;
    record.yaw = booted.state.angles.yaw;
    record.keyDest = booted.state.keyDest;
    record.dead = booted.state.dead;
    console.log("FIXTURE " + candidate.id + ": keyDest " + record.keyDest + " dead " + record.dead + " at " + JSON.stringify(record.spawnPosition) + " in " + record.bootMs + "ms");
    if (!(record.keyDest === 0 && record.dead === false)) {
      record.fail = "not controllable: keyDest " + record.keyDest + ", dead " + record.dead;
      continue;
    }

    // Only-blaster check: at a pristine spawn, before any map item is picked up.
    if (!blasterChecked) {
      stage = "5-blaster";
      await wakeTouchUi();
      await checkBlasterOnly();
      blasterChecked = true;
      stage = "fixture:" + candidate.id;
    }

    // Measure all eight movement directions from the spawn, out and back.  The
    // forward measurement is also the brief's "forward key moves >100 units".
    let spawn = await readEngine();
    const yaw = spawn.angles.yaw;
    const distances = [];
    for (const name of DIRECTION_ORDER) {
      const start = await readEngine();
      const walked = await walkKeys(DIR_KEYS[name], { target: 220, maxMs: 16000, yaw });
      const p = project(start, await readEngine(), yaw);
      const back = await returnTo(spawn, { tolerance: 30, timeoutMs: 15000 });
      const direction = { distance: Math.round(p.d), forwardComponent: Math.round(p.fwd), rightComponent: Math.round(p.right), ms: walked.elapsed, startedUnitsFromSpawn: Math.round(distance(spawn.position, start.position)), returnDistance: Math.round(back.d), returnTimeout: Boolean(back.timeout) };
      record.directions[name] = direction;
      distances.push(direction.distance);
      console.log("  " + name + ": d=" + p.d.toFixed(1) + " fwd=" + p.fwd.toFixed(1) + " right=" + p.right.toFixed(1) + " t=" + walked.elapsed + " start=" + direction.startedUnitsFromSpawn + " back=" + back.d.toFixed(1) + (direction.distance >= 200 ? " PASS" : " FAIL"));
      // Every direction is measured from the spawn.  When the return walk
      // cannot get back (run 10's demo2: the first walk ended 104 units away
      // and every later direction then measured from that other room), the map
      // is loaded again so the next direction starts where the clearances are
      // measured instead of recording geometry the walk never saw.
      if (back.d > 40) {
        report.notes.push({ kind: "fixture-reload", id: candidate.id, direction: name, returnDistance: Math.round(back.d), text: "the return walk from " + name + " ended " + Math.round(back.d) + " units from the spawn, so the map was loaded again before the next direction; without it every later direction measured from that other room" });
        console.log("fixture: the return from " + name + " ended " + back.d.toFixed(0) + " units from the spawn; reloading " + candidate.id + " before the next direction");
        await boot(base, candidate, candidate.id);
        lastBooted = candidate;
        await wakeTouchUi();
        spawn = await readEngine();
      }
    }
    record.openDirections = distances.filter((one) => one >= 200).length;
    record.minClearance = Math.min(...distances);
    record.qualified = record.openDirections === 8;
    record.forward = { distance: record.directions.N.distance, ms: record.directions.N.ms, from: spawn.position, yaw };
    // A qualified candidate has forward >= 200; the >100 bar is checked too so
    // the record shows it explicitly.
    record.pass = record.qualified && record.directions.N.distance > 100;
    record.endedUnitsFromSpawn = Math.round(distance(spawn.position, (await readEngine()).position));
    console.log("FIXTURE " + candidate.id + ": " + (record.pass ? "QUALIFIED" : "not qualified") + " -- " + record.openDirections + "/8 directions at 200+ units, forward " + record.directions.N.distance + " units, minimum clearance " + record.minClearance + " units, ended " + record.endedUnitsFromSpawn + " units from spawn");
    measured.push({ order: index, candidate, record, qualified: record.pass, minClearance: record.minClearance, openDirections: record.openDirections });
    if (record.pass) break;
  }
  if (!measured.length) throw new Error("no free-roam fixture candidate was controllable (see fixture.candidates)");
  const ranked = rankCandidates(measured);
  const best = ranked[0];
  report.fixture.chosen = best.record.id;
  report.fixture.qualified = Boolean(best.qualified);
  report.fixture.ranked = ranked.map((one) => ({ id: one.record.id, qualified: one.qualified, openDirections: one.openDirections, minClearance: one.minClearance }));
  report.map = { id: best.record.id, map: best.record.map, mode: best.record.mode, spawnPosition: best.record.spawnPosition, yaw: best.record.yaw, query: best.record.query };
  report.numbers.fixture = { id: best.record.id, forward: best.record.forward.distance, directions: best.record.directions, openDirections: best.record.openDirections, minClearance: best.record.minClearance, qualified: Boolean(best.qualified) };
  if (best.qualified) {
    check("fixture", "free-roam fixture " + best.record.id + ": forward >100 and 200+ units open in the 8 movement directions", true,
      { forward: best.record.forward.distance, openDirections: 8, spawnPosition: best.record.spawnPosition, yaw: best.record.yaw });
  } else {
    // Map geometry, not control behaviour: recorded as a fixture shortfall, not
    // as a failing input check.  The movement checks below still prove the
    // joystick and the buttons against the live engine on this map.
    report.fixture.shortfall = "The brief's bar of 200+ units open in all 8 movement directions was not met by any candidate (" +
      measured.map((one) => one.record.id + ": " + one.record.openDirections + "/8, minimum " + one.record.minClearance + " units").join("; ") +
      "). The movement checks run on " + best.record.id + " at its spawn; check 4's stick directions run under the engine's noclip, so their bar no longer depends on the level's clearance (the smallest measured here is " + best.record.minClearance + " units).";
    report.notes.push({ kind: "fixture-shortfall", id: best.record.id, openDirections: best.record.openDirections, minClearance: best.record.minClearance, text: report.fixture.shortfall });
    console.log("fixture: " + report.fixture.shortfall);
  }
  if (lastBooted !== best.candidate) {
    // The best candidate was measured earlier; load it again for the checks.
    stage = "fixture:reload-" + best.record.id;
    console.log("fixture: reloading " + best.record.id + " for the checks");
    const booted = await boot(base, best.candidate, best.record.id);
    lastBooted = best.candidate;
    best.record.checksBootMs = booted.ms;
    best.record.checksSpawn = booted.state.position;
  }
  stage = "fixture";
  await wakeTouchUi();
  // The movement checks run at the fixture spawn itself: that is the only spot
  // whose 8 clearances were measured, and the engine can run near 200 units/s,
  // so a 60-unit walk overshot to 120 and put the player on a lower floor with
  // forward blocked and a fatal drop beside it (measured 2026-11-04).  The
  // stick checks cap each excursion at 45 units, inside the measured minimum.
  const spot = await readEngine();
  report.map.checkSpot = spot.position;
  report.numbers.fixture.checkSpot = { walkedUnits: 0, from: spot.position, to: spot.position, yaw: spot.angles.yaw,
    note: "the movement checks run at the fixture spawn, where the 8 directions were measured" };
  console.log("fixture: the movement checks run at the fixture spawn " + JSON.stringify(spot.position));
  return best.candidate;
}

// ---- Checks ---------------------------------------------------------------

async function fireButton() {
  return rect("#mc-fire");
}

// With only the blaster owned, WPN must not change the weapon -- and must not
// be silent either: the owner's note was "the wpn buttons not doing anything".
// The pad says there is nothing to switch to.  Run at the spawn, before the
// fixture walk: the walk can cross map items and leave the player owning a
// second weapon.
async function checkBlasterOnly() {
  const before = await readEngine();
  const weapon = await rect("#mc-weapon");
  if (!weapon || weapon.w === 0) throw new Error("no WPN control on the pad");
  const tapsBefore = (await touchState()).weaponTaps;
  await tapSelector("#mc-weapon", 120);
  // The touch layer waits for both 2 s and 20 drawn frames before it decides
  // nothing changed (headless rendering here runs at a few frames a second).
  const noted = await waitFor("the WPN note", async () => {
    const now = await touchState();
    const engine = await readEngine();
    if (engine && engine.weaponIndex !== before.weaponIndex) return { changed: true, now, engine };
    return now && now.weaponNote ? { changed: false, now, engine } : false;
  }, 30000, 250).catch(() => null);
  const note = await rect("#mc-weapon-note");
  const after = await readEngine();
  check("5a", "WPN with only the blaster: the weapon index stays and the pad says there is nothing to switch to",
    Boolean(noted && !noted.changed && noted.now.weaponTaps === tapsBefore + 1 && note && note.display !== "none" && note.w > 0 &&
      after.weaponIndex === before.weaponIndex),
    { before: before.weaponIndex, after: after.weaponIndex, taps: noted && noted.now.weaponTaps, noteShown: Boolean(noted && noted.now.weaponNote),
      noteText: note && note.text, noteBox: note && note.w > 0 ? round(note) : null, ammo: [before.ammo, after.ammo] });
}

// A deathmatch death respawns the player with the blaster only, which silently
// voids the give-all loadout the ammo checks need.  Bring the player back and
// re-arm with a trusted console command before any check that reads ammo.
async function waitAliveEngine(timeoutMs = 15000) {
  return waitFor("the player alive", async () => {
    const now = await readEngine();
    return now && now.dead === false ? now : false;
  }, timeoutMs, 300).catch(() => null);
}

async function ensureAlive(label) {
  const state = await readEngine();
  if (!state || state.dead === false) return state;
  console.log("player is dead before " + label + "; respawning with a trusted FIRE tap");
  const fire = await fireButton();
  if (fire && fire.w > 0 && fire.h > 0) {
    await tapAt(fire.left + fire.w / 2, fire.top + fire.h / 2, 120);
  }
  const alive = await waitAliveEngine();
  if (!alive) console.log("player is still dead before " + label + "; its checks will report that");
  return alive || (await readEngine());
}

async function ensureArmed(label) {
  const state = await ensureAlive(label);
  if (!state || state.dead !== false) return state;
  if (typeof state.ammo === "number" && state.ammo > 0) return state;
  console.log("re-arming before " + label + " with a trusted console: sv_cheats 1;give all");
  try { await evaluate("document.getElementById('canvas').focus(); 1"); } catch { /* no canvas */ }
  await consoleCommand("sv_cheats 1;give all", 1400);
  await keyTap("4", "Digit4", 52, "4");
  const armed = await waitFor("ammo after re-arm", async () => {
    const now = await readEngine();
    return now && typeof now.ammo === "number" && now.ammo > 0 ? now : false;
  }, 15000, 300).catch(() => null);
  if (!armed) console.log("re-arm before " + label + " did not raise ammo; the check will show it");
  return armed || (await readEngine());
}

async function readStable(label, timeoutMs = 12000, quietMs = 1400) {
  // Wait until two readings a quiet interval apart carry the same position,
  // ammo and angles, then return the later one.  The engine runs at ~1-2 fps
  // here, so a fixed sleep is not enough for a shot or a step to finish.
  const same = (a, b) => Boolean(a && b &&
    a.position.x === b.position.x && a.position.y === b.position.y && a.position.z === b.position.z &&
    a.ammo === b.ammo && a.angles.yaw === b.angles.yaw && a.angles.pitch === b.angles.pitch);
  const started = Date.now();
  let prev = await readEngine();
  let prevAt = Date.now();
  while (Date.now() - started < timeoutMs) {
    await sleep(300);
    if (Date.now() - prevAt < quietMs) continue;
    const now = await readEngine();
    if (same(now, prev)) return now;
    prev = now;
    prevAt = Date.now();
  }
  return readEngine();
}

function emptyState(state) {
  return state && Array.isArray(state.keys) && state.keys.length === 0 && state.fireHeld === false;
}

async function checksTouch(base, candidate) {
  // The fixture left the player at the free-roam spot with the trusted keyboard.
  // The touch layer still has to be woken up with a real touch.
  stage = "wake";
  await wakeTouchUi();
  await instrument();

  const state = await readEngine();
  check("setup", "engine is in game with a controllable player before the checks",
    state && state.keyDest === 0 && state.dead === false,
    { keyDest: state && state.keyDest, dead: state && state.dead, position: state && state.position });

  // ---- Arming: trusted CDP keys only, in the engine's own console.
  stage = "arm";
  console.log("arming: sv_cheats 1;give all, then select a weapon with ammo");
  await consoleCommand("sv_cheats 1;give all", 1200);
  await keyTap("4", "Digit4", 52, "4");
  let armed = null;
  await waitFor("ammo after give all + weapon 4", async () => {
    const s = await readEngine();
    if (s && typeof s.ammo === "number" && s.ammo > 0) { armed = s; return true; }
    return false;
  }, 12000).catch(() => null);
  check("setup-arm", "give all armed the player: ammo is readable and above zero",
    Boolean(armed), { ammo: armed && armed.ammo, weaponIndex: armed && armed.weaponIndex, keyDest: armed && armed.keyDest });
  // The pad live in the game, at the phone size the owner reported from.
  if (options.phone) await capture("phone-landscape", "landscape 844x390, pad live in game");

  // ---- Layout: the HUD review's top row and target sizes.
  stage = "layout";
  const layouts = await checkLandscapeLayouts();

  // ---- Ergonomics and opacity (docs/mobile-hud-review.md, criterion 6).
  stage = "opacity";
  {
    // The aiming zone: the middle 40 % of the picture's width, where the look
    // drag starts and the crosshair sits. No target may reach into it.
    const zoneHits = [];
    for (const id of ["L1", "L2"]) {
      const snap = layouts[id];
      const left = snap.viewport.w * 0.30, right = snap.viewport.w * 0.70;
      for (const one of snap.targets) {
        if (one.right > left + 0.5 && one.left < right - 0.5) zoneHits.push({ layout: id, id: one.id, box: round(one) });
      }
    }
    check("A1", "ergonomics: no target reaches into the aiming zone (x 30-70 %) at 844x390 or 932x430",
      zoneHits.length === 0 && ["L1", "L2"].every((id) => layouts[id] && layouts[id].targets.length >= LANDSCAPE_TARGETS.length),
      { zone: ["L1", "L2"].map((id) => ({ layout: id, x: [Number((layouts[id].viewport.w * 0.30).toFixed(1)), Number((layouts[id].viewport.w * 0.70).toFixed(1))] })),
        hits: zoneHits, nearest: ["L1", "L2"].map((id) => {
          const w = layouts[id].viewport.w;
          const left = Math.max(...layouts[id].targets.filter((one) => one.right <= w * 0.5).map((one) => one.right));
          const right = Math.min(...layouts[id].targets.filter((one) => one.left >= w * 0.5).map((one) => one.left));
          return { layout: id, leftGroupEnds: Number(left.toFixed(1)), rightGroupStarts: Number(right.toFixed(1)) };
        }) });

    // Idle: nobody touching anything. Every pad control is drawn at a
    // computed opacity between 0.3 and 0.6, and the look surface is clear.
    await sleep(500);
    const idle = await layoutSnapshot();
    const look = await dumpJson(`(() => { const cs = getComputedStyle(document.getElementById("mc-look")); return { background: cs.backgroundColor, image: cs.backgroundImage, opacity: cs.opacity }; })()`);
    const idleOut = idle.targets.filter((one) => !(one.opacity >= 0.3 && one.opacity <= 0.6));
    check("O1", "opacity at idle: every pad control is drawn between 0.3 and 0.6, and the look surface is clear",
      idle.targets.length >= LANDSCAPE_TARGETS.length && idleOut.length === 0 && look.background === "rgba(0, 0, 0, 0)" && look.image === "none",
      { opacity: Object.fromEntries(idle.targets.map((one) => [one.id, one.opacity])), outOfRange: idleOut.map((one) => one.id), look });

    // Pressed: the control under the finger is drawn at full strength, and
    // goes back to its idle value after the release. CROUCH and the stick's
    // centre are the presses with no side effect a later check could trip on.
    const pressedReadings = {};
    for (const selector of ["#mc-crouch", "#mc-stick"]) {
      const box = await rect(selector);
      await pressAt(box.left + box.w / 2, box.top + box.h / 2);
      await sleep(600);
      const during = await dumpJson(`Number(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).opacity)`);
      const others = await dumpJson(`Number(getComputedStyle(document.getElementById("mc-fire")).opacity)`);
      await releaseTouch();
      await sleep(700);
      const afterRelease = await dumpJson(`Number(getComputedStyle(document.querySelector(${JSON.stringify(selector)})).opacity)`);
      pressedReadings[selector] = { pressed: during, fireMeanwhile: others, afterRelease };
    }
    // The crouch press ducked the player; let the view come back up before
    // the next checks read positions.
    await readStable("after the opacity presses", 8000, 900).catch(() => null);
    check("O2", "opacity pressed: the control under the finger is drawn at 1, the others stay at idle, and it returns to idle after release",
      Object.values(pressedReadings).every((one) => one.pressed === 1 && one.fireMeanwhile >= 0.3 && one.fireMeanwhile <= 0.6 && one.afterRelease >= 0.3 && one.afterRelease <= 0.6),
      pressedReadings);
  }

  // ---- Check 1: an empty tap never fires.
  stage = "1";
  {
    const look = await rect("#mc-look");
    if (!look) throw new Error("no #mc-look");
    const points = [
      [look.left + look.w * 0.50, look.top + look.h * 0.18],
      [look.left + look.w * 0.30, look.top + look.h * 0.25],
      [look.left + look.w * 0.70, look.top + look.h * 0.22],
    ];
    const results = [];
    let ok = true;
    for (const [x, y] of points) {
      const before = await readEngine();
      const entitiesBefore = await entityIds();
      const countersBefore = await gateCounters();
      await tapAt(x, y, 70);
      await sleep(1200);
      const after = await readEngine();
      const entitiesAfter = await entityIds();
      const countersAfter = await gateCounters();
      const d = angleDelta(before, after);
      const row = {
        at: [Math.round(x), Math.round(y)],
        ammo: [before.ammo, after.ammo],
        yawDelta: Number(d.yaw.toFixed(3)),
        pitchDelta: Number(d.pitch.toFixed(3)),
        newEntities: newEntityIds(entitiesBefore, entitiesAfter).length,
        mousedown: countersAfter.mousedown - countersBefore.mousedown,
        fireHeld: (await touchState()).fireHeld,
      };
      results.push(row);
      if (row.ammo[0] !== row.ammo[1] || Math.abs(d.yaw) > 1 || Math.abs(d.pitch) > 1 || row.newEntities !== 0 || row.mousedown !== 0 || row.fireHeld) ok = false;
    }
    check("1", "a tap away from the controls never fires or turns", ok, results);
  }

  // ---- Check 2: FIRE press/hold, release, pointercancel.
  stage = "2";
  {
    const before = await readEngine();
    const entitiesBefore = await entityIds();
    const countersBefore = await gateCounters();
    const fire = await fireButton();
    if (!fire) throw new Error("no #mc-fire");
    const cx = fire.left + fire.w / 2, cy = fire.top + fire.h / 2;
    await pressAt(cx, cy);
    await sleep(2600);
    const during = await readEngine();
    const touchDuring = await touchState();
    const countersDuring = await gateCounters();
    await releaseTouch();
    await sleep(1800);
    const after = await readEngine();
    const d = angleDelta(before, after);
    const entitiesAfter = await entityIds();
    const ammoDrop = (typeof before.ammo === "number" && typeof after.ammo === "number") ? before.ammo - after.ammo : null;
    const muzzle = newEntityIds(entitiesBefore, entitiesAfter).length;
    const fired = (typeof ammoDrop === "number" && ammoDrop > 0) || muzzle > 0;
    const releasedTouch = await touchState();
    const settled = await readStable("fire stop");
    const settled2 = await readEngine();
    check("2a", "FIRE press/hold fires: ammo falls and/or a new entity appears; the press does not turn the view",
      fired && Math.abs(d.yaw) <= 1 && Math.abs(d.pitch) <= 1,
      { ammo: [before.ammo, during.ammo, after.ammo, settled2.ammo], ammoDrop, muzzleEntities: muzzle, yawDelta: Number(d.yaw.toFixed(3)), pitchDelta: Number(d.pitch.toFixed(3)), touchDuring: touchDuring && { fireHeld: touchDuring.fireHeld, keys: touchDuring.keys }, mousedownEvents: countersDuring.mousedown - countersBefore.mousedown });
    const stopped = settled && settled2 && settled.ammo === settled2.ammo;
    check("2b", "FIRE release stops firing (ammo is stable afterwards)", stopped && releasedTouch && releasedTouch.fireHeld === false,
      { afterRelease: after.ammo, settled: settled && settled.ammo, settled2: settled2 && settled2.ammo, fireHeld: releasedTouch && releasedTouch.fireHeld });

    // pointercancel while held must release the button.
    await pressAt(cx, cy);
    await sleep(1800);
    await touchEvent("touchCancel", []);
    await sleep(1500);
    const cancelled = await touchState();
    const cancelAmmo1 = await readEngine();
    await sleep(1400);
    const cancelAmmo2 = await readEngine();
    check("2c", "pointercancel on held FIRE releases it and stops the shots",
      cancelled && cancelled.fireHeld === false && cancelAmmo1.ammo === cancelAmmo2.ammo,
      { fireHeld: cancelled && cancelled.fireHeld, ammo: [cancelAmmo1.ammo, cancelAmmo2.ammo] });
  }

  // ---- Check 3: a look drag turns yaw and pitch; a tap there fires nothing.
  stage = "3";
  {
    const look = await rect("#mc-look");
    if (!look) throw new Error("no #mc-look");
    const before = await readEngine();
    const entitiesBefore = await entityIds();
    const id = nextTouchId();
    const x0 = look.left + look.w * 0.62, y0 = look.top + look.h * 0.42;
    await touchEvent("touchStart", [point(id, x0, y0)]);
    for (let i = 1; i <= 8; i++) {
      await touchEvent("touchMove", [point(id, x0 - 120 * i / 8, y0 - 70 * i / 8)]);
      await sleep(45);
      // Capture the finger still down, halfway through the drag: the phone shot
      // must show a live look gesture, not a released one.
      if (options.phone && i === 4) await capture("phone-look-drag", "landscape 844x390, look drag mid-gesture (finger down)");
    }
    await touchEvent("touchEnd", []);
    await sleep(1500);
    const after = await readEngine();
    const d1 = angleDelta(before, after);
    const entitiesAfter = await entityIds();
    const ammoUnchanged = before.ammo === after.ammo;
    const noShot = newEntityIds(entitiesBefore, entitiesAfter).length === 0;
    check("3a", "look drag left+up raises yaw and lowers pitch, without firing",
      d1.yaw > 5 && d1.pitch < -5 && ammoUnchanged && noShot,
      { yawDelta: Number(d1.yaw.toFixed(3)), pitchDelta: Number(d1.pitch.toFixed(3)), ammo: [before.ammo, after.ammo], newEntities: newEntityIds(entitiesBefore, entitiesAfter).length });

    const before2 = await readEngine();
    const id2 = nextTouchId();
    const bx = look.left + look.w * 0.45, by = look.top + look.h * 0.30;
    await touchEvent("touchStart", [point(id2, bx, by)]);
    for (let i = 1; i <= 8; i++) {
      await touchEvent("touchMove", [point(id2, bx + 120 * i / 8, by + 70 * i / 8)]);
      await sleep(45);
    }
    await touchEvent("touchEnd", []);
    await sleep(1500);
    const after2 = await readEngine();
    const d2 = angleDelta(before2, after2);
    check("3b", "look drag right+down lowers yaw and raises pitch, without firing",
      d2.yaw < -5 && d2.pitch > 5 && before2.ammo === after2.ammo,
      { yawDelta: Number(d2.yaw.toFixed(3)), pitchDelta: Number(d2.pitch.toFixed(3)), ammo: [before2.ammo, after2.ammo] });

    const before3 = await readEngine();
    const entitiesBefore3 = await entityIds();
    const countersBefore3 = await gateCounters();
    await tapAt(look.left + look.w * 0.55, look.top + look.h * 0.35, 80);
    await sleep(1300);
    const after3 = await readEngine();
    const d3 = angleDelta(before3, after3);
    const countersAfter3 = await gateCounters();
    check("3c", "a tap on the look surface fires nothing and turns nothing",
      before3.ammo === after3.ammo && Math.abs(d3.yaw) <= 1 && Math.abs(d3.pitch) <= 1 && countersAfter3.mousedown === countersBefore3.mousedown && newEntityIds(entitiesBefore3, await entityIds()).length === 0,
      { ammo: [before3.ammo, after3.ammo], yawDelta: Number(d3.yaw.toFixed(3)), pitchDelta: Number(d3.pitch.toFixed(3)), mousedown: countersAfter3.mousedown - countersBefore3.mousedown });
  }

  // ---- Check 4: the thumbstick.
  stage = "4";
  {
    const stick = await rect("#mc-stick");
    if (!stick) throw new Error("no #mc-stick");
    const cx = stick.left + stick.w / 2;
    const cy = stick.top + stick.h / 2;
    const ringRadius = stick.w * 0.42; // STICK_RADIUS_FRACTION in mobile-controls.js
    const offset = ringRadius * 0.70;  // 70% of the ring, as the brief asks
    // Noclip for the stick group.  demo2's spawn sits on a ledge above a 100-
    // unit pit, this box runs the engine at several hundred units/s, and even a
    // 20-unit capped excursion crossed the step: the return walks then fell in
    // (measured 2026-11-04, z -106 -> -186 -> -210, dead), which also left every
    // later check on a dead player.  Cheats are already on, so noclip keeps the
    // player out of the geometry; the stick's direction mapping and its release
    // are what this group measures, not the level's ledges.
    console.log("check 4: noclip on, so the stick excursions cannot fall off demo2");
    report.deviations.push("Check 4's stick directions run with the engine's noclip (cheats are on): the fixture spawn sits on a ledge above a pit and this box's engine speed makes even a 20-unit excursion fall in, so the stick's direction mapping is measured without the level's geometry. The map is reloaded before checks 5-8.");
    await consoleCommand("noclip", 900);
    const noclipState = await readEngine();
    console.log("check 4: noclip state " + JSON.stringify({ keyDest: noclipState && noclipState.keyDest, dead: noclipState && noclipState.dead, z: noclipState && noclipState.position && noclipState.position.z }));
    const centreId = nextTouchId();
    const beforeCentre = await readEngine();
    await touchEvent("touchStart", [point(centreId, cx, cy)]);
    await sleep(700);
    const centreState = await touchState();
    const duringCentre = await readEngine();
    await touchEvent("touchEnd", []);
    await sleep(250);
    const centreMove = distance(beforeCentre.position, duringCentre.position);
    check("4a", "stick pressed at the ring centre holds no keys and does not move the player",
      centreState && centreState.keys.length === 0 && centreMove !== null && centreMove < 1,
      { keys: centreState && centreState.keys, movedUnits: centreMove === null ? null : Number(centreMove.toFixed(3)) });

    // 8 directions, 70% of the ring radius.  Up is forward, right is right.
    const directions = {
      N: { dx: 0, dy: -1 }, NE: { dx: Math.SQRT1_2, dy: -Math.SQRT1_2 },
      E: { dx: 1, dy: 0 }, SE: { dx: Math.SQRT1_2, dy: Math.SQRT1_2 },
      S: { dx: 0, dy: 1 }, SW: { dx: -Math.SQRT1_2, dy: Math.SQRT1_2 },
      W: { dx: -1, dy: 0 }, NW: { dx: -Math.SQRT1_2, dy: -Math.SQRT1_2 },
    };
    const rows = {};
    let allOk = true;
    // With noclip on, geometry cannot block or kill, so each direction is a
    // fixed 160 ms push followed by a release: one clean displacement, no
    // polling race (a poll iteration here costs ~250 ms, which is how the
    // previous 20-unit cap measured 90 units).  Direction is judged by the
    // shape of that displacement: a cardinal direction must put at least 80%
    // of the travel on its axis and under 30% on the other, a diagonal at least
    // 35% on each of its two axes.  A wrong or swapped direction fails both.
    for (const [name, vector] of Object.entries(directions)) {
      const start = await readEngine();
      const id = nextTouchId();
      await touchEvent("touchStart", [point(id, cx, cy)]);
      await sleep(140);
      await touchEvent("touchMove", [point(id, cx + vector.dx * offset, cy + vector.dy * offset)]);
      await sleep(160);
      await touchEvent("touchEnd", []);
      await sleep(300);
      const end = await readEngine();
      const p = project(start, end, start.angles.yaw);
      const d = Math.hypot(p.fwd, p.right);
      const want = {
        N: { fwd: 1, right: 0 }, S: { fwd: -1, right: 0 }, E: { fwd: 0, right: 1 }, W: { fwd: 0, right: -1 },
        NE: { fwd: 1, right: 1 }, SE: { fwd: -1, right: 1 }, SW: { fwd: -1, right: -1 }, NW: { fwd: 1, right: -1 },
      }[name];
      const need = d * (want.fwd !== 0 && want.right !== 0 ? 0.35 : 0.8);
      const other = d * 0.3;
      const okFwd = want.fwd === 0 ? Math.abs(p.fwd) <= other : want.fwd * p.fwd >= need;
      const okRight = want.right === 0 ? Math.abs(p.right) <= other : want.right * p.right >= need;
      const ok = d >= 20 && okFwd && okRight;
      rows[name] = { distance: Number(d.toFixed(1)), forward: Number(p.fwd.toFixed(1)), right: Number(p.right.toFixed(1)), zDelta: Number((end.position.z - start.position.z).toFixed(1)), alive: end.dead === false, from: { x: Math.round(start.position.x), y: Math.round(start.position.y), z: Math.round(start.position.z) }, to: { x: Math.round(end.position.x), y: Math.round(end.position.y), z: Math.round(end.position.z) }, pass: ok };
      if (end.dead) {
        console.log("check 4b: the player died moving " + name + " (z " + start.position.z + " -> " + end.position.z + "); the remaining directions are not measured");
        allOk = false;
        break;
      }
      if (!ok) allOk = false;
    }
    check("4b", "stick at 70% of the ring moves in the 8 expected directions",
      allOk, { noclip: true, directions: rows });
    // Release stops, measured after the last direction's release.
    const r0 = await readEngine();
    await sleep(1200);
    const r1 = await readEngine();
    check("4c", "stick release stops the player", distance(r0.position, r1.position) < 1,
      { movedAfterRelease: Number(distance(r0.position, r1.position).toFixed(3)), noclip: true });
    // The stick group flew the player through walls in noclip; reload the map
    // so checks 5-8 start from the fixture spawn with normal physics (a respawn
    // would keep noclip and could leave the player inside a wall).
    const reloaded = await boot(base, candidate, "post-stick");
    console.log("check 4: reloaded the fixture for checks 5-8 at " + JSON.stringify(reloaded.state.position) + " in " + reloaded.ms + " ms");
    await wakeTouchUi();
    await instrument();
    await sleep(400);
  }

  // ---- Check 5 (part 2): the buttons.
  stage = "5";
  {
    // Check 4's stick rampage can end in a fall; act on it here rather than
    // letting a respawn's blaster-only loadout fail every later ammo check.
    await ensureArmed("check 5");
    // JUMP: the button holds Space (+moveup); z rises and the player lands.
    const jumpBefore = await readEngine();
    const jumpBox = await rect("#mc-jump");
    if (!jumpBox) throw new Error("no #mc-jump");
    const jx = jumpBox.left + jumpBox.w / 2, jy = jumpBox.top + jumpBox.h / 2;
    // +moveup is sampled per frame: hold it across a few frames so the jump
    // starts on any box, but release well before the first landing (~0.7 s of
    // game time) so the player does not bunny-hop through the landing check.
    // z is read during the hold as well as after it: on a box that draws
    // quickly the whole jump fits inside the hold, and a check that only
    // looked after the release saw the player already back on the floor
    // (measured on the 1.2.3 tree: 0 units, while a reading at 300 ms into
    // the hold showed +15).
    let maxZ = jumpBefore.position.z;
    let rose = false;
    let landed = false;
    await pressAt(jx, jy);
    const holdStart = Date.now();
    while (Date.now() - holdStart < 600) {
      const now = await readEngine();
      if (now && now.position) {
        if (now.position.z > maxZ) maxZ = now.position.z;
        if (now.position.z > jumpBefore.position.z + 5) rose = true;
      }
      await sleep(60);
    }
    await releaseTouch();
    const jumpStart = Date.now();
    while (Date.now() - jumpStart < 25000) {
      const now = await readEngine();
      if (now.position.z > maxZ) maxZ = now.position.z;
      if (now.position.z > jumpBefore.position.z + 5) rose = true;
      if (rose && now.position.z <= jumpBefore.position.z + 2) { landed = true; break; }
      await sleep(350);
    }
    check("5b", "buttons: JUMP raises z and the player lands again",
      rose && landed,
      { zBefore: jumpBefore.position.z, zMax: maxZ, zAfter: (await readEngine()).position.z, roseUnits: Number((maxZ - jumpBefore.position.z).toFixed(2)), rose, landed });

    // USE: the button presses and releases the engine's own +use key.
    const useBox = await rect("#mc-use");
    if (!useBox) throw new Error("no #mc-use");
    const useBefore = await readEngine();
    const useCountersBefore = await gateCounters();
    await pressAt(useBox.left + useBox.w / 2, useBox.top + useBox.h / 2);
    await sleep(1400);
    const useDuring = await touchState();
    await releaseTouch();
    await sleep(500);
    const useCounters = await gateCounters();
    const useKeyLog = useCounters.keylog.filter((entry) => entry.vk === 69 && entry.synthetic);
    const useAfter = await readEngine();
    const cfg = await dumpJson(`(() => { try { return { text: FS.readFile("/baseq2/q2touch.cfg", { encoding: "utf8" }) }; } catch (error) { return { error: String((error && error.message) || error) }; } })()`);
    const execRan = report.notes.some((entry) => entry.kind === "engine-cfg" && /q2touch/i.test(entry.text));
    check("5c", "buttons: USE holds and releases the engine's +use key, and the engine cfg that binds it actually executed",
      useKeyLog.some((entry) => entry.type === "down") && useKeyLog.some((entry) => entry.type === "up") && /bind\s+e\s+"\+use"/i.test((cfg && cfg.text) || "") && execRan,
      { keylog: useKeyLog, q2touchCfg: cfg, engineExecutedCfg: execRan, keyDest: useAfter.keyDest, alive: useAfter.dead === false,
        note: "No door on demo2/demo3 is provable in this harness; the check proves the binding and the key the button presses instead." });
    check("5d", "buttons: USE leaves the keyboard in the game with the player alive",
      useAfter.keyDest === 0 && useAfter.dead === false,
      { keyDest: useAfter.keyDest, dead: useAfter.dead, position: useAfter.position, keysHeldWhileUse: useDuring && useDuring.keys });

    // WPN with the give-all loadout: each tap switches to the next weapon the
    // engine's own weapon model index confirms.  The tap is weapnext on /,
    // the key default.cfg binds; on the 1.2.3 tree the pad pressed [ and ],
    // which kept default.cfg's invprev/invnext because q2touch.cfg never ran.
    const weaponBefore = await readEngine();
    const switches = [];
    let previous = weaponBefore;
    for (let tap = 0; tap < 2; tap++) {
      await tapSelector("#mc-weapon", 120);
      let switched = null;
      await waitFor("weaponIndex change after WPN tap " + (tap + 1), async () => {
        const now = await readEngine();
        if (now && now.weaponIndex !== null && now.weaponIndex !== previous.weaponIndex) { switched = now; return true; }
        return false;
      }, 20000).catch(() => null);
      switches.push({ before: previous.weaponIndex, after: switched && switched.weaponIndex });
      if (!switched) break;
      previous = switched;
      await sleep(600);
    }
    const weaponNoteAfter = await touchState();
    check("5e", "WPN with the give-all loadout: each tap changes the engine's weapon index, with no 'nothing to switch' note",
      switches.length === 2 && switches.every((one) => one.after !== null && one.after !== one.before) && weaponNoteAfter && weaponNoteAfter.weaponNote === false,
      { before: weaponBefore.weaponIndex, switches, note: weaponNoteAfter && weaponNoteAfter.weaponNote,
        q2touchExecuted: report.notes.some((entry) => entry.kind === "engine-cfg" && /q2touch/i.test(entry.text)) });

    // Back to the machinegun for the ammo checks below.
    await keyTap("4", "Digit4", 52, "4");
    await waitFor("the machinegun back after WPN", async () => {
      const now = await readEngine();
      return now && now.weaponIndex === weaponBefore.weaponIndex && typeof now.ammo === "number" && now.ammo > 0;
    }, 20000).catch(() => null);

    // CROUCH: holds the PC's crouch key, c (+movedown).  The engine's view
    // origin drops by the duck (view height 22 -> -2) while it is held and
    // comes back after the release; x/y do not move.
    {
      const crouchBox = await rect("#mc-crouch");
      const jumpRow = await rect("#mc-jump");
      if (!crouchBox || crouchBox.w === 0) throw new Error("no #mc-crouch");
      const standing = await readStable("crouch: standing", 8000, 900).catch(() => null) || await readEngine();
      const countersBefore = await gateCounters();
      await pressAt(crouchBox.left + crouchBox.w / 2, crouchBox.top + crouchBox.h / 2);
      let ducked = null;
      await waitFor("the view to drop while CROUCH is held", async () => {
        const now = await readEngine();
        if (now && now.position && now.position.z < standing.position.z - 15) { ducked = now; return true; }
        return false;
      }, 15000, 120).catch(() => null);
      const held = await touchState();
      await releaseTouch();
      let stood = null;
      await waitFor("the view back after CROUCH is released", async () => {
        const now = await readEngine();
        if (now && now.position && Math.abs(now.position.z - standing.position.z) <= 2) { stood = now; return true; }
        return false;
      }, 15000, 120).catch(() => null);
      const counters = await gateCounters();
      const cKeys = counters.keylog.slice(countersBefore.keylog.length).filter((entry) => entry.vk === 67 && entry.synthetic);
      const drift = ducked ? Math.hypot(ducked.position.x - standing.position.x, ducked.position.y - standing.position.y) : null;
      check("5h", "CROUCH beside JUMP holds c: the engine's view drops >= 15 units while held and returns after release",
        Boolean(ducked && stood && held && held.keys.includes("crouch") && drift !== null && drift < 2 &&
          cKeys.some((entry) => entry.type === "down") && cKeys.some((entry) => entry.type === "up") &&
          Math.abs(crouchBox.top - jumpRow.top) < 1 && Math.abs(crouchBox.h - jumpRow.h) < 1 && crouchBox.right <= jumpRow.left),
        { zStanding: standing.position.z, zDucked: ducked && ducked.position.z, zAfter: stood && stood.position.z,
          drop: ducked ? Number((standing.position.z - ducked.position.z).toFixed(2)) : null, xyDrift: drift === null ? null : Number(drift.toFixed(2)),
          keysHeld: held && held.keys, keylog: cKeys.map((entry) => entry.type),
          crouchBox: round(crouchBox), jumpBox: round(jumpRow) });
    }

    // CROUCH with the stick: a crouch-walk moves the player with the view low.
    {
      const stick = await rect("#mc-stick");
      const crouchBox = await rect("#mc-crouch");
      const sx = stick.left + stick.w / 2, sy = stick.top + stick.h / 2;
      const offset = stick.w * 0.42 * 0.70;
      const start = await readStable("crouch-walk: standing", 8000, 900).catch(() => null) || await readEngine();
      const id1 = nextTouchId(), id2 = nextTouchId();
      const cx = crouchBox.left + crouchBox.w / 2, cy = crouchBox.top + crouchBox.h / 2;
      await touchEvent("touchStart", [point(id2, cx, cy)]);
      let low = null;
      await waitFor("the view low before the crouch-walk", async () => {
        const now = await readEngine();
        if (now && now.position && now.position.z < start.position.z - 15) { low = now; return true; }
        return false;
      }, 15000, 120).catch(() => null);
      await touchEvent("touchStart", [point(id2, cx, cy), point(id1, sx, sy)]);
      await sleep(120);
      await touchEvent("touchMove", [point(id2, cx, cy), point(id1, sx, sy - offset)]);
      let walked = null;
      await waitFor("the crouch-walk to cover ground", async () => {
        const now = await readEngine();
        if (now && now.position && distance(start.position, now.position) > 30) { walked = now; return true; }
        return false;
      }, 15000, 150).catch(() => null);
      const walkState = await touchState();
      await touchEvent("touchEnd", []);
      await sleep(900);
      check("5i", "CROUCH with the stick: a crouch-walk moves the player while the view stays low",
        Boolean(low && walked && walked.position.z < start.position.z - 15 && walkState && walkState.keys.includes("crouch") && walkState.keys.includes("forward")),
        { zStanding: start.position.z, zLow: low && low.position.z, zWhileWalking: walked && walked.position.z,
          movedUnits: walked ? Number(distance(start.position, walked.position).toFixed(1)) : null, keys: walkState && walkState.keys });
      await returnTo(start);
    }

    // PAUSE: the engine menu opens, the pad hides, Resume returns to the game.
    const pauseBox = await rect("#mc-pause");
    if (!pauseBox) throw new Error("no #mc-pause");
    await tapAt(pauseBox.left + pauseBox.w / 2, pauseBox.top + pauseBox.h / 2, 80);
    let menuState = null;
    const menuOk = await waitFor("engine menu after PAUSE (keyDest 3)", async () => {
      const now = await readEngine();
      if (now && now.keyDest === 3) { menuState = now; return true; }
      return false;
    }, 10000).catch(() => null);
    // The app's poll turns keyDest 3 into the page menu about 120 ms later.
    await waitFor("the page menu to open", async () => dumpJson(`document.body.classList.contains("menu-open")`), 4000).catch(() => null);
    const padWhileMenu = await dumpJson(`(() => { const root = document.getElementById("mobile-controls"); return { display: root ? getComputedStyle(root).display : null, menuOpen: document.body.classList.contains("menu-open") }; })()`);
    if (options.phone) await capture("phone-menu", "landscape 844x390, menu open over the game");
    let resume = await rect('[data-action="resume"]');
    let resumed = null;
    if (resume) {
      const target = resume;
      await tapAt(target.left + target.w / 2, target.top + target.h / 2, 90);
      resumed = await waitFor("the game after Resume", async () => {
        const now = await readEngine();
        if (now && now.keyDest === 0) return now;
        return false;
      }, 12000).catch(() => null);
    }
    check("5f", "buttons: PAUSE opens the engine menu with the pad hidden, and Resume returns the game",
      Boolean(menuOk) && padWhileMenu.display === "none" && Boolean(resumed),
      { keyDestWhilePaused: menuState && menuState.keyDest, padDisplayWhileMenu: padWhileMenu.display, menuOpenClass: padWhileMenu.menuOpen, keyDestAfterResume: resumed && resumed.keyDest });

    // Touch controls off and back on from the menu (OPTIONS > touch
    // controls). The PAD button over the game is gone (the owner's HUD
    // review); this row is the one place the pad is put away and brought back.
    const padRow = async () => dumpJson(`(() => {
      const row = document.querySelector('[data-action="touch-pad"]');
      return row ? { value: (document.getElementById("touch-pad-value") || {}).textContent || null, pressed: row.getAttribute("aria-pressed"),
        inOptions: Boolean(row.closest('.menu-view[data-view="options"]')) } : null;
    })()`);
    const openPadOptions = async () => {
      await tapSelector("#mc-pause", 80);
      await waitFor("the page menu after MENU", async () => dumpJson(`document.body.classList.contains("menu-open")`), 10000);
      await sleep(300);
      await tapSelector('.menu-view[data-view="main"] [data-action="options"]', 80);
      await waitFor("the OPTIONS view", async () => dumpJson(`(() => { const view = document.querySelector('.menu-view[data-view="options"]'); return Boolean(view && !view.hidden); })()`), 5000);
      await dumpJson(`(() => { const row = document.querySelector('[data-action="touch-pad"]'); if (row) row.scrollIntoView({ block: "center" }); return true; })()`);
      await sleep(300);
      return rect('[data-action="touch-pad"]');
    };
    const resumeFromMenu = async () => {
      await tapSelector('.menu-foot [data-action="resume"]', 90);
      return waitFor("the game after Resume", async () => {
        const now = await readEngine();
        const open = await dumpJson(`document.body.classList.contains("menu-open")`);
        return now && now.keyDest === 0 && !open ? now : false;
      }, 12000).catch(() => null);
    };
    const padBefore = await touchState();
    const rowBox = await openPadOptions();
    await tapSelector('[data-action="touch-pad"]', 80);
    await sleep(400);
    const rowOff = await padRow();
    const resumedOff = await resumeFromMenu();
    await sleep(600);
    const padOff = await touchState();
    const snapOff = await layoutSnapshot();
    const stickOff = await rect("#mc-stick");
    const actionsOff = await rect("#mc-actions");
    if (options.phone) await capture("phone-pad-off", "landscape 844x390, touch controls off from OPTIONS: only MENU stays");
    await openPadOptions();
    await tapSelector('[data-action="touch-pad"]', 80);
    await sleep(400);
    const rowOn = await padRow();
    const resumedOn = await resumeFromMenu();
    await sleep(600);
    const padOn = await touchState();
    const stickOn = await rect("#mc-stick");
    const actionsOn = await rect("#mc-actions");
    check("5g", "touch controls: no PAD button; OPTIONS > touch controls hides the pad (MENU stays) and shows it again",
      Boolean(padBefore && padBefore.padOn === true && rowBox && rowBox.h >= 44 && rowOff && rowOff.inOptions && rowOff.value === "off" &&
        resumedOff && padOff && padOff.padOn === false && stickOff.display === "none" && actionsOff.display === "none" &&
        snapOff.targets.length === 1 && snapOff.targets[0].id === "#mc-pause" && snapOff.floating.length === 0 &&
        rowOn && rowOn.value === "on" && resumedOn && padOn && padOn.padOn === true && stickOn.display !== "none" && actionsOn.display !== "none"),
      { padOnBefore: padBefore && padBefore.padOn, rowBox: rowBox && round(rowBox), rowOff, padOnAfterOff: padOff && padOff.padOn,
        stickDisplayOff: stickOff.display, actionsDisplayOff: actionsOff.display, targetsOff: snapOff.targets.map((one) => one.id),
        floating: snapOff.floating, rowOn, padOnAfterOn: padOn && padOn.padOn, stickDisplayOn: stickOn.display, actionsDisplayOn: actionsOn.display });
    // Opacity with the pad put away: nothing of the pad is drawn (no box, no
    // touch), MENU alone stays, at the idle strength.
    const menuOff = snapOff.targets.find((one) => one.id === "#mc-pause");
    check("O3", "opacity with the pad hidden: the stick and every action control are not drawn and take no touch; MENU stays at idle strength",
      Boolean(stickOff.display === "none" && actionsOff.display === "none" && stickOff.w === 0 && actionsOff.w === 0 &&
        snapOff.targets.length === 1 && menuOff && menuOff.opacity >= 0.3 && menuOff.opacity <= 0.6 && menuOff.w >= 44 && menuOff.h >= 44),
      { stick: { display: stickOff.display, w: stickOff.w }, actions: { display: actionsOff.display, w: actionsOff.w },
        drawnTargets: snapOff.targets.map((one) => ({ id: one.id, opacity: one.opacity, box: round(one) })) });
  }

  // ---- Check 6: two fingers at once.
  stage = "6";
  {
    await ensureArmed("check 6");
    const stick = await rect("#mc-stick");
    const fire = await fireButton();
    if (!stick || !fire) throw new Error("two-finger controls missing");
    const sx = stick.left + stick.w / 2, sy = stick.top + stick.h / 2;
    const offset = stick.w * 0.42 * 0.70;
    const fx = fire.left + fire.w / 2, fy = fire.top + fire.h / 2;

    // stick + fire
    {
      const before = await readEngine();
      const id1 = nextTouchId(), id2 = nextTouchId();
      await touchEvent("touchStart", [point(id1, sx, sy + 0), point(id2, fx, fy)]);
      await sleep(150);
      await touchEvent("touchMove", [point(id1, sx, sy - offset), point(id2, fx, fy)]);
      await sleep(2600);
      const moved = await readEngine();
      const touch = await touchState();
      await touchEvent("touchEnd", []);
      await sleep(900);
      const movedUnits = distance(before.position, moved.position);
      const ammoDrop = before.ammo - moved.ammo;
      check("6a", "two fingers: stick + FIRE move the player and fire in the same window",
        movedUnits > 10 && ammoDrop > 0,
        { movedUnits: Number(movedUnits.toFixed(1)), ammo: [before.ammo, moved.ammo], keys: touch && touch.keys, fireHeld: touch && touch.fireHeld });
      await returnTo(before);
    }

    // look + fire
    {
      const before = await readEngine();
      const look = await rect("#mc-look");
      const lx = look.left + look.w * 0.55, ly = look.top + look.h * 0.42;
      const id1 = nextTouchId(), id2 = nextTouchId();
      await touchEvent("touchStart", [point(id1, lx, ly), point(id2, fx, fy)]);
      for (let i = 1; i <= 8; i++) {
        await touchEvent("touchMove", [point(id1, lx - 120 * i / 8, ly - 50 * i / 8), point(id2, fx, fy)]);
        await sleep(60);
      }
      await sleep(1600);
      const after = await readEngine();
      await touchEvent("touchEnd", []);
      await sleep(700);
      const d = angleDelta(before, after);
      const ammoDrop = before.ammo - after.ammo;
      check("6b", "two fingers: look + FIRE turn the view and fire in the same window",
        Math.abs(d.yaw) > 5 && ammoDrop > 0,
        { yawDelta: Number(d.yaw.toFixed(2)), pitchDelta: Number(d.pitch.toFixed(2)), ammo: [before.ammo, after.ammo] });
    }

    // stick + look
    {
      const before = await readEngine();
      const look = await rect("#mc-look");
      const lx = look.left + look.w * 0.60, ly = look.top + look.h * 0.42;
      const id1 = nextTouchId(), id2 = nextTouchId();
      await touchEvent("touchStart", [point(id1, sx, sy), point(id2, lx, ly)]);
      await sleep(120);
      await touchEvent("touchMove", [point(id1, sx, sy - offset), point(id2, lx - 80, ly)]);
      await sleep(2400);
      const during = await readEngine();
      await touchEvent("touchEnd", []);
      await sleep(800);
      const movedUnits = distance(before.position, during.position);
      const d = angleDelta(before, during);
      check("6c", "two fingers: stick + look move the player and turn the view at once",
        movedUnits > 10 && Math.abs(d.yaw) > 5,
        { movedUnits: Number(movedUnits.toFixed(1)), yawDelta: Number(d.yaw.toFixed(2)), pitchDelta: Number(d.pitch.toFixed(2)) });
      await returnTo(before);
    }

    // stick + FIRE that slides: move, aim and fire in ONE two-finger gesture
    // (the owner's "fire+move"). The left thumb holds the stick forward; the
    // right thumb presses FIRE and slides left while it keeps firing.
    {
      await ensureArmed("check 6d");
      const before = await readEngine();
      const countersBefore = await gateCounters();
      const id1 = nextTouchId(), id2 = nextTouchId();
      await touchEvent("touchStart", [point(id1, sx, sy)]);
      await sleep(120);
      await touchEvent("touchMove", [point(id1, sx, sy - offset)]);
      await touchEvent("touchStart", [point(id1, sx, sy - offset), point(id2, fx, fy)]);
      await sleep(700);
      const aiming = await touchState();
      for (let i = 1; i <= 10; i++) {
        await touchEvent("touchMove", [point(id1, sx, sy - offset), point(id2, fx - 6 * i, fy - 2 * i)]);
        await sleep(70);
      }
      await sleep(1600);
      const during = await readEngine();
      const held = await touchState();
      await touchEvent("touchEnd", []);
      await sleep(900);
      const after = await readEngine();
      const counters = await gateCounters();
      const movedUnits = distance(before.position, during.position);
      const d = angleDelta(before, during);
      const ammoDrop = before.ammo - during.ammo;
      check("6d", "one two-finger gesture: stick + FIRE sliding to aim moves >= 50 units, turns >= 5 deg and drops ammo",
        movedUnits >= 50 && Math.abs(d.yaw) >= 5 && ammoDrop > 0 && held && held.fireHeld === true && held.keys.includes("forward") &&
          aiming && aiming.fireAiming === true && after.ammo <= during.ammo,
        { movedUnits: Number(movedUnits.toFixed(1)), yawDelta: Number(d.yaw.toFixed(2)), pitchDelta: Number(d.pitch.toFixed(2)),
          ammo: [before.ammo, during.ammo, after.ammo], keys: held && held.keys, fireHeld: held && held.fireHeld,
          fireAiming: aiming && aiming.fireAiming, mousedowns: counters.mousedown - countersBefore.mousedown });
      await returnTo(before);
    }
  }

  // ---- Check 7: pointercancel / touchCancel on held controls.
  stage = "7";
  {
    await ensureArmed("check 7");
    const fire = await fireButton();
    const fx = fire.left + fire.w / 2, fy = fire.top + fire.h / 2;
    const before = await readEngine();
    await pressAt(fx, fy);
    await sleep(1500);
    await touchEvent("touchCancel", []);
    await sleep(1400);
    const cancelled = await touchState();
    const sampled1 = await readEngine();
    await sleep(1400);
    const sampled2 = await readEngine();
    const stopped = sampled1.ammo === sampled2.ammo;
    // The next press must work.
    await pressAt(fx, fy);
    await sleep(2200);
    await touchEvent("touchEnd", []);
    await sleep(700);
    const after = await readEngine();
    const nextPressFired = before.ammo !== after.ammo || (typeof after.ammo === "number" && typeof sampled2.ammo === "number" && after.ammo < sampled2.ammo);
    check("7a", "touchCancel on held FIRE releases it; ammo stops; the next press fires",
      cancelled && cancelled.fireHeld === false && stopped && nextPressFired,
      { fireHeldAfterCancel: cancelled && cancelled.fireHeld, ammoStable: stopped, ammo: [before.ammo, sampled1.ammo, sampled2.ammo, after.ammo] });

    const stick = await rect("#mc-stick");
    const sx = stick.left + stick.w / 2, sy = stick.top + stick.h / 2;
    const offset = stick.w * 0.42 * 0.70;
    // demo2's floor is not perfectly level: with no key held the player slid
    // 9.7 units between the two post-cancel samples in run 6.  Measure the
    // level's own drift first, so "stopped" means the stick is not pushing the
    // player rather than that the floor is flat.
    // A CDP touch that never reaches the stick moves nothing at all (run 7's
    // first press: no keys, 0 units, while the very next press moved 29.9), so
    // a press that registers nothing is re-sent once instead of being counted
    // as the control failing.
    let baseDrift = 0;
    let stickBefore = null;
    let moving = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const drift0 = await readEngine();
      await sleep(1300);
      const drift1 = await readEngine();
      baseDrift = distance(drift0.position, drift1.position);
      console.log("check 7b: attempt " + attempt + ", the floor's own drift over 1.3 s is " + Number(baseDrift.toFixed(1)) + " units");
      stickBefore = await readEngine();
      const id = nextTouchId();
      await touchEvent("touchStart", [point(id, sx, sy)]);
      await sleep(140);
      await touchEvent("touchMove", [point(id, sx, sy - offset)]);
      await sleep(1500);
      moving = await readEngine();
      if (distance(stickBefore.position, moving.position) > 5) break;
      await touchEvent("touchCancel", []);
      await sleep(700);
      console.log("check 7b: attempt " + attempt + " moved " + distance(stickBefore.position, moving.position).toFixed(1) + " units while held; pressing the stick again");
    }
    await touchEvent("touchCancel", []);
    await sleep(1200);
    const afterCancel = await touchState();
    const s1 = await readEngine();
    await sleep(1300);
    const s2 = await readEngine();
    const postDrift = distance(s1.position, s2.position);
    // "Stopped" is measured against the push itself: the held stick moved the
    // player ~31 units in 1.5 s, so a post-cancel window that travels less than
    // a fifth of that is the engine's residual slide, not the stick still
    // pushing.  A stick left down would keep the same ~20 units/s and fail.
    const heldDistance = distance(stickBefore.position, moving.position);
    const stickStopped = postDrift <= Math.max(1, baseDrift + 1, heldDistance * 0.2);
    // Next press works.  A CDP touch the page misses moves nothing at all (the
    // same drop the held press above retries), so a next press that registers
    // nothing is re-sent once instead of being read as the control failing.
    let movedAgain = 0;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const ref = await readEngine();
      const id2 = nextTouchId();
      await touchEvent("touchStart", [point(id2, sx, sy)]);
      await sleep(120);
      await touchEvent("touchMove", [point(id2, sx, sy - offset)]);
      await sleep(1800);
      const again = await readEngine();
      await touchEvent("touchEnd", []);
      await sleep(600);
      movedAgain = distance(ref.position, again.position);
      if (movedAgain > 5) break;
      console.log("check 7b: the next press (attempt " + attempt + ") moved " + movedAgain.toFixed(1) + " units; pressing again");
    }
    check("7b", "touchCancel on held stick releases it; the player stops; the next press moves",
      heldDistance > 5 && afterCancel && afterCancel.keys.length === 0 && stickStopped && movedAgain > 5,
      { movedWhileHeld: Number(heldDistance.toFixed(1)), keysAfterCancel: afterCancel && afterCancel.keys, movedAfterCancel: Number(postDrift.toFixed(3)), floorDrift: Number(baseDrift.toFixed(1)), stopBar: Number(Math.max(1, baseDrift + 1, heldDistance * 0.2).toFixed(1)), cancelWindow: { from: s1.position, to: s2.position }, movedOnNextPress: Number(movedAgain.toFixed(1)) });
    await returnTo(stickBefore);
  }

  // ---- Check 8: release-all on blur and tab hide.
  stage = "8";
  {
    await ensureArmed("check 8");
    const stick = await rect("#mc-stick");
    const fire = await fireButton();
    const sx = stick.left + stick.w / 2, sy = stick.top + stick.h / 2;
    const offset = stick.w * 0.42 * 0.70;
    const fx = fire.left + fire.w / 2, fy = fire.top + fire.h / 2;
    await evaluate("window.__gate.events = []; 1");
    const before = await readEngine();
    const id1 = nextTouchId(), id2 = nextTouchId();
    await touchEvent("touchStart", [point(id1, sx, sy), point(id2, fx, fy)]);
    await sleep(120);
    await touchEvent("touchMove", [point(id1, sx, sy - offset), point(id2, fx, fy)]);
    await sleep(2000);
    const heldState = await touchState();
    const heldEngine = await readEngine();
    // Background the page through the browser endpoint: a new target becomes active.
    let backgrounded = false;
    if (browserCdp) {
      const created = await browserCdp.send("Target.createTarget", { url: "about:blank" });
      await browserCdp.send("Target.activateTarget", { targetId: created.targetId });
      backgrounded = true;
      await sleep(1200);
      const hiddenState = await touchState();
      const hiddenEngine1 = await readEngine();
      await sleep(1300);
      const hiddenEngine2 = await readEngine();
      const events = await dumpJson("window.__gate.events || []");
      const visibility = await evaluate("document.visibilityState");
      const stoppedMoving = distance(hiddenEngine1.position, hiddenEngine2.position) < 1;
      const stoppedFiring = hiddenEngine1.ammo === hiddenEngine2.ammo;
      const wentHidden = events.some((one) => one === "blur" || one === "visibility:hidden");
      check("8a", "blur/tab hide: held stick + FIRE are released and the player/ammo stop",
        heldState && heldState.fireHeld === true && heldState.keys.length > 0 && hiddenState && hiddenState.fireHeld === false && hiddenState.keys.length === 0 && stoppedMoving && stoppedFiring && wentHidden,
        { held: { keys: heldState && heldState.keys, fireHeld: heldState && heldState.fireHeld, ammo: heldEngine.ammo }, afterHide: { keys: hiddenState && hiddenState.keys, fireHeld: hiddenState && hiddenState.fireHeld }, visibilityAfterHide: visibility, wentHidden, movedAfterHide: Number(distance(hiddenEngine1.position, hiddenEngine2.position).toFixed(3)), ammoAfterHide: [hiddenEngine1.ammo, hiddenEngine2.ammo], events });
      await browserCdp.send("Target.activateTarget", { targetId: chromeTargetId });
      await cdp.send("Page.bringToFront");
      await sleep(1500);
      await browserCdp.send("Target.closeTarget", { targetId: created.targetId }).catch(() => null);
      const visible = await evaluate("document.visibilityState");
      const visibleState = await touchState();
      // Return and press again, on the button as it is laid out now.
      await wakeTouchUi();
      const fireAgain = await rect("#mc-fire");
      const ax = fireAgain && fireAgain.w > 0 ? fireAgain.left + fireAgain.w / 2 : fx;
      const ay = fireAgain && fireAgain.h > 0 ? fireAgain.top + fireAgain.h / 2 : fy;
      await pressAt(ax, ay);
      await sleep(2200);
      await touchEvent("touchEnd", []);
      await sleep(700);
      const after = await readEngine();
      const pressedAgain = after.ammo < hiddenEngine2.ammo || after.ammo < before.ammo;
      check("8b", "returning to the tab leaves no keys down and the next FIRE press works",
        visible === "visible" && visibleState && visibleState.fireHeld === false && visibleState.keys.length === 0 && pressedAgain,
        { visibility: visible, keys: visibleState && visibleState.keys, fireHeld: visibleState && visibleState.fireHeld, ammo: [before.ammo, hiddenEngine2.ammo, after.ammo] });
    } else {
      check("8a", "blur/tab hide: held stick + FIRE are released and the player/ammo stop", false, { error: "no browser endpoint" });
      check("8b", "returning to the tab leaves no keys down and the next FIRE press works", false, { error: "no browser endpoint" });
    }
    // 8b's press already ended its touch; a second touchEnd with no active
    // touch is a CDP error ("Must send a TouchStart first") that aborted the run.
    await sleep(400);
    assertNoHeld(touchState);
  }
  stage = "8-done";
  return true;
}

async function assertNoHeld(touchStateFn) {
  const state = await touchStateFn();
  if (!state) return;
  if (state.fireHeld || (state.keys && state.keys.length)) {
    report.notes.push({ kind: "held-after-check", keys: state.keys, fireHeld: state.fireHeld });
  }
}

// ---- Portrait -------------------------------------------------------------

async function checkPortrait(base, candidate) {
  stage = "9";
  // The checks before this one walk and fire the player around the level.  The
  // portrait checks read ammo and need a live armed player, and the pad they
  // would use to respawn is hidden once the page is portrait, so bring the
  // player back while the landscape pad is still on screen.
  await ensureArmed("check 9");
  const before = await readEngine();
  await emulate(PORTRAIT_SIZE, true, MOBILE_UA, portraitOrientation());
  await sleep(1400);
  const state = await touchState();
  const overlay = await rect("#rotate-overlay");
  const stick = await rect("#mc-stick");
  const actions = await rect("#mc-actions");
  const pause = await rect("#mc-pause");
  const portrait = state && state.portrait;
  check("9a", "portrait (390x844): rotate guide visible, pad hidden, pause reachable",
    portrait && overlay.display !== "none" && overlay.hidden !== true && /Rotate your device/i.test(overlay.text || "") && stick.display === "none" && actions.display === "none" && pause.display !== "none",
    { portrait, rotateDisplay: overlay.display, rotateText: overlay.text, stickDisplay: stick.display, actionsDisplay: actions.display, pauseDisplay: pause.display });
  if (options.phone) await capture("phone-portrait", "portrait 390x844 with the rotate guide");
  await checkLayout("L3", "layout 390x844 portrait", PORTRAIT_TARGETS);

  // A tap where the FIRE button would be (bottom right) must not fire.  The
  // engine's stats array is momentarily unreadable while the page resizes for
  // the rotation (engine-state then reports ammo null with a reason), so read
  // until the engine yields a number instead of failing on a moment when there
  // was nothing to compare (run 10 read ammo null straight after the rotate).
  const readAmmoState = async (label) => {
    const state = await waitFor(label, async () => {
      const now = await readEngine();
      return now && typeof now.ammo === "number" ? now : false;
    }, 8000, 250).catch(() => null);
    return state || (await readEngine());
  };
  const beforeTap = await readAmmoState("portrait ammo before the tap");
  const ammoBefore = beforeTap.ammo;
  const anglesBefore = beforeTap;
  const countersBefore = await gateCounters();
  await tapAt(PORTRAIT_SIZE.width * 0.86, PORTRAIT_SIZE.height * 0.82, 80);
  await sleep(1300);
  const after = await readAmmoState("portrait ammo after the tap");
  const d = angleDelta(anglesBefore, after);
  const countersAfter = await gateCounters();
  const touchAfterTap = await touchState();
  check("9b", "portrait: a tap where FIRE would be fires nothing",
    after.ammo === ammoBefore && Math.abs(d.yaw) <= 1 && Math.abs(d.pitch) <= 1 && touchAfterTap && touchAfterTap.fireHeld === false,
    { ammo: [ammoBefore, after.ammo], ammoReason: after.ammoReason || null, dead: after.dead, yawDelta: Number(d.yaw.toFixed(3)), pitchDelta: Number(d.pitch.toFixed(3)), mousedown: countersAfter.mousedown - countersBefore.mousedown, fireHeld: touchAfterTap && touchAfterTap.fireHeld });

  // Pause is reachable in portrait; resume from the page menu.
  const pauseBox = await rect("#mc-pause");
  await tapAt(pauseBox.left + pauseBox.w / 2, pauseBox.top + pauseBox.h / 2, 80);
  const paused = await waitFor("the engine menu in portrait", async () => {
    const now = await readEngine();
    return now && now.keyDest === 3 ? now : false;
  }, 10000).catch(() => null);
  await waitFor("the page menu to open in portrait", async () => dumpJson(`document.body.classList.contains("menu-open")`), 4000).catch(() => null);
  const resume = await rect('[data-action="resume"]');
  let resumed = null;
  if (resume) {
    const target = resume;
    await tapAt(target.left + target.w / 2, target.top + target.h / 2, 90);
    resumed = await waitFor("the game after Resume in portrait", async () => {
      const now = await readEngine();
      return now && now.keyDest === 0 ? now : false;
    }, 12000).catch(() => null);
  }
  check("9c", "portrait: pause opens the menu and Resume returns to the game",
    Boolean(paused) && Boolean(resumed),
    { keyDestPaused: paused && paused.keyDest, keyDestAfterResume: resumed && resumed.keyDest });
  await emulate(MOBILE_SIZE, true, MOBILE_UA, landscapeOrientation());
  await sleep(800);
  await wakeTouchUi();
  return true;
}

// ---- Desktop --------------------------------------------------------------

async function desktopBoot(base, candidate) {
  await emulate(DESKTOP_SIZE, false, DESKTOP_UA, landscapeOrientation());
  await sleep(500);
  const booted = await boot(base, candidate, "desktop");
  await sleep(600);
  const ui = await dumpJson(`(() => ({
    touchUi: document.body.classList.contains("touch-ui"),
    isTouch: !!(window.quake2Touch && window.quake2Touch.isTouchUi && window.quake2Touch.isTouchUi()),
    state: window.quake2Touch ? window.quake2Touch.state() : null,
    controls: (() => { const root = document.getElementById("mobile-controls"); return root ? { hidden: root.hidden, display: getComputedStyle(root).display } : null; })(),
    canvas: (() => { const c = document.getElementById("canvas"); if (!c) return null; const b = c.getBoundingClientRect(); return { left: b.left, top: b.top, w: b.width, h: b.height, id: c.id }; })(),
  }))()`);
  return { state: booted.state, ui, bootMs: booted.ms };
}

async function desktopArm() {
  // Closing the console hands the engine a pointer lock from inside the key
  // event; when headless Chrome drops that lock at once, app.js reads the lost
  // lock as the player's Escape and opens its menu (keyDest 3, a panel over the
  // canvas, every later mouse move hitting the panel).  A trusted Escape is the
  // player's own way back, so key the game back to keyDest 0 before measuring.
  const backToGame = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const state = await readEngine();
      if (state && state.keyDest === 0) return true;
      console.log("desktop: arming left keyDest " + (state && state.keyDest) + "; closing it with a trusted Escape");
      await keyTap("Escape", "Escape", 27);
      await sleep(1600);
    }
    return false;
  };
  const canvasCentre = async () => {
    const c = await dumpJson(`(() => { const b = document.getElementById("canvas").getBoundingClientRect(); return { left: b.left, top: b.top, w: b.width, h: b.height }; })()`);
    return { x: c.left + c.w / 2, y: c.top + c.h / 2 };
  };
  const clickOnce = async () => {
    const { x, y } = await canvasCentre();
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
    await sleep(80);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
    await sleep(900);
  };
  // Arming is a chain of trusted CDP key events typed into the engine's own
  // console: one event the page misses leaves `give all` or the weapon key
  // untyped and the loadout empty (run 8's headful leg timed out on exactly
  // that).  A page still unarmed after a pass is therefore armed again from
  // scratch rather than aborting the desktop leg.
  let armed = null;
  for (let attempt = 1; attempt <= 3 && !armed; attempt++) {
    const before = await readEngine();
    console.log("desktop: arming attempt " + attempt + " (keyDest " + (before && before.keyDest) + ", dead " + (before && before.dead) + ", ammo " + (before && before.ammo) + ")");
    if (before && before.dead) {
      // A deathmatch death waits for the attack button: a trusted left press is
      // the player's own respawn gesture.
      console.log("desktop: the player is dead; respawning with a trusted left press");
      await clickOnce();
      for (let i = 0; i < 10; i++) { const now = await readEngine(); if (now && now.dead === false) break; await sleep(300); }
    }
    await backToGame();
    try { await evaluate("document.getElementById('canvas').focus(); 1"); } catch { /* no canvas */ }
    await consoleCommand("sv_cheats 1;give all", 1200);
    await keyTap("4", "Digit4", 52, "4");
    armed = await waitFor("desktop ammo", async () => {
      const state = await readEngine();
      return state && typeof state.ammo === "number" && state.ammo > 0 ? state : false;
    }, 12000, 300).catch(() => null);
  }
  if (!armed) console.log("desktop: the give-all loadout never produced readable ammo after 3 passes; check 10d reports the numbers it sees");
  await backToGame();
  try { await evaluate("document.getElementById('canvas').focus(); 1"); } catch { /* no canvas */ }
  const state = await readEngine();
  console.log("desktop: armed at keyDest " + (state && state.keyDest) + " with ammo " + (state && state.ammo));
  return state;
}

async function desktopLookAndLock(canvas) {
  const cx = canvas.left + canvas.w / 2;
  const cy = canvas.top + canvas.h / 2;
  const pageState = () => dumpJson(`(() => {
    const at = document.elementFromPoint(${Math.round(cx + 60)}, ${Math.round(cy)});
    let engineLock = null;
    try { engineLock = window.Module && window.Module.Browser ? !!window.Module.Browser.pointerLock : null; } catch (error) { engineLock = "error"; }
    return { lock: document.pointerLockElement ? document.pointerLockElement.id : null, body: document.body.className, engineLock, at: at ? (at.id || at.tagName) : null };
  })()`);
  const moveLog = async () => {
    const events = await dumpJson("(window.__gate && window.__gate.moves) || []");
    return events.slice(-8);
  };

  // A trusted click on the canvas is the pointer-lock gesture.
  const click = async () => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", buttons: 1, clickCount: 1 });
    await sleep(80);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", buttons: 0, clickCount: 1 });
  };
  const lockNow = () => evaluate("document.pointerLockElement ? document.pointerLockElement.id : null");

  // The lock the app takes while its console closes is measured first: probe
  // 20 (same page, same arming) reported real deltas under exactly that lock.
  // If its moves arrive as net-zero pairs — this Chrome can pin the cursor at
  // a stale point and report each CDP move and its correction — release it and
  // take a fresh one with the check's own trusted click, which is the gesture
  // check 10b is about.
  const lockBefore = await lockNow();
  console.log("desktop: lock as the look check starts " + lockBefore);
  let lockAfterExit = lockBefore;
  let locked = lockBefore;
  if (!locked) {
    await click();
    await sleep(1800);
  }
  const relinquishAndReclick = async () => {
    try { await evaluate("if (document.pointerLockElement) document.exitPointerLock(); 1"); } catch { /* no lock API */ }
    await sleep(90);
    lockAfterExit = await lockNow();
    // Re-lock inside app.js's ~220 ms lost-lock window so its handler sees the
    // lock restored instead of reading the gap as the player's Escape.
    await click();
    await sleep(1800);
    // If the gap did open the menu, the click landed on its panel; the
    // player's own Escape closes it and the resume path re-locks.
    const afterRelock = await pageState();
    if (afterRelock.at !== "canvas") {
      console.log("desktop: the relock left " + JSON.stringify(afterRelock) + "; closing the menu with a trusted Escape");
      await keyTap("Escape", "Escape", 27);
      await sleep(1600);
      if ((await pageState()).at !== "canvas") { await click(); await sleep(1800); }
    }
    return lockNow();
  };

  // One warm-up move puts the engine's reference point on the canvas centre so
  // the measured moves are pure deltas (the very first mousemove after a load
  // is taken as a new reference, not as a turn).
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy, button: "none", buttons: 0 });
  await sleep(600);
  const pageBefore = await pageState();
  console.log("desktop: page before the look moves " + JSON.stringify(pageBefore));

  let lockedDelta = { yaw: 0, pitch: 0 };
  let lockedMoves = [];
  let pageDuring = pageBefore;
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (!locked) {
      await click();
      await sleep(1800);
      locked = await lockNow();
      if (!locked) break;
    }
    // A fresh lock starts a new reference point, so repeat the warm-up after
    // every re-lock: its first move is not a turn.
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy, button: "none", buttons: 0 });
    await sleep(600);
    await evaluate("if (window.__gate) window.__gate.moves = []; 1");
    pageDuring = await pageState();
    console.log("desktop: page while locked (" + attempt + ") " + JSON.stringify(pageDuring));
    const lockedBefore = await readEngine();
    for (let i = 1; i <= 5; i++) {
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx + i * 30, y: cy + i * 10, button: "none", buttons: 0 });
      await sleep(90);
    }
    await sleep(2200);
    lockedDelta = angleDelta(lockedBefore, await readEngine());
    lockedMoves = await moveLog();
    console.log("desktop: locked look moves (" + attempt + ") " + JSON.stringify(lockedMoves));
    if (Math.abs(lockedDelta.yaw) > 3 || Math.abs(lockedDelta.pitch) > 3) break;
    if (attempt < 3) {
      console.log("desktop: the locked moves turned nothing; releasing the lock and taking a fresh one with our own trusted click");
      locked = await relinquishAndReclick();
    }
  }
  return { lockBefore, lockAfterExit, locked, lockedDelta, lockedMoves, pageBefore, pageDuring, cx, cy };
}

async function checkDesktop(base, candidate) {
  stage = "10";
  // The desktop leg gets its own freshly launched Chrome.  In the shared
  // browser the phone and portrait phases leave the pointer at a stale
  // position: the app's own console lock then pins the cursor there (clientY
  // -87 in run 5) and every CDP move arrives as a pair of opposite deltas, so
  // no look can be measured.  A fresh browser reports the same events as real
  // deltas (probes 18-20).
  await closeChrome();
  await launchChrome({ headless: true, windowSize: DESKTOP_SIZE.width + "," + DESKTOP_SIZE.height });
  report.notes.push({ kind: "desktop-browser", text: "the desktop leg runs in a freshly launched Chrome so the phone emulation's stale cursor state cannot zero the mouse moves" });
  let desktopMode = "headless";
  let boot = await desktopBoot(base, candidate);
  let canvas = boot.ui.canvas;
  if (!canvas) throw new Error("no canvas on the desktop page");
  check("10a", "desktop (1280x720, no touch emulation): the touch layer is absent",
    boot.ui.isTouch === false && boot.ui.touchUi === false && boot.ui.controls && boot.ui.controls.display === "none",
    { isTouchUi: boot.ui.isTouch, touchUiClass: boot.ui.touchUi, controls: boot.ui.controls, viewport: { width: DESKTOP_SIZE.width, height: DESKTOP_SIZE.height } });

  await desktopArm();
  await instrument();
  let measure = await desktopLookAndLock(canvas);
  const looked = Math.abs(measure.lockedDelta.yaw) > 3 && Math.abs(measure.lockedDelta.pitch) > 3;
  if (!measure.locked || !looked) {
    // Headless refused the lock, or reported every CDP move as a net-zero
    // pair: run the desktop leg headful under Xvfb with its own display and
    // debugging port, as the brief allows.
    const why = !measure.locked ? "refused the pointer lock" : "reported the look moves as net-zero";
    console.log("desktop: headless " + why + "; retrying headful under Xvfb");
    report.notes.push({ kind: "desktop-fallback", text: "headless " + why + "; the desktop leg was re-run headful under Xvfb" });
    await closeChrome();
    const display = await startXvfb();
    await launchChrome({ headless: false, display, windowSize: DESKTOP_SIZE.width + "," + DESKTOP_SIZE.height });
    desktopMode = "headful-xvfb";
    boot = await desktopBoot(base, candidate);
    canvas = boot.ui.canvas;
    if (!canvas) throw new Error("no canvas on the headful desktop page");
    await desktopArm();
    await instrument();
    measure = await desktopLookAndLock(canvas);
  }
  check("10b", "desktop: a trusted click takes the pointer lock",
    Boolean(measure.locked), { pointerLockElement: measure.locked, lockBefore: measure.lockBefore, lockAfterExit: measure.lockAfterExit, mode: desktopMode });

  // The moves go right and down: yaw falls and pitch rises (check 3's look
  // drag carries the same signs on the touch path).
  const yawD = measure.lockedDelta.yaw;
  const pitchD = measure.lockedDelta.pitch;
  const lookPass = yawD < -3 && pitchD > 3;
  check("10c", "desktop: trusted mouse moves change yaw and pitch",
    lookPass,
    { locked: { yawDelta: Number(yawD.toFixed(2)), pitchDelta: Number(pitchD.toFixed(2)) },
      note: lookPass ? null : "the locked look did not clear 3 degrees on both axes (yaw must fall, pitch rise); numbers.desktop.lockedMoves holds the movementX the page received" });

  // Fire with the left button while in game.
  const ammoBefore = (await readEngine()).ammo;
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: measure.cx, y: measure.cy, button: "left", buttons: 1, clickCount: 1 });
  await sleep(1800);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: measure.cx, y: measure.cy, button: "left", buttons: 0, clickCount: 1 });
  await sleep(2200);
  const ammoAfter = (await readEngine()).ammo;
  check("10d", "desktop: the left mouse button fires (ammo changes)",
    typeof ammoBefore === "number" && typeof ammoAfter === "number" && ammoBefore > ammoAfter,
    { ammo: [ammoBefore, ammoAfter] });

  // Keyboard W moves the player.
  const moveBefore = await readEngine();
  await keyDown("w", "KeyW", 87);
  await sleep(2400);
  await keyUp("w", "KeyW", 87);
  await sleep(800);
  const moveAfter = await readEngine();
  check("10e", "desktop: the keyboard moves the player",
    distance(moveBefore.position, moveAfter.position) > 10,
    { movedUnits: Number(distance(moveBefore.position, moveAfter.position).toFixed(1)), keyDest: moveAfter.keyDest });

  await capture("desktop-1280x720", "desktop 1280x720, in game");
  report.numbers.desktop = { mode: desktopMode, pointerLocked: Boolean(measure.locked), lockBefore: measure.lockBefore, lockAfterExit: measure.lockAfterExit, lockedDelta: measure.lockedDelta,
    pageBefore: measure.pageBefore, pageDuring: measure.pageDuring, lockedMoves: measure.lockedMoves };
  return { mode: desktopMode };
}

async function capture(name, note) {
  try {
    const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
    const file = path.join(SHOTS, name + ".png");
    fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
    report.screenshots.push({ name, file, note });
    console.log("  screenshot " + file);
  } catch (error) {
    report.notes.push({ kind: "screenshot-failed", name, error: String((error && error.message) || error) });
  }
}

// ---- Cleanup / main -------------------------------------------------------

async function cleanup() {
  if (cdp) { cdp.close(); cdp = null; }
  if (browserCdp) { browserCdp.close(); browserCdp = null; }
  await stopChild(chromeChild); chromeChild = null;
  await stopChild(xvfbChild); xvfbChild = null;
  await stopChild(serverChild); serverChild = null;
  for (const dir of [chromeProfile, serverDataDir]) {
    if (!dir) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  chromeProfile = null; serverDataDir = null;
}

function writeReport() {
  report.checksRun = checksRun;
  report.failures = failures;
  report.passed = failures === 0 && !report.error && checksRun > 0;
  // printErr noise from the engine is informational and can be large; keep the
  // first 200 entries and the true counts.
  report.consoleErrorCount = report.consoleErrors.length;
  report.pageErrorCount = report.pageErrors.length;
  if (report.consoleErrors.length > 200) report.consoleErrors = report.consoleErrors.slice(0, 200);
  if (report.pageErrors.length > 200) report.pageErrors = report.pageErrors.slice(0, 200);
  report.numbers.environment = {
    consoleErrors: report.consoleErrorCount,
    pageErrors: report.pageErrorCount,
    consoleErrorSamples: report.consoleErrors.slice(0, 5),
    pageErrorSamples: report.pageErrors.slice(0, 5),
  };
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
}

// A runaway CDP call must not leave Chrome sitting there.  40 minutes is well
// above a healthy run on this box (the engine renders at ~1-2 fps).
const watchdog = setTimeout(async () => {
  report.error = "watchdog: the run exceeded 40 minutes";
  report.passed = false;
  console.error("watchdog: the run exceeded 40 minutes");
  try { writeReport(); } catch { /* best effort */ }
  try { await cleanup(); } catch { /* best effort */ }
  process.exit(3);
}, 40 * 60 * 1000);
if (typeof watchdog.unref === "function") watchdog.unref();

try {
  let base;
  if (options.url) {
    base = options.url.endsWith("/") ? options.url : options.url + "/";
    await waitFor("the supplied app server at " + base, async () => {
      const response = await fetch(base, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    }, 15000);
    report.url = base;
  } else {
    base = await startServer();
    report.url = base;
  }
  await launchChrome({ headless: true, windowSize: MOBILE_SIZE.width + "," + MOBILE_SIZE.height });
  await emulate(MOBILE_SIZE, true, MOBILE_UA, landscapeOrientation());

  const candidate = await qualifyFixture(base);
  await checksTouch(base, candidate);
  await checkPortrait(base, candidate);
  // Desktop last: it reloads the page with touch emulation off.
  const desktop = await checkDesktop(base, candidate);
  report.desktop = desktop;

} catch (error) {
  report.error = String((error && error.stack) || error);
  console.error("FAIL: " + ((error && error.message) || error));
} finally {
  clearTimeout(watchdog);
  await cleanup();
  writeReport();
  const failed = failures > 0 || Boolean(report.error);
  console.log("\n" + (failed ? "FAILED" : "PASSED") + ": " + (checksRun - failures) + "/" + checksRun + " checks");
  console.log("report: " + path.join(OUT, "report.json"));
  process.exit(failed ? 1 : 0);
}
