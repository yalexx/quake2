#!/usr/bin/env node
// scripts/goto-test.mjs -- prove the bridge's navigation against the live game.
//
// The control API can be tested without a game (see control-api-test.mjs). This
// cannot: face(), walk() and goto() are closed loops around what the engine
// reports, and a fake engine would only prove that the test agrees with itself.
// So this test drives the game the box is showing, reads the player's position
// out of the engine's own console, and checks that the player really moved.
//
// It is deliberately gentle: it turns, walks a short way and walks back to where
// it started. It still moves the player, so it is not something to run mid-game
// by accident -- and it says so in its own output.
//
// The steps, in order:
//   1. the CDP endpoint answers and the game frame is found
//   2. a level is running and the engine reports a player position
//   3. route.mjs reads the running map from the archive and finds its exit
//   4. face() turns the player to a bearing it was given
//   5. walk() moves the player
//   6. goto() leaves the player within tolerance of a point it was given
//   7. goto() reports a miss honestly instead of claiming a target it never
//      reached
//
// PASS/FAIL per step, exit 1 if any step failed. A step is SKIPPED, with its
// reason printed, when there is no browser, no game open, no level running, or a
// level whose player cannot be driven at all -- a turn and a walk decide that
// last one before any navigation step runs, so a dead player is reported as a
// dead player instead of as a broken goto(). "PASS" is only printed when the
// navigation steps really ran. Node built-ins only.
//
//   node scripts/goto-test.mjs
"use strict";
import { QuakeControl } from "../control/bridge.mjs";
import { loadMap, normalizeMapName } from "../control/route.mjs";

// How far the player is allowed to end up from a goto target.
const TOLERANCE = 48;
// The step 6 trip, in milliseconds of held forward key.
const WALK_MS = 600;
// Step 7's target is the level's own exit: far enough that two steps cannot
// reach it, which is the point.
const DISTANT_ROUNDS = 2;

let failures = 0;
let skips = 0;
let ran = 0;

function ok(name, note) {
  console.log("PASS  " + name + (note ? " -- " + note : ""));
}

function bad(name, reason) {
  failures++;
  console.log("FAIL  " + name + "\n        " + String(reason).replace(/\n/g, "\n        "));
}

async function step(name, fn) {
  try {
    const note = await fn();
    ok(name, note);
    return note;
  } catch (error) {
    bad(name, (error && error.message) || error);
    return undefined;
  }
}

