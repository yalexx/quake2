#!/usr/bin/env node
// scripts/material-classes-test.mjs -- the material contract t3 and t4 draw by.
//
//   node scripts/material-classes-test.mjs     # exit 0 pass, 1 fail
//
// Three things are pinned here:
//
//   1. the thirteen names and the rule order. The rules are read in order and
//      the first match wins, so the tests put two plausible classes on one name
//      (`trigger` with light flag 1 is still a sign) and check the boundary the
//      other way as well: `cgrate` is c+grate, not "crate", and reaches the
//      metal rule; `exitdr` contains "exit" and reaches the sign rule, which is
//      why the reviewed table promotes the real exit doors to tech.
//   2. the rust promotion. The share of rust-hued source pixels is measured on
//      the optional source picture; at 35% a metal name becomes rust, below 35%
//      it stays metal, and a table row never moves with the source.
//   3. the reviewed table and the manifest. The table must decide every one of
//      the 270 reviewed WALs that carry replacement art plus the ones the
//      coverage pass added (every art-bearing WAL, never fewer than the 270
//      reviewed), every row must name a real material and say why, and every
//      animname link in the archive must share one material, so an animation
//      cannot flicker between recipes.

import { MATERIALS, RUST_SHARE, TABLE, materialCounts, materialFor, materialKey } from "./material-classes.mjs";
import { textureTargets } from "./hires-art.mjs";
import { readManifest } from "./texture-lib.mjs";

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

const RECORD = { flags: 0, contents: 0, animname: "" };
function entry(name, extra = {}) {
  return { name: "textures/test/" + name + ".wal", ...RECORD, ...extra };
}
function materialOf(name, extra = {}, source = null) {
  return materialFor(entry(name, extra), source).material;
}
function answerOf(name, extra = {}, source = null) {
  return materialFor(entry(name, extra), source);
}

// A source picture: one row of RGB triples, so the pixel fraction is exact.
function sourceOf(pixels) {
  const rgb = new Uint8Array(pixels.length * 3);
  pixels.forEach((p, i) => rgb.set(p, i * 3));
  return { width: pixels.length, height: 1, rgb };
}
const RUST_PIXEL = [150, 80, 25]; // hue 26.4, saturation 0.83
const GREY_PIXEL = [110, 110, 115]; // no hue worth counting
const GREY_PIXEL_B = [120, 120, 125]; // second grey, so a 0% fixture is not uniform
function withShare(count, total) {
  const pixels = [];
  for (let i = 0; i < total; i++) pixels.push(i < count ? RUST_PIXEL : i % 2 ? GREY_PIXEL_B : GREY_PIXEL);
  return sourceOf(pixels);
}

// ---------------------------------------------------------------------------
// 1. The names
// ---------------------------------------------------------------------------
process.stdout.write("the contract\n");
check("MATERIALS is exactly the thirteen agreed strings", MATERIALS.length === 13 && MATERIALS.join(",") === "stone,metal,rust,tech,crate,wood,organic,lamp,glass,sign,water,sky,flat", MATERIALS.join(","));
check("MATERIALS is frozen, so a caller cannot rename one", Object.isFrozen(MATERIALS));
check("a table answer is { material, why, by: table }", (() => {
  const a = materialFor({ name: "textures/e1u1/grnx1_1.wal" });
  return a.by === "table" && a.material === "metal" && typeof a.why === "string" && a.why.length > 0;
})());
check("a rule answer is { material, why, by: rule }", (() => {
  const a = answerOf("wall1");
  return a.by === "rule" && a.material === "stone" && typeof a.why === "string" && a.why.length > 0;
})());
check("a record with no name is refused", (() => {
  try { materialFor({ flags: 0 }); return false; } catch (error) { return error instanceof TypeError; }
})());

