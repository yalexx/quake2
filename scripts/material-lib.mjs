#!/usr/bin/env node
// scripts/material-lib.mjs -- give a 4x picture its surface back.
//
// One job: take the faithful 4x enlargement of a Quake 2 WAL
// ({ width, height, rgb } in sRGB, exactly what upscaleImage() returns), treat
// it as a height field derived from its own shading, and light it as a real
// material. Nothing here invents shapes or colours: every result is the input
// colour scaled by a shading factor, so a stone wall stays the same brown and a
// red light stays red. The detail comes from relief, not from paint.
//
//   applyMaterial(base, source, material, { seed }) -> { width, height, rgb }
//
//     base      the 4x sRGB picture from upscaleImage()
//     source    the 1x pristine sRGB picture (only `crate` reads it, to decide
//               whether the face is timber or steel); may be null
//     material  one of the thirteen names material-classes.mjs fixes:
//               stone metal rust tech crate wood organic lamp glass sign water
//               sky flat. An unknown name is an error, never a new recipe.
//     seed      hash of the texture name (materialSeed(name) does that). It is
//               the only randomness: the same arguments always produce the same
//               bytes, so a rebuild reproduces the archive.
//
// `sign`, `water`, `sky` and `flat` are the four materials that mean "keep the
// faithful picture": applyMaterial returns a copy of base untouched.
//
// The pipeline is the one the brief fixes, in this order:
//
//   1. Height. Base luminance minus a wrapped blur is high-pass relief: bright
//      paint and lit edges stand proud, dark grooves sink. It is normalised to
//      its own 2nd-98th percentile band, then each material adds its own
//      tileable micro-structure (ridged fbm and pores on stone, brushed streaks
//      and scratches on metal, pitted crust on rust, warped grain on wood, ...).
//   2. Normals. A wrapped Sobel of that height, lit by ONE fixed light for
//      every texture: L = normalize(-1, -1, 1.3) with y down, i.e. from the
//      upper left. shade = 1 + k * (N.L / Nflat.L - 1).
//   3. Occlusion. Two wrapped cavity radii darken crevices (stone up to 35%,
//      metal up to 25%); convex edges facing the light brighten, and on metal
//      that highlight is a desaturated glint. Metal, crate and tech edges take
//      chipped wear.
//   4. Grunge. Low-frequency fbm gated by cavity, darkening and desaturating by
//      up to 15%, plus faint vertical streaks. Grain of +-2-4% (metal +-1.5%)
//      finishes. Lamp gets a soft glow falloff around its bright pixels; glass
//      gets faint diagonal reflection streaks.
//   5. Colour. Every change is a scale on the base RGB, except the deliberate
//      pull toward the pixel's own luminance for desaturation -- no channel is
//      ever re-hued. A mean-brightness guard then computes one global gain that
//      puts the result's encoded luminance back where the faithful enlargement
//      had it (the first pass balances linear light, up to two more correct the
//      encoded mean, reaching further only when a recipe drifted a long way),
//      so the software renderer's palette mapping sees neither a washed-out nor
//      a neon wall. The guard touches only the mean, never the local relief.
//
// Everything wraps modulo the picture size with integer lattice periods. A
// blur is a wrapped box, a Sobel reads its wrapped neighbours, and every noise
// is sampled from a lattice that wraps at the edge, so the result tiles exactly
// as the original does: no seam is introduced.
//
// Node built-ins only. The tileable lattice fbm/hash helpers are copied from
// scripts/map-art.mjs lines 79-160 rather than imported, because that module's
// CLI runs on import.

import { MATERIALS } from "./material-classes.mjs";

// Re-exported so a caller importing the material recipes also sees the one
// fixed list of names they answer to; material-classes.mjs owns it.
export { MATERIALS };

// The four names that keep the faithful recipe. They are part of the material
// contract, not a separate list a caller can vary.
export const UNCHANGED_MATERIALS = Object.freeze(["sign", "water", "sky", "flat"]);

const MATERIAL_SET = new Set(MATERIALS);
const UNCHANGED_SET = new Set(UNCHANGED_MATERIALS);

// ---------------------------------------------------------------------------
// Colour: sRGB <-> linear light
//
// Relief maths is meaningless on gamma-encoded bytes: a +10 step in sRGB is a
// 40% change in linear light down in the shadows. Decode once, shade in linear,
// encode once at the end (tables, because Math.pow per channel would dominate
// a 270-texture run).
// ---------------------------------------------------------------------------

const SRGB_TO_LINEAR = new Float32Array(256);
for (let value = 0; value < 256; value++) {
  const channel = value / 255;
  SRGB_TO_LINEAR[value] = channel <= 0.04045 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
}

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

// Rec. 709 luminance weights, in linear light. One definition, used for the
// height field, the glow mask and the mean-brightness guard.
const LUMA_R = 0.2126;
const LUMA_G = 0.7152;
const LUMA_B = 0.0722;

// The mean of the 8-bit picture's luminance, in the same 0-255 units the
// texture gates measure (Rec. 601 weights, as hires-art's `luminance()`).
function srgbLuminanceMean(rgb, count) {
  let sum = 0;
  for (let at = 0; at < count * 3; at += 3) sum += 0.299 * rgb[at] + 0.587 * rgb[at + 1] + 0.114 * rgb[at + 2];
  return sum / count;
}

