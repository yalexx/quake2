// control/fast.mjs -- ITERATION MODE: run the level as fast as this engine accepts.
//
// ############################################################################
// # THIS IS A CHEAT MODE. IT IS FOR ITERATION ONLY. A RUN MADE WITH IT IS NOT  #
// # A FINISH AND MUST NEVER BE REPORTED AS ONE. The finish proof is a          #
// # normal-speed, `cheats 0` walk in which the engine itself prints            #
// # `"mapname" is "demo2"` -- every number this module produces has to be      #
// # labelled as coming from iteration mode, and the normal path has to be      #
// # left intact and ready.                                                     #
// ############################################################################
//
// Why it exists
// -------------
// A `play` run of demo1 costs 4 to 5 minutes of wall clock at the engine's own
// speed (measured this pass: 400 ticks in 37 s at the default 80 ms tick). Most
// of that is the game's own simulation clock, not the harness: the loop can only
// make about 30 decisions a second and the level takes minutes to walk. So the
// only lever that moves the wall clock by a factor is the engine's own
// `timescale`, which multiplies the server's frame time -- the game runs N
// seconds of Quake 2 per second of our clock.
//
// What this module does
// ---------------------
//   1. Render/sound cost, and the frame cap. Cheap and NOT a cheat: they change
//      nothing about the simulation, only how long a frame takes to draw. The
//      HUD read in control/hud.mjs is frame-locked (it grabs the WebGL buffer
//      inside the engine's own requestAnimationFrame), so more frames per second
//      is also a faster loop.
//   2. `timescale N`, which DOES change the simulation. `timescale` is cheat
//      protected in this build (it is registered with CVAR_CHEAT), so turning it
//      on means typing `cheats 1` first. That is the only cheat this mode uses.
//      God, noclip, give and teleport are not used here or anywhere else.
//
// How the cvars are set, and why it is the console
// ------------------------------------------------
// The Qwasm2 build exports no cvar or command accessor to JS (its wasm exports
// are libc and SDL only -- see control/bridge.mjs), so there is no way to write
// a cvar from the harness directly. The two routes are (a) console commands and
// (b) a config file the engine `exec`s at startup. This module uses (a): the
// engine's console through `QuakeControl.command()`, in TWO round trips, one to
// read the values that are there now and one to set them and read them back.
// Each round trip opens the console briefly, and the engine pauses while it is
// open -- the first run therefore pays a second or two of pause once, not once
// per command. Route (b) was rejected because the engine's mount is IDBFS-backed
// and restored from the save store only at page load (app.js `restoreUserData`),
// so a config file written to disk would need the kiosk page reloaded to be seen.
//
// Restoring
// ---------
// `leaveFastMode()` puts back exactly what was there before -- it reads the
// values first and restores THOSE, rather than assuming a default -- and always
// ends on `cheats 0`. A run that dies mid-way still leaves the game as it found
// it, because the driver calls it from a `finally`.

// The env var and the CLI flag that turn the whole thing on.
export const FAST_ENV = "QUAKE2_FAST";
export const FAST_FLAG = "--fast";

// Timescale. QUAKE2_FAST_TIMESCALE picks the multiplier; 0 or 1 means "do the
// render/sound speed-up but leave the simulation alone", which is a legitimate
// way to iterate without touching a cheat at all.
export const FAST_TIMESCALE_ENV = "QUAKE2_FAST_TIMESCALE";
export const FAST_TIMESCALE_DEFAULT = 2;
// What the console walk in `scripts/fast-probe.mjs` tried, in order. The engine
// is asked for each one and its own answer is what the report quotes.
export const FAST_TIMESCALE_CHOICES = [1, 2, 3, 5, 10];

// The render/sound/frame-cap half. None of these changes the simulation.
//
// The names are this build's, and they are not the ones a first guess would
// reach for: the active renderer here is `ref_gles3` (app.js passes
// `+set vid_renderer gles3`), and its cvars are mostly `r_*`. The `gl_*` family
// that `ref_gl1` and the soft renderer register -- `gl_picmip`, `gl_drawflat`,
// `gl_shadows`, `gl_dynamic` and the rest -- is NOT registered on this
// configuration; typing one at the console gets `Unknown command`, which is
// measured and written down in the pass's own report rather than assumed. So
// there is no `r_picmip`/`gl_picmip` lever here at all, and the render cost is
// cut with the levers the gles3 renderer does own.
//
// Resolution is deliberately NOT in the default set. The health read
// (control/hud.mjs) picks the status bar's digits out of the frame by template
// matching, and a small `r_mode` shrinks those digits with it; the loop would
// trade a faster frame for an unreadable HUD. `QUAKE2_FAST_RES=1` adds it for a
// caller who does not need the health series.
export const FAST_RENDER_CVARS = [
  { name: "cl_maxfps", value: "-1", why: "uncapped client frames (already -1 here, kept explicit)" },
  { name: "vid_maxfps", value: "0", why: "uncapped display frames (the engine ships 300)" },
  { name: "s_initsound", value: "0", why: "no audio device opened, no mixing on the way in" },
  { name: "s_volume", value: "0", why: "and nothing to mix" },
  { name: "cl_particles", value: "0", why: "no particle effects" },
  { name: "gl_texturemode", value: "GL_NEAREST", why: "no filtering" },
  { name: "r_shadows", value: "0", why: "no entity shadows" },
  { name: "r_fullbright", value: "1", why: "skip the lightmap pass" },
  { name: "r_lightmap", value: "0", why: "and do not draw one either" },
  { name: "r_norefresh", value: "1", why: "do not redraw the world between frames" },
  { name: "r_drawworld", value: "0", why: "skip the world pass outright; the bot's sensor is memory, not sight" },
  { name: "r_drawentities", value: "0", why: "and the entity pass with it" },
];

