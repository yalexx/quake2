#!/usr/bin/env node
// scripts/route-test.mjs -- the route planner's own behaviour, checked against
// the real archive. No browser, no game: everything here is read out of
// baseq2/pak0.pak, so it runs anywhere the repo is checked out.
//
//   node scripts/route-test.mjs
//
// It exits non-zero on the first failure, and each check prints what it saw, so
// a failure says what changed rather than only that something did.

import { loadMap, listMaps, RouteError } from "../control/route.mjs";
import { RouteWalker, deepestReading } from "../control/walker.mjs";
import { CombatWalker, threats, levelShotReaches, movementKeys, clearWalk } from "../control/combat.mjs";
import { loadDigits, readBar, decodePng } from "../control/hud.mjs";
import { QuakeControl, turnIsBlocked } from "../control/bridge.mjs";
import { bearingTo, shortestTurn, leadPoint, readMonsters, staticMonsters, rankTargets, decide, PLAY_DEFAULTS, MONSTER_MODELS, MONSTER_SOLID } from "../control/loop.mjs";
import fs from "node:fs";

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks++;
  if (condition) {
    console.log("  ok   " + name);
  } else {
    failures++;
    console.log("  FAIL " + name + (detail === undefined ? "" : " -- " + JSON.stringify(detail)));
  }
}

function near(a, b, slack = 1) {
  return a !== null && a !== undefined && Math.abs(a - b) <= slack;
}

console.log("maps in the archive");
const maps = listMaps();
check("demo1 is in the pack", maps.includes("demo1"), maps);

console.log("demo1's brush entities");
const map = await loadMap("demo1");
check("the models lump yields 34 inline models", map.models.length === 34, map.models.length);
const staticBrushes = map.models.filter((m) => m.kind === "static");
const movers = map.models.filter((m) => m.kind === "mover");
check("func_wall and func_explosive are static geometry",
  staticBrushes.map((m) => m.classname).every((c) => /^func_wall$|^func_explosive$/.test(c)),
  staticBrushes.map((m) => m.classname));
check("the four doors, the lift and the fans are movers",
  movers.filter((m) => /^func_door/.test(m.classname)).length === 4 && movers.some((m) => m.classname === "func_train"),
  movers.map((m) => m.classname));
check("triggers are not geometry", map.models.every((m) => !/^trigger_/.test(m.classname) || m.kind === "none"));

console.log("a mover placed by its origin");
const fan = map.models.find((m) => m.classname === "func_rotating");
check("the rotating fan carries an origin", fan && fan.origin.x === 416 && fan.origin.z === -72, fan && fan.origin);
check("its world box is shifted onto that origin", fan && near(fan.mins.x, 328) && near(fan.maxs.z, -72), fan && fan.mins);
check("asking what is at the fan finds it", map.brushesAt(416, 608, -80).some((b) => b.model === fan.ref), map.brushesAt(416, 608, -80));

console.log("static brush geometry is part of the level");
// func_explosive *20 stands in a gap the world tree leaves open; it is a wall
// until it is shot, so the planner has to know it is there.
const wall = map.models.find((m) => m.ref === "*20");
const outside = { x: -40, y: 140, z: 64 }; // in the gap the wall fills
const solid = { x: -120, y: 140, z: 64 }; // the rock the gap runs through
check("the world tree is open where the explosive wall stands",
  (map.worldContentsAt(outside.x, outside.y, outside.z) & 1) === 0, map.worldContentsAt(outside.x, outside.y, outside.z));
check("the level is solid there anyway", map.isSolid(outside.x, outside.y, outside.z));
check("the rock either side of the gap is solid whatever stands in it", map.isSolid(solid.x, solid.y, solid.z));
const wallContents = map.modelContentsAt(wall, wall.centre.x, wall.centre.y, wall.centre.z);
check("the wall's own model says blocking at its centre", (wallContents & (1 | 2 | 0x10000)) !== 0, wallContents);

console.log("the exit trigger volume");
const exit = map.exitPoint();
check("its map is demo2 with landmark base1", exit.nextMap === "demo2" && exit.landmark === "base1", exit.nextMap + "$" + exit.landmark);
check("the aim point is inside the trigger volume", map.insideVolume(exit.triggerVolume, exit.aim));
check("the volume is the trigger_multiple's own box", exit.triggerModel === "*27");
check("the mapper's marker sits outside it", exit.markerInsideTrigger === false);

console.log("path() tells the truth about a route");
const start = map.playerStart().position;
const nearby = { x: -40, y: 264, z: -40 }; // a reachable pocket in the start area
const close = map.path(start, nearby, {});
check("a route inside the start area is found", close.points.length > 0, close.reason);
check("it carries a distance", close.points.length > 0 && close.distance > 0, close.distance);
check("no brush has to be opened for it", (close.crossings || []).length === 0, close.crossings);

console.log("path() names what blocks a route it cannot find");
const blocked = map.path(start, exit.aim, {});
check("spawn to the exit is NO_ROUTE in the static data", blocked.reason === "NO_ROUTE", blocked.reason);
check("it reports where the search stopped", blocked.reached && Number.isFinite(blocked.reached.x), blocked.reached);
check("it names the brushes nearest that point", blocked.blockers.length > 0, blocked.blockers);
check("each blocker says what it is and why it is in the way",
  blocked.blockers.every((b) => b.classname && b.model && b.why && Number.isFinite(b.distance)),
  blocked.blockers.slice(0, 2));
check("the message repeats the blocker names rather than saying only 'no route'",
  blocked.blockers.some((b) => blocked.message.includes(b.classname)), blocked.message);

console.log("jumps are opt-in");
const jumped = map.path(start, exit.aim, { maxJump: 160, maxStepUp: 45, maxDrop: 300 });
check("asking for jumps is accepted and still honest", jumped.points.length > 0 || jumped.reason === "NO_ROUTE", jumped.reason);
check("a route that only walks reports no jump points",
  close.points.every((p) => !p.jump), close.points.filter((p) => p.jump));

console.log("the walker's own helpers");
const walker = new RouteWalker({}, map, {});
check("brushesNear finds the door it is standing at", walker.brushesNear({ x: -1112, y: 1632, z: 16 }, 64).some((b) => b.kind === "mover"));
check("brushesNear finds nothing in open air", walker.brushesNear({ x: 0, y: 240, z: -40 }, 32).length === 0, walker.brushesNear({ x: 0, y: 240, z: -40 }, 32));

console.log("a route that crosses a mover says which one");
// Every mover in demo1 is in the exit room, so a route that passes one is found
// by asking for one there. The cells are sampled rather than enumerated: this
// runs A* once per pair, and a test that takes minutes is a test nobody runs.
const grid16 = map.floorGrid(16, 4);
const exitRoom = [];
for (const [k, floors] of grid16.floors) {
  const [ix, iy] = k.split(",").map(Number);
  const x = grid16.minX + ix * 16, y = grid16.minY + iy * 16;
  if (x >= -2120 && x <= -1090 && y >= 1200 && y <= 1920) for (const z of floors) exitRoom.push({ x, y, z });
}
const sample = [];
const stride = Math.max(1, Math.floor(exitRoom.length / 40));
for (let i = 0; i < exitRoom.length; i += stride) sample.push(exitRoom[i]);

let crossing = null;
let crossingPairs = 0;
for (let i = 0; i < sample.length && !crossing; i++) {
  for (let j = i + 1; j < sample.length && !crossing; j++) {
    crossingPairs++;
    const route = map.path(sample[i], sample[j], { maxStepUp: 45, maxDrop: 300, cell: 16 });
    if (route.points.length && (route.crossings || []).length) crossing = route;
  }
}
check("a route through the exit room crosses a mover", !!crossing, { crossingPairs, sampled: sample.length });
check("and each crossing names the brush and the action",
  !crossing || crossing.crossings.every((c) => c.classname && c.model && c.action && c.centre),
  crossing && crossing.crossings);

