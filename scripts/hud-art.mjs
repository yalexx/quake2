#!/usr/bin/env node
// scripts/hud-art.mjs -- the HUD, menu and sprite half of the team's new art.
//
//   node scripts/hud-art.mjs                 # derive every picture this task owns
//   node scripts/hud-art.mjs --only inventory
//   node scripts/hud-art.mjs --list          # the targets and their methods, and stop
//   node scripts/hud-art.mjs --dry-run       # say what it would write, write nothing
//
// The raw art is what this box's image generator drew, and it lives in
// assets/textures/hud/ under the flat names the generation prompts asked for.
// What the packer reads is a PNG per ARCHIVE ENTRY, at the path the manifest
// records (`assets/textures/pics/<name>.png`, `assets/textures/sprites/<name>.png`),
// at exactly the entry's own dimensions -- scripts/tex-check.mjs fails on
// anything else and scripts/texture-pack.mjs refuses to pack it. This script is
// the one place the raw art becomes those pictures.
//
// The interesting part is that most of what this task covers is NOT a picture
// that can simply be swapped. The HUD status bar is a layout: a frame, its
// bevels and a black middle the engine blits numbers over. The help and end
// screens and the main menu are text drawn into metal. Painting generated art
// straight over any of those would delete the layout and the words, and a HUD
// whose ammo readout is drawn on rivets is a ruined HUD, not new art. So the
// recipes below keep the STRUCTURE of the picture being replaced -- its
// luminance, which is where the layout, the text and the logo live -- and take
// the MATERIAL from the generated art: its hue and its grain. The picture is
// recognisably the same widget in a new material.
//
// Four recipes, one per kind of target:
//
//   transfer  structure from the original, material from the generated art.
//             new luminance = original luminance, modulated by the generated
//             texture's own brightness, and the colour direction (hue) comes
//             from the generated pixel. Used for the status bar, the help
//             screen and the menu backdrop: everything whose layout matters.
//             A pixel that was black stays black, so a status bar's readout
//             area stays dark and the engine's own drawing on top still reads.
//   tile      a straight replacement for a flat tiling texture (pics/backtile),
//             rescaled to the entry's size, matched to the original's mean
//             brightness so a HUD drawn on it stays legible, and wrapped at the
//             edges so the seams do not tile.
//   sprite    a sprite frame: the generated art through the ORIGINAL frame's
//             silhouette, so the shape the engine animates is untouched and
//             only its fire is new. Every pixel the original marked transparent
//             (index 255) stays transparent, which is what the packer's
//             `original` alpha rule then preserves into the archive.
//   regrade   no generated art at all: the original pixels re-indexed onto a
//             new colour ramp built out of the picture's OWN palette, so the
//             result survives the packer's re-index byte for byte. This is for
//             the two things that must not be redrawn -- the console font and
//             the HUD numerals, which a 64x64 font sheet cannot get away with
//             blurring (`scripts/route-test.mjs` reads those very pictures) --
//             and for the menu's metal, so the menu changes with the HUD.
//
// A regrade is deliberately luminance-preserving: a new index is chosen for its
// colour but has to sit within a couple of steps of the old one's brightness, so
// glyphs keep their shapes and the lighter-than-the-background that makes text
// text. It never moves a pixel to index 255 or onto the picture's most common
// index unless it was already there -- those two are how the engine and
// control/hud.mjs tell ink from background.
//
// Colouring rules that apply to all four recipes:
//   the entry's own palette is the source of every colour, so whatever the
//   packer re-indexes finds the exact colour it was given; index 255 (the
//   engine's transparent key) is never written to and never moved.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  DEFAULT_MANIFEST,
  DEFAULT_PAK,
  PROJECT_ROOT,
  TextureError,
  artPathInProject,
  decodePcx,
  decodePng,
  pakEntry,
  paletteFromPcx,
  paletteMapper,
  readManifest,
} from "./texture-lib.mjs";

// The raw art the generation prompts wrote, and the entry that is not art.
const RAW_DIR = path.join(PROJECT_ROOT, "assets", "textures", "hud");
const TRANSPARENT = 255;

const USAGE = `hud-art.mjs -- generated HUD, menu and sprite art into per-entry pictures

  --raw <dir>     where the generated art is (default ${rel(RAW_DIR)})
  --pak <file>    the archive the originals are read from (default ${rel(DEFAULT_PAK)})
  --manifest <f>  the manifest that names each entry's art path (default ${rel(DEFAULT_MANIFEST)})
  --only <text>   derive only entries whose name contains <text> (repeatable)
  --list          print the targets and stop
  --dry-run       derive and report, but write nothing
  --quiet         print only the summary
  --help          this text
`;