// The names this pass asked for that the engine does NOT have -- `r_picmip`,
// `gl_picmip`, `gl_drawflat`, `gl_shadows`, `gl_dynamic`, `gl_flashblend`,
// `gl_overbrightbits`, `gl_texturesolidmode`, `gl_maxfps`, `gl_particle_size`,
// every one of which answers `Unknown command` here. They are not in the plan
// above because setting a cvar the engine has never heard of is a console round
// trip spent on nothing; the measurement is in README.md rather than in code.

// The frame-rate half, when a caller wants the flat world without the small one.
export const FAST_RES_CVARS = [
  { name: "r_customwidth", value: "640", why: "half-width frame" },
  { name: "r_customheight", value: "480", why: "half-height frame" },
  { name: "r_mode", value: "-1", why: "r_mode -1 is this build's custom mode" },
];

// Everything this module may touch, in the order it is set: render first (it is
// harmless), then the cheat-protected timescale last so the `cheats 1` that
// accompanies it is the last state change.
//
// `options.render === false` leaves the renderer alone and applies only the
// simulation multiplier. It exists to MEASURE the two halves apart -- a run that
// turned everything on at once cannot say which lever bought what -- and it is
// the honest way to answer "did the render cuts help or hurt".
export function fastCvarPlan(options = {}) {
  const plan = options.render === false ? [] : [...FAST_RENDER_CVARS];
  if (options.resolution === true) plan.push(...FAST_RES_CVARS);
  return plan;
}

// Every cvar this module reads before it changes anything, so that leaving puts
// back what was there and not what some default is supposed to be. `timescale`
// is in the list and has to be: it is not in FAST_RENDER_CVARS (it is the cheat)
// and a restore that only walked the render plan left the multiplier ON -- which
// is exactly what the first version of this module did, and it was caught by
// reading the game back afterwards rather than by reasoning about it.
export function fastBaselineNames(options = {}) {
  return [...new Set([...fastCvarPlan(options).map((entry) => entry.name), "timescale"])];
}

// The multiplier a caller asked for, checked against what the engine takes.
export function fastTimescale(options = {}) {
  const asked = Number(options.timescale);
  if (!Number.isFinite(asked)) return FAST_TIMESCALE_DEFAULT;
  return asked;
}

// Read the request out of an environment-like object (process.env, or a literal
// in a test). `on` is what decides whether the driver enters fast mode at all.
export function fastRequest(env = {}, flags = []) {
  const raw = env[FAST_ENV];
  const flag = flags.includes(FAST_FLAG);
  // `--timescale N` wins over the env var, because it is the one a caller types
  // while trying which multiplier to settle on.
  const at = flags.indexOf("--timescale");
  const fromFlags = at === -1 || flags[at + 1] === undefined ? null : Number(flags[at + 1]);
  const flagTimescale = fromFlags !== null && Number.isFinite(fromFlags) ? fromFlags : null;
  const asked = flagTimescale === null ? env[FAST_TIMESCALE_ENV] : flagTimescale;
  const timescale = fastTimescale({ timescale: asked });
  const resolution = env.QUAKE2_FAST_RES === "1";
  const fromEnv = raw !== undefined && raw !== "" && raw !== "0" && String(raw).toLowerCase() !== "false";
  const on = flag || flagTimescale !== null || fromEnv;
  const source = flag ? FAST_FLAG : (flagTimescale !== null ? "--timescale" : (fromEnv ? FAST_ENV : null));
  // The render half can be left alone on its own, which is how the two levers
  // are measured apart: `QUAKE2_FAST_RENDER=0` keeps the flat world off and
  // leaves only the multiplier.
  const render = env.QUAKE2_FAST_RENDER !== "0";
  return { on, timescale, resolution, render, source };
}

