#!/usr/bin/env node
// scripts/model-geometry.mjs -- procedural detail for Quake 2's MD2 models.
//
// The engine draws every weapon and monster from an MD2 mesh. This tool rebuilds
// those meshes at a higher effective polygon budget -- one uniform edge split per
// face, with the new edge midpoints pulled onto the endpoint tangent planes, so
// curved barrels, heads and limbs stop reading as flat blocks -- and adds
// procedurally modelled hardware (barrel collars, vent ribs, sight rails, grip
// straps, trigger guards, cabling) in the same model space. Every new vertex is
// bound to the original triangles, so the game's own frame animation, frame
// timing and hit detection are carried over untouched. The skins are untouched:
// new faces sample the model's existing UV atlas.
//
// The result is written to baseq2/pak10.pak, which the engine loads after pak0;
// a later PAK wins in Quake 2's file system, so these meshes replace the
// originals while the original archive, maps, sounds and skins stay as shipped.
//
//   node scripts/model-geometry.mjs --build          # write baseq2/pak10.pak
//   node scripts/model-geometry.mjs --dry-run        # measure, write nothing
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
  decodePng,
  loadPak,
  normalizeName,
  readPakDirectory,
  readPakFile,
  writePakBytes,
} from "./texture-lib.mjs";

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
      const p = lerp(m, mid(ta, tb), PHONG_BLEND);
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
  return { model: refined, note };
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

// Bind one hardware vertex to the original surface: nearest point on the
// nearest original face, stored as barycentrics plus an offset in that face's
// own frame, so every generated vertex follows the game's animation exactly.
function bindVertex(context, p, normalIndex = 0) {
  const { model, rest } = context;
  let best = { distance: Infinity, tri: 0, bary: [1, 0, 0], point: rest[0] };
  for (let t = 0; t < model.tris.length; t++) {
    const tri = model.tris[t];
    const a = rest[tri.v[0]], b = rest[tri.v[1]], c = rest[tri.v[2]];
    const hit = closestOnTriangle(p, a, b, c);
    const d = len(sub(p, hit.point));
    if (d < best.distance) best = { distance: d, tri: t, bary: hit.bary, point: hit.point };
  }
  const tri = model.tris[best.tri];
  const a = rest[tri.v[0]], b = rest[tri.v[1]], c = rest[tri.v[2]];
  const basis = basisOf(a, b, c);
  const delta = sub(p, best.point);
  const deltaLocal = [dot(delta, basis[0]), dot(delta, basis[1]), dot(delta, basis[2])];
  const index = context.finalVerts.length;
  context.finalVerts.push({
    kind: "h", tri: best.tri, bary: best.bary, deltaLocal,
    restBasis: basis, st: null, normal: normalIndex,
  });
  context.restPos.push(p);
  return index;
}

// --- procedural parts ------------------------------------------------------