function rel(file) {
  return path.relative(PROJECT_ROOT, file).split(path.sep).join("/") || ".";
}

// ---------------------------------------------------------------------------
// A PNG encoder
// ---------------------------------------------------------------------------
//
// texture-lib.mjs decodes PNG for the packer and there is no encoder in it,
// because until now nothing in the project had to WRITE a picture. This is the
// smallest one that does: filter 0 on every row, deflate, colour type 2 for an
// opaque picture and 6 when a sprite needs its transparency back.

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = -1;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

// `rgba` is the decoded layout (4 bytes a pixel); an opaque picture is written
// as three bytes a pixel, which is a third of the size for the same pixels.
function encodePng(rgba, width, height, { alpha = false } = {}) {
  const channels = alpha ? 4 : 3;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const at = y * (stride + 1);
    raw[at] = 0;
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      const to = at + 1 + x * channels;
      raw[to] = rgba[from];
      raw[to + 1] = rgba[from + 1];
      raw[to + 2] = rgba[from + 2];
      if (alpha) raw[to + 3] = rgba[from + 3];
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = alpha ? 6 : 2; // colour type: RGBA or RGB
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Pixels
// ---------------------------------------------------------------------------

function luminance(r, g, b) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// A colour scaled to a chosen brightness while keeping its hue: the generated
// art's own colour direction, re-lit. A pixel too dark to have a hue at all
// becomes the grey of the brightness asked for rather than black -- the
// brightness it was asked for is the picture's own structure, and throwing it
// away turns every dark patch of generated art into a hole in whatever it is
// laid on. (It is why the last frames of an explosion, which are almost all
// dark smoke, used to come out black.)
function relit(r, g, b, target) {
  if (target <= 0) return [0, 0, 0];
  const l = luminance(r, g, b);
  if (l < 0.03) {
    const grey = Math.round(target * 255);
    return [Math.min(255, grey), Math.min(255, grey), Math.min(255, grey)];
  }
  const k = target / l;
  return [Math.min(255, Math.round(r * k)), Math.min(255, Math.round(g * k)), Math.min(255, Math.round(b * k))];
}

// A picture of any size as the entry's size: crop to the entry's aspect ratio
// from the middle, then average blocks of pixels down to it. Averaging rather
// than sampling is what keeps a generated 1024x1024 photograph from turning
// into noise at 128x128 -- it is a box filter, and for a downscale that is the
// dull but right answer.
function fit(image, width, height) {
  const wanted = width / height;
  let cw = image.width;
  let ch = Math.round(cw / wanted);
  if (ch > image.height) {
    ch = image.height;
    cw = Math.round(ch * wanted);
  }
  const x0 = Math.floor((image.width - cw) / 2);
  const y0 = Math.floor((image.height - ch) / 2);
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy0 = y0 + Math.floor((y * ch) / height);
    const sy1 = y0 + Math.max(sy0 + 1 - y0, Math.floor(((y + 1) * ch) / height));
    for (let x = 0; x < width; x++) {
      const sx0 = x0 + Math.floor((x * cw) / width);
      const sx1 = x0 + Math.max(sx0 + 1 - x0, Math.floor(((x + 1) * cw) / width));
      let r = 0, g = 0, b = 0, n = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        for (let sx = sx0; sx < sx1; sx++) {
          const at = (sy * image.width + sx) * 4;
          r += image.data[at]; g += image.data[at + 1]; b += image.data[at + 2];
          n++;
        }
      }
      const to = (y * width + x) * 4;
      out[to] = Math.round(r / n); out[to + 1] = Math.round(g / n); out[to + 2] = Math.round(b / n); out[to + 3] = 255;
    }
  }
  return { data: out, width, height };
}

function hasTransparency(image) {
  for (let i = 3; i < image.data.length; i += 4) if (image.data[i] !== 255) return true;
  return false;
}

function meanLuminance(image) {
  let total = 0;
  for (let i = 0; i < image.width * image.height; i++) {
    total += luminance(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]);
  }
  return total / (image.width * image.height) || 1 / 255;
}

function scaleLuminance(image, factor) {
  const out = Buffer.from(image.data);
  for (let i = 0; i < image.width * image.height; i++) {
    const [r, g, b] = relit(out[i * 4], out[i * 4 + 1], out[i * 4 + 2], Math.min(1, luminance(out[i * 4], out[i * 4 + 1], out[i * 4 + 2]) * factor));
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b;
  }
  return { data: out, width: image.width, height: image.height };
}

