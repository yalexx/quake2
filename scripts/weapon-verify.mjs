#!/usr/bin/env node
// Verifies the 2x view-weapon art end to end.
//
//   node scripts/weapon-verify.mjs
//
// What it checks
//   1. In game: boots demo1 at 1280x720, gives every weapon, then puts each of
//      the 13 v_* view weapons in hand and captures it. Every frame must report
//      that weapon's model/skin draw through window.quake2RTX (the skin size it
//      bound, the neutral weapon draw, the name the crosshair code derives from
//      the skin), and the captured frame must differ from the same frame with
//      cl_gun 0 (the gun is really there, not blank).
//   2. Saturation: decodes the 13 pak10 skins and the 13 pak0 originals and
//      compares mean HSV saturation and mean chroma over opaque texels.
//   3. Edges: index-255 cut-out count and mask, no near-black/near-white fringe
//      introduced at the cut-out, and a blockiness metric (luma step at 2-texel
//      block boundaries over the step inside blocks) for the whole skin and for
//      the pistol-bottom band.
//   4. The project's own offline passes: tex-check, texture-pack --dry-run and
//      texture-audit --select.
//
// It starts its own server on a free port (never 4231) and its own headless
// Chromium on a free debugging port (never 18801/9222), and kills both. The
// live server and kiosk are never touched.
//
// baseq2's game module has no item for three of the thirteen models
// (v_flareg, v_disint, v_handgr), so those cannot be selected with `use`. For
// those three the verifier boots one extra session with a test-only pak10,
// built in memory, that swaps each model+skin into a real weapon slot
// (v_blast, v_shotg, v_machn) and adds a v_flareg skin entry so the renderer's
// skin-size index can name it. No repository file is changed for this: the
// archive is delivered by CDP request interception for that session only.
//
// Exit code 0 only when every measured check passes.

import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { QuakeControl } from "../control/bridge.mjs";
import {
  loadPak,
  readPakDirectory,
  readPakFile,
  decodePcx,
  buildPak,
  decodePng,
  pngSize,
} from "./texture-lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PAK0 = path.join(ROOT, "baseq2/pak0.pak");
const PAK10 = path.join(ROOT, "baseq2/pak10.pak");
const OUT_DEFAULT = path.join(ROOT, "docs/weapon-review");
const TRANSPARENT = 255;
const BUSY_PORTS = [4231, 18801, 9222];

// Thresholds, stated once and quoted in the report.
const LIMITS = {
  meanSaturationGain: 0.005,   // pak10 mean minus pak0 mean, over the 13 skins
  meanChromaGain: 0,           // pak10 mean must be at least pak0's
  cutoutRatio: 4,              // 2x2 replication: exactly four transparent texels per original
  cutoutRatioTolerance: 0.001, // floating point; the counts are integers
  fringeDistance: 48,          // max-channel RGB distance to the source 3x3 colours
  fringeLumaDark: 12,          // a fringe is near-black...
  fringeLumaLight: 243,        // ...or near-white,
  fringeChroma: 24,            // ...and has little colour of its own
  edgeLumaShiftLevels: 20,     // boundary mean luma may move this many levels (0-255) vs the source
  blockRatioMax: 3.0,          // boundary luma step / inside-block luma step
  blockRatioPistolMargin: 0.5, // v_blast bottom band must not exceed the worst other skin by more
  blockRatioSensitivity: 1000, // nearest-neighbour 2x control must blow past the bound
  minGunPixels: 2000,          // changed pixels (gun vs cl_gun 0) per captured frame
  minPairDiffPixels: 1000,     // two weapons sharing one skin size must differ
};

const args = process.argv.slice(2);
const texturesOnly = args.includes("--textures-only");
const outIndex = args.indexOf("--out");
const OUT = outIndex >= 0 && args[outIndex + 1] ? path.resolve(args[outIndex + 1]) : OUT_DEFAULT;
const shotsDir = path.join(OUT, "shots");
const evidenceDir = path.join(OUT, "evidence");
const scratchRoot = process.env.CLAWBOX_RUN_ARTIFACTS_DIR || os.tmpdir();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [];
const logLines = [];
// Every session registers here so an interrupt still kills the server and the
// headless browser this run started, rather than leaving them behind.
const activeSessions = new Set();

function log(...parts) {
  const line = parts.map((part) => (typeof part === "string" ? part : JSON.stringify(part))).join(" ");
  logLines.push(line);
  process.stdout.write(line + "\n");
}
function check(id, name, pass, detail, value) {
  checks.push({ id, name, pass: Boolean(pass), detail: detail || "", value: value === undefined ? null : value });
  log((pass ? "PASS" : "FAIL"), id, name, detail ? "- " + detail : "");
  return Boolean(pass);
}
function waitFor(label, probe, timeout = 90000, interval = 300) {
  const started = Date.now();
  let lastError = null;
  return (async () => {
    while (Date.now() - started < timeout) {
      try {
        const value = await probe();
        if (value) return value;
      } catch (error) {
        lastError = error;
      }
      await sleep(interval);
    }
    throw new Error("timed out waiting for " + label + (lastError ? ": " + lastError.message : ""));
  })();
}
async function freePort() {
  for (let attempt = 0; attempt < 40; attempt++) {
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address().port;
        server.close(() => resolve(address));
      });
    });
    if (!BUSY_PORTS.includes(port)) return port;
  }
  throw new Error("could not find a spare port");
}
function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}
// The archive's size at the commit before the one that last changed it, so the
// report can state how much the weapon-art commit added rather than ask the
// reader to diff binaries. Null outside a git checkout.
function previousPakSize(relative) {
  try {
    const revs = execFileSync("git", ["log", "--format=%H", "--", relative], { cwd: ROOT, encoding: "utf8" })
      .trim()
      .split("\n")
      .filter(Boolean);
    if (revs.length < 2) return null;
    const size = Number(execFileSync("git", ["cat-file", "-s", revs[1] + ":" + relative], { cwd: ROOT, encoding: "utf8" }).trim());
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Texture metrics
// ---------------------------------------------------------------------------

const WEAPONS = [
  { name: "v_blast", item: "Blaster" },
  { name: "v_shotg", item: "Shotgun" },
  { name: "v_shotg2", item: "Super Shotgun" },
  { name: "v_machn", item: "Machinegun" },
  { name: "v_chain", item: "Chaingun" },
  { name: "v_launch", item: "Grenade Launcher" },
  { name: "v_rocket", item: "Rocket Launcher" },
  { name: "v_rail", item: "Railgun" },
  { name: "v_hyperb", item: "HyperBlaster" },
  { name: "v_bfg", item: "BFG10K" },
  { name: "v_disint", item: null, extra: true },
  { name: "v_flareg", item: null, extra: true },
  { name: "v_handgr", item: null, extra: true },
];
const EXTRAS = [
  { name: "v_flareg", slot: "v_blast", item: "Blaster" },
  { name: "v_disint", slot: "v_shotg", item: "Shotgun" },
  { name: "v_handgr", slot: "v_machn", item: "Machinegun" },
];

function skinEntry(pak, weapon) {
  for (const file of ["skin.pcx", "base.pcx"]) {
    const bytes = readPakFile(pak, `models/weapons/${weapon}/${file}`);
    if (bytes) return { file, bytes: Buffer.from(bytes) };
  }
  throw new Error("no view-weapon skin for " + weapon);
}
function md2Entry(pak, weapon) {
  const bytes = readPakFile(pak, `models/weapons/${weapon}/tris.md2`);
  if (!bytes) throw new Error("no view-weapon model for " + weapon);
  return Buffer.from(bytes);
}

const luma = (palette, index) => 0.299 * palette[index * 3] + 0.587 * palette[index * 3 + 1] + 0.114 * palette[index * 3 + 2];
const chroma = (palette, index) => Math.max(palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]) - Math.min(palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]);

function skinStats(pcx) {
  let saturation = 0;
  let chromaSum = 0;
  let opaque = 0;
  let transparent = 0;
  for (const index of pcx.indices) {
    if (index === TRANSPARENT) {
      transparent++;
      continue;
    }
    const r = pcx.palette[index * 3];
    const g = pcx.palette[index * 3 + 1];
    const b = pcx.palette[index * 3 + 2];
    const high = Math.max(r, g, b);
    if (high) saturation += (high - Math.min(r, g, b)) / high;
    chromaSum += high - Math.min(r, g, b);
    opaque++;
  }
  return { saturation: opaque ? saturation / opaque : 0, chroma: opaque ? chromaSum / opaque : 0, opaque, transparent };
}

// Boundary = an opaque texel with a 4-neighbour transparent texel. Every such
// texel is compared with the opaque colours of the 3x3 source block it came
// from. A fringe counts as introduced only when it is near-black/near-white and
// farther than `fringeDistance` from every source colour (the source art really
// does paint dark outlines, so those must not be reported).
function boundaryStats(original, scaled) {
  const nearFringe = (palette, index) => {
    const value = luma(palette, index);
    return chroma(palette, index) <= LIMITS.fringeChroma && (value <= LIMITS.fringeLumaDark || value >= LIMITS.fringeLumaLight);
  };
  let boundary = 0;
  let fringe = 0;
  let introduced = 0;
  let maxFringeDistance = 0;
  let maxDistance = 0;
  let lumaSum = 0;
  for (let y = 0; y < scaled.height; y++) {
    for (let x = 0; x < scaled.width; x++) {
      const index = scaled.indices[y * scaled.width + x];
      if (index === TRANSPARENT) continue;
      let adjacent = false;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= scaled.width || ny >= scaled.height) continue;
        if (scaled.indices[ny * scaled.width + nx] === TRANSPARENT) adjacent = true;
      }
      if (!adjacent) continue;
      boundary++;
      lumaSum += luma(scaled.palette, index);
      const ox = x >> 1;
      const oy = y >> 1;
      let nearest = Infinity;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const sx = ox + dx;
          const sy = oy + dy;
          if (sx < 0 || sy < 0 || sx >= original.width || sy >= original.height) continue;
          const sourceIndex = original.indices[sy * original.width + sx];
          if (sourceIndex === TRANSPARENT) continue;
          let distance = 0;
          for (let channel = 0; channel < 3; channel++) {
            distance = Math.max(distance, Math.abs(scaled.palette[index * 3 + channel] - original.palette[sourceIndex * 3 + channel]));
          }
          if (distance < nearest) nearest = distance;
        }
      }
      if (Number.isFinite(nearest)) {
        maxDistance = Math.max(maxDistance, nearest);
        if (nearFringe(scaled.palette, index)) {
          fringe++;
          maxFringeDistance = Math.max(maxFringeDistance, nearest);
          if (nearest > LIMITS.fringeDistance) introduced++;
        }
      }
    }
  }
  let sourceBoundary = 0;
  let sourceFringe = 0;
  let sourceLumaSum = 0;
  for (let y = 0; y < original.height; y++) {
    for (let x = 0; x < original.width; x++) {
      const index = original.indices[y * original.width + x];
      if (index === TRANSPARENT) continue;
      let adjacent = false;
      for (const [dx, dy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= original.width || ny >= original.height) continue;
        if (original.indices[ny * original.width + nx] === TRANSPARENT) adjacent = true;
      }
      if (adjacent) {
        sourceBoundary++;
        sourceLumaSum += luma(original.palette, index);
        if (nearFringe(original.palette, index)) sourceFringe++;
      }
    }
  }
  return {
    boundary,
    sourceBoundary,
    sourceFringe,
    fringe,
    introduced,
    maxFringeDistance,
    maxDistance,
    lumaMean: boundary ? lumaSum / boundary : 0,
    sourceLumaMean: sourceBoundary ? sourceLumaSum / sourceBoundary : 0,
  };
}