function makeParts(context) {
  const { model, rest } = context;
  const skin = loadSkin(model.skins[0]);
  const patch = (target, size) => {
    if (!skin) return { x: 0, y: 0, size: 16 };
    return findQuietPatch(skin, target, size);
  };
  const patches = {
    metal: patch(105, 16),
    dark: patch(50, 16),
    steel: patch(150, 14),
    grip: patch(38, 18),
  };
  const b = bounds(rest);
  const tris = model.tris;
  const info = tris.map((tri) => {
    const a = rest[tri.v[0]], bb = rest[tri.v[1]], c = rest[tri.v[2]];
    const n = triNormal(a, bb, c);
    return { tri, a, b: bb, c, n, area: len(cross(sub(bb, a), sub(c, a))) / 2, center: mul(add(add(a, bb), c), 1 / 3) };
  });
  const added = [];
  const uvFor = (patchDef, u, v) => [patchDef.x + 0.5 + u * (patchDef.size - 1), patchDef.y + 0.5 + v * (patchDef.size - 1)];
  function vertex(p, uv) {
    const index = bindVertex(context, p, 0);
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
  function quad(patchDef, p0, p1, p2, p3, uvs) {
    const [uv0, uv1, uv2, uv3] = uvs || [[0, 0], [1, 0], [1, 1], [0, 1]];
    const i0 = vertex(p0, uvFor(patchDef, uv0[0], uv0[1]));
    const i1 = vertex(p1, uvFor(patchDef, uv1[0], uv1[1]));
    const i2 = vertex(p2, uvFor(patchDef, uv2[0], uv2[1]));
    const i3 = vertex(p3, uvFor(patchDef, uv3[0], uv3[1]));
    tri(i0, i1, i2);
    tri(i0, i2, i3);
  }
  function box(center, axisX, axisY, axisZ, patchDef) {
    const corner = (sx, sy, sz) => add(center, add(add(mul(axisX, sx), mul(axisY, sy)), mul(axisZ, sz)));
    const c000 = corner(-1, -1, -1), c100 = corner(1, -1, -1), c110 = corner(1, 1, -1), c010 = corner(-1, 1, -1);
    const c001 = corner(-1, -1, 1), c101 = corner(1, -1, 1), c111 = corner(1, 1, 1), c011 = corner(-1, 1, 1);
    quad(patchDef, c000, c010, c110, c100); // -Z
    quad(patchDef, c001, c101, c111, c011); // +Z
    quad(patchDef, c000, c100, c101, c001); // -Y
    quad(patchDef, c010, c011, c111, c110); // +Y
    quad(patchDef, c000, c001, c011, c010); // -X
    quad(patchDef, c100, c110, c111, c101); // +X
  }
  function cylinder(p0, p1, radius, sides, patchDef, caps = true) {
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
      quad(patchDef, r0[i], r0[j], r1[j], r1[i], [[i / sides, 0], [(i + 1) / sides, 0], [(i + 1) / sides, 1], [i / sides, 1]]);
    }
    if (caps) {
      for (let i = 1; i < sides - 1; i++) {
        const c0 = vertex(p0, uvFor(patchDef, 0.5, 0.5));
        const a = vertex(r0[i + 1], uvFor(patchDef, 0.85, 0.85));
        const b = vertex(r0[i], uvFor(patchDef, 0.15, 0.85));
        tri(c0, a, b);
        const c1 = vertex(p1, uvFor(patchDef, 0.5, 0.5));
        const d = vertex(r1[i], uvFor(patchDef, 0.85, 0.85));
        const e = vertex(r1[i + 1], uvFor(patchDef, 0.15, 0.85));
        tri(c1, d, e);
      }
    }
  }
  function tube(points, radius, sides, patchDef) {
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
        quad(patchDef, rings[i][k], rings[i][j], rings[i + 1][j], rings[i + 1][k],
          [[k / sides, i / (rings.length - 1)], [(k + 1) / sides, i / (rings.length - 1)], [(k + 1) / sides, (i + 1) / (rings.length - 1)], [k / sides, (i + 1) / (rings.length - 1)]]);
      }
    }
  }

  return { patches, added, info, bounds: b, box, cylinder, tube, quad, vertex, uvFor, skin };
}

