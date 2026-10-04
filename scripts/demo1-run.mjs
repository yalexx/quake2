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
import { PlayLoop } from "../control/loop.mjs";
import { fastRequest, enterFastMode, leaveFastMode, readCvars, FAST_FLAG, FAST_BANNER, FAST_TIMESCALE_CHOICES } from "../control/fast.mjs";

const CDP = process.env.QUAKE2_CDP_URL || "http://127.0.0.1:18801";
const game = new QuakeControl({ cdpUrl: CDP, timeoutMs: 20000 });

// Iteration mode, as the caller asked for it on the command line or the
// environment. Read once, at the top, so the flag means the same thing for the
// whole run. See control/fast.mjs for what it does and why it is a cheat.
const FAST = fastRequest(process.env, process.argv.slice(2));
// What `enterFastMode()` changed, kept so the `finally` can put it all back.
let fastState = null;

// A line of the run's report. `value` is optional: a label on its own is a
// heading, and heading that reads "undefined" is worse than no heading at all.
function report(label, value) {
  if (value === undefined) { console.log(label); return; }
  console.log(label + ": " + (typeof value === "string" ? value : JSON.stringify(value)));
}

// A budget knob read from the environment. Read so that an explicit zero
// survives: `Number(x) || fallback` throws a zero away because zero is falsy,
// and zero is the value this knob most needs to be able to say -- "do not
// restart the level at all" is the one-life diagnostic, and quietly turning it
// into the default makes a run that was asked for one life report eight without
// saying so. An absent or unreadable knob is null, and the caller picks the
// default.
function askedFor(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
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
// How many times the reset is asked for before the run gives up on it.
//
// One send is not a start on this box, and it is not the level's fault. The
// console drops a keystroke now and then -- `map demo1` has arrived as `ap
// demo1` ("Unknown command") and as `mo1` -- and the engine boots into its own
// attract demo, whose `mapname` is `q2demo1.dm2`, so a run that trusted one
// send reported "map after reset: q2demo1.dm2" and stopped before walking a
// step. `map demo1` is idempotent, so the answer is to ask again and then ask
// the engine what level it is really on, rather than to believe the send.
const RESET_TRIES = 6;

async function freshDemo1() {
  let sent = null;
  let map = null;
  for (let tries = 1; tries <= RESET_TRIES; tries++) {
    sent = await game.command(["map demo1", "cheats 0"], { tail: 12 });
    // The level takes a moment to come up, and a reading taken inside that
    // moment names the level the engine is leaving, not the one it is loading.
    await new Promise((resolve) => setTimeout(resolve, tries === 1 ? 2500 : 2000));
    map = await readMapName();
    if (map.name === "demo1") break;
  }
  const state = await game.position();
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
      // Reading the status bar costs a screenshot and an image decode inside
      // every firing leg, with the trigger down. `QUAKE2_READ_HUD=0` turns it
      // off, which is the lever for "does photographing the health cost the
      // fight?": the health series is the only thing that reading buys, and a
      // run that does not finish has nothing to spend it on.
      readHud: process.env.QUAKE2_READ_HUD !== "0",
      hudCropDir: process.env.QUAKE2_HUD_DIR || null,
      weapon: process.env.QUAKE2_WEAPON || null,
      fireWhile: process.env.QUAKE2_FIRE_WHILE || "advance",
      ...(process.env.QUAKE2_PICKUP_RANGE ? { pickupRange: Number(process.env.QUAKE2_PICKUP_RANGE) } : {}),
      // How many pieces a firing leg's step is walked in, re-aimed at the leg's
      // own route point between them (see CombatWalker). 1 is the behaviour
      // every run before this one was measured with.
      ...(process.env.QUAKE2_STEP_ROUNDS ? { stepRounds: Number(process.env.QUAKE2_STEP_ROUNDS) } : {}),
      // How far to one side of the plan a leg may look for ground fewer
      // soldiers can shoot (see CombatWalker #coverLane). 0 is the behaviour
      // every run before this one was measured with.
      ...(process.env.QUAKE2_COVER_LANE ? { coverLane: Number(process.env.QUAKE2_COVER_LANE) } : {}),
      // How far off the way forward a soldier may stand and still be answered,
      // whatever its distance (see CombatWalker _legTarget). Unset is the
      // targeting every run before this one was measured with.
      ...(process.env.QUAKE2_FORWARD_ARC ? { forwardArc: Number(process.env.QUAKE2_FORWARD_ARC) } : {}),
      // The range inside which a soldier is not traded with at all (see
      // CombatWalker _legTarget). Unset is the targeting every run before this
      // one was measured with.
      ...(process.env.QUAKE2_AVOID_RANGE ? { avoidRange: Number(process.env.QUAKE2_AVOID_RANGE) } : {}),
    },
  });
  // The three levers this line adds are reported with the rest, so a finished
  // run says which targeting and which lane search it was actually fought with.
  report("fight options", { weapon: walker.engage.weapon, fireWhile: walker.engage.fireWhile, pickupRange: walker.engage.pickupRange, coverLane: walker.engage.coverLane, forwardArc: walker.engage.forwardArc, avoidRange: walker.engage.avoidRange });
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
  // `askedFor` is the module's own (see the top of this file), which reads an
  // explicit zero as zero rather than throwing it away.
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
  report("walker reached the exit volume", result.reached);
  report("walker reason", result.reason);
  // The one reason that is not a failure. `reached` is false because the walk
  // never stood in the exit volume and watched itself arrive -- the engine had
  // already loaded the next level by the time anything was read again -- so the
  // reason is what tells "the level ended" apart from "the walk gave up".
  if (result.reason === "LEVEL_CHANGED") {
    report("the engine changed level under the walk", (result.level || "?") + " -> " + (result.map || "?"));
  }
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
    // What the plan was *routed* over, rather than what a leg happened to pass:
    // a health or armour item beside a step of the route is inserted into the
    // plan as a waypoint of its own (see CombatWalker.snapPickups), and this is
    // the list of insertions. "The walk tops up on the way" is a claim about the
    // plan, and a claim about a plan is one the plan can be asked to prove.
    if (result.combat.pickupDetours && result.combat.pickupDetours.length) {
      report("top-ups the plan was routed over (item, at, how far off the line)");
      for (const detour of result.combat.pickupDetours) {
        report("  " + detour.classname + "  " + Math.round(detour.x) + " " + Math.round(detour.y) + " " + Math.round(detour.z) +
          "  " + detour.offRoute + " off the route line");
      }
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
        (fight.aimError === null || fight.aimError === undefined ? "" : " (" + fight.aimError + "deg" + (fight.aimMethod ? " " + fight.aimMethod : "") + ")") +
        "  fired " + (fight.fired ? "yes" : "no") +
        "  covered " + fight.travelled +
        (fight.holdMs === undefined ? "" : "  held " + fight.holdMs + "ms") +
        (fight.offCourseDegrees === undefined ? "" : "  off-course " + fight.offCourseDegrees + "deg") +
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
        // Only when the engine was not the one listening: a leg fought with the
        // console or the menu on screen is a leg that could not have walked or
        // turned however good the plan was, and it should be visible in the
        // record rather than inferred from a leg that covers nothing.
        (fight.inGame === false ? "  ENGINE HAD NO KEYBOARD (" + fight.keyDest + ", paused " + fight.paused + ")" : "") +
        (fight.hudCrop ? "  " + fight.hudCrop.split("/").pop() : ""));
    }
    const missed = fights.filter((fight) => fight.health === null || fight.health === undefined).length;
    if (missed) report("firing legs with no health reading", missed);
    // The same fault counted rather than listed: legs the engine's own state
    // says could not have moved anything, and legs whose turn never landed.
    const noKeyboard = fights.filter((fight) => fight.inGame === false).length;
    if (noKeyboard) report("firing legs the engine had taken the keyboard off the game for", noKeyboard + " of " + fights.length);
    const missedAim = fights.filter((fight) => fight.aimed === false).length;
    report("firing legs the turn did not land on", missedAim + " of " + fights.length);
    // The leg's own clock, because "the leg was standing in the open" is an
    // argument about time and this is the time: the trigger is down for the
    // whole of `holdMs`, and the walking is only part of it.
    const held = fights.map((fight) => fight.holdMs).filter((value) => typeof value === "number");
    if (held.length) {
      report("firing legs held the trigger for", {
        totalMs: held.reduce((sum, value) => sum + value, 0),
        medianMs: held.slice().sort((a, b) => a - b)[Math.floor(held.length / 2)],
        maxMs: Math.max(...held),
      });
      const covered = fights.reduce((sum, fight) => sum + (fight.travelled || 0), 0);
      const totalMs = held.reduce((sum, value) => sum + value, 0);
      if (totalMs > 0) report("ground covered per second with the trigger down", Math.round(covered / (totalMs / 1000)));
    }
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