// ---------------------------------------------------------------------------
// The four recipes
// ---------------------------------------------------------------------------

// transfer: the original's structure, the generated art's material.
//
// Every pixel keeps the brightness it had -- which is the only place a status
// bar's layout, a screen of text or the logo on the menu backdrop exists -- but
// the generated texture is allowed to modulate it by `grain`, and the pixel
// takes the generated art's hue at that brightness. Black stays black: the
// middle of the status bar is where the engine draws the player's ammo, and a
// material there is a material over the reading. A pixel the original had at
// index 255 -- the engine's transparent key -- is left transparent and is not
// part of any of this, or the help screen would come back with its cut-outs
// filled in.
function transfer(original, generated, options = {}) {
  const grain = options.grain ?? 0.6;
  const gain = options.gain ?? 1.1;
  // Above this brightness the picture is ink -- text, a logo, a white bar, the
  // hot core of a fireball -- and the material does not get to dim it: ink
  // keeps its own brightness and only takes the generated hue. Without this the
  // generated art's dark patches land on a screen's lettering and make reading
  // the console font a matter of luck.
  const inkAbove = options.inkAbove ?? 0.6;
  const genMean = meanLuminance(generated);
  const rgba = Buffer.alloc(original.indices.length * 4);
  for (let i = 0; i < original.indices.length; i++) {
    if (original.indices[i] === TRANSPARENT) continue;
    const at = original.indices[i] * 3;
    const base = luminance(original.palette[at], original.palette[at + 1], original.palette[at + 2]);
    if (base <= 0) { rgba[i * 4 + 3] = 255; continue; }
    const g = Math.max(0.2, Math.min(2.2, luminance(generated.data[i * 4], generated.data[i * 4 + 1], generated.data[i * 4 + 2]) / genMean));
    const modulation = base >= inkAbove ? 1 : 1 + grain * (g - 1);
    const target = Math.min(0.99, base * modulation * gain);
    const [r, gg, b] = relit(generated.data[i * 4], generated.data[i * 4 + 1], generated.data[i * 4 + 2], target);
    rgba[i * 4] = r; rgba[i * 4 + 1] = gg; rgba[i * 4 + 2] = b; rgba[i * 4 + 3] = 255;
  }
  return { data: rgba, width: original.width, height: original.height };
}

// tile: a replacement for a flat picture, with the original's mean brightness so
// a HUD drawn on top of it stays legible, and its edges cross-faded into a copy
// of itself shifted by half in both directions -- the four quadrants then meet
// their own continua and the texture tiles without a visible seam.
function tile(original, generated) {
  const { width, height } = original;
  const fitted = fit(generated, width, height);
  const blend = Math.max(2, Math.round(Math.min(width, height) / 5));
  const out = Buffer.from(fitted.data);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // Distance to the nearest edge, as the weight of the wrapped copy: the
      // very edge line is all wrapped copy, so the pixel that leaves on the
      // right is the one that entered on the left, and the wrap is continuous.
      const edge = Math.min(x, y, width - 1 - x, height - 1 - y);
      if (edge >= blend) continue;
      const w = 1 - edge / blend;
      const from = (((y + Math.floor(height / 2)) % height) * width + ((x + Math.floor(width / 2)) % width)) * 4;
      const to = (y * width + x) * 4;
      for (let c = 0; c < 3; c++) {
        out[to + c] = Math.round(out[to + c] * (1 - w) + fitted.data[from + c] * w);
      }
    }
  }
  let sum = 0;
  for (let i = 0; i < width * height; i++) sum += luminance(out[i * 4], out[i * 4 + 1], out[i * 4 + 2]);
  const original0 = original.palette;
  let want = 0;
  for (let i = 0; i < original.indices.length; i++) {
    const at = original.indices[i] * 3;
    want += luminance(original0[at], original0[at + 1], original0[at + 2]);
  }
  want /= original.indices.length;
  return scaleLuminance({ data: out, width, height }, (want || 1 / 255) / (sum / (width * height) || 1 / 255));
}