console.log("every jump a route takes is inside maxJump");
// maxJump is a distance. A diagonal run of r cells is r * 1.414 cells long, so
// counting cells alone lets a "160 unit" jump reach 226 units at 16-unit cells
// -- further than the option asked for, and further than a run-and-leap carries.
//
// This pair in demo1 is one the archive actually needs, and it is the one that
// shows the mistake: given a 96-unit budget the old cell-counted reach could
// still take a 136-unit jump (6 diagonal cells of 16), and this route has one
// waiting. It is pinned rather than searched for because finding it costs 73 A*
// runs and five minutes; the coordinates are the level's, not the test's.
//
// Two budgets here are tighter than the walker's, and both are load-bearing.
// maxStepUp is 18 -- Quake 2's own STEPSIZE, the height a player walks up -- not
// the walker's 45, which is the height a *jump* clears; and maxDrop is 64, not
// the walker's 300. With either one at the walker's value the floor grid climbs
// or descends this gap a step at a time and the route takes no jump at all (both
// 18/300 and 45/300 measure jumps=[]), so there would be nothing to measure.
const jumpFrom = { x: -2112, y: 1280, z: 192 };
const jumpTo = { x: -1232, y: 1504, z: 280 };
const jumpOptions = { maxStepUp: 18, maxDrop: 64, cell: 16 };
const jumpLegs = (route) => {
  const legs = [];
  for (let at = 1; at < route.points.length; at++) {
    if (!route.points[at].jump) continue;
    legs.push(Math.hypot(route.points[at].x - route.points[at - 1].x, route.points[at].y - route.points[at - 1].y));
  }
  return legs;
};
const withJump = map.path(jumpFrom, jumpTo, { ...jumpOptions, maxJump: 160 });
const jumpLeg = jumpLegs(withJump);
check("a route across demo1's gap uses a jump", jumpLeg.length > 0, { points: withJump.points.length, reason: withJump.reason });
check("and that jump is inside the maxJump asked for", jumpLeg.every((d) => d <= 160), jumpLeg);
const narrow = map.path(jumpFrom, jumpTo, { ...jumpOptions, maxJump: 96 });
const narrowLegs = jumpLegs(narrow);
check("a 96-unit budget takes no jump over 96", narrowLegs.every((d) => d <= 96), { legs: narrowLegs, points: narrow.points.length, reason: narrow.reason });
check("and that budget really does rule a jump out here", narrowLegs.length > 0 && jumpLeg.some((d) => d > 96), { narrow: narrowLegs, asked: jumpLeg });
const narrower = map.path(jumpFrom, jumpTo, { ...jumpOptions, maxJump: 64 });
check("nor does a 64-unit budget", jumpLegs(narrower).every((d) => d <= 64), { legs: jumpLegs(narrower), points: narrower.points.length });
check("because 64 units cannot cross this gap at all", narrower.points.length === 0, { reason: narrower.reason, points: narrower.points.length });

console.log("the walker leaves a level the engine has already left");
// A stub game, so this needs no browser: the engine reports a *different* map
// with the death roll, which is exactly what the intermission camera looks like.
const stub = {
  respawns: [],
  async position() {
    return { probed: true, position: { x: 0, y: 0, z: 20 }, angles: { pitch: 0, yaw: 0, roll: 39 }, map: "demo2", dead: true };
  },
  async respawn(options) { this.respawns.push(options); return { respawned: true, how: "map" }; },
  async goto(point) { return { reached: true, position: point }; },
};
const leaving = new RouteWalker(stub, map, {});
const left = await leaving.follow({ x: -1776, y: 1544, z: 4 }, { attempts: 2 });
check("a walk stops when the engine is on another map", left.reason === "LEVEL_CHANGED", left.reason);
check("and does not restart the level it was walking", stub.respawns.length === 0, stub.respawns);
check("the level it was walking is named", left.level === "demo1" && left.map === "demo2", { level: left.level, map: left.map });

// The other half: dead on the *same* map is a death, and it is restarted -- with
// the level's name handed to respawn so the bridge can apply the same check.
const dying = {
  respawns: [],
  async position() {
    return this.respawns.length
      ? { probed: true, position: { x: 128, y: -319, z: 46 }, angles: { pitch: 0, yaw: 135, roll: 0 }, map: "demo1", dead: false }
      : { probed: true, position: { x: -427, y: 111, z: -1 }, angles: { pitch: 0, yaw: 0, roll: 39 }, map: "demo1", dead: true };
  },
  async respawn(options) { this.respawns.push(options); return { respawned: false, reason: "LEVEL_CHANGED" }; },
  async goto(point) { return { reached: true, position: point }; },
};
const died = new RouteWalker(dying, map, {});
const after = await died.follow({ x: -1776, y: 1544, z: 4 }, { attempts: 1 });
check("a death on the same map is restarted", dying.respawns.length === 1, dying.respawns.length);
check("and the restart names the level it expects", dying.respawns[0] && dying.respawns[0].expectMap === "demo1", dying.respawns[0]);
check("the walk then stops if the level had changed", after.reason === "LEVEL_CHANGED", after.reason);

console.log("the fighting walker");
// Looking one way and walking another is the whole of shooting on the move:
// Quake 2 moves a player along the view, so a soldier to the side of the route
// is only shootable if the walk keeps a strafe key down.
check("looking the way you walk holds forward alone", movementKeys(90, 90).join("") === "w", movementKeys(90, 90));
check("walking a quarter turn left holds the left strafe", movementKeys(0, 90).join("") === "a", movementKeys(0, 90));
check("and a quarter turn right holds the right strafe", movementKeys(90, 0).join("") === "d", movementKeys(90, 0));
check("a diagonal is forward plus the strafe", movementKeys(0, 45).join("") === "wa", movementKeys(0, 45));
check("and the other diagonal is the other strafe", movementKeys(0, -45).join("") === "wd", movementKeys(0, -45));
check("a soldier dead behind is not walked at sideways", movementKeys(0, 180).join("") === "s", movementKeys(0, 180));
check("the turn is read the short way round the compass", movementKeys(350, 10).join("") === "w", movementKeys(350, 10));

// Clear air is not the same as a walkable floor, and demo1's dead-end pocket is
// the proof: the wall that closes it is a brush 16 units thick, so a line check
// that strides in 16-unit steps reports the way clear and walks the player into
// it. clearWalk() strides at 10 and is what keeps a leg from aiming through it.
// (A leg that still ends at -427 111 is a different fault -- the view having
// stopped turning, see the section on `face()` in the README -- and the checks
// under "a leg that covers no ground" below are about that one.)
check("the wall across demo1's pocket is not walkable through",
  !clearWalk(map, { x: -427, y: 111, z: -47 }, { x: -480, y: 24, z: -48 }));
check("but the way the plan actually goes out of it is",
  clearWalk(map, { x: -427, y: 111, z: -47 }, { x: -432, y: 24, z: -40 }));
check("and a soldier standing down the corridor is walkable to",
  clearWalk(map, { x: -696, y: 192, z: -48 }, { x: -672, y: 336, z: -40 }));
check("a line to nowhere is not walkable at all", !clearWalk(map, null, null));

// The corridor route point 12 is (-696,192,-48) of floor, so a player standing
// there has their eye at -2. A level shot leaves the muzzle at that height and
// flies straight, which is what levelShotReaches() answers.
const corridorEye = { x: -696, y: 192, z: -2 };
const corridorSoldier = map.waypoints("enemy").find((e) => Math.round(e.position.x) === -672 && Math.round(e.position.y) === 336);
check("the level's own entity lump has the corridor soldier", !!corridorSoldier, corridorSoldier && corridorSoldier.position);
check("a level shot reaches a soldier on the corridor's own floor",
  levelShotReaches(map, corridorEye, corridorSoldier.position));
check("but not one two storeys up",
  !levelShotReaches(map, corridorEye, { x: -1176, y: 1272, z: 152 }),
  levelShotReaches(map, corridorEye, { x: -1176, y: 1272, z: 152 }));
check("nor through the wall between two rooms",
  !levelShotReaches(map, { x: -288, y: 0, z: -2 }, { x: -856, y: 584, z: -24 }));

const enemies = map.waypoints("enemy");
const onTheWay = threats(map, corridorEye, { bearing: 135, enemies });
check("a soldier standing where the route goes is a target", onTheWay.length > 0, onTheWay.map((t) => t.classname));
// The leader is the cheapest *fight*, not the nearest soldier: walking 30
// degrees off the way forward costs something, and the score is what says so.
check("and the list is ordered by what the fight costs",
  onTheWay.every((t, i) => i === 0 || t.score >= onTheWay[i - 1].score), onTheWay.map((t) => Math.round(t.score)));
check("every target is inside the arc and inside the range",
  onTheWay.every((t) => t.off <= 80 && t.distance <= 1100), onTheWay.map((t) => Math.round(t.distance)));
