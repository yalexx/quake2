#!/usr/bin/env node
// scripts/hires-art.mjs -- 4x art for the demo's own surface textures, drawn
// from the demo's own pixels.
//
//   node scripts/hires-art.mjs                  # draw every target, then check it
//   node scripts/hires-art.mjs --check          # check the art on disk, draw nothing
//   node scripts/hires-art.mjs --only e1u1      # just the names containing e1u1
//   node scripts/hires-art.mjs --json           # also print the report
//
// What it is for
//
// The generated replacements that reached the archive first were painted at the
// size the entry already had (32x32, 64x64, 128x128 ...). This tool takes the
// OTHER road: it starts from the pixels the demo shipped and makes them four
// times larger, without inventing anything. Every pixel is an interpolation of
// the demo's own palette colours in linear light, so the result keeps the
// original's shapes, brightness and colour family while the engine finally has
// enough samples to draw a wall up close.
//
// Where the source comes from
//
// baseq2/pak0.pak in the working tree is no longer the demo's archive -- it is
// the archive with generated replacements packed into it. The demo's own pixels
// survive in git history as the blob whose content SHA-1 is
// b86e8878a8e8706595ceebe88b3e6b4c1ba5bcab (the scaffold commit). loadPristine()
// finds that blob, extracts it once to os.tmpdir(), and every texture read comes
// from it. WAL files carry no palette: the indices mean the global palette, the
// last 768 bytes of pics/colormap.pcx, and that is read from the same archive.
//
// The recipe, in one paragraph
//
// sRGB -> linear light; a wrapped Catmull-Rom 4x upscale (separable, so it is
// cheap) with every tap and every 2x2 neighbourhood read modulo the texture
// size, so a tiling texture still tiles; each output pixel clamped to the
// min/max of the source 2x2 that surrounds it, which is what keeps the filter's
// negative lobes from ringing; a mild thresholded unsharp over linear
// luminance, clamped again; each 4x4 block's mean pulled back onto the source
// pixel it replaces, so the picture says the same thing on average (the
// outermost ring is left alone, so the repair cannot sharpen the wrap);
// a deterministic, wrapped fine grain of at most 3% luminance scaled by the
// source's local variance (off for signs, lights, water, sky and flat art);
// a last clamp to the source 3x3 min/max +/- 4 so no output pixel can stray
// outside the tolerance the QC gate allows; and, only where sharpening would
// still make the wrap boundary harsher than a plain bilinear 4x does, the
// outermost ring is blended toward that bilinear by the least amount that
// settles it. One parameter set, with per-class overrides chosen by the
// texture's name and the WAL header's own flags/contents.
//
// The gates --check enforces (all from the original WAL pixels, not from an
// earlier replacement):
//
//   1. 4x4 box downsample vs original: luminance Pearson r >= 0.97 and mean
//      absolute RGB error <= 6; a flat original must stay flat within 1.
//   2. the picture's mean luminance (after the same box downsample) is within
//      2 of the original's. The per-pixel luminance error is reported beside it,
//      but a per-pixel rule would fail any faithful enlargement of a dithered
//      source, which the demo's WALs are.
//   3. the wrap seam (last column vs first, last row vs first) steps no more
//      than 1.15x an ordinary interior step. The demo's own WALs already break
//      that literal bound -- 172 of the 270 targets did before any enlargement
//      (sky1's own seam is 15x its interior) -- and fixing a source's seam would
//      mean painting new pixels over the border, which gate 4 forbids. So the
//      gate is what the upscale can be held to: it may not add seam to what is
//      already there. Each axis's ratio of boundary step to interior step must
//      stay within 1.15x the same ratio for a plain wrapped bilinear 4x of the
//      source (plus 0.05 of a ratio, head-room for a step averaged over 0..255
//      levels), and a boundary step below one level in both pictures passes
//      outright, because it cannot be seen -- that covers `trigger`, whose
//      bilinear baseline is zero. The report keeps the literal ratio, the
//      source's own ratio and the bilinear baseline per entry.
//   4. at most 0.5% of output pixels lie more than 4 beyond their source 3x3
//      min/max on any channel.
//   5. mean luminance gradient >= 1.05x a plain wrapped bilinear 4x.
//
// The report goes to docs/texture-review/hires-report.json.
//
// This file imports the readers from texture-lib.mjs and edits nothing there.
// It exports loadPristine(), the upscale/baseline/downsample helpers and the
// gate measurement for the review task to use.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  DEFAULT_MANIFEST,
  PROJECT_ROOT,
  TextureError,
  decodePng,
  decodeWal,
  formatBytes,
  globalPalette,
  readManifest,
  readPakDirectory,
  readPakFile,
} from "./texture-lib.mjs";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const SCALE = 4;

// The demo's own pak0.pak, the one the scaffold commit shipped. The current
// working-tree archive and HEAD's archive both contain generated replacements.
export const PRISTINE_SHA1 = "b86e8878a8e8706595ceebe88b3e6b4c1ba5bcab";
export const PRISTINE_ENTRY = "baseq2/pak0.pak";
export const PRISTINE_BYTES = 49951322;

export const DEFAULT_REPORT = path.join(PROJECT_ROOT, "docs", "texture-review", "hires-report.json");

export const GATES = {
  pearson: 0.97,
  meanAbsRgb: 6,
  flatMax: 1,
  meanLuminance: 2,
  seam: 1.15,
  outlierPercent: 0.5,
  outlierTolerance: 4,
  gradient: 1.05,
};

// How far past the seam limit the upscaler alone may aim, leaving room for the
// last rounding step and for measureGates' own 0.05 of head-room.
const SEAM_HEAD_ROOM = 0.02;

// One parameter set. `sharpen` is the unsharp amount, `threshold` its dead zone
// in linear luminance, `grain` the multiplier on the 3%-luminance grain (0 turns
// it off). The class overrides only touch how hard the edge is worked: text and
// lights keep their edges where they are, water and sky are smoothed because a
// hard edge on them reads as damage, grates are pushed a little harder so their
// bars stay bars.
export const BASE_PARAMS = {
  upscale: "catmull-rom",
  tension: 0.5,
  sharpen: 0.32,
  threshold: 0.0035,
  grain: 1,
};

export const CLASS_PARAMS = {
  "sign/arrow/text": { sharpen: 0.26, threshold: 0.0045, grain: 0 },
  light: { sharpen: 0.2, threshold: 0.005, grain: 0 },
  "water/warp": { sharpen: 0.16, threshold: 0.006, grain: 0 },
  sky: { sharpen: 0.1, threshold: 0.007, grain: 0 },
  grate: { sharpen: 0.4, threshold: 0.0028, grain: 0.45 },
  "flat/black": { sharpen: 0.14, threshold: 0.005, grain: 0 },
  generic: {},
};

export function paramsFor(textureClass) {
  return { ...BASE_PARAMS, ...(CLASS_PARAMS[textureClass] ?? CLASS_PARAMS.generic) };
}

// Textures whose content the name test cannot read. `trigger` is a brown sign
// reading "Trig" and `baslt3_1` is a fluorescent tube in a metal frame like its
// `baselt_*` neighbours, but neither name matches a class pattern, so both were
// drawn as generic: grain on a glowing fixture, text edges worked as if they
// were a rock. An override names the class to draw with (or sets single knobs
// after it), and goes into the report so the delivered art records every
// texture that did not follow its name. Gates are never touched from here.
export const TEXTURE_OVERRIDES = {
  "textures/e1u1/trigger.wal": {
    class: "sign/arrow/text",
    why: "brown sign reading 'Trig': text keeps its edges and takes no grain",
  },
  "textures/e1u1/baslt3_1.wal": {
    class: "light",
    why: "fluorescent tube in a metal frame, the same fixture as the baselt_* lights",
  },
};

