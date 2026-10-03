// control/combat.mjs -- the fight on the way out of a level.
//
// route.mjs says where the way out is, walker.mjs walks it and opens what has to
// be opened. Neither one shoots, and on demo1 that is the whole story: the route
// is 4,693 units long and the furthest a walker has ever been measured is
// 3,286 of them, because five soldiers stand along the corridor the route goes
// down and a walk that does not answer them dies there. The level is not
// blocked; it is *defended*.
//
// So this module adds the one thing the walker was missing -- a reason to look
// at something other than the next route point -- and it does it in the level's
// own terms. Every soldier is an entity in the BSP's entity lump with an origin
// the level's author placed; `map.waypoints("enemy")` is that list, and
// `threats()` is what is left of it once the geometry has been asked whether a
// shot could even reach.
//
// The tactic is the one a player uses and the one the failed runs did not: keep
// walking, and shoot what is in the way while you walk. Moving is not a
// preference on this level, it is the whole of the defence -- standing still in
// demo1's corridor with full health and no armour was measured to end in a
// corpse in six seconds, while walking the same ground into the same soldiers
// costs nothing. So a leg that has a target looks at it, holds the trigger down,
// and *walks the route anyway*: Quake 2 moves a player along the view, so
// looking at a soldier to the side means holding forward *and* the strafe key
// that keeps the player on the line the walker chose (see movementKeys). The
// first attempt at this walked at the soldier instead -- off the plan, into a
// wall beside the corridor, standing still in the open -- and died on the second
// leg of the fight.
//
// Aiming, and why there is no pitch here. A Quake 2 bolt leaves the muzzle along
// the view and flies straight, so a shot fired with the view level crosses the
// world at the player's eye height -- 46 units above the floor they stand on.
// A soldier standing on that same floor is 56 units tall with its origin 24
// above its feet, so its body spans eye-24 to eye+32: the eye is *inside* it,
// and a level shot hits the chest without any pitch at all. That is not a
// coincidence, it is how the level was built, and it is why this module filters
// to soldiers the level shot can reach instead of guessing an angle. The ones it
// cannot reach -- a soldier on the floor above, a sniper on a ledge -- are
// behind the floor's own geometry from down here, which the line check below
// finds anyway.
//
// It gives up honestly, like the walker. A level with no enemies in it is a
// level this walker crosses exactly as the plain one does, and that is a test,
// not a special case: `threats()` on a map with no `monster_*` entities returns
// an empty list and `_legTarget` hands back the route point it was given.

import { RouteWalker } from "./walker.mjs";

// The player's eye sits this far above the floor they stand on (24 of the
// player's 32x32x56 box, plus 22 more to the view). map data places floors and
// the engine reports the eye; every vertical comparison here goes through this,
// the same way walker.mjs does it.
const EYE_ABOVE_FEET = 46;

// A monster's own box, relative to the entity's origin: Quake 2 gives a soldier
// a (-16,-16,-24) to (16,16,32) box, so its origin sits 24 above its feet and 24
// below its top of head.
const MONSTER_FEET_BELOW_ORIGIN = 24;
const MONSTER_HEAD_ABOVE_ORIGIN = 32;