// ---------------------------------------------------------------------------
// 2. The rules, first match wins
// ---------------------------------------------------------------------------
process.stdout.write("\nrule order\n");
check("sky: surface flag 4", materialOf("wall", { flags: 4 }) === "sky");
check("sky: a name beginning with sky", materialOf("sky1") === "sky");
check("sky wins over water contents", materialOf("wall", { flags: 4, contents: 32 }) === "sky");
check("water: warp flag 8", materialOf("wall", { flags: 8 }) === "water");
check("water: lava contents 8", materialOf("wall", { contents: 8 }) === "water");
check("water: slime contents 16", materialOf("wall", { contents: 16 }) === "water");
check("water: water contents 32", materialOf("wall", { contents: 32 }) === "water");
check("water: contents 64 is not a liquid", materialOf("wall", { contents: 64 }) === "stone");
check("water: watr/water/bluwter names", materialOf("watr1") === "water" && materialOf("water2") === "water" && materialOf("bluwter") === "water");
check("water wins over flat", materialOf("black", { flags: 8 }) === "water");
check("flat: the name black", materialOf("black") === "flat");
check("flat: a uniform source", materialOf("wall", {}, sourceOf([GREY_PIXEL, GREY_PIXEL, GREY_PIXEL])) === "flat");
check("a near-uniform source is not flat", materialOf("wall", {}, sourceOf([[10, 10, 10], [12, 10, 10]])) === "stone");
check("flat wins over sign when the source is uniform", materialOf("trigger", {}, sourceOf([GREY_PIXEL, GREY_PIXEL])) === "flat");
check("sign: sign/arrow/exit/endsign/kcsign", ["sign4", "arrow0", "exit1", "endsign2", "kcsign4"].every((n) => materialOf(n) === "sign"));
check("sign: trigger/basemap/alarm/lever", ["trigger", "basemap", "alarm0", "lever3"].every((n) => materialOf(n) === "sign"));
check("sign wins over lamp", materialOf("trigger", { flags: 1 }) === "sign");
check("lamp: light flag 1", materialOf("wall", { flags: 1 }) === "lamp");
check("lamp: plite/lite/light/baselt/baslt names", ["plite1_1", "light3", "baselt_2", "baslt3_1"].every((n) => materialOf(n) === "lamp"));
check("lamp wins over glass", materialOf("wndow_light") === "lamp");
check("glass: a wndow name", materialOf("wndow0_3") === "glass");
check("crate: box and crate names", materialOf("box1_1") === "crate" && materialOf("crate1_1") === "crate");
check("cgrate is c+grate, so it reaches metal, not crate", materialOf("cgrate1_1") === "metal");
check("crate wins over tech", materialOf("box_comp") === "crate");
check("tech: computer/machine/door names", ["comp1_1", "btactmach0", "timpod3", "shooter2", "btshoot1", "dr02_1", "keydr1_1", "refdr3_1", "hdoor1_1", "keydran1_1", "btelev_up"].every((n) => materialOf(n) === "tech"));
check("exitdr hits the earlier exit sign rule before tech", materialOf("exitdr9_1") === "sign");
check("tech wins over organic", materialOf("grnx_comp") === "tech");
check("organic: grass/grnx/sewer names", materialOf("grass1_7") === "organic" && materialOf("grnx1_1") === "organic" && materialOf("sewer1") === "organic");
check("organic wins over stone", materialOf("grass_rocks") === "organic");
check("stone: rock/concrete/ceiling/floor names", ["rocks19_1", "grnmt1_1", "wbasic1_1", "basic1_7", "wslt1_1", "wswall1_1", "cgrbase1_1", "broken2_1", "damage1_1", "ceil1_2", "floor3_2", "florr1_2", "flat1_1"].every((n) => materialOf(n) === "stone"));
check("flat1 is a stone floor, not the flat recipe", materialOf("flat1_1") === "stone");
check("stone wins over metal", materialOf("metal_floor") === "stone");
check("metal: steel/pipe/grate/trim/paint names", ["metal2_1", "c_met5_1", "wmtal3_5", "pipe1_2", "pip01_1", "rpip2_2", "support1_1", "wsupprt1_3", "grate1_1", "ggrat2_1", "wplat1_1", "wtroof4_2", "color1_2", "red1_1", "yellow1_2", "caution1_1", "p_tub1_1"].every((n) => materialOf(n) === "metal"));
check("default: an unread name is stone", materialOf("wall1") === "stone" && materialOf("grey1_3") === "stone");

