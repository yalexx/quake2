#!/usr/bin/env node
// scripts/material-lib-test.mjs -- the material recipes t4 draws with.
//
//   node scripts/material-lib-test.mjs     # exit 0 pass, 1 fail
//
// Nothing here needs the archive or a browser: applyMaterial is a pure function
// of (base, source, material, seed), so every property the brief asks for can
// be pinned on small synthetic pictures whose answer is known.
//
//   1. the contract. The thirteen names are material-classes.mjs's; `sign`,
//      `water`, `sky` and `flat` return the faithful picture byte for byte; an
//      unknown name is refused rather than silently given a new recipe.
//   2. purity and determinism. The same arguments produce the same bytes, no
//      argument is mutated, and the seed is the only source of variation.
//   3. the source is for the crate question only. A brown or olive crate face
//      takes wood grain, a grey one steel; every other material produces the
//      same bytes whatever source is handed to it.
//   4. the light. One direction for every texture, from the upper left with y
//      down: on a periodic field of bumps the north-west flank is clearly
//      brighter than the south-east flank.
//   5. occlusion and material response. A dark pit is darkened more than the
//      flat paint around it, and stone (up to 35%) more than metal (up to 25%);
//      lamp glows around its bright pixels; glass changes only faintly; grain
//      stays inside +-2-4% (metal +-1.5%).
//   6. tiling. Every blur, gradient and noise wraps, so the step across the
//      wrap edge is no bigger than the busiest step inside the picture.
//   7. colour. Only the base RGB is scaled (and pulled toward its own grey for
//      desaturation): a saturated input keeps its hue within a degree or two.
//   8. per-entry tuning. The optional `params` merge over MATERIAL_PARAMS:
//      none (or {}) is the shipped picture byte for byte, a knob changes it,
//      a bad knob is refused, and desat / bias / grungeDesat do what they say.

import { MATERIALS, UNCHANGED_MATERIALS, applyMaterial, materialSeed } from "./material-lib.mjs";
import { MATERIALS as CONTRACT_MATERIALS } from "./material-classes.mjs";

let failed = 0;
let checked = 0;
function check(what, ok, detail) {
  checked++;
  if (ok) process.stdout.write("  ok   " + what + "\n");
  else {
    failed++;
    process.stdout.write("  FAIL " + what + (detail ? " -- " + detail : "") + "\n");
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function imageOf(width, height, pixel) {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const at = (y * width + x) * 3;
      rgb[at] = r;
      rgb[at + 1] = g;
      rgb[at + 2] = b;
    }
  }
  return { width, height, rgb };
}

// A smoothly shaded, exactly periodic base: every wave has a whole number of
// cycles across the picture, so the tile closes at every edge.
function periodicBase(width = 64, height = 64) {
  return imageOf(width, height, (x, y) => {
    const u = x / width;
    const v = y / height;
    const wave =
      0.5 +
      0.18 * Math.sin(2 * Math.PI * u * 2) +
      0.14 * Math.cos(2 * Math.PI * v * 3) +
      0.08 * Math.sin(2 * Math.PI * (u * 3 + v * 2));
    const k = 0.7 + 0.5 * wave;
    return [Math.round(150 * k), Math.round(110 * k), Math.round(80 * k)];
  });
}

function solidBase(value, width = 64, height = 64, tint = [1, 1, 1]) {
  return imageOf(width, height, () => [Math.round(value * tint[0]), Math.round(value * tint[1]), Math.round(value * tint[2])]);
}

function solidSource(r, g, b, width = 16, height = 16) {
  return imageOf(width, height, () => [r, g, b]);
}

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
const wrapIndex = (v, n) => ((v % n) + n) % n;

function meanLuminance(image) {
  let sum = 0;
  for (let at = 0; at < image.rgb.length; at += 3) sum += luma(image.rgb[at], image.rgb[at + 1], image.rgb[at + 2]);
  return sum / (image.rgb.length / 3);
}

