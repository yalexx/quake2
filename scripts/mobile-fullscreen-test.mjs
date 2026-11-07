#!/usr/bin/env node
// scripts/mobile-fullscreen-test.mjs -- Full screen, from the menu, on a phone.
//
//   node scripts/mobile-fullscreen-test.mjs [--out DIR]
//
// The owner's HUD review moved full screen off the game picture and into the
// VIDEO view. This check boots the app in a phone-emulated headless Chrome
// (844x390, coarse pointer, touch emulation), opens the menu with the phone's
// own touch, and proves:
//
//   * nothing floats over the game picture any more -- no #fullscreen-button
//     and no #fullscreen-hint exist;
//   * the row is VIDEO's page control (.menu-page-list), at least 44 px, and
//     the page reports a document that is allowed to go full screen;
//   * a touch on the row enters full screen (document.fullscreenElement, the
//     row reading "on"), and a second touch leaves it (row reading "off");
//   * Resume still returns the game with the keyboard (key_dest 0).
//
// It starts its own server.js with a temp store and its own headless Chrome on
// free ports; the live app on 4231 and the kiosk browser on 18801 are never
// touched, and only the children this run started are stopped.
//
// Why this is its own command: the long mobile-controls run keeps one page
// alive through hundreds of gestures, and in a headless document that page
// can leave the browser's full-screen request pending (measured: the row's
// click handler ran, the request was made, and neither fullscreenchange nor a
// rejection arrived). A freshly opened document -- what a phone has when the
// player opens the app -- completes it, as this check proves. The desktop
// presentation gate enters the same row on a desktop document.
//
// Node built-ins only, no dependencies.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ARTIFACTS = process.env.CLAWBOX_RUN_ARTIFACTS_DIR || "";
const options = {
  out: ARTIFACTS ? path.join(ARTIFACTS, "mobile-fullscreen") : path.join(ROOT, "docs", "mobile-fullscreen-verification"),
};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") options.out = path.resolve(argv[++i]);
  else if (argv[i] === "--help" || argv[i] === "-h") {
    console.log("mobile-fullscreen-test.mjs [--out DIR]");
    process.exit(0);
  } else {
    console.error("unknown option: " + argv[i]);
    process.exit(2);
  }
}
fs.mkdirSync(path.join(options.out, "shots"), { recursive: true });
fs.mkdirSync(path.join(options.out, "logs"), { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const report = { at: new Date().toISOString(), checks: [], screenshots: [], consoleErrors: [], pageErrors: [], notes: [] };
let failures = 0;
function check(name, condition, detail) {
  const pass = Boolean(condition);
  if (!pass) failures += 1;
  report.checks.push({ name, pass, detail: detail === undefined ? null : detail });
  console.log((pass ? "  ok   " : "  FAIL ") + name + (detail === undefined ? "" : " -- " + JSON.stringify(detail)));
  return pass;
}
async function waitFor(label, fn, timeoutMs = 30000, intervalMs = 200) {
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

async function freePort(avoid = []) {
  for (let attempt = 0; attempt < 40; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { const chosen = server.address().port; server.close(() => resolve(chosen)); });
    });
    if (port !== 4231 && port !== 18801 && !avoid.includes(port)) return port;
  }
  throw new Error("could not find a free port away from 4231/18801");
}

function findChrome() {
  const candidates = [process.env.CHROME_PATH, "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"].filter(Boolean);
  for (const candidate of candidates) if (fs.existsSync(candidate)) return candidate;
  throw new Error("no Chrome/Chromium found (set CHROME_PATH)");
}

