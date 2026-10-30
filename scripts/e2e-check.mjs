#!/usr/bin/env node
// End-to-end check of what the owner actually opens: the ClawBox app on
// :3005/apps/quake2/ and the live game on :4231, the served archives by
// content, and the real Chrome tab over CDP (renderer, canvas, pak9 in the
// engine FS). Node built-ins only. Report: docs/texture-review/ingame/final/e2e.json
//
//   node scripts/e2e-check.mjs [--out dir] [--fps path] [--skip-chrome]
//
// The CDP helpers (navigate/waitBootControl/checkRenderer/readCvar) are
// copied from scripts/texture-fps.mjs, which drives the same open window under
// the same real-Chrome rule: no claim without the screenshot and the renderer
// string, and the tab is left on http://127.0.0.1:4231/.

import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { QuakeControl } from "../control/bridge.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CDP = "http://127.0.0.1:9222";
const APP_URL = "http://127.0.0.1:3005/apps/quake2/";
const LIVE_URL = "http://127.0.0.1:4231/";
const GAME_URL = LIVE_URL + "?+map&demo1&+set&cl_gun&0&+set&crosshair&0";
const TARGET_W = 1366, TARGET_H = 768;
const LOAD_LIMIT = 4;

const options = { out: path.join(ROOT, "docs", "texture-review", "ingame", "final"),
  fps: path.join(ROOT, "docs", "texture-review", "ingame", "final", "fps.json"), skipChrome: false };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") options.out = path.resolve(argv[++i]);
  else if (argv[i] === "--fps") options.fps = path.resolve(argv[++i]);
  else if (argv[i] === "--skip-chrome") options.skipChrome = true;
  else { console.log("e2e-check.mjs [--out dir] [--fps path] [--skip-chrome]"); process.exit(2); }
}
const OUT = options.out;
fs.mkdirSync(OUT, { recursive: true });

const report = { at: new Date().toISOString(), load: [], checks: [], screenshots: [], renderer: null,
  frameTime: null, notes: [] };
function check(name, ok, expected, actual, detail) {
  report.checks.push({ name, ok, expected, actual, ...(detail ? { detail } : {}) });
  console.log((ok ? "  ok   " : "  FAIL ") + name + " — " + actual + (ok ? "" : " (expected " + expected + ")"));
  return ok;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- 1. Load, before any measurement --------------------------------------
function busyShare() {
  const snap = () => os.cpus().map((c) => c.times);
  return { snap };
}
function cpuBusy() {
  const before = os.cpus().map((c) => c.times);
  return sleep(1000).then(() => {
    let busy = 0, total = 0;
    os.cpus().forEach((cpu, i) => {
      const b = before[i], a = cpu.times;
      const d = a.user + a.nice + a.sys + a.irq + a.idle - (b.user + b.nice + b.sys + b.irq + b.idle);
      const i2 = a.idle - b.idle;
      total += d; busy += d - i2;
    });
    return total > 0 ? Math.round((100 * busy) / total) / 100 : 0;
  });
}
async function loadReading(wait) {
  const reading = { at: new Date().toISOString(), load1: os.loadavg()[0], load5: os.loadavg()[1],
    load15: os.loadavg()[2], cores: os.cpus().length, busy: await cpuBusy(),
    waitedS: wait };
  report.load.push(reading);
  console.log("  load(1m) " + reading.load1.toFixed(2) + " on " + reading.cores + " cores; cpu busy " +
    (reading.busy * 100).toFixed(0) + "%" + (wait ? " (after " + wait + " s wait)" : ""));
  return reading;
}
let reading = await loadReading(0);
for (let attempt = 0; attempt < 3 && reading.load1 > LOAD_LIMIT; attempt++) {
  const waited = (attempt + 1) * 30;
  report.notes.push("load " + reading.load1.toFixed(2) + " above " + LOAD_LIMIT + "; waited " + waited + " s");
  await sleep(waited * 1000);
  reading = await loadReading(waited);
}
report.loadVerdict = reading.load1 <= LOAD_LIMIT ? "quiet enough (load1 " + reading.load1.toFixed(2) + " <= " + LOAD_LIMIT + ")" :
  "STILL BUSY: load1 " + reading.load1.toFixed(2) + " > " + LOAD_LIMIT + "; timings may be noisy";
console.log("  " + report.loadVerdict);

// ---- 2. HTTP -------------------------------------------------------------
async function fetchText(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(120000) });
  const body = await response.text();
  return { status: response.status, type: response.headers.get("content-type") || "", body };
}
async function fetchSha1(url) {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(180000) });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, bytes: buffer.length, type: response.headers.get("content-type") || "",
    sha1: crypto.createHash("sha1").update(buffer).digest("hex") };
}
function localFile(rel) {
  const file = path.join(ROOT, rel);
  if (!fs.existsSync(file)) return { bytes: 0, sha1: null };
  const buffer = fs.readFileSync(file);
  return { bytes: buffer.length, sha1: crypto.createHash("sha1").update(buffer).digest("hex") };
}
const localPaks = { "baseq2/pak0.pak": localFile("baseq2/pak0.pak"), "baseq2/pak9.pak": localFile("baseq2/pak9.pak") };
console.log("local pak0 " + localPaks["baseq2/pak0.pak"].bytes + " B " + localPaks["baseq2/pak0.pak"].sha1.slice(0, 12) +
  "; pak9 " + localPaks["baseq2/pak9.pak"].bytes + " B " + localPaks["baseq2/pak9.pak"].sha1.slice(0, 12));

