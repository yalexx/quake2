#!/usr/bin/env node
// scripts/engine-state-test.mjs -- what `engine-state.js` makes of the memory
// it reads. No browser, no game: the page script is loaded into a sandbox with
// a synthetic linear memory and asked for a reading, so every field it reports
// can be set up by hand and checked.
//
//   node scripts/engine-state-test.mjs
//
// The one that matters is `dead`. It is the only word a caller has for whether
// the player is alive, and on this build the view rolls for two different
// reasons -- the death camera at 40 degrees, and the lean Yamagi Quake II puts
// on a strafing player. A threshold inside the lean turns every strafe into a
// corpse, and the walker restarts the level for a corpse.

import fs from "node:fs";
import vm from "node:vm";
import { ROLL_IS_DEATH, deadFromRoll } from "../control/bridge.mjs";

let failures = 0;
let checks = 0;
function check(name, condition, detail) {
  checks++;
  if (condition) console.log("  ok   " + name);
  else { failures++; console.log("  FAIL " + name + (detail === undefined ? "" : " -- " + JSON.stringify(detail))); }
}

// The page script defines `window.quake2Engine` and reads the engine's memory
// through a global `wasmMemory`. Both are supplied here; nothing else is.
const source = fs.readFileSync(new URL("../engine-state.js", import.meta.url), "utf8");
const SIZE = 600000;
let buffer = new ArrayBuffer(SIZE);
const sandbox = { window: {}, wasmMemory: { buffer }, console, Date, JSON };
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

const engine = sandbox.window.quake2Engine;
const VIEWORG = engine.offsets.vieworg;
const VIEWANGLES = engine.offsets.viewangles;

function put(position, angles, keyDest) {
  buffer = new ArrayBuffer(SIZE);
  sandbox.wasmMemory.buffer = buffer;
  new Float32Array(buffer, VIEWORG, 3).set(position);
  new Float32Array(buffer, VIEWANGLES, 3).set(angles);
  new Int32Array(buffer, engine.offsets.keyDest, 1)[0] = keyDest;
}

// Write entries into the client's stats array the page script reads. The
// array is int16 on this build, so the test writes through an Int16Array --
// and a value of 200 has to survive, which is the check that the reader is
// not mistakenly taking a byte.
function putStats(values) {
  const view = new Int16Array(buffer, engine.offsets.stats, engine.offsets.statsCount);
  view.fill(0);
  for (const [index, value] of Object.entries(values)) view[Number(index)] = value;
}

// Write the player state's weapon model index, which is int32. A fresh `put`
// leaves it at 0, the engine's "no weapon model yet".
function putGunindex(value) {
  new Int32Array(buffer, engine.offsets.gunindex, 1)[0] = value;
}

console.log("the page script loads and names its offsets");
check("engine-state.js defines window.quake2Engine", !!engine && typeof engine.read === "function");
check("and the offsets it reads are the ones it publishes",
  VIEWORG > 0 && VIEWANGLES === VIEWORG + 12 && engine.offsets.keyDest > 0,
  engine.offsets);

console.log("a reading is the engine's own floats");
put([128, -320, 46], [0, 135, 0], 0);
const standing = engine.read();
check("position comes back as the three floats that were written",
  standing.ok && standing.position.x === 128 && standing.position.y === -320 && standing.position.z === 46, standing.position);
check("angles likewise", standing.angles.yaw === 135 && standing.angles.roll === 0, standing.angles);
check("key_dest 0 is the game, and not paused",
  standing.inGame === true && standing.paused === false && standing.keyDestName === "game", standing.keyDestName);
// The ammo expectation deliberately changed: ammo is now read out of the
// engine's own stats array, so a zeroed synthetic memory reads 0, not null.
// Health and armour are still not this pass's, and stay null.
check("health and armour stay null; the weapon and ammo are read from the engine",
  standing.health === null && standing.armour === null &&
  standing.weaponIndex === 0 && standing.ammo === 0,
  [standing.health, standing.armour, standing.weaponIndex, standing.ammo]);

console.log("the current weapon and its ammo are the engine's own numbers");
// The weapon is `player_state.gunindex`, an int32 model index measured on the
// live engine as 36/64/68/69/70/71/72/73 for the eight weapons -- distinct for
// every one. The ammo is the int16 stats[3] measured against the HUD in eight
// weapon states and against firing.
put([-682, 174, -26], [0, 150, 0], 0);
putGunindex(68);
putStats({ 1: 100, 2: 14, 3: 200 });
const armed = engine.read();
check("weaponIndex comes back as the number written at gunindex",
  armed.weaponIndex === 68 && typeof armed.weaponIndex === "number", armed.weaponIndex);
