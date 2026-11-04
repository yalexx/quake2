#!/usr/bin/env node
// scripts/app-harness.mjs -- the local harness the release checks share.
//
// It starts everything the checks need and nothing on the live box:
//   * `node server.js` on a free port, with QUAKE2_DATA_DIR in a fresh temp
//     folder, so the owner's userdata/ and saves are never read or written;
//   * a small proxy in front of it that adds the box's
//     `Content-Security-Policy: sandbox allow-scripts allow-pointer-lock` to
//     HTML, so the page runs with an opaque origin exactly as it does on the
//     device (localStorage throws, every fetch is a CORS request);
//   * headless Chromium on a free debugging port, with its own throwaway
//     profile.
//
// Ports 4231 (the live quake2-app.service) and 18801 (the kiosk browser) are
// never used, and the only processes stopped are the ones this class started.
//
// Zero dependencies. Node's built-in WebSocket speaks CDP.
//
//   import { Harness } from "./app-harness.mjs";
//   const app = new Harness({ name: "my-check" });
//   await app.start();
//   try { await app.open(); ... } finally { await app.stop(); }

import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const LIVE_PORT = 4231; // the live service: never used here
export const LIVE_CDP_PORT = 18801; // the kiosk browser: never used here
export const APP_PATH = "/apps/quake2/";
export const BOX_CSP = "sandbox allow-scripts allow-pointer-lock";
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function findChrome() {
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

export function freePort(avoid = []) {
  const banned = new Set([LIVE_PORT, LIVE_CDP_PORT, ...avoid]);
  return new Promise((resolve, reject) => {
    const tryOne = () => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const port = server.address().port;
        server.close(() => (banned.has(port) ? tryOne() : resolve(port)));
      });
    };
    tryOne();
  });
}

export async function waitFor(fn, timeoutMs, what, intervalMs = 250) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
      last = value;
    } catch (error) {
      last = error.message;
    }
    await sleep(intervalMs);
  }
  throw new Error(what + " did not happen within " + timeoutMs + " ms (last: " + JSON.stringify(last) + ")");
}

// ---- CDP -------------------------------------------------------------------

export class Cdp {
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
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
      } catch {
        return;
      }
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

// ---- The harness -----------------------------------------------------------

const HOP_HEADERS = new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailers", "transfer-encoding", "upgrade"]);
function withoutHopHeaders(headers) {
  const copy = { ...headers };
  for (const name of HOP_HEADERS) delete copy[name];
  return copy;
}

export class Harness {
  constructor({ name = "q2-check", appPath = APP_PATH } = {}) {
    this.name = name;
    this.appPath = appPath;
    this.children = [];
    this.proxy = null;
    this.cdp = null;
    this.consoleErrors = [];
    this.pageErrors = [];
    this.logs = [];
  }