report.http = {};
for (const [label, url] of [["app3005", APP_URL], ["live4231", LIVE_URL]]) {
  try {
    const page = await fetchText(url);
    const hasCanvas = /id=['"]canvas['"]/.test(page.body);
    const errorish = /<title>[^<]*(error|not found|login|sign in)/i.test(page.body) || page.status >= 400;
    report.http[label] = { url, status: page.status, type: page.type, hasCanvas,
      excerpt: page.body.replace(/\s+/g, " ").slice(0, 400), errorish };
    check(label + " HTTP 200", page.status === 200, 200, String(page.status));
    check(label + " text/html", /text\/html/i.test(page.type), "text/html", page.type || "(none)");
    check(label + " game page (id='canvas')", hasCanvas && !errorish, "the game page with id=canvas",
      hasCanvas ? "page holds id='canvas'" + (errorish ? " but looks like an error/login page" : "") : "no id='canvas'");
  } catch (error) {
    report.http[label] = { url, error: String(error.message || error) };
    check(label + " reachable", false, "HTTP 200", "fetch failed: " + (error.message || error));
  }
}
report.paks = {};
for (const [label, origin] of [["app3005", APP_URL.replace(/\/$/, "")], ["live4231", new URL(LIVE_URL).origin]]) {
  report.paks[label] = {};
  for (const rel of Object.keys(localPaks)) {
    const wanted = localPaks[rel];
    try {
      const served = await fetchSha1(origin + "/" + rel);
      report.paks[label][rel] = served;
      check(label + " serves " + rel + " byte length", served.bytes === wanted.bytes, String(wanted.bytes), String(served.bytes));
      check(label + " serves " + rel + " sha1", served.sha1 === wanted.sha1, wanted.sha1, served.sha1);
    } catch (error) {
      report.paks[label][rel] = { error: String(error.message || error) };
      check(label + " serves " + rel, false, wanted.sha1, "fetch failed: " + (error.message || error));
    }
  }
}
report.liveServedMatchesWorktree = ["baseq2/pak0.pak", "baseq2/pak9.pak"].every((rel) =>
  report.paks.live4231[rel] && report.paks.live4231[rel].sha1 === localPaks[rel].sha1);
if (!report.liveServedMatchesWorktree) {
  report.notes.push("4231 is quake2-app.service on the MAIN checkout: its archives differ from this worktree's, " +
    "so the merged work has not reached the served folder. The service was not restarted.");
}

// ---- 3. Real Chrome over CDP --------------------------------------------
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
async function navigate(cdp, url) {
  const loaded = cdp.waitFor("Page.loadEventFired", 120000).catch(() => null);
  await cdp.send("Page.navigate", { url }, 60000);
  await loaded;
}
async function waitBootControl(control, label, timeoutMs = 240000) {
  const started = Date.now();
  let seen = null;
  while (Date.now() - started < timeoutMs) {
    try {
      seen = await control.evaluate(`(() => { const c = document.getElementById("canvas");
        return { display: c && c.style.display, fs: typeof FS, gl: typeof GLctx }; })()`);
      if (seen && seen.display === "block" && seen.fs === "object" && seen.gl === "object") return seen;
    } catch { /* context torn down mid-reload */ }
    await sleep(1500);
  }
  throw new Error(label + ": the engine did not boot in " + timeoutMs / 1000 + " s (" + JSON.stringify(seen) + ")");
}
const RENDERER = `(() => {
  const canvas = document.getElementById("canvas");
  if (typeof GLctx === "undefined" || !GLctx) return { error: "GLctx is not defined", webgl2: false };
  const ext = GLctx.getExtension("WEBGL_debug_renderer_info");
  return { webgl2: GLctx instanceof WebGL2RenderingContext,
    vendor: ext && GLctx.getParameter(ext.UNMASKED_VENDOR_WEBGL),
    renderer: ext && GLctx.getParameter(ext.UNMASKED_RENDERER_WEBGL),
    glVersion: GLctx.getParameter(GLctx.VERSION),
    drawingBuffer: [canvas.width, canvas.height], inner: [innerWidth, innerHeight],
    dpr: devicePixelRatio, visible: document.visibilityState };
})()`;
const PAK9_SIZE = `(() => { try { return FS.statSync("baseq2/pak9.pak").size; } catch (e) {
  try { return FS.lookupPath("baseq2/pak9.pak").node.contents.length; } catch (e2) { return -1; } } })()`;
function checkRenderer(label, renderer, vidRenderer) {
  if (!renderer || renderer.error) return { ok: false, why: renderer ? renderer.error : "renderer unreadable" };
  const problems = [];
  if (renderer.webgl2 !== true) problems.push("GLctx is not WebGL2");
  if (!/ANGLE/.test(String(renderer.renderer || ""))) problems.push("unmasked renderer lacks ANGLE: " + JSON.stringify(renderer.renderer));
  if (!Array.isArray(renderer.drawingBuffer) || renderer.drawingBuffer[0] !== TARGET_W || renderer.drawingBuffer[1] !== TARGET_H) {
    problems.push("drawing buffer " + (renderer.drawingBuffer ? renderer.drawingBuffer.join("x") : "unknown"));
  }
  if (vidRenderer !== "gles3") problems.push("vid_renderer " + JSON.stringify(vidRenderer));
  return { ok: problems.length === 0, why: problems.join("; ") };
}
async function readCvarDurable(box, cdpUrl, name, attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    let got = null;
    try {
      const answer = await box.control.command(name, { tail: 4 });
      const line = answer.output.map((one) => /"([^"]+)"\s+is\s+"([^"]*)"/.exec(one)).find(Boolean);
      got = line ? line[2] : null;
    } catch { /* console missed */ }
    if (got !== null) return got;
    await box.control.close().catch(() => {});
    box.control = new QuakeControl({ cdpUrl, gameUrlMark: box.mark });
    await sleep(1200);
  }
  return null;
}
async function shoot(control, file) {
  const png = await control.screenshot();
  await fsp.writeFile(path.join(OUT, file), png);
  report.screenshots.push(file);
  console.log("  shot " + file + " (" + png.length + " B)");
  return file;
}

