#!/usr/bin/env node
// Investigation probe (not part of the release gate).
// Boots the app at 2560x1440 exactly as verify-presentation.mjs does for the
// crosshair stage, then samples the renderer main thread and the app's own
// status-bar read-back. The durable gate failed at 194/195 with
// "CDP Runtime.evaluate timed out after 60000 ms" while sending `timescale 0`
// in this state, and a Chrome log from a nearby probe recorded a 60.75 s
// compositor stall plus "GPU state invalid after WaitForGetOffsetInRange".
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { QuakeControl } from "../control/bridge.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const PORT = Number(process.env.PROBE_PORT || 4299);
const TARGET = "http://127.0.0.1:" + PORT + "/apps/quake2/";
const GAME = TARGET + "?+set&r_mode&25&+map&demo1&+set&crosshair&1&+set&timescale&0" +
  "&+set&gl3_intensity&2.0&+set&gl3_overbrightbits&1.3";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tail(file, n) {
  try { return fs.readFileSync(file, "utf8").trim().split("\n").slice(-n).join("\n"); }
  catch { return ""; }
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
    s.on("error", reject);
  });
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "q2probe-chrome-"));
  const logFile = path.join(profile, "chrome.log");
  const log = fs.openSync(logFile, "a");
  // Server from this working tree, so the served bytes are the tree under test.
  const serverLog = path.join(profile, "server.log");
  const serverOut = fs.openSync(serverLog, "a");
  const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", serverOut, serverOut],
  });
  const port = await freePort();
  const chromePath = "/usr/bin/google-chrome";
  const chrome = spawn(chromePath, [
    "--headless=new", "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader", "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=" + port, "--user-data-dir=" + profile,
    "--window-size=2560,1440", "--hide-scrollbars", "--no-first-run",
    "--no-default-browser-check", "--disable-infobars",
    "--disable-features=Translate,MediaRouter", "--autoplay-policy=no-user-gesture-required",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows", "--disable-dev-shm-usage", "--mute-audio",
    GAME,
  ], { stdio: ["ignore", log, log] });

  const base = "http://127.0.0.1:" + port;
  const started = Date.now();
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(base + "/json/version", { signal: AbortSignal.timeout(1500) });
      if (r.ok) break;
    } catch { /* not up yet */ }
    await sleep(300);
  }
  console.log("chrome up in", Date.now() - started, "ms; url", GAME);

  const control = new QuakeControl({ cdpUrl: base, gameUrlMark: "/apps/quake2/", timeoutMs: 120000 });
  // Wait for the first useful reading: canvas sized, engine running.
  let ready = null;
  const bootStart = Date.now();
  while (Date.now() - bootStart < 240000) {
    try {
      ready = await control.state();
      const ok = ready && ready.engine && ready.engine.running &&
        ready.player && ready.player.position;
      if (ok) break;
    } catch (error) {
      ready = { error: String(error && error.message || error) };
    }
    await sleep(2000);
  }
  console.log("settled after", Date.now() - bootStart, "ms:", JSON.stringify({
    running: ready && ready.engine && ready.engine.running,
    url: ready && ready.url,
    error: ready && ready.error,
  }));

  const hudExpr = `(() => {
    const h = window.quake2Hud && window.quake2Hud.read ? window.quake2Hud.read() : null;
    const t = performance.now();
    let readMs = null, readError = null;
    try { const r = window.quake2Hud && window.quake2Hud.readNow && window.quake2Hud.readNow();
      readMs = performance.now() - t; readError = r ? null : "null"; }
    catch (error) { readError = String(error && error.message || error); }
    return JSON.stringify({ readMs, readError, hud: h, now: performance.now(),
      frames: window.__q2probe ? window.__q2probe.frames : null,
      maxGap: window.__q2probe ? window.__q2probe.maxGap : null });
  })()`;

  // Long-task and frame-gap instrumentation: injected once, lives in the page.
  await control.evaluate(`(() => {
    if (window.__q2probe) return "already";
    window.__q2probe = { frames: 0, maxGap: 0, gaps: [], long: [] };
    let last = 0;
    function step(now) {
      if (last) { const gap = now - last; window.__q2probe.gaps.push(Math.round(gap));
        if (gap > window.__q2probe.maxGap) window.__q2probe.maxGap = Math.round(gap); }
      last = now; window.__q2probe.frames++;
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
    try { new PerformanceObserver((list) => { for (const e of list.getEntries())
      window.__q2probe.long.push({ start: Math.round(e.startTime), dur: Math.round(e.duration) }); })
      .observe({ entryTypes: ["longtask"] }); } catch (e) { window.__q2probe.longError = String(e); }
    return "ok";
  })()`).catch((e) => console.log("instrument failed:", e.message));

  console.log("\n sampling page responsiveness at 2560x1440 (2 s cadence)");
  const samples = [];
  for (let i = 0; i < 25; i++) {
    const t0 = Date.now();
    let value = null, error = null;
    try {
      value = await control.evaluate("JSON.stringify({now: performance.now(), href: location.href})");
    } catch (e) { error = String(e && e.message || e); }
    const latency = Date.now() - t0;
    samples.push({ at: Math.round((Date.now() - bootStart) / 1000), latency, error });
    console.log("  +" + samples[samples.length - 1].at + "s evaluate " + latency + " ms" +
      (error ? " ERROR " + error : ""));
    await sleep(Math.max(200, 2000 - latency));
  }

  console.log("\n forcing the app's status-bar read-back five times");
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    try {
      const raw = await control.evaluate(hudExpr);
      console.log("  read", i, "round-trip", Date.now() - t0, "ms:", String(raw).slice(0, 400));
    } catch (e) {
      console.log("  read", i, "round-trip", Date.now() - t0, "ms ERROR", e.message);
    }
    await sleep(1000);
  }

  console.log("\n sending `timescale 0` through the console bridge (the gate's failing step)");
  const t0 = Date.now();
  try {
    const answer = await control.command("timescale 0", { tail: 8 });
    console.log("  command returned in", Date.now() - t0, "ms:", JSON.stringify(answer).slice(0, 500));
  } catch (e) {
    console.log("  command FAILED after", Date.now() - t0, "ms:", e.message);
  }

  try {
    const tail = await control.evaluate("JSON.stringify(window.__q2probe)");
    console.log("\n page probe:", String(tail).slice(0, 1200));
  } catch (e) { console.log("\n page probe unavailable:", e.message); }

  console.log("\n chrome.log flagged lines:");
  console.log(tail(logFile, 400).split("\n").filter((l) =>
    /ERROR|too long|GPU|timeout|Lost|invalid/i.test(l)).slice(-15).join("\n"));

  try { await control.close(); } catch { /* ignore */ }
  try { chrome.kill("SIGKILL"); } catch { /* ignore */ }
  try { server.kill("SIGKILL"); } catch { /* ignore */ }
  console.log("\nprobe done; profile", profile);
}

main().catch((error) => { console.error("probe crashed:", error); process.exitCode = 1; });
