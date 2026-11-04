#!/usr/bin/env node
// scripts/perf-check.mjs -- the frame and menu numbers, measured.
//
//   node scripts/perf-check.mjs [--out DIR]
//
// Measures on its own server/temp store/box-CSP proxy/headless Chromium:
//   * the frame rate and frame-time percentiles in the game at the shipped
//     default (HD 1280x720, RTX Performance);
//   * the same at 1366x768, so the HD default's own contribution is visible;
//   * main-thread task time per drawn frame (CDP Performance.getMetrics),
//     which is the part this change set actually removes -- the software
//     renderer's GPU work is unchanged by it;
//   * the synchronous status-bar read-back cost at HD (the reader the shipped
//     page no longer runs on a timer) and proof that no automatic reads happen
//     while nobody asks for one;
//   * menu open latency and the frame rate with the menu up, against the game
//     frame rate on the same page and scene.
//
// It asserts the things that must hold, not a raw FPS number (this box's
// software renderer and the owner's desktop make absolute fps meaningless):
//   - the default is HD and RTX is on;
//   - the menu does not halve the frame rate any more (>= 80% of the game's
//     fps; the blur measured 54%) and its main-thread cost per frame is within
//     10% of the game's (the blur measured ~1.9x);
//   - no automatic HUD reads happen in an idle page, and the on-demand read
//     still works;
//   - the start-up line stays within the engine's argument limit.
//
// Numbers are printed and written to <out>/perf.json. Exit 0 when every
// invariant held, 1 otherwise.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Harness, Report, sleep, waitFor } from "./app-harness.mjs";

const argv = process.argv.slice(2);
let outDir = process.env.CLAWBOX_RUN_ARTIFACTS_DIR || path.join(os.tmpdir(), "q2-perf-" + process.pid);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") outDir = path.resolve(argv[++i]);
  else if (argv[i] === "--help" || argv[i] === "-h") { console.log("perf-check.mjs [--out DIR]"); process.exit(0); }
  else { console.error("unknown option: " + argv[i]); process.exit(2); }
}
fs.mkdirSync(outDir, { recursive: true });

const report = new Report("Performance");
const app = new Harness({ name: "q2-perf" });
let code = 0;
const numbers = {};

function percentile(values, p) {
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : null;
}

async function measure(seconds) {
  const metrics = await app.metrics();
  const frames = await app.frames(seconds);
  const m = await metrics.diff();
  return {
    seconds: frames.seconds,
    frames: frames.frames,
    fps: frames.fps,
    frameTimeMs: frames.frameTime,
    taskMs: m.TaskDuration * 1000,
    scriptMs: m.ScriptDuration * 1000,
    taskPerFrameMs: frames.frames ? (m.TaskDuration * 1000) / frames.frames : null,
    scriptPerFrameMs: frames.frames ? (m.ScriptDuration * 1000) / frames.frames : null,
  };
}