  // server.js with a temp store. Resolves once it answers.
  async startServer() {
    this.dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), this.name + "-data-"));
    const realStore = path.join(ROOT, "userdata");
    if (this.dataDir === realStore || this.dataDir.startsWith(realStore + path.sep)) {
      throw new Error("the temp store overlaps the real userdata/");
    }
    this.serverPort = await freePort();
    const logPath = path.join(this.dataDir, "server.log");
    const out = fs.openSync(logPath, "a");
    const child = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(this.serverPort), QUAKE2_DATA_DIR: this.dataDir },
      stdio: ["ignore", out, out],
    });
    this.children.push(child);
    this.serverLog = logPath;
    await waitFor(async () => {
      try {
        const response = await fetch("http://127.0.0.1:" + this.serverPort + this.appPath);
        return response.ok;
      } catch {
        return false;
      }
    }, 30000, "server.js on port " + this.serverPort, 150);
    return this.serverPort;
  }

  async startProxy() {
    this.proxyPort = await freePort([this.serverPort]);
    this.proxy = http.createServer((req, res) => {
      const upstream = http.request({
        host: "127.0.0.1",
        port: this.serverPort,
        method: req.method,
        path: req.url,
        headers: { ...withoutHopHeaders(req.headers), host: "127.0.0.1:" + this.serverPort, connection: "close" },
        agent: false,
      }, (answer) => {
        const headers = withoutHopHeaders(answer.headers);
        if (/^text\/html\b/i.test(headers["content-type"] || "")) headers["content-security-policy"] = BOX_CSP;
        res.writeHead(answer.statusCode, answer.statusMessage, headers);
        answer.pipe(res);
      });
      upstream.on("error", (error) => {
        if (res.headersSent) res.destroy();
        else if (!res.destroyed) {
          res.writeHead(502, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" }).end(String(error.message));
        }
      });
      res.on("close", () => upstream.destroy());
      req.pipe(upstream);
    });
    await new Promise((resolve, reject) => {
      this.proxy.once("error", reject);
      this.proxy.listen(this.proxyPort, "127.0.0.1", resolve);
    });
    return this.proxyPort;
  }

  async startChrome() {
    const chrome = findChrome();
    this.cdpPort = await freePort([this.serverPort, this.proxyPort]);
    this.profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), this.name + "-chrome-"));
    const args = [
      "--headless=new", "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader", "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=" + this.cdpPort, "--user-data-dir=" + this.profileDir,
      "--window-size=1280,720", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
      "--disable-infobars", "--disable-features=Translate,MediaRouter",
      "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
      "--disable-dev-shm-usage", "--mute-audio", "about:blank",
    ];
    const logPath = path.join(this.dataDir, "chrome.log");
    const out = fs.openSync(logPath, "a");
    const child = spawn(chrome, args, { stdio: ["ignore", out, out] });
    this.children.push(child);
    this.chromeLog = logPath;
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error("Chrome exited with code " + child.exitCode);
      try {
        const response = await fetch("http://127.0.0.1:" + this.cdpPort + "/json/version", { signal: AbortSignal.timeout(2000) });
        return response.ok;
      } catch {
        return false;
      }
    }, 30000, "headless Chrome", 250);
  }

  async connect() {
    const targets = await (await fetch("http://127.0.0.1:" + this.cdpPort + "/json/list")).json();
    const page = targets.find((one) => one.type === "page" && one.webSocketDebuggerUrl);
    if (!page) throw new Error("headless Chrome has no page target");
    this.cdp = new Cdp(page.webSocketDebuggerUrl);
    await this.cdp.open();
    this.cdp.on("Runtime.consoleAPICalled", (params) => {
      const text = (params.args || []).map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || arg.type || "")).join(" ");
      this.logs.push({ type: params.type, text });
      if (params.type === "error") this.consoleErrors.push(text);
    });
    this.cdp.on("Runtime.exceptionThrown", (params) => {
      const details = params.exceptionDetails || {};
      this.pageErrors.push((details.exception && details.exception.description) || details.text || "exception");
    });
    this.cdp.on("Log.entryAdded", (params) => {
      const entry = params.entry || {};
      if (entry.level === "error" && !/Failed to load resource.*404/i.test(entry.text || "")) {
        this.consoleErrors.push(entry.text || "log error");
      }
    });
    await this.cdp.send("Page.enable");
    await this.cdp.send("Runtime.enable");
    await this.cdp.send("Log.enable");
    await this.cdp.send("Performance.enable");
    await this.cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `window.__q2check = { frames: 0, frameTimes: [], longTasks: [], at: 0 };
        (function () {
          var last = 0;
          function step(t) {
            window.__q2check.frames++;
            if (last) { window.__q2check.frameTimes.push(t - last); if (window.__q2check.frameTimes.length > 900) window.__q2check.frameTimes.shift(); }
            last = t;
            requestAnimationFrame(step);
          }
          requestAnimationFrame(step);
        })();
        try {
          new PerformanceObserver(function (list) {
            for (var i = 0; i < list.getEntries().length; i++) window.__q2check.longTasks.push(list.getEntries()[i].duration);
          }).observe({ entryTypes: ["longtask"] });
        } catch (error) { /* not every Chromium has longtask */ }`,
    });
  }

  async start() {
    await this.startServer();
    await this.startProxy();
    await this.startChrome();
    await this.connect();
    return this;
  }

  url(extraQuery = "") {
    return "http://127.0.0.1:" + this.proxyPort + this.appPath + (extraQuery ? "?" + extraQuery : "");
  }

  async evaluate(expression, awaitPromise = false, timeoutMs = 60000) {
    const result = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise }, timeoutMs);
    if (result.exceptionDetails) {
      const details = result.exceptionDetails;
      throw new Error((details.exception && details.exception.description) || details.text || "page exception");
    }
    return result.result.value;
  }

  // Navigates and waits for a NEW document, then for the engine's first frame.
  // Without the timeOrigin check an evaluate can land in the old document and
  // see its bootFrame before the navigation has started.
  async open(url = this.url(), { timeoutMs = 240000 } = {}) {
    const navAt = Date.now();
    await this.cdp.send("Page.navigate", { url }, 60000);
    await waitFor(async () => {
      try {
        const origin = await this.evaluate("performance.timeOrigin");
        return typeof origin === "number" && origin >= navAt - 1000;
      } catch {
        return false;
      }
    }, 60000, "a new document");
    await waitFor(() => this.evaluate("Boolean(window.quake2Engine && window.quake2Engine.read && window.quake2BootFrame)"),
      timeoutMs, "the engine's first frame", 300);
    return this.state();
  }

  async reload(options = {}) {
    const url = await this.evaluate("location.href");
    return this.open(url, options);
  }

  async state() {
    return this.evaluate(`(() => {
      const canvas = document.getElementById("canvas");
      const gl = canvas.getContext("webgl2");
      const current = Array.from(document.querySelectorAll(".menu-view")).find((view) => !view.hidden);
      return {
        keyDest: window.quake2Engine && window.quake2Engine.keyDest ? window.quake2Engine.keyDest() : null,
        buffer: gl ? gl.drawingBufferWidth + "x" + gl.drawingBufferHeight : null,
        canvasDisplay: canvas.style.display,
        menuOpen: document.getElementById("menu-layer").hidden === false,
        view: current ? current.dataset.view : null,
        mainEntries: Array.from(document.querySelectorAll('.menu-view[data-view="main"] .label')).map((one) => one.textContent.trim()),
        loadSlots: Array.from(document.querySelectorAll("#load-slots button")).map((one) => one.dataset.slot),
        loadEmpty: document.getElementById("load-empty") ? !document.getElementById("load-empty").hidden : null,
        startup: window.quake2StartupArguments,
        rtx: window.quake2RTX ? window.quake2RTX.status() : null,
        banner: document.getElementById("banner").hidden ? null : document.getElementById("banner-text").textContent,
      };
    })()`);
  }

  async click(selector) {
    const clicked = await this.evaluate(`(() => { const button = document.querySelector(${JSON.stringify(selector)}); if (!button) return false; button.click(); return true; })()`);
    if (!clicked) throw new Error("no element matches " + selector);
    await sleep(60);
  }

  // A trusted CDP click at the element's own centre. Full screen and game mode
  // need a real user gesture; a JS .click() does not count as one.
  async trustedClick(selector) {
    const box = await this.evaluate(`(() => {
      const element = document.querySelector(${JSON.stringify(selector)});
      if (!element) return null;
      const rect = element.getBoundingClientRect();
      return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    })()`);
    if (!box) throw new Error("no element matches " + selector);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: box.x, y: box.y, button: "none" });
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await sleep(50);
    await this.cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1 });
    await sleep(150);
  }

  // The app's own key path: a synthetic Escape/F6/Enter is exactly what the
  // page's tapKey sends the engine (window.dispatchEvent, keyCode defined).
  async tapKey(descriptor) {
    return this.evaluate(`window.quake2App.tapKey(${JSON.stringify(descriptor)})`);
  }

  // A real CDP key: the page's panel handler reads it like a player's key.
  async pressKey(name) {
    const keys = {
      Enter: { key: "Enter", code: "Enter", vk: 13 },
      Escape: { key: "Escape", code: "Escape", vk: 27 },
      ArrowDown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
      Tab: { key: "Tab", code: "Tab", vk: 9 },
    };
    const k = keys[name];
    if (!k) throw new Error("unknown key " + name);
    const event = { key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
    await this.cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
    await sleep(40);
    await this.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
    await sleep(120);
  }

  async openMenu(timeoutMs = 30000) {
    await this.evaluate("document.getElementById('canvas').focus(); true");
    const started = Date.now();
    let attempt = 0;
    while (Date.now() - started < timeoutMs) {
      if (await this.evaluate("document.getElementById('menu-layer').hidden === false")) return true;
      // The app's own key path first; a trusted CDP Escape as a fallback for a
      // frame where a synthetic key is dropped (the engine runs at a few
      // frames a second under the software renderer).
      if (attempt % 6 === 0) {
        if (attempt % 12 === 0) await this.tapKey({ key: "Escape", code: "Escape", vk: 27, ch: 27 });
        else await this.pressKey("Escape");
      }
      await sleep(300);
      attempt++;
    }
    return false;
  }

  async closeMenu() {
    if (!(await this.evaluate("document.getElementById('menu-layer').hidden === false"))) return true;
    await this.click('[data-action="resume"]');
    await waitFor(() => this.evaluate("document.getElementById('menu-layer').hidden === true"), 15000, "the menu to close");
    return true;
  }

  async screenshot(file) {
    const { data } = await this.cdp.send("Page.captureScreenshot", { format: "png" }, 60000);
    await fsp.writeFile(file, Buffer.from(data, "base64"));
    return file;
  }

  async frames(seconds) {
    const before = await this.evaluate("window.__q2check.frames");
    const t0 = Date.now();
    await sleep(seconds * 1000);
    const after = await this.evaluate("window.__q2check.frames");
    const elapsed = (Date.now() - t0) / 1000;
    const stats = await this.evaluate(`(() => {
      const times = window.__q2check.frameTimes.slice(-Math.max(20, Math.round(${seconds} * 60))).slice(-400);
      const sorted = times.slice().sort((a, b) => a - b);
      const q = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null);
      return { n: sorted.length, p50: q(0.5), p95: q(0.95), max: sorted.length ? sorted[sorted.length - 1] : null };
    })()`);
    return { seconds: elapsed, frames: after - before, fps: (after - before) / elapsed, frameTime: stats };
  }

  async metrics() {
    const before = await this.cdp.send("Performance.getMetrics");
    const m0 = Object.fromEntries(before.metrics.map((one) => [one.name, one.value]));
    return {
      diff: async () => {
        const after = await this.cdp.send("Performance.getMetrics");
        const m1 = Object.fromEntries(after.metrics.map((one) => [one.name, one.value]));
        const out = {};
        for (const key of Object.keys(m1)) out[key] = m1[key] - (m0[key] || 0);
        return out;
      },
    };
  }

  // The store, over the same HTTP surface the page uses.
  async storeList() {
    const response = await fetch("http://127.0.0.1:" + this.proxyPort + "/userdata/", { cache: "no-store" });
    if (!response.ok) throw new Error("userdata listing HTTP " + response.status);
    return (await response.json()).files;
  }

  async storeRead(relPath) {
    const response = await fetch("http://127.0.0.1:" + this.proxyPort + "/userdata/" + relPath.split("/").map(encodeURIComponent).join("/"), { cache: "no-store" });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("userdata read HTTP " + response.status);
    return Buffer.from(await response.arrayBuffer());
  }

  async storeWrite(relPath, data) {
    const response = await fetch("http://127.0.0.1:" + this.proxyPort + "/userdata/" + relPath.split("/").map(encodeURIComponent).join("/"), { method: "POST", body: data });
    if (!response.ok) throw new Error("userdata write HTTP " + response.status);
    return response.status;
  }

  async storeDelete(relPath) {
    const response = await fetch("http://127.0.0.1:" + this.proxyPort + "/userdata/" + relPath.split("/").map(encodeURIComponent).join("/") + "?delete", { method: "POST" });
    if (!response.ok) throw new Error("userdata delete HTTP " + response.status);
    return response.status;
  }

  // A console command through the repository's own driver (control/bridge.mjs).
  // Loaded lazily so a check that never needs the console does not pay for it.
  async control() {
    if (!this.controlInstance) {
      const { QuakeControl } = await import("../control/bridge.mjs");
      this.controlInstance = new QuakeControl({
        cdpUrl: "http://127.0.0.1:" + this.cdpPort,
        gameUrlMark: this.appPath,
        timeoutMs: 60000,
      });
    }
    return this.controlInstance;
  }

  async command(text) {
    const control = await this.control();
    return control.command(text, { tail: 12 });
  }

  async mapName() {
    const control = await this.control();
    const answer = await control.level();
    return answer.map;
  }

  async stop() {
    if (this.controlInstance) {
      try {
        await Promise.race([this.controlInstance.close(), sleep(2000)]);
      } catch { /* gone */ }
    }
    if (this.cdp) this.cdp.close();
    // Children first: the page's keep-alive connections would otherwise hold
    // the proxy's close() open forever.
    for (const child of this.children) {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGTERM"); } catch { /* gone */ }
      }
    }
    await sleep(500);
    for (const child of this.children) {
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch { /* gone */ }
      }
    }
    if (this.proxy) {
      try { this.proxy.closeAllConnections(); } catch { /* older node */ }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
        this.proxy.close(() => { clearTimeout(timer); resolve(); });
      });
    }
    for (const dir of [this.profileDir, this.dataDir]) {
      if (dir) await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// A tiny check/report helper, so each check file reads the same.
export class Report {
  constructor(title) {
    this.title = title;
    this.checks = [];
    this.notes = [];
  }
  check(name, ok, expected, actual, detail) {
    const entry = { name, ok: Boolean(ok), expected, actual, ...(detail ? { detail } : {}) };
    this.checks.push(entry);
    console.log((ok ? "  ok   " : "  FAIL ") + name + " — " + actual + (ok ? "" : " (expected " + expected + ")"));
    return Boolean(ok);
  }
  note(text) {
    this.notes.push(text);
    console.log("  note " + text);
  }
  finish() {
    const failed = this.checks.filter((one) => !one.ok);
    console.log("\n" + (this.checks.length - failed.length) + "/" + this.checks.length + " checks passed" +
      (failed.length ? ": " + failed.map((one) => one.name).join("; ") : ""));
    return failed.length === 0;
  }
}
