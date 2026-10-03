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
// What was NOT recovered, and is therefore reported as null rather than
// guessed: health, armour, ammo, and the game DLL's own edict fields. This
// build's game module (engine/game_baseq2.wasm) carries no name section either,
// and no anchor for those fields survived this pass. See README.md.

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

  // The view rolls only when the engine hands the view to the death camera
  // (Quake 2 has no lean), so a non-zero roll is how a reader learns the player
  // is dead without a screenshot. Measured at 39 degrees on the death camera.
  var ROLL_IS_DEATH = 1;

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

  function keyDest(buffer) {
    if (!inRange(buffer, KEYDEST, 4)) return null;
    return new Int32Array(buffer, KEYDEST, 1)[0];
  }

  // One reading of the engine, as JSON-serialisable data.
  //
  // `ok: false` and a `reason` mean the memory is not up yet, or the engine has
  // not laid out the structures at the addresses measured above. Nothing is
  // reported as a zero when it is really unknown.
  function read() {
    var buffer = memory();
    if (!buffer) {
      return { ok: false, reason: "ENGINE_NOT_LOADED", source: "wasm-memory", position: null, angles: null };
    }
    var org = triple(buffer, VIEWORG);
    var ang = triple(buffer, VIEWANGLES);
    var dest = keyDest(buffer);
    if (!org || !ang) {
      return {
        ok: false,
        reason: "STATE_UNREADABLE",
        source: "wasm-memory",
        position: null,
        angles: null,
        keyDest: dest,
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
      // derived from the view roll, which was measured, and says so.
      alive: !dead,
      aliveSource: "view-roll",
      health: null,
      armour: null,
      ammo: null,
      readAt: new Date().toISOString(),
    };
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

  window.quake2Engine = {
    version: 1,
    offsets: {
      vieworg: VIEWORG,
      viewangles: VIEWANGLES,
      keyDest: KEYDEST,
    },
    read: read,
    state: state,
    watch: watch,
    // The engine's name for the memory, for anything that wants to read it
    // itself. Null until the engine has booted.
    buffer: memory,
  };
})();