// `"cvar" is "value"` -- the engine's own answer when a bare cvar name is typed
// at its console. It is the only cvar reader this build offers.
const CVAR_ANSWER = /^"([^"]+)"\s+is\s+"([^"]*)"/i;

// Ask the engine for the values of `names`, one console round trip.
//
// A cvar the engine does not know answers `Unknown command` and simply does not
// appear in the answer -- that is a fact about the build worth reporting, so it
// comes back as `null` with the lines that were seen, rather than as a guess.
export async function readCvars(game, names) {
  const answer = await game.command(names, { tail: 2 * names.length + 8 });
  const values = {};
  const seen = new Set();
  for (const line of answer.output || []) {
    const match = CVAR_ANSWER.exec(line.trim());
    if (!match) continue;
    values[match[1]] = match[2];
    seen.add(match[1]);
  }
  for (const name of names) if (!(name in values)) values[name] = null;
  return { values, output: answer.output || [], echoFound: answer.echoFound === true, ran: answer.ran === true, seen: [...seen] };
}

// What the engine does with a command it does not know. Q2 prints
// `Unknown command "r_picmip"`; anything that is not that is the engine having
// taken the command.
export function commandRefused(lines, name) {
  return (lines || []).some((line) => /unknown command/i.test(line) && line.includes(name));
}

// Apply iteration mode. Returns everything a report needs to say what happened,
// including the values the engine confirmed afterwards -- a cvar set that did
// not take must not be reported as if it had.
//
// `options.baseline` is the value set read before the change; this module reads
// it itself when the caller does not have it.
export async function enterFastMode(game, options = {}) {
  const plan = fastCvarPlan(options);
  const names = plan.map((entry) => entry.name);
  const timescale = fastTimescale(options);
  const cheat = timescale !== 1 && timescale !== 0;

  const before = options.baseline || (await readCvars(game, fastBaselineNames(options))).values;

  // One round trip: `cheats 1` if the simulation is to be sped up, then every
  // set, then every value read back. The console echoes each command, so the
  // dump holds both the sets and the engine's answer for each cvar.
  const commands = [];
  if (cheat) commands.push("cheats 1");
  for (const entry of plan) commands.push(`${entry.name} ${entry.value}`);
  if (cheat) commands.push(`timescale ${timescale}`);
  commands.push(...names);
  if (cheat) commands.push("timescale");

  const answer = await game.command(commands, { tail: commands.length * 2 + 12 });
  const lines = answer.output || [];
  const after = {};
  for (const line of lines) {
    const match = CVAR_ANSWER.exec(line.trim());
    if (match) after[match[1]] = match[2];
  }
  const refused = names.filter((name) => commandRefused(lines, name));

  return {
    mode: "iteration",
    cheat,
    timescale: cheat ? timescale : 1,
    baseline: before,
    confirmed: after,
    refused,
    // A cvar is "taken" when the engine answers its value with the value asked
    // for. `gl_texturemode` answers a name, not a number, so it is compared as
    // a string and case-insensitively.
    taken: plan
      .filter((entry) => !refused.includes(entry.name))
      .map((entry) => ({
        name: entry.name,
        asked: entry.value,
        got: after[entry.name] === undefined ? null : after[entry.name],
        ok: after[entry.name] !== undefined && String(after[entry.name]).toLowerCase() === String(entry.value).toLowerCase(),
      })),
    lines,
    echoFound: answer.echoFound === true,
  };
}

// Put the engine back the way it was found: every cvar restored to the value
// that was read before, and `cheats 0` last. Restoring a read value rather than
// a hard-coded default is the whole point -- this build ships its own
// config.cfg, and a mode that reset `cl_maxfps` to some default of its own would
// quietly change the normal path it is supposed to leave alone.
//
// Two things make this harder than sending the opposite commands, and both were
// measured on the live game rather than reasoned about:
//
//   * `timescale` is not in the render plan (it is the cheat) and a restore
//     built from that plan alone silently left the multiplier ON. The baseline
//     read now includes it explicitly (see `fastBaselineNames`).
//   * **Quake 2 LATCHES `cheats`.** Typing `cheats 0` answers `cheats will be
//     changed for next game.` and the running game keeps cheats ON until a level
//     is loaded -- so a restore that ended there handed the next run a game with
//     cheats 1, which is the one thing this mode must never leave behind. When
//     the read-back still says 1, the level is re-loaded: that is what applies
//     the latch, and it is the same `map <level>` a run does to start.
//
// The restore is therefore read back and reported, not assumed. A caller that
// gets `{ cheats: "1" }` back has been told the truth.
export async function leaveFastMode(game, state = {}, options = {}) {
  const baseline = state.baseline || {};
  const commands = [];
  const restore = [];
  for (const [name, value] of Object.entries(baseline)) {
    if (value === null || value === undefined) continue;
    if (name === "timescale") continue; // set explicitly below, after the reads
    commands.push(`${name} ${value}`);
    restore.push(name);
  }
  // The multiplier first, then cheats off, then the reads that say whether
  // either worked.
  //
  // `timescale` goes back to 1 -- the level's own speed -- and NOT to whatever
  // the baseline happened to read. That baseline is taken at the top of a run,
  // and a run that started while a previous one had left a multiplier on would
  // read that multiplier back as "the way the game was found" and faithfully
  // restore it, which is how a stray `timescale 3` survives from run to run and
  // quietly invalidates the owner's normal-speed test. The normal speed is 1;
  // this mode's job is to leave the game there.
  const found = baseline.timescale === undefined || baseline.timescale === null ? "1" : baseline.timescale;
  commands.push("timescale 1", "cheats 0", "timescale", "cheats");
  restore.push("timescale", "cheats");
  let answer = null;
  try {
    answer = await game.command(commands, { tail: commands.length * 2 + 10 });
  } catch (error) {
    return { restored: restore, timescale: null, cheats: null, latched: false, reason: "COMMAND_FAILED", message: error.message };
  }
  const lines = answer.output || [];
  let timescale = null;
  let cheats = null;
  for (const line of lines) {
    const match = CVAR_ANSWER.exec(line.trim());
    if (!match) continue;
    if (match[1] === "timescale") timescale = match[2];
    if (match[1] === "cheats") cheats = match[2];
  }

  // The latch. `cheats 0` above was accepted and answered `cheats will be
  // changed for next game.` -- the RUNNING game keeps cheats on until a level is
  // loaded, and the load is what applies the pending value. So the level is
  // reloaded, the load is given its own wall-clock time (a level load is host
  // time and no timescale shortens it), and the read that follows is the one
  // that says whether it took. Sending `cheats 0` and `map` in the same batch
  // and reading straight after does NOT work: the reads land while the old game
  // is still shutting down and report the old game's value.
  let relatched = null;
  if (cheats !== null && cheats !== "0") {
    const level = options.level || state.level || "demo1";
    // The settle time is computed here rather than through a shared helper:
    // `numberOr` exists privately in bridge.mjs, combat.mjs and route.mjs and is
    // exported by none of them, and calling it from this module is exactly what
    // the first version of this branch did. The failure is worth writing down
    // because of where it threw -- `numberOr is not defined` was raised while
    // BUILDING the arguments to `setTimeout`, so the wait never happened, the
    // read-back that would have caught it never ran, and the catch turned the
    // whole thing into `latched: true`, which the driver printed as "had to be
    // latched by reloading demo1". The reload had been sent; nothing had checked
    // that it worked. scripts/route-test.mjs pins this path against a stub so it
    // cannot silently break again.
    const settleMs = Number(options.settleMs);
    const waitMs = Number.isFinite(settleMs) ? Math.max(0, settleMs) : 2500;
    try {
      await game.command(["cheats 0", "map " + level], { tail: 10 });
      await new Promise((resolve) => setTimeout(resolve, waitMs));
      const again = await game.command(["timescale", "cheats"], { tail: 8 });
      const againLines = again.output || [];
      let t2 = null;
      let c2 = null;
      for (const line of againLines) {
        const match = CVAR_ANSWER.exec(line.trim());
        if (!match) continue;
        if (match[1] === "timescale") t2 = match[2];
        if (match[1] === "cheats") c2 = match[2];
      }
      // `ok` says whether the reload was READ BACK, not merely sent. A caller
      // must not report a latch as fixed on the strength of having asked.
      relatched = { level, timescale: t2, cheats: c2, lines: againLines, ok: true };
      timescale = t2 === null ? timescale : t2;
      cheats = c2 === null ? cheats : c2;
    } catch (error) {
      relatched = { level, ok: false, error: error.message };
    }
  }
  return { restored: restore, timescale, cheats, timescaleFound: found, latched: relatched !== null, relatched, lines, echoFound: answer.echoFound === true };
}

// The one line every fast-mode report has to carry. Kept here so the driver and
// any probe say the same thing, and so nobody has to remember to say it.
export const FAST_BANNER =
  "ITERATION MODE (CHEAT): timescale/cheats are ON. A result from this run is NOT a finish. " +
  "The finish proof is a normal-speed, cheats-0 walk that ends with the engine printing `mapname demo2`.";

// The wait after a `map demo1`, and the one before the final `mapname`, are
// deliberately NOT scaled by the timescale. Both are waits for the HOST -- for a
// level to be read off the pak and for the intermission to be drawn -- and
// `timescale` multiplies the server's frame time, which is not what either of
// them is waiting for. A fast run shortens itself by covering the level in fewer
// ticks, not by asking the engine to load it in less wall-clock time.
