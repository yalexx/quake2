#!/usr/bin/env node
// End-to-end check for saved games: plays the real game in headless Chromium
// and proves that saves survive a page reload and a server restart.
//
//   node scripts/e2e-saves.js       exit 0 = passed, 1 = failed, 77 = skipped
//
// Node built-ins only. Chromium comes from CHROME_BIN or PATH (chromium,
// chromium-browser, google-chrome) and is driven over the DevTools protocol
// on --remote-debugging-pipe (fds 3/4, NUL-terminated JSON) with a throwaway
// profile. Where it cannot start under a no-new-privileges parent, the script
// falls back to the browser inside a snap launcher and to --no-sandbox; if it
// still cannot run, the check is skipped (exit 77) with the reason.
//
// The script starts its own `node server.js` on port 4299, or on a
// port the OS picks when that one is taken (never 4231, which belongs to the
// live quake2-app.service), with QUAKE2_DATA_DIR in a fresh temp folder, so
// the real userdata/ is never read or written. It only ever stops processes
// it started itself.
//
// A small proxy in front of that server plays the box: it adds the box's
// `Content-Security-Policy: sandbox allow-scripts allow-pointer-lock` to HTML,
// so the page at /apps/quake2/ runs with an opaque origin and no IndexedDB,
// as it does on the box.
//
// Environment:
//   CHROME_BIN       Chromium binary to use instead of searching PATH
//   E2E_CHROME_ARGS  extra Chromium flags, space-separated
//   E2E_OUT_DIR      where the screenshots go (default: a new temp folder, kept)
//   E2E_KEEP=1       keep the temp save folder and browser profile
//   E2E_VERBOSE=1    echo the game's console while it plays
"use strict";
const { spawn } = require("child_process");
const fs = require("fs");
const fsp = fs.promises;
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const LIVE_PORT = 4231; // the live quake2-app.service: never used here
const PREFERRED_PORT = 4299;
const APP_PATH = "/apps/quake2/";
const BOX_CSP = "sandbox allow-scripts allow-pointer-lock";
const SOFT_RENDERER_QUERY = "?+set&vid_renderer&soft"; // app.js appends query args
const SKIP_EXIT = 77;
const VERBOSE = process.env.E2E_VERBOSE === "1";
const KEEP = process.env.E2E_KEEP === "1";

const BOOT_MS = 240000; // PAK download, WASM compile, first frame
const LOAD_MS = 90000; // one map load
const SAVE_MS = 30000; // one save, until the server holds it
const STEP_MS = 20000; // anything else the game answers at once
const QUIET_MS = 1500; // console silence that ends a map load
const TOTAL_MS = 20 * 60000;
const KEY_GAP_MS = 25;
const SAVE_FILES = ["server.ssv", "game.ssv"];
const LEVEL_FILES = (map) => [map + ".sav", map + ".sv2"];

class Skip extends Error {}

const children = new Set(); // every process this run started and has not seen exit
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(line) {
  process.stdout.write(line + "\n");
}

function step(title) {
  log("\n== " + title);
}

function ok(what) {
  log("  ok    " + what);
}

function note(what) {
  log("  note  " + what);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isWithin(dir, p) {
  return p === dir || p.startsWith(dir + path.sep);
}

// Calls back with each line of a text stream.
function onLines(stream, callback) {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop();
    for (const line of lines) callback(line.replace(/\r$/, ""));
  });
  stream.on("end", () => {
    if (rest) callback(rest);
  });
}

// ---- Processes -------------------------------------------------------------

function hasExited(child) {
  return child.exitCode !== null || child.signalCode !== null;
}

// Children run detached, as the leaders of their own process groups, so this
// reaches whatever they started themselves and nothing else.
function signalChild(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

async function stopChild(child, graceMs) {
  if (!child || hasExited(child)) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  signalChild(child, "SIGTERM");
  const stopped = await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)]);
  if (!stopped) {
    signalChild(child, "SIGKILL");
    await exited;
  }
}

function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

process.on("exit", () => {
  for (const child of children) signalChild(child, "SIGKILL");
});

// ---- Ports -----------------------------------------------------------------

// Resolves to the port a probe could listen on (port 0: one the OS picks), or null.
function probePort(port) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once("error", () => resolve(null));
    probe.listen(port, "127.0.0.1", () => {
      const got = probe.address().port;
      probe.close(() => resolve(got));
    });
  });
}

// `preferred` when it is free, else a port the OS picks; never LIVE_PORT or one in `avoid`.
async function pickPort(preferred, avoid) {
  const banned = new Set([LIVE_PORT, ...avoid]);
  if (preferred && !banned.has(preferred) && (await probePort(preferred))) return preferred;
  for (;;) {
    const port = await probePort(0);
    if (port && !banned.has(port)) return port;
  }
}

// ---- The game server and the box proxy -------------------------------------

const serverErrors = []; // stderr of every server.js this run started

