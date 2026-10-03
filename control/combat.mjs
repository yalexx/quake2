// control/combat.mjs -- the fight on the way out of a level.
//
// route.mjs says where the way out is, walker.mjs walks it and opens what has to
// be opened. Neither one shoots, and on demo1 that is the whole story: the route
// is 4,693 units long and the furthest a walker has ever been measured is
// 3,286 of them, because five soldiers stand along the corridor the route goes
// down and a walk that does not answer them dies there. The level is not
// blocked; it is *defended*.
//
// So this module adds the one thing the walker was missing -- a reason to look
// at something other than the next route point -- and it does it in the level's
// own terms. Every soldier is an entity in the BSP's entity lump with an origin
// the level's author placed; `map.waypoints("enemy")` is that list, and
// `threats()` is what is left of it once the geometry has been asked whether a
// shot could even reach.
//
// The tactic is the one a player uses and the one the failed runs did not: keep
// walking, and shoot what is in the way while you walk. Moving is not a
// preference on this level, it is the whole of the defence -- standing still in
// demo1's corridor with full health and no armour was measured to end in a
// corpse in six seconds, while walking the same ground into the same soldiers
// costs nothing. So a leg that has a target looks at it, holds the trigger down,
// and *walks the route anyway*: Quake 2 moves a player along the view, so
// looking at a soldier to the side means holding forward *and* the strafe key
// that keeps the player on the line the walker chose (see movementKeys). The
// first attempt at this walked at the soldier instead -- off the plan, into a
// wall beside the corridor, standing still in the open -- and died on the second
// leg of the fight.
//
// Aiming, and why there is no pitch here. A Quake 2 bolt leaves the muzzle along
// the view and flies straight, so a shot fired with the view level crosses the
// world at the player's eye height -- 46 units above the floor they stand on.
// A soldier standing on that same floor is 56 units tall with its origin 24
// above its feet -- its box runs from 24 below that origin to 32 above it, which
// on the player's own floor is from 46 below the eye to 10 above it. The eye is
// *inside* that span, so a level shot hits the chest without any pitch at all.
// That is not a coincidence, it is how the level was built, and it is why this
// module filters to soldiers the level shot can reach instead of guessing an
// angle. The ones it
// cannot reach -- a soldier on the floor above, a sniper on a ledge -- are
// behind the floor's own geometry from down here, which the line check below
// finds anyway.
//
// It gives up honestly, like the walker. A level with no monsters in it fires
// nothing -- `threats()` on a map with no `monster_*` entities returns an empty
// list -- but it is not walked *identically* to the plain walker, and that is
// deliberate: every leg, firing or not, aims at a route point a few steps ahead
// on the plan rather than at the farthest one in sight (see walkAhead), because
// the farthest one is a chord across the plan and demo1 punishes it. What the
// absence of enemies changes is whether a leg shoots on the way, not where it
// goes.

import fs from "node:fs";
import path from "node:path";
import { RouteWalker, finitePoint } from "./walker.mjs";
import { hudShot, readHealth } from "./hud.mjs";

// The player's eye sits this far above the floor they stand on (24 of the
// player's 32x32x56 box, plus 22 more to the view). map data places floors and
// the engine reports the eye; every vertical comparison here goes through this,
// the same way walker.mjs does it.
const EYE_ABOVE_FEET = 46;

// A monster's own box, relative to the entity's origin: Quake 2 gives a soldier
// a (-16,-16,-24) to (16,16,32) box, so its origin sits 24 above its feet and 24
// below its top of head.
const MONSTER_FEET_BELOW_ORIGIN = 24;
const MONSTER_HEAD_ABOVE_ORIGIN = 32;

