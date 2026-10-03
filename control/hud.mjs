// control/hud.mjs -- reading the numbers the engine will not say out loud.
//
// Quake 2 draws health, armour and ammo on the status bar and prints them
// nowhere: there is no console command for them and this build exports no cvar
// or command accessor (see "Reading the game's state" in README.md), so
// position() cannot answer "how much health is left". That is the one reading a
// fight report cannot do without -- "the fight got better" is unfalsifiable
// against a corpse -- and this module is how it is taken.
//
// Two facts make it possible, and both were measured on this box rather than
// assumed.
//
// 1. The HUD is drawn at a fixed pixel size in the canvas's own coordinates.
//    Quake 2's status bar does not scale with resolution: `pics/num_0.pcx` is
//    16x24 and it is drawn 16x24 however big the canvas is. On this box the
//    canvas is 1366x768 and the digit row sits in its bottom 24 rows, so the
//    numbers are *small* compared with the picture around them.
// 2. A whole-page screenshot is smaller than the canvas. The canvas is 1366
//    wide and its CSS box -- what CDP's Page.captureScreenshot sees -- is 837,
//    so a plain screenshot has already thrown away 39% of the HUD's pixels
//    before anything can read them. Measured: at that size the ring of a "0"
//    and the bowl of a "6" are the same blur, and a matcher against the level's
//    own digits scores every digit nearly the same. A screenshot taken while
//    the canvas is displayed at its own size (see `hudShot`) is 1:1 with what
//    the engine drew, and the same matcher separates "100" cleanly.
//
// The digits themselves come from the level archive: `pics/num_*.pcx` are the
// pictures the engine blits for a number, and `pics/anum_*.pcx` the ones it
// blits for armour. They are 8-bit paletted, index 255 is transparent, and the
// *most common remaining index* is the picture's own background -- which is
// what the glyph is not. (Getting that wrong is not a small error: taking index
// 127 for part of the glyph turns every digit into the same solid rectangle,
// which is exactly what a matcher that "reads" 100 for every screenshot would
// be doing.)
//
// Reading is done by normalised cross-correlation, not by thresholding. The
// status bar sits on top of the level, and its background is a lit texture, so
// "bright pixel" is not the same as "glyph pixel" -- measured on this box, the
// glyph strokes and the wall behind them overlap in luminance. Correlation
// against the glyph's own shape does not care what the background is doing.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { readPakFile } from "./route.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Where the level archive is, relative to this module. The same pak route.mjs
// plans from, so a caller that can plan a route can read the HUD.
export const DEFAULT_PAK = path.join(HERE, "..", "baseq2", "pak0.pak");

// The engine blits a number as one picture per digit, 16x24 each, side by side
// with no gap. The whole of the HUD's arithmetic is in these two constants.
export const GLYPH_WIDTH = 16;
export const GLYPH_HEIGHT = 24;

// How many of the canvas's bottom rows are worth capturing. The digit row is
// the bottom 24; the rest is headroom for a status bar drawn a few pixels
// higher, and for reading the icons that sit beside the numbers.
const HUD_BAND = 40;

// ---------------------------------------------------------------------------
// PNG decoding
// ---------------------------------------------------------------------------