export const ENGAGE_DEFAULTS = {
  // How far away a soldier is worth turning for. A Quake 2 soldier starts
  // shooting at about 1,000 units and does not stop; a little past that is the
  // distance at which ignoring one is a decision rather than an oversight.
  engageRange: 1100,
  // How far off the way forward a soldier may stand and still be shot at. The
  // player does not walk *at* the soldier -- the fight leg walks the route and
  // looks sideways (see movementKeys) -- so this is not a limit on how far the
  // walk can be dragged off course. It is a limit on how much of a turn is worth
  // making, and a turn is cheap: a soldier to the side of the corridor is a
  // soldier the player can shoot while passing it, which is exactly what a
  // player does and what walking *at* it cannot do.
  engageArc: 80,
  // How long one firing leg lasts. At the player's 300 units per second this is
  // about 150 units of ground and, with the trigger held, several blaster bolts
  // -- three of them kill a soldier, and they are aimed the whole way in.
  engageStepMs: 500,
  // How many walk rounds an ordinary (non-firing) leg may take. The base
  // walker's leg runs goto() until it arrives, which on open ground is many
  // hundred units of walking with no decision made in between -- and that is
  // exactly how a walk dies in demo1's corridor: the leg that enters it is
  // decided while the soldiers are still out of sight, and the next decision is
  // taken by a corpse. Two rounds is about 240 units, comfortably inside the
  // range a soldier opens fire at, so the trigger comes down before the fight
  // starts rather than after it.
  walkRounds: 2,
  // How many times the same soldier may be walked at before the walker leaves it
  // alone. There is no console command that says whether a monster is dead --
  // not even its health, which is drawn on the HUD like the player's -- so
  // "leaving it alone" is not a statement that it died. It is a statement that
  // three legs at it is the most this walker will spend on one of them.
  maxEngagements: 3,
  // ...unless the soldier is this close, in which case the count does not
  // apply and it is shot at until the walk is out of its reach. A soldier at
  // arm's length is the one thing on the floor that can be *blocking* the walk:
  // Quake 2's monsters are solid, a walk that ends against one makes no progress
  // and re-plans into the same wall, and the count -- which exists to stop the
  // walker wasting its budget on a distant soldier it cannot finish -- is the
  // wrong tool for it. A corpse is not solid, so a leg spent on one costs a turn
  // and nothing else; the leg walks the route either way.
  closeRange: 250,
  // How many of the legs spent on a close soldier may come out of the count's
  // exemption rather than the count. Without a cap the exemption is a loop: a
  // run that ended pinned 63 units from a `monster_soldier` spent eight
  // engagements on it and never looked anywhere else, because a soldier inside
  // closeRange is never skipped. Two extra legs is enough to finish a fight that
  // is going to be finished, and few enough that a fight that is not leaves the
  // walk somewhere to go.
  closeEngagements: 2,
  // How far along the plan a *fighting* leg walks towards, and how far away
  // that point may be. The base walker aims at the farthest route point it can
  // see, which is right for a walk and wrong for a fight: a player looking at a
  // soldier and walking at a point a thousand units beyond it walks *through*
  // the soldier to get there, and Quake 2's monsters are solid. Measured: a
  // walk that reached the corridor stopped there, 1,660 units short, 65 units
  // from a `monster_soldier` and 12 units from the route -- stuck against a body
  // it had been firing past. Walking at the route a few points ahead keeps the
  // leg on the path the planner actually cleared.
  walkAhead: 4,
  walkReach: 240,
  // How far the player has to move away from an engagement before the count
  // against that soldier starts again. A level restart puts the player back at
  // the spawn, which is this far from anywhere they died, so a fresh attempt
  // fights the same soldiers again rather than walking past their corpses.
  forgetDistance: 600,
};

// Local compass arithmetic, matching the engine's: 0 is +X, 90 is +Y, and the
// yaw grows anticlockwise. bridge.mjs has its own copy of these two; they are
// three lines each and importing them would mean exporting them from the
// browser-facing bridge, which is a worse trade than repeating them.
function bearingTo(from, to) {
  return (Math.atan2(to.y - from.y, to.x - from.x) * (180 / Math.PI) + 360) % 360;
}

function shortestTurn(degrees) {
  let angle = Number(degrees) % 360;
  if (angle > 180) angle -= 360;
  if (angle <= -180) angle += 360;
  return angle;
}

