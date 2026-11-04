// engine-state.js -- the harness's live view of the running engine.
//
// The ClawBox control harness (control/bridge.mjs) has to know where the player
// is and which way they are looking. Until now the only way to ask was the
// engine's own console: type `viewpos`, `condump` the answer to a file, read the
// file back. That works, but the console is a pause -- opening it stops the
// simulation -- so every reading froze the game, and a walk was measured in
// frozen slices. This file removes the console from the hot path entirely: the
// engine's own live state is read out of the WASM linear memory the page already
// owns, and the bridge picks it up with Runtime.evaluate.
//
// This is a classic script, loaded before app.js. It touches nothing at load
// time: `wasmMemory` does not exist until the engine's own loader runs. Every
// call re-reads `wasmMemory.buffer`, because the engine can grow the memory and
// a stale view would then be detached.
//
// ---------------------------------------------------------------------------
// Where the offsets came from (no offset here is a guess)
// ---------------------------------------------------------------------------
// engine/index.wasm keeps its data section but NOT its name section (the only
// custom section is `dylink.0`), so there are no symbols to look up. The fields
// below were recovered by scanning the live image, anchored by facts the engine
// itself produced, and each is backed by an independent check:
//
//   refdef vieworg / viewangles (the three floats `viewpos` prints)
//     The engine's `viewpos` prints `position: %i %i %i, angles: %i %i %i` --
//     integer truncations of two consecutive vec3_t. Reading the console's own
//     answer beside a windowed scan of the heap for float triples inside those
//     integer windows left 7 candidate triples. Turning and walking the player
//     and re-scanning left the pair at 0x597c8 / 0x597d4. Those two addresses
//     are exactly 12 bytes apart, which is `refdef_t`'s layout (vec3_t vieworg
//     immediately followed by vec3_t viewangles), and over six samples taken at
//     six different poses -- including one taken mid-motion and one while the
//     death camera held the view -- Math.trunc() of each of the six floats
//     equalled the six integers `viewpos` printed, every time.
//
//   cls key_dest (whether the console or the menu owns the keyboard)
//     Three snapshots of 4 MiB of the heap around one console toggle (closed,
//     open, closed) left four words that ran 0 -> 1 -> 0; one more toggle
//     showed 0x8d8b8 flipping between two values as the console opened and
//     shut, and pressing Escape then showed it holding 3 while the engine's own
//     menu was up. Which end was which was settled by drawing the page rather
//     than by naming the ends: with the word reading 0 the frame is a clean
//     in-game view -- no console, no PAUSED -- and with it reading 1 the console
//     and PAUSED are both on screen. So 0 is the game, 1 is the console and 3
//     is the menu, read off the engine rather than assumed, which is Quake 2's
//     own keydest_t order. The bridge uses it to prove the console stayed shut.
//
//   the player's own stats (health, and the ammo the HUD draws)
//     `cl.frame.playerstate.stats` is a 32-entry array sitting immediately
//     after the player state's `fov` (90.0f) and `rdflags`, and on this build
//     its entries are int16, not int: 32 * 2 bytes = 64, and the 32nd entry
//     ends exactly where the next field of the structure starts. Five
//     snapshots of the low image, one per weapon (spawn, Machinegun, Shotgun,
//     Railgun, BFG10K), were diffed offline: exactly one 32-entry int16 window
//     in the image changed with the weapon. Its entry 1 read 100 in every
//     state, the number the HUD draws as health, and entry 3 read 200 / 100 /
//     50 / 200 -- the ammo the HUD drew at the same moment. A second live run
//     selected eight weapons with their own number-key binds and showed what
//     entry 2 is: machinegun and chaingun (both bullets) share entry 2 = 14
//     and ammo 200, shotgun and super shotgun (both shells) share entry 2 = 9
//     and ammo 100, while railgun, BFG10K and rocket launcher each read their
//     own icon and count. So entry 2 is the *ammo type's icon index*, not a
//     weapon, and the array carries the ammo type and count but not the
//     current weapon -- this is the classic Quake 2 stat layout (HEALTH_ICON
//     0, HEALTH 1, AMMO_ICON 2, AMMO 3, ARMOR_ICON 4, ARMOR 5), and stock
//     Quake 2 has no weapon entry in it. Firing confirmed the ammo entry: with
//     `+attack` held it fell from 200 to 198 (and 200 to 197 in an earlier
//     run) while the weapon word did not move, and the entries that identify
//     the array stayed put. The screenshot HUD is not a witness while firing
//     -- the digit reader misreads the ammo field just after a burst -- which
//     is why the HUD cross-check is quoted only for the settled states.
//
//   the current weapon: `cl.frame.playerstate.gunindex`
//     The player state's own weapon field is the model index of the
//     first-person weapon model (`gunindex`), a 32-bit word immediately before
//     `gunframe`, `blend[4]`, `fov` and `stats`. Eight weapons were selected
//     with their own number-key binds and the word read 36 (Blaster), 64
//     (Shotgun), 68 (Machinegun), 69 (Chaingun), 70 (Super Shotgun), 71
//     (Railgun), 72 (BFG10K) and 73 (Rocket Launcher) -- distinct for every
//     weapon, including the pairs that share an ammo type and therefore read
//     identically in `stats`. It is a model index, not Quake 2's 1..10 weapon
//     number: model indices are assigned in precache order, so the same weapon
//     can read differently on another level. On one level it changes with the
//     weapon and with nothing else, which is what a gate needs; a caller that
//     wants a weapon number should not read it as one.
//
// What was NOT recovered, and is therefore reported as null rather than
// guessed: health and armour, and the game DLL's own edict fields. This
// build's game module (engine/game_baseq2.wasm) carries no name section either,
// and no anchor for those fields survived this pass. The documented edict base
// (control/edicts.mjs) did not hold on this build -- the game heap moves
// between boots -- and the edicts were not located in the time available, so
// the checks above are against the HUD, the engine's own drawn output, rather
// than against the game-side edict. See README.md.