// A minimal PNG reader: 8-bit, non-interlaced, colour types 0, 2 and 6 --
// everything CDP's Page.captureScreenshot emits. Returns RGBA.
export function decodePng(buffer) {
  if (buffer.length < 8 || buffer.readUInt32BE(0) !== 0x89504e47) {
    throw new Error("not a PNG");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const parts = [];
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("latin1", offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("interlaced PNG is not supported");
    } else if (type === "IDAT") {
      parts.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 0 ? 1 : 0;
  if (!channels || bitDepth !== 8) {
    throw new Error("unsupported PNG (colour type " + colorType + ", depth " + bitDepth + ")");
  }
  const raw = zlib.inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let previous = Buffer.alloc(stride);
  let at = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[at++];
    const line = raw.subarray(at, at + stride);
    at += stride;
    const row = Buffer.alloc(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = previous[i];
      const c = i >= channels ? previous[i - channels] : 0;
      const x = line[i];
      let value;
      switch (filter) {
        case 0: value = x; break;
        case 1: value = x + a; break;
        case 2: value = x + b; break;
        case 3: value = x + ((a + b) >> 1); break;
        case 4: {
          const pa = Math.abs(b - c);
          const pb = Math.abs(a - c);
          const pc = Math.abs(a + b - 2 * c);
          value = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
          break;
        }
        default: throw new Error("unknown PNG filter " + filter);
      }
      row[i] = value & 255;
    }
    row.copy(out, y * stride);
    previous = row;
  }
  const rgba = Buffer.alloc(width * height * 4);
  for (let pixel = 0; pixel < width * height; pixel++) {
    const source = pixel * channels;
    const target = pixel * 4;
    const r = out[source];
    const g = channels >= 3 ? out[source + 1] : out[source];
    const b = channels >= 3 ? out[source + 2] : out[source];
    rgba[target] = r;
    rgba[target + 1] = g;
    rgba[target + 2] = b;
    rgba[target + 3] = channels === 4 ? out[source + 3] : 255;
  }
  return { width, height, data: rgba };
}

// The luminance plane, which is what every glyph here is read from. Quake 2's
// HUD numbers are grey, so the colour channels carry nothing the luminance
// does not.
export function luminance(image) {
  const { width, height, data } = image;
  const out = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const j = i * 4;
    out[i] = data[j] * 0.3 + data[j + 1] * 0.59 + data[j + 2] * 0.11;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The engine's own digits
// ---------------------------------------------------------------------------

// An 8-bit single-plane PCX, which is what every `pics/*.pcx` in the archive
// is. RLE, with runs marked by the top two bits of the length byte.
function decodePcx(buffer) {
  const xmax = buffer.readUInt16LE(8);
  const ymax = buffer.readUInt16LE(10);
  const planes = buffer[65];
  const width = xmax + 1;
  const height = ymax + 1;
  const total = width * height * planes;
  const pixels = Buffer.alloc(total);
  let at = 128;
  let n = 0;
  while (n < total && at < buffer.length) {
    const byte = buffer[at++];
    if ((byte & 0xc0) === 0xc0) {
      const count = byte & 0x3f;
      const value = buffer[at++];
      for (let i = 0; i < count && n < total; i++) pixels[n++] = value;
    } else {
      pixels[n++] = byte;
    }
  }
  return { width, height, pixels };
}

// One glyph, as a coverage mask: 1 where the engine's picture has ink, 0 where
// it has background or transparency. See the note at the top of this file about
// which index "background" is -- it is the picture's own most common index, and
// getting it wrong makes every digit the same rectangle.
export function readGlyph(pakBuffer, name) {
  const image = decodePcx(readPakFile(pakBuffer, name));
  const histogram = new Map();
  for (const value of image.pixels) histogram.set(value, (histogram.get(value) || 0) + 1);
  let background = 0;
  let seen = -1;
  for (const [value, count] of histogram) {
    if (value === 255) continue;
    if (count > seen) { seen = count; background = value; }
  }
  const mask = new Uint8Array(image.width * image.height);
  for (let i = 0; i < mask.length; i++) {
    const value = image.pixels[i];
    mask[i] = value !== 255 && value !== background ? 1 : 0;
  }
  return { width: image.width, height: image.height, mask };
}

// The ten digits of each family the status bar uses: `num_*` for health and
// ammo, `anum_*` for armour. A caller may hand in a pak buffer; the default is
// the level archive beside this module.
export function loadDigits(pakBuffer = fs.readFileSync(DEFAULT_PAK)) {
  const families = {};
  for (const family of ["num", "anum"]) {
    const digits = [];
    for (let digit = 0; digit < 10; digit++) {
      digits.push(readGlyph(pakBuffer, "pics/" + family + "_" + digit + ".pcx"));
    }
    families[family] = digits;
  }
  return families;
}

// A glyph as the engine would blit it at `scale`: for every output pixel, how
// much of it is covered by ink. Supersampled, because at the sizes the HUD is
// actually read at a digit is about ten pixels wide and the difference between
// a stroke and its gap is a fraction of one of them.
function coverage(glyph, scale) {
  const width = Math.max(3, Math.round(glyph.width * scale));
  const height = Math.max(3, Math.round(glyph.height * scale));
  const pattern = new Float32Array(width * height);
  const samples = 5;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let ink = 0;
      for (let sy = 0; sy < samples; sy++) {
        for (let sx = 0; sx < samples; sx++) {
          const u = (x + (sx + 0.5) / samples) / scale;
          const v = (y + (sy + 0.5) / samples) / scale;
          const ix = Math.floor(u);
          const iy = Math.floor(v);
          if (ix >= 0 && iy >= 0 && ix < glyph.width && iy < glyph.height && glyph.mask[iy * glyph.width + ix]) ink++;
        }
      }
      pattern[y * width + x] = ink / (samples * samples);
    }
  }
  return { width, height, pattern };
}

