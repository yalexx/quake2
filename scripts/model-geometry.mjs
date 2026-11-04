#!/usr/bin/env node
// scripts/model-geometry.mjs -- procedural detail for Quake 2's MD2 models.
//
// The engine draws every weapon and monster from an MD2 mesh. This tool rebuilds
// those meshes at a higher effective polygon budget -- one uniform edge split per
// face, with the new edge midpoints pulled onto the endpoint tangent planes, so
// curved barrels, heads and limbs stop reading as flat blocks -- and adds
// procedurally modelled hardware (a muzzle collar on view weapons, shoulder
// collars on monsters) in the same model space. Every new vertex is
// bound to the original triangles, so the game's own frame animation, frame
// timing and hit detection are carried over untouched. Enemy skins and meshes
// are untouched: new faces sample the model's existing UV atlas.
//
// The 13 first-person weapon MD2s also ship with a 2x skin: model-art.mjs's
// Lanczos-3 upscaler produces the PCX (same palette, same cut-out, exactly 2x
// width and height), this tool doubles skinWidth/skinHeight and every ST
// coordinate, and both entries go into the archive together. Entry names are
// unchanged, so the engine finds the bigger skin through the later PAK.
//
// The result is written to baseq2/pak10.pak, which the engine loads after pak0;
// a later PAK wins in Quake 2's file system, so these meshes replace the
// originals while the original archive, maps and sounds stay as shipped.
//
//   node scripts/model-geometry.mjs                  # write baseq2/pak10.pak
//   node scripts/model-geometry.mjs --dry-run        # measure, write nothing
//   node scripts/model-geometry.mjs --verify         # audit pak10 against pak0
//   node scripts/model-geometry.mjs --markers        # calibration build
//   node scripts/model-geometry.mjs --only models/weapons/v_machn/tris.md2
//
// Node built-ins only; the PAK and PNG readers are the project's own
// (scripts/texture-lib.mjs).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_MANIFEST,
  DEFAULT_PAK,
  buildPakFromEntries,
  decodePcx,
  decodePng,
  loadPak,
  normalizeName,
  readPakDirectory,
  readPakFile,
  writePakBytes,
} from "./texture-lib.mjs";
import { countCutout, meanSaturation, upscaleSkin2x } from "./model-art.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const OUT_PAK = path.join(ROOT, "baseq2", "pak10.pak");
const MD2_VERSION = 8;

const WEAPON_RE = /^models\/weapons\/v_[a-z0-9]+\/tris\.md2$/;
const MONSTER_RE = /^models\/monsters\/([a-z0-9_]+)\/(tris)\.md2$/;
const SKIP_MODELS = new Set(["parasite/segment", "parasite/tip"]);

// ---------------------------------------------------------------------------
// MD2: read
// ---------------------------------------------------------------------------

export function parseMd2(buf) {
  const ident = buf.toString("latin1", 0, 4);
  if (ident !== "IDP2") throw new Error("not an MD2 (unknown ident " + JSON.stringify(ident) + ")");
  const model = {
    version: buf.readInt32LE(4),
    skinWidth: buf.readInt32LE(8),
    skinHeight: buf.readInt32LE(12),
    skins: [],
    st: [],
    tris: [],
    frames: [],
  };
  const numSkins = buf.readInt32LE(20);
  const numXYZ = buf.readInt32LE(24);
  const numST = buf.readInt32LE(28);
  const numTris = buf.readInt32LE(32);
  const numFrames = buf.readInt32LE(40);
  const ofsSkins = buf.readInt32LE(44);
  const ofsST = buf.readInt32LE(48);
  const ofsTris = buf.readInt32LE(52);
  const ofsFrames = buf.readInt32LE(56);
  const frameSize = buf.readInt32LE(16);
  for (let i = 0; i < numSkins; i++) {
    model.skins.push(buf.toString("latin1", ofsSkins + i * 64, ofsSkins + i * 64 + 64).split("\0")[0]);
  }
  for (let i = 0; i < numST; i++) {
    model.st.push([buf.readInt16LE(ofsST + i * 4), buf.readInt16LE(ofsST + i * 4 + 2)]);
  }
  for (let i = 0; i < numTris; i++) {
    const o = ofsTris + i * 12;
    model.tris.push({
      v: [buf.readInt16LE(o), buf.readInt16LE(o + 2), buf.readInt16LE(o + 4)],
      t: [buf.readInt16LE(o + 6), buf.readInt16LE(o + 8), buf.readInt16LE(o + 10)],
    });
  }
  for (let f = 0; f < numFrames; f++) {
    const o = ofsFrames + f * frameSize;
    model.frames.push({
      name: buf.toString("latin1", o + 24, o + 40).split("\0")[0],
      scale: [buf.readFloatLE(o), buf.readFloatLE(o + 4), buf.readFloatLE(o + 8)],
      trans: [buf.readFloatLE(o + 12), buf.readFloatLE(o + 16), buf.readFloatLE(o + 20)],
      verts: Buffer.from(buf.subarray(o + 40, o + 40 + numXYZ * 4)),
    });
  }
  model.numXYZ = numXYZ;
  model.originalGlCmds = Buffer.from(buf.subarray(buf.readInt32LE(60), buf.readInt32LE(64)));
  return model;
}

// ---------------------------------------------------------------------------
// MD2: write. Frames keep their names, scale and origin, so the game's own
// animation, frame indexing and timing are untouched.
// ---------------------------------------------------------------------------

export function encodeMd2(model) {
  const numXYZ = model.frames[0].verts.length / 4;
  const numST = model.st.length;
  const numTris = model.tris.length;
  const numFrames = model.frames.length;
  const frameSize = 40 + numXYZ * 4;
  const ofsSkins = 68;
  const ofsST = ofsSkins + model.skins.length * 64;
  const ofsTris = ofsST + numST * 4;
  const ofsFrames = ofsTris + numTris * 12;
  const ofsGlCmds = ofsFrames + numFrames * frameSize;
  // One triangle fan per face: a valid command list for any mesh, not only the
  // strips the original artist happened to author.
  const glcmds = Buffer.alloc(4 + numTris * (4 + 3 * 12) + 4);
  let gp = 0;
  for (const tri of model.tris) {
    glcmds.writeInt32LE(3, gp); gp += 4;
    for (let k = 0; k < 3; k++) {
      const st = model.st[tri.t[k]];
      // GL commands carry normalised texture coordinates with the half-texel
      // centre, unlike the integer pixel coordinates in the ST table.
      glcmds.writeFloatLE((st[0] + 0.5) / model.skinWidth, gp);
      glcmds.writeFloatLE((st[1] + 0.5) / model.skinHeight, gp + 4);
      glcmds.writeInt32LE(tri.v[k], gp + 8);
      gp += 12;
    }
  }
  glcmds.writeInt32LE(0, gp);
  const ofsEnd = ofsGlCmds + glcmds.length;
  const out = Buffer.alloc(ofsEnd);
  out.write("IDP2", 0, "latin1");
  out.writeInt32LE(MD2_VERSION, 4);
  out.writeInt32LE(model.skinWidth, 8);
  out.writeInt32LE(model.skinHeight, 12);
  out.writeInt32LE(frameSize, 16);
  out.writeInt32LE(model.skins.length, 20);
  out.writeInt32LE(numXYZ, 24);
  out.writeInt32LE(numST, 28);
  out.writeInt32LE(numTris, 32);
  out.writeInt32LE(glcmds.length / 4, 36);
  out.writeInt32LE(numFrames, 40);
  out.writeInt32LE(ofsSkins, 44);
  out.writeInt32LE(ofsST, 48);
  out.writeInt32LE(ofsTris, 52);
  out.writeInt32LE(ofsFrames, 56);
  out.writeInt32LE(ofsGlCmds, 60);
  out.writeInt32LE(ofsEnd, 64);
  let at = ofsSkins;
  for (const skin of model.skins) {
    const bytes = Buffer.from(skin, "latin1");
    bytes.copy(out, at, 0, Math.min(bytes.length, 63));
    at += 64;
  }
  at = ofsST;
  for (const [s, t] of model.st) {
    out.writeInt16LE(clampInt16(s), at);
    out.writeInt16LE(clampInt16(t), at + 2);
    at += 4;
  }
  at = ofsTris;
  for (const tri of model.tris) {
    for (let k = 0; k < 3; k++) out.writeInt16LE(clampInt16(tri.v[k]), at + k * 2);
    for (let k = 0; k < 3; k++) out.writeInt16LE(clampInt16(tri.t[k]), at + 6 + k * 2);
    at += 12;
  }
  at = ofsFrames;
  for (const frame of model.frames) {
    out.writeFloatLE(frame.scale[0], at);
    out.writeFloatLE(frame.scale[1], at + 4);
    out.writeFloatLE(frame.scale[2], at + 8);
    out.writeFloatLE(frame.trans[0], at + 12);
    out.writeFloatLE(frame.trans[1], at + 16);
    out.writeFloatLE(frame.trans[2], at + 20);
    out.write(frame.name, at + 24, "latin1");
    frame.verts.copy(out, at + 40);
    at += frameSize;
  }
  glcmds.copy(out, ofsGlCmds);
  return out;
}

