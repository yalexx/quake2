#!/usr/bin/env node
// scripts/map-art.mjs -- new art for the surface textures the maps draw.
//
//   node scripts/map-art.mjs                        # draw every used map texture
//   node scripts/map-art.mjs --list                 # what it would draw, and as what family
//   node scripts/map-art.mjs --only e1u1/metal     # just these entries (substring)
//   node scripts/map-art.mjs --sheet out.png       # contact sheet of the art as drawn
//   node scripts/map-art.mjs --sheet out.png --pairs
//                                                  # ... original | new, side by side
//   node scripts/map-art.mjs --src assets/textures/map
//                                                  # prefer a generated picture when one exists
//
// One PNG per WAL entry that any map in the archive actually draws -- every map
// in the manifest, not just maps/demo1.bsp, because a texture demo2 or demo3
// draws is a surface a player sees the moment that level is loaded. The picture
// is written where scripts/texture-lib.mjs says an entry's art belongs
// (artPathInProject): the archive name with its extension turned into .png,
// under assets/textures.
// scripts/tex-check.mjs then verifies the sizes and scripts/texture-pack.mjs
// re-indexes them onto the archive's own palette -- this tool only has to get
// the picture right, at exactly the entry's dimensions.
//
// Two ways a picture is made:
//
//   from a generated square (--src dir)   A 1024x1024 picture from the box's
//       image generator is the wrong shape for a 64x128 wall, so it is cropped
//       to the entry's aspect, made seamless at the edges, then box-filtered
//       down to exactly the entry's size. Seamlessness matters: a wall texture
//       is repeated across a whole room and a hard edge would show as a grid of
//       lines across the floor. The crop is the middle of the picture and the
//       edge blend continues each border into the pixels that would sit beside
//       it when tiled, so the seam is a soft gradient instead of a cut.
//
//   procedurally                          A seeded recipe chosen from the
//       entry's name -- floor slabs, wall ribs, grating bars, ceiling panels,
//       rock, water, hazard stripes -- drawn at the entry's own size with
//       tileable value-noise fBm, then coloured along a ramp taken from the
//       ORIGINAL texture's own palette usage and nudged back to its mean
//       brightness. That is what keeps a room built out of these tiles looking
//       like the level it was: new structure, same light and same colour family,
//       still inside Quake 2's 256-colour palette.
//
// The art is not written by hand: this tool is the recipe, and it is
// deterministic, so running it again redraws the same pictures.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import {
  DEFAULT_PAK,
  PROJECT_ROOT,
  artPathInProject,
  decodePng,
  decodeWal,
  globalPalette,
  loadPak,
  readManifest,
  readPakFile,
} from "./texture-lib.mjs";

const USAGE = `map-art.mjs -- new art for the surface textures the maps draw

  --list             print the entries and the recipe each one gets, draw nothing
  --only <text>      draw only entries whose name contains <text> (repeatable, comma-splittable)
  --src <dir>        a directory of generated squares, <entry-with-slashes-as-underscores>.png
  --procedural       ignore --src and draw everything procedurally
  --sheet <file>     write a contact sheet of the art to <file> (relative to the project)
  --pairs            with --sheet: draw original next to new for each entry
  --cell <px>        with --sheet: cell size (default 64)
  --force            redraw art that is already there
  --help             this text
`;

// ---------------------------------------------------------------------------
// small maths: hashing, seeded rng, tileable value noise

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
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => t * t * (3 - 2 * t);

// A lattice of random values that wraps at px by py, so noise sampled over the
// whole texture meets itself at the edges: that is what makes a drawn tile
// seamless rather than obviously repeated.
function makeLattice(rng, px, py) {
  const g = new Float32Array(px * py);
  for (let i = 0; i < g.length; i++) g[i] = rng();
  return g;
}

function sampleLattice(g, px, py, x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smooth(x - xi);
  const fy = smooth(y - yi);
  const wrap = (v, p) => ((v % p) + p) % p;
  const at = (a, b) => g[wrap(a, px) + wrap(b, py) * px];
  const a = at(xi, yi);
  const b = at(xi + 1, yi);
  const c = at(xi, yi + 1);
  const d = at(xi + 1, yi + 1);
  return lerp(lerp(a, b, fx), lerp(c, d, fx), fy);
}

// fBm in [0,1], tileable in both axes. px/py are the lattice periods of the
// first octave, so a large px with a small py gives horizontally stretched
// features -- rust streaks, wood grain, water lines.
function fbm(W, H, seed, options = {}) {
  const { octaves = 4, px = 4, py = 4, gain = 0.5, ridged = false } = options;
  const rng = makeRng(seed);
  const layers = [];
  let lx = Math.max(1, Math.round(px));
  let ly = Math.max(1, Math.round(py));
  let amp = 1;
  let total = 0;
  for (let o = 0; o < octaves; o++) {
    layers.push({ g: makeLattice(rng, lx, ly), px: lx, py: ly, amp });
    total += amp;
    amp *= gain;
    lx *= 2;
    ly *= 2;
  }
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = 0;
      for (const layer of layers) {
        const n = sampleLattice(layer.g, layer.px, layer.py, (x / W) * layer.px, (y / H) * layer.py);
        v += layer.amp * (ridged ? 1 - Math.abs(2 * n - 1) : n);
      }
      out[y * W + x] = v / total;
    }
  }
  return out;
}

function perPixelHash(x, y, seed) {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const blank = (W, H) => new Float32Array(W * H);

function add(a, b, scale = 1) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] + b[i] * scale;
  return out;
}

function scaleField(a, s, offset = 0) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] * s + offset;
  return out;
}

function clampField(a, lo = 0, hi = 1) {
  for (let i = 0; i < a.length; i++) a[i] = clamp(a[i], lo, hi);
  return a;
}

// ---------------------------------------------------------------------------
// the picture every recipe produces: a value field, plus masks that pull a
// pixel towards the very darkest or the very brightest colour in the palette.

function makeCanvas(W, H) {
  return { W, H, v: blank(W, H), dark: blank(W, H), glow: blank(W, H) };
}

function paintEdge(canvas, edgePx, depth = 0.35) {
  const { W, H, v, dark } = canvas;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const ex = Math.min(x, W - 1 - x);
      const ey = Math.min(y, H - 1 - y);
      const e = Math.min(ex, ey);
      const f = e < edgePx ? 1 - (e + 0.5) / edgePx : 0;
      if (f > 0) {
        dark[i] = Math.max(dark[i], f);
        v[i] = lerp(v[i], 0.15, f * depth);
      }
    }
  }
  return canvas;
}