// Boundary/inside luma-step ratio on the 2x grid. A plain nearest-neighbour
// upscale has no step inside a block at all (ratio -> huge); a smoothed upscale
// keeps the two close (ratio near 2, a step each side of the edge). `from`/`to`
// are fractions of the height, so the pistol-bottom band is the lower 40%.
function blockRatio(pcx, from = 0, to = 1) {
  const y0 = Math.floor(pcx.height * from);
  const y1 = Math.floor(pcx.height * to);
  let inside = 0;
  let insideCount = 0;
  let boundary = 0;
  let boundaryCount = 0;
  let insideY = 0;
  let insideCountY = 0;
  let boundaryY = 0;
  let boundaryCountY = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = 0; x < pcx.width - 1; x++) {
      const step = Math.abs(luma(pcx.palette, pcx.indices[y * pcx.width + x]) - luma(pcx.palette, pcx.indices[y * pcx.width + x + 1]));
      if (x % 2 === 0) {
        inside += step;
        insideCount++;
      } else {
        boundary += step;
        boundaryCount++;
      }
    }
  }
  // The same step across the horizontal 2-texel grid, so a vertically banded
  // upscale cannot pass on the horizontal number alone.
  for (let y = y0; y < y1 - 1; y++) {
    for (let x = 0; x < pcx.width; x++) {
      const step = Math.abs(luma(pcx.palette, pcx.indices[y * pcx.width + x]) - luma(pcx.palette, pcx.indices[(y + 1) * pcx.width + x]));
      if (y % 2 === 0) {
        insideY += step;
        insideCountY++;
      } else {
        boundaryY += step;
        boundaryCountY++;
      }
    }
  }
  const insideMean = insideCount ? inside / insideCount : 0;
  const boundaryMean = boundaryCount ? boundary / boundaryCount : 0;
  const insideMeanY = insideCountY ? insideY / insideCountY : 0;
  const boundaryMeanY = boundaryCountY ? boundaryY / boundaryCountY : 0;
  const ratioX = boundaryMean / (insideMean || 1e-9);
  const ratioY = boundaryMeanY / (insideMeanY || 1e-9);
  return { inside: insideMean, boundary: boundaryMean, ratioX, insideY: insideMeanY, boundaryY: boundaryMeanY, ratioY, ratio: Math.max(ratioX, ratioY) };
}

function nearestNeighbour2x(pcx) {
  const width = pcx.width * 2;
  const height = pcx.height * 2;
  const indices = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      indices[y * width + x] = pcx.indices[(y >> 1) * pcx.width + (x >> 1)];
    }
  }
  return { width, height, indices, palette: pcx.palette };
}

// The renderer's own skin-size index: every models/weapons/v_*/skin.pcx entry
// (base.pcx is not indexed), keyed by the PCX header size, in pak order. This
// mirrors rtx-renderer.js so the expected crosshair name is derived, not typed.
function skinSizeIndex(paks) {
  const map = new Map();
  for (const pak of paks) {
    const directory = readPakDirectory(pak);
    for (const entry of directory.values()) {
      const match = /^models\/weapons\/(v_[a-z0-9]+)\/skin\.pcx$/.exec(entry.name);
      if (!match) continue;
      if (entry.offset + 16 > pak.length) continue;
      const width = pak.readUInt16LE(entry.offset + 8) - pak.readUInt16LE(entry.offset + 4) + 1;
      const height = pak.readUInt16LE(entry.offset + 10) - pak.readUInt16LE(entry.offset + 6) + 1;
      if (!width || !height) continue;
      const key = width + "x" + height;
      const list = map.get(key) || [];
      if (!list.includes(match[1])) list.push(match[1]);
      map.set(key, list);
    }
  }
  return map;
}

function pcxSize(pcx) {
  return pcx.width + "x" + pcx.height;
}

function analyseTextures(pak0, pak10) {
  const results = [];
  for (const weapon of WEAPONS) {
    const originalBytes = skinEntry(pak0, weapon.name);
    const scaledBytes = skinEntry(pak10, weapon.name);
    const original = decodePcx(originalBytes.bytes);
    const scaled = decodePcx(scaledBytes.bytes);
    const before = skinStats(original);
    const after = skinStats(scaled);
    let cutoutOriginal = 0;
    let cutoutScaled = 0;
    for (const index of original.indices) if (index === TRANSPARENT) cutoutOriginal++;
    for (const index of scaled.indices) if (index === TRANSPARENT) cutoutScaled++;
    let mismatch = -1;
    if (scaled.width === original.width * 2 && scaled.height === original.height * 2) {
      mismatch = 0;
      for (let y = 0; y < original.height; y++) {
        for (let x = 0; x < original.width; x++) {
          const sourceTransparent = original.indices[y * original.width + x] === TRANSPARENT;
          for (let dy = 0; dy < 2; dy++) {
            for (let dx = 0; dx < 2; dx++) {
              const scaledTransparent = scaled.indices[(2 * y + dy) * scaled.width + 2 * x + dx] === TRANSPARENT;
              if (sourceTransparent !== scaledTransparent) mismatch++;
            }
          }
        }
      }
    }
    const edges = boundaryStats(original, scaled);
    const control = blockRatio(nearestNeighbour2x(original));
    results.push({
      name: weapon.name,
      originalFile: originalBytes.file,
      scaledFile: scaledBytes.file,
      originalSize: pcxSize(original),
      scaledSize: pcxSize(scaled),
      original,
      scaled,
      saturationOriginal: before.saturation,
      saturationScaled: after.saturation,
      chromaOriginal: before.chroma,
      chromaScaled: after.chroma,
      opaqueOriginal: before.opaque,
      opaqueScaled: after.opaque,
      cutoutOriginal,
      cutoutScaled,
      // A skin with no transparent texel must keep none; that is a 4x count of
      // zero, not an unknown ratio.
      cutoutRatio: cutoutOriginal ? cutoutScaled / cutoutOriginal : cutoutScaled === 0 ? LIMITS.cutoutRatio : 0,
      cutoutMismatch: mismatch,
      edge: edges,
      blockAll: blockRatio(scaled),
      blockBottom: blockRatio(scaled, 0.6, 1),
      blockControl: control,
      blockBottomControl: blockRatio(nearestNeighbour2x(original), 0.6, 1),
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Paks: the clean pair, the original-art baseline, and the extra-weapon archive
// ---------------------------------------------------------------------------

function buildOriginalPak10(pak0, pak10) {
  const replacements = new Map();
  for (const weapon of WEAPONS) {
    const scaled = skinEntry(pak10, weapon.name);
    const original = skinEntry(pak0, weapon.name);
    replacements.set(`models/weapons/${weapon.name}/tris.md2`, md2Entry(pak0, weapon.name));
    replacements.set(`models/weapons/${weapon.name}/${scaled.file}`, original.bytes);
  }
  return buildPak(pak10, replacements).buffer;
}

function buildExtraPak10(pak10) {
  const replacements = new Map();
  for (const extra of EXTRAS) {
    const model = md2Entry(pak10, extra.name);
    const skin = skinEntry(pak10, extra.name);
    replacements.set(`models/weapons/${extra.slot}/tris.md2`, model);
    replacements.set(`models/weapons/${extra.slot}/skin.pcx`, skin.bytes);
  }
  // v_flareg's skin is base.pcx, which the renderer's size index ignores. Give
  // it the same skin under the skin.pcx name so the drawn 624x338 size is
  // named v_flareg (only the index reads this entry; the engine never asks for
  // it). The pak builder appends it after the archive's own entries.
  replacements.set("models/weapons/v_flareg/skin.pcx", skinEntry(pak10, "v_flareg").bytes);
  return buildPak(pak10, replacements).buffer;
}

// ---------------------------------------------------------------------------
// Browser session
// ---------------------------------------------------------------------------

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
  }
  async open() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", () => reject(new Error("WebSocket failed")), { once: true });
    });
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(typeof event.data === "string" ? event.data : Buffer.from(event.data).toString("utf8"));
      if (message.id && this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
        else pending.resolve(message.result);
        return;
      }
      if (message.method && this.handlers.has(message.method)) {
        for (const handler of this.handlers.get(message.method)) {
          Promise.resolve()
            .then(() => handler(message.params))
            .catch((error) => log("cdp handler", message.method, error.message));
        }
      }
    });
  }
  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }
  send(method, params = {}, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(method + " timed out"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try {
      this.ws.close();
    } catch {
      // already closed
    }
  }
}

