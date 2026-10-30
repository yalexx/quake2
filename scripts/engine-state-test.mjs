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
check("health, armour and ammo stay null rather than being invented",
  standing.health === null && standing.armour === null && standing.ammo === null,
  [standing.health, standing.armour, standing.ammo]);

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
sandbox.wasmMemory.buffer = null;
check("no engine at all is its own reason", engine.read().reason === "ENGINE_NOT_LOADED", engine.read().reason);

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