// Both halves are asserted together on purpose. `every()` on the list behind is
// vacuously true when the list is empty, which is exactly what a broken arc
// filter would NOT produce -- so on its own it is a check that cannot fail. The
// non-empty list from the opposite bearing is what makes it a test.
// Behind the way forward is a reason to leave a soldier alone only while
// leaving it alone is cheap. Out of answering range it is not a target; close
// enough to be shooting the player, it has to be -- measured on a `finish` run,
// the soldiers that killed the player at the deepest point it reached stood 116
// and 82 degrees off the way forward at 58 and 151 units, and the walker
// would not turn for either.
const behindUs = threats(map, corridorEye, { bearing: 315, enemies });
const behindFar = threats(map, corridorEye, { bearing: 315, enemies, answerRange: 0 });
check("a soldier behind the way forward and out of answering range is not one",
  behindFar.length === 0 && onTheWay.length > 0,
  { behind: behindFar.map((t) => Math.round(t.off)), ahead: onTheWay.map((t) => Math.round(t.off)) });
check("but one behind and close enough to shoot back at is a target",
  behindUs.length > 0 && behindUs.every((t) => t.off > 80 && t.distance <= 200),
  behindUs.map((t) => t.classname + "@" + Math.round(t.distance) + " off" + Math.round(t.off)));
check("and the arc still holds for everything further off",
  threats(map, corridorEye, { bearing: 315, enemies, answerRange: 0 }).length === 0 &&
  onTheWay.every((t) => t.off <= 80 && t.distance <= 1100),
  onTheWay.map((t) => Math.round(t.off)));
const skipped = threats(map, corridorEye, { bearing: 135, enemies, skip: () => true });
check("a soldier the caller has given up on is skipped", skipped.length === 0, skipped.length);
const outOfRange = threats(map, corridorEye, { bearing: 135, enemies, engageRange: 40 });
check("and one further away than the range is not a target at all", outOfRange.length === 0, outOfRange.length);

// The seam itself. A level with no monsters in it has to walk exactly as the
// plain walker does -- that is what makes this an addition rather than a
// different walker -- and a level with one on the route has to aim at it.
const bareMap = { isSolid: () => false, waypoints: () => [] };
const bare = new CombatWalker({}, bareMap, {});
const plainPoints = [{ x: 5, y: 6, z: 7 }, { x: 55, y: 6, z: 7 }];
// A walker with no monsters in the level does not walk *identically* to the
// plain one -- every leg of this one follows the plan a few points at a time --
// but what it aims at has to still be a point of the plan, and nothing else.
const noEnemies = bare._legTarget({ x: 0, y: 0, z: 0 }, plainPoints);
check("with no enemies the leg target is a point of the plan",
  plainPoints.some((p) => p.x === noEnemies.x && p.y === noEnemies.y && p.z === noEnemies.z), noEnemies);

const fightPoints = map.path(map.playerStart().position, map.exitPoint().aim, { maxStepUp: 45, maxDrop: 300, maxJump: 160, cell: 24 }).points;
const fighter = new CombatWalker({}, map, {});
const aimed = fighter._legTarget(corridorEye, fightPoints);
check("with a soldier on the route the leg aims at the soldier", !!(aimed && aimed.enemy), aimed);
check("and it still carries the route point it displaced", !!(aimed && aimed.route && aimed.route.x !== undefined), aimed && aimed.route);
check("the aim is level with the player's own eye", Math.abs(aimed.z - corridorEye.z) < 1, aimed.z);
check("the soldier is counted against its own budget", fighter.engagements.size === 1, fighter.engagements.size);

// Three faults of the same shape -- a leg that covers 0 units -- each measured
// on a traced `finish` run, and none of them a wall.
console.log("a leg that covers no ground");

// The chord between two route points is not the floor between them: the route's
// own step from -120 -72 4 to -144 -72 -48 drops 52 units in the 24 it takes,
// and sampling the chord halfway down puts the sample inside the floor it is
// supposed to be standing on -- which rejected every point past the drop and
// collapsed every leg to the nearest next one. These two points are that step.
check("clearWalk follows the floor down the route's own 52-unit step",
  clearWalk(map, { x: -120, y: -72, z: 4 }, { x: -144, y: -72, z: -48 }));
// ...and the longer chord from the start room that was rejected with it.
check("and down the longer chord from the start room to the west corridor",
  clearWalk(map, { x: -99, y: -84, z: 0 }, { x: -216, y: -72, z: -48 }));

// The planner snaps a route's start onto the nearest floor, so a walk stopped
// 111 units short of the plan's first point still reads as "nearest to point 1".
// Aiming only *after* that point aims at point 2, through the 16-unit func_wall
// -- which is what the traced runs did from -427 111, twice an attempt.
const pocketOptions = { maxStepUp: 45, maxDrop: 300, maxJump: 160, maxJumpDown: 300, cell: 24, step: 4 };
const pocketPlan = map.path({ x: -429, y: 10, z: 6 }, map.exitPoint().aim, pocketOptions);
const pocketWalker = new CombatWalker({}, map, {});
const pocketTarget = pocketWalker._legTarget({ x: -427, y: 111, z: -1 }, pocketPlan.points);
check("a walk stopped in demo1's pocket aims at the plan's own way out",
  Math.hypot(pocketTarget.x + 456, pocketTarget.y - 24) < 8, pocketTarget);
check("and not at the point beyond it, through the 16-unit wall",
  Math.hypot(pocketTarget.x + 480, pocketTarget.y - 24) > 8, pocketTarget);

// A player who never moves must not be walked for a whole attempt. The stub's
// goto() answers `reached` and leaves the position alone, which is exactly what
// the bridge does for a target it is already inside its own tolerance of -- and
// the old walker read that as arrival, cleared its stall counter, and spent all
// eight legs of the attempt standing on the same 24 units.
const pinned = {
  gotos: 0,
  async position() { return { probed: true, position: { x: -427, y: 111, z: -1 }, angles: { pitch: 0, yaw: 135, roll: 0 }, map: "demo1", dead: false }; },
  async goto(point) { this.gotos++; return { reached: true, reason: "reached", target: point, position: { x: -427, y: 111, z: -1 }, rounds: 0, travelled: 0, trail: [] }; },
  async strafe() { return { key: "a", requestedMs: 400, heldMs: 400 }; },
  async face() { return { facing: true, target: 0, yaw: 0, error: 0, rounds: 1 }; },
  async walk() { return { key: "w", requestedMs: 400, heldMs: 400 }; },
  async walkKeys() { return { keys: ["w"], requestedMs: 400, heldMs: 400 }; },
  async attackHold() { return { held: true }; },
  async useHold() { return { held: true }; },
};
const stander = new CombatWalker(pinned, map, {});
const standerResult = await stander.follow(map.exitPoint().aim, { attempts: 3, maxLegs: 8, backOff: false });
check("a leg that does not move the player is not progress", standerResult.reached === false, standerResult.reason);
check("so the walk re-plans instead of spending the attempt standing still", pinned.gotos < 12, pinned.gotos);
check("and it says so rather than reporting an arrival", standerResult.log.some((entry) => /no progress/.test(entry.message)), standerResult.log.map((e) => e.message));

