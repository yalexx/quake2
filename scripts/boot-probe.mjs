#!/usr/bin/env node
// scripts/boot-probe.mjs -- what the player lands on, measured at the frame.
//
// The app boots straight into a level with a chain of `+set` commands on the
// engine's start-up line. The engine is free to treat a command line as a
// command *session*, and in the past it did: the level started with the
// engine's own console up, so the first thing the player saw was a wall of
// text and a paused game. The cvars have to keep applying (they are the app's
// defaults) and the level has to keep starting, so the fix is not to drop the
// start-up line but to make sure the keyboard is the game's on the first frame.
//
// This probe answers that with numbers rather than a screenshot:
//
//   (a) on the first engine frame, consoleOpen === false and keyDest is "game"
//   (b) after 5 s, still consoleOpen === false and keyDest "game"
//   (c) document.fullscreenElement is null after load
//   (d) it is still null after the first click on the game canvas
//   (e) no full-screen control floats over the game; the VIDEO menu's
//       `full screen` row enters full screen (or offers the app's own window
//       where the browser refuses) and Esc leaves it
//
// plus the start-up line itself: every cvar the app passes is still on it and
// the level still starts (the engine reports a running level, not a menu).
//
//   node scripts/boot-probe.mjs
//   node scripts/boot-probe.mjs --url http://127.0.0.1:PORT/apps/quake2/ --out DIR
//
// It starts this checkout's own server on a free port (never the live 4231)
// and its own headless Chromium on a free debugging port (never the live
// 18801 or 9222), and kills every child it started in `finally`. Node
// built-ins only; no dependencies.
"use strict";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = process.env.CLAWBOX_RUN_ARTIFACTS_DIR || "";
const DEFAULT_OUT = ARTIFACTS ? path.join(ARTIFACTS, "boot-probe") : path.join(ROOT, "docs", "boot-probe");

const LIVE_PORTS = new Set([4231, 18801, 9222]);

const options = { url: "", out: DEFAULT_OUT, map: "demo1", settleMs: 5000, query: "" };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--url") options.url = argv[++i];
  else if (argv[i] === "--out") options.out = path.resolve(argv[++i]);
  else if (argv[i] === "--map") options.map = argv[++i];
  else if (argv[i] === "--settle-ms") options.settleMs = Number(argv[++i]);
  else if (argv[i] === "--query") options.query = argv[++i].replace(/^\?/, "");
  else if (argv[i] === "--help" || argv[i] === "-h") {
    console.log("boot-probe.mjs [--url URL] [--out DIR] [--map NAME] [--settle-ms N] [--query ARGS]");
    process.exit(0);
  } else {
    console.error("unknown option: " + argv[i]);
    process.exit(2);
  }
}

const OUT = options.out;
const LOGS = path.join(OUT, "logs");
fs.mkdirSync(LOGS, { recursive: true });

const report = {
  at: new Date().toISOString(),
  checkout: ROOT,
  node: process.version,
  url: options.url || null,
  map: options.map,
  settleMs: options.settleMs,
  server: null,
  chrome: null,
  checks: [],
  measurements: {},
  notes: [],
};

let failures = 0;
let checks = 0;
function check(name, condition, detail) {
  checks++;
  const pass = Boolean(condition);
  if (!pass) failures++;
  report.checks.push({ name, pass, detail: detail === undefined ? null : detail, at: new Date().toISOString() });
  console.log((pass ? "  PASS " : "  FAIL ") + name + (detail === undefined ? "" : " -- " + JSON.stringify(detail)));
  return pass;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Children: one list, killed by PID in `finally` -----------------------

const children = [];

function track(child, label) {
  children.push({ child, label, pid: child.pid });
  return child;
}

async function killChildren() {
  // Stop Chrome before the server: a renderer mid-load is the longest-lived
  // thing here, and it holds the CDP socket a later run would reuse.
  for (const entry of children.slice().reverse()) {
    const child = entry.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) continue;
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (children.every((entry) => !entry.child || entry.child.exitCode !== null || entry.child.signalCode !== null)) break;
    await sleep(100);
  }
  for (const entry of children) {
    const child = entry.child;
    if (!child || child.exitCode !== null || child.signalCode !== null) continue;
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
  for (const entry of children) {
    if (!entry.pid) continue;
    // A wrapper may leave nothing behind; the PID is the contract.
    report.notes.push("stopped " + entry.label + " (pid " + entry.pid + ")");
  }
}

// ---- Free ports, never the live ones --------------------------------------

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
    if (!LIVE_PORTS.has(port)) return port;
  }
  throw new Error("could not find a free port away from the live services");
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

