#!/usr/bin/env node
// scripts/store-package.mjs -- build the ClawBox Store package, then boot it.
//
//   node scripts/store-package.mjs [--port 4471] [--out DIR] [--version X.Y.Z]
//
// What the Store ships is what `packProject` packs: the files git lists
// (tracked plus untracked-but-not-ignored) in one tar.gz, refused over 50 MiB
// compressed. The full tree does not fit, so every publish since 1.0.0 leaves
// out the same three things (docs/store-package-1.0.0.md): the gate evidence
// under docs/, the source art under assets/, and baseq2/pak9.pak (39 MB of
// optional 4x wall art; app.js skips a missing optional archive). This script
// builds exactly that tarball from this checkout without touching the
// repository -- no .gitignore edit, no commit -- and records its size and
// sha256. The tarball is reproducible: names sorted, owner 0, every mtime the
// time of the newest commit that touched a packaged file, gzip without a
// timestamp (so a docs-only commit leaves the sha256 unchanged).
//
// Then it proves the bytes run: the tarball is extracted into an empty
// folder named like a Store install (`quake-2`), that copy's own server.js is
// started on --port with a fresh QUAKE2_DATA_DIR, and headless Chrome opens
// /apps/quake-2/ with no query -- the app's own start-up line, which is map
// demo1 with cheats 0. The report records the archive fetches (pak0 and pak10
// 200, pak9 404 as intended), the boot time, the engine's keyboard owner, the
// start-up line, console errors and page exceptions, plus a screenshot.
//
// Ports: --port must not be the live app (4231), the control API (4233) or the
// kiosk browser (18801); Chrome's debugging port is a free one away from
// them. Only the children this run started are stopped. Node built-ins only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { ROOT, findChrome, freePort, waitFor, Cdp, sleep } from "./app-harness.mjs";

const FORBIDDEN_PORTS = new Set([4231, 4233, 18801]);
const PACKAGE_MAX_BYTES = 50 * 1024 * 1024; // the Store's compressed cap
const RAW_MAX_BYTES = 256 * 1024 * 1024; // and its raw cap
const LEFT_OUT = [/^docs\//, /^assets\//, /^baseq2\/pak9\.pak$/];
const INSTALL_ID = "quake-2"; // the Store listing's slug, which names the install folder

const options = { port: 4471, out: path.join(ROOT, "docs", "store-package"), version: null };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--port") options.port = Number(argv[++i]);
  else if (argv[i] === "--out") options.out = path.resolve(argv[++i]);
  else if (argv[i] === "--version") options.version = argv[++i];
  else if (argv[i] === "--help" || argv[i] === "-h") {
    console.log("store-package.mjs [--port 4471] [--out DIR] [--version X.Y.Z]");
    process.exit(0);
  } else {
    console.error("unknown option: " + argv[i]);
    process.exit(2);
  }
}
if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535 || FORBIDDEN_PORTS.has(options.port)) {
  console.error("--port must be a free unprivileged port other than 4231, 4233 and 18801");
  process.exit(2);
}

const report = {
  at: new Date().toISOString(),
  version: options.version,
  commit: null,
  leftOut: LEFT_OUT.map(String),
  package: null,
  boot: null,
  checks: [],
  consoleErrors: [],
  pageErrors: [],
  passed: false,
};
const children = [];
let failures = 0;

function check(name, condition, detail) {
  const pass = Boolean(condition);
  if (!pass) failures++;
  report.checks.push({ name, pass, detail: detail === undefined ? null : detail });
  console.log("  " + (pass ? "ok  " : "FAIL") + " " + name + (detail === undefined ? "" : " -- " + JSON.stringify(detail)));
}

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "buffer", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error("git " + args.join(" ") + " failed: " + String(result.stderr));
  return result.stdout;
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function portFree(port) {
  try {
    await fetch("http://127.0.0.1:" + port + "/", { signal: AbortSignal.timeout(1500) });
    return false;
  } catch {
    return true;
  }
}