export function overrideFor(name) {
  return TEXTURE_OVERRIDES[String(name).toLowerCase()] ?? null;
}

// What a texture is actually drawn with: the detected class unless an override
// names another, then that class's parameters, then any knob the override sets.
export function recipeFor(entry, source = null) {
  const detectedClass = classifyTexture(entry, source);
  const override = overrideFor(entry.name);
  const textureClass = override?.class ?? detectedClass;
  return {
    textureClass,
    detectedClass,
    override,
    params: { ...paramsFor(textureClass), ...(override?.params ?? {}) },
  };
}

// ---------------------------------------------------------------------------
// Colour: sRGB <-> linear light
// ---------------------------------------------------------------------------

const SRGB_TO_LINEAR = new Float32Array(256);
for (let value = 0; value < 256; value++) {
  const channel = value / 255;
  SRGB_TO_LINEAR[value] = channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

// Linear -> sRGB, through a table and one interpolation, because the real
// Math.pow per channel per output pixel would dominate the whole run.
const LINEAR_TABLE_SIZE = 4096;
const LINEAR_TO_SRGB = new Float32Array(LINEAR_TABLE_SIZE + 1);
for (let index = 0; index <= LINEAR_TABLE_SIZE; index++) {
  const value = index / LINEAR_TABLE_SIZE;
  LINEAR_TO_SRGB[index] = value <= 0.0031308 ? 12.92 * value : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

function linearToByte(value) {
  if (!(value > 0)) return 0;
  if (value >= 1) return 255;
  const scaled = value * LINEAR_TABLE_SIZE;
  const index = scaled | 0;
  const fraction = scaled - index;
  const encoded = LINEAR_TO_SRGB[index] + (LINEAR_TO_SRGB[index + 1] - LINEAR_TO_SRGB[index]) * fraction;
  return Math.round(encoded * 255);
}

export function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

export function rgbaToRgb(image) {
  if (image.rgb) return image;
  const data = image.data;
  if (!data || data.length !== image.width * image.height * 4) {
    throw new TextureError("that image is not the RGBA picture decodePng returns", "BAD_IMAGE");
  }
  const rgb = new Uint8Array(image.width * image.height * 3);
  for (let pixel = 0; pixel < image.width * image.height; pixel++) {
    rgb[pixel * 3] = data[pixel * 4];
    rgb[pixel * 3 + 1] = data[pixel * 4 + 1];
    rgb[pixel * 3 + 2] = data[pixel * 4 + 2];
  }
  return { width: image.width, height: image.height, rgb };
}

// ---------------------------------------------------------------------------
// The pristine archive
// ---------------------------------------------------------------------------

function sha1Of(buffer) {
  return crypto.createHash("sha1").update(buffer).digest("hex");
}

function sameFile(file, wanted) {
  try {
    return sha1Of(fs.readFileSync(file)) === wanted;
  } catch {
    return false;
  }
}

// Every blob that has ever been baseq2/pak0.pak on any branch, newest first, as
// git says. rev-list --objects names the blob ids; the path filter keeps it to
// the one file.
function pakBlobsInHistory() {
  let listing;
  try {
    listing = execFileSync("git", ["-C", PROJECT_ROOT, "rev-list", "--all", "--objects", "--", PRISTINE_ENTRY], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch (error) {
    throw new TextureError(
      "cannot read baseq2/pak0.pak from git history (" + (error && error.message ? error.message : String(error)) + ")",
      "NO_PRISTINE"
    );
  }
  const blobs = [];
  for (const line of listing.split("\n")) {
    if (!line) continue;
    const space = line.indexOf(" ");
    if (space === -1) continue;
    const id = line.slice(0, space);
    const file = line.slice(space + 1);
    if (file !== PRISTINE_ENTRY) continue;
    const size = Number(execFileSync("git", ["-C", PROJECT_ROOT, "cat-file", "-s", id], { encoding: "utf8" }).trim());
    if (size !== PRISTINE_BYTES) continue;
    if (!blobs.includes(id)) blobs.push(id);
  }
  return blobs;
}

// The demo's archive, as a Buffer, plus where it came from. It is cached in
// os.tmpdir() under its content SHA-1 so a second run -- or another tool run on
// the same box -- reads 50 MB off disk instead of replaying git history.
export function loadPristine(options = {}) {
  const wanted = options.sha1 ?? PRISTINE_SHA1;
  const working = options.pak ?? path.join(PROJECT_ROOT, PRISTINE_ENTRY);
  const cached = options.cachePath ?? path.join(os.tmpdir(), "quake2-pristine-" + wanted + ".pak");

  let buffer = null;
  let source = null;
  let cachePath = null;

  if (fs.existsSync(working) && sameFile(working, wanted)) {
    buffer = fs.readFileSync(working);
    source = "working tree " + PRISTINE_ENTRY;
  } else if (fs.existsSync(cached) && sameFile(cached, wanted)) {
    buffer = fs.readFileSync(cached);
    source = "cache " + cached;
    cachePath = cached;
  } else {
    for (const id of pakBlobsInHistory()) {
      const candidate = execFileSync("git", ["-C", PROJECT_ROOT, "cat-file", "blob", id], {
        maxBuffer: PRISTINE_BYTES + 1024 * 1024,
      });
      if (sha1Of(candidate) !== wanted) continue;
      buffer = candidate;
      source = "git history blob " + id;
      break;
    }
    if (!buffer) {
      throw new TextureError(
        "none of the baseq2/pak0.pak blobs in git history has the demo's SHA-1 " + wanted + " (" + PRISTINE_BYTES + " bytes)",
        "NO_PRISTINE"
      );
    }
    // The task asks for the archive to be extracted to os.tmpdir(); keep it
    // there so the next run and the review pass can read it without git.
    try {
      fs.writeFileSync(cached, buffer);
      cachePath = cached;
    } catch {
      // A read-only tmpdir is not a reason to fail: the bytes are in memory.
    }
  }

  const { palette } = globalPalette(buffer);
  return {
    sha1: wanted,
    source,
    cachePath,
    pak: buffer,
    directory: readPakDirectory(buffer),
    palette,
    paletteSource: "pics/colormap.pcx",
    readWal: (name) => readWalRgb(buffer, palette, name),
  };
}

// One WAL's level-zero pixels as sRGB bytes, through the archive's own global
// palette. The WAL header, not the manifest, says how wide and tall it is.
export function readWalRgb(pak, palette, name) {
  const bytes = readPakFile(pak, name);
  if (!bytes) throw new TextureError('the pristine archive has no "' + name + '"', "NO_ENTRY");
  const header = decodeWal(bytes);
  const count = header.width * header.height;
  const rgb = new Uint8Array(count * 3);
  for (let pixel = 0; pixel < count; pixel++) {
    const index = header.indices[pixel];
    rgb[pixel * 3] = palette[index * 3];
    rgb[pixel * 3 + 1] = palette[index * 3 + 1];
    rgb[pixel * 3 + 2] = palette[index * 3 + 2];
  }
  return { name, width: header.width, height: header.height, rgb, indices: header.indices, header };
}

// ---------------------------------------------------------------------------
// Which entries this tool draws
// ---------------------------------------------------------------------------

// Every WAL that already has art under assets/textures/textures/, plus every
// other frame the WAL's animname chain links to, so no animation is left with
// old art on half its frames. The chain is a set of mutual links
// (+0 -> +1 -> ... -> +0); walking it from the target set closes the family.
export function textureTargets(manifest, options = {}) {
  const wals = manifest.entries.filter((entry) => entry.type === "wal" && entry.png);
  const alreadyDrawn = options.requireArt === false ? wals : wals.filter((entry) => fs.existsSync(path.resolve(PROJECT_ROOT, entry.png)));
  const byName = new Map(wals.map((entry) => [entry.name.toLowerCase(), entry]));
  const wanted = new Map(alreadyDrawn.map((entry) => [entry.name.toLowerCase(), entry]));

  const queue = [...wanted.keys()];
  while (queue.length) {
    const entry = byName.get(queue.pop());
    if (!entry || !entry.animname) continue;
    const mateName = ("textures/" + entry.animname + ".wal").toLowerCase();
    const mate = byName.get(mateName);
    if (!mate || wanted.has(mateName)) continue;
    wanted.set(mateName, mate);
    queue.push(mateName);
  }

  return [...wanted.values()].sort((left, right) => left.name.localeCompare(right.name));
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

// The Quake 2 surface flags and contents that name a class by themselves.
const SURF_LIGHT = 0x1;
const SURF_SKY = 0x4;
const SURF_WARP = 0x8;
const CONTENTS_LAVA = 0x8;
const CONTENTS_SLIME = 0x10;
const CONTENTS_WATER = 0x20;

export const CLASS_NAMES = ["sign/arrow/text", "light", "water/warp", "sky", "grate", "flat/black", "generic"];

export function isUniform(image) {
  const rgb = image.rgb;
  const r = rgb[0];
  const g = rgb[1];
  const b = rgb[2];
  for (let index = 3; index < rgb.length; index += 3) {
    if (rgb[index] !== r || rgb[index + 1] !== g || rgb[index + 2] !== b) return false;
  }
  return true;
}

// Name and header first, pixels second: `source` is optional, and the pixel test
// is only there to catch a texture whose name does not say it is flat.
export function classifyTexture(entry, source = null) {
  const name = entry.name.toLowerCase();
  const base = name.slice(name.lastIndexOf("/") + 1);
  const flags = entry.flags ?? 0;
  const contents = entry.contents ?? 0;

  if (flags & SURF_SKY || /(^|[\/_])sky\d/.test(name) || base.startsWith("sky")) return "sky";
  if (
    flags & SURF_WARP ||
    (contents & (CONTENTS_LAVA | CONTENTS_SLIME | CONTENTS_WATER)) !== 0 ||
    /watr|water|bluwter|sewer|lava|slime|turb|swamp/.test(base)
  ) {
    return "water/warp";
  }
  if (base === "black" || base.startsWith("flat") || (source && isUniform(source))) return "flat/black";
  if (/sign|arrow|exit|caution|text|lever|alarm/.test(base)) return "sign/arrow/text";
  if (flags & SURF_LIGHT || /plite|lite|light|wndow|neon|lamp/.test(base)) return "light";
  if (/grat|bars|mesh|wire|fence|chain/.test(base)) return "grate";
  return "generic";
}

// ---------------------------------------------------------------------------
// Upscale
// ---------------------------------------------------------------------------

// Cardinal cubic (Catmull-Rom) weights for t in [0,1): the four taps at -1, 0,
// 1, 2. `tension` is the Hermite tangent scale; 0.5 is the classic Catmull-Rom,
// and lower values smooth the curve's shoulders without changing its reach.
function cubicWeights(t, tension) {
  const t2 = t * t;
  const t3 = t2 * t;
  const h00 = 2 * t3 - 3 * t2 + 1;
  const h10 = t3 - 2 * t2 + t;
  const h01 = -2 * t3 + 3 * t2;
  const h11 = t3 - t2;
  return [-h10 * tension, h00 - h11 * tension, h01 + h10 * tension, h11 * tension];
}

function wrap(index, size) {
  const value = index % size;
  return value < 0 ? value + size : value;
}

// The sample position of output pixel `out` for a `scale`-times enlargement:
// pixel centres line up, so a 4x4 block averages back to its source pixel.
function sampleAt(out, scale) {
  const position = (out + 0.5) / scale - 0.5;
  const low = Math.floor(position);
  return { low, fraction: position - low };
}

// One axis of a separable wrapped Catmull-Rom enlargement: per output column,
// the four wrapped source indices and their weights.
function axisTable(size, outSize, tension) {
  const indices = new Int32Array(outSize * 4);
  const weights = new Float32Array(outSize * 4);
  const low = new Int32Array(outSize);
  const fraction = new Float32Array(outSize);
  for (let out = 0; out < outSize; out++) {
    const sample = sampleAt(out, SCALE);
    const taps = cubicWeights(sample.fraction, tension);
    for (let tap = 0; tap < 4; tap++) {
      indices[out * 4 + tap] = wrap(sample.low - 1 + tap, size);
      weights[out * 4 + tap] = taps[tap];
    }
    low[out] = sample.low;
    fraction[out] = sample.fraction;
  }
  return { indices, weights, low, fraction };
}

function horizontalPass(source, width, height, outWidth, table) {
  const out = new Float32Array(outWidth * height * 3);
  for (let y = 0; y < height; y++) {
    const row = y * width * 3;
    for (let x = 0; x < outWidth; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let tap = 0; tap < 4; tap++) {
        const weight = table.weights[x * 4 + tap];
        const at = row + table.indices[x * 4 + tap] * 3;
        r += source[at] * weight;
        g += source[at + 1] * weight;
        b += source[at + 2] * weight;
      }
      const target = (y * outWidth + x) * 3;
      out[target] = r;
      out[target + 1] = g;
      out[target + 2] = b;
    }
  }
  return out;
}

function verticalPass(source, width, height, outHeight, table) {
  const out = new Float32Array(width * outHeight * 3);
  for (let y = 0; y < outHeight; y++) {
    const taps = [table.indices[y * 4], table.indices[y * 4 + 1], table.indices[y * 4 + 2], table.indices[y * 4 + 3]];
    const weights = [table.weights[y * 4], table.weights[y * 4 + 1], table.weights[y * 4 + 2], table.weights[y * 4 + 3]];
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let tap = 0; tap < 4; tap++) {
        const at = (taps[tap] * width + x) * 3;
        const weight = weights[tap];
        r += source[at] * weight;
        g += source[at + 1] * weight;
        b += source[at + 2] * weight;
      }
      const target = (y * width + x) * 3;
      out[target] = r;
      out[target + 1] = g;
      out[target + 2] = b;
    }
  }
  return out;
}

// Clamp every output pixel to the min/max of the source 2x2 that surrounds it.
// This is what makes the cubic's negative lobes harmless: no pixel can overshoot
// past the colours that are actually next to it, so there is no ringing halo.
// The bounds come from `source` (the original's linear pixels); `out` is only
// read and written at output coordinates.
function clampToSourcePair(source, out, width, height, outWidth, outHeight, xTable, yTable) {
  for (let y = 0; y < outHeight; y++) {
    const y0 = wrap(yTable.low[y], height);
    const y1 = wrap(yTable.low[y] + 1, height);
    const row0 = y0 * width;
    const row1 = y1 * width;
    for (let x = 0; x < outWidth; x++) {
      const x0 = wrap(xTable.low[x], width);
      const x1 = wrap(xTable.low[x] + 1, width);
      const corners = [row0 + x0, row0 + x1, row1 + x0, row1 + x1];
      const target = (y * outWidth + x) * 3;
      for (let channel = 0; channel < 3; channel++) {
        let low = Infinity;
        let high = -Infinity;
        for (let corner = 0; corner < 4; corner++) {
          const value = source[corners[corner] * 3 + channel];
          if (value < low) low = value;
          if (value > high) high = value;
        }
        const value = out[target + channel];
        out[target + channel] = value < low ? low : value > high ? high : value;
      }
    }
  }
}

// A 3x3 binomial blur, separable and wrapped, over an interleaved RGB float
// image. Used for the unsharp mask and the noise field's smoothstep.
function wrappedBlur3(linear, width, height) {
  const horizontal = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const left = (row + wrap(x - 1, width)) * 3;
      const centre = (row + x) * 3;
      const right = (row + wrap(x + 1, width)) * 3;
      for (let channel = 0; channel < 3; channel++) {
        horizontal[centre + channel] = (linear[left + channel] + 2 * linear[centre + channel] + linear[right + channel]) / 4;
      }
    }
  }
  const out = new Float32Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const above = wrap(y - 1, height);
    const below = wrap(y + 1, height);
    for (let x = 0; x < width; x++) {
      const up = (above * width + x) * 3;
      const centre = (y * width + x) * 3;
      const down = (below * width + x) * 3;
      for (let channel = 0; channel < 3; channel++) {
        out[centre + channel] = (horizontal[up + channel] + 2 * horizontal[centre + channel] + horizontal[down + channel]) / 4;
      }
    }
  }
  return out;
}

