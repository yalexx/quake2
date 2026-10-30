#!/usr/bin/env node
// scripts/texture-shots.mjs -- in-game before/after shots that prove the engine
// draws the 4x WAL art out of baseq2/pak9.pak.
//
// The pipeline can be checked on disk (tex-check, texture-pack --check), but the
// only proof that the change reaches the player is the game itself: boot the
// real engine in headless Chromium, stand at the spawn of a map, and photograph
// the same view with and without the new archives.
//
// Every run builds three throwaway app folders in a scratch directory, because
// server.js serves its own folder and the difference must live in the served
// baseq2/ (each gets the same app files copied from this checkout, engine/
// symlinked):
//
//   before/  baseq2/pak0.pak written from loadPristine() -- the demo's original
//            archive, from git history -- and no pak9.pak at all. The game as
//            it shipped; the BEFORE side of the <map>-before-after composite.
//   prev/    the previous team's archives, streamed out of git at --prev <rev>
//            (default b6c2a4f) with `git cat-file blob <rev>:baseq2/pak0.pak`
//            and ...:baseq2/pak9.pak. PREV.
//   after/   the archives a release run produces:
//            `node scripts/texture-pack.mjs --out after/baseq2/pak0.pak`, which
//            also writes pak9.pak beside it. What the player gets; NEW.
//
// The fourth variant is the after folder again with r_retexturing 0 (the URL
// query app.js appends), the engine drawing the WALs: OFF.
//
// Each variant is a fresh page load against its own server.js on a free port
// (never 4231 or 4233, the live app and the control API) with a temporary
// QUAKE2_DATA_DIR, driven over the DevTools pipe exactly as scripts/e2e-saves.js
// does: `map <name>`, wait for the level, `cl_gun 0`, `crosshair 0`, then wait
// until two frames a moment apart match. The console overlay fades out and the
// engine is still uploading textures for a moment after the map loads, and a
// shot taken mid-fade is not the view a player sees -- its Laplacian sits 25-50
// points off the settled one, which is several times the pak9 effect measured
// here.
//
// The views are not a sweep: each map's spawn (view `<map>-spawn`), plus up to
// two more from a targetnamed info_player_start (`map <map>$<targetname>`, read
// out of the BSP's entity lump with loadMap() from control/route.mjs). An extra
// view that does not load on its first try -- or that lands on the spawn view
// pixel for pixel -- is dropped and the rest carry on.
//
// For every view it prints and saves:
//   * mean absolute difference of NEW vs OFF -- the same page and the same two
//     archives with only r_retexturing flipped, so it is the pak9 art alone --
//     of PREV vs NEW, the change this checkout made, and of PREV vs OFF;
//   * the floor to read NEW vs OFF against: the temporal noise, i.e. how much
//     the same view of the same art moves between settled frames. A pak9 shot
//     has to clear 0.5 mean |diff| and twice that jitter, change some pixels
//     and lift the Laplacian. BEFORE vs OFF is printed too, but the material
//     pass also
//     redrew pak0's 1x WALs, so it now measures two changes, not one floor;
//   * the Laplacian energy and mean luma of every shot (mean squared 4-neighbour
//     Laplacian of luma): higher means more high-frequency detail;
//   * `imagelist` line counts, and every engine console line naming a .png (this
//     build logs none -- the list is recorded even when empty);
//   * whether the page fetched pak9.pak, and the size of the engine's own copy.
// The run exits 1 when NEW does not stand clear of the OFF shot, which is what a
// pak the engine never read would look like. (Replacing every pak9 picture with
// solid magenta moved 583,882 pixels of this same view, so a pak it reads is
// unmistakable.) A PREV vs NEW mean |diff| at or below EQUAL_EPS is printed as a
// note, not a failure: the material pass may leave a view untouched. An extra
// view whose `map <map>$<targetname>` lands on the spawn view pixel for pixel is
// dropped the same way: this build's `map` does not honour the targetname.
//
// Output (docs/texture-review/ingame/ by default), under 12 MB in total:
//   <view>-PREV.jpg, <view>-NEW.jpg, <view>-OFF.jpg
//                            the identical frozen view in each variant, JPEG q90
//                            (the numbers below always come from the lossless PNG)
//   <view>-prev-new.png      one labelled PREV | NEW side-by-side per view
//   <map>-before-after.png   the shipped change (BEFORE | AFTER), spawn view
//   shots.json               every number above, plus what was drawn from where
//
// Node built-ins only; the PNG reader is the project's own (texture-lib.mjs) and
// the side-by-side is composed by the same headless browser that took the shots.
//
//   node scripts/texture-shots.mjs                       # demo1, demo2, demo3
//   node scripts/texture-shots.mjs --maps demo1          # one map while working
//   node scripts/texture-shots.mjs --prev b6c2a4f        # the PREV archives' rev
//   node scripts/texture-shots.mjs --keep --verbose      # keep scratch, echo console
//
// Exit: 0 every view shows the pak9 art; 1 one did not (or the run failed).
"use strict";

import fs from "node:fs";
import fsp from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadPristine } from "./hires-art.mjs";
import { decodePng, readPakDirectory } from "./texture-lib.mjs";
import { loadMap } from "../control/route.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_OUT = path.join(ROOT, "docs", "texture-review", "ingame");
const DEFAULT_MAPS = ["demo1", "demo2", "demo3"];
const DEFAULT_PREV_REV = "b6c2a4f"; // the archives before this team's repack
const EXTRA_VIEW_LIMIT = 2; // targetnamed start views beside the spawns
const JPEG_QUALITY = 90;
// The live quake2-app.service and the box's control API: never touched.
const BANNED_PORTS = new Set([4231, 4233]);
const PREFERRED_PORT = 4292;
const SHOT_W = 1024;
const SHOT_H = 768;
const SCENE_SETTLE_MS = 20000; // longest wait for the spawn view to stop changing
const SCENE_SETTLE_EPS = 0.2; // mean |difference| between frames that means "still"
const BOOT_MS = 180000; // PAK download, WASM compile, first frame
const LOAD_MS = 90000; // one map load
const STEP_MS = 30000; // anything the game answers at once
const QUIET_MS = 1500; // console silence that ends a map load
const KEY_GAP_MS = 25;
const EQUAL_EPS = 0.05; // mean |difference| below which two shots are "equal"
const OUTPUT_LIMIT = 12 * 1024 * 1024; // output folder ceiling, per the task

