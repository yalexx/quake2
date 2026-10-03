// control/walker.mjs -- follow a route through a live level, and say what
// stopped it when it stops.
//
// route.mjs answers "where do I go?" from the level's own data; bridge.mjs can
// hold a key and read back where the player ended up. Neither one gets a player
// from the spawn to the exit on its own. A grid route is a line drawn over a
// floor plan, and a level is not a floor plan: the doors are shut, the lift is
// at the wrong end, the follower drifts into a corner that the grid does not
// know is there, and a route that ran fine in the data dead-ends against a
// func_door 20 units from the mouth of a corridor.
//
// So this is a follower, not a planner: it walks the route one leg at a time,
// and every time a leg fails it works out *why* and does the one thing that
// fixes that kind of failure.
//
//   * a leg that stops next to a brush entity that moves -- a door, a button --
//     gets the use key held, and the leg is retried. That is what opens a door.
//   * a leg that stops anywhere else gets a step taken *away* from the point it
//     was aiming at, and then the route *re-planned from where the player
//     actually is* once the attempt gives up on this one. The first route was
//     drawn from the spawn; a route drawn from a position 300 units into the
//     level sees rooms the first one did not, and this is also how a follower
//     recovers from a drift the grid route did not intend. The step back is not
//     decoration: a follower pressed square against something the grid does not
//     know about draws the same line again from the same spot and walks it at
//     the same view, which is the same wall at the same angle on every round of
//     every attempt.
//   * a leg that keeps failing gets a sideways step and a new plan, because a
//     follower pressed square against a wall never learns which way is open.
//   * a leg whose next point is flagged `jump` gets the space bar: a gap too
//     wide to step over is crossed by running at it.
//
// It gives up honestly. `reached: false` comes back with the position the player
// really stopped at, how far short it was, what the plan said about the spot,
// and a log of what was tried -- because "it is stuck at -448 112 -48 against a
// func_wall" is worth more than a hopeful "walking".

import { loadMap } from "./route.mjs";

// The movement the walker plans with. A step up of 24 units is what a player
// walks up without thinking; a drop of 96 is a fall they survive; a jump of 160
// is a run-and-leap over a gap, which is how demo1's canyon is crossed. A route
// that needs any of these says so in its points, so a caller can see that the
// plan is not a stroll.
// The engine reports the *eye*, and this is how far above the feet it sits: the
// player's origin is the middle of their 32x32x56 box (24 up) and the view is
// another 22 above that. A route point is a floor, so every comparison between
// the two has to go through this.
const EYE_ABOVE_FEET = 46;

// Whether a player standing at `position` is touching the thing a `via` call
// names -- and "touching" is not a radius.
//
// Quake 2 takes a pickup when the player's box and the item's box overlap, and
// that test is per axis. The player's box is 32 units across and a pickup item
// is the same, so two origins 45 units apart *on the diagonal* are touching --
// 32 across and 32 along, both exactly on the limit -- while two origins 33
// units apart *straight out* are not. A radius gets those the wrong way round,
// and on demo1 it is the difference that mattered: measured, a walk sent to
// fetch the level's supershotgun closed to 33 units of it, was not told the call
// was made, could not close the last unit, and spent a whole attempt dithering
// beside the weapon it had already picked up.
//
// The vertical test is a slab for the same reason. An item rests on a floor with
// its origin in the middle of its 32-unit box; the player stands on that floor
// with their origin 24 above their feet. The boxes overlap while the origins are
// up to 40 units apart in z, so the slab is wider than the half-width -- and it
// still refuses a call on another storey.
const CALL_TOUCH_HALF = 32;
const CALL_TOUCH_Z = 56;

function touchesCall(position, call) {
  if (!position || !call) return false;
  const feet = position.z - EYE_ABOVE_FEET;
  return Math.abs(position.x - call.x) <= CALL_TOUCH_HALF &&
    Math.abs(position.y - call.y) <= CALL_TOUCH_HALF &&
    Math.abs(feet - call.z) <= CALL_TOUCH_Z;
}

const WALK_DEFAULTS = {
  maxStepUp: 45, // a step, or the height a jump clears
  maxDrop: 300, // a fall the player walks away from
  maxJump: 160, // a gap crossed at a run
  maxJumpDown: 300,
  cell: 24,
  step: 4,
  // How far down the route a single straight walk may aim -- a guard rail, not a
  // leash. The trap it guards is real: demo1 has a dead-end pocket at -427 111,
  // and the line from the start room to the far west runs right past it, so a leg
  // aimed far off can slide in and stall. But a *tight* cap is worse than the
  // trap: measured against demo1, capping at 360 stalled every walk in the first
  // corridor (2043, 2049, 2032 and 2022 units short of the exit), because every
  // leg that ends at a wall costs a re-plan, while a long leg carries the player
  // out of the start room and 3,286 units down the level -- 1407 units from the
  // exit -- before the soldiers kill them. What keeps a walk pointed forwards is
  // the nearest-point rule in #farthestVisible; this is only here so that one leg
  // cannot aim the length of the level.
  maxLegDistance: 1200,
};