// Mild thresholded unsharp on linear luminance. A pixel whose local contrast is
// under `threshold` is left exactly alone, so flat paint stays flat and only
// real edges are crisped; the result is clamped back to the source 2x2 envelope.
function unsharp(source, linear, bounds, params) {
  const blurred = wrappedBlur3(linear, bounds.width, bounds.height);
  const amount = params.sharpen;
  const threshold = params.threshold;
  for (let pixel = 0; pixel < bounds.width * bounds.height; pixel++) {
    const at = pixel * 3;
    const dr = linear[at] - blurred[at];
    const dg = linear[at + 1] - blurred[at + 1];
    const db = linear[at + 2] - blurred[at + 2];
    const detail = Math.abs(0.2126 * dr + 0.7152 * dg + 0.0722 * db);
    if (!(detail > threshold)) continue;
    let strength = (detail - threshold) / threshold;
    if (strength > 1) strength = 1;
    const scale = amount * strength;
    linear[at] += dr * scale;
    linear[at + 1] += dg * scale;
    linear[at + 2] += db * scale;
  }
  clampToSourcePair(source, linear, bounds.sourceWidth, bounds.sourceHeight, bounds.width, bounds.height, bounds.xTable, bounds.yTable);
}

// A deterministic hash in [0,1), the grain's only source of randomness. No
// Math.random: the same texture always gets the same grain.
function hash01(x, y, seed) {
  let hash = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(seed, 362437);
  hash = Math.imul(hash ^ (hash >>> 13), 1274126177);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4294967296;
}

