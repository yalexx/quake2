// control/loop.mjs -- play the level as a reactive loop, not a script.
//
// Everything before this module plays demo1 as a *plan*: walker.mjs and
// combat.mjs cut the route into legs, and each leg is one decision -- one
// target chosen, one bearing set, the trigger held from the start of the leg to
// the end of it (see the fight section of README.md). That shape was measured
// to be the thing that misses: the aim is set once, from where the player
// stands at the top of the leg, and the soldier walks out of it while the leg
// runs. Worse, the soldiers the leg aims at are read out of the BSP's entity
// lump -- where the level's author *placed* them -- so the aim is at a point on
// a map, not at a monster.
//
// This module replaces the leg with a control loop. One tick does four things,
// and it does all four every tick, at roughly 12 Hz:
//
//   1. PERCEIVE. One evaluate against the live engine returns the player and
//      the client's own live entity array (engine-state.js / control/bridge.mjs
//      read it straight out of the WASM linear memory). Every monster is
//      therefore where it IS -- this frame -- and not where the map put it.
//   2. DECIDE. A small state machine over that reading: advance when the way is
//      clear, engage when a monster is in range and the player is healthy,
//      retreat when the player is not, recover when the walk stops. It is not a
//      plan; two ticks in a row can decide differently.
//   3. AIM. Every tick, from the player's CURRENT position to the target's
//      CURRENT position, with the bolt's travel led out. The turn is one mouse
//      delta proportional to the error, so the aim converges while the player
//      walks -- not one bearing per leg.
//   4. VERIFY. The trigger is only down when the aim error is inside the
//      tolerance AND the level's own geometry says a level shot reaches the
//      target. What the shots did is counted (see the hit accounting below).
//
// Where the monsters come from, and what could not be read
// ---------------------------------------------------------
// The client's entity array (`cl_entities`, 1024 x 276 bytes at 0x91550 in this
// build) is live: it is what the engine is drawing from this frame. Each record
// begins with `entity_state_t`, whose origin, angles, model index, animation
// frame and solid box are at the offsets `ENTITY_FIELDS` names below. Those
// offsets were recovered by scanning the live image and are checked at runtime
// by `verifyEntityRead()`, which compares the player's own entity against the
// refdef the engine already reports: if the two disagree the loop says so and
// falls back to the level's static list rather than aiming at a stale address.
//
// What is NOT readable, and is reported as such rather than estimated: a
// monster's **health**. The client's entity state is the network state and
// carries no health field, and this pass could not recover the game DLL's edict
// array either. So the hit accounting below is built on what IS observable --
// a monster that stops being a live monster, and a live monster whose animation
// frame runs backwards while the trigger is down -- and every number it prints
// is labelled with which of the two it came from. A landed turn is not a hit,
// and this module never counts one as one.

import { movementKeys, levelShotReaches, beamReaches, clearWalk, floorNear } from "./combat.mjs";
import { healthOf, liveOf } from "./edicts.mjs";

// The player's eye sits this far above the floor (walker.mjs and combat.mjs use
// the same number for the same reason).
const EYE_ABOVE_FEET = 46;

// ---------------------------------------------------------------------------
// The live entity array, as measured on this build
// ---------------------------------------------------------------------------
// `cl_entities` is a static array in the engine's own image: 1024 `centity_t`,
// 276 bytes each, based at 0x91550. Each record opens with `entity_state_t`
// (84 bytes), then two more copies (`prev` and `baseline`) and the lerp fields.
// The offsets below are into that first copy.
//
// Provenance, because a guessed offset here would aim the player at nothing:
//   * the base was found by matching a live entity's `number` to its index and
//     its origin to a monster's placed origin (`-856 584 -24` is demo1's
//     `monster_soldier_light`, and it sits at record 283);
//   * the stride follows from two live records whose `number` fields are 283
//     and 284 and whose addresses are 276 bytes apart;
//   * `number` at +0x00 and `origin` at +0x04 are the two fields the match
//     used, and `angles` at +0x10 read `(0, -90, 0)` for that monster, which is
//     the angle the entity lump gives it;
//   * `solid` at +0x48 read 8290 for every monster and 0 for every item, which
//     is the box a `monster_soldier` is given.
const CL_ENTITIES = 0x91550; // 595280
const ENTITY_STRIDE = 276; // sizeof(centity_t)
const MAX_EDICTS = 1024;

export const ENTITY_FIELDS = {
  number: 0x00,
  origin: 0x04, // vec3_t floats
  angles: 0x10, // vec3_t floats
  oldOrigin: 0x1c, // vec3_t floats
  modelindex: 0x28,
  modelindex2: 0x2c,
  modelindex3: 0x30,
  modelindex4: 0x34,
  frame: 0x38,
  skinnum: 0x3c,
  effects: 0x40,
  renderfx: 0x44,
  solid: 0x48,
  sound: 0x4c,
  event: 0x50,
};

export const ENTITY_LAYOUT = { base: CL_ENTITIES, stride: ENTITY_STRIDE, max: MAX_EDICTS };

// The model indices a monster carries, as they read on this build's demo1.
//
// These are measured, not looked up in a table of model names, and the
// measurement is worth writing down because reading the model names out of the
// client's own configstrings disagrees with it by one slot. What the entities
// themselves say is unambiguous: eighteen entities carrying modelindex 44 stand
// at exactly the origins the entity lump gives demo1's soldiers, they carry the
// monster's own 8290 box, and one of them walks toward the player when the
// level starts; and the blaster bolt the player fires is modelindex 45 with
// EF_BLASTER, which is a *different* entity entirely (measured -- see
// `BOLT_MODEL`). So the loop classifies by what an entity IS and only uses the
// map's own list to name it.
export const MONSTER_MODELS = [44, 65];

// The blaster bolt, as the client's entity array shows it: modelindex 45,
// `effects` bit 0x8 (`EF_BLASTER`), `solid` 0. Measured by holding the trigger
// and watching what appears -- the first version of this loop watched for a
// bolt carrying the *monster's* model index and therefore counted no bolts at
// all, which read as "the trigger never fired" for as long as it went unfixed.
export const BOLT_MODEL = 45;
export const EF_BLASTER = 0x8;

// The `solid` box a live `monster_*` carries. Items carry 0 and brush models
// carry 31, so this is the field that separates a monster from the blaster bolt
// that shares its model index.
export const MONSTER_SOLID = 8290;

// ---------------------------------------------------------------------------
// The levers
// ---------------------------------------------------------------------------
export const PLAY_DEFAULTS = {
  // The loop's own rate. 12.5 Hz: fast enough that a walking soldier moves a
  // few units between ticks, slow enough that one tick's four CDP round trips
  // fit inside a frame budget on loopback.
  tickMs: 80,
  // What is worth engaging. `engageRange` is about where a soldier opens fire;
  // inside `answerRange` a monster is answered whatever angle it stands at,
  // because it can shoot the player from where it is; inside `minimumRange` it
  // is walked out of rather than turned for.
  engageRange: 1100,
  engageArc: 100,
  answerRange: 340,
  minimumRange: 40,
  // How close a monster has to come to count as "met". The owner's second
  // success condition is "kill everything you meet", so what "meet" means has
  // to be a number and not a feeling: the same range at which a soldier is
  // worth answering, which is where the level's own soldiers open fire.
  metRange: 1100,
  // The aim has to be inside this before the trigger goes down. At 300 units a
  // 1.6-degree miss passes a 32-unit-wide soldier by well under its own body.
  aimTolerance: 1.6,
  // The most one tick may turn. A proportional controller with a one-tick delay
  // overshoots if it is allowed to take the whole error in one step.
  maxTurnPerTick: 30,
  // The proportional gain on the aim error, and the scale the loop learns for
  // the mouse itself.
  //
  // Both are needed. The gain has to be below one or a controller whose
  // correction arrives a tick late oscillates around the target instead of
  // settling on it. The scale is a measured property of the box: this build's
  // mouse turns about 0.13 degrees per count where the bridge's documented
  // default is 0.066, so a loop that asked for the error in degrees got almost
  // exactly twice the turn it asked for -- measured, three 20-degree requests
  // produced 0, 39.4 and 39.4 degrees. The loop therefore measures what its
  // last turn actually achieved and folds it back in, and the aim converges to
  // the tolerance however far the default is from the box.
  turnGain: 0.5,
  turnScale: 1,
  // ---- the second axis: pitch -------------------------------------------
  //
  // The loop used to be yaw-only. It could not look up or down, so it aimed a
  // level shot at whatever the target's x/y was and ignored its z -- fine for a
  // soldier on the player's own floor (the eye sits inside that soldier's box,
  // see control/combat.mjs) and wrong for anything else. This axis aims at the
  // target's own z, which is what the entity array carries.
  //
  // Quake 2's pitch is the mouse's other axis: like yaw it is degrees per mouse
  // count (governed by `m_pitch` rather than `m_yaw`), and like yaw its real
  // value on this box is not the one the config suggests. So it is calibrated
  // the same way and by the same trick -- ask for a correction, measure what the
  // pitch actually did, fold the ratio back in.
  //
  // Sign convention, from the engine's own angles: `cl.refdef.viewangles[PITCH]`
  // is NEGATIVE when looking up and positive when looking down, and a positive
  // mouse dy (the pointer moving down the screen) raises it. The aim angle
  // computed below is therefore `-atan2(dz, distance)`, and the mouse delta it
  // produces is positive to look further down.
  pitchGain: 0.5,
  maxPitchPerTick: 30,
  pitchScale: 1,
  // How far the pitch is allowed to be off before the trigger goes down. Same
  // value as the yaw's and for the same reason: at 300 units a 1.6-degree miss
  // passes a 32-unit-wide soldier by well under its own body.
  pitchTolerance: 1.6,
  // Whether the pitch axis is driven at all. On by default; a run that wants to
  // reproduce the old yaw-only aim sets this to false and gets exactly the old
  // behaviour, which is how the change is measured against the thing it replaced.
  pitchAim: true,
  // How far a bolt travels per second, for the lead. Quake 2's blaster bolt.
  // `measureBoltSpeed()` replaces it with the live reading when bolts are seen.
  boltSpeed: 1000,
  boltModel: BOLT_MODEL,
  // How much lead to actually apply. The lead is a correction, not a policy: a
  // reading of the target's velocity from two ticks 80 ms apart is noisy, and a
  // full lead on a noisy velocity is worse than none.
  leadFactor: 1,
  // The walk. A route point is "reached" inside this, and the leg looks this
  // far ahead for a point it can actually walk to.
  arriveRadius: 48,
  lookAhead: 340,
  // Health. Below `lowHealth` the loop stops advancing into a fight it can
  // leave; `retreatHealth` is where it starts backing out of one.
  lowHealth: 28,
  // How long a retreat may last before the walk takes the lead back. A retreat
  // is a manoeuvre, not a mode: see `#tick`'s own note for the run that proved
  // it -- 9904 of 12000 ticks spent backing away, 128 units from the exit, and
  // not one step closer in fifteen minutes.
  retreatMs: 4000,
  // How long a stopped player is allowed to stand still before the loop
  // intervenes, and for how long each intervention lasts.
  stuckMs: 1300,
  nudgeMs: 800,
  // The status bar is photographed this often. It is the one sensor with a real
  // cost (a frame capture and an image decode), and health the engine prints
  // nowhere is worth roughly one reading a second.
  healthReadMs: 1000,
  // How far the player may be from the plan before the loop asks the engine
  // which level it is on. The exit trigger loads demo2 and the next reading of
  // "where am I" is a coordinate on a map this plan knows nothing about.
  offRouteLimit: 700,
  // The loop's ceiling, so a run that cannot finish still reports.
  maxTicks: 12000,
  // How many level restarts the loop will live through.
  deaths: 10,
  // Errands: a weapon or ammunition the level offers near the way out, and a
  // health box worth walking over when the player is hurt. `errandRange` is how
  // far out of the way the loop will go for one; `topUpHealth` is how hurt the
  // player has to be before a health box counts as "on the way" rather than
  // "beside the route".
  errandRange: 900,
  topUpHealth: 70,
  touchRadius: 56,
  // Keep a per-tick record of what was decided and what the aim looked like.
  // Off by default -- it is a diagnostic, not part of the run -- and the run
  // that needs it is the one where the player is not doing what the loop says.
  trace: false,
};

