// control/edicts.mjs -- read the GAME DLL's own edicts: every entity's health,
// and whether it is dead.
//
// Why this exists
// ---------------
// The client's entity array (`cl_entities`, control/loop.mjs) is the NETWORK
// state: it carries origin, angles, model index, frame and effects, and no
// health at all. That is why every pass before this one could only guess at a
// hit from an animation frame moving, and measured zero -- an idle monster's
// frame does not move, so a frame that moves is a hit, but nothing moves when a
// shot misses, and nothing says how much health was taken when one lands.
//
// The game DLL is a side module of the engine's own wasm: `game_baseq2.wasm`
// imports `env.memory` (measured -- `WebAssembly.Module.imports`), so its
// `g_edicts` array is in the SAME linear memory the page already reads the
// player and the entity array out of. It is simply further along:
//
//     base   0x35EA250   (`g_edicts[0]`)
//     stride 892         (`sizeof(edict_t)` on this build)
//     count  1024        (`MAX_EDICTS`)
//
// and `edict[i].s` is an `entity_state_t` at the same offsets the client array
// uses, which is the anchor the whole thing was found by.
//
// How it was found, and how it is checked
// ---------------------------------------
// A record search over the whole 128 MiB image, not a guess at an address:
// every 4-byte word equal to the `solid` box a monster's `entity_state_t`
// carries (8290) whose record also had `modelindex` 44 thirty-two bytes before
// it and its own `number` seventy-two bytes before that. The client's own array
// satisfies that signature by construction; the second set of records that did
// -- at 0x35EA250, 892 bytes apart -- is the game DLL's edicts. Three checks
// hold on it. Two of them are re-run on every reading the harness takes, by the
// code that consumes this one: the walk below keeps only slots whose first word
// is their own index (the array naming itself), and `healthOf` checks the origin
// agreement and counts what disagreed. The third -- health against the entity's
// class -- was measured once, and the live replacement for it is the player's
// own health checked against the status bar every run (`crossCheck`, counted in
// control/loop.mjs), which is ground truth this reading did not supply.
//
//   * `edict[i].s.number === i` for every used slot (the array names itself);
//   * a monster edict's `s.origin` equals the client's network origin for the
//     same entity number (measured across all 15 of demo1's soldiers);
//   * every monster's health equals its class's own health -- 20 for
//     `monster_soldier_light`, 30 for `monster_soldier`, 40 for
//     `monster_soldier_ss` (measured: 15 of 15).
//
// The player's own health is the cross-check that matters most, because it has
// ground truth the harness did not have to trust any offset for: the status bar
// (control/hud.mjs) reads it off the screen. Field `+0x1e0` came back 100/100
// for the player and 40/30/20 for the soldiers, which is the health a
// `monster_soldier_ss`/`_soldier`/`_soldier_light` is given and nothing else in
// the record is.
//
// What could not be read
// ----------------------
// `classname` is a pointer into the game DLL's string data and is NOT read
// here; monsters are named from the level's own entity lump, exactly as
// `control/loop.mjs` already does. `deadflag` was not pinned down by value this
// pass (the word after `max_health` is -30 on every soldier, which is not a
// deadflag) -- so "dead" here means `health <= 0`, which is the game's own
// state for it, and the field that is read is labelled with which of the two it
// came from.

// The shape of one edict, as measured. Everything is an offset into the record.
export const EDICT_LAYOUT = {
  base: 0x35ea250,
  stride: 892,
  max: 1024,
  // `entity_state_t`, the same offsets control/loop.mjs uses for cl_entities:
  // the two structures are the same type and this is the anchor the array was
  // found by.
  number: 0x00,
  origin: 0x04,
  modelindex: 0x28,
  solid: 0x48,
  // The game-side fields, past the entity state.
  health: 0x1e0,
  maxHealth: 0x1e4,
  // The word after `max_health`. It is NOT deadflag -- it reads -30 on every
  // live soldier -- and nothing here reads it as one. Kept only so a later pass
  // can see what was looked at.
  afterMaxHealth: 0x1e8,
};

// The raw walk, as JavaScript for the page. Exported as source text rather than
// a function because it has to run in the page's own context, against the
// page's `wasmMemory`, in the SAME evaluate as the player read and the entity
// read -- a loop that read the world in two evaluates would be deciding on two
// different frames.
//
// `buf` and `DataView` are passed in by the caller so this can be spliced into
// an outer expression that has already resolved the memory (the page's heap can
// grow between calls, so the buffer must be taken fresh each time).
export function edictWalkSource() {
  const L = EDICT_LAYOUT;
  return `(function () {
    const base = ${L.base}, stride = ${L.stride}, max = ${L.max};
    const dv = new DataView(buf);
    const out = [];
    for (let i = 1; i < max; i++) {
      const at = base + i * stride;
      if (at + ${L.maxHealth + 4} > buf.byteLength) break;
      // The array names itself: a used slot's first word is its own index. A
      // freed slot keeps a stale number, which is why the reader does not stop
      // at the first mismatch and why a caller cross-checks the origin.
      if (dv.getInt32(at + ${L.number}, true) !== i) continue;
      const x = dv.getFloat32(at + ${L.origin}, true);
      const y = dv.getFloat32(at + ${L.origin + 4}, true);
      const z = dv.getFloat32(at + ${L.origin + 8}, true);
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
      const health = dv.getInt32(at + ${L.health}, true);
      const maxHealth = dv.getInt32(at + ${L.maxHealth}, true);
      const modelindex = dv.getInt32(at + ${L.modelindex}, true);
      // A slot with no model, no box and no health is not something the game is
      // using; it is dropped here rather than carried as a zero.
      if (modelindex === 0 && health === 0 && maxHealth === 0 && dv.getInt32(at + ${L.solid}, true) === 0) continue;
      out.push({ number: i, x, y, z, modelindex, health, maxHealth });
    }
    return out;
  })()`;
}