export const ENGAGE_DEFAULTS = {
  // How far away a soldier is worth turning for. A Quake 2 soldier starts
  // shooting at about 1,000 units and does not stop; a little past that is the
  // distance at which ignoring one is a decision rather than an oversight.
  engageRange: 1100,
  // How far off the way forward a soldier may stand and still be shot at. The
  // player does not walk *at* the soldier -- the fight leg walks the route and
  // looks sideways (see movementKeys) -- so this is not a limit on how far the
  // walk can be dragged off course. It is a limit on how much of a turn is worth
  // making, and a turn is cheap: a soldier to the side of the corridor is a
  // soldier the player can shoot while passing it, which is exactly what a
  // player does and what walking *at* it cannot do.
  engageArc: 80,
  // ...unless the soldier is this close, in which case the angle does not
  // matter and it is a target wherever it stands.
  //
  // This is the one fight rule that came out of reading the player's own
  // health rather than the level's geometry, and it is the reading that
  // explained a whole run. Measured on run 5 of the `finish` instrument: at the
  // deepest point it reached (`-728 321 -1`) there were two soldiers the level
  // shot could reach -- one at 58 units and one at 151 -- and the walker fired
  // on neither, because they stood 116 and 82 degrees off the way forward and
  // the arc is 80. The second of those misses by two degrees. The player was
  // killed by soldiers it could have shot and simply would not turn for; the
  // per-leg record shows it arriving in the corridor at 9 health and dying on
  // the next leg, and the aim on the legs it did take was 0 to 3 degrees, so
  // the firing was never the problem.
  answerRange: 200,
  // How long one firing leg lasts. At the player's 300 units per second this is
  // about 150 units of ground and, with the trigger held, several blaster bolts
  // -- three of them kill a soldier, and they are aimed the whole way in.
  engageStepMs: 500,
  // How many walk rounds an ordinary (non-firing) leg may take. The base
  // walker's leg runs goto() until it arrives, which on open ground is many
  // hundred units of walking with no decision made in between -- and that is
  // exactly how a walk dies in demo1's corridor: the leg that enters it is
  // decided while the soldiers are still out of sight, and the next decision is
  // taken by a corpse. Two rounds is about 240 units, comfortably inside the
  // range a soldier opens fire at, so the trigger comes down before the fight
  // starts rather than after it.
  walkRounds: 2,
  // How many times the same soldier may be walked at before the walker leaves it
  // alone. There is no console command that says whether a monster is dead --
  // not even its health, which is drawn on the HUD like the player's -- so
  // "leaving it alone" is not a statement that it died. It is a statement that
  // three legs at it is the most this walker will spend on one of them.
  maxEngagements: 3,
  // ...unless the soldier is this close, in which case the count does not
  // apply and it is shot at until the walk is out of its reach. A soldier at
  // arm's length is the one thing on the floor that can be *blocking* the walk:
  // Quake 2's monsters are solid, a walk that ends against one makes no progress
  // and re-plans into the same wall, and the count -- which exists to stop the
  // walker wasting its budget on a distant soldier it cannot finish -- is the
  // wrong tool for it. A corpse is not solid, so a leg spent on one costs a turn
  // and nothing else; the leg walks the route either way.
  closeRange: 250,
  // How many of the legs spent on a close soldier may come out of the count's
  // exemption rather than the count. Without a cap the exemption is a loop: a
  // run that ended pinned 63 units from a `monster_soldier` spent eight
  // engagements on it and never looked anywhere else, because a soldier inside
  // closeRange is never skipped. Two extra legs is enough to finish a fight that
  // is going to be finished, and few enough that a fight that is not leaves the
  // walk somewhere to go.
  closeEngagements: 2,
  // How far along the plan a leg walks towards, and how far away that point may
  // be. The base walker aims at the farthest route point it can see, which is a
  // straight line between two points the planner cleared -- and clearing a line
  // of *air* is not the same as clearing a *floor*, which is what `clearWalk()`
  // covers below.
  //
  // Measured, on the run that argued for this: a walk that had reached demo1's
  // corridor stopped there 1,660 units short of the exit, with a `monster_soldier`
  // 67 units away and a valid 29-point route to the exit available from where it
  // stood. Distance alone does not say what it was stopped by -- a soldier's own
  // box and the player's do not touch at 67 units -- and the reading that fits
  // the geometry is the chord: the leg aimed at a point beyond the soldier and
  // the floor under that line does not go there. Aiming at the route a few
  // points ahead keeps the leg on the path the planner actually cleared.
  walkAhead: 4,
  walkReach: 240,
  // Half the player's 32x32 box, for the shoulder test a leg's line is held to.
  // A line clear down its centre is not a line a body fits down: the plan's way
  // past demo1's pocket `func_wall` leaves 7 units of margin, which a point
  // sample calls open and a player 32 units across calls a wall. The walker tries this radius
  // first and falls back to the centre line, so a corridor genuinely narrower
  // than the player is still walked.
  bodyRadius: 16,
  // How far a route point has to be from the player before walking to it is
  // worth a leg. This is the bridge's own `goto` tolerance (48): a target
  // inside it comes back `reached` with no step taken, so a leg aimed there is
  // a leg spent standing still -- measured, seven in a row, and the attempt was
  // over with the player at the same (-99,-84,46) it started from.
  minLegReach: 48,
  // How far the player has to move away from an engagement before the count
  // against that soldier starts again. A level restart puts the player back at
  // the spawn, which is this far from anywhere they died, so a fresh attempt
  // fights the same soldiers again rather than walking past their corpses.
  forgetDistance: 600,
  // Whether every firing leg takes a picture of the status bar and reads the
  // player's health and armour off it. Off by default because it costs a
  // screenshot and an image decode per leg, and because a caller that does not
  // want a health record should not pay for one; `finish` turns it on. See
  // control/hud.mjs for why the numbers cannot be had any other way.
  readHud: false,
  // Where to put the per-leg HUD crops. They are the evidence behind the
  // health numbers: a reading that is wrong is visible in the picture it came
  // from, and a report whose numbers cannot be checked is a nicer story than
  // the one that happened.
  hudCropDir: null,
  // Which weapon the fight asks for, named the way the engine's own config
  // names it ("Super Shotgun"). null leaves the player the weapon they walked
  // in with. The press goes through the engine's own `use <weapon>` binding --
  // the same kind of real key event as the trigger, no console -- and a weapon
  // the player does not have is not an error: Quake 2 ignores it and keeps the
  // weapon in hand, so what this buys is measurable and what it costs is one
  // key press per life.
  weapon: null,
  // How a firing leg moves while the trigger is down: "advance" keeps walking
  // the route (the way this walked before the option existed), "retreat" backs
  // along the route away from the soldier being shot, "hold" stands. "adapt"
  // tries each in turn and then follows the health the fight actually cost --
  // see #fireMode, which is the measurement this option exists for.
  fireWhile: "advance",
  // How many firing legs each way of firing is given before "adapt" starts
  // choosing the cheaper one. Two is the smallest number that can show a
  // difference; more would spend the level's health learning instead of
  // walking.
  fireModeWarmup: 2,
  // How far off the route a health or armour pickup may stand and still be
  // walked over on the way past. **On by default at 96, and re-measured.**
  //
  // It was off, because the point-nudge this used to be could not reach anything
  // on demo1 worth having: at 96 it moved two plan points onto the level's two
  // `item_health_small` at route units 629 and 677 for 53 extra units of
  // walking, and the player is at full health when it passes them (the first
  // firing leg of every traced `finish` run is past route unit 900). The one
  // item the route could use -- `item_health_large` at -1176 1520, 50 health, 64
  // units off the route *line* at unit 2,770 -- is more than twice this from any
  // of the plan's own points, because a plan is 37 points over 4,693 units and a
  // step is 130 units long.
  //
  // `pickupDetours` asks the same question of the plan's *steps* and inserts a
  // detour, and that reaches it: measured, `pickupRange: 96` takes exactly one
  // pickup on demo1's exit route -- the `item_health_large` -- and inserts two
  // points for it, the foot of the detour on the line and the item itself, so
  // the plan grows 37 points to 39 and the walk is 123 units longer. The run that used it covered 7,386 units on 30 firing legs for 349
  // health -- 11.63 a leg -- and reached `-951 1550`, 825 units short; the run
  // without it covered 4,426 on 25 legs for 436 -- 17.44 a leg -- and reached
  // `-935 1262`, 887 short. The 62 units between those two deepest readings is
  // inside this level's own run-to-run spread and is not claimed for the
  // top-up; what is claimed for it is the insert, which the run reports, and
  // the 50 health it is worth. Left at 96 rather than raised: the next items out
  // are 208 units off the line, and a 416-unit round trip through a corridor
  // this level shoots down is not a top-up.
  pickupRange: 96,
  // ...and how much of a turn taking it may cost. A pickup is taken on the way
  // past, so a nudge that would bend the route is not a top-up, it is a
  // different route -- measured on demo1, the nearest health item to the exit
  // route is 91 units off it, and nudging demo1's pocket escape onto that item
  // turns the leg through the pocket's own wall-corner. The turn is measured
  // between the bearing the leg had and the bearing the nudge would give it, so
  // a point on a straight run takes a pickup beside it and a corner does not.
  pickupTurn: 45,
  // What a pickup beside a *step* of the plan may cost to collect, as the round
  // trip out to it and back to the line. This is the bound that does the work
  // `pickupTurn` cannot do for an insert (see `pickupDetours`), and it is set
  // from a measurement rather than picked: demo1's `item_health_large` is 64
  // units off the line, so 128 of round trip, and the next item out is the
  // `item_health_small` at -384 80 -- 91 units off the line, 182 of round trip,
  // and the item the pass before this one measured as *harmful* from demo1's
  // pocket ("nudging demo1's pocket escape onto that item turns the leg through
  // the pocket's own wall-corner"). 140 sits between the two: it is above the
  // 50-health item this mechanism exists for and below the 15-health one that
  // was measured to cost a leg. A top-up the walk would pay 280 units of
  // corridor for is not a top-up, it is a different route with an item at the
  // end of it.
  pickupDetour: 140,
};

// Local compass arithmetic, matching the engine's: 0 is +X, 90 is +Y, and the
// yaw grows anticlockwise. bridge.mjs has its own copy of these two; they are
// three lines each and importing them would mean exporting them from the
// browser-facing bridge, which is a worse trade than repeating them.
function bearingTo(from, to) {
  return (Math.atan2(to.y - from.y, to.x - from.x) * (180 / Math.PI) + 360) % 360;
}

function shortestTurn(degrees) {
  let angle = Number(degrees) % 360;
  if (angle > 180) angle -= 360;
  if (angle <= -180) angle += 360;
  return angle;
}

// Which keys walk the player along `wanted` while they are looking at
// `facing`, both in Quake 2's bearings.
//
// Quake 2 moves a player along the view, so the only way to shoot one way and
// walk another is to hold the view and add a strafe: forward is the view,
// `+moveleft` is the view turned a quarter turn anticlockwise, and the four
// diagonals are the two together. Eight directions is enough to be within 22.5
// degrees of any bearing, which is a straighter line than the walk would manage
// if it were re-aimed every step.
//
// This is not decoration. A fighting leg that walks *at* the soldier is a leg
// that walks off the plan and into whatever is beside the corridor: measured on
// demo1, the first such leg travelled 28 units in half a second, the second
// travelled none at all, and the player -- standing still in the open, which is
// the one thing the level punishes -- was dead before the third.
export function movementKeys(facing, wanted) {
  const turn = shortestTurn(Number(wanted) - Number(facing));
  if (!Number.isFinite(turn)) return ["w"];
  const off = Math.abs(turn);
  if (off <= 22.5) return ["w"];
  if (off >= 157.5) return ["s"];
  // Positive is anticlockwise, which is towards `+moveleft`.
  const side = turn > 0 ? "a" : "d";
  if (off <= 67.5) return ["w", side];
  if (off <= 112.5) return [side];
  return ["s", side];
}

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function point(value) {
  if (!value || typeof value !== "object") return null;
  const at = { x: Number(value.x), y: Number(value.y), z: Number(value.z) };
  if (![at.x, at.y, at.z].every(Number.isFinite)) return null;
  return at;
}

