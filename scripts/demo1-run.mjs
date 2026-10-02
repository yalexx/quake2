#!/usr/bin/env node
// scripts/demo1-run.mjs -- play demo1 with the control layer, and prove it.
//
//   node scripts/demo1-run.mjs plan              what the level says about the way out
//   node scripts/demo1-run.mjs walk X,Y,Z        walk the route to a point, and report
//   node scripts/demo1-run.mjs finish            reset to demo1 and walk to the exit
//
// "finish" is the whole point: it starts a fresh demo1 with cheats off, plans a
// route from the spawn to the exit trigger's volume, follows it with
// control/walker.mjs -- opening what has to be opened on the way -- and then
// asks the engine what map it is on. `"mapname" is "demo2"` is the proof, and it
// is the engine's own answer, not the script's opinion.
//
// Nothing here uses a cheat. There is no noclip, no god, no give and no
// teleport; the only console commands it sends are `map demo1`, `cheats 0`,
// `mapname` and the `+use`/`-use` pair that is the use key.

import { QuakeControl } from "../control/bridge.mjs";
import { loadMap } from "../control/route.mjs";
import { RouteWalker } from "../control/walker.mjs";

const CDP = process.env.QUAKE2_CDP_URL || "http://127.0.0.1:18801";
const game = new QuakeControl({ cdpUrl: CDP, timeoutMs: 20000 });

function report(label, value) {
  console.log(label + ": " + (typeof value === "string" ? value : JSON.stringify(value)));
}

// The engine's answer to "which map is running". This is the finish line: not a
// position the script believes it reached, but the level the engine itself says
// it loaded. Quake 2 prints it as `"mapname" is "demo2"`.
async function readMapName() {
  const answer = await game.command("mapname", { tail: 12 });
  const line = (answer.output || []).find((entry) => /"mapname" is "/.test(entry));
  const found = line && /"mapname" is "([^"]*)"/.exec(line);
  return { name: found ? found[1] : null, lines: answer.output || [] };
}

async function freshDemo1() {
  const sent = await game.command(["map demo1", "cheats 0"], { tail: 12 });
  await new Promise((resolve) => setTimeout(resolve, 2500));
  const state = await game.position();
  const map = await readMapName();
  return { map: map.name, position: state.position, angles: state.angles, cheatsAnswer: sent.output || [] };
}

async function plan() {
  const map = await loadMap("demo1");
  const start = map.playerStart();
  const exit = map.exitPoint();
  report("map", map.summary().message);
  report("spawn", start.position);
  report("exit target", exit.nextMap + (exit.landmark ? " (landmark " + exit.landmark + ")" : ""));
  report("exit trigger", exit.triggerClassname + " " + exit.triggerModel);
  report("exit volume", exit.triggerVolume && { mins: exit.triggerVolume.mins, maxs: exit.triggerVolume.maxs });
  report("aim", exit.aim);
  report("brush entities (static)", map.models.filter((m) => m.kind === "static").map((m) => m.classname + m.ref));
  report("brush entities (move)", map.barriers().map((b) => b.classname + b.model + " " + b.action));
  const straight = map.path(start.position, exit.aim, {});
  report("route, steps only", straight.points.length ? straight.points.length + " points, " + Math.round(straight.distance) + " units" : straight.reason);
  if (!straight.points.length) {
    report("  where it stopped", straight.reached);
    report("  why", straight.message);
    report("  blockers", straight.blockers);
  }
  const jumping = map.path(start.position, exit.aim, { maxStepUp: 45, maxDrop: 300, maxJump: 160, cell: 24 });
  report("route, with jumps", jumping.points.length ? jumping.points.length + " points, " + Math.round(jumping.distance) + " units" : jumping.reason);
  if (!jumping.points.length) {
    report("  where it stopped", jumping.reached);
    report("  why", jumping.message);
    report("  blockers", jumping.blockers);
  } else {
    report("  crossings", (jumping.crossings || []).map((c) => c.classname + c.model + " " + c.action));
  }
}

async function walk(target) {
  const [x, y, z] = String(target).split(",").map(Number);
  if (![x, y, z].every(Number.isFinite)) throw new Error("walk needs X,Y,Z");
  const map = await loadMap("demo1");
  const walker = new RouteWalker(game, map);
  const before = await game.position();
  report("from", before.position);
  const result = await walker.follow({ x, y, z }, { attempts: 3, tolerance: 64 });
  report("reached", result.reached);
  report("reason", result.reason);
  report("stopped at", result.position);
  report("short by", result.distance === null ? null : Math.round(result.distance));
  if (result.blockers && result.blockers.length) report("blockers", result.blockers.map((b) => b.classname + b.model + "@" + Math.round(b.distance)));
  report("log", result.log.map((entry) => entry.message));
  return result;
}

async function finish() {
  report("starting", "fresh demo1 with cheats 0");
  const fresh = await freshDemo1();
  report("map after reset", fresh.map);
  report("player at", fresh.position);
  report("cheats line", fresh.cheatsAnswer.filter((line) => /cheats/.test(line)));
  if (fresh.map !== "demo1") {
    report("result", "could not start demo1; stopping rather than walking an unknown level");
    process.exitCode = 1;
    return;
  }
  const map = await loadMap("demo1");
  const exit = map.exitPoint();
  const walker = new RouteWalker(game, map);
  const plan = map.path(map.playerStart().position, exit.aim, walker.options);
  report("route plan", plan.points.length ? plan.points.length + " points" : plan.reason);
  if (!plan.points.length) {
    report("  where the plan stopped", plan.reached);
    report("  what the plan says is there", plan.blockers.map((b) => b.classname + " " + b.model + " " + b.why));
  }
  const result = await walker.follow(exit.aim, { attempts: 8, tolerance: 96 });
  report("walker reached the exit volume", result.reached);
  report("walker reason", result.reason);
  report("walker stopped at", result.position);
  if (result.distance !== null && result.distance !== undefined) report("short of the exit by", Math.round(result.distance));
  if (result.explored) {
    report("no route in the level's floor plan, so the walker steered straight at the exit");
    report("  furthest real position", result.position);
    // How far from the spawn the player actually got, measured along the trail
    // the engine reported rather than from anything the planner believes.
    const spawn = map.playerStart().position;
    const furthest = result.trail.reduce((best, point) => Math.max(best, Math.hypot(point.x - spawn.x, point.y - spawn.y)), 0);
    report("  ground covered from the spawn", Math.round(furthest));
  }
  if (result.blockers && result.blockers.length) report("blockers", result.blockers.map((b) => b.classname + b.model + "@" + Math.round(b.distance)));
  // The engine has the last word: it may have loaded demo2 while the walker was
  // still reading its own trail.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = await readMapName();
  report("engine says the map is", after.name);
  report("proof", after.lines.filter((line) => /"mapname" is "/.test(line)));
  report("result", after.name === "demo2" ? "FINISHED -- the engine loaded demo2" : "NOT finished -- the engine is still on " + after.name);
}

const [command, argument] = process.argv.slice(2);
try {
  if (command === "plan") await plan();
  else if (command === "walk") await walk(argument);
  else if (command === "finish") await finish();
  else console.log("usage: node scripts/demo1-run.mjs plan|walk X,Y,Z|finish");
} catch (error) {
  console.error("ERROR " + (error.code ? error.code + ": " : "") + error.message);
  process.exitCode = 1;
} finally {
  await game.close().catch(() => {});
}