function pixelLuminance(image, x, y) {
  const at = (wrapIndex(y, image.height) * image.width + wrapIndex(x, image.width)) * 3;
  return luma(image.rgb[at], image.rgb[at + 1], image.rgb[at + 2]);
}

function meanChannel(image) {
  const n = image.rgb.length / 3;
  const sum = [0, 0, 0];
  for (let at = 0; at < image.rgb.length; at += 3) {
    sum[0] += image.rgb[at];
    sum[1] += image.rgb[at + 1];
    sum[2] += image.rgb[at + 2];
  }
  return sum.map((value) => value / n);
}

function hueOf(r, g, b) {
  const red = r / 255;
  const green = g / 255;
  const blue = b / 255;
  const high = Math.max(red, green, blue);
  const low = Math.min(red, green, blue);
  const delta = high - low;
  if (delta === 0) return 0;
  let hue;
  if (high === red) hue = ((green - blue) / delta) % 6;
  else if (high === green) hue = (blue - red) / delta + 2;
  else hue = (red - green) / delta + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

function hueDistance(a, b) {
  const distance = Math.abs(a - b) % 360;
  return distance > 180 ? 360 - distance : distance;
}

// The average step across the wrap edge, against the sharpest step anywhere
// inside. A wrapped recipe's seam is just another interior edge, so it can
// never be the sharpest transition in the picture; an unwrapped one cuts a
// fresh boundary that no interior edge matches. Averaging the seam over the
// whole side (rather than looking at one row) keeps single noisy pixels from
// deciding the answer, and the sharpest interior step is a hard ceiling rather
// than a statistical guess.
function seamProfile(image) {
  const { width: W, height: H, rgb } = image;
  const step = (a, b) => (Math.abs(rgb[a] - rgb[b]) + Math.abs(rgb[a + 1] - rgb[b + 1]) + Math.abs(rgb[a + 2] - rgb[b + 2])) / 3;
  let seamX = 0;
  let maxX = 0;
  for (let y = 0; y < H; y++) {
    const row = y * W;
    seamX += step((row + W - 1) * 3, row * 3);
    for (let x = 0; x < W - 1; x++) maxX = Math.max(maxX, step((row + x) * 3, (row + x + 1) * 3));
  }
  let seamY = 0;
  let maxY = 0;
  for (let x = 0; x < W; x++) {
    seamY += step(((H - 1) * W + x) * 3, x * 3);
    for (let y = 0; y < H - 1; y++) maxY = Math.max(maxY, step((y * W + x) * 3, ((y + 1) * W + x) * 3));
  }
  return { seamX: seamX / H, seamY: seamY / W, maxX, maxY };
}

// ---------------------------------------------------------------------------
// 1. The contract
// ---------------------------------------------------------------------------
process.stdout.write("the contract\n");
check("MATERIALS is material-classes.mjs's exact thirteen", MATERIALS === CONTRACT_MATERIALS && MATERIALS.length === 13, MATERIALS.join(","));
check("MATERIALS cannot be renamed", Object.isFrozen(MATERIALS));
check("the four faithful materials are the brief's", UNCHANGED_MATERIALS.join(",") === "sign,water,sky,flat" && Object.isFrozen(UNCHANGED_MATERIALS));
check("an unknown material is refused, not given a recipe", (() => {
  try {
    applyMaterial(periodicBase(16, 16), null, "plastic", { seed: 1 });
    return false;
  } catch (error) {
    return error instanceof TypeError && /unknown material/.test(error.message);
  }
})());
check("a bad base is refused", (() => {
  try {
    applyMaterial({ width: 4, height: 4, rgb: new Uint8Array(10) }, null, "stone", { seed: 1 });
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
})());
check("a non-finite seed is refused", (() => {
  try {
    applyMaterial(periodicBase(16, 16), null, "stone", { seed: NaN });
    return false;
  } catch (error) {
    return error instanceof TypeError;
  }
})());
check("the result is exactly { width, height, rgb }", (() => {
  const out = applyMaterial(periodicBase(16, 16), null, "stone", { seed: 1 });
  return Object.keys(out).sort().join(",") === "height,rgb,width" && out.rgb instanceof Uint8Array && out.rgb.length === out.width * out.height * 3;
})());

// ---------------------------------------------------------------------------
// 2. The faithful materials return the faithful picture
// ---------------------------------------------------------------------------
process.stdout.write("\nfaithful materials\n");
const faithfulBase = periodicBase(48, 32);
const faithfulCopy = Uint8Array.from(faithfulBase.rgb);
for (const material of UNCHANGED_MATERIALS) {
  const out = applyMaterial(faithfulBase, solidSource(120, 90, 60), material, { seed: 99 });
  check(material + " returns the base unchanged", out.width === faithfulBase.width && out.height === faithfulBase.height && out.rgb.length === faithfulBase.rgb.length && out.rgb.every((value, i) => value === faithfulBase.rgb[i]));
  check(material + " returns a copy, not the caller's array", out.rgb !== faithfulBase.rgb);
}
check("the faithful materials leave the base untouched", faithfulBase.rgb.every((value, i) => value === faithfulCopy[i]));

// ---------------------------------------------------------------------------
// 3. Determinism, purity, and the seed
// ---------------------------------------------------------------------------
process.stdout.write("\ndeterminism and purity\n");
const seedBase = periodicBase(64, 48);
const seedSource = solidSource(150, 100, 50);
const seedBaseCopy = Uint8Array.from(seedBase.rgb);
const seedSourceCopy = Uint8Array.from(seedSource.rgb);
const first = applyMaterial(seedBase, seedSource, "stone", { seed: materialSeed("textures/e1u1/rocks19_1.wal") });
const second = applyMaterial(seedBase, seedSource, "stone", { seed: materialSeed("textures/e1u1/rocks19_1.wal") });
check("the same arguments produce the same bytes", first.rgb.every((value, i) => value === second.rgb[i]));
check("materialSeed is stable and per-name", materialSeed("a") === materialSeed("a") && materialSeed("a") !== materialSeed("b"));
check("no seed means the same default every time", (() => {
  const a = applyMaterial(seedBase, null, "metal");
  const b = applyMaterial(seedBase, null, "metal");
  return a.rgb.every((value, i) => value === b.rgb[i]);
})());
check("a different seed changes the detail", (() => {
  const a = applyMaterial(seedBase, null, "metal", { seed: 1 });
  const b = applyMaterial(seedBase, null, "metal", { seed: 2 });
  return a.rgb.some((value, i) => value !== b.rgb[i]);
})());
check("a string seed and its hash are the same stream", (() => {
  const a = applyMaterial(seedBase, null, "rust", { seed: "textures/e1u1/metal1_3.wal" });
  const b = applyMaterial(seedBase, null, "rust", { seed: materialSeed("textures/e1u1/metal1_3.wal") });
  return a.rgb.every((value, i) => value === b.rgb[i]);
})());
check("the base is not mutated", seedBase.rgb.every((value, i) => value === seedBaseCopy[i]));
check("the source is not mutated", seedSource.rgb.every((value, i) => value === seedSourceCopy[i]));

// ---------------------------------------------------------------------------
// 4. Every material runs, at the base's size
// ---------------------------------------------------------------------------
process.stdout.write("\nshapes\n");
const smallBase = periodicBase(48, 24);
const oddBase = periodicBase(40, 20);
check("all thirteen materials return the base's dimensions", MATERIALS.every((material) => {
  const out = applyMaterial(smallBase, null, material, { seed: 3 });
  return out.width === smallBase.width && out.height === smallBase.height && out.rgb.length === smallBase.rgb.length;
}));
check("a small, odd-sized base works too", (() => {
  const out = applyMaterial(oddBase, null, "organic", { seed: 4 });
  return out.width === 40 && out.height === 20 && out.rgb.length === 40 * 20 * 3;
})());
check("the source's own size is irrelevant to a non-crate material", (() => {
  const a = applyMaterial(seedBase, solidSource(1, 2, 3, 4, 4), "stone", { seed: 5 });
  const b = applyMaterial(seedBase, solidSource(250, 240, 230, 32, 32), "stone", { seed: 5 });
  return a.rgb.every((value, i) => value === b.rgb[i]);
})());

// ---------------------------------------------------------------------------
// 5. The crate question
// ---------------------------------------------------------------------------
process.stdout.write("\ncrates\n");
const crateBase = solidBase(120, 48, 48);
const brownSource = solidSource(150, 100, 50);
const oliveSource = solidSource(110, 120, 60);
const greySource = solidSource(110, 112, 115);
const wooden = applyMaterial(crateBase, brownSource, "crate", { seed: 8 });
const olive = applyMaterial(crateBase, oliveSource, "crate", { seed: 8 });
const steel = applyMaterial(crateBase, greySource, "crate", { seed: 8 });
const noSource = applyMaterial(crateBase, null, "crate", { seed: 8 });
const sameBytes = (a, b) => a.rgb.every((value, i) => value === b.rgb[i]);
check("brown and olive crate faces take the same wood recipe", sameBytes(wooden, olive));
check("a grey crate face takes a different (metal) recipe", !sameBytes(wooden, steel));
check("a crate with no source falls back to the metal recipe", sameBytes(steel, noSource));

// ---------------------------------------------------------------------------
// 6. One light, from the upper left
// ---------------------------------------------------------------------------
process.stdout.write("\nthe light\n");
// Periodic Gaussian bumps on a mid grey. The base is symmetric about each bump,
// so any brightness difference between the north-west and south-east flanks
// comes from the shading the material applies.
const BUMP_W = 96;
const BUMP_H = 96;
const bumpCenters = [];
for (let by = 0; by < 3; by++) for (let bx = 0; bx < 3; bx++) bumpCenters.push([(bx + 0.5) * BUMP_W / 3, (by + 0.5) * BUMP_H / 3]);
const wrapDelta = (d, n) => {
  const wrapped = ((d % n) + n) % n;
  return wrapped > n / 2 ? wrapped - n : wrapped;
};
const bumpBase = imageOf(BUMP_W, BUMP_H, (x, y) => {
  let bump = 0;
  for (const [cx, cy] of bumpCenters) {
    const dx = wrapDelta(x - cx, BUMP_W);
    const dy = wrapDelta(y - cy, BUMP_H);
    bump += Math.exp(-(dx * dx + dy * dy) / (2 * 5 * 5));
  }
  const value = 90 + 90 * Math.min(1, bump);
  return [clampByte(value), clampByte(value * 0.9), clampByte(value * 0.75)];
});
function flankMeans(image) {
  let northWest = 0;
  let southEast = 0;
  let count = 0;
  for (const [cx, cy] of bumpCenters) {
    for (const [ox, oy] of [[-4, -4], [4, 4], [-5, -3], [5, 3], [-3, -5], [3, 5]]) {
      const value = pixelLuminance(image, Math.round(cx + ox), Math.round(cy + oy));
      if (ox < 0 && oy < 0) northWest += value;
      else southEast += value;
      count++;
    }
  }
  return { northWest: northWest / (count / 2), southEast: southEast / (count / 2) };
}
for (const material of ["stone", "metal", "rust", "tech", "crate", "wood", "organic"]) {
  const out = applyMaterial(bumpBase, greySource, material, { seed: 17 });
  const { northWest, southEast } = flankMeans(out);
  check(material + " is lit from the upper left", northWest > southEast * 1.15, "NW " + northWest.toFixed(1) + " SE " + southEast.toFixed(1));
}

// ---------------------------------------------------------------------------
// 7. Cavity: crevices darken, flats do not
// ---------------------------------------------------------------------------
process.stdout.write("\nocclusion\n");
const PIT_W = 96;
const PIT_H = 96;
const pitCenters = [];
for (let by = 0; by < 3; by++) for (let bx = 0; bx < 3; bx++) pitCenters.push([(bx + 0.5) * PIT_W / 3, (by + 0.5) * PIT_H / 3]);
const pitBase = imageOf(PIT_W, PIT_H, (x, y) => {
  let isPit = false;
  for (const [cx, cy] of pitCenters) {
    const dx = wrapDelta(x - cx, PIT_W);
    const dy = wrapDelta(y - cy, PIT_H);
    if (dx * dx + dy * dy < 9) isPit = true;
  }
  const value = isPit ? 60 : 140;
  return [value, value, value];
});
function cavityRatios(out) {
  let pitRatio = 0;
  let pitCount = 0;
  let flatRatio = 0;
  let flatCount = 0;
  for (let y = 0; y < PIT_H; y++) {
    for (let x = 0; x < PIT_W; x++) {
      const at = (y * PIT_W + x) * 3;
      const before = luma(pitBase.rgb[at], pitBase.rgb[at + 1], pitBase.rgb[at + 2]);
      const after = luma(out.rgb[at], out.rgb[at + 1], out.rgb[at + 2]);
      let isPit = false;
      for (const [cx, cy] of pitCenters) {
        if (wrapDelta(x - cx, PIT_W) ** 2 + wrapDelta(y - cy, PIT_H) ** 2 < 1) isPit = true;
      }
      if (isPit) {
        pitRatio += after;
        pitCount++;
      } else if (before > 130) {
        flatRatio += after;
        flatCount++;
      }
    }
  }
  return { pit: pitRatio / pitCount / 60, flat: flatRatio / flatCount / 140 };
}
const stonePits = cavityRatios(applyMaterial(pitBase, null, "stone", { seed: 21 }));
const metalPits = cavityRatios(applyMaterial(pitBase, null, "metal", { seed: 21 }));
check("a crevice is darkened more than flat paint", stonePits.pit < stonePits.flat * 0.9, JSON.stringify(stonePits));
check("flat paint keeps its level (AO stays in the crevices)", stonePits.flat > 0.94, JSON.stringify(stonePits));
check("stone darkens crevices more than metal (35% vs 25%)", 1 - stonePits.pit > 1 - metalPits.pit, JSON.stringify({ stone: stonePits.pit, metal: metalPits.pit }));

// ---------------------------------------------------------------------------
// 8. Lamp glow and glass reflection
// ---------------------------------------------------------------------------
process.stdout.write("\nlamp and glass\n");
// Four bright spots on a dim wall. The pixel just outside a spot must be lifted
// relative to an equally dark pixel far from every spot; that falloff is the
// glow. A pure black wall would stay black because the glow scales the wall's
// own light, so the fixture is given a dim surface to bloom onto.
const GLOW_W = 96;
const GLOW_H = 96;
const glowCenters = [[24, 24], [72, 24], [24, 72], [72, 72]];
const glowBase = imageOf(GLOW_W, GLOW_H, (x, y) => {
  let bright = 40;
  for (const [cx, cy] of glowCenters) {
    const dx = x - cx;
    const dy = y - cy;
    if (dx * dx + dy * dy < 25) bright = 250;
  }
  return [bright, bright, Math.round(bright * 0.9)];
});
const glowOut = applyMaterial(glowBase, null, "lamp", { seed: 31 });
const nearGlow = pixelLuminance(glowOut, 30, 24);
const farGlow = pixelLuminance(glowOut, 4, 4);
check("lamp light blooms onto the surface just outside a bright pixel", nearGlow > farGlow + 2, "near " + nearGlow.toFixed(1) + " far " + farGlow.toFixed(1));

const flatGlass = solidBase(128, 64, 64);
const glassOut = applyMaterial(flatGlass, null, "glass", { seed: 32 });
let glassSum = 0;
let glassMax = 0;
for (let i = 0; i < glassOut.rgb.length; i++) {
  const difference = Math.abs(glassOut.rgb[i] - flatGlass.rgb[i]);
  glassSum += difference;
  glassMax = Math.max(glassMax, difference);
}
check("glass changes the surface only faintly", glassSum / glassOut.rgb.length < 6 && glassMax <= 24, "mean " + (glassSum / glassOut.rgb.length).toFixed(2) + " max " + glassMax);
check("glass does add reflection streaks", glassMax >= 2);

// ---------------------------------------------------------------------------
// 9. Grain stays inside the brief's band
// ---------------------------------------------------------------------------
process.stdout.write("\ngrain\n");
// Lamp is the smooth material: on a flat mid-grey wall it has no relief, no
// cavity and no glow, so everything left is its +-2% grain (and the mean
// guard). Its brightness may not move more than a few levels anywhere.
const flatLamp = solidBase(128, 64, 64);
const lampFlat = applyMaterial(flatLamp, null, "lamp", { seed: 41 });
let lampMaxDeviation = 0;
for (let i = 0; i < lampFlat.rgb.length; i++) lampMaxDeviation = Math.max(lampMaxDeviation, Math.abs(lampFlat.rgb[i] - flatLamp.rgb[i]));
check("a smooth material's grain stays within a few levels", lampMaxDeviation <= 6, "max " + lampMaxDeviation);

// ---------------------------------------------------------------------------
// 10. Tiling: the wrap edge does not stand out
// ---------------------------------------------------------------------------
process.stdout.write("\ntiling\n");
const tileBase = periodicBase(96, 96);
const tileSource = solidSource(150, 100, 50);
for (const material of ["stone", "metal", "rust", "tech", "crate", "wood", "organic", "lamp", "glass"]) {
  let worstX = 0;
  let worstY = 0;
  let ok = true;
  for (const seed of [1, 2]) {
    const out = applyMaterial(tileBase, tileSource, material, { seed });
    const profile = seamProfile(out);
    worstX = Math.max(worstX, profile.seamX);
    worstY = Math.max(worstY, profile.seamY);
    if (profile.seamX > profile.maxX + 0.5 || profile.seamY > profile.maxY + 0.5) ok = false;
  }
  check(material + " tiles: no wrap-edge step beyond its own content", ok, "worst seamX " + worstX.toFixed(2) + " seamY " + worstY.toFixed(2));
}

// ---------------------------------------------------------------------------
// 11. Colour: scale the base, never re-hue it
// ---------------------------------------------------------------------------
process.stdout.write("\ncolour\n");
const HUES = [
  [150, 70, 40], // rust brown
  [90, 120, 60], // olive
  [40, 60, 130], // blue steel
  [120, 120, 120], // grey
];
for (const [r, g, b] of HUES) {
  const colourBase = imageOf(48, 48, () => [r, g, b]);
  const before = hueOf(r, g, b);
  let worst = 0;
  let orderKept = true;
  for (const material of ["stone", "metal", "rust", "tech", "crate", "wood", "organic"]) {
    const out = applyMaterial(colourBase, greySource, material, { seed: 51 });
    const [ar, ag, ab] = meanChannel(out);
    const shift = hueDistance(before, hueOf(ar, ag, ab));
    worst = Math.max(worst, shift);
    if ((r >= g) !== (ar >= ag) || (g >= b) !== (ag >= ab)) orderKept = false;
  }
  check("hue " + before.toFixed(0) + " degrees survives every material", worst <= 6 && orderKept, "worst shift " + worst.toFixed(1));
}
check("the mean brightness stays close to the faithful picture", (() => {
  const base = periodicBase(64, 64);
  const before = meanLuminance(base);
  return ["stone", "metal", "rust", "tech", "crate", "wood", "organic", "lamp", "glass"].every((material) => {
    const out = applyMaterial(base, greySource, material, { seed: 61 });
    return Math.abs(meanLuminance(out) - before) < 2.5;
  });
})());

// ---------------------------------------------------------------------------
// 12. Per-entry tuning. A row's params merge over MATERIAL_PARAMS[material]:
//     no params (or an empty object) reproduces the shipped picture byte for
//     byte, a param does change it, and an unknown knob is refused.
// ---------------------------------------------------------------------------
process.stdout.write("\ntuning\n");
const TUNED = ["stone", "metal", "rust", "tech", "lamp"];
const tuningBase = periodicBase(64, 64);
const tuningSource = solidSource(150, 100, 50);
for (const material of TUNED) {
  const plain = applyMaterial(tuningBase, tuningSource, material, { seed: 71 });
  check(material + ": no params is what the material row draws on its own",
    sameBytes(plain, applyMaterial(tuningBase, tuningSource, material, { seed: 71 })));
  check(material + ": an empty params object changes nothing",
    sameBytes(plain, applyMaterial(tuningBase, tuningSource, material, { seed: 71, params: {} })));
  check(material + ": a param changes the picture",
    !sameBytes(plain, applyMaterial(tuningBase, tuningSource, material, { seed: 71, params: { grain: 0.5 } })));
}
// The digest below was taken from material-lib.mjs as it stood before the
// params option existed: the shipped rows must stay byte for byte the same.
const TUNING_DIGEST = 0x2ae8727;
function tuningDigest() {
  let hash = 0x811c9dc5;
  for (const material of TUNED) {
    const bytes = applyMaterial(periodicBase(32, 32), solidSource(120, 110, 100), material, { seed: 3 }).rgb;
    for (const value of bytes) hash = Math.imul(hash ^ value, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
check("the shipped defaults hash to the same bytes as before the params option",
  tuningDigest() === TUNING_DIGEST, "digest 0x" + tuningDigest().toString(16));

let refused = 0;
for (const params of [{ grain2: 0.5 }, { detail: 1 }, { glow: "bright" }, { desat: Number.NaN }, { bias: Infinity }]) {
  try {
    applyMaterial(tuningBase, tuningSource, "stone", { seed: 71, params });
    refused++;
  } catch (error) {
    if (!(error instanceof TypeError)) refused++;
  }
}
check("bad knob rows are refused, not silently ignored", refused === 0, refused + " accepted");

const plainRust = applyMaterial(tuningBase, tuningSource, "rust", { seed: 72 });
const desatRust = applyMaterial(tuningBase, tuningSource, "rust", { seed: 72, params: { desat: 0.2 } });
function meanSpread(image) {
  let sum = 0;
  for (let at = 0; at < image.rgb.length; at += 3) {
    const r = image.rgb[at], g = image.rgb[at + 1], b = image.rgb[at + 2];
    sum += Math.max(r, g, b) - Math.min(r, g, b);
  }
  return sum / (image.rgb.length / 3);
}
check("desat pulls the colour toward its own grey", meanSpread(desatRust) < meanSpread(plainRust) - 0.5,
  meanSpread(plainRust).toFixed(2) + " -> " + meanSpread(desatRust).toFixed(2));

const biasDown = applyMaterial(tuningBase, tuningSource, "stone", { seed: 73, params: { bias: -1 } });
const biasUp = applyMaterial(tuningBase, tuningSource, "stone", { seed: 73, params: { bias: 1 } });
const plainStone = applyMaterial(tuningBase, tuningSource, "stone", { seed: 73 });
check("bias moves the mean by about a level and in the asked direction",
  Math.abs(meanLuminance(plainStone) - meanLuminance(biasDown) - 1) < 0.4 &&
  Math.abs(meanLuminance(biasUp) - meanLuminance(plainStone) - 1) < 0.4,
  [meanLuminance(biasDown), meanLuminance(plainStone), meanLuminance(biasUp)].map((v) => v.toFixed(2)).join(" / "));

const grungeOn = applyMaterial(tuningBase, tuningSource, "rust", { seed: 74 });
const grungeOff = applyMaterial(tuningBase, tuningSource, "rust", { seed: 74, params: { grungeDesat: 0 } });
check("grungeDesat: 0 leaves the grunge colour alone", !sameBytes(grungeOff, grungeOn) &&
  meanSpread(grungeOff) > meanSpread(grungeOn),
  "spread " + meanSpread(grungeOn).toFixed(2) + " -> " + meanSpread(grungeOff).toFixed(2));

process.stdout.write("\n" + (failed ? failed + " of " + checked + " checks FAILED\n" : "all " + checked + " checks passed\n"));
process.exitCode = failed ? 1 : 0;