// ---- Server --------------------------------------------------------------

let serverDataDir = null;

async function startServer() {
  const port = await freePort();
  serverDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "q2boot-data-"));
  const log = fs.openSync(path.join(LOGS, "server.log"), "w");
  const child = track(spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), QUAKE2_DATA_DIR: serverDataDir },
    stdio: ["ignore", log, log],
  }), "server.js");
  const base = "http://127.0.0.1:" + port + "/apps/quake2/";
  await waitFor("the app server on port " + port, async () => {
    if (child.exitCode !== null) throw new Error("server.js exited with " + child.exitCode);
    const response = await fetch(base, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  }, 30000, 250);
  report.server = { port, pid: child.pid, dataDir: serverDataDir, log: path.join(LOGS, "server.log") };
  if (LIVE_PORTS.has(port)) throw new Error("server landed on a live port");
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

let chromeProfile = null;
let cdp = null;

async function startChrome() {
  const chromePath = findChrome();
  const debuggingPort = await freePort();
  if (LIVE_PORTS.has(debuggingPort)) throw new Error("debugging port collided with a live service");
  chromeProfile = fs.mkdtempSync(path.join(os.tmpdir(), "q2boot-chrome-"));
  const log = fs.openSync(path.join(LOGS, "chrome.log"), "w");
  const child = track(spawn(chromePath, [
    "--headless=new",
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=" + debuggingPort,
    "--user-data-dir=" + chromeProfile,
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
  ], { stdio: ["ignore", log, log] }), "chromium");
  const base = "http://127.0.0.1:" + debuggingPort;
  await waitFor("headless Chrome's CDP endpoint", async () => {
    if (child.exitCode !== null) throw new Error("Chrome exited with " + child.exitCode);
    const response = await fetch(base + "/json/version", { signal: AbortSignal.timeout(2000) });
    return response.ok;
  }, 30000, 250);
  report.chrome = { path: chromePath, debuggingPort, headless: true, profile: chromeProfile };
  if (LIVE_PORTS.has(debuggingPort)) throw new Error("chrome landed on a live debugging port");
  const targets = await (await fetch(base + "/json/list")).json();
  const page = targets.find((one) => one.type === "page" && one.webSocketDebuggerUrl);
  if (!page) throw new Error("headless Chrome has no page target to drive");
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  cdp.on("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails || {};
    report.notes.push("page error: " + (details.exception && details.exception.description ? details.exception.description : details.text));
  });
  cdp.on("Log.entryAdded", (params) => {
    const entry = params.entry || {};
    if (entry.level === "error" && !/pak[12]\.pak/.test(entry.url || entry.text || "")) {
      report.notes.push("log error: " + (entry.text || "").slice(0, 300));
    }
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

// ---- The page-side frame observer ----------------------------------------
//
// The engine's first frame is the moment that matters, and a page-side timer
// cannot see it: a busy boot starves setInterval (engine-state.js measured a
// console up for ten frames that a 100 ms timer never saw). app.js therefore
// leaves its own `window.quake2BootFrame` record for the probe. This injected
// observer is the independent second opinion -- installed before any page
// script runs, it samples cls.key_dest once per animation frame from the
// moment window.quake2Engine exists, and keeps a change log -- and it is also
// what makes the probe runnable against a page that predates the record.
const OBSERVER = `(() => {
  if (window.__q2BootObservation) return;
  var rec = {
    startedAt: Math.round(performance.now()),
    frames: 0,
    readableFrames: 0,
    firstReadable: null,
    lastDest: null,
    changes: [],
    counts: { game: 0, console: 0, menu: 0, other: 0 },
    engineStartedAt: null
  };
  window.__q2BootObservation = rec;
  function canvasState() {
    var canvas = document.getElementById("canvas");
    return canvas ? getComputedStyle(canvas).display : null;
  }
  function tick() {
    rec.frames++;
    var dest = null;
    try {
      var engine = window.quake2Engine;
      if (engine && typeof engine.keyDest === "function") dest = engine.keyDest();
    } catch (error) { dest = null; }
    if (typeof dest === "number") {
      if (rec.engineStartedAt === null) rec.engineStartedAt = Math.round(performance.now());
      rec.readableFrames++;
      if (dest === 0) rec.counts.game++;
      else if (dest === 1) rec.counts.console++;
      else if (dest === 3) rec.counts.menu++;
      else rec.counts.other++;
      var at = Math.round(performance.now());
      if (rec.firstReadable === null) {
        rec.firstReadable = { keyDest: dest, at: at, frame: rec.frames, canvas: canvasState(), readyState: document.readyState };
      }
      if (rec.lastDest !== dest) {
        rec.changes.push({ keyDest: dest, at: at, frame: rec.frames, canvas: canvasState(), readyState: document.readyState });
        rec.lastDest = dest;
      }
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();`;

// ---- Input ---------------------------------------------------------------

async function mouseClick(x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, button: "none", buttons: 0 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 });
  await sleep(40);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 });
}