function clampInt16(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value)));
}

// ---------------------------------------------------------------------------
// Vector helpers
// ---------------------------------------------------------------------------

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];

export function framePos(model, f, i) {
  const frame = model.frames[f];
  const o = i * 4;
  return [
    frame.verts[o] * frame.scale[0] + frame.trans[0],
    frame.verts[o + 1] * frame.scale[1] + frame.trans[1],
    frame.verts[o + 2] * frame.scale[2] + frame.trans[2],
  ];
}
function restPositions(model) {
  const out = [];
  const n = model.frames[0].verts.length / 4;
  for (let i = 0; i < n; i++) out.push(framePos(model, 0, i));
  return out;
}
function packVertex(frame, p, normalByte = 0) {
  return [
    Math.max(0, Math.min(255, Math.round((p[0] - frame.trans[0]) / frame.scale[0]))),
    Math.max(0, Math.min(255, Math.round((p[1] - frame.trans[1]) / frame.scale[1]))),
    Math.max(0, Math.min(255, Math.round((p[2] - frame.trans[2]) / frame.scale[2]))),
    normalByte,
  ];
}
function smoothNormals(verts, tris) {
  const out = verts.map(() => [0, 0, 0]);
  for (const tri of tris) {
    const a = verts[tri.v[0]], b = verts[tri.v[1]], c = verts[tri.v[2]];
    const n = cross(sub(b, a), sub(c, a));
    for (const vi of tri.v) out[vi] = add(out[vi], n);
  }
  return out.map((n) => (len(n) < 1e-9 ? [0, 1, 0] : norm(n)));
}
function bounds(points) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of points) for (let k = 0; k < 3; k++) { lo[k] = Math.min(lo[k], p[k]); hi[k] = Math.max(hi[k], p[k]); }
  return { lo, hi, size: sub(hi, lo), center: mul(add(lo, hi), 0.5) };
}
function triNormal(a, b, c) {
  const n = cross(sub(b, a), sub(c, a));
  return len(n) < 1e-9 ? [0, 0, 1] : norm(n);
}

// ---------------------------------------------------------------------------
// Mesh refinement: one uniform 1-to-4 split per face. The new midpoint on an
// edge is projected onto the two endpoint tangent planes and blended back, so
// curved surfaces bulge smoothly while flat panels stay flat. No T-junctions:
// every face is split, so the mesh stays watertight.
// ---------------------------------------------------------------------------

const PHONG_BLEND = Number(process.env.Q2_PHONG || 0.6);
// How far a projected edge midpoint may move from the straight midpoint, as a
// fraction of the edge it splits.
const MIDPOINT_LIMIT = Number(process.env.Q2_MIDPOINT_LIMIT || 0.12);

// --- surface relaxation -----------------------------------------------------
// Enemy meshes are blocky by construction: boxy limbs and a boxy head. A few
// Laplacian passes round the silhouette (the shader carries no per-pixel
// normal, so only the outline can sell the extra roundness), then an inflation
// pass restores the volume the relaxation pulls in.
function adjacency(tris, count) {
  const sets = Array.from({ length: count }, () => new Set());
  for (const tri of tris) {
    const [a, b, c] = tri.v;
    sets[a].add(b); sets[a].add(c);
    sets[b].add(a); sets[b].add(c);
    sets[c].add(a); sets[c].add(b);
  }
  return sets.map((set) => [...set]);
}
function relax(raw, neighbors, lambda, iterations) {
  let points = raw.map((p) => [p[0], p[1], p[2]]);
  for (let it = 0; it < iterations; it++) {
    const next = points.map((p, i) => {
      const nb = neighbors[i];
      if (!nb || !nb.length) return p;
      let x = 0, y = 0, z = 0;
      for (const j of nb) { x += points[j][0]; y += points[j][1]; z += points[j][2]; }
      const k = nb.length;
      return [p[0] + lambda * (x / k - p[0]), p[1] + lambda * (y / k - p[1]), p[2] + lambda * (z / k - p[2])];
    });
    points = next;
  }
  return points;
}
function inflate(points, tris, amount) {
  if (!amount) return points;
  const normals = points.map(() => [0, 0, 0]);
  for (const tri of tris) {
    const a = points[tri.v[0]], b = points[tri.v[1]], c = points[tri.v[2]];
    const n = cross(sub(b, a), sub(c, a));
    for (const vi of tri.v) normals[vi] = add(normals[vi], n);
  }
  return points.map((p, i) => (len(normals[i]) < 1e-9 ? p : add(p, mul(norm(normals[i]), amount))));
}


function buildRefined(model, opts) {
  const rawRest = restPositions(model);
  const neighbors = adjacency(model.tris, model.numXYZ);
  const smoothing = opts.isWeapon ? { lambda: 0, iterations: 0, inflate: 0 }
    : { lambda: Number(process.env.Q2_LAMBDA || 0.25), iterations: Number(process.env.Q2_RELAX || 1), inflate: Number(process.env.Q2_INFLATE || 0.3) };
  const rest = inflate(relax(rawRest, neighbors, smoothing.lambda, smoothing.iterations), model.tris, smoothing.inflate);
  const st = model.st.map((pair) => [pair[0], pair[1]]);
  const finalVerts = [];
  for (let i = 0; i < model.numXYZ; i++) finalVerts.push({ kind: "o", i });
  const restPos = rest.slice();
  let tris = model.tris.map((tri) => ({ v: tri.v.slice(), t: tri.t.slice() }));
  const levels = opts.levels || 1;
  for (let level = 0; level < levels; level++) {
    const normals = smoothNormals(restPos, tris);
    const edgePos = new Map();
    const stMap = new Map();
    function midpoint(a, b) {
      const key = a < b ? a + ":" + b : b + ":" + a;
      let index = edgePos.get(key);
      if (index !== undefined) return index;
      const pa = restPos[a], pb = restPos[b];
      const m = mid(pa, pb);
      const na = normals[a], nb = normals[b];
      const ta = sub(m, mul(na, dot(sub(m, pa), na)));
      const tb = sub(m, mul(nb, dot(sub(m, pb), nb)));
      let p = lerp(m, mid(ta, tb), PHONG_BLEND);
      // The tangent-plane projection can throw a midpoint well off the edge
      // where two very different normals meet (a sharp sight, a barrel rim),
      // and a midpoint that far out turns its four child triangles into thin
      // spikes. Bound the move to a fraction of the edge it splits: the
      // rounding survives, the sliver does not.
      const moved = sub(p, m);
      const reach = len(moved);
      const limit = len(sub(pa, pb)) * MIDPOINT_LIMIT;
      if (reach > limit && reach > 1e-9) p = add(m, mul(moved, limit / reach));
      index = finalVerts.length;
      finalVerts.push({ kind: "s", a, b, delta: sub(p, m) });
      restPos.push(p);
      edgePos.set(key, index);
      return index;
    }
    function stMid(ta, tb) {
      const key = ta < tb ? ta + ":" + tb : tb + ":" + ta;
      let index = stMap.get(key);
      if (index !== undefined) return index;
      index = st.length;
      st.push([Math.round((st[ta][0] + st[tb][0]) / 2), Math.round((st[ta][1] + st[tb][1]) / 2)]);
      stMap.set(key, index);
      return index;
    }
    const nextTris = [];
    for (const tri of tris) {
      const [v0, v1, v2] = tri.v;
      const [t0, t1, t2] = tri.t;
      const m01 = midpoint(v0, v1), m12 = midpoint(v1, v2), m20 = midpoint(v2, v0);
      const s01 = stMid(t0, t1), s12 = stMid(t1, t2), s20 = stMid(t2, t0);
      nextTris.push(
        { v: [v0, m01, m20], t: [t0, s01, s20] },
        { v: [m01, v1, m12], t: [s01, t1, s12] },
        { v: [m20, m12, v2], t: [s20, s12, t2] },
        { v: [m01, m12, m20], t: [s01, s12, s20] },
      );
    }
    tris = nextTris;
  }

  const context = { model, rest, restPos, finalVerts, tris, st, originalCount: model.numXYZ, isWeapon: opts.isWeapon, name: opts.name, smoothing, neighbors };
  let note = "";
  if (!process.env.Q2_NO_HW) {
    if (opts.isWeapon) note = addWeaponHardware(context);
    else note = addMonsterHardware(context);
  }
  const frames = buildFrames(context);
  // Hardware builders append their faces to context.tris (a new array, not the
  // subdivided one), so the model has to take that array -- otherwise the added
  // vertices would ship with no face referencing them.
  const refined = { ...model, tris: context.tris, st, frames, numXYZ: finalVerts.length };
  const hardware = context.hardware || [];
  const hardwareWorst = {
    parts: hardware.length,
    maxEdge: hardware.reduce((worst, part) => Math.max(worst, part.edge), 0),
    maxMismatch: hardware.reduce((worst, part) => Math.max(worst, part.mismatch), 0),
    minPitchRatio: hardware.reduce((worst, part) => Math.min(worst, part.pitchRatio), Infinity),
  };
  return { model: refined, note, hardware, hardwareWorst };
}