// Would a shot fired level from `eye` reach the thing standing at `target`?
//
// The shot is a horizontal line at the eye's own height, which is what the
// engine fires when the view is level, so the question splits in two: is the
// target's body tall enough to be crossed by that line, and is the line clear?
// Both are answered from the level's own data -- the BSP's contents for the
// second, the monster's own box for the first -- and neither needs the browser.
export function levelShotReaches(map, eye, origin, options = {}) {
  if (!eye || !origin) return false;
  // A map with no geometry to ask -- a stub in a test -- has no wall to invent.
  if (!map || typeof map.isSolid !== "function") return true;
  const slack = numberOr(options.slack, 12);
  const low = origin.z - MONSTER_FEET_BELOW_ORIGIN - slack;
  const high = origin.z + MONSTER_HEAD_ABOVE_ORIGIN + slack;
  const eyeZ = eye.z;
  if (eyeZ < low || eyeZ > high) return false;
  const span = Math.hypot(origin.x - eye.x, origin.y - eye.y);
  const steps = Math.max(2, Math.ceil(span / (options.step || 24)));
  for (let index = 1; index < steps; index++) {
    const t = index / steps;
    if (map.isSolid(eye.x + (origin.x - eye.x) * t, eye.y + (origin.y - eye.y) * t, eyeZ)) return false;
  }
  return true;
}

// The four heights a standing player occupies above the floor they are on:
// knees, waist, chest, top of the head. Every clearance test in this module and
// in walker.mjs samples the same four, so that "the player fits" means one thing.
const BODY_LIFTS = [8, 24, 40, 52];

// The corners of a 32x32 player's footprint, as multipliers of a half-width.
// Corners and not a circle, because a doorway is square: a rounded test closes
// a gap the player walks through.
const SHOULDERS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

// Which floor a player crossing at (x, y) would be standing on, looked for from
// `z` outwards: the same height first, then a step up or a step down, whichever
// is nearer. Returns null where there is no floor a player fits on within reach.
//
// This is what makes a walk a *walk*. The old clearWalk sampled the straight
// chord between two route points and lifted the body off that, which is only
// the floor while the floor is level: the route's own second step drops 52
// units in the 24 it takes -- from -120 -72 4 down to -144 -72 -48, just west
// of demo1's start room -- and halfway along that chord the sample is *inside*
// the floor it is supposed to be standing on. Every point on the plan past the
// drop was therefore rejected, every leg collapsed to the nearest next point,
// and the nearest next point is one `goto` answers `reached` to without moving
// -- which is how a walk ends up standing still for a whole attempt and then
// reporting "no progress".
export function floorNear(map, x, y, z, options = {}) {
  if (!map || typeof map.standable !== "function") return null;
  const up = numberOr(options.maxStepUp, 45);
  const down = numberOr(options.maxDrop, 300);
  const step = Math.max(1, numberOr(options.probeStep, 4));
  for (let reach = 0; reach <= Math.max(up, down); reach += step) {
    if (reach <= up && map.standable(x, y, z + reach)) return z + reach;
    if (reach <= down && reach > 0 && map.standable(x, y, z - reach)) return z - reach;
  }
  return null;
}

// Can a standing player walk a straight line between two floors?
//
// The same four heights walker.mjs samples -- knees, waist, chest, head, above
// the feet -- and, just as important, sampled *finely*. demo1's pocket is walled
// in by a `func_wall` 16 units thick in x, and a 16-unit stride steps straight
// over it: a line check that walks in 16-unit strides reports the way clear and
// sends the player into the wall, which is how a walk ends up stopped at
// -427 111 with a valid route to the exit in hand.
//
// `options.radius` is the half-width to insist on: 0 keeps the centre-line test
// the planner's own rows are built on, and 16 is the player's actual 32 units of
// shoulder. A line that is clear down its centre is not a line a body fits down
// -- the plan's way past that same `func_wall` leaves 7 units of margin -- so the
// caller can ask for the wider test and fall back to the narrower one.
export function clearWalk(map, from, to, options = {}) {
  if (!map || typeof map.isSolid !== "function") return true;
  if (!from || !to) return false;
  const radius = Math.max(0, numberOr(options.radius, 0));
  const span = Math.hypot(to.x - from.x, to.y - from.y);
  const steps = Math.max(2, Math.ceil(span / numberOr(options.step, 10)));
  for (let index = 1; index < steps; index++) {
    const t = index / steps;
    const x = from.x + (to.x - from.x) * t;
    const y = from.y + (to.y - from.y) * t;
    const chord = from.z + (to.z - from.z) * t;
    const floor = floorNear(map, x, y, chord, options);
    if (floor === null) {
      // No floor within a step of the line: a gap, a shaft, the middle of a
      // fall. This is the centre-line test the function used to be, kept so
      // that nothing which was walkable before stops being walkable now.
      for (const lift of BODY_LIFTS) if (map.isSolid(x, y, chord + lift)) return false;
      continue;
    }
    for (const lift of BODY_LIFTS) {
      if (map.isSolid(x, y, floor + lift)) return false;
      for (const [ox, oy] of SHOULDERS) {
        if (radius && map.isSolid(x + ox * radius, y + oy * radius, floor + lift)) return false;
      }
    }
  }
  return true;
}

// What in the level's own entity list is worth shooting from here, best first.
//
// `from` is where the player is (the engine reports the eye). `options.bearing`
// is the way the walker is already heading, in degrees; a soldier far behind
// the player is not a soldier this walk can turn for without giving up the
// route, and `answerRange` is where that stops being true -- inside it, a
// soldier is a target whatever the angle, because it can shoot the player
// wherever it stands. Enemies are scored by how much of the fight it costs to
// deal with them now: the distance to walk, plus a penalty for every degree off
// the way forward.
export function threats(map, from, options = {}) {
  const eye = point(from);
  if (!eye) return [];
  const enemies = options.enemies || map.waypoints("enemy");
  const range = numberOr(options.engageRange, ENGAGE_DEFAULTS.engageRange);
  const arc = numberOr(options.engageArc, ENGAGE_DEFAULTS.engageArc);
  const answerRange = numberOr(options.answerRange, ENGAGE_DEFAULTS.answerRange);
  const angleCost = numberOr(options.angleCost, 3);
  const bearing = options.bearing === undefined || options.bearing === null ? null : Number(options.bearing);
  const skip = typeof options.skip === "function" ? options.skip : () => false;
  const out = [];
  for (let index = 0; index < enemies.length; index++) {
    const enemy = enemies[index];
    const origin = point(enemy && enemy.position);
    if (!origin) continue;
    const key = enemy.index === undefined ? index : enemy.index;
    if (skip(key, enemy)) continue;
    const distance = Math.hypot(origin.x - eye.x, origin.y - eye.y);
    if (distance > range) continue;
    let off = 0;
    if (bearing !== null && Number.isFinite(bearing)) {
      off = Math.abs(shortestTurn(bearingTo(eye, origin) - bearing));
      // Off the way forward is only a reason to leave a soldier alone while
      // leaving it alone is cheap. Inside `answerRange` it is not: a soldier
      // that close can shoot the player wherever it stands, and the walker
      // taking damage from one it will not turn for is the measured way a
      // `finish` run dies in demo1's corridor. So the arc decides what is
      // worth *walking towards*, and this decides what has to be answered.
      if (off > arc && distance > answerRange) continue;
    }
    // A soldier close enough to be touching the player is not something to
    // turn the view onto: the bearing to it changes with every step, and the
    // leg would spend its half second spinning instead of firing. It is a
    // collision to be walked out of, not a target, and the walker's own stuck
    // handling is what deals with that. This is deliberately *not* relaxed by
    // `answerRange`: measured on run 7 of the instrument, the one leg that
    // answered a soldier inside this radius (`monster_soldier` at 39 units, 95
    // degrees off) covered 0 units and died on the spot, which is the fault the
    // radius was put here to avoid.
    if (distance < numberOr(options.minimumRange, 40)) continue;
    if (!levelShotReaches(map, eye, origin, options)) continue;
    out.push({
      index: key,
      classname: enemy.classname,
      position: origin,
      distance,
      off,
      score: distance + off * angleCost,
    });
  }
  return out.sort((a, b) => a.score - b.score);
}