// ---------------------------------------------------------------------------
// 3. Rust promotion (metal only, source driven)
// ---------------------------------------------------------------------------
process.stdout.write("\nrust promotion\n");
check("RUST_SHARE is the contract's 35%", RUST_SHARE === 0.35);
check("metal with no source stays metal", materialOf("metal2_1") === "metal");
check("metal with 0% rust-hued pixels stays metal", materialOf("metal2_1", {}, withShare(0, 20)) === "metal");
check("metal with 34% rust-hued pixels stays metal", materialOf("metal2_1", {}, withShare(17, 50)) === "metal");
check("metal with exactly 35% rust-hued pixels becomes rust", materialOf("metal2_1", {}, withShare(7, 20)) === "rust");
check("metal with 100% rust-hued but non-uniform pixels becomes rust", materialOf("metal2_1", {}, sourceOf([[150, 80, 25], [151, 80, 25]])) === "rust");
check("hue 10 is inside the rust band", materialOf("metal2_1", {}, sourceOf([[140, 40, 20], GREY_PIXEL])) === "rust");
check("hue 45 is inside the rust band", materialOf("metal2_1", {}, sourceOf([[200, 155, 20], GREY_PIXEL])) === "rust");
check("hue 46 is outside the rust band", materialOf("metal2_1", {}, sourceOf([[200, 157, 20], GREY_PIXEL])) === "metal");
check("saturation exactly 0.25 is outside the rust band", materialOf("metal2_1", {}, sourceOf([[200, 160, 150], GREY_PIXEL])) === "metal");
check("a non-metal name is never promoted by a rust source", materialOf("floor3_2", {}, sourceOf([[150, 80, 25], [151, 80, 25]])) === "stone");
check("a rust share is reported to one decimal", answerOf("metal2_1", {}, withShare(69, 200)).why.includes("34.5%"), answerOf("metal2_1", {}, withShare(69, 200)).why);
check("a table row never moves with the source", (() => {
  const a = materialFor({ name: "textures/e1u1/grnx1_1.wal" }, sourceOf([[150, 80, 25], [151, 80, 25]]));
  return a.material === "metal" && a.by === "table";
})());

// ---------------------------------------------------------------------------
// 4. The reviewed table
// ---------------------------------------------------------------------------
process.stdout.write("\nreviewed table\n");
const manifest = readManifest();
const targets = textureTargets(manifest);
const targetKeys = new Set(targets.map((e) => materialKey(e)));
const tableKeys = new Set(Object.keys(TABLE));
check("the table decides every texture with replacement art (the 270 reviewed, plus coverage)", targets.length === tableKeys.size && targets.length >= 270, targets.length + " targets, " + tableKeys.size + " rows");
check("every target is in the table", [...targetKeys].every((key) => tableKeys.has(key)), [...targetKeys].filter((key) => !tableKeys.has(key)).slice(0, 4).join(", "));
check("the table has no key that is not a target", [...tableKeys].every((key) => targetKeys.has(key)), [...tableKeys].filter((key) => !targetKeys.has(key)).slice(0, 4).join(", "));
check("every table row names a real material", Object.entries(TABLE).every(([, row]) => MATERIALS.includes(row.material)));
check("every table row says why", Object.entries(TABLE).every(([, row]) => typeof row.why === "string" && row.why.trim().length > 0));
check("every target answers by table", targets.every((e) => materialFor(e).by === "table"));