function startServer(port, dataDir) {
  return new Promise((resolve, reject) => {
    assert(port !== LIVE_PORT, "refusing to start server.js on the live port " + LIVE_PORT);
    const child = track(spawn(process.execPath, [path.join(ROOT, "server.js")], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(port), QUAKE2_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }));
    const stderr = [];
    let settled = false;
    const timer = setTimeout(() => fail(new Error("server.js did not start listening within 15 s")), 15000);
    function fail(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopChild(child, 2000).then(() => reject(error));
    }
    onLines(child.stdout, (line) => {
      if (VERBOSE) log("  server: " + line);
      const m = /^Quake 2 static server on http:\/\/127\.0\.0\.1:(\d+)\/.*, saves in (.+)$/.exec(line);
      if (!m || settled) return;
      if (Number(m[1]) !== port || path.resolve(m[2]) !== dataDir) {
        fail(new Error("server.js started with the wrong settings: " + line));
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(child);
    });
    onLines(child.stderr, (line) => {
      stderr.push(line);
      serverErrors.push(line);
      log("  server stderr: " + line);
    });
    child.once("error", (error) => fail(error));
    child.once("exit", (code, signal) => {
      fail(new Error("server.js exited (" + (signal || "code " + code) + ") before listening" +
        (stderr.length ? ": " + stderr.slice(-5).join(" | ") : "")));
    });
  });
}

// Starts server.js on `port`, or on another free port if that one got taken meanwhile.
async function startServerOnFreePort(port, dataDir, avoid) {
  for (let attempt = 1; ; attempt++) {
    try {
      return { child: await startServer(port, dataDir), port };
    } catch (error) {
      if (attempt >= 3) throw error;
      note("server.js could not start on port " + port + " (" + error.message + "); trying another port");
      port = await pickPort(0, avoid);
    }
  }
}

const HOP_HEADERS = ["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection"];

function withoutHopHeaders(headers) {
  const copy = { ...headers };
  for (const name of HOP_HEADERS) delete copy[name];
  return copy;
}

// Forwards everything to the game server; HTML answers get the box's CSP sandbox header.
function startBoxProxy(targetPort, avoid) {
  const proxy = http.createServer((req, res) => {
    const port = targetPort();
    const upstream = http.request({
      host: "127.0.0.1",
      port,
      method: req.method,
      path: req.url,
      headers: { ...withoutHopHeaders(req.headers), host: "127.0.0.1:" + port, connection: "close" },
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
        res.writeHead(502, { "Content-Type": "text/plain", "Access-Control-Allow-Origin": "*" })
          .end("box proxy: " + error.message);
      }
    });
    res.on("close", () => upstream.destroy());
    req.pipe(upstream);
  });
  return new Promise((resolve, reject) => {
    pickPort(0, avoid).then((port) => {
      proxy.once("error", reject);
      proxy.listen(port, "127.0.0.1", () => resolve({ proxy, port }));
    }, reject);
  });
}

// ---- Chromium over the DevTools pipe ----------------------------------------

class Cdp {
  constructor(input, output) {
    this.input = input; // Chromium reads fd 3
    this.nextId = 1;
    this.calls = new Map();
    this.handlers = new Set();
    this.closed = null;
    let pending = [];
    output.on("data", (chunk) => {
      let start = 0;
      let end;
      while ((end = chunk.indexOf(0, start)) >= 0) {
        pending.push(chunk.subarray(start, end));
        const text = Buffer.concat(pending).toString("utf8");
        pending = [];
        start = end + 1;
        let message;
        try {
          message = JSON.parse(text);
        } catch {
          continue;
        }
        this.receive(message);
      }
      if (start < chunk.length) pending.push(chunk.subarray(start));
    });
    output.on("close", () => this.shutdown(new Error("the browser closed the DevTools pipe")));
    input.on("error", (error) => this.shutdown(error));
  }

  receive(message) {
    if (message.id === undefined) {
      for (const handler of [...this.handlers]) handler(message);
      return;
    }
    const call = this.calls.get(message.id);
    if (!call) return;
    this.calls.delete(message.id);
    clearTimeout(call.timer);
    if (message.error) call.reject(new Error(call.method + ": " + message.error.message));
    else call.resolve(message.result);
  }

  send(method, params, sessionId, timeoutMs) {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    const message = { id, method, params: params || {} };
    if (sessionId) message.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const ms = timeoutMs || STEP_MS;
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(method + ": no answer within " + ms / 1000 + " s"));
      }, ms);
      this.calls.set(id, { method, resolve, reject, timer });
      this.input.write(JSON.stringify(message) + "\0");
    });
  }

  on(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  shutdown(error) {
    if (this.closed) return;
    this.closed = error;
    for (const call of this.calls.values()) {
      clearTimeout(call.timer);
      call.reject(error);
    }
    this.calls.clear();
  }
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function findChromium() {
  if (process.env.CHROME_BIN) {
    if (!isExecutable(process.env.CHROME_BIN)) throw new Skip("CHROME_BIN=" + process.env.CHROME_BIN + " is not an executable file");
    return process.env.CHROME_BIN;
  }
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const name of ["chromium", "chromium-browser", "google-chrome"]) {
    for (const dir of dirs) {
      const file = path.join(dir, name);
      if (isExecutable(file)) return file;
    }
  }
  throw new Skip("no Chromium found: set CHROME_BIN, or put chromium, chromium-browser or google-chrome on PATH");
}

// For a snap launcher (/snap/bin/<name> -> /usr/bin/snap), the browser binary inside that snap.
function snapBrowser(bin) {
  let target;
  try {
    target = fs.realpathSync(bin);
  } catch {
    return null;
  }
  if (path.basename(target) !== "snap") return null;
  const snap = path.join("/snap", path.basename(bin), "current");
  return ["usr/lib/chromium-browser/chrome", "usr/lib/chromium/chrome"]
    .map((rel) => path.join(snap, rel)).find(isExecutable) || null;
}