class Cdp {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  async open() {
    this.ws = new WebSocket(this.url);
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
  on(method, fn) { if (!this.handlers.has(method)) this.handlers.set(method, []); this.handlers.get(method).push(fn); }
  send(method, params = {}, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("CDP " + method + " timed out")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch { /* already closed */ } }
}

let serverChild = null;
let chromeChild = null;
let cdp = null;
let dataDir = null;
let profile = null;

async function main() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "q2fs-data-"));
  profile = fs.mkdtempSync(path.join(os.tmpdir(), "q2fs-chrome-"));
  const port = await freePort();
  const serverLog = fs.openSync(path.join(options.out, "logs", "server.log"), "w");
  serverChild = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), QUAKE2_DATA_DIR: dataDir },
    stdio: ["ignore", serverLog, serverLog],
  });
  const base = "http://127.0.0.1:" + port + "/apps/quake2/";
  await waitFor("the app server on port " + port, async () => {
    if (serverChild.exitCode !== null) throw new Error("server.js exited with " + serverChild.exitCode);
    const response = await fetch(base, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  }, 30000, 250);
  console.log("  server 127.0.0.1:" + port + " (temp store " + dataDir + ")");

  const chromePath = findChrome();
  const debugPort = await freePort([port]);
  const chromeLog = fs.openSync(path.join(options.out, "logs", "chrome.log"), "w");
  chromeChild = spawn(chromePath, [
    "--headless=new", "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + debugPort,
    "--user-data-dir=" + profile, "--window-size=844,390", "--hide-scrollbars",
    "--no-first-run", "--no-default-browser-check", "--disable-infobars",
    "--disable-features=Translate,MediaRouter", "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", "--disable-dev-shm-usage", "--mute-audio", "about:blank",
  ], { stdio: ["ignore", chromeLog, chromeLog] });
  const debugBase = "http://127.0.0.1:" + debugPort;
  let targets = null;
  await waitFor("headless Chrome's CDP endpoint", async () => {
    if (chromeChild.exitCode !== null) throw new Error("Chrome exited with " + chromeChild.exitCode);
    const response = await fetch(debugBase + "/json/list", { signal: AbortSignal.timeout(2000) });
    targets = await response.json();
    return targets.some((one) => one.type === "page" && one.webSocketDebuggerUrl);
  }, 30000, 250);
  const page = targets.find((one) => one.type === "page" && one.webSocketDebuggerUrl);
  cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  cdp.on("Runtime.consoleAPICalled", (params) => {
    const text = (params.args || []).map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type || "")).join(" ");
    if (params.type === "error" || params.type === "assert") report.consoleErrors.push({ type: params.type, text });
  });
  cdp.on("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails || {};
    report.pageErrors.push((details.exception && details.exception.description) || details.text || "exception");
  });

  const evaluate = async (expression, awaitPromise = false) => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "evaluation failed");
    return result.result.value;
  };
  const dump = async (expression) => {
    const value = await evaluate("JSON.stringify(" + expression + ")");
    return value === undefined ? null : JSON.parse(value);
  };

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 844, height: 390, deviceScaleFactor: 2, mobile: true,
    screenOrientation: { type: "landscapePrimary", angle: 90 } });
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await cdp.send("Emulation.setUserAgentOverride", {
    userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
    platform: "Linux armv8l",
  });
  await cdp.send("Page.navigate", { url: base + "?+set&skill&1&+map&demo1" });
  await waitFor("the touch layer over a running game", async () => {
    return evaluate("Boolean(window.quake2Touch && window.quake2Touch.state().live && window.quake2Engine && window.quake2Engine.read().keyDest === 0)");
  }, 120000, 300);
  console.log("  game live at 844x390");

  async function rect(selector) {
    return dump(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, left: box.left, top: box.top, right: box.right, bottom: box.bottom,
        w: box.width, h: box.height, display: getComputedStyle(element).display };
    })()`);
  }
  async function touch(type, points) { await cdp.send("Input.dispatchTouchEvent", { type, touchPoints: points, modifiers: 0 }); }
  let touchId = 500;
  async function tap(x, y) {
    const id = ++touchId;
    await touch("touchStart", [{ id, x: Math.round(x), y: Math.round(y), radiusX: 8, radiusY: 8, force: 1 }]);
    await sleep(70);
    await touch("touchEnd", []);
    await sleep(200);
  }
  async function screenshot(name) {
    const result = await cdp.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    const file = path.join(options.out, "shots", name);
    fs.writeFileSync(file, Buffer.from(result.data, "base64"));
    report.screenshots.push(path.relative(options.out, file));
    console.log("  shot " + path.relative(options.out, file));
  }

  // ---- The control has left the game picture ----------------------------
  const removed = await dump(`({
    button: !!document.getElementById("fullscreen-button"),
    hint: !!document.getElementById("fullscreen-hint"),
    row: (() => {
      const row = document.querySelector('#menu [data-action="fullscreen"]');
      if (!row) return null;
      const view = row.closest(".menu-view");
      const label = row.querySelector(".label");
      return { view: view ? view.dataset.view : null, pageList: !!row.closest(".menu-page-list"),
        label: label ? label.textContent.trim() : null };
    })(),
  })`);
  check("no full-screen control floats over the game any more",
    removed.button === false && removed.hint === false, removed);
  check("the Full screen row is VIDEO's page control",
    removed.row && removed.row.view === "video" && removed.row.pageList === true && removed.row.label === "full screen",
    removed.row);

  // ---- Open the menu with the phone's own input -------------------------
  const pause = await rect("#mc-pause");
  await tap(pause.x + pause.w / 2, pause.y + pause.h / 2);
  await waitFor("the menu to open from the MENU control", async () => {
    return evaluate("document.getElementById('menu-layer').hidden === false && document.body.classList.contains('menu-open')");
  }, 10000, 150);
  const video = await rect('[data-action="video"]');
  await tap(video.x + video.w / 2, video.y + video.h / 2);
  await sleep(400);
  const row = await dump(`(() => {
    const row = document.querySelector('#menu [data-action="fullscreen"]');
    row.scrollIntoView({ block: "center" });
    const box = row.getBoundingClientRect();
    return { x: box.left + box.width / 2, y: box.top + box.height / 2, w: box.width, h: box.height,
      value: document.getElementById("fullscreen-value").textContent.trim(),
      status: window.quake2Fullscreen ? window.quake2Fullscreen.status() : null };
  })()`);
  check("the Full screen row is finger-sized and the document allows full screen",
    row && row.h >= 44 && row.w >= 44 && row.status && row.status.supported === true && row.status.blocked === false,
    row);
  await screenshot("phone-video-fullscreen-row.png");

  // ---- A touch enters, a second touch leaves ----------------------------
  await tap(row.x, row.y);
  const entered = await waitFor("full screen after a touch on the row", async () => {
    const now = await dump(`({ element: Boolean(document.fullscreenElement),
      value: document.getElementById("fullscreen-value").textContent.trim(),
      status: window.quake2Fullscreen.status() })`);
    return now.element === true ? now : null;
  }, 10000, 200).catch(() => null);
  check("a touch on the row enters full screen", Boolean(entered) && entered.value === "on" && entered.status.fullscreen === true,
    entered || { element: false });
  if (entered) await screenshot("phone-fullscreen-on.png");
  const rowOn = entered ? await dump(`(() => {
    const row = document.querySelector('#menu [data-action="fullscreen"]');
    row.scrollIntoView({ block: "center" });
    const b = row.getBoundingClientRect();
    return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
  })()`) : row;
  await tap(rowOn.x, rowOn.y);
  const left = await waitFor("full screen to end after a second touch", async () => {
    const now = await dump(`({ element: Boolean(document.fullscreenElement),
      value: document.getElementById("fullscreen-value").textContent.trim() })`);
    return now.element === false && now.value === "off" ? now : null;
  }, 10000, 200).catch(() => null);
  check("a second touch on the row leaves full screen", Boolean(left), left || { element: true });

  // ---- Resume still returns the game -----------------------------------
  const resume = await rect('.menu-foot [data-action="resume"]');
  await tap(resume.x + resume.w / 2, resume.y + resume.h / 2);
  const playing = await waitFor("the game after Resume", async () => {
    return evaluate("window.quake2Engine.read().keyDest === 0");
  }, 10000, 200).catch(() => false);
  check("Resume returns the game with the keyboard", playing === true, { keyDest: await evaluate("window.quake2Engine.read().keyDest") });
  check("no console errors", report.consoleErrors.length === 0, report.consoleErrors.slice(0, 4));
  check("no uncaught page exceptions", report.pageErrors.length === 0, report.pageErrors.slice(0, 4));
}

async function stopChild(child) {
  if (!child) return;
  try { child.kill("SIGTERM"); } catch { /* gone */ }
  await new Promise((resolve) => {
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* gone */ } resolve(); }, 4000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

let code = 0;
try {
  await main();
  code = failures ? 1 : 0;
} catch (error) {
  failures += 1;
  report.error = String((error && error.stack) || error);
  console.error("FAIL: " + (error && error.message ? error.message : error));
  code = 1;
} finally {
  if (cdp) cdp.close();
  await stopChild(chromeChild);
  await stopChild(serverChild);
  for (const dir of [dataDir, profile]) {
    if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
  report.passed = failures === 0;
  fs.writeFileSync(path.join(options.out, "report.json"), JSON.stringify(report, null, 2));
  console.log("\n" + (failures ? "FAILED" : "PASSED") + ": " + (report.checks.length - failures) + "/" + report.checks.length +
    " checks, " + report.screenshots.length + " screenshot(s)");
  console.log("report: " + path.join(options.out, "report.json"));
  process.exit(code);
}