// a rectangular tile grid: lit tiles, dark grout between them, a bevel on the
// tile's own edge. `cols`/`rows` are tile counts.
function tileGrid(canvas, cols, rows, gapPx, bevel = 0.22) {
  const { W, H, v, dark, glow } = canvas;
  const tw = W / cols;
  const th = H / rows;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const lx = ((x % tw) + tw) % tw;
      const ly = ((y % th) + th) % th;
      const d = Math.min(lx, tw - 1 - lx, ly, th - 1 - ly);
      if (d < gapPx) {
        const f = 1 - (d + 0.5) / gapPx;
        dark[i] = Math.max(dark[i], 0.55 + 0.45 * f);
        v[i] = lerp(v[i], 0.2, 0.5 * f);
      } else if (d < gapPx + 1.5) {
        glow[i] = Math.max(glow[i], bevel * 0.5);
        v[i] = lerp(v[i], 0.72, bevel * 0.5);
      }
    }
  }
  return canvas;
}

// vertical ribs, as on a steel wall or a pillar
function ribPattern(canvas, count, ribWidthPx, depth = 0.4) {
  const { W, H, v, dark, glow } = canvas;
  const period = W / count;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const lx = ((x % period) + period) % period;
      const centre = period / 2;
      const d = Math.abs(lx - centre);
      if (d < ribWidthPx / 2) {
        glow[i] = Math.max(glow[i], 0.35);
        v[i] = lerp(v[i], 0.66, depth);
      } else {
        const edge = Math.min(d - ribWidthPx / 2, period / 2 - d + ribWidthPx / 2);
        if (edge < 1.5) {
          dark[i] = Math.max(dark[i], 0.6);
          v[i] = lerp(v[i], 0.22, 0.7);
        }
      }
    }
  }
  return canvas;
}

function boltPattern(canvas, stepX, stepY, radius, offsetX = 0, offsetY = 0) {
  const { W, H, v, glow, dark } = canvas;
  for (let cy = offsetY; cy < H + stepY; cy += stepY) {
    for (let cx = offsetX; cx < W + stepX; cx += stepX) {
      for (let y = Math.max(0, Math.floor(cy - radius - 2)); y < Math.min(H, Math.ceil(cy + radius + 2)); y++) {
        for (let x = Math.max(0, Math.floor(cx - radius - 2)); x < Math.min(W, Math.ceil(cx + radius + 2)); x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d > radius + 1.6) continue;
          const i = y * W + x;
          if (d <= radius) {
            v[i] = lerp(v[i], 0.78, 0.55);
            glow[i] = Math.max(glow[i], 0.3 * (1 - d / radius));
          } else {
            dark[i] = Math.max(dark[i], 0.7);
            v[i] = lerp(v[i], 0.25, 0.5);
          }
        }
      }
    }
  }
  return canvas;
}

// ---------------------------------------------------------------------------
// the recipes. Each takes the entry's own size plus its rng and returns a canvas.