// The closest the engine was ever *measured* to be to the goal, over every
// reading this walk took.
//
// This exists because `position` on a run that ended on a death or on the
// attempt budget is the *last* thing the engine said, and the last thing it
// says before a level restart is where the corpse was. A run that reached
// -951 1023 and then died back at the pocket reports `position: -462 19 -19`
// unless the two readings are kept apart, and "how far did the walk get" is
// answered by this one, not by the other. (Measured: the deepest `finish` run
// on demo1 is exactly that pair -- furthest -951 1023, last read -462 19 -19 --
// and a report that prints only the second understates the walk by 500 units.)
//
// It is computed from the trail rather than tracked as a running variable so
// that every return site agrees with the record the caller can already see.
export function deepestReading(trail) {
  let best = null;
  for (const point of trail || []) {
    if (!point || typeof point.distance !== "number") continue;
    if (!best || point.distance < best.distance) best = point;
  }
  if (!best) return null;
  return {
    x: best.x, y: best.y, z: best.z,
    distance: best.distance,
    attempt: best.attempt,
    leg: best.leg === undefined ? null : best.leg,
  };
}

// A point this walk can aim at, or null. All three coordinates, not the two the
// route is walked on: a call with no height is not a call this walk can use, and
// a point that reaches the follower with a coordinate that is not a number does
// not degrade the walk, it ends it -- every distance to it is NaN, every
// comparison against that NaN is false, and the follower grinds out its whole
// budget aiming at a place the engine can never report the player as standing.
// The check belongs where the point enters, so that a bad one is refused with a
// reason instead of failing somewhere inside the leg loop.
export function finitePoint(value) {
  if (!value || typeof value !== "object") return null;
  const at = { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
  return [at.x, at.y, at.z].every(Number.isFinite) ? at : null;
}

export class RouteWalker {
  constructor(game, map, options = {}) {
    this.game = game;
    this.map = map;
    // The level this walk belongs to. It is what tells "the player is dead on
    // the level I am walking" (restart it) from "the level ended and the engine
    // has loaded the next one" (stop, do not undo it).
    this.levelName = map && map.name ? map.name : null;
    this.options = { ...WALK_DEFAULTS, ...options };
    this.log = [];
    // How many times this walk has been put back on a restarted level. A death
    // does not spend an attempt (see `attempt--` in follow), so the attempt
    // number alone cannot tell a subclass that the player is a *different*
    // player now -- back on the spawn with the level's own starting loadout.
    // This is what does.
    this.restarts = 0;
  }

  #note(message, detail) {
    const entry = { at: new Date().toISOString(), message, ...(detail ? { detail } : {}) };
    this.log.push(entry);
    return entry;
  }

  // The same note, for a subclass. A fighting walker's decisions -- which
  // soldier a leg was aimed at, and why -- belong in the log the caller reads
  // back next to the walker's own, and the log is one list.
  _note(message, detail) {
    return this.#note(message, detail);
  }

  // What the level says is near a point, and whether any of it moves. This is
  // how a stuck follower tells "a door is in my way" from "a wall is in my way".
  brushesNear(point, radius = 96) {
    const out = [];
    for (const model of this.map.models) {
      if (model.kind === "none") continue;
      const nearest = {
        x: Math.max(model.mins.x, Math.min(point.x, model.maxs.x)),
        y: Math.max(model.mins.y, Math.min(point.y, model.maxs.y)),
        z: Math.max(model.mins.z, Math.min(point.z, model.maxs.z)),
      };
      const distance = Math.hypot(nearest.x - point.x, nearest.y - point.y, nearest.z - point.z);
      if (distance > radius) continue;
      out.push({ ...model, distance });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  // Hold the use key, take another run at the target, let go. A door in Quake 2
  // opens when the player touches it -- but only if they are using something at
  // the time, so the key goes down before the step and comes up after it.
  async #tryDoor(point, options) {
    await this.game.useHold(true);
    try {
      const result = await this.game.goto(point, { ...options, maxRounds: Math.min(6, options.maxRounds || 6) });
      return result;
    } finally {
      await this.game.useHold(false);
    }
  }

  // The point a leg aims at. The base walker is a navigator and knows only the
  // route, so it picks the farthest point the player can see -- never one behind
  // them, and never one that needs a jump.
  //
  // This is the seam a fighting walker overrides: `control/combat.mjs` hands
  // back the soldier standing where the route goes instead of the route point,
  // and its own `_leg` looks at that soldier while it walks. Nothing else about
  // the leg loop changes, which is the point -- "where am I going, and what am
  // I shooting at" is one decision, made in one place.
  _legTarget(position, points) {
    return this.#farthestVisible(position, points) ||
      points[Math.min(this.#nearestIndex(position, points) + 1, points.length - 1)];
  }

  // Walk one leg. Returns the bridge's goto() result, plus whether the point
  // wanted a jump on the way in. Overridable for the same reason _legTarget is:
  // a subclass that aims at a soldier has to fire while it walks.
  async _leg(point, options) {
    if (point.jump) {
      // Face the landing spot and run at it with the jump key down: a gap is
      // cleared by speed and timing, not by aiming.
      const before = await this.game.position();
      // The engine can fail to answer -- the bridge models that as a result with
      // a null position -- and a walk that dies on a TypeError instead of
      // reporting where it stopped is worse than one that does not jump. So a
      // leg with no position to aim from falls through to the ordinary step,
      // which reports the miss honestly.
      if (!before || !before.position) return this.game.goto(point, options);
      const bearing = Math.atan2(point.y - before.position.y, point.x - before.position.x) * 180 / Math.PI;
      await this.game.face(bearing, { from: before, tolerance: 6, rounds: 4 });
      const jump = this.game.jump();
      const walked = this.game.walk(options.stepMs || 400);
      await Promise.all([jump, walked]);
      const after = await this.game.position();
      return { ...(after || { position: before.position }), jumped: true, reached: false };
    }
    return this.game.goto(point, options);
  }

  // Steer straight at a goal the route planner has no route to, and report how
  // far a player really gets. The bridge's goto() is a straight-line follower:
  // it will not go round anything, but it does walk, jump-free, and it says
  // where it stopped. Dying restarts the level and the run continues from the
  // spawn, so a level that kills the player halfway shows up as a furthest point
  // short of the goal rather than as a failure to start -- and the furthest
  // point is measured from positions the player actually walked to, because a
  // respawn that restored a save would otherwise be reported as ground covered.
  async #explore(goal, options, trail) {
    const rounds = Math.max(1, options.exploreRounds === undefined ? 3 : options.exploreRounds);
    let best = null;
    for (let round = 0; round < rounds; round++) {
      const start = await this.game.position();
      if (!start || !start.position) break;
      if (this.levelName && start.map && start.map !== this.levelName) {
        this.#note("the engine moved to another level; stopping the exploration", { from: this.levelName, to: start.map });
        break;
      }
      if (start.dead && options.respawn !== false && this.game.respawn) {
        this.#note("the player is dead; restarting the level before exploring");
        await this.game.respawn({ expectMap: this.levelName });
      }
      const trip = await this.game.goto(goal, {
        tolerance: options.tolerance === undefined ? 96 : options.tolerance,
        stepMs: options.stepMs === undefined ? 400 : options.stepMs,
        timeoutMs: options.exploreTimeoutMs === undefined ? 60000 : options.exploreTimeoutMs,
        stuckRounds: 4,
        maxRounds: 120,
      });
      // Read the state rather than trusting the trip's last position: a position
      // read while the death camera is up is the corpse's, and reporting it as
      // ground covered would credit the walk with a distance it never crossed.
      const state = await this.game.position();
      const at = state && !state.dead ? state.position : null;
      if (!at) {
        this.#note("the walk ended with the player dead; not counting its position", { reason: trip.reason });
        const back = await this.game.respawn({ expectMap: this.levelName });
        if (back.reason === "LEVEL_CHANGED") break;
        continue;
      }
      if (at) {
        trail.push({ x: at.x, y: at.y, z: at.z, explore: round + 1, distance: Math.hypot(at.x - goal.x, at.y - goal.y) });
        if (!best || Math.hypot(at.x - goal.x, at.y - goal.y) < best.distance) {
          best = { position: at, distance: Math.hypot(at.x - goal.x, at.y - goal.y), travelled: trip.travelled || 0, reason: trip.reason };
        }
      }
      this.#note("explored straight at the goal", { round: round + 1, at, distance: best && Math.round(best.distance), reason: trip.reason });
      if (!at || Math.hypot(at.x - goal.x, at.y - goal.y) <= (options.tolerance || 96)) break;
      // Somewhere new to try from: a step sideways and another run.
      await this.game.strafe(500, round % 2 === 0 ? "left" : "right");
    }
    return best || { position: null, distance: null, travelled: 0 };
  }

  // Plan from where the player is now. `from` is the live position rather than
  // the last waypoint, because the two differ by whatever the last leg actually
  // achieved.
  plan(from, to) {
    return this.map.path(from, to, this.options);
  }

  // The level the engine itself says it is running, asked on its own console --
  // not the `map` that `position()` carries, which is the last `mapname` the
  // engine answered and goes on naming the level the run started in however
  // long ago that was. A game with no console to ask -- a walker driven by a
  // stub in a test -- answers nothing rather than guessing, so this can never
  // invent a level change.
  async #levelFromEngine() {
    if (!this.game || typeof this.game.level !== "function") return null;
    try {
      const read = await this.game.level();
      return read && read.map ? read.map : null;
    } catch {
      return null;
    }
  }

  // Can a player walk in a straight line between two points? Sampled at the
  // body's height, because that is what has to be clear -- a route point is a
  // floor and the player stands *on* it, so the line is tested 8 to 52 units up
  // from the feet.
  #lineOpen(from, to) {
    const feet = { x: from.x, y: from.y, z: from.z - EYE_ABOVE_FEET };
    const span = Math.hypot(to.x - feet.x, to.y - feet.y);
    const steps = Math.max(2, Math.ceil(span / 16));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const x = feet.x + (to.x - feet.x) * t;
      const y = feet.y + (to.y - feet.y) * t;
      const z = feet.z + (to.z - feet.z) * t;
      for (const lift of [8, 24, 40, 52]) if (this.map.isSolid(x, y, z + lift)) return false;
    }
    return true;
  }

  // The farthest point of the plan the player can walk straight to, or null when
  // even the nearest is out of sight (a corner, a door, a step). A point that
  // needs a jump is never chosen this way: a jump is aimed at one point at a
  // time, because the leap has to be aimed and timed.
  // Only ever aims at a point *after* the one the player is nearest to. A leg
  // that aims behind the player walks them back the way they came -- and with a
  // leg-length cap in play it is easy to hit: a player who has slid a little
  // south of the corridor is nearest to route point 6, and the farthest point
  // within 360 units with a clear line is point 2, back in the start room. The
  // cap and this go together: one keeps the leg short enough not to slide into a
  // pocket, the other keeps it pointed at where the route is going.
  #farthestVisible(from, points) {
    const limit = this.options.maxLegDistance === undefined ? WALK_DEFAULTS.maxLegDistance : this.options.maxLegDistance;
    const nearest = this.#nearestIndex(from, points);
    for (let i = points.length - 1; i > nearest; i--) {
      if (points[i].jump) continue;
      if (limit && Math.hypot(points[i].x - from.x, points[i].y - from.y) > limit) continue;
      if (this.#lineOpen(from, points[i])) return points[i];
    }
    return null;
  }

  // A call on the `via` list has been reached, and whatever the caller asked to
  // happen on arrival happens here.
  //
  // The one thing that uses it is a key press, and the reason it exists is that
  // picking a weapon up is not the same as holding it. Quake 2's `weapon_*`
  // items put the weapon in the pack; which one the player is *firing* is a
  // separate state, and a walk that leaves it alone walks the rest of the level
  // with whatever it started with -- on demo1, the spawn's own blaster, against
  // soldiers standing thirty units from the route. The key to press is not
  // guessed here: it comes from the caller, which reads it out of the engine's
  // own config (see QuakeControl.binding).
  //
  // Never throws. A key that cannot be pressed leaves the walk where it was --
  // on a call it has made, with the note saying the press did not land -- which
  // is worse than a working press and much better than losing the attempt.
  async #madeCall(entry) {
    const asked = entry && entry.tap ? (Array.isArray(entry.tap) ? entry.tap : [entry.tap]) : [];
    const pressed = [];
    for (const key of asked) {
      if (typeof this.game.tap !== "function") {
        this.#note("a call asked for a key this game object cannot press", { key });
        continue;
      }
      try {
        await this.game.tap(key);
        pressed.push(key);
      } catch (error) {
        this.#note("a call's key did not reach the game", { key, reason: error.message });
      }
    }
    return pressed;
  }

  // The route point the player is nearest to.
  #nearestIndex(from, points) {
    let nearest = 0;
    let best = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = Math.hypot(points[i].x - from.x, points[i].y - from.y);
      if (d < best) { best = d; nearest = i; }
    }
    return nearest;
  }

  // Walk the route, re-planning when it breaks. `goal` is the point the route is
  // planned towards; the walker stops when the player is inside `tolerance` of
  // it, or when it has run out of ideas.
  async follow(goal, options = {}) {
    // The goal is the one point the whole walk is aimed at, so it is the last
    // place a coordinate that is not a number should be found -- and the worst,
    // because a walk that cannot aim at its goal has no answer to give about
    // the level. Refused here, by name, rather than left to fail inside the
    // leg loop (see finitePoint).
    const aimed = finitePoint(goal);
    if (!aimed) {
      this.#note("the goal is not a point this walk can aim at", { goal });
      return { reached: false, reason: "BAD_GOAL", goal: goal === undefined ? null : goal, position: null, trail: [], log: this.log };
    }
    goal = aimed;
    const tolerance = options.tolerance === undefined ? 64 : options.tolerance;
    const attempts = Math.max(1, options.attempts === undefined ? 6 : options.attempts);
    const legOptions = {
      tolerance: Math.max(24, tolerance / 2),
      stepMs: options.stepMs === undefined ? 400 : options.stepMs,
      timeoutMs: options.timeoutMs === undefined ? 25000 : options.timeoutMs,
      stuckRounds: 3,
      maxRounds: options.maxRounds === undefined ? 40 : options.maxRounds,
    };
    const trail = [];
    // How many level restarts this walk will live through. A death is not a
    // plan that failed: the level puts the player back at the spawn and the
    // route out of it is the route that already worked, so charging the death
    // to the attempt budget -- which is what this used to do -- makes the walk
    // only as long as the level is survivable. demo1 is defended by 33 monsters
    // and is not: measured, six and seven of the eight attempts in two `finish`
    // runs went on restarts, and the walk was over in the corridor with the
    // level's own plan unspent. The restarts get their own budget instead --
    // `attempts` still bounds the re-plans, so a walk that cannot get anywhere
    // still stops.
    const deathsAllowed = Math.max(0, options.deaths === undefined ? attempts : options.deaths);
    let deaths = 0;
    let attempt = 0;
    let bestDistance = Infinity;
    let position = null;
    let lastPlan = null;
    // Places the walk has to call at on the way to the goal: the level's own
    // weapons, armour and shells, which a fresh spawn does not have and the
    // fight cannot be walked through without. They are goals in their own right,
    // taken in the order given, and `stage` is how many have been reached.
    //
    // The order is the caller's, and it is not an optimization: a walk that dies
    // after the weapon and before the exit is put back at the spawn *without*
    // the weapon, so the errand has to be run again. That is why `stage` is
    // reset by a death and why this lives inside the attempt loop rather than in
    // a sequence of separate calls from outside -- a sequence of calls would
    // walk the exit route from the spawn with nothing but the spawn's own
    // blaster on every second attempt, and report that as the level's fault.
    // All three coordinates, not just the two the route is walked on. A call
    // with no height is not a call this walk can use, and `map.path()` throws
    // `BAD_REQUEST` on a goal it cannot parse -- so a malformed entry left in
    // the list does not degrade the walk, it ends it with an exception from
    // inside the follower. The filter is where a bad call is supposed to stop.
    const via = Array.isArray(options.via)
      ? options.via.filter((point) => point &&
        Number.isFinite(Number(point.x)) && Number.isFinite(Number(point.y)) && Number.isFinite(Number(point.z)))
      : [];
    // How close a leg walking to a call has to aim. This is the distance the
    // player really ends up at, because `goto` stops as soon as it is inside
    // the tolerance it was given -- and it has to be small, because a plan's
    // last point is a grid cell and its centre can sit most of a cell away from
    // the item the call names. Whether the call then counts as *made* is not a
    // distance at all: see touchesCall.
    const viaLegTolerance = options.viaLegTolerance === undefined ? 12 : options.viaLegTolerance;
    // How close the player has to be before the walk stops aiming at the
    // planner's cell and starts aiming at the item itself. See the guard on the
    // appended point below.
    const viaApproach = options.viaApproach === undefined ? 240 : options.viaApproach;
    let stage = 0;
    // The point this attempt is really walking towards: the next call that has
    // not been made, or the goal once every one of them has.
    const activeGoal = () => (stage < via.length ? via[stage] : goal);
    // A call that has been made does not spend one of the attempts, for the same
    // reason a death does not: an attempt is a *re-plan that went nowhere*, and
    // walking to the level's own supershotgun is the walk going somewhere.
    // Charging it to the budget is what a walk with four calls to make and five
    // attempts to make them in gets. Measured, on the run that argued for this:
    // the errand run spent every attempt it had, made the last call with the
    // budget already gone, and never turned for the exit at all -- the mechanic
    // worked and the accounting around it made it useless.
    const madeCall = async (entry) => {
      const pressed = await this.#madeCall(entry);
      stage++;
      attempt--;
      bestDistance = Infinity;
      return pressed;
    };

    while (attempt < attempts) {
      attempt++;
      let current = await this.game.position();
      if (!current || !current.position) {
        this.#note("no position from the engine", current);
        return { reached: false, reason: "NO_POSITION", attempts: attempt, position: null, trail, log: this.log };
      }
      // The engine is playing a different level: this walk is over, and whatever
      // the reason, restarting *this* one would be undoing someone else's work.
      // The intermission camera rolls exactly as the death camera does, so
      // without this the walk that enters the exit trigger would immediately
      // restart the level it just finished.
      if (this.levelName && current.map && current.map !== this.levelName) {
        this.#note("the engine moved to another level; stopping", { from: this.levelName, to: current.map });
        return { reached: false, reason: "LEVEL_CHANGED", map: current.map, level: this.levelName, attempts: attempt, position: current.position, trail, log: this.log };
      }
      // A dead player cannot move, and every movement key silently does nothing:
      // without this check a death reads as a wall and the follower grinds at it
      // until its budget runs out. Dying mid-level is normal -- demo1 is full of
      // soldiers -- so the level is restarted and the attempt begins again from
      // the spawn.
      if (current.dead && options.respawn !== false && this.game.respawn) {
        this.#note("the player is dead; restarting the level");
        deaths++;
        if (deaths > deathsAllowed) {
          this.#note("the level has restarted the player too many times", { deaths, allowed: deathsAllowed });
          return { reached: false, reason: "DEATHS", attempts: attempt, deaths, position: current.position, deepest: deepestReading(trail), trail, log: this.log, plan: lastPlan, blockers: (lastPlan && lastPlan.blockers) || [] };
        }
        // The restart does not spend an attempt: the plan was not the thing
        // that failed, and the next one is the same plan from the same spawn.
        attempt--;
        // Back at the spawn means back to the spawn's own loadout: whatever the
        // walk had collected on the way is gone with the corpse, so every call
        // is owed again.
        stage = 0;
        bestDistance = Infinity;
        const back = await this.game.respawn({ expectMap: this.levelName });
        this.#note(back.respawned ? "back in the level" : "could not get back into the level", { how: back.how, reason: back.reason });
        if (back.reason === "LEVEL_CHANGED") {
          return { reached: false, reason: "LEVEL_CHANGED", map: back.map, level: this.levelName, attempts: attempt, position: back.position, trail, log: this.log };
        }
        const restarted = await this.game.position();
        if (!restarted || !restarted.position) {
          return { reached: false, reason: "NO_POSITION", attempts: attempt, position: null, deepest: deepestReading(trail), trail, log: this.log };
        }
        if (restarted.dead) {
          // The player is still a corpse, so the restart did not take. That is
          // not the end of the walk: it is a restart that has to be tried again,
          // and the budget for trying again is the death budget the caller set
          // -- the top of this loop counts it and stops the walk when it runs
          // out. Ending the run here instead is what a proof run did on its
          // fourth death, with six of its eight lives and the level's own route
          // still unspent. Measured: two restarts came back `ALIVE` from the
          // bridge's own recheck and the walker read a corpse straight after.
          this.#note("the player is still dead; restarting again");
          continue;
        }
        // Alive again, on a level that has just been restarted: this is a new
        // life, and the choices a subclass made about the old one -- which
        // weapon it asked the engine for -- are spent with it.
        this.restarts++;
        current = restarted;
      }
      position = current.position;
      // A call the walk is already standing on is a call it has made. This runs
      // before the goal test on purpose: a restart puts the player back at the
      // spawn, and a spawn that happens to sit on one of the calls must not be
      // read as the walk being over.
      while (stage < via.length && touchesCall(position, via[stage])) {
        const call = stage + 1;
        const pressed = await madeCall(via[stage]);
        this.#note("standing where the walk was headed anyway", { at: via[stage], call, of: via.length, pressed });
      }
      const active = activeGoal();
      // Two distances, and they answer different questions. `need` is how far
      // the player is from what this attempt is walking towards -- the next call
      // while any are owed, and the goal after that -- and it is what progress
      // is judged by. `distance` is the run's own record of how far it is from
      // the goal, which is what `deepest`, the report and a reader of the trail
      // all mean by "how far did it get". Handing the first over as the second
      // would make a walk that stopped 20 units from a shell box read as a walk
      // that stopped 20 units from the exit.
      const need = Math.hypot(position.x - active.x, position.y - active.y);
      const distance = Math.hypot(position.x - goal.x, position.y - goal.y);
      trail.push({ x: position.x, y: position.y, z: position.z, attempt, distance, need: stage < via.length ? need : undefined });
      if (stage >= via.length && need <= tolerance && Math.abs(position.z - active.z) <= (options.zTolerance || 96)) {
        this.#note("reached the goal");
        return { reached: true, reason: "reached", attempts: attempt, position, distance, trail, log: this.log, crossings: lastPlan ? lastPlan.crossings : undefined };
      }

      const plan = this.plan(position, active);
      // A call is an *object*, not a place on the grid. The planner answers with
      // the centre of the floor cell it snapped the goal to, and that centre can
      // sit most of a cell away from the item the level put there -- which is
      // the difference between walking over a supershotgun and walking past it.
      // Measured, on the run that argued for this: the walk arrived beside the
      // weapon, 16 units along one axis and 48 along the other, was not touching
      // it, had nothing left to aim at that was any closer, backed off, and went
      // wandering. The item's own origin is put on the end of the plan so the
      // leg that fetches it is aimed at the thing itself.
      // Only on the last approach, though, and that guard is not decoration
      // either. The item's origin is an entity's origin, not a floor the planner
      // has cleared: aimed at from across the level it is a bearing with no
      // floor under it, and a walk that follows one on demo1 is a walk off the
      // ledge above its canyon. Measured, on the first run that tried it
      // unguarded: the player ended at `317 76 -198`, two hundred units below
      // the level, with no route anywhere. Inside `viaApproach` the correction
      // is what it was meant to be -- a step onto the thing the walk is standing
      // beside -- and outside it the plan is the planner's own.
      if (stage < via.length && plan.points.length &&
          Math.hypot(position.x - active.x, position.y - active.y) <= viaApproach) {
        plan.points = [...plan.points, { x: active.x, y: active.y, z: active.z, jump: 0 }];
      }
      lastPlan = plan;
      if (!plan.points.length && stage < via.length) {
        // A call the planner cannot find a way to is a call this walk cannot
        // make from here, and it is not the walk's destination: standing the
        // whole walk on it because a shell box is round a corner the grid does
        // not connect is how a run that was going to the exit ends up throwing
        // its attempt budget at a detour. It is given up on -- out loud, so the
        // report says which errand was abandoned and why -- and the walk
        // re-plans for whatever is next, which after the last call is the exit.
        const abandoned = via[stage];
        this.#note("giving up on a call the planner cannot reach", {
          classname: abandoned.classname || null, at: abandoned, reason: plan.reason, call: stage + 1, of: via.length,
        });
        stage++;
        attempt--;
        continue;
      }
      if (!plan.points.length) {
        this.#note("no route from here", { reason: plan.reason, closest: plan.closest, blockers: plan.blockers });
        // "No route" is also what a level that has changed under the walk looks
        // like, and the cheap reading cannot tell the two apart. The plan is
        // drawn on the level this walk set out in; once the engine has loaded
        // the next one the player stands in the new level's coordinates and
        // every grid point misses -- while `position().map` keeps naming the
        // old level, because it is the `mapname` answer from the start of the
        // run and nothing refreshes it. Measured on `demo1`: the engine loaded
        // `demo2` with the player 80 units from the exit, and the walk spent
        // the rest of its budget planning `demo2`'s coordinates on `demo1`'s
        // grid, ending on `START_OFF_GRID` -- a lost route, not a lost level.
        // This is the one place the engine's own word is worth a console round
        // trip: it is the moment the walk has lost the level, and the answer
        // decides between "there is no way out of here" and "there is nothing
        // left to do here".
        const live = await this.#levelFromEngine();
        if (this.levelName && live && live !== this.levelName) {
          this.#note("the engine moved to another level; stopping", { from: this.levelName, to: live });
          return { reached: false, reason: "LEVEL_CHANGED", map: live, level: this.levelName, attempts: attempt, position, trail, log: this.log };
        }
        // The level's own floor plan does not connect these two points. That is
        // the answer to "is there a route", but it is not an answer to "how far
        // does a player get" -- a grid says a wall is a wall, and the only thing
        // that knows whether the player can actually walk it is the player. So
        // unless the caller said not to, the walker steers straight at the goal
        // and reports the furthest position it really reached, which is the
        // honest measure of how much of the level is playable and *where* it
        // stops.
        if (options.explore !== false) {
          const explored = await this.#explore(active, options, trail);
          return {
            reached: false,
            reason: plan.reason,
            message: plan.message,
            attempts: attempt,
            position: explored.position,
            // How far the furthest point really reached is from the *goal*, and
            // not from whatever the walk was heading for when it got there. A
            // walk that ran out of level beside a shell box has not stopped a
            // hundred units from the exit.
            distance: explored.position ? Math.hypot(explored.position.x - goal.x, explored.position.y - goal.y) : null,
            explored: true,
            plan,
            blockers: plan.blockers || [],
            trail,
            log: this.log,
          };
        }
        return {
          reached: false,
          reason: plan.reason,
          message: plan.message,
          attempts: attempt,
          position,
          distance,
          plan,
          blockers: plan.blockers || [],
          trail,
          log: this.log,
        };
      }
      this.#note("planned a route", { points: plan.points.length, distance: Math.round(plan.distance || 0), crossings: (plan.crossings || []).map((c) => c.classname + c.model) });

      // Walk as far down the route as the player can see, then look again. A
      // grid route is a staircase of twenty-four unit steps, and stopping at
      // each one wastes the walk and multiplies the chances of a leg failing on
      // a step's riser; the follower aims instead at the farthest route point
      // with a clear line from where the player stands -- which is the goal
      // itself whenever the room allows it.
      const maxLegs = Math.max(2, options.maxLegs === undefined ? 8 : options.maxLegs);
      let legs = 0;
      let stalled = 0;
      while (legs < maxLegs) {
        // Fall back to the point just after the one the player is nearest to,
        // never to the goal: an aimed-at goal from a corner is a straight walk
        // through whatever is in the way, which is how a walk ends up in a
        // pocket the route went round.
        const target = this._legTarget(position, plan.points);
        // The attempt and leg numbers ride along with the leg so that anything
        // the leg records -- a combat walker's health reading, say -- can say
        // where in the run it was taken.
        // A leg walking to a *call* is held to a tighter tolerance than a leg
        // walking the route. A route point is a place to be roughly, and 48
        // units of slack is what keeps a follower from grinding against a
        // riser. A call is an object on the floor, and it is picked up by
        // touching it: measured, a walk sent for demo1's supershotgun closed to
        // 48 units of it, was told it had arrived, and could not close the last
        // 16 -- because the leg's own arrival radius was the thing standing
        // between the player and the weapon. `goto` will walk onto a point when
        // it is asked for that, so it is asked for that.
        const leg = await this._leg(target, {
          ...legOptions,
          tolerance: stage < via.length ? Math.min(legOptions.tolerance, viaLegTolerance) : legOptions.tolerance,
          attempt, leg: legs + 1,
        });
        const at = (leg && leg.position) || (await this.game.position()).position;
        if (!at) { this.#note("leg produced no position", leg); break; }
        legs++;
        const remaining = Math.hypot(at.x - active.x, at.y - active.y);
        trail.push({ x: at.x, y: at.y, z: at.z, attempt, leg: legs,
          distance: Math.hypot(at.x - goal.x, at.y - goal.y),
          need: stage < via.length ? remaining : undefined });
        // Standing on the call the walk came for ends both the leg and the plan
        // it was drawn from: the attempt re-plans from here towards whatever is
        // next, instead of reading "the player is on the pickup" as arrival at
        // the exit. The `break` is the point -- the plan's remaining points
        // belong to the call just made, not to the one after it.
        if (stage < via.length && touchesCall(at, via[stage])) {
          const call = stage + 1;
          const entry = via[stage];
          const pressed = await madeCall(entry);
          this.#note("reached what the walk came for", {
            at, call, of: via.length, classname: entry.classname || null, pressed,
          });
          position = at;
          stalled = 0;
          break;
        }
        // What the leg actually did, measured from the engine's own positions:
        // the ground it covered, and whether it closed on the point it was
        // aimed at. Both are needed, and neither is the same question as "is
        // the player closer to the exit".
        //
        // `moved` is the first of them, because `goto` reports `reached` for a
        // target it is already inside its own tolerance of *without taking a
        // step*. A leg aimed at a point 24 units away comes back
        // `reached, rounds: 0, 0 units covered`, and the walker used to read
        // that as arrival and clear its stall counter on it -- measured, seven
        // consecutive legs like that against (-120,-72,4) from (-99,-84,46),
        // and the attempt was over without the player having moved at all.
        //
        // `advanced` is the second, because a route out of a pocket goes
        // *farther* from the goal before it goes closer. The way out of
        // demo1's dead-end pocket at -427 111 is 100 units of walking away
        // from the exit before the route turns back towards it, and judged by
        // `remaining` alone -- which is what the walker used to do -- every one
        // of those legs is "no progress": two of them abandon the attempt, the
        // re-plan from the same spot draws the same dog-leg, and four
        // consecutive `finish` runs ended there with the attempt budget spent
        // and a valid 35-point route to the exit in the walker's own hand.
        const moved = Math.hypot(at.x - position.x, at.y - position.y);
        const advanced = Math.hypot(position.x - target.x, position.y - target.y) >
          Math.hypot(at.x - target.x, at.y - target.y) + 8;
        const arrived = moved > 8 && Math.hypot(at.x - target.x, at.y - target.y) <= Math.max(48, legOptions.tolerance * 2);
        if (arrived || advanced || remaining < bestDistance - 1) {
          if (remaining < bestDistance) bestDistance = remaining;
          position = at;
          stalled = 0;
          if (stage >= via.length && remaining <= tolerance && Math.abs(at.z - active.z) <= (options.zTolerance || 96)) {
            this.#note("reached the goal");
            return { reached: true, reason: "reached", attempts: attempt, position: at, distance: remaining, trail, log: this.log, crossings: plan.crossings };
          }
          continue;
        }
        // No progress. A leg that produced no movement at all is usually a death
        // rather than a wall: the keys go nowhere while the death camera is up.
        // Hand it back to the attempt loop, which restarts the level.
        const state = await this.game.position();
        if (state && state.dead) {
          this.#note("the player died on this leg");
          break;
        }
        // Work out what is standing there before deciding what to do about it.
        const near = this.brushesNear(at, 128);
        const mover = near.find((brush) => brush.kind === "mover" && brush.distance < 96);
        this.#note("a leg stopped", { target, at, near: near.slice(0, 3).map((b) => b.classname + b.model + "@" + b.distance.toFixed(0)) });
        if (mover && options.useDoors !== false) {
          // A door, a button, a lift: hold use and take another run at it.
          this.#note("opening what is in the way", { classname: mover.classname, model: mover.ref, distance: mover.distance });
          const retry = await this.#tryDoor(target, legOptions);
          const after = (retry && retry.position) || (await this.game.position()).position;
          const afterRemaining = Math.hypot(after.x - active.x, after.y - active.y);
          trail.push({ x: after.x, y: after.y, z: after.z, attempt, leg: legs,
            distance: Math.hypot(after.x - goal.x, after.y - goal.y),
            need: stage < via.length ? afterRemaining : undefined });
          if (afterRemaining < bestDistance - 1) {
            bestDistance = afterRemaining;
            position = after;
            stalled = 0;
            continue;
          }
        }
        stalled++;
        // Nothing to open, and the leg went nowhere. Re-planning from here is
        // not enough on its own, because a follower pressed square against
        // something the plan does not know about draws the same line again from
        // the same spot -- and `+forward` walks that line at the view the leg
        // already had, which is the same wall at the same angle on every round
        // of every attempt. That is the whole of demo1's pocket: the plan's own
        // way out sits 91 units from -427 111, and leg after leg aimed at it
        // covered 0 units there, measured across three traced `finish` runs.
        //
        // So the first stalled leg backs the player *off* the point it was
        // aimed at -- away from it, along the ground, on the bearing it would
        // have to walk to get there -- and the leg after that aims again from
        // somewhere the player has not already been stuck at, so the same plan
        // is not walked into the same wall twice in a row. Measured on the run
        // that argued for it: five back-offs, and the next leg covered 53, 67
        // and 194 units after three of them. The sideways step the attempt
        // already takes is kept for the case where backing off has nowhere to
        // go either: a follower in a corner has to change both where it stands
        // and which way it is looking.
        const away = state && state.position ? (Math.atan2(at.y - target.y, at.x - target.x) * 180 / Math.PI + 360) % 360 : null;
        if (stalled === 1 && away !== null && options.backOff !== false && typeof this.game.face === "function") {
          this.#note("backing off the point that stopped the leg", { bearing: Math.round(away), from: at, target });
          await this.game.face(away, { from: state, tolerance: 8, rounds: 4 });
          await this.game.walk(options.backOffMs === undefined ? 400 : options.backOffMs);
          const back = await this.game.position();
          const landed = back && back.position ? back.position : at;
          trail.push({ x: landed.x, y: landed.y, z: landed.z, attempt, leg: legs,
            distance: Math.hypot(landed.x - goal.x, landed.y - goal.y),
            need: stage < via.length ? Math.hypot(landed.x - active.x, landed.y - active.y) : undefined });
          if (Math.hypot(landed.x - at.x, landed.y - at.y) > 8) {
            this.#note("backed off", { to: landed });
            position = landed;
            stalled = 0;
            continue;
          }
        }
        if (stalled >= 2) {
          this.#note("no progress; planning again from here");
          break;
        }
      }
      position = (await this.game.position()).position || position;
      while (stage < via.length && touchesCall(position, via[stage])) {
        await madeCall(via[stage]);
      }
      const settled = activeGoal();
      const settledDistance = Math.hypot(position.x - settled.x, position.y - settled.y);
      if (stage >= via.length && settledDistance <= tolerance) {
        return { reached: true, reason: "reached", attempts: attempt, position, distance: settledDistance, trail, log: this.log, crossings: plan.crossings };
      }
      if (options.sideStep !== false) {
        // A step sideways, alternating, because a follower that is square
        // against a wall has to change something about where it stands.
        const direction = attempt % 2 === 0 ? "left" : "right";
        this.#note("stepping aside to get a new angle", { direction });
        await this.game.strafe(400, direction);
      }
    }
    const final = await this.game.position();
    position = final && final.position ? final.position : position;
    this.#note("gave up after the attempt budget", { attempts });
    return {
      reached: false,
      reason: "ATTEMPTS",
      attempts,
      // The last thing the engine said, which after a death is where the
      // corpse was -- kept next to `deepest`, which is the furthest the walk
      // actually got, so a caller cannot print one and mean the other.
      position,
      distance: position ? Math.hypot(position.x - goal.x, position.y - goal.y) : null,
      deepest: deepestReading(trail),
      plan: lastPlan,
      blockers: (lastPlan && lastPlan.blockers) || [],
      trail,
      log: this.log,
    };
  }
}

// The walker the CLI and the tests both use: load the map, hand back a follower.
export async function walkerFor(game, mapName, options = {}) {
  const map = await loadMap(mapName, options);
  return new RouteWalker(game, map, options);
}

export default RouteWalker;
