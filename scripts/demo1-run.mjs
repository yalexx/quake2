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

// What the level itself says a fresh spawn has to go and get before the walk
// out is a fight it can survive.
//
// A level started with `map demo1` hands the player the engine's default
// loadout -- a blaster and nothing else -- and demo1 is defended by 33 monsters
// with a soldier standing 33 units from the route. Nothing is given and nothing
// is invented here: every call below is an entity the level's own author placed,
// at the origin the entity lump names, reached by the planner's own route from
// where the player actually stands. "Walk over a weapon the level put on the
// floor" is what a player does in the first ten seconds of this level.
//
// Only what is genuinely near the spawn is taken. The rule is deliberately
// narrow: the nearest weapon the level offers within REACH units of walking,
// and the ammunition that feeds it. A wider sweep -- every weapon, every armour
// vest, every health box -- would walk the player around the level before the
// walk out even started, and the point of the exercise is the way out.
function supplyCalls(map, from) {
  const WALK = { maxStepUp: 45, maxDrop: 300, maxJump: 160, cell: 24 };
  // How far the player will walk out of the way for a weapon, and how far a
  // candidate has to be to be worth planning a route to at all. The straight
  // line screens the entities; the walk distance decides.
  const REACH = 700;
  const SCREEN = 1000;
  const AMMO_FOR = {
    weapon_supershotgun: "ammo_shells",
    weapon_shotgun: "ammo_shells",
    weapon_machinegun: "ammo_bullets",
    weapon_chaingun: "ammo_bullets",
    weapon_rocketlauncher: "ammo_rockets",
    weapon_grenadelauncher: "ammo_grenades",
    weapon_hyperblaster: "ammo_cells",
    weapon_railgun: "ammo_slugs",
  };
  const near = [];
  for (const point of map.waypoints("*")) {
    if (!point.position) continue;
    const strays = Math.hypot(point.position.x - from.x, point.position.y - from.y);
    if (strays > SCREEN) continue;
    if (!/^weapon_|^ammo_/.test(point.classname)) continue;
    const walk = map.path(from, point.position, WALK);
    if (!walk.points.length || walk.distance > REACH) continue;
    near.push({ classname: point.classname, position: point.position, distance: Math.round(walk.distance) });
  }
  const weapons = near.filter((entry) => /^weapon_/.test(entry.classname)).sort((a, b) => a.distance - b.distance);
  if (!weapons.length) return [];
  const weapon = weapons[0];
  const calls = [{
    classname: weapon.classname, call: "weapon",
    x: weapon.position.x, y: weapon.position.y, z: weapon.position.z,
    walkDistance: weapon.distance,
    tap: null,
    binding: null,
  }];
  const ammo = AMMO_FOR[weapon.classname];
  if (ammo) {
    for (const box of near.filter((entry) => entry.classname === ammo).sort((a, b) => a.distance - b.distance)) {
      calls.push({
        classname: box.classname, call: "ammo",
        x: box.position.x, y: box.position.y, z: box.position.z,
        walkDistance: box.distance,
      });
    }
  }
  // Health and armour boxes are deliberately *not* on this list, and that is a
  // measurement rather than a preference. They look like the answer: the walk
  // does not end on the route, it ends on the player's health, which the fights
  // along demo1's corridor take down about twenty-five points per firing leg,
  // and the level's own boxes sit 91 to 248 units from the route it already
  // walks. Measured, with the five nearest added: the walk reached `-379 40`,
  // 2,053 units short, fired **no shots at all** in five attempts, and spent
  // every one of them walking between boxes. Against the same code without them:
  // `-948 457`, 1,366 units short, 42 firing legs. An errand is not free, and on
  // this level the walk that stops to collect is the walk that never arrives.
  return calls;
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
  // Everything that can be worked out from the level's own archive is worked
  // out *before* the level is started, and that is not tidiness.
  //
  // Planning a route across demo1 takes about eight seconds of this process's
  // time, and the sweep that finds the level's weapons and shells takes about
  // seventeen; the game does not stop while they run. A player left standing at
  // the spawn for that long is a player the level's soldiers can find and kill,
  // and a death before the walk begins is one the walker finds on its first
  // read -- it restarts the level, and a restart through the engine's own
  // autosave puts the player wherever that save left them. Measured, on the two
  // runs that argued for this: the walk's first recorded position was `-456 20`
  // on one and `-72 -1` on the next, 676 and 383 units from the spawn it had
  // just been handed, and the attempts that followed were spent walking back.
  //
  // Nothing below touches the game until `freshDemo1()`, so the level starts
  // with the thinking already done and the walk begins the moment the player is
  // on the spawn.
  const map = await loadMap("demo1");
  const exit = map.exitPoint();
  // The fight is instrumented: every firing leg reads the player's health and
  // armour off the status bar and, when a directory is named, keeps the picture
  // it read them from. Without the series, "the fight got better" is a claim
  // about the shape of a run rather than about the player, and this run has no
  // way to tell one from the other. See control/hud.mjs.
  // The fight's levers, each one a knob so that a run can be made and read back
  // without editing the walker: which weapon to ask the engine for (by the name
  // the engine's own config uses) and how a firing leg moves while the trigger
  // is down. Defaults are the behaviour that was measured before they existed.
  const walker = new CombatWalker(game, map, {
    engage: {
      readHud: true,
      hudCropDir: process.env.QUAKE2_HUD_DIR || null,
      weapon: process.env.QUAKE2_WEAPON || null,
      fireWhile: process.env.QUAKE2_FIRE_WHILE || "advance",
      ...(process.env.QUAKE2_PICKUP_RANGE ? { pickupRange: Number(process.env.QUAKE2_PICKUP_RANGE) } : {}),
    },
  });
  report("fight options", { weapon: walker.engage.weapon, fireWhile: walker.engage.fireWhile, pickupRange: walker.engage.pickupRange });
  const plan = map.path(map.playerStart().position, exit.aim, walker.options);
  report("route plan", plan.points.length ? plan.points.length + " points" : plan.reason);
  // The errands: the level's own weapon and the shells that are near the spawn.
  // See supplyCalls for why nothing else is on the list.
  const calls = process.env.QUAKE2_NO_SUPPLY ? [] : supplyCalls(map, map.playerStart().position);
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
  // How many re-plans the walk gets, and how many deaths it will live through.
  // Both are overridable so that a change to the fight can be measured on a
  // short attempt -- a diagnostic that stops after two deaths still says where
  // the player got to and how the fight went, and it says it in a fraction of
  // the wall clock -- while the proof itself still runs the full budget.
  // Read so that an explicit zero survives. `Number(x) || fallback` throws a
  // zero away because zero is falsy, and zero is the value this knob most needs
  // to be able to say: "do not restart the level at all" is the one-life
  // diagnostic, and quietly turning it into "eight" makes a run that was asked
  // for one life report eight without saying so.
  const askedFor = (name) => {
    const raw = process.env[name];
    if (raw === undefined || raw === "") return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  const attemptBudget = askedFor("QUAKE2_ATTEMPTS");
  const deathBudget = askedFor("QUAKE2_DEATHS");
  const attempts = Math.max(1, attemptBudget === null ? 8 : attemptBudget);
  const deaths = Math.max(0, deathBudget === null ? attempts : deathBudget);
  report("budget", { attempts, deaths });
  // The calls the walk makes before the exit: the level's own weapon and the
  // ammunition for it. `via` is inside the attempt loop, so a death that loses
  // the weapon makes the walk go back for it, which is the whole reason the
  // errand is a list the follower owns rather than calls from out here.
  report("calls before the exit", calls.length ? calls.map((call) =>
    call.call + " " + call.classname + " at " + Math.round(call.x) + " " + Math.round(call.y) + " " + Math.round(call.z) +
    " (" + call.walkDistance + " units' walk)" + (call.tap ? " press " + call.tap : "")) : "none the level offers within reach");
  // Everything the archive can answer has been answered: start the level.
  const fresh = await freshDemo1();
  report("map after reset", fresh.map);
  report("player at", fresh.position);
  report("cheats line", fresh.cheatsAnswer.filter((line) => /cheats/.test(line)));
  if (fresh.map !== "demo1") {
    report("result", "could not start demo1; stopping rather than walking an unknown level");
    process.exitCode = 1;
    return;
  }
  // The key that selects the weapon is the engine's own, read out of the
  // player's own config now that the page is up: a weapon in the pack is not a
  // weapon in hand, and which key the player bound to `use supershotgun` is not
  // something this script may guess. It is one page evaluate, so it costs the
  // walk nothing -- unlike the sweep above, which is why the sweep happened
  // first.
  const armed = calls.find((call) => call.call === "weapon");
  if (armed) {
    const binding = typeof game.binding === "function"
      ? await game.binding("use " + armed.classname.replace(/^weapon_/, ""))
      : { found: false, reason: "NO_BINDING_LOOKUP" };
    armed.tap = binding && binding.key ? binding.key : null;
    armed.binding = binding && binding.binding ? binding.binding : null;
    armed.bindingFound = !!(binding && binding.found);
    armed.bindingReason = binding && !binding.found ? binding.reason : null;
  }
  const unbound = calls.filter((call) => call.call === "weapon" && !call.tap);
  if (unbound.length) report("note", "the config binds no key to " + unbound.map((c) => "use " + c.classname.replace(/^weapon_/, "")).join(", ") + "; the walk relies on the engine's own weapon switch");
  const result = await walker.follow(exit.aim, {
    attempts, deaths, tolerance: 96,
    via: calls,
  });
  report("walker reached the exit volume", result.reached);
  report("walker reason", result.reason);
  // Two different readings, and a run that ends on a death has them in two
  // different places. `position` is the last thing the engine said, and the
  // last thing it says before a restart is where the corpse was; `deepest` is
  // the closest the player was ever *measured* to be. One run on this level
  // ended with them 489 units apart (deepest -951 1023, last read -462 19 -19),
  // so printing one as though it were the other understates the walk.
  report("walker last read at", result.position);
  if (result.deepest) {
    report("deepest reading", { x: Math.round(result.deepest.x), y: Math.round(result.deepest.y), z: Math.round(result.deepest.z),
      short: Math.round(result.deepest.distance), attempt: result.deepest.attempt, leg: result.deepest.leg });
  }
  if (result.deaths !== undefined) report("level restarts the walker lived through", result.deaths);
  const lastRead = result.position;
  const apart = result.deepest && lastRead &&
    Math.hypot(result.deepest.x - lastRead.x, result.deepest.y - lastRead.y) > 1;
  if (apart) {
    report("note", "the last read is not the deepest reading: the run ended with the player " +
      Math.round(Math.hypot(result.deepest.x - lastRead.x, result.deepest.y - lastRead.y)) +
      " units from the furthest point it had reached");
  }
  if (result.combat) {
    report("soldiers in the level", result.combat.enemiesInLevel);
    report("firing legs", result.combat.firingLegs + " (" + result.combat.onTarget + " with the turn landed on the soldier)");
    report("firing legs with a health reading", result.combat.healthReadings);
    report("lowest health the fight took the player to", result.combat.minHealth);
    report("health after the last firing leg", result.combat.lastHealth);
    if (result.combat.weapon) report("weapon the fight asked for", result.combat.weapon);
    if (result.combat.fireModes && result.combat.fireModes.length) {
      report("what each way of firing cost (mode, legs, ground covered, health spent, per leg)");
      for (const row of result.combat.fireModes) {
        report("  " + row.mode.padEnd(8) + " legs " + row.legs + "  covered " + row.covered +
          "  spent " + (row.healthSpent === null ? "?" : row.healthSpent) +
          "  per leg " + (row.spentPerLeg === null ? "?" : row.spentPerLeg) +
          "  readings " + row.healthReadings);
      }
    }
    if (result.combat.onRoutePickups && result.combat.onRoutePickups.length) {
      report("pickups the route ran over", result.combat.onRoutePickups);
    }
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
    // Every one of them, in the order the engine gave them. "Where it stopped"
    // is an argument about a run; this is the run's own record of where it was,
    // leg by leg, and a stall is what a run of readings that do not move looks
    // like. The position is the eye, as the engine reports it (see
    // EYE_ABOVE_FEET in control/walker.mjs); `short` is the ground distance from
    // that reading to the exit's aim point.
    report("positions per leg (attempt, leg, x y z, units short of the exit)");
    for (const point of trail) {
      const leg = point.leg === undefined ? "" : " leg " + point.leg;
      report("  a" + point.attempt + leg + "  " + Math.round(point.x) + " " + Math.round(point.y) + " " + Math.round(point.z) +
        "  short " + Math.round(point.distance) +
        // ...and, on the legs of the walk that were owed a call, how far it was
        // from the thing it was owed. A pickup is taken by touching it, so the
        // number that says whether an errand was run is the distance to the
        // pickup and not the distance to the exit.
        (point.need === undefined ? "" : "  need " + Math.round(point.need)));
    }
  }
  // And the fight's own record, leg by leg: the health the player had left
  // after each firing leg, read off the status bar. This is the measurement
  // that makes "the fight got better" falsifiable, and the soldier each leg was
  // aimed at is next to it because "which one is doing the damage" is the
  // question a health series answers.
  const fights = (result.combat && result.combat.fights) || [];
  if (fights.length) {
    report("per-leg fight record (leg, soldier, aimed, fired, ground covered, health after, armour)");
    for (let index = 0; index < fights.length; index++) {
      const fight = fights[index];
      report("  " + String(index + 1).padStart(2, " ") + "  " + fight.classname + (fight.enemyDistance === undefined ? "" : " d" + fight.enemyDistance) +
        "  aimed " + (fight.aimed ? "yes" : "no") +
        (fight.aimError === null || fight.aimError === undefined ? "" : " (" + fight.aimError + "deg)") +
        "  fired " + (fight.fired ? "yes" : "no") +
        "  covered " + fight.travelled +
        (fight.fireMode && fight.fireMode !== "advance" ? "  " + fight.fireMode : "") +
        (fight.pickupOnRoute ? "  over " + fight.pickupOnRoute : "") +
        // How much of the leg went on turning. It is the number that says
        // whether the leg walked through its turn or stood still for it.
        (fight.turnMs === null || fight.turnMs === undefined ? "" : "  turn " + fight.turnMs + "ms") +
        "  health " + (fight.health === null || fight.health === undefined ? "?" : fight.health) +
        (fight.armour === null || fight.armour === undefined ? "" : "  armour " + fight.armour) +
        // Every number the status bar showed, in the order it showed them:
        // health, armour, and the ammunition of whatever weapon the player is
        // actually holding. That last one is the only evidence on this box of
        // which weapon a picked-up weapon became.
        (fight.barNumbers && fight.barNumbers.length ? "  bar " + fight.barNumbers.join("+") : "") +
        (fight.dead ? "  DIED ON THIS LEG" : "") +
        (fight.hudCrop ? "  " + fight.hudCrop.split("/").pop() : ""));
    }
    const missed = fights.filter((fight) => fight.health === null || fight.health === undefined).length;
    if (missed) report("firing legs with no health reading", missed);
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
  if (game.attacking) {
    if (typeof game.mouseHold === "function") await game.mouseHold("left", false).catch(() => {});
    else await game.attackHold(false).catch(() => {});
  }
  await game.close().catch(() => {});
}