// Which keys walk the player along `wanted` while they are looking at
// `facing`, both in Quake 2's bearings.
//
// Quake 2 moves a player along the view, so the only way to shoot one way and
// walk another is to hold the view and add a strafe: forward is the view,
// `+moveleft` is the view turned a quarter turn anticlockwise, and the four
// diagonals are the two together. Eight directions is enough to be within 22.5
// degrees of any bearing, which is a straighter line than the walk would manage
// if it were re-aimed every step.
//
// This is not decoration. A fighting leg that walks *at* the soldier is a leg
// that walks off the plan and into whatever is beside the corridor: measured on
// demo1, the first such leg travelled 28 units in half a second, the second
// travelled none at all, and the player -- standing still in the open, which is
// the one thing the level punishes -- was dead before the third.
export function movementKeys(facing, wanted) {
  const turn = shortestTurn(Number(wanted) - Number(facing));
  if (!Number.isFinite(turn)) return ["w"];
  const off = Math.abs(turn);
  if (off <= 22.5) return ["w"];
  if (off >= 157.5) return ["s"];
  // Positive is anticlockwise, which is towards `+moveleft`.
  const side = turn > 0 ? "a" : "d";
  if (off <= 67.5) return ["w", side];
  if (off <= 112.5) return [side];
  return ["s", side];
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function point(value) {
  if (!value || typeof value !== "object") return null;
  const at = { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
  if (![at.x, at.y, at.z].every(Number.isFinite)) return null;
  return at;
}

// Would a shot fired level from `eye` reach the thing standing at `target`?
//
// The shot is a horizontal line at the eye's own height, which is what the
// engine fires when the view is level, so the question splits in two: is the
// target's body tall enough to be crossed by that line, and is the line clear?
// Both are answered from the level's own data -- the BSP's contents for the
// second, the monster's own box for the first -- and neither needs the browser.
export function levelShotReaches(map, eye, origin, options = {}) {
  if (!eye || !origin) return false;
  // A map with no geometry to ask -- a stub in a test -- has no wall to invent.
  if (!map || typeof map.isSolid !== "function") return true;
  const slack = numberOr(options.slack, 12);
  const low = origin.z - MONSTER_FEET_BELOW_ORIGIN - slack;
  const high = origin.z + MONSTER_HEAD_ABOVE_ORIGIN + slack;
  const eyeZ = eye.z;
  if (eyeZ < low || eyeZ > high) return false;
  const span = Math.hypot(origin.x - eye.x, origin.y - eye.y);
  const steps = Math.max(2, Math.ceil(span / (options.step || 24)));
  for (let index = 1; index < steps; index++) {
    const t = index / steps;
    if (map.isSolid(eye.x + (origin.x - eye.x) * t, eye.y + (origin.y - eye.y) * t, eyeZ)) return false;
  }
  return true;
}

// Can a standing player walk a straight line between two floors?
//
// The same four heights walker.mjs samples -- knees, waist, chest, head, above
// the feet -- and, just as important, sampled *finely*. demo1's pocket is walled
// in by a `func_wall` 16 units thick in x, and a 16-unit stride steps straight
// over it: a line check that walks in 16-unit strides reports the way clear and
// sends the player into the wall, which is how a walk ends up stopped at
// -427 111 with a valid route to the exit in hand.
export function clearWalk(map, from, to, options = {}) {
  if (!map || typeof map.isSolid !== "function") return true;
  if (!from || !to) return false;
  const span = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(2, Math.ceil(span / numberOr(options.step, 10)));
  for (let index = 1; index < steps; index++) {
    const t = index / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const z = from.z + (to.z - from.z) * t;
    for (const lift of [8, 24, 40, 52]) if (map.isSolid(x, y, z + lift)) return false;
  }
  return true;
}

// What in the level's own entity list is worth shooting from here, best first.
//
// `from` is where the player is (the engine reports the eye). `options.bearing`
// is the way the walker is already heading, in degrees; a soldier behind the
// player is not a soldier this walk can turn for without giving up the route.
// Enemies are scored by how much of the fight it costs to deal with them now:
// the distance to walk, plus a penalty for every degree off the way forward.
export function threats(map, from, options = {}) {
  const eye = point(from);
  if (!eye) return [];
  const enemies = options.enemies || map.waypoints("enemy");
  const range = numberOr(options.engageRange, ENGAGE_DEFAULTS.engageRange);
  const arc = numberOr(options.engageArc, ENGAGE_DEFAULTS.engageArc);
  const angleCost = numberOr(options.angleCost, 3);
  const bearing = options.bearing === undefined || options.bearing === null ? null : Number(options.bearing);
  const skip = typeof options.skip === "function" ? options.skip : () => false;
  const out = [];
  for (let index = 0; index < enemies.length; index++) {
    const enemy = enemies[index];
    const origin = point(enemy && enemy.position);
    if (!origin) continue;
    const key = enemy.index === undefined ? index : enemy.index;
    if (skip(key, enemy)) continue;
    const distance = Math.hypot(origin.x - eye.x, origin.y - eye.y);
    if (distance > range) continue;
    let off = 0;
    if (bearing !== null && Number.isFinite(bearing)) {
      off = Math.abs(shortestTurn(bearingTo(eye, origin) - bearing));
      if (off > arc) continue;
    }
    // A soldier close enough to be touching the player is not something to
    // turn the view onto: the bearing to it changes with every step, and the
    // leg would spend its half second spinning instead of firing. It is a
    // collision to be walked out of, not a target, and the walker's own stuck
    // handling is what deals with that.
    if (distance < numberOr(options.minimumRange, 40)) continue;
    if (!levelShotReaches(map, eye, origin, options)) continue;
    out.push({
      index: key,
      classname: enemy.classname,
      position: origin,
      distance,
      off,
      score: distance + off * angleCost,
    });
  }
  return out.sort((a, b) => a.score - b.score);
}

// The walker that shoots back. It is the plain walker with one decision
// replaced -- which point the next leg aims at -- plus the one thing that
// decision implies: a leg aimed at a soldier fires on the way there.
export class CombatWalker extends RouteWalker {
  constructor(game, map, options = {}) {
    super(game, map, options);
    this.engage = { ...ENGAGE_DEFAULTS, ...(options.engage || {}) };
    // The level's monsters, indexed once, so the per-leg decision is arithmetic
    // on a list the level gave us rather than a search through the entity lump.
    this.enemies = (map && map.waypoints ? map.waypoints("enemy") : [])
      .filter((enemy) => enemy.position)
      .map((enemy, index) => ({ ...enemy, index }));
    // index -> { count, from }: how many legs have been spent walking at this
    // one, and where the player was standing when that started. See
    // ENGAGE_DEFAULTS.forgetDistance for what clears it.
    this.engagements = new Map();
    // Every firing leg, for the report. `aimed` says whether the turn landed on
    // the soldier; a leg that fired with the turn still short is recorded as
    // such, because that is the difference between "the plan missed" and "the
    // engine would not turn", and only one of those is worth fixing.
    this.fights = [];
  }

  // How many times this soldier has been walked at from roughly where the player
  // stands now. Counted from a position, not from the start of the run, so that
  // a level restart -- which puts the player back at the spawn, hundreds of
  // units from wherever they fell -- hands every soldier a clean slate.
  #spent(index, position) {
    const seen = this.engagements.get(index);
    if (!seen) return 0;
    if (Math.hypot(seen.from.x - position.x, seen.from.y - position.y) > this.engage.forgetDistance) {
      this.engagements.delete(index);
      return 0;
    }
    return seen.count;
  }

  #spend(index, position) {
    const spent = this.#spent(index, position);
    this.engagements.set(index, { count: spent + 1, from: { x: position.x, y: position.y, z: position.z } });
    return spent + 1;
  }

  // Where a fighting leg walks towards: the route a few points along the plan
  // from wherever the player is, kept inside walkReach so that the direction is
  // the path's own and not a long chord across it. It falls back to the next
  // point when even that is too far, and to whatever it was given when there is
  // no plan at all (a caller driving the walker leg by leg).
  #walkPoint(position, points) {
    if (!Array.isArray(points) || !points.length) return null;
    let nearest = 0;
    let best = Infinity;
    for (let index = 0; index < points.length; index++) {
      const distance = Math.hypot(points[index].x - position.x, points[index].y - position.y);
      if (distance < best) { best = distance; nearest = index; }
    }
    // The player's feet, because a route point is a floor and the engine reports
    // the eye (see EYE_ABOVE_FEET).
    const feet = { x: position.x, y: position.y, z: position.z - EYE_ABOVE_FEET };
    // A point that has to be jumped to is never walked past: the jump is aimed
    // and timed one point at a time (see walker.mjs), so the leg stops there.
    for (let index = nearest + 1; index <= Math.min(nearest + this.engage.walkAhead, points.length - 1); index++) {
      if (points[index].jump) return points[index];
    }
    // Farthest first, and back towards the player until one of them can be
    // *walked to* and not merely seen: a plan point across a wall is a leg that
    // ends against it, and a walk that ends against a wall is a walk that stops
    // still in the open, which is the one thing demo1 punishes.
    for (let index = Math.min(nearest + this.engage.walkAhead, points.length - 1); index > nearest; index--) {
      const candidate = points[index];
      if (Math.hypot(candidate.x - position.x, candidate.y - position.y) > this.engage.walkReach) continue;
      if (clearWalk(this.map, feet, candidate, this.engage)) return candidate;
    }
    return points[Math.min(nearest + 1, points.length - 1)];
  }

  // The seam: aim at a soldier when one is standing where the route goes, and at
  // the route point when none is. The route point is still computed first, and
  // still decides the cone -- a walk that turns for a soldier behind it is a
  // walk that has stopped going anywhere.
  _legTarget(position, points) {
    // The near point first, for every leg and not only the firing ones. The base
    // walker aims at the farthest route point it can see, which is a *chord*
    // across the plan: it is checked for a clear line, not for a walkable floor,
    // and on demo1 that is enough to walk the player into the dead-end pocket at
    // -427 111 and stall there -- measured, with the walker's own note naming
    // that position and the two `func_wall`s it was standing against. Following
    // the plan point by point costs a re-decision every leg and cannot cut a
    // corner, because the points it aims at are points the planner cleared.
    const near = this.#walkPoint(position, points);
    const route = near || super._legTarget(position, points);
    if (!route || !this.enemies.length) return route;
    const bearing = bearingTo(position, route);
    const found = threats(this.map, position, {
      ...this.engage,
      bearing,
      enemies: this.enemies,
      skip: (index, enemy) => {
        const spent = this.#spent(index, position);
        if (spent < this.engage.maxEngagements) return false;
        const close = Math.hypot(enemy.position.x - position.x, enemy.position.y - position.y) <= this.engage.closeRange;
        return !(close && spent < this.engage.maxEngagements + this.engage.closeEngagements);
      },
    });
    if (!found.length) return route;
    const target = found[0];
    this._note("a soldier is on the way; looking at it with the trigger down", {
      classname: target.classname,
      at: target.position,
      distance: Math.round(target.distance),
      offCourseDegrees: Math.round(target.off),
      attempt: this.#spend(target.index, position),
    });
    // z is the player's own eye height: the aim is deliberately level, so that
    // what the weapon is pointed at is a line the level shot can actually reach
    // (see the note at the top of this file). The `route` the leg walks is the
    // near one -- see walkAhead -- because the far one may lie straight through
    // the soldier being shot at, and a monster is solid.
    return { x: target.position.x, y: target.position.y, z: position.z, enemy: target, route: this.#walkPoint(position, points), jump: 0 };
  }

  async _leg(target, options) {
    if (!target || !target.enemy) {
      // A leg with nothing to shoot still has to be short, because the decision
      // to shoot is only taken between legs. See walkRounds.
      const rounds = Math.max(1, Math.min(options.maxRounds || 40, this.engage.walkRounds));
      return super._leg(target, { ...options, maxRounds: rounds });
    }
    return this.#fight(target, options);
  }

  // One firing leg: look at the soldier, hold the trigger down, walk the route,
  // let the trigger up.
  //
  // The walk is the part that matters, and it is the route -- not the soldier.
  // Walking at what is being shot at is what a first attempt does and what the
  // level punishes twice: the aim leaves the plan, the leg ends against a wall
  // beside the corridor, the player stops moving in the open, and a stopped
  // player is dead inside a few seconds (measured: 100 health and no armour
  // becomes a corpse in six seconds of standing still in demo1's corridor,
  // while the whole walk in costs nothing). So the leg faces the soldier and
  // walks the way the walker was already going, with the strafe key that keeps
  // the two apart.
  async #fight(target, options) {
    const before = await this.game.position();
    // No position to aim from is not a reason to skip the leg: falling through
    // to the ordinary step reports the miss honestly instead of throwing.
    if (!before || !before.position) return super._leg({ ...target, enemy: undefined }, options);
    const aim = { x: target.x, y: target.y, z: before.position.z };
    const facing = bearingTo(before.position, aim);
    const aimed = await this.game.face(facing, {
      from: before,
      tolerance: numberOr(options.faceTolerance, 6),
      rounds: numberOr(options.faceRounds, 4),
    });
    // Where to walk: at the route point the leg would have aimed at had there
    // been no soldier. A leg that has lost its route point walks where it looks,
    // which is the best a leg can do with nothing to go on.
    const walkBearing = target.route ? bearingTo(before.position, target.route) : facing;
    const keys = movementKeys(facing, walkBearing);
    const stepMs = numberOr(options.engageStepMs, this.engage.engageStepMs);
    await this.game.attackHold(true);
    let walked = null;
    try {
      walked = await this.game.walkKeys(keys, stepMs, options);
    } finally {
      // The trigger comes up even if the walk threw: fire is also the key that
      // leaves the death camera, and a stuck trigger would respawn the player
      // onto the engine's autosave instead of the level's own spawn.
      await this.game.attackHold(false);
    }
    const after = await this.game.position();
    const at = (after && after.position) || before.position;
    this.fights.push({
      classname: target.enemy.classname,
      aimed: !!(aimed && aimed.facing),
      aimError: aimed && aimed.error !== undefined ? Math.round(aimed.error) : null,
      keys,
      offCourseDegrees: Math.round(shortestTurn(walkBearing - facing)),
      from: before.position,
      at,
      travelled: Math.round(Math.hypot(at.x - before.position.x, at.y - before.position.y)),
      holdMs: walked ? walked.heldMs : 0,
    });
    return { ...(after || { position: before.position }), fired: true, position: at };
  }

  // The same walk the base class runs, plus a summary of the fight so far --
  // a count of firing legs, and how many of them the turn actually landed on.
  async follow(goal, options = {}) {
    const result = await super.follow(goal, options);
    return {
      ...result,
      combat: {
        enemiesInLevel: this.enemies.length,
        firingLegs: this.fights.length,
        onTarget: this.fights.filter((fight) => fight.aimed).length,
        fights: this.fights,
      },
    };
  }
}

export default CombatWalker;