// Launches Chromium as found. Where that cannot run, retries the ways that
// can: for a snap launcher that snap-confine refuses (a no-new-privileges
// parent denies it its capabilities), the browser inside the snap; and when
// Chromium's own sandbox cannot start for the same reason, --no-sandbox (it
// only ever loads this script's local server).
async function startChromium(bin, profileDir) {
  const failures = [];
  let attempt = { bin, noSandbox: false };
  for (;;) {
    try {
      return await launchChromium(attempt.bin, profileDir, attempt.noSandbox ? ["--no-sandbox"] : []);
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      failures.push(error.message);
      const inner = /snap-confine/.test(error.message) && snapBrowser(attempt.bin);
      if (inner) {
        note("snap-confine cannot run " + attempt.bin + " here; using the browser inside the snap: " + inner);
        attempt = { bin: inner, noSandbox: attempt.noSandbox };
      } else if (!attempt.noSandbox && /sandbox|namespace/i.test(error.message)) {
        note("Chromium's own sandbox cannot start here; relaunching with --no-sandbox");
        attempt = { bin: attempt.bin, noSandbox: true };
      } else {
        const hint = /Socket path too long/.test(error.message)
          ? "\n  (Chromium puts a socket under TMPDIR: use a shorter TMPDIR)" : "";
        throw new Skip(failures.join("\n  then: ") + hint);
      }
      await fsp.rm(profileDir, { recursive: true, force: true });
      await fsp.mkdir(profileDir);
    }
  }
}

async function launchChromium(bin, profileDir, extraArgs) {
  const args = [
    "--headless=new",
    "--remote-debugging-pipe",
    "--user-data-dir=" + profileDir,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-sync",
    "--disable-component-update",
    "--disable-background-networking",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--mute-audio",
    "--autoplay-policy=no-user-gesture-required",
    "--window-size=1024,768",
    // Headless has no GPU: WebGL runs on SwiftShader.
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    ...extraArgs,
    ...(process.env.E2E_CHROME_ARGS || "").split(/\s+/).filter(Boolean),
    "about:blank",
  ];
  const child = track(spawn(bin, args, { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"], detached: true }));
  const stderrTail = [];
  onLines(child.stderr, (line) => {
    stderrTail.push(line);
    if (stderrTail.length > 30) stderrTail.shift();
  });
  const cdp = new Cdp(child.stdio[3], child.stdio[4]);
  const failed = new Promise((resolve, reject) => {
    child.once("error", (error) => reject(new Error("could not run it: " + error.message)));
    child.once("exit", (code, signal) => reject(new Error("it exited (" + (signal || "code " + code) + ")")));
  });
  failed.catch(() => {}); // a later exit is handled where it matters
  try {
    const version = await Promise.race([cdp.send("Browser.getVersion", {}, null, 30000), failed]);
    return { child, cdp, version, stderrTail };
  } catch (pipeError) {
    // A broken pipe usually means the process died: say how, if it did.
    const error = await Promise.race([failed.catch((exit) => exit), sleep(1500).then(() => pipeError)]);
    await stopChild(child, 2000);
    const tail = stderrTail.filter(Boolean).slice(-8).join("\n    ");
    throw new Skip("Chromium " + bin + " cannot run here: " + error.message + (tail ? "\n    " + tail : ""));
  }
}

async function closeChromium(browser) {
  if (!browser || hasExited(browser.child)) return;
  const exited = new Promise((resolve) => browser.child.once("exit", resolve));
  await browser.cdp.send("Browser.close", {}, null, 5000).catch(() => {});
  const closed = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
  if (!closed) await stopChild(browser.child, 3000);
}

// ---- The page and the game's console ----------------------------------------

const FATAL_RE = /^(Error: |Engine aborted|Could not download game data|Could not load the game engine)/;
const lines = []; // everything the page logged, as { n, type, text }
const lineWaiters = new Set();
const pageExceptions = [];
let lastLineAt = Date.now();
let fatal = null;
let quitting = false; // after `quit` the engine stopping is expected

function recordLine(type, rawText) {
  // eslint-disable-next-line no-control-regex
  const text = String(rawText).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
  for (const part of text.split("\n")) {
    const line = { n: lines.length, type, text: part.trim() };
    lines.push(line);
    if (VERBOSE) log("  | " + (type === "log" ? "" : type + ": ") + line.text);
    if (!fatal && !quitting && FATAL_RE.test(line.text)) fatal = new Error("the game stopped: " + line.text);
    for (const waiter of [...lineWaiters]) waiter(line);
  }
  lastLineAt = Date.now();
}

function remoteValue(arg) {
  if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  return arg.description || arg.unserializableValue || arg.type;
}

function mark() {
  return lines.length;
}

// Resolves to the first line logged at index `since` or later whose text matches re.
function waitForLine(re, since, timeoutMs, what) {
  const found = lines.slice(since).find((line) => re.test(line.text));
  if (found) return Promise.resolve(found);
  if (fatal) return Promise.reject(fatal);
  return new Promise((resolve, reject) => {
    const waiter = (line) => {
      if (fatal) {
        done();
        reject(fatal);
      } else if (line.n >= since && re.test(line.text)) {
        done();
        resolve(line);
      }
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error("timed out after " + timeoutMs / 1000 + " s waiting for " + (what || String(re))));
    }, timeoutMs);
    function done() {
      clearTimeout(timer);
      lineWaiters.delete(waiter);
    }
    lineWaiters.add(waiter);
  });
}

// Resolves to check()'s first truthy result, polling until timeoutMs.
async function waitUntil(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fatal) throw fatal;
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out after " + timeoutMs / 1000 + " s waiting for " + (typeof what === "function" ? what() : what));
    await sleep(200);
  }
}

