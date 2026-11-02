#!/usr/bin/env node
// Investigation probe (not part of the release gate).
// Proves that pipelined console key dispatch reaches the engine intact, and
// measures the command round trip at 1280x720 and 2560x1440. The engine echoes
// the command as it received it, so the echo line is the evidence: a dropped
// character shows up as a malformed `]...` line, which `echoFound` rejects.
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

async function launch(url, size) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "q2probe-console-"));
  const log = fs.openSync(path.join(profile, "chrome.log"), "a");
  const port = await freePort();
  const chrome = spawn("/usr/bin/google-chrome", [
    "--headless=new", "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader", "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=" + port, "--user-data-dir=" + profile,
    "--window-size=" + size, "--hide-scrollbars", "--no-first-run",
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
  return { chrome, base, profile };
}

async function runAt(label, size, mode, commands) {
  const url = TARGET + "?+set&r_mode&" + mode + "&+map&demo1";
  const { chrome, base, profile } = await launch(url, size);
  const control = new QuakeControl({ cdpUrl: base, gameUrlMark: "/apps/quake2/", timeoutMs: 120000 });
  let ready = null;
  const start = Date.now();
  while (Date.now() - start < 180000) {
    try {
      ready = await control.state();
      if (ready && ready.running && ready.gameDir) break;
    } catch { /* keep waiting */ }
    await sleep(1500);
  }
  await sleep(4000);
  const draw = await control.evaluate("(() => { const c = document.getElementById('canvas'); return c.width + 'x' + c.height; })()");
  console.log("\n== " + label + " " + size + " drawing buffer " + draw + " (waited " + (Date.now() - start) + " ms)");
  const results = [];
  for (const command of commands) {
    const t0 = Date.now();
    let answer = null, error = null;
    try { answer = await control.command(command, { tail: 6 }); }
    catch (e) { error = e.message; }
    const ms = Date.now() - t0;
    const echoed = answer && answer.output ? answer.output[0] : null;
    const intact = Boolean(answer && answer.echoFound && answer.output &&
      answer.output.some((line) => line.replace(/^\]\s*/, "").trim() === command));
    let after = null;
    try {
      const s = await control.state();
      after = { running: s.running, gameDir: s.gameDir, logPath: s.logPath, logLength: s.logLength,
        consoleOpen: s.engine && s.engine.consoleOpen, keyDest: s.engine && s.engine.keyDestName,
        tail: (s.console && s.console.tail || []).slice(-3) };
    } catch (e) { after = { stateError: e.message }; }
    results.push({ command, ms, ran: answer && answer.ran, echoFound: answer && answer.echoFound,
      attempts: answer && answer.attempts, reason: answer && answer.reason, intact, echoed, error, after,
      spend: control.consoleMetrics() });
    console.log("  " + (intact ? "ok  " : "BAD ") + JSON.stringify(command) + "  " + ms +
      " ms  echo " + JSON.stringify(echoed) + (error ? "  ERROR " + error : ""));
    if (!intact) console.log("      ran " + (answer && answer.ran) + " reason " + (answer && answer.reason) +
      " attempts " + (answer && answer.attempts) + " | after " + JSON.stringify(after));
  }
  try {
    const hud = JSON.parse(await control.evaluate("JSON.stringify(window.quake2Hud.read())"));
    console.log("  after console use: hud interval " + hud.intervalMs + " ms, cost " + hud.costMs + " ms, health " + hud.health);
  } catch (e) { console.log("  hud read failed: " + e.message); }
  try { await control.close(); } catch { /* ignore */ }
  try { chrome.kill("SIGKILL"); } catch { /* ignore */ }
  console.log("  profile " + profile);
  return results;
}

async function main() {
  const serverLog = fs.openSync(path.join(os.tmpdir(), "q2probe-console-server.log"), "a");
  const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ["ignore", serverLog, serverLog],
  });
  await sleep(1200);
  const results = [];
  try {
    if (!process.env.PROBE_SKIP_1280) results.push(...await runAt("console", "1280,720", "14", [
      "echo alpha-123", "timescale 0", "timescale 1",
      "echo bravo 456", "echo charlie_789", "echo delta-0123456789-abcdef",
    ]));
    if (!process.env.PROBE_SKIP_2560) results.push(...await runAt("console", "2560,1440", "25", [
      "timescale 0", "echo echo-2560-check", "timescale 1",
    ]));
  } finally {
    try { server.kill("SIGKILL"); } catch { /* ignore */ }
  }
  const bad = results.filter((r) => !r.intact);
  const times = results.map((r) => r.command.length + "ch " + r.ms + "ms");
  console.log("\nsummary: " + (results.length - bad.length) + "/" + results.length + " intact; " + times.join(", "));
  fs.writeFileSync(path.join(os.tmpdir(), "console-probe-result.json"), JSON.stringify(results, null, 1));
}

main().catch((error) => { console.error("probe crashed:", error); process.exitCode = 1; });