async function pressEscape() {
  await cdp.send("Input.dispatchKeyEvent", {
    type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
  await sleep(30);
  await cdp.send("Input.dispatchKeyEvent", {
    type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27,
  });
}

async function rect(selector) {
  return dumpJson(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return null;
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      x: box.x, y: box.y, w: box.width, h: box.height,
      left: box.left, top: box.top, right: box.right, bottom: box.bottom,
      display: style.display, visibility: style.visibility, hidden: element.hidden,
    };
  })()`);
}

async function screenshot(name) {
  const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = path.join(OUT, name);
  fs.writeFileSync(file, Buffer.from(result.data, "base64"));
  report.notes.push("screenshot " + path.relative(OUT, file));
  return file;
}

// ---- Page readings -------------------------------------------------------

function readBootRecord() {
  return dumpJson(`(() => {
    const record = window.quake2BootFrame || null;
    const observation = window.__q2BootObservation || null;
    return {
      record: record ? {
        keyDest: typeof record.keyDest === "number" ? record.keyDest : null,
        consoleOpen: record.consoleOpen === true,
        at: typeof record.at === "number" ? record.at : null,
        frames: record.frames === undefined ? null : record.frames,
        consoleFrames: record.consoleFrames === undefined ? null : record.consoleFrames,
        closedConsole: record.closedConsole === true,
      } : null,
      source: window.quake2BootFrame ? "page-record" : "frame-observer",
      observation: observation ? {
        frames: observation.frames,
        readableFrames: observation.readableFrames,
        firstReadable: observation.firstReadable,
        lastDest: observation.lastDest,
        changes: observation.changes.slice(0, 40),
        counts: observation.counts,
      } : null,
    };
  })()`);
}

function readLive() {
  return dumpJson(`(() => {
    const canvas = document.getElementById("canvas");
    // Full screen is VIDEO's page-control row now (the owner's HUD review);
    // the floating button and its hint are checked for absence.
    const button = document.querySelector('#menu [data-action="fullscreen"]');
    const value = document.getElementById("fullscreen-value");
    const floating = ["fullscreen-button", "fullscreen-hint"].filter((id) => document.getElementById(id));
    let engine = null;
    try {
      const api = window.quake2Engine;
      if (api && typeof api.read === "function") engine = api.read();
      else if (api && typeof api.keyDest === "function") {
        const dest = api.keyDest();
        engine = dest === null ? null : { keyDest: dest, consoleOpen: dest === 1, inGame: dest === 0 };
      }
    } catch (error) { engine = null; }
    return {
      engine: engine ? {
        ok: engine.ok === undefined ? null : engine.ok,
        keyDest: engine.keyDest === undefined ? null : engine.keyDest,
        keyDestName: engine.keyDestName === undefined ? null : engine.keyDestName,
        consoleOpen: engine.consoleOpen === true,
        inGame: engine.inGame === true,
        position: engine.position || null,
      } : null,
      canvasDisplay: canvas ? getComputedStyle(canvas).display : null,
      fullscreenElement: document.fullscreenElement !== null,
      fullscreenEnabled: typeof document.fullscreenEnabled === "boolean" ? document.fullscreenEnabled : null,
      pointerLocked: document.pointerLockElement !== null,
      button: button ? {
        hidden: button.hidden,
        display: getComputedStyle(button).display,
        ariaPressed: button.getAttribute("aria-pressed"),
        ariaLabel: button.getAttribute("aria-label"),
        title: button.getAttribute("title"),
        classes: button.className,
        value: value ? value.textContent.trim() : null,
      } : null,
      floating,
      menuOpen: document.body.classList.contains("menu-open"),
      startupArguments: Array.isArray(window.quake2StartupArguments) ? window.quake2StartupArguments : null,
      entityCount: (() => {
        try {
          const api = window.quake2Engine;
          return api && typeof api.entities === "function" ? (api.entities() || []).length : null;
        } catch (error) { return null; }
      })(),
      readyState: document.readyState,
    };
  })()`);
}

// ---- The start-up line this app must keep --------------------------------
//
// Every pair is the app's own default (app.js buildArguments). Dropping any of
// them to quiet the console would be a different bug; the probe pins them.
const EXPECTED_SETS = [
  ["vid_renderer", "gles3"],
  ["r_retexturing", "1"],
  ["gl3_usefbo", "1"],
  ["cl_gun", "1"],
  ["fov", "90"],
  ["crosshair", "1"],
  ["crosshair_scale", "3"],
  ["q2_crosshair_alpha", "0.45"],
  ["q2_crosshair_tint", "ddb589"],
];

function setArguments(args) {
  const pairs = [];
  if (!Array.isArray(args)) return pairs;
  for (let i = 0; i + 2 < args.length + 1; i++) {
    if (args[i] === "+set" && i + 2 < args.length) {
      pairs.push([args[i + 1], args[i + 2]]);
      i += 2;
    }
  }
  return pairs;
}

function mapArgument(args) {
  if (!Array.isArray(args)) return null;
  const at = args.indexOf("+map");
  return at >= 0 && at + 1 < args.length ? args[at + 1] : null;
}

// ---- The run -------------------------------------------------------------

async function run() {
  let baseUrl = options.url;
  if (!baseUrl) baseUrl = await startServer();
  report.url = baseUrl;
  await startChrome();
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: OBSERVER });

  const targetUrl = options.query ? baseUrl + (baseUrl.includes("?") ? "&" : "?") + options.query : baseUrl;
  console.log("booting " + targetUrl + " (map " + options.map + ")");
  await cdp.send("Page.navigate", { url: targetUrl });
  const bootStartedAt = Date.now();

  // The page's own record is the authority: app.js writes it from inside the
  // engine's frame loop on the first frame the game surface is up. The
  // injected observer is the independent second opinion (and the fallback for
  // a page that predates the record).
  const boot = await waitFor("the page's first-frame record", async () => {
    const now = await readBootRecord();
    return now.record ? now : null;
  }, 120000, 100).catch(() => readBootRecord());

  const firstFrame = boot.record
    ? {
      keyDest: boot.record.keyDest,
      consoleOpen: boot.record.consoleOpen,
      at: boot.record.at,
      frames: boot.record.frames,
      consoleFrames: boot.record.consoleFrames,
      closedConsole: boot.record.closedConsole,
      source: "window.quake2BootFrame",
    }
    : {
      keyDest: boot.observation && boot.observation.firstReadable ? boot.observation.firstReadable.keyDest : null,
      consoleOpen: boot.observation && boot.observation.firstReadable ? boot.observation.firstReadable.keyDest === 1 : null,
      at: boot.observation && boot.observation.firstReadable ? boot.observation.firstReadable.at : null,
      source: "injected frame observer (the page left no record)",
    };
  report.measurements.firstFrame = firstFrame;
  report.measurements.observation = boot.observation;

  console.log("first engine frame: keyDest=" + String(firstFrame.keyDest) + " consoleOpen=" + firstFrame.consoleOpen +
    " at " + String(firstFrame.at) + " ms (" + firstFrame.source + ")");

  check("the page left a first-frame record (window.quake2BootFrame)",
    firstFrame.source === "window.quake2BootFrame", { source: firstFrame.source });
  check("(a) first engine frame: consoleOpen is false", firstFrame.consoleOpen === false,
    { consoleOpen: firstFrame.consoleOpen, keyDest: firstFrame.keyDest, source: firstFrame.source });
  check("(a) first engine frame: keyDest is the game (0)", firstFrame.keyDest === 0,
    { keyDest: firstFrame.keyDest, source: firstFrame.source });

  // Wait for the level itself, so the 5 s window is measured while the player
  // is really in the game rather than while a loading plaque is up.
  const inGame = await waitFor("the in-game state", async () => {
    const now = await readLive();
    if (now.engine && now.engine.keyDest === 0 && now.canvasDisplay === "block" && now.engine.position &&
        (now.engine.position.x !== 0 || now.engine.position.y !== 0)) return now;
    return null;
  }, 180000, 250);
  const landedAt = Date.now();
  report.measurements.inGame = { afterMs: landedAt - bootStartedAt, engine: inGame.engine, canvasDisplay: inGame.canvasDisplay };

  // ---- (b) five seconds later -------------------------------------------
  await sleep(options.settleMs);
  const settled = await readLive();
  report.measurements.afterSettleMs = Date.now() - landedAt;
  report.measurements.settled = {
    keyDest: settled.engine ? settled.engine.keyDest : null,
    keyDestName: settled.engine ? settled.engine.keyDestName : null,
    consoleOpen: settled.engine ? settled.engine.consoleOpen : null,
    position: settled.engine ? settled.engine.position : null,
    fullscreenElement: settled.fullscreenElement,
  };
  const observation = await readBootRecord();
  report.measurements.observationAfterSettle = observation.observation;
  console.log("after " + options.settleMs + " ms in game: keyDest=" + String(settled.engine && settled.engine.keyDest) +
    " consoleOpen=" + String(settled.engine && settled.engine.consoleOpen));

  check("(b) after " + options.settleMs + " ms: consoleOpen is false",
    settled.engine !== null && settled.engine.consoleOpen === false,
    settled.engine ? { consoleOpen: settled.engine.consoleOpen, keyDest: settled.engine.keyDest, keyName: settled.engine.keyDestName } : null);
  check("(b) after " + options.settleMs + " ms: keyDest is the game (0)",
    settled.engine !== null && settled.engine.keyDest === 0,
    settled.engine ? { keyDest: settled.engine.keyDest, keyName: settled.engine.keyDestName } : null);
  const counts = observation.observation && observation.observation.counts;
  check("no frame in the observed boot ever had the console up",
    counts && counts.console === 0,
    counts || null);

  // ---- The start-up line and the level ----------------------------------
  const startup = settled.startupArguments;
  const pairs = setArguments(startup);
  const missing = EXPECTED_SETS.filter(([cvar, value]) => !pairs.some(([name, got]) => name === cvar && got === value));
  report.measurements.startup = { arguments: startup, sets: pairs, map: mapArgument(startup) };
  check("every +set cvar of the app's start-up line is still passed with its value",
    Array.isArray(startup) && missing.length === 0, { missing });
  check("the level still starts (" + options.map + " on the start-up line)",
    mapArgument(startup) === options.map, { map: mapArgument(startup) });
  check("the level is running, not a menu: entities are being sent", typeof settled.entityCount === "number" && settled.entityCount >= 5,
    { entityCount: settled.entityCount });

  // ---- (c) no fullscreen after load -------------------------------------
  check("(c) document.fullscreenElement is null after load", settled.fullscreenElement === false,
    { fullscreenElement: settled.fullscreenElement, fullscreenEnabled: settled.fullscreenEnabled });
  await screenshot("01-landed.png");

  // ---- (e) the full-screen row -----------------------------------------
  // Measured before the canvas is clicked: a click on the game locks the
  // pointer, and a locked pointer is not how a player would reach a page
  // control either. Full screen lives in VIDEO's page-control list (the
  // owner's HUD review: nothing floats over the game), so the menu is opened
  // the way a player does it (Esc), the row is clicked, and Resume puts the
  // game back before (d) clicks the canvas.
  const beforeButton = await readLive();
  check("(e) no full-screen control floats over the game", beforeButton.floating.length === 0 && Boolean(beforeButton.button),
    { floating: beforeButton.floating, row: beforeButton.button });
  await pressEscape();
  await waitFor("the page menu after Esc", async () => (await readLive()).menuOpen === true, 15000, 200);
  const videoEntry = await rect('.menu-view[data-view="main"] [data-action="video"]');
  if (!videoEntry || videoEntry.w < 1) throw new Error("the VIDEO entry is not in the menu");
  await mouseClick(videoEntry.left + videoEntry.w / 2, videoEntry.top + videoEntry.h / 2);
  await sleep(400);
  await evaluate(`(() => { const row = document.querySelector('#menu [data-action="fullscreen"]'); if (row) row.scrollIntoView({ block: "center" }); return true; })()`);
  await sleep(300);
  const button = await rect('#menu [data-action="fullscreen"]');
  if (!button || button.w < 1 || button.h < 1) throw new Error("the full-screen row is not in the VIDEO view");
  report.measurements.beforeButton = { button, row: beforeButton.button, fullscreenElement: beforeButton.fullscreenElement };
  await mouseClick(button.left + button.w / 2, button.top + button.h / 2);

  let entered = null;
  for (let i = 0; i < 40; i++) {
    entered = await readLive();
    if (entered.fullscreenElement) break;
    if (entered.button && entered.button.value === "own window") break;
    await sleep(150);
  }
  const ownWindow = Boolean(entered && entered.button && entered.button.value === "own window");
  report.measurements.afterButton = {
    fullscreenElement: entered ? entered.fullscreenElement : null,
    fullscreenEnabled: entered ? entered.fullscreenEnabled : null,
    ownWindow,
    button: entered ? entered.button : null,
  };
  check("(e) the VIDEO full-screen row either enters fullscreen or offers the app's own window",
    Boolean(entered && (entered.fullscreenElement === true || ownWindow)),
    { fullscreenElement: entered ? entered.fullscreenElement : null, ownWindow, row: entered ? entered.button : null });
  if (entered && entered.fullscreenElement) {
    check("(e) the row's aria-pressed and value follow the fullscreen state",
      entered.button && entered.button.ariaPressed === "true" && entered.button.value === "on", entered.button);
    await screenshot("02-fullscreen-by-button.png");
    // Esc is the browser's own way out (full screen is a user-agent mode, so
    // the page cannot close it from script without this key).
    await pressEscape();
    let left = null;
    for (let i = 0; i < 40; i++) {
      left = await readLive();
      if (!left.fullscreenElement) break;
      await sleep(150);
    }
    // `fullscreenchange` reaches the page a moment after the element is gone;
    // give the row's own handler the frame it needs before reading it.
    await sleep(400);
    left = await readLive();
    report.measurements.afterEscape = { fullscreenElement: left ? left.fullscreenElement : null, button: left ? left.button : null };
    check("(e) Esc leaves fullscreen", Boolean(left && left.fullscreenElement === false),
      { fullscreenElement: left ? left.fullscreenElement : null });
    check("(e) the row's aria-pressed and value follow Esc",
      left && left.button && left.button.ariaPressed === "false" && left.button.value === "off", left ? left.button : null);
    await screenshot("03-after-escape.png");
  } else {
    // The blocked path: this document can never go fullscreen, so Esc has
    // nothing to leave, and the row must already point at the own-window
    // route rather than promise a click will fix it.
    check("(e) Esc leaves fullscreen (nothing was entered to leave)",
      Boolean(entered && entered.fullscreenElement === false), { fullscreenElement: entered ? entered.fullscreenElement : null });
  }
  // Back to the game before the canvas checks: Resume, if the menu is still
  // up (the browser's Esc out of full screen does not reach the page).
  if ((await readLive()).menuOpen) {
    const resume = await rect('.menu-foot [data-action="resume"]');
    if (resume && resume.w > 0) await mouseClick(resume.left + resume.w / 2, resume.top + resume.h / 2);
  }
  await waitFor("the game after Resume", async () => {
    const live = await readLive();
    return live.menuOpen === false && live.engine && live.engine.keyDest === 0;
  }, 15000, 200);

  // ---- (d) no fullscreen after the first canvas click -------------------
  const canvas = await rect("#canvas");
  if (!canvas || canvas.w < 2) throw new Error("the game canvas is not on the page");
  const canvasPoint = { x: canvas.left + canvas.w / 2, y: canvas.top + canvas.h / 2 };
  await mouseClick(canvasPoint.x, canvasPoint.y);
  // A request inside a gesture resolves asynchronously; give it a generous
  // window so a hidden automatic request cannot slip past the check.
  const clickWaitMs = 3000;
  let afterClick = null;
  for (let waited = 0; waited <= clickWaitMs; waited += 150) {
    afterClick = await readLive();
    if (afterClick.fullscreenElement) break;
    if (waited < clickWaitMs) await sleep(150);
  }
  report.measurements.afterFirstClick = {
    fullscreenElement: afterClick.fullscreenElement,
    pointerLocked: afterClick.pointerLocked,
    clickedAt: canvasPoint,
  };
  check("(d) document.fullscreenElement is still null " + clickWaitMs + " ms after the first canvas click",
    afterClick.fullscreenElement === false, { fullscreenElement: afterClick.fullscreenElement });
  await screenshot("04-after-canvas-click.png");

  // No automatic request may still be waiting for a gesture: a second click
  // on the canvas must not take the screen either.
  await mouseClick(canvasPoint.x, canvasPoint.y);
  await sleep(1200);
  const secondClick = await readLive();
  check("a second canvas click does not take the screen either (no armed gesture request)",
    Boolean(secondClick.fullscreenElement === false),
    { after: secondClick.fullscreenElement, pointerLocked: secondClick.pointerLocked });
  await screenshot("05-after-second-click.png");

  // ---- The record -------------------------------------------------------
  fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
}

async function main() {
  try {
    await run();
  } catch (error) {
    failures++;
    report.error = error && error.stack ? error.stack : String(error);
    console.log("  FAIL the probe could not finish -- " + (error && error.message ? error.message : error));
  } finally {
    try { if (cdp) cdp.close(); } catch { /* already closed */ }
    await killChildren();
    fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
    if (serverDataDir) { try { fs.rmSync(serverDataDir, { recursive: true, force: true }); } catch { /* best effort */ } }
    if (chromeProfile) { try { fs.rmSync(chromeProfile, { recursive: true, force: true }); } catch { /* best effort */ } }
    console.log("");
    if (failures) console.log(failures + " check(s) FAILED of " + checks + " run -- report in " + path.relative(ROOT, OUT));
    else console.log("all " + checks + " checks passed -- report in " + path.relative(ROOT, OUT));
    process.exitCode = failures ? 1 : 0;
  }
}

main();