const USAGE = `texture-shots.mjs -- in-game before/after shots for the 4x WAL art

  --maps <list>     comma-separated maps (default ${DEFAULT_MAPS.join(",")})
  --prev <rev>      git revision the PREV archives come from
                    (default ${DEFAULT_PREV_REV}: baseq2/pak0.pak + pak9.pak)
  --out <dir>       where the side-by-sides and shots.json go
                    (default docs/texture-review/ingame)
  --tmp <dir>       scratch folder (default a new folder under ${os.tmpdir()})
  --keep            keep the scratch folder after the run
  --port <n>        preferred server.js port (default ${PREFERRED_PORT})
  --chrome <file>   the browser to drive (default CHROME_BIN or PATH)
  --json            also print the summary as JSON
  --verbose         echo the game's console
  --help            this text
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line) => process.stdout.write(line + "\n");
const step = (title) => log("\n== " + title);
const ok = (what) => log("  ok    " + what);
const note = (what) => log("  note  " + what);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function formatBytes(bytes) {
  return bytes >= 1048576 ? (bytes / 1048576).toFixed(1) + " MiB" : Math.round(bytes / 1024) + " KiB";
}

function onLines(stream, callback) {
  let rest = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const parts = (rest + chunk).split("\n");
    rest = parts.pop();
    for (const line of parts) callback(line.replace(/\r$/, ""));
  });
  stream.on("end", () => {
    if (rest) callback(rest);
  });
}

// ---- Child processes -------------------------------------------------------

const children = new Set();
const sleepers = new Set();

function track(child) {
  children.add(child);
  child.once("exit", () => children.delete(child));
  return child;
}

function signalChild(child, signal) {
  if (!child || !child.pid) return;
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

async function stopChild(child, graceMs = 5000) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolve) => child.once("exit", resolve));
  signalChild(child, "SIGTERM");
  const closed = await Promise.race([exited.then(() => true), sleep(graceMs).then(() => false)]);
  if (!closed) {
    signalChild(child, "SIGKILL");
    await Promise.race([exited, sleep(2000)]);
  }
}

process.on("exit", () => {
  for (const child of children) signalChild(child, "SIGKILL");
});

// ---- Arguments -------------------------------------------------------------

function parseArguments(argv) {
  const options = {
    maps: DEFAULT_MAPS.slice(),
    prev: DEFAULT_PREV_REV,
    out: DEFAULT_OUT,
    tmp: null,
    keep: process.env.TEXTURE_SHOTS_KEEP === "1",
    port: PREFERRED_PORT,
    chrome: null,
    json: false,
    verbose: process.env.TEXTURE_SHOTS_VERBOSE === "1",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(arg + " needs a value");
      return next;
    };
    if (arg === "--maps") options.maps = value().split(",").map((map) => map.trim()).filter(Boolean);
    else if (arg === "--prev") options.prev = value();
    else if (arg === "--out") options.out = value();
    else if (arg === "--tmp") options.tmp = value();
    else if (arg === "--keep") options.keep = true;
    else if (arg === "--port") options.port = Number(value());
    else if (arg === "--chrome") options.chrome = value();
    else if (arg === "--json") options.json = true;
    else if (arg === "--verbose") options.verbose = true;
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error("unknown argument " + JSON.stringify(arg) + " (try --help)");
  }
  if (!options.maps.length) throw new Error("--maps names no map");
  return options;
}

// ---- Ports and the static server -------------------------------------------

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

async function pickPort(preferred) {
  if (preferred && !BANNED_PORTS.has(preferred) && (await probePort(preferred))) return preferred;
  for (;;) {
    const port = await probePort(0);
    if (port && !BANNED_PORTS.has(port)) return port;
  }
}

// Starts `node <appRoot>/server.js` and resolves once it says it is listening.
async function startServer(appRoot, dataDir) {
  for (let attempt = 1; ; attempt++) {
    const port = await pickPort(attempt === 1 ? PREFERRED_PORT : 0);
    assert(!BANNED_PORTS.has(port), "refusing to serve on port " + port);
    const child = track(spawn(process.execPath, [path.join(appRoot, "server.js")], {
      cwd: appRoot,
      env: { ...process.env, PORT: String(port), QUAKE2_DATA_DIR: dataDir },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    }));
    const stderr = [];
    onLines(child.stderr, (line) => stderr.push(line));
    const started = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      const timer = setTimeout(() => finish({ error: new Error("server.js did not start listening within 20 s") }), 20000);
      onLines(child.stdout, (line) => {
        const m = /^Quake 2 static server on http:\/\/127\.0\.0\.1:(\d+)\//.exec(line);
        if (m && Number(m[1]) === port) finish({ child, port });
      });
      child.once("error", (error) => finish({ error }));
      child.once("exit", (code, signal) => finish({
        error: new Error("server.js exited (" + (signal || "code " + code) + ")" + (stderr.length ? ": " + stderr.slice(-3).join(" | ") : "")),
      }));
    });
    if (!started.error) return started;
    await stopChild(child, 2000);
    if (attempt >= 3) throw started.error;
    note("server.js did not start (" + started.error.message + "); trying again");
  }
}

// ---- Chromium over the DevTools pipe ---------------------------------------

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

function findChromium(explicit) {
  const candidates = [];
  if (explicit) candidates.push(explicit);
  if (process.env.CHROME_BIN) candidates.push(process.env.CHROME_BIN);
  for (const dir of (process.env.PATH || "").split(path.delimiter).filter(Boolean)) {
    for (const name of ["google-chrome", "chromium", "chromium-browser"]) candidates.push(path.join(dir, name));
  }
  candidates.push("/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser");
  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return candidate;
  }
  throw new Error("no Chromium found: set CHROME_BIN, or put google-chrome/chromium on PATH");
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
    "--window-size=" + SHOT_W + "," + SHOT_H,
    // Headless has no GPU: WebGL runs on SwiftShader.
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
    "--ignore-gpu-blocklist",
    ...extraArgs,
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
  failed.catch(() => {});
  try {
    const version = await Promise.race([cdp.send("Browser.getVersion", {}, null, 30000), failed]);
    return { child, cdp, version, stderrTail };
  } catch (pipeError) {
    const error = await Promise.race([failed.catch((exit) => exit), sleep(1500).then(() => pipeError)]);
    await stopChild(child, 2000);
    const tail = stderrTail.filter(Boolean).slice(-8).join("\n    ");
    throw new Error("Chromium " + bin + " cannot run here: " + error.message + (tail ? "\n    " + tail : ""));
  }
}

// Tries the browser as found, then once more with --no-sandbox when only its
// sandbox stopped it (it only ever loads this script's local server).
async function startChromium(bin, profileDir) {
  try {
    return await launchChromium(bin, profileDir, []);
  } catch (error) {
    if (!/sandbox|namespace/i.test(error.message)) throw error;
    note("Chromium's own sandbox cannot start here; relaunching with --no-sandbox");
    await fsp.rm(profileDir, { recursive: true, force: true });
    await fsp.mkdir(profileDir, { recursive: true });
    return launchChromium(bin, profileDir, ["--no-sandbox"]);
  }
}

async function closeChromium(browser) {
  if (!browser) return;
  await browser.cdp.send("Browser.close", {}, null, 5000).catch(() => {});
  const exited = new Promise((resolve) => browser.child.once("exit", resolve));
  const closed = await Promise.race([exited.then(() => true), sleep(5000).then(() => false)]);
  if (!closed) await stopChild(browser.child, 3000);
}

// ---- The page --------------------------------------------------------------

const lines = []; // everything a page logged, as { n, type, text }
const lineWaiters = new Set();
let lastLineAt = 0;
let fatal = null;

// eslint-disable-next-line no-control-regex
const clean = (text) => String(text).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");

function recordLine(type, rawText) {
  for (const part of clean(rawText).split("\n")) {
    const line = { n: lines.length, type, text: part.trim() };
    lines.push(line);
    lastLineAt = Date.now();
    if (/^(Error: |Engine aborted|Could not download game data|Could not load the game engine)/.test(line.text)) {
      fatal = new Error("the game reported: " + line.text);
    }
    for (const waiter of [...lineWaiters]) waiter(line);
    if (process.env.TEXTURE_SHOTS_VERBOSE === "1" || verboseMode) log("    [" + type + "] " + line.text);
  }
}

let verboseMode = false;

function remoteValue(arg) {
  if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  return arg.description || arg.unserializableValue || arg.type;
}

function mark() {
  return lines.length;
}

function waitForLine(re, since, timeoutMs, what) {
  const found = lines.slice(since).find((line) => re.test(line.text));
  if (found) return Promise.resolve(found);
  if (fatal) return Promise.reject(fatal);
  return new Promise((resolve, reject) => {
    const waiter = (line) => {
      if (fatal && !re.test(line.text)) {
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

async function waitQuiet(timeoutMs) {
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

async function openPage(cdp, { record = true } = {}) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = new Page(cdp, sessionId);
  page.targetId = targetId;
  if (record) {
    cdp.on((message) => {
      if (message.sessionId !== sessionId) return;
      const p = message.params;
      if (message.method === "Runtime.consoleAPICalled") {
        recordLine(p.type, p.args.map(remoteValue).join(" "));
      } else if (message.method === "Runtime.exceptionThrown") {
        const e = p.exceptionDetails;
        recordLine("exception", (e.exception && e.exception.description) || e.text);
      } else if (message.method === "Log.entryAdded" && p.entry.level === "error") {
        recordLine("browser", p.entry.text + (p.entry.url ? " (" + p.entry.url + ")" : ""));
      }
    });
  }
  await page.send("Page.enable");
  await page.send("Runtime.enable");
  await page.send("Log.enable");
  await page.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await page.send("Page.bringToFront");
  return page;
}

async function closePage(page) {
  await page.cdp.send("Target.closeTarget", { targetId: page.targetId }).catch(() => {});
}

// ---- Keyboard --------------------------------------------------------------

const NAMED_KEYS = {
  Backquote: { key: "`", code: "Backquote", keyCode: 192 },
  Enter: { key: "Enter", code: "Enter", keyCode: 13 },
  Escape: { key: "Escape", code: "Escape", keyCode: 27 },
};

