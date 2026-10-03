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
import { RouteWalker } from "../control/walker.mjs";
import { CombatWalker, threats, levelShotReaches, movementKeys, clearWalk } from "../control/combat.mjs";

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
const behindUs = threats(map, corridorEye, { bearing: 315, enemies });
check("a soldier behind the way forward is not one",
  behindUs.length === 0 && onTheWay.length > 0,
  { behind: behindUs.map((t) => Math.round(t.off)), ahead: onTheWay.map((t) => Math.round(t.off)) });
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

console.log("errors are named, never empty");
let threw = null;
try { await loadMap("nosuchmap"); } catch (error) { threw = error; }
check("an unknown map throws MAP_NOT_FOUND", threw && threw.code === "MAP_NOT_FOUND", threw && threw.code);
check("and it names the maps that do exist", threw && threw.message.includes("demo1"), threw && threw.message);

console.log("");
console.log(failures ? failures + " of " + checks + " checks FAILED" : "all " + checks + " checks passed");
process.exitCode = failures ? 1 : 0;