function buildPackage(workDir) {
  // packProject's file set, then the three exclusions every publish makes.
  const listed = git(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).toString("utf8").split("\0").filter(Boolean);
  const files = Array.from(new Set(listed)).filter((file) => fs.existsSync(path.join(ROOT, file)) &&
    fs.statSync(path.join(ROOT, file)).isFile() && !LEFT_OUT.some((rule) => rule.test(file))).sort();
  const rawBytes = files.reduce((sum, file) => sum + fs.statSync(path.join(ROOT, file)).size, 0);
  const listFile = path.join(workDir, "files.txt");
  fs.writeFileSync(listFile, files.join("\0") + "\0");
  // The newest commit that touched anything packaged: a later commit that only
  // changes docs/ or assets/ builds the identical tarball, sha256 included.
  const commitTime = git(["log", "-1", "--format=%cI", "--", ".", ":(exclude)docs", ":(exclude)assets", ":(exclude)baseq2/pak9.pak"]).toString("utf8").trim();
  const tarball = path.join(workDir, "quake2-store" + (options.version ? "-" + options.version : "") + ".tgz");
  const tar = spawnSync("bash", ["-c",
    'tar --null -T "$1" --sort=name --owner=0 --group=0 --numeric-owner --mtime="$2" -cf - | gzip -n -6 > "$3"',
    "pack", listFile, commitTime, tarball], { cwd: ROOT, encoding: "utf8" });
  if (tar.status !== 0) throw new Error("tar failed: " + tar.stderr);
  const bytes = fs.statSync(tarball).size;
  return { tarball, files: files.length, rawBytes, bytes, sha256: sha256(tarball), mtime: commitTime,
    hasPak9: files.includes("baseq2/pak9.pak"), hasPak0: files.includes("baseq2/pak0.pak"), hasPak10: files.includes("baseq2/pak10.pak") };
}

async function stopAll() {
  for (const child of children.reverse()) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    try { child.kill("SIGTERM"); } catch { /* gone */ }
    const exited = await Promise.race([new Promise((resolve) => child.once("exit", () => resolve(true))), sleep(4000).then(() => false)]);
    if (!exited) { try { child.kill("SIGKILL"); } catch { /* gone */ } }
  }
}

