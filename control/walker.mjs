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
//   * a leg that stops anywhere else gets the route *re-planned from where the
//     player actually is*. The first route was drawn from the spawn; a route
//     drawn from a position 300 units into the level sees rooms the first one
//     did not, and this is also how a follower recovers from a drift the grid
//     route did not intend.
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
    let attempt = 0;
    let bestDistance = Infinity;
    let position = null;
    let lastPlan = null;

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
        const back = await this.game.respawn({ expectMap: this.levelName });
        this.#note(back.respawned ? "back in the level" : "could not get back into the level", { how: back.how, reason: back.reason });
        if (back.reason === "LEVEL_CHANGED") {
          return { reached: false, reason: "LEVEL_CHANGED", map: back.map, level: this.levelName, attempts: attempt, position: back.position, trail, log: this.log };
        }
        const restarted = await this.game.position();
        if (!restarted || !restarted.position || restarted.dead) {
          return { reached: false, reason: "DEAD", attempts: attempt, position: restarted && restarted.position, trail, log: this.log };
        }
        current = restarted;
      }
      position = current.position;
      const distance = Math.hypot(position.x - goal.x, position.y - goal.y);
      trail.push({ x: position.x, y: position.y, z: position.z, attempt, distance });
      if (distance <= tolerance && Math.abs(position.z - goal.z) <= (options.zTolerance || 96)) {
        this.#note("reached the goal");
        return { reached: true, reason: "reached", attempts: attempt, position, distance, trail, log: this.log, crossings: lastPlan ? lastPlan.crossings : undefined };
      }

      const plan = this.plan(position, goal);
      lastPlan = plan;
      if (!plan.points.length) {
        this.#note("no route from here", { reason: plan.reason, closest: plan.closest, blockers: plan.blockers });
        // The level's own floor plan does not connect these two points. That is
        // the answer to "is there a route", but it is not an answer to "how far
        // does a player get" -- a grid says a wall is a wall, and the only thing
        // that knows whether the player can actually walk it is the player. So
        // unless the caller said not to, the walker steers straight at the goal
        // and reports the furthest position it really reached, which is the
        // honest measure of how much of the level is playable and *where* it
        // stops.
        if (options.explore !== false) {
          const explored = await this.#explore(goal, options, trail);
          return {
            reached: false,
            reason: plan.reason,
            message: plan.message,
            attempts: attempt,
            position: explored.position,
            distance: explored.distance,
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
        const leg = await this._leg(target, legOptions);
        const at = (leg && leg.position) || (await this.game.position()).position;
        if (!at) { this.#note("leg produced no position", leg); break; }
        legs++;
        const remaining = Math.hypot(at.x - goal.x, at.y - goal.y);
        trail.push({ x: at.x, y: at.y, z: at.z, attempt, leg: legs, distance: remaining });
        const arrived = Math.hypot(at.x - target.x, at.y - target.y) <= Math.max(48, legOptions.tolerance * 2);
        if (arrived || remaining < bestDistance - 1) {
          if (remaining < bestDistance) bestDistance = remaining;
          position = at;
          stalled = 0;
          if (remaining <= tolerance && Math.abs(at.z - goal.z) <= (options.zTolerance || 96)) {
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
          const afterRemaining = Math.hypot(after.x - goal.x, after.y - goal.y);
          trail.push({ x: after.x, y: after.y, z: after.z, attempt, leg: legs, distance: afterRemaining });
          if (afterRemaining < bestDistance - 1) {
            bestDistance = afterRemaining;
            position = after;
            stalled = 0;
            continue;
          }
        }
        stalled++;
        if (stalled >= 2) {
          this.#note("no progress; planning again from here");
          break;
        }
      }
      position = (await this.game.position()).position || position;
      if (Math.hypot(position.x - goal.x, position.y - goal.y) <= tolerance) {
        return { reached: true, reason: "reached", attempts: attempt, position, distance: Math.hypot(position.x - goal.x, position.y - goal.y), trail, log: this.log, crossings: plan.crossings };
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
      position,
      distance: position ? Math.hypot(position.x - goal.x, position.y - goal.y) : null,
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