// --- hardware binding ------------------------------------------------------

function closestOnTriangle(p, a, b, c) {
  // Ericson, Real-Time Collision Detection: closest point on a triangle.
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a);
  const d1 = dot(ab, ap), d2 = dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return { point: a, bary: [1, 0, 0] };
  const bp = sub(p, b);
  const d3 = dot(ab, bp), d4 = dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return { point: b, bary: [0, 1, 0] };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return { point: add(a, mul(ab, v)), bary: [1 - v, v, 0] };
  }
  const cp = sub(p, c);
  const d5 = dot(ab, cp), d6 = dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return { point: c, bary: [0, 0, 1] };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return { point: add(a, mul(ac, w)), bary: [1 - w, 0, w] };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
    return { point: add(b, mul(sub(c, b), w)), bary: [0, 1 - w, w] };
  }
  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator, w = vc * denominator;
  return { point: add(add(mul(a, 1 - v - w), mul(b, v)), mul(c, w)), bary: [1 - v - w, v, w] };
}

function basisOf(a, b, c, fallback = null) {
  const e0 = sub(b, a);
  if (len(e0) < 1e-8) return fallback || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const n = cross(e0, sub(c, a));
  if (len(n) < 1e-8) return fallback || [norm(e0), [0, 1, 0], [0, 0, 1]];
  const e0n = norm(e0), nn = norm(n);
  return [e0n, cross(nn, e0n), nn];
}

// Bind one hardware vertex to the original surface: nearest point on a face of
// the original mesh, stored as barycentrics plus an offset in that face's own
// frame, so every generated vertex follows the game's animation exactly.
//
// The face is chosen once per *part*, not once per vertex. Choosing it per
// vertex let the four corners of one quad bind to four different faces; at rest
// that is invisible (every face agrees with the mesh), but on any animation
// frame where those faces move differently the quad is stretched between them
// and becomes a long thin grey sliver -- measured on the rebuilt soldier and
// the blaster, whose hardware quads span a shoulder and a gun. `anchor` is the
// point the part is placed around (a quad's centre, a cap's centre, a tube
// ring's centre): the face nearest *it* is the one face every vertex of that
// part rides on, so the part moves rigidly with one piece of the body.
function bindVertex(context, p, normalIndex = 0, anchor = null) {
  const { model, rest } = context;
  const probe = anchor || p;
  const face = nearestFace(context, probe);
  const tri = model.tris[face];
  const a = rest[tri.v[0]], b = rest[tri.v[1]], c = rest[tri.v[2]];
  const basis = basisOf(a, b, c);
  const hit = closestOnTriangle(p, a, b, c);
  const delta = sub(p, hit.point);
  const deltaLocal = [dot(delta, basis[0]), dot(delta, basis[1]), dot(delta, basis[2])];
  const index = context.finalVerts.length;
  context.finalVerts.push({
    kind: "h", tri: face, bary: hit.bary, deltaLocal,
    restBasis: basis, st: null, normal: normalIndex,
  });
  context.restPos.push(p);
  return index;
}

// --- skin regions for added parts ------------------------------------------
//
// A new face used to sample a 14x14 "quiet patch" chosen by brightness alone.
// On a weapon that patch could land on the player's painted hand instead of on
// the gun, and a flat cell magnified across a collar reads as blocks of the
// wrong material (the pistol's artefact in design/weapons-reference.png). Every
// added face now samples the ORIGINAL face it is anchored to: the same UV
// triangle that face is painted with, so a collar shows the barrel's own metal.
// The triangle is validated for size and edge contrast; when it cannot carry a
// wrapper (a sliver face, or a face across a hard seam), a quiet, colour-matched
// patch from the face's own neighbourhood is used instead, with the whole skin
// (still this weapon's own paint) as the last resort.

const HARDWARE_MAX_TEXELS = 640;
const HARDWARE_MAX_EDGE = 72;
const HARDWARE_PATCH_MAX_SIZE = 16;

function lumaPlane(skin) {
  const luma = new Float32Array(skin.width * skin.height);
  for (let pixel = 0; pixel < luma.length; pixel++) {
    luma[pixel] = 0.2126 * skin.data[pixel * 4] + 0.7152 * skin.data[pixel * 4 + 1] + 0.0722 * skin.data[pixel * 4 + 2];
  }
  return luma;
}

function texelLuma(skin, luma, x, y) {
  return luma[Math.max(0, Math.min(skin.height - 1, y)) * skin.width + Math.max(0, Math.min(skin.width - 1, x))];
}

// Luma statistics of an axis-aligned region (or of the texels `inside` accepts),
// including the largest step between two neighbouring texels in it. That step is
// what decides whether a region will read as a painted surface or as a seam.
function regionLumaStats(skin, luma, x0, y0, w, h, inside = null) {
  let sum = 0, sum2 = 0, min = 255, max = 0, count = 0;
  const test = (x, y) => !inside || inside(x, y);
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (!test(x, y)) continue;
      const l = texelLuma(skin, luma, x, y);
      sum += l; sum2 += l * l; count++;
      if (l < min) min = l;
      if (l > max) max = l;
    }
  }
  let edge = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (!test(x, y)) continue;
      const l = texelLuma(skin, luma, x, y);
      if (x + 1 < x0 + w && test(x + 1, y)) edge = Math.max(edge, Math.abs(l - texelLuma(skin, luma, x + 1, y)));
      if (y + 1 < y0 + h && test(x, y + 1)) edge = Math.max(edge, Math.abs(l - texelLuma(skin, luma, x, y + 1)));
    }
  }
  const mean = count ? sum / count : 0;
  return { x: x0, y: y0, w, h, texels: count, mean, sd: count ? Math.sqrt(Math.max(0, sum2 / count - mean * mean)) : 0, min, max, edge };
}

function uvTriangleStats(skin, luma, uvs) {
  let [a, b, c] = uvs;
  let area2 = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (area2 < 0) { const swap = b; b = c; c = swap; area2 = -area2; }
  const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0], c[0])));
  const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1], c[1])));
  const x1 = Math.min(skin.width - 1, Math.ceil(Math.max(a[0], b[0], c[0])));
  const y1 = Math.min(skin.height - 1, Math.ceil(Math.max(a[1], b[1], c[1])));
  const inside = area2 < 1e-6 ? () => false : (x, y) => {
    const px = x + 0.5, py = y + 0.5;
    const w0 = ((b[0] - px) * (c[1] - py) - (b[1] - py) * (c[0] - px)) / area2;
    const w1 = ((c[0] - px) * (a[1] - py) - (c[1] - py) * (a[0] - px)) / area2;
    return w0 >= -0.02 && w1 >= -0.02 && w0 + w1 <= 1.02;
  };
  return regionLumaStats(skin, luma, x0, y0, x1 - x0 + 1, y1 - y0 + 1, inside);
}

// Median texel density of the model's own faces, in texels per unit of surface.
// It is the fair yardstick for an added part: the barrel's faces vary from tiny
// trim triangles to broad panels, so a part is blocky only when it spends far
// fewer texels per unit than the weapon as a whole.
function modelTexelPitch(context, info) {
  const pitches = [];
  for (const item of info) {
    const [a, b, c] = item.tri.t.map((t) => context.model.st[t]);
    const uvArea = Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
    if (uvArea < 0.5 || item.area < 1e-6) continue;
    pitches.push(Math.sqrt(uvArea / item.area));
  }
  pitches.sort((x, y) => x - y);
  return pitches.length ? pitches[Math.floor(pitches.length / 2)] : 1;
}