// ---------------------------------------------------------------------------
// The node side: what an edict reading means
// ---------------------------------------------------------------------------

// How far an edict's origin may sit from the client's own origin for the same
// entity before the reading is not about the same thing. The two are written in
// the same frame for a monster at rest and can differ by a few units while one
// is lerped; 96 units is loose enough for that and far too tight for a different
// entity (an entity's own box is 32 units across).
export const ORIGIN_TOLERANCE = 96;

// Index a raw edict walk by entity number.
export function byNumber(edicts) {
  const map = new Map();
  for (const edict of Array.isArray(edicts) ? edicts : []) {
    if (!edict || !Number.isFinite(edict.number)) continue;
    map.set(edict.number, edict);
  }
  return map;
}

// The game's own answer for one entity: its health, and whether it is dead.
//
// "Dead" is `health <= 0` and says so. There is no second, independent field
// read here, and a caller that wants to be told the difference between "health
// ran out" and "the engine says it is gone" has to get that from the entity
// array (the entity stops being sent at all is a different fact, and
// control/loop.mjs already watches it).
export function liveOf(edict) {
  if (!edict) return null;
  const health = Number.isFinite(edict.health) ? edict.health : null;
  return {
    number: edict.number,
    health,
    maxHealth: Number.isFinite(edict.maxHealth) ? edict.maxHealth : null,
    dead: health !== null && health <= 0,
    alive: health !== null && health > 0,
  };
}

// Does the edict array agree with the client's entity array about where this
// entity is? This is the check that keeps a stale slot -- a freed edict whose
// number has not been cleared -- from being read as a live monster with someone
// else's health.
export function originAgrees(edict, entity, tolerance = ORIGIN_TOLERANCE) {
  if (!edict || !entity || !entity.position) return false;
  const span = Math.hypot(edict.x - entity.position.x, edict.y - entity.position.y, edict.z - entity.position.z);
  return span <= tolerance;
}

// Match an edict reading against the client's live monster list. Returns the
// monsters with their health attached, and a count of how many could not be
// matched -- which is reported rather than hidden, because a monster the edict
// array cannot vouch for is a monster whose health this pass did not read.
export function healthOf(monsters, edicts, options = {}) {
  const tolerance = Number.isFinite(options.tolerance) ? options.tolerance : ORIGIN_TOLERANCE;
  const index = byNumber(edicts);
  const out = [];
  let unmatched = 0;
  let disagreed = 0;
  for (const monster of Array.isArray(monsters) ? monsters : []) {
    const edict = index.get(monster.number);
    // `entitySource` is the caller's own name for where the monster came from,
    // kept because "no edict" does not mean the same thing for both kinds of
    // caller. A monster read from the LIVE entity array is keyed by its entity
    // number, so no edict behind it means the game does not have that entity.
    // A monster from the level's static list (`staticMonsters` in
    // control/loop.mjs) is keyed by its place in that list, which was never an
    // entity number at all -- so a caller cannot use "no edict" to decide
    // anything about those without throwing the whole fallback away. See
    // `#withHealth`.
    if (!edict) {
      unmatched += 1;
      out.push({ ...monster, health: null, maxHealth: null, dead: null, source: "no-edict", entitySource: monster.source || null });
      continue;
    }
    // A monster the caller handed over with no position at all: `staticMonsters`
    // in control/loop.mjs passes the level's own `enemy.position` straight
    // through, and an entity lump whose origin will not parse gives `undefined`.
    // `originAgrees` already refuses that reading; the error MEASUREMENT has to
    // refuse it too, or the mismatch is reported by throwing a TypeError out of
    // a function whose whole job is to report what it could not read.
    const measured = monster.position
      ? Math.round(Math.hypot(edict.x - monster.position.x, edict.y - monster.position.y, edict.z - monster.position.z) * 10) / 10
      : null;
    const agreed = originAgrees(edict, monster, tolerance);
    if (!agreed) disagreed += 1;
    const live = liveOf(edict);
    out.push({
      ...monster,
      health: live.health,
      maxHealth: live.maxHealth,
      dead: live.dead,
      source: agreed ? "game-edict" : "game-edict-origin-disagrees",
      originError: measured,
      // Where the GAME says the monster is, carried beside the client's own
      // reading so a caller can choose. It is the same pair `originError` is the
      // distance between, and it is here because the two are not equally true:
      // see the note on `#withHealth` in control/loop.mjs for the measurement
      // that settled which of them a player should aim at.
      edictPosition: { x: edict.x, y: edict.y, z: edict.z },
    });
  }
  return { monsters: out, unmatched, disagreed, edicts: index.size };
}