// ---------------------------------------------------------------------------
// The pure part: bearings, lead, targets, decisions
// ---------------------------------------------------------------------------

// Quake 2's compass: 0 is +X, 90 is +Y, and the yaw grows anticlockwise.
// combat.mjs keeps its own copy of these two lines for the same reason.
export function bearingTo(from, to) {
  return (Math.atan2(to.y - from.y, to.x - from.x) * (180 / Math.PI) + 360) % 360;
}

export function shortestTurn(degrees) {
  let angle = Number(degrees) % 360;
  if (angle > 180) angle -= 360;
  if (angle <= -180) angle += 360;
  return angle;
}

const finite = (value) => typeof value === "number" && Number.isFinite(value);
const point3 = (value) =>
  value && finite(value.x) && finite(value.y) && finite(value.z)
    ? { x: value.x, y: value.y, z: value.z }
    : null;

// Where to point the bolt so that it and the target arrive together.
//
// The bolt flies straight and takes `distance / boltSpeed` seconds to cross the
// gap; the target walks on for that long. One iteration of the correction is
// enough -- the second-order term is the target's own acceleration over a
// third of a second -- and the result is clamped to `options.maxLead` so a bad
// velocity reading cannot throw the aim across the room.
export function leadPoint(from, target, velocity, options = {}) {
  const eye = point3(from);
  const at = point3(target);
  if (!eye || !at) return at;
  const speed = finite(options.boltSpeed) && options.boltSpeed > 0 ? options.boltSpeed : 1000;
  const factor = finite(options.leadFactor) ? options.leadFactor : 1;
  const maxLead = finite(options.maxLead) ? options.maxLead : 96;
  const vx = velocity && finite(velocity.x) ? velocity.x : 0;
  const vy = velocity && finite(velocity.y) ? velocity.y : 0;
  // The offset is clamped where it is COMPUTED, not after: the second solve
  // below re-derives it from the velocity, and a clamp applied only to the
  // first would let the second put the shot back across the room. Measured: a
  // target read with a 100,000 unit/second velocity put the lead 31,499 units
  // off the aim point through exactly that gap.
  const clamp = (dx, dy) => {
    const span = Math.hypot(dx, dy);
    return span > maxLead && span > 0 ? [(dx / span) * maxLead, (dy / span) * maxLead] : [dx, dy];
  };
  let flight = Math.hypot(at.x - eye.x, at.y - eye.y) / speed;
  let [leadX, leadY] = clamp(vx * flight * factor, vy * flight * factor);
  // Re-solve once at the led point: the gap the bolt actually crosses is the
  // one to where the target will be, not the one to where it is.
  flight = Math.hypot(at.x + leadX - eye.x, at.y + leadY - eye.y) / speed;
  [leadX, leadY] = clamp(vx * flight * factor, vy * flight * factor);
  return { x: at.x + leadX, y: at.y + leadY, z: at.z };
}

// The PITCH that points the view at a target's own height, in Quake 2's own
// sense: NEGATIVE when the target is above the eye, positive when it is below,
// because that is the sign `cl.refdef.viewangles[PITCH]` carries. Zero when the
// two are level.
//
// The eye is the live read's own position (it is `cl.refdef.vieworg`), and the
// target's z is the entity's own origin -- the centre of the box a bolt has to
// cross, not the top of it. `span` is the ground-plane distance and not the
// straight-line one: the angle is measured from the horizontal, which is what
// the engine's pitch is.
export function aimPitch(eye, target) {
  const from = point3(eye);
  const at = point3(target);
  if (!from || !at) return null;
  const span = Math.hypot(at.x - from.x, at.y - from.y);
  const rise = at.z - from.z;
  if (span < 0.001 && Math.abs(rise) < 0.001) return null;
  return -(Math.atan2(rise, span) * 180) / Math.PI;
}

// Which live entity is which monster.
//
// An entity is a monster when it carries a monster's model index AND a
// monster's solid box. That is the whole test, and it is deliberately not
// "near where the map put one": a monster that has walked 300 units from its
// spawn is still a monster, and the loop's job is to find it where it is. The
// level's own list is used for the *name* (and, only when the live read has
// failed its integrity check, as a fallback).
//
// Identity is the entity's own number, which the server keeps for the level's
// lifetime, so a target is the same target from tick to tick even as it moves.
export function readMonsters(entities, options = {}) {
  const models = options.models || MONSTER_MODELS;
  const solid = finite(options.solid) ? options.solid : MONSTER_SOLID;
  const role = options.role || "live-memory";
  const out = [];
  for (const entity of Array.isArray(entities) ? entities : []) {
    if (!entity || !entity.position) continue;
    if (!models.includes(entity.modelindex)) continue;
    if (entity.solid !== solid) continue;
    out.push({
      number: entity.number,
      position: { x: entity.position.x, y: entity.position.y, z: entity.position.z },
      angles: entity.angles || null,
      modelindex: entity.modelindex,
      frame: entity.frame,
      solid: entity.solid,
      effects: entity.effects,
      skinnum: entity.skinnum,
      source: role,
    });
  }
  return out;
}

// The same classification, made from the level's own entity lump, for a run
// whose live read did not pass its check. The positions are where the map
// PLACED the monsters, which is exactly the reading this module exists to stop
// using -- so it is a fallback that says so, and never the first choice.
export function staticMonsters(map, options = {}) {
  const enemies = options.enemies
    || (map && typeof map.waypoints === "function" ? map.waypoints("enemy") : []);
  return enemies.map((enemy, index) => ({
    number: null,
    index,
    classname: enemy.classname,
    position: enemy.position,
    angles: null,
    modelindex: null,
    frame: null,
    solid: null,
    effects: null,
    skinnum: null,
    source: "map-entity-lump",
  }));
}

// What to shoot at, best first, from where the player is and the way the walk
// is going. `threats()` in combat.mjs asks this of the map; here the monsters
// are live, so the same question is asked of the live list and the answers move
// as the monsters do.
export function rankTargets(monsters, from, options = {}) {
  const eye = point3(from);
  if (!eye) return [];
  const range = finite(options.engageRange) ? options.engageRange : PLAY_DEFAULTS.engageRange;
  const arc = finite(options.engageArc) ? options.engageArc : PLAY_DEFAULTS.engageArc;
  const answer = finite(options.answerRange) ? options.answerRange : PLAY_DEFAULTS.answerRange;
  const minimum = finite(options.minimumRange) ? options.minimumRange : PLAY_DEFAULTS.minimumRange;
  const heading = options.heading;
  const ranked = [];
  for (const monster of monsters) {
    if (!monster || !monster.position) continue;
    const distance = Math.hypot(monster.position.x - eye.x, monster.position.y - eye.y);
    if (distance > range || distance < minimum) continue;
    const bearing = bearingTo(eye, monster.position);
    const off = heading === undefined || heading === null ? 0 : Math.abs(shortestTurn(bearing - heading));
    if (off > arc && distance > answer) continue;
    // What it costs to deal with this one now: the ground to walk, plus a
    // penalty for every degree off the way the walk is already going.
    ranked.push({ ...monster, distance, bearing, off, score: distance + off * 3 });
  }
  ranked.sort((a, b) => a.score - b.score);
  return ranked;
}