// sprite: the generated art through the original frame's silhouette. The shape
// is what the game animates -- a fireball's growth, a muzzle flash's spikes --
// and it is already right, so it is kept, and so is the frame's own shading
// inside it: a sprite frame has no palette of its own to spend, it is indexed
// onto the same few hundred colours the rest of the archive uses, and fire
// painted flat into a silhouette comes out two or three flat colours. So the
// frame's brightness is the envelope and the generated art -- the fire of the
// stage this frame is at -- supplies the hue and a hard grain on top of it.
// Transparent pixels are written transparent, which the packer reads as "keep
// what was there", i.e. keep index 255.
function sprite(original, generated, options = {}) {
  return transfer(original, matchMeanTo(original, fit(generated, original.width, original.height)), { grain: options.grain ?? 0.8, gain: options.gain ?? 1.25 });
}

// The generated fire is only as bright as the picture it happens to be, and an
// explosion's frames are a brightness curve -- the flash, the fireball, the
// smoke -- that the animation is nothing without. So the generated art is
// re-lit until its mean over the pixels the frame actually draws is the mean
// the frame had: the new fire is the same explosion at the same heat, in a
// different material.
function matchMeanTo(original, generated) {
  let drawn = 0, want = 0, have = 0;
  for (let i = 0; i < original.indices.length; i++) {
    if (original.indices[i] === TRANSPARENT) continue;
    const at = original.indices[i] * 3;
    want += luminance(original.palette[at], original.palette[at + 1], original.palette[at + 2]);
    have += luminance(generated.data[i * 4], generated.data[i * 4 + 1], generated.data[i * 4 + 2]);
    drawn++;
  }
  if (!drawn || have <= 0) return generated;
  return scaleLuminance(generated, Math.max(0.4, Math.min(2.5, want / have)));
}

// The colour a brightness should become, as a ramp of anchors. Each anchor is
// placed at the brightness it is meant to serve, so a colour comes out of the
// ramp at the brightness it went in at.
function rampAt(anchors, level) {
  let low = anchors[0];
  let high = anchors[anchors.length - 1];
  for (let i = 0; i < anchors.length - 1; i++) {
    if (level >= anchors[i][0] && level <= anchors[i + 1][0]) { low = anchors[i]; high = anchors[i + 1]; break; }
  }
  const span = high[0] - low[0] || 1;
  const t = Math.max(0, Math.min(1, (level - low[0]) / span));
  return [
    low[1] + (high[1] - low[1]) * t,
    low[2] + (high[2] - low[2]) * t,
    low[3] + (high[3] - low[3]) * t,
  ];
}

// regrade: one palette index -> another, out of the picture's own palette.
//
// A picture's palette is the whole of the colour it can hold, so a new look has
// to be built out of the entries already in it: for every index, the brightness
// its colour has is looked up in the ramp, and the index chosen is the palette
// entry nearest that ramp colour -- nearest overall, with a strong penalty for
// being a different brightness, which is what keeps a glyph's inside, edge and
// highlight three different colours and the text legible.
function regradeLut(palette, indices, options) {
  const anchors = options.anchors;
  const lift = options.lift ?? 1;
  const counts = new Map();
  for (const index of indices) counts.set(index, (counts.get(index) ?? 0) + 1);
  const majority = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const keep = new Set([TRANSPARENT, majority]);
  const lut = Buffer.alloc(256);
  const weight = options.luminanceWeight ?? 2.5;
  // An index that is already the right colour is not moved for the sake of
  // moving: a hit has to be this much closer than the colour the index already
  // has. Without it the ramp's own gradient sweeps near-identical palette
  // entries onto one another and a font sheet loses half the shades it uses to
  // draw a curve.
  const bias = options.identityBias ?? 200;
  for (let index = 0; index < 256; index++) {
    if (keep.has(index)) { lut[index] = index; continue; }
    const at = index * 3;
    const level = luminance(palette[at], palette[at + 1], palette[at + 2]);
    const wanted = rampAt(anchors, Math.min(1, level * lift));
    let best = index;
    let bestCost = Infinity;
    for (let other = 0; other < 256; other++) {
      if (keep.has(other)) continue;
      const otherAt = other * 3;
      const dr = palette[otherAt] - wanted[0];
      const dg = palette[otherAt + 1] - wanted[1];
      const db = palette[otherAt + 2] - wanted[2];
      const otherLevel = luminance(palette[otherAt], palette[otherAt + 1], palette[otherAt + 2]);
      const cost =
        dr * dr + dg * dg + db * db +
        weight * weight * 255 * 255 * (otherLevel - level) * (otherLevel - level) +
        (other === index ? 0 : bias);
      if (cost < bestCost) { bestCost = cost; best = other; }
    }
    lut[index] = best;
  }
  return lut;
}