// The quiet-patch fallback, searched in the face's own neighbourhood first and
// then over the whole atlas. The patch side is read from the weapon's median
// texel density and the part's model area, so a wrapper is never magnified
// relative to the weapon it rides. Of the patches that size, the one with the
// lowest boundary step and the closest mean colour wins: the tiers below make a
// quiet, colour-matched patch always beat a louder or mismatched one.
function quietPatch(context, stats, targetLuma, sizes, quadArea, modelPitch) {
  const skin = context.skin, luma = context.luma;
  const centre = [stats.x + stats.w / 2, stats.y + stats.h / 2];
  let best = null;
  for (const requested of sizes) {
    const side = Math.max(3, Math.min(HARDWARE_PATCH_MAX_SIZE, Math.round(requested)));
    const step = side >= 12 ? 3 : side >= 8 ? 2 : Math.max(1, Math.floor(side / 3));
    const density = side / Math.sqrt(Math.max(1e-6, quadArea)) / modelPitch;
    const evaluate = (x, y) => {
      const patch = regionLumaStats(skin, luma, x, y, side, side);
      const distance = Math.hypot(x + side / 2 - centre[0], y + side / 2 - centre[1]);
      const mismatch = Math.abs(patch.mean - targetLuma);
      const tier = patch.edge <= 40 && mismatch <= 20 ? 0 : patch.edge <= 64 && mismatch <= 36 ? 1 : 2;
      // Below 0.6x the weapon's median density a patch reads as enlarged pixels,
      // so it pays for the colour match it buys.
      const sparse = Math.max(0, 0.6 - density) * 400;
      const score = tier * 1000 + patch.edge * (1 + tier) + mismatch * (1 + tier) + patch.sd * 0.25 + distance * 0.03 + sparse;
      return { ...patch, score, distance, mismatch, tier, side };
    };
    let sizeBest = null;
    // The face's own UV neighbourhood: stays in the barrel's part of the atlas.
    const radius = 48;
    const nearX0 = Math.max(0, Math.floor(stats.x - radius));
    const nearY0 = Math.max(0, Math.floor(stats.y - radius));
    const nearX1 = Math.min(skin.width - side, Math.ceil(stats.x + stats.w + radius));
    const nearY1 = Math.min(skin.height - side, Math.ceil(stats.y + stats.h + radius));
    for (let y = nearY0; y <= nearY1; y += step) {
      for (let x = nearX0; x <= nearX1; x += step) {
        const patch = evaluate(x, y);
        if (!sizeBest || patch.score < sizeBest.score) sizeBest = patch;
      }
    }
    // A face painted with a hard seam leaves nothing quiet nearby; the rest of the
    // skin is still this weapon's own paint, so a low-contrast patch there is a
    // better wrapper material than the seam.
    if (!sizeBest || sizeBest.tier > 0) {
      for (let y = 0; y + side <= skin.height; y += step) {
        for (let x = 0; x + side <= skin.width; x += step) {
          if (x >= nearX0 && x <= nearX1 && y >= nearY0 && y <= nearY1) continue;
          const patch = evaluate(x, y);
          if (!sizeBest || patch.score < sizeBest.score) sizeBest = patch;
        }
      }
    }
    if (sizeBest && (!best || sizeBest.score < best.score)) best = sizeBest;
  }
  return best;
}

// The UV mapping for one part, chosen once from the face at its anchor:
//   face  -- the face's own UV triangle, sampled barycentrically;
//   patch -- a density-matched quiet patch from the face's neighbourhood.
// Either way the wrapper is painted like the surface it wraps, and the choice is
// made per part, so it is made for every weapon and every added face.
function regionForAnchor(context, anchor, quadArea) {
  const skin = context.skin;
  const face = nearestFace(context, anchor);
  if (!skin) {
    return { kind: "none", face, stats: { texels: 0, edge: 0, mean: 0, faceMean: 0, faceTexels: 0, faceArea: 1 }, uvAt: () => [0.5, 0.5] };
  }
  const tri = context.model.tris[face];
  const uvs = tri.t.map((t) => context.model.st[t]);
  const A = context.rest[tri.v[0]], B = context.rest[tri.v[1]], C = context.rest[tri.v[2]];
  const faceArea = Math.max(1e-6, len(cross(sub(B, A), sub(C, A))) / 2);
  const stats = uvTriangleStats(skin, context.luma, uvs);
  const facePitch = Math.sqrt(Math.max(1, stats.texels) / faceArea);
  const modelPitch = context.modelPitch || facePitch;
  const faceBase = { faceMean: stats.mean, faceTexels: stats.texels, faceArea, facePitch, modelPitch };
  // The quad's own texel density if it samples this face directly, measured
  // against the weapon's median density rather than this one face (a tiny trim
  // triangle can be ten times denser than the paint around it).
  const pitchRatio = Math.sqrt(stats.texels / Math.max(1e-6, quadArea)) / modelPitch;
  if (process.env.Q2_HW_DEBUG && (stats.texels < 4 || stats.texels > HARDWARE_MAX_TEXELS || stats.edge > HARDWARE_MAX_EDGE || pitchRatio < 0.45)) {
    process.stderr.write(`face reject ${face} texels ${stats.texels} edge ${stats.edge.toFixed(1)} pitch ${pitchRatio.toFixed(2)} area ${quadArea.toFixed(2)}\n`);
  }
  if (stats.texels >= 4 && stats.texels <= HARDWARE_MAX_TEXELS && stats.edge <= HARDWARE_MAX_EDGE && pitchRatio >= 0.45) {
    return {
      kind: "face", face, uvs, stats: { ...stats, ...faceBase },
      // Square to triangle: (1-u)(1-v) + u(1-v) + v = 1, so every sample lies
      // inside the face's own UV triangle and never crosses into a neighbour.
      uvAt(u, v) {
        const w0 = (1 - u) * (1 - v), w1 = u * (1 - v), w2 = v;
        return [
          uvs[0][0] * w0 + uvs[1][0] * w1 + uvs[2][0] * w2,
          uvs[0][1] * w0 + uvs[1][1] * w1 + uvs[2][1] * w2,
        ];
      },
    };
  }
  const wanted = modelPitch * Math.sqrt(Math.max(1e-6, quadArea));
  // Two sizes: the density-matched one, and a larger one for parts whose anchor
  // lands on a small, loud piece of paint (a glowing tip) where nothing quiet of
  // the right size exists. The larger patch is still capped and bounded.
  const larger = Math.min(HARDWARE_PATCH_MAX_SIZE, Math.max(wanted + 1, wanted * 1.5));
  const smaller = Math.max(3, Math.round(wanted / 2));
  const patch = quietPatch(context, stats, stats.mean, [wanted, larger, smaller], quadArea, modelPitch);
  return {
    kind: "patch", face, stats: { ...patch, ...faceBase },
    uvAt(u, v) {
      return [patch.x + 0.5 + u * (patch.w - 1), patch.y + 0.5 + v * (patch.h - 1)];
    },
  };
}

function nearestFace(context, probe) {
  const { model, rest } = context;
  let best = { distance: Infinity, tri: 0 };
  for (let t = 0; t < model.tris.length; t++) {
    const tri = model.tris[t];
    const hit = closestOnTriangle(probe, rest[tri.v[0]], rest[tri.v[1]], rest[tri.v[2]]);
    const d = len(sub(probe, hit.point));
    if (d < best.distance) best = { distance: d, tri: t };
  }
  return best.tri;
}

// --- procedural parts ------------------------------------------------------

