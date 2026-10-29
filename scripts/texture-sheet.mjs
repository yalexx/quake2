#!/usr/bin/env node
// scripts/texture-sheet.mjs -- contact sheets for the 4x texture set.
//
//   node scripts/texture-sheet.mjs                 # every group plus the luminance sheet
//   node scripts/texture-sheet.mjs --only e1u1     # one group (substring match)
//   node scripts/texture-sheet.mjs --detail --only wgrate1   # one texture, cells at native size
//   node scripts/texture-sheet.mjs --out <dir> --cell 160 --rows 12
//
// Why it exists
//
// scripts/hires-art.mjs draws a 4x picture for every wall texture the demo had
// art for, and its gates say those pictures still say what the demo's pixels
// said. Gates do not say whether the set looks right: whether a grate still
// reads as a grate, whether a sign is blurry, whether one texture came out much
// darker than its neighbours, whether the new art tears at the wrap seam. That
// is a question about pictures side by side, so this tool puts every texture on
// a page beside the three things it has to be judged against:
//
//   cell 1  the demo's own WAL pixels from the pristine archive, nearest x4
//   cell 2  the art the archive shipped before this work (git show <rev>:<png>),
//           nearest x4 -- the "no prior art" cell for frames the archive never
//           held a replacement for
//   cell 3  the new 4x art, as it sits on disk
//   cell 4  the new art tiled 2x2 at half scale, so the wrap seam sits in the
//           middle of the cell where a tear cannot hide
//   cell 5  the new art box-downsampled to 1x and scaled back x4 nearest -- the
//           picture the engine's mip chain starts from, i.e. what is seen at
//           in-game distance
//
// A page holds at most 24 textures (12 by default, so the cells stay large
// enough to read); each row is labelled with its number in the page, its name
// and its class. Pages are written to docs/texture-review/sheets/<group>-NN.png.
//
// set-luminance.png puts every texture's mean colour on one page, grouped and
// sorted by luminance: the top half of each tile is the demo original's mean
// colour, the bottom half the new art's, and a red border marks a texture whose
// mean luminance moved more than 1.5 levels or whose mean hue moved more than
// 10 degrees. That is what spots an outlier -- a texture that is suddenly
// brighter or a different colour than the set around it.
//
// It draws nothing itself and changes no art: the input is the pristine archive
// (loadPristine), the tree's PNGs (decodePngRgb) and the git blob of the prior
// art. Everything it writes lives under docs/texture-review/.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { DEFAULT_MANIFEST, PROJECT_ROOT, TextureError, decodePng, readManifest } from "./texture-lib.mjs";
import {
  SCALE,
  boxDownsample4,
  recipeFor,
  decodePngRgb,
  encodePngRgb,
  luminance,
  loadPristine,
  rgbaToRgb,
  textureTargets,
} from "./hires-art.mjs";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export const GROUPS = ["e1u1", "e1u2", "e1u3", "e2u1", "e2u2"];
export const DEFAULT_OUT = path.join(PROJECT_ROOT, "docs", "texture-review", "sheets");
// The commit whose PNGs are "the art shipped before this work".
export const DEFAULT_PRIOR = "ee00012";
export const MAX_PER_PAGE = 24;
const DEFAULTS = { cell: 160, rows: 12, pad: 12, gap: 6, rowGap: 8, labelWidth: 300 };

const COLORS = {
  background: [18, 18, 22],
  cell: [32, 32, 38],
  border: [72, 72, 82],
  text: [232, 232, 236],
  dim: [150, 150, 162],
  number: [255, 216, 112],
  accent: [120, 196, 255],
  missing: [58, 30, 30],
  flag: [228, 64, 64],
  white: [255, 255, 255],
  black: [0, 0, 0],
};

// ---------------------------------------------------------------------------
// 5x7 bitmap font -- enough for texture names, class names and page headers.
// ---------------------------------------------------------------------------