// Normalised cross-correlation between a glyph's shape and the picture at
// (x0, y0): 1 is "exactly this digit", 0 is "nothing to do with it", negative
// is "the ink is where the glyph has gaps". Background-brightness cancels, so a
// number on a dark wall and the same number on a lit one read the same.
function correlate(template, lum, imageWidth, x0, y0) {
  const { width, height, pattern } = template;
  const n = width * height;
  let meanImage = 0;
  for (let y = 0; y < height; y++) {
    const row = (y0 + y) * imageWidth + x0;
    for (let x = 0; x < width; x++) meanImage += lum[row + x];
  }
  meanImage /= n;
  let meanShape = 0;
  for (let i = 0; i < n; i++) meanShape += 2 * pattern[i] - 1;
  meanShape /= n;
  let covariance = 0;
  let shapeVariance = 0;
  let imageVariance = 0;
  for (let y = 0; y < height; y++) {
    const row = (y0 + y) * imageWidth + x0;
    for (let x = 0; x < width; x++) {
      const ds = 2 * pattern[y * width + x] - 1 - meanShape;
      const di = lum[row + x] - meanImage;
      covariance += ds * di;
      shapeVariance += ds * ds;
      imageVariance += di * di;
    }
  }
  const denominator = Math.sqrt(shapeVariance * imageVariance);
  return denominator ? covariance / denominator : 0;
}

// The best digit for a cell, and how much better it is than the runner-up.
// The margin is the honest part of the answer: a "6" and an "8" can both score
// well against a smudged cell, and a reading whose best and second-best are
// within a hair of each other should not be reported as though it were sure.
function readCell(templates, lum, imageWidth, x0, y0) {
  let best = -2;
  let second = -2;
  let digit = -1;
  for (let d = 0; d < templates.length; d++) {
    const score = correlate(templates[d], lum, imageWidth, x0, y0);
    if (score > best) { second = best; best = score; digit = d; }
    else if (score > second) second = score;
  }
  return { digit, score: best, margin: best - second };
}

// ---------------------------------------------------------------------------
// Taking the picture
// ---------------------------------------------------------------------------