// Weapon hardware, placed from the mesh's own surfaces and proportions:
// forward is +X, up is +Z and left is +Y in Quake's model space.
function addWeaponHardware(context) {
  const parts = makeParts(context);
  const { patches, box, cylinder, tube, info, bounds: b } = parts;
  const size = b.size;
  const lo = b.lo, hi = b.hi;
  const span = (k) => Math.max(0.001, size[k]);
  const notes = [];

  // Muzzle cluster: faces in the forward sixth. Its centre is the barrel axis.
  const forward = info.filter((t) => t.center[0] > hi[0] - span(0) * 0.16 && t.area > 0.05);
  if (forward.length) {
    const fb = bounds(forward.flatMap((t) => [t.a, t.b, t.c]));
    const radius = Math.max(1.1, Math.min(fb.size[1], fb.size[2]) * 0.4);
    const half = Math.max(1.4, span(0) * 0.06);
    const center = [hi[0] - half * 0.8, fb.center[1], fb.center[2]];
    // Open rings, not capped discs: the barrel bore has to stay visible.
    cylinder(sub(center, [half * 0.8, 0, 0]), add(center, [half * 0.8, 0, 0]), radius + 0.22, 10, patches.metal, false);
    cylinder(add(center, [half * 0.9, 0, 0]), add(center, [half * 1.45, 0, 0]), radius + 0.05, 10, patches.steel, false);
    notes.push("muzzle");
  }

  // Sight rail: a low rail over the top faces, with a front blade and a rear
  // notch block.
  const top = info.filter((t) => t.n[2] > 0.55 && t.area > 0.2)
    .filter((t) => t.center[0] > lo[0] + span(0) * 0.28 && t.center[0] < hi[0] - span(0) * 0.12);
  if (top.length) {
    const tb = bounds(top.flatMap((t) => [t.a, t.b, t.c]));
    const railX0 = tb.center[0] - tb.size[0] * 0.34;
    const railX1 = tb.center[0] + tb.size[0] * 0.34;
    const railY = tb.center[1];
    const railZ = tb.hi[2] + 0.16;
    box([(railX0 + railX1) / 2, railY, railZ], [Math.max(1.2, (railX1 - railX0) / 2), 0, 0], [0, 0.5, 0], [0, 0, 0.22], patches.steel);
    box([railX1 - 0.3, railY, railZ + 0.8], [0.55, 0, 0], [0, 0.62, 0], [0, 0, 0.7], patches.steel);
    box([railX0 + 0.5, railY, railZ + 0.55], [0.45, 0, 0], [0, 0.5, 0], [0, 0, 0.5], patches.dark);
    notes.push("rail");
  }

  // Vent ribs on the side with the most vertical surface, in the receiver band.
  const sides = info.filter((t) => Math.abs(t.n[1]) > 0.62 && t.area > 0.15)
    .filter((t) => t.center[2] > lo[2] + span(2) * 0.3 && t.center[2] < hi[2] - span(2) * 0.15)
    .filter((t) => t.center[0] > lo[0] + span(0) * 0.25 && t.center[0] < hi[0] - span(0) * 0.2);
  if (sides.length) {
    let sum = 0;
    for (const t of sides) sum += Math.sign(t.n[1]) * t.area;
    const sideSign = sum >= 0 ? 1 : -1;
    const chosen = sides.filter((t) => Math.sign(t.n[1]) === sideSign);
    const sb = bounds(chosen.flatMap((t) => [t.a, t.b, t.c]));
    const sideY = sideSign > 0 ? sb.hi[1] : sb.lo[1];
    const xHalf = Math.max(0.7, sb.size[0] * 0.16);
    const zHalf = Math.max(0.65, sb.size[2] * 0.11);
    // A shallow housing plate ties the ribs to the receiver, so they read as
    // louvres in a panel rather than three rods stuck to the side.
    box([sb.center[0], sideY + sideSign * 0.06, sb.center[2]], [xHalf, 0, 0], [0, 0.1, 0], [0, 0, zHalf], patches.metal);
    for (let i = 0; i < 2; i++) {
      const z = sb.center[2] - zHalf * 0.42 + i * zHalf * 0.84;
      box([sb.center[0], sideY + sideSign * 0.19, z], [xHalf * 0.9, 0, 0], [0, 0.14, 0], [0, 0, 0.16], patches.dark);
    }
    notes.push("vents");
  }

  // Trigger guard: an arc under the receiver where the grip meets the body.
  const lowBand = info.filter((t) => t.center[2] < lo[2] + span(2) * 0.45)
    .filter((t) => t.center[0] > lo[0] + span(0) * 0.2 && t.center[0] < hi[0] - span(0) * 0.3);
  if (lowBand.length) {
    const lb = bounds(lowBand.flatMap((t) => [t.a, t.b, t.c]));
    const guardX = lb.center[0];
    const guardZ = lb.center[2] + 0.4;
    const guardY = lb.center[1];
    const radius = Math.max(1.1, Math.min(span(1), span(2)) * 0.14);
    const arc = [];
    for (let i = 0; i <= 6; i++) {
      const a = -0.35 + (i / 6) * Math.PI * 1.15;
      arc.push([guardX + Math.cos(a) * radius, guardY, guardZ - Math.sin(a) * radius * 1.15]);
    }
    tube(arc, 0.5, 6, patches.grip);
    box(arc[0], [0.72, 0, 0], [0, 0.62, 0], [0, 0, 0.55], patches.grip);
    box(arc[arc.length - 1], [0.72, 0, 0], [0, 0.62, 0], [0, 0, 0.55], patches.grip);
    notes.push("guard");
  }

  // Cable: a slack run that hugs the underside of the receiver, so it reads as
  // cabling along the body rather than a loop hanging in the air.
  const cx0 = lo[0] + span(0) * 0.2, cx1 = hi[0] - span(0) * 0.2;
  const cy = b.center[1] - span(1) * 0.16;
  const cablePoints = [];
  for (let i = 0; i <= 5; i++) {
    const t = i / 5;
    const x = cx0 + (cx1 - cx0) * t;
    let floorZ = lo[2] + span(2) * 0.2;
    const near = context.rest.filter((p) => Math.abs(p[0] - x) < span(0) * 0.06 && Math.abs(p[1] - cy) < span(1) * 0.4);
    if (near.length) floorZ = Math.min(...near.map((p) => p[2]));
    cablePoints.push([x, cy, floorZ - 0.22 - Math.sin(t * Math.PI) * span(2) * 0.025]);
  }
  tube(cablePoints, 0.42, 6, patches.dark);
  for (const index of [0, cablePoints.length - 1]) {
    box(cablePoints[index], [0.62, 0, 0], [0, 0.62, 0], [0, 0, 0.5], patches.metal);
  }
  notes.push("cable");

  // Bevel strips on the rear edges: low wedges that catch the rim light instead
  // of leaving a bare block corner.
  const rear = info.filter((t) => t.n[0] < -0.45 && t.area > 0.25 && t.center[0] < lo[0] + span(0) * 0.4);
  if (rear.length) {
    const rb = bounds(rear.flatMap((t) => [t.a, t.b, t.c]));
    box([rb.center[0] - 0.2, rb.center[1], rb.center[2]], [0.35, 0, 0], [0, rb.size[1] * 0.34, 0], [0, 0, 0.4], patches.steel);
    notes.push("bevel");
  }

  context.tris = context.tris.concat(parts.added);
  return notes.join("+");
}