const GLYPH_SOURCE = {
  " ": "00000/00000/00000/00000/00000/00000/00000",
  A: "01110/10001/10001/11111/10001/10001/10001",
  B: "11110/10001/10001/11110/10001/10001/11110",
  C: "01110/10001/10000/10000/10000/10001/01110",
  D: "11110/10001/10001/10001/10001/10001/11110",
  E: "11111/10000/10000/11110/10000/10000/11111",
  F: "11111/10000/10000/11110/10000/10000/10000",
  G: "01110/10001/10000/10111/10001/10001/01111",
  H: "10001/10001/10001/11111/10001/10001/10001",
  I: "01110/00100/00100/00100/00100/00100/01110",
  J: "00111/00010/00010/00010/00010/10010/01100",
  K: "10001/10010/10100/11000/10100/10010/10001",
  L: "10000/10000/10000/10000/10000/10000/11111",
  M: "10001/11011/10101/10101/10001/10001/10001",
  N: "10001/11001/10101/10011/10001/10001/10001",
  O: "01110/10001/10001/10001/10001/10001/01110",
  P: "11110/10001/10001/11110/10000/10000/10000",
  Q: "01110/10001/10001/10001/10101/10010/01101",
  R: "11110/10001/10001/11110/10100/10010/10001",
  S: "01111/10000/10000/01110/00001/00001/11110",
  T: "11111/00100/00100/00100/00100/00100/00100",
  U: "10001/10001/10001/10001/10001/10001/01110",
  V: "10001/10001/10001/10001/10001/01010/00100",
  W: "10001/10001/10001/10101/10101/11011/10001",
  X: "10001/10001/01010/00100/01010/10001/10001",
  Y: "10001/10001/01010/00100/00100/00100/00100",
  Z: "11111/00001/00010/00100/01000/10000/11111",
  "0": "01110/10001/10011/10101/11001/10001/01110",
  "1": "00100/01100/00100/00100/00100/00100/01110",
  "2": "01110/10001/00001/00010/00100/01000/11111",
  "3": "11111/00010/00100/00010/00001/10001/01110",
  "4": "00010/00110/01010/10010/11111/00010/00010",
  "5": "11111/10000/11110/00001/00001/10001/01110",
  "6": "00110/01000/10000/11110/10001/10001/01110",
  "7": "11111/00001/00010/00100/01000/01000/01000",
  "8": "01110/10001/10001/01110/10001/10001/01110",
  "9": "01110/10001/10001/01111/00001/00010/01100",
  ".": "00000/00000/00000/00000/00000/01100/01100",
  ",": "00000/00000/00000/00000/01100/01100/01000",
  "/": "00001/00010/00010/00100/01000/01000/10000",
  "_": "00000/00000/00000/00000/00000/00000/11111",
  "+": "00000/00100/00100/11111/00100/00100/00000",
  "-": "00000/00000/00000/11111/00000/00000/00000",
  ":": "00000/01100/01100/00000/01100/01100/00000",
  ";": "00000/01100/01100/00000/01100/01100/01000",
  "%": "11001/11010/00010/00100/01000/01011/10011",
  "#": "01010/01010/11111/01010/11111/01010/01010",
  "(": "00010/00100/01000/01000/01000/00100/00010",
  ")": "01000/00100/00010/00010/00010/00100/01000",
  "=": "00000/00000/11111/00000/11111/00000/00000",
  "*": "00000/00100/10101/01110/10101/00100/00000",
  "'": "00100/00100/00000/00000/00000/00000/00000",
  "!": "00100/00100/00100/00100/00100/00000/00100",
  "?": "01110/10001/00001/00010/00100/00000/00100",
  "<": "00010/00100/01000/10000/01000/00100/00010",
  ">": "01000/00100/00010/00001/00010/00100/01000",
  "|": "00100/00100/00100/00100/00100/00100/00100",
  "[": "01110/01000/01000/01000/01000/01000/01110",
  "]": "01110/00010/00010/00010/00010/00010/01110",
  "&": "01100/10010/10100/01000/10101/10010/01101",
  "\"": "01010/01010/00000/00000/00000/00000/00000",
  "×": "00000/10001/01010/00100/01010/10001/00000", // multiplication sign
  "°": "01100/10010/01100/00000/00000/00000/00000", // degree sign
  "→": "00100/00010/11111/00010/00100/00000/00000", // right arrow
};

