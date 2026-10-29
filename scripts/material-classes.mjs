#!/usr/bin/env node
// scripts/material-classes.mjs -- what every Quake 2 texture is made of.
//
// One job: turn a manifest record into one material word from a fixed list, so
// the art scripts can choose a recipe by material instead of by file name.
// `sign`, `water`, `sky` and `flat` are the four materials that mean "keep the
// old faithful recipe"; the other nine say what surface the picture is made of.
//
// The answer has two sources, in this order:
//
//   1. TABLE, an explicit decision for each of the 270 WALs that carry
//      replacement art. It was made by reading every page of
//      docs/texture-review/sheets/*.png (rows labelled with the texture name,
//      cell 1 the demo original) and recording, per texture, what the picture
//      shows and why it has that material. The table is exhaustive for those
//      270 targets, so every delivered texture has a reviewed answer rather
//      than an inference from its name.
//   2. RULES, the name/header contract below, for everything else: the 33 WALs
//      that have no replacement art yet, and any entry a caller passes that is
//      not in the table. First match wins.
//
// The rules are also the seed the table was reviewed against. Where the demo
// picture disagreed with the name (green `grnx` panels that are steel, not
// vegetation; `watrt` trim that is not water; `exitdr` doors that the sign rule
// catches first) the table says so and says why.
//
// Flags and contents are the WAL header's own Quake 2 surface/contents bits:
//   flags    1 light, 4 sky, 8 warp
//   contents 8 lava, 16 slime, 32 water (the rule tests 0x38)
//
// Zero dependencies beyond node's standard library. `isUniform` is borrowed
// from hires-art.mjs so "a uniform source" has exactly one definition; that
// module's CLI is guarded, so importing it runs nothing.
//
// The contract the rest of the texture pipeline uses:
//   MATERIALS                     the thirteen names, exactly, never renamed
//   materialFor(entry, source?)   -> { material, why, by }
//   materialCounts(entries)       -> { stone: n, metal: n, ... }
//
// `source` is optional and is the pristine WAL as { width, height, rgb } in
// sRGB. Only the rust test reads it; a table decision never depends on it, so
// the same texture gets the same material with or without the picture.

import { isUniform } from "./hires-art.mjs";

// Exactly these strings. `sign`, `water`, `sky` and `flat` mean "keep the old
// faithful recipe"; the rest name a physical material for the art recipes.
export const MATERIALS = Object.freeze([
  "stone",
  "metal",
  "rust",
  "tech",
  "crate",
  "wood",
  "organic",
  "lamp",
  "glass",
  "sign",
  "water",
  "sky",
  "flat",
]);

const MATERIAL_SET = new Set(MATERIALS);

// The header bits the rules read by themselves.
const SURF_LIGHT = 0x1;
const SURF_SKY = 0x4;
const SURF_WARP = 0x8;
const CONTENTS_LIQUID = 0x38; // lava (8) | slime (16) | water (32)

// A rust pixel is a brown-orange one: hue 10..45 degrees and saturation over
// a quarter. A metal surface promotes to rust when at least this share of its
// source pixels are rust pixels. The threshold is the contract, not a guess.
const RUST_HUE_LOW = 10;
const RUST_HUE_HIGH = 45;
const RUST_SATURATION = 0.25;
export const RUST_SHARE = 0.35;