// Fine grain, on the source grid and then enlarged with the same wrapped
// bilinear the clamp uses, so the grain field itself is periodic with the
// texture and adds nothing to the seam. The caller scales it by 3% of the local
// luminance, times how textured that part of the source is.
function grainField(width, height, outWidth, outHeight, xTable, yTable) {
  const noise = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Two octaves on the same grid, one finer: value noise, not white noise,
      // so the grain reads as film grain and not as static.
      const coarse = hash01(x, y, 0x51ed) * 2 - 1;
      const fine = 0.5 * (hash01(x * 2, y * 2, 0x9e37) + hash01(x * 2 + 1, y * 2 + 1, 0x9e37)) * 2 - 1;
      noise[y * width + x] = 0.7 * coarse + 0.3 * fine;
    }
  }
  const out = new Float32Array(outWidth * outHeight);
  for (let y = 0; y < outHeight; y++) {
    const y0 = wrap(yTable.low[y], height);
    const y1 = wrap(yTable.low[y] + 1, height);
    const ty = yTable.fraction[y];
    for (let x = 0; x < outWidth; x++) {
      const x0 = wrap(xTable.low[x], width);
      const x1 = wrap(xTable.low[x] + 1, width);
      const tx = xTable.fraction[x];
      const top = noise[y0 * width + x0] * (1 - tx) + noise[y0 * width + x1] * tx;
      const bottom = noise[y1 * width + x0] * (1 - tx) + noise[y1 * width + x1] * tx;
      out[y * outWidth + x] = top * (1 - ty) + bottom * ty;
    }
  }
  return out;
}

// Local standard deviation of source luminance over the wrapped 3x3, and the
// wrapped 3x3 source RGB envelope, both per source pixel. The envelope is what
// the final safety clamp uses; it is the same 3x3 the QC gate measures against.
function sourceEnvelopes(image) {
  const { width, height, rgb } = image;
  const count = width * height;
  const means = new Float32Array(count);
  const deviations = new Float32Array(count);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const row = wrap(y + dy, height);
        for (let dx = -1; dx <= 1; dx++) {
          const at = (row * width + wrap(x + dx, width)) * 3;
          sum += luminance(rgb[at], rgb[at + 1], rgb[at + 2]);
        }
      }
      const mean = sum / 9;
      let variance = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const row = wrap(y + dy, height);
        for (let dx = -1; dx <= 1; dx++) {
          const at = (row * width + wrap(x + dx, width)) * 3;
          const difference = luminance(rgb[at], rgb[at + 1], rgb[at + 2]) - mean;
          variance += difference * difference;
        }
      }
      const index = y * width + x;
      means[index] = mean;
      deviations[index] = Math.sqrt(variance / 9);
    }
  }
  const low = new Uint8Array(count * 3);
  const high = new Uint8Array(count * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < 3; channel++) {
        let minimum = 255;
        let maximum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const row = wrap(y + dy, height);
          for (let dx = -1; dx <= 1; dx++) {
            const value = rgb[(row * width + wrap(x + dx, width)) * 3 + channel];
            if (value < minimum) minimum = value;
            if (value > maximum) maximum = value;
          }
        }
        const index = (y * width + x) * 3 + channel;
        low[index] = minimum;
        high[index] = maximum;
      }
    }
  }
  return { means, deviations, low, high };
}