// Enemy hardware keeps to the torso and shoulders, where nearest-face binding
// cannot fight the animation: chest vents and shoulder collars.
function addMonsterHardware(context) {
  const parts = makeParts(context);
  const { patches, box, cylinder, info, bounds: b } = parts;
  const size = b.size;
  const span = (k) => Math.max(0.001, size[k]);
  const notes = [];
  const front = info.filter((t) => t.n[0] > 0.55 && t.area > 0.5)
    .filter((t) => t.center[2] > b.lo[2] + span(2) * 0.45 && t.center[2] < b.lo[2] + span(2) * 0.8);
  if (front.length) {
    const fb = bounds(front.flatMap((t) => [t.a, t.b, t.c]));
    const x = fb.hi[0] + 0.2;
    for (let i = 0; i < 3; i++) {
      box([x, fb.center[1] - 1.8 + i * 1.8, fb.center[2]], [0.28, 0, 0], [0, 0.55, 0], [0, 0, 0.32], patches.dark);
    }
    notes.push("vents");
  }
  const shoulders = info.filter((t) => t.n[2] > 0.6 && t.area > 0.6)
    .filter((t) => t.center[2] > b.lo[2] + span(2) * 0.68 && Math.abs(t.center[1] - b.center[1]) > span(1) * 0.18);
  if (shoulders.length) {
    const sb = bounds(shoulders.flatMap((t) => [t.a, t.b, t.c]));
    for (const sign of [-1, 1]) {
      const y = b.center[1] + sign * Math.min(span(1) * 0.26, sb.size[1] * 0.3);
      cylinder([sb.center[0] - 0.5, y, sb.center[2] + 0.6], [sb.center[0] + 0.5, y, sb.center[2] + 0.6], Math.max(0.8, span(1) * 0.06), 7, patches.steel);
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
      let sum = 0, sum2 = 0, n = 0;
      for (let dy = 0; dy < size; dy += 2) {
        for (let dx = 0; dx < size; dx += 2) {
          const l = lumaAt(skin, x + dx, y + dy);
          sum += l; sum2 += l * l; n++;
        }
      }
      const mean = sum / n;
      const sd = Math.sqrt(Math.max(0, sum2 / n - mean * mean));
      const score = sd + Math.abs(mean - targetLuma) * 0.35;
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

function main() {
  const args = process.argv.slice(2);
  const opt = (name, dflt) => {
    const at = args.indexOf("--" + name);
    if (at < 0) return dflt;
    const value = args[at + 1];
    return value && !value.startsWith("--") ? value : true;
  };
  const dryRun = args.includes("--dry-run");
  const only = opt("only", null);
  const markers = args.includes("--markers");
  const pak = loadPak(DEFAULT_PAK);
  const directory = readPakDirectory(pak);
  const names = [...directory.values()]
    .map((e) => e.name)
    .filter((name) => WEAPON_RE.test(name) || (MONSTER_RE.test(name) && !SKIP_MODELS.has(name.split("/")[2] + "/" + (name.split("/")[2] === "parasite" ? name.split("/")[3] : ""))))
    .filter((name) => !only || normalizeName(name) === normalizeName(only))
    .sort();
  console.log("models: " + names.length + (only ? " (--only " + only + ")" : ""));
  const built = [];
  let beforeXYZ = 0, afterXYZ = 0, beforeTris = 0, afterTris = 0;
  for (const name of names) {
    const raw = readPakFile(pak, name);
    const model = parseMd2(raw);
    const isWeapon = WEAPON_RE.test(name);
    beforeXYZ += model.numXYZ; beforeTris += model.tris.length;
    const result = markers ? addMarkers(model) : buildRefined(model, { isWeapon, name, levels: Number(process.env.Q2_SUB_LEVELS || (process.env.Q2_NO_SUB ? 0 : 1)) });
    afterXYZ += result.model.frames[0].verts.length / 4;
    afterTris += result.model.tris.length;
    const bytes = encodeMd2(result.model);
    built.push({ name, data: bytes });
    console.log(
      "  " + name.replace(/^models\/(weapons|monsters)\//, "").padEnd(34) +
      " verts " + String(model.numXYZ).padStart(4) + " -> " + String(result.model.frames[0].verts.length / 4).padStart(4) +
      "  tris " + String(model.tris.length).padStart(4) + " -> " + String(result.model.tris.length).padStart(5) +
      "  " + (bytes.length / 1024).toFixed(0).padStart(5) + " KiB" + (result.note ? "  " + result.note : ""),
    );
  }
  console.log("total verts " + beforeXYZ + " -> " + afterXYZ + ", tris " + beforeTris + " -> " + afterTris);
  const { buffer } = buildPakFromEntries(built);
  const existing = fs.existsSync(OUT_PAK) ? fs.readFileSync(OUT_PAK) : null;
  const identical = existing && existing.length === buffer.length && existing.equals(buffer);
  console.log((identical ? "unchanged: " : "pak10: ") + "baseq2/pak10.pak, " + (buffer.length / 1048576).toFixed(2) + " MiB" + (dryRun ? " (dry run: nothing written)" : ""));
  if (!dryRun && !identical) writePakBytes(buffer, OUT_PAK);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