const PUNCTUATION_KEYS = {
  " ": { code: "Space", keyCode: 32 },
  ".": { code: "Period", keyCode: 190 },
  "-": { code: "Minus", keyCode: 189 },
  "_": { code: "Minus", keyCode: 189, shift: true },
  "$": { code: "Digit4", keyCode: 52, shift: true },
};

function charKey(ch) {
  if (/^[a-z]$/.test(ch)) return { code: "Key" + ch.toUpperCase(), keyCode: ch.toUpperCase().charCodeAt(0) };
  if (/^[0-9]$/.test(ch)) return { code: "Digit" + ch, keyCode: ch.charCodeAt(0) };
  if (PUNCTUATION_KEYS[ch]) return PUNCTUATION_KEYS[ch];
  throw new Error("the script cannot type " + JSON.stringify(ch));
}

async function pressKey(page, name) {
  const k = NAMED_KEYS[name];
  const event = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...event });
  await sleep(40);
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...event });
  await sleep(KEY_GAP_MS);
}

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

// ---- The game, driven through its own console ------------------------------

let consoleOpen = false;
let syncCount = 0;

function makeGame(page) {
  const command = async (text) => {
    await typeText(page, text);
    await pressKey(page, "Enter");
  };

  // Makes sure typed text reaches the console: echoes a token (letters only,
  // none bound to a menu or chat key) and toggles the console until it comes back.
  const ensureConsole = async (toggleFirst) => {
    const recovery = ["Backquote", "Backquote", "Escape", "Backquote", "Escape", "Backquote"];
    if (toggleFirst) {
      await pressKey(page, "Backquote");
      await sleep(700);
    }
    for (let attempt = 0; ; attempt++) {
      const token = "shotsmark" + String(++syncCount).replace(/\d/g, (d) => "abcdefghij"[d]);
      const since = mark();
      await command("echo " + token);
      const echoed = await waitForLine(new RegExp("^" + token + "$"), since, 2500).catch((error) => {
        if (error === fatal) throw error;
        return null;
      });
      if (echoed) {
        consoleOpen = true;
        return;
      }
      if (attempt >= recovery.length) throw new Error("typed commands never reached the game's console");
      note("the console did not answer; pressing " + recovery[attempt]);
      await pressKey(page, recovery[attempt]);
      await sleep(900);
    }
  };

  // Opens the console after a shot (it is closed then) and checks it answers.
  const openConsole = async () => {
    await pressKey(page, "Backquote");
    await sleep(700);
    await ensureConsole(false);
  };

  const closeConsole = async () => {
    await pressKey(page, "Backquote");
    await sleep(500);
    consoleOpen = false;
  };

  const cvar = async (name) => {
    const since = mark();
    await command(name);
    const re = new RegExp('^"' + name + '" is "([^"]*)"');
    const line = await waitForLine(re, since, STEP_MS, "the value of " + name);
    return re.exec(line.text)[1];
  };

  // Runs a map-changing command and waits until the game is playable again.
  const changeMap = async (text, expectedMap) => {
    const since = mark();
    await command(text);
    const line = await waitForLine(/^(-+ server initialization -+|No such savegame: .*|USAGE: .*|ERROR: .*)$/i,
      since, LOAD_MS, "`" + text + "` to start the server");
    assert(/server initialization/i.test(line.text), "`" + text + "` failed: " + line.text);
    await waitQuiet();
    // A map typed from the console of a running game keeps the console open;
    // one typed with no game takes the keyboard. Track what we saw, not a guess.
    await ensureConsole(!consoleOpen);
    const mapname = await cvar("mapname");
    assert(mapname === expectedMap, "`" + text + "` left mapname at " + JSON.stringify(mapname) + ", not " + expectedMap);
  };

  return { command, ensureConsole, openConsole, closeConsole, cvar, changeMap };
}

// ---- Screenshots and their numbers -----------------------------------------

async function captureNow(page) {
  const { data } = await page.send("Page.captureScreenshot", { format: "png" }, 30000);
  return Buffer.from(data, "base64");
}

// The stored shot: half the bytes of the PNG for a view nobody measures. Taken
// right after the steady PNG, while timescale 0 still freezes the world.
async function captureJpeg(page) {
  const { data } = await page.send("Page.captureScreenshot", { format: "jpeg", quality: JPEG_QUALITY }, 30000);
  return Buffer.from(data, "base64");
}

function meanLuma(image) {
  let sum = 0;
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  return sum / (image.width * image.height);
}

// Mean squared 4-neighbour Laplacian of luma over the interior: high-frequency
// detail, so a crisper wall scores higher than a smoothed one.
function laplacianEnergy(image) {
  const { width, height, data } = image;
  const luma = new Float32Array(width * height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    luma[p] = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
  }
  let sum = 0;
  let count = 0;
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const p = y * width + x;
      const lap = 4 * luma[p] - luma[p - 1] - luma[p + 1] - luma[p - width] - luma[p + width];
      sum += lap * lap;
      count++;
    }
  }
  return count ? sum / count : 0;
}

function meanAbsDiff(a, b) {
  assert(a.width === b.width && a.height === b.height,
    "the shots differ in size (" + a.width + "x" + a.height + " vs " + b.width + "x" + b.height + ")");
  let sum = 0;
  let differing = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const delta = (Math.abs(a.data[i] - b.data[i]) + Math.abs(a.data[i + 1] - b.data[i + 1]) + Math.abs(a.data[i + 2] - b.data[i + 2])) / 3;
    sum += delta;
    if (delta > 8) differing++;
  }
  const pixels = a.width * a.height;
  return { meanAbsDiff: sum / pixels, differingPixels: differing, pixels };
}