report.chrome = {};
if (!options.skipChrome) {
  // The open window is driven through the page target's own debugger URL; the
  // engine frame may be an iframe (the ClawBox app is framed), so everything
  // inside the page goes through QuakeControl, which resolves the game frame.
  let tab = null;
  try {
    const targets = await fetch(CDP + "/json/list", { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    const pages = targets.filter((one) => one.type === "page" && one.webSocketDebuggerUrl);
    tab = pages.find((one) => /127\.0\.0\.1:4231/.test(one.url)) ||
      pages.find((one) => /\/apps\/quake2\//.test(one.url)) ||
      pages.find((one) => /quake2/i.test(one.url)) || pages[0] || null;
  } catch (error) {
    check("CDP " + CDP + " reachable", false, "the open Chrome window",
      "unreachable: " + (error.message || error) + " — relaunch ~/.openclaw/workspace/scripts/game-chrome.sh");
  }
  check("CDP " + CDP + " has the open game tab", Boolean(tab), "a page target on 4231 or /apps/quake2/",
    tab ? "tab " + tab.url : "no page target (relaunch ~/.openclaw/workspace/scripts/game-chrome.sh)");
  const cdpPage = tab ? new RawCdp(tab.webSocketDebuggerUrl) : null;
  if (cdpPage) await cdpPage.open();

  const views = [
    { label: "app3005", url: APP_URL, mark: "/apps/quake2/", map: null },
    { label: "live4231", url: GAME_URL, mark: "127.0.0.1:4231", map: "demo1" },
  ];
  for (const view of views) {
    const box = { control: null, mark: view.mark };
    const entry = { url: view.url, shots: [] };
    report.chrome[view.label] = entry;
    try {
      if (!cdpPage) throw new Error("no CDP page target");
      await navigate(cdpPage, view.url);
      // Where the tab actually landed: the ClawBox proxy answers a browser
      // without a valid session by redirecting to /login, and a login page is
      // not the game. Report that as itself, not as a slow boot.
      const landed = await cdpPage.send("Runtime.evaluate", { expression: "location.href", returnByValue: true })
        .then((one) => one.result.value, () => null);
      entry.finalUrl = landed;
      if (landed && /\/login\b/.test(landed)) {
        const png = await cdpPage.send("Page.captureScreenshot", { format: "png" }).then((one) => Buffer.from(one.data, "base64"));
        await fsp.writeFile(path.join(OUT, "e2e-" + view.label + "-login.png"), png);
        report.screenshots.push("e2e-" + view.label + "-login.png");
        throw new Error(view.url + " redirected to " + landed + " — the open Chrome profile has no valid ClawBox session, " +
          "so the game never boots there (screenshot e2e-" + view.label + "-login.png)");
      }
      check(view.label + " landed on the game page", !landed || landed.startsWith(view.url.replace(/\?.*$/, "")),
        "a URL under " + view.url, String(landed));
      box.control = new QuakeControl({ cdpUrl: CDP, gameUrlMark: view.mark });
      await sleep(800);
      await waitBootControl(box.control, view.label);
      const renderer = await box.control.evaluate(RENDERER);
      const vidRenderer = await readCvarDurable(box, CDP, "vid_renderer");
      const checked = checkRenderer(view.label, renderer, vidRenderer);
      entry.renderer = renderer;
      entry.vidRenderer = vidRenderer;
      if (!report.renderer && renderer && renderer.renderer) report.renderer = renderer.renderer;
      check(view.label + " WebGL2", renderer && renderer.webgl2 === true, true, String(renderer && renderer.webgl2));
      check(view.label + " ANGLE unmasked renderer", !!(renderer && /ANGLE/.test(String(renderer.renderer))), "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL ES 3.2)", String(renderer && renderer.renderer));
      check(view.label + " vid_renderer gles3", vidRenderer === "gles3", "gles3", String(vidRenderer));
      check(view.label + " drawing buffer 1366x768", !!(renderer && renderer.drawingBuffer && renderer.drawingBuffer[0] === TARGET_W && renderer.drawingBuffer[1] === TARGET_H), TARGET_W + "x" + TARGET_H, renderer && renderer.drawingBuffer ? renderer.drawingBuffer.join("x") : "unknown");
      check(view.label + " renderer gate (all of the above)", checked.ok, "pass", checked.ok ? "pass" : checked.why);
      const pak9 = await box.control.evaluate(PAK9_SIZE).catch(() => -1);
      entry.pak9InEngine = pak9;
      check(view.label + " pak9 bytes in the engine FS", pak9 === localPaks["baseq2/pak9.pak"].bytes, String(localPaks["baseq2/pak9.pak"].bytes), String(pak9));
      if (view.map) {
        const mapname = await readCvarDurable(box, CDP, "mapname");
        entry.mapname = mapname;
        check(view.label + " map loaded", mapname === view.map, view.map, String(mapname));
      }
      await sleep(2500);
      entry.shots.push(await shoot(box.control, "e2e-" + view.label + (view.map ? "-" + view.map : "") + ".png"));
      if (view.map) {
        // The OFF comparison and the map commands, as a console-only route: the
        // task asks for them to be verified before the docs claim they work.
        const before = await box.control.screenshot();
        await box.control.command("r_retexturing 0");
        await sleep(1500);
        const offValue = await readCvarDurable(box, CDP, "r_retexturing");
        const offShot = await box.control.screenshot();
        entry.consoleOff = { readback: offValue, frameChanged: !before.equals(offShot) };
        await fsp.writeFile(path.join(OUT, "e2e-live4231-r_retexturing-0-console.png"), offShot);
        report.screenshots.push("e2e-live4231-r_retexturing-0-console.png");
        check("console r_retexturing 0 reads back 0", offValue === "0", "0", String(offValue));
        check("console r_retexturing 0 changes the frame", !before.equals(offShot), "a different frame",
          before.equals(offShot) ? "identical frame" : "frame changed");
        await box.control.command("r_retexturing 1");
        await sleep(600);
        const onAgain = await readCvarDurable(box, CDP, "r_retexturing");
        check("console r_retexturing 1 restores", onAgain === "1", "1", String(onAgain));
        // Console `map` command: the docs tell the owner to type it.
        const prevMap = entry.mapname;
        await box.control.command("map demo2");
        let mapNow = null;
        for (let i = 0; i < 40 && mapNow !== "demo2"; i++) { await sleep(1500); mapNow = await readCvarDurable(box, CDP, "mapname", 1); }
        entry.consoleMap = { typed: "map demo2", from: prevMap, readback: mapNow };
        check("console map demo2 loads demo2", mapNow === "demo2", "demo2", String(mapNow));
        await sleep(2000);
        entry.shots.push(await shoot(box.control, "e2e-live4231-console-map-demo2.png"));
      }
    } catch (error) {
      entry.error = String(error.message || error);
      check(view.label + " real-Chrome checks", false, "booted engine with gles3", "failed: " + (error.message || error));
    } finally {
      if (box.control) await box.control.close().catch(() => {});
    }
  }
  // Leave the tab where the real-Chrome rule wants it.
  try {
    if (!cdpPage) throw new Error("no CDP page target");
    await navigate(cdpPage, LIVE_URL);
    await sleep(1500);
    report.tabLeftOn = LIVE_URL;
    cdpPage.close();
  } catch (error) { report.notes.push("could not return the tab to " + LIVE_URL + ": " + (error.message || error)); }
} else {
  report.notes.push("real-Chrome checks skipped (--skip-chrome): no renderer claim is made by this report");
}

// ---- 4. Frame time (texture-fps.mjs wrote fps.json) ----------------------
if (fs.existsSync(options.fps)) {
  const fps = JSON.parse(fs.readFileSync(options.fps, "utf8"));
  report.frameTime = { file: path.relative(ROOT, options.fps), summary: fps.summary || fps.verdict || null,
    load: fps.environment && fps.environment.load || fps.load || null };
  check("frame-time report present", true, "fps.json", path.relative(ROOT, options.fps));
} else {
  report.notes.push("no frame-time report at " + path.relative(ROOT, options.fps) + ": frame timings were not measured by this run");
  check("frame-time report present", false, "fps.json", "missing");
}

report.ok = report.checks.every((one) => one.ok);
await fsp.writeFile(path.join(OUT, "e2e.json"), JSON.stringify(report, null, 2) + "\n");
console.log((report.ok ? "PASS" : "FAIL") + " — " + report.checks.filter((one) => !one.ok).length + " of " +
  report.checks.length + " checks failed; report in " + path.relative(ROOT, path.join(OUT, "e2e.json")));
process.exit(report.ok ? 0 : 1);