(function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Offsets into the WASM linear memory, in bytes. See the provenance above.
  // ---------------------------------------------------------------------
  var VIEWORG = 366536; // 0x0597c8  cl.refdef.vieworg[3],   float32 x3
  var VIEWANGLES = 366548; // 0x0597d4  cl.refdef.viewangles[3], float32 x3
  var KEYDEST = 579768; // 0x08d8b8  cls.key_dest, int32

  // `cls.key_dest` as this build stores it, measured rather than assumed:
  // 0 while the game is playing, 1 while the console is up, 3 while the game's
  // own menu is up. 2 is the enum's remaining member and was never observed on
  // this build, so it is named "unknown" with everything else.
  var KEYDEST_GAME = 0;
  var KEYDEST_CONSOLE = 1;
  var KEYDEST_NAMES = { 0: "game", 1: "console", 3: "menu" };

  // ---------------------------------------------------------------------
  // The current weapon: `cl.frame.playerstate.gunindex`, int32
  // ---------------------------------------------------------------------
  // Provenance is the block at the top of this file. `gunindex` is the model
  // index of the first-person weapon model, and it is the only field of the
  // player state that identifies the weapon: the stats array next to it groups
  // weapons by ammo type. It is published here as `weaponIndex` with that
  // caveat spelled out for callers.
  var GUNINDEX = 362544; // 0x058830  cl.frame.playerstate.gunindex, int32
  var GUNFRAME = 362548; // 0x058834  cl.frame.playerstate.gunframe, int32
  var MAX_GUNINDEX = 65535; // a model index, never negative or absurd

  // A gunindex of 0 is real: it is "no weapon model", which is what the state
  // reads before the level has handed the player anything. A gunindex outside
  // the range above is not this field at all -- the memory has moved, or has
  // not been laid out yet -- and is reported as unreadable rather than passed
  // on.

  // ---------------------------------------------------------------------
  // The player's own stats: `cl.frame.playerstate.stats`, int16 x 32
  // ---------------------------------------------------------------------
  // Provenance is the block at the top of this file. The indexes below are
  // measured, not assumed. HEALTH matched the health the HUD drew and stayed
  // put across weapon switches; AMMO matched the HUD in the settled weapon
  // states and fell when firing; AMMO_ICON is the ammo *type*, which is why
  // machinegun and chaingun share it and cannot be told apart here. There is
  // no weapon index in the array: the weapon is GUNINDEX above.
  var STATS = 362576; // 0x058850  cl.frame.playerstate.stats, int16 x 32
  var STATS_COUNT = 32;
  var STAT_HEALTH = 1; // int16, 100 at spawn -- the health the HUD draws
  var STAT_AMMO_ICON = 2; // int16, the ammo type's icon index (14=bull, 9=shell)
  var STAT_AMMO = 3; // int16, the number the HUD draws, falls with firing

  // A stats array that does not hold a plausible health is not this array --
  // the memory has moved, or has not been laid out yet. Reporting that is
  // better than publishing whatever two bytes happen to be there as ammo 0.
  // Zero is allowed: a dead player's health stat is 0.
  var MAX_STAT_HEALTH = 1000;

  // ---------------------------------------------------------------------
  // The live entity array: `cl_entities`
  // ---------------------------------------------------------------------
  // Where the player's own view comes from is one field; where *everything
  // else* is comes from another, and a harness that wants to aim at a monster
  // has to have the second one. `cl_entities` is the client's own array of the
  // entities the server has sent for this frame -- 1024 `centity_t`, 276 bytes
  // each, static in the image -- and every record opens with the
  // `entity_state_t` the server sent.
  //
  // Recovered the same way as the fields above: by matching live records
  // against facts the engine itself produced, never by looking for a plausible
  // number. Record 283 held `origin = -856 584 -24` with `angles = 0 -90 0`,
  // which is the `monster_soldier_light` the level's own entity lump places at
  // `-856 584 -24` facing 270; record 284 sat exactly 276 bytes after it and
  // named itself 284; record 1 held the player's own origin, moving when the
  // player moved. The fields inside a record were then read off those facts:
  // `number` 0x00 and `origin` 0x04 are what the match used, `angles` 0x10 is
  // the angle the lump gives that monster, and `solid` 0x48 reads 8290 for
  // every monster and 0 for every item, which is the box a soldier is given.
  var EDICTS = 595280; // 0x91550  cl_entities[0]
  var EDICT_STRIDE = 276; // sizeof(centity_t)
  var MAX_EDICTS = 1024;

  // Offsets into one record, into its first entity_state_t.
  var EDICT_FIELDS = {
    number: 0x00,
    origin: 0x04,
    angles: 0x10,
    oldOrigin: 0x1c,
    modelindex: 0x28,
    modelindex2: 0x2c,
    modelindex3: 0x30,
    modelindex4: 0x34,
    frame: 0x38,
    skinnum: 0x3c,
    effects: 0x40,
    renderfx: 0x44,
    solid: 0x48,
    sound: 0x4c,
    event: 0x50,
  };

  // The view roll is how a reader learns the player is dead without a
  // screenshot, and the threshold has to sit between the two reasons Quake 2
  // rolls the view -- an order of magnitude apart.
  //
  // A *hit* kicks the view. Measured on a live player fighting through demo1's
  // corridor, that kick reached 1.57 degrees while the status bar was showing
  // 100 health at the same moment: the four moments a one-degree threshold
  // called death carried rolls of 1.21, 1.25, 1.57 and 1.57 beside health
  // readings of 100, 100, 100 and 52. *Strafing* leans it too, and further:
  // Yamagi Quake II has a `cl_rollangle` that stock Quake 2 does not, measured
  // on a live player on demo1 at one reading per CDP round trip -- standing
  // still 0, walking forward at most 0.72, and strafing up to 2.00 over 47
  // samples of pure strafe, none above 2.0. The fight walker's own
  // `movementKeys()` strafes on every firing leg, so that population is not a
  // corner case: at a threshold of 1, 24 of the 171 readings taken while
  // walking a player into demo1's corridor were called deaths by a roll the
  // player was strafing through, and a false death is not cosmetic -- the
  // walker restarts the level for one, which puts the player back at the spawn.
  //
  // A *death* rolls the view much further: the death camera held 27.28 degrees
  // in the corridor run, 39 when this offset was first recovered, and exactly
  // 40 held over the whole death when a player was walked into demo1's soldiers
  // with nothing fired. Ten is five times the largest non-death roll measured
  // (2.00) and less than half the smallest death (27.28), so it reads a death
  // early in its roll without ever reading a strafe as one.
  // control/bridge.mjs carries the same number for the same reason and decides
  // the same question for itself, because a page that is already running keeps
  // the script it loaded.
  var ROLL_IS_DEATH = 10;

  // A reading further from the origin than this is not a map this engine has;
  // it means the memory moved under us, and it is reported as untrustworthy
  // rather than passed on as a position.
  var MAX_COORDINATE = 1e6;

  // Only the fallback cadence: the watch normally samples once per rendered
  // frame through the engine's own requestAnimationFrame.
  var WATCH_INTERVAL_MS = 16;

  function memory() {
    return typeof wasmMemory !== "undefined" && wasmMemory ? wasmMemory.buffer : null;
  }

  function inRange(buffer, address, bytes) {
    return !!buffer && address >= 0 && address + bytes <= buffer.byteLength;
  }

  function finite(value) {
    return typeof value === "number" && Number.isFinite(value);
  }

  // Three consecutive float32s, or null if the memory cannot be trusted to hold
  // them. The view is built fresh every call: the engine grows its heap, and a
  // Float32Array kept from an earlier call would be a detached view.
  function triple(buffer, address) {
    if (!inRange(buffer, address, 12)) return null;
    var f = new Float32Array(buffer, address, 3);
    var out = [f[0], f[1], f[2]];
    return finite(out[0]) && finite(out[1]) && finite(out[2]) &&
      Math.abs(out[0]) < MAX_COORDINATE && Math.abs(out[1]) < MAX_COORDINATE && Math.abs(out[2]) < MAX_COORDINATE
      ? out
      : null;
  }

  // The view is kept and rebuilt only when the buffer it was taken from has
  // been replaced, which happens when the engine grows its memory (the old
  // ArrayBuffer is detached then). Building it fresh on every call would
  // allocate once per rendered frame for as long as the page lives, and the
  // console watch calls this every frame.
  var keyDestView = null;

  function keyDest(buffer) {
    if (!inRange(buffer, KEYDEST, 4)) return null;
    if (keyDestView === null || keyDestView.buffer !== buffer) keyDestView = new Int32Array(buffer, KEYDEST, 1);
    return keyDestView[0];
  }

  // The current weapon's model index, or { reason } when the word cannot be
  // trusted. Built fresh every call for the same reason as `triple`: the
  // engine can grow its heap. Called from `read()`, never from the frame loop.
  function gunindex(buffer) {
    if (!inRange(buffer, GUNINDEX, 4)) return { reason: "GUNINDEX_OUT_OF_RANGE" };
    var value = new Int32Array(buffer, GUNINDEX, 1)[0];
    if (!(value >= 0 && value <= MAX_GUNINDEX)) {
      return { reason: "GUNINDEX_IMPLAUSIBLE", value: value };
    }
    return { value: value };
  }

  // The ammo count from the stats array, or { reason } when it cannot be
  // trusted. The health entry is read only to check the array's identity: a
  // window whose health is not a plausible health is not this array.
  function stats(buffer) {
    if (!inRange(buffer, STATS, STATS_COUNT * 2)) return { reason: "STATS_OUT_OF_RANGE" };
    var view = new Int16Array(buffer, STATS, STATS_COUNT);
    var health = view[STAT_HEALTH];
    if (!(health >= 0 && health <= MAX_STAT_HEALTH)) return { reason: "STATS_IMPLAUSIBLE", health: health };
    return { ammo: view[STAT_AMMO] };
  }

  // Each number a caller asked for, or null with its own reason. The two are
  // read from different structures, so one being unreadable does not make the
  // other a null. `health` is deliberately not forwarded here -- this pass did
  // not recover it and the reading is only used to check the array's identity.
  function statFields(weapon, reading) {
    var weaponOk = !!weapon && weapon.reason === undefined;
    var ammoOk = !!reading && reading.reason === undefined;
    return {
      weaponIndex: weaponOk ? weapon.value : null,
      ammo: ammoOk ? reading.ammo : null,
      weaponIndexReason: weaponOk ? null : (weapon && weapon.reason) || "GUNINDEX_UNREADABLE",
      ammoReason: ammoOk ? null : (reading && reading.reason) || "STATS_UNREADABLE",
    };
  }

  // One reading of the engine, as JSON-serialisable data.
  //
  // `ok: false` and a `reason` mean the memory is not up yet, or the engine has
  // not laid out the structures at the addresses measured above. Nothing is
  // reported as a zero when it is really unknown.
  function read() {
    var buffer = memory();
    if (!buffer) {
      var unloaded = statFields({ reason: "ENGINE_NOT_LOADED" }, { reason: "ENGINE_NOT_LOADED" });
      return {
        ok: false,
        reason: "ENGINE_NOT_LOADED",
        source: "wasm-memory",
        position: null,
        angles: null,
        weaponIndex: unloaded.weaponIndex,
        ammo: unloaded.ammo,
        weaponIndexReason: unloaded.weaponIndexReason,
        ammoReason: unloaded.ammoReason,
      };
    }
    var org = triple(buffer, VIEWORG);
    var ang = triple(buffer, VIEWANGLES);
    var dest = keyDest(buffer);
    var statsFields = statFields(gunindex(buffer), stats(buffer));
    if (!org || !ang) {
      return {
        ok: false,
        reason: "STATE_UNREADABLE",
        source: "wasm-memory",
        position: null,
        angles: null,
        keyDest: dest,
        weaponIndex: statsFields.weaponIndex,
        ammo: statsFields.ammo,
        weaponIndexReason: statsFields.weaponIndexReason,
        ammoReason: statsFields.ammoReason,
      };
    }
    var dead = Math.abs(ang[2]) > ROLL_IS_DEATH;
    return {
      ok: true,
      source: "wasm-memory",
      position: { x: org[0], y: org[1], z: org[2] },
      angles: { pitch: ang[0], yaw: ang[1], roll: ang[2] },
      keyDest: dest,
      keyDestName: KEYDEST_NAMES[dest] || "unknown",
      // The console and the menu both take the keyboard away from the game and
      // both make the engine draw PAUSED while it is a single-player level.
      inGame: dest === KEYDEST_GAME,
      consoleOpen: dest === KEYDEST_CONSOLE,
      paused: dest !== KEYDEST_GAME,
      dead: dead,
      // Reported as null on purpose: this pass did not recover these fields,
      // and a made-up zero would be worse than an honest gap. `alive` is
      // derived from the view roll, separately from the lean the same build
      // puts on a strafing player, and says so.
      alive: !dead,
      aliveSource: "view-roll-above-strafe-lean",
      health: null,
      armour: null,
      // The two numbers the input gate asserts on. Each is either an integer
      // the engine itself wrote -- the weapon model index, and the ammo count
      // from the stats array -- or null with its own reason.
      weaponIndex: statsFields.weaponIndex,
      ammo: statsFields.ammo,
      weaponIndexReason: statsFields.weaponIndexReason,
      ammoReason: statsFields.ammoReason,
      readAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------
  // The live entity array
  // ---------------------------------------------------------------------
  // Every entity the client is holding for this frame, as plain data. A slot
  // whose `number` is zero is one the engine is not using -- `number` is the
  // entity's own index in this array, so a used slot always names itself -- and
  // a record whose origin is not a finite, on-map coordinate is skipped rather
  // than reported, because a wrong position is worse than a missing one.
  //
  // The view is built fresh on every call: the engine grows its heap and a view
  // kept from an earlier call would be detached. It is not called from the
  // frame loop -- the console watch below is the only thing that runs that
  // often -- so the allocation is one per call and not one per frame.
  function entities() {
    var buffer = memory();
    if (!buffer) return null;
    var dv = new DataView(buffer);
    var list = [];
    for (var index = 0; index < MAX_EDICTS; index++) {
      var slot = EDICTS + index * EDICT_STRIDE;
      if (slot + EDICT_STRIDE > buffer.byteLength) break;
      // A record holds the entity's current state first and its previous state
      // 84 bytes in (`entity_state_t` is 84 bytes on this build). Almost every
      // slot names itself in the first copy; the client's own player does not
      // -- its current copy reads zero and its previous one carries the live
      // state -- so take whichever copy names itself and skip the slot if
      // neither does.
      var off = slot;
      var number = dv.getInt32(off + EDICT_FIELDS.number, true);
      if (number === 0) {
        off = slot + 84;
        number = dv.getInt32(off + EDICT_FIELDS.number, true);
      }
      if (number === 0) continue;
      var x = dv.getFloat32(off + EDICT_FIELDS.origin, true);
      var y = dv.getFloat32(off + EDICT_FIELDS.origin + 4, true);
      var z = dv.getFloat32(off + EDICT_FIELDS.origin + 8, true);
      if (!finite(x) || !finite(y) || !finite(z)) continue;
      if (Math.abs(x) >= MAX_COORDINATE || Math.abs(y) >= MAX_COORDINATE || Math.abs(z) >= MAX_COORDINATE) continue;
      list.push({
        number: number,
        copy: off === slot ? "current" : "previous",
        position: { x: x, y: y, z: z },
        angles: {
          pitch: dv.getFloat32(off + EDICT_FIELDS.angles, true),
          yaw: dv.getFloat32(off + EDICT_FIELDS.angles + 4, true),
          roll: dv.getFloat32(off + EDICT_FIELDS.angles + 8, true),
        },
        modelindex: dv.getInt32(off + EDICT_FIELDS.modelindex, true),
        modelindex2: dv.getInt32(off + EDICT_FIELDS.modelindex2, true),
        frame: dv.getInt32(off + EDICT_FIELDS.frame, true),
        skinnum: dv.getInt32(off + EDICT_FIELDS.skinnum, true),
        effects: dv.getInt32(off + EDICT_FIELDS.effects, true),
        renderfx: dv.getInt32(off + EDICT_FIELDS.renderfx, true),
        solid: dv.getInt32(off + EDICT_FIELDS.solid, true),
      });
    }
    return list;
  }

  // ---------------------------------------------------------------------
  // The console watch
  //
  // The bridge reports how many times *it* opened the console. That is a claim
  // about the bridge. This is the page's own, independent record: it samples
  // `cls.key_dest` and counts every sample where the keyboard was not the
  // game's, so a console toggle that came from anywhere -- a stray key, another
  // client on the same CDP endpoint, the bridge itself -- is on the record.
  //
  // It samples from inside the engine's own frame loop, not from a timer. That
  // is not a detail: a console opened by a client typing over CDP is up for
  // only a handful of frames, and while the keys are being dispatched the
  // page's main thread is busy enough that setInterval callbacks do not fire --
  // measured, a 100 ms timer saw nothing at all during a probe that per-frame
  // sampling showed the console open for ten frames. A timer would have
  // reported "the console was never opened" about a console that was up.
  //
  // Each sample creates one Int32Array and reads one word. It does not touch
  // the canvas, the file system or the engine's own state.
  // ---------------------------------------------------------------------
  var watch = {
    running: false,
    driver: null,
    samples: 0,
    nonGameSamples: 0,
    consoleSamples: 0,
    menuSamples: 0,
    transitions: 0,
    firstNonGameAt: null,
    lastNonGameAt: null,
    startedAt: null,
    _timer: null,
    _last: null,
  };

  function sample() {
    var buffer = memory();
    if (!buffer) return;
    var dest = keyDest(buffer);
    watch.samples++;
    if (dest !== KEYDEST_GAME) {
      watch.nonGameSamples++;
      if (dest === KEYDEST_CONSOLE) watch.consoleSamples++;
      if (dest === 3) watch.menuSamples++;
      var at = new Date().toISOString();
      if (watch.firstNonGameAt === null) watch.firstNonGameAt = at;
      watch.lastNonGameAt = at;
    }
    if (watch._last !== null && watch._last !== dest) watch.transitions++;
    watch._last = dest;
  }

  // One sample per rendered frame, scheduled through the engine's own
  // requestAnimationFrame. setTimeout is the fallback for a page where the
  // engine's loop has not been set up (or has been torn down).
  function schedule() {
    if (typeof Module !== "undefined" && Module && typeof Module.requestAnimationFrame === "function") {
      watch.driver = "frame";
      Module.requestAnimationFrame(sampleFrame);
      return;
    }
    watch.driver = "timer";
    watch._timer = setTimeout(sampleFrame, WATCH_INTERVAL_MS);
  }

  function sampleFrame() {
    if (!watch.running) return;
    sample();
    schedule();
  }

  function startWatch() {
    if (watch.running) return watch.stats();
    watch.running = true;
    watch.startedAt = new Date().toISOString();
    watch._last = null;
    schedule();
    return watch.stats();
  }

  function stopWatch() {
    watch.running = false;
    if (watch._timer !== null) clearTimeout(watch._timer);
    watch._timer = null;
    return watch.stats();
  }

  function resetWatch() {
    watch.samples = 0;
    watch.nonGameSamples = 0;
    watch.consoleSamples = 0;
    watch.menuSamples = 0;
    watch.transitions = 0;
    watch.firstNonGameAt = null;
    watch.lastNonGameAt = null;
    watch.startedAt = new Date().toISOString();
    watch._last = null;
    return watch.stats();
  }

  watch.stats = function () {
    return {
      running: watch.running,
      driver: watch.driver,
      startedAt: watch.startedAt,
      samples: watch.samples,
      nonGameSamples: watch.nonGameSamples,
      consoleSamples: watch.consoleSamples,
      menuSamples: watch.menuSamples,
      transitions: watch.transitions,
      firstNonGameAt: watch.firstNonGameAt,
      lastNonGameAt: watch.lastNonGameAt,
      keyDestAddress: KEYDEST,
      // The whole point: a run where the engine never read PAUSED has zero
      // non-game samples and zero transitions.
      clean: watch.nonGameSamples === 0,
    };
  };
  watch.start = startWatch;
  watch.stop = stopWatch;
  watch.reset = resetWatch;

  // `state()` is what the bridge calls: one reading, and the watch running so
  // the reading is backed by a continuous record.
  function state() {
    startWatch();
    return { read: read(), watch: watch.stats() };
  }

  // One word, no allocation: the renderer samples cls.key_dest at every frame
  // clear, and read() builds a whole reading (arrays and a timestamp) for a
  // caller that only wants this number. Null until the memory is up.
  function keyDestNow() {
    var buffer = memory();
    return buffer ? keyDest(buffer) : null;
  }

  window.quake2Engine = {
    version: 1,
    keyDest: keyDestNow,
    offsets: {
      vieworg: VIEWORG,
      viewangles: VIEWANGLES,
      keyDest: KEYDEST,
      edicts: EDICTS,
      edictStride: EDICT_STRIDE,
      maxEdicts: MAX_EDICTS,
      gunindex: GUNINDEX,
      gunframe: GUNFRAME,
      stats: STATS,
      statsCount: STATS_COUNT,
      statsEncoding: "int16",
      statHealth: STAT_HEALTH,
      statAmmoIcon: STAT_AMMO_ICON,
      statAmmo: STAT_AMMO,
    },
    read: read,
    entities: entities,
    state: state,
    watch: watch,
    // The engine's name for the memory, for anything that wants to read it
    // itself. Null until the engine has booted.
    buffer: memory,
  };
})();