// The packer re-indexes every pixel of the art through the entry's palette, and
// index 255 -- the engine's transparent key -- is in that palette like any
// other colour. A derived pixel whose colour happens to be nearest that brown
// would come back from the packer transparent, which is a hole punched in a
// picture that used to be drawn there. So each pixel is put through the
// packer's own mapping here: the ones that would land on 255 get the nearest
// colour that is not 255 instead, and the art reaches the archive with the
// silhouettes it was given.
function sealTransparency(image, original, palette) {
  const asPacked = paletteMapper(palette);
  const withoutKey = paletteMapper(palette, { exclude: [TRANSPARENT] });
  let sealed = 0;
  for (let i = 0; i < original.indices.length; i++) {
    if (original.indices[i] === TRANSPARENT || image.data[i * 4 + 3] < 128) continue;
    if (asPacked(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]) !== TRANSPARENT) continue;
    const index = withoutKey(image.data[i * 4], image.data[i * 4 + 1], image.data[i * 4 + 2]);
    image.data[i * 4] = palette[index * 3];
    image.data[i * 4 + 1] = palette[index * 3 + 1];
    image.data[i * 4 + 2] = palette[index * 3 + 2];
    sealed++;
  }
  return sealed;
}

function applyLut(original, lut) {
  const rgba = Buffer.alloc(original.indices.length * 4);
  for (let i = 0; i < original.indices.length; i++) {
    const index = lut[original.indices[i]];
    const at = index * 3;
    rgba[i * 4] = original.palette[at];
    rgba[i * 4 + 1] = original.palette[at + 1];
    rgba[i * 4 + 2] = original.palette[at + 2];
    rgba[i * 4 + 3] = 255;
  }
  return { data: rgba, width: original.width, height: original.height };
}

// ---------------------------------------------------------------------------
// The targets
// ---------------------------------------------------------------------------

// The two ramps the regrades are built from. Steel for the menu and the metal
// the labels are engraved in -- coal at the bottom, gunmetal through the
// middle, a hot amber only where the original was brightest, which is where its
// highlights and its text are. Amber and ember for the glyph families, so the
// console font and the HUD readout pick up the HUD's own amber; the HUD keeps
// its two number families apart, white-amber for one and red for the other.
const STEEL = [[0, 8, 6, 4], [0.35, 108, 88, 56], [0.7, 198, 172, 124], [1, 255, 214, 152]];
const AMBER = [[0, 8, 5, 3], [0.35, 150, 88, 26], [0.75, 255, 190, 96], [1, 255, 238, 205]];
const EMBER = [[0, 12, 3, 2], [0.35, 176, 58, 20], [0.8, 255, 148, 56], [1, 255, 216, 166]];

// Everything with a picture this task draws, one record per archive entry.
// `art` names the raw generated art; entries without one are regraded from
// their own palette and need nothing generated.
const SCREENS = [
  { name: "pics/inventory.pcx", art: "pics_inventory.png", grain: 0.55, gain: 1.15 },
  { name: "pics/help.pcx", art: "pics_help.png", grain: 0.7, gain: 1.15 },
  { name: "pics/conback.pcx", art: "pics_conback.png", grain: 0.9, gain: 1.25 },
  // The menu's own panel and the two screens the game ends on: paintings with
  // words on them, so the material moves and the lettering does not.
  { name: "pics/m_main.pcx", art: "pics_menu_panel.png", grain: 0.6, gain: 1.1 },
  { name: "pics/victory.pcx", art: "pics_victory.png", grain: 0.5, gain: 1.05 },
  { name: "pics/quit.pcx", art: "pics_quit.png", grain: 0.5, gain: 1.05 },
];
const TILES = [{ name: "pics/backtile.pcx", art: "pics_backtile.png" }];