const RECIPES = {
  // big floor slabs with grout, grit and stains
  floor(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const cols = Math.max(1, Math.round(W / 32));
    const rows = Math.max(1, Math.round(H / 32));
    const grit = fbm(W, H, seed + "grit", { octaves: 3, px: Math.max(2, Math.round(W / 8)), py: Math.max(2, Math.round(H / 8)) });
    const stain = fbm(W, H, seed + "stain", { octaves: 4, px: 3, py: 3 });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.52 + (grit[i] - 0.5) * 0.5 + (stain[i] - 0.5) * 0.28;
    tileGrid(c, cols, rows, Math.max(1, Math.round(Math.min(W, H) / 32)), 0.3);
    // a darker slab or two, so a whole wall of the tile is not flat
    const odd = fbm(W, H, seed + "odd", { octaves: 1, px: cols, py: rows });
    for (let i = 0; i < W * H; i++) if (odd[i] > 0.68) c.v[i] -= 0.1;
    return c;
  },

  // riveted steel wall
  metal(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const scratch = fbm(W, H, seed + "scratch", { octaves: 4, px: Math.max(2, W / 4), py: 1, gain: 0.55 });
    const rust = fbm(W, H, seed + "rust", { octaves: 4, px: 2, py: Math.max(2, H / 6), gain: 0.6 });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.46 + (scratch[i] - 0.5) * 0.32 + (rust[i] - 0.5) * 0.2;
    const ribs = H >= 64 ? (W >= 96 ? 4 : 2) : 2;
    ribPattern(c, ribs, Math.max(2, Math.round(W / (ribs * 3))), 0.4);
    // a horizontal seam band with bolts along it
    const bandY = Math.round(H * 0.5);
    for (let y = bandY - 1; y <= bandY + 1; y++) {
      for (let x = 0; x < W; x++) {
        const i = ((y + H) % H) * W + x;
        c.v[i] = lerp(c.v[i], 0.3, 0.8);
        c.dark[i] = Math.max(c.dark[i], 0.6);
      }
    }
    boltPattern(c, Math.max(8, Math.round(W / 2)), H >= 64 ? H : H / 2, Math.max(1, Math.min(W, H) / 32), Math.round(W / 4), 3);
    // rust running down from the seam
    for (let y = bandY; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const streak = rust[i] * (1 - (y - bandY) / H);
        if (streak > 0.55) c.v[i] = lerp(c.v[i], 0.28, (streak - 0.55) * 1.4);
      }
    }
    return c;
  },

  // heavy grating: thick bars over a dark void
  grate(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const cells = Math.max(2, Math.round(W / 32));
    const barX = W / cells;
    const barY = H / cells;
    const bar = Math.max(1, Math.round(Math.min(barX, barY) / 3));
    const grain = fbm(W, H, seed + "grain", { octaves: 3, px: Math.max(2, cells * 2), py: Math.max(2, cells * 2) });
    const under = fbm(W, H, seed + "under", { octaves: 4, px: 3, py: 3 });
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const lx = Math.abs(((x % barX) + barX) % barX - barX / 2);
        const ly = Math.abs(((y % barY) + barY) % barY - barY / 2);
        const onBar = lx > barX / 2 - bar || ly > barY / 2 - bar;
        if (onBar) {
          c.v[i] = 0.6 + (grain[i] - 0.5) * 0.4;
          // bar catching the light along its top/left, dark under its lip
          const edge = Math.min(lx - (barX / 2 - bar), ly - (barY / 2 - bar));
          if (edge < 1.2) {
            c.glow[i] = 0.45;
            c.v[i] = lerp(c.v[i], 0.85, 0.6);
          }
        } else {
          c.v[i] = 0.1 + under[i] * 0.22;
          c.dark[i] = 0.85;
        }
      }
    }
    boltPattern(c, barX, barY, Math.max(1, bar), Math.round(barX / 2), Math.round(barY / 2));
    return c;
  },

  rock(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const base = fbm(W, H, seed + "rock", { octaves: 5, px: Math.max(2, Math.round(W / 16)), py: Math.max(2, Math.round(H / 16)), ridged: true });
    const grit = fbm(W, H, seed + "grit", { octaves: 4, px: Math.max(4, W / 2), py: Math.max(4, H / 2) });
    const cracks = fbm(W, H, seed + "crack", { octaves: 3, px: 3, py: 3, ridged: true });
    for (let i = 0; i < W * H; i++) {
      let v = 0.28 + base[i] * 0.62 + (grit[i] - 0.5) * 0.34;
      const crack = 1 - Math.abs(cracks[i] - 0.5) * 2;
      if (crack > 0.86) {
        v *= 0.45;
        c.dark[i] = (crack - 0.86) / 0.14;
      }
      c.v[i] = v;
    }
    return c;
  },

  grass(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const clump = fbm(W, H, seed + "clump", { octaves: 5, px: Math.max(3, W / 8), py: Math.max(3, H / 8) });
    const blade = fbm(W, H, seed + "blade", { octaves: 3, px: Math.max(4, W), py: Math.max(4, H), gain: 0.6 });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.4 + clump[i] * 0.4 + (blade[i] - 0.5) * 0.5;
    return c;
  },

  // grimy organic film on walls -- grnx*, the most-used small texture in the map
  grime(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const blotch = fbm(W, H, seed + "blotch", { octaves: 4, px: Math.max(2, W / 8), py: Math.max(2, H / 8) });
    const fine = fbm(W, H, seed + "fine", { octaves: 3, px: Math.max(3, W / 2), py: Math.max(3, H / 2) });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.42 + blotch[i] * 0.36 + (fine[i] - 0.5) * 0.3;
    return c;
  },

  ceil(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const wide = W >= 32;
    const cols = wide ? Math.max(1, Math.round(W / 32)) : 1;
    const rows = wide ? Math.max(1, Math.round(H / 32)) : 1;
    const dust = fbm(W, H, seed + "dust", { octaves: 3, px: 3, py: 3 });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.5 + (dust[i] - 0.5) * 0.24;
    tileGrid(c, cols, rows, Math.max(1, Math.round(Math.min(W, H) / 16)), 0.34);
    if (W >= 64) {
      // recessed louvre slats along one axis
      const step = Math.max(2, Math.round(H / 8));
      for (let y = 0; y < H; y++) {
        const f = y % step === 0 ? 1 : y % step === 1 ? 0.5 : 0;
        if (!f) continue;
        for (let x = 0; x < W; x++) {
          const i = y * W + x;
          c.v[i] = lerp(c.v[i], 0.3, 0.6 * f);
          c.dark[i] = Math.max(c.dark[i], 0.5 * f);
        }
      }
    }
    return c;
  },

  // pillars, supports, base trim: ribs and a banded foot
  pillar(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const grain = fbm(W, H, seed + "grain", { octaves: 4, px: 2, py: Math.max(4, H / 4) });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.46 + (grain[i] - 0.5) * 0.3;
    ribPattern(c, W >= 64 ? 3 : 2, Math.max(1, Math.round(W / 10)), 0.4);
    const bandH = Math.max(2, Math.round(H / 16));
    for (const at of [Math.round(H * 0.12), Math.round(H * 0.86)]) {
      for (let y = at; y < at + bandH; y++) {
        for (let x = 0; x < W; x++) {
          const i = ((y % H) + H) % H * W + x;
          c.v[i] = lerp(c.v[i], 0.34, 0.75);
          c.dark[i] = Math.max(c.dark[i], 0.5);
        }
      }
    }
    return c;
  },

  // crates and boxes: a bright frame, planks and corner bolts
  crate(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const plank = fbm(W, H, seed + "plank", { octaves: 4, px: Math.max(3, W / 4), py: 2, gain: 0.55 });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.48 + (plank[i] - 0.5) * 0.36;
    const seam = Math.max(1, Math.round(Math.min(W, H) / 24));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const edge = Math.min(x, W - 1 - x, y, H - 1 - y);
        if (edge < seam) {
          c.dark[i] = 0.55;
          c.v[i] = lerp(c.v[i], 0.28, 0.6);
        } else if (Math.abs(x - y) < 1 || Math.abs(x - (W - 1 - y)) < 1) {
          c.v[i] = lerp(c.v[i], 0.68, 0.35);
        }
      }
    }
    boltPattern(c, W - 1, H - 1, Math.max(1, Math.min(W, H) / 24), 1, 1);
    return c;
  },

  // battle damage: pitted metal with impact craters
  broken(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const crackle = fbm(W, H, seed + "crackle", { octaves: 4, px: Math.max(2, W / 6), py: Math.max(2, H / 6), ridged: true });
    const grime = fbm(W, H, seed + "grime", { octaves: 3, px: 3, py: 3 });
    for (let i = 0; i < W * H; i++) {
      const crack = 1 - Math.abs(crackle[i] - 0.5) * 2;
      let v = 0.42 + (grime[i] - 0.5) * 0.3;
      if (crack > 0.78) {
        v = lerp(v, 0.16, (crack - 0.78) / 0.22);
        c.dark[i] = Math.max(c.dark[i], (crack - 0.78) / 0.22);
      }
      c.v[i] = v;
    }
    const holes = Math.max(1, Math.round((W * H) / 1400));
    for (let n = 0; n < holes; n++) {
      const cx = rng() * W;
      const cy = rng() * H;
      const r = 1 + rng() * Math.max(1.5, Math.min(W, H) / 12);
      for (let y = Math.floor(cy - r - 1); y <= cy + r + 1; y++) {
        for (let x = Math.floor(cx - r - 1); x <= cx + r + 1; x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d > r + 1) continue;
          const i = (((y % H) + H) % H) * W + (((x % W) + W) % W);
          if (d <= r) {
            c.v[i] = lerp(c.v[i], 0.12, 0.85);
            c.dark[i] = Math.max(c.dark[i], 0.9);
          } else {
            c.glow[i] = Math.max(c.glow[i], 0.4);
            c.v[i] = lerp(c.v[i], 0.8, 0.5);
          }
        }
      }
    }
    return c;
  },

  // flat tinted panels -- the "color" textures, still flat but no longer dead
  color(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const scuff = fbm(W, H, seed + "scuff", { octaves: 3, px: Math.max(2, W / 6), py: Math.max(2, H / 6) });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.55 + (scuff[i] - 0.5) * 0.18;
    paintEdge(c, Math.max(1, Math.round(Math.min(W, H) / 32)), 0.5);
    return c;
  },

  // doors: two leaves, a stripe, bolts
  door(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const grain = fbm(W, H, seed + "grain", { octaves: 4, px: 3, py: Math.max(4, H / 4) });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.45 + (grain[i] - 0.5) * 0.26;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const mid = Math.abs(x - W / 2);
        if (mid < 1.5) {
          c.dark[i] = 0.85;
          c.v[i] = lerp(c.v[i], 0.2, 0.85);
        } else if (mid < 4) {
          c.glow[i] = 0.4;
          c.v[i] = lerp(c.v[i], 0.72, 0.4);
        }
      }
    }
    const stripeY = Math.round(H * 0.42);
    for (let y = stripeY; y < stripeY + Math.max(2, H / 12); y++) {
      for (let x = 0; x < W; x++) {
        const i = ((y % H) + H) % H * W + x;
        c.glow[i] = Math.max(c.glow[i], 0.35);
        c.v[i] = lerp(c.v[i], 0.6, 0.5);
      }
    }
    boltPattern(c, Math.max(8, W / 2), H, Math.max(1, Math.min(W, H) / 32), 4, 4);
    return c;
  },

  // computer panels: dark plate, rows of lit indicators, no lettering
  computer(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const grime = fbm(W, H, seed + "grime", { octaves: 3, px: 3, py: 3 });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.3 + (grime[i] - 0.5) * 0.2;
    const cols = Math.max(2, Math.round(W / 10));
    const rows = Math.max(3, Math.round(H / 6));
    const cw = W / cols;
    const ch = H / rows;
    for (let r = 0; r < rows; r++) {
      for (let col = 0; col < cols; col++) {
        if (rng() > 0.62) continue;
        const lit = rng();
        for (let y = Math.floor(r * ch + ch * 0.22); y < Math.floor(r * ch + ch * 0.78); y++) {
          for (let x = Math.floor(col * cw + cw * 0.16); x < Math.floor(col * cw + cw * 0.84); x++) {
            const i = (((y % H) + H) % H) * W + (((x % W) + W) % W);
            c.v[i] = lerp(c.v[i], 0.55 + lit * 0.4, 0.85);
            if (lit > 0.7) c.glow[i] = Math.max(c.glow[i], 0.7);
          }
        }
      }
    }
    paintEdge(c, Math.max(1, Math.round(Math.min(W, H) / 24)), 0.45);
    return c;
  },

  // windows: dark glass in a frame, with the mullion cross
  window(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const glass = fbm(W, H, seed + "glass", { octaves: 3, px: 3, py: 3 });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.2 + glass[i] * 0.2;
    const frame = Math.max(1, Math.round(Math.min(W, H) / 24));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const edge = Math.min(x, W - 1 - x, y, H - 1 - y);
        const bar = Math.abs(x - W / 2) < frame / 2 || Math.abs(y - H / 2) < frame / 2;
        if (edge < frame || bar) {
          c.v[i] = lerp(c.v[i], 0.62, 0.85);
          c.glow[i] = Math.max(c.glow[i], 0.25);
        }
      }
    }
    // a couple of pale reflections across the glass
    for (let n = 0; n < 3; n++) {
      const x0 = rng() * W;
      const y0 = rng() * H;
      for (let d = 0; d < Math.max(W, H) / 3; d++) {
        const x = Math.round(x0 + d * 0.6);
        const y = Math.round(y0 + d * 0.6);
        const i = (((y % H) + H) % H) * W + (((x % W) + W) % W);
        c.v[i] = lerp(c.v[i], 0.6, 0.5 * (1 - d / (Math.max(W, H) / 3)));
        c.glow[i] = Math.max(c.glow[i], 0.3);
      }
    }
    return c;
  },

  // churning water: ridged caustics
  water(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const ripple = fbm(W, H, seed + "ripple", { octaves: 4, px: Math.max(3, W / 8), py: Math.max(3, H / 2), ridged: true });
    const swell = fbm(W, H, seed + "swell", { octaves: 3, px: 2, py: 2 });
    for (let i = 0; i < W * H; i++) {
      const v = 0.34 + ripple[i] * 0.42 + (swell[i] - 0.5) * 0.22;
      c.v[i] = v;
      if (v > 0.82) c.glow[i] = (v - 0.82) / 0.18;
    }
    return c;
  },

  // yellow hazard chevrons
  hazard(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const wear = fbm(W, H, seed + "wear", { octaves: 4, px: Math.max(3, W / 6), py: Math.max(3, H / 6) });
    const period = Math.max(6, Math.round(Math.max(W, H) / 3));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const d = ((x + y) % period + period) % period;
        const on = d < period / 2;
        const w = 0.82 + (wear[i] - 0.5) * 0.36;
        c.v[i] = on ? w : 0.16;
        if (!on) c.dark[i] = 0.75;
        else c.glow[i] = 0.35;
      }
    }
    return c;
  },

  // light fittings: a bright panel in a dark frame
  light(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const cx = (W - 1) / 2;
    const cy = (H - 1) / 2;
    const r = Math.min(W, H) / 2;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const d = Math.max(Math.abs(x - cx) / r, Math.abs(y - cy) / r);
        if (d > 1.02) {
          c.dark[i] = 0.8;
          c.v[i] = 0.15;
        } else if (d > 0.82) {
          c.v[i] = 0.42;
          c.dark[i] = 0.35;
        } else {
          c.v[i] = 0.95 - d * 0.16;
          c.glow[i] = 0.9;
        }
      }
    }
    return c;
  },

  // the sky: a bright band of cloud across a darker overhead, drawn so that the
  // dark and the light meet when the tile repeats -- a straight top-to-bottom
  // gradient would put a hard line across the sky the moment it tiles.
  sky(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const cloud = fbm(W, H, seed + "cloud", { octaves: 4, px: Math.max(3, W / 4), py: 3 });
    for (let y = 0; y < H; y++) {
      const phase = y / H;
      const wave = Math.cos(2 * Math.PI * phase);
      const base = 0.44 + 0.3 * wave;
      const cloudDepth = 0.14 + 0.22 * (0.5 + 0.5 * wave);
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        c.v[i] = clamp(base + (cloud[i] - 0.5) * cloudDepth);
      }
    }
    return c;
  },

  // concrete base slab (cgrbase)
  concrete(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const grain = fbm(W, H, seed + "grain", { octaves: 4, px: Math.max(3, W / 8), py: Math.max(3, H / 8) });
    const patch = fbm(W, H, seed + "patch", { octaves: 3, px: 2, py: 2 });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.48 + (grain[i] - 0.5) * 0.4 + (patch[i] - 0.5) * 0.2;
    return c;
  },

  // base wall panel (e1u2/basic1_7)
  panel(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const grain = fbm(W, H, seed + "grain", { octaves: 4, px: Math.max(2, W / 6), py: Math.max(2, H / 6) });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.5 + (grain[i] - 0.5) * 0.34;
    tileGrid(c, Math.max(1, Math.round(W / 32)), Math.max(1, Math.round(H / 32)), Math.max(1, Math.round(Math.min(W, H) / 24)), 0.3);
    return c;
  },

  // the timed pods (timpod..timpod8): one body, a band that walks down the
  // frames, so the engine's animation reads as a light chasing the pod rather
  // than as eight unrelated pictures.
  pod(W, H, rng, seed, frame = 0) {
    const c = makeCanvas(W, H);
    const body = fbm(W, H, seed + "body", { octaves: 3, px: 2, py: 2 });
    const cx = (W - 1) / 2;
    const cy = (H - 1) / 2;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const d = Math.hypot((x - cx) / (W / 2), (y - cy) / (H / 2));
        if (d > 0.94) {
          c.v[i] = 0.16;
          c.dark[i] = 0.8;
        } else {
          c.v[i] = 0.42 + (body[i] - 0.5) * 0.26;
        }
        if (d < 0.72 && d > 0.6) {
          c.v[i] = lerp(c.v[i], 0.3, 0.5);
          c.dark[i] = Math.max(c.dark[i], 0.4);
        }
      }
    }
    const bandH = Math.max(2, Math.round(H / 6));
    const centre = ((frame % 8) / 8) * H;
    for (let y = 0; y < H; y++) {
      // distance taken around the wrap, so the band slides off one edge and back
      // in at the other: the eight frames then read as one light chasing the pod
      let d = Math.abs(y - centre);
      d = Math.min(d, H - d);
      if (d > bandH) continue;
      const strength = 1 - d / bandH;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        c.v[i] = lerp(c.v[i], 0.85, 0.8 * strength);
        c.glow[i] = Math.max(c.glow[i], 0.75 * strength);
      }
    }
    return c;
  },

  // the floor arrow decal
  arrow(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const scratch = fbm(W, H, seed + "scratch", { octaves: 3, px: 4, py: 4 });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.3 + (scratch[i] - 0.5) * 0.2;
    const cx = (W - 1) / 2;
    for (let y = 0; y < H; y++) {
      const t = y / Math.max(1, H - 1);
      const half = t < 0.45 ? (W / 2) * (1 - t / 0.45) * 0.9 + W * 0.06 : W * 0.06;
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        if (Math.abs(x - cx) < half) {
          c.v[i] = lerp(c.v[i], 0.86, 0.85);
          c.glow[i] = 0.6;
        }
      }
    }
    return c;
  },

  // a blank sign plate: frame, plate, corner bolts -- no lettering
  sign(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const wear = fbm(W, H, seed + "wear", { octaves: 4, px: Math.max(3, W / 8), py: Math.max(3, H / 4) });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.52 + (wear[i] - 0.5) * 0.2;
    const frame = Math.max(1, Math.round(Math.min(W, H) / 10));
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const edge = Math.min(x, W - 1 - x, y, H - 1 - y);
        if (edge < frame) {
          c.v[i] = lerp(c.v[i], 0.3, 0.7);
          c.dark[i] = Math.max(c.dark[i], 0.5);
        } else if (edge < frame + 1) {
          c.v[i] = lerp(c.v[i], 0.78, 0.5);
          c.glow[i] = Math.max(c.glow[i], 0.3);
        }
      }
    }
    boltPattern(c, Math.max(4, W - 1), Math.max(4, H - 1), Math.max(1, Math.min(W, H) / 16), 2, 2);
    return c;
  },

  // the trigger texture is never drawn by the renderer; keep its look, add wear
  trigger(W, H, rng, seed) {
    const c = makeCanvas(W, H);
    const grain = fbm(W, H, seed + "grain", { octaves: 3, px: 3, py: 3 });
    for (let i = 0; i < W * H; i++) c.v[i] = 0.34 + (grain[i] - 0.5) * 0.16;
    paintEdge(c, 1, 0.3);
    return c;
  },
};