// ---------------------------------------------------------------------------
// Small maths: hashing, seeded rng, tileable lattice noise
//
// Copied from scripts/map-art.mjs lines 79-160 (that module's CLI runs when it
// is imported, so it cannot be imported here). Same algorithm, so the whole
// project's procedural art shares one idea of "seeded and tileable".
// ---------------------------------------------------------------------------

function hash32(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function makeRng(seed) {
  let s = typeof seed === "string" ? hash32(seed) : seed >>> 0;
  return function next() {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp = (v, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const smooth = (t) => t * t * (3 - 2 * t);
const wrap = (v, n) => ((v % n) + n) % n;

// A lattice of random values that wraps at px by py, so noise sampled over the
// whole texture meets itself at the edges.
function makeLattice(rng, px, py) {
  const g = new Float32Array(px * py);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return g;
}

// Bilinear resample of a wrapped field onto a larger wrapped grid. Both grids
// repeat at their own width, so the result is periodic like its source. This
// is how the procedural structure gets its frequency content without paying
// for lattice lookups on every one of the 420 million base pixels the full set
// would otherwise cost.
function upsampleWrapped(field, sourceW, sourceH, W, H) {
  if (sourceW === W && sourceH === H) return field;
  const out = new Float32Array(W * H);
  const x0 = new Int32Array(W);
  const x1 = new Int32Array(W);
  const fx = new Float32Array(W);
  for (let x = 0; x < W; x++) {
    const s = ((x + 0.5) / W) * sourceW - 0.5;
    const cell = Math.floor(s);
    x0[x] = wrap(cell, sourceW);
    x1[x] = wrap(cell + 1, sourceW);
    fx[x] = s - cell;
  }
  const y0 = new Int32Array(H);
  const y1 = new Int32Array(H);
  const fy = new Float32Array(H);
  for (let y = 0; y < H; y++) {
    const s = ((y + 0.5) / H) * sourceH - 0.5;
    const cell = Math.floor(s);
    y0[y] = wrap(cell, sourceH);
    y1[y] = wrap(cell + 1, sourceH);
    fy[y] = s - cell;
  }
  for (let y = 0; y < H; y++) {
    const row = y * W;
    const r0 = y0[y] * sourceW;
    const r1 = y1[y] * sourceW;
    const t = fy[y];
    for (let x = 0; x < W; x++) {
      const a = field[x0[x] + r0];
      const b = field[x1[x] + r0];
      const c = field[x0[x] + r1];
      const d = field[x1[x] + r1];
      const top = a + (b - a) * fx[x];
      const bottom = c + (d - c) * fx[x];
      out[row + x] = top + (bottom - top) * t;
    }
  }
  return out;
}

// The lattice fBm itself, at the given grid size.
function fbmGrid(W, H, seed, options) {
  const { octaves, px, py, gain, ridged } = options;
  const rng = makeRng(seed);
  const layers = [];
  let lx = Math.max(1, Math.round(px));
  let ly = Math.max(1, Math.round(py));
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    const x0 = new Int32Array(W);
    const x1 = new Int32Array(W);
    const fx = new Float32Array(W);
    for (let x = 0; x < W; x++) {
      const s = (x / W) * lx;
      const cell = Math.floor(s);
      x0[x] = wrap(cell, lx);
      x1[x] = wrap(cell + 1, lx);
      fx[x] = smooth(s - cell);
    }
    const y0 = new Int32Array(H);
    const y1 = new Int32Array(H);
    const fy = new Float32Array(H);
    for (let y = 0; y < H; y++) {
      const s = (y / H) * ly;
      const cell = Math.floor(s);
      y0[y] = wrap(cell, ly);
      y1[y] = wrap(cell + 1, ly);
      fy[y] = smooth(s - cell);
    }
    layers.push({ g: makeLattice(rng, lx, ly), px: lx, x0, x1, fx, y0, y1, fy, amp });
    total += amp;
    amp *= gain;
    lx *= 2;
    ly *= 2;
  }
  const out = new Float32Array(W * H);
  // One pass per octave: the accumulator is a plain Float32Array read and
  // written in scan order, which is much friendlier than walking an array of
  // layer objects once per pixel.
  for (let i = 0; i < layers.length; i++) {
    const layer = layers[i];
    const g = layer.g;
    const lpx = layer.px;
    const amp = layer.amp;
    const lx0 = layer.x0;
    const lx1 = layer.x1;
    const lfx = layer.fx;
    const ly0 = layer.y0;
    const ly1 = layer.y1;
    const lfy = layer.fy;
    for (let y = 0; y < H; y++) {
      const row = y * W;
      const r0 = ly0[y] * lpx;
      const r1 = ly1[y] * lpx;
      const t = lfy[y];
      for (let x = 0; x < W; x++) {
        const a = g[lx0[x] + r0];
        const b = g[lx1[x] + r0];
        const c = g[lx0[x] + r1];
        const d = g[lx1[x] + r1];
        const top = a + (b - a) * lfx[x];
        const bottom = c + (d - c) * lfx[x];
        const n = top + (bottom - top) * t;
        out[row + x] += amp * (ridged ? 1 - Math.abs(2 * n - 1) : n);
      }
    }
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// fBm in [0,1], tileable in both axes. px/py are the lattice periods of the
// first octave, so a large px with a small py gives features stretched along
// that axis -- wood grain, brushed metal, vertical grime.
//
// At a 4x base the structure is generated on a half-resolution grid and
// upsampled: the lattice keeps the same number of cells across the picture, so
// the frequency layout is unchanged, but the per-corner work is a quarter of
// what a full 4x grid would cost. The base's own relief and the grain above it
// are still computed at full resolution, so nothing at pixel scale is lost.
function fbmField(W, H, seed, options = {}) {
  const { octaves = 4, px = 4, py = 4, gain = 0.5, ridged = false } = options;
  const settings = { octaves, px, py, gain, ridged };
  const gridW = W >= 64 ? Math.max(1, Math.ceil(W / 2)) : W;
  const gridH = H >= 64 ? Math.max(1, Math.ceil(H / 2)) : H;
  return upsampleWrapped(fbmGrid(gridW, gridH, seed, settings), gridW, gridH, W, H);
}

// Per-pixel white noise in [0,1), keyed on the wrapped coordinate. Because the
// picture only ever repeats at x + W, sampling coordinates 0..W-1 makes the
// field periodic by construction; the wrap edge is as uncorrelated as any other
// neighbouring pair, which is exactly what grain should look like.
function noiseField(W, H, seed) {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
      h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
      out[y * W + x] = ((h ^ (h >>> 16)) >>> 0) / 4294967296;
    }
  }
  return out;
}

// A stable independent stream per purpose: every field gets its own seed
// without weakening determinism.
function mixSeed(seed, salt) {
  let h = (seed ^ Math.imul(salt | 0, 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function smoothstep(edge0, edge1, value) {
  if (edge1 <= edge0) return value < edge0 ? 0 : 1;
  const t = clamp((value - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Wrapped filters
// ---------------------------------------------------------------------------

// A box blur with wrapped edges, run twice (horizontal + vertical, then again)
// which is close enough to a Gaussian for relief and costs O(pixels) at any
// radius. `radius` is in pixels; radius 0 copies the field.
function boxBlurWrapped(field, W, H, radius, passes = 2) {
  const r = Math.max(0, Math.round(radius));
  if (r === 0) return Float32Array.from(field);
  const size = 2 * r + 1;
  let a = Float32Array.from(field);
  const b = new Float32Array(W * H);
  // The two wrapped neighbours the sliding window adds and drops, as index
  // tables: the radius is always smaller than the axis, so one conditional
  // wrap is enough and the inner loop does no modulo at all.
  const addX = new Int32Array(W);
  const dropX = new Int32Array(W);
  for (let x = 0; x < W; x++) {
    const add = x + r + 1;
    const drop = x - r;
    addX[x] = add >= W ? add - W : add;
    dropX[x] = drop < 0 ? drop + W : drop;
  }
  const addY = new Int32Array(H);
  const dropY = new Int32Array(H);
  for (let y = 0; y < H; y++) {
    const add = y + r + 1;
    const drop = y - r;
    addY[y] = add >= H ? add - H : add;
    dropY[y] = drop < 0 ? drop + H : drop;
  }
  for (let pass = 0; pass < passes; pass++) {
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let sum = 0;
      for (let d = -r; d <= r; d++) sum += a[row + (d < 0 ? d + W : d)];
      for (let x = 0; x < W; x++) {
        b[row + x] = sum / size;
        sum += a[row + addX[x]] - a[row + dropX[x]];
      }
    }
    for (let x = 0; x < W; x++) {
      let sum = 0;
      for (let d = -r; d <= r; d++) sum += b[(d < 0 ? d + H : d) * W + x];
      for (let y = 0; y < H; y++) {
        a[y * W + x] = sum / size;
        sum += b[addY[y] * W + x] - b[dropY[y] * W + x];
      }
    }
  }
  return a;
}

// 2nd and 98th percentiles, the band the height field is normalised into. A
// 4096-bin histogram is O(pixels) and finer than the eye can resolve in a
// height range; sorting a million floats per texture was the other hot spot.
const PERCENTILE_BINS = 4096;
function percentileBand(field) {
  let low = Infinity;
  let high = -Infinity;
  for (let i = 0; i < field.length; i++) {
    const value = field[i];
    if (value < low) low = value;
    if (value > high) high = value;
  }
  if (!(high > low)) return { low, high };
  const scale = (PERCENTILE_BINS - 1) / (high - low);
  const histogram = new Uint32Array(PERCENTILE_BINS);
  for (let i = 0; i < field.length; i++) histogram[((field[i] - low) * scale) | 0]++;
  const at = (fraction) => {
    const target = fraction * (field.length - 1);
    let seen = 0;
    for (let bin = 0; bin < PERCENTILE_BINS; bin++) {
      seen += histogram[bin];
      if (seen > target) return low + ((bin + 0.5) / (PERCENTILE_BINS - 1)) * (high - low);
    }
    return high;
  };
  return { low: at(0.02), high: at(0.98) };
}

// Wrapped Sobel gradient of a height field. The kernel is divided by 8 so the
// value is a per-pixel slope, and the result is the raw slope: the caller
// scales it into normal units, so one gradient can serve the normals and the
// edge-wear mask.
function sobelGradient(field, W, H) {
  const gx = new Float32Array(W * H);
  const gy = new Float32Array(W * H);
  const left = new Int32Array(W);
  const right = new Int32Array(W);
  for (let x = 0; x < W; x++) {
    left[x] = x === 0 ? W - 1 : x - 1;
    right[x] = x === W - 1 ? 0 : x + 1;
  }
  for (let y = 0; y < H; y++) {
    const up = (y === 0 ? H - 1 : y - 1) * W;
    const mid = y * W;
    const down = (y === H - 1 ? 0 : y + 1) * W;
    for (let x = 0; x < W; x++) {
      const l = left[x];
      const r = right[x];
      const tl = field[up + l];
      const tc = field[up + x];
      const tr = field[up + r];
      const ml = field[mid + l];
      const mr = field[mid + r];
      const bl = field[down + l];
      const bc = field[down + x];
      const br = field[down + r];
      gx[mid + x] = (tr + 2 * mr + br - (tl + 2 * ml + bl)) / 8;
      gy[mid + x] = (bl + 2 * bc + br - (tl + 2 * tc + tr)) / 8;
    }
  }
  return { gx, gy };
}

// ---------------------------------------------------------------------------
// Material height detail
//
// Each field returns a Float32Array of height offsets around zero. Amplitudes
// are in the same units as the normalised base relief (roughly -0.5 .. +0.5),
// so a material's structure reads as strongly as the picture's own shading.
// ---------------------------------------------------------------------------

function stoneDetail(W, H, seed) {
  const ridged = fbmField(W, H, mixSeed(seed, 0x51ed270b), { octaves: 4, px: 4, py: 4, gain: 0.55, ridged: true });
  const grain = fbmField(W, H, mixSeed(seed, 0x9e3779b9), { octaves: 2, px: 12, py: 12, gain: 0.5 });
  // Pores are a second, finer noise read as pits: only its high tail carves.
  const pores = fbmField(W, H, mixSeed(seed, 0x85ebca6b), {
    octaves: 2,
    px: Math.max(6, Math.round(W / 12)),
    py: Math.max(6, Math.round(H / 12)),
    gain: 0.5,
  });
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) {
    let d = (ridged[i] - 0.5) * 0.55 + (grain[i] - 0.5) * 0.14;
    if (pores[i] > 0.74) d -= (pores[i] - 0.74) * 1.4;
    out[i] = d;
  }
  return out;
}

// Sparse thin grooves. Coordinates wrap, so a scratch that runs off the right
// edge comes back on the left and the tile stays seamless.
function addScratches(field, W, H, seed, count) {
  const rng = makeRng(seed);
  for (let n = 0; n < count; n++) {
    const x0 = rng() * W;
    const y0 = rng() * H;
    const angle = (rng() - 0.5) * 0.8; // mostly horizontal, like a brush mark
    const length = (0.15 + rng() * 0.3) * W;
    const depth = 0.18 + rng() * 0.22;
    const steps = Math.max(2, Math.ceil(length));
    for (let step = 0; step < steps; step++) {
      const f = step / steps;
      const x = wrap(Math.round(x0 + Math.cos(angle) * length * f), W);
      const y = wrap(Math.round(y0 + Math.sin(angle) * length * f), H);
      const at = y * W + x;
      if (-depth < field[at]) field[at] = -depth;
    }
  }
}

function metalDetail(W, H, seed) {
  // Brushed anisotropic noise: features long in x (px 2) and thin in y
  // (py about H/2), i.e. horizontal brushing with the grain running across.
  const brushed = fbmField(W, H, mixSeed(seed, 0x1b873593), {
    octaves: 3,
    px: 2,
    py: Math.max(24, Math.round(H / 2)),
    gain: 0.5,
  });
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = (brushed[i] - 0.5) * 0.30;
  addScratches(out, W, H, mixSeed(seed, 0x2c1b3c6d), Math.max(3, Math.min(10, Math.round(W / 48))));
  return out;
}

function rustDetail(W, H, seed) {
  const blotch = fbmField(W, H, mixSeed(seed, 0x7f4a7c15), { octaves: 4, px: 4, py: 4, gain: 0.55 });
  const pits = fbmField(W, H, mixSeed(seed, 0x2545f491), { octaves: 2, px: 14, py: 14, gain: 0.5 });
  const crust = fbmField(W, H, mixSeed(seed, 0x2545f492), { octaves: 2, px: 8, py: 8, gain: 0.5 });
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) {
    const patch = smoothstep(0.42, 0.62, blotch[i]);
    let d = (blotch[i] - 0.5) * 0.22 + patch * 0.18 + (crust[i] - 0.5) * 0.05;
    if (pits[i] > 0.68) d -= (pits[i] - 0.68) * 1.2 * patch;
    out[i] = d;
  }
  return out;
}

// Warped, stretched grain. The phase advances 12 times across u and is warped
// by a smooth periodic field, so the bands run down the picture and bend like
// real timber; every term is periodic in u and v, so the tile closes.
function woodDetail(W, H, seed, periods = 12) {
  const warp = fbmField(W, H, mixSeed(seed, 0x3bd39e1f), { octaves: 3, px: 3, py: 2, gain: 0.55 });
  const fine = fbmField(W, H, mixSeed(seed, 0x6a09e667), { octaves: 2, px: 8, py: 8, gain: 0.5 });
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const v = y / H;
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const u = x / W;
      const bend = warp[i] - 0.5;
      const phase = 2 * Math.PI * (u * periods + bend * 1.6) + 0.7 * Math.sin(2 * Math.PI * v * 2 + bend * 3);
      let band = Math.sin(phase);
      band = band < 0 ? -Math.pow(-band, 0.7) : Math.pow(band, 0.7);
      out[i] = band * 0.17 + (fine[i] - 0.5) * 0.06 + bend * 0.08;
    }
  }
  return out;
}

function techDetail(W, H, seed) {
  const panel = fbmField(W, H, mixSeed(seed, 0x510e527f), { octaves: 3, px: 8, py: 8, gain: 0.5 });
  const fine = fbmField(W, H, mixSeed(seed, 0x9b05688c), { octaves: 2, px: 24, py: 24, gain: 0.5 });
  const out = new Float32Array(W * H);
  for (let i = 0; i < out.length; i++) out[i] = (panel[i] - 0.5) * 0.07 + (fine[i] - 0.5) * 0.05;
  return out;
}

// Cellular veins: a wrapped Worley lattice. The difference between the nearest
// and second-nearest feature distance is near zero on a cell boundary, so it
// draws a network of veins; both lattices wrap at the texture edge.
function organicDetail(W, H, seed) {
  const cells = 6;
  const rng = makeRng(mixSeed(seed, 0x1f83d9ab));
  const jitterX = new Float32Array(cells * cells);
  const jitterY = new Float32Array(cells * cells);
  for (let i = 0; i < jitterX.length; i++) {
    jitterX[i] = 0.15 + rng() * 0.7;
    jitterY[i] = 0.15 + rng() * 0.7;
  }
  const fine = fbmField(W, H, mixSeed(seed, 0x5be0cd19), { octaves: 2, px: 14, py: 14, gain: 0.5 });
  const cellW = W / cells;
  const cellH = H / cells;
  const cellSize = Math.min(cellW, cellH);
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = ((x + 0.5) / W) * cells;
      const v = ((y + 0.5) / H) * cells;
      const ci = Math.floor(u);
      const cj = Math.floor(v);
      let nearest = Infinity;
      let second = Infinity;
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const gi = ci + ox;
          const gj = cj + oy;
          const wi = wrap(gi, cells);
          const wj = wrap(gj, cells);
          const feature = wj * cells + wi;
          const pointX = (gi + jitterX[feature]) * cellW;
          const pointY = (gj + jitterY[feature]) * cellH;
          let dx = pointX - (x + 0.5);
          let dy = pointY - (y + 0.5);
          dx -= Math.round(dx / W) * W;
          dy -= Math.round(dy / H) * H;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance < nearest) {
            second = nearest;
            nearest = distance;
          } else if (distance < second) {
            second = distance;
          }
        }
      }
      const edge = second - nearest;
      const vein = 1 - clamp(edge / Math.max(1, cellSize * 0.3));
      out[y * W + x] = (vein - 0.35) * 0.32 + (fine[y * W + x] - 0.5) * 0.06;
    }
  }
  return out;
}