function skip(name, reason) {
  skips++;
  console.log("SKIP  " + name + " -- " + reason);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function shortest(degrees) {
  let angle = Number(degrees) % 360;
  if (angle > 180) angle -= 360;
  if (angle <= -180) angle += 360;
  return angle;
}

const here = (point) => point ? point.x + "," + point.y + "," + point.z : "nowhere";
const flat = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- The run --------------------------------------------------------------

const game = new QuakeControl();
let gameOpen = false;
let map = null;
let start = null;

try {
  await (async () => {
    try {
      const { target, frameId } = await game.findGame();
      gameOpen = true;
      ok("the CDP endpoint answers and the game frame is found", target.url + (frameId ? " (framed)" : " (own tab)"));
    } catch (error) {
      // "There is no game to navigate" is a skip, not a failure: this test's
      // subject is the navigation loop, and it cannot have an opinion about a
      // browser that is not running.
      if (error && (error.code === "GAME_NOT_RUNNING" || error.code === "CDP_UNREACHABLE")) {
        skip("the CDP endpoint answers and the game frame is found", String(error.message || error).split("\n")[0]);
      } else {
        bad("the CDP endpoint answers and the game frame is found", (error && error.message) || error);
      }
    }
  })();

  if (!gameOpen) {
    skip("a level is running and the engine reports a player position", "no game is open in the browser at " + game.cdpUrl);
    skip("route.mjs reads the running map from the archive and finds its exit", "no game is open");
    skip("face() turns the player to a bearing it was given", "no game is open");
    skip("walk() moves the player", "no game is open");
    skip("goto() leaves the player within tolerance of a point it was given", "no game is open");
    skip("goto() reports a miss honestly", "no game is open");
  } else {
    // ---- Step 2: is a level actually running? ----------------------------
    let reported = null;
    await step("a level is running and the engine reports a player position", async () => {
      reported = await game.position();
      if (!reported.probed) return null; // handled below as a skip
      assert(reported.position, "the engine answered but printed no `position:` line, so there is no player to navigate");
      assert(reported.angles, "the engine answered but printed no angles");
      start = reported.position;
      return "map " + reported.map + ", player at " + here(start) + ", yaw " + reported.angles.yaw;
    });

    if (!reported || !reported.probed || !start) {
      const why = reported && reported.message ? reported.message : "the engine did not report a live player";
      skip("route.mjs reads the running map from the archive and finds its exit", why);
      skip("face() turns the player to a bearing it was given", why);
      skip("walk() moves the player", why);
      skip("goto() leaves the player within tolerance of a point it was given", why);
      skip("goto() reports a miss honestly", why);
    } else {
      // ---- Step 3: the route data agrees with the running engine ---------
      await step("route.mjs reads the running map from the archive and finds its exit", async () => {
        const name = normalizeMapName(reported.map);
        map = await loadMap(name);
        const exit = map.exitPoint();
        assert(exit.position, "the exit has no position");
        assert(exit.nextMap, "the exit names no next map");
        const playerStart = map.playerStart();
        assert(playerStart && playerStart.position, "the map has no `info_player_start` to compare against");
        const nearestEnemy = map.nearest(reported.position, "enemy");
        const nearestItem = map.nearest(reported.position, "item");
        // The player has to be somewhere in the map the archive describes, or
        // the two are not talking about the same level.
        const bounds = map.bounds();
        const inside = reported.position.x >= bounds.min.x && reported.position.x <= bounds.max.x &&
          reported.position.y >= bounds.min.y && reported.position.y <= bounds.max.y;
        assert(inside, "the running player at " + here(reported.position) + " is outside the bounds of " + name + " (" + JSON.stringify(bounds) + "), so the archive and the engine are not the same level");
        return name + ": " + map.entities.length + " entities, exit -> " + exit.nextMap +
          (exit.landmark ? "$" + exit.landmark : "") + " at " + here(exit.position) +
          ", nearest enemy " + (nearestEnemy ? nearestEnemy.classname + " at " + Math.round(nearestEnemy.distance) + "u" : "none") +
          ", nearest item " + (nearestItem ? nearestItem.classname + " at " + Math.round(nearestItem.distance) + "u" : "none");
      });

      // ---- Gate: can the player be driven at all? --------------------------
      // A level can be up with a player who cannot be driven: dead, paused, or
      // with a menu holding the keys. Everything below would then fail for a
      // reason that is not the bridge's fault, so one short turn and one short
      // walk decide it first. A real navigation bug still fails loudly -- the
      // gate only skips when *nothing* moves, which is the game's state and not
      // the code's.
      let canDrive = false;
      await (async () => {
        const probe = await game.position();
        const before = probe.position;
        const yaw = probe.angles ? probe.angles.yaw : null;
        await game.key("ArrowLeft", true);
        await sleep(400);
        await game.key("ArrowLeft", false);
        await sleep(200);
        const turned = (await game.position()).angles;
        if (yaw !== null && turned && Math.abs(shortest(turned.yaw - yaw)) > 1) {
          canDrive = true;
          ok("the player can be driven", "a 400 ms arrow-key turn moved the yaw " + yaw + " -> " + turned.yaw);
          return;
        }
        await game.walk(400);
        const after = (await game.position()).position;
        if (flat(before, after) > 20) {
          canDrive = true;
          ok("the player can be driven", "a 400 ms walk moved the player " + flat(before, after).toFixed(0) + " units");
          return;
        }
        skip("the player can be driven",
          "the engine reports a live level and a player at " + here(before) + ", but neither a 400 ms arrow-key turn nor a 400 ms walk changed anything. " +
          "That is the game's state, not the bridge's: the player is dead, the game is paused, or a menu has the keys" +
          (probe.angles && probe.angles.roll ? " (the reported roll is " + probe.angles.roll + ", which Quake 2 shows from a death or intermission camera, not from a live player)" : "") +
          ". Start a fresh level (the bridge's own command(\"map demo1\")) and run this again.");
      })();

      if (!canDrive) {
        skip("face() turns the player to a bearing it was given", "the player cannot be driven (see above)");
        skip("walk() moves the player", "the player cannot be driven (see above)");
        skip("goto() leaves the player within tolerance of a point it was given", "the player cannot be driven (see above)");
        skip("goto() reports a miss honestly", "the player cannot be driven (see above)");
      } else {
        // Only now has a navigation step actually been attempted. The summary
        // must not claim the bridge navigated anything on a run where every
        // navigation step was skipped.
        ran++;

        // ---- Step 4: facing ------------------------------------------------
        await step("face() turns the player to a bearing it was given", async () => {
          const before = await game.position();
          assert(before.angles, "no angles before the turn");
          // A quarter turn from wherever the player is looking: enough to prove
          // the loop corrects, small enough to be harmless.
          const target = (before.angles.yaw + 90) % 360;
          const result = await game.face(target, { tolerance: 6, rounds: 6 });
          const after = await game.position();
          assert(after.angles, "no angles after the turn");
          const error = Math.abs(shortest(target - after.angles.yaw));
          assert(result.facing, "face() gave up: " + (result.message || result.reason) + " (wanted " + target.toFixed(0) + ", got " + after.angles.yaw + ")");
          assert(error <= 6, "face() said it faced " + target.toFixed(0) + " but the engine reports " + after.angles.yaw + " (off by " + error.toFixed(1) + " degrees)");
          return "yaw " + before.angles.yaw + " -> " + after.angles.yaw + " for bearing " + target.toFixed(0) +
            " via " + result.method + " in " + result.rounds + " round(s), within " + error.toFixed(1) + " degrees";
        });

        // ---- Step 5: walking ------------------------------------------------
        let walked = null;
        await step("walk() moves the player", async () => {
          // Wherever the previous step left the player may be nose-first into a
          // wall, and a walk into a wall proves nothing either way. Try the four
          // cardinal headings and take the first one that actually moves; only a
          // player walled in on all four is a failure.
          const attempts = [];
          for (const turn of [0, 90, 180, 270]) {
            const probe = await game.position();
            const before = probe.position;
            const heading = (probe.angles.yaw + turn) % 360;
            if (turn) await game.face(heading, { tolerance: 8, rounds: 4 });
            const held = await game.walk(WALK_MS);
            const after = (await game.position()).position;
            const moved = flat(before, after);
            attempts.push({ heading, moved, heldMs: held.heldMs });
            if (moved > 60) {
              walked = { before, after, moved, heading, heldMs: held.heldMs };
              break;
            }
          }
          assert(walked, "the player moved 60 units or less from every one of four headings (" +
            attempts.map((a) => a.heading.toFixed(0) + "deg:" + a.moved.toFixed(0) + "u").join(", ") + ") in " + WALK_MS + " ms each. " +
            "Either the engine is not taking keys -- the game may be paused, the player dead, or a menu open -- or something solid is " +
            "within " + WALK_MS / 1000 * 300 + " units in every direction.");
          return "held " + walked.heldMs + " ms facing " + walked.heading.toFixed(0) + " degrees, moved " + walked.moved.toFixed(0) +
            " units, " + walked.before.x + "," + walked.before.y + " -> " + walked.after.x + "," + walked.after.y;
        });

        // ---- Step 6: arriving ------------------------------------------------
        await step("goto() leaves the player within tolerance of a point it was given", async () => {
          assert(walked, "the walk step did not produce a position to return to");
          const target = walked.before;
          const result = await game.goto(target, { tolerance: TOLERANCE, stepMs: 300, timeoutMs: 25000, faceTolerance: 10 });
          const final = (await game.position()).position;
          assert(final, "the engine stopped reporting a position during goto");
          const miss = flat(final, target);
          assert(result.reached, "goto() gave up " + miss.toFixed(0) + " units short (" + result.reason + "): " + (result.message || ""));
          assert(miss <= TOLERANCE, "goto() said it reached " + here(target) + " but the engine reports " + here(final) + ", " + miss.toFixed(0) + " units away");
          return "walked back to " + here(target) + " from " + here(walked.after) + " in " + result.rounds + " round(s), ended " + miss.toFixed(0) + " units away";
        });

        // ---- Step 7: honest failure -----------------------------------------
        await step("goto() reports a miss honestly", async () => {
          assert(map, "the route step did not produce a map");
          const exit = map.exitPoint();
          const current = (await game.position()).position;
          const away = flat(current, exit.position);
          assert(away > 500, "the player is already " + away.toFixed(0) + " units from the exit, which is too close for this step to mean anything");
          const result = await game.goto(exit.position, { tolerance: TOLERANCE, stepMs: 200, maxRounds: DISTANT_ROUNDS, timeoutMs: 20000 });
          assert(result.reached === false, "goto() claimed to reach the exit " + away.toFixed(0) + " units away in " + DISTANT_ROUNDS + " steps");
          assert(typeof result.reason === "string" && result.reason.length > 0, "goto() reported a miss with no reason");
          assert(result.position, "goto() reported a miss with no last position");
          return "exit is " + away.toFixed(0) + " units away; goto() said reached=false, reason=" + result.reason +
            ", last position " + here(result.position);
        });
      }
    }
  }
} catch (error) {
  failures++;
  console.log("FAIL  the test harness itself\n        " + String((error && error.stack) || error).replace(/\n/g, "\n        "));
}

console.log("");
if (failures) {
  console.log("goto-test: FAIL -- " + failures + " step(s) failed");
} else if (!ran) {
  console.log("goto-test: SKIP -- nothing was navigated (" + skips + " step(s) skipped; each says why above)");
} else {
  console.log("goto-test: PASS -- the bridge navigated the live game" + (skips ? " (" + skips + " skipped)" : ""));
}
process.exit(failures === 0 ? 0 : 1);