// Picture over name: the decisions a name-only rule would miss.
const OVERRIDES = {
  "textures/e1u1/grnx1_1.wal": "metal", // organic by name; green-painted steel in the picture
  "textures/e1u1/grnmt1_1.wal": "metal", // stone by name; green-metal hatch
  "textures/e1u1/watrt1_1.wal": "metal", // water by name; steel wall trim, flags/contents 0
  "textures/e1u1/floor3_1.wal": "metal", // stone by name; diamond-tread steel floor
  "textures/e1u1/damage1_1.wal": "metal", // stone by name; riveted steel wall
  "textures/e1u1/wswall1_1.wal": "metal", // stone by name; steel vent wall
  "textures/e1u1/wslt1_1.wal": "metal", // stone by name; slotted steel vent
  "textures/e1u1/cgrbase1_1.wal": "tech", // stone by name; control panel
  "textures/e1u1/exitdr01_1.wal": "tech", // sign by the exit rule; an exit door mechanism
  "textures/e1u2/caution1_1.wal": "metal", // rust by the red-hue test; hazard paint on steel
};
check("the overrides the review found are in the table", Object.entries(OVERRIDES).every(([name, material]) => materialFor({ name }).material === material), Object.entries(OVERRIDES).filter(([name, material]) => materialFor({ name }).material !== material).map(([name]) => name).join(", "));
check("floor3_2 stays a stone floor, unlike floor3_1", materialFor({ name: "textures/e1u1/floor3_2.wal" }).material === "stone");
check("the lit wslt slots stay lamps", materialFor({ name: "textures/e1u1/wslt1_5.wal" }).material === "lamp" && materialFor({ name: "textures/e1u1/wslt1_6.wal" }).material === "lamp");
check("the window entry stays glass", materialFor({ name: "textures/e1u1/wndow0_3.wal" }).material === "glass");
check("the support beam stays rust", materialFor({ name: "textures/e1u1/support1_1.wal" }).material === "rust");
check("a table key is the miptex, lower-cased", materialKey({ name: "textures/e1u1/PIP04_3.wal" }) === "e1u1/pip04_3" && materialFor({ name: "textures/e1u1/PIP04_3.wal" }).by === "table");
check("the archive's mixed case does not split a decision", materialKey({ miptex: "E1U1/PIP04_3", name: "textures/e1u1/PIP04_3.wal" }) === materialKey({ name: "textures/e1u1/pip04_3.wal" }));
check("an empty miptex falls back to the entry name", materialFor({ miptex: "", name: "textures/e1u1/grnx1_1.wal" }).by === "table");

// ---------------------------------------------------------------------------
// 5. The manifest and animation families
// ---------------------------------------------------------------------------
process.stdout.write("\nmanifest and families\n");
const wals = manifest.entries.filter((e) => e.type === "wal");
check("all 303 WALs resolve to a material in the list", wals.length === 303 && wals.every((e) => MATERIALS.includes(materialFor(e).material)));
const byKey = new Map(wals.map((e) => [materialKey(e), e]));
let links = 0;
const splits = [];
for (const e of wals) {
  if (!e.animname) continue;
  const mate = byKey.get(e.animname.toLowerCase());
  if (!mate) continue;
  links++;
  const a = materialFor(e).material;
  const b = materialFor(mate).material;
  if (a !== b) splits.push(e.name + " " + a + " vs " + mate.name + " " + b);
}
check("there is at least one animname link to check", links > 0, "links " + links);
check("every animation family shares one material", splits.length === 0, splits.slice(0, 4).join("; "));

const counts = materialCounts(targets);
check("materialCounts returns exactly the thirteen names", Object.keys(counts).join(",") === MATERIALS.join(","));
check("materialCounts sums to the targets", Object.values(counts).reduce((a, b) => a + b, 0) === targets.length, JSON.stringify(counts));
check("materialCounts agrees with materialFor", targets.every((e) => counts[materialFor(e).material] >= 1));
check("materialCounts accepts a manifest object", (() => {
  const other = materialCounts({ entries: targets });
  return Object.keys(other).length === 13 && other.metal === counts.metal;
})());
check("materialCounts refuses something that is not a list", (() => {
  try { materialCounts({}); return false; } catch (error) { return error instanceof TypeError; }
})());

process.stdout.write("\n" + (failed ? failed + " of " + checked + " checks FAILED\n" : "all " + checked + " checks passed\n"));
process.exitCode = failed ? 1 : 0;