// Per-material response. `detail` picks the structure; `normals` scales the
// Sobel slope into a normal; `shade` is k in the brief's shade formula;
// `ao` is the maximum cavity darkening; `grunge` scales the 15% grime;
// `grain` is the grain amplitude; `edge` is the convex-edge brightening;
// `glint` marks metal, whose highlight is desaturated instead of plain bright;
// `wear` is the chipped-paint strength on edges.
const PROFILES = Object.freeze({
  stone: { detail: "stone", normals: 8.5, shade: 1.15, ao: 0.35, grunge: 1.0, grain: 0.03, edge: 0.16, glint: 0, wear: 0 },
  metal: { detail: "metal", normals: 7.0, shade: 0.85, ao: 0.25, grunge: 0.8, grain: 0.015, edge: 0.10, glint: 1, wear: 1 },
  rust: { detail: "rust", normals: 7.5, shade: 1.05, ao: 0.30, grunge: 1.0, grain: 0.035, edge: 0.14, glint: 0, wear: 0.5 },
  tech: { detail: "tech", normals: 6.0, shade: 0.80, ao: 0.22, grunge: 0.7, grain: 0.02, edge: 0.12, glint: 0, wear: 1 },
  crate: { detail: "crate", normals: 7.0, shade: 0.90, ao: 0.25, grunge: 0.8, grain: 0.025, edge: 0.13, glint: 0, wear: 1 },
  wood: { detail: "wood", normals: 7.0, shade: 0.95, ao: 0.25, grunge: 1.0, grain: 0.03, edge: 0.14, glint: 0, wear: 0.4 },
  organic: { detail: "organic", normals: 7.0, shade: 0.85, ao: 0.28, grunge: 1.0, grain: 0.035, edge: 0.12, glint: 0, wear: 0 },
  lamp: { detail: "smooth", normals: 2.0, shade: 0.30, ao: 0.03, grunge: 0.1, grain: 0.02, edge: 0.05, glint: 0, wear: 0 },
  glass: { detail: "smooth", normals: 2.5, shade: 0.35, ao: 0.10, grunge: 0.4, grain: 0.02, edge: 0.05, glint: 0, wear: 0 },
});