function recipeFor(name) {
  const base = name.replace(/^.*\//, "").toLowerCase();
  if (/^\+/.test(base)) return null; // animated frame: leave the whole animation alone
  if (base.startsWith("sky")) return "sky";
  if (base === "black") return "black";
  if (base.startsWith("trigger")) return "trigger";
  if (base.startsWith("arrow")) return "arrow";
  if (base.startsWith("kcsign") || base.includes("sign")) return "sign";
  if (base.includes("grat")) return "grate";
  if (base.includes("ceil")) return "ceil";
  if (base.startsWith("light") || base.startsWith("plite") || base.includes("lamp")) return "light";
  if (base.includes("floor") || base.includes("florr") || base.startsWith("flat")) return "floor";
  if (base.startsWith("rock") || base.startsWith("grnmt")) return "rock";
  if (base.includes("water") || base.includes("wter") || base.includes("watrt")) return "water";
  if (base.startsWith("grass")) return "grass";
  if (base.startsWith("grn")) return "grime";
  if (base.startsWith("metal")) return "metal";
  if (base.startsWith("support") || base.startsWith("baselt") || base.includes("pipe")) return "pillar";
  if (base.startsWith("box") || base.startsWith("crate")) return "crate";
  if (base.startsWith("broken") || base.startsWith("damage")) return "broken";
  if (base.startsWith("color")) return "color";
  if (base.startsWith("dr0") || base.startsWith("door")) return "door";
  if (base.startsWith("comp")) return "computer";
  if (base.startsWith("wndow") || base.startsWith("window")) return "window";
  if (base.startsWith("yellow") || base.startsWith("caution")) return "hazard";
  if (base.startsWith("timpod")) return "pod";
  if (base.startsWith("cgrbase")) return "concrete";
  return "panel";
}

// 'black' is a real texture: the level uses it where it wants a black surface.
function blackRecipe(W, H, rng, seed) {
  const c = makeCanvas(W, H);
  const grain = fbm(W, H, seed + "grain", { octaves: 3, px: 2, py: 2 });
  for (let i = 0; i < W * H; i++) c.v[i] = 0.02 + grain[i] * 0.05;
  return c;
}
RECIPES.black = blackRecipe;

// ---------------------------------------------------------------------------
// colour: a ramp out of the palette colours the ORIGINAL texture uses

function paletteRgb(palette, index) {
  return [palette[index * 3], palette[index * 3 + 1], palette[index * 3 + 2]];
}

function luminance(r, g, b) {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

// How the original texture is coloured and how bright it is: the percentile
// colours give the ramp the new picture is coloured along, so a brown wall stays
// brown and a green one green, and mean/std are what the new picture's own mean
// and contrast are anchored to.
function originalStats(orig, palette) {
  const counts = new Map();
  for (const index of orig.indices) counts.set(index, (counts.get(index) ?? 0) + 1);
  const entries = [...counts].map(([index, count]) => ({ index, count, lum: luminance(...paletteRgb(palette, index)) }));
  entries.sort((a, b) => a.lum - b.lum);
  const total = orig.indices.length;
  const pick = (p) => {
    let acc = 0;
    for (const entry of entries) {
      acc += entry.count;
      if (acc >= p * total) return entry.index;
    }
    return entries[entries.length - 1].index;
  };
  let sum = 0;
  let sumSq = 0;
  for (const entry of entries) {
    sum += entry.lum * entry.count;
    sumSq += entry.lum * entry.lum * entry.count;
  }
  const mean = sum / total;
  const std = Math.sqrt(Math.max(0, sumSq / total - mean * mean));
  return {
    dark: paletteRgb(palette, pick(0.08)),
    mid: paletteRgb(palette, pick(0.5)),
    light: paletteRgb(palette, pick(0.92)),
    darkest: paletteRgb(palette, entries[0].index),
    brightest: paletteRgb(palette, entries[entries.length - 1].index),
    mean,
    std,
  };
}

// Pull a picture's mean brightness and its contrast onto the original texture's:
// the level's lighting is baked into how bright these tiles are, so a wall that
// suddenly lights up would change the room it is in, and a tile that comes out
// flatter than the one it replaces reads as an untextured surface. The mean is
// only half matched, so the new art keeps its own look; the contrast is matched
// with a little gain, because a drawn texture wants to read from across a room.
function matchStats(rgb, stats, options = {}) {
  const { meanWeight = 0.5, stdWeight = 0.85, minStd = 0.05, maxStd = 0.15, stdGain = 1.2 } = options;
  if (!stats) return rgb;
  const n = rgb.length / 3;
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < n; i++) {
    const value = luminance(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    sum += value;
    sumSq += value * value;
  }
  const mean = sum / n;
  const std = Math.sqrt(Math.max(0, sumSq / n - mean * mean));
  if (mean <= 0.01) return rgb; // a texture that is meant to be black
  const targetMean = lerp(mean, stats.mean, meanWeight) * 255;
  const targetStd = clamp(stats.std * stdGain, minStd, maxStd) * 255;
  const k = std < 0.004 ? 1 : lerp(1, targetStd / (std * 255), stdWeight);
  for (let i = 0; i < n * 3; i++) rgb[i] = clamp((rgb[i] - mean * 255) * k + targetMean, 0, 255);
  return rgb;
}

function colorize(c, stats, seed) {
  const { W, H, v, dark, glow } = c;
  const rgb = Buffer.alloc(W * H * 3);
  // fBm clusters around its own mean, and a field that never leaves the middle
  // of the ramp comes out flat: spread it over the ramp before colouring.
  let fieldMean = 0;
  for (let i = 0; i < W * H; i++) fieldMean += v[i];
  fieldMean /= W * H;
  let fieldVar = 0;
  for (let i = 0; i < W * H; i++) fieldVar += (v[i] - fieldMean) * (v[i] - fieldMean);
  const fieldStd = Math.sqrt(fieldVar / (W * H));
  const spread = fieldStd > 1e-4 ? 0.3 / fieldStd : 1;
  const [dr, dg, db] = stats.dark;
  const [mr, mg, mb] = stats.mid;
  const [lr, lg, lb] = stats.light;
  const [kr, kg, kb] = stats.darkest;
  const [br, bg, bb] = stats.brightest;
  for (let i = 0; i < W * H; i++) {
    // a little ordered noise, the way an eight-bit texture dithers a gradient
    const x = i % W;
    const y = (i - x) / W;
    const t = clamp((v[i] - fieldMean) * spread + 0.5 + (perPixelHash(x, y, seed) - 0.5) * 0.09);
    let r;
    let g;
    let b;
    if (t < 0.5) {
      const u = t * 2;
      r = lerp(dr, mr, u);
      g = lerp(dg, mg, u);
      b = lerp(db, mb, u);
    } else {
      const u = (t - 0.5) * 2;
      r = lerp(mr, lr, u);
      g = lerp(mg, lg, u);
      b = lerp(mb, lb, u);
    }
    const d = dark[i];
    const q = glow[i];
    if (d > 0) {
      const k = clamp(d) * 0.92;
      r = lerp(r, kr, k);
      g = lerp(g, kg, k);
      b = lerp(b, kb, k);
    }
    if (q > 0) {
      const k = clamp(q) * 0.85;
      r = lerp(r, br, k);
      g = lerp(g, bg, k);
      b = lerp(b, bb, k);
    }
    rgb[i * 3] = clamp(r, 0, 255);
    rgb[i * 3 + 1] = clamp(g, 0, 255);
    rgb[i * 3 + 2] = clamp(b, 0, 255);
  }
  return matchStats(rgb, stats);
}

// ---------------------------------------------------------------------------
// PNG: write an 8-bit RGB picture (colour type 2, no filter) -- the one PNG the
// rest of the toolchain needs and the one no dependency is available to write.

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
  let c = ~0;
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "latin1");
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePngRgb(width, height, rgb) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// a generated square -> the entry's exact size

// To RGBA triples in a plain array-of-rows of [r,g,b].
function rgbaToRgb(image) {
  const { width, height, data } = image;
  const out = Buffer.alloc(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    out[i * 3] = data[i * 4];
    out[i * 3 + 1] = data[i * 4 + 1];
    out[i * 3 + 2] = data[i * 4 + 2];
  }
  return out;
}

// The largest region of the picture that has the entry's aspect ratio, taken
// from the middle and pulled in a little so any border the generator drew is
// left behind.
function aspectCrop(width, height, targetW, targetH, inset = 0.92) {
  const aspect = targetW / targetH;
  let w = width;
  let h = height;
  if (width / height > aspect) w = Math.round(height * aspect);
  else h = Math.round(width / aspect);
  w = Math.max(1, Math.round(w * inset));
  h = Math.max(1, Math.round(h * inset));
  return { x: Math.round((width - w) / 2), y: Math.round((height - h) / 2), w, h };
}

// Continue each border into the pixels that would sit beside it when the tile is
// repeated, over a band at each edge, so the tile is seamless: the seam becomes
// a soft gradient rather than a visible cut.
function makeSeamless(rgb, width, height, marginFrac = 0.22) {
  const mx = Math.max(1, Math.round(width * marginFrac));
  const my = Math.max(1, Math.round(height * marginFrac));
  const tmp = Buffer.from(rgb);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < mx; x++) {
      const t = 1 - (x + 0.5) / mx; // 1 at the edge, 0 where the band ends
      const sx = (x + width - mx) % width;
      for (let k = 0; k < 3; k++) {
        const here = tmp[(y * width + x) * 3 + k];
        const there = tmp[(y * width + sx) * 3 + k];
        rgb[(y * width + x) * 3 + k] = here * (1 - t) + there * t;
      }
    }
  }
  Buffer.from(rgb).copy(tmp);
  for (let y = 0; y < my; y++) {
    const t = 1 - (y + 0.5) / my;
    const sy = (y + height - my) % height;
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < 3; k++) {
        const here = tmp[(y * width + x) * 3 + k];
        const there = tmp[(sy * width + x) * 3 + k];
        rgb[(y * width + x) * 3 + k] = here * (1 - t) + there * t;
      }
    }
  }
  return rgb;
}