// A firing leg is one decision and one trigger press, and the press has to
// cover the whole of it. It did not: the turn onto the soldier and the
// status-bar read both ran with the trigger *up*, and those two are most of a
// leg's wall clock -- measured on the live game, the turn 415 ms, the walk
// 538 ms, `hudShot` 732 ms and `readHealth` 294 ms, so 1.4 s of every 2.2 s leg
// was the player standing still in the open being shot at with nothing fired
// back. (Those are the numbers that shaped this and they are left as measured;
// the per-call cost under them was cut at the source afterwards -- one CDP
// connection for the whole run, and the status bar read in the page -- which
// took `hudShot` from 391 ms to 80 ms on this box.) This pins the shape of the
// fix, with no browser: the trigger goes down first, the turn and the
// status-bar read are taken inside that press, and the trigger comes up last.
console.log("a firing leg holds the trigger for the whole of it");
const legCalls = [];
const fightStub = {
  async position() { legCalls.push("position"); return { probed: true, position: { x: -672, y: 300, z: 14 }, angles: { pitch: 0, yaw: 0, roll: 0 }, map: "demo1", dead: false }; },
  async mouseHold(button, down) { legCalls.push("fire:" + down); return { held: !!down, button, buttons: down ? 1 : 0 }; },
  async face(bearing, options) { legCalls.push("face:" + ((options && options.turn) || "auto")); return { facing: true, target: bearing, yaw: bearing, error: 0.01, rounds: 2, method: "mouse" }; },
  async key(key, down) { legCalls.push("key:" + key + (down ? "+" : "-")); return { key, down }; },
  async evaluate(expression) {
    if (/getBoundingClientRect/.test(expression)) { legCalls.push("hud:frame"); return JSON.stringify({ width: 1366, height: 768, left: 0, top: 728, shownLeft: 0, shownTop: -728, viewport: 1366 }); }
    legCalls.push("hud:style");
    return /setAttribute/.test(expression) ? "restored" : "display:block";
  },
  async screenshot() { legCalls.push("hud:capture"); return fs.readFileSync(new URL("../favicon.png", import.meta.url)); },
};
const legWalker = new CombatWalker(fightStub, map, { engage: { readHud: true } });
await legWalker._leg({
  x: -672, y: 336, z: 14,
  enemy: { index: 0, classname: "monster_soldier", position: { x: -672, y: 336, z: -16 }, distance: 46 },
  route: { x: -696, y: 192, z: -48 },
}, { attempt: 1, leg: 1 });
const firstDown = legCalls.findIndex((call) => /^key:.+\+$/.test(call));
const capture = legCalls.indexOf("hud:capture");
const fireDown = legCalls.indexOf("fire:true");
const fireUp = legCalls.indexOf("fire:false");
// The movement keys that are down at a point in the trace, replayed from the
// key events themselves. This is what "the player is walking" means -- a set
// that is non-empty -- and it is stronger than counting presses and releases,
// which a swap of one key for another moves around without changing.
const heldAt = (index) => {
  const held = new Set();
  for (const call of legCalls.slice(0, index)) {
    const match = /^key:(.+)([+-])$/.exec(call);
    if (!match) continue;
    if (match[2] === "+") held.add(match[1]);
    else held.delete(match[1]);
  }
  return held;
};
check("the trigger goes down before the turn and before any movement key",
  fireDown > 0 && fireDown < legCalls.indexOf("face:mouse") && fireDown < firstDown, legCalls);
check("the turn onto the soldier is taken with the mouse",
  legCalls.indexOf("face:mouse") > fireDown && legCalls.indexOf("face:keys") === -1, legCalls);
// The walk starts *before* the turn, not after it. A leg used to take its aim
// with nothing held, so every firing leg began with the player standing still
// in the open with the trigger down -- the one posture this level's own
// measurements say kills (100 health and no armour is a corpse after six
// seconds of standing still in demo1's corridor). The keys for the view the
// player *has* go down first and the turn is taken in motion.
check("the walk starts before the turn, not after it",
  firstDown > fireDown && firstDown < legCalls.indexOf("face:mouse"), legCalls);
// ...and they are then swapped for the ones the view the aim actually left
// behind wants, because Quake 2 moves a player along their view and a leg that
// walked on the requested bearing after the turn landed somewhere else would
// walk off the route.
check("and they are swapped for the ones the aim's own view wants",
  legCalls.slice(legCalls.indexOf("face:mouse"), capture).some((call) => /^key:.+\+$/.test(call)), legCalls);
check("the status bar is photographed while the player is still walking",
  capture > firstDown && heldAt(capture).size > 0, { atCapture: [...heldAt(capture)], trace: legCalls });
check("and no movement key is still down when the leg ends",
  heldAt(legCalls.length).size === 0, { atEnd: [...heldAt(legCalls.length)], trace: legCalls });
check("and still firing", capture < fireUp, legCalls);
check("nothing comes up between the read and the trigger except the walk's own keys",
  fireUp > capture && legCalls.slice(capture + 1, fireUp).every((call) => /^key:.+-$/.test(call) || call === "hud:style"), legCalls);
const legRecord = legWalker.fights[0];
check("the leg's own record says which way it turned", legRecord.aimMethod === "mouse", { aimMethod: legRecord.aimMethod });
check("and how close the turn landed, to a hundredth of a degree",
  legRecord.aimError === 0.01, { aimError: legRecord.aimError });
check("a leg that fired says so", legRecord.fired === true, { fired: legRecord.fired });

// ...and a leg that a key press throws inside still lifts every key it put down.
// A press the bridge throws on can leave the write half-done -- the engine takes
// the key and the caller is answered with an error anyway -- so a key recorded
// as held only *after* its press returns is a key the release never lifts, and
// the player walks into a wall for the rest of the run. Measured on a stub whose
// `key()` throws on the way down, the release-first order left both of a firing
// leg's movement keys held when the leg ended.
console.log("a firing leg lifts its keys even when a press throws");
const throwingHeld = new Set();
const throwingStub = {
  async position() { return { probed: true, position: { x: -672, y: 300, z: 14 }, angles: { pitch: 0, yaw: 0, roll: 0 }, map: "demo1", dead: false }; },
  async mouseHold(button, down) { return { held: !!down, button, buttons: down ? 1 : 0 }; },
  async face(bearing) { return { facing: true, target: bearing, yaw: bearing, error: 0.01, rounds: 2, method: "mouse" }; },
  async key(key, down) {
    if (down) { throwingHeld.add(key); throw new Error("the press was taken and the caller was refused"); }
    throwingHeld.delete(key);
    return { key, down };
  },
};
const throwingWalker = new CombatWalker(throwingStub, map, {});
await throwingWalker._leg({
  x: -672, y: 336, z: 14,
  enemy: { index: 0, classname: "monster_soldier", position: { x: -672, y: 336, z: -16 }, distance: 46 },
  route: { x: -696, y: 192, z: -48 },
}, { attempt: 1, leg: 1 });
check("no movement key is left down by a press that threw", throwingHeld.size === 0, [...throwingHeld]);

// A failed aim is retried, and the retry has to measure again rather than
// re-run the first attempt's arithmetic. `face()` skips its opening probe when
// it is handed `from`, and `from` here is the position read *before* the first
// attempt turned the player -- so passing it back aims the second attempt at
// the error the first one has already spent. Measured on a live `finish` run's
// leg record: residuals of 10 to 30 degrees, and one of 109, after first
// attempts that had already turned most of the way.
console.log("a failed aim is retried against the view the player actually has");
const retryCalls = [];
const retryStub = {
  // The stub's player carries the yaw the turns left behind, because that is
  // what the engine does and the walk's keys are computed from it. A stub that
  // reported yaw 0 whatever `face()` returned would answer the question below
  // with a view the player never had.
  yaw: 0,
  async position() { return { probed: true, position: { x: -672, y: 300, z: 14 }, angles: { pitch: 0, yaw: this.yaw, roll: 0 }, map: "demo1", dead: false }; },
  async mouseHold(button, down) { return { held: !!down, button, buttons: down ? 1 : 0 }; },
  async face(bearing, options) {
    retryCalls.push({ turn: (options && options.turn) || "auto", hasFrom: !!(options && options.from) });
    // The first attempt gets most of a 29-degree miss back and still fails; the
    // retry ends somewhere else entirely.
    if (retryCalls.length === 1) { this.yaw = 25; return { facing: false, target: bearing, yaw: 25, error: 29.7, rounds: 4, reason: "NOT_CONVERGED", method: "mouse" }; }
    this.yaw = 200;
    return { facing: false, target: bearing, yaw: 200, error: 12.5, rounds: 2, reason: "NOT_CONVERGED", method: "keys" };
  },
  async key(key, down) { return { key, down }; },
  async evaluate() { return "1"; },
  async screenshot() { return fs.readFileSync(new URL("../favicon.png", import.meta.url)); },
};
const retryWalker = new CombatWalker(retryStub, map, { engage: { readHud: false } });
await retryWalker._leg({
  x: -672, y: 336, z: 14,
  enemy: { index: 0, classname: "monster_soldier", position: { x: -672, y: 336, z: -16 }, distance: 46 },
  route: { x: -696, y: 192, z: -48 },
}, { attempt: 1, leg: 1 });
check("the first aim is given the view the leg already read", retryCalls[0] && retryCalls[0].hasFrom === true, retryCalls);
check("a miss is retried the bridge's own way", retryCalls.length === 2 && retryCalls[1].turn === "auto", retryCalls);
check("and the retry measures again instead of reusing the spent view", retryCalls[1].hasFrom === false, retryCalls);
const retryRecord = retryWalker.fights[0];
check("the leg's record is the retry's answer, not the first attempt's",
  retryRecord.aimError === 12.5 && retryRecord.aimMethod === "keys" && retryRecord.aimed === false, retryRecord);