// Waits until the console has been silent for QUIET_MS.
function waitQuiet(timeoutMs) {
  return waitUntil(() => Date.now() - lastLineAt >= QUIET_MS, timeoutMs || LOAD_MS, "the console to settle");
}

class Page {
  constructor(cdp, sessionId) {
    this.cdp = cdp;
    this.sessionId = sessionId;
  }

  send(method, params, timeoutMs) {
    return this.cdp.send(method, params, this.sessionId, timeoutMs);
  }

  async evaluate(expression, timeoutMs) {
    const answer = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, timeoutMs);
    if (answer.exceptionDetails) {
      const e = answer.exceptionDetails;
      throw new Error("page script failed: " + ((e.exception && e.exception.description) || e.text));
    }
    return answer.result.value;
  }

  waitForEvent(method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const off = this.cdp.on((message) => {
        if (message.sessionId === this.sessionId && message.method === method) {
          off();
          clearTimeout(timer);
          resolve(message.params);
        }
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error("timed out after " + timeoutMs / 1000 + " s waiting for " + method));
      }, timeoutMs);
    });
  }
}

async function openPage(cdp) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(cdp, sessionId);
  cdp.on((message) => {
    if (message.sessionId !== sessionId) return;
    const p = message.params;
    if (message.method === "Runtime.consoleAPICalled") {
      recordLine(p.type, p.args.map(remoteValue).join(" "));
    } else if (message.method === "Runtime.exceptionThrown") {
      const e = p.exceptionDetails;
      const text = (e.exception && e.exception.description) || e.text;
      pageExceptions.push({ text, url: e.url || "" });
      recordLine("exception", text);
    } else if (message.method === "Log.entryAdded" && p.entry.level === "error") {
      recordLine("browser", p.entry.text + (p.entry.url ? " (" + p.entry.url + ")" : ""));
    }
  });
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Page.bringToFront");
  return page;
}

// ---- Keyboard ---------------------------------------------------------------

const NAMED_KEYS = {
  Backquote: { key: "`", code: "Backquote", keyCode: 192 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
  F6: { key: "F6", code: "F6", keyCode: 117 },
};

const PUNCTUATION_KEYS = {
  " ": { code: "Space", keyCode: 32 },
  ".": { code: "Period", keyCode: 190 },
  "-": { code: "Minus", keyCode: 189 },
  "_": { code: "Minus", keyCode: 189, shift: true },
};

function charKey(ch) {
  if (/^[a-z]$/.test(ch)) return { code: "Key" + ch.toUpperCase(), keyCode: ch.toUpperCase().charCodeAt(0) };
  if (/^[0-9]$/.test(ch)) return { code: "Digit" + ch, keyCode: ch.charCodeAt(0) };
  if (PUNCTUATION_KEYS[ch]) return PUNCTUATION_KEYS[ch];
  throw new Error("the script cannot type " + JSON.stringify(ch));
}

// A key without text: a keydown and a keyup, no keypress (so no text input).
async function pressKey(page, name) {
  const k = NAMED_KEYS[name];
  const event = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
  await sleep(40);
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  await sleep(KEY_GAP_MS);
}

// Typed text: keydown with text also fires keypress, which SDL turns into text input.
async function typeText(page, text) {
  for (const ch of text) {
    const k = charKey(ch);
    const event = {
      key: ch,
      code: k.code,
      windowsVirtualKeyCode: k.keyCode,
      nativeVirtualKeyCode: k.keyCode,
      modifiers: k.shift ? 8 : 0,
    };
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, unmodifiedText: ch, ...event });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
    await sleep(KEY_GAP_MS);
  }
}

// ---- Saves on disk ----------------------------------------------------------

function diskPath(dataDir, relPath) {
  return path.join(dataDir, ...relPath.split("/"));
}

function readDisk(dataDir, relPath) {
  try {
    return fs.readFileSync(diskPath(dataDir, relPath));
  } catch {
    return null;
  }
}

// Every file in the store, as sorted "/"-separated relative paths.
function diskFiles(dir, prefix, out) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) diskFiles(path.join(dir, entry.name), prefix + entry.name + "/", out);
    else if (entry.isFile()) out.push(prefix + entry.name);
  }
  return out.sort();
}

// The files the page restores at boot (app.js skips *.log and the server hides dot-files).
function restorableFiles(dataDir) {
  return diskFiles(dataDir, "", []).filter((p) => !/\.log$/i.test(p) && !p.split("/").some((s) => s.startsWith(".")));
}

function slotFiles(dataDir, slot) {
  return diskFiles(path.join(dataDir, "baseq2", "save", slot), "", []);
}