// The rules, in the order the contract gives them. Each entry is
// [test, material, why]; the first test that matches decides. `test` gets the
// lower-case base name, the entry's flags/contents and the optional source.
const RULES = [
  {
    material: "sky",
    why: "sky: surface flag 4 or a name beginning with sky",
    test: ({ base, flags }) => (flags & SURF_SKY) !== 0 || base.startsWith("sky"),
  },
  {
    material: "water",
    why: "water: warp flag 8, liquid contents (lava/slime/water) or a water name",
    test: ({ base, flags, contents }) =>
      (flags & SURF_WARP) !== 0 || (contents & CONTENTS_LIQUID) !== 0 || /watr|water|bluwter/.test(base),
  },
  {
    material: "flat",
    why: "flat: the name is black, or the source is one uniform colour",
    test: ({ base, source }) => base === "black" || (source != null && isUniform(source)),
  },
  {
    material: "sign",
    why: "sign: text or graphic sign name (sign/arrow/exit/alarm/lever/...)",
    test: ({ base }) => /sign|arrow|exit|endsign|kcsign|trigger|basemap|alarm|lever/.test(base),
  },
  {
    material: "lamp",
    why: "lamp: light flag 1, or a light-fixture name",
    test: ({ base, flags }) => (flags & SURF_LIGHT) !== 0 || /plite|lite|light|baselt|baslt/.test(base),
  },
  {
    material: "glass",
    why: "glass: window name",
    test: ({ base }) => /wndow/.test(base),
  },
  {
    material: "crate",
    why: "crate: box or crate name",
    test: ({ base }) => /box|crate/.test(base),
  },
  {
    material: "tech",
    why: "tech: machine, computer or door-mechanism name",
    test: ({ base }) =>
      /comp|btactmach|timpod|shooter|btshoot|dr0|exitdr|keydr|refdr|hdoor|keydran|btelev/.test(base),
  },
  {
    material: "organic",
    why: "organic: grass or green-growth name",
    test: ({ base }) => /grass|grnx|sewer/.test(base),
  },
  {
    material: "stone",
    why: "stone: rock, concrete, ceiling or floor name",
    test: ({ base }) => /rocks|grnmt|wbasic|basic|wslt|wswall|cgrbase|broken|damage|ceil|floor|florr|flat1/.test(base),
  },
  {
    material: "metal",
    why: "metal: steel, pipe, grate, trim or painted-panel name",
    test: ({ base }) =>
      /metal|c_met|wmtal|pipe|pip|rpip|support|wsupprt|grat|ggrat|wplat|wtroof|color|red|yellow|caution|p_tub/.test(base),
    rust: true,
  },
];

// A texture's identity in the table: its miptex when the manifest record has
// one, otherwise its entry name, lower-cased, without the `textures/` prefix or
// the extension. The archive mixes upper and lower case (`PIP04_3`), so the
// key is always lower-case.
export function materialKey(entry) {
  const raw = typeof entry === "string" ? entry : entry && (entry.miptex || entry.name);
  if (typeof raw !== "string" || raw.length === 0) {
    throw new TypeError("materialFor expects a manifest record with a name or miptex");
  }
  let key = raw.trim().toLowerCase().replace(/\\/g, "/");
  const dot = key.lastIndexOf(".");
  if (dot > key.lastIndexOf("/")) key = key.slice(0, dot);
  if (key.startsWith("textures/")) key = key.slice("textures/".length);
  return key;
}

function baseNameOf(key) {
  return key.slice(key.lastIndexOf("/") + 1);
}