class Session {
  constructor(name, pakOverrides) {
    this.name = name;
    this.pakOverrides = pakOverrides || null; // { "pak10.pak": Buffer }
    this.scratch = fs.mkdtempSync(path.join(scratchRoot, "weapon-verify-" + name + "-"));
    this.serverPort = null;
    this.debugPort = null;
    this.server = null;
    this.chrome = null;
    this.cdp = null;
    this.served = 0;
    activeSessions.add(this);
  }
  async start() {
    this.serverPort = await freePort();
    this.dataDir = path.join(this.scratch, "data");
    fs.mkdirSync(this.dataDir, { recursive: true });
    const serverLog = fs.openSync(path.join(this.scratch, "server.log"), "w");
    this.server = spawn(process.execPath, ["server.js"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(this.serverPort), QUAKE2_DATA_DIR: this.dataDir },
      stdio: ["ignore", serverLog, serverLog],
    });
    this.base = `http://127.0.0.1:${this.serverPort}/apps/quake2/`;
    await waitFor(this.name + " server", async () => (await fetch(this.base, { signal: AbortSignal.timeout(2000) })).ok, 30000);

    const chromePath = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium"].find((candidate) => fs.existsSync(candidate));
    if (!chromePath) throw new Error("no Chromium/Chrome found");
    this.debugPort = await freePort();
    const profile = path.join(this.scratch, "chrome");
    fs.mkdirSync(profile, { recursive: true });
    const chromeLog = fs.openSync(path.join(this.scratch, "chrome.log"), "w");
    this.chrome = spawn(chromePath, [
      "--headless=new", "--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
      "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=" + this.debugPort,
      "--user-data-dir=" + profile, "--window-size=1280,720", "--hide-scrollbars", "--no-first-run",
      "--no-default-browser-check", "--disable-infobars", "--disable-features=Translate,MediaRouter",
      "--autoplay-policy=no-user-gesture-required", "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", "--disable-dev-shm-usage",
      "--mute-audio", "about:blank",
    ], { stdio: ["ignore", chromeLog, chromeLog] });
    this.cdpBase = "http://127.0.0.1:" + this.debugPort;
    await waitFor(this.name + " cdp", async () => (await fetch(this.cdpBase + "/json/version", { signal: AbortSignal.timeout(2000) })).ok, 30000);
    const targets = await (await fetch(this.cdpBase + "/json/list")).json();
    const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
    if (!page) throw new Error("no page target in " + this.name + " Chrome");
    this.cdp = new Cdp(page.webSocketDebuggerUrl);
    await this.cdp.open();
    await this.cdp.send("Page.enable");
    await this.cdp.send("Runtime.enable");
    await this.cdp.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    if (this.pakOverrides) await this.installOverrides();
  }
  async installOverrides() {
    const entries = Object.entries(this.pakOverrides).map(([name, buffer]) => [name, buffer.toString("base64"), buffer.length]);
    this.cdp.on("Fetch.requestPaused", async (params) => {
      const hit = entries.find(([name]) => params.request.url.includes("baseq2/" + name));
      try {
        if (hit) {
          this.served++;
          await this.cdp.send("Fetch.fulfillRequest", {
            requestId: params.requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Content-Type", value: "application/octet-stream" },
              { name: "Content-Length", value: String(hit[2]) },
              { name: "Cache-Control", value: "no-store" },
            ],
            body: hit[1],
          });
        } else {
          await this.cdp.send("Fetch.continueRequest", { requestId: params.requestId });
        }
      } catch (error) {
        log(this.name, "fetch interception failed:", error.message);
      }
    });
    await this.cdp.send("Fetch.enable", {
      patterns: Object.keys(this.pakOverrides).map((name) => ({ urlPattern: "*baseq2/" + name + "*", requestStage: "Request" })),
    });
  }
  async evaluate(expression, awaitPromise = false) {
    const result = await this.cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 500));
    return result.result.value;
  }
  async open() {
    await this.cdp.send("Page.navigate", { url: this.base + "?+set&r_mode&14" });
    await waitFor(this.name + " steady state", async () => {
      const state = await this.state();
      return state.ok && state.position && (state.position.x || state.position.y);
    }, 180000);
    await sleep(1000);
    return this.state();
  }
  async state() {
    return JSON.parse(await this.evaluate(`(() => {
      const engine = window.quake2Engine && window.quake2Engine.read ? window.quake2Engine.read() : null;
      const canvas = document.getElementById("canvas");
      return JSON.stringify({
        ok: Boolean(engine && engine.ok),
        keyDest: engine ? engine.keyDest : null,
        keyDestName: engine ? engine.keyDestName : null,
        consoleOpen: Boolean(engine && engine.consoleOpen),
        position: engine ? engine.position : null,
        canvasDisplay: canvas ? getComputedStyle(canvas).display : null,
        canvasWidth: canvas ? canvas.width : null,
        canvasHeight: canvas ? canvas.height : null
      });
    })()`));
  }
  async crosshair() {
    return JSON.parse(await this.evaluate("JSON.stringify(window.quake2RTX.crosshairState())"));
  }
  async status() {
    return JSON.parse(await this.evaluate("JSON.stringify(window.quake2RTX.status())"));
  }
  async hidePageChrome() {
    await this.evaluate(`(() => {
      const style = document.createElement("style");
      style.id = "weapon-verify-hide-page-chrome";
      style.textContent = "#options-chip,#lighting-chip,#prompt,#fullscreen-button,#fullscreen-hint,#banner{display:none !important}";
      document.head.appendChild(style);
      return true;
    })()`);
  }
  async screenshot() {
    const result = await this.cdp.send("Page.captureScreenshot", { format: "png" });
    return Buffer.from(result.data, "base64");
  }
  async close() {
    activeSessions.delete(this);
    try {
      if (this.cdp) this.cdp.close();
    } catch {
      // already closed
    }
    for (const child of [this.chrome, this.server]) {
      if (!child || child.exitCode !== null) continue;
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
    this.cdp = null;
    this.chrome = null;
    this.server = null;
    try {
      fs.rmSync(this.scratch, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

class Engine {
  constructor(session) {
    this.session = session;
    this.control = null;
  }
  async connect() {
    this.control = new QuakeControl({ cdpUrl: this.session.cdpBase, gameUrlMark: "/apps/quake2/", timeoutMs: 90000 });
  }
  async disconnect() {
    try {
      if (this.control) await this.control.close();
    } catch {
      // already closed
    }
    this.control = null;
  }
  async reconnect() {
    await this.disconnect();
    await sleep(600);
    await this.connect();
  }
  // The console and menu take a moment to finish opening or closing; tapping
  // again in that window toggles them straight back, which is how a screenshot
  // ends up with the console over it. So look twice before tapping.
  async ensureGame(timeout = 15000) {
    if (!this.control) await this.connect();
    const started = Date.now();
    while (Date.now() - started < timeout) {
      let state = await this.session.state();
      if (state.ok && state.keyDest === 0 && !state.consoleOpen) return state;
      try {
        if (state.consoleOpen || state.keyDestName === "console") {
          await sleep(450);
          state = await this.session.state();
          if (state.consoleOpen || state.keyDestName === "console") await this.control.tap("`");
        } else if (state.keyDestName === "menu") {
          await sleep(300);
          state = await this.session.state();
          if (state.keyDestName === "menu") await this.control.tap("Escape");
        }
      } catch {
        this.control = null;
        await this.connect();
      }
      await sleep(300);
    }
    return this.session.state();
  }
  // Stop a key the console typing may have left down. A command typed while
  // the console is NOT open lands in the game as keystrokes, and one movement
  // key left down walks the player for the rest of the run.
  async stopWalking() {
    try { await this.control.release(["w", "a", "s", "d", "Space", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"]); } catch { /* best effort */ }
  }
  async run(text, tail = 40) {
    if (!this.control) await this.connect();
    let state = await this.session.state();
    this.control.consoleOpen = Boolean(state.consoleOpen);
    if (!this.control.consoleOpen) {
      // Open the console here and confirm it before typing. The bridge's own
      // toggle is one key press with no confirmation; when that press is lost
      // the command's characters go to the game instead, and a movement key
      // left down walks the player away (measured 2026-11-03: the view moved
      // 300,481 pixels between two captures, every weapon stayed the shotgun,
      // and `use ...` came back ran=false). An attempt that cannot open the
      // console says so instead of typing into the game.
      await this.control.tap("`");
      for (let i = 0; i < 10; i++) {
        await sleep(250);
        state = await this.session.state();
        if (state.consoleOpen) break;
      }
      if (!state.consoleOpen) {
        await this.stopWalking();
        return {
          commands: [String(text)], ran: false, echoFound: false, consoleOpen: false,
          output: [], reason: "CONSOLE_NOT_OPEN",
          message: "the engine's console did not open, so the command was not typed into the game",
        };
      }
      this.control.consoleOpen = true;
    }
    return this.control.command(text, { tail });
  }
  async runUntilEcho(text, attempts = 6, tail = 40) {
    let last = null;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        await this.ensureGame(8000).catch(() => {});
        const answer = await this.run(text, tail);
        last = answer;
        if (answer.ran && answer.echoFound) return answer;
        log("  retry", JSON.stringify(text), "ran=" + answer.ran, "echo=" + answer.echoFound);
      } catch (error) {
        last = error.message;
        log("  retry", JSON.stringify(text), "threw " + error.message);
      }
      await this.stopWalking();
      await this.reconnect();
    }
    throw new Error("never echoed " + JSON.stringify(text) + ": " + JSON.stringify(last));
  }
  async cvar(name) {
    const pattern = new RegExp('"' + name + '" is "([^"]*)"', "i");
    for (let attempt = 0; attempt < 6; attempt++) {
      const answer = await this.runUntilEcho(name, 6, 12);
      const text = (answer.output || []).join("\n");
      const match = pattern.exec(text);
      if (match) return match[1];
      // A read taken in the first second or two after the first frame echoes
      // but carries no value: measured 2026-11-03, `]cl_gun` came back with
      // `==== ShutdownGame ====` where the value line belongs, while the same
      // read 4 s later answered `"cl_gun" is "1"`. Wait the engine out instead
      // of reporting a null cvar as a failure.
      log("  cvar", name, "answered with no value; retrying");
      await sleep(1500);
    }
    return null;
  }
  async pollWeapon(expected, timeout = 25000) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeout) {
      const state = await this.session.state();
      if (state.keyDest !== 0 || state.consoleOpen) await this.ensureGame(6000).catch(() => {});
      const crosshair = await this.session.crosshair();
      last = crosshair.weapon;
      if (crosshair.weapon === expected) return crosshair;
      await sleep(300);
    }
    return { weapon: last, timedOut: true };
  }
  async useWeapon(item, expected) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const answer = await this.runUntilEcho("use " + item, 6, 20);
      const text = (answer.output || []).join("\n");
      if (/out of item/i.test(text)) {
        log("  out of item, re-running give all");
        await this.giveAll();
        continue;
      }
      const crosshair = await this.pollWeapon(expected);
      if (!crosshair.timedOut) return crosshair;
      log("  weapon never became", expected, "- re-running give all");
      await this.giveAll();
    }
    const crosshair = await this.pollWeapon(expected, 5000);
    return crosshair;
  }
  async giveAll() {
    await this.runUntilEcho("sv_cheats 1", 6, 12);
    const answer = await this.runUntilEcho("give all", 8, 40);
    await sleep(400);
    return answer;
  }
}

function decodeShot(buffer) {
  const png = decodePng(buffer);
  return { width: png.width, height: png.height, data: png.data };
}

function gunStats(shot, noGun) {
  const width = shot.width;
  const height = shot.height;
  const x0 = Math.floor(width * 0.30);
  const y0 = Math.floor(height * 0.40);
  let pixels = 0;
  let saturation = 0;
  let chromaSum = 0;
  for (let y = y0; y < height; y++) {
    for (let x = x0; x < width; x++) {
      const at = (y * width + x) * 4;
      const diff = Math.max(
        Math.abs(shot.data[at] - noGun.data[at]),
        Math.abs(shot.data[at + 1] - noGun.data[at + 1]),
        Math.abs(shot.data[at + 2] - noGun.data[at + 2]),
      );
      if (diff <= 16) continue;
      pixels++;
      const r = shot.data[at];
      const g = shot.data[at + 1];
      const b = shot.data[at + 2];
      const high = Math.max(r, g, b);
      if (high) saturation += (high - Math.min(r, g, b)) / high;
      chromaSum += high - Math.min(r, g, b);
    }
  }
  return { pixels, saturation: pixels ? saturation / pixels : 0, chroma: pixels ? chromaSum / pixels : 0 };
}

// Changed pixels in the upper 40% of the frame, where the first-person weapon
// never reaches: a proxy for demo motion between two captures. Two back-to-back
// frames with the gun still drawn measure it without involving the gun.
function noiseStats(a, b) {
  if (a.width !== b.width || a.height !== b.height) return 0;
  const width = a.width;
  const height = Math.floor(a.height * 0.4);
  let pixels = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const diff = Math.max(
        Math.abs(a.data[at] - b.data[at]),
        Math.abs(a.data[at + 1] - b.data[at + 1]),
        Math.abs(a.data[at + 2] - b.data[at + 2]),
      );
      if (diff > 16) pixels++;
    }
  }
  return pixels;
}