// Play the level with the reactive loop instead of the leg script.
//
// `finish` above walks the route one leg at a time: each leg picks a soldier
// once, sets the bearing once, and holds the trigger from the top of the leg to
// the bottom. This does the same job at 12 Hz -- perceive, decide, aim, verify,
// every tick -- and aims at where the monsters ARE, read live out of the
// client's own entity array rather than out of the entity lump the level's
// author wrote years ago. See control/loop.mjs for the loop and README.md for
// what it measures.
//
// Nothing about the level's plan changes: the route, the exit volume and the
// level's own gun are the same offline facts, read the same way.
async function play() {
  report("starting", "fresh demo1 with cheats 0, played by control/loop.mjs");
  const map = await loadMap("demo1");
  const exit = map.exitPoint();
  const walk = { maxStepUp: 45, maxDrop: 300, maxJump: 160, cell: 24 };
  const plan = map.path(map.playerStart().position, exit.aim, walk);
  report("route plan", plan.points.length ? plan.points.length + " points, " + Math.round(plan.distance) + " units" : plan.reason);
  // The errands, in the loop's own terms: the level's gun and its ammunition
  // (see supplyCalls) and the health boxes the plan already passes (built
  // below). The loop runs them when they are owed and reachable, which is
  // a decision taken every tick rather than a waypoint inserted into a plan.
  const errands = [];
  if (!process.env.QUAKE2_NO_SUPPLY) {
    for (const call of supplyCalls(map, map.playerStart().position)) {
      errands.push({
        classname: call.classname,
        call: call.call,
        position: { x: call.x, y: call.y, z: call.z },
        tap: call.tap || null,
        walkDistance: call.walkDistance,
      });
    }
  }
  if (!process.env.QUAKE2_NO_TOPUP) {
    // The level's own health and armour boxes that already stand on the plan,
    // as errands the loop may detour for when the player is hurt enough (see
    // PlayLoop's `#activeErrand`).
    //
    // Built here rather than borrowed, and that is a merge decision worth
    // naming: the base's `finish()` used to get this list from a `topUpCalls()`,
    // and PR #10 removed that function along with the walker's own errand list
    // -- its pickups are handled by routing the *plan* over them instead
    // (CombatWalker's `snapPickups`). This loop has no walker and does not
    // re-route the plan, so its equivalent is an errand list, and this is where
    // its list comes from. A call to the removed `topUpCalls()` is a call to
    // nothing, which is what the rebase produced before this was written.
    //
    // Only boxes the plan already passes are taken (`NEAR`), because the
    // measurement behind that limit still holds: the walk that swept up every
    // health box it could see reached 2,053 units short and fired no shots at
    // all.
    const NEAR = 96;
    const offPlan = (x, y) => {
      let best = { distance: Infinity, index: 0 };
      for (let index = 0; index < plan.points.length; index++) {
        const a = plan.points[index];
        const b = plan.points[Math.min(index + 1, plan.points.length - 1)];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = dx * dx + dy * dy;
        const t = length === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length));
        const distance = Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
        if (distance < best.distance) best = { distance, index };
      }
      return best;
    };
    const boxes = [];
    const already = new Set();
    for (const item of map.waypoints("*")) {
      if (!item.position || !/^item_(health|armor)/.test(item.classname)) continue;
      const near = offPlan(item.position.x, item.position.y);
      if (near.distance > NEAR) continue;
      const key = item.classname + Math.round(item.position.x) + "," + Math.round(item.position.y);
      if (already.has(key)) continue;
      already.add(key);
      boxes.push({ item, near });
    }
    boxes.sort((a, b) => a.near.index - b.near.index);
    for (const { item, near } of boxes) {
      errands.push({ classname: item.classname, call: "health", position: { x: item.position.x, y: item.position.y, z: item.position.z }, walkDistance: Math.round(near.distance) });
    }
  }
  report("errands the loop carries", errands.length
    ? errands.map((errand) => errand.call + " " + errand.classname + " at " + Math.round(errand.position.x) + " " + Math.round(errand.position.y) + " " + Math.round(errand.position.z) + (errand.tap ? " press " + errand.tap : ""))
    : "none the level offers within reach");
  // Read the weapon binding before the level starts, like `finish` does, so the
  // gun is in hand the moment the errand is run rather than a round trip later.
  const armed = errands.find((errand) => errand.call === "weapon");
  if (armed) {
    const WEAPON_LABEL = { supershotgun: "Super Shotgun", shotgun: "Shotgun", machinegun: "Machinegun", chaingun: "Chaingun", grenadelauncher: "Grenade Launcher", rocketlauncher: "Rocket Launcher", hyperblaster: "HyperBlaster", railgun: "Railgun", bfg10k: "BFG10K" };
    const short = armed.classname.replace(/^weapon_/, "");
    const binding = typeof game.weaponKey === "function" ? await game.weaponKey(WEAPON_LABEL[short] || short) : { found: false };
    armed.tap = binding && binding.key ? binding.key : null;
    armed.label = WEAPON_LABEL[short] || short;
  }
  const tickMs = askedFor("QUAKE2_TICK_MS");
  const deathBudget = askedFor("QUAKE2_DEATHS");
  const loop = new PlayLoop(game, map, {
    errands,
    ...(tickMs === null ? {} : { tickMs: Math.max(20, tickMs) }),
    ...(deathBudget === null ? {} : { deaths: Math.max(0, deathBudget) }),
    ...(process.env.QUAKE2_ENGAGE_RANGE ? { engageRange: Number(process.env.QUAKE2_ENGAGE_RANGE) } : {}),
    ...(process.env.QUAKE2_AIM_TOLERANCE ? { aimTolerance: Number(process.env.QUAKE2_AIM_TOLERANCE) } : {}),
    ...(process.env.QUAKE2_LOW_HEALTH ? { lowHealth: Number(process.env.QUAKE2_LOW_HEALTH) } : {}),
    ...(process.env.QUAKE2_MAX_TICKS ? { maxTicks: Math.max(1, Number(process.env.QUAKE2_MAX_TICKS)) } : {}),
    ...(process.env.QUAKE2_HEALTH_READ_MS ? { healthReadMs: Math.max(0, Number(process.env.QUAKE2_HEALTH_READ_MS)) } : {}),
    // The two levers this pass added. `QUAKE2_PITCH_AIM=0` is the control for
    // the second aim axis: it gives back exactly the old yaw-only behaviour, so
    // a change to the aim can be measured against the thing it replaced rather
    // than against a memory of it.
    ...(process.env.QUAKE2_PITCH_AIM === "0" ? { pitchAim: false } : {}),
    ...(process.env.QUAKE2_MET_RANGE ? { metRange: Math.max(1, Number(process.env.QUAKE2_MET_RANGE)) } : {}),
    // Stop and kill: how close a shootable target has to be before the walk
    // stands still for it, and how long it may stand there. `QUAKE2_STOP_RANGE=0`
    // is the control -- the walk never stops, which is the behaviour every run
    // before this pass was measured with.
    ...(process.env.QUAKE2_STOP_RANGE ? { stopRange: Math.max(0, Number(process.env.QUAKE2_STOP_RANGE)) } : {}),
    ...(process.env.QUAKE2_ENGAGE_HOLD_MS ? { engageHoldMs: Math.max(0, Number(process.env.QUAKE2_ENGAGE_HOLD_MS)) } : {}),
    // How far the walk will go out of its way for a monster it has met, and how
    // long it will spend before leaving it. `QUAKE2_HUNT_RANGE=0` is the control:
    // the walk only ever shoots at what happens to cross it, which is the
    // behaviour every run before this one was measured with.
    ...(process.env.QUAKE2_HUNT_RANGE ? { huntRange: Math.max(0, Number(process.env.QUAKE2_HUNT_RANGE)) } : {}),
    ...(process.env.QUAKE2_HUNT_GIVEUP_MS ? { huntGiveUpMs: Math.max(0, Number(process.env.QUAKE2_HUNT_GIVEUP_MS)) } : {}),
    trace: process.env.QUAKE2_TRACE === "1",
  });
  loop.plan = plan;
  report("loop levers", {
    tickMs: loop.options.tickMs,
    engageRange: loop.options.engageRange,
    answerRange: loop.options.answerRange,
    aimTolerance: loop.options.aimTolerance,
    lowHealth: loop.options.lowHealth,
    boltSpeed: loop.options.boltSpeed,
    deaths: loop.options.deaths,
  });
  const fresh = await freshDemo1();
  report("map after reset", fresh.map);
  report("player at", fresh.position);
  report("cheats line", fresh.cheatsAnswer.filter((line) => /cheats/.test(line)));
  // The line above is the console's ECHO of `cheats 0`; this is the engine's own
  // answer when the cvar is asked for its value, and they are not the same
  // reading: the echo says the command arrived, the answer says what the engine
  // did with it. A finish proof has to carry the second one, and the run above
  // has already printed an empty echo for it once.
  const cheatsBefore = await readCvars(game, ["cheats", "timescale"]).catch((error) => ({ values: null, reason: error.message }));
  report("cheats and timescale, the engine's own answer before the walk", cheatsBefore.values || cheatsBefore.reason);
  if (fresh.map !== "demo1") {
    report("result", "could not start demo1; stopping rather than playing an unknown level");
    process.exitCode = 1;
    return;
  }
  if (armed && armed.tap) await game.tap(armed.tap).catch(() => {});
  // ITERATION MODE, and only here: after `freshDemo1()` has put the level back
  // to `cheats 0`, so the reset is a reset, and before the clock starts, so the
  // console pause it costs is not billed to the run. It is deliberately after
  // the level check above: a fast run that could not start demo1 should say that
  // rather than spend two console round trips on a game that is not there.
  if (FAST.on) {
    report("ITERATION MODE", FAST_BANNER);
    report("iteration mode asked for", { timescale: FAST.timescale, resolution: FAST.resolution, via: FAST.source });
    try {
      fastState = await enterFastMode(game, { timescale: FAST.timescale, resolution: FAST.resolution, render: FAST.render });
      // Which level the restore has to reload if `cheats 0` turns out to be
      // latched (see control/fast.mjs). It is always demo1 on this script.
      fastState.level = "demo1";
      report("iteration mode, what the engine confirmed", fastState.taken.map((entry) => entry.name + "=" + (entry.got === null ? "?" : entry.got) + (entry.ok ? "" : " (ASKED " + entry.asked + ")")));
      if (fastState.refused.length) report("iteration mode, cvars this build does not have", fastState.refused.join(", ") + " -- Unknown command");
      if (fastState.cheat) report("iteration mode, cheat", "cheats 1 + timescale " + fastState.timescale + " -- the only cheat in this mode; no god, noclip, give or teleport");
      if (FAST.timescale !== 1 && fastState.confirmed.timescale !== String(FAST.timescale)) {
        report("iteration mode", "asked for timescale " + FAST.timescale + " but the engine answers " + JSON.stringify(fastState.confirmed.timescale) + "; continuing at whatever it accepted");
      }
      // The loop's own level restart sends `map <level>` and a cheats line. In
      // iteration mode that line is `cheats 1` rather than `cheats 0`, so a
      // restart cannot be the thing that ends iteration mode halfway through a
      // run. This is DEFENSIVE and is labelled as such: what was measured is
      // that `cheats` is latched for the next game, and that `timescale` is a
      // client cvar a level load does not touch -- so the lever guards against
      // a restart turning the cheat off, and this pass did NOT measure that it
      // would have. Setting it costs nothing and leaves the normal path alone:
      // without `--fast` the option is unset and the line is `cheats 0`.
      loop.options.cheatsAfterRestart = fastState.cheat ? "cheats 1" : "cheats 0";
    } catch (error) {
      report("iteration mode", "could not be entered (" + error.message + "); playing at normal speed");
      fastState = null;
    }
  }
  const started = Date.now();
  const result = await loop.run(exit.aim, { tolerance: 96, level: "demo1" });
  report("loop reason", result.reason);
  report("engine's answer while playing", result.levelChanged ? result.levelChanged.name : "demo1");
  if (result.deepest) {
    report("deepest reading", {
      x: Math.round(result.deepest.x), y: Math.round(result.deepest.y), z: Math.round(result.deepest.z),
      short: Math.round(result.deepest.distance), mode: result.deepest.mode,
    });
  }
  report("ticks", result.ticks + " in " + Math.round(result.durationMs / 1000) + "s");
  report("the loop's own rate", result.timing);
  report("decisions taken (mode, ticks)", result.states);
  report("monsters seen in one frame at most", result.monstersSeen);
  report("shots fired", result.shots + " trigger presses, " + result.triggerMs + "ms with the trigger down");
  report("monsters driven off the engine's entity list", result.killsCount);
  if (result.kills.length) {
    for (const kill of result.kills) report("  " + kill.classname + " #" + kill.number + "  after " + kill.samples + " live readings, " + kill.flinches + " flinches");
  }
  report("damage events (a live monster's animation frame moved with the trigger down)", result.damageEvents);
  report("  of those, flinches (the frame ran backwards)", result.flinches);
  // ---- the game's own state: health, hits and kills -----------------------
  // Everything below comes from the game DLL's own edict array
  // (control/edicts.mjs), not from the network entity state and not from a
  // landed turn. It is the only reading of a monster's health the harness has.
  if (result.enemies) {
    report("enemies met in the LAST attempt (within reach of the player, from the loop's own record)", result.enemies.met);
    report("  of those, killed (the game's own edict says health <= 0)", result.enemies.killed);
    report("  of those killed, killed BY this attempt (alive when it first met them)", result.enemies.killedByThisAttempt);
    if (result.enemies.alreadyDeadWhenMet) report("  already dead when the attempt first met them (an earlier attempt's kills, or a first tick reading the level being left)", result.enemies.alreadyDeadWhenMet);
    report("enemies met and still standing", result.enemies.stillStanding);
    if (result.enemies.unreadableHealth) report("enemies whose health the game's edict would not give up", result.enemies.unreadableHealth);
    report("SECOND SUCCESS CONDITION (kill everything met)", result.enemies.met === 0
      ? "no enemy was met in this attempt -- nothing was slipped past and nothing was proven"
      : (result.enemies.stillStanding === 0
        ? "met " + result.enemies.met + ", killed " + result.enemies.killed + " -- every enemy met was killed"
        : "met " + result.enemies.met + ", killed " + result.enemies.killed + " -- " + result.enemies.stillStanding + " STILL STANDING"));
    for (const enemy of result.enemies.list) {
      report("  #" + String(enemy.number).padStart(4) + " " + (enemy.classname || "monster").padEnd(22) +
        " met at " + String(enemy.metAt).padStart(5) + "u  health " + enemy.healthFirst + " -> " + enemy.healthLowest +
        "  hits " + enemy.hits + "  " + (enemy.killed ? "KILLED (" + enemy.killedBy + ")" : "alive"));
    }
  }
  // Every attempt, because a death reloads the level and revives its monsters:
  // the numbers above are the LAST attempt's, and these are the ones before it.
  // A run that dies four times made five attempts, and only the last one is the
  // trip that could have finished the level.
  if (result.attempts && result.attempts.length) {
    report("attempts (a death reloads the level, so its monsters come back alive and the count starts again)", result.attempts.length + 1);
    for (const attempt of result.attempts) {
      report("  attempt " + attempt.attempt + " (" + attempt.endedBy + ")",
        "met " + attempt.met + ", killed " + attempt.killed + " (of which this attempt's: " + attempt.killedByThisAttempt + ")" +
        ", still standing " + attempt.stillStanding +
        ", health taken off them " + attempt.healthDamage + " over " + attempt.healthDamageEvents + " drops" +
        ", " + Math.round(attempt.wallClockMs / 1000) + "s");
    }
    report("  attempt " + result.enemies.attempt + " (the last one)",
      "met " + result.enemies.met + ", killed " + result.enemies.killed + " (of which this attempt's: " + result.enemies.killedByThisAttempt + ")" +
      ", still standing " + result.enemies.stillStanding +
      ", health taken off them " + result.healthDamage + " over " + result.healthDamageEvents + " drops" +
      ", " + Math.round(result.enemies.wallClockMs / 1000) + "s");
    // Kills this run can actually claim. A monster met already dead is not one
    // of them -- counting those is how the same run reported three kills an
    // attempt beside zero health taken off anything.
    report("monsters this run killed itself (alive when its attempt first met them, dead at the end of it)",
      result.attempts.reduce((sum, attempt) => sum + attempt.killedByThisAttempt, 0) + result.enemies.killedByThisAttempt);
  }
  report("health the game says was taken off monsters", result.healthDamage + " over " + result.healthDamageEvents + " drops" +
    (result.healthDamageTotal !== undefined && result.healthDamageTotal !== result.healthDamage
      ? " (this attempt; " + result.healthDamageTotal + " over " + result.healthDamageEventsTotal + " across the whole run)"
      : ""));
  report("edict read (the game DLL's own array)", result.edictRead && {
    ticks: result.edictRead.ticks,
    from: result.edictRead.source,
    monstersWithHealth: result.edictRead.withHealth,
    unmatched: result.edictRead.unmatched,
    originDisagreed: result.edictRead.originDisagreed,
    playerEdict: result.edictRead.playerEdict,
    crossCheckAgainstStatusBar: result.edictRead.crossCheck,
  });
  report("player health series (game's own edict, on change)", (result.edictHealth || []).map((entry) => entry.health).join(", ") || "none read");
  report("aim, the second axis (pitch)", result.pitch && {
    on: result.pitch.on,
    scaleLearned: result.pitch.scale,
    samples: result.pitch.samples,
    failures: result.pitch.failures,
  });
  // The yaw's own learned scale, which the report never carried: the two axes
  // are calibrated by the same fold-back and the pitch's number was quoted
  // without the yaw's beside it.
  report("aim, the first axis (yaw)", result.turnScale && { scaleLearned: result.turnScale.learned, samples: result.turnScale.samples });
  // The gun in hand, and what the loop did with it. The weapon is the loop's own
  // record of which key it pressed for the gun the level's errand fetched; the
  // fingerprint below is the game's evidence for whether that press took
  // effect. A blaster bolt is a flat 10 -- measured, and the only weapon this
  // level actually hands the player -- so a drop of anything else is a
  // different gun firing, whatever the loop's own record says.
  report("the gun the walk fetched", result.weapon || "none fetched (spawn blaster)");
  report("ticks spent standing still to shoot (stop and kill)", result.stopAndShootTicks + " of " + result.ticks);
  // Going out of the way for what was met and not killed. `left` is how many
  // monsters the walk decided it could not reach.
  if (result.hunts) report("hunts (met, alive, and walkable: the walk went to it)", result.hunts);
  // The game's own fingerprint of which gun was really firing: the size of every
  // drop in a monster's own health, in order. A blaster bolt is a flat 10 --
  // measured on a whole run -- so a series that is not all 10s is a different
  // gun. The loop's record of the key it pressed is a claim; this is the
  // engine's answer to the same question.
  if (result.dropSizes && result.dropSizes.length) {
    const sizes = new Map();
    for (const size of result.dropSizes) sizes.set(size, (sizes.get(size) || 0) + 1);
    report("every drop in a monster's own health, by size (the weapon's fingerprint)", [...sizes.entries()].sort((a, b) => b[1] - a[1]).map(([size, count]) => size + "x" + count).join(", "));
  }
  // The aim measured on the tick's own corrected reading, both axes, for every
  // tick that had a target. This is what "the aim landed" means for this loop:
  // it is the state the trigger is released from, and it is counted whether or
  // not the run asked for the per-tick trace.
  if (result.gate) {
    report("the aim gate, per tick with a target (the trigger only goes down with BOTH axes inside 1.6 degrees)", {
      ticksWithATarget: result.gate.ticks,
      yawInside: result.gate.yawInside,
      pitchInside: result.gate.pitchInside,
      bothInside: result.gate.bothInside,
      triggerDidGoDown: result.gate.fire,
      meanYawErrorDeg: result.gate.aimErrorMean,
      meanPitchErrorDeg: result.gate.pitchErrorMean,
    });
  }
  if (result.hitRate) {
    report("hit accounting", {
      damageEventsPerTriggerPress: Math.round(result.hitRate.damageEventsPerPress * 1000) / 1000,
      damageEventsPerSecondWithTheTriggerDown: result.hitRate.damageEventsPerSecondOfTrigger === null ? null : Math.round(result.hitRate.damageEventsPerSecondOfTrigger * 1000) / 1000,
      killsPerTriggerPress: Math.round(result.hitRate.killsPerPress * 1000) / 1000,
    });
    report("note", "the `damage events` line above is the old frame-moved proxy and it is the one sensor on this box that does NOT work: an idle monster's animation frame does not move, so a frame that moves should be a hit, but measured on this build it has never fired once and the loop reads a monster's own health out of the game DLL's edict array instead (see `enemies killed` and `health the game says was taken off monsters`). A landed turn is not counted as a hit anywhere in this report.");
  }
  report("health series (status bar)", result.healthSeries.map((entry) => entry.health).join(", ") || "none read");
  report("lowest health read", result.lowestHealth);
  report("level restarts the loop lived through", result.deaths);
  report("bolt speed used for the lead", result.boltSpeed);
  // The bolts are the only direct evidence that the trigger did anything: a
  // bolt is an entity of its own and the live array is where it is.
  report("bolts seen in the live entity array", result.bolts);
  if (result.bolts && result.bolts.rejectedModelIndexOnlyTotal) {
    report("  (of which model index 45 WITHOUT the blaster effect: the level's own props, at fixed positions -- kept apart from the bolts, and the reason the bolt speed below is measurable at all)");
  }
  if (result.targets && result.targets.length) {
    report("monsters the loop watched (entity, name, readings, flinches, killed, distinct solid values, distinct effects, last frame)");
    for (const target of result.targets) {
      report("  #" + target.number + " " + target.classname + "  readings " + target.seen + "  damage events " + (target.damageEvents || 0) + "  flinches " + target.flinches +
        "  stopped being a monster " + (target.killed ? "yes" : "no") + "  solid [" + (target.solids || []).join(",") + "]" +
        "  effects [" + (target.effects || []).join(",") + "]  frame " + target.lastFrame);
    }
  }
  report("live entity read (checks, agreements, worst disagreement)", result.entityIntegrity);
  report("errand record", result.errands);
  if (result.trace && result.trace.length) {
    report("per-tick trace (tick, decision, yaw, aim, aim error, line clear, trigger, target, monsters, at, turn scale)");
    for (const entry of result.trace) {
      report("  " + String(entry.tick).padStart(4, " ") + " " + entry.mode.padEnd(7) + " " + (entry.said || "").padEnd(24) +
        " yaw " + String(entry.yaw).padStart(7, " ") + " aim " + String(entry.aim).padStart(7, " ") +
        " err " + String(entry.aimError).padStart(6, " ") + " clear " + (entry.clear ? "yes" : "no ") +
        " fire " + (entry.fire ? "yes" : "no ") +
        " target " + (entry.target ? "#" + entry.target.n + " d" + entry.target.d + " off" + entry.target.off : "-") +
        " monsters " + entry.monsters + " at " + entry.at.join(" ") + " scale " + entry.scale);
    }
  }
  if (result.trail.length) {
    report("last positions the engine reported (x y z, monsters in frame, decision)");
    for (const point of result.trail.slice(-12)) {
      report("  " + point.x + " " + point.y + " " + point.z + "  monsters " + point.monsterCount + "  " + point.mode);
    }
  }
  report("last loop notes", result.log.slice(-12).map((entry) => entry.message + (entry.detail ? " " + JSON.stringify(entry.detail) : "")));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const after = await readMapName();
  report("engine says the map is", after.name);
  report("proof", after.lines.filter((line) => /"mapname" is "/.test(line)));
  // The other half of the proof, and the engine's own answer rather than the
  // script's promise: a walk at a multiplied clock or with cheats on is not a
  // finish whatever the `mapname` says. Asked here, at the end, on the same
  // console the `mapname` above came off.
  const cheatsAfter = await readCvars(game, ["cheats", "timescale"]).catch((error) => ({ values: null, reason: error.message }));
  report("cheats and timescale, the engine's own answer after the walk", cheatsAfter.values || cheatsAfter.reason);
  const playedStraight = cheatsAfter.values && cheatsAfter.values.cheats === "0" && (cheatsAfter.values.timescale === "1" || cheatsAfter.values.timescale === "0");
  // The finish line. What makes a run a finish proof is not the flag, it is what the run
  // actually was: normal speed and cheats 0. `QUAKE2_FAST=1
  // QUAKE2_FAST_TIMESCALE=1` does the render/sound cuts and touches NOTHING
  // about the simulation -- no `cheats 1`, no `timescale` -- so a map change in
  // a run like that is the same engine event a normal run produces and it is
  // reported as a finish. A run whose simulation was multiplied is not, and
  // says so.
  const cheated = fastState ? fastState.cheat === true : false;
  // The flag the run was started with is not the proof; the engine's answer is.
  // A run whose `cheats` read back anything but "0", or whose clock read back
  // anything but 1, is reported as NOT a finish however its `mapname` answers --
  // and when the read-back does not come back at all that is said rather than
  // assumed either way.
  if (!cheatsAfter.values) report("cheats read-back", "the engine did not answer; the finish proof below rests on the `mapname` line alone (" + (cheatsAfter.reason || "no answer") + ")");
  if (after.name === "demo2") {
    if (cheated) report("result", "FAST-MODE RESULT ONLY -- the engine loaded demo2, but this run's SIMULATION was multiplied (cheats 1, timescale " + fastState.timescale + "), so it is NOT a finish. Re-run at normal speed with cheats 0 to prove it.");
    else if (cheatsAfter.values && !playedStraight) report("result", "NOT a finish proof -- the engine loaded demo2, but its own answer after the walk was " + JSON.stringify(cheatsAfter.values) + ", not cheats 0 at timescale 1");
    else report("result", "FINISHED -- the engine loaded demo2" + (FAST.on ? " (normal speed, cheats 0; the render/sound cuts were on and change nothing the engine simulates)" : "") + (cheatsAfter.values ? " (its own answer after the walk: cheats " + cheatsAfter.values.cheats + ", timescale " + cheatsAfter.values.timescale + ")" : ""));
  } else {
    report("result", (cheated ? "(iteration mode, simulation multiplied) " : "") + "NOT finished -- the engine is still on " + after.name);
  }
  report("wall clock", Math.round((Date.now() - started) / 1000) + "s" + (cheated ? " (iteration mode, timescale " + fastState.timescale + ")" : " (normal speed)"));
  report("this run was", cheated
    ? "ITERATION MODE WITH THE SIMULATION MULTIPLIED -- cheats 1, timescale " + fastState.timescale + ". Its numbers are iteration numbers, not the level's."
    : (FAST.on
      ? "NORMAL SPEED, cheats 0, with the render/sound speed-up on -- it changes how long a frame takes to draw and nothing the engine simulates, so a result from it counts. Timescale 1."
      : "NORMAL SPEED, cheats 0 -- the mode every finish proof has to be made in."));
}

const [command, argument] = process.argv.slice(2);
try {
  if (command === "plan") await plan();
  else if (command === "walk") await walk(argument);
  else if (command === "play") await play();
  // `finish` is the same walk the level has always been measured with, run two
  // ways. The loop is the default now -- it is the change this pass is about --
  // and QUAKE2_LEGACY=1 hands the job back to the leg script, which is how a
  // change can be measured against the thing it replaced.
  else if (command === "finish") await (process.env.QUAKE2_LEGACY === "1" ? finish() : play());
  else if (command === FAST_FLAG || command === "fast") await play();
  else console.log("usage: node scripts/demo1-run.mjs plan|walk X,Y,Z|finish|play|--fast [--timescale N]");
  // `--timescale N` is read by fastRequest() out of argv, so nothing else has to
  // see it. Saying so here keeps a typo from being silently a normal-speed run.
  const strayTimescale = process.argv.slice(2).findIndex((arg) => arg === "--timescale");
  if (strayTimescale !== -1 && !Number.isFinite(Number(process.argv[strayTimescale + 1]))) {
    console.log("--timescale needs a number; the engine's own list this pass tried: " + FAST_TIMESCALE_CHOICES.join(", "));
  }
} catch (error) {
  console.error("ERROR " + (error.code ? error.code + ": " : "") + error.message);
  if (process.env.QUAKE2_DEBUG === "1" && error.stack) console.error(error.stack);
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
  // Iteration mode comes off before the movement keys and before the bridge
  // goes away, so the game is handed back at normal speed and with `cheats 0`
  // whether the run finished, threw or was cut short. A timescale left on is the
  // worst thing this pass could leave behind: the owner's own normal-speed test
  // would run at five times speed and every number from it would be wrong. It
  // comes after the trigger release only because a console round trip with the
  // trigger still down would leave the player firing through it.
  if (fastState) {
    const left = await leaveFastMode(game, fastState, { level: fastState.level || "demo1" })
      .catch((error) => ({ reason: "COMMAND_FAILED", message: error.message }));
    const latch = left.relatched || {};
    console.log("iteration mode off: timescale " + JSON.stringify(left.timescale) + ", cheats " + JSON.stringify(left.cheats) +
      " (restored " + (left.restored || []).length + " cvars)" +
      // Only claim the reload worked when it was READ BACK. A reload that was
      // sent and never checked is not a restore, and saying it was is how a
      // broken branch reads as a working one.
      (left.latched && latch.ok
        ? ", and `cheats 0` had to be latched by reloading " + latch.level + " -- Quake 2 keeps cheats for the running game until a level loads"
        : (left.latched ? ", and the reload that was meant to latch `cheats 0` could NOT be verified: " + (latch.error || "no read-back") + " (level " + latch.level + ")" : "")) +
      (left.reason ? " -- " + left.reason + ": " + left.message : ""));
    if (left.cheats !== "0" && left.cheats !== null) {
      console.log("WARNING: the game is still at cheats " + left.cheats + ". Do not make a normal-speed run until it reads `cheats 0`.");
    }
    fastState = null;
  } else if (FAST.on) {
    console.log("iteration mode was asked for but never entered; the game is at normal speed");
  }
  // And the movement keys, for the same reason one order of magnitude louder:
  // fire left down shoots at nothing, but `+forward` left down *walks the
  // player*, and a run that ends on an exception with a key held hands the
  // level a player who keeps walking after the harness has gone. Measured: a
  // smoke run that threw on its first tick left `w` down, and the next run's
  // reset found the player 600 units from the spawn the engine had just given
  // them.
  if (typeof game.hold === "function") await game.hold([]).catch(() => {});
  await game.close().catch(() => {});
}