// area-average down to exactly dw x dh
function resample(rgb, sw, sh, dw, dh) {
  const out = Buffer.alloc(dw * dh * 3);
  const sx = sw / dw;
  const sy = sh / dh;
  for (let y = 0; y < dh; y++) {
    const y0 = y * sy;
    const y1 = (y + 1) * sy;
    const iy0 = Math.floor(y0);
    const iy1 = Math.min(sh, Math.ceil(y1));
    for (let x = 0; x < dw; x++) {
      const x0 = x * sx;
      const x1 = (x + 1) * sx;
      const ix0 = Math.floor(x0);
      const ix1 = Math.min(sw, Math.ceil(x1));
      let r = 0;
      let g = 0;
      let b = 0;
      let weight = 0;
      for (let sy2 = iy0; sy2 < iy1; sy2++) {
        const wy = Math.min(y1, sy2 + 1) - Math.max(y0, sy2);
        if (wy <= 0) continue;
        for (let sx2 = ix0; sx2 < ix1; sx2++) {
          const wx = Math.min(x1, sx2 + 1) - Math.max(x0, sx2);
          if (wx <= 0) continue;
          const w = wx * wy;
          const at = (sy2 * sw + sx2) * 3;
          r += rgb[at] * w;
          g += rgb[at + 1] * w;
          b += rgb[at + 2] * w;
          weight += w;
        }
      }
      const at = (y * dw + x) * 3;
      out[at] = Math.round(r / weight);
      out[at + 1] = Math.round(g / weight);
      out[at + 2] = Math.round(b / weight);
    }
  }
  return out;
}