// Size plus 32-bit FNV-1a, as MOUNT_PRINTS_JS computes it in the page.
function fingerprint(data) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 0x01000193);
  return data.length + ":" + (hash >>> 0).toString(16);
}

function saveRel(slot, name) {
  return "baseq2/save/" + slot + "/" + name;
}

// Waits until every relPath is on disk and not empty.
function waitForFiles(dataDir, relPaths, timeoutMs, what) {
  return waitUntil(
    () => relPaths.every((relPath) => {
      const data = readDisk(dataDir, relPath);
      return data && data.length > 0;
    }),
    timeoutMs,
    () => what + " (missing: " + relPaths.filter((p) => !readDisk(dataDir, p)).join(", ") +
      "; on disk: " + (diskFiles(dataDir, "", []).join(", ") || "nothing") + ")",
  );
}

function expectOnDisk(dataDir, relPaths, what) {
  const missing = relPaths.filter((p) => !(readDisk(dataDir, p) || "").length);
  assert(!missing.length, what + ": missing on disk: " + missing.join(", ") +
    " (on disk: " + (diskFiles(dataDir, "", []).join(", ") || "nothing") + ")");
}

// ---- The run ------------------------------------------------------------------

async function run(ctx) {
  const chromeBin = findChromium();
  log("Chromium: " + chromeBin);

  ctx.dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), "quake2-e2e-saves-"));
  ctx.profileDir = await fsp.mkdtemp(path.join(os.tmpdir(), "quake2-e2e-chrome-"));
  const realStore = path.join(ROOT, "userdata");
  assert(!isWithin(realStore, ctx.dataDir) && !isWithin(ctx.dataDir, realStore), "the temp save folder overlaps the real userdata/");
  const outDir = process.env.E2E_OUT_DIR ? path.resolve(process.env.E2E_OUT_DIR)
    : await fsp.mkdtemp(path.join(os.tmpdir(), "quake2-e2e-out-"));
  await fsp.mkdir(outDir, { recursive: true });
  ctx.outDir = outDir;
  const dataDir = ctx.dataDir;

  step("Start server.js and the box proxy");
  let serverPort = await pickPort(PREFERRED_PORT, []);
  ({ child: ctx.server, port: serverPort } = await startServerOnFreePort(serverPort, dataDir, []));
  ok("server.js on 127.0.0.1:" + serverPort + ", QUAKE2_DATA_DIR=" + dataDir);
  const box = await startBoxProxy(() => serverPort, [serverPort]);
  ctx.proxy = box.proxy;
  const baseUrl = "http://127.0.0.1:" + box.port + APP_PATH;
  ok("box proxy on 127.0.0.1:" + box.port + " adds `Content-Security-Policy: " + BOX_CSP + "` to HTML");

  step("Start headless Chromium");
  ctx.browser = await startChromium(chromeBin, ctx.profileDir);
  ok(ctx.browser.version.product + " over --remote-debugging-pipe");
  const page = await openPage(ctx.browser.cdp);
  ctx.page = page;

  // -- Helpers bound to this page ------------------------------------------

  async function command(text) {
    await typeText(page, text);
    await pressKey(page, "Enter");
  }

  let syncCount = 0;
  // Makes sure typed text reaches the console: echoes a token (letters only,
  // none bound to a menu or chat key) and toggles the console until it comes back.
  async function ensureConsole(toggleFirst) {
    const recovery = ["Backquote", "Backquote", "Escape", "Backquote", "Escape", "Backquote"];
    if (toggleFirst) {
      await pressKey(page, "Backquote");
      await sleep(700);
    }
    for (let attempt = 0; ; attempt++) {
      const token = "syncmark" + String(++syncCount).replace(/\d/g, (d) => "abcdefghij"[d]);
      const since = mark();
      await command("echo " + token);
      const echoed = await waitForLine(new RegExp("^" + token + "$"), since, 2500).catch((error) => {
        if (error === fatal) throw error;
        return null;
      });
      if (echoed) return;
      if (attempt >= recovery.length) throw new Error("typed commands never reached the game's console");
      note("the console did not answer; pressing " + recovery[attempt]);
      await pressKey(page, recovery[attempt]);
      await sleep(900);
    }
  }

  async function cvar(name) {
    const since = mark();
    await command(name);
    const re = new RegExp('^"' + name + '" is "([^"]*)"');
    const line = await waitForLine(re, since, STEP_MS, "the value of " + name);
    return re.exec(line.text)[1];
  }

  // Runs a map-changing command and waits until the game is playable again.
  // Typed during a game, the console stays open over the new map; typed with
  // no game running, the new map takes the keyboard and the console closes.
  let inGame = false;
  async function changeMap(text, expectedMap) {
    const since = mark();
    await command(text);
    const line = await waitForLine(/^(-+ server initialization -+|No such savegame: .*|USAGE: .*|ERROR: .*)$/i,
      since, LOAD_MS, "`" + text + "` to start the server");
    assert(/server initialization/i.test(line.text), "`" + text + "` failed: " + line.text);
    await waitQuiet();
    await ensureConsole(!inGame);
    inGame = true;
    const mapname = await cvar("mapname");
    assert(mapname === expectedMap, "`" + text + "` left mapname at " + JSON.stringify(mapname) + ", not " + expectedMap);
  }

  // Every file the game holds under its save mount (/qwasm2), as relPath ->
  // size and FNV-1a hash; *.log is never synced.
  const MOUNT_PRINTS_JS = `(() => {
    const out = {};
    const walk = (dir, prefix) => {
      for (const name of FS.readdir(dir)) {
        if (name === "." || name === "..") continue;
        const full = dir + "/" + name;
        const stat = FS.stat(full);
        if (FS.isDir(stat.mode)) walk(full, prefix + name + "/");
        else if (FS.isFile(stat.mode) && !/\\.log$/i.test(name)) {
          const data = FS.readFile(full);
          let hash = 0x811c9dc5;
          for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 0x01000193);
          out[prefix + name] = data.length + ":" + (hash >>> 0).toString(16);
        }
      }
    };
    walk("/qwasm2", "");
    return out;
  })()`;

  // Waits until the server's store holds exactly the files the game has, byte for byte.
  async function expectStoreMatchesGame(label) {
    let differences = [];
    let count = 0;
    await waitUntil(async () => {
      const game = await page.evaluate(MOUNT_PRINTS_JS);
      const store = {};
      for (const relPath of restorableFiles(dataDir)) store[relPath] = fingerprint(readDisk(dataDir, relPath) || []);
      differences = [];
      for (const relPath of new Set([...Object.keys(game), ...Object.keys(store)])) {
        if (!(relPath in store)) differences.push(relPath + " is missing on the server");
        else if (!(relPath in game)) differences.push(relPath + " is on the server but not in the game");
        else if (game[relPath] !== store[relPath]) differences.push(relPath + " differs");
      }
      count = Object.keys(game).length;
      return !differences.length;
    }, SAVE_MS, () => "the server's store to match the game's files: " + differences.join("; "));
    ok(label + ": the server holds exactly the game's " + count + " files, byte for byte");
  }

  // Saves through `save <slot>` (or a key bound to it) and waits for the
  // engine's own sync to report back. Returns how it was saved.
  async function saveGame(slot, key) {
    for (let attempt = 1; ; attempt++) {
      const since = mark();
      let how = "`save " + slot + "`";
      if (key) {
        await pressKey(page, key);
        const bound = await waitForLine(/^Quick Saving\.\.\.$/, since, 5000).catch(() => null);
        if (bound) {
          how = key + " (bound to `save " + slot + "`)";
        } else {
          note(key + " did not start a save; typing `save " + slot + "` instead");
          await ensureConsole(true); // the key was pressed with the console closed
          key = null;
          continue;
        }
      } else {
        await command("save " + slot);
      }
      const done = await waitForLine(/^(Done\.|Can't savegame while dead!|You must be in a game to save\.|Bad savedir\.|Can't save to 'current'|Can't savegame in a deathmatch)$/,
        since, STEP_MS, how + " to finish");
      if (done.text === "Done.") {
        const synced = await waitForLine(/^(Data saved\.|Failed to save data.*)$/, since, SAVE_MS, "the engine's sync after " + how);
        assert(synced.text === "Data saved.", how + ": " + synced.text);
        return how;
      }
      if (attempt >= 6 || !/dead|in a game/.test(done.text)) throw new Error(how + " failed: " + done.text);
      await sleep(2000);
    }
  }

  const RESTORED_RE = /restored (\d+) (?:saved )?file\(s\)/i;

  // Loads the page (or reloads it) and waits until the engine runs and the
  // typed commands reach its console. Returns how many files app.js restored.
  async function boot(load) {
    const since = mark();
    inGame = false;
    const loaded = page.waitForEvent("Page.loadEventFired", BOOT_MS);
    await load();
    await loaded;
    const restored = await waitForLine(RESTORED_RE, since, BOOT_MS, "app.js to restore the saved games");
    await waitUntil(() => page.evaluate("document.getElementById('canvas').style.display === 'block'"), BOOT_MS,
      "the engine to show its canvas");
    await waitForLine(/^==== Yamagi Quake II Initialized ====$/, since, BOOT_MS, "the engine to initialise");
    await waitQuiet();
    // The engine starts the attract demo; the console key stops it and leaves the console open.
    await ensureConsole(true);
    return Number(RESTORED_RE.exec(restored.text)[1]);
  }

  // -- 1. The page under the box's sandbox --------------------------------------

  step("Open " + APP_PATH + " through the box proxy (opaque-origin sandbox)");
  let appUrl = baseUrl;
  let restoredAtStart;
  const firstBoot = () => boot(() => page.send("Page.navigate", { url: appUrl }));
  const bootStarted = mark();
  try {
    restoredAtStart = await firstBoot();
  } catch (error) {
    if (fatal || /canvas|initialise/.test(error.message)) {
      note("the engine did not start with WebGL (" + error.message + "); retrying with the software renderer");
      fatal = null;
      appUrl = baseUrl + SOFT_RENDERER_QUERY;
      restoredAtStart = await firstBoot();
    } else {
      throw error;
    }
  }
  const sandbox = await page.evaluate(`(async () => {
    const out = { origin: self.origin, url: location.href };
    out.indexedDB = await new Promise((resolve) => {
      try {
        const request = indexedDB.open("quake2-e2e-probe");
        request.onsuccess = () => { request.result.close(); resolve("opened"); };
        request.onerror = () => resolve("error: " + (request.error && request.error.name));
        request.onblocked = () => resolve("blocked");
      } catch (error) {
        resolve("threw " + error.name);
      }
    });
    try {
      out.localStorage = "allowed (" + localStorage.length + ")";
    } catch (error) {
      out.localStorage = "threw " + error.name;
    }
    const probe = document.createElement("canvas");
    out.webgl2 = !!probe.getContext("webgl2");
    return out;
  })()`);
  assert(sandbox.origin === "null", "the page is not sandboxed: its origin is " + sandbox.origin);
  assert(sandbox.indexedDB !== "opened", "indexedDB.open worked under the box's sandbox");
  ok("origin " + sandbox.origin + ", indexedDB.open " + sandbox.indexedDB + ", localStorage " + sandbox.localStorage);
  ok("WebGL2 " + (sandbox.webgl2 ? "available" : "unavailable") + "; page " + sandbox.url);
  const renderer = lines.slice(bootStarted).map((l) => /ref_(\w+)\.wasm|Loading library: .*ref_(\w+)/.exec(l.text)).find(Boolean);
  if (renderer) note("renderer library: ref_" + (renderer[1] || renderer[2]));
  assert(restoredAtStart === 0, "a fresh store should restore 0 files, app.js restored " + restoredAtStart);
  ok("app.js restored " + restoredAtStart + " file(s) from the empty store; typed commands reach the console");

  // -- 2. Level-change autosave ----------------------------------------------------

  step("`map demo1`: the level-change autosave reaches the server");
  await changeMap("map demo1", "demo1");
  const autosave = [...SAVE_FILES.map((f) => saveRel("current", f)), ...SAVE_FILES.map((f) => saveRel("save0", f))];
  await waitForFiles(dataDir, autosave, SAVE_MS, "the autosave on disk");
  ok("on disk: " + autosave.join(", "));

  // -- 3. Explicit saves ------------------------------------------------------------

  step("`save save1` and the quicksave");
  let how = await saveGame("save1");
  const save1Demo1 = [...SAVE_FILES, ...LEVEL_FILES("demo1")].map((f) => saveRel("save1", f));
  expectOnDisk(dataDir, save1Demo1, how + " reported \"Data saved.\"");
  ok(how + " -> \"Data saved.\"; on disk: " + save1Demo1.join(", "));

  await pressKey(page, "Backquote"); // back to the game, as a player would quicksave
  await sleep(700);
  how = await saveGame("quick", "F6");
  const quick = [...SAVE_FILES, ...LEVEL_FILES("demo1")].map((f) => saveRel("quick", f));
  expectOnDisk(dataDir, quick, how + " reported \"Data saved.\"");
  ok(how + " -> \"Data saved.\"; on disk: " + quick.join(", "));
  await ensureConsole(!/^`/.test(how));

  // -- 4. Overwriting a slot ----------------------------------------------------------

  step("`gamemap demo2`, `save save1`: the slot takes both levels");
  await changeMap("gamemap demo2", "demo2");
  await waitForFiles(dataDir, LEVEL_FILES("demo1").map((f) => saveRel("current", f)), SAVE_MS,
    "demo1's level files in the autosave after the level change");
  ok("level change wrote " + LEVEL_FILES("demo1").map((f) => saveRel("current", f)).join(", "));
  how = await saveGame("save1");
  const save1Both = [...save1Demo1, ...LEVEL_FILES("demo2").map((f) => saveRel("save1", f))];
  expectOnDisk(dataDir, save1Both, how + " on demo2");
  ok("save1 on disk: " + slotFiles(dataDir, "save1").join(", "));

  step("`map demo1`, `save save1`: files the game dropped from the slot leave the server");
  await changeMap("map demo1", "demo1");
  how = await saveGame("save1");
  expectOnDisk(dataDir, save1Demo1, how + " on demo1 again");
  const stale = LEVEL_FILES("demo2").map((f) => saveRel("save1", f)).filter((p) => readDisk(dataDir, p));
  assert(!stale.length, "save1 still holds files the game deleted: " + stale.join(", "));
  ok("save1 on disk: " + slotFiles(dataDir, "save1").join(", ") + " (demo2.sav, demo2.sv2 gone)");
  expectOnDisk(dataDir, quick, "the quicksave after save1 was rewritten");
  ok("quick untouched: " + slotFiles(dataDir, "quick").join(", "));

  // -- 5. config.cfg ----------------------------------------------------------------------

  await expectStoreMatchesGame("before quitting");

  step("`sensitivity 7.5`, `quit`: config.cfg reaches the server");
  await command("sensitivity 7.5");
  assert((await cvar("sensitivity")) === "7.5", "the sensitivity cvar did not take 7.5");
  const config = "baseq2/config.cfg";
  const quitSince = mark();
  quitting = true;
  inGame = false;
  await command("quit");
  await waitUntil(() => /\bsensitivity\s+"?7\.5\b/.test(String(readDisk(dataDir, config) || "")), SAVE_MS,
    () => config + " with sensitivity 7.5 (on disk: " + diskFiles(dataDir, "", []).join(", ") + ")");
  const configLine = String(readDisk(dataDir, config)).split("\n").find((l) => /\bsensitivity\b/.test(l)).trim();
  ok(config + " on disk has " + configLine);
  const quitSynced = await waitForLine(/^(Data saved\.|Failed to save data.*)$/, quitSince, SAVE_MS, "the engine's sync on quit")
    .catch(() => null);
  if (quitSynced) ok("the engine's sync on quit: " + quitSynced.text);
  else note("the engine logged no sync on quit");
  await waitUntil(() => page.evaluate("document.getElementById('canvas').style.display === 'none'"), STEP_MS,
    "the engine to stop");
  await sleep(1000); // let a last push land before the page goes
  quitting = false;

  // -- 6. Reload, restart, reload ---------------------------------------------------------

  async function checkRestore(label, load) {
    const expected = restorableFiles(dataDir);
    const restored = await boot(load);
    assert(restored === expected.length, label + ": app.js restored " + restored + " file(s), the store holds " +
      expected.length + " (" + expected.join(", ") + ")");
    ok(label + ": app.js restored " + restored + " file(s), all the store holds");
    const sensitivity = await cvar("sensitivity");
    assert(sensitivity === "7.5", label + ": sensitivity is " + sensitivity + ", not 7.5 from config.cfg");
    ok(label + ": sensitivity is 7.5 (config.cfg kept)");
  }

  step("Reload the page");
  await checkRestore("after the reload", () => page.send("Page.reload", { ignoreCache: true }));

  step("Restart server.js on the same save folder, reload again");
  await stopChild(ctx.server, 5000);
  ok("server.js (pid " + ctx.server.pid + ") stopped");
  ({ child: ctx.server, port: serverPort } = await startServerOnFreePort(serverPort, dataDir, [box.port]));
  ok("server.js restarted on 127.0.0.1:" + serverPort + " with the same QUAKE2_DATA_DIR");
  await checkRestore("after the restart", () => page.send("Page.reload", { ignoreCache: true }));

  step("`load save1` and `load quick` after the restart");
  await changeMap("load save1", "demo1");
  ok("`load save1` -> mapname demo1");
  await changeMap("map demo3", "demo3");
  ok("`map demo3` -> mapname demo3 (so the next load has to change the map)");
  await changeMap("load quick", "demo1");
  ok("`load quick` -> mapname demo1");

  step("The Load Game menu");
  await command("menu_loadgame");
  await sleep(2000);
  const shot = path.join(outDir, "menu_loadgame.png");
  const { data } = await page.send("Page.captureScreenshot", { format: "png" }, 30000);
  await fsp.writeFile(shot, Buffer.from(data, "base64"));
  ok("screenshot: " + shot);
  await pressKey(page, "Escape");
  await expectStoreMatchesGame("at the end");

  // -- 7. Nothing went wrong on the way -------------------------------------------------

  step("Console and server errors");
  const saveProblems = lines.filter((l) => /^Saved games:/.test(l.text) && (l.type === "warning" || l.type === "error"));
  assert(!saveProblems.length, "app.js reported save problems:\n    " + saveProblems.map((l) => l.text).join("\n    "));
  ok("app.js logged no save warnings or errors");
  const appErrors = pageExceptions.filter((e) => /\/app\.js/.test(e.url) || /app\.js/.test(e.text));
  assert(!appErrors.length, "app.js threw:\n    " + appErrors.map((e) => e.text).join("\n    "));
  ok("app.js threw nothing");
  assert(!serverErrors.length, "server.js logged errors:\n    " + serverErrors.join("\n    "));
  ok("server.js logged no errors");
  log("\nStore at the end: " + restorableFiles(dataDir).join(", "));
}

async function cleanUp(ctx) {
  await closeChromium(ctx.browser).catch(() => {});
  await stopChild(ctx.server, 5000).catch(() => {});
  if (ctx.proxy) await new Promise((resolve) => ctx.proxy.close(resolve));
  for (const dir of [ctx.profileDir, ctx.dataDir]) {
    if (!dir) continue;
    if (KEEP) log("kept " + dir);
    else await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function main() {
  const ctx = {};
  let code = 0;
  const watchdog = setTimeout(() => {
    fatal = new Error("the whole run took over " + TOTAL_MS / 60000 + " minutes");
  }, TOTAL_MS);
  const interrupted = (signal) => {
    log("\n" + signal + ": cleaning up");
    cleanUp(ctx).finally(() => process.exit(130));
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    await run(ctx);
    log("\nPASS: saves survive a page reload and a server restart");
  } catch (error) {
    if (error instanceof Skip) {
      log("\nSKIP: " + error.message);
      code = SKIP_EXIT;
    } else {
      code = 1;
      log("\nFAIL: " + error.message);
      if (lines.length) log("\nLast console lines:\n" + lines.slice(-40).map((l) => "  " + l.type + ": " + l.text).join("\n"));
      if (ctx.dataDir) log("\nStore: " + (diskFiles(ctx.dataDir, "", []).join(", ") || "empty"));
      if (ctx.browser && ctx.browser.stderrTail.length) log("\nChromium stderr (tail):\n  " + ctx.browser.stderrTail.slice(-10).join("\n  "));
      if (ctx.page && ctx.outDir) {
        try {
          const { data } = await ctx.page.send("Page.captureScreenshot", { format: "png" }, 10000);
          const file = path.join(ctx.outDir, "failure.png");
          await fsp.writeFile(file, Buffer.from(data, "base64"));
          log("\nScreenshot at the failure: " + file);
        } catch {
          // the browser is gone
        }
      }
    }
  } finally {
    clearTimeout(watchdog);
    await cleanUp(ctx);
  }
  process.exit(code);
}

main();