// The walk is walked on the yaw the aim left behind. Taken from the first
// attempt it would be 25, and the keys for the route at 25 are not the keys at
// 200 -- so this is what says the leg did not walk off on a spent view.
const walkBearing = ((Math.atan2(192 - 300, -696 + 672) * (180 / Math.PI)) + 360) % 360;
check("the walk's keys are computed from the view the retry left behind",
  JSON.stringify(retryRecord.keys) === JSON.stringify(movementKeys(200, walkBearing)) &&
  JSON.stringify(movementKeys(200, walkBearing)) !== JSON.stringify(movementKeys(25, walkBearing)),
  { keys: retryRecord.keys, at200: movementKeys(200, walkBearing), at25: movementKeys(25, walkBearing) });

// A level restart is not a plan that failed. This stub's player is dead on
// every read except the one right after a restart -- which is the shape of a
// `finish` run on demo1, where six and seven of eight attempts went on restarts
// and the walk was over in the corridor with its plan unspent.
const dyingStub = {
  respawns: 0,
  alive: 1,
  async position() {
    if (this.alive) { this.alive = 0; return { probed: true, position: { x: 128, y: -319, z: 46 }, angles: { pitch: 0, yaw: 135, roll: 0 }, map: "demo1", dead: false }; }
    return { probed: true, position: { x: 128, y: -319, z: 46 }, angles: { pitch: 0, yaw: 0, roll: 39 }, map: "demo1", dead: true };
  },
  async respawn() { this.respawns++; this.alive = 1; return { respawned: true, how: "map" }; },
  async goto(point) { return { reached: true, reason: "reached", target: point, position: { x: 128, y: -319, z: 46 }, rounds: 0, travelled: 0, trail: [] }; },
  async strafe() { return { key: "a", requestedMs: 400, heldMs: 400 }; },
  async face() { return { facing: true, target: 0, yaw: 0, error: 0, rounds: 1 }; },
  async walk() { return { key: "w", requestedMs: 400, heldMs: 400 }; },
  async walkKeys() { return { keys: ["w"], requestedMs: 400, heldMs: 400 }; },
  async attackHold() { return { held: true }; },
  async useHold() { return { held: true }; },
};
const restarter = new CombatWalker(dyingStub, map, {});
const restartResult = await restarter.follow(map.exitPoint().aim, { attempts: 2, deaths: 3, backOff: false });
check("more restarts than attempts are lived through", dyingStub.respawns === 3, { respawns: dyingStub.respawns, attempts: 2 });
check("and the walk stops on its own restart budget, not on its attempts",
  restartResult.reason === "DEATHS", restartResult.reason);

// The weapon a fighting walker asks the engine for is per *life*, not per
// attempt. A death restarts the level and hands the player the level's own
// starting loadout, and the walker does not spend an attempt on that restart
// (`attempt--` in follow) -- so the same attempt number comes round again on a
// spawn that no longer carries the weapon. Keyed on the attempt alone, every
// life after the first was fought with the blaster while the report said
// shotgun: measured on this stub, one ask across four lives.
console.log("the weapon a fighting walker asks the engine for");
{
  const enemy = map.waypoints("enemy").filter((e) => e.classname === "monster_soldier")
    .sort((a, b) => Math.hypot(a.position.x + 856, a.position.y - 240) - Math.hypot(b.position.x + 856, b.position.y - 240))[0];
  // On the soldier's own floor: its origin is 24 above its feet and the
  // player's eye is 46 above its own, so the eye is 22 above that origin --
  // inside the soldier's box, which is what a level shot needs.
  const standing = { x: enemy.position.x + 150, y: enemy.position.y, z: enemy.position.z + 22 };
  const fightStub = {
    asked: 0,
    async position() { return { probed: true, position: standing, angles: { pitch: 0, yaw: 0, roll: 0 }, map: "demo1", dead: false }; },
    async selectWeapon(name) { this.asked++; return { selected: true, weapon: name, method: "key", key: "3" }; },
    async face() { return { facing: true, target: 0, yaw: 0, error: 0, rounds: 1 }; },
    async key(key, down) { return { held: !!down, key }; },
    async mouseHold() { return { held: true }; },
    async attackHold() { return { held: true }; },
    async walkKeys(keys, ms) { return { keys, requestedMs: ms, heldMs: ms }; },
  };
  const armed = new CombatWalker(fightStub, map, { engage: { weapon: "Super Shotgun", readHud: false } });
  const enemyTarget = { classname: "monster_soldier", position: enemy.position, distance: 150 };
  const target = { x: standing.x, y: standing.y, z: standing.z, enemy: enemyTarget, route: { x: standing.x, y: standing.y, z: standing.z } };
  // Twice at the *same* attempt number, which is what a death really looks
  // like: the walker does not spend an attempt on a restart (`attempt--` in
  // follow), so the attempt the player died on is the attempt it comes back on.
  const legOptions = { attempt: 3, leg: 1, tolerance: 32, engageStepMs: 20, maxRounds: 1 };
  await armed._leg(target, legOptions);
  check("a life asks the engine for its weapon", fightStub.asked === 1, fightStub.asked);
  armed.restarts++;
  await armed._leg(target, legOptions);
  check("and the life after a restart asks again, at the attempt the player died on",
    fightStub.asked === 2, { asked: fightStub.asked, attempt: legOptions.attempt, restarts: armed.restarts });
}

// The same question asked the other way, through the walk's own loop rather
// than one leg called by hand: a stub whose player really dies gives up its
// lives through `follow`, and every one of them is a life the engine has to be
// asked about again.
{
  const enemy = map.waypoints("enemy").filter((e) => e.classname === "monster_soldier")
    .sort((a, b) => Math.hypot(a.position.x + 856, a.position.y - 240) - Math.hypot(b.position.x + 856, b.position.y - 240))[0];
  const standing = { x: enemy.position.x + 150, y: enemy.position.y, z: enemy.position.z + 22 };
  const fightStub = {
    asked: 0, dead: false, keys: 0, respawns: 0,
    async position() { return { probed: true, position: standing, angles: { pitch: 0, yaw: 0, roll: this.dead ? 39 : 0 }, map: "demo1", dead: this.dead }; },
    async respawn() { this.respawns++; this.dead = false; return { respawned: true, how: "fire", position: standing }; },
    async selectWeapon(name) { this.asked++; return { selected: true, weapon: name, method: "key", key: "3" }; },
    async face() { return { facing: true, yaw: 0, error: 0, rounds: 1 }; },
    async key(key, down) { this.keys++; if (this.keys > 4) this.dead = true; return { held: !!down, key }; },
    async mouseHold() { return { held: true }; },
    async attackHold() { return { held: true }; },
    async useHold() { return { held: true }; },
    async goto(point) { return { reached: true, reason: "reached", target: point, position: standing, rounds: 1, travelled: 10, trail: [] }; },
    async strafe() { return { key: "a", requestedMs: 400, heldMs: 400 }; },
    async walk() { return { key: "w", requestedMs: 400, heldMs: 400 }; },
    async walkKeys() { return { keys: ["w"], requestedMs: 400, heldMs: 400 }; },
  };
  const armed = new CombatWalker(fightStub, map, { engage: { weapon: "Super Shotgun", readHud: false, maxEngagements: 20 } });
  // Four attempts, not more: the stub's player is dead by the third, and every
  // attempt is a full A* over demo1's grid, which is the slowest thing in this
  // file.
  const armedResult = await armed.follow(map.exitPoint().aim, { attempts: 4, deaths: 2, tolerance: 96, maxLegs: 2 });
  check("the walk fought, died and was put back on the spawn",
    armed.restarts >= 1 && armedResult.reason !== "NO_POSITION",
    { lives: armed.restarts + 1, reason: armedResult.reason, asks: fightStub.asked });
  check("and asked the engine for its weapon once in every life it fought",
    fightStub.asked === armed.restarts + 1, { lives: armed.restarts + 1, asks: fightStub.asked });
}