// ---------------------------------------------------------------------------
// The crate question: is the face timber or steel?
// ---------------------------------------------------------------------------

// The share of source pixels that are brown or olive. Brown is the wood hue
// (roughly 20-40 degrees), olive the green timber finish (roughly 60-90); both
// are saturated enough to have a colour at all. A crate whose source is at
// least 35% such pixels gets wood grain, everything else is metal.
const CRATE_WOOD_SHARE = 0.35;

function crateFaceFor(source) {
  if (!source || !source.rgb) return "metal";
  const width = Number(source.width) || 0;
  const height = Number(source.height) || 0;
  const count = width * height;
  if (!count || !source.rgb || source.rgb.length < count * 3) return "metal";
  let brown = 0;
  for (let pixel = 0; pixel < count; pixel++) {
    const at = pixel * 3;
    const r = source.rgb[at] / 255;
    const g = source.rgb[at + 1] / 255;
    const b = source.rgb[at + 2] / 255;
    const high = Math.max(r, g, b);
    const low = Math.min(r, g, b);
    const delta = high - low;
    if (high < 0.08 || delta < 0.03) continue; // too dark or too grey to be timber
    const saturation = delta / high;
    if (saturation < 0.15) continue;
    let hue;
    if (high === r) hue = ((g - b) / delta) % 6;
    else if (high === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
    if (hue >= 15 && hue <= 105) brown++;
  }
  return brown / count >= CRATE_WOOD_SHARE ? "wood" : "metal";
}

// The structure field for one material, or null for the smooth surfaces.
function detailFor(profile, source, W, H, seed) {
  switch (profile.detail) {
    case "stone": return stoneDetail(W, H, seed);
    case "metal": return metalDetail(W, H, seed);
    case "rust": return rustDetail(W, H, seed);
    case "tech": return techDetail(W, H, seed);
    case "wood": return woodDetail(W, H, seed);
    case "organic": return organicDetail(W, H, seed);
    case "crate": return crateFaceFor(source) === "wood" ? woodDetail(W, H, seed, 8) : metalDetail(W, H, seed);
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// The one light
// ---------------------------------------------------------------------------

// Upper left, y down (screen coordinates). Every texture is lit by exactly this
// vector and nothing else, so a set of walls shares one sun.
const LIGHT_RAW = [-1, -1, 1.3];
const LIGHT_LENGTH = Math.sqrt(LIGHT_RAW[0] ** 2 + LIGHT_RAW[1] ** 2 + LIGHT_RAW[2] ** 2);
const LIGHT_X = LIGHT_RAW[0] / LIGHT_LENGTH;
const LIGHT_Y = LIGHT_RAW[1] / LIGHT_LENGTH;
const LIGHT_Z = LIGHT_RAW[2] / LIGHT_LENGTH;
// N.L for the flat normal (0,0,1); the shade formula divides by this so a flat
// surface is exactly 1.0 whatever the light's length.
const LIGHT_FLAT = LIGHT_Z;

// ---------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------

// The seed for a texture name: FNV-1a of the name, so `applyMaterial` is a pure
// function of (base, source, material, name) and a rebuild is byte-identical.
export function materialSeed(name) {
  if (typeof name !== "string") throw new TypeError("materialSeed expects the texture name as a string");
  return hash32(name);
}

function seedOf(seed) {
  if (seed === undefined || seed === null) return 0x9e3779b9;
  if (typeof seed === "string") return hash32(seed);
  const value = Number(seed);
  if (!Number.isFinite(value)) throw new TypeError("applyMaterial: seed must be a string or a finite number");
  return Math.floor(value) >>> 0;
}

// ---------------------------------------------------------------------------
// The main entry point
// ---------------------------------------------------------------------------

function validateImage(image, what) {
  if (!image || typeof image !== "object") throw new TypeError("applyMaterial: " + what + " must be { width, height, rgb }");
  const width = Number(image.width);
  const height = Number(image.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new TypeError("applyMaterial: " + what + " has a bad width/height");
  }
  if (!image.rgb || image.rgb.length !== width * height * 3) {
    throw new TypeError("applyMaterial: " + what + ".rgb is not width x height x 3");
  }
  return { width, height };
}

export function applyMaterial(base, source, material, options = {}) {
  const { width, height } = validateImage(base, "base");
  if (typeof material !== "string" || !MATERIAL_SET.has(material)) {
    throw new TypeError(
      "applyMaterial: unknown material " + JSON.stringify(material) + "; the contract names " + MATERIALS.join(" ")
    );
  }

  // The faithful materials keep the faithful picture. The copy means a caller
  // can draw into the result without touching the base it passed in.
  if (UNCHANGED_SET.has(material)) {
    return { width, height, rgb: Uint8Array.from(base.rgb) };
  }

  const profile = PROFILES[material];
  if (!profile) throw new TypeError("applyMaterial: material " + JSON.stringify(material) + " has no recipe");
  if (source != null) validateImage(source, "source");

  const seed = seedOf(options.seed);
  const count = width * height;

  // -- sRGB base -> linear light, and its luminance ------------------------
  const linear = new Float32Array(count * 3);
  const luma = new Float32Array(count);
  for (let pixel = 0; pixel < count; pixel++) {
    const at = pixel * 3;
    const r = SRGB_TO_LINEAR[base.rgb[at]];
    const g = SRGB_TO_LINEAR[base.rgb[at + 1]];
    const b = SRGB_TO_LINEAR[base.rgb[at + 2]];
    linear[at] = r;
    linear[at + 1] = g;
    linear[at + 2] = b;
    luma[pixel] = LUMA_R * r + LUMA_G * g + LUMA_B * b;
  }

  // -- 1. height -----------------------------------------------------------
  // The picture's own relief: luminance minus a wrapped blur of about an
  // eighth of the short side (about W/8), normalised to the 2nd-98th
  // percentile band so every texture starts with the same working range.
  const shortSide = Math.min(width, height);
  const reliefRadius = Math.max(2, Math.round(shortSide / 8));
  const reliefBlur = boxBlurWrapped(luma, width, height, reliefRadius);
  const relief = new Float32Array(count);
  for (let pixel = 0; pixel < count; pixel++) relief[pixel] = luma[pixel] - reliefBlur[pixel];
  const band = percentileBand(relief);
  const span = Math.max(1e-6, band.high - band.low);

  // A nearly flat picture (a plain painted crate face is only ~0.008 of linear
  // luminance from edge to edge) must not have its own sensor noise stretched
  // into mountains by the percentile normalisation. The relief keeps its full
  // range when the picture has real shading (span 0.02 and over) and is
  // attenuated, never inverted, when it has almost none.
  const reliefScale = clamp(span / 0.02, 0.3, 1);
  const detailScale = 0.6 + 0.4 * reliefScale;

  // The material's own structure, plus micro-height: fine relief that the
  // packer's 4x4 average keeps faint but a 4x PNG shows at close range.
  const detail = detailFor(profile, source, width, height, seed);
  const smoothSurface = profile.detail === "smooth";
  const micro = smoothSurface
    ? null
    : fbmField(width, height, mixSeed(seed, 0x243f6a88), {
        octaves: 2,
        px: Math.max(3, Math.round(width / 8)),
        py: Math.max(3, Math.round(height / 8)),
        gain: 0.5,
      });
  const heightField = new Float32Array(count);
  for (let pixel = 0; pixel < count; pixel++) {
    let h = clamp((relief[pixel] - band.low) / span, 0, 1) * reliefScale;
    if (detail) h += detail[pixel] * detailScale;
    if (micro) h += (micro[pixel] - 0.5) * 0.08 * detailScale;
    heightField[pixel] = h;
  }

  // -- 2. normals and shade ------------------------------------------------
  const { gx, gy } = sobelGradient(heightField, width, height);
  const nDotL = new Float32Array(count);
  for (let pixel = 0; pixel < count; pixel++) {
    const nx = -gx[pixel] * profile.normals;
    const ny = -gy[pixel] * profile.normals;
    const length = Math.sqrt(nx * nx + ny * ny + 1);
    nDotL[pixel] = (nx * LIGHT_X + ny * LIGHT_Y + LIGHT_Z) / length;
  }

  // -- 3. cavity and convex edges -----------------------------------------
  // Two radii: a tight one for pores and chips, a wide one (about W/10) for
  // the broad hollows between stones. A crevice is where the surface sits
  // below its own smooth neighbourhood; a convex edge is where it sits above.
  const cavityNear = boxBlurWrapped(heightField, width, height, Math.max(2, Math.round(shortSide / 32)));
  const cavityFar = boxBlurWrapped(heightField, width, height, Math.max(4, Math.round(shortSide / 10)), 1);
  const cavity = new Float32Array(count);
  const convex = new Float32Array(count);
  for (let pixel = 0; pixel < count; pixel++) {
    const near = clamp((cavityNear[pixel] - heightField[pixel]) * 9);
    const far = clamp((cavityFar[pixel] - heightField[pixel]) * 5);
    cavity[pixel] = clamp(near * 0.65 + far * 0.35);
    convex[pixel] = clamp((heightField[pixel] - cavityNear[pixel]) * 9);
  }

  // -- 4. grunge, grain, glow, glass --------------------------------------
  const lowGrunge = fbmField(width, height, mixSeed(seed, 0x3c6ef372), { octaves: 3, px: 4, py: 4, gain: 0.55 });
  const streaks = fbmField(width, height, mixSeed(seed, 0x5f356495), {
    octaves: 2,
    px: Math.max(8, Math.round(width / 10)),
    py: 2,
    gain: 0.5,
  });
  const grainNoise = noiseField(width, height, mixSeed(seed, 0x6a09e667));
  const grunge = new Float32Array(count);
  for (let pixel = 0; pixel < count; pixel++) {
    const gate = 0.3 + 0.7 * cavity[pixel];
    grunge[pixel] = clamp(lowGrunge[pixel] * gate + 0.45 * streaks[pixel] * (0.4 + 0.6 * cavity[pixel])) * profile.grunge;
  }

  // Chipped wear: paint missing along edges, so it follows the high-frequency
  // gradient and a fine speckle, and it is only on the materials whose edges
  // take knocks.
  const chipNoise = profile.wear > 0 ? noiseField(width, height, mixSeed(seed, 0xbb67ae85)) : null;
  const chip = new Float32Array(count);
  if (chipNoise) {
    for (let pixel = 0; pixel < count; pixel++) {
      const edge = Math.sqrt(gx[pixel] * gx[pixel] + gy[pixel] * gy[pixel]) * 8;
      const speckle = clamp((chipNoise[pixel] - 0.7) / 0.3);
      chip[pixel] = speckle * clamp(edge * 2) * profile.wear;
    }
  }

  // Lamp: bloom around everything bright, two wrapped falloffs (tight core,
  // wide halo). The mask is smoothstepped rather than thresholded, so there is
  // no ring where the glow starts.
  const glow = new Float32Array(count);
  if (material === "lamp") {
    const bright = new Float32Array(count);
    for (let pixel = 0; pixel < count; pixel++) bright[pixel] = smoothstep(0.55, 0.95, luma[pixel]);
    const tight = boxBlurWrapped(bright, width, height, Math.max(2, Math.round(shortSide / 24)));
    const wide = boxBlurWrapped(bright, width, height, Math.max(3, Math.round(shortSide / 8)), 1);
    for (let pixel = 0; pixel < count; pixel++) glow[pixel] = 1.2 * tight[pixel] + 0.7 * wide[pixel];
  }

  // Glass: two families of faint diagonal reflection streaks. The phase
  // frequencies are whole numbers of cycles across the picture, so the streaks
  // meet themselves at the wrap.
  const reflection = new Float32Array(count);
  if (material === "glass") {
    const warp = fbmField(width, height, mixSeed(seed, 0xcbbb9d5d), { octaves: 3, px: 4, py: 4, gain: 0.55 });
    const fine = fbmField(width, height, mixSeed(seed, 0x629a292a), { octaves: 2, px: 6, py: 6, gain: 0.5 });
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pixel = y * width + x;
        const u = x / width;
        const v = y / height;
        const phaseA = 2 * Math.PI * (u * 2 + v * 1) + 2.4 * (warp[pixel] - 0.5);
        const phaseB = 2 * Math.PI * (u * 3 - v * 2) + 2.0 * (fine[pixel] - 0.5);
        // sin^8 and sin^10 by squaring: a glass texture is the one place these
        // run millions of times, and Math.pow would cost more than the rest.
        const sineA = Math.max(0, Math.sin(phaseA));
        const sineB = Math.max(0, Math.sin(phaseB));
        const a2 = sineA * sineA;
        const b2 = sineB * sineB;
        const a4 = a2 * a2;
        const b4 = b2 * b2;
        const streakA = a4 * a4;
        const streakB = b4 * b4 * b2;
        reflection[pixel] = clamp(0.7 * streakA + 0.5 * streakB);
      }
    }
  }

  // -- 5. colour -----------------------------------------------------------
  const out = new Float32Array(count * 3);
  const grainAmplitude = profile.grain;
  for (let pixel = 0; pixel < count; pixel++) {
    const pixelAt = pixel * 3;
    const ndl = nDotL[pixel];
    const facing = clamp((ndl - LIGHT_FLAT) / (1 - LIGHT_FLAT));

    let shade = 1 + profile.shade * (ndl / LIGHT_FLAT - 1);
    shade = clamp(shade, 0.25, 2.2);
    const occlusion = 1 - profile.ao * cavity[pixel];

    let brighten;
    let desaturate = 0.15 * grunge[pixel];
    if (profile.glint) {
      // Metal's convex highlight is a glint: less bright, and pulled toward
      // its own grey so it reads as sheen rather than paint.
      brighten = 0.10 * convex[pixel] * facing;
      desaturate += 0.35 * convex[pixel] * facing;
    } else {
      brighten = profile.edge * convex[pixel] * facing;
    }
    if (profile.wear > 0) {
      brighten += 0.12 * chip[pixel];
      desaturate += 0.45 * chip[pixel];
    }

    const grain = 1 + grainAmplitude * (grainNoise[pixel] * 2 - 1);
    const factor =
      shade *
      occlusion *
      (1 + brighten) *
      (1 - 0.15 * grunge[pixel]) *
      grain *
      (1 + glow[pixel]) *
      (1 + 0.10 * reflection[pixel]);

    const r = linear[pixelAt] * factor;
    const g = linear[pixelAt + 1] * factor;
    const b = linear[pixelAt + 2] * factor;

    // Desaturate toward the pixel's own luminance. This is the only change
    // that is not a plain scale, and it cannot introduce a hue: it moves each
    // channel toward the grey of the same brightness.
    const grey = LUMA_R * r + LUMA_G * g + LUMA_B * b;
    const mix = clamp(desaturate, 0, 0.6);
    out[pixelAt] = r + (grey - r) * mix;
    out[pixelAt + 1] = g + (grey - g) * mix;
    out[pixelAt + 2] = b + (grey - b) * mix;
  }

  // Keep the overall level where the demo put it. The relief and the occlusion
  // move brightness around locally -- that is the point -- but the software
  // renderer's colour mapping was tuned to the original's mean, and a material
  // must not wash the wall out or make it neon. The first gain balances the
  // linear-light mean; because encoding to sRGB is nonlinear, one more
  // correction in the encoded domain brings the visible mean back to the
  // faithful picture's. Only the mean is corrected, never the local structure,
  // so crevices stay dark and edges stay bright.
  let baseMean = 0;
  let outMean = 0;
  for (let pixel = 0; pixel < count; pixel++) {
    baseMean += luma[pixel];
    const at = pixel * 3;
    outMean += LUMA_R * out[at] + LUMA_G * out[at + 1] + LUMA_B * out[at + 2];
  }
  baseMean /= count;
  outMean /= count;
  let gain = baseMean > 1e-6 && outMean > 1e-6 ? clamp(baseMean / outMean, 0.85, 1.15) : 1;

  const rgb = new Uint8Array(count * 3);
  const encode = () => {
    for (let index = 0; index < rgb.length; index++) rgb[index] = linearToByte(out[index] * gain);
  };
  encode();

  const baseSrgbMean = srgbLuminanceMean(base.rgb, count);
  if (baseSrgbMean > 0.5) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const outSrgbMean = srgbLuminanceMean(rgb, count);
      if (!(outSrgbMean > 0.5)) break;
      const correction = clamp(baseSrgbMean / outSrgbMean, 0.75, 1.35);
      if (Math.abs(correction - 1) < 0.004) break;
      gain = clamp(gain * Math.pow(correction, 2.4), 0.55, 2.2);
      encode();
    }
  }

  return { width, height, rgb };
}