// A first frame can still be black while SwiftShader warms up: wait for a
// picture with something in it.
async function shoot(page) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const png = await captureNow(page);
    const image = decodePng(png);
    if (image.width === SHOT_W && image.height === SHOT_H && meanLuma(image) > 2) return { png, image };
    await sleep(500);
  }
  throw new Error("the game never drew a lit frame (the canvas stayed black)");
}

// The spawn view is not still the moment the map loads: the console fades out,
// the status bar redraws and the engine is still uploading textures, so a shot
// taken two seconds after `map` is not yet the picture a player sees. Take
// frames a moment apart and keep the first one that matches its predecessor;
// the second and third shots of the same view a second apart differed by a
// whole Laplacian point, which is plenty to hide the very effect being proved.
async function shootSteady(page) {
  let previous = await shoot(page);
  const frames = [laplacianEnergy(previous.image)];
  let lastDelta = null;
  const deadline = Date.now() + SCENE_SETTLE_MS;
  while (Date.now() < deadline) {
    await sleep(600);
    const next = await shoot(page);
    frames.push(laplacianEnergy(next.image));
    lastDelta = meanAbsDiff(previous.image, next.image);
    previous = next;
    if (lastDelta.meanAbsDiff <= SCENE_SETTLE_EPS) {
      return { png: next.png, image: next.image, frames, lastDelta };
    }
  }
  throw new Error("the spawn view never stopped changing (the last two frames differed by mean |diff| " +
    (lastDelta ? lastDelta.meanAbsDiff.toFixed(2) : "n/a") + " over " + frames.length + " frames)");
}

// ---- The side-by-side composite --------------------------------------------

const MARGIN = 16;
const GAP = 16;

// Renders a labelled side-by-side in the browser that took the shots (its PNG
// encoder is the one we already have) and returns its bytes. `spec` is
// { title, subtitle, left: { png, label, note }, right: { png, label, note },
// caption }, so the caller says what the two halves are; `format` "jpeg" writes
// the whole board as JPEG_QUALITY for the folder-size fallback.
async function compose(cdp, spec, scale = 1, format = "png") {
  const page = await openPage(cdp, { record: false });
  const imageW = Math.round(SHOT_W * scale);
  const imageH = Math.round(SHOT_H * scale);
  const width = imageW * 2 + GAP + 2 * MARGIN;
  const text = {
    title: spec.title,
    subtitle: spec.subtitle,
    caption: spec.caption,
    left: { label: spec.left.label, note: spec.left.note },
    right: { label: spec.right.label, note: spec.right.note },
  };
  try {
    await page.send("Emulation.setDeviceMetricsOverride", {
      width, height: 1200, deviceScaleFactor: 1, mobile: false,
    });
    await page.evaluate("window.__shots = " + JSON.stringify([
      spec.left.png.toString("base64"),
      spec.right.png.toString("base64"),
    ]) + "; \"ok\"", 60000);
    const height = await page.evaluate(`(() => {
      const [a, b] = window.__shots;
      const spec = ${JSON.stringify(text)};
      document.documentElement.style.background = "#0b0b0d";
      document.body.style.cssText = "margin:0;background:#0b0b0d;color:#e6e6e6;font:14px/1.4 system-ui,'DejaVu Sans',sans-serif";
      const figure = (src, label, sub) => {
        const fig = document.createElement("figure");
        fig.style.cssText = "margin:0";
        const img = document.createElement("img");
        img.src = "data:image/png;base64," + src;
        img.width = ${imageW};
        img.height = ${imageH};
        img.style.cssText = "display:block";
        const cap = document.createElement("figcaption");
        cap.style.cssText = "padding-top:6px;color:#c9d1d9";
        const name = document.createElement("b");
        name.textContent = label;
        cap.append(name, " — " + sub);
        fig.append(img, cap);
        return fig;
      };
      const head = document.createElement("div");
      head.style.cssText = "padding:${MARGIN}px ${MARGIN}px 0";
      const title = document.createElement("div");
      title.style.cssText = "font-size:20px;font-weight:600";
      title.textContent = spec.title;
      const subtitle = document.createElement("div");
      subtitle.style.cssText = "color:#9aa4b2";
      subtitle.textContent = spec.subtitle;
      head.append(title, subtitle);
      const row = document.createElement("div");
      row.style.cssText = "display:flex;gap:${GAP}px;padding:10px ${MARGIN}px 0";
      row.append(figure(a, spec.left.label, spec.left.note), figure(b, spec.right.label, spec.right.note));
      const foot = document.createElement("div");
      foot.style.cssText = "padding:8px ${MARGIN}px 0;color:#9fe3a0;font-variant-numeric:tabular-nums";
      foot.textContent = spec.caption;
      document.body.replaceChildren(head, row, foot);
      return Promise.all(Array.from(document.images, (img) => img.decode().catch(() => {})))
        .then(() => Math.ceil(Math.max(...Array.from(document.body.children,
          (element) => element.getBoundingClientRect().bottom))));
    })()`, 60000);
    const contentHeight = Math.max(200, height);
    await page.send("Emulation.setDeviceMetricsOverride", {
      width, height: contentHeight, deviceScaleFactor: 1, mobile: false,
    });
    await sleep(200);
    const shotParams = format === "jpeg"
      ? { format: "jpeg", quality: JPEG_QUALITY }
      : { format: "png" };
    const { data } = await page.send("Page.captureScreenshot", {
      ...shotParams,
      clip: { x: 0, y: 0, width, height: contentHeight, scale: 1 },
      captureBeyondViewport: true,
    }, 60000);
    const bytes = Buffer.from(data, "base64");
    if (format === "jpeg") return bytes;
    const decoded = decodePng(bytes);
    assert(decoded.width === width && decoded.height === contentHeight,
      "the composite came out " + decoded.width + "x" + decoded.height + ", not " + width + "x" + contentHeight);
    return bytes;
  } finally {
    await closePage(page);
  }
}

// ---- Scratch app roots -----------------------------------------------------

const APP_FILES = ["index.html", "app.js", "engine-state.js", "style.css", "server.js", "favicon.ico", "favicon.png"];

// server.js serves its own folder, so each variant gets its own copy of the
// small app files; engine/ (3 MB of WASM) is symlinked. server.js itself must
// be a real file: Node resolves a symlinked entry point to its real folder.
function makeAppRoot(rootDir) {
  fs.mkdirSync(path.join(rootDir, "baseq2"), { recursive: true });
  for (const name of APP_FILES) {
    const from = path.join(ROOT, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(rootDir, name));
  }
  fs.symlinkSync(path.join(ROOT, "engine"), path.join(rootDir, "engine"), "dir");
}

// Writes one archive out of git history straight into `dest`. stdout goes to a
// file descriptor: execFileSync's 1 MiB maxBuffer cannot hold a 50 MB blob.
function extractGitBlob(rev, entry, dest) {
  let fd = fs.openSync(dest, "w");
  return new Promise((resolve, reject) => {
    const child = track(spawn("git", ["-C", ROOT, "cat-file", "blob", rev + ":" + entry], {
      stdio: ["ignore", fd, "pipe"],
    }));
    let err = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { err += chunk; });
    const finish = (error) => {
      if (fd !== null) {
        fs.closeSync(fd);
        fd = null;
      }
      if (error) reject(error);
      else resolve(fs.statSync(dest).size);
    };
    child.once("error", (error) => finish(error));
    child.once("exit", (code) => {
      const size = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
      if (code === 0 && size > 0) return finish(null);
      fs.rmSync(dest, { force: true });
      finish(new Error("--prev " + rev + " has no " + entry +
        (err.trim() ? " (" + err.trim().split("\n").pop() + ")" : "")));
    });
  });
}