// Which generated picture each sprite frame is made of, in frame order. The
// stage a frame gets follows the frame's own silhouette, which the archive
// says: a frame whose fire fills much of its cell is a young fireball, a frame
// that is almost all transparent is the last wisp of it. The order matters --
// a fire stage on the frame that is supposed to be dying smoke would put a
// bright blob at the end of the animation.
const STAGE1 = "sprites_explosion_stage1.png";
const STAGE2 = "sprites_explosion_stage2.png";
const STAGE3 = "sprites_explosion_stage3.png";
const STAGE4 = "sprites_explosion_stage4.png";
const SPRITES = [
  // s_explod: 91%, 72%, 48%, 74%, 83%, 95% of the cell is transparent, i.e. it
  // grows to frame 2 and then dies away to a wisp.
  { name: "sprites/s_explod_0.pcx", art: STAGE1 },
  { name: "sprites/s_explod_1.pcx", art: STAGE2 },
  { name: "sprites/s_explod_2.pcx", art: STAGE2 },
  { name: "sprites/s_explod_3.pcx", art: STAGE3 },
  { name: "sprites/s_explod_4.pcx", art: STAGE3 },
  { name: "sprites/s_explod_5.pcx", art: STAGE4 },
  // s_explo2 grows to frame 6 (80% transparent) then fades out over six frames.
  ...[...Array(13).keys()].map((i) => ({ name: `sprites/s_explo2_${i}.pcx`, art: i < 2 ? STAGE1 : i < 8 ? STAGE2 : i < 12 ? STAGE3 : STAGE4 })),
  // s_explo3 is the big one: it peaks at frame 4 (69%) and is a wisp by 7.
  ...[...Array(8).keys()].map((i) => ({ name: `sprites/s_explo3_${i}.pcx`, art: i < 2 ? STAGE1 : i < 6 ? STAGE2 : i === 6 ? STAGE3 : STAGE4 })),
  ...[0, 1].map((i) => ({ name: `sprites/s_flash_${i}.pcx`, art: i === 0 ? "sprites_flash_bright.png" : "sprites_flash_small.png" })),
  { name: "sprites/s_flash_2.pcx", art: "sprites_flash_small.png" },
  ...[0, 1].map((i) => ({ name: `sprites/s_bfg1_${i}.pcx`, art: "sprites_bfg_ball.png" })),
  ...[0, 1].map((i) => ({ name: `sprites/s_bfg2_${i}.pcx`, art: "sprites_bfg_ball.png" })),
  ...[2, 3].map((i) => ({ name: `sprites/s_bfg2_${i}.pcx`, art: "sprites_bfg_burst.png" })),
  ...[0, 1, 2].map((i) => ({ name: `sprites/s_bfg3_${i}.pcx`, art: "sprites_bfg_ball.png" })),
  ...[3, 4, 5].map((i) => ({ name: `sprites/s_bfg3_${i}.pcx`, art: "sprites_bfg_burst.png" })),
];

// The console font and the HUD's two number families: recoloured, never
// redrawn. A glyph drawn by an image generator is a smudge that the engine then
// blits at 8x8, and control/hud.mjs reads these particular pictures to know what
// the game is showing.
const GLYPHS = [
  { name: "pics/conchars.pcx", anchors: AMBER, lift: 1.15 },
  ...[...Array(10).keys()].map((i) => ({ name: `pics/num_${i}.pcx`, anchors: AMBER, lift: 1.35 })),
  { name: "pics/num_minus.pcx", anchors: AMBER, lift: 1.35 },
  ...[...Array(10).keys()].map((i) => ({ name: `pics/anum_${i}.pcx`, anchors: EMBER, lift: 1.5 })),
  { name: "pics/anum_minus.pcx", anchors: EMBER, lift: 1.5 },
];

// The menu's metal and the screens the game prints words on: regraded so the
// whole interface moves together with the HUD, its layout and its lettering
// untouched.
const METAL = [
  "pics/m_main_logo.pcx",
  "pics/m_main_plaque.pcx",
  "pics/m_main_options.pcx",
  "pics/m_main_options_sel.pcx",
  "pics/m_main_game.pcx",
  "pics/m_main_game_sel.pcx",
  "pics/m_main_multiplayer.pcx",
  "pics/m_main_multiplayer_sel.pcx",
  "pics/m_main_video.pcx",
  "pics/m_main_video_sel.pcx",
  "pics/m_main_quit.pcx",
  "pics/m_main_quit_sel.pcx",
  "pics/m_banner_start_server.pcx",
  "pics/m_banner_customize.pcx",
  "pics/m_banner_join_server.pcx",
  "pics/m_banner_save_game.pcx",
  "pics/m_banner_multiplayer.pcx",
  "pics/m_banner_addressbook.pcx",
  "pics/m_banner_plauer_setup.pcx",
  "pics/m_banner_video.pcx",
  "pics/m_banner_options.pcx",
  "pics/m_banner_load_game.pcx",
  "pics/m_banner_game.pcx",
  "pics/pause.pcx",
  "pics/loading.pcx",
  "pics/areyousure.pcx",
  "pics/yn.pcx",
  "pics/tag1.pcx",
  "pics/tag2.pcx",
].map((name) => ({ name, anchors: STEEL }));