// A missed respawn is not the end of the walk, and this is the run that said
// so: a `finish` run ended on a single `NOT_RESPAWNED` at attempt 3 of 8 with
// the player 1,802 units short, four attempts unspent. One press of fire is
// enough in a clean experiment -- measured live: a click, 2.5 s, roll -1.50 to
// 0.00, alive -- and evidently not always enough under fire on a live level.
console.log("a missed respawn does not end the walk");
const flakyStub = {
  respawns: 0,
  alive: false,
  async position() {
    return { probed: true, position: { x: 128, y: -319, z: 46 }, angles: { pitch: 0, yaw: 135, roll: this.alive ? 0 : 39 }, map: "demo1", dead: !this.alive };
  },
  async respawn() {
    this.respawns++;
    if (this.respawns === 1) return { respawned: false, reason: "NOT_RESPAWNED", how: "fire" };
    this.alive = true;
    return { respawned: true, how: "fire" };
  },
  async goto(point) { return { reached: true, reason: "reached", target: point, position: { x: 128, y: -319, z: 46 }, rounds: 0, travelled: 0, trail: [] }; },
  async strafe() { return { key: "a", requestedMs: 400, heldMs: 400 }; },
  async face() { return { facing: true, target: 0, yaw: 0, error: 0, rounds: 1 }; },
  async walk() { return { key: "w", requestedMs: 400, heldMs: 400 }; },
  async walkKeys() { return { keys: ["w"], requestedMs: 400, heldMs: 400 }; },
  async attackHold() { return { held: true }; },
  async useHold() { return { held: true }; },
};
const flakyResult = await new RouteWalker(flakyStub, map, {}).follow(map.exitPoint().aim, { attempts: 2, deaths: 1, backOff: false });
check("a respawn that comes back NOT_RESPAWNED is pressed again", flakyStub.respawns === 2, flakyStub.respawns);
check("and the walk does not end on the one miss", flakyResult.reason !== "DEAD", flakyResult.reason);

// The other end of it: a player the level will not give back at all is a
// restart budget that runs out -- the honest ending -- and not a walk that stops
// on the first refusal with the budget unspent.
const stubbornStub = {
  respawns: 0,
  mapRestarts: 0,
  async position() { return { probed: true, position: { x: -427, y: 111, z: -1 }, angles: { pitch: 0, yaw: 0, roll: 39 }, map: "demo1", dead: true }; },
  async respawn(options = {}) {
    this.respawns++;
    if (options.how === "map") this.mapRestarts++;
    return { respawned: false, reason: "NOT_RESPAWNED", how: options.how || "fire" };
  },
  async goto(point) { return { reached: true, reason: "reached", target: point, position: { x: -427, y: 111, z: -1 }, rounds: 0, travelled: 0, trail: [] }; },
  async strafe() { return { key: "a", requestedMs: 400, heldMs: 400 }; },
  async face() { return { facing: true, target: 0, yaw: 0, error: 0, rounds: 1 }; },
  async walk() { return { key: "w", requestedMs: 400, heldMs: 400 }; },
  async walkKeys() { return { keys: ["w"], requestedMs: 400, heldMs: 400 }; },
  async attackHold() { return { held: true }; },
  async useHold() { return { held: true }; },
};
const stubbornResult = await new RouteWalker(stubbornStub, map, {}).follow(map.exitPoint().aim, { attempts: 2, deaths: 3, backOff: false });
check("a player that will not come back ends on the restart budget, not on one refusal",
  stubbornResult.reason === "DEATHS", stubbornResult.reason);
check("with three presses of fire spent on each of the three restarts it was allowed",
  stubbornStub.respawns === 12, { respawns: stubbornStub.respawns, deaths: 3 });
// ...and the fourth, once per death, is the engine's own restart by name --
// `map demo1`, the command a player's death runs for them. A level that will
// not hand the player back to the fire button is still a level this walker is
// standing in, and giving up on it there is what ended four traced runs on
// their first death with seven restarts unspent.
check("and one restart by name per death as the fire button's fallback",
  stubbornStub.mapRestarts === 3, stubbornStub.mapRestarts);

// The furthest reading is a different reading from the last one, and on a run
// that ends in a death they are hundreds of units apart. The walker's `position`
// is the last thing the engine said -- before a restart, where the corpse was --
// so the two are kept in separate fields and this pins that down.
console.log("the furthest reading is kept apart from the last one");
const trailWithACorpse = [
  { x: 128, y: -319, z: 46, attempt: 1, distance: 2664 },
  { x: -951, y: 1023, z: -13, attempt: 7, leg: 3, distance: 976 },
  { x: -462, y: 19, z: -19, attempt: 8, distance: 2032 },
];
const deepest = deepestReading(trailWithACorpse);
check("deepest is the closest reading, not the last",
  deepest && near(deepest.x, -951) && near(deepest.y, 1023) && near(deepest.distance, 976), deepest);
check("and it says which attempt and leg took it there",
  deepest && deepest.attempt === 7 && deepest.leg === 3, deepest);
check("a trail with nothing in it has no deepest reading", deepestReading([]) === null, deepestReading([]));

// The status bar. `position()` cannot report health -- the engine prints none
// -- so the fight is measured off the HUD, and this is the reader checked
// against the archive it reads from: a bar painted out of the level's own
// digit pictures, read back. No browser is involved.
console.log("the status bar's numbers are readable");
const digitGlyphs = loadDigits();
check("each digit picture is the 16x24 the engine blits", digitGlyphs.num.every((g) => g.width === 16 && g.height === 24),
  digitGlyphs.num.map((g) => g.width + "x" + g.height));
check("and every digit of the two families has ink in it",
  [...digitGlyphs.num, ...digitGlyphs.anum].every((g) => g.mask.some((v) => v === 1)),
  [...digitGlyphs.num, ...digitGlyphs.anum].map((g) => g.mask.reduce((a, b) => a + b, 0)));

// Paint a status bar: the digits at 16-pixel advance on a background that is
// not flat, because the one the HUD really sits on is a lit wall.
function paintBar(text, options = {}) {
  const width = options.width || 220;
  const height = options.height || 40;
  const base = options.background === undefined ? 70 : options.background;
  const ink = options.ink === undefined ? 200 : options.ink;
  // The ink's colour is what tells a health number from an armour one (the
  // engine's `num_*` pictures are grey and its `anum_*` pictures are red); the
  // screen carries that difference through, so the painted bar does too.
  const rgb = options.family === "anum" ? [200, 120, 60] : [200, 200, 170];
  const lum = new Float32Array(width * height);
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const value = options.noise === false ? base : base + ((x * 7 + y * 13) % 25) - 12;
      lum[y * width + x] = value;
      const at = (y * width + x) * 4;
      rgba[at] = value;
      rgba[at + 1] = value;
      rgba[at + 2] = value;
      rgba[at + 3] = 255;
    }
  }
  // Where the number starts. Q2 right-aligns a number in its field, so the
  // field's own reading is checked by painting one where the engine draws it:
  // the field's right edge less one 16-wide cell per digit. See the check for it
  // below.
  let ox = options.offsetX === undefined ? 20 : options.offsetX;
  // ...and where it sits vertically. A real status bar draws its digits in the
  // canvas's bottom 24 rows, which is the row the field's own reading looks at
  // (see `field` in control/hud.mjs), so a bar painted at 0 has its number above
  // the row that read is about.
  const oy = options.offsetY === undefined ? 8 : options.offsetY;
  for (const character of text) {
    const glyph = digitGlyphs[options.family || "num"][Number(character)];
    for (let y = 0; y < glyph.height; y++) {
      for (let x = 0; x < glyph.width; x++) {
        if (!glyph.mask[y * glyph.width + x]) continue;
        const px = ox + x;
        const py = oy + y;
        if (px >= width || py >= height) continue;
        lum[py * width + px] = ink;
        const at = (py * width + px) * 4;
        rgba[at] = rgb[0];
        rgba[at + 1] = rgb[1];
        rgba[at + 2] = rgb[2];
      }
    }
    ox += 16;
  }
  return { lum, rgba, width, height };
}
function readPainted(text, options = {}) {
  const bar = paintBar(text, options);
  const status = readBar(bar.lum, bar.width, bar.height, { searchBottom: bar.height - 1, rgba: bar.rgba });
  return { status, leftmost: status.numbers[0] || null };
}

// Every digit of the font gets read at least once, and "2" and "6" get a
// number of their own: they are the ones this module's own note calls close
// cousins of "0", so a reading that cannot tell them apart is the failure the
// note is warning about.
for (const value of ["100", "43", "7", "0", "88", "19", "155", "62", "296", "267890"]) {
  const read = readPainted(value);
  check("a painted " + value + " reads back as " + value, read.leftmost && read.leftmost.value === Number(value),
    read.status.numbers.map((n) => n.value));
}
// Not a threshold: the same number on a dark wall and on a lit one.
const dark = readPainted("63", { background: 60, ink: 150 });
const lit = readPainted("63", { background: 150, ink: 235 });
check("a number on a dark background reads the same as one on a lit background",
  dark.leftmost && lit.leftmost && dark.leftmost.value === 63 && lit.leftmost.value === 63,
  { dark: dark.status.numbers.map((n) => n.value), lit: lit.status.numbers.map((n) => n.value) });
