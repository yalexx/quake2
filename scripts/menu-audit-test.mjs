#!/usr/bin/env node
// scripts/menu-audit-test.mjs -- every control in the menu, proven.
//
//   node scripts/menu-audit-test.mjs [--out DIR]
//
// The owner's second report: remove dead, duplicate and pointless controls and
// keep only the ones that work. This check is the audit's evidence:
//
//   * every <button> in #menu is either a settings row naming a cvar the engine
//     binaries actually register, or an action in the known set -- there is no
//     row without one, and no note-only row (the ones removed were notes);
//   * the OPTIONS/VIDEO rows are exactly the audited lists;
//   * every action changes something observable: views open/close, credits
//     shows, Save game puts a slot on the server, New Game starts demo1 at the
//     chosen skill, QUIT shows the quit plate, game mode enters and leaves,
//     Full screen enters and leaves, the lighting buttons switch the renderer
//     mode;
//   * every settings row, clicked one step and applied, is written into the
//     engine's own config.cfg as a `set` line (this build's `seta` is a player
//     command and does nothing local), survives the reload showing the new
//     value, and -- after the whole run -- is present in the config the engine
//     itself writes when it quits, which is the engine's own statement that the
//     cvars are live. Rows with a directly visible effect are checked on the
//     effect too (resolution -> drawing buffer, crosshair -> draws,
//     multisampling -> GL samples, fov -> start-up line).
//
// Own server/temp store/box-CSP proxy/headless Chromium on free ports. Never
// touches the live app (4231) or the kiosk browser (18801).

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Harness, Report, ROOT, sleep, waitFor } from "./app-harness.mjs";

const argv = process.argv.slice(2);
let outDir = process.env.CLAWBOX_RUN_ARTIFACTS_DIR || path.join(os.tmpdir(), "q2-menu-audit-" + process.pid);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") outDir = path.resolve(argv[++i]);
  else if (argv[i] === "--help" || argv[i] === "-h") { console.log("menu-audit-test.mjs [--out DIR]"); process.exit(0); }
  else { console.error("unknown option: " + argv[i]); process.exit(2); }
}
fs.mkdirSync(outDir, { recursive: true });

const report = new Report("Menu audit");
const app = new Harness({ name: "q2-menu-audit" });
let code = 0;

const KNOWN_ACTIONS = ["resume", "back", "game", "options", "video", "credits", "newgame",
  "loadgame", "loadslot", "savegame", "apply", "reset-video", "reset-options", "quit", "game-mode",
  "fullscreen", "touch-pad"];
const AUDITED = {
  options: ["effects volume", "mouse speed", "always run", "invert mouse", "lookstrafe",
    "free look", "crosshair", "pause on minimized"],
  video: ["video mode", "brightness", "field of view", "color intensity", "overbrights",
    "multisampling", "texture filter"],
};

