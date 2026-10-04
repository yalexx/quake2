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

import { movementKeys, levelShotReaches, clearWalk, floorNear } from "./combat.mjs";

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
  if (!percept) return { mode: "advance", move: null, aim: null, fire: false, reason: "NO_READING" };
  if (percept.dead) return { mode: "dead", move: null, aim: null, fire: false, reason: "PLAYER_DEAD" };
  if (percept.arrived) return { mode: "arrived", move: null, aim: null, fire: false, reason: "AT_THE_EXIT" };
  if (percept.recover) {
    return { mode: "recover", move: percept.recover.bearing, aim: percept.recover.aim || null, fire: percept.recover.fire === true, reason: percept.recover.reason || "STUCK" };
  }
  const target = percept.target || null;
  // Retreat is a health decision, not a fight one: the player is hurt, and the
  // level's own corridor is the thing that is killing them. It still shoots --
  // this level punishes a player who stops.
  const hurt = finite(percept.health) && percept.health <= lowHealth;
  if (hurt && target && percept.retreatBearing !== null && percept.retreatBearing !== undefined) {
    return { mode: "retreat", move: percept.retreatBearing, aim: target.bearing, fire: true, reason: "LOW_HEALTH" };
  }
  if (target) {
    return { mode: "engage", move: percept.routeBearing, aim: target.bearing, fire: percept.targetClear !== false, reason: "MONSTER_IN_RANGE" };
  }
  // Nothing to shoot: face the way the walk is going. Quake 2 moves a player
  // along the view, so a walk that never turns is a walk that steers entirely
  // with the strafe keys -- which works, at 45-degree steps, and it is what the
  // first version of this loop did. Turning with the route is the same walk
  // with `+forward` doing the work.
  return { mode: "advance", move: percept.routeBearing, aim: percept.routeBearing, fire: false, reason: "WAY_CLEAR" };
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
    // scale, before this tick decides the next correction.
    this.#learnTurn(read.angles.yaw);

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

    // ---- 1b. health, from the status bar ----------------------------------
    // The one reading the engine cannot be asked for out of memory (see the
    // module comment), so it is read off the status bar at a bounded rate and
    // cached in between. The HUD read is the project's own (control/hud.mjs).
    let health = this.lastView.health;
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
        }
      : null;
    const stuck = this.#stuckNow(player, tickStart);
    const retreatBearing = this.#retreatBearing(player, ranked, route);
    const arrived = goal ? Math.hypot(player.x - goal.x, player.y - goal.y) <= this.goalTolerance : false;

    if (dead) {
      await this.#release();
      this.deaths += 1;
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
    this.trace.push({
      tick: this.lastView.tick,
      mode: decision.mode,
      said: decision.reason,
      yaw: Math.round(read.angles.yaw * 10) / 10,
      aim: decision.aim === null || decision.aim === undefined ? null : Math.round(decision.aim * 10) / 10,
      aimError: decision.aim === null || decision.aim === undefined ? null : Math.round(Math.abs(shortestTurn(decision.aim - read.angles.yaw)) * 10) / 10,
      clear: clear === true,
      fire: this.triggerDown === true,
      target: target ? { n: target.number, d: Math.round(target.distance), off: Math.round(target.off) } : null,
      monsters: this.lastView.monsters.length,
      at: [Math.round(player.x), Math.round(player.y), Math.round(player.z)],
      scale: Math.round(this.turnScale * 100) / 100,
    });
    if (this.trace.length > 800) this.trace.shift();
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
    for (const entity of entities) {
      if (!entity) continue;
      if (entity.modelindex !== this.options.boltModel) continue;
      if (entity.solid === MONSTER_SOLID) continue; // a monster, not a bolt
      inTheAir.push(entity);
    }
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

  // A shot is only worth taking when the level's own geometry says a level shot
  // from the player's eye reaches the target's body. The box the target's own
  // live origin implies -- not the one the map placed.
  #shotReaches(player, monster) {
    return levelShotReaches(this.map, player, monster.position, {});
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
    // Where the player is on the plan: the nearest point, which is also what
    // "how far off the plan am I" means. The index only ever moves forward and
    // never by more than a few points in one tick -- a route that passes near
    // itself later would otherwise teleport the walk to the far side of it.
    let closest = null;
    for (let index = 0; index < points.length; index++) {
      const distance = Math.hypot(points[index].x - player.x, points[index].y - player.y);
      if (!closest || distance < closest.distance) closest = { index, distance };
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
        return { bearing: heading, aim, fire: true, reason: "STUCK_BUTTON" };
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

  #nearestButton(player) {
    if (!this.map || typeof this.map.waypoints !== "function") return null;
    let best = null;
    for (const entity of this.map.waypoints("*")) {
      if (!entity.position) continue;
      if (!/^func_button$/.test(entity.classname)) continue;
      const distance = Math.hypot(entity.position.x - player.x, entity.position.y - player.y);
      if (!best || distance < best.distance) best = { classname: entity.classname, position: entity.position, distance };
    }
    return best && best.distance <= 320 ? best : null;
  }

  // ---- action -------------------------------------------------------------

  async #act(decision, percept, read) {
    const yaw = read.angles.yaw;
    // The turn: one mouse delta proportional to the error, clamped so the
    // controller cannot overshoot the target within a tick.
    if (decision.aim !== null && decision.aim !== undefined) {
      const error = shortestTurn(decision.aim - yaw);
      const step = Math.max(-this.options.maxTurnPerTick, Math.min(this.options.maxTurnPerTick, error * this.options.turnGain));
      if (Math.abs(step) >= 0.05 && typeof this.game.look === "function") {
        this.pendingTurn = { requested: step, yaw };
        try {
          await this.game.look(step * this.turnScale);
        } catch (error) {
          this.pendingTurn = null;
          this.note("the turn failed: " + error.message);
        }
      }
    }
    // The walk: the keys that move the player along the route while the view
    // holds wherever the fight needs it. This is the whole trick of looking one
    // way and walking another, and it is recomputed every tick.
    let keys = [];
    if (decision.move !== null && decision.move !== undefined) keys = movementKeys(yaw, decision.move);
    await this.#hold(keys);
    // The trigger: down only when a target is chosen, the aim has converged and
    // the level says the shot reaches. `decision.fire` already carries the
    // geometry test.
    const aimError = decision.aim === null || decision.aim === undefined ? null : Math.abs(shortestTurn(decision.aim - yaw));
    const wantFire = decision.fire === true && aimError !== null && aimError <= this.options.aimTolerance;
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
    this.lastDecision = { ...decision, aimError };
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
      await this.game.command(["map " + (this.level || "demo1"), "cheats 0"], { tail: 8 }).catch(() => null);
      await this.#sleep(2500);
      const again = await this.game.live().catch(() => null);
      if (again && again.read && again.read.ok && again.read.dead === false) alive = again.read;
    }
    if (!alive) return { stop: true, reason: "NOT_RESPAWNED" };
    const player = alive.position;
    this.stuck = { since: null, from: null, stage: 0, nudges: 0 };
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
      hitRate: this.shots > 0
        ? {
            damageEventsPerPress: this.damageEvents / this.shots,
            damageEventsPerSecondOfTrigger: this.triggerMs > 0 ? this.damageEvents / (this.triggerMs / 1000) : null,
            killsPerPress: this.kills.length / this.shots,
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
      bolts: { maxInFlight: this.boltsInFlight || 0, framesWithABolt: this.boltFrames || 0 },
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