// Hue in degrees and HSV saturation from one sRGB triple. A black pixel has no
// hue and no saturation, so it can never be a rust pixel.
function hueSaturation(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const high = Math.max(red, green, blue);
  const low = Math.min(red, green, blue);
  const delta = high - low;
  if (delta === 0) return { hue: 0, saturation: 0 };
  let hue;
  if (high === red) hue = ((green - blue) / delta) % 6;
  else if (high === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  hue *= 60;
  if (hue < 0) hue += 360;
  return { hue, saturation: high === 0 ? 0 : delta / high };
}

// The share of source pixels that are rust-hued, or null when no usable source
// was given. A source with no rgb (or too few bytes) cannot promote anything.
function rustShareOf(source) {
  if (!source || !source.rgb) return null;
  const width = Number(source.width) || 0;
  const height = Number(source.height) || 0;
  const count = width * height;
  const rgb = source.rgb;
  if (!count || !rgb || rgb.length < count * 3) return null;
  let rust = 0;
  for (let pixel = 0; pixel < count; pixel++) {
    const at = pixel * 3;
    const { hue, saturation } = hueSaturation(rgb[at], rgb[at + 1], rgb[at + 2]);
    if (hue >= RUST_HUE_LOW && hue <= RUST_HUE_HIGH && saturation > RUST_SATURATION) rust++;
  }
  return rust / count;
}

// One decimal, so a 34.5% share never reads as "35% ... (< 35%)".
function percent(share) {
  return Math.round(share * 1000) / 10;
}

function ruleFor(entry, source) {
  const key = materialKey(entry);
  const base = baseNameOf(key);
  const flags = Number(entry && entry.flags) || 0;
  const contents = Number(entry && entry.contents) || 0;
  const context = { base, flags, contents, source };
  for (const rule of RULES) {
    if (!rule.test(context)) continue;
    if (rule.rust) {
      const share = rustShareOf(source);
      if (share !== null && share >= RUST_SHARE) {
        return {
          material: "rust",
          why: "rust: metal name and " + percent(share) + "% of source pixels are rust-hued (>= 35%)",
          by: "rule",
        };
      }
      return {
        material: "metal",
        why: share === null ? "metal: metal name, no source to test for rust" : "metal: metal name and only " + percent(share) + "% rust-hued source pixels (< 35%)",
        by: "rule",
      };
    }
    return { material: rule.material, why: rule.why, by: "rule" };
  }
  return { material: "stone", why: "stone: the default when no rule matches", by: "rule" };
}

// ---------------------------------------------------------------------------
// The reviewed table -- 270 entries, one per WAL with replacement art
// ---------------------------------------------------------------------------
//
// Key: the entry's miptex, lower-case (see materialKey). Material: one of
// MATERIALS. Why: what the demo picture in cell 1 of its review-sheet row
// showed, or, where it disagreed with the name, why the picture wins. Every row
// was reviewed on docs/texture-review/sheets/*.png; the sheets hold 26 pages
// (e1u1 22, e1u2/e1u3/e2u1/e2u2 one each) and the luminance page, and the rows
// are labelled with the texture name. An animation family shares one material;
// the test checks that against every animname link in the manifest.
export const TABLE = {
  "e1u1/+0btshoot1": { material: "tech", why: "shooter-panel face; tech by name even though it reads as a light" },
  "e1u1/+0btshoot2": { material: "tech", why: "shooter-panel face; tech by name even though it reads as a light" },
  "e1u1/+0cgrate1_1": { material: "metal", why: "steel crate face with a stencilled security label; the name matches grat, so metal" },
  "e1u1/+0cgrate3_1": { material: "metal", why: "steel crate face with a stencilled code label; the name matches grat, so metal" },
  "e1u1/+1cgrate1_1": { material: "metal", why: "steel crate face with a stencilled security label; the name matches grat, so metal" },
  "e1u1/+1cgrate3_1": { material: "metal", why: "steel crate face with a stencilled code label; the name matches grat, so metal" },
  "e1u1/+abtshoot2": { material: "tech", why: "shooter-panel face; tech by name" },
  "e1u1/+abtshoot3": { material: "tech", why: "shooter-panel face; tech by name" },
  "e1u1/alarm0": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/alarm1": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/alarm2": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/alarm3": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/arrow0": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/arrow1": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/arrow2": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/arrow3": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/arrowup0": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/arrowup1": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/arrowup2": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/arrowup3": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/baselt_2": { material: "lamp", why: "fluorescent light fixture" },
  "e1u1/baselt_3": { material: "lamp", why: "fluorescent light fixture" },
  "e1u1/baselt_4": { material: "lamp", why: "fluorescent light fixture" },
  "e1u1/baselt_b": { material: "lamp", why: "red lamp fixture" },
  "e1u1/basemap": { material: "sign", why: "dark map/terminal sign; the sign recipe keeps the circuitry crisp" },
  "e1u1/baslt3_1": { material: "lamp", why: "fluorescent tube in a metal frame (baslt name, no light flag)" },
  "e1u1/black": { material: "flat", why: "uniform black: the flat recipe reproduces it exactly" },
  "e1u1/bluwter": { material: "water", why: "dark rippled liquid; warp flag, contents 32 and the name agree" },
  "e1u1/box1_1": { material: "crate", why: "crate face, name and look agree" },
  "e1u1/box1_3": { material: "crate", why: "crate face, name and look agree" },
  "e1u1/box1_4": { material: "crate", why: "crate face, name and look agree" },
  "e1u1/box1_5": { material: "crate", why: "crate face, name and look agree" },
  "e1u1/box1_6": { material: "crate", why: "crate face, name and look agree" },
  "e1u1/box3_1": { material: "crate", why: "crate face, name and look agree" },
  "e1u1/box3_2": { material: "crate", why: "crate face, name and look agree" },
  "e1u1/box3_3": { material: "crate", why: "crate face, name and look agree" },
  "e1u1/box3_4": { material: "crate", why: "rusted steel crate face; the object class is still crate" },
  "e1u1/box3_5": { material: "crate", why: "rusted steel crate face; the object class is still crate" },
  "e1u1/box3_6": { material: "crate", why: "rusted steel crate face; the object class is still crate" },
  "e1u1/broken1_1": { material: "stone", why: "broken rock/concrete edge" },
  "e1u1/broken2_1": { material: "stone", why: "broken rock/concrete edge" },
  "e1u1/broken2_2": { material: "stone", why: "broken rock/concrete edge" },
  "e1u1/broken2_3": { material: "stone", why: "broken rock/concrete edge" },
  "e1u1/broken2_4": { material: "stone", why: "broken rock ledge" },
  "e1u1/btactmach": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/btactmach0": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/btactmach1": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/btactmach2": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/btactmach3": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/btelev_up": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/btelev_up3": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/c_met5_1": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/c_met5_2": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/c_met51a": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/c_met7_1": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/c_met7_2": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/c_met8_2": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/ceil1_1": { material: "lamp", why: "ceiling light panel (flag 1)" },
  "e1u1/ceil1_2": { material: "lamp", why: "red ceiling light panel (flag 1)" },
  "e1u1/ceil1_3": { material: "lamp", why: "orange ceiling light panel (flag 1)" },
  "e1u1/ceil1_4": { material: "lamp", why: "orange ceiling light panel (flag 1)" },
  "e1u1/ceil1_7": { material: "lamp", why: "cyan ceiling light panel (flag 1)" },
  "e1u1/ceil1_8": { material: "lamp", why: "white ceiling light panel (flag 1)" },
  "e1u1/cgrbase1_1": { material: "tech", why: "control panel with a screen and vent slots, not a stone base" },
  "e1u1/color1_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/color1_3": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/color1_4": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/color1_6": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/color1_7": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/color1_8": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/color2_4": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/comp1_1": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp1_2": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp1_4": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp1_5": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp1_7": { material: "tech", why: "computer-panel edge; tech by name" },
  "e1u1/comp2_1": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp2_3": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp2_5": { material: "tech", why: "computer-panel edge; tech by name" },
  "e1u1/comp3_1": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp3_2": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp3_3": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp3_4": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp3_5": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp3_7": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp3_8": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp4_1": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp4_2": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp5_1": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp5_2": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp5_3": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/comp5_4": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u1/crate1_1": { material: "crate", why: "crate face, name and look agree" },
  "e1u1/crate1_3": { material: "crate", why: "crate face, name and look agree" },
  "e1u1/crate1_4": { material: "crate", why: "crate face, name and look agree" },
  "e1u1/crate1_6": { material: "crate", why: "crate face, name and look agree" },
  "e1u1/crate1_7": { material: "crate", why: "crate face, name and look agree" },
  "e1u1/damage1_1": { material: "metal", why: "riveted steel wall carrying impact damage" },
  "e1u1/damage1_2": { material: "metal", why: "riveted steel wall carrying impact damage" },
  "e1u1/dr02_1": { material: "tech", why: "steel door with a vent grille; tech by the dr0 name" },
  "e1u1/dr04_1": { material: "tech", why: "steel door with inset vents; tech by the dr0 name" },
  "e1u1/endsign2": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/endsign3": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/endsign5": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/endsign6": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/exit1": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/exitdr01_1": { material: "tech", why: "exit-door mechanism: the tech list names exitdr; 'exit' hits the sign rule first" },
  "e1u1/exitdr01_2": { material: "tech", why: "exit-door mechanism: the tech list names exitdr; 'exit' hits the sign rule first" },
  "e1u1/flat1_1": { material: "stone", why: "dark floor slab (flat1 is a floor, not the flat recipe)" },
  "e1u1/flat1_2": { material: "stone", why: "dark floor slab (flat1 is a floor, not the flat recipe)" },
  "e1u1/floor3_1": { material: "metal", why: "diamond-tread steel floor plate" },
  "e1u1/floor3_2": { material: "stone", why: "rough stone/concrete, name and look agree" },
  "e1u1/floor3_3": { material: "metal", why: "diagonal steel floor grid" },
  "e1u1/florr1_2": { material: "stone", why: "rough stone/concrete, name and look agree" },
  "e1u1/florr1_5": { material: "stone", why: "rough stone/concrete, name and look agree" },
  "e1u1/ggrat12_4": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/ggrat2_1": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/ggrat2_7": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/ggrat4_1": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/ggrat4_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/ggrat4_3": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/ggrat4_4": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/ggrat5_1": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/ggrat5_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/ggrat6_1": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/ggrat6_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/ggrate7_1": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/ggrate8_1": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/ggrate9_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/grass1_7": { material: "organic", why: "mottled grass and dirt, the only vegetation in the set" },
  "e1u1/grate1_1": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/grate1_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/grate1_3": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/grate1_4": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/grate1_5": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/grate1_6": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/grate2_1": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/grate2_2": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/grate2_3": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/grate2_4": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/grate2_5": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/grate2_7": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/grate2_8": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/grnmt1_1": { material: "metal", why: "'green metal' riveted hatch: steel plate, not rock" },
  "e1u1/grnx1_1": { material: "metal", why: "green-painted riveted steel X-brace, not vegetation" },
  "e1u1/grnx1_2": { material: "metal", why: "green-painted riveted steel X-brace, not vegetation" },
  "e1u1/grnx2_1": { material: "metal", why: "riveted steel plate with a central boss, not vegetation" },
  "e1u1/grnx2_2": { material: "metal", why: "riveted steel plate with a central seam, not vegetation" },
  "e1u1/grnx2_3": { material: "metal", why: "riveted steel panel, not vegetation" },
  "e1u1/grnx2_5": { material: "metal", why: "slatted steel vent grille, not vegetation" },
  "e1u1/grnx2_6": { material: "metal", why: "steel grating, not vegetation" },
  "e1u1/grnx2_7": { material: "metal", why: "barred steel vent panel, not vegetation" },
  "e1u1/grnx2_9": { material: "metal", why: "corroded steel patch with olive grime, not grass" },
  "e1u1/grnx3_1": { material: "metal", why: "riveted steel inset panel, not vegetation" },
  "e1u1/grnx3_2": { material: "metal", why: "slotted steel vent panel, not vegetation" },
  "e1u1/grnx3_3": { material: "metal", why: "cross-braced steel grating, not vegetation" },
  "e1u1/kcsign4": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/keydr1_1": { material: "tech", why: "keyed steel door with a red indicator; tech by name" },
  "e1u1/lever3": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/lever8": { material: "sign", why: "text/graphic sign, name and look agree" },
  "e1u1/metal1_2": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/metal1_3": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/metal1_5": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/metal1_7": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/metal1_8": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/metal14_1": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/metal2_1": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/metal2_2": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/metal2_3": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/metal2_4": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/metal3_1": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/metal3_2": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/metal3_3": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/metal3_4": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/metal3_5": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/metal3_6": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/metal3_7": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/metal5_1": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/metal5_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/metal6_1": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/metal6_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/p_tub1_1": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pip01_1": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pip01_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pip01_4": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pip02_1": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pip02_5": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pip02_6": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pip03_4": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pip04_3": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pip04_4": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pip04_5": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pip04_6": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pip05_1": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pipe1_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pipe1_3": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pipe1_4": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/pipe1_5": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/plite1_1": { material: "lamp", why: "white plasma light in a grille" },
  "e1u1/plite1_3": { material: "lamp", why: "white bar light (flag 1)" },
  "e1u1/red1_1": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/red1_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/red1_3": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/rocks16_2": { material: "stone", why: "rough stone/concrete, name and look agree" },
  "e1u1/rocks19_1": { material: "stone", why: "rough stone/concrete, name and look agree" },
  "e1u1/rpip2_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/sewer1": { material: "water", why: "green sludge surface; warp flag 8 and slime contents 16 agree" },
  "e1u1/sky1": { material: "sky", why: "orange sunset sky; flags 4 and the sky name both say sky" },
  "e1u1/support1_1": { material: "rust", why: "corroded steel support beam; its brown passes the rust test at 81%" },
  "e1u1/timpod": { material: "tech", why: "teleport-pod face; tech by family name" },
  "e1u1/timpod2": { material: "tech", why: "teleport-pod face; tech by family name though this side reads as stone" },
  "e1u1/timpod3": { material: "tech", why: "teleport-pod control face with screen and vents" },
  "e1u1/timpod4": { material: "tech", why: "teleport-pod vent face; tech by family name" },
  "e1u1/timpod5": { material: "tech", why: "teleport-pod face; tech by family name" },
  "e1u1/timpod6": { material: "tech", why: "teleport-pod face; tech by family name though this side reads as steel" },
  "e1u1/timpod7": { material: "tech", why: "teleport-pod face; tech by family name though this side reads as rust" },
  "e1u1/timpod8": { material: "tech", why: "teleport-pod face; tech by family name" },
  "e1u1/trigger": { material: "sign", why: "brown 'Trig' text sign: a sign, not a generic wall" },
  "e1u1/watrt1_1": { material: "metal", why: "steel wall-trim panel, not a liquid surface: flags 0, contents 0" },
  "e1u1/watrt1_2": { material: "metal", why: "steel wall-trim panel, not a liquid surface: flags 0, contents 0" },
  "e1u1/watrt2_1": { material: "metal", why: "steel wall-trim panel, not a liquid surface: flags 0, contents 0" },
  "e1u1/watrt3_2": { material: "metal", why: "riveted steel wall-trim panel, not a liquid surface: flags 0, contents 0" },
  "e1u1/wbasic1_1": { material: "stone", why: "rough brown concrete wall" },
  "e1u1/wbasic1_4": { material: "stone", why: "rough brown concrete wall" },
  "e1u1/wbasic1_7": { material: "stone", why: "rough brown concrete wall" },
  "e1u1/wgrate1_1": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/wgrate1_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/wgrate1_3": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/wgrate1_4": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/wgrate1_5": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/wgrate1_6": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/wgrate1_8": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/wmtal3_5": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/wndow0_3": { material: "glass", why: "window surface (contents 2): glass panes in a dark frame" },
  "e1u1/wplat1_1": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/wplat1_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/wslt1_1": { material: "metal", why: "slotted steel vent panel, not stone" },
  "e1u1/wslt1_2": { material: "metal", why: "slotted steel vent panel, not stone" },
  "e1u1/wslt1_3": { material: "metal", why: "slotted steel vent panel, not stone" },
  "e1u1/wslt1_4": { material: "metal", why: "slotted steel vent panel, not stone" },
  "e1u1/wslt1_5": { material: "lamp", why: "short lit slot: flag 1 makes it a lamp" },
  "e1u1/wslt1_6": { material: "lamp", why: "short lit slot: flag 1 makes it a lamp" },
  "e1u1/wsupprt1_14": { material: "lamp", why: "lit support strip: flag 1 makes it a lamp, not a support" },
  "e1u1/wsupprt1_3": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e1u1/wswall1_1": { material: "metal", why: "rusted steel vent wall, not rock" },
  "e1u1/wswall1_2": { material: "metal", why: "rusted steel vent wall, not rock" },
  "e1u1/wtroof1_5": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/wtroof4_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/wtroof4_3": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/wtroof4_5": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/wtroof4_8": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/yellow1_2": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u1/yellow1_4": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u2/basic1_7": { material: "stone", why: "rough stone/concrete, name and look agree" },
  "e1u2/caution1_1": { material: "metal", why: "yellow/black hazard paint over steel: the red hue is paint, so it is not rust" },
  "e1u2/grate1_5": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u2/keydran1_1": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u2/keydran2_1": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u2/metal11_3": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u2/metal13_1": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u2/metal13_3": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u2/metal14_1": { material: "rust", why: "corroded brown steel, name and look agree" },
  "e1u3/flat1_2": { material: "stone", why: "dark floor slab (flat1 is a floor, not the flat recipe)" },
  "e1u3/refdr3_1": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u3/shooter2": { material: "tech", why: "machine/computer panel, name and look agree" },
  "e1u3/slotwl5_5": { material: "stone", why: "rough stone/concrete, name and look agree" },
  "e2u1/grate1_1": { material: "metal", why: "bare/weathered steel, name and look agree" },
  "e2u1/hdoor1_1": { material: "tech", why: "heavy steel door; tech by name" },
  "e2u1/hdoor1_2": { material: "tech", why: "heavy steel door; tech by name" },
  "e2u2/refdr9_3": { material: "tech", why: "machine/computer panel, name and look agree" },
};

// Look the entry up in the reviewed table, then fall back to the rules. The
// returned object is plain data; callers may keep or copy it.
export function materialFor(entry, source = null) {
  const key = materialKey(entry);
  const row = TABLE[key];
  if (row) {
    if (!MATERIAL_SET.has(row.material)) {
      throw new Error('material-classes: TABLE["' + key + '"] names unknown material "' + row.material + '"');
    }
    return { material: row.material, why: row.why, by: "table" };
  }
  const answer = ruleFor(entry, source);
  if (!MATERIAL_SET.has(answer.material)) {
    throw new Error("material-classes: rule produced unknown material " + answer.material);
  }
  return answer;
}

// How many entries fall into each material. Every MATERIALS name is present,
// in MATERIALS order, even when its count is zero; the counts sum to the
// number of entries. A manifest object with an `entries` array is accepted as
// a convenience, as is the array itself.
export function materialCounts(entries) {
  const list = Array.isArray(entries) ? entries : entries && Array.isArray(entries.entries) ? entries.entries : null;
  if (!list) throw new TypeError("materialCounts expects an array of manifest records");
  const counts = {};
  for (const material of MATERIALS) counts[material] = 0;
  for (const entry of list) {
    const { material } = materialFor(entry);
    counts[material]++;
  }
  return counts;
}