// Armour is blitted from the other family, and the reading says which it is.
const armourBar = paintBar("35", { family: "anum" });
const armourStatus = readBar(armourBar.lum, armourBar.width, armourBar.height, { searchBottom: armourBar.height - 1, rgba: armourBar.rgba });
check("an armour number is read as armour, not as health",
  armourStatus.numbers[0] && armourStatus.numbers[0].value === 35 && armourStatus.numbers[0].family === "anum",
  armourStatus.numbers.map((n) => n.value + ":" + n.family));
check("and a health number is read as health",
  readPainted("100").leftmost.family === "num", readPainted("100").leftmost.family);

// The number in the health *field*, read where the field is.
//
// A real status bar puts the health number right-aligned on a fixed column and
// the level's own health icon (a bright cross) three units to the right of it,
// and the general scan's "most confident cell first" can anchor on the icon and
// grow a number across the digits -- measured on this box, on two strips of the
// same legible 100 a second apart (`hud-probe` in the run's evidence): one read
// 100 and the other found only a `0` that ends on 557, so the player's health
// came back as nothing at all. Both readings are taken here: the field's own
// read has to find the 100 in the field, and a painted bar whose number is
// right-aligned there is what that is checked against.
const fieldEdge = Math.round(1366 * (573 / 1366));
const fieldBar = paintBar("100", { width: 1366, offsetY: 16, offsetX: fieldEdge - 3 * 16 });
const fieldStatus = readBar(fieldBar.lum, fieldBar.width, fieldBar.height, { searchBottom: fieldBar.height - 1, rgba: fieldBar.rgba, healthFieldRight: 573 / 1366 });
check("the health field is read from the field the engine draws it in",
  fieldStatus.field && fieldStatus.field.value === 100, fieldStatus.field && fieldStatus.field.value);
check("...and a number that is not in the field is not reported as being in it",
  (() => {
    const elsewhere = paintBar("100", { width: 1366, offsetX: 20 });
    const read = readBar(elsewhere.lum, elsewhere.width, elsewhere.height, { searchBottom: elsewhere.height - 1, rgba: elsewhere.rgba, healthFieldRight: 573 / 1366 });
    return !read.field || read.field.value !== 100;
  })(), "a bar with its number at the far left has nothing in the health field");

// The reader's other half is the decoder, and it had no check at all: every
// case above hands `readBar` a luminance plane, so the PNG chunk walk, the
// IDAT inflate and the per-row filter reconstruction -- the part production
// actually runs on a screenshot -- were never exercised. `favicon.png` is a
// real 64x64 8-bit RGB PNG in the repo, which is the shape CDP's
// `Page.captureScreenshot` emits (colour type 2, no alpha, not interlaced).
const favicon = decodePng(fs.readFileSync(new URL("../favicon.png", import.meta.url)));
check("a real PNG decodes to the size its IHDR declares",
  favicon.width === 64 && favicon.height === 64, [favicon.width, favicon.height]);
check("an RGB picture with no alpha channel comes back fully opaque",
  favicon.data.length === 64 * 64 * 4 && favicon.data[3] === 255 && favicon.data[favicon.data.length - 1] === 255,
  favicon.data.length);
check("and the pixels are the picture's, not one flat fill",
  new Set(Array.from({ length: 64 }, (_, x) => favicon.data[x * 4])).size > 1,
  [...new Set(Array.from({ length: 64 }, (_, x) => favicon.data[x * 4]))].slice(0, 4));

// A turn that could not be taken is not evidence about the method that could
// not take it. This is the fault the named blocker of the round before this one
// was: the death camera holds the view, so a miss while the player is dead says
// nothing about the mouse or the keys -- but three of them retired a method for
// the rest of the run, and both methods could be retired one death apart, after
// which `face()` answered NO_TURN without sending anything at all and the walk
// could only push forward at whatever bearing it happened to have. The stub
// below is a player who is dead and cannot be turned; the mouse is the method
// the fighting walker asks for by name (see combat.mjs `aimTurn`).
console.log("a turn that could not be taken does not retire the method that could not take it");
check("the engine's own states that take the keyboard off the game are the ones that block a turn",
  turnIsBlocked({ dead: true }) && turnIsBlocked({ inGame: false }) && turnIsBlocked({ paused: true }) &&
  !turnIsBlocked({ dead: false, inGame: true, paused: false }) && !turnIsBlocked(null),
  [turnIsBlocked({ dead: true }), turnIsBlocked({ inGame: false }), turnIsBlocked({ paused: true }), turnIsBlocked({ inGame: true })]);

class DeadPlayer extends QuakeControl {
  constructor(state) {
    super({ cdpUrl: "http://127.0.0.1:1", timeoutMs: 1000 });
    this.state = state;
    this.moves = 0;
  }
  async position() { return this.state; }
  async mouseMove(dx) {
    this.moves++;
    // The death camera holds the view: the turn is applied and changes nothing.
    if (!this.state.dead) {
      this.state = { ...this.state, angles: { ...this.state.angles, yaw: this.state.angles.yaw - dx * 0.05 } };
    }
    return { dx };
  }
}
const corpse = new DeadPlayer({ probed: true, position: { x: 0, y: 0, z: 0 }, angles: { pitch: 0, yaw: 0, roll: 40 }, dead: true, inGame: true, paused: false, keyDestName: "game" });
const corpseAim = await corpse.face(90, { tolerance: 2, rounds: 4, turn: "mouse" });
check("a dead player's turns are still sent", corpse.moves === 4, corpse.moves);
check("and the aim is reported as not taken rather than as taken badly",
  corpseAim.facing === false && corpseAim.reason === "NOT_CONVERGED" && corpseAim.method === "mouse", corpseAim.reason);
check("the mouse is not retired by four misses the death camera caused",
  corpse.turnCalibration.mouseWorks === null || corpse.turnCalibration.mouseWorks === undefined ||
  corpse.turnCalibration.mouseWorks === true, corpse.turnCalibration.mouseWorks);
// ...and the proof that "not retired" means something: the same bridge, with the
// player alive again and a mouse that turns, still turns them.
corpse.state = { probed: true, position: { x: 0, y: 0, z: 0 }, angles: { pitch: 0, yaw: 0, roll: 0 }, dead: false, inGame: true, paused: false, keyDestName: "game" };
const revivedAim = await corpse.face(90, { tolerance: 2, rounds: 6, turn: "mouse" });
check("the same bridge turns a live player after living through a death",
  revivedAim.facing === true && Math.abs(revivedAim.error) <= 2, { facing: revivedAim.facing, error: revivedAim.error, rounds: revivedAim.rounds });

// The other half: when the player *is* in a state to be turned and the method
// the caller asked for achieves nothing twice in a row, `face()` tries the
// other one inside the same call. The mouse here is applied and changes the
// yaw by nothing, which is what a live player whose mouse has stopped turning
// them looks like. The keys cannot be sent without a game -- this stub has none
// -- so what the check reads is that the mouse was abandoned after exactly two
// blank turns and the call went to the keys instead of spending all six rounds
// on the same dead turn.
console.log("a method that cannot turn a live player is abandoned inside the call, not between calls");
const stubborn = new DeadPlayer({ probed: true, position: { x: 0, y: 0, z: 0 }, angles: { pitch: 0, yaw: 0, roll: 0 }, dead: false, inGame: true, paused: false, keyDestName: "game" });
stubborn.mouseMove = async function (dx) { this.moves++; return { dx }; };
let stubbornThrew = null;
try { await stubborn.face(90, { tolerance: 2, rounds: 6, turn: "mouse" }); } catch (error) { stubbornThrew = error; }
check("the dead mouse gets two rounds before the keys are tried",
  stubborn.moves === 2 && stubbornThrew !== null, { mouseTurnsSent: stubborn.moves, then: stubbornThrew && stubbornThrew.name });