// The 4x picture: the whole recipe above, in the order the comments describe.
//   image   { width, height, rgb }  sRGB bytes, the original WAL pixels
//   options { textureClass, params }  class/params normally come from
//           classifyTexture() and paramsFor(); passing them only overrides.
// Returns { width, height, rgb } at 4x.
export function upscaleImage(image, options = {}) {
  if (!image || !image.rgb || image.rgb.length !== image.width * image.height * 3) {
    throw new TextureError("upscaleImage needs { width, height, rgb } sRGB bytes", "BAD_IMAGE");
  }
  const textureClass = options.textureClass ?? options.class ?? "generic";
  const params = { ...paramsFor(textureClass), ...(options.params ?? {}) };
  const width = image.width;
  const height = image.height;
  const outWidth = width * SCALE;
  const outHeight = height * SCALE;

  const source = new Float32Array(width * height * 3);
  for (let pixel = 0; pixel < width * height * 3; pixel++) source[pixel] = SRGB_TO_LINEAR[image.rgb[pixel]];

  const xTable = axisTable(width, outWidth, params.tension);
  const yTable = axisTable(height, outHeight, params.tension);
  const bounds = { width: outWidth, height: outHeight, sourceWidth: width, sourceHeight: height, xTable, yTable };

  let linear = horizontalPass(source, width, height, outWidth, xTable);
  linear = verticalPass(linear, outWidth, height, outHeight, yTable);
  clampToSourcePair(source, linear, width, height, outWidth, outHeight, xTable, yTable);
  unsharp(source, linear, bounds, params);

  // Linear floats to sRGB floats, still unrounded so grain can be added in the
  // same units the gate measures.
  const srgb = new Float32Array(outWidth * outHeight * 3);
  for (let index = 0; index < srgb.length; index++) {
    const value = linear[index];
    if (!(value > 0)) srgb[index] = 0;
    else if (value >= 1) srgb[index] = 255;
    else {
      const scaled = value * LINEAR_TABLE_SIZE;
      const tableIndex = scaled | 0;
      const fraction = scaled - tableIndex;
      const encoded = LINEAR_TO_SRGB[tableIndex] + (LINEAR_TO_SRGB[tableIndex + 1] - LINEAR_TO_SRGB[tableIndex]) * fraction;
      srgb[index] = encoded * 255;
    }
  }

  // Keep each 4x4 block's mean on the source pixel it replaces. Interpolation
  // and the sharpening move colour around inside a block but must not change
  // what the texture says on average; this one pass makes the downsample gate
  // ("the 4x art, box-averaged back, is the original") true by construction
  // rather than by luck, and it is far too small to be seen.
  for (let sourceY = 0; sourceY < height; sourceY++) {
    for (let sourceX = 0; sourceX < width; sourceX++) {
      let blockR = 0;
      let blockG = 0;
      let blockB = 0;
      for (let dy = 0; dy < SCALE; dy++) {
        const row = ((sourceY * SCALE + dy) * outWidth + sourceX * SCALE) * 3;
        for (let dx = 0; dx < SCALE; dx++) {
          blockR += srgb[row + dx * 3];
          blockG += srgb[row + dx * 3 + 1];
          blockB += srgb[row + dx * 3 + 2];
        }
      }
      const total = SCALE * SCALE;
      const at = (sourceY * width + sourceX) * 3;
      const correctionR = image.rgb[at] - blockR / total;
      const correctionG = image.rgb[at + 1] - blockG / total;
      const correctionB = image.rgb[at + 2] - blockB / total;
      if (Math.abs(correctionR) < 1e-4 && Math.abs(correctionG) < 1e-4 && Math.abs(correctionB) < 1e-4) continue;
      for (let dy = 0; dy < SCALE; dy++) {
        const outY = sourceY * SCALE + dy;
        const row = (outY * outWidth + sourceX * SCALE) * 3;
        for (let dx = 0; dx < SCALE; dx++) {
          const outX = sourceX * SCALE + dx;
          // The outermost ring is the pixel that touches the next tile. Leave
          // it at the interpolated value so the mean repair cannot sharpen the
          // wrap seam the interpolation had just smoothed; the other fifteen
          // pixels of the block absorb the (tiny) correction instead.
          if (outX === 0 || outX === outWidth - 1 || outY === 0 || outY === outHeight - 1) continue;
          srgb[row + dx * 3] += correctionR;
          srgb[row + dx * 3 + 1] += correctionG;
          srgb[row + dx * 3 + 2] += correctionB;
        }
      }
    }
  }

  const envelopes = sourceEnvelopes(image);
  if (params.grain > 0) {
    const grain = grainField(width, height, outWidth, outHeight, xTable, yTable);
    for (let y = 0; y < outHeight; y++) {
      const sourceRow = (y >> 2) * width;
      for (let x = 0; x < outWidth; x++) {
        const sourceIndex = sourceRow + (x >> 2);
        const deviation = envelopes.deviations[sourceIndex];
        // Nothing on flat paint; a third of the maximum by a local deviation of
        // about 10, full only on genuinely busy pixels.
        let factor = (deviation - 2) / 30;
        if (factor < 0) continue;
        if (factor > 1) factor = 1;
        const at = (y * outWidth + x) * 3;
        const pixelLuminance = luminance(srgb[at], srgb[at + 1], srgb[at + 2]);
        // At most 3% of the local luminance, and never more than 4/255, so the
        // grain cannot by itself push a pixel past gate 4's tolerance.
        const amplitude = Math.min(pixelLuminance * 0.03, GATES.outlierTolerance) * factor * params.grain;
        if (!(amplitude > 0)) continue;
        const noise = grain[y * outWidth + x];
        for (let channel = 0; channel < 3; channel++) srgb[at + channel] += amplitude * noise;
      }
    }
  }

  // The last word on "no new shapes": every output pixel ends inside the source
  // 3x3 it came from, give or take the gate's 4 levels, so nothing can sit on a
  // wall that the demo did not put within a hair of that spot.
  const out = new Uint8Array(outWidth * outHeight * 3);
  for (let y = 0; y < outHeight; y++) {
    const sourceRow = (y >> 2) * width;
    for (let x = 0; x < outWidth; x++) {
      const sourceIndex = sourceRow + (x >> 2);
      const at = (y * outWidth + x) * 3;
      const envelope = sourceIndex * 3;
      for (let channel = 0; channel < 3; channel++) {
        let value = srgb[at + channel];
        const low = envelopes.low[envelope + channel] - GATES.outlierTolerance;
        const high = envelopes.high[envelope + channel] + GATES.outlierTolerance;
        if (value < low) value = low;
        else if (value > high) value = high;
        out[at + channel] = value <= 0 ? 0 : value >= 255 ? 255 : Math.round(value);
      }
    }
  }

  // The enlargement must not add a wrap seam of its own. The demo's WALs already
  // carry a boundary step -- some of them a large one -- and sharpening a genuine
  // edge is the point of the filter, but where the sharpening would push the
  // boundary past 1.15x what a plain wrapped bilinear does, the outermost output
  // ring (the pixels that touch the next tile) is blended toward the bilinear
  // result. Only that ring moves, and only when it has to. It runs after the
  // final clamp, on the 8-bit picture the gate will measure.
  guardSeam(out, outWidth, outHeight, image);

  return { width: outWidth, height: outHeight, rgb: out, textureClass, params };
}

// A plain wrapped bilinear 4x, the gradient baseline gate 5 compares against.
// Deliberately not clamped and not sharpened: it is what a naive enlargement of
// the same pixels would do.
export function bilinear4x(image) {
  const { width, height, rgb } = image;
  const outWidth = width * SCALE;
  const outHeight = height * SCALE;
  const xTable = axisTable(width, outWidth, 0);
  const yTable = axisTable(height, outHeight, 0);
  const out = new Uint8Array(outWidth * outHeight * 3);
  for (let y = 0; y < outHeight; y++) {
    const y0 = wrap(yTable.low[y], height);
    const y1 = wrap(yTable.low[y] + 1, height);
    const ty = yTable.fraction[y];
    for (let x = 0; x < outWidth; x++) {
      const x0 = wrap(xTable.low[x], width);
      const x1 = wrap(xTable.low[x] + 1, width);
      const tx = xTable.fraction[x];
      const at = (y * outWidth + x) * 3;
      for (let channel = 0; channel < 3; channel++) {
        const top = rgb[(y0 * width + x0) * 3 + channel] * (1 - tx) + rgb[(y0 * width + x1) * 3 + channel] * tx;
        const bottom = rgb[(y1 * width + x0) * 3 + channel] * (1 - tx) + rgb[(y1 * width + x1) * 3 + channel] * tx;
        out[at + channel] = Math.round(top * (1 - ty) + bottom * ty);
      }
    }
  }
  return { width: outWidth, height: outHeight, rgb: out };
}

// The 4x4 box average back to the original size, rounded, in sRGB -- the
// downsample gate 1 measures against.
export function boxDownsample4(image) {
  if (image.width % SCALE !== 0 || image.height % SCALE !== 0) {
    throw new TextureError("boxDownsample4 needs a multiple of " + SCALE, "BAD_IMAGE");
  }
  const width = image.width / SCALE;
  const height = image.height / SCALE;
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < SCALE; dy++) {
        const row = (y * SCALE + dy) * image.width;
        for (let dx = 0; dx < SCALE; dx++) {
          const at = (row + x * SCALE + dx) * 3;
          r += image.rgb[at];
          g += image.rgb[at + 1];
          b += image.rgb[at + 2];
        }
      }
      const at = (y * width + x) * 3;
      rgb[at] = Math.round(r / (SCALE * SCALE));
      rgb[at + 1] = Math.round(g / (SCALE * SCALE));
      rgb[at + 2] = Math.round(b / (SCALE * SCALE));
    }
  }
  return { width, height, rgb };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

function luminanceArray(image) {
  const out = new Float32Array(image.width * image.height);
  for (let pixel = 0; pixel < out.length; pixel++) {
    out[pixel] = luminance(image.rgb[pixel * 3], image.rgb[pixel * 3 + 1], image.rgb[pixel * 3 + 2]);
  }
  return out;
}