// A screenshot in which the canvas is shown at its own size, so the HUD's
// pixels survive. A plain `screenshot()` shows the canvas at 837 CSS pixels
// wide against a 1366-wide backing store, and the digits are blurred below the
// size at which their shapes differ (see the note at the top of this file).
//
// The canvas is displayed at its native size and slid up and to the left so
// that the strip of it which holds the status bar is what the viewport shows;
// `screenshot()` then captures that strip 1:1. The canvas's own style is put
// back afterwards, whatever happens, because the running game is not ours to
// leave rearranged -- the position of the status bar is only the *view* of it.
//
// The engine draws into the canvas's backing store and does not re-create it
// when the CSS box changes (measured: canvas.width stays 1366x768 across the
// move), so the picture on the other side of this is the same game, framed
// differently for the length of one screenshot.
export async function hudShot(game, options = {}) {
  const before = await game.evaluate("document.querySelector('canvas').getAttribute('style')");
  const geometry = await game.evaluate(`(() => {
    const canvas = document.querySelector('canvas');
    const width = canvas.width;
    const height = canvas.height;
    const band = ${options.band || HUD_BAND};
    // The status bar is centred on the canvas, so the health number sits at
    // about half the width; a window that starts a little left of centre is
    // enough to hold the whole of it whatever the level's own layout is.
    const left = Math.max(0, Math.round(width / 2 - ${options.offsetX || 360}));
    const top = Math.max(0, height - band);
    canvas.setAttribute('style', 'display:block;width:' + width + 'px;height:' + height + 'px;margin-left:-' + left + 'px;margin-top:-' + top + 'px;');
    const rect = canvas.getBoundingClientRect();
    return JSON.stringify({ width, height, left, top, shownLeft: rect.left, shownTop: rect.top, viewport: window.innerWidth });
  })()`);
  const box = typeof geometry === "string" ? JSON.parse(geometry) : geometry;
  // The style change is a layout change, and the compositor has to have drawn
  // a frame with it before the capture can see it. Without this the picture is
  // sometimes of the *previous* framing -- measured: two of three reads on a
  // live player came back with the status bar where the un-framed canvas puts
  // it, off the bottom of the strip, and no number in it.
  await new Promise((resolve) => setTimeout(resolve, options.settleMs === undefined ? 150 : options.settleMs));
  let png;
  try {
    // Only the band that holds the status bar: a full-page capture is ~600 KB
    // of level to decode for forty rows of HUD, and the player is standing
    // still while this happens -- which is the one thing this level punishes.
    // `scale: 1` is required, not decorative: this build's CDP answers
    // "Invalid parameters" to a clip with no scale field (measured).
    png = await game.screenshot({
      clip: {
        x: 0, y: 0, scale: 1,
        width: Math.max(1, Math.round(box.viewport || options.viewportWidth || 900)),
        height: (options.band || HUD_BAND) + 8,
      },
    });
  } finally {
    await game.evaluate("(() => { const c = document.querySelector('canvas'); c.setAttribute('style', " + JSON.stringify(before) + "); return 'restored'; })()");
  }
  // Canvas coordinates of the strip's top-left corner, as shown, and the rows
  // of the capture the status bar's digits must be on: the strip shows the
  // canvas's bottom `band` rows, and the digits are the bottom 24 of those.
  // Handing this to `readStatus` is what makes the read cheap.
  const band = options.band || HUD_BAND;
  const digitRow = Math.max(0, band - GLYPH_HEIGHT);
  return {
    png,
    canvasLeft: box.left,
    canvasTop: box.top,
    canvasWidth: box.width,
    canvasHeight: box.height,
    readOptions: { rows: [digitRow - 1, digitRow, digitRow + 1].filter((y) => y >= 0) },
  };
}

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

// Every number on the status bar, left to right.
//
// The digit row is found, not assumed: the strip is scanned for cells whose
// best digit correlates well and beats the runner-up, and cells one glyph wide
// apart on the same row are gathered into a number. That is why this works
// whatever the canvas size is -- the layout constants are the engine's, not
// this box's.
export function readStatus(pngBuffer, options = {}) {
  const image = decodePng(pngBuffer);
  return readBar(luminance(image), image.width, image.height, { ...options, rgba: image.data });
}