// The walker that shoots back. It is the plain walker with one decision
// replaced -- which point the next leg aims at -- plus the one thing that
// decision implies: a leg aimed at a soldier fires on the way there.
export class CombatWalker extends RouteWalker {
  constructor(game, map, options = {}) {
    super(game, map, options);
    this.engage = { ...ENGAGE_DEFAULTS, ...(options.engage || {}) };
    // The level's monsters, indexed once, so the per-leg decision is arithmetic
    // on a list the level gave us rather than a search through the entity lump.
    this.enemies = (map && map.waypoints ? map.waypoints("enemy") : [])
      .filter((enemy) => enemy.position)
      .map((enemy, index) => ({ ...enemy, index }));
    // index -> { count, from }: how many legs have been spent walking at this
    // one, and where the player was standing when that started. See
    // ENGAGE_DEFAULTS.forgetDistance for what clears it.
    this.engagements = new Map();
    // Every firing leg, for the report. `aimed` says whether the turn landed on
    // the soldier; a leg that fired with the turn still short is recorded as
    // such, because that is the difference between "the plan missed" and "the
    // engine would not turn", and only one of those is worth fixing.
    this.fights = [];
    // The level's own health and armour, indexed once. Only the ones the route
    // passes within `pickupRange` of are ever aimed at (see snapPickups), so
    // this is a list of things the level offers rather than a list of errands.
    this.pickups = (map && map.waypoints ? map.waypoints("item") : [])
      .filter((item) => item.position && /^item_(health|armor)/.test(item.classname))
      .map((item) => ({ classname: item.classname, position: finitePoint(item.position) }))
      .filter((item) => item.position);
    // The plan the pickups were snapped onto, and the snapped points. A plan is
    // a fresh array on every re-plan, so the array itself is the cache key.
    this.snapped = null;
    // The pickups that were *inserted* into a plan as waypoints of their own,
    // because they stood beside a step of it and no point of it was close
    // enough to nudge. Kept for the report: "the walk tops up on the way" is a
    // claim about the plan, and this is the plan's own record of it.
    //
    // Accumulated across re-plans rather than replaced by each one, and keyed by
    // the item. A walk re-plans every `maxLegs` legs, from wherever it has got
    // to, and a plan drawn from half way down the level need not contain the
    // step an item stood beside -- so the last call is not a superset of the
    // first. Measured, the first version of this overwrote the record on a
    // later re-plan and a run that had routed over a 50-health item reported
    // none at all.
    this.detours = new Map();
    // One row per way of firing: how many legs it took, and what the status bar
    // says they cost. See #fireMode.
    this.fireModes = new Map();
    // Which attempt of which life the weapon was already asked for (see
    // #ensureWeapon), and the answer.
    this.weaponAsked = null;
    this.weaponSelection = null;
    // The soldier the last leg fired at, so that the next leg can finish it.
    // See _legTarget.
    this.stickTo = null;
  }

  // A route with its points nudged onto the level's own pickups where the
  // pickup is close enough to be walked over anyway.
  //
  // The nudge moves the point's x and y onto the item and keeps the route
  // point's z, because the z is a floor the planner has already cleared and an
  // item's own z is where its centre floats, not where a player stands. A
  // nudge is refused when the line from the point before it to the item is not
  // walkable -- the item is beside a wall, say -- so that a pickup this
  // walker cannot reach without leaving the route costs it nothing.
  snapPickups(points) {
    if (this.snapped && this.snapped.points === points) return this.snapped.result;
    const range = numberOr(this.engage.pickupRange, 0);
    let result = points;
    if (range > 0 && this.pickups.length && Array.isArray(points) && points.length) {
      const claimed = new Set();
      result = points.map((point) => ({ ...point }));
      for (let index = 1; index < result.length; index++) {
        const point = result[index];
        let best = null;
        for (const pickup of this.pickups) {
          const distance = Math.hypot(pickup.position.x - point.x, pickup.position.y - point.y);
          // A pickup the route already runs over needs no nudge: the point is
          // where the item is, and moving it would be this walker walking to
          // where it was going anyway.
          if (distance < 2 || distance > range) continue;
          if (best && distance >= best.distance) continue;
          const key = pickup.classname + pickup.position.x + "," + pickup.position.y;
          if (claimed.has(key)) continue;
          best = { pickup, distance, key };
        }
        if (!best) continue;
        const candidate = { ...point, x: best.pickup.position.x, y: best.pickup.position.y, pickup: best.pickup };
        const previous = result[index - 1];
        const turn = Math.abs(shortestTurn(bearingTo(previous, candidate) - bearingTo(previous, point)));
        if (Number.isFinite(turn) && turn > numberOr(this.engage.pickupTurn, 45)) continue;
        const reachable = clearWalk(this.map, previous, candidate, { radius: this.engage.bodyRadius });
        if (!reachable) continue;
        claimed.add(best.key);
        result[index] = candidate;
      }
      // ...and the same question asked of the plan's *steps*, which the loop
      // above cannot see.
      //
      // A plan is a handful of points spread over thousands of units -- demo1's
      // is 37 points over 4,693, so a step is about 130 units long -- and a
      // pickup that stands 64 units to the side of a step is 225 units from
      // either end of it. Nudging points therefore misses it by a factor of two,
      // and on demo1 the one item the walk could actually use is exactly that
      // case: `item_health_large` at -1176 1520 sits 64 units off the route
      // *line* at route unit 2,770 and more than twice `pickupRange` from any
      // point. It is 50 health, it is on the way in to the exit complex, and
      // the point-based nudge has never once reached it (measured; see README).
      //
      // So a pickup whose perpendicular is close to a step, and whose projection
      // lands in the middle of it, is *inserted* into the plan as a waypoint of
      // its own -- at the foot of the detour and at the item. Every insertion is
      // guarded by a walkable line at each of its three legs, and by
      // `pickupDetour` on what the round trip may cost; `pickupTurn` is not one
      // of the guards, for the reason given at `pickupDetours`.
      const walked = [result[0]];
      for (let index = 1; index < result.length; index++) {
        // A point that is already standing on a pickup is the item; do not look
        // for another one to insert beside it.
        if (!result[index].pickup) {
          for (const detour of this.pickupDetours(walked[walked.length - 1], result[index], range, claimed)) walked.push(detour);
        }
        walked.push(result[index]);
      }
      result = walked;
      for (const point of result) {
        if (!point.detour) continue;
        this.detours.set(point.pickup.classname + point.x + "," + point.y, {
          classname: point.pickup.classname,
          x: point.x, y: point.y, z: point.z,
          offRoute: point.off,
        });
      }
    }
    this.snapped = { points, result };
    return result;
  }