// ---------------------------------------------------------------------------
// The play loop's own arithmetic and decisions.
//
// Everything the loop decides is decided by a pure function of one reading --
// control/loop.mjs's `decide()` takes a percept and returns a mode, a bearing
// and a trigger -- so the whole state machine can be pinned here, without a
// browser and without a game. What the loop does with the answer (send a turn,
// hold a key, pull a trigger) is the part that needs a level.
console.log("");
console.log("the play loop's compass matches the fight's");
check("bearingTo and combat.mjs's own compass agree",
  Math.round(bearingTo({ x: 0, y: 0 }, { x: 10, y: 0 })) === 0 &&
  Math.round(bearingTo({ x: 0, y: 0 }, { x: 0, y: 10 })) === 90 &&
  Math.round(bearingTo({ x: 0, y: 0 }, { x: -10, y: 0 })) === 180, {
    east: bearingTo({ x: 0, y: 0 }, { x: 10, y: 0 }), north: bearingTo({ x: 0, y: 0 }, { x: 0, y: 10 }),
  });
check("shortestTurn takes the short way round",
  shortestTurn(350) === -10 && shortestTurn(-350) === 10 && shortestTurn(190) === -170,
  { a: shortestTurn(350), b: shortestTurn(-350), c: shortestTurn(190) });

console.log("the lead is the bolt's travel, and it is bounded");
const still = leadPoint({ x: 0, y: 0, z: 0 }, { x: 300, y: 0, z: 0 }, null, { boltSpeed: 1000 });
check("a target standing still is aimed at where it stands",
  Math.round(still.x) === 300 && Math.round(still.y) === 0, still);
// 100 units a second across the line, a bolt that covers 1000 a second, a gap
// of 300: the bolt takes 0.3 s and the target moves 30.
const walking = leadPoint({ x: 0, y: 0, z: 0 }, { x: 300, y: 0, z: 0 }, { x: 0, y: 100, z: 0 }, { boltSpeed: 1000 });
check("a walking target is led by its own speed over the bolt's flight",
  Math.round(walking.y) > 25 && Math.round(walking.y) < 40, { y: Math.round(walking.y) });
const wild = leadPoint({ x: 0, y: 0, z: 0 }, { x: 300, y: 0, z: 0 }, { x: 0, y: 100000, z: 0 }, { boltSpeed: 1000, maxLead: 96 });
check("a bad velocity reading cannot throw the aim across the room",
  Math.abs(wild.y - 0) <= 96 + 1, { y: Math.round(wild.y) });

console.log("what is a monster is decided by the entity, not by the map");
const entities = [
  { number: 1, position: { x: 0, y: 0, z: 0 }, modelindex: 255, solid: 8290 },
  { number: 7, position: { x: 400, y: 200, z: -32 }, modelindex: MONSTER_MODELS[0], solid: MONSTER_SOLID },
  { number: 8, position: { x: 300, y: -100, z: -64 }, modelindex: MONSTER_MODELS[1], solid: MONSTER_SOLID },
  { number: 11, position: { x: -158, y: 1424, z: -128 }, modelindex: 46, solid: 0 },
  { number: 12, position: { x: 0, y: 0, z: 0 }, modelindex: 31, solid: 31 },
];
const live = readMonsters(entities);
check("a monster model with a monster's box is a monster", live.length === 2 && live.every((m) => m.source === "live-memory"), live.map((m) => m.number));
check("an item and a brush model are not", live.every((m) => m.modelindex !== 46 && m.modelindex !== 31));
// The bolt carries the same model index as a soldier on this build -- that is
// the whole reason the box is part of the test.
const withBolt = readMonsters([...entities, { number: 99, position: { x: 100, y: 100, z: 40 }, modelindex: MONSTER_MODELS[0], solid: 16 }]);
check("the bolt that shares a monster's model index is not a monster", withBolt.length === 2, withBolt.map((m) => m.number));
// The fallback the loop takes when the live read stops agreeing gives every
// monster `number: null`, and the loop keys its per-monster record on the
// number. What makes that safe is that each of these also carries its own
// `index`, which is what the loop keys on instead -- so this is the property
// that fix depends on, and it is checked rather than assumed.
const statics = staticMonsters(map);
check("the static fallback gives every monster an index of its own, so none is keyed on the same null twice",
  statics.length > 0 && new Set(statics.map((m) => m.index)).size === statics.length &&
  statics.every((m) => m.number === null && m.source === "map-entity-lump"),
  { monsters: statics.length, distinctIndexes: new Set(statics.map((m) => m.index)).size });

console.log("the target ranking is distance and off-course, and the close override");
const from = { x: 0, y: 0, z: 0 };
const crowd = [
  { number: 1, position: { x: 300, y: 0, z: 0 }, modelindex: MONSTER_MODELS[0], solid: MONSTER_SOLID },
  { number: 2, position: { x: 0, y: 300, z: 0 }, modelindex: MONSTER_MODELS[0], solid: MONSTER_SOLID },
  { number: 3, position: { x: 900, y: 0, z: 0 }, modelindex: MONSTER_MODELS[0], solid: MONSTER_SOLID },
];
const ahead = rankTargets(crowd, from, { heading: 0 });
check("a soldier on the way forward beats one to the side",
  ahead[0].number === 1 && ahead[0].off === 0, ahead.map((t) => t.number + "@" + Math.round(t.off)));
check("nothing beyond engageRange is a target at all",
  rankTargets(crowd, from, { heading: 0, engageRange: 400 }).every((t) => t.distance <= 400));
// The override: inside answerRange a soldier is answered whatever angle it
// stands at, because it can shoot the player from where it stands.
// Behind the player is past the arc, which is what answerRange overrides.
const behind = [{ number: 4, position: { x: -300, y: 0, z: 0 }, modelindex: MONSTER_MODELS[0], solid: MONSTER_SOLID }];
check("a soldier behind the walk is a target inside answerRange and not outside it",
  rankTargets(behind, from, { heading: 0, answerRange: 400 }).some((t) => t.number === 4) &&
  !rankTargets(behind, from, { heading: 0, answerRange: 100 }).some((t) => t.number === 4),
  { inside: rankTargets(behind, from, { heading: 0, answerRange: 400 }).length, outside: rankTargets(behind, from, { heading: 0, answerRange: 100 }).length });

console.log("the state machine takes its decisions from one reading");
const base = { dead: false, health: 100, target: null, targetClear: true, routeBearing: 45, routeDistance: 300, offRoute: 5, arrived: false, recover: null, retreatBearing: 225 };
check("nothing to shoot: walk the route", decide(base).mode === "advance" && decide(base).move === 45, decide(base));
check("the way forward is also where the view goes when nothing is in range", decide(base).aim === 45, decide(base).aim);
const armed = { ...base, target: { number: 7, bearing: 50, distance: 300, off: 5 } };
check("a reachable monster is engaged, and it is what the view holds", decide(armed).mode === "engage" && decide(armed).aim === 50 && decide(armed).fire === true, decide(armed));
check("a monster whose line is blocked is not fired at", decide({ ...armed, targetClear: false }).fire === false, decide({ ...armed, targetClear: false }));
check("the walk still goes on while the trigger is down", decide(armed).move === 45, decide(armed).move);
check("hurt, with something shooting: back out, still firing",
  decide({ ...armed, health: PLAY_DEFAULTS.lowHealth - 1 }).mode === "retreat" &&
  decide({ ...armed, health: PLAY_DEFAULTS.lowHealth - 1 }).move === 225 &&
  decide({ ...armed, health: PLAY_DEFAULTS.lowHealth - 1 }).fire === true, decide({ ...armed, health: 20 }));
check("healthy, the same reading engages", decide({ ...armed, health: 100 }).mode === "engage");
check("a corpse is not a target and not a reason to stand still",
  decide({ ...base, target: null }).mode === "advance");
check("the death camera outranks everything", decide({ ...armed, dead: true }).mode === "dead" && decide({ ...armed, dead: true }).fire === false);
check("standing in the exit volume stops the loop", decide({ ...base, arrived: true }).mode === "arrived");
check("a walk that has stopped is recovered, not advanced",
  decide({ ...base, recover: { bearing: 90, aim: 90, fire: true, reason: "STUCK_BUTTON" } }).mode === "recover" &&
  decide({ ...base, recover: { bearing: 90, aim: 90, fire: true, reason: "STUCK_BUTTON" } }).aim === 90);
check("no reading at all is not a reason to fire", decide(null).fire === false);

console.log("errors are named, never empty");
let threw = null;
try { await loadMap("nosuchmap"); } catch (error) { threw = error; }
check("an unknown map throws MAP_NOT_FOUND", threw && threw.code === "MAP_NOT_FOUND", threw && threw.code);
check("and it names the maps that do exist", threw && threw.message.includes("demo1"), threw && threw.message);

console.log("");
console.log(failures ? failures + " of " + checks + " checks FAILED" : "all " + checks + " checks passed");
process.exitCode = failures ? 1 : 0;