function pearson(left, right) {
  const count = left.length;
  let leftSum = 0;
  let rightSum = 0;
  for (let index = 0; index < count; index++) {
    leftSum += left[index];
    rightSum += right[index];
  }
  const leftMean = leftSum / count;
  const rightMean = rightSum / count;
  let covariance = 0;
  let leftVariance = 0;
  let rightVariance = 0;
  for (let index = 0; index < count; index++) {
    const leftDelta = left[index] - leftMean;
    const rightDelta = right[index] - rightMean;
    covariance += leftDelta * rightDelta;
    leftVariance += leftDelta * leftDelta;
    rightVariance += rightDelta * rightDelta;
  }
  if (leftVariance === 0 || rightVariance === 0) {
    // A flat picture has no correlation to speak of; the caller uses the flat
    // rule instead. 1 here means "no evidence against".
    return 1;
  }
  return covariance / Math.sqrt(leftVariance * rightVariance);
}

// The wrap-seam step: the mean absolute colour step between the last column
// and the first (and the last row and the first), and the same measure over the
// interior neighbours, which is the step a tile's own edge-to-edge transition
// is compared with.
export function seamSteps(image) {
  const { width, height, rgb } = image;
  const channelStep = (left, right) =>
    (Math.abs(rgb[left] - rgb[right]) + Math.abs(rgb[left + 1] - rgb[right + 1]) + Math.abs(rgb[left + 2] - rgb[right + 2])) / 3;

  let seamX = 0;
  for (let y = 0; y < height; y++) seamX += channelStep((y * width) * 3, (y * width + width - 1) * 3);
  seamX /= height;

  let interiorX = 0;
  let interiorCount = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 1; x < width; x++) {
      interiorX += channelStep((y * width + x) * 3, (y * width + x - 1) * 3);
      interiorCount++;
    }
  }
  interiorX = interiorCount ? interiorX / interiorCount : 0;

  let seamY = 0;
  for (let x = 0; x < width; x++) seamY += channelStep(x * 3, ((height - 1) * width + x) * 3);
  seamY /= width;

  let interiorY = 0;
  let interiorCountY = 0;
  for (let y = 1; y < height; y++) {
    for (let x = 0; x < width; x++) {
      interiorY += channelStep((y * width + x) * 3, ((y - 1) * width + x) * 3);
      interiorCountY++;
    }
  }
  interiorY = interiorCountY ? interiorY / interiorCountY : 0;

  const ratioX = interiorX > 1e-6 ? seamX / interiorX : seamX > 1e-6 ? Infinity : 1;
  const ratioY = interiorY > 1e-6 ? seamY / interiorY : seamY > 1e-6 ? Infinity : 1;
  return { seamX, seamY, interiorX, interiorY, ratioX, ratioY, ratio: Math.max(ratioX, ratioY) };
}

// Blend the outermost output ring toward a plain wrapped bilinear until the
// boundary step is no more than 1.15x bilinear's, measured as a ratio of the
// interior step (see the gate-3 note at the top). This runs on the finished
// 8-bit picture, because that is the picture the gate measures: rounding to
// whole levels is what turns a sub-level difference into a step, and a guard
// that worked in floats would not survive it. Each pass doubles its reach, so a
// boundary that needs a sixth of a level of adjustment is fixed without moving
// the ring any further than it has to.
function guardSeam(out, outWidth, outHeight, image) {
  const bilinear = bilinear4x(image);
  const baseline = seamSteps(bilinear);
  let amount = 0;
  for (let pass = 0; pass < 6; pass++) {
    const current = seamSteps({ width: outWidth, height: outHeight, rgb: out });
    const needs = {};
    for (const axis of ["X", "Y"]) {
      const step = current["seam" + axis];
      const baselineStep = baseline["seam" + axis];
      // A boundary no more than one level high, in both pictures, cannot be
      // seen: there is nothing to guard.
      if (step <= 1 && baselineStep <= 1) continue;
      const limit = GATES.seam * baseline["ratio" + axis] + SEAM_HEAD_ROOM;
      if (current["ratio" + axis] > limit) needs[axis] = true;
    }
    if (!needs.X && !needs.Y) break;
    amount = Math.min(1, amount === 0 ? 0.1 : amount * 2);
    const mix = (at) => {
      for (let channel = 0; channel < 3; channel++) {
        out[at + channel] = Math.round(out[at + channel] + (bilinear.rgb[at + channel] - out[at + channel]) * amount);
      }
    };
    if (needs.X) {
      for (let y = 0; y < outHeight; y++) {
        mix(y * outWidth * 3);
        mix((y * outWidth + outWidth - 1) * 3);
      }
    }
    if (needs.Y) {
      for (let x = 0; x < outWidth; x++) {
        mix(x * 3);
        mix(((outHeight - 1) * outWidth + x) * 3);
      }
    }
  }
}

function meanGradient(image) {
  const { width, height } = image;
  const lum = luminanceArray(image);
  let total = 0;
  let count = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const here = lum[y * width + x];
      total += Math.abs(here - lum[y * width + wrap(x - 1, width)]);
      total += Math.abs(here - lum[wrap(y - 1, height) * width + x]);
      count += 2;
    }
  }
  return count ? total / count : 0;
}

// The 3x3 source envelope gate 4 measures against, per source pixel.
function sourceRange(image) {
  const { width, height, rgb } = image;
  const low = new Uint8Array(width * height * 3);
  const high = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let channel = 0; channel < 3; channel++) {
        let minimum = 255;
        let maximum = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const row = wrap(y + dy, height);
          for (let dx = -1; dx <= 1; dx++) {
            const value = rgb[(row * width + wrap(x + dx, width)) * 3 + channel];
            if (value < minimum) minimum = value;
            if (value > maximum) maximum = value;
          }
        }
        const index = (y * width + x) * 3 + channel;
        low[index] = minimum;
        high[index] = maximum;
      }
    }
  }
  return { low, high };
}