  // The level's own top-ups that stand beside one *step* of the plan, in the
  // order they are passed, as plan points to insert between its two ends.
  //
  // `claimed` is shared with the point nudge above so that one item is walked to
  // once and not twice. Each candidate is bounded by `pickupDetour` -- the round
  // trip out to it and back to the line -- and by three walkable lines: the plan
  // to the foot of the detour, the foot to the item, and the item back on to the
  // plan. `pickupTurn` deliberately does not appear here; see below.
  pickupDetours(from, to, range, claimed) {
    const out = [];
    if (!from || !to) return out;
    const vx = to.x - from.x;
    const vy = to.y - from.y;
    const length2 = vx * vx + vy * vy;
    if (length2 < 1) return out;
    const found = [];
    for (const pickup of this.pickups) {
      const key = pickup.classname + pickup.position.x + "," + pickup.position.y;
      if (claimed.has(key)) continue;
      const t = ((pickup.position.x - from.x) * vx + (pickup.position.y - from.y) * vy) / length2;
      // Near either end the step is not where the pickup is, and the point nudge
      // above has already had its chance at it.
      if (!(t > 0.12 && t < 0.88)) continue;
      const off = Math.hypot(pickup.position.x - (from.x + vx * t), pickup.position.y - (from.y + vy * t));
      if (off > range) continue;
      if (off * 2 > numberOr(this.engage.pickupDetour, ENGAGE_DEFAULTS.pickupDetour)) continue;
      found.push({ pickup, key, t, off });
    }
    found.sort((a, b) => a.t - b.t);
    let previous = from;
    for (const candidate of found) {
      const pickup = candidate.pickup;
      // The item floats; the plan point is a *floor*, so the height comes from
      // the level's own geometry under the item and not from the item's centre.
      const chord = from.z + (to.z - from.z) * candidate.t;
      // The detour is walked from the point on the route line directly beside
      // the item -- the perpendicular -- and that point is inserted into the
      // plan as a waypoint of its own.
      //
      // This is not tidiness, it is the difference between the mechanism
      // working and not working. Without it the detour is approached from the
      // plan's previous *vertex*, which on demo1's 130-unit steps can be a
      // hundred units back up the line and on the far side of a wall: measured,
      // `item_health_large` at -1176 1520 clears from its own perpendicular to
      // within a body's width, and does *not* clear from the vertex at -960
      // 1584 -- 216 units back, behind the wall the two rooms share. The first
      // version of this asked the vertex and refused the one item it was
      // written for.
      const via = { x: from.x + vx * candidate.t, y: from.y + vy * candidate.t };
      const viaFloor = floorNear(this.map, via.x, via.y, chord, this.engage);
      if (viaFloor === null) continue;
      via.z = viaFloor;
      const floor = floorNear(this.map, pickup.position.x, pickup.position.y, chord, this.engage);
      if (floor === null) continue;
      const detour = { x: pickup.position.x, y: pickup.position.y, z: floor, pickup, detour: true };
      detour.off = Math.round(candidate.off);
      // What the detour is allowed to cost is `pickupDetour`, and that is the
      // only shape test it needs. `pickupTurn` is deliberately *not* applied
      // here: it measures a deflection from the line, and every insert is a
      // step straight off the line and back, so its angle is 90 degrees by
      // construction and the knob would refuse all of them -- measured, at 45 it
      // refused the one item this code was written for. A step aside whose
      // round trip is inside `pickupDetour` is a top-up; anything longer is the
      // `pickupTurn`-governed nudge's business or another route's.
      //
      // The line along the route to the foot is tested at the same standard the
      // plan's own rows were built on -- the centre line -- for the same reason:
      // `minLegReach`-style shoulder room is more than the level gives the route
      // itself. Measured, the plan's own step from -960 1584 to -1488 1584 does
      // not clear the shoulder test at any point along it, so requiring it of a
      // part of that same step would refuse the route's own ground.
      const walkable = (a, b) => clearWalk(this.map, a, b, { radius: this.engage.bodyRadius }) ||
        clearWalk(this.map, a, b, { radius: 0 });
      if (!walkable(previous, via)) continue;
      if (!walkable(via, detour)) continue;
      if (!walkable(detour, to)) continue;
      claimed.add(candidate.key);
      out.push(via);
      previous = detour;
      out.push(detour);
    }
    return out;
  }