// The reading itself, over a luminance plane. Split out from `readStatus` so
// that the recognition -- the part that can be wrong -- is testable without a
// screenshot: the regression checks in scripts/route-test.mjs paint a status
// bar out of the archive's own digits and read it back.
export function readBar(lum, width, height, options = {}) {
  const families = options.digits || loadDigits(options.pak);
  const family = options.family || "num";
  const templates = (families[family] || families.num).map((glyph) => coverage(glyph, options.scale || 1));
  const cellWidth = templates[0].width;
  const cellHeight = templates[0].height;
  const minScore = options.minScore === undefined ? 0.6 : options.minScore;
  // The strip a `hudShot` returns puts the status bar in its first rows; a
  // whole screenshot puts it wherever the canvas bottom is. Searching only the
  // band keeps the scene -- which is full of shapes -- out of the answer.
  const bottom = Math.min(height - cellHeight, options.searchBottom === undefined ? (options.band || HUD_BAND) : options.searchBottom);
  const advance = cellWidth;
  // Which rows to look at. A caller that took the picture with `hudShot` knows
  // where the digits have to be -- they are drawn in the canvas's bottom 24
  // rows whatever the canvas size is, and `hudShot` framed the capture -- so it
  // says so, and the reader scores a handful of rows instead of the whole
  // strip. That matters because the player is standing still while this runs,
  // and standing still is what this level punishes. Without it, every row is
  // tried and the digit row wins on total score; that works too, and is what a
  // caller reading someone else's screenshot gets.
  const rows = Array.isArray(options.rows) && options.rows.length
    ? options.rows.filter((y) => y >= 0 && y <= bottom)
    : null;
  const cells = [];
  const scanRow = (y) => {
    for (let x = 0; x + cellWidth <= width; x++) {
      const cell = readCell(templates, lum, width, x, y);
      if (cell.score >= minScore) cells.push({ x, y, ...cell, used: false });
    }
  };
  if (rows) {
    for (const y of rows) scanRow(y);
  } else {
    for (let y = 0; y <= bottom; y++) scanRow(y);
  }
  // Reading a number is not "every cell that scored well" -- a digit scores
  // well at a pixel either side of itself, and a number's digits are not
  // equally confident ("0", "6" and "8" are close cousins in this font, and a
  // "0" can win by a hair). So: take the most confident cell there is, then
  // grow a number out of it one glyph at a time, left and right, keeping the
  // best cell at each step. A digit next to an already-read one only has to
  // *score* well, not beat its own runner-up.
  const numbers = [];
  for (;;) {
    let anchor = null;
    for (const cell of cells) {
      if (cell.used) continue;
      if (!anchor || cell.score > anchor.score) anchor = cell;
    }
    if (!anchor) break;
    anchor.used = true;
    const run = [anchor];
    for (const direction of [-1, 1]) {
      for (;;) {
        const edge = direction < 0 ? run[0] : run[run.length - 1];
        if (run.length >= 4) break;
        let next = null;
        for (const cell of cells) {
          if (cell.used) continue;
          if (Math.abs(cell.y - edge.y) > 3) continue;
          if (Math.abs(cell.x - (edge.x + direction * advance)) > 2) continue;
          if (!next || cell.score > next.score) next = cell;
        }
        if (!next) break;
        next.used = true;
        if (direction < 0) run.unshift(next); else run.push(next);
      }
    }
    const digits = run.map((cell) => cell.digit);
    numbers.push({
      value: Number(digits.join("")),
      digits,
      x: run[0].x,
      y: run[0].y,
      // The weakest link: a number is only as sure as its shakiest digit.
      score: Math.min(...run.map((cell) => cell.score)),
      margin: Math.min(...run.map((cell) => cell.margin)),
      cells: run,
    });
  }
  numbers.sort((a, b) => a.x - b.x);
  // The same number is read more than once -- a cell scores well one pixel off
  // as well as on, and a digit that was passed over as an anchor may still be
  // found on its own. A reading that occupies ground an already-accepted
  // reading covers is the same number seen a second time; the more confident
  // one is the reading.
  const span = (number) => [number.x, number.x + (number.cells.length - 1) * advance + cellWidth];
  const accepted = [];
  for (const number of [...numbers].sort((a, b) => b.score - a.score)) {
    const [start, end] = span(number);
    const overlaps = accepted.some((other) => {
      const [otherStart, otherEnd] = span(other);
      return Math.abs(other.y - number.y) <= 4 && start < otherEnd && otherStart < end;
    });
    if (!overlaps) accepted.push(number);
  }
  accepted.sort((a, b) => a.x - b.x);
  // Which family of digits each number is drawn with.
  //
  // Health and armour are blitted from pictures whose *shapes* are the same
  // font: re-scoring a reading against the other family does not separate them
  // -- measured on this box, a painted "100" reads as its own family only by a
  // hair, and the wrong family wins about as often. What does separate them is
  // colour. The engine's `num_*` pictures carry a grey ink (palette 55,55,43)
  // and its `anum_*` pictures a red one (75,15,0), and that difference survives
  // the screen: the health digits come back at about 171,171,141 and armour at
  // about 200,120,60. So the family is read off the ink's own hue: a number
  // whose bright pixels lean red is armour, and one whose bright pixels do not
  // is health. Without colour to read -- a caller that handed over luminance
  // alone -- every number is reported as the default family, and `readHealth`
  // falls back to the leftmost reading.
  const rgba = options.rgba || null;
  const INK = options.inkLevel === undefined ? 140 : options.inkLevel;
  for (const number of accepted) {
    number.family = family;
    if (!rgba) continue;
    let redness = 0;
    let count = 0;
    for (const cell of number.cells) {
      for (let y = 0; y < cellHeight; y++) {
        for (let x = 0; x < cellWidth; x++) {
          const px = cell.x + x;
          const py = cell.y + y;
          if (lum[py * width + px] < INK) continue;
          const at = (py * width + px) * 4;
          redness += rgba[at] - rgba[at + 1];
          count++;
        }
      }
    }
    if (count >= 8) {
      number.tint = Math.round(redness / count);
      number.family = number.tint >= (options.tintThreshold === undefined ? 20 : options.tintThreshold) ? "anum" : "num";
    }
  }
  return { numbers: accepted, width, height, scale: options.scale || 1 };
}