// Up to EXTRA_VIEW_LIMIT further views, one per map in turn: the first
// info_player_start carrying a targetname, which `map <map>$<targetname>` picks.
async function extraViews(maps) {
  const views = [];
  for (const map of maps) {
    if (views.length >= EXTRA_VIEW_LIMIT) break;
    let loaded;
    try {
      loaded = await loadMap(map);
    } catch (error) {
      note("no route data for " + map + " (" + error.message + ")");
      continue;
    }
    const start = loaded.entities.find((entity) => entity.classname === "info_player_start" && entity.targetname);
    if (!start) continue;
    views.push({
      name: map + "-" + start.targetname,
      map,
      command: "map " + map + "$" + start.targetname,
      extra: true,
    });
  }
  return views;
}

// Runs one of this checkout's node scripts and resolves with its output.
function runNode(script, args, { cwd = ROOT, timeoutMs = 300000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = track(spawn(process.execPath, [script, ...args], { cwd, stdio: ["ignore", "pipe", "pipe"] }));
    let out = "";
    let err = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { out += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { err += chunk; });
    const timer = setTimeout(() => {
      signalChild(child, "SIGKILL");
      reject(new Error(path.basename(script) + " did not finish within " + timeoutMs / 1000 + " s"));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(path.basename(script) + " failed (" + (signal || "code " + code) + ")\n" + err.trim() + (out.trim() ? "\n" + out.trim() : "")));
    });
  });
}

// ---- Main ------------------------------------------------------------------

async function run(options) {
  const scratch = options.tmp
    ? path.resolve(options.tmp)
    : await fsp.mkdtemp(path.join(os.tmpdir(), "quake2-texture-shots-"));
  const outDir = path.resolve(ROOT, options.out);
  const beforeRoot = path.join(scratch, "before");
  const prevRoot = path.join(scratch, "prev");
  const afterRoot = path.join(scratch, "after");
  const dataRoot = path.join(scratch, "data");
  const profileDir = path.join(scratch, "profile");
  const rawDir = path.join(scratch, "raw");
  for (const dir of [dataRoot, profileDir, rawDir]) fs.mkdirSync(dir, { recursive: true });
  const ctx = { scratch, browsers: [], servers: [], page: null, outDir };
  const cleanup = async () => {
    for (const page of ctx.pages || []) await closePage(page).catch(() => {});
    for (const browser of ctx.browsers) await closeChromium(browser).catch(() => {});
    for (const server of ctx.servers) await stopChild(server, 3000).catch(() => {});
    if (options.keep) note("kept the scratch folder " + scratch);
    else await fsp.rm(scratch, { recursive: true, force: true }).catch(() => {});
  };
  try {
    return await runWith(ctx, options, { scratch, outDir, beforeRoot, prevRoot, afterRoot, dataRoot, profileDir, rawDir });
  } finally {
    await cleanup();
  }
}