  // Which way of firing the fight is currently using, and the measurement
  // behind the choice.
  //
  // "adapt" is the whole point of the option: the level decides. Each way is
  // given `fireModeWarmup` legs, and after that the walker uses whichever one
  // has cost the least health per leg according to the status bar. The cost is
  // the drop in health between one firing leg's reading and the next, counted
  // only within a life -- a level restart puts the player back at 100, and
  // charging that to the mode would blame the mode for the death.
  #fireMode() {
    const wanted = this.engage.fireWhile || "advance";
    if (wanted !== "adapt") return wanted;
    const modes = ["advance", "retreat", "hold"];
    const rows = modes.map((mode) => this.fireModes.get(mode)).filter((row) => row && row.legs >= numberOr(this.engage.fireModeWarmup, 2));
    if (rows.length < modes.length) {
      // Still learning: take the mode with the fewest legs so far.
      let best = modes[0];
      for (const mode of modes) {
        const legs = (this.fireModes.get(mode) || { legs: 0 }).legs;
        if (legs < (this.fireModes.get(best) || { legs: 0 }).legs) best = mode;
      }
      return best;
    }
    let best = rows[0];
    for (const row of rows) {
      const cost = row.healthSpent === null ? Infinity : row.healthSpent / Math.max(1, row.legs);
      const bestCost = best.healthSpent === null ? Infinity : best.healthSpent / Math.max(1, best.legs);
      if (cost < bestCost) best = row;
    }
    return best.mode;
  }

  // Record what one firing leg cost, so #fireMode has something to choose on.
  #recordFireMode(mode, covered, reading) {
    const row = this.fireModes.get(mode) || { mode, legs: 0, covered: 0, healthSpent: null, healthReadings: 0 };
    row.legs++;
    row.covered += covered;
    if (reading && typeof reading.health === "number") {
      row.healthReadings++;
      const before = this.lastHealth;
      // A reading that went *up* is a pickup, not a cost, and a reading after a
      // restart is a different life: neither is charged to the mode.
      if (typeof before === "number" && before >= reading.health) row.healthSpent = (row.healthSpent === null ? 0 : row.healthSpent) + (before - reading.health);
      this.lastHealth = reading.health;
    }
    this.fireModes.set(mode, row);
  }

  // Ask the engine for the weapon once per life, through the engine's own
  // `use <weapon>` binding. Done at the first firing leg rather than at the
  // start of the attempt, because the first thing a restarted level does is put
  // the player back on the spawn with the spawn's own weapon, and a switch made
  // before that is a switch thrown away.
  async #ensureWeapon(attempt, life) {
    const wanted = this.engage.weapon;
    if (!wanted) return null;
    // Keyed on the attempt *and* the life, not on the attempt alone.
    //
    // A death restarts the level and hands the player the level's own starting
    // loadout, and the walker does not spend an attempt on that restart (see
    // `attempt--` in walker.follow) -- so the same attempt number comes round
    // again on a spawn where the weapon this asked for is no longer carried.
    // Keyed on the attempt alone, the switch asked for before the death would
    // count as already made, and every life after the first would be fought
    // with the blaster while the report said the level's own shotgun.
    const key = String(attempt) + ":" + String(life === undefined || life === null ? 0 : life);
    if (this.weaponAsked === key) return this.weaponSelection;
    if (typeof this.game.selectWeapon !== "function") return null;
    this.weaponAsked = key;
    this.weaponSelection = await this.game.selectWeapon(wanted).catch((error) => ({ selected: false, weapon: wanted, reason: error.message }));
    this._note(this.weaponSelection && this.weaponSelection.selected
      ? "asked for the level's own " + wanted
      : "could not ask for " + wanted, this.weaponSelection || undefined);
    return this.weaponSelection;
  }

  // How many times this soldier has been walked at from roughly where the player
  // stands now. Counted from a position, not from the start of the run, so that
  // a level restart -- which puts the player back at the spawn, hundreds of
  // units from wherever they fell -- hands every soldier a clean slate.
  #spent(index, position) {
    const seen = this.engagements.get(index);
    if (!seen) return 0;
    if (Math.hypot(seen.from.x - position.x, seen.from.y - position.y) > this.engage.forgetDistance) {
      this.engagements.delete(index);
      return 0;
    }
    return seen.count;
  }

  #spend(index, position) {
    const spent = this.#spent(index, position);
    this.engagements.set(index, { count: spent + 1, from: { x: position.x, y: position.y, z: position.z } });
    return spent + 1;
  }

  // Where a fighting leg walks towards: the route a few points along the plan
  // from wherever the player is, kept inside walkReach so that the direction is
  // the path's own and not a long chord across it. It falls back to the next
  // point when even that is too far, and to whatever it was given when there is
  // no plan at all (a caller driving the walker leg by leg).
  #walkPoint(position, points) {
    if (!Array.isArray(points) || !points.length) return null;
    let nearest = 0;
    let best = Infinity;
    for (let index = 0; index < points.length; index++) {
      const distance = Math.hypot(points[index].x - position.x, points[index].y - position.y);
      if (distance < best) { best = distance; nearest = index; }
    }
    // The player's feet, because a route point is a floor and the engine reports
    // the eye (see EYE_ABOVE_FEET).
    const feet = { x: position.x, y: position.y, z: position.z - EYE_ABOVE_FEET };
    // The point the player is *nearest to* is where the plan says they are, and
    // that is not the same as where they have got to. The planner snaps the
    // start of a route onto the nearest floor, so a walk that stops 111 units
    // short of the plan's own first point still reads as "nearest to point 1" --
    // which is exactly what demo1's pocket does, from -427 111. Aiming only at
    // points *after* the nearest one then aims at point 2, whose straight line
    // crosses the 16-unit `func_wall` the pocket is walled by, and the leg stops
    // dead against it twice and the attempt is abandoned -- measured, on two
    // consecutive attempts, with the plan's own way out sitting at point 1.
    //
    // So the nearest point is a target too, whenever the player has not
    // actually arrived at it: `minLegReach` is `goto`'s own arrival radius, and
    // inside it the walker is standing on the point it is nearest to.
    const short = Math.hypot(points[nearest].x - position.x, points[nearest].y - position.y) <= this.engage.minLegReach;
    const stop = short ? nearest + 1 : nearest;
    // A point that has to be jumped to is never walked past: the jump is aimed
    // and timed one point at a time (see walker.mjs), so the leg stops there.
    const last = Math.min(nearest + this.engage.walkAhead, points.length - 1);
    for (let index = stop; index <= last; index++) {
      if (points[index].jump) return points[index];
    }
    // Farthest first, and back towards the player until one of them can be
    // *walked to* and not merely seen: a plan point across a wall is a leg that
    // ends against it, and a walk that ends against a wall is a walk that stops
    // still in the open, which is the one thing demo1 punishes.
    const within = [];
    for (let index = last; index >= stop; index--) {
      const distance = Math.hypot(points[index].x - position.x, points[index].y - position.y);
      if (distance > this.engage.walkReach) continue;
      // ...and never at one the player is already standing inside the leg's own
      // arrival radius of. `goto()` is asked for a point with a tolerance of
      // `max(24, tolerance/2)` -- 48 on a `finish` run -- and it answers
      // `reached` to a target it is already inside that of *without taking a
      // step*. A leg aimed at one is a leg spent standing still: the position
      // does not move, the walker's own `moved > 8` test calls it a stall, and
      // the attempt loses one of its eight legs. Measured, this is what the
      // walk was doing at -438 13 on demo1: the only plan point past it that
      // cleared the shoulder test was 21 units away, `goto` returned `reached,
      // rounds: 0, 0 units covered`, and legs 5, 6 and 7 of the attempt covered
      // 3, 0 and 0 units in a row -- with a clear 166-unit line to a point four
      // further along the plan sitting right there unused.
      if (distance <= this.engage.minLegReach) continue;
      within.push(points[index]);
    }
    // Farthest first, and the shoulders first *for each candidate*: the margin
    // is a preference about a line, not about which point to aim at, and the
    // two loops used to be written the other way round -- the radius outermost,
    // so every candidate was tried with the shoulder test before any was tried
    // without it, and a point 21 units away that a body fits down beat a point
    // 166 units away that only the centre line cleared. A short leg is not a
    // cheaper leg: it spends one of the attempt's eight legs to cross a fifth
    // of the ground, and at 21 units it spends one to cross none.
    for (const candidate of within) {
      for (const radius of [this.engage.bodyRadius, 0]) {
        if (clearWalk(this.map, feet, candidate, { ...this.engage, radius })) return candidate;
      }
    }
    // Nothing on the plan could be walked to at all. Hand back the nearest point
    // that is still worth a leg -- and never one the player is already inside
    // `goto`'s own tolerance of, because that comes back `reached` without a
    // step taken and the leg is spent standing still.
    for (let index = stop; index <= last; index++) {
      if (Math.hypot(points[index].x - position.x, points[index].y - position.y) > this.engage.minLegReach) return points[index];
    }
    return points[Math.min(stop, points.length - 1)];
  }

  // The seam: aim at a soldier when one is standing where the route goes, and at
  // the route point when none is. The route point is still computed first, and
  // still decides the cone -- a walk that turns for a soldier behind it is a
  // walk that has stopped going anywhere.
  _legTarget(position, points) {
    // The near point first, for every leg and not only the firing ones. The base
    // walker aims at the farthest route point it can see, which is a *chord*
    // across the plan: it is checked for a clear line, not for a walkable floor,
    // and on demo1 that is enough to walk the player into the dead-end pocket at
    // -427 111 and stall there -- measured, with the walker's own note naming
    // that position and the two `func_wall`s it was standing against. Following
    // the plan point by point costs a re-decision every leg and cannot cut a
    // corner, because the points it aims at are points the planner cleared.
    // The level's own pickups sitting on the plan are folded into the plan
    // before anything is aimed at, so a walk past one is a walk *over* one.
    points = this.snapPickups(points);
    const near = this.#walkPoint(position, points);
    const route = near || super._legTarget(position, points);
    if (!route || !this.enemies.length) return route;
    const bearing = bearingTo(position, route);
    const found = threats(this.map, position, {
      ...this.engage,
      bearing,
      enemies: this.enemies,
      skip: (index, enemy) => {
        const spent = this.#spent(index, position);
        if (spent < this.engage.maxEngagements) return false;
        const close = Math.hypot(enemy.position.x - position.x, enemy.position.y - position.y) <= this.engage.closeRange;
        return !(close && spent < this.engage.maxEngagements + this.engage.closeEngagements);
      },
    });
    if (!found.length) {
      this.stickTo = null;
      return route;
    }
    // Finish what the last leg started, when it is still a target.
    //
    // The list is scored fresh every leg -- distance plus a penalty for every
    // degree off the way forward -- and a soldier's score changes with every
    // step the player takes, so the *best* target changes while the fight is
    // going on. What the per-leg record of four traced `finish` runs shows is
    // the fire never settling: legs aimed at `monster_soldier` at 127 to 407
    // units, with the aim landing on every one and the trigger down on every
    // one, and the player dead at 1 health on the leg after the record starts.
    // A Quake 2 soldier is 30 health and goes on shooting until it is dead, so
    // the soldier the last leg shot at is the soldier this leg shoots at, until
    // the `skip` above takes it out of `found` -- which is what ends it when it
    // is out of range, out of the fight, or out of the budget, and what a
    // soldier that dies simply does by no longer being there.
    const kept = this.stickTo === null || this.stickTo === undefined
      ? null
      : found.find((candidate) => candidate.index === this.stickTo);
    const target = kept || found[0];
    this.stickTo = target.index;
    this._note("a soldier is on the way; looking at it with the trigger down", {
      classname: target.classname,
      at: target.position,
      distance: Math.round(target.distance),
      offCourseDegrees: Math.round(target.off),
      attempt: this.#spend(target.index, position),
    });
    // z is the player's own eye height: the aim is deliberately level, so that
    // what the weapon is pointed at is a line the level shot can actually reach
    // (see the note at the top of this file). The `route` the leg walks is the
    // near one -- see walkAhead -- because the far one may lie straight through
    // the soldier being shot at, and a monster is solid.
    return { x: target.position.x, y: target.position.y, z: position.z, enemy: target, route: this.#walkPoint(position, points), jump: 0 };
  }

  async _leg(target, options) {
    if (!target || !target.enemy) {
      // A leg with nothing to shoot still has to be short, because the decision
      // to shoot is only taken between legs. See walkRounds.
      const rounds = Math.max(1, Math.min(options.maxRounds || 40, this.engage.walkRounds));
      return super._leg(target, { ...options, maxRounds: rounds });
    }
    return this.#fight(target, options);
  }

  // One firing leg: look at the soldier, hold the trigger down, walk the route,
  // let the trigger up.
  //
  // The walk is the part that matters, and it is the route -- not the soldier.
  // Walking at what is being shot at is what a first attempt does and what the
  // level punishes twice: the aim leaves the plan, the leg ends against a wall
  // beside the corridor, the player stops moving in the open, and a stopped
  // player is dead inside a few seconds (measured: 100 health and no armour
  // becomes a corpse in six seconds of standing still in demo1's corridor,
  // while the whole walk in costs nothing). So the leg faces the soldier and
  // walks the way the walker was already going, with the strafe key that keeps
  // the two apart.
  async #fight(target, options) {
    const before = await this.game.position();
    // No position to aim from is not a reason to skip the leg: falling through
    // to the ordinary step reports the miss honestly instead of throwing.
    if (!before || !before.position) return super._leg({ ...target, enemy: undefined }, options);
    const aim = { x: target.x, y: target.y, z: before.position.z };
    const facing = bearingTo(before.position, aim);
    // Where to walk: at the route point the leg would have aimed at had there
    // been no soldier. A leg that has lost its route point walks where it looks,
    // which is the best a leg can do with nothing to go on.
    const walkBearing = target.route ? bearingTo(before.position, target.route) : facing;
    const stepMs = numberOr(options.engageStepMs, this.engage.engageStepMs);
    // The press is asked for and reported on: a trigger the engine never took
    // is a leg that walked and aimed and did not shoot, and saying otherwise
    // would make the fight summary a nicer story than the one that happened.
    //
    // Through the mouse, not the console. `+attack` as a console command opens
    // and shuts the in-game console twice for one firing leg, and the console
    // pauses the game -- which is a strange thing for a leg to be doing while
    // it is trying to measure a fight. `mouseHold` presses the button the
    // engine's own config already binds to `+attack`; the console path is kept
    // for a game object that has no mouse (the stubs in `scripts/route-test.mjs`).
    // Which weapon the fight is using, asked of the engine's own config once
    // per life. The press lands before the trigger goes down so that the first
    // leg of the life is already firing the weapon the level gave out.
    await this.#ensureWeapon(options && options.attempt, this.restarts);
    const press = typeof this.game.mouseHold === "function"
      ? await this.game.mouseHold("left", true)
      : await this.game.attackHold(true);
    let walked = null;
    let aimed = null;
    // Which way this leg walks while it shoots (see #fireMode). "retreat" walks
    // the route backwards -- away from the soldier being shot at, still on the
    // plan; "hold" stands, which the level punishes and which is here as the
    // third thing to measure rather than as a recommendation. `null` is the
    // bearing-means-nothing case: see #turnOnTheMove.
    const mode = this.#fireMode();
    const walk = mode === "hold" ? null : (mode === "retreat" ? walkBearing + 180 : walkBearing);
    // The keys the leg is walking on. Computed from the view the player has at
    // the start of the leg and re-computed after the turn, because Quake 2 walks
    // a player along the view: the same key is a different direction after the
    // view has moved. See #turnOnTheMove.
    let keys = walk === null ? [] : movementKeys(facing, walk);
    try {
      walked = await this.#turnOnTheMove(before, facing, walk, keys, stepMs, options);
      aimed = walked.aimed;
      keys = walked.keys;
    } finally {
      // The trigger comes up even if the walk threw: fire is also the key that
      // leaves the death camera, and a stuck trigger would respawn the player
      // onto the engine's autosave instead of the level's own spawn.
      if (typeof this.game.mouseHold === "function") await this.game.mouseHold("left", false);
      else await this.game.attackHold(false);
    }
    const after = await this.game.position();
    const at = (after && after.position) || before.position;
    const record = {
      classname: target.enemy.classname,
      // Where the soldier was and how far off the way forward it stood: which
      // soldier a leg cost health to is only answerable if the leg says who it
      // was fighting and where.
      enemyAt: target.enemy.position,
      enemyDistance: Math.round(target.enemy.distance),
      fired: !!press.held,
      aimed: !!(aimed && aimed.facing),
      aimError: aimed && aimed.error !== undefined ? Math.round(aimed.error) : null,
      keys,
      offCourseDegrees: Math.round(shortestTurn(walkBearing - facing)),
      from: before.position,
      at,
      travelled: Math.round(Math.hypot(at.x - before.position.x, at.y - before.position.y)),
      holdMs: walked ? walked.heldMs : 0,
      // How much of the leg the turn took, and how long the leg held its keys.
      // The turn used to be the whole leg -- it was made standing still and the
      // walking happened after it -- so these two numbers are how "the leg walks
      // through its turn" is checkable from a run's own record rather than
      // believed from this file.
      turnMs: walked && walked.turnMs !== undefined ? walked.turnMs : null,
      fireMode: mode,
      // The pickup this leg's route point was nudged onto, if any: evidence
      // that "the walk tops up as it passes" is what happened rather than what
      // was intended.
      pickupOnRoute: target.route && target.route.pickup ? target.route.pickup.classname : null,
      dead: !!(after && after.dead),
    };
    // The one reading the engine will not give: how much of the player is left
    // after this leg. Taken here, with the trigger up, because that is the
    // only moment the status bar is showing the player's own state rather than
    // a death camera -- and because a leg is the unit the fight is fought in.
    const health = await this.#readHud(options);
    if (health) Object.assign(record, health);
    // What this leg cost, by the way it was fought. This is the number
    // `fireWhile: "adapt"` chooses on, and it is recorded whether or not the
    // choice is being made, so a run can be read back and argued with.
    this.#recordFireMode(mode, record.travelled, health);
    this.fights.push(record);
    return { ...(after || { position: before.position }), fired: !!press.held, position: at };
  }

  // One firing leg's movement: the player is walking the route before the turn
  // starts, keeps walking through it, and is still walking when the leg ends.
  //
  // This is the leg's whole defence and it used to be missing. A leg built out
  // of `face()` and then `walkKeys()` turns first and walks afterwards, and the
  // turn is the longer half: the arrow keys turn at cl_yawspeed -- 140 degrees a
  // second -- and face() caps one round at 900 ms, so a soldier 90 degrees off
  // the way forward is over half a second of a half-second leg spent standing
  // still, and a soldier behind the player is more. Standing still in demo1's
  // corridor with full health and no armour was measured to end in a corpse in
  // six seconds; walking the same ground into the same soldiers costs nothing.
  // A leg that stands still for most of itself is therefore not fighting, it is
  // dying, and the fix is the one a player uses without thinking about it: hold
  // the movement keys down *first* and turn while they are held.
  //
  // The keys have to be re-chosen after the turn, and that is not a detail.
  // Quake 2 moves a player along the view, so `movementKeys(facing, wanted)`
  // answers "which keys walk `wanted` while looking at `facing`" -- and `facing`
  // is a different direction once the turn lands. Left as they were, a leg that
  // turned a quarter turn would keep walking the bearing it started with a
  // quarter turn away. Both sets are returned so the caller can report which
  // keys the leg actually walked on.
  async #turnOnTheMove(before, facing, walkBearing, startKeys, stepMs, options) {
    // `walkBearing === null` is the caller asking the leg to *stand*: the turn
    // is still made and the trigger is still held, but no movement key goes
    // down. It exists for `fireWhile: "hold"`, which is the third thing that
    // setting puts up against the other two -- standing in demo1's corridor
    // with full health and no armour was measured to end in a corpse in six
    // seconds, so this is a case to be measured, not a recommendation.
    const faceOptions = {
      from: before,
      tolerance: numberOr(options.faceTolerance, 6),
      rounds: numberOr(options.faceRounds, 4),
    };
    // A game object that cannot hold a key apart from the call that sends it --
    // the stubs in scripts/route-test.mjs -- keeps the old shape: turn, then
    // walk. It is the half of this file's own argument that measurably loses,
    // and it is here only so that an object with no input state still runs.
    if (typeof this.game.holdKeys !== "function") {
      const aimed = await this.game.face(facing, faceOptions);
      const keys = walkBearing === null ? [] : movementKeys(facing, walkBearing);
      const walked = await this.game.walkKeys(keys, stepMs, options);
      return { aimed, keys, heldMs: walked ? walked.heldMs : 0, turnMs: null };
    }
    // Down before the first turn: the leg is moving before it has turned a
    // degree, which is the whole point of this method.
    let keys = walkBearing === null ? [] : startKeys;
    let aimed = null;
    let turnMs = 0;
    try {
      // The press goes inside the `try` so that the `finally` below covers it.
      // A key-down that throws on the way out -- the bridge's own `holdKeys`
      // catches a refused key, but a session that dies while the keys are going
      // down does not -- would otherwise leave movement keys held with nothing
      // left to lift them, and a key left down is a player walking into a wall
      // for the rest of the run. Releasing keys that were never pressed costs a
      // keyup the engine ignores.
      if (keys.length) await this.game.holdKeys(keys, true);
      const turnedAt = Date.now();
      aimed = await this.game.face(facing, faceOptions);
      turnMs = Date.now() - turnedAt;
      const yaw = aimed && aimed.yaw !== undefined ? aimed.yaw : facing;
      const after = walkBearing === null ? [] : movementKeys(yaw, walkBearing);
      if (after.join(",") !== keys.join(",")) {
        // Release before pressing: a key held down and pressed again is one key
        // hold, not two, and the direction it is held on is the first one.
        await this.game.holdKeys(keys, false);
        await this.game.holdKeys(after, true);
        keys = after;
      }
      // The leg lasts `stepMs` of walking, counted from the moment the keys went
      // down -- so the turn is spent walking rather than added to the leg. A
      // soldier far off the way forward costs ground to answer, not health.
      const rest = stepMs - turnMs;
      if (rest > 0) await new Promise((resolve) => setTimeout(resolve, rest));
    } finally {
      // The keys come up whatever happened above: a leg that throws with a
      // movement key still down is a player walking into a wall for the rest of
      // the run. Nothing is released for a leg that held nothing.
      if (keys.length) await this.game.holdKeys(keys, false);
    }
    return { aimed, keys, heldMs: Math.max(turnMs, stepMs), turnMs };
  }

  // The player's own state off the status bar, and the picture it was read
  // from. Never throws: a leg that could not be measured is a leg with no
  // health reading, which the summary says out loud rather than filling in.
  async #readHud(options) {
    if (!this.engage.readHud) return null;
    if (typeof this.game.evaluate !== "function" || typeof this.game.screenshot !== "function") return null;
    const where = "a" + (options && options.attempt !== undefined ? options.attempt : "?") +
      (options && options.leg !== undefined ? "l" + options.leg : "");
    try {
      const shot = await hudShot(this.game);
      const reading = readHealth(shot.png, shot.readOptions);
      let crop = null;
      let cropReason = null;
      if (this.engage.hudCropDir) {
        // Saving the picture is evidence-keeping, not measuring, and a
        // write that fails must not throw away a reading that succeeded:
        // a full disk would otherwise turn every leg into `health: null`
        // and the run's own report would blame the status bar.
        try {
          fs.mkdirSync(this.engage.hudCropDir, { recursive: true });
          crop = path.join(this.engage.hudCropDir,
            "leg-" + where + "-" + String(this.fights.length + 1).padStart(3, "0") + ".png");
          fs.writeFileSync(crop, shot.png);
        } catch (error) {
          crop = null;
          cropReason = error.message;
        }
      }
      return {
        health: reading.health,
        healthScore: reading.healthReading ? Number(reading.healthReading.score.toFixed(3)) : null,
        healthMargin: reading.healthReading ? Number(reading.healthReading.margin.toFixed(3)) : null,
        armour: reading.armour ? reading.armour.value : null,
        barNumbers: reading.numbers.map((number) => number.value),
        hudCrop: crop,
        ...(cropReason ? { hudCropReason: cropReason } : {}),
      };
    } catch (error) {
      this._note("could not read the status bar", { reason: error.message });
      return { health: null, healthReason: error.message };
    }
  }

  // The same walk the base class runs, plus a summary of the fight so far --
  // a count of firing legs, how many of them the turn actually landed on, and
  // the health the player had left after each of them. The health series is the
  // point of the summary: "the fight got better" is not a claim a run can make
  // about itself on the strength of a body count, and this is the number that
  // can be checked leg by leg.
  async follow(goal, options = {}) {
    const result = await super.follow(goal, options);
    const measured = this.fights.filter((fight) => typeof fight.health === "number");
    return {
      ...result,
      combat: {
        enemiesInLevel: this.enemies.length,
        firingLegs: this.fights.length,
        onTarget: this.fights.filter((fight) => fight.aimed).length,
        healthReadings: measured.length,
        // A restart puts the player back at 100, so this is the lowest the
        // fight ever took them, not the lowest reading of one life.
        minHealth: measured.length ? Math.min(...measured.map((fight) => fight.health)) : null,
        lastHealth: measured.length ? measured[measured.length - 1].health : null,
        // What each way of firing cost, so "this one is cheaper" is a claim
        // about the run rather than about the walker's opinion. `healthSpent`
        // is the drop between consecutive readings within one life, and null
        // means no two readings ever landed next to each other.
        fireModes: [...this.fireModes.values()].map((row) => ({
          mode: row.mode,
          legs: row.legs,
          covered: Math.round(row.covered),
          healthReadings: row.healthReadings,
          healthSpent: row.healthSpent,
          spentPerLeg: row.healthSpent === null ? null : Number((row.healthSpent / Math.max(1, row.legs)).toFixed(2)),
        })),
        weapon: this.weaponSelection,
        onRoutePickups: [...new Set(this.fights.map((fight) => fight.pickupOnRoute).filter(Boolean))],
        // What the plan itself was routed over: one entry per pickup inserted as
        // a waypoint, with where it stands off the line. A run whose plan
        // contains one did walk over it; whether the player was still alive at
        // the time is the trail's answer and not this one's.
        pickupDetours: [...this.detours.values()],
        fights: this.fights,
      },
    };
  }
}

export default CombatWalker;
