#!/usr/bin/env node
// Investigation probe (not part of the release gate).
// Boots at 2560x1440 and watches the page's own status-bar read-back: how often
// it runs, what one read costs, and whether the adaptive interval backs off.
// The read is a synchronous gl.readPixels and feeds nothing on the page.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { QuakeControl } from "../control/bridge.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = Number(process.env.PROBE_PORT || 4299);
const TARGET = "http://127.0.0.1:" + PORT + "/apps/quake2/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

async function main() {
  const serverLog = fs.openSync(path.join(os.tmpdir(), "q2probe-hud-server.log"), "a");
  const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", serverLog, serverLog],
  });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "q2probe-hud-"));
  const log = fs.openSync(path.join(profile, "chrome.log"), "a");
  const port = await freePort();
  const MODE = process.env.PROBE_MODE || "25";
  const SIZE = process.env.PROBE_SIZE || "2560,1440";
  const url = TARGET + "?+set&r_mode&" + MODE + "&+map&demo1";
  const chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader", "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=" + port, "--user-data-dir=" + profile,
    "--window-size=" + SIZE, "--hide-scrollbars", "--no-first-run",
    "--no-default-browser-check", "--disable-infobars",
    "--disable-features=Translate,MediaRouter", "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", "--disable-dev-shm-usage", "--mute-audio",
    url,
  ], { stdio: ["ignore", log, log] });
  const base = "http://127.0.0.1:" + port;
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(base + "/json/version", { signal: AbortSignal.timeout(1500) }); if (r.ok) break; }
    catch { /* not up */ }
    await sleep(300);
  }
  const control = new QuakeControl({ cdpUrl: base, gameUrlMark: "/apps/quake2/", timeoutMs: 120000 });
  const start = Date.now();
  let ready = false;
  while (Date.now() - start < 180000) {
    try {
      const hud = JSON.parse(await control.evaluate("JSON.stringify(window.quake2Hud.read())"));
      if (hud.ready && (hud.reads + hud.misses) > 0) { ready = true; break; }
    } catch { /* keep waiting */ }
    await sleep(2000);
  }
  console.log("ready " + ready + " after " + (Date.now() - start) + " ms");
  const first = await control.evaluate("JSON.stringify(window.quake2Hud.read())");
  const firstRead = JSON.parse(first);
  console.log("t=0  attempts " + (firstRead.reads + firstRead.misses) + " reads " + firstRead.reads +
    " interval " + firstRead.intervalMs + " cost " + firstRead.costMs);
  const started = Date.now();
  for (let i = 1; i <= 7; i++) {
    await sleep(10000);
    const t0 = Date.now();
    let raw = null, error = null;
    try { raw = await control.evaluate("JSON.stringify(window.quake2Hud.read())"); }
    catch (e) { error = e.message; }
    const latency = Date.now() - t0;
    const hud = raw ? JSON.parse(raw) : null;
    console.log("t=" + Math.round((Date.now() - started) / 1000) + "s evaluate " + latency + " ms  " +
      (hud ? "attempts " + (hud.reads + hud.misses) + " reads " + hud.reads + " interval " +
        hud.intervalMs + " cost " + hud.costMs + " health " + hud.health : "ERROR " + error));
  }
  const last = JSON.parse(await control.evaluate("JSON.stringify(window.quake2Hud.read())"));
  console.log("attempts over the 70 s window: " + ((last.reads + last.misses) - (firstRead.reads + firstRead.misses)));
  try { await control.close(); } catch { /* ignore */ }
  try { chrome.kill("SIGKILL"); } catch { /* ignore */ }
  try { server.kill("SIGKILL"); } catch { /* ignore */ }
  console.log("profile " + profile);
}

main().catch((error) => { console.error("probe crashed:", error); process.exitCode = 1; });
