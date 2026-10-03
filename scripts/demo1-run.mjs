#!/usr/bin/env node
// scripts/demo1-run.mjs -- play demo1 with the control layer, and prove it.
//
//   node scripts/demo1-run.mjs plan              what the level says about the way out
//   node scripts/demo1-run.mjs walk X,Y,Z        walk the route to a point, and report
//   node scripts/demo1-run.mjs finish            reset to demo1 and walk to the exit
//
// "finish" is the whole point: it starts a fresh demo1 with cheats off, plans a
// route from the spawn to the exit trigger's volume, follows it with
// control/combat.mjs -- a walker that shoots the soldiers standing on the route
// as it goes, and opens what has to be opened -- and then asks the engine what
// map it is on. `"mapname" is "demo2"` is the proof, and it is the engine's own
// answer, not the script's opinion.
//
// Nothing here uses a cheat. There is no noclip, no god, no give and no
// teleport; the only console commands it sends are `map demo1`, `cheats 0`,
// `mapname`, and the `+use`/`-use` and `+attack`/`-attack` pairs that are the
// use key and the fire button. Fire is what a player does with the level's own
// weapon against the level's own monsters; killing them is the game.

import { QuakeControl } from "../control/bridge.mjs";
import { loadMap } from "../control/route.mjs";
import { RouteWalker } from "../control/walker.mjs";
import { CombatWalker } from "../control/combat.mjs";

const CDP = process.env.QUAKE2_CDP_URL || "http://127.0.0.1:18801";
const game = new QuakeControl({ cdpUrl: CDP, timeoutMs: 20000 });

// A line of the run's report. `value` is optional: a label on its own is a
// heading, and heading that reads "undefined" is worse than no heading at all.
function report(label, value) {
  if (value === undefined) { console.log(label); return; }
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
  const walker = new CombatWalker(game, map);
  const plan = map.path(map.playerStart().position, exit.aim, walker.options);
  report("route plan", plan.points.length ? plan.points.length + " points" : plan.reason);
  if (!plan.points.length) {
    report("  where the plan stopped", plan.reached);
    report("  what the plan says is there", plan.blockers.map((b) => b.classname + " " + b.model + " " + b.why));
  }
  // The walker's own defaults for `maxLegs` and `sideStep` are left alone on
  // purpose. A fighting walker re-decides what to shoot every leg whatever
  // `maxLegs` says -- that is `_legTarget`, not the plan -- and `maxLegs` is
  // what spaces out the *re-plans* and the sideways step that follows each one.
  // A run with it shortened to 3 ended 2,057 units short with the player at
  // -301 110, beside demo1's dead-end pocket at -427 111: three legs per
  // attempt instead of eight means three times as many of the 400 ms sideways
  // steps that end an attempt, and that step is taken across the route.
  const result = await walker.follow(exit.aim, { attempts: 8, tolerance: 96 });
  report("walker reached the exit volume", result.reached);
  report("walker reason", result.reason);
  report("walker stopped at", result.position);
  if (result.combat) {
    report("soldiers in the level", result.combat.enemiesInLevel);
    report("firing legs", result.combat.firingLegs + " (" + result.combat.onTarget + " with the turn landed on the soldier)");
  }
  if (result.distance !== null && result.distance !== undefined) report("short of the exit by", Math.round(result.distance));
  // The engine's positions, not the planner's opinion of them: the closest the
  // player was ever measured to be to the exit, over every attempt the walk
  // made. This is the honest answer to "how far did it get".
  const trail = (result.trail || []).filter((point) => typeof point.distance === "number");
  if (trail.length) {
    const closest = trail.reduce((best, point) => (point.distance < best.distance ? point : best));
    report("furthest position reached", { x: Math.round(closest.x), y: Math.round(closest.y), z: Math.round(closest.z), short: Math.round(closest.distance) });
    report("positions the engine reported", trail.length);
  }
  // And the walker's own last words, which are what explains a run that did not
  // finish: every death it restarted, every leg it re-planned, and what stopped
  // the last one.
  if (result.log && result.log.length) {
    const deaths = result.log.filter((entry) => /is dead/.test(entry.message)).length;
    report("times the level restarted the player", deaths);
    // With the detail, not just the message: "a leg stopped" is the walker
    // saying it did not move, and the detail is what it was standing next to --
    // the difference between a wall, a closed door and a soldier's body.
    report("last walker notes", result.log.slice(-10).map((entry) => entry.message +
      (entry.detail ? " " + JSON.stringify(entry.detail) : "")));
  }
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
  // The trigger comes up before the bridge goes away, whatever happened above.
  // Fire is not a harmless key to leave down: it also leaves the death camera
  // and skips an intermission, so a run cut short must not hand the game a
  // player who is firing at nothing.
  if (game.attacking) await game.attackHold(false).catch(() => {});
  await game.close().catch(() => {});
}