check("ammo comes back as the number written at stats[3]",
  armed.ammo === 200 && typeof armed.ammo === "number", armed.ammo);
check("nothing readable is reported with a null reason",
  armed.weaponIndexReason === null && armed.ammoReason === null,
  [armed.weaponIndexReason, armed.ammoReason]);
check("the ammo stat is int16, not bytes: 200 is not read as 200 mod 256",
  armed.ammo === 200, armed.ammo);
// The measured fact that forced the split: stats[2] is the ammo *type* icon,
// and machinegun and chaingun share it. The reader must not treat it as the
// weapon, so changing it alone must leave weaponIndex exactly as written.
putGunindex(69);
putStats({ 1: 100, 2: 14, 3: 200 });
const chaingun = engine.read();
check("a different weapon with the same ammo icon reads as the new gunindex",
  chaingun.weaponIndex === 69 && chaingun.ammo === 200,
  [chaingun.weaponIndex, chaingun.ammo]);
putStats({ 1: 50, 2: 9, 3: 34 });
const switched = engine.read();
check("an ammo icon the gunindex does not share is not published as the weapon",
  switched.weaponIndex === 69 && switched.ammo === 34,
  [switched.weaponIndex, switched.ammo]);
check("the offsets the reader publishes are the ones it reads",
  engine.offsets.gunindex > 0 && engine.offsets.gunindex === 362544 &&
  engine.offsets.stats > 0 && engine.offsets.statsCount === 32 &&
  engine.offsets.statHealth === 1 && engine.offsets.statAmmoIcon === 2 &&
  engine.offsets.statAmmo === 3 && engine.offsets.statsEncoding === "int16",
  engine.offsets);

console.log("the strafe lean is not a death");
// Measured on a live player on demo1: strafing rolls the view up to 2.00
// degrees over 47 samples of pure strafe, and walking forward up to 0.72.
for (const roll of [0, 0.72, -0.72, 1.0, 1.43, 1.95, -2.0, 2.0]) {
  put([-682, 174, -26], [0, 150, roll], 0);
  const reading = engine.read();
  check("a roll of " + roll + " is a lean, not a death", reading.dead === false && reading.alive === true, { dead: reading.dead });
}
check("and the reading says what it derived `alive` from",
  standing.aliveSource === "view-roll-above-strafe-lean", standing.aliveSource);

console.log("the death camera is");
// Measured by walking a player into demo1's soldiers with nothing fired: the
// camera rolls to 40 and holds it while the position freezes and the mouse
// turns the yaw 0 degrees.
for (const roll of [20.1, 39, 40, -40, 90]) {
  put([-682, 174, -26], [0, 150, roll], 0);
  const reading = engine.read();
  check("a roll of " + roll + " is a death", reading.dead === true && reading.alive === false, { dead: reading.dead });
}

console.log("the lean and the death are the two populations that were measured");
// The gap between them is where the threshold has to live, and it is wide: the
// largest lean measured is 2.0 and the death camera's roll is 40.
put([0, 0, 0], [0, 0, 2.0], 0);
const lean = engine.read();
put([0, 0, 0], [0, 0, 40], 0);
const death = engine.read();
check("the largest strafe lean measured is alive and the death camera is dead",
  lean.dead === false && death.dead === true, { leanRoll: lean.angles.roll, leanDead: lean.dead, deathRoll: death.angles.roll, deathDead: death.dead });
check("the threshold is not inside either population",
  20 >= lean.angles.roll * 5 && 20 <= death.angles.roll / 2, { lean: lean.angles.roll, death: death.angles.roll });

console.log("a memory that cannot be read is not a zero");
sandbox.wasmMemory.buffer = new ArrayBuffer(64);   // too small for the offsets
const unreadable = engine.read();
check("a buffer without the offsets in it reports a reason rather than a value",
  unreadable.ok === false && unreadable.position === null && unreadable.angles === null, unreadable.reason);
check("and it does not claim the player is alive or dead",
  unreadable.dead === undefined && unreadable.alive === undefined,
  { dead: unreadable.dead, alive: unreadable.alive });