// Pictures this task deliberately leaves alone, and why, so that "not changed"
// is a decision on the record rather than an omission:
//
//   pics/colormap.pcx        it is the engine's global palette for every WAL in
//                            the archive, not a picture: its last 768 bytes are
//                            the colours every wall in the game is drawn with.
//   pics/field_3.pcx         the HUD's bar FILL, already amber and already the
//                            colour the new HUD is built around.
//   pics/w_*.pcx, pics/i_*.pcx, pics/a_*.pcx, pics/p_*.pcx, pics/k_*.pcx
//                            the 24x24 weapon, ammo, item, powerup and key
//                            icons: the keys and powerups are told apart BY
//                            COLOUR in play, and a 1024x1024 generated icon
//                            averaged down to 24x24 is a smudge.
//   pics/m_cursor0..14.pcx   the menu cursors: 22x29 pointer art, whose outline
//                            is the whole of it.
//   pics/ch1..ch3.pcx, pics/net.pcx, pics/turtle.pcx
//                            the small status glyphs, same reason.
const SKIPPED = [
  "pics/colormap.pcx -- the engine's global palette, not a picture",
  "pics/field_3.pcx -- the HUD bar fill is already the amber the new HUD uses",
  "pics/w_*, i_*, a_*, p_*, k_*.pcx (45 icons) -- colour tells them apart in play; 24x24 is smaller than generated art can be averaged into",
  "pics/m_cursor0..14.pcx (15 cursors) -- 22x29 pointer art, all outline",
  "pics/ch1..ch3.pcx, pics/net.pcx, pics/turtle.pcx -- small status glyphs, same reason",
];

// ---------------------------------------------------------------------------
// Running it
// ---------------------------------------------------------------------------

function parseArguments(argv) {
  const options = { raw: RAW_DIR, pak: DEFAULT_PAK, manifest: DEFAULT_MANIFEST, only: [], list: false, dryRun: false, quiet: false, help: false };
  const takesValue = new Set(["--raw", "--pak", "--manifest", "--only"]);
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") options.help = true;
    else if (argument === "--list") options.list = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--quiet") options.quiet = true;
    else {
      const split = argument.indexOf("=");
      const flag = split === -1 ? argument : argument.slice(0, split);
      if (!takesValue.has(flag)) throw new TextureError("unknown option " + argument + "\n\n" + USAGE, "BAD_ARGUMENT");
      const value = split === -1 ? argv[++index] : argument.slice(split + 1);
      if (value === undefined || (split === -1 && value.startsWith("--"))) {
        throw new TextureError(flag + " needs a value", "BAD_ARGUMENT");
      }
      if (flag === "--raw") options.raw = path.resolve(value);
      else if (flag === "--pak") options.pak = path.resolve(value);
      else if (flag === "--manifest") options.manifest = path.resolve(value);
      else if (flag === "--only") options.only.push(value.toLowerCase());
    }
  }
  return options;
}

function originalFor(pak, name) {
  const entry = pakEntry(pak, name);
  if (!entry) throw new TextureError("the archive has no entry " + name, "NO_ENTRY");
  const bytes = pak.subarray(entry.offset, entry.offset + entry.length);
  return { ...decodePcx(bytes), palette: paletteFromPcx(bytes) };
}

function generatedFor(rawDir, art, cache) {
  const file = path.join(rawDir, art);
  if (!cache.has(file)) {
    if (!fs.existsSync(file)) throw new TextureError("the generated art " + rel(file) + " is not there", "NO_ART");
    cache.set(file, decodePng(fs.readFileSync(file)));
  }
  return cache.get(file);
}