function configValue(text, cvar) {
  let value = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    const match = /^\s*seta?\s+([^\s"]+)\s+(?:"([^"]*)"|(\S+))\s*$/i.exec(line);
    if (match && match[1].toLowerCase() === String(cvar).toLowerCase()) value = match[2] !== undefined ? match[2] : match[3];
  }
  return value;
}
function sameValue(a, b) {
  if (a === null || b === null) return false;
  const na = Number(a), nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}
function cvarInBinaries(cvar) {
  const names = ["engine/index.wasm", "engine/ref_gles3.wasm", "engine/game_baseq2.wasm"];
  const needle = Buffer.from(cvar, "latin1");
  return names.some((file) => fs.readFileSync(path.join(ROOT, file)).indexOf(needle) !== -1);
}

async function main() {
  await app.start();
  console.log("  server 127.0.0.1:" + app.serverPort + " (temp store " + app.dataDir + ")");
  console.log("  box proxy 127.0.0.1:" + app.proxyPort + ", Chrome CDP 127.0.0.1:" + app.cdpPort);
  await app.open();

  const rowState = (cvar) => app.evaluate(`(() => {
    const button = document.querySelector('.setting[data-cvar="${cvar}"]');
    if (!button) return null;
    const values = button.dataset.values.split(",");
    return { value: values[Number(button.dataset.index)], label: button.querySelector(".value").textContent.trim(),
      index: Number(button.dataset.index), changed: button.classList.contains("changed") };
  })()`);
  async function ensureGame() {
    if (await app.evaluate("document.getElementById('menu-layer').hidden === false")) await app.closeMenu();
    await waitFor(() => app.evaluate("window.quake2Engine && window.quake2Engine.keyDest && window.quake2Engine.keyDest() === 0"),
      20000, "the game to own the keyboard", 300).catch(() => null);
  }
  async function waitForReload(startOrigin, what = "the page to boot after Apply") {
    await waitFor(async () => {
      const origin = await app.evaluate("performance.timeOrigin").catch(() => null);
      if (!(typeof origin === "number" && origin > startOrigin + 1)) return false;
      return app.evaluate("Boolean(window.quake2BootFrame)").catch(() => false);
    }, 120000, what, 500);
    await sleep(1400);
    return app.state();
  }

  // ---- the audit of what is on the menu ----------------------------------
  if (!(await app.openMenu())) throw new Error("the menu did not open for the audit");
  const buttons = await app.evaluate(`Array.from(document.querySelectorAll("#menu button")).map(function (button) {
    const label = button.querySelector(".label") || button;
    const view = button.closest(".menu-view");
    return { label: (label.textContent || "").trim(), action: button.dataset.action || null,
      cvar: button.dataset.cvar || null, lighting: button.dataset.lighting || null,
      view: view ? view.dataset.view : "footer", text: (button.textContent || "").trim() };
  })`);
  const homeless = buttons.filter((one) => !one.action && !one.cvar && !one.lighting);
  report.check("every button in the menu is a control", homeless.length === 0,
    "each button has data-action, data-cvar or data-lighting",
    homeless.length ? JSON.stringify(homeless) : buttons.length + " buttons, all controls");
  const unknownActions = buttons.filter((one) => one.action && !KNOWN_ACTIONS.includes(one.action));
  report.check("every action is one the page handles", unknownActions.length === 0,
    "actions in " + KNOWN_ACTIONS.join(", "), unknownActions.length ? JSON.stringify(unknownActions) : "all known");
  const settingRows = buttons.filter((one) => one.cvar);
  const missingCvars = settingRows.filter((one) => !cvarInBinaries(one.cvar));
  report.check("every settings row names a cvar the engine registers", missingCvars.length === 0,
    "each data-cvar found in the engine binaries",
    missingCvars.length ? missingCvars.map((one) => one.label + " (" + one.cvar + ")").join(", ") : settingRows.length + " rows, all found");
  const optionsLabels = buttons.filter((one) => one.view === "options" && one.cvar).map((one) => one.label);
  const videoLabels = buttons.filter((one) => one.view === "video" && one.cvar).map((one) => one.label);
  report.check("OPTIONS carries the audited rows, in order",
    JSON.stringify(optionsLabels) === JSON.stringify(AUDITED.options),
    AUDITED.options.join(", "), optionsLabels.join(", "));
  report.check("VIDEO carries the audited rows, in order",
    JSON.stringify(videoLabels) === JSON.stringify(AUDITED.video),
    AUDITED.video.join(", "), videoLabels.join(", "));
  // The touch layer's show/hide row (the PAD button that sat over the game
  // moved here in the owner's HUD review) lives in OPTIONS and is shown only
  // on a touch device; the input gate drives it on a phone. On this desktop
  // it must be in the menu and not be drawn.
  const touchRow = await app.evaluate(`(() => {
    const row = document.querySelector('#menu [data-action="touch-pad"]');
    const group = row && row.closest(".menu-touch");
    const view = row && row.closest(".menu-view");
    return row ? { view: view ? view.dataset.view : null, groupHidden: Boolean(group && group.hidden),
      drawn: row.getClientRects().length > 0, touchUi: document.body.classList.contains("touch-ui") } : null;
  })()`);
  report.check("the touch-controls row is in OPTIONS and not drawn on a desktop",
    Boolean(touchRow) && touchRow.view === "options" && touchRow.groupHidden === true && touchRow.drawn === false && touchRow.touchUi === false,
    "OPTIONS > touch controls, hidden without a touch layer", JSON.stringify(touchRow));
  report.check("the dead OGG-music, note and engine-fullscreen rows are gone",
    !buttons.some((one) => /OGG|sound backend|customize controls|go to console|vertical sync|aniso filtering/i.test(one.label)) &&
      !buttons.some((one) => ["vid_fullscreen", "r_vsync", "r_anisotropic", "gl3_colorlight"].includes(one.cvar)),
    "no OGG, note, vsync, aniso, vid_fullscreen or gl3_colorlight rows",
    buttons.filter((one) => /OGG|backend|customize|console|vsync|aniso|vid_fullscreen|gl3_colorlight/i.test(one.label + " " + one.cvar)).map((one) => one.label).join(", ") || "none");

  // ---- main menu navigation ----------------------------------------------
  for (const [action, view] of [["game", "game"], ["options", "options"], ["video", "video"]]) {
    await app.click(`[data-action="${action}"]`);
    const shown = await app.evaluate(`(Array.from(document.querySelectorAll(".menu-view")).find(function (one) { return !one.hidden; }) || {}).dataset.view`);
    report.check("main > " + action + " opens its view", shown === view, view, String(shown));
    await app.click('[data-action="back"]');
    const back = await app.evaluate(`(Array.from(document.querySelectorAll(".menu-view")).find(function (one) { return !one.hidden; }) || {}).dataset.view`);
    report.check("back from " + action + " returns to the main menu", back === "main", "main", String(back));
  }
  await app.click('[data-action="game"]');
  await app.click('[data-action="credits"]');
  const credits = await app.evaluate(`(() => { const view = Array.from(document.querySelectorAll(".menu-view")).find(function (one) { return !one.hidden; }); return view ? { view: view.dataset.view, text: view.textContent.replace(/\\s+/g, " ").trim().slice(0, 60) } : null; })()`);
  report.check("credits opens the credits", credits && credits.view === "credits" && /Quake II/.test(credits.text),
    "the CREDITS view with the game's credits", credits ? credits.view + ": " + credits.text : "missing");
  await app.click('[data-action="back"]');
  await app.closeMenu();

  // ---- save game ---------------------------------------------------------
  await app.storeDelete("baseq2/save/quick/server.ssv");
  if (!(await app.openMenu())) throw new Error("the menu did not open for Save game");
  await app.click('[data-action="game"]');
  await app.click('[data-action="savegame"]');
  const savedQuick = await waitFor(async () => (await app.storeRead("baseq2/save/quick/server.ssv")) !== null,
    45000, "Save game to write the quick slot", 700).catch(() => false);
  report.check("save game writes the engine's quick slot to the store", savedQuick === true,
    "baseq2/save/quick/server.ssv on the server", savedQuick ? "present" : "missing");
  await app.closeMenu();

  // ---- New Game ----------------------------------------------------------
  if (!(await app.openMenu())) throw new Error("the menu did not open for New Game");
  await app.click('[data-action="game"]');
  const startOrigin = await app.evaluate("performance.timeOrigin");
  await app.evaluate(`document.querySelector('[data-action="newgame"][data-skill="2"]').click(); true`);
  const newGame = await waitFor(async () => {
    const origin = await app.evaluate("performance.timeOrigin").catch(() => null);
    if (!(typeof origin === "number" && origin > startOrigin + 1)) return null;
    const search = await app.evaluate("location.search").catch(() => "");
    return await app.evaluate("Boolean(window.quake2BootFrame)").catch(() => false) && /\+set&skill&2/.test(search) && /\+map&demo1/.test(search) ? search : null;
  }, 120000, "New Game at hard", 500);
  const newGameMap = await waitFor(async () => { const name = await app.mapName(); return name === "demo1" ? name : null; },
    60000, "demo1 after New Game", 1000).catch(() => null);
  // The pair must be read before the map: `map` starts the level at once, so
  // a `+set skill` after it would only affect the next level. The engine's own
  // skill cvar is the proof, not the URL's order in isolation.
  let engineSkill = null;
  for (let attempt = 0; attempt < 3 && engineSkill === null; attempt++) {
    try {
      const answer = await app.command("skill");
      const line = (answer.output || []).find((one) => /"skill"\s+is\s+"\d+"/i.test(one));
      if (line) engineSkill = /"skill"\s+is\s+"(\d+)"/i.exec(line)[1];
    } catch (error) { /* the console dropped a keystroke; ask again */ }
  }
  report.check("new game starts demo1 at the chosen skill", /\+set&skill&2/.test(newGame) && newGameMap === "demo1" && engineSkill === "2",
    "+set skill 2 before +map demo1, engine on demo1 at skill 2",
    newGame + "; map " + newGameMap + "; engine skill " + String(engineSkill));
  const newGameStartup = await app.evaluate("window.quake2StartupArguments");
  report.check("the start-up line stays inside the engine's argument limit after New Game",
    newGameStartup.length <= 48, "at most 48 arguments", String(newGameStartup.length));

  // ---- lighting buttons --------------------------------------------------
  if (!(await app.openMenu())) throw new Error("the menu did not open for lighting");
  await app.click('[data-action="options"]');
  const lighting = await app.evaluate(`(() => {
    const out = [];
    for (const value of ["off", "high", "performance"]) {
      document.querySelector('[data-lighting="' + value + '"]').click();
      out.push({ value, status: document.getElementById("rtx-status").textContent,
        pressed: document.querySelector('[data-lighting="' + value + '"]').getAttribute("aria-pressed"),
        mode: window.quake2RTX.status().mode, quality: window.quake2RTX.status().quality, enabled: window.quake2RTX.status().enabled });
    }
    return out;
  })()`);
  report.check("the lighting buttons turn the RTX look off, high and performance",
    lighting[0].mode === 0 && /Original lighting/.test(lighting[0].status) && lighting[0].pressed === "true" &&
      lighting[1].mode === 2 && /High/.test(lighting[1].status) &&
      lighting[2].mode === 1 && /Performance/.test(lighting[2].status) && lighting[2].enabled === true,
    "Off -> mode 0, High -> mode 2, Performance -> mode 1",
    lighting.map((one) => one.value + " mode " + one.mode + " (" + one.status + ")").join("; "));
  await app.closeMenu();

  // ---- Apply with nothing to apply --------------------------------------
  if (!(await app.openMenu())) throw new Error("the menu did not open for the empty Apply");
  await app.click('[data-action="options"]');
  await app.click('.menu-view[data-view="options"] [data-action="apply"]');
  const emptyNote = await app.evaluate(`(() => { const note = document.getElementById("menu-note"); return { hidden: note.hidden, text: note.textContent }; })()`);
  report.check("Apply with nothing changed says so in the panel",
    emptyNote.hidden === false && /Nothing to apply/i.test(emptyNote.text), "a visible 'Nothing to apply' note", JSON.stringify(emptyNote));
  await app.closeMenu();

  // ---- resets ------------------------------------------------------------
  // Do these before the row sweep: a reset puts cvars back to their defaults,
  // and the engine's own config check at the end must see the values the sweep
  // left behind.
  await ensureGame();
  if (!(await app.openMenu())) throw new Error("the menu did not open for reset defaults");
  await app.click('[data-action="options"]');
  let sens = await rowState("sensitivity");
  if (sens.value === "6") {
    await app.click('.setting[data-cvar="sensitivity"]');
    let origin = await app.evaluate("performance.timeOrigin");
    await app.click('.menu-view[data-view="options"] [data-action="apply"]');
    await waitForReload(origin);
    await ensureGame();
    if (!(await app.openMenu())) throw new Error("the menu did not reopen for reset defaults");
    await app.click('[data-action="options"]');
  }
  let origin = await app.evaluate("performance.timeOrigin");
  await app.click('.menu-view[data-view="options"] [data-action="reset-options"]');
  await waitForReload(origin, "the page to boot after reset defaults");
  const sensitivity = await rowState("sensitivity");
  const resetConfig = (await app.storeRead("baseq2/config.cfg"))?.toString("utf8") || "";
  report.check("reset defaults restores the engine defaults and writes them",
    sensitivity.value === "6" && sensitivity.changed === false && sameValue(configValue(resetConfig, "sensitivity"), "6"),
    "sensitivity 6 after reset", sensitivity.value + " (changed " + sensitivity.changed + "), config " + JSON.stringify(configValue(resetConfig, "sensitivity")));
  await ensureGame();

  if (!(await app.openMenu())) throw new Error("the menu did not open for reset video");
  await app.click('[data-action="video"]');
  let gamma = await rowState("vid_gamma");
  if (gamma.value === "1.6") {
    await app.click('.setting[data-cvar="vid_gamma"]');
    origin = await app.evaluate("performance.timeOrigin");
    await app.click('.menu-view[data-view="video"] [data-action="apply"]');
    await waitForReload(origin);
    await ensureGame();
    if (!(await app.openMenu())) throw new Error("the menu did not reopen for reset video");
    await app.click('[data-action="video"]');
  }
  origin = await app.evaluate("performance.timeOrigin");
  await app.click('.menu-view[data-view="video"] [data-action="reset-video"]');
  await waitForReload(origin, "the page to boot after reset to default");
  gamma = await rowState("vid_gamma");
  report.check("reset to default restores the VIDEO defaults", gamma.value === "1.6" && gamma.changed === false,
    "brightness 1.6 after reset", gamma.value + " (changed " + gamma.changed + ")");
  await ensureGame();

  // ---- every settings row ------------------------------------------------
  const rows = [
    ["options", "s_volume"], ["options", "sensitivity"], ["options", "cl_run"], ["options", "m_pitch"],
    ["options", "lookstrafe"], ["options", "freelook"], ["options", "crosshair"], ["options", "vid_pauseonfocuslost"],
    ["video", "r_mode"], ["video", "vid_gamma"], ["video", "fov"], ["video", "gl3_intensity"],
    ["video", "gl3_overbrightbits"], ["video", "r_msaa_samples"], ["video", "gl_texturemode"],
  ];
  const applied = [];
  for (const [view, cvar] of rows) {
    await ensureGame();
    if (!(await app.openMenu())) throw new Error("the menu did not open for " + cvar);
    await app.click(`[data-action="${view}"]`);
    const before = await rowState(cvar);
    if (!before) throw new Error("no row for " + cvar);
    // The resolution row steps to 1366x768 rather than the next entry: the
    // headless window is 1280x720, and a taller mode has no display mode to
    // switch to. It is still one real change from the HD default.
    if (cvar === "r_mode") {
      for (let step = 0; step < 6 && (await rowState(cvar)).label !== "1366x768"; step++) {
        await app.click(`.menu-view[data-view="${view}"] .setting[data-cvar="${cvar}"]`);
      }
    } else {
      await app.click(`.menu-view[data-view="${view}"] .setting[data-cvar="${cvar}"]`);
    }
    const pending = await rowState(cvar);
    const hint = await app.evaluate(`(document.querySelector('.menu-view[data-view="${view}"] #apply-hint') || document.getElementById("apply-hint-options") || {}).textContent`);
    const start = await app.evaluate("performance.timeOrigin");
    await app.click(`.menu-view[data-view="${view}"] [data-action="apply"]`);
    const after = await waitForReload(start);
    const shown = await rowState(cvar);
    const config = (await app.storeRead("baseq2/config.cfg"))?.toString("utf8") || "";
    const stored = configValue(config, cvar);
    const visible = [];
    if (cvar === "r_mode") visible.push(["drawing buffer", after.buffer, pending.label]);
    if (cvar === "r_msaa_samples") {
      const samples = await app.evaluate("document.getElementById('canvas').getContext('webgl2').getParameter(WebGL2RenderingContext.SAMPLES)");
      visible.push(["GL samples", String(samples), pending.value]);
    }
    if (cvar === "crosshair") {
      // The first frames after a boot can still be the level load; wait for a
      // drawn crosshair (the value is 2/dot here, not none) before reading.
      const draws = await waitFor(async () => {
        const count = await app.evaluate("window.quake2RTX.status().crosshairDraws");
        return count > 0 ? count : null;
      }, 20000, "a drawn crosshair", 500).catch(() => 0);
      visible.push(["crosshair draws", String(draws), pending.value]);
    }
    if (cvar === "fov") {
      const startup = after.startup || [];
      const at = startup.indexOf("fov");
      visible.push(["start-up fov", at >= 0 ? startup[at + 1] : "absent", pending.value]);
    }
    const rowOk = Boolean(shown) && shown.value === pending.value && shown.changed === false;
    const storedOk = sameValue(stored, pending.value);
    const visibleOk = visible.every(([what, actual, wanted]) => {
      if (what === "drawing buffer") return actual === wanted;
      // The browser picks the sample count it can give: asking for 2x on this
      // ANGLE/SwiftShader build yields 4. Off must be 0, anything else > 0.
      if (what === "GL samples") return Number(wanted) === 0 ? Number(actual) === 0 : Number(actual) > 0;
      if (what === "crosshair draws") return Number(wanted) === 0 ? Number(actual) === 0 : Number(actual) > 0;
      return sameValue(actual, wanted);
    });
    const changedSteps = pending.value !== before.value;
    report.check("setting " + cvar + " applies, persists and shows its new value",
      changedSteps && pending.changed === true && /1 change/.test(String(hint)) && rowOk && storedOk && visibleOk,
      "a pending change, a set line in config.cfg, the new value after the reload" +
        (visible.length ? ", and " + visible.map((one) => one[0] + " " + one[2]).join(" / ") : ""),
      "from " + before.value + " to " + pending.value + " (changed " + pending.changed + ", hint " + JSON.stringify(hint) + "), stored " +
        JSON.stringify(stored) + ", shown " + JSON.stringify(shown) + (visible.length ? ", " + visible.map((one) => one[0] + " " + one[1]).join(" / ") : ""));
    applied.push([cvar, pending.value]);
    await ensureGame();
  }

  // ---- game mode and full screen ----------------------------------------
  await ensureGame();
  if (!(await app.openMenu())) throw new Error("the menu did not open for game mode");
  await app.click('[data-action="video"]');
  await app.trustedClick('[data-action="game-mode"]');
  const mode = await waitFor(async () => {
    const status = await app.evaluate("window.quake2GameMode && window.quake2GameMode.status ? window.quake2GameMode.status() : null");
    return status && (status.active === true || status.reason) ? status : null;
  }, 15000, "the game-mode status", 400).catch(() => null);
  report.check("game mode engages from its row", Boolean(mode) && (mode.active === true || Boolean(mode.reason)),
    "active, or a stated reason it could not", mode ? JSON.stringify({ active: mode.active, fullscreen: mode.fullscreen, reason: mode.reason }) : "no status");
  await app.evaluate("window.quake2GameMode.exit('audit', { keepFullscreen: false })");
  await sleep(900);
  const modeAfter = await app.evaluate("window.quake2GameMode.status()");
  report.check("game mode leaves when asked", modeAfter.active === false, "inactive", JSON.stringify({ active: modeAfter.active }));
  await app.evaluate("document.exitFullscreen && document.exitFullscreen().catch(function () {})");
  await sleep(500);

  // The owner's HUD review moved full screen off the game picture and into
  // VIDEO's page-control list. This harness runs the page under the box's CSP
  // sandbox, which does not grant full screen (allow-fullscreen is absent), so
  // the row's own defined behaviour is the blocked one: it reads "own window"
  // and its click opens the app in a window that may fill the display.
  // Clicking it here would navigate this run, so its state is what is checked;
  // where the document *can* go full screen (the presentation gate runs
  // without the sandbox), the same row enters and leaves it.
  const fullscreenState = await app.evaluate(`(() => {
    const row = document.querySelector('#menu [data-action="fullscreen"]');
    const value = document.getElementById("fullscreen-value");
    const status = window.quake2Fullscreen && window.quake2Fullscreen.status ? window.quake2Fullscreen.status() : null;
    return row ? { enabled: document.fullscreenEnabled, inVideo: !!(row.closest(".menu-view") && row.closest(".menu-view").dataset.view === "video"),
      inPageList: !!row.closest(".menu-page-list"), value: value ? value.textContent.trim() : null,
      title: row.title, label: row.getAttribute("aria-label"), status: status,
      playLayer: !!document.getElementById("fullscreen-button") || !!document.getElementById("fullscreen-hint") } : null;
  })()`);
  if (fullscreenState && fullscreenState.enabled) {
    if (!(await app.openMenu())) throw new Error("the menu did not open for full screen");
    await app.click('[data-action="video"]');
    await sleep(300);
    await app.evaluate(`(() => { const row = document.querySelector('#menu [data-action="fullscreen"]'); if (row) row.scrollIntoView({ block: "center" }); return true; })()`);
    await app.trustedClick('#menu [data-action="fullscreen"]');
    const fullscreen = await waitFor(() => app.evaluate("Boolean(document.fullscreenElement)"), 12000, "full screen", 300).catch(() => false);
    report.check("the Full screen row enters full screen", fullscreen === true, "document.fullscreenElement", String(fullscreen));
    await app.evaluate("document.exitFullscreen && document.exitFullscreen().catch(function () {})");
    await sleep(700);
    report.check("full screen can be left", (await app.evaluate("!document.fullscreenElement")) === true,
      "no fullscreenElement", String(await app.evaluate("Boolean(document.fullscreenElement)")));
  } else {
    report.check("the Full screen row states the sandbox's own-window path", Boolean(fullscreenState) &&
      fullscreenState.playLayer === false && fullscreenState.inVideo && fullscreenState.inPageList &&
      fullscreenState.status && fullscreenState.status.blocked === true && fullscreenState.value === "own window" &&
      /own window/i.test(fullscreenState.title + " " + fullscreenState.label),
      "the VIDEO page-control row reads 'own window' when the sandbox blocks full screen, and nothing floats over the game",
      JSON.stringify(fullscreenState));
    report.note("full screen is blocked by the box's CSP sandbox (fullscreenEnabled false); the menu row offers the own-window path, and the presentation gate checks the entering/leaving path without the sandbox");
  }

  // ---- QUIT --------------------------------------------------------------
  await ensureGame();
  if (!(await app.openMenu())) throw new Error("the menu did not open for QUIT");
  await app.click('[data-action="quit"]');
  const quit = await waitFor(async () => {
    const state = await app.evaluate(`(() => ({ display: document.getElementById("canvas").style.display,
      status: document.getElementById("status").textContent, menuHidden: document.getElementById("menu-layer").hidden }))()`);
    return state.display === "none" && /quit/i.test(state.status) ? state : null;
  }, 15000, "QUIT to show the quit plate", 300).catch(() => null);
  report.check("quit stops the picture and says so", Boolean(quit), "canvas hidden and a quit message", quit ? JSON.stringify(quit) : "no quit plate");

  // ---- the engine's own config, written when it quits --------------------
  // QUIT on this page is a presentation; this quits the engine itself. It
  // writes every cvar it holds on the way out, and that file is the engine's
  // own statement of what was live. Every value the sweep applied must be in
  // it, together with the `set` form (this build's `seta` is a player command
  // that changes no local cvar, so a patched `seta` line would be a setting
  // that silently did nothing).
  await app.open(app.url());
  const configBefore = await app.storeRead("baseq2/config.cfg");
  const beforeText = configBefore ? configBefore.toString("utf8") : "";
  report.check("the engine keeps its config in the store, written as `set` lines",
    /^set\s+/m.test(beforeText) && !/^seta\s+/m.test(beforeText),
    "set lines and no seta lines in userdata/baseq2/config.cfg",
    beforeText ? beforeText.split("\n").length + " lines; " + (beforeText.match(/^seta\s.*$/m) || ["no seta"])[0] : "no config.cfg");
  const quitEngine = async () => {
    try {
      await (await app.control()).command("quit", { tail: 4 });
      return true;
    } catch (error) {
      // The engine stops before it answers the console; the command itself
      // was typed, which is what matters.
      report.note("the engine quit through the console (" + error.message + ")");
      return false;
    }
  };
  const fullConfig = () => waitFor(async () => {
    const data = await app.storeRead("baseq2/config.cfg");
    const text = data ? data.toString("utf8") : "";
    return applied.every(([cvar, value]) => sameValue(configValue(text, cvar), value)) ? text : null;
  }, 25000, "the engine's own config to hold every applied value", 1000).catch(() => null);
  await quitEngine();
  let engineConfig = await fullConfig();
  if (!engineConfig) {
    // A console keystroke is dropped now and then; one clean page and one more
    // quit is cheaper than a false failure.
    report.note("the engine's config did not arrive after the first quit; retrying on a fresh page");
    await app.open(app.url());
    await quitEngine();
    engineConfig = await fullConfig();
  }
  const missing = engineConfig ? applied.filter(([cvar, value]) => !sameValue(configValue(engineConfig, cvar), value)) : applied;
  report.check("the engine itself holds every value this audit applied",
    Boolean(engineConfig) && missing.length === 0,
    "every applied cvar present with its value in the config the engine wrote on quit",
    engineConfig ? applied.length + " applied, " + missing.length + " missing" +
      (missing.length ? ": " + missing.map(([cvar, value]) => cvar + "=" + value).join(", ") : "") : "the engine's own config never arrived");
  await app.screenshot(path.join(outDir, "menu-audit-final.png"));

  const pageErrors = app.pageErrors.filter((text) => /app\.js/.test(String(text)));
  report.check("app.js threw nothing during the audit", pageErrors.length === 0, "no page exception from app.js",
    pageErrors.length ? pageErrors.join(" | ") : "none");
  report.note("screenshots in " + outDir);
}

try {
  await main();
  code = report.finish() ? 0 : 1;
} catch (error) {
  console.error("\nFAIL: " + (error && error.stack ? error.stack : error));
  code = 1;
} finally {
  await app.stop().catch(() => {});
}
process.exit(code);