function artFromGenerated(file, targetW, targetH, stats) {
  const image = decodePng(fs.readFileSync(file));
  const rgb = rgbaToRgb(image);
  const crop = aspectCrop(image.width, image.height, targetW, targetH);
  const cropped = Buffer.alloc(crop.w * crop.h * 3);
  for (let y = 0; y < crop.h; y++) {
    const from = ((crop.y + y) * image.width + crop.x) * 3;
    rgb.copy(cropped, y * crop.w * 3, from, from + crop.w * 3);
  }
  makeSeamless(cropped, crop.w, crop.h);
  const small = resample(cropped, crop.w, crop.h, targetW, targetH);
  return anchorMean(small, stats);
}

function anchorMean(rgb, stats) {
  if (!stats || stats.mean <= 0.02) return rgb;
  let sum = 0;
  for (let i = 0; i < rgb.length; i += 3) sum += luminance(rgb[i], rgb[i + 1], rgb[i + 2]);
  const mean = sum / (rgb.length / 3);
  if (mean <= 0.02) return rgb;
  const factor = lerp(mean, stats.mean, 0.4) / mean;
  for (let i = 0; i < rgb.length; i++) rgb[i] = clamp(rgb[i] * factor, 0, 255);
  return rgb;
}

// ---------------------------------------------------------------------------
// contact sheets, for looking at what was drawn