function diffPixels(a, b) {
  if (a.width !== b.width || a.height !== b.height) return { pixels: -1, total: 0 };
  const width = a.width;
  const height = a.height;
  const x0 = Math.floor(width * 0.30);
  const y0 = Math.floor(height * 0.40);
  let pixels = 0;
  let total = 0;
  for (let y = y0; y < height; y++) {
    for (let x = x0; x < width; x++) {
      total++;
      const at = (y * width + x) * 4;
      const diff = Math.max(
        Math.abs(a.data[at] - b.data[at]),
        Math.abs(a.data[at + 1] - b.data[at + 1]),
        Math.abs(a.data[at + 2] - b.data[at + 2]),
      );
      if (diff > 16) pixels++;
    }
  }
  return { pixels, total };
}

// ---------------------------------------------------------------------------
// In-game session
// ---------------------------------------------------------------------------

// A screenshot taken only once the game, not the console or menu, owns the
// keyboard, and checked again after the capture so a console that opened
// mid-frame is caught rather than measured.
async function captureStill(session, engine, attempts = 4) {
  let last = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await engine.ensureGame(12000);
    await sleep(250);
    const before = await session.state();
    if (before.ok && before.keyDest === 0 && !before.consoleOpen) {
      const shot = await session.screenshot();
      const after = await session.state();
      if (after.ok && after.keyDest === 0 && !after.consoleOpen) return { shot, state: after };
      last = after;
    } else {
      last = before;
    }
    await sleep(400);
  }
  throw new Error("could not capture a frame with the game in hand: " + JSON.stringify(last));
}