async function main() {
  fs.mkdirSync(options.out, { recursive: true });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "q2-store-"));
  report.commit = git(["rev-parse", "HEAD"]).toString("utf8").trim();
  console.log("building the Store package from " + report.commit.slice(0, 12));
  const pkg = buildPackage(workDir);
  report.package = { files: pkg.files, rawBytes: pkg.rawBytes, bytes: pkg.bytes, sha256: pkg.sha256, mtime: pkg.mtime,
    name: path.basename(pkg.tarball) };
  check("the package is under the Store's 50 MiB compressed cap", pkg.bytes <= PACKAGE_MAX_BYTES, { bytes: pkg.bytes, cap: PACKAGE_MAX_BYTES });
  check("the package is under the Store's 256 MiB raw cap", pkg.rawBytes <= RAW_MAX_BYTES, { rawBytes: pkg.rawBytes, cap: RAW_MAX_BYTES });
  check("the package carries pak0 and pak10 and leaves pak9 out", pkg.hasPak0 && pkg.hasPak10 && !pkg.hasPak9,
    { pak0: pkg.hasPak0, pak10: pkg.hasPak10, pak9: pkg.hasPak9 });
  const againDir = fs.mkdtempSync(path.join(os.tmpdir(), "q2-store-again-"));
  const again = buildPackage(againDir);
  fs.rmSync(againDir, { recursive: true, force: true });
  check("the package is reproducible (a second build has the same sha256)", again.sha256 === pkg.sha256, { first: pkg.sha256, second: again.sha256 });

  // Extract into an empty folder named like the Store install and boot it.
  const installRoot = fs.mkdtempSync(path.join(os.tmpdir(), "q2-store-install-"));
  const install = path.join(installRoot, INSTALL_ID);
  fs.mkdirSync(install);
  const untar = spawnSync("tar", ["-xzf", pkg.tarball, "-C", install], { encoding: "utf8" });
  if (untar.status !== 0) throw new Error("extract failed: " + untar.stderr);
  check("the extracted package has no docs/, assets/ or pak9", !fs.existsSync(path.join(install, "docs")) &&
    !fs.existsSync(path.join(install, "assets")) && !fs.existsSync(path.join(install, "baseq2", "pak9.pak")), null);

  if (!(await portFree(options.port))) throw new Error("port " + options.port + " is already answering; choose another --port");
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "q2-store-data-"));
  const serverLog = fs.openSync(path.join(workDir, "server.log"), "w");
  const server = spawn(process.execPath, ["server.js"], {
    cwd: install,
    env: { ...process.env, PORT: String(options.port), QUAKE2_DATA_DIR: dataDir },
    stdio: ["ignore", serverLog, serverLog],
  });
  children.push(server);
  const base = "http://127.0.0.1:" + options.port + "/apps/" + INSTALL_ID + "/";
  await waitFor(async () => {
    if (server.exitCode !== null) throw new Error("the package's server.js exited with " + server.exitCode);
    const response = await fetch(base, { signal: AbortSignal.timeout(2000) });
    return response.ok;
  }, 30000, "the package's server on port " + options.port);
  const fetches = {};
  for (const pak of ["pak0.pak", "pak10.pak", "pak9.pak"]) {
    const response = await fetch(base + "baseq2/" + pak, { method: "HEAD", signal: AbortSignal.timeout(5000) });
    fetches[pak] = { status: response.status, bytes: Number(response.headers.get("content-length")) || null };
  }
  check("the package's server answers pak0 and pak10, and 404s the left-out pak9",
    fetches["pak0.pak"].status === 200 && fetches["pak10.pak"].status === 200 && fetches["pak9.pak"].status === 404, fetches);

  const cdpPort = await freePort([options.port, 4233]);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "q2-store-chrome-"));
  const chromeLog = fs.openSync(path.join(workDir, "chrome.log"), "w");
  const chrome = spawn(findChrome(), [
    "--headless=new", "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + cdpPort, "--user-data-dir=" + profile,
    "--window-size=1366,768", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check", "--mute-audio",
    "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-dev-shm-usage", "about:blank",
  ], { stdio: ["ignore", chromeLog, chromeLog] });
  children.push(chrome);
  await waitFor(async () => {
    if (chrome.exitCode !== null) throw new Error("Chrome exited with " + chrome.exitCode);
    const response = await fetch("http://127.0.0.1:" + cdpPort + "/json/version", { signal: AbortSignal.timeout(2000) });
    return response.ok;
  }, 30000, "headless Chrome");
  const targets = await (await fetch("http://127.0.0.1:" + cdpPort + "/json/list")).json();
  const page = targets.find((one) => one.type === "page" && one.webSocketDebuggerUrl);
  const cdp = new Cdp(page.webSocketDebuggerUrl);
  await cdp.open();
  cdp.on("Runtime.consoleAPICalled", (params) => {
    if (params.type !== "error") return;
    report.consoleErrors.push((params.args || []).map((arg) => (arg.value !== undefined ? String(arg.value) : arg.description || "")).join(" "));
  });
  cdp.on("Runtime.exceptionThrown", (params) => {
    const details = params.exceptionDetails || {};
    report.pageErrors.push((details.exception && details.exception.description) || details.text || "exception");
  });
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  const evaluate = async (expression) => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "page exception");
    return result.result.value;
  };
  const startedAt = Date.now();
  await cdp.send("Page.navigate", { url: base });
  const game = await waitFor(async () => {
    const state = await evaluate("(() => { try { return window.quake2Engine && window.quake2Engine.read ? window.quake2Engine.read() : null; } catch (error) { return null; } })()");
    return state && state.ok && state.keyDest === 0 && state.position && (state.position.x || state.position.y) ? state : false;
  }, 240000, "the packaged game in a level", 300);
  const bootMs = Date.now() - startedAt;
  const startup = await evaluate("window.quake2StartupArguments || null");
  const status = await evaluate("(document.getElementById('status') || {}).textContent || null");
  await sleep(2500);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
  const shotFile = path.join(options.out, "boot.png");
  fs.writeFileSync(shotFile, Buffer.from(shot.data, "base64"));
  cdp.close();
  report.boot = { url: base.replace(String(options.port), "<port>"), port: options.port, bootMs, keyDest: game.keyDest,
    position: game.position, startup, status, screenshot: path.relative(ROOT, shotFile) };
  const cheatsOn = Array.isArray(startup) && startup.some((token, i) => /^(\+set|set)$/.test(token) && /^cheats$/i.test(startup[i + 1] || "") && startup[i + 2] !== "0");
  check("the packaged app boots into a level with the keyboard in the game", game.keyDest === 0, { bootMs, position: game.position });
  check("its start-up line is map demo1 with cheats 0", Array.isArray(startup) && startup.join(" ").includes("+map demo1") && !cheatsOn,
    { startupTail: Array.isArray(startup) ? startup.slice(-4) : startup });
  check("no console errors and no page exceptions", report.consoleErrors.length === 0 && report.pageErrors.length === 0,
    { consoleErrors: report.consoleErrors.slice(0, 3), pageErrors: report.pageErrors.slice(0, 3) });

  fs.rmSync(installRoot, { recursive: true, force: true });
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(profile, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
}

let code = 0;
try {
  await main();
} catch (error) {
  failures++;
  report.error = String((error && error.stack) || error);
  console.error("store-package: " + report.error);
} finally {
  await stopAll();
  report.passed = failures === 0;
  fs.mkdirSync(options.out, { recursive: true });
  fs.writeFileSync(path.join(options.out, "store-package.json"), JSON.stringify(report, null, 2) + "\n");
  const pkg = report.package;
  console.log((report.passed ? "PASSED" : "FAILED") + ": " + report.checks.filter((one) => one.pass).length + "/" + report.checks.length + " checks" +
    (pkg ? "; package " + pkg.bytes + " bytes, sha256 " + pkg.sha256 : ""));
  code = report.passed ? 0 : 1;
}
process.exit(code);