check("the weapon and ammo are null with a reason rather than a fabricated 0/0",
  unreadable.weaponIndex === null && unreadable.ammo === null &&
  unreadable.weaponIndexReason === "GUNINDEX_OUT_OF_RANGE" && unreadable.ammoReason === "STATS_OUT_OF_RANGE",
  [unreadable.weaponIndex, unreadable.ammo, unreadable.weaponIndexReason, unreadable.ammoReason]);
sandbox.wasmMemory.buffer = null;
const noEngine = engine.read();
check("no engine at all is its own reason", noEngine.reason === "ENGINE_NOT_LOADED", noEngine.reason);
check("and the weapon and ammo are null with that reason",
  noEngine.weaponIndex === null && noEngine.ammo === null &&
  noEngine.weaponIndexReason === "ENGINE_NOT_LOADED" && noEngine.ammoReason === "ENGINE_NOT_LOADED",
  [noEngine.weaponIndex, noEngine.ammo, noEngine.weaponIndexReason, noEngine.ammoReason]);

console.log("a stats array that is not the player's is not read as one");
// The identity check: the stats entry the reader trusts as health has to hold
// a plausible health. A window full of noise makes the ammo null -- but the
// weapon lives elsewhere, so a good gunindex is still a good weapon reading.
put([0, 0, 0], [0, 0, 0], 0);
putGunindex(72);
putStats({ 1: 30000, 2: 7, 3: 200 });
const garbage = engine.read();
check("an implausible health stat makes the ammo null with a reason",
  garbage.ammo === null && garbage.ammoReason === "STATS_IMPLAUSIBLE",
  [garbage.ammo, garbage.ammoReason]);
check("and the separately-read weapon is unaffected",
  garbage.weaponIndex === 72 && garbage.weaponIndexReason === null,
  [garbage.weaponIndex, garbage.weaponIndexReason]);

console.log("a weapon word that cannot be a model index is not published");
// A model index is never negative and never absurd. A word that is cannot be
// gunindex, so it is reported instead of passed on -- and the ammo, read from
// another structure, is still a number.
put([0, 0, 0], [0, 0, 0], 0);
putGunindex(-5);
putStats({ 1: 100, 2: 14, 3: 87 });
const badGun = engine.read();
check("a negative gunindex makes the weapon null with a reason",
  badGun.weaponIndex === null && badGun.weaponIndexReason === "GUNINDEX_IMPLAUSIBLE",
  [badGun.weaponIndex, badGun.weaponIndexReason]);
check("while the ammo is still the number in the stats array",
  badGun.ammo === 87 && badGun.ammoReason === null, [badGun.ammo, badGun.ammoReason]);

console.log("the key_dest reading is Quake 2's own order");
put([0, 0, 0], [0, 0, 0], 1);
check("1 is the console, and it is a pause", engine.read().consoleOpen === true && engine.read().paused === true, engine.read().keyDestName);
put([0, 0, 0], [0, 0, 0], 3);
check("3 is the engine's own menu", engine.read().keyDestName === "menu", engine.read().keyDestName);

console.log("the bridge and the page must agree about the same roll");
// Two readers, one signal: the page script's `dead` and the control layer's
// `deadFromRoll`. The bridge decides for itself rather than passing the page's
// verdict through (the app server may be serving an older engine-state.js, and
// an older one draws the line at 1), so the two have to be checked against each
// other or the walk would act on one and the report would quote the other.
for (const roll of [0, 2.0, -2.0, 12, 40, -40]) {
  put([0, 0, 0], [0, 150, roll], 0);
  const page = engine.read();
  const bridge = deadFromRoll({ angles: { pitch: 0, yaw: 150, roll }, dead: page.dead });
  check("a roll of " + roll + " is read the same way by both", page.dead === bridge, { page: page.dead, bridge });
}
check("the bridge's threshold is the one the two measured populations argue for",
  ROLL_IS_DEATH >= 2.0 * 5 && ROLL_IS_DEATH <= 40 / 2, ROLL_IS_DEATH);
check("with no roll to judge, the bridge falls back to the page rather than to an answer",
  deadFromRoll({ dead: true }) === true && deadFromRoll({ dead: false }) === false && deadFromRoll(null) === false,
  [deadFromRoll({ dead: true }), deadFromRoll({ dead: false }), deadFromRoll(null)]);

console.log("");
if (failures) { console.log(failures + " of " + checks + " checks FAILED"); process.exitCode = 1; }
else console.log("all " + checks + " checks passed");