function drawCell(sheet, sheetW, x0, y0, cell, rgb, w, h, background = 26) {
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const to = ((y0 + y) * sheetW + x0 + x) * 3;
      const sx = Math.min(w - 1, Math.floor((x / cell) * w));
      const sy = Math.min(h - 1, Math.floor((y / cell) * h));
      const from = (sy * w + sx) * 3;
      if (rgb && sx < w && sy < h) {
        sheet[to] = rgb[from];
        sheet[to + 1] = rgb[from + 1];
        sheet[to + 2] = rgb[from + 2];
      } else {
        sheet[to] = background;
        sheet[to + 1] = background;
        sheet[to + 2] = background;
      }
    }
  }
}

function buildSheet(outFile, items, cell, pairs) {
  const perRow = pairs ? Math.max(1, Math.floor(1024 / (cell * 2))) : Math.max(1, Math.floor(1024 / cell));
  const rows = Math.ceil(items.length / perRow);
  const width = perRow * cell * (pairs ? 2 : 1);
  const height = rows * cell;
  const sheet = Buffer.alloc(width * height * 3, 20);
  items.forEach((item, i) => {
    const row = Math.floor(i / perRow);
    const col = i % perRow;
    if (pairs) {
      drawCell(sheet, width, col * cell * 2, row * cell, cell, item.original, item.originalW, item.originalH, 40);
      drawCell(sheet, width, col * cell * 2 + cell, row * cell, cell, item.rgb, item.w, item.h, 10);
    } else {
      drawCell(sheet, width, col * cell, row * cell, cell, item.rgb, item.w, item.h);
    }
  });
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, encodePngRgb(width, height, sheet));
  return { file: outFile, width, height, cells: items.length, perRow };
}