const GLYPHS = Object.fromEntries(
  Object.entries(GLYPH_SOURCE).map(([character, rows]) => [character, rows.split("/")])
);

const GLYPH_WIDTH = 5;
const GLYPH_HEIGHT = 7;
const GLYPH_ADVANCE = GLYPH_WIDTH + 1;

export function textWidth(text, scale) {
  return text.length * GLYPH_ADVANCE * scale - scale;
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

export function newImage(width, height, color = COLORS.black) {
  const rgb = new Uint8Array(width * height * 3);
  for (let pixel = 0; pixel < width * height; pixel++) {
    rgb[pixel * 3] = color[0];
    rgb[pixel * 3 + 1] = color[1];
    rgb[pixel * 3 + 2] = color[2];
  }
  return { width, height, rgb };
}

export function fillRect(image, x, y, width, height, color) {
  const x0 = Math.max(0, Math.round(x));
  const y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(image.width, Math.round(x + width));
  const y1 = Math.min(image.height, Math.round(y + height));
  for (let row = y0; row < y1; row++) {
    let at = (row * image.width + x0) * 3;
    for (let column = x0; column < x1; column++) {
      image.rgb[at] = color[0];
      image.rgb[at + 1] = color[1];
      image.rgb[at + 2] = color[2];
      at += 3;
    }
  }
}

export function strokeRect(image, x, y, width, height, color) {
  fillRect(image, x, y, width, 1, color);
  fillRect(image, x, y + height - 1, width, 1, color);
  fillRect(image, x, y, 1, height, color);
  fillRect(image, x + width - 1, y, 1, height, color);
}

// Copy src onto dst at (dx, dy), clipped to dst. No scaling.
export function blitImage(dst, src, dx, dy) {
  const x0 = Math.max(0, dx);
  const y0 = Math.max(0, dy);
  const x1 = Math.min(dst.width, dx + src.width);
  const y1 = Math.min(dst.height, dy + src.height);
  for (let y = y0; y < y1; y++) {
    let source = ((y - dy) * src.width + (x0 - dx)) * 3;
    let target = (y * dst.width + x0) * 3;
    for (let x = x0; x < x1; x++) {
      dst.rgb[target] = src.rgb[source];
      dst.rgb[target + 1] = src.rgb[source + 1];
      dst.rgb[target + 2] = src.rgb[source + 2];
      source += 3;
      target += 3;
    }
  }
}

export function drawText(image, x, y, text, scale, color) {
  let cursor = Math.round(x);
  y = Math.round(y);
  for (const character of text) {
    const glyph = GLYPHS[character.toUpperCase()] ?? GLYPHS["?"];
    for (let row = 0; row < GLYPH_HEIGHT; row++) {
      for (let column = 0; column < GLYPH_WIDTH; column++) {
        if (glyph[row][column] === "1") fillRect(image, cursor + column * scale, y + row * scale, scale, scale, color);
      }
    }
    cursor += GLYPH_ADVANCE * scale;
  }
  return cursor;
}

// Point-sampled enlargement (what the cells 1, 2 and 5 are described as).
export function nearestResize(image, outWidth, outHeight) {
  const out = { width: outWidth, height: outHeight, rgb: new Uint8Array(outWidth * outHeight * 3) };
  for (let y = 0; y < outHeight; y++) {
    const sourceY = Math.min(image.height - 1, Math.floor((y * image.height) / outHeight));
    for (let x = 0; x < outWidth; x++) {
      const sourceX = Math.min(image.width - 1, Math.floor((x * image.width) / outWidth));
      const from = (sourceY * image.width + sourceX) * 3;
      const to = (y * outWidth + x) * 3;
      out.rgb[to] = image.rgb[from];
      out.rgb[to + 1] = image.rgb[from + 1];
      out.rgb[to + 2] = image.rgb[from + 2];
    }
  }
  return out;
}

// Area (box) resample, used only to shrink a cell to the page's cell box. It is
// the same operation the engine's mip chain starts with, so what the page shows
// at reduced size is what a mip of the art looks like, not aliasing.
export function areaResize(image, outWidth, outHeight) {
  const xCoverage = coverageList(image.width, outWidth);
  const yCoverage = coverageList(image.height, outHeight);
  const row = new Float32Array(outWidth * 3);
  const out = { width: outWidth, height: outHeight, rgb: new Uint8Array(outWidth * outHeight * 3) };
  for (let y = 0; y < outHeight; y++) {
    row.fill(0);
    let total = 0;
    for (const [sourceY, weightY] of yCoverage[y]) {
      for (let x = 0; x < outWidth; x++) {
        const weights = xCoverage[x];
        let r = 0;
        let g = 0;
        let b = 0;
        for (const [sourceX, weightX] of weights) {
          const at = (sourceY * image.width + sourceX) * 3;
          const w = weightX * weightY;
          r += image.rgb[at] * w;
          g += image.rgb[at + 1] * w;
          b += image.rgb[at + 2] * w;
        }
        row[x * 3] += r;
        row[x * 3 + 1] += g;
        row[x * 3 + 2] += b;
      }
      total += weightY;
    }
    // total is the area of one output pixel in source pixels (constant here);
    // xCoverage weights already sum to the horizontal extent.
    const horizontal = (image.width / outWidth) * (image.height / outHeight);
    for (let x = 0; x < outWidth; x++) {
      const at = (y * outWidth + x) * 3;
      out.rgb[at] = clampByte(row[x * 3] / horizontal);
      out.rgb[at + 1] = clampByte(row[x * 3 + 1] / horizontal);
      out.rgb[at + 2] = clampByte(row[x * 3 + 2] / horizontal);
    }
  }
  return out;
}

function coverageList(inputSize, outputSize) {
  const scale = inputSize / outputSize;
  const list = [];
  for (let out = 0; out < outputSize; out++) {
    const start = out * scale;
    const end = (out + 1) * scale;
    const entries = [];
    for (let index = Math.floor(start); index < Math.ceil(end); index++) {
      const low = Math.max(start, index);
      const high = Math.min(end, index + 1);
      if (high > low) entries.push([index, high - low]);
    }
    list.push(entries);
  }
  return list;
}

function clampByte(value) {
  if (value <= 0) return 0;
  if (value >= 255) return 255;
  return Math.round(value);
}

// Fit an image inside a cell box without distorting it: enlarge point-sampled,
// shrink with the box filter, leave it alone when it already fits.
export function scaleToBox(image, boxWidth, boxHeight, options = {}) {
  if (!options.fill && image.width <= boxWidth && image.height <= boxHeight) return image;
  const scale = Math.min(boxWidth / image.width, boxHeight / image.height);
  const width = Math.max(1, Math.floor(image.width * scale));
  const height = Math.max(1, Math.floor(image.height * scale));
  if (width >= image.width && height >= image.height) return nearestResize(image, width, height);
  return areaResize(image, width, height);
}

// The 2x2 tile of the art at half scale: the wrap seam lands on the middle
// cross of the cell, both axes, at a size where a tear is obvious.
export function tileHalf(image) {
  if (image.width % 2 !== 0 || image.height % 2 !== 0) {
    throw new TextureError("tileHalf needs even dimensions, got " + image.width + "x" + image.height, "BAD_IMAGE");
  }
  const halfWidth = image.width / 2;
  const halfHeight = image.height / 2;
  const half = areaResize(image, halfWidth, halfHeight);
  const out = { width: image.width, height: image.height, rgb: new Uint8Array(image.width * image.height * 3) };
  for (let ty = 0; ty < 2; ty++) {
    for (let tx = 0; tx < 2; tx++) blitImage(out, half, tx * halfWidth, ty * halfHeight);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Prior art (git show <rev>:<png>)
// ---------------------------------------------------------------------------

export function loadPriorArt(pngPath, revision = DEFAULT_PRIOR) {
  try {
    const buffer = execFileSync("git", ["-C", PROJECT_ROOT, "show", revision + ":" + pngPath], {
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return rgbaToRgb(decodePng(buffer));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// One texture's five cells
// ---------------------------------------------------------------------------

// options.prior is the pre-work art for this PNG, or null when the archive
// never held a replacement for it.
export function buildCells(original, art, options = {}) {
  const scale = options.scale ?? SCALE;
  const seeded = nearestResize(original, original.width * scale, original.height * scale);
  const prior = options.prior ? nearestResize(options.prior, art.width, art.height) : null;
  const mip = nearestResize(boxDownsample4(art), art.width, art.height);
  return [seeded, prior, art, tileHalf(art), mip].map((image) =>
    image ? scaleToBox(image, options.box, options.box, { fill: options.fill }) : null
  );
}

// ---------------------------------------------------------------------------
// A page
// ---------------------------------------------------------------------------

const COLUMN_LABELS = ["1 demo x4", "2 prior art x4", "3 new 4x", "4 tiled 2x2", "5 mip 1x-x4"];

// rows: [{ number, name, textureClass, source, cells: [image|null x5] }]
export function renderPage(title, subtitle, rows, options = {}) {
  const cell = options.cell ?? DEFAULTS.cell;
  const pad = DEFAULTS.pad;
  const gap = DEFAULTS.gap;
  const rowGap = DEFAULTS.rowGap;
  const labelWidth = DEFAULTS.labelWidth;
  const columns = 5;

  const headerHeight = 62;
  const width = pad * 2 + labelWidth + columns * cell + (columns - 1) * gap;
  const height = headerHeight + rows.length * (cell + rowGap) + pad;
  const image = newImage(width, height, COLORS.background);

  drawText(image, pad, pad, title, 2, COLORS.accent);
  drawText(image, pad, pad + 22, subtitle, 1, COLORS.dim);

  const cellsLeft = pad + labelWidth;
  for (let column = 0; column < columns; column++) {
    const x = cellsLeft + column * (cell + gap);
    drawText(image, x + 2, headerHeight - 12, COLUMN_LABELS[column], 1, COLORS.dim);
  }

  let y = headerHeight;
  for (const row of rows) {
    for (let column = 0; column < columns; column++) {
      const x = cellsLeft + column * (cell + gap);
      fillRect(image, x, y, cell, cell, COLORS.cell);
      strokeRect(image, x, y, cell, cell, COLORS.border);
      const picture = row.cells[column];
      if (picture) {
        blitImage(image, picture, x + Math.floor((cell - picture.width) / 2), y + Math.floor((cell - picture.height) / 2));
      } else {
        fillRect(image, x + 1, y + 1, cell - 2, cell - 2, COLORS.missing);
        const text = "NO PRIOR ART";
        drawText(image, x + Math.floor((cell - textWidth(text, 1)) / 2), y + Math.floor((cell - GLYPH_HEIGHT) / 2), text, 1, COLORS.dim);
      }
    }

    // Label: a big row number, then the name and its class/size. The number is
    // what a reader (or the vision model reviewing the page) can point at.
    const numberText = String(row.number).padStart(2, "0");
    drawText(image, pad, y + 2, numberText, 3, COLORS.number);
    const nameX = pad + textWidth(numberText, 3) + 10;
    const room = labelWidth - (nameX - pad) - 4;
    let nameScale = 2;
    while (nameScale > 1 && textWidth(row.name, nameScale) > room) nameScale--;
    drawText(image, nameX, y + 4, row.name, nameScale, COLORS.text);
    drawText(image, pad, y + 34, row.textureClass + "  " + row.source, 1, COLORS.dim);

    y += cell + rowGap;
  }
  return image;
}

// ---------------------------------------------------------------------------
// Lighting statistics (for the luminance sheet and the review text)
// ---------------------------------------------------------------------------

export function meanRgb(image) {
  let r = 0;
  let g = 0;
  let b = 0;
  const count = image.width * image.height;
  for (let pixel = 0; pixel < count; pixel++) {
    r += image.rgb[pixel * 3];
    g += image.rgb[pixel * 3 + 1];
    b += image.rgb[pixel * 3 + 2];
  }
  return [r / count, g / count, b / count];
}

// Hue in degrees and saturation 0..1 from a mean colour. A near-grey has no
// meaningful hue, so the caller compares hues only when both saturations count.
export function hueSaturation([r, g, b]) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const high = Math.max(red, green, blue);
  const low = Math.min(red, green, blue);
  const delta = high - low;
  let hue = 0;
  if (delta > 0) {
    if (high === red) hue = 60 * (((green - blue) / delta) % 6);
    else if (high === green) hue = 60 * ((blue - red) / delta + 2);
    else hue = 60 * ((red - green) / delta + 4);
  }
  if (hue < 0) hue += 360;
  const saturation = high === 0 ? 0 : delta / high;
  return { hue, saturation };
}

export function hueDistance(left, right) {
  const difference = Math.abs(left - right) % 360;
  return difference > 180 ? 360 - difference : difference;
}

// ---------------------------------------------------------------------------
// The luminance sheet
// ---------------------------------------------------------------------------

// groups: [{ name, items: [{ name, originalMean, artMean, luminanceShift, hueShift, flagged }] }]
export function renderLuminanceSheet(groups, options = {}) {
  const pad = DEFAULTS.pad;
  const tileWidth = 24;
  const tileHeight = 30;
  const tileGap = 8;
  const rowHeight = tileHeight + tileGap + 6;
  const width = pad * 2 + 36 * (tileWidth + tileGap / 2);
  const totalRows = groups.reduce((sum, group) => sum + Math.ceil(group.items.length / 36), 0);

  const headerHeight = 76;
  const height = headerHeight + groups.length * 22 + totalRows * rowHeight + pad;
  const image = newImage(width, height, COLORS.background);

  drawText(image, pad, pad, "MEAN COLOUR PER TEXTURE, GROUPED AND SORTED BY LUMINANCE", 2, COLORS.accent);
  drawText(image, pad, pad + 22, "TOP HALF: DEMO ORIGINAL'S MEAN COLOUR.  BOTTOM HALF: THE NEW 4X ART'S.", 1, COLORS.dim);
  drawText(image, pad, pad + 36, "SORTED BY THE NEW ART'S LUMINANCE, SO AN OUT-OF-ORDER TILE IS A SHIFT.", 1, COLORS.dim);
  drawText(image, pad, pad + 50, "RED BORDER: LUMINANCE SHIFT > 1.5, OR HUE SHIFT > 10 DEGREES WITH SATURATION ON BOTH SIDES.", 1, COLORS.dim);

  let y = headerHeight;
  for (const group of groups) {
    drawText(image, pad, y + 4, group.name + "  (" + group.items.length + ")", 2, COLORS.text);
    y += 22;
    let x = pad;
    let rowTop = y;
    for (const item of group.items) {
      if (x + tileWidth > width - pad) {
        x = pad;
        rowTop += rowHeight;
      }
      if (item.flagged) fillRect(image, x - 2, rowTop - 2, tileWidth + 4, tileHeight + 4, COLORS.flag);
      else fillRect(image, x - 2, rowTop - 2, tileWidth + 4, tileHeight + 4, COLORS.border);
      fillRect(image, x, rowTop, tileWidth, 14, item.originalMean.map(Math.round));
      fillRect(image, x, rowTop + 15, tileWidth, 15, item.artMean.map(Math.round));
      x += tileWidth + tileGap;
    }
    y = rowTop + rowHeight;
  }
  return image;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const USAGE = `texture-sheet.mjs -- contact sheets for the 4x texture set

  --out <dir>        where the pages go (default docs/texture-review/sheets)
  --cell <px>        cell box in pixels (default ${DEFAULTS.cell})
  --rows <n>         rows per page, at most ${MAX_PER_PAGE} (default ${DEFAULTS.rows})
  --only <text>      only entries whose name contains <text> (repeatable)
  --prior <rev>      git revision holding the art shipped before this work (default ${DEFAULT_PRIOR})
  --detail           one page per matching texture, cells at native art size
  --luminance-only   write only set-luminance.png
  --quiet            no per-page lines
  --help             this text
`;

function relative(file) {
  return path.relative(PROJECT_ROOT, file).split(path.sep).join("/") || ".";
}

function parseArguments(argv) {
  const options = {
    out: DEFAULT_OUT,
    cell: DEFAULTS.cell,
    cellGiven: false,
    rows: DEFAULTS.rows,
    only: [],
    prior: DEFAULT_PRIOR,
    detail: false,
    luminanceOnly: false,
    quiet: false,
    help: false,
  };
  const takesValue = new Set(["--out", "--cell", "--rows", "--only", "--prior"]);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--detail") options.detail = true;
    else if (argument === "--luminance-only") options.luminanceOnly = true;
    else if (argument === "--quiet") options.quiet = true;
    else {
      const split = argument.indexOf("=");
      const flag = split === -1 ? argument : argument.slice(0, split);
      if (!takesValue.has(flag)) throw new TextureError("unknown option " + argument + "\n\n" + USAGE, "BAD_ARGUMENT");
      const value = split === -1 ? argv[++index] : argument.slice(split + 1);
      if (value === undefined || (split === -1 && value.startsWith("--"))) throw new TextureError(flag + " needs a value", "BAD_ARGUMENT");
      if (flag === "--only") options.only.push(value.toLowerCase());
      else if (flag === "--out") options.out = path.resolve(value);
      else if (flag === "--prior") options.prior = value;
      else if (flag === "--cell") {
        options.cell = Math.max(32, Number.parseInt(value, 10) || DEFAULTS.cell);
        options.cellGiven = true;
      }
      else if (flag === "--rows") options.rows = Math.min(MAX_PER_PAGE, Math.max(1, Number.parseInt(value, 10) || DEFAULTS.rows));
    }
  }
  return options;
}

function groupOf(name) {
  const match = /^textures\/([^/]+)\//.exec(name);
  return match ? match[1] : "other";
}

function baseName(name) {
  return name.slice(name.lastIndexOf("/") + 1).replace(/\.wal$/, "");
}

// Build the record for one manifest entry: the demo's pixels, the art on disk,
// the art from before this work, and the numbers the luminance sheet needs.
function loadEntry(entry, pristine, options) {
  const original = pristine.readWal(entry.name);
  const pngFile = path.resolve(PROJECT_ROOT, entry.png);
  if (!fs.existsSync(pngFile)) throw new TextureError("no art on disk for " + entry.name + " (" + entry.png + ")", "NO_ART");
  const art = decodePngRgb(pngFile);
  if (art.width !== original.width * SCALE || art.height !== original.height * SCALE) {
    throw new TextureError(
      entry.name + ": art is " + art.width + "x" + art.height + ", expected " + original.width * SCALE + "x" + original.height * SCALE,
      "BAD_SIZE"
    );
  }
  const prior = loadPriorArt(entry.png, options.prior);
  if (prior && (prior.width !== original.width || prior.height !== original.height)) {
    throw new TextureError(entry.name + ": prior art is " + prior.width + "x" + prior.height + ", expected " + original.width + "x" + original.height, "BAD_SIZE");
  }
  const originalMean = meanRgb(original);
  const artMean = meanRgb(art);
  const originalLight = hueSaturation(originalMean);
  const artLight = hueSaturation(artMean);
  const luminanceShift = luminance(...artMean) - luminance(...originalMean);
  const hueShift = hueDistance(originalLight.hue, artLight.hue);
  const hueCounts = originalLight.saturation >= 0.12 && artLight.saturation >= 0.12;
  return {
    entry,
    name: entry.name,
    group: groupOf(entry.name),
    textureClass: recipeFor(entry, original).textureClass,
    source: original.width + "x" + original.height,
    original,
    art,
    prior,
    originalMean,
    artMean,
    luminanceShift,
    hueShift,
    flagged: Math.abs(luminanceShift) > 1.5 || (hueCounts && hueShift > 10),
  };
}

function drawSheets(records, options, written) {
  const byGroup = new Map();
  for (const record of records) {
    if (!byGroup.has(record.group)) byGroup.set(record.group, []);
    byGroup.get(record.group).push(record);
  }
  const groups = [...byGroup.keys()].sort((left, right) => {
    const leftIndex = GROUPS.indexOf(left);
    const rightIndex = GROUPS.indexOf(right);
    return (leftIndex === -1 ? 99 : leftIndex) - (rightIndex === -1 ? 99 : rightIndex) || left.localeCompare(right);
  });

  const pages = [];
  for (const group of groups) {
    const list = byGroup.get(group).sort((left, right) => left.name.localeCompare(right.name));
    const perPage = options.detail ? 1 : options.rows;
    const pagesInGroup = Math.max(1, Math.ceil(list.length / perPage));
    for (let page = 0; page < pagesInGroup; page++) {
      const chunk = list.slice(page * perPage, (page + 1) * perPage);
      if (!chunk.length) continue;
      const detailBox = options.cellGiven
        ? options.cell
        : Math.max(...chunk.map((record) => Math.max(record.art.width, record.art.height)));
      const cell = options.detail ? detailBox : options.cell;
      const rows = chunk.map((record, index) => ({
        number: index + 1,
        name: record.group + "/" + baseName(record.name) + ".wal",
        textureClass: record.textureClass,
        source: record.source,
        cells: buildCells(record.original, record.art, {
          prior: record.prior,
          // A detail page shows the cells at their own size: nothing is
          // resampled for display, which is what a close look needs.
          box: cell,
          // A detail page magnifies to the cell box so a small texture can be
          // judged at a size where an edge or a halo is visible.
          fill: options.detail,
        }),
      }));
      const title = options.detail
        ? "TEXTURE REVIEW -- " + chunk[0].group + "/" + baseName(chunk[0].name)
        : "TEXTURE REVIEW -- " + group + " -- PAGE " + (page + 1) + " OF " + pagesInGroup;
      const subtitle = options.detail
        ? "CELLS AT NATIVE 4X SIZE: DEMO, PRIOR ART, NEW 4X, TILED 2X2 AT HALF SCALE, IN-GAME MIP"
        : chunk.length + " of " + list.length + " textures in " + group + ".  ONE LABELLED ROW EACH.";
      const image = renderPage(title, subtitle, rows, { ...options, cell });
      pages.push({ file: path.join(options.out, options.detail ? "detail-" + baseName(chunk[0].name) + ".png" : group + "-" + String(page + 1).padStart(2, "0") + ".png"), image, count: chunk.length });
    }
  }
  for (const page of pages) {
    fs.mkdirSync(path.dirname(page.file), { recursive: true });
    fs.writeFileSync(page.file, encodePngRgb(page.image.width, page.image.height, page.image.rgb));
    written.push(page.file);
    if (!options.quiet) process.stdout.write("sheet " + relative(page.file) + "  " + page.image.width + "x" + page.image.height + "  " + page.count + " textures\n");
  }
  return groups;
}

function writeLuminanceSheet(records, options, written) {
  const groups = [];
  for (const group of GROUPS) {
    const list = records.filter((record) => record.group === group).sort((left, right) => luminance(...left.artMean) - luminance(...right.artMean));
    if (list.length) groups.push({ name: group, items: list });
  }
  const other = records.filter((record) => !GROUPS.includes(record.group));
  if (other.length) groups.push({ name: "other", items: other.sort((left, right) => luminance(...left.artMean) - luminance(...right.artMean)) });
  const image = renderLuminanceSheet(groups);
  const file = path.join(options.out, "set-luminance.png");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encodePngRgb(image.width, image.height, image.rgb));
  written.push(file);
  if (!options.quiet) process.stdout.write("sheet " + relative(file) + "  " + image.width + "x" + image.height + "  " + records.length + " textures\n");
  return groups;
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
  const records = targets.map((entry) => loadEntry(entry, pristine, options));
  const written = [];
  if (!options.luminanceOnly) drawSheets(records, options, written);
  writeLuminanceSheet(records, options, written);

  const flagged = records.filter((record) => record.flagged);
  if (flagged.length) {
    process.stdout.write("\nluminance/hue outliers (" + flagged.length + "):\n");
    for (const record of flagged) {
      process.stdout.write(
        "  " + record.name.padEnd(34) + " luma " + (record.luminanceShift >= 0 ? "+" : "") + record.luminanceShift.toFixed(2) +
          "  hue " + record.hueShift.toFixed(1) + "°\n"
      );
    }
  } else {
    process.stdout.write("\nno luminance or hue outliers\n");
  }
  process.stdout.write("wrote " + written.length + " sheets under " + relative(options.out) + "\n");
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write((error instanceof TextureError ? error.message : error && error.stack ? error.stack : String(error)) + "\n");
    process.exitCode = 2;
  }
}