async function main() {
  await app.start();
  console.log("  server 127.0.0.1:" + app.serverPort + " (temp store " + app.dataDir + ")");
  console.log("  box proxy 127.0.0.1:" + app.proxyPort + ", Chrome CDP 127.0.0.1:" + app.cdpPort);
  const boot = await app.open();
  const renderer = await app.evaluate(`(() => { const gl = document.getElementById("canvas").getContext("webgl2");
    const info = gl.getExtension("WEBGL_debug_renderer_info");
    return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : "unknown"; })()`);
  console.log("  renderer: " + renderer);

  numbers.default = { buffer: boot.buffer, rtx: { enabled: boot.rtx.enabled, quality: boot.rtx.quality } };
  report.check("the shipped default is HD", boot.buffer === "1280x720", "1280x720", String(boot.buffer));
  report.check("RTX is on by default", Boolean(boot.rtx && boot.rtx.enabled === true),
    "enabled true", boot.rtx ? "enabled " + boot.rtx.enabled + ", quality " + boot.rtx.quality : "missing");
  report.check("the start-up line is inside the engine's argument limit",
    (boot.startup || []).length <= 48, "at most 48 arguments", String((boot.startup || []).length));

  // No reader asked for the status bar: the shipped page must not run the
  // synchronous read-back on a timer.
  await sleep(6500);
  const idle = await app.evaluate("(() => { const s = window.quake2RTX.status(); return { reads: s.hudReads, cost: s.hudReadCostMs, attempts: s.hudAttempts, auto: s.hudAutoRead }; })()");
  numbers.hud = { idleReads: idle.reads, idleCostMs: idle.cost, idleAttempts: idle.attempts, autoRead: idle.auto };
  report.check("an idle page performs no status-bar read-backs", idle.reads === 0 && idle.attempts === 0 && idle.auto === false,
    "the automatic reader off, 0 reads and 0 attempts",
    "autoRead " + idle.auto + ", " + idle.reads + " reads, " + idle.attempts + " attempts");

  // The reader is a synchronous framebuffer read that only lands inside the
  // engine's own drawn frame, so a reader is asked for and then read back --
  // `readNow()` from an outer evaluation can land on a cleared buffer.
  await app.evaluate("window.quake2Hud.start()");
  const readValue = await waitFor(async () => {
    const reading = await app.evaluate("window.quake2Hud.read()");
    return reading.reads > 0 ? reading : null;
  }, 20000, "the status-bar reader to find the bar", 500).catch(() => null);
  numbers.hud.onDemandMs = readValue ? readValue.costMs : null;
  numbers.hud.onDemandValue = readValue ? { health: readValue.health, ammo: readValue.ammo, reads: readValue.reads } : null;
  report.check("the on-demand status-bar reader still works",
    Boolean(readValue) && readValue.reads > 0 && (typeof readValue.health === "number" || typeof readValue.ammo === "number"),
    "successful reads that find the bar's numbers",
    readValue ? readValue.reads + " read(s), health " + readValue.health + ", ammo " + readValue.ammo +
      ", last read " + Math.round(readValue.costMs) + " ms" : "no successful read");
  // `read()` starts the automatic reader; stop it again (via status(), which
  // has no side effect) and prove the idle page goes quiet.
  await app.evaluate("window.quake2Hud.stop()");
  // A read armed before stop() still lands in the frame it was queued for;
  // let it settle, then measure the quiet page.
  await sleep(1500);
  const readsAfterStart = await app.evaluate("window.quake2RTX.status().hudReads");
  await sleep(4000);
  const stopped = await app.evaluate("window.quake2RTX.status().hudReads");
  numbers.hud.readsWhileStopped = stopped - readsAfterStart;
  report.check("stopping the reader stops the automatic reads", stopped - readsAfterStart <= 0,
    "no new automatic reads after stop()", (stopped - readsAfterStart) + " new read(s)");

  const game = await measure(8);
  numbers.game = game;
  console.log("  game: " + game.fps.toFixed(2) + " fps, frame p50 " + Math.round(game.frameTimeMs.p50) +
    " ms / p95 " + Math.round(game.frameTimeMs.p95) + " ms, task " + Math.round(game.taskPerFrameMs) + " ms/frame");

  // The same page at 1366x768: the HD default's own contribution, no other
  // change. The query's pair is allowed (the page's own line is 32 arguments,
  // this pair makes 35).
  await app.open(app.url("+set&r_mode&17&+map&demo1"));
  const large = await measure(8);
  numbers.game1366 = large;
  console.log("  game at 1366x768: " + large.fps.toFixed(2) + " fps, task " + Math.round(large.taskPerFrameMs) + " ms/frame");
  // HD has 8.9% fewer pixels, but the software renderer on a shared box is
  // noisy and GPU-bound: a small drift either way is not evidence. 90% is the
  // sanity bound; the numbers themselves are reported.
  report.check("HD is no slower than 1366x768 on the same scene", game.fps >= large.fps * 0.9,
    "HD frames per second >= 90% of 1366x768", game.fps.toFixed(2) + " vs " + large.fps.toFixed(2) + " fps");

  // Back to the default, then the menu, measured on the same page and scene.
  await app.open();
  await sleep(2000);
  const game2 = await measure(6);
  const openLatency = [];
  for (let round = 0; round < 5; round++) {
    if (await app.evaluate("document.getElementById('menu-layer').hidden === false")) await app.closeMenu();
    await sleep(700);
    const latency = await app.evaluate(`new Promise(function (resolve) {
      var started = performance.now();
      window.quake2App.tapKey({ key: "Escape", code: "Escape", vk: 27, ch: 27 });
      var timer = setInterval(function () {
        if (document.getElementById("menu-layer").hidden === false) {
          var shown = performance.now() - started;
          clearInterval(timer);
          requestAnimationFrame(function () { requestAnimationFrame(function () { resolve({ shown: shown, painted: performance.now() - started }); }); });
        }
      }, 4);
      setTimeout(function () { clearInterval(timer); resolve(null); }, 15000);
    })`, true);
    if (latency) openLatency.push(latency);
  }
  const menu = await measure(6);
  const scrim = await app.evaluate(`(() => { const style = getComputedStyle(document.querySelector(".menu-scrim")); return { backdropFilter: style.backdropFilter, webkitBackdropFilter: style.webkitBackdropFilter }; })()`);
  numbers.menu = { openLatencyMs: openLatency, frames: menu, scrim };
  const latencyP50 = percentile(openLatency.map((one) => one.shown), 0.5);
  const paintP50 = percentile(openLatency.map((one) => one.painted), 0.5);
  console.log("  menu open: p50 " + Math.round(latencyP50) + " ms to show, " + Math.round(paintP50) + " ms to paint");
  console.log("  menu: " + menu.fps.toFixed(2) + " fps, task " + Math.round(menu.taskPerFrameMs) + " ms/frame vs game " +
    game2.fps.toFixed(2) + " fps, " + Math.round(game2.taskPerFrameMs) + " ms/frame");
  report.check("the menu scrim carries no backdrop blur", !/blur/.test(scrim.backdropFilter + " " + scrim.webkitBackdropFilter),
    "backdrop-filter none on .menu-scrim", scrim.backdropFilter + " / " + scrim.webkitBackdropFilter);
  report.check("the menu keeps at least 80% of the game's frame rate", menu.fps >= game2.fps * 0.8,
    "menu fps >= 80% of game fps", menu.fps.toFixed(2) + " vs " + game2.fps.toFixed(2) + " fps (" +
      Math.round((menu.fps / game2.fps) * 100) + "%)");
  report.check("the menu adds no main-thread cost per drawn frame", menu.taskPerFrameMs <= game2.taskPerFrameMs * 1.1,
    "menu task/frame <= 110% of game's", Math.round(menu.taskPerFrameMs) + " vs " + Math.round(game2.taskPerFrameMs) +
      " ms (" + (menu.taskPerFrameMs / game2.taskPerFrameMs).toFixed(2) + "x)");
  report.check("the menu opens within a second and a half of the engine's own frame",
    latencyP50 !== null && latencyP50 < 1500, "p50 under 1500 ms on the software renderer",
    latencyP50 === null ? "no measurement" : Math.round(latencyP50) + " ms");
  numbers.gameBeforeMenu = game2;
  await app.screenshot(path.join(outDir, "perf-menu.png"));
  // Paired control: put the old 2 px backdrop blur back on the scrim for one
  // measured window on this same page and scene, then take it off. This is
  // the cause the change removed, measured against its own absence.
  await app.evaluate(`document.querySelector(".menu-scrim").style.backdropFilter = "blur(2px)"; true`);
  await sleep(600);
  const blurred = await measure(6);
  await app.evaluate(`document.querySelector(".menu-scrim").style.backdropFilter = ""; true`);
  await sleep(400);
  numbers.menuWithBlur = blurred;
  console.log("  menu with the old 2 px blur: " + blurred.fps.toFixed(2) + " fps, task " + Math.round(blurred.taskPerFrameMs) + " ms/frame");
  report.check("the old backdrop blur is what cost the menu its frame rate",
    menu.fps > blurred.fps * 1.1,
    "the menu without the blur draws at least 10% more frames than with it",
    menu.fps.toFixed(2) + " fps without vs " + blurred.fps.toFixed(2) + " fps with (" +
      Math.round((menu.fps / blurred.fps - 1) * 100) + "% more without)");
  await app.closeMenu();

  fs.writeFileSync(path.join(outDir, "perf.json"), JSON.stringify({ renderer, numbers }, null, 2));
  report.note("numbers in " + path.join(outDir, "perf.json"));

  const pageErrors = app.pageErrors.filter((text) => /app\.js/.test(String(text)));
  report.check("app.js threw nothing during the measurement", pageErrors.length === 0, "no page exception from app.js",
    pageErrors.length ? pageErrors.join(" | ") : "none");
}

try {
  await main();
  code = report.finish() ? 0 : 1;
} catch (error) {
  console.error("\nFAIL: " + (error && error.stack ? error.stack : error));
  code = 1;
} finally {
  await app.stop().catch(() => {});
}
process.exit(code);