function makeParts(context) {
  const { model, rest } = context;
  const skin = loadSkin(model.skins[0]);
  context.skin = skin;
  context.luma = skin ? lumaPlane(skin) : null;
  context.hardware = [];
  // Enemy pauldrons keep the exact material patch the committed pak10 shipped:
  // the task is the view weapons, and an enemy's bytes must not move.
  const legacyPatch = !context.isWeapon && skin ? findQuietPatch(skin, 150, 14) : null;
  const legacyUv = (patchDef, u, v) => [patchDef.x + 0.5 + u * (patchDef.size - 1), patchDef.y + 0.5 + v * (patchDef.size - 1)];
  const b = bounds(rest);
  const tris = model.tris;
  const info = tris.map((tri) => {
    const a = rest[tri.v[0]], bb = rest[tri.v[1]], c = rest[tri.v[2]];
    const n = triNormal(a, bb, c);
    return { tri, a, b: bb, c, n, area: len(cross(sub(bb, a), sub(c, a))) / 2, center: mul(add(add(a, bb), c), 1 / 3) };
  });
  context.modelPitch = modelTexelPitch(context, info);
  const added = [];
  function vertex(p, uv, anchor = null) {
    const index = bindVertex(context, p, 0, anchor);
    const stIndex = context.st.length;
    context.st.push([Math.round(uv[0]), Math.round(uv[1])]);
    context.finalVerts[index].stIndex = stIndex;
    return index;
  }
  function tri(a, bb, c) {
    added.push({
      v: [a, bb, c],
      t: [context.finalVerts[a].stIndex, context.finalVerts[bb].stIndex, context.finalVerts[c].stIndex],
    });
  }
  // Record what the part samples, for --verify: the atlas region's own edge
  // contrast, how far its colour is from the face it rides, and how many texels
  // it spends per unit of model surface (the opposite of magnification).
  function polygonArea(points) {
    let area = 0;
    for (let i = 1; i + 1 < points.length; i++) {
      area += len(cross(sub(points[i], points[0]), sub(points[i + 1], points[0]))) / 2;
    }
    return Math.max(1e-6, area);
  }
  function record(region, points) {
    const area = polygonArea(points);
    const pitch = Math.sqrt(region.stats.texels / area);
    const facePitch = region.stats.facePitch || pitch;
    const modelPitch = region.stats.modelPitch || context.modelPitch || pitch;
    const part = {
      face: region.face,
      kind: region.kind,
      edge: region.stats.edge,
      texels: region.stats.texels,
      mean: region.stats.mean,
      faceMean: region.stats.faceMean,
      mismatch: Math.abs(region.stats.mean - region.stats.faceMean),
      pitch,
      facePitch,
      modelPitch,
      pitchRatio: pitch / (modelPitch || 1),
      area,
    };
    if (process.env.Q2_HW_DEBUG) process.stderr.write("hw " + context.name + " " + JSON.stringify(part) + "\n");
    context.hardware.push(part);
    return part;
  }
  // Enemy pauldrons map linearly over the committed material patch; record the
  // patch's own stats against the face they ride for the dry-run report.
  function legacyRegion(anchor, patchDef) {
    const face = nearestFace(context, anchor);
    const uvs = context.model.tris[face].t.map((t) => context.model.st[t]);
    const faceStats = context.skin ? uvTriangleStats(context.skin, context.luma, uvs) : { mean: 0 };
    const patchStats = context.skin
      ? regionLumaStats(context.skin, context.luma, patchDef.x, patchDef.y, patchDef.size, patchDef.size)
      : { texels: 0, edge: 0, mean: 0, sd: 0, x: patchDef.x, y: patchDef.y, w: patchDef.size, h: patchDef.size };
    return {
      kind: "legacy", face,
      stats: { ...patchStats, faceMean: faceStats.mean, facePitch: context.modelPitch, modelPitch: context.modelPitch },
      uvAt(u, v) { return legacyUv(patchDef, u, v); },
    };
  }
  function quad(p0, p1, p2, p3, uvs, patchDef = null) {
    const [uv0, uv1, uv2, uv3] = uvs || [[0, 0], [1, 0], [1, 1], [0, 1]];
    // One face for the whole quad: its own centre decides which piece of the
    // body it rides, so the quad can never be stretched between two of them.
    const anchor = mid(mid(p0, p1), mid(p2, p3));
    const region = patchDef
      ? legacyRegion(anchor, patchDef)
      : regionForAnchor(context, anchor, polygonArea([p0, p1, p2, p3]));
    const i0 = vertex(p0, region.uvAt(uv0[0], uv0[1]), anchor);
    const i1 = vertex(p1, region.uvAt(uv1[0], uv1[1]), anchor);
    const i2 = vertex(p2, region.uvAt(uv2[0], uv2[1]), anchor);
    const i3 = vertex(p3, region.uvAt(uv3[0], uv3[1]), anchor);
    tri(i0, i1, i2);
    tri(i0, i2, i3);
    record(region, [p0, p1, p2, p3]);
  }
  function box(center, axisX, axisY, axisZ) {
    const corner = (sx, sy, sz) => add(center, add(add(mul(axisX, sx), mul(axisY, sy)), mul(axisZ, sz)));
    const c000 = corner(-1, -1, -1), c100 = corner(1, -1, -1), c110 = corner(1, 1, -1), c010 = corner(-1, 1, -1);
    const c001 = corner(-1, -1, 1), c101 = corner(1, -1, 1), c111 = corner(1, 1, 1), c011 = corner(-1, 1, 1);
    quad(c000, c010, c110, c100); // -Z
    quad(c001, c101, c111, c011); // +Z
    quad(c000, c100, c101, c001); // -Y
    quad(c010, c011, c111, c110); // +Y
    quad(c000, c001, c011, c010); // -X
    quad(c100, c110, c111, c101); // +X
  }
  function cylinder(p0, p1, radius, sides, caps = true, patchDef = null) {
    const axis = sub(p1, p0);
    if (len(axis) < 1e-6) return;
    const w = norm(axis);
    const up = Math.abs(w[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
    const u = norm(cross(up, w));
    const v = cross(w, u);
    const ring = (center) => {
      const out = [];
      for (let i = 0; i < sides; i++) {
        const a = (i / sides) * Math.PI * 2;
        out.push(add(center, add(mul(u, Math.cos(a) * radius), mul(v, Math.sin(a) * radius))));
      }
      return out;
    };
    const r0 = ring(p0), r1 = ring(p1);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      quad(r0[i], r0[j], r1[j], r1[i], [[i / sides, 0], [(i + 1) / sides, 0], [(i + 1) / sides, 1], [i / sides, 1]], patchDef);
    }
    if (caps) {
      for (let i = 1; i < sides - 1; i++) {
        const region0 = patchDef
          ? legacyRegion(p0, patchDef)
          : regionForAnchor(context, p0, polygonArea([p0, r0[i + 1], r0[i]]));
        const c0 = vertex(p0, region0.uvAt(0.5, 0.5), p0);
        const a = vertex(r0[i + 1], region0.uvAt(0.85, 0.85), p0);
        const b = vertex(r0[i], region0.uvAt(0.15, 0.85), p0);
        tri(c0, a, b);
        record(region0, [p0, r0[i + 1], r0[i]]);
        const region1 = patchDef
          ? legacyRegion(p1, patchDef)
          : regionForAnchor(context, p1, polygonArea([p1, r1[i], r1[i + 1]]));
        const c1 = vertex(p1, region1.uvAt(0.5, 0.5), p1);
        const d = vertex(r1[i], region1.uvAt(0.85, 0.85), p1);
        const e = vertex(r1[i + 1], region1.uvAt(0.15, 0.85), p1);
        tri(c1, d, e);
        record(region1, [p1, r1[i], r1[i + 1]]);
      }
    }
  }
  function tube(points, radius, sides) {
    if (points.length < 2) return;
    const rings = points.map((p, i) => {
      const prev = points[Math.max(0, i - 1)], next = points[Math.min(points.length - 1, i + 1)];
      const w = norm(sub(next, prev));
      const up = Math.abs(w[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
      const u = norm(cross(up, w)), v = cross(w, u);
      const out = [];
      for (let k = 0; k < sides; k++) {
        const a = (k / sides) * Math.PI * 2;
        out.push(add(p, add(mul(u, Math.cos(a) * radius), mul(v, Math.sin(a) * radius))));
      }
      return out;
    });
    for (let i = 0; i < rings.length - 1; i++) {
      for (let k = 0; k < sides; k++) {
        const j = (k + 1) % sides;
        quad(rings[i][k], rings[i][j], rings[i + 1][j], rings[i + 1][k],
          [[k / sides, i / (rings.length - 1)], [(k + 1) / sides, i / (rings.length - 1)], [(k + 1) / sides, (i + 1) / (rings.length - 1)], [k / sides, (i + 1) / (rings.length - 1)]]);
      }
    }
  }

  return { added, info, bounds: b, box, cylinder, tube, quad, vertex, skin, legacyPatch };
}

// Weapon hardware, placed from the mesh's own surfaces and proportions:
// forward is +X, up is +Z and left is +Y in Quake's model space.
function addWeaponHardware(context) {
  const parts = makeParts(context);
  const { box, cylinder, tube, info, bounds: b } = parts;
  const size = b.size;
  const lo = b.lo, hi = b.hi;
  const span = (k) => Math.max(0.001, size[k]);
  const notes = [];

  // Muzzle cluster: faces in the forward sixth. Its centre is the barrel axis.
  const forward = info.filter((t) => t.center[0] > hi[0] - span(0) * 0.16 && t.area > 0.05);
  if (forward.length) {
    const fb = bounds(forward.flatMap((t) => [t.a, t.b, t.c]));
    const radius = Math.max(0.9, Math.min(fb.size[1], fb.size[2]) * 0.3);
    const half = Math.max(1.4, span(0) * 0.06);
    const center = [hi[0] - half * 0.8, fb.center[1], fb.center[2]];
    // Open rings, not capped discs: the barrel bore has to stay visible.
    cylinder(sub(center, [half * 0.8, 0, 0]), add(center, [half * 0.8, 0, 0]), radius + 0.16, 10, false);
    cylinder(add(center, [half * 0.9, 0, 0]), add(center, [half * 1.45, 0, 0]), radius + 0.03, 10, false);
    notes.push("muzzle");
  }

  // The other parts this pass used to add -- sight rail, vent louvres, trigger
  // guard, cable and rear bevels -- are gone. Each was placed from guessed
  // bounds and sat a little off the surface it was meant to detail; on a
  // magnified view weapon they read as flat untextured slabs and thin slivers
  // stuck through the gun, not as hardware. What is left is the one part that
  // can be placed from the model itself: the muzzle collar, which wraps the
  // barrel's own forward faces and cannot float.

  context.tris = context.tris.concat(parts.added);
  return notes.join("+");
}

// Enemy hardware keeps to the torso and shoulders, where nearest-face binding
// cannot fight the animation: chest vents and shoulder collars.
function addMonsterHardware(context) {
  const parts = makeParts(context);
  const { cylinder, info, bounds: b, legacyPatch } = parts;
  const size = b.size;
  const span = (k) => Math.max(0.001, size[k]);
  const notes = [];
  // Chest vents were placed in front of the torso from guessed bounds and read
  // as flat slabs hanging off the body; the shoulder collars below wrap boxes
  // the mesh already has, so they are the part kept.
  const shoulders = info.filter((t) => t.n[2] > 0.6 && t.area > 0.6)
    .filter((t) => t.center[2] > b.lo[2] + span(2) * 0.68 && Math.abs(t.center[1] - b.center[1]) > span(1) * 0.18);
  if (shoulders.length) {
    const sb = bounds(shoulders.flatMap((t) => [t.a, t.b, t.c]));
    for (const sign of [-1, 1]) {
      const y = b.center[1] + sign * Math.min(span(1) * 0.26, sb.size[1] * 0.3);
      cylinder([sb.center[0] - 0.5, y, sb.center[2] + 0.6], [sb.center[0] + 0.5, y, sb.center[2] + 0.6], Math.max(0.8, span(1) * 0.06), 7, true, legacyPatch);
    }
    notes.push("pauldrons");
  }
  context.tris = context.tris.concat(parts.added);
  return notes.join("+");
}

// Every frame is rebuilt from the original frame's bytes: the original vertices
// keep their exact values, a subdivided vertex follows its two edge endpoints
// (itself possibly a midpoint from the level before), and hardware follows the
// face it was bound to. Frame names, scale and origin are untouched.
function buildFrames(context) {
  const { model, finalVerts, smoothing, neighbors } = context;
  const originalCount = context.originalCount;
  const total = finalVerts.length;
  return model.frames.map((frame, f) => {
    const raw = [];
    for (let i = 0; i < originalCount; i++) raw.push(framePos(model, f, i));
    const base = smoothing && smoothing.lambda > 0
      ? inflate(relax(raw, neighbors, smoothing.lambda, smoothing.iterations), model.tris, smoothing.inflate)
      : raw;
    const memo = new Array(total);
    function posOf(i) {
      if (memo[i]) return memo[i];
      const v = finalVerts[i];
      let p;
      if (v.kind === "o") p = base[v.i];
      else if (v.kind === "s") p = add(mid(posOf(v.a), posOf(v.b)), v.delta);
      else {
        const tri = model.tris[v.tri];
        const A = base[tri.v[0]], B = base[tri.v[1]], C = base[tri.v[2]];
        const interp = add(add(mul(A, v.bary[0]), mul(B, v.bary[1])), mul(C, v.bary[2]));
        const basis = basisOf(A, B, C, v.restBasis);
        p = add(interp, add(add(mul(basis[0], v.deltaLocal[0]), mul(basis[1], v.deltaLocal[1])), mul(basis[2], v.deltaLocal[2])));
      }
      memo[i] = p;
      return p;
    }
    const out = Buffer.alloc(total * 4);
    for (let i = 0; i < total; i++) {
      const [x, y, z] = packVertex(frame, posOf(i), finalVerts[i].normal || 0);
      const o = i * 4;
      out[o] = x; out[o + 1] = y; out[o + 2] = z; out[o + 3] = finalVerts[i].normal || 0;
    }
    return { ...frame, verts: out };
  });
}

// ---------------------------------------------------------------------------
// Skin sampling: choose small, quiet patches of the existing atlas so new
// hardware reads as the same painted metal instead of a flat colour.
// ---------------------------------------------------------------------------

export function loadSkin(modelFile) {
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(DEFAULT_MANIFEST, "utf8"));
  } catch { return null; }
  const entry = manifest.entries.find((e) => normalizeName(e.name) === normalizeName(modelFile));
  if (!entry || !entry.png) return null;
  const file = path.join(ROOT, entry.png);
  if (!fs.existsSync(file)) return null;
  try { return decodePng(fs.readFileSync(file)); } catch { return null; }
}

function lumaAt(skin, x, y) {
  const i = (Math.min(skin.height - 1, Math.max(0, y)) * skin.width + Math.min(skin.width - 1, Math.max(0, x))) * 4;
  return 0.2126 * skin.data[i] + 0.7152 * skin.data[i + 1] + 0.0722 * skin.data[i + 2];
}

export function findQuietPatch(skin, targetLuma, size = 14, step = 2) {
  let best = { score: Infinity, x: 0, y: 0, size, mean: targetLuma, sd: 0 };
  for (let y = 0; y + size <= skin.height; y += step) {
    for (let x = 0; x + size <= skin.width; x += step) {
      let sum = 0, sum2 = 0, n = 0, sr = 0, sg = 0, sb = 0;
      for (let dy = 0; dy < size; dy += 2) {
        for (let dx = 0; dx < size; dx += 2) {
          const i = (Math.min(skin.height - 1, y + dy) * skin.width + Math.min(skin.width - 1, x + dx)) * 4;
          const r = skin.data[i], g = skin.data[i + 1], b = skin.data[i + 2];
          const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          sum += l; sum2 += l * l; n++;
          sr += r; sg += g; sb += b;
        }
      }
      const mean = sum / n;
      const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
      // Prefer quiet, near-neutral patches: the skin atlases also hold the
      // player's brightly painted hands, and a rail cut from those reads as
      // painted wood instead of metal.
      const saturation = (Math.max(sr, sg, sb) - Math.min(sr, sg, sb)) / n / 255;
      const score = sd + Math.abs(mean - targetLuma) * 0.35 + saturation * 60;
      if (score < best.score) best = { score, x, y, size, mean, sd };
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Calibration markers (--markers): three differently sized boxes at known model
// axes, so one screenshot can be read back into model space.
// ---------------------------------------------------------------------------

function addMarkers(model) {
  const rest = restPositions(model);
  const b = bounds(rest);
  const c = b.center;
  const defs = [
    { name: "FRONT", center: [b.hi[0] + 5, c[1], c[2]], half: 4.0 },
    { name: "UP", center: [c[0], c[1], b.hi[2] + 7], half: 3.0 },
    { name: "LEFT", center: [c[0], b.hi[1] + 7, c[2]], half: 2.0 },
  ];
  const baseXY = model.numXYZ;
  const boxes = defs.map((def) => ({
    ...def,
    points: [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]].map(
      ([sx, sy, sz]) => [def.center[0] + sx * def.half, def.center[1] + sy * def.half, def.center[2] + sz * def.half],
    ),
  }));
  model.st.push([Math.round(model.skinWidth * 0.5), Math.round(model.skinHeight * 0.5)]);
  const st0 = model.st.length - 1;
  for (const frame of model.frames) {
    const nv = Buffer.alloc(frame.verts.length + boxes.length * 8 * 4);
    frame.verts.copy(nv, 0);
    let at = frame.verts.length;
    for (const def of boxes) {
      for (const p of def.points) {
        const [x, y, z] = packVertex(frame, p);
        nv[at] = x; nv[at + 1] = y; nv[at + 2] = z; nv[at + 3] = 0;
        at += 4;
      }
    }
    frame.verts = nv;
  }
  const faces = [[0,1,2],[0,2,3],[4,6,5],[4,7,6],[0,4,5],[0,5,1],[3,2,6],[3,6,7],[0,3,7],[0,7,4],[1,5,6],[1,6,2]];
  boxes.forEach((def, bi) => {
    const base = baseXY + bi * 8;
    for (const f of faces) model.tris.push({ v: f.map((k) => base + k), t: [st0, st0, st0] });
  });
  return { model, note: "markers" };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

// The vertex and triangle counts the current geometry pass produces for the 13
// view weapons. A 2x skin must not change the mesh, so these are asserted by
// --verify rather than left as "it looked the same".
const BASELINE_COUNTS = {
  "v_bfg": [779, 1384],
  "v_blast": [628, 1080],
  "v_chain": [576, 1000],
  "v_disint": [779, 1384],
  "v_flareg": [797, 1456],
  "v_handgr": [902, 1664],
  "v_hyperb": [708, 1264],
  "v_launch": [864, 1576],
  "v_machn": [814, 1452],
  "v_rail": [790, 1440],
  "v_rocket": [810, 1464],
  "v_shotg": [596, 1048],
  "v_shotg2": [868, 1552],
};

// model space -> MD2 space for a 2x skin. Every ST coordinate is doubled with
// the declared size, so the normalised (st + 0.5) / skinSize the GL commands
// carry is untouched and the engine's animation, hit tests and texture lookup
// are exactly what they were.
function doubleSkin(model) {
  model.skinWidth *= 2;
  model.skinHeight *= 2;
  model.st = model.st.map(([s, t]) => [s * 2, t * 2]);
  return model;
}

function weaponSkinNames(directory) {
  const skins = new Map();
  for (const entry of directory.values()) {
    const match = /^(models\/weapons\/v_[a-z0-9]+)\/(?:skin|base)\.pcx$/i.exec(entry.name);
    if (match) skins.set(match[1].toLowerCase(), entry.name);
  }
  return skins;
}

// pak10's numbers, checked against pak0: exactly 2x pixels with the same
// palette and silhouette, an MD2 that declares the new size, an ST table that
// still means the same UVs, the same mesh, an upscaled skin that kept (and
// raised) its colour, and every added hardware face bound to its own barrel
// region instead of a guessed patch.
function verifySkins(pak, directory, only) {
  const problems = [];
  let pak10;
  try { pak10 = loadPak(OUT_PAK); } catch (error) {
    process.stderr.write("no readable " + OUT_PAK + " (" + error.message + ")\n");
    return 1;
  }
  const directory10 = readPakDirectory(pak10);
  const skins = weaponSkinNames(directory);
  const names = [...directory.values()].map((entry) => entry.name).filter((name) => WEAPON_RE.test(name)).sort()
    .filter((name) => !only || normalizeName(name) === normalizeName(only));
  if (!names.length) {
    process.stderr.write("no view weapon MD2 matches" + (only ? " --only " + only : "") + "\n");
    return 1;
  }
  const weaponPcx = [...directory10.values()].filter((entry) => /^models\/weapons\/v_[a-z0-9]+\/(skin|base)\.pcx$/i.test(entry.name));
  const weaponMd2 = [...directory10.values()].filter((entry) => WEAPON_RE.test(entry.name));
  console.log("pak10: " + weaponPcx.length + " view weapon skin(s), " + weaponMd2.length + " view weapon MD2(s)");
  if (!only && weaponPcx.length !== 13) problems.push("pak10 has " + weaponPcx.length + " view weapon skins, expected 13");
  if (!only && weaponMd2.length !== 13) problems.push("pak10 has " + weaponMd2.length + " view weapon MD2s, expected 13");
  let satBefore = 0, satAfter = 0, parts = 0, faceParts = 0;
  let worstEdge = 0, worstMismatch = 0, worstPitch = Infinity, worstLegacy = 0, worstLegacyEdge = 0;
  for (const name of names) {
    const short = name.replace("models/weapons/", "").replace("/tris.md2", "");
    const md2Entry = directory10.get(normalizeName(name));
    const skinName = skins.get(path.posix.dirname(name).toLowerCase());
    if (!md2Entry) { problems.push(short + ": pak10 has no " + name); continue; }
    if (!skinName) { problems.push(short + ": pak0 has no skin PCX beside it"); continue; }
    const skinEntry = directory10.get(normalizeName(skinName));
    if (!skinEntry) { problems.push(short + ": pak10 has no " + skinName); continue; }
    try {
      const originalMd2 = parseMd2(readPakFile(pak, name));
      const builtMd2 = parseMd2(readPakFile(pak10, name));
      const originalPcx = decodePcx(readPakFile(pak, skinName));
      const builtPcx = decodePcx(readPakFile(pak10, skinName));

      if (builtPcx.width !== originalPcx.width * 2 || builtPcx.height !== originalPcx.height * 2) {
        problems.push(short + ": PCX is " + builtPcx.width + "x" + builtPcx.height + ", not 2x " + originalPcx.width + "x" + originalPcx.height);
      }
      if (!builtPcx.palette.equals(originalPcx.palette)) problems.push(short + ": PCX palette differs from pak0");
      if (builtPcx.bytesPerLine !== builtPcx.width) problems.push(short + ": bytesPerLine " + builtPcx.bytesPerLine + " != width " + builtPcx.width);
      const sourceCutout = countCutout(originalPcx.indices);
      const builtCutout = countCutout(builtPcx.indices);
      if (builtCutout !== sourceCutout * 4) problems.push(short + ": cut-out " + sourceCutout + " -> " + builtCutout + ", expected 4x");
      if (builtMd2.skinWidth !== builtPcx.width || builtMd2.skinHeight !== builtPcx.height) {
        problems.push(short + ": MD2 skin " + builtMd2.skinWidth + "x" + builtMd2.skinHeight + " != PCX " + builtPcx.width + "x" + builtPcx.height);
      }
      if (!builtMd2.skins.length || normalizeName(builtMd2.skins[0]) !== normalizeName(skinName)) {
        problems.push(short + ": MD2 names skin " + builtMd2.skins[0] + ", expected " + skinName);
      }
      let stMin = [Infinity, Infinity], stMax = [-Infinity, -Infinity];
      for (const [s, t] of builtMd2.st) {
        stMin = [Math.min(stMin[0], s), Math.min(stMin[1], t)];
        stMax = [Math.max(stMax[0], s), Math.max(stMax[1], t)];
      }
      if (stMin[0] < 0 || stMin[1] < 0 || stMax[0] >= builtMd2.skinWidth || stMax[1] >= builtMd2.skinHeight) {
        problems.push(short + ": ST " + stMin + ".." + stMax + " outside " + builtMd2.skinWidth + "x" + builtMd2.skinHeight);
      }
      // The engine normalises a sample as (st + 0.5) / skinWidth, so that is what
      // must survive. An integer ST table can only land within half a 2x texel of
      // the exact doubled coordinate, which is a quarter of an original texel:
      // sub-pixel, and the whole point of a 2x skin.
      let stDrift = 0;
      for (let i = 0; i < originalMd2.st.length; i++) {
        const builtS = builtMd2.st[i][0], builtT = builtMd2.st[i][1];
        const normS = (builtS + 0.5) / builtMd2.skinWidth - (originalMd2.st[i][0] + 0.5) / originalMd2.skinWidth;
        const normT = (builtT + 0.5) / builtMd2.skinHeight - (originalMd2.st[i][1] + 0.5) / originalMd2.skinHeight;
        stDrift = Math.max(stDrift, Math.abs(normS) * builtMd2.skinWidth, Math.abs(normT) * builtMd2.skinHeight);
      }
      if (stDrift > 0.5 + 1e-6) problems.push(short + ": normalized UV drift " + stDrift.toFixed(3) + " target texels > 0.5");

      // Rebuild the mesh from pak0 with this tool's own code: its counts must be
      // the baseline (geometry unchanged), and every added face audited.
      const refined = buildRefined(parseMd2(readPakFile(pak, name)), { isWeapon: true, name, levels: Number(process.env.Q2_SUB_LEVELS || 1) });
      const verts = refined.model.frames[0].verts.length / 4;
      const tris = refined.model.tris.length;
      const baseline = BASELINE_COUNTS[short];
      if (baseline && (verts !== baseline[0] || tris !== baseline[1])) {
        problems.push(short + ": geometry " + verts + "/" + tris + " != baseline " + baseline[0] + "/" + baseline[1]);
      }
      if (builtMd2.frames[0].verts.length / 4 !== verts || builtMd2.tris.length !== tris) {
        problems.push(short + ": pak10 mesh " + (builtMd2.frames[0].verts.length / 4) + "/" + builtMd2.tris.length + " != rebuilt " + verts + "/" + tris);
      }
      const skinImage = loadSkin(originalMd2.skins[0]);
      const legacy = skinImage ? findQuietPatch(skinImage, 150, 14) : null;
      const legacyEdge = legacy && skinImage
        ? regionLumaStats(skinImage, lumaPlane(skinImage), legacy.x, legacy.y, legacy.size, legacy.size).edge
        : 0;
      let legacyMismatch = 0;
      for (const part of refined.hardware) {
        parts++;
        if (part.kind === "face") faceParts++;
        worstEdge = Math.max(worstEdge, part.edge);
        worstMismatch = Math.max(worstMismatch, part.mismatch);
        worstPitch = Math.min(worstPitch, part.pitchRatio);
        if (part.mismatch > 24) problems.push(short + ": hardware part mismatches its face by " + part.mismatch.toFixed(0) + " luma");
        if (part.edge > HARDWARE_MAX_EDGE) problems.push(short + ": hardware region edge " + part.edge + " > " + HARDWARE_MAX_EDGE);
        if (part.texels > HARDWARE_MAX_TEXELS) problems.push(short + ": hardware region " + part.texels + " texels > " + HARDWARE_MAX_TEXELS + " bound");
        if (part.pitchRatio < 0.45) problems.push(short + ": hardware texel pitch " + part.pitchRatio.toFixed(2) + "x the weapon median (blockiness)");
        if (legacy) legacyMismatch = Math.max(legacyMismatch, Math.abs(legacy.mean - part.faceMean));
      }
      worstLegacy = Math.max(worstLegacy, legacyMismatch);
      worstLegacyEdge = Math.max(worstLegacyEdge, legacyEdge);

      const before = meanSaturation(originalPcx.indices, originalPcx.palette);
      const after = meanSaturation(builtPcx.indices, builtPcx.palette);
      satBefore += before; satAfter += after;
      if (!(after > before)) problems.push(short + ": mean saturation " + before.toFixed(3) + " -> " + after.toFixed(3) + " did not rise");

      console.log(
        "  " + short.padEnd(9) + " PCX " + originalPcx.width + "x" + originalPcx.height + " -> " + builtPcx.width + "x" + builtPcx.height +
          "  palette same  cutout " + sourceCutout + "->" + builtCutout +
          "  MD2 " + builtMd2.skinWidth + "x" + builtMd2.skinHeight +
          "  ST " + stMin[0] + "," + stMin[1] + ".." + stMax[0] + "," + stMax[1] +
          " (drift " + stDrift.toFixed(2) + " texel)" +
          "  sat " + before.toFixed(3) + "->" + after.toFixed(3) +
          "  hw " + refined.hardware.length + " parts (" + refined.hardware.filter((p) => p.kind === "face").length + " face-bound)" +
          ", edge " + Math.max(...refined.hardware.map((p) => p.edge)) + " vs legacy " + legacyEdge +
          ", material " + Math.max(...refined.hardware.map((p) => p.mismatch)).toFixed(0) +
          " (legacy " + legacyMismatch.toFixed(0) + ")" +
          ", pitch " + Math.min(...refined.hardware.map((p) => p.pitchRatio)).toFixed(2) + "x" +
          "  mesh " + verts + "/" + tris,
      );
    } catch (error) {
      problems.push(short + ": " + (error && error.message ? error.message : String(error)));
    }
  }
  console.log(
    "saturation mean " + (satBefore / names.length).toFixed(3) + " -> " + (satAfter / names.length).toFixed(3) +
      "  hardware parts " + parts + " (" + faceParts + " face-bound)  worst edge " + worstEdge +
      "  worst material mismatch " + worstMismatch.toFixed(0) +
      "  legacy 14x14 patch: worst material mismatch " + worstLegacy.toFixed(0) + ", worst edge " + worstLegacyEdge +
      "  min texel pitch " + worstPitch.toFixed(2) + "x the weapon median",
  );
  if (problems.length) {
    for (const problem of problems) process.stderr.write("FAIL " + problem + "\n");
    console.log(problems.length + " problem(s)");
    return 1;
  }
  console.log("all 13 view weapons: 2x pixels, same palette, same cut-out shape, UVs within half a 2x texel, same mesh, more saturated, hardware bound to its own face");
  return 0;
}

function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const at = args.indexOf("--" + name);
    if (at < 0) return dflt;
    const value = args[at + 1];
    return value && !value.startsWith("--") ? value : true;
  };
  const dryRun = args.includes("--dry-run");
  const verify = args.includes("--verify");
  const only = opt("only", null);
  const markers = args.includes("--markers");
  const pak = loadPak(DEFAULT_PAK);
  const directory = readPakDirectory(pak);
  if (verify) {
    const status = verifySkins(pak, directory, only);
    if (status !== 0) process.exitCode = status;
    return;
  }
  const skins = weaponSkinNames(directory);
  const names = [...directory.values()]
    .map((e) => e.name)
    .filter((name) => WEAPON_RE.test(name) || (MONSTER_RE.test(name) && !SKIP_MODELS.has(name.split("/")[2] + "/" + (name.split("/")[2] === "parasite" ? name.split("/")[3] : ""))))
    .filter((name) => !only || normalizeName(name) === normalizeName(only))
    .sort();
  console.log("models: " + names.length + (only ? " (--only " + only + ")" : ""));
  const built = [];
  const skinEntries = [];
  let beforeXYZ = 0, afterXYZ = 0, beforeTris = 0, afterTris = 0;
  let satBefore = 0, satAfter = 0, skinCount = 0;
  for (const name of names) {
    const raw = readPakFile(pak, name);
    const model = parseMd2(raw);
    const isWeapon = WEAPON_RE.test(name);
    beforeXYZ += model.numXYZ; beforeTris += model.tris.length;
    const result = markers ? addMarkers(model) : buildRefined(model, { isWeapon, name, levels: Number(process.env.Q2_SUB_LEVELS || (process.env.Q2_NO_SUB ? 0 : 1)) });
    afterXYZ += result.model.frames[0].verts.length / 4;
    afterTris += result.model.tris.length;
    let skinNote = "";
    if (isWeapon && !markers) {
      // The view weapon keeps its own skin, at 2x: the MD2 declares the doubled
      // size and the same archive carries the upscaled PCX beside it. A later
      // pak wins, so pak10 replaces pak0's skin without any engine change.
      const skinName = skins.get(path.posix.dirname(name).toLowerCase());
      if (!skinName) throw new Error("pak0 has no skin PCX beside " + name);
      const upscaled = upscaleSkin2x(readPakFile(pak, skinName));
      doubleSkin(result.model);
      skinEntries.push({ name: skinName, data: upscaled.bytes });
      skinCount++;
      satBefore += upscaled.stats.sourceSaturation;
      satAfter += upscaled.stats.saturation;
      skinNote = "  skin 2x " + upscaled.width + "x" + upscaled.height + " sat " + upscaled.stats.sourceSaturation.toFixed(3) + "->" + upscaled.stats.saturation.toFixed(3);
    }
    const bytes = encodeMd2(result.model);
    built.push({ name, data: bytes });
    const worst = result.hardwareWorst;
    console.log(
      "  " + name.replace(/^models\/(weapons|monsters)\//, "").padEnd(34) +
      " verts " + String(model.numXYZ).padStart(4) + " -> " + String(result.model.frames[0].verts.length / 4).padStart(4) +
      "  tris " + String(model.tris.length).padStart(4) + " -> " + String(result.model.tris.length).padStart(5) +
      "  " + (bytes.length / 1024).toFixed(0).padStart(5) + " KiB" + (result.note ? "  " + result.note : "") +
      (worst && worst.parts ? "  hw " + worst.parts + " edge " + worst.maxEdge + " material " + worst.maxMismatch.toFixed(0) + " pitch " + worst.minPitchRatio.toFixed(2) + "x" : "") +
      skinNote,
    );
  }
  console.log("total verts " + beforeXYZ + " -> " + afterXYZ + ", tris " + beforeTris + " -> " + afterTris);
  if (skinCount) console.log("2x skins: " + skinCount + ", mean saturation " + (satBefore / skinCount).toFixed(3) + " -> " + (satAfter / skinCount).toFixed(3));
  const { buffer } = buildPakFromEntries([...built, ...skinEntries]);
  const existing = fs.existsSync(OUT_PAK) ? fs.readFileSync(OUT_PAK) : null;
  const identical = existing && existing.length === buffer.length && existing.equals(buffer);
  const delta = existing ? buffer.length - existing.length : buffer.length;
  console.log((identical ? "unchanged: " : "pak10: ") + "baseq2/pak10.pak, " + (buffer.length / 1048576).toFixed(2) + " MiB" + (existing && delta ? " (" + (delta > 0 ? "+" : "") + delta + " bytes)" : "") + (dryRun ? " (dry run: nothing written)" : ""));
  if (!dryRun && !identical) writePakBytes(buffer, OUT_PAK);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