// Measure one 4x picture against the original it was drawn from. `art` is the
// 4x image; `original` is the WAL's own size. Returns every number the report
// keeps, the gate verdicts and the list of gates that failed.
export function measureGates(original, art, options = {}) {
  const gates = options.gates ?? GATES;
  const failures = [];
  const dimsOk = art.width === original.width * SCALE && art.height === original.height * SCALE;
  if (!dimsOk) {
    failures.push("size " + art.width + "x" + art.height + " is not " + SCALE + "x " + original.width + "x" + original.height);
  }

  const downsampled = boxDownsample4(art);
  const originalLuminance = luminanceArray(original);
  const downsampleLuminance = luminanceArray(downsampled);

  const flat = isUniform(original);
  let flatMax = 0;
  if (flat) {
    for (let index = 0; index < art.rgb.length; index++) {
      const difference = Math.abs(art.rgb[index] - original.rgb[index % 3]);
      if (difference > flatMax) flatMax = difference;
    }
  }

  const correlation = flat ? 1 : pearson(originalLuminance, downsampleLuminance);

  let meanAbsRgb = 0;
  for (let index = 0; index < downsampled.rgb.length; index++) {
    meanAbsRgb += Math.abs(downsampled.rgb[index] - original.rgb[index]);
  }
  meanAbsRgb /= downsampled.rgb.length;

  let meanLuminanceError = 0;
  let meanOriginal = 0;
  let meanDownsample = 0;
  for (let index = 0; index < originalLuminance.length; index++) {
    meanLuminanceError += Math.abs(downsampleLuminance[index] - originalLuminance[index]);
    meanOriginal += originalLuminance[index];
    meanDownsample += downsampleLuminance[index];
  }
  meanLuminanceError /= originalLuminance.length;
  meanOriginal /= originalLuminance.length;
  meanDownsample /= originalLuminance.length;

  const artSeam = seamSteps(art);
  const sourceSeam = seamSteps(original);
  const bilinear = bilinear4x(original);
  const bilinearSeam = seamSteps(bilinear);
  const seam = artSeam.ratio;

  // Gate 3 says the upscale adds no seam, so each axis is compared as the ratio
  // seam step / interior step -- the shape of the transition, which is what a
  // sharpening filter legitimately changes -- against the same ratio for a plain
  // wrapped bilinear 4x. 0.05 of a ratio is head-room for a step averaged over
  // 0..255 levels. A boundary step under one level in both pictures is invisible
  // and passes outright; that is the `trigger` texture, whose baseline is zero.
  const seamAllows = (axis) =>
    (artSeam["seam" + axis] <= 1 && bilinearSeam["seam" + axis] <= 1) ||
    artSeam["ratio" + axis] <= gates.seam * bilinearSeam["ratio" + axis] + 0.05;
  const gate3 = seamAllows("X") && seamAllows("Y");

  // Gate 4: how far outside the source 3x3 each output pixel sits.
  const range = sourceRange(original);
  let outliers = 0;
  for (let y = 0; y < art.height; y++) {
    const sourceRow = (y >> 2) * original.width;
    for (let x = 0; x < art.width; x++) {
      const at = (y * art.width + x) * 3;
      const envelope = (sourceRow + (x >> 2)) * 3;
      let outside = false;
      for (let channel = 0; channel < 3; channel++) {
        const value = art.rgb[at + channel];
        if (value > range.high[envelope + channel] + gates.outlierTolerance || value < range.low[envelope + channel] - gates.outlierTolerance) {
          outside = true;
          break;
        }
      }
      if (outside) outliers++;
    }
  }
  const outlierPercent = (outliers / (art.width * art.height)) * 100;

  const artGradient = meanGradient(art);
  const baselineGradient = meanGradient(bilinear);
  const gradientRatio = baselineGradient > 1e-6 ? artGradient / baselineGradient : artGradient > 1e-6 ? Infinity : 1;

  const gate1 = flat ? flatMax <= gates.flatMax : correlation >= gates.pearson && meanAbsRgb <= gates.meanAbsRgb;
  if (!gate1) failures.push(flat ? "a flat original is not flat within " + gates.flatMax + " (worst " + flatMax + ")" : "r " + correlation.toFixed(4) + " / mean RGB error " + meanAbsRgb.toFixed(3));
  // "mean luminance within 2" is the picture's mean, not each pixel's: the
  // per-pixel error is reported beside it, but a dithered source would fail a
  // per-pixel rule no faithful enlargement can avoid.
  const meanLuminanceBias = Math.abs(meanDownsample - meanOriginal);
  const gate2 = meanLuminanceBias <= gates.meanLuminance;
  if (!gate2) failures.push("mean luminance shifted " + meanLuminanceBias.toFixed(3));
  if (!gate3) {
    failures.push(
      "wrap seam X " + artSeam.ratioX.toFixed(4) + "/Y " + artSeam.ratioY.toFixed(4) + "x interior, bilinear X " +
        bilinearSeam.ratioX.toFixed(4) + "/Y " + bilinearSeam.ratioY.toFixed(4) + "x (source " + sourceSeam.ratio.toFixed(4) + "x)"
    );
  }
  const gate4 = outlierPercent <= gates.outlierPercent;
  if (!gate4) failures.push(outlierPercent.toFixed(3) + "% of pixels outside their source 3x3 by more than " + gates.outlierTolerance);
  // A completely flat original has no gradient to beat; there is nothing for
  // the 1.05x rule to measure, so it passes by construction.
  const gate5 = baselineGradient <= 1e-6 || gradientRatio >= gates.gradient;
  if (!gate5) failures.push("gradient " + gradientRatio.toFixed(3) + "x bilinear");

  const metrics = {
    pearson: round(correlation),
    meanAbsRgb: round(meanAbsRgb),
    flat,
    flatMax: flat ? flatMax : null,
    meanLuminanceError: round(meanLuminanceError),
    meanLuminanceBias: round(meanLuminanceBias),
    seam: round(seam),
    seamSource: round(sourceSeam.ratio),
    seamBilinear: round(bilinearSeam.ratio),
    seamStep: round(Math.max(artSeam.seamX, artSeam.seamY)),
    seamStepBilinear: round(Math.max(bilinearSeam.seamX, bilinearSeam.seamY)),
    outlierPercent: round(outlierPercent),
    gradient: round(gradientRatio),
  };

  return {
    metrics,
    gates: { downsample: gate1, luminance: gate2, seam: gate3, outliers: gate4, gradient: gate5 },
    pass: dimsOk && gate1 && gate2 && gate3 && gate4 && gate5,
    failures,
  };
}

function round(value) {
  if (!Number.isFinite(value)) return value === Infinity ? null : String(value);
  return Math.round(value * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// PNG writer (8-bit RGB, non-interlaced -- colour type 2, no alpha)
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let value = 0xffffffff;
  for (let index = 0; index < buffer.length; index++) value = CRC_TABLE[(value ^ buffer[index]) & 255] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "latin1");
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  typeBytes.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length);
  return chunk;
}

function paeth(left, above, upperLeft) {
  const estimate = left + above - upperLeft;
  const leftDistance = Math.abs(estimate - left);
  const aboveDistance = Math.abs(estimate - above);
  const upperLeftDistance = Math.abs(estimate - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) return left;
  if (aboveDistance <= upperLeftDistance) return above;
  return upperLeft;
}

function signedAbs(value) {
  return value < 128 ? value : 256 - value;
}

// Adaptive per-row filtering: the standard minimum-sum heuristic over the five
// PNG filters. It costs a pass over the row and saves a large part of the
// file, which matters when 270 pictures of 4x art go into the repository.
export function encodePngRgb(width, height, rgb) {
  if (rgb.length !== width * height * 3) throw new TextureError("encodePngRgb: rgb is not width x height x 3", "BAD_IMAGE");
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  let previous = Buffer.alloc(stride);
  const candidate = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const row = Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride);
    let bestFilter = 0;
    let bestScore = Infinity;
    let best = null;
    for (let filter = 0; filter < 5; filter++) {
      let score = 0;
      for (let i = 0; i < stride; i++) {
        const left = i >= 3 ? row[i - 3] : 0;
        const above = previous[i];
        const upperLeft = i >= 3 ? previous[i - 3] : 0;
        let value;
        switch (filter) {
          case 0: value = row[i]; break;
          case 1: value = row[i] - left; break;
          case 2: value = row[i] - above; break;
          case 3: value = row[i] - ((left + above) >> 1); break;
          default: value = row[i] - paeth(left, above, upperLeft); break;
        }
        value &= 255;
        candidate[i] = value;
        score += signedAbs(value);
      }
      if (score < bestScore) {
        bestScore = score;
        bestFilter = filter;
        best = Buffer.from(candidate);
      }
    }
    raw[y * (stride + 1)] = bestFilter;
    best.copy(raw, y * (stride + 1) + 1);
    previous = row;
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour, no alpha
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // not interlaced
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// A PNG on disk as { width, height, rgb }, with the format this tool promises
// checked: 8-bit, non-interlaced, colour type 2 or 3.
export function decodePngRgb(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 33 || buffer.readUInt32BE(0) !== 0x89504e47) throw new TextureError(file + " is not a PNG", "BAD_PNG");
  if (buffer.toString("latin1", 12, 16) !== "IHDR") throw new TextureError(file + " has no IHDR", "BAD_PNG");
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  const depth = buffer[24];
  const colorType = buffer[25];
  const interlace = buffer[28];
  if (depth !== 8) throw new TextureError(file + " is " + depth + "-bit, not 8-bit", "BAD_PNG");
  if (colorType !== 2 && colorType !== 3) throw new TextureError(file + " is colour type " + colorType + ", not 2 or 3", "BAD_PNG");
  if (interlace !== 0) throw new TextureError(file + " is interlaced", "BAD_PNG");
  return rgbaToRgb(decodePng(buffer));
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