// The player's health, read off the status bar.
//
// Health is the leftmost number on the bar (the level's armour is drawn to its
// right, and an empty armour pool draws nothing at all), and on this level it
// is a value between 1 and 100 that a fight moves downwards. `readStatus`
// returns every number it can read, so a caller that wants to check this
// assumption has the evidence.
export function readHealth(pngBuffer, options = {}) {
  const status = readStatus(pngBuffer, options);
  const usable = status.numbers.filter((candidate) => candidate.value > 0 && candidate.value <= 999);
  // Health is drawn with the `num` pictures; a reading the other family fits
  // better is the armour number and is left for a caller that wants it.
  const health = usable.filter((candidate) => candidate.family === "num");
  const number = (health.length ? health : usable)[0] || null;
  return {
    ...status,
    health: number ? number.value : null,
    healthReading: number || null,
    armour: usable.filter((candidate) => candidate.family !== "num")[0] || null,
  };
}

// ---------------------------------------------------------------------------
// Command line: node control/hud.mjs shot.png  ->  the numbers in it
// ---------------------------------------------------------------------------

if (process.argv[1] && process.argv[1].endsWith("hud.mjs")) {
  const file = process.argv[2];
  if (!file) {
    console.log("usage: node control/hud.mjs <screenshot.png>");
    process.exitCode = 1;
  } else {
    const status = readHealth(fs.readFileSync(file));
    console.log("numbers: " + JSON.stringify(status.numbers.map((n) => ({ value: n.value, x: n.x, y: n.y, score: +n.score.toFixed(3), margin: +n.margin.toFixed(3) }))));
    console.log("health: " + status.health);
  }
}