async function captureWeapons(session, engine, list, options) {
  const results = [];
  for (const weapon of list) {
    const expected = options.expectedName(weapon.name);
    const size = options.expectedSize(weapon.name);
    log(session.name, "weapon", weapon.name, "size", size, "expect", expected);
    const before = await session.status();
    let crosshair = null;
    let useAnswer = null;
    try {
      useAnswer = await engine.useWeapon(weapon.item, expected);
      crosshair = useAnswer;
      await sleep(700);
    } catch (error) {
      log(session.name, "switch failed", weapon.name, error.message);
    }
    // Capture the weapon in hand, then the same view with the view weapon
    // hidden: the changed pixels are the gun. A cvar change lands on the next
    // drawn frame and a headless capture can beat it, which would report a real
    // gun as zero gun pixels; a demo that is animating would contribute pixels
    // of its own. So the pair is retried until the frames differ, the upper
    // 40% of the screen (where the view weapon never reaches) is sampled as
    // scene noise, and the pair is captured again if the counter snapshot or
    // the weapon frame itself went stale. An identical pair is never believed.
    let shot = null;
    let state = null;
    let noGun = null;
    let gun = null;
    let crosshairShot = null;
    let sceneNoise = 0;
    let after = null;
    let textureDelta = 0;
    for (let pair = 1; pair <= 3; pair++) {
      const gunFrame = await captureStill(session, engine);
      shot = gunFrame.shot;
      state = gunFrame.state;
      after = await session.status();
      crosshairShot = await session.crosshair();
      const decodedShot = decodeShot(shot);
      // The same frame twice with the gun still drawn: anything that moves in
      // the upper 40% is the demo, not the weapon.
      const noiseShot = (await captureStill(session, engine)).shot;
      sceneNoise = noiseStats(decodedShot, decodeShot(noiseShot));
      const need = Math.max(LIMITS.minGunPixels, 8 * sceneNoise);
      for (let attempt = 1; attempt <= 4; attempt++) {
        await engine.runUntilEcho("cl_gun 0", 6, 12);
        await sleep(200 * attempt);
        const candidate = (await captureStill(session, engine)).shot;
        const measured = gunStats(decodedShot, decodeShot(candidate));
        noGun = candidate;
        gun = measured;
        if (measured.pixels >= need) break;
        log(session.name, "gun hide not applied to", weapon.name, "attempt", attempt, "gunPixels=" + measured.pixels, "sceneNoise=" + sceneNoise);
      }
      await engine.runUntilEcho("cl_gun 1", 6, 12);
      await engine.ensureGame(8000);
      textureDelta = (after.modelTextureDraws[size] || 0) - (before.modelTextureDraws[size] || 0);
      if (gun.pixels >= need && textureDelta > 0) break;
      log(session.name, "weapon pair not settled for", weapon.name, "- recapturing", "gunPixels=" + gun.pixels, "textureDelta=" + textureDelta);
      await sleep(800);
    }
    crosshair = crosshairShot;
    const delta = (key) => (after[key] || 0) - (before[key] || 0);
    const lastSkinDelta = (after.lastModelSkinDraws[size] || 0) - (before.lastModelSkinDraws[size] || 0);
    if (results.length === 0 && !Object.prototype.hasOwnProperty.call(after.modelTextureDraws, size)) {
      throw new Error("the drawn skin size " + size + " is not in modelTextureDraws (keys " + Object.keys(after.modelTextureDraws).join(",") + ")");
    }
    const shotInfo = pngSize(shot);
    if (options.saveShots) {
      fs.writeFileSync(path.join(options.shotsDir, weapon.name + ".png"), shot);
    }
    fs.mkdirSync(path.join(scratchRoot, "weapon-verify-no-gun"), { recursive: true });
    fs.writeFileSync(path.join(scratchRoot, "weapon-verify-no-gun", session.name + "-" + weapon.name + ".png"), noGun);
    const record = {
      name: weapon.name,
      item: weapon.item,
      expectedName: expected,
      expectedSize: size,
      crosshairWeapon: crosshair ? crosshair.weapon : null,
      keyDest: state.keyDest,
      keyDestName: state.keyDestName,
      consoleOpen: state.consoleOpen,
      clGun: null,
      weaponDrawsDelta: delta("weaponDraws"),
      neutralDrawsDelta: delta("weaponNeutralDraws"),
      modelTextureDelta: textureDelta,
      lastSkinDelta,
      frame: { width: shotInfo.width, height: shotInfo.height, sha256: sha256(shot) },
      gunPixels: gun.pixels,
      sceneNoise,
      gunSaturation: gun.saturation,
      gunChroma: gun.chroma,
      shot: options.saveShots ? path.relative(ROOT, path.join(options.shotsDir, weapon.name + ".png")) : null,
      useOutput: useAnswer && useAnswer.output ? useAnswer.output.slice(0, 6) : null,
    };
    results.push(record);
    log(session.name, "captured", weapon.name, "name=" + record.crosshairWeapon, "sizeDelta=" + textureDelta, "gunPixels=" + gun.pixels, "gunSat=" + gun.saturation.toFixed(3));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Offline project commands
// ---------------------------------------------------------------------------

function runOfflineCommand(label, command, commandArgs, evidenceDir) {
  log("running", label + ":", "node", command, ...commandArgs);
  const started = Date.now();
  const result = spawnSync(process.execPath, [command, ...commandArgs], { cwd: ROOT, encoding: "utf8", timeout: 300000, maxBuffer: 64 * 1024 * 1024 });
  const duration = Date.now() - started;
  const stdout = result.stdout || "";
  const stderr = result.stderr || "";
  fs.writeFileSync(path.join(evidenceDir, label + ".txt"), [
    "$ node " + [command, ...commandArgs].join(" "),
    "",
    stdout,
    stderr ? "[stderr]\n" + stderr : "",
    "[exit " + result.status + ", " + duration + " ms]",
  ].join("\n"));
  return { label, command: "node " + [command, ...commandArgs].join(" "), status: result.status, stdout, stderr, duration };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmt(value, digits = 4) {
  return Number.isFinite(value) ? value.toFixed(digits) : "n/a";
}
function pct(value) {
  return Number.isFinite(value) ? (value * 100).toFixed(1) + "%" : "n/a";
}

function buildReport(context) {
  const { texture, extraTextures, inGame, inGameBaseline, sessions, commands, gitHead, pakSizes } = context;
  const lines = [];
  const line = (text = "") => lines.push(text);
  line("# Weapon art verification");
  line();
  line("Generated by `node scripts/weapon-verify.mjs` on " + new Date().toISOString() + ".");
  line("Commit: `" + (gitHead || "unknown") + "`.");
  line();
  line("## Result");
  line();
  const failed = checks.filter((item) => !item.pass);
  line(failed.length ? "**FAIL** — " + failed.length + " of " + checks.length + " checks failed: " + failed.map((item) => item.id).join(", ") + "." : "**PASS** — all " + checks.length + " checks passed.");
  line();
  line("## What was measured");
  line();
  line("- **In game.** The checkout's own `server.js` on a spare port, with a headless Chromium of this run on a spare debugging port (no dependency on the live server on 4231 or the kiosk on 18801/9222). `demo1` is loaded at 1280x720 with the app's normal arguments plus `+set r_mode 14` (1280x720). After `sv_cheats 1; give all`, each weapon is put in hand with `use <item>`, the console is closed, `keyDest` is checked back at game and the frame is captured with the page's own chrome (Options/Lighting chips, pointer-lock prompt, fullscreen button) hidden by a page-only style element. The engine's HUD/status bar is untouched and visible.");
  line("- **Counters.** Every capture asserts the RTX renderer's per-skin-size `modelTextureDraws` advanced for the size the engine bound, that `weaponDraws` and the neutral-shading counter (`weaponNeutralDraws`, the t4 path) advanced, and that the frame equals the weapon the crosshair code names from the bound skin size. `lastModelSkinDraws` is recorded too, but it is only incremented for the skin of the frame's last model draw, so it can legitimately stay flat when the game draws an item or monster after the gun; it is not part of the assertion. A blank or wrong gun frame would fail the skin-draw and the gun-pixel checks below.");
  line("- **Gun pixels.** A second capture of the same view with `cl_gun 0` shows the scene without the gun; the changed pixels are the drawn weapon, and they must exceed both " + LIMITS.minGunPixels + " and 8x the demo motion measured between two back-to-back gun frames in the upper 40% of the screen (where the view weapon never reaches). The pair is retried until the hide has landed, so the shot is proved not blank and gives the in-game saturation sample.");
  line("- **Texture metrics.** The 13 pak10 skins and the 13 pak0 originals are decoded with the project's PCX reader (row length = width, matching the engine) and compared: mean HSV saturation and mean chroma over opaque texels, index-255 counts and the exact 2x2 cut-out mask, fringe colours on the cut-out boundary, and a 2-texel blockiness ratio (boundary luma step / inside-block luma step), whole skin and pistol-bottom band.");
  line("- **Project passes.** `tex-check`, `texture-pack --dry-run` and `texture-audit --select` are run from this checkout and their exit codes and summaries recorded.");
  line();
  line("## Commands");
  line();
  line("```");
  line("node scripts/weapon-verify.mjs");
  if (commands) for (const command of commands) line(command.command);
  line("```");
  line();
  line("The verifier starts one server and one headless Chromium per session. Ports used: " + sessions.map((item) => item.name + " server " + item.serverPort + ", devtools " + item.debugPort).join("; ") + ". Every PID it started is killed before it exits.");
  line();
  line("## Thresholds");
  line();
  line("| Check | Threshold |");
  line("| --- | --- |");
  line("| Mean saturation gain (pak10 − pak0, 13 skins) | ≥ +" + LIMITS.meanSaturationGain.toFixed(3) + " |");
  line("| Mean chroma gain | > 0 |");
  line("| Cut-out count ratio (2x skin / original) | = " + LIMITS.cutoutRatio + " (2x2 replication) |");
  line("| Cut-out mask mismatch | 0 texels |");
  line("| Introduced near-black/near-white fringe | 0, where fringe = luma ≤ " + LIMITS.fringeLumaDark + " or ≥ " + LIMITS.fringeLumaLight + ", chroma ≤ " + LIMITS.fringeChroma + ", farther than " + LIMITS.fringeDistance + " (max channel RGB) from every source 3x3 colour |");
  line("| Scaled boundary fringe vs source | ≤ 4 × the source's own boundary fringe + 4 (the 2x2 expansion; the originals paint dark outlines of their own) |");
  line("| Boundary mean-luma shift vs source | ≤ " + LIMITS.edgeLumaShiftLevels + " levels (of 255); a percentage is meaningless where the original outline is near-black |");
  line("| Blockiness ratio, horizontal and vertical (all / bottom 40%) | < " + LIMITS.blockRatioMax.toFixed(1) + " (the max of the two axes) |");
  line("| Pistol-bottom band vs other weapons | v_blast ≤ worst other + " + LIMITS.blockRatioPistolMargin.toFixed(1) + " |");
  line("| Nearest-neighbour 2x control | > " + LIMITS.blockRatioSensitivity + " (the metric must catch a blocky upscale) |");
  line("| Gun pixels per captured frame | ≥ " + LIMITS.minGunPixels + " and ≥ 8 × the upper-frame scene noise |");
  line("| Same-size weapon pair difference | > " + LIMITS.minPairDiffPixels + " pixels |");
  line();
  line("## In-game captures");
  line();
  line("| Weapon | Item | Skin size | RTX name | Skin draws Δ | Neutral draws Δ | Gun pixels | Scene noise | In-game sat | Screenshot |");
  line("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |");
  for (const item of inGame) {
    line("| " + item.name + " | " + (item.item || "substituted") + " | " + item.expectedSize + " | " + (item.crosshairWeapon || "n/a") + " | " + item.modelTextureDelta + " | " + item.neutralDrawsDelta + " | " + item.gunPixels + " | " + (item.sceneNoise || 0) + " | " + fmt(item.gunSaturation, 3) + " | " + (item.shot || "—") + " |");
  }
  line();
  if (extraTextures.length) {
    line("### Extra weapons");
    line();
    line("baseq2 has no item for `v_flareg`, `v_disint` or `v_handgr` (the console answers `unknown item: …`), so the model cannot be put in hand through the game. For these three only, a separate session is served a test-only pak10, built in memory, that swaps each model and skin into a real slot (`v_flareg`→`v_blast`, `v_disint`→`v_shotg`, `v_handgr`→`v_machn`) and adds `models/weapons/v_flareg/skin.pcx` so the renderer's size index can name the 624x338 skin. The slot's item is given with `use`, so the engine really draws the substituted model and skin; no repository file is changed and the archive is delivered by CDP request interception for that session only.");
    line();
    line("| Weapon | Slot | Skin size | RTX name | Skin draws Δ | Slot's clean 2x size | Gun pixels | Scene noise | In-game sat | Screenshot |");
    line("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const item of extraTextures) {
      line("| " + item.name + " | " + item.slot + " | " + item.expectedSize + " | " + (item.crosshairWeapon || "n/a") + " | " + item.modelTextureDelta + " | " + item.slotOriginalSize + " | " + item.gunPixels + " | " + (item.sceneNoise || 0) + " | " + fmt(item.gunSaturation, 3) + " | " + (item.shot || "—") + " |");
    }
    line();
  }
  if (inGameBaseline && inGameBaseline.length) {
    line("### In-game saturation against original art");
    line();
    line("The same 1280x720 measurement with a test-only pak10 whose 13 weapon entries hold the pak0 originals (the engine binds the 1x art). Gun pixels are the `cl_gun 1` / `cl_gun 0` difference in each weapon's own frame.");
    line();
    line("| Weapon | 2x gun pixels | 2x sat | 1x gun pixels | 1x sat | Δ sat |");
    line("| --- | ---: | ---: | ---: | ---: | ---: |");
    let weighted2x = 0, weighted1x = 0, pixels2x = 0, pixels1x = 0;
    for (const item of inGameBaseline) {
      line("| " + item.name + " | " + item.gunPixels2x + " | " + fmt(item.sat2x, 3) + " | " + item.gunPixels1x + " | " + fmt(item.sat1x, 3) + " | " + (item.sat2x - item.sat1x >= 0 ? "+" : "") + fmt(item.sat2x - item.sat1x, 3) + " |");
      weighted2x += item.sat2x * item.gunPixels2x;
      weighted1x += item.sat1x * item.gunPixels1x;
      pixels2x += item.gunPixels2x;
      pixels1x += item.gunPixels1x;
    }
    line("| **weighted mean** | " + pixels2x + " | " + fmt(weighted2x / pixels2x, 3) + " | " + pixels1x + " | " + fmt(weighted1x / pixels1x, 3) + " | " + (weighted2x / pixels2x - weighted1x / pixels1x >= 0 ? "+" : "") + fmt(weighted2x / pixels2x - weighted1x / pixels1x, 3) + " |");
    line();
  }
  line("## Texture saturation");
  line();
  line("| Weapon | Skin | Opaque texels (1x → 2x) | Mean saturation 1x → 2x | Δ | Mean chroma 1x → 2x | Δ |");
  line("| --- | --- | ---: | ---: | ---: | ---: | ---: |");
  let sat1 = 0, sat2 = 0, chroma1 = 0, chroma2 = 0;
  for (const item of texture) {
    sat1 += item.saturationOriginal;
    sat2 += item.saturationScaled;
    chroma1 += item.chromaOriginal;
    chroma2 += item.chromaScaled;
    line("| " + item.name + " | " + item.originalSize + " → " + item.scaledSize + " | " + item.opaqueOriginal + " → " + item.opaqueScaled + " | " + fmt(item.saturationOriginal) + " → " + fmt(item.saturationScaled) + " | " + (item.saturationScaled - item.saturationOriginal >= 0 ? "+" : "") + fmt(item.saturationScaled - item.saturationOriginal) + " | " + fmt(item.chromaOriginal, 2) + " → " + fmt(item.chromaScaled, 2) + " | " + (item.chromaScaled - item.chromaOriginal >= 0 ? "+" : "") + fmt(item.chromaScaled - item.chromaOriginal, 2) + " |");
  }
  line("| **mean of 13** | | | " + fmt(sat1 / texture.length) + " → " + fmt(sat2 / texture.length) + " | +" + fmt(sat2 / texture.length - sat1 / texture.length) + " | " + fmt(chroma1 / texture.length, 2) + " → " + fmt(chroma2 / texture.length, 2) + " | +" + fmt(chroma2 / texture.length - chroma1 / texture.length, 2) + " |");
  line();
  line("## Edges, cut-out and blockiness");
  line();
  line("| Weapon | 255 count 1x → 2x | Ratio | Mask mismatch | Boundary texels | Boundary fringe 2x / 1x | Introduced fringe | Fringe max dist | Boundary luma shift | Block ratio all (max) | Block ratio vertical | Block ratio bottom 40% | NN control |");
  line("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const item of texture) {
    const shift = item.edge.lumaMean - item.edge.sourceLumaMean;
    line("| " + item.name + " | " + item.cutoutOriginal + " → " + item.cutoutScaled + " | " + fmt(item.cutoutRatio, 2) + " | " + item.cutoutMismatch + " | " + item.edge.boundary + " | " + item.edge.fringe + " / " + item.edge.sourceFringe + " | " + item.edge.introduced + " | " + item.edge.maxFringeDistance + " | " + (shift >= 0 ? "+" : "") + fmt(shift, 1) + " | " + fmt(item.blockAll.ratio, 2) + " | " + fmt(item.blockAll.ratioY, 2) + " | " + fmt(item.blockBottom.ratio, 2) + " | " + fmt(item.blockControl.ratio, 0) + " |");
  }
  line();
  line("The nearest-neighbour control is a 2x replication of the original skin: its inside-block step is zero, so the ratio explodes (…e+9 in the JSON). The real skins sit near 2 on both axes — one step on each side of an edge, none locked to the 2-texel grid. Every scaled boundary fringe texel is accounted for by the source's own dark/light outline (the `Boundary fringe 2x / 1x` column), and `Introduced fringe` counts only a near-fringe colour more than " + LIMITS.fringeDistance + " levels from every source 3x3 colour.");
  line();
  line("## Project passes");
  line();
  line("| Command | Exit | Summary |");
  line("| --- | ---: | --- |");
  if (commands) {
    for (const command of commands) {
      let summary = "";
      if (command.label === "tex-check") {
        summary = (command.stdout.match(/^checked .*$/m) || [""])[0];
      } else if (command.label === "texture-pack") {
        const packed = (command.stdout.match(/^\d+ packed .*$/m) || [""])[0];
        const left = (command.stdout.match(/^left alone .*$/m) || [""])[0];
        const hires = (command.stdout.match(/^no 4x art.*$/m) || [""])[0];
        summary = [packed, left, hires].filter(Boolean).join("<br>");
      } else if (command.label === "texture-audit") {
        const first = command.stdout.split("\n").find((text) => text.includes("texinfo wals across")) || "";
        const skipped = (command.stdout.match(/SKIPPED:/g) || []).length;
        summary = first.trim() + (skipped ? " — " + skipped + " skipped entries listed in the log" : "");
      }
      line("| `" + command.command + "` | " + command.status + " | " + summary.replace(/\|/g, "\\|") + " |");
    }
  }
  line();
  line("Full output: " + (commands ? commands.map((command) => "`" + path.relative(ROOT, path.join(evidenceDir, command.label + ".txt")) + "`").join(", ") : "") + ".");
  line();
  line("## Checks");
  line();
  line("| id | Check | Result | Detail |");
  line("| --- | --- | --- | --- |");
  for (const item of checks) {
    line("| " + item.id + " | " + item.name + " | " + (item.pass ? "PASS" : "**FAIL**") + " | " + String(item.detail).replace(/\|/g, "\\|") + " |");
  }
  line();
  line("## Screenshots");
  line();
  line("| Weapon | File | Size | sha256 |");
  line("| --- | --- | --- | --- |");
  for (const item of inGame.concat(extraTextures)) {
    if (!item.shot) continue;
    line("| " + item.name + " | `" + item.shot + "` | " + item.frame.width + "x" + item.frame.height + " | `" + item.frame.sha256.slice(0, 16) + "…` |");
  }
  line();
  line("The page chrome (Options/Lighting chips, pointer-lock prompt, fullscreen button) is hidden for the captures by a style element added to the page after boot; the engine's HUD and status bar are part of the canvas and are untouched. `evidence/page-chrome.png` is a capture from the same session before that style was added, for comparison.");
  line();
  line("## Assumptions");
  line();
  line("- The three extra view models (`v_flareg`, `v_disint`, `v_handgr`) have no item in `game_baseq2.wasm`; `use` answers `unknown item: …`. Their captures therefore use the test-only substituted pak10 described above. The frame's RTX name lists every model whose skin has that size, so it reads `v_blast/v_flareg`, `v_bfg/v_disint/v_shotg`, `v_handgr/v_machn`; the extra weapon's own name is present and its 2x skin size is drawn, and the screenshot is the extra weapon, distinguished from the slot's real weapon by the pair-difference check.");
  line("- `v_flareg`'s skin ships as `base.pcx`, which `rtx-renderer.js`'s size index deliberately does not scan (it indexes `skin.pcx` only). The test pak adds a `models/weapons/v_flareg/skin.pcx` entry with the same bytes so the renderer can name the size; the engine never loads that added entry.");
  line("- In-game saturation compares the rendered gun pixels of the 2x session with a baseline session whose pak10 weapon entries hold the pak0 originals (test-only archive, same delivery path). It is a rendered-pixel measurement: lighting (the neutral weapon path) and the palette are part of it, which is the point of an end-to-end check. The baseline frames pass the same name, draw-counter and gun-pixel checks (`O-*`) before their numbers are used.");
  line("- Saturation is `(max−min)/max` per pixel, the same definition `model-art.mjs` uses; chroma is `max−min`. Means are per opaque texel, so the 2x skin and the 1x original weigh their own pixels equally.");
  line("- The blockiness ratio is measured at 2-texel period on both axes: an inside-block luma step versus a block-boundary luma step, averaged over the skin (and over the lower 40% for the pistol). A nearest-neighbour 2x upscale makes the inside step zero; a smoothed upscale keeps the two comparable. The pair difference and the gun/no-gun difference are measured against a frame-to-frame scene-noise sample so demo motion cannot be mistaken for the weapon.");
  line("- `r_mode 14` is the engine's 1280x720 mode (from its own mode strings); the page and canvas are asserted at 1280x720 before any capture.");
  line();
  line("## Environment");
  line();
  line("- Node " + process.version + ", project root `" + ROOT + "`.");
  line("- pak0 " + (pakSizes.pak0 / 1048576).toFixed(2) + " MiB.");
  line("- Sessions: " + sessions.map((item) => item.name + " (server " + item.serverPort + ", devtools " + item.debugPort + ", test pak10 fulfilled " + item.served + ")").join("; ") + ". A count of 0 is the clean session, which is served the checkout's real pak10 by the server.");
  line("- pak10 is " + (pakSizes.pak10 / 1048576).toFixed(2) + " MiB" + (pakSizes.previousPak10 ? ", up from " + (pakSizes.previousPak10 / 1048576).toFixed(2) + " MiB before the 2x weapon-art commit (+" + ((pakSizes.pak10 - pakSizes.previousPak10) / 1048576).toFixed(2) + " MiB)" : "") + ". The Store package is built outside this repository (there is no packaging script in it), so this run measures the archive, not the package: the published 1.1.0 package was 45.65 MB against a 50 MiB cap. If the packaged size no longer fits, the optional pak to drop is pak9 (4x world art); pak10 carries the rebuilt models and the 2x weapon art.");
  line();
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// An interrupt (Ctrl-C, a run timeout) must not leave the server or the
// headless browser it started behind: close every live session, then exit.
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("received " + signal + ", closing " + activeSessions.size + " session(s)");
  await Promise.all([...activeSessions].map((session) => session.close().catch(() => {})));
  process.exit(signal === "SIGINT" ? 130 : 143);
}
process.once("SIGINT", () => { shutdown("SIGINT"); });
process.once("SIGTERM", () => { shutdown("SIGTERM"); });
process.on("exit", () => {
  for (const session of activeSessions) {
    for (const child of [session.chrome, session.server]) {
      try {
        if (child && child.exitCode === null) child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }
  }
});

async function main() {
  fs.mkdirSync(shotsDir, { recursive: true });
  fs.mkdirSync(evidenceDir, { recursive: true });
  // A previous run's screenshots must not be mistaken for this run's.
  for (const name of fs.readdirSync(shotsDir)) {
    if (/\.png$/i.test(name)) fs.unlinkSync(path.join(shotsDir, name));
  }

  log("project", ROOT);
  const pak0 = loadPak(PAK0);
  const pak10 = loadPak(PAK10);
  const previousPak10 = previousPakSize("baseq2/pak10.pak");
  let gitHead = null;
  try {
    gitHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    // not a git checkout
  }

  // ---- Texture checks -----------------------------------------------------
  const texture = analyseTextures(pak0, pak10);
  const meanSaturationOriginal = texture.reduce((sum, item) => sum + item.saturationOriginal, 0) / texture.length;
  const meanSaturationScaled = texture.reduce((sum, item) => sum + item.saturationScaled, 0) / texture.length;
  const meanChromaOriginal = texture.reduce((sum, item) => sum + item.chromaOriginal, 0) / texture.length;
  const meanChromaScaled = texture.reduce((sum, item) => sum + item.chromaScaled, 0) / texture.length;

  check("S1", "mean saturation rises by the stated threshold", meanSaturationScaled - meanSaturationOriginal >= LIMITS.meanSaturationGain,
    "mean " + fmt(meanSaturationOriginal) + " → " + fmt(meanSaturationScaled) + " (" + (meanSaturationScaled - meanSaturationOriginal >= 0 ? "+" : "") + fmt(meanSaturationScaled - meanSaturationOriginal) + "), threshold +" + LIMITS.meanSaturationGain.toFixed(3));
  check("S2", "every weapon's saturation rises", texture.every((item) => item.saturationScaled >= item.saturationOriginal),
    "smallest gain " + fmt(Math.min(...texture.map((item) => item.saturationScaled - item.saturationOriginal))));
  check("S3", "mean chroma rises", meanChromaScaled > meanChromaOriginal + LIMITS.meanChromaGain,
    "mean " + fmt(meanChromaOriginal, 2) + " → " + fmt(meanChromaScaled, 2));
  const cutoutFailures = texture.filter((item) => !item.cutoutRatio || Math.abs(item.cutoutRatio - LIMITS.cutoutRatio) > LIMITS.cutoutRatioTolerance);
  check("E1", "cut-out count is exactly 4x the original", cutoutFailures.length === 0,
    cutoutFailures.length ? "off: " + cutoutFailures.map((item) => item.name + "=" + fmt(item.cutoutRatio, 2)).join(", ") : "all 13 at 4.00");
  const mismatchFailures = texture.filter((item) => item.cutoutMismatch !== 0);
  check("E2", "cut-out mask is the 2x2 expansion of the original (no opaque texel re-indexed to 255)", mismatchFailures.length === 0,
    mismatchFailures.length ? "mismatch: " + mismatchFailures.map((item) => item.name + "=" + item.cutoutMismatch).join(", ") : "0 mismatched texels over all 13");
  const fringeFailures = texture.filter((item) => item.edge.introduced !== 0);
  check("E3", "no near-black/near-white fringe introduced at the cut-out", fringeFailures.length === 0,
    fringeFailures.length ? "introduced: " + fringeFailures.map((item) => item.name + "=" + item.edge.introduced).join(", ") : "0 introduced; worst fringe colour distance " + Math.max(...texture.map((item) => item.edge.maxFringeDistance)) + " (limit " + LIMITS.fringeDistance + ")");
  // The source art legitimately paints near-black outlines around its cut-outs,
  // so "no fringe" means none the upscale invented: the scaled boundary fringe
  // may not exceed the source's own, expanded 2x2 (plus a small allowance for
  // the boundary geometry changing shape).
  const fringeExpansion = texture.filter((item) => item.edge.fringe > 4 * item.edge.sourceFringe + 4);
  const worstExpansion = texture.reduce((worst, item) => {
    const over = item.edge.fringe - (4 * item.edge.sourceFringe + 4);
    return over > worst.over ? { name: item.name, over, item } : worst;
  }, { name: "", over: -Infinity, item: null });
  check("E3b", "scaled fringe texels are explained by the source art", fringeExpansion.length === 0,
    fringeExpansion.length
      ? "over: " + fringeExpansion.map((item) => item.name + "=" + item.edge.fringe + " vs " + (4 * item.edge.sourceFringe + 4)).join(", ")
      : "worst " + worstExpansion.name + " " + worstExpansion.item.edge.fringe + " vs limit " + (4 * worstExpansion.item.edge.sourceFringe + 4) + " (2x2 of the source's " + worstExpansion.item.edge.sourceFringe + ")");
  const worstShift = texture.reduce((worst, item) => {
    const shift = Math.abs(item.edge.lumaMean - item.edge.sourceLumaMean);
    return shift > worst.shift ? { name: item.name, shift } : worst;
  }, { name: "", shift: 0 });
  check("E4", "boundary brightness is not shifted by the upscale", worstShift.shift <= LIMITS.edgeLumaShiftLevels,
    "worst " + worstShift.name + " " + fmt(worstShift.shift, 1) + " levels, limit " + LIMITS.edgeLumaShiftLevels);
  const blockFailures = texture.filter((item) => item.blockAll.ratio >= LIMITS.blockRatioMax || item.blockBottom.ratio >= LIMITS.blockRatioMax);
  check("B1", "blockiness ratio below the bound (whole skin and pistol band)", blockFailures.length === 0,
    blockFailures.length ? "over: " + blockFailures.map((item) => item.name + "=" + fmt(item.blockAll.ratio, 2) + "/" + fmt(item.blockBottom.ratio, 2)).join(", ") : "worst whole " + fmt(Math.max(...texture.map((item) => item.blockAll.ratio)), 2) + ", worst bottom " + fmt(Math.max(...texture.map((item) => item.blockBottom.ratio)), 2));
  const blast = texture.find((item) => item.name === "v_blast");
  const otherBottom = Math.max(...texture.filter((item) => item.name !== "v_blast").map((item) => item.blockBottom.ratio));
  check("B2", "pistol-bottom band is not an outlier", blast.blockBottom.ratio <= otherBottom + LIMITS.blockRatioPistolMargin,
    "v_blast " + fmt(blast.blockBottom.ratio, 2) + " vs worst other " + fmt(otherBottom, 2) + " (margin " + LIMITS.blockRatioPistolMargin.toFixed(1) + ")");
  check("B3", "blockiness metric detects a nearest-neighbour upscale", texture.every((item) => item.blockControl.ratio > LIMITS.blockRatioSensitivity),
    "control ratios " + fmt(Math.min(...texture.map((item) => item.blockControl.ratio)), 0) + " … " + fmt(Math.max(...texture.map((item) => item.blockControl.ratio)), 0));

  const textureReport = texture.map((item) => ({
    name: item.name, originalSize: item.originalSize, scaledSize: item.scaledSize,
    opaqueOriginal: item.opaqueOriginal, opaqueScaled: item.opaqueScaled,
    saturationOriginal: item.saturationOriginal, saturationScaled: item.saturationScaled,
    chromaOriginal: item.chromaOriginal, chromaScaled: item.chromaScaled,
    cutoutOriginal: item.cutoutOriginal, cutoutScaled: item.cutoutScaled, cutoutRatio: item.cutoutRatio, cutoutMismatch: item.cutoutMismatch,
    edge: item.edge, blockAll: item.blockAll, blockBottom: item.blockBottom, blockControl: item.blockControl,
  }));

  // ---- Offline project passes --------------------------------------------
  const commands = [
    runOfflineCommand("tex-check", "scripts/tex-check.mjs", ["--only", "models/"], evidenceDir),
    runOfflineCommand("texture-pack", "scripts/texture-pack.mjs", ["--dry-run", "--only", "models/"], evidenceDir),
    runOfflineCommand("texture-audit", "scripts/texture-audit.mjs", ["--select"], evidenceDir),
  ];
  check("P1", "tex-check --only models/ exits 0", commands[0].status === 0, "exit " + commands[0].status);
  check("P2", "texture-pack --dry-run --only models/ exits 0", commands[1].status === 0, "exit " + commands[1].status);
  check("P3", "texture-audit --select exits 0", commands[2].status === 0, "exit " + commands[2].status);
  const packedLine = (commands[1].stdout.match(/^\d+ packed .*$/m) || [""])[0];
  const packedMatch = packedLine.match(/^(\d+) packed \((\d+) identical to the original\), (\d+) without art, (\d+) skipped, (\d+) failed/);
  const packedCount = packedMatch ? Number(packedMatch[1]) : 0;
  const identicalCount = packedMatch ? Number(packedMatch[2]) : -1;
  const failedCount = packedMatch ? Number(packedMatch[5]) : -1;
  check("P4", "texture-pack reports every picture identical", Boolean(packedMatch) && packedCount > 0 && identicalCount === packedCount && failedCount === 0,
    packedLine ? packedLine + " (identical " + identicalCount + " of " + packedCount + ")" : "no summary line");

  if (texturesOnly) {
    const report = buildReport({ texture: textureReport, extraTextures: [], inGame: [], inGameBaseline: null, sessions: [], commands, gitHead, pakSizes: { pak0: pak0.length, pak10: pak10.length, previousPak10 } });
    fs.writeFileSync(path.join(OUT, "REPORT.md"), report);
    fs.writeFileSync(path.join(evidenceDir, "weapon-verify.json"), JSON.stringify({ generated: new Date().toISOString(), gitHead, checks, texture: textureReport, commands: commands.map((command) => ({ label: command.label, command: command.command, status: command.status })) }, null, 2));
    process.exitCode = checks.every((item) => item.pass) ? 0 : 1;
    log("textures-only run complete:", checks.filter((item) => item.pass).length + "/" + checks.length + " checks passed");
    return;
  }

  // ---- Paks and names -----------------------------------------------------
  const originalPak10 = buildOriginalPak10(pak0, pak10);
  const extraPak10 = buildExtraPak10(pak10);
  const cleanIndex = skinSizeIndex([pak0, pak10]);
  const originalIndex = skinSizeIndex([pak0, originalPak10]);
  const extraIndex = skinSizeIndex([pak0, extraPak10]);
  // The drawn skin is the one from the last pak that supplies it: pak10's 2x
  // art overrides pak0's 1x original, and the index is built in pak order. The
  // 1x and 2x sizes are different keys, so "the last size this weapon appears
  // at" is the one the engine uploads.
  const sizeOf = (index, weapon) => {
    let found = null;
    for (const [size, names] of index) if (names.includes(weapon)) found = size;
    return found;
  };
  const nameFor = (index, size) => (index.get(size) || []).join("/");
  fs.writeFileSync(path.join(evidenceDir, "skin-index.json"), JSON.stringify({
    clean: Object.fromEntries([...cleanIndex].map(([size, names]) => [size, names])),
    original: Object.fromEntries([...originalIndex].map(([size, names]) => [size, names])),
    extra: Object.fromEntries([...extraIndex].map(([size, names]) => [size, names])),
  }, null, 2));

  const sessions = [];
  let inGame = [];
  let extraTextures = [];
  let inGameBaseline = null;
  let pageChrome = false;

  // ---- Session A: clean pak10, ten selectable weapons --------------------
  const clean = new Session("clean", null);
  try {
    log("starting session clean");
    await clean.start();
    const boot = await clean.open();
    check("A1", "boots demo1 at 1280x720 with the game in hand", boot.keyDest === 0 && boot.keyDestName === "game" && boot.canvasWidth === 1280 && boot.canvasHeight === 720,
      "keyDest=" + boot.keyDestName + " canvas=" + boot.canvasWidth + "x" + boot.canvasHeight);
    check("A2", "console is closed and cl_gun is 1", !boot.consoleOpen, "consoleOpen=" + boot.consoleOpen);
    const engine = new Engine(clean);
    await engine.connect();
    const clGun = await engine.cvar("cl_gun");
    check("A3", "cl_gun is 1", clGun === "1", "cl_gun=\"" + clGun + "\"");
    await engine.giveAll();
    await engine.ensureGame(12000);
    const armed = await clean.state();
    check("A4", "give all left the game running (console closed, keyDest=game)", armed.keyDest === 0 && !armed.consoleOpen, "keyDest=" + armed.keyDestName + " consoleOpen=" + armed.consoleOpen);
    // The raw page, before the screenshot-only chrome hide.
    fs.writeFileSync(path.join(evidenceDir, "page-chrome.png"), await clean.screenshot());
    pageChrome = true;
    await clean.hidePageChrome();
    const selectable = WEAPONS.filter((weapon) => !weapon.extra);
    inGame = await captureWeapons(clean, engine, selectable, {
      expectedName: (name) => nameFor(cleanIndex, sizeOf(cleanIndex, name)),
      expectedSize: (name) => sizeOf(cleanIndex, name),
      saveShots: true,
      shotsDir,
    });
    await engine.disconnect();
  } catch (error) {
    log("session clean failed:", error.stack || error.message);
    check("A0", "clean session completed", false, error.message);
  } finally {
    const record = { name: "clean", serverPort: clean.serverPort, debugPort: clean.debugPort, served: clean.served };
    sessions.push(record);
    await clean.close();
  }

  // ---- Session B: original-art baseline ----------------------------------
  const baseline = new Session("original", { "pak10.pak": originalPak10 });
  try {
    log("starting session original");
    await baseline.start();
    await baseline.open();
    const engine = new Engine(baseline);
    await engine.connect();
    await engine.giveAll();
    await engine.ensureGame(12000);
    await baseline.hidePageChrome();
    const selectable = WEAPONS.filter((weapon) => !weapon.extra);
    const baselineResults = await captureWeapons(baseline, engine, selectable, {
      expectedName: (name) => nameFor(originalIndex, sizeOf(originalIndex, name)),
      expectedSize: (name) => sizeOf(originalIndex, name),
      saveShots: false,
      shotsDir,
    });
    await engine.disconnect();
    // The baseline's own frames must be right too: a failed switch there would
    // silently attribute one weapon's 1x saturation to another in G-I.
    for (const item of baselineResults) {
      check("O-" + item.name, item.name + " baseline frame reports its own 1x skin and a gun",
        item.crosshairWeapon === item.expectedName && item.modelTextureDelta > 0 && item.gunPixels >= Math.max(LIMITS.minGunPixels, 8 * (item.sceneNoise || 0)),
        "name=" + item.crosshairWeapon + " (expected " + item.expectedName + ") sizeΔ=" + item.modelTextureDelta + " gunPixels=" + item.gunPixels + " sceneNoise=" + item.sceneNoise);
    }
    const byName = new Map(inGame.map((item) => [item.name, item]));
    inGameBaseline = baselineResults.map((item) => ({
      name: item.name,
      gunPixels2x: byName.get(item.name) ? byName.get(item.name).gunPixels : 0,
      sat2x: byName.get(item.name) ? byName.get(item.name).gunSaturation : 0,
      gunPixels1x: item.gunPixels,
      sat1x: item.gunSaturation,
    }));
  } catch (error) {
    log("session original failed:", error.stack || error.message);
    check("O0", "original-art baseline session completed", false, error.message);
  } finally {
    sessions.push({ name: "original", serverPort: baseline.serverPort, debugPort: baseline.debugPort, served: baseline.served });
    await baseline.close();
  }

  // ---- Session C: extras through the substituted pak10 -------------------
  const extraSession = new Session("extras", { "pak10.pak": extraPak10 });
  try {
    log("starting session extras");
    await extraSession.start();
    await extraSession.open();
    const engine = new Engine(extraSession);
    await engine.connect();
    await engine.giveAll();
    await extraSession.hidePageChrome();
    const extras = EXTRAS.map((extra) => ({ name: extra.name, item: extra.item, slot: extra.slot }));
    const captured = await captureWeapons(extraSession, engine, extras, {
      expectedName: (name) => nameFor(extraIndex, sizeOf(extraIndex, name)),
      expectedSize: (name) => sizeOf(extraIndex, name),
      saveShots: true,
      shotsDir,
    });
    await engine.disconnect();
    extraTextures = captured.map((item) => {
      const extra = EXTRAS.find((candidate) => candidate.name === item.name);
      const slotSizeClean = sizeOf(cleanIndex, extra.slot);
      return {
        ...item,
        slot: extra.slot,
        slotOriginalSize: slotSizeClean,
        slotOriginalSize: slotSizeClean,
      };
    });
  } catch (error) {
    log("session extras failed:", error.stack || error.message);
    check("X0", "extra-weapon session completed", false, error.message);
  } finally {
    sessions.push({ name: "extras", serverPort: extraSession.serverPort, debugPort: extraSession.debugPort, served: extraSession.served });
    await extraSession.close();
  }

  // ---- In-game checks ----------------------------------------------------
  const allCaptures = inGame.concat(extraTextures);
  for (const item of allCaptures) {
    check("G-" + item.name, item.name + " reports its own skin draw and is not blank", item.crosshairWeapon === item.expectedName && item.modelTextureDelta > 0 && item.weaponDrawsDelta > 0 && item.neutralDrawsDelta > 0 && item.gunPixels >= Math.max(LIMITS.minGunPixels, 8 * (item.sceneNoise || 0)) && item.frame.width === 1280 && item.frame.height === 720,
      "name=" + item.crosshairWeapon + " (expected " + item.expectedName + ") skinΔ=" + item.modelTextureDelta + " lastΔ=" + item.lastSkinDelta + " weaponΔ=" + item.weaponDrawsDelta + " neutralΔ=" + item.neutralDrawsDelta + " gunPixels=" + item.gunPixels + " sceneNoise=" + item.sceneNoise + " frame=" + item.frame.width + "x" + item.frame.height);
  }
  // Same-size pairs must differ: the name alone cannot tell them apart.
  const byName = new Map(allCaptures.map((item) => [item.name, item]));
  const pairChecks = [
    ["v_shotg2", "v_hyperb"],
    ["v_bfg", "v_disint"],
    ["v_flareg", "v_blast"],
    ["v_disint", "v_shotg"],
    ["v_handgr", "v_machn"],
  ];
  for (const [left, right] of pairChecks) {
    const a = byName.get(left);
    const b = byName.get(right);
    if (!a || !b || !a.shot || !b.shot) {
      check("D-" + left + "-" + right, left + " and " + right + " differ", false, "missing capture");
      continue;
    }
    const aFile = path.join(ROOT, a.shot);
    const bFile = path.join(ROOT, b.shot);
    const diff = diffPixels(decodeShot(fs.readFileSync(aFile)), decodeShot(fs.readFileSync(bFile)));
    check("D-" + left + "-" + right, left + " and " + right + " draw different frames", diff.pixels > LIMITS.minPairDiffPixels, diff.pixels + " changed pixels (limit " + LIMITS.minPairDiffPixels + ")");
  }
  for (const item of extraTextures) {
    check("X-" + item.name, item.name + " replaced the slot's original art",
      item.slotOriginalSize !== null && item.slotOriginalSize !== item.expectedSize && item.modelTextureDelta > 0,
      "slot " + item.slot + " clean size " + item.slotOriginalSize + " is not the drawn size " + item.expectedSize + " (skin draws Δ " + item.modelTextureDelta + ")");
  }
  if (inGameBaseline && inGameBaseline.length) {
    let weighted2x = 0, weighted1x = 0, pixels2x = 0, pixels1x = 0;
    for (const item of inGameBaseline) {
      weighted2x += item.sat2x * item.gunPixels2x;
      weighted1x += item.sat1x * item.gunPixels1x;
      pixels2x += item.gunPixels2x;
      pixels1x += item.gunPixels1x;
    }
    const sat2x = pixels2x ? weighted2x / pixels2x : 0;
    const sat1x = pixels1x ? weighted1x / pixels1x : 0;
    check("G-I", "in-game gun pixels are at least as saturated as the original-art baseline", sat2x - sat1x >= -0.002,
      "2x " + fmt(sat2x, 3) + " vs 1x " + fmt(sat1x, 3) + " (" + (sat2x - sat1x >= 0 ? "+" : "") + fmt(sat2x - sat1x, 3) + ") over " + pixels2x + "/" + pixels1x + " gun pixels");
  }

  // ---- Evidence and report ----------------------------------------------
  const evidence = {
    generated: new Date().toISOString(),
    gitHead,
    projectRoot: ROOT,
    limits: LIMITS,
    checks,
    texture: textureReport,
    inGame,
    extraTextures,
    inGameBaseline,
    sessions,
    commands: commands.map((command) => ({ label: command.label, command: command.command, status: command.status, duration: command.duration })),
    pageChrome,
    pakSizes: { pak0: pak0.length, pak10: pak10.length, previousPak10, originalPak10: originalPak10.length, extraPak10: extraPak10.length },
  };
  fs.writeFileSync(path.join(evidenceDir, "weapon-verify.json"), JSON.stringify(evidence, null, 2));
  fs.writeFileSync(path.join(OUT, "REPORT.md"), buildReport({
    texture: textureReport,
    extraTextures,
    inGame,
    inGameBaseline,
    sessions,
    commands,
    gitHead,
    pakSizes: { pak0: pak0.length, pak10: pak10.length, previousPak10 },
  }));
  fs.writeFileSync(path.join(evidenceDir, "weapon-verify-run.txt"), logLines.join("\n") + "\n");

  const failed = checks.filter((item) => !item.pass);
  log("done:", (checks.length - failed.length) + "/" + checks.length + " checks passed");
  if (failed.length) log("failed:", failed.map((item) => item.id + " " + item.name).join("; "));
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((error) => {
  log("fatal:", error.stack || error.message);
  try {
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(path.join(evidenceDir, "weapon-verify-run.txt"), logLines.join("\n") + "\n");
    fs.writeFileSync(path.join(evidenceDir, "weapon-verify.json"), JSON.stringify({ generated: new Date().toISOString(), fatal: error.message, checks }, null, 2));
  } catch {
    // best effort
  }
  process.exitCode = 1;
});