// ---------------------------------------------------------------------------
// main

function parseArgs(argv) {
  const options = {
    list: false,
    only: [],
    src: path.join(PROJECT_ROOT, "assets", "textures", "map"),
    procedural: false,
    sheet: null,
    pairs: false,
    cell: 64,
    force: false,
    help: false,
  };
  const takesValue = new Set(["--only", "--src", "--sheet", "--cell"]);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") options.help = true;
    else if (arg === "--list") options.list = true;
    else if (arg === "--procedural") options.procedural = true;
    else if (arg === "--pairs") options.pairs = true;
    else if (arg === "--force") options.force = true;
    else if (takesValue.has(arg)) {
      const value = argv[++i];
      if (value === undefined) throw new Error(arg + " needs a value");
      if (arg === "--only") options.only.push(...value.split(",").filter(Boolean));
      else if (arg === "--src") options.src = path.resolve(PROJECT_ROOT, value);
      else if (arg === "--sheet") options.sheet = path.resolve(PROJECT_ROOT, value);
      else if (arg === "--cell") options.cell = Math.max(8, Number(value) || 64);
    } else throw new Error("unknown option " + arg);
  }
  return options;
}

function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }

  const manifest = readManifest();
  const pak = loadPak(DEFAULT_PAK);
  const palette = globalPalette(pak).palette;
  const entries = new Map(manifest.entries.map((entry) => [entry.name, entry]));

  // Every map in the archive, not just the first one. A texture demo2 or demo3
  // draws is a surface a player sees the moment that level is loaded, so it is
  // this pass's art too; a texture several maps share is pooled once with its
  // uses summed, so the order still runs most-used first and a picture is drawn
  // once per entry rather than once per map that wants it.
  const pooled = new Map();
  for (const map of manifest.maps) {
    for (const texture of map.textures) {
      if (!(texture.uses > 0)) continue;
      const key = texture.wal.toLowerCase();
      const seen = pooled.get(key) ?? { ...texture, uses: 0, maps: [] };
      seen.uses += texture.uses;
      if (!seen.maps.includes(map.name)) seen.maps.push(map.name);
      pooled.set(key, seen);
    }
  }
  const used = [...pooled.values()]
    .sort((a, b) => b.uses - a.uses || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map((texture) => ({ ...texture, entry: entries.get(texture.wal) }))
    .filter((texture) => texture.entry);

  const wanted = used.filter((texture) => !options.only.length || options.only.some((needle) => texture.name.toLowerCase().includes(needle.toLowerCase())));

  const done = [];
  const skipped = [];
  const drawn = [];
  for (const texture of wanted) {
    const entry = texture.entry;
    const recipe = recipeFor(texture.name);
    const outPath = path.join(PROJECT_ROOT, entry.png);
    const slug = texture.name.replace(/[\\/]/g, "_");
    const source = path.join(options.src, slug + ".png");
    const hasSource = !options.procedural && fs.existsSync(source) && fs.statSync(source).size > 0;
    const how = recipe === null ? "skipped (animated frame)" : hasSource ? "generated picture" : "procedural:" + recipe;

    if (options.list) {
      process.stdout.write(
        [
          texture.name.padEnd(22),
          String(texture.uses).padStart(4),
          (entry.width + "x" + entry.height).padStart(8),
          how,
        ].join(" ") + "\n",
      );
      continue;
    }

    if (recipe === null) {
      skipped.push(texture.name);
      continue;
    }

    const original = decodeWal(readPakFile(pak, entry.name));
    const stats = originalStats(original, palette);
    let rgb;
    if (hasSource) {
      rgb = artFromGenerated(source, entry.width, entry.height, stats);
    } else {
      const frame = Number((texture.name.match(/(\d+)$/) ?? [])[1] ?? 0);
      const recipeFn = RECIPES[recipe];
      const canvas = recipeFn(entry.width, entry.height, makeRng(texture.name), texture.name, frame);
      rgb = colorize(canvas, stats, hash32(texture.name));
    }
    if (rgb.length !== entry.width * entry.height * 3) {
      throw new Error(texture.name + ": drew " + rgb.length / 3 + " pixels, entry wants " + entry.width * entry.height);
    }
    const png = encodePngRgb(entry.width, entry.height, rgb);
    // read back what was written: an encoder that lies about its own header is
    // exactly the failure this check is for
    const check = decodePng(png);
    if (check.width !== entry.width || check.height !== entry.height) {
      throw new Error(texture.name + ": wrote a " + check.width + "x" + check.height + " PNG, entry wants " + entry.width + "x" + entry.height);
    }
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, png);
    done.push({ texture, entry, how, rgb, original });
    drawn.push({ name: texture.name, art: entry.png, how, bytes: png.length });
  }

  if (!options.list) {
    process.stdout.write(
      "drew " +
        drawn.length +
        " of " +
        wanted.length +
        " map textures" +
        (skipped.length ? " (" + skipped.length + " animated frames left alone: " + skipped.join(", ") + ")" : "") +
        "\n",
    );
    for (const item of drawn) process.stdout.write("  " + item.name.padEnd(22) + item.art.padEnd(50) + item.how + "\n");
  }

  if (options.sheet && done.length) {
    const items = done.map((item) => ({
      name: item.texture.name,
      rgb: item.rgb,
      w: item.entry.width,
      h: item.entry.height,
      original: options.pairs ? originalRgb(item.original, palette) : null,
      originalW: item.entry.width,
      originalH: item.entry.height,
    }));
    const sheet = buildSheet(options.sheet, items, options.cell, options.pairs);
    process.stdout.write("sheet " + path.relative(PROJECT_ROOT, sheet.file) + " " + sheet.width + "x" + sheet.height + " (" + sheet.cells + " cells)\n");
  }
  return 0;
}

function originalRgb(original, palette) {
  const { width, height, indices } = original;
  const rgb = Buffer.alloc(width * height * 3);
  for (let i = 0; i < indices.length; i++) {
    const at = indices[i] * 3;
    rgb[i * 3] = palette[at];
    rgb[i * 3 + 1] = palette[at + 1];
    rgb[i * 3 + 2] = palette[at + 2];
  }
  return rgb;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  process.stderr.write("map-art: " + (error && error.message ? error.message : String(error)) + "\n");
  process.exitCode = 1;
}