async function runWith(ctx, options, dirs) {
  const { outDir, beforeRoot, prevRoot, afterRoot, dataRoot, profileDir, rawDir } = dirs;
  verboseMode = options.verbose;
  fs.mkdirSync(outDir, { recursive: true });

  // -- 1. The archives -------------------------------------------------------
  step("Build the BEFORE, PREV and AFTER app folders");

  makeAppRoot(beforeRoot);
  makeAppRoot(prevRoot);
  makeAppRoot(afterRoot);
  const pristine = loadPristine();
  fs.writeFileSync(path.join(beforeRoot, "baseq2", "pak0.pak"), pristine.pak);
  ok("BEFORE: pak0.pak from " + pristine.source + " (" + formatBytes(pristine.pak.length) + "), no pak9.pak");
  assert(!fs.existsSync(path.join(beforeRoot, "baseq2", "pak9.pak")), "the BEFORE folder already holds a pak9.pak");

  const afterPak = path.join(afterRoot, "baseq2", "pak0.pak");
  const packed = await runNode(path.join(ROOT, "scripts", "texture-pack.mjs"), ["--out", afterPak]);
  const packLine = packed.out.trim().split("\n").pop();
  ok("AFTER: " + packLine);
  const pak9Path = path.join(afterRoot, "baseq2", "pak9.pak");
  assert(fs.existsSync(pak9Path), "texture-pack did not write a pak9.pak beside " + afterPak);
  const pak9 = fs.readFileSync(pak9Path);
  const pak9Names = [...readPakDirectory(pak9).keys()].filter((name) => /\.png$/i.test(name));
  assert(pak9Names.length > 0, "pak9.pak holds no .png entries");
  ok("pak9.pak: " + pak9Names.length + " PNG(s), " + formatBytes(pak9.length) + " (first: " + pak9Names[0] + ")");

  // PREV: the previous team's two archives, straight out of git. pak9.pak is
  // required -- without it "previous" would silently mean "before".
  const prevSizes = {};
  for (const entry of ["pak0.pak", "pak9.pak"]) {
    const dest = path.join(prevRoot, "baseq2", entry);
    prevSizes[entry] = await extractGitBlob(options.prev, "baseq2/" + entry, dest);
    assert(fs.readFileSync(dest).toString("latin1", 0, 4) === "PACK",
      "--prev " + options.prev + ":baseq2/" + entry + " is not a PAK");
  }
  const prevPak9 = fs.readFileSync(path.join(prevRoot, "baseq2", "pak9.pak"));
  const prevPak9Names = [...readPakDirectory(prevPak9).keys()].filter((name) => /\.png$/i.test(name));
  assert(prevPak9Names.length > 0, "--prev " + options.prev + ":baseq2/pak9.pak holds no .png entries");
  ok("PREV: pak0.pak " + formatBytes(prevSizes["pak0.pak"]) + ", pak9.pak " + formatBytes(prevSizes["pak9.pak"]) +
    " (" + prevPak9Names.length + " PNG(s)) from " + options.prev);

  // -- 2. The browser --------------------------------------------------------
  step("Start headless Chromium");
  const chrome = findChromium(options.chrome);
  const profile = path.join(profileDir, "main");
  fs.mkdirSync(profile, { recursive: true });
  const browser = await startChromium(chrome, profile);
  ctx.browsers.push(browser);
  ok(browser.version.product + " from " + chrome + " over --remote-debugging-pipe");

  const page = await openPage(browser.cdp);
  ctx.page = page;
  ctx.pages = [page];
  await page.send("Emulation.setDeviceMetricsOverride", {
    width: SHOT_W, height: SHOT_H, deviceScaleFactor: 1, mobile: false,
  });
  // Every variant is served on the same origin, and server.js says
  // "Cache-Control: max-age=3600" for the PAKs: without this, the AFTER page
  // would be handed the BEFORE archive out of the HTTP cache and the
  // comparison would quietly become nonsense.
  await page.send("Network.enable");
  await page.send("Network.setCacheDisabled", { cacheDisabled: true });

  const game = makeGame(page);
  let rendererTokens = null; // filled in when the default renderer cannot start

  const appUrl = (port, retexturingOn) => {
    const tokens = [];
    if (rendererTokens) tokens.push(...rendererTokens);
    tokens.push("+set", "r_retexturing", retexturingOn ? "1" : "0");
    return "http://127.0.0.1:" + port + "/apps/quake2/?" + tokens.join("&");
  };

  const boot = async (port, retexturingOn, label) => {
    for (let attempt = 0; ; attempt++) {
      const since = mark();
      consoleOpen = false;
      const loaded = page.waitForEvent("Page.loadEventFired", BOOT_MS);
      await page.send("Page.navigate", { url: appUrl(port, retexturingOn) }, 30000);
      await loaded;
      try {
        await waitUntil(() => page.evaluate("document.getElementById('canvas') && document.getElementById('canvas').style.display === 'block'"),
          BOOT_MS, "the engine to show its canvas");
        await waitForLine(/^==== Yamagi Quake II Initialized ====$/, since, BOOT_MS, "the engine to initialise");
        await waitQuiet();
        await game.ensureConsole(true);
        return;
      } catch (error) {
        if (attempt === 0 && !rendererTokens && /canvas|initialise|WebGL|Error: /.test(error.message)) {
          note("the engine did not start with WebGL (" + error.message + "); retrying with the software renderer");
          fatal = null;
          rendererTokens = ["+set", "vid_renderer", "soft"];
          continue;
        }
        throw new Error(label + ": " + error.message);
      }
    }
  };

  // -- 3. Shoot every variant ------------------------------------------------
  const variants = [
    { key: "before", label: "BEFORE (original pak0.pak)", root: beforeRoot, retexturingOn: true, store: false },
    { key: "prev", label: "PREV (archives at " + options.prev + ")", root: prevRoot, retexturingOn: true, store: true },
    { key: "after", label: "NEW (pak0.pak + pak9.pak)", root: afterRoot, retexturingOn: true, store: true },
    { key: "retexturingOff", label: "NEW with r_retexturing 0", root: afterRoot, retexturingOn: false, store: true },
  ];
  // A handful of representative views: each map's spawn, then up to
  // EXTRA_VIEW_LIMIT targetnamed starts.
  const views = options.maps.map((map) => ({ name: map + "-spawn", map, command: "map " + map }))
    .concat(await extraViews(options.maps));
  const extras = views.filter((view) => view.extra);
  if (extras.length) ok("extra view(s): " + extras.map((view) => view.command).join(", "));
  const shots = {}; // view -> variant -> { image, png, jpeg, laplacian, luma, pngLines }
  const droppedViews = new Set(); // extra views the game would not load
  const fetches = {}; // variant -> resource timing entries for pak9.pak
  const engineState = {}; // variant -> { pak9InEngine, cvars }

  for (const variant of variants) {
    step("Shoot " + variant.label);
    const server = await startServer(variant.root, path.join(dataRoot, variant.key));
    ctx.servers.push(server.child);
    ok("server.js on 127.0.0.1:" + server.port + " serving " + variant.root);
    await boot(server.port, variant.retexturingOn, variant.label);
    const pak9Fetch = await page.evaluate("performance.getEntriesByType('resource')" +
      ".filter((e) => /pak9\\.pak/.test(e.name))" +
      ".map((e) => ({ url: e.name, transferSize: e.transferSize }))");
    fetches[variant.key] = pak9Fetch;
    // The engine's own MEMFS is what matters: app.js writes every downloaded
    // archive there before the engine starts.
    const pak9InEngine = await page.evaluate("(() => { try { return FS.stat('/baseq2/pak9.pak').size; } catch (error) { return -1; } })()");
    fetches[variant.key + "InEngine"] = pak9InEngine;
    if (variant.key !== "before" && !pak9Fetch.length) note("the page never fetched pak9.pak");
    if (variant.key !== "before") ok("page fetched pak9.pak (" + (pak9Fetch[0] && pak9Fetch[0].transferSize) + " bytes), engine FS holds " + pak9InEngine + " bytes");
    const cvars = {};
    // r_retexturing is the switch that turns the pak9 lookup on; gl_texturemode
    // and vid_gamma shape the image and are saved so a surprising shot can be
    // explained rather than guessed at.
    for (const name of ["r_retexturing", "gl_texturemode", "vid_gamma"]) {
      cvars[name] = await game.cvar(name).catch((error) => "error: " + error.message);
    }
    engineState[variant.key] = { pak9InEngine, cvars };
    ok("engine: r_retexturing " + cvars.r_retexturing +
      ", gl_texturemode " + cvars.gl_texturemode + ", vid_gamma " + cvars.vid_gamma);

    for (const view of views) {
      if (droppedViews.has(view.name)) continue;
      const since = mark();
      try {
        await game.changeMap(view.command, view.map);
      } catch (error) {
        // An extra view is optional: if it will not load on its first try, drop
        // it and the rest of the run carries on with the spawn views.
        if (view.extra && !shots[view.name]) {
          note("dropping the extra view " + view.name + " (" + error.message + ")");
          droppedViews.add(view.name);
          continue;
        }
        throw error;
      }
      await game.command("cl_gun 0");
      await game.command("crosshair 0");
      // Freeze the world: a Strogg's idle animation or a blinking light keeps
      // changing the same view between shots, and on demo2 that noise alone
      // moved the Laplacian by more than the pak9 art did. With timescale 0
      // the two shots of the SAME art become identical, so everything NEW
      // changes is pak9's -- and the world is still drawn every frame.
      await game.command("timescale 0");
      await game.closeConsole();
      const shot = await shootSteady(page);
      // The stored shot is JPEG q90, taken while the world is still frozen; the
      // numbers below always come from the lossless PNG.
      const jpeg = variant.store ? await captureJpeg(page) : null;
      await fsp.writeFile(path.join(rawDir, view.name + "-" + variant.key + ".png"), shot.png);
      const frames = shot.frames.map((value) => Number(value.toFixed(2)));
      note(view.name + " " + variant.key + " settled after " + frames.length + " frame(s) (Laplacian " +
        frames.join(" → ") + ", last frame-to-frame mean |diff| " + shot.lastDelta.meanAbsDiff.toFixed(3) + ")");
      await game.openConsole();
      await game.command("timescale 1"); // let the next map load move again
      // The renderer's own inventory, one line per texture it has loaded. It is
      // the engine saying which art it kept, independent of any pixel metric.
      const listSince = mark();
      await game.command("imagelist");
      await sleep(1500);
      const imageList = lines.slice(listSince).map((line) => line.text);
      const imageListPng = imageList.filter((text) => /\.png\b/i.test(text));
      await fsp.writeFile(path.join(rawDir, view.name + "-" + variant.key + "-imagelist.txt"), imageList.join("\n") + "\n");
      const pngLines = lines.slice(since).map((line) => line.text).filter((text) => /\.png\b/i.test(text));
      const image = shot.image;
      (shots[view.name] || (shots[view.name] = {}))[variant.key] = {
        image,
        png: shot.png,
        jpeg,
        bytes: shot.png.length,
        laplacian: laplacianEnergy(image),
        meanLuma: meanLuma(image),
        settleFrames: frames,
        settleDelta: shot.lastDelta.meanAbsDiff,
        pngLines,
        imageList: {
          lines: imageList.length,
          png: imageListPng.slice(0, 20),
          textureSample: imageList.filter((text) => /textures\//i.test(text)).slice(0, 8),
        },
      };
      ok(view.name + ": " + variant.key + " " + SHOT_W + "x" + SHOT_H + ", Laplacian " + laplacianEnergy(image).toFixed(2) +
        ", imagelist " + imageList.length + " line(s)" +
        (imageListPng.length ? ", " + imageListPng.length + " naming .png" : "") +
        (pngLines.length ? ", " + pngLines.length + " .png console line(s)" : ""));
      // `map <map>$<targetname>` only means something if the engine honoured the
      // start. A view that is the spawn view pixel for pixel is dropped; the
      // console is open and timescale is back at 1, so the next view carries on.
      const spawnShot = view.extra && shots[view.map + "-spawn"] && shots[view.map + "-spawn"][variant.key];
      if (spawnShot) {
        const delta = meanAbsDiff(spawnShot.image, image);
        if (delta.meanAbsDiff <= EQUAL_EPS) {
          note("dropping the extra view " + view.name + ": it is the spawn view (mean |diff| " +
            delta.meanAbsDiff.toFixed(3) + "), so `" + view.command + "` did not honour the targetname");
          droppedViews.add(view.name);
          delete shots[view.name];
        }
      }
    }
    await stopChild(server.child, 3000).catch(() => {});
  }

  // -- 4. Numbers and the side-by-sides --------------------------------------
  step("Compare and compose");
  const report = {
    schema: 2,
    generatedAt: new Date().toISOString(),
    engine: browser.version.product,
    chrome,
    prevRevision: options.prev,
    pak: {
      pristine: { source: pristine.source, bytes: pristine.pak.length },
      prev: { pak0: prevSizes["pak0.pak"], pak9: prevSizes["pak9.pak"], pak9Entries: prevPak9Names.length },
      pak9: { bytes: pak9.length, entries: pak9Names.length, first: pak9Names[0] },
    },
    pak9Fetch: fetches,
    engineState,
    views: [],
  };
  const failures = [];
  const jobs = []; // composites: { entry, field, base, spec }

  for (const view of views) {
    if (droppedViews.has(view.name)) continue;
    const set = shots[view.name];
    assert(set && set.prev && set.after && set.retexturingOff, "the shots for " + view.name + " are incomplete");
    // NEW and OFF are the same page and the same two archives, with only
    // r_retexturing flipped: their difference is the pak9 art, and nothing
    // else. The floor it has to clear is the temporal noise -- how much the
    // SAME view of the SAME art moves between settled frames -- because the
    // material pass also redrew pak0's 1x WALs, so BEFORE vs OFF now measures
    // two changes (reported, but not a lower bound). PREV vs NEW is this
    // checkout's change.
    const newVsOff = meanAbsDiff(set.after.image, set.retexturingOff.image);
    const prevVsNew = meanAbsDiff(set.prev.image, set.after.image);
    const prevVsOff = meanAbsDiff(set.prev.image, set.retexturingOff.image);
    const beforeVsOff = meanAbsDiff(set.before.image, set.retexturingOff.image);
    const noise = Math.max(0.001, set.prev.settleDelta, set.after.settleDelta, set.retexturingOff.settleDelta);
    // A change the eye would see (0.5 mean |diff|) and well clear of the
    // same-view jitter; at least some pixels actually moved off their old
    // colour; and the Laplacian lifted. A pak the engine never read changes
    // zero pixels and leaves the Laplacian alone (two settled frames of the
    // same art are within 0.2 of each other by construction, so 0.5 sits above
    // anything jitter alone can produce).
    const floor = Math.max(0.5, 2 * noise);
    const lapGap = set.after.laplacian - set.retexturingOff.laplacian;
    const drawnShare = newVsOff.differingPixels / newVsOff.pixels;
    const drawn = newVsOff.meanAbsDiff > floor && drawnShare > 0.0001 && Math.abs(lapGap) > 0.1;
    const signalToNoise = newVsOff.meanAbsDiff / noise;
    const equal = prevVsNew.meanAbsDiff <= EQUAL_EPS;
    if (!drawn) {
      failures.push(view.name + ": the NEW shot does not stand clear of the OFF shot (mean |diff| " +
        newVsOff.meanAbsDiff.toFixed(3) + " against the " + floor.toFixed(3) + " noise floor; " +
        (drawnShare * 100).toFixed(2) + "% of pixels differ; Laplacian gap " + lapGap.toFixed(2) +
        "), so the engine did not draw the pak9 art");
    }
    if (equal) {
      note(view.name + ": PREV and NEW are equal (mean |diff| " + prevVsNew.meanAbsDiff.toFixed(3) +
        " at or below " + EQUAL_EPS + "): this view keeps the same pixels, which is a note, not a failure");
    }
    const numbers = (diff) => "mean |Δ| " + diff.meanAbsDiff.toFixed(2) + " (" + diff.differingPixels + " px)";
    const caption = "NEW vs OFF (pak9): " + numbers(newVsOff) + " · PREV vs NEW (this change): " +
      numbers(prevVsNew) + " · BEFORE vs OFF (the material pass on pak0's 1x art): " + numbers(beforeVsOff) + " · " +
      signalToNoise.toFixed(1) + "× · Laplacian PREV " + set.prev.laplacian.toFixed(1) +
      " / NEW " + set.after.laplacian.toFixed(1) + " / OFF " + set.retexturingOff.laplacian.toFixed(1);
    log("");
    log("  " + view.name + (view.extra ? "  (`" + view.command + "`)" : ""));
    log("    mean |diff| NEW vs OFF:      " + newVsOff.meanAbsDiff.toFixed(3) +
      "  (" + newVsOff.differingPixels + " of " + newVsOff.pixels + " pixels differ by more than 8)");
    log("    mean |diff| PREV vs NEW:     " + prevVsNew.meanAbsDiff.toFixed(3) +
      "  (" + prevVsNew.differingPixels + " pixels differ)" + (equal ? "  — equal" : ""));
    log("    mean |diff| PREV vs OFF:     " + prevVsOff.meanAbsDiff.toFixed(3) +
      "  (" + prevVsOff.differingPixels + " pixels differ)");
    log("    mean |diff| BEFORE vs OFF:   " + beforeVsOff.meanAbsDiff.toFixed(3) +
      "  (" + beforeVsOff.differingPixels + " pixels differ) — informational, not a bound");
    log("    signal / noise: " + signalToNoise.toFixed(1) + "×  (NEW vs OFF over the same-view temporal noise " +
      noise.toFixed(3) + "; the bar is max(0.5, 2× noise) = " + floor.toFixed(3) + "), " +
      (drawnShare * 100).toFixed(2) + "% of pixels differ");
    log("    Laplacian energy: PREV " + set.prev.laplacian.toFixed(2) +
      " · NEW " + set.after.laplacian.toFixed(2) +
      " · OFF " + set.retexturingOff.laplacian.toFixed(2) + "  (pak9 gap " + lapGap.toFixed(2) + ")");
    log("    mean luma: PREV " + set.prev.meanLuma.toFixed(2) + " · NEW " + set.after.meanLuma.toFixed(2) +
      " · OFF " + set.retexturingOff.meanLuma.toFixed(2));
    const pngLines = set.after.pngLines;
    log("    engine console .png lines: " + (pngLines.length ? pngLines.length : "none"));
    const listPng = set.after.imageList;
    log("    imagelist: " + listPng.lines + " line(s)" + (listPng.png.length ? ", " + listPng.png.length + " naming .png" : ""));

    const stats = (shot) => ({ laplacian: round(shot.laplacian), meanLuma: round(shot.meanLuma), bytes: shot.bytes });
    const diffStats = (diff) => ({
      meanAbsDiff: round(diff.meanAbsDiff, 4), differingPixels: diff.differingPixels, pixels: diff.pixels,
    });
    const entry = {
      view: view.name,
      map: view.map,
      command: view.command,
      files: {
        prev: view.name + "-PREV.jpg", new: view.name + "-NEW.jpg", off: view.name + "-OFF.jpg",
        prevNew: null, beforeAfter: null,
      },
      prev: stats(set.prev),
      new: stats(set.after),
      off: stats(set.retexturingOff),
      before: stats(set.before),
      diff: {
        prevVsNew: diffStats(prevVsNew),
        newVsOff: diffStats(newVsOff),
        prevVsOff: diffStats(prevVsOff),
        beforeVsOff: diffStats(beforeVsOff),
      },
      prevVsNewEqual: equal,
      signalToNoise: round(signalToNoise, 2),
      laplacianGap: round(lapGap, 3),
      reference: "NEW vs OFF flips only r_retexturing on the same two archives, so it is the pak9 art " +
        "alone and stands " + signalToNoise.toFixed(1) + "x above the same-view temporal noise " +
        noise.toFixed(3) + "; BEFORE vs OFF also includes the material pass's redraw of pak0's 1x WALs, " +
        "so it is reported but is no longer a lower bound; PREV vs NEW is this checkout's change",
      temporalNoise: {
        prev: round(set.prev.settleDelta, 4),
        new: round(set.after.settleDelta, 4),
        off: round(set.retexturingOff.settleDelta, 4),
        note: "mean |diff| between the last two settled frames of the same view",
      },
      consolePngLines: { prev: set.prev.pngLines, new: set.after.pngLines, off: set.retexturingOff.pngLines },
      imagelist: {
        prev: { lines: set.prev.imageList.lines, png: set.prev.imageList.png },
        new: { lines: set.after.imageList.lines, png: set.after.imageList.png },
        off: { lines: set.retexturingOff.imageList.lines, png: set.retexturingOff.imageList.png },
      },
      verdict: drawn
        ? "pak9 art drawn (NEW moves the view " + signalToNoise.toFixed(1) + "x the settled-frame noise, Laplacian " +
          (lapGap >= 0 ? "+" : "") + lapGap.toFixed(2) + ")"
        : "pak9 art NOT provably drawn (NEW does not stand clear of OFF)",
    };
    report.views.push(entry);

    jobs.push({
      entry, field: "prevNew", base: view.name + "-prev-new",
      spec: {
        title: view.name + " — PREV | NEW",
        subtitle: "left: the previous team's archives at " + options.prev +
          " · right: this checkout's baseq2/pak0.pak + pak9.pak (material pass, 4x art through r_retexturing)",
        left: { png: set.prev.png, label: "PREV", note: "baseq2/pak0.pak + pak9.pak at " + options.prev },
        right: { png: set.after.png, label: "NEW", note: "baseq2/pak0.pak + pak9.pak from the material pass" },
        caption,
      },
    });
    if (!view.extra) {
      jobs.push({
        entry, field: "beforeAfter", base: view.map + "-before-after",
        spec: {
          title: view.map + " — BEFORE | AFTER",
          subtitle: "left: pak0.pak only (the demo's original WAL art) · right: pak0.pak + pak9.pak (4x PNG art through r_retexturing)",
          left: { png: set.before.png, label: "BEFORE", note: "baseq2/pak0.pak, no pak9.pak" },
          right: { png: set.after.png, label: "AFTER", note: "baseq2/pak0.pak + pak9.pak" },
          caption,
        },
      });
    }
  }

  // The singles: JPEG q90 of the identical frozen view. The metrics above come
  // from the lossless PNGs, which never leave the scratch folder.
  for (const entry of report.views) {
    const set = shots[entry.view];
    for (const [variant, field] of [["prev", "prev"], ["after", "new"], ["retexturingOff", "off"]]) {
      fs.writeFileSync(path.join(outDir, entry.files[field]), set[variant].jpeg);
    }
  }

  const writeComposites = async (scale, format) => {
    for (const job of jobs) {
      const name = job.base + (format === "jpeg" ? ".jpg" : ".png");
      const previous = job.entry.files[job.field];
      if (previous && previous !== name) fs.rmSync(path.join(outDir, previous), { force: true });
      const bytes = await compose(browser.cdp, job.spec, scale, format);
      fs.writeFileSync(path.join(outDir, name), bytes);
      job.entry.files[job.field] = name;
      ok("side-by-side: " + name + " (" + formatBytes(bytes.length) + ")");
    }
  };
  await writeComposites(1, "png");

  report.summary = {
    views: report.views.length,
    maps: options.maps.length,
    drawn: report.views.length - failures.length,
    failures,
    droppedViews: [...droppedViews],
    retexturing: "r_retexturing on; OFF is the same archive through the URL query app.js appends",
    compositeScale: 1,
    compositeFormat: "png",
    outputBytes: 0,
  };
  const shotsJson = path.join(outDir, "shots.json");
  const writeReport = () => fs.writeFileSync(shotsJson, JSON.stringify(report, null, 2) + "\n");
  // The figure is what a reader of shots.json wants, so measure the folder with
  // this report in it: write once to learn the size, then again with it set.
  writeReport();
  report.summary.outputBytes = outputSize(outDir);

  // The output folder must stay under 12 MiB: recompose the side-by-sides
  // smaller if the first pass was too heavy (the shots themselves are never
  // scaled), and encode them as JPEG q90 if even that is not enough.
  if (report.summary.outputBytes > OUTPUT_LIMIT) {
    note("the output is " + formatBytes(report.summary.outputBytes) + ", over the 12 MiB ceiling; recomposing at 3/4 size");
    report.summary.compositeScale = 0.75;
    await writeComposites(0.75, "png");
    writeReport();
    report.summary.outputBytes = outputSize(outDir);
  }
  if (report.summary.outputBytes > OUTPUT_LIMIT) {
    note("the output is still " + formatBytes(report.summary.outputBytes) + "; encoding the side-by-sides as JPEG q" +
      JPEG_QUALITY + " too");
    report.summary.compositeScale = 1;
    report.summary.compositeFormat = "jpeg";
    await writeComposites(1, "jpeg");
    writeReport();
    report.summary.outputBytes = outputSize(outDir);
  }
  if (report.summary.outputBytes > OUTPUT_LIMIT) {
    note("the output is still " + formatBytes(report.summary.outputBytes) + " over the " + formatBytes(OUTPUT_LIMIT) + " ceiling");
  }
  // Write once more so the figure travels in the file it measures.
  report.summary.outputBytes = outputSize(outDir);
  writeReport();

  step("Summary");
  log("  " + report.summary.drawn + "/" + report.summary.views + " views show the pak9 art (" +
    report.summary.maps + " map(s), PREV from " + options.prev + "); output " +
    formatBytes(report.summary.outputBytes) + " in " + path.relative(ROOT, outDir) + "/");
  if (droppedViews.size) log("  dropped extra view(s): " + [...droppedViews].join(", "));
  for (const failure of failures) log("  FAIL " + failure);
  if (options.json) log(JSON.stringify(report, null, 2));
  return failures.length ? 1 : 0;
}

function round(value, digits = 2) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function outputSize(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) total += fs.statSync(path.join(dir, name)).size;
  return total;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(error.message + "\n");
    return 2;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  verboseMode = options.verbose;
  let code = 0;
  try {
    code = await run(options);
  } catch (error) {
    process.stderr.write("\nFAIL: " + (error && error.stack ? error.stack : String(error)) + "\n");
    if (lines.length) {
      process.stderr.write("\nLast console lines:\n" +
        lines.slice(-25).map((line) => "  " + line.type + ": " + line.text).join("\n") + "\n");
    }
    code = 1;
  }
  return code;
}

main().then((code) => {
  process.exitCode = code;
});