function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const manifest = readManifest(options.manifest);
  const artPaths = new Map(manifest.entries.map((entry) => [entry.name, entry.png]));

  const targets = [
    ...SCREENS.map((target) => ({ ...target, method: "transfer" })),
    ...TILES.map((target) => ({ ...target, method: "tile" })),
    ...SPRITES.map((target) => ({ ...target, method: "sprite" })),
    ...GLYPHS.map((target) => ({ ...target, method: "regrade" })),
    ...METAL.map((target) => ({ ...target, method: "regrade" })),
  ];
  const wanted = options.only.length ? targets.filter((target) => options.only.some((text) => target.name.toLowerCase().includes(text))) : targets;
  // One entry, one picture. Two recipes for the same entry would silently be
  // whichever ran last, which is how a menu panel that had been given a new
  // material went back to having only a new palette.
  const seen = new Set();
  for (const target of targets) {
    if (seen.has(target.name)) throw new TextureError(target.name + " is in the target list twice", "BAD_TARGETS");
    seen.add(target.name);
  }
  if (options.only.length && !wanted.length) {
    throw new TextureError("no target matches --only " + options.only.join(", "), "BAD_ARGUMENT");
  }

  if (options.list) {
    for (const target of targets) {
      process.stdout.write(target.method.padEnd(9) + target.name + (target.art ? "  <- " + target.art : "") + "\n");
    }
    process.stdout.write("\nleft alone, on purpose:\n");
    for (const line of SKIPPED) process.stdout.write("  " + line + "\n");
    return 0;
  }

  const pak = fs.readFileSync(options.pak);
  const cache = new Map();
  const written = [];
  const failed = [];
  let unchanged = 0;

  for (const target of wanted) {
    try {
      const original = originalFor(pak, target.name);
      let image;
      if (target.method === "transfer") image = transfer(original, fit(generatedFor(options.raw, target.art, cache), original.width, original.height), { grain: target.grain, gain: target.gain });
      else if (target.method === "tile") image = tile(original, generatedFor(options.raw, target.art, cache));
      else if (target.method === "sprite") image = sprite(original, generatedFor(options.raw, target.art, cache));
      else image = applyLut(original, regradeLut(original.palette, original.indices, target));
      sealTransparency(image, original, original.palette);

      if (image.width !== original.width || image.height !== original.height) {
        throw new TextureError("derived " + image.width + "x" + image.height + ", the entry is " + original.width + "x" + original.height, "BAD_SIZE");
      }
      // A picture that comes out identical to the one it replaces is not art,
      // and pretending otherwise would put a target in the report that changed
      // nothing. It also catches a regrade whose ramp has collapsed.
      //
      // The alpha channel has to survive into the file whenever any pixel is
      // transparent: a PNG written as three bytes a pixel decodes back opaque,
      // and the packer would then paint over the entry's own transparent key
      // instead of leaving it, which is a filled-in cut-out in the game and not
      // a picture that changed.
      const png = encodePng(image.data, image.width, image.height, { alpha: hasTransparency(image) });
      const outFile = path.join(PROJECT_ROOT, artPaths.get(target.name) ?? artPathInProject(target.name));
      const sameAsOriginal = pixelsEqual(image.data, original);
      let rewrote = false;
      if (!options.dryRun && !sameAsOriginal) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        const previous = fs.existsSync(outFile) ? fs.readFileSync(outFile) : null;
        if (previous && previous.equals(png)) unchanged++;
        else rewrote = true;
        fs.writeFileSync(outFile, png);
      } else if (sameAsOriginal && fs.existsSync(outFile)) {
        // A recipe that now produces the original picture must not leave the
        // art an earlier recipe left behind: the archive would pack a look this
        // run never decided on.
        fs.rmSync(outFile);
      }
      written.push({ name: target.name, method: target.method, art: target.art ?? null, file: rel(outFile), bytes: png.length, sameAsOriginal, rewrote });
    } catch (error) {
      failed.push({ name: target.name, problem: error instanceof TextureError ? error.message : String(error && error.message ? error.message : error) });
    }
  }

  if (!options.quiet) {
    for (const item of written) {
      process.stdout.write(
        (item.sameAsOriginal ? "same " : options.dryRun ? "would " : "wrote ") + item.method.padEnd(9) + item.name.padEnd(28) +
          (item.art ? "<- " + item.art.padEnd(30) : "".padEnd(33)) + (item.sameAsOriginal ? "identical to the original" : item.bytes + " bytes") + "\n"
      );
    }
  }
  for (const item of failed) process.stderr.write("FAIL " + item.name + ": " + item.problem + "\n");
  process.stdout.write(
    written.length + " target(s): " + written.filter((item) => item.rewrote).length + " rewritten, " +
      written.filter((item) => !item.rewrote && !item.sameAsOriginal).length + " already up to date, " +
      written.filter((item) => item.sameAsOriginal).length + " identical to the original, " + failed.length + " failed\n"
  );
  return failed.length ? 1 : 0;
}

// Whether a derived picture is the original pixel for pixel, which for a
// regrade should never happen and for a transfer would mean the generated art
// had no effect at all.
function pixelsEqual(rgba, original) {
  for (let i = 0; i < original.indices.length; i++) {
    const at = original.indices[i] * 3;
    if (rgba[i * 4] !== original.palette[at] || rgba[i * 4 + 1] !== original.palette[at + 1] || rgba[i * 4 + 2] !== original.palette[at + 2]) return false;
  }
  return true;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write((error instanceof TextureError ? error.message : error && error.stack ? error.stack : String(error)) + "\n");
  process.exitCode = 2;
}
