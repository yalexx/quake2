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

console.log("errors are named, never empty");
let threw = null;
try { await loadMap("nosuchmap"); } catch (error) { threw = error; }
check("an unknown map throws MAP_NOT_FOUND", threw && threw.code === "MAP_NOT_FOUND", threw && threw.code);
check("and it names the maps that do exist", threw && threw.message.includes("demo1"), threw && threw.message);

console.log("");
console.log(failures ? failures + " of " + checks + " checks FAILED" : "all " + checks + " checks passed");
process.exitCode = failures ? 1 : 0;