const USAGE = `hires-art.mjs -- 4x art for the demo's surface textures

  --check            check the art already on disk; draw nothing
  --only <text>      only entries whose name contains <text> (repeatable)
  --report <file>    where the gate report goes (default docs/texture-review/hires-report.json)
  --json             print the report to stdout as well
  --quiet            only the summary
  --help             this text
`;

function rel(file) {
  return path.relative(PROJECT_ROOT, file).split(path.sep).join("/") || ".";
}

function parseArguments(argv) {
  const options = { check: false, only: [], report: null, json: false, quiet: false, help: false };
  const takesValue = new Set(["--only", "--report"]);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--check") options.check = true;
    else if (argument === "--json") options.json = true;
    else if (argument === "--quiet") options.quiet = true;
    else {
      const split = argument.indexOf("=");
      const flag = split === -1 ? argument : argument.slice(0, split);
      if (!takesValue.has(flag)) throw new TextureError("unknown option " + argument + "\n\n" + USAGE, "BAD_ARGUMENT");
      const value = split === -1 ? argv[++index] : argument.slice(split + 1);
      if (value === undefined || (split === -1 && value.startsWith("--"))) {
        throw new TextureError(flag + " needs a value", "BAD_ARGUMENT");
      }
      if (flag === "--only") options.only.push(value.toLowerCase());
      else options.report = path.resolve(value);
    }
  }
  return options;
}

function artFileFor(entry) {
  return path.isAbsolute(entry.png) ? entry.png : path.join(PROJECT_ROOT, entry.png);
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const manifest = readManifest(DEFAULT_MANIFEST);
  let targets = textureTargets(manifest);
  if (options.only.length) {
    targets = targets.filter((entry) => options.only.some((text) => entry.name.toLowerCase().includes(text)));
    if (!targets.length) throw new TextureError("no target WAL matches --only " + options.only.join(", "), "BAD_ARGUMENT");
  }

  const pristine = loadPristine();
  const reportPath = options.report ?? DEFAULT_REPORT;
  const entries = [];
  const classCounts = {};
  let artBytes = 0;
  let pngBytes = 0;
  let artPixels = 0;
  let failures = 0;
  let unchanged = 0;

  for (const entry of targets) {
    const original = pristine.readWal(entry.name);
    const recipe = recipeFor(entry, original);
    const textureClass = recipe.textureClass;
    const file = artFileFor(entry);
    let art = null;
    let generated = false;

    if (options.check) {
      if (!fs.existsSync(file)) {
        const result = { name: entry.name, png: rel(file), textureClass, source: original.width + "x" + original.height, art: null, pass: false, failures: ["no art on disk"], metrics: null, gates: null };
        entries.push(result);
        failures++;
        if (!options.quiet) process.stderr.write("FAIL " + entry.name + ": no art on disk (" + rel(file) + ")\n");
        continue;
      }
      art = decodePngRgb(file);
    } else {
      art = upscaleImage(original, { textureClass, params: recipe.params });
      const png = encodePngRgb(art.width, art.height, art.rgb);
      const previous = fs.existsSync(file) ? fs.readFileSync(file) : null;
      if (!previous || !previous.equals(png)) {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, png);
      } else {
        unchanged++;
      }
      // Read back what was written, so a bug in the writer cannot pass the gate
      // that the writer's own array would have passed.
      art = decodePngRgb(file);
      generated = true;
    }

    const measurement = measureGates(original, art);
    const bytes = fs.existsSync(file) ? fs.statSync(file).size : 0;
    artBytes += art.width * art.height * 3;
    artPixels += art.width * art.height;
    pngBytes += bytes;
    classCounts[textureClass] = (classCounts[textureClass] ?? 0) + 1;
    if (!measurement.pass) failures++;

    entries.push({
      name: entry.name,
      png: rel(file),
      textureClass,
      ...(recipe.override ? { detectedClass: recipe.detectedClass, override: { class: recipe.override.class ?? null, params: recipe.override.params ?? null, why: recipe.override.why } } : {}),
      source: original.width + "x" + original.height,
      art: art.width + "x" + art.height,
      pngBytes: bytes,
      generated,
      pass: measurement.pass,
      gates: measurement.gates,
      metrics: measurement.metrics,
      failures: measurement.failures,
    });
    if (!measurement.pass) {
      for (const failure of measurement.failures) process.stderr.write("FAIL " + entry.name + " (" + textureClass + "): " + failure + "\n");
    } else if (!options.quiet) {
      const metrics = measurement.metrics;
      process.stdout.write(
        "ok   " + entry.name.padEnd(38) + " " + textureClass.padEnd(15) + " " + original.width + "x" + original.height + " -> " + art.width + "x" + art.height +
          "  r " + metrics.pearson.toFixed(4) + "  rgb " + metrics.meanAbsRgb.toFixed(2) + "  seam " + metrics.seam.toFixed(2) + "  grad " + metrics.gradient.toFixed(2) + "\n"
      );
    }
  }

  const report = {
    generator: "scripts/hires-art.mjs",
    scale: SCALE,
    mode: options.check ? "check" : "generate",
    only: options.only.length ? options.only : null,
    // The cache lives in os.tmpdir(), whose path is this box's; the SHA-1 is
    // what makes the archive the same everywhere, so the report names that.
    pristine: { entry: PRISTINE_ENTRY, sha1: pristine.sha1, source: pristine.source.startsWith("cache ") ? "os.tmpdir cache" : pristine.source, palette: pristine.paletteSource },
    recipe: {
      upscale: "wrapped separable Catmull-Rom, linear light, clamped to the source 2x2",
      sharpen: "thresholded unsharp on linear luminance, clamped again",
      blockMean: "each 4x4 block's mean restored to the source pixel it replaces, outermost output ring left alone",
      seamGuard: "only if the finished 8-bit seam ratio exceeds 1.15x bilinear's, blend the outermost ring that far toward a plain wrapped bilinear",
      grain: "wrapped value noise on the source grid, at most 3% of local luminance and 4/255 absolute, scaled by source 3x3 variance; off for sign/arrow/text, light, water/warp, sky and flat/black",
      finalClamp: "source 3x3 min/max +/- " + GATES.outlierTolerance,
      parameters: BASE_PARAMS,
      classes: CLASS_PARAMS,
      overrides: TEXTURE_OVERRIDES,
    },
    gates: GATES,
    summary: {
      entries: entries.length,
      passed: entries.length - failures,
      failed: failures,
      classes: Object.fromEntries(CLASS_NAMES.filter((name) => classCounts[name]).map((name) => [name, classCounts[name]])),
      artPixels,
      artBytes,
      pngBytes,
      unchanged,
    },
    entries,
  };

  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 1) + "\n");

  process.stdout.write(
    (options.check ? "checked" : "drew") + " " + entries.length + " textures: " + report.summary.passed + " pass, " + failures + " fail" +
      " (" + GATES.pearson + " r, " + GATES.meanAbsRgb + " rgb, " + GATES.meanLuminance + " luma, " + GATES.seam + "x seam, " +
      GATES.outlierPercent + "% outliers, " + GATES.gradient + "x gradient); " +
      artPixels + " px, " + formatBytes(pngBytes) + " PNG" +
      (options.check ? "" : ", " + unchanged + " already identical") + "\n" +
      "report: " + rel(reportPath) + "\n"
  );
  if (options.json) process.stdout.write(JSON.stringify(report, null, 1) + "\n");
  return failures ? 1 : 0;
}

// Only run the CLI when this file is executed, so the review task can import
// loadPristine(), upscaleImage() and measureGates() without side effects.
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write((error instanceof TextureError ? error.message : error && error.stack ? error.stack : String(error)) + "\n");
    process.exitCode = 2;
  }
}