// The decision, as a pure function of one reading. The driver calls this every
// tick and acts on the answer; nothing here touches the browser, so the whole
// state machine can be tested without one.
//
// `percept` is:
//   { player, health, monsterCount, target, inRange, routeBearing, routeDistance,
//     arrived, offRoute, stuck, dead }
// and the answer is `{ mode, move, aim, fire, reason }`:
//   mode  -- "dead" | "arrived" | "recover" | "retreat" | "engage" | "advance"
//   move  -- the bearing to walk (null to stand)
//   aim   -- the bearing to look (null to look where the walk is going)
//   fire  -- whether the trigger should be down
export function decide(percept, options = {}) {
  const lowHealth = finite(options.lowHealth) ? options.lowHealth : PLAY_DEFAULTS.lowHealth;
  // The pitch the walk itself wants: level, so a walk that never fires does not
  // drift its view up or down the corridor. A target overrides it.
  //
  // With the axis off the decision carries NO pitch at all -- not a level one,
  // not the target's. That is what makes `pitchAim: false` the control for the
  // change: the decision is then exactly the old yaw-only decision, and the
  // caller driving the mouse has nothing to drive on the second axis.
  const axisOff = options.pitchAim === false;
  const level = axisOff ? null : 0;
  if (!percept) return { mode: "advance", move: null, aim: null, pitch: level, fire: false, reason: "NO_READING" };
  if (percept.dead) return { mode: "dead", move: null, aim: null, pitch: null, fire: false, reason: "PLAYER_DEAD" };
  if (percept.arrived) return { mode: "arrived", move: null, aim: null, pitch: null, fire: false, reason: "AT_THE_EXIT" };
  if (percept.recover) {
    // The recovery carries its own pitch when the thing it is about to shoot is
    // not on the player's own level -- the exit's `func_button` is 121 units
    // above the eye that has to hit it. `null` when the axis is off, which is
    // the same promise the rest of this function makes.
    const recoverPitch = axisOff ? null : (finite(percept.recover.pitch) ? percept.recover.pitch : level);
    return { mode: "recover", move: percept.recover.bearing, aim: percept.recover.aim || null, pitch: recoverPitch, fire: percept.recover.fire === true, reason: percept.recover.reason || "STUCK" };
  }
  const target = percept.target || null;
  // The pitch that points at the target's own z, carried on the target by the
  // driver (it is the only part of the aim that needs the eye's height).
  const atTarget = axisOff ? null : (target && finite(target.pitch) ? target.pitch : level);
  // Retreat is a health decision, not a fight one: the player is hurt, and the
  // level's own corridor is the thing that is killing them. It still shoots --
  // this level punishes a player who stops.
  const hurt = finite(percept.health) && percept.health <= lowHealth;
  // `retreatSpent` is the caller's clock on the manoeuvre (see `#tick`): once
  // it is set, being hurt is no longer a reason to stop walking, and the
  // decision falls through to `engage` -- same aim, same trigger, but the walk
  // keeps its bearing. A caller that never sets it (the pure-function tests, a
  // tool driving `decide()` by hand) gets the old behaviour exactly.
  if (hurt && percept.retreatSpent !== true && target && percept.retreatBearing !== null && percept.retreatBearing !== undefined) {
    return { mode: "retreat", move: percept.retreatBearing, aim: target.bearing, pitch: atTarget, fire: true, reason: "LOW_HEALTH" };
  }
  if (target) {
    return { mode: "engage", move: percept.routeBearing, aim: target.bearing, pitch: atTarget, fire: percept.targetClear !== false, reason: "MONSTER_IN_RANGE" };
  }
  // Nothing to shoot: face the way the walk is going. Quake 2 moves a player
  // along the view, so a walk that never turns is a walk that steers entirely
  // with the strafe keys -- which works, at 45-degree steps, and it is what the
  // first version of this loop did. Turning with the route is the same walk
  // with `+forward` doing the work.
  return { mode: "advance", move: percept.routeBearing, aim: percept.routeBearing, pitch: level, fire: false, reason: "WAY_CLEAR" };
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

// A trail point is kept per `trailEveryMs`, not per tick: 12.5 Hz of positions
// is a lot of report for a run that lasts minutes, and the trail exists to show
// where the player went, not to be a flight recorder.
const TRAIL_EVERY_MS = 500;

export class PlayLoop {
  constructor(game, map, options = {}) {
    this.game = game;
    this.map = map;
    this.options = { ...PLAY_DEFAULTS, ...options };
    this.plan = null;
    this.routeIndex = 0;
    this.trail = [];
    this.shots = 0;
    this.triggerMs = 0;
    this.healthSeries = [];
    this.kills = [];
    this.flinches = 0;
    this.damageEvents = 0;
    this.triggerMs = 0;
    this.lastTriggerTick = 0;
    this.states = {};
    this.targets = new Map();
    this.monstersSeen = 0;
    this.readWarnings = 0;
    this.entityIntegrity = { checked: 0, agreed: 0, worstError: null, source: "live-memory" };
    this.lastView = { monsters: [], health: null, tick: 0 };
    this.stuck = { since: null, from: null, stage: 0, nudges: 0 };
    // When the retreat began, for the clock `retreatMs` puts on it. Null while
    // the player is not hurt.
    this.retreatSince = null;
    this.boltSpeed = this.options.boltSpeed;
    this.boltSamples = 0;
    this.log = [];
    this.deaths = 0;
    this.deepest = null;
    this.lastPosition = null;
    this.lastRead = null;
    this.levelChanged = null;
    this.offRouteTicks = 0;
    this.healthReadAt = 0;
    this.triggerDown = false;
    this.keysHeld = [];
    // What the last turn asked for and where the view was when it asked, so the
    // next tick can fold the achieved turn back into the mouse's own scale.
    this.turnScale = finite(options.turnScale) ? options.turnScale : this.options.turnScale;
    this.turnSamples = 0;
    this.pendingTurn = null;
    // The same for the pitch axis, which is a second mouse delta with a scale of
    // its own.
    this.pitchScale = finite(options.pitchScale) ? options.pitchScale : this.options.pitchScale;
    this.pitchSamples = 0;
    this.pitchFailures = 0;
    this.pendingPitch = null;
    // ---- the aim gate, counted on both axes every tick ---------------------
    //
    // The second axis is judged by this and by nothing else: for every tick that
    // had a target, how often the yaw and the pitch were each inside their
    // tolerance once the tick's own corrections had been sent, and how often
    // BOTH were -- which is the only state the trigger is allowed down in. A
    // landed turn is not a hit and neither is a trigger press with no target,
    // so the run reports the gate directly rather than leaving it to a trace
    // that has to be switched on.
    this.gate = {
      ticks: 0, yawInside: 0, pitchInside: 0, bothInside: 0, fire: 0,
      aimErrorSum: 0, aimErrorCount: 0, pitchErrorSum: 0, pitchErrorCount: 0,
    };
    // ---- enemies met, and enemies killed ----------------------------------
    //
    // The owner's second success condition: the walk has to kill what it meets,
    // not slip past it. "Met" is defined here and nowhere else, so the number is
    // reproducible: a monster the loop has seen within `metRange` of the player
    // on a tick where the player was alive. "Killed" is the GAME's own answer --
    // its edict's health at or below zero -- and never a landed turn, a frame
    // that moved, or the loop's own opinion.
    //
    // And it is counted PER ATTEMPT, because an attempt here is one life. A
    // death hands the engine its own level-start autosave back, which reloads
    // the level and revives every monster on it; the entity numbers are reused,
    // so a kill from a life that is over is NOT a kill in the life that follows
    // and a record that kept it would report a soldier as dead while it stands
    // on the spawn reloading its blaster. Each death therefore closes the
    // attempt -- its numbers are kept in `attempts` -- and the accounting starts
    // again on the level the player is handed next. The success condition is
    // read off the LAST attempt, which is the one that would have finished the
    // level.
    this.met = new Map();
    this.attempt = 1;
    this.attempts = [];
    // When this attempt began, so the report can say what each trip down the
    // corridor cost in wall clock and not only what the run cost in total.
    this.attemptStartedAt = Date.now();
    this.healthDamage = 0;
    this.healthDamageEvents = 0;
    // Where the run totals stood when the current attempt began, so the report
    // can say what this attempt alone took off the level's monsters.
    this.attemptDamageBase = { damage: 0, events: 0 };
    this.killEvents = [];
    this.edictRead = { ticks: 0, withHealth: 0, unmatched: 0, originDisagreed: 0, source: null, reason: null };
    this.playerEdictNumber = null;
    this.playerEdictFromEdict = null;
    this.healthCrossCheck = { agreed: 0, disagreed: 0, worst: null };
    this.edictHealth = [];
    // The waypoint being walked to and the monster being shot at, held between
    // ticks so that neither the heading nor the aim re-picks itself every tick.
    this.waypoint = null;
    this.focusNumber = null;
    // The errands the caller asked for, and the one the loop is running. A
    // death resets them: the engine's autosave hands the player the spawn's own
    // blaster back, so a weapon fetched before a death has to be fetched again.
    this.errands = Array.isArray(options.errands) ? options.errands.map((errand) => ({ ...errand, taken: false })) : [];
    this.errand = null;
    this.errandsRun = [];
    this.trace = [];
    this.timing = { live: 0, act: 0, ticks: 0 };
    this.goalTolerance = 96;
  }

  note(message, detail) {
    const entry = { at: Date.now(), message };
    if (detail !== undefined) entry.detail = detail;
    this.log.push(entry);
    if (this.log.length > 400) this.log.shift();
  }

  // ---- the loop -----------------------------------------------------------

  async run(goal, options = {}) {
    const started = Date.now();
    const goalPoint = point3(goal);
    if (!goalPoint) throw new Error("the play loop needs an exit point to walk to");
    this.goal = goalPoint;
    if (options.level) this.level = options.level;
    if (!this.plan) this.plan = this.#planFrom(options.from || null);
    const tolerance = finite(options.tolerance) ? options.tolerance : 96;
    // Stored, not just used here: the decision made inside each tick asks the
    // same question ("am I there yet?") and must ask it with the same number.
    // It used to hardcode 96, so a caller that asked for 64 got a walk that
    // stopped where the loop thought it should.
    this.goalTolerance = tolerance;
    const maxTicks = Math.max(1, Math.floor(this.options.maxTicks));
    let ticks = 0;
    let reason = "MAX_TICKS";

    while (ticks < maxTicks) {
      const tickStart = Date.now();
      ticks += 1;
      let live;
      try {
        live = await this.game.live();
      } catch (error) {
        this.note("the live read failed: " + error.message);
        await this.#sleep(this.options.tickMs);
        continue;
      }
      const liveMs = Date.now() - tickStart;
      if (!live || !live.read || !live.read.ok) {
        // No level up yet, or the engine is between maps. Wait rather than
        // decide on nothing.
        await this.#sleep(this.options.tickMs);
        continue;
      }
      const read = live.read;
      this.lastRead = read;
      const position = read.position;
      this.lastPosition = position;

      let outcome;
      try {
        outcome = await this.#tick(live, tickStart);
      } catch (error) {
        // A fault in one tick must not leave the player holding a key: a stuck
        // `+forward` walks the level's own player across the map with nobody
        // watching, which is a fault this harness has already paid for once.
        // Everything comes up, and the error goes on to the caller.
        await this.#release();
        throw error;
      }
      if (outcome && outcome.stop) {
        reason = outcome.reason;
        break;
      }
      const goalDistance = Math.hypot(position.x - goalPoint.x, position.y - goalPoint.y);
      if (goalDistance <= tolerance) {
        reason = "ARRIVED";
        break;
      }
      // Where a tick's time goes. The loop's rate is a promise about how fast
      // it reacts, so the run says how much of each tick the perception cost
      // and how much was the acting: a loop that is late because the live read
      // takes 40 ms is a loop that should read less, not sleep less.
      const elapsed = Date.now() - tickStart;
      this.timing.live += liveMs;
      this.timing.act += elapsed - liveMs;
      this.timing.ticks += 1;
      await this.#sleep(Math.max(0, this.options.tickMs - elapsed));
    }

    await this.#release();
    return this.#summary({ reason, ticks, started, goal: goalPoint });
  }

  async #tick(live, tickStart) {
    const read = live.read;
    const options = this.options;
    const player = read.position;
    // Fold what the last tick's turn actually achieved into the mouse's own
    // scale, before this tick decides the next correction. Both axes: they are
    // two mouse deltas and this box's two per-count angles are not the same
    // number.
    this.#learnTurn(read.angles.yaw);
    this.#learnPitch(read.angles.pitch);

    // ---- 1. PERCEIVE ------------------------------------------------------
    const liveEntities = Array.isArray(live.entities) ? live.entities : null;
    let monsters;
    if (liveEntities) {
      this.entityIntegrity.checked += 1;
      const check = this.#verifyEntityRead(read, liveEntities);
      if (check.ok) this.entityIntegrity.agreed += 1;
      else this.readWarnings += 1;
      monsters = readMonsters(liveEntities);
      this.#rememberFrames(monsters);
      this.#measureBolts(liveEntities);
      if (check.ok) this.entityIntegrity.source = "live-memory";
      else if (this.entityIntegrity.agreed === 0) this.entityIntegrity.source = "map-entity-lump-fallback";
    } else {
      monsters = [];
      if (this.entityIntegrity.agreed === 0) this.entityIntegrity.source = "map-entity-lump-fallback";
    }
    const usingFallback = this.entityIntegrity.source === "map-entity-lump-fallback";
    if (usingFallback) {
      monsters = staticMonsters(this.map).map((monster, index) => ({ ...monster, index }));
      if (this.readWarnings === 1) {
        this.note("the live entity read did not agree with the engine's own player position; falling back to the level's static monster list", this.entityIntegrity);
      }
    }
    this.monstersSeen = Math.max(this.monstersSeen, monsters.length);
    this.lastView.monsters = monsters;
    this.lastView.tick += 1;

    // ---- 1a. the game DLL's own edicts: health, and who is dead -----------
    //
    // Attached to the monster list before anything decides on it, so the fight
    // is fought on the same reading it is judged by. A monster the edict array
    // does not vouch for keeps `health: null` and says so; nothing here invents
    // one. `#metAndKilled` is the owner's second success condition: what the
    // walk met, and what the GAME says it killed.
    monsters = this.#withHealth(monsters, live, player);
    this.#metAndKilled(monsters, player, read.dead === true);

    // ---- 1b. health, from the status bar ----------------------------------
    // The player's own health: the edict array has it now (the game DLL's own
    // `g_edicts`, the same array the monsters come from), so it is taken from
    // there every tick for nothing, and the status bar -- which costs a frame
    // capture and an image decode -- is kept at its bounded rate as the
    // independent cross-check it has always been.
    let health = this.lastView.health;
    const fromEdict = this.#playerHealth(live, player);
    if (fromEdict !== null) {
      health = fromEdict;
      this.lastView.health = health;
      this.lastView.healthSource = "game-edict";
      // Recorded when it CHANGES, not every tick: the series exists to show what
      // the player's health did, and 12.5 identical readings a second is 12.5
      // times the report for none of the information.
      const last = this.edictHealth[this.edictHealth.length - 1];
      if (!last || last.health !== fromEdict) {
        this.edictHealth.push({ at: Date.now(), health: fromEdict, tick: this.lastView.tick });
        if (this.edictHealth.length > 4000) this.edictHealth.shift();
      }
    }
    if (tickStart - this.healthReadAt >= options.healthReadMs && !read.dead) {
      this.healthReadAt = tickStart;
      try {
        const { hudShot, readHealth } = await import("./hud.mjs");
        const shot = await hudShot(this.game);
        const reading = readHealth(shot.png, shot.readOptions);
        if (finite(reading.health)) {
          health = reading.health;
          this.lastView.health = health;
          this.healthSeries.push({ at: Date.now(), health, armour: reading.armour, tick: this.lastView.tick });
          // The status bar is the independent reader: it is the number the
          // engine DRAWS, and it owes nothing to the offset the edict array was
          // read from. One outside the other is a fault in this pass's sensor and
          // is counted rather than averaged away.
          if (fromEdict !== null) {
            const gap = Math.abs(fromEdict - reading.health);
            if (gap <= 1) this.healthCrossCheck.agreed += 1;
            else {
              this.healthCrossCheck.disagreed += 1;
              this.healthCrossCheck.worst = this.healthCrossCheck.worst === null ? gap : Math.max(this.healthCrossCheck.worst, gap);
              if (this.healthCrossCheck.disagreed === 1) {
                this.note("the status bar and the game's own edict disagree about the player's health: bar " + reading.health + ", edict " + fromEdict);
              }
            }
          }
        } else if (read.dead) {
          health = null;
        }
      } catch (error) {
        if (this.healthSeries.length === 0) this.note("the status bar could not be read: " + error.message);
      }
    }
    // The death camera is the engine's own answer and it outranks the bar: a
    // corpse has no status bar to photograph.
    const dead = read.dead === true;

    // ---- 2. DECIDE --------------------------------------------------------
    const route = this.#routePoint(player);
    const heading = route ? bearingTo(player, route.point) : read.angles.yaw;
    const offRoute = route ? route.offRoute : 0;
    // The errand, if one is owed and reachable: the level's own weapon and its
    // ammunition early, and a health box once the player is hurt enough for it
    // to be worth the detour. It changes where the walk goes, never what the
    // loop will fight -- a monster in the way is still engaged.
    this.errand = this.#activeErrand(player, health);
    if (this.errand) {
      const distance = Math.hypot(this.errand.position.x - player.x, this.errand.position.y - player.y);
      if (distance <= options.touchRadius) {
        this.errand.taken = true;
        this.errandsRun.push({ classname: this.errand.classname, call: this.errand.call, at: Date.now(), distanceToExit: this.deepest ? Math.round(this.deepest.distance) : null });
        this.note("called at the level's own " + this.errand.classname, { call: this.errand.call });
        this.errand = null;
      }
    }
    const moveBearing = this.errand ? bearingTo(player, this.errand.position) : heading;
    const ranked = rankTargets(monsters, player, {
      engageRange: options.engageRange,
      engageArc: options.engageArc,
      answerRange: options.answerRange,
      minimumRange: options.minimumRange,
      heading: moveBearing,
    });
    // Of the monsters worth dealing with, the ones a level shot can actually
    // reach. combat.mjs's `threats()` makes the same distinction and for the
    // same reason: a soldier on the floor above is a thing to walk away from,
    // not a thing to shoot at, and a trigger held against one is a trigger held
    // against a wall. What is reachable gets the aim and the trigger; what is
    // nearest gets the retreat bearing.
    //
    // This was measured rather than reasoned: without it the loop spent an
    // entire run "engaging" two soldiers 40 and 80 units below the floor the
    // player stood on, aimed at them, never fired -- correctly, the geometry
    // says no -- and never walked the route either.
    const reachable = [];
    for (const monster of ranked) {
      if (!this.#isAlive(monster)) continue;
      if (!this.#shotReaches(player, monster)) continue;
      reachable.push(monster);
    }
    // ...and the one being shot at is held too, while it is still there and
    // still shootable. Switching targets every tick is switching aim every
    // tick, and an aim that never holds still is a trigger that never goes
    // down: the first version of this loop fired eleven times in four hundred
    // ticks while a corridor full of soldiers shot at it.
    let chosen = reachable.find((monster) => monster.number === this.focusNumber) || reachable[0] || null;
    this.focusNumber = chosen ? chosen.number : null;
    const clear = chosen ? this.#shotReaches(player, chosen) : false;
    const goal = this.goal || null;
    const target = chosen
      ? {
          ...chosen,
          bearing: bearingTo(player, this.#lead(player, chosen)),
          // The second axis: the pitch that points the view at the target's own
          // z, led out the same way the bearing is (the lead point carries the
          // target's z through unchanged, so this is the target's own height at
          // the moment it is read).
          pitch: aimPitch(player, this.#lead(player, chosen)),
        }
      : null;
    const stuck = this.#stuckNow(player, tickStart);
    const retreatBearing = this.#retreatBearing(player, ranked, route);
    const arrived = goal ? Math.hypot(player.x - goal.x, player.y - goal.y) <= this.goalTolerance : false;
    // How long the loop has been backing off, and whether that has gone on long
    // enough to stop.
    //
    // A retreat that never ends is not a retreat. Measured on the 12000-tick
    // run of 2026-10-04: the loop spent **9904 of those ticks in `retreat`**,
    // parked at -1648 1436 with 128 units to go and all fifteen soldiers in
    // frame, firing at them for fifteen minutes and never taking another step
    // towards the exit. Two runs before it ended the same way, and the deepest
    // reading of all three is the same corner. The health it was protecting
    // never came back, because this level does not let a stopped player heal.
    //
    // So a retreat is a manoeuvre with a clock on it: it is allowed to break
    // contact and let the walk re-aim, and when it has run for `retreatMs`
    // without the player's health coming back above `lowHealth`, the walk takes
    // the lead again -- still firing, still choosing the same target. Dying is
    // affordable here (an attempt is a life and there are twenty-four of them);
    // standing still is not, because a run that never advances can never
    // finish.
    const hurtNow = finite(health) && health <= options.lowHealth;
    if (hurtNow) { if (this.retreatSince === null) this.retreatSince = tickStart; }
    else this.retreatSince = null;
    const retreatSpent = this.retreatSince !== null && tickStart - this.retreatSince >= options.retreatMs;

    if (dead) {
      await this.#release();
      this.deaths += 1;
      // The life is over: close its accounting before `#handleDeath` reloads
      // the level, because the reload is what revives the monsters and reuses
      // their entity numbers (see `#endAttempt`).
      this.#endAttempt("the player died");
      return this.#handleDeath(read, tickStart);
    }

    const percept = {
      dead: false,
      health,
      target,
      targetClear: clear,
      routeBearing: moveBearing,
      routeDistance: route ? route.distance : 0,
      offRoute,
      arrived,
      monsterCount: monsters.length,
      recover: stuck,
      retreatBearing,
      retreatSpent,
    };
    const decision = decide(percept, options);
    this.states[decision.mode] = (this.states[decision.mode] || 0) + 1;

    // Off the plan for long enough that the plan is the wrong question: ask the
    // engine which level it is really on. The exit trigger loads demo2 and the
    // player is then standing on a map this plan has never seen.
    if (offRoute > options.offRouteLimit) {
      this.offRouteTicks += 1;
      if (this.offRouteTicks >= 25 && typeof this.game.level === "function") {
        this.offRouteTicks = 0;
        const level = await this.game.level().catch(() => null);
        if (level && level.name && level.name !== (this.level || "demo1")) {
          this.levelChanged = level;
          this.note("the engine says the level is now " + level.name);
          return { stop: true, reason: "LEVEL_CHANGED" };
        }
      }
    } else {
      this.offRouteTicks = 0;
    }

    // ---- 3. AIM and ACT ---------------------------------------------------
    await this.#act(decision, percept, read);
    this.#track(player, monsters, tickStart, decision, clear);
    this.#traceTick(read, decision, clear, target, player);
    return null;
  }

  // One line per tick, for a run that is not doing what it says it is.
  #traceTick(read, decision, clear, target, player) {
    if (!this.options.trace) return;
    // The errors are the ones `#act` actually gated the trigger on -- measured
    // against the aim its own turn had just achieved, not against the reading
    // from before it. A trace that printed the stale number would show an aim
    // that never converged next to a trigger that was down.
    const last = this.lastDecision || {};
    this.trace.push({
      tick: this.lastView.tick,
      mode: decision.mode,
      said: decision.reason,
      yaw: Math.round(read.angles.yaw * 10) / 10,
      aim: decision.aim === null || decision.aim === undefined ? null : Math.round(decision.aim * 10) / 10,
      aimError: last.aimError === null || last.aimError === undefined ? null : Math.round(last.aimError * 10) / 10,
      pitch: Math.round(read.angles.pitch * 10) / 10,
      pitchAim: decision.pitch === null || decision.pitch === undefined ? null : Math.round(decision.pitch * 10) / 10,
      pitchError: last.pitchError === null || last.pitchError === undefined ? null : Math.round(Math.abs(last.pitchError) * 10) / 10,
      clear: clear === true,
      fire: this.triggerDown === true,
      target: target ? { n: target.number, d: Math.round(target.distance), off: Math.round(target.off) } : null,
      monsters: this.lastView.monsters.length,
      at: [Math.round(player.x), Math.round(player.y), Math.round(player.z)],
      scale: Math.round(this.turnScale * 100) / 100,
    });
    if (this.trace.length > 800) this.trace.shift();
  }

  // ---- the game DLL's own edicts (see control/edicts.mjs) ------------------

  // Attach every monster's health, from the game DLL's `g_edicts`. Returns a
  // NEW list; a monster the edict array does not carry, or carries at an origin
  // that disagrees with the client's, keeps `health: null` and a `source` that
  // says which of the two happened. Nothing here invents a health.
  #withHealth(monsters, live, player) {
    const edicts = Array.isArray(live.edicts) ? live.edicts : null;
    this.edictRead.ticks += 1;
    this.edictRead.source = live.edictsSource || null;
    this.edictRead.reason = live.edictReason || null;
    if (!edicts) return monsters.map((monster) => ({ ...monster, health: null, maxHealth: null, dead: null, source: "no-edict-array" }));
    const answer = healthOf(monsters, edicts);
    this.edictRead.unmatched += answer.unmatched;
    this.edictRead.originDisagreed += answer.disagreed;
    this.edictRead.withHealth += answer.monsters.filter((monster) => monster.health !== null).length;
    return answer.monsters;
  }

  // The player's own health, out of the same edict array.
  //
  // The client's entity array carries the player's own record and its x/y are
  // the eye's x/y (the eye/feet gap is vertical), which is how the player's
  // entity number is found the first time. The number is then held: a server
  // keeps an entity's number for the level's lifetime. If the held number stops
  // leading to an edict standing where the player stands -- a level restart
  // moves the player and can renumber -- it is looked for again rather than
  // silently read from the wrong record.
  #playerHealth(live, player) {
    const edicts = Array.isArray(live.edicts) ? live.edicts : null;
    if (!edicts) return null;
    const near = (edict) => edict && Number.isFinite(edict.x) &&
      Math.hypot(edict.x - player.x, edict.y - player.y) <= 64;
    let edict = this.playerEdictNumber === null ? null : edicts.find((entry) => entry.number === this.playerEdictNumber);
    if (!near(edict)) {
      let best = null;
      for (const entry of edicts) {
        if (!near(entry)) continue;
        const z = Math.abs(entry.z - player.z);
        if (!best || z < best.z) best = { entry, z };
      }
      edict = best ? best.entry : null;
      this.playerEdictNumber = edict ? edict.number : null;
      if (!edict) return null;
    }
    const live_ = liveOf(edict);
    return live_ && live_.health !== null ? live_.health : null;
  }

  // The owner's second success condition, kept as three numbers: what the walk
  // MET, what the GAME says it KILLED, and what is still standing.
  //
  // "Met" is this loop's own definition and is written down here so the number
  // is reproducible: a monster seen within `metRange` of the player while the
  // player was alive. "Killed" is never the loop's opinion -- it is the game
  // DLL's own `health <= 0`, or the engine having stopped sending the entity,
  // and every kill records which of the two said so.
  #metAndKilled(monsters, player, dead) {
    const range = finite(this.options.metRange) ? this.options.metRange : this.options.engageRange;
    for (const monster of monsters) {
      const key = this.#key(monster);
      const distance = Math.hypot(monster.position.x - player.x, monster.position.y - player.y);
      let record = this.met.get(key);
      if (!record) {
        if (dead || distance > range) continue;
        record = {
          number: monster.number,
          classname: this.#nameFor(monster),
          modelindex: monster.modelindex,
          firstMet: Date.now(),
          distanceWhenMet: Math.round(distance),
          samples: 0,
          healthFirst: monster.health === null ? null : monster.health,
          healthLowest: monster.health === null ? null : monster.health,
          lastHealth: monster.health === null ? null : monster.health,
          hits: 0,
          killed: false,
          killedBy: null,
          at: null,
        };
        this.met.set(key, record);
        this.note("met " + record.classname + " (#" + monster.number + ") at " + record.distanceWhenMet + " units, health " +
          (record.healthFirst === null ? "unreadable" : record.healthFirst));
      }
      record.samples += 1;
      record.lastSeen = Date.now();
      if (monster.position) record.lastPosition = { x: Math.round(monster.position.x), y: Math.round(monster.position.y), z: Math.round(monster.position.z) };
      const health = monster.health;
      if (health === null || health === undefined) continue;
      // A health that DROPPED is the game's own answer that a shot connected --
      // this is the real hit signal, and it replaces the animation-frame proxy
      // the passes before this one had to use and measured zero with.
      if (record.lastHealth !== null && health < record.lastHealth) {
        record.hits += 1;
        record.lastDrop = record.lastHealth - health;
        this.healthDamage += record.lastDrop;
        this.healthDamageEvents += 1;
        if (record.samples <= 3 || record.hits <= 3) {
          this.note("the game's own health for " + record.classname + " (#" + monster.number + ") fell by " + record.lastDrop +
            ", to " + health + " of " + monster.maxHealth, { hit: record.hits, triggerDown: this.triggerDown === true });
        }
      }
      if (record.healthLowest === null || health < record.healthLowest) record.healthLowest = health;
      record.lastHealth = health;
      if (health <= 0 && !record.killed) {
        record.killed = true;
        record.killedBy = "game-edict-health-below-zero";
        record.at = Date.now();
        this.killEvents.push({ number: monster.number, classname: record.classname, by: record.killedBy, hits: record.hits, health: health });
        this.note("the game says " + record.classname + " (#" + monster.number + ") is DEAD: its own health is " + health);
      }
    }
  }

  // The owner's two numbers, read off the record `#metAndKilled` keeps. One
  // function so the per-attempt report and the run's own summary cannot drift
  // apart on what "killed" means.
  #enemiesNow() {
    const records = [...this.met.values()];
    const damage = this.healthDamage - this.attemptDamageBase.damage;
    const damageEvents = this.healthDamageEvents - this.attemptDamageBase.events;
    return {
      attempt: this.attempt,
      wallClockMs: Date.now() - this.attemptStartedAt,
      met: records.length,
      killed: records.filter((record) => record.killed).length,
      stillStanding: records.filter((record) => !record.killed).length,
      unreadableHealth: records.filter((record) => record.healthFirst === null).length,
      healthDamage: damage,
      healthDamageEvents: damageEvents,
      list: records.map((record) => ({
        number: record.number,
        classname: record.classname,
        metAt: record.distanceWhenMet,
        healthFirst: record.healthFirst,
        healthLowest: record.healthLowest,
        hits: record.hits,
        killed: record.killed,
        killedBy: record.killedBy,
        samples: record.samples,
      })),
    };
  }

  // Close the attempt that is ending, and start the next one's accounting.
  //
  // Called from exactly one place -- the tick that reads the engine's death
  // camera -- because that is the event on this level that reloads it and
  // revives its monsters. Everything the attempt accumulated is kept under its
  // own number; the live accounting starts again empty, which is the only
  // reading that is true of the level the player is handed next.
  #endAttempt(endedBy) {
    const snapshot = this.#enemiesNow();
    this.attempts.push({ ...snapshot, endedBy });
    this.met = new Map();
    this.attemptStartedAt = Date.now();
    this.attemptDamageBase = { damage: this.healthDamage, events: this.healthDamageEvents };
    // The per-entity history goes with it: a level restart reuses the entity
    // numbers, so a frame, a velocity or a "stopped being sent" verdict read
    // before the restart belongs to a monster that no longer exists. The map
    // repopulates from the first tick of the next attempt.
    this.targets = new Map();
    this.attempt += 1;
  }

  // ---- perception helpers -------------------------------------------------

  // Does the live entity array agree with the engine's own answer about where
  // the player is? Entity 1 is the player in a single-player game, and its
  // origin is the player's feet -- the refdef position minus the view offset.
  // A disagreement means the offsets moved under this build and the loop must
  // say so rather than aim at whatever is at those addresses now.
  #verifyEntityRead(read, entities) {
    // The player's OWN record is the anchor -- entity 1 in a single-player game
    // -- and its x/y are the refdef's x/y, because the view offset that
    // separates the eye from the feet is vertical. The record the reader takes
    // may be the *previous* copy, which lags the current one by a server frame,
    // so the tolerance is 64 and not 4; what it has to catch is an offset that
    // has moved under the build, which is thousands of units wide, not a lag.
    //
    // This used to take the nearest entity of ANY kind, which is a check that
    // can be satisfied by a monster: measured on the live game, entity 1 agreed
    // to 0.06 units while the *second* nearest entity was 13.81 away. A check
    // whose anchor can be something other than the player is a check that can
    // pass while the player's own row holds anything at all.
    const eye = read.position;
    const anchor = entities.find((entity) => entity && entity.number === 1 && entity.position);
    const error = anchor ? Math.max(Math.abs(anchor.position.x - eye.x), Math.abs(anchor.position.y - eye.y)) : null;
    if (error !== null) {
      this.entityIntegrity.worstError = this.entityIntegrity.worstError === null
        ? Math.round(error * 100) / 100
        : Math.max(this.entityIntegrity.worstError, Math.round(error * 100) / 100);
    }
    return { ok: error !== null && error <= 64, error, anchor: anchor ? anchor.copy : "ABSENT" };
  }

  // What the last turn actually achieved, folded back into the mouse's scale.
  // Only a turn big enough to be seen is judged -- the same rule the bridge's
  // own `#learnTurn` uses, and for the same reason: a correction of a degree
  // that lands as nothing is evidence about the aim, not about the mouse.
  #learnTurn(yaw) {
    const pending = this.pendingTurn;
    this.pendingTurn = null;
    if (!pending || Math.abs(pending.requested) < 3) return;
    const achieved = shortestTurn(yaw - pending.yaw);
    if (Math.abs(achieved) < 0.5) return;
    const ratio = achieved / pending.requested;
    if (!(ratio > 0.05 && ratio < 20)) return;
    this.turnScale = Math.max(0.1, Math.min(8, this.turnScale * (0.5 + 0.5 / ratio)));
    this.turnSamples += 1;
  }

  // The same fold-back for the pitch axis, and for the same reason: `m_pitch`
  // is 0.022 on this box's config and the number of degrees a mouse count
  // actually moves the view is not that -- it is whatever the engine's
  // sensitivity works out to, and this build will not report it. Pitch is
  // measured exactly as yaw is: ask for a correction, read what the pitch did,
  // fold the ratio in. The error is a plain difference and not a `shortestTurn`
  // -- the pitch is clamped to +/-90 and does not wrap.
  #learnPitch(pitch) {
    const pending = this.pendingPitch;
    this.pendingPitch = null;
    if (!pending || Math.abs(pending.requested) < 3) return;
    const achieved = pitch - pending.pitch;
    if (Math.abs(achieved) < 0.5) return;
    const ratio = achieved / pending.requested;
    if (!(ratio > 0.05 && ratio < 20)) return;
    this.pitchScale = Math.max(0.1, Math.min(8, this.pitchScale * (0.5 + 0.5 / ratio)));
    this.pitchSamples += 1;
  }

  // What identifies a monster in the records this loop keeps.
  //
  // The entity number is the identity when there is one. A monster read from
  // the level's static list has none -- `staticMonsters()` gives it only its
  // place in that list -- and keying those on `null` puts all of them in ONE
  // record: each overwrote the last, the run's per-monster table showed a
  // single row, and `#track`'s "have I seen it this tick" set, which is keyed
  // the same way, then matched nothing and would have marked every one of them
  // killed a second into the run. The fallback has never actually been taken on
  // this build -- the live read agrees with the engine on every tick -- which is
  // exactly why it has to be right on the day it is.
  #key(monster) {
    return monster.number === null || monster.number === undefined ? "index:" + monster.index : monster.number;
  }

  #rememberFrames(monsters) {
    for (const monster of monsters) {
      const previous = this.targets.get(this.#key(monster));
      const now = { at: Date.now(), frame: monster.frame, position: monster.position };
      if (!previous) {
        this.targets.set(this.#key(monster), {
          number: monster.number,
          classname: this.#nameFor(monster),
          modelindex: monster.modelindex,
          firstSeen: now.at,
          lastSeen: now.at,
          samples: 1,
          seen: 1,
          frames: [monster.frame],
          position: { ...monster.position },
          velocity: { x: 0, y: 0, z: 0 },
          firstSolid: monster.solid,
          firstEffects: monster.effects,
          solids: [monster.solid],
          effectsSeen: [monster.effects],
        });
        continue;
      }
      // The velocity the lead is built on: the distance between the last two
      // readings over the time between them. It is the only way to know how
      // fast a monster is walking, and it is a live reading, not a table.
      const seconds = Math.max(0.001, (now.at - previous.at) / 1000);
      previous.velocity = {
        x: (monster.position.x - previous.position.x) / seconds,
        y: (monster.position.y - previous.position.y) / seconds,
        z: (monster.position.z - previous.position.z) / seconds,
      };
      // A frame that MOVES while the trigger is down is the damage signal this
      // build actually carries, and it is a good one because of what a monster
      // does when nothing is hitting it: measured, one hundred samples over
      // twenty seconds of a level standing still, every one of demo1's eighteen
      // monsters reported **one** distinct animation frame and **one** distinct
      // position. An idle monster on this build does not animate in the client's
      // entity state at all. So a change is news -- the pain animation -- and a
      // change that is a *regression* is the pain animation restarting, which is
      // kept separately as a flinch.
      if (finite(previous.frame) && finite(monster.frame) && monster.frame !== previous.frame) {
        previous.frameChanges = (previous.frameChanges || 0) + 1;
        if (monster.frame < previous.frame) previous.flinches = (previous.flinches || 0) + 1;
        if (this.triggerDown) {
          this.damageEvents += 1;
          previous.damageEvents = (previous.damageEvents || 0) + 1;
        }
      }
      // Every distinct `solid` and `effects` value this entity has carried
      // while the loop watched it. A monster that dies is a monster whose
      // entity state changed, and this is the record of what it changed to --
      // which is how "a hit is a kill" can be checked instead of assumed.
      previous.solids = previous.solids || [previous.firstSolid];
      if (previous.solids.length < 8 && !previous.solids.includes(monster.solid)) previous.solids.push(monster.solid);
      previous.effectsSeen = previous.effectsSeen || [previous.firstEffects];
      if (previous.effectsSeen.length < 8 && !previous.effectsSeen.includes(monster.effects)) previous.effectsSeen.push(monster.effects);
      previous.frame = monster.frame;
      previous.position = { ...monster.position };
      previous.lastSeen = now.at;
      previous.samples += 1;
      previous.seen += 1;
      if (previous.frames.length > 8) previous.frames.shift();
      previous.frames.push(monster.frame);
    }
  }

  // A blaster bolt is an entity carrying the bolt's model and moving far faster
  // than a monster walks. Watching one between two ticks gives the bolt's real
  // speed, which is what the lead needs; with none in flight the loop keeps the
  // documented default and reports how many it actually measured.
  #measureBolts(entities) {
    const now = Date.now();
    const inTheAir = [];
    let modelOnly = 0;
    for (const entity of entities) {
      if (!entity) continue;
      if (entity.modelindex !== this.options.boltModel) continue;
      if (entity.solid === MONSTER_SOLID) continue; // a monster, not a bolt
      // ...and the EFFECT, which the model index alone does not carry. This is
      // the third condition of the definition above and it was missing, and its
      // absence was measured: demo1 has twelve static entities carrying model
      // index 45 with `effects` 0 at fixed positions -- the level's own props,
      // not one bolt -- so "a bolt in the air" was true on 700 of 700 ticks and
      // the bolt's speed, which needs the same entity seen moving on two
      // consecutive ticks, was never once measured. A reading that is true on
      // every frame is not a firing rate; it is a mis-identification, and the
      // count of what was rejected is reported next to the count of what was
      // kept so the two can never be confused again.
      if (!((entity.effects & EF_BLASTER) === EF_BLASTER)) { modelOnly += 1; continue; }
      inTheAir.push(entity);
    }
    this.boltModelOnly = Math.max(this.boltModelOnly || 0, modelOnly);
    this.boltModelOnlyTotal = (this.boltModelOnlyTotal || 0) + modelOnly;
    // How many bolts are in the air at once, which is the only direct evidence
    // that pulling the trigger did anything: a bolt is an entity of its own,
    // and the live array is where it is.
    this.boltsInFlight = Math.max(this.boltsInFlight || 0, inTheAir.length);
    if (inTheAir.length > 0) this.boltFrames = (this.boltFrames || 0) + 1;
    this.boltSamplesCur = inTheAir.length;
    // The speed is measured between THIS tick's bolts and the PREVIOUS tick's,
    // and the previous tick's are thrown away rather than accumulated.
    //
    // An entity number is a slot the engine reuses, so a sample kept until that
    // slot next holds a bolt can be seconds old and can be of a *different*
    // bolt: the distance between the two is then a number that mixes positions
    // and time, and its ratio is a speed the lead would go on to believe. With
    // the map rebuilt every tick, an entry can only ever mean "this slot held a
    // bolt one tick ago".
    let fastest = null;
    const wasInTheAir = this.boltPrevious;
    for (const entity of inTheAir) {
      const before = wasInTheAir ? wasInTheAir.get(entity.number) : null;
      if (!before) continue;
      const seconds = Math.max(0.001, (now - before.at) / 1000);
      const speed = Math.hypot(
        entity.position.x - before.position.x,
        entity.position.y - before.position.y,
        entity.position.z - before.position.z,
      ) / seconds;
      if (speed > 400 && speed < 6000 && (!fastest || speed > fastest)) fastest = speed;
    }
    this.boltPrevious = new Map(inTheAir.map((entity) => [entity.number, { at: now, position: entity.position }]));
    if (fastest !== null) {
      this.boltSpeed = this.boltSamples === 0 ? fastest : this.boltSpeed * 0.5 + fastest * 0.5;
      this.boltSamples += 1;
    }
  }

  #lead(player, monster) {
    const record = monster.number === null ? null : this.targets.get(this.#key(monster));
    return leadPoint(player, monster.position, record ? record.velocity : null, {
      boltSpeed: this.boltSpeed,
      leadFactor: this.options.leadFactor,
    });
  }

  // Which errand is worth running right now, if any. A weapon the errand names
  // is fetched whatever the loop is doing, because it is the difference between
  // fighting demo1 with the spawn's blaster and fighting it with the level's
  // own gun; a health box waits until the player is hurt enough that walking to
  // it costs less than not walking to it.
  #activeErrand(player, health) {
    if (!this.errands.length) return null;
    for (const errand of this.errands) {
      if (errand.taken) continue;
      const distance = Math.hypot(errand.position.x - player.x, errand.position.y - player.y);
      if (distance > this.options.errandRange) continue;
      if (errand.call === "health" && health !== null && health > this.options.topUpHealth) continue;
      // The errand itself, not a copy of it. The caller marks it taken when the
      // player touches it, and a copy would take the mark instead -- which is
      // how a first version of this "called at the super shotgun" on every one
      // of 150 ticks while standing on it.
      errand.distance = distance;
      return errand;
    }
    return null;
  }

  // A shot is only worth taking when the level's own geometry says a shot from
  // the player's eye reaches the target's body. The box the target's own live
  // origin implies -- not the one the map placed.
  //
  // With the pitch axis on, the shot is the 3D segment from the eye to the
  // target's own origin and the test is the same test in three dimensions
  // (`beamReaches`); with it off, the shot is a level line at eye height and
  // the original `levelShotReaches` is what answers, so `pitchAim: false` gives
  // back exactly the old behaviour.
  #shotReaches(player, monster) {
    if (this.options.pitchAim === false) return levelShotReaches(this.map, player, monster.position, {});
    return beamReaches(this.map, player, monster.position, {});
  }

  #isAlive(monster) {
    if (monster.source === "map-entity-lump") return true;
    const record = this.targets.get(this.#key(monster));
    if (!record) return true;
    // A monster the server has stopped sending is gone. The live reader only
    // returns entities that are in this frame, so a record that has not been
    // seen for a while while the entity is absent is a corpse the level has
    // removed -- and a corpse is not worth firing at.
    const quiet = Date.now() - record.lastSeen;
    return quiet < 4000;
  }

  #nameFor(monster) {
    // The map's own list gives the monster its name: the loop takes identity
    // from the entity and the classname from the level's author, and matches
    // them by position at first sight.
    if (this.map && typeof this.map.waypoints === "function") {
      let best = null;
      for (const enemy of this.map.waypoints("enemy")) {
        // An entity the lump gives no parsable origin is not a candidate; it is
        // also the only reason this loop can reach a waypoint without a
        // position at all.
        if (!enemy.position) continue;
        const distance = Math.hypot(enemy.position.x - monster.position.x, enemy.position.y - monster.position.y);
        if (!best || distance < best.distance) best = { classname: enemy.classname, distance };
      }
      if (best && best.distance <= 96) return best.classname;
    }
    return "monster#" + monster.number;
  }

  // ---- the walk -----------------------------------------------------------

  #planFrom(from) {
    const walk = { maxStepUp: 45, maxDrop: 300, maxJump: 160, cell: 24 };
    const start = from || (this.map && typeof this.map.playerStart === "function" ? this.map.playerStart().position : null);
    const goal = this.goal;
    return this.map.path(start, goal, walk);
  }

  // The route point the walk is heading for, and how far off the plan the
  // player has drifted. The point is the farthest ahead that a standing player
  // can actually walk to -- the same "aim at something worth walking to"
  // question combat.mjs asks, asked again every tick because the player moves
  // every tick.
  #routePoint(player) {
    const points = this.plan && this.plan.points ? this.plan.points : null;
    if (!points || !points.length) {
      return { point: this.goal, distance: this.goal ? Math.hypot(this.goal.x - player.x, this.goal.y - player.y) : 0, offRoute: 0 };
    }
    const feet = { x: player.x, y: player.y, z: player.z - EYE_ABOVE_FEET };
    // Where the player is on the plan: the nearest point ON THE PLAYER'S OWN
    // FLOOR, which is also what "how far off the plan am I" means. The index
    // only ever moves forward and never by more than a few points in one tick
    // -- a route that passes near itself later would otherwise teleport the
    // walk to the far side of it.
    //
    // The height is part of that answer, and leaving it out is what stopped
    // this walk at the exit. The way out of demo1 doubles back over itself: the
    // plan climbs a ramp at y 1728 from z -32 up to z 96 and then comes back
    // along a catwalk directly ABOVE the ground it has already covered. An
    // x/y-only "nearest point" picks the catwalk -- 76 units away in x/y and 96
    // units up -- hands the walk a bearing into the wall underneath it, and
    // holds it there. Measured, on the 5640-tick run of 2026-10-04: the player
    // pressed against the exit room's east face at -1648 1540 for the whole
    // run, mode `engage`, 128 units from the exit, while the plan's own next
    // point was on the ramp it never turned towards, and it died there 25
    // times.
    //
    // So a point more than a step above or below the feet is scored far behind
    // every point that is not. When the player is off the plan entirely and
    // NOTHING is on their floor, the same term still orders what is left by how
    // far out of reach it is rather than by x/y alone, so a player who has been
    // knocked off the plan can still find their way back to it.
    const climb = finite(this.options.maxStepUp) ? this.options.maxStepUp : 45;
    let closest = null;
    for (let index = 0; index < points.length; index++) {
      const point = points[index];
      const height = Math.abs((finite(point.z) ? point.z : feet.z) - feet.z);
      const distance = Math.hypot(point.x - player.x, point.y - player.y);
      const score = height <= climb ? distance : distance + height * 4 + 1000;
      if (!closest || score < closest.score) closest = { index, distance, score };
    }
    if (closest && closest.index > this.routeIndex) {
      this.routeIndex = Math.min(closest.index, this.routeIndex + 6);
    }
    while (this.routeIndex < points.length - 1 &&
           Math.hypot(points[this.routeIndex].x - player.x, points[this.routeIndex].y - player.y) <= this.options.arriveRadius) {
      this.routeIndex += 1;
    }
    // The heading is HELD, not re-picked every tick.
    //
    // This is the difference between an aim that settles and an aim that does
    // not. Choosing the farthest visible point again each tick is choosing a
    // different point each tick -- the lookahead jumps between them as the
    // player moves -- and the view chases the jump. Measured on the first
    // version of this loop: yaw 152, 102, 89, 61, 97, 77, 22 within twenty
    // ticks of plain walking, and an aim that was still 40 degrees off when a
    // soldier walked into range. A waypoint is held until it is reached or the
    // walkable line to it closes, which is what a person does.
    let chosen = this.waypoint && this.waypoint.index >= this.routeIndex ? this.waypoint : null;
    if (chosen) {
      const floor = this.#floorAt(chosen.point);
      const reach = Math.hypot(chosen.point.x - player.x, chosen.point.y - player.y);
      if (floor === null || reach <= this.options.arriveRadius ||
          !clearWalk(this.map, feet, { x: chosen.point.x, y: chosen.point.y, z: floor }, { step: 10 })) {
        chosen = null;
      }
    }
    if (!chosen) {
      const last = Math.min(points.length - 1, this.routeIndex + 16);
      for (let index = last; index >= this.routeIndex; index--) {
        const point = points[index];
        if (Math.hypot(point.x - player.x, point.y - player.y) > this.options.lookAhead) continue;
        const floor = this.#floorAt(point);
        if (floor === null) continue;
        if (clearWalk(this.map, feet, { x: point.x, y: point.y, z: floor }, { step: 10 })) {
          chosen = { point, index };
          break;
        }
      }
      this.waypoint = chosen || { point: points[this.routeIndex], index: this.routeIndex };
      chosen = this.waypoint;
    }
    return {
      point: chosen.point,
      distance: Math.hypot(chosen.point.x - player.x, chosen.point.y - player.y),
      offRoute: closest ? closest.distance : 0,
      index: chosen.index,
    };
  }

  // The floor a route point stands on, or null when there is none: the plan's
  // points are already on floors, so this is a fallback for a point the grid
  // moved under.
  #floorAt(point) {
    if (typeof this.map.standable === "function" && this.map.standable(point.x, point.y, point.z)) return point.z;
    return floorNear(this.map, point.x, point.y, point.z, {});
  }

  // Where to back off to, when health says the fight is being lost: straight
  // away from the nearest monster that is shooting, at a bearing the walk can
  // still use.
  #retreatBearing(player, ranked, route) {
    const nearest = ranked[0];
    if (!nearest) return null;
    return (bearingTo(player, nearest.position) + 180) % 360;
  }

  #stuckNow(player, tickStart) {
    const stuck = this.stuck;
    if (!stuck.from) {
      stuck.from = { ...player };
      stuck.since = tickStart;
      return null;
    }
    const moved = Math.hypot(player.x - stuck.from.x, player.y - stuck.from.y);
    if (moved >= 16) {
      stuck.from = { ...player };
      stuck.since = tickStart;
      stuck.stage = 0;
      return null;
    }
    if (tickStart - stuck.since < this.options.stuckMs) return null;
    return this.#recovery(player);
  }

  // What a player does when they are pressed against something the plan did not
  // know about. The ladder is ordered by what a person would try first: open
  // what is in front of you, shoot the button that opens it, then step to one
  // side, then plan again from where you actually are.
  #recovery(player) {
    const stuck = this.stuck;
    stuck.stage += 1;
    stuck.from = { ...player };
    stuck.since = Date.now();
    // The waypoint that was held is a waypoint this player demonstrably cannot
    // walk to -- holding it is what keeps them against the wall -- so let it go
    // before asking where the route goes next.
    this.waypoint = null;
    const route = this.#routePoint(player);
    const heading = route && route.point ? bearingTo(player, route.point) : 0;
    // The one obstacle on demo1 that does not yield to walking is the door
    // `func_button *34` opens, and a Quake 2 button is opened by shooting it.
    // That is the first thing tried, and it is a fix rather than a nudge: the
    // loop can already aim at a thing and pull the trigger, and a button is a
    // thing. (`+use` is not an option here: the config on this box binds no key
    // to it, and the console is not this loop's to open.)
    if (stuck.stage <= 2) {
      const button = this.#nearestButton(player);
      if (button) {
        this.note("the walk stopped beside " + button.classname + "; shooting it", { distance: Math.round(button.distance), stage: stuck.stage });
        const aim = bearingTo(player, button.position);
        // Both axes, or the shot goes into the wall below the button. A Quake 2
        // button is usually on a wall at eye height, which is why this was a
        // bearing and nothing else -- but the one on demo1's exit is `func_button
        // *34` at (-1843.5 1536 136), and the player shooting at it stands ~195
        // units away at an eye height of about 15. That is 121 units of climb
        // over 195 of ground: a level shot passes 121 units under it and hits
        // the wall. The pitch is carried here the same way `decide()` carries a
        // target's, and is `null` when the axis is off so that `pitchAim: false`
        // still gives exactly the old behaviour.
        const pitch = this.options.pitchAim === false ? null : aimPitch(player, button.position);
        return { bearing: heading, aim, pitch, fire: true, reason: "STUCK_BUTTON" };
      }
    }
    if (stuck.stage >= 4) {
      stuck.stage = 0;
      stuck.nudges += 1;
      const replanned = this.#planFrom(player);
      if (replanned && replanned.points && replanned.points.length) {
        this.plan = replanned;
        this.routeIndex = 0;
        this.note("the plan was rebuilt from where the player actually is", { points: replanned.points.length, at: [Math.round(player.x), Math.round(player.y), Math.round(player.z)] });
      }
      return { bearing: (heading + (stuck.nudges % 2 ? 90 : -90) + 360) % 360, reason: "STUCK_REPLAN" };
    }
    const side = (heading + (stuck.stage % 2 ? 60 : -60) + 360) % 360;
    this.note("the walk stopped; stepping sideways", { stage: stuck.stage, bearing: Math.round(side), at: [Math.round(player.x), Math.round(player.y), Math.round(player.z)] });
    return { bearing: side, reason: "STUCK_SIDESTEP" };
  }

  // The closest `func_button` to the player, if one is within reach.
  //
  // This used to scan `map.waypoints("*")`, and on this build that list holds
  // NO buttons at all: demo1's `func_button *13` and `*34` are brush entities,
  // and a brush model carries no `origin`, so the waypoint list -- which drops
  // every entity with neither an origin nor a kind -- never described them.
  // Measured on the live map: `waypoints("*")` is 638 entities and **zero** of
  // them are `func_button`; the two buttons are in `barriers()`, which reads
  // the brush models and their `modelBounds` instead. The check found nothing,
  // every time, on every run -- which is why the loop's own log has never once
  // said "the walk stopped beside func_button", only "stepping sideways", and
  // why the first rung of the recovery ladder was dead code on the one level it
  // was written for.
  //
  // The position is the brush's own centre, the same reading `exitPoint()`
  // takes the exit volume from; the button is a 9x32x32 box on a wall and its
  // `origin` is (0,0,0) just like every other brush model here.
  #nearestButton(player) {
    if (!this.map) return null;
    let best = null;
    const consider = (classname, position) => {
      if (!/^func_button$/.test(String(classname || ""))) return;
      if (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)) return;
      const distance = Math.hypot(position.x - player.x, position.y - player.y);
      if (!best || distance < best.distance) best = { classname, position, distance };
    };
    if (typeof this.map.barriers === "function") {
      for (const barrier of this.map.barriers()) consider(barrier.classname, barrier.centre);
    }
    if (typeof this.map.waypoints === "function") {
      for (const entity of this.map.waypoints("*")) consider(entity.classname, entity.position);
    }
    return best && best.distance <= 320 ? best : null;
  }

  // ---- action -------------------------------------------------------------

  async #act(decision, percept, read) {
    const yaw = read.angles.yaw;
    // What this tick's own corrections actually ask for, in degrees. The fire
    // gate below is checked against these and not against a re-read, because
    // the turns have already been sent by then and a second read would be
    // another round trip inside the tick.
    let appliedYaw = 0;
    // The turn: one mouse delta proportional to the error, clamped so the
    // controller cannot overshoot the target within a tick.
    if (decision.aim !== null && decision.aim !== undefined) {
      const error = shortestTurn(decision.aim - yaw);
      const step = Math.max(-this.options.maxTurnPerTick, Math.min(this.options.maxTurnPerTick, error * this.options.turnGain));
      if (Math.abs(step) >= 0.05 && typeof this.game.look === "function") {
        this.pendingTurn = { requested: step, yaw };
        try {
          await this.game.look(step * this.turnScale);
          appliedYaw = step;
        } catch (error) {
          this.pendingTurn = null;
          this.note("the turn failed: " + error.message);
        }
      }
    }
    // The pitch: the same proportional correction on the mouse's other axis,
    // driving the view at the target's own height. Without it the loop aimed a
    // level shot and a target whose z it could not reach was a target it fired
    // at anyway.
    const pitch = read.angles.pitch;
    let appliedPitch = 0;
    let pitchError = null;
    if (this.options.pitchAim !== false && decision.pitch !== null && decision.pitch !== undefined && typeof this.game.lookPitch === "function") {
      pitchError = decision.pitch - pitch;
      const step = Math.max(-this.options.maxPitchPerTick, Math.min(this.options.maxPitchPerTick, pitchError * this.options.pitchGain));
      if (Math.abs(step) >= 0.05) {
        this.pendingPitch = { requested: step, pitch };
        try {
          await this.game.lookPitch(step * this.pitchScale);
          appliedPitch = step;
        } catch (error) {
          this.pendingPitch = null;
          if (this.pitchFailures === 0) this.note("the pitch turn failed: " + error.message);
          this.pitchFailures += 1;
        }
      }
    }
    // The walk: the keys that move the player along the route while the view
    // holds wherever the fight needs it. This is the whole trick of looking one
    // way and walking another, and it is recomputed every tick.
    let keys = [];
    if (decision.move !== null && decision.move !== undefined) keys = movementKeys(yaw, decision.move);
    await this.#hold(keys);
    // The trigger: down only when a target is chosen, the aim has converged on
    // BOTH axes and the level says the shot reaches. `decision.fire` already
    // carries the geometry test.
    //
    // The error is measured against the aim the turns ABOVE have just achieved
    // (`yaw + appliedYaw`), not against the yaw read at the top of the tick.
    // That is not a nicety, it is the difference between firing and not: the
    // controller's gain is 0.5, so each tick removes half the error, and a
    // reading taken before the correction is always about twice the real one.
    // Measured on the traced run before this fix: of 182 engagement ticks, 28
    // had the trigger down, and in the ticks around them the aim error sat at
    // 2.0 to 2.4 degrees -- inside the 1.6-degree gate after the turn that was
    // already on its way, and outside it in the stale reading the gate was
    // asked about.
    const aimNow = yaw + appliedYaw;
    const pitchNow = pitch + appliedPitch;
    const aimError = decision.aim === null || decision.aim === undefined ? null : Math.abs(shortestTurn(decision.aim - aimNow));
    const pitchReady = !(this.options.pitchAim !== false && pitchError !== null) || Math.abs(decision.pitch - pitchNow) <= this.options.pitchTolerance;
    const wantFire = decision.fire === true && aimError !== null && aimError <= this.options.aimTolerance && pitchReady;
    // Counted here, on the tick's own corrected aim, so a run that never asks
    // for the per-tick trace still carries the measurement the second axis is
    // judged by. `ticks` is every tick with a target in front of the player.
    if (percept && percept.target) {
      const yawIn = aimError !== null && aimError <= this.options.aimTolerance;
      this.gate.ticks += 1;
      if (yawIn) this.gate.yawInside += 1;
      if (pitchReady) this.gate.pitchInside += 1;
      if (yawIn && pitchReady) this.gate.bothInside += 1;
      if (wantFire) this.gate.fire += 1;
      if (aimError !== null) { this.gate.aimErrorSum += aimError; this.gate.aimErrorCount += 1; }
      if (this.options.pitchAim !== false && pitchError !== null) { this.gate.pitchErrorSum += Math.abs(pitchError); this.gate.pitchErrorCount += 1; }
    }
    // How long the trigger was down, counted between ticks rather than from the
    // press: counting from the press adds the whole engagement on every tick it
    // stays down, which reported 349 seconds of trigger-down inside a 270
    // second run.
    const nowMs = Date.now();
    if (this.triggerDown && this.lastTriggerTick) this.triggerMs += Math.max(0, nowMs - this.lastTriggerTick);
    this.lastTriggerTick = nowMs;
    if (wantFire !== this.triggerDown) {
      this.triggerDown = wantFire;
      if (wantFire) this.shots += 1;
      if (typeof this.game.mouseHold === "function") await this.game.mouseHold("left", wantFire).catch(() => {});
    }
    this.lastDecision = { ...decision, aimError, pitchError };
  }

  async #hold(keys) {
    const wanted = [...new Set(keys)];
    const same = wanted.length === this.keysHeld.length && wanted.every((key) => this.keysHeld.includes(key));
    if (same) return;
    this.keysHeld = wanted;
    if (typeof this.game.hold === "function") await this.game.hold(wanted).catch(() => {});
  }

  async #release() {
    this.keysHeld = [];
    this.triggerDown = false;
    if (typeof this.game.hold === "function") await this.game.hold([]).catch(() => {});
    if (typeof this.game.mouseHold === "function") await this.game.mouseHold("left", false).catch(() => {});
  }

  async #handleDeath(read, tickStart) {
    // A death on this level is not the end of the walk: the engine's
    // fire-to-respawn restores its own autosave, which is the level's start.
    // The loop waits for the player to be alive again, then re-plans from
    // wherever that put them.
    if (this.deaths > this.options.deaths) return { stop: true, reason: "DEATHS" };
    if (typeof this.game.mouseHold === "function") await this.game.mouseHold("left", false).catch(() => {});
    let alive = null;
    for (let attempt = 0; attempt < 5 && !alive; attempt++) {
      // Fire is the press that leaves Quake 2's death camera, and the bridge's
      // own `respawn()` is that press -- measured on this box, one press and
      // 2.5 seconds is enough on a clean death. It is not always enough under
      // fire, which is why it is tried more than once.
      if (typeof this.game.respawn === "function") await this.game.respawn({ how: "fire", settleMs: 900 }).catch(() => null);
      else await this.game.click("left").catch(() => {});
      const again = await this.game.live().catch(() => null);
      if (again && again.read && again.read.ok && again.read.dead === false) alive = again.read;
      else await this.#sleep(400);
    }
    if (!alive) {
      // A press that will not take. Restarting the level is what the run did to
      // start it, and `map demo1` is one of the two console commands this
      // harness is allowed; it puts the player on the spawn rather than at the
      // end of the corridor, which is a cost, not a cheat.
      this.note("the death camera would not let go; restarting the level", { deaths: this.deaths });
      // The cheats line that accompanies the restart is a lever, not a constant:
      // a normal run restarts with `cheats 0` -- which is the default here and
      // what every pass before this one sent -- and the iteration-mode run
      // (control/fast.mjs) restarts with `cheats 1`, so its own restart cannot
      // be the thing that ends iteration mode half way through. Nothing else
      // reads the option, so the normal path is unchanged.
      await this.game.command(["map " + (this.level || "demo1"), this.options.cheatsAfterRestart || "cheats 0"], { tail: 8 }).catch(() => null);
      await this.#sleep(2500);
      const again = await this.game.live().catch(() => null);
      if (again && again.read && again.read.ok && again.read.dead === false) alive = again.read;
    }
    if (!alive) return { stop: true, reason: "NOT_RESPAWNED" };
    const player = alive.position;
    this.stuck = { since: null, from: null, stage: 0, nudges: 0 };
    // A new life gets its own retreat allowance.
    this.retreatSince = null;
    this.waypoint = null;
    this.focusNumber = null;
    const replanned = this.#planFrom(player);
    if (replanned && replanned.points && replanned.points.length) {
      this.plan = replanned;
      this.routeIndex = 0;
    }
    // A restart hands the player the spawn's own blaster back, so every errand
    // that was run before the death is owed again.
    for (const errand of this.errands) errand.taken = false;
    this.note("the player is alive again; the plan was rebuilt from " + Math.round(player.x) + " " + Math.round(player.y), { deaths: this.deaths });
    return null;
  }

  async #sleep(ms) {
    if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ---- verification -------------------------------------------------------

  #track(player, monsters, tickStart, decision, clear) {
    const goal = this.goal;
    if (goal) {
      const distance = Math.hypot(player.x - goal.x, player.y - goal.y);
      if (!this.deepest || distance < this.deepest.distance) {
        this.deepest = { x: player.x, y: player.y, z: player.z, distance, at: Date.now(), mode: decision.mode };
      }
    }
    if (this.deepest === null || Date.now() - (this.lastTrailAt || 0) >= TRAIL_EVERY_MS) {
      this.lastTrailAt = Date.now();
      this.trail.push({ x: Math.round(player.x), y: Math.round(player.y), z: Math.round(player.z), monsterCount: monsters.length, mode: decision.mode });
      if (this.trail.length > 4000) this.trail.shift();
    }
    // Kills: a monster this loop has seen alive and is no longer seeing at all.
    const seen = new Set(monsters.map((monster) => this.#key(monster)));
    for (const [number, record] of this.targets) {
      if (record.killed) continue;
      if (seen.has(number)) { record.lastSeen = Date.now(); continue; }
      if (Date.now() - record.lastSeen > 1200 && record.samples >= 3) {
        record.killed = true;
        record.killedAt = Date.now();
        this.kills.push({ number, classname: record.classname, samples: record.samples, flinches: record.flinches || 0 });
        this.note("a monster stopped being sent by the engine: " + record.classname + " (#" + number + ")", { afterSamples: record.samples });
      }
    }
  }

  #summary({ reason, ticks, started, goal }) {
    const targets = [...this.targets.values()].map((record) => ({
      number: record.number,
      classname: record.classname,
      modelindex: record.modelindex,
      seen: record.samples,
      flinches: record.flinches || 0,
      damageEvents: record.damageEvents || 0,
      killed: record.killed === true,
      solids: record.solids,
      effects: record.effectsSeen,
      lastFrame: record.frame,
    }));
    const healths = this.healthSeries.map((entry) => entry.health).filter(finite);
    // Read once, so the numbers in `enemies` and the per-attempt ones beside
    // them are the same reading rather than two taken a tick apart.
    const enemies = this.#enemiesNow();
    return {
      reason,
      ticks,
      durationMs: Date.now() - started,
      plan: this.plan && this.plan.points ? { points: this.plan.points.length, distance: Math.round(this.plan.distance || 0) } : null,
      position: this.lastPosition,
      deepest: this.deepest,
      trail: this.trail,
      states: this.states,
      shots: this.shots,
      triggerMs: Math.round(this.triggerMs),
      kills: this.kills,
      killsCount: this.kills.length,
      flinches: this.flinches,
      damageEvents: this.damageEvents,
      // ---- the owner's second success condition --------------------------
      //
      // Enemies MET and enemies KILLED, both from the game DLL's own state.
      // `killed` here is `met.edict.health <= 0`, never a landed turn; the
      // frame-moved proxy that the passes before this one used is reported
      // separately as `damageEvents` and is not what any of these numbers is
      // built on.
      //
      // These are the LAST attempt's numbers -- the trip that either reached
      // the exit or ran out of road -- because a death reloads the level and
      // revives its monsters, so an earlier life's kills are not this life's.
      // Every attempt's own numbers are in `attempts` beside them.
      enemies,
      attempts: this.attempts,
      killedEvents: this.killEvents,
      // Health the game itself says was taken off monsters, and how many times
      // its number fell -- the direct replacement for the frame-moved proxy.
      // This attempt's, with the run's own totals next to them.
      healthDamage: enemies.healthDamage,
      healthDamageEvents: enemies.healthDamageEvents,
      healthDamageTotal: this.healthDamage,
      healthDamageEventsTotal: this.healthDamageEvents,
      edictRead: {
        ...this.edictRead,
        playerEdict: this.playerEdictNumber,
        crossCheck: this.healthCrossCheck,
      },
      edictHealth: this.edictHealth,
      hitRate: this.shots > 0
        ? {
            damageEventsPerPress: this.damageEvents / this.shots,
            damageEventsPerSecondOfTrigger: this.triggerMs > 0 ? this.damageEvents / (this.triggerMs / 1000) : null,
            killsPerPress: this.kills.length / this.shots,
            // The real ones: presses that took health off a monster, and
            // presses that killed one, both as the GAME reports them.
            healthDropsPerPress: this.healthDamageEvents / this.shots,
            gameKillsPerPress: this.killEvents.length / this.shots,
            healthPerSecondOfTrigger: this.triggerMs > 0 ? this.healthDamage / (this.triggerMs / 1000) : null,
          }
        : null,
      monstersSeen: this.monstersSeen,
      targets,
      healthSeries: this.healthSeries,
      lowestHealth: healths.length ? Math.min(...healths) : null,
      lastHealth: healths.length ? healths[healths.length - 1] : null,
      deaths: this.deaths,
      errands: { asked: this.errands.map((errand) => ({ classname: errand.classname, call: errand.call, taken: errand.taken === true })), run: this.errandsRun },
      boltSpeed: { used: Math.round(this.boltSpeed), samples: this.boltSamples },
      bolts: {
        maxInFlight: this.boltsInFlight || 0,
        framesWithABolt: this.boltFrames || 0,
        // Model index 45 WITHOUT the blaster effect: the level's own props, at
        // fixed positions. Kept apart from the bolts so a sensor that has
        // stopped discriminating cannot read as a trigger that never stops
        // firing.
        rejectedModelIndexOnly: this.boltModelOnly || 0,
        rejectedModelIndexOnlyTotal: this.boltModelOnlyTotal || 0,
      },
      // Two rates, because they are two different numbers and only one of them
      // is what a reader means by "how fast is the loop".
      //
      // `msPerLive` and `msPerAct` are the tick's own work. `hzAtWork` is the
      // rate of that work alone, which is NOT the loop's rate: it leaves out
      // the sleep that keeps the tick at `tickMs`, and on a tick whose work
      // finishes early it reports a rate the loop never runs at -- measured, a
      // 150-tick run whose ticks took 30 ms of work and 50 ms of sleep reported
      // 33.7 Hz while running at 11.5. `wallClockHz` is the loop's actual rate
      // over the whole run, deaths and level restarts included.
      timing: {
        ticks: this.timing.ticks,
        msPerLive: this.timing.ticks ? Math.round(this.timing.live / this.timing.ticks) : null,
        msPerAct: this.timing.ticks ? Math.round(this.timing.act / this.timing.ticks) : null,
        msPerTickAtWork: this.timing.ticks ? Math.round((this.timing.live + this.timing.act) / this.timing.ticks) : null,
        hzAtWork: this.timing.ticks ? Math.round((1000 / ((this.timing.live + this.timing.act) / this.timing.ticks)) * 10) / 10 : null,
        wallClockHz: (Date.now() - started) > 0 ? Math.round((ticks / ((Date.now() - started) / 1000)) * 10) / 10 : null,
      },
      turnScale: { learned: Math.round(this.turnScale * 1000) / 1000, samples: this.turnSamples },
      // The second axis, its own calibration, and whether the engine took it.
      pitch: {
        on: this.options.pitchAim !== false,
        scale: Math.round(this.pitchScale * 1000) / 1000,
        samples: this.pitchSamples,
        failures: this.pitchFailures,
      },
      // The gate, per tick with a target: the measurement the aim in both axes
      // is judged by, and the one that replaced "did the turn land".
      gate: {
        ...this.gate,
        aimErrorMean: this.gate.aimErrorCount ? Math.round((this.gate.aimErrorSum / this.gate.aimErrorCount) * 100) / 100 : null,
        pitchErrorMean: this.gate.pitchErrorCount ? Math.round((this.gate.pitchErrorSum / this.gate.pitchErrorCount) * 100) / 100 : null,
      },
      trace: this.trace,
      entityIntegrity: this.entityIntegrity,
      levelChanged: this.levelChanged,
      log: this.log,
    };
  }
}

// A one-call entry point, for callers that have a map and a goal and no
// interest in the class.
export async function play(game, map, goal, options = {}) {
  const loop = new PlayLoop(game, map, options);
  return loop.run(goal, options);
}

export default PlayLoop;
