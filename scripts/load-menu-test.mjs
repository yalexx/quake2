#!/usr/bin/env node
// scripts/load-menu-test.mjs -- Load Game, end to end, on the real engine.
//
//   node scripts/load-menu-test.mjs [--out DIR]
//
// Proves the owner's first report is fixed:
//   * GAME > load game opens a page-drawn LOAD GAME view (the engine's own
//     load menu is one of the 2D draws the renderer drops while the keyboard
//     is away from the game, which is why it could never be seen or clicked);
//   * an empty store says so, in the panel;
//   * the view is rebuilt on every open from userdata/baseq2/save/<slot>/,
//     a slot counts only while it holds server.ssv, and the order is the
//     engine's (save0, save1…, quick, current, then named slots);
//   * a slot made on another level, after a page reload, is listed and a
//     click (and Enter) restores THAT level: the next boot's start-up line
//     carries `+load <slot>` and no `+map`, and the engine answers `demo3`;
//   * New Game after a load drops the stale `+load`.
//
// It starts its own server.js (temp QUAKE2_DATA_DIR), box-CSP proxy and
// headless Chromium on free ports. The live app on 4231 and the kiosk browser
// on 18801 are never touched, and only the processes this run started are
// stopped.
//
// Exit 0 when every check passed, 1 otherwise, 77 when no Chromium is found.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Harness, Report, sleep, waitFor } from "./app-harness.mjs";

const argv = process.argv.slice(2);
let outDir = process.env.CLAWBOX_RUN_ARTIFACTS_DIR || path.join(os.tmpdir(), "q2-load-menu-" + process.pid);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--out") outDir = path.resolve(argv[++i]);
  else if (argv[i] === "--help" || argv[i] === "-h") {
    console.log("load-menu-test.mjs [--out DIR]");
    process.exit(0);
  } else {
    console.error("unknown option: " + argv[i]);
    process.exit(2);
  }
}
fs.mkdirSync(outDir, { recursive: true });

const report = new Report("Load Game");
const app = new Harness({ name: "q2-load-menu" });
let code = 0;

async function main() {
  await app.start();
  console.log("  server 127.0.0.1:" + app.serverPort + " (temp store " + app.dataDir + ")");
  console.log("  box proxy 127.0.0.1:" + app.proxyPort + " (CSP sandbox), Chrome CDP 127.0.0.1:" + app.cdpPort);

  const first = await app.open();
  // The engine's own console log names the level it loaded (`Map: demo3`).
  // Reading it avoids a console visit for a fact the engine already wrote: the
  // console's text input drops keystrokes now and then under load, and a
  // console read is what made the map checks flaky.
  async function engineMap() {
    const log = await app.evaluate("(() => { try { return FS.readFile('/qwasm2/baseq2/qconsole.log', { encoding: 'utf8' }); } catch (error) { return ''; } })()").catch(() => "");
    let map = null;
    for (const line of String(log || "").split("\n")) {
      const match = /^Map: (\S+)/.exec(line);
      if (match) map = match[1];
    }
    return map;
  }
  report.check("the app boots to HD", first.buffer === "1280x720", "drawing buffer 1280x720", String(first.buffer));
  report.check("RTX is on by default", Boolean(first.rtx && first.rtx.enabled === true),
    "quake2RTX.status().enabled true", first.rtx ? "enabled " + first.rtx.enabled + ", quality " + first.rtx.quality : "no status");
  report.check("the page is in the game", first.keyDest === 0 && first.canvasDisplay === "block",
    "key_dest 0 and the canvas shown", "key_dest " + first.keyDest + ", canvas " + first.canvasDisplay);

  // ---- the menu routes to a real LOAD view --------------------------------
  report.check("the main menu is the audited four entries",
    JSON.stringify(first.mainEntries) === JSON.stringify(["GAME", "OPTIONS", "VIDEO", "QUIT"]),
    "GAME, OPTIONS, VIDEO, QUIT", (first.mainEntries || []).join(", "));
  if (!(await app.openMenu())) throw new Error("the menu did not open");
  await app.click('[data-action="game"]');
  const gameRow = await app.evaluate(`(() => {
    const button = document.querySelector('[data-action="loadgame"]');
    if (!button) return null;
    return { label: button.querySelector(".label").textContent.trim(), hint: button.querySelector(".hint").textContent.trim(), action: button.dataset.action };
  })()`);
  report.check("GAME still carries load game, labelled and ordered as before",
    Boolean(gameRow) && gameRow.label === "load game",
    "a row labelled 'load game'", gameRow ? gameRow.label + " (" + gameRow.action + ", hint " + gameRow.hint + ")" : "missing");
  const gameOrder = await app.evaluate(`Array.from(document.querySelectorAll('.menu-view[data-view="game"] .label')).map((one) => one.textContent.trim())`);
  report.check("the GAME rows keep the engine's order",
    JSON.stringify(gameOrder) === JSON.stringify(["easy", "medium", "hard", "hard+", "load game", "save game", "credits"]),
    "easy, medium, hard, hard+, load game, save game, credits", (gameOrder || []).join(", "));

  // ---- empty store --------------------------------------------------------
  // The engine writes save0/current when a level starts; remove the slot
  // headers from the store so the page reads an empty list, as a first visit
  // with no saves would. (Only this run's temp store is touched.)
  const listing = await app.storeList();
  const slotHeaders = listing.map((one) => one.path).filter((one) => /^baseq2\/save\/[^/]+\/server\.ssv$/.test(one));
  for (const relPath of slotHeaders) await app.storeDelete(relPath);
  await app.click('[data-action="loadgame"]');
  await waitFor(() => app.evaluate(`document.querySelector('.menu-view[data-view="load"]') && !document.querySelector('.menu-view[data-view="load"]').hidden`),
    15000, "the LOAD GAME view");
  // The listing is fetched when the view opens; the page also runs the game at
  // a few frames a second under the software renderer, so poll for the answer
  // instead of sleeping a fixed time.
  await waitFor(() => app.evaluate(`document.getElementById("load-empty").hidden === false || document.querySelectorAll("#load-slots button").length > 0 || document.getElementById("load-error").hidden === false`),
    15000, "the save listing to arrive", 300);
  const empty = await app.evaluate(`(() => ({
    view: Array.from(document.querySelectorAll(".menu-view")).find((one) => !one.hidden).dataset.view,
    slots: Array.from(document.querySelectorAll("#load-slots button")).map((one) => one.dataset.slot),
    emptyHidden: document.getElementById("load-empty").hidden,
    emptyText: document.getElementById("load-empty").textContent,
    errorHidden: document.getElementById("load-error").hidden,
  }))()`);
  await app.screenshot(path.join(outDir, "load-empty.png"));
  report.check("load game opens the page-drawn LOAD GAME view", empty.view === "load", "data-view=load", String(empty.view));
  report.check("an empty store says so in the panel",
    empty.slots.length === 0 && empty.emptyHidden === false &&
      empty.emptyText === "No saved games yet — save with F6 or Save game." && empty.errorHidden === true,
    "no slots and the empty-state sentence",
    empty.slots.length + " slot(s), empty hidden " + empty.emptyHidden + ", text " + JSON.stringify(empty.emptyText));

  // ---- make a save, on another level, then reload the page ----------------
  // The console drops a keystroke now and then, and the bridge's `command`
  // returns the *requested* map as a hint even when the console text never
  // reached the engine. So each attempt must (a) put the panel away first --
  // an open panel owns the keyboard and swallows the trusted console keys --
  // and (b) prove the command ran (echoed) before waiting for the engine's own
  // `mapname` to answer demo3.
  let mapAnswer = null;
  let changed = false;
  for (let attempt = 0; attempt < 4 && !changed; attempt++) {
    await app.closeMenu().catch(() => null);
    mapAnswer = await app.command("map demo3").catch((error) => ({ ran: false, echoFound: false, error: error.message }));
    if (mapAnswer && mapAnswer.ran && mapAnswer.echoFound) {
      changed = await waitFor(async () => (await engineMap()) === "demo3", 30000, "demo3 to load", 1000).catch(() => false);
    }
    if (!changed) await sleep(1500);
  }
  if (!changed) {
    throw new Error("the console could not load demo3 (last answer: " +
      JSON.stringify(mapAnswer && { ran: mapAnswer.ran, echo: mapAnswer.echoFound, error: mapAnswer.error }) + ")");
  }
  // A console keystroke is dropped now and then on this engine, so ask again
  // if the slot does not appear; each retry is a complete round trip.
  let savedSeen = false;
  for (let attempt = 0; attempt < 3 && !savedSeen; attempt++) {
    await app.closeMenu().catch(() => null);
    const answer = await app.command("save loadproof");
    if (attempt === 0) report.note("save answer: ran " + answer.ran + ", echo " + answer.echoFound + ", console " + answer.consoleOpen);
    savedSeen = Boolean(await waitFor(async () => (await app.storeRead("baseq2/save/loadproof/server.ssv")) !== null, 20000,
      "the loadproof save on the server", 500).catch(() => false));
  }
  if (!savedSeen) throw new Error("the engine never put loadproof on the server");
  // A console-named slot whose first character is an underscore: the store
  // accepts it and the engine's own `+load _edge` works, so the page must list
  // it too. (The review of 5e1ef7d found the page's slot-name filter silently
  // dropped such a save; this is the regression check for that fix.)
  const storeAfterSave = await app.storeList();
  const proofFiles = storeAfterSave.filter((entry) => /^baseq2\/save\/loadproof\//.test(entry.path));
  for (const entry of proofFiles) {
    const data = await app.storeRead(entry.path);
    await app.storeWrite(entry.path.replace("/save/loadproof/", "/save/_edge/"), data);
  }
  report.note("made baseq2/save/loadproof on demo3 and copied it to the console-named slot _edge, then reloaded the page");

  await app.open(app.url());
  // The first frame can land while the +map demo1 level is still loading, and
  // `mapname` then answers the attract demo's name (q2demo1.dm2). Give the
  // level the same chance a player gives it, then read what the engine says.
  const reloadedMap = await waitFor(async () => { const name = await engineMap(); return name === "demo1" ? name : null; },
    60000, "demo1 after the reload", 1000).catch(() => null);
  report.check("after a page reload the game is back on demo1", reloadedMap === "demo1", "demo1", String(reloadedMap));

  // ---- the slot list, on every open ---------------------------------------
  if (!(await app.openMenu())) throw new Error("the menu did not reopen");
  await app.click('[data-action="game"]');
  await app.click('[data-action="loadgame"]');
  const listed = await waitFor(async () => {
    const state = await app.evaluate(`(() => ({
      slots: Array.from(document.querySelectorAll("#load-slots button")).map((one) => ({ slot: one.dataset.slot, hint: one.querySelector(".hint").textContent.trim(), label: one.querySelector(".label").textContent.trim() })),
      emptyHidden: document.getElementById("load-empty").hidden,
      focus: document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.slot : null,
    }))()`);
    return state.slots.some((one) => one.slot === "loadproof") ? state : null;
  }, 20000, "the loadproof slot in the list", 400);
  await app.screenshot(path.join(outDir, "load-list.png"));
  report.check("the saved slot is listed with its name and a load hint",
    listed.slots.some((one) => one.slot === "loadproof" && one.hint === "load" && one.label === "loadproof") && listed.emptyHidden === true,
    "loadproof / load and no empty state", JSON.stringify(listed.slots));
  report.check("a console-named slot that starts with an underscore is listed",
    listed.slots.some((one) => one.slot === "_edge" && one.hint === "load"),
    "an _edge row with a load hint", listed.slots.map((one) => one.slot).join(", "));
  const order = listed.slots.map((one) => one.slot);
  const expected = order.filter((slot) => /^save\d+$/.test(slot)).sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
    .concat(["quick", "current"].filter((slot) => order.includes(slot)))
    .concat(order.filter((slot) => /^save\d+$/.test(slot) || slot === "quick" || slot === "current" ? false : true).sort());
  report.check("the slots are in the engine's order (save0, save1…, quick, current, named)",
    JSON.stringify(order) === JSON.stringify(expected), expected.join(", "), order.join(", "));
  report.check("the roving ring starts on the first slot", listed.focus === order[0], order[0], String(listed.focus));

  // Enter, from the keyboard ring, loads the focused slot. Focus the slot
  // first: the ring starts on save0 (the engine's own autosave), and this
  // check is about Enter acting on whatever is focused.
  await app.evaluate(`document.querySelector('#load-slots button[data-slot="loadproof"]').focus(); document.activeElement.dataset.slot === "loadproof"`);
  await app.pressKey("Enter");
  const entered = await waitFor(async () => {
    const search = await app.evaluate("location.search").catch(() => "");
    return /\+load&loadproof/.test(search) && (await app.evaluate("Boolean(window.quake2BootFrame)").catch(() => false)) ? search : null;
  }, 120000, "Enter to load the focused slot", 500);
  report.check("Enter on the focused slot loads it", /\+load&loadproof/.test(entered), "+load&loadproof", entered);
  // Wait for the saved level, not for the first answer: while the save is
  // still loading the engine's own `mapname` is the attract demo's
  // (q2demo1.dm2), which is a real answer but not the restored level.
  const enterMap = await waitFor(async () => { const name = await engineMap(); return name === "demo3" ? name : null; },
    120000, "demo3 after Enter", 1000).catch(() => null);
  report.check("Enter restores the saved level (demo3)", enterMap === "demo3", "demo3", String(enterMap));

  // ---- the owner's own path: reload the page, then click the slot ----------
  await app.closeMenu();
  const fresh = await app.open(app.url());
  report.note("reloaded the page again; the next load is the click path");
  if (!(await app.openMenu())) throw new Error("the menu did not open after the reload");
  await app.click('[data-action="game"]');
  await app.click('[data-action="loadgame"]');
  await waitFor(() => app.evaluate(`Array.from(document.querySelectorAll("#load-slots button")).some((one) => one.dataset.slot === "loadproof")`),
    20000, "loadproof after the reload", 400);
  // Click and read the banner in the same evaluation: the click handler runs
  // synchronously, and the reload that follows 150 ms later would take the
  // document away from a second round trip.
  const banner = await app.evaluate(`(() => {
    document.querySelector('#load-slots button[data-slot="loadproof"]').click();
    return { hidden: document.getElementById("banner").hidden, text: document.getElementById("banner-text").textContent,
      menuOpen: document.getElementById("menu-layer").hidden === false };
  })()`);
  report.check("clicking a slot shows 'Loading <slot>…' on the game layer",
    banner.hidden === false && banner.text === "Loading loadproof…" && banner.menuOpen === false,
    "the banner 'Loading loadproof…' and the panel put away", JSON.stringify(banner));
  const clicked = await waitFor(async () => {
    const search = await app.evaluate("location.search").catch(() => "");
    return /\+load&loadproof/.test(search) && (await app.evaluate("Boolean(window.quake2BootFrame)").catch(() => false)) ? search : null;
  }, 120000, "the click to reload with +load", 500);
  await app.screenshot(path.join(outDir, "load-restored.png"));
  const startup = await app.evaluate("window.quake2StartupArguments");
  report.check("the next boot carries +load loadproof on its start-up line",
    startup.includes("+load") && startup[startup.indexOf("+load") + 1] === "loadproof",
    "+load loadproof", startup.slice(-6).join(" "));
  report.check("and carries no +map of its own", !startup.includes("+map"), "no +map", startup.includes("+map") ? "+map present" : "none");
  const restoredMap = await waitFor(async () => { const name = await engineMap(); return name === "demo3" ? name : null; }, 120000, "demo3 after the click", 1000).catch(() => null);
  report.check("the click restores the save's own level", restoredMap === "demo3", "demo3", String(restoredMap));
  const loaded = await app.state();
  report.check("the load boot still starts at HD", loaded.buffer === "1280x720", "1280x720", String(loaded.buffer));

  // ---- New Game drops the stale +load ------------------------------------
  await app.closeMenu();
  if (!(await app.openMenu())) throw new Error("the menu did not open for New Game");
  await app.click('[data-action="game"]');
  await app.evaluate(`document.querySelector('[data-action="newgame"][data-skill="1"]').click(); true`);
  const newGameSearch = await waitFor(async () => {
    const search = await app.evaluate("location.search").catch(() => "");
    return /\+map&demo1/.test(search) && (await app.evaluate("Boolean(window.quake2BootFrame)").catch(() => false)) ? search : null;
  }, 120000, "New Game to reload", 500);
  report.check("New Game after a load drops +load and maps demo1",
    /\+map&demo1/.test(newGameSearch) && !/\+load/.test(newGameSearch),
    "+map demo1 and no +load", newGameSearch);

  // ---- nothing went wrong on the way -------------------------------------
  const pageErrors = app.pageErrors.filter((text) => /app\.js/.test(String(text)));
  const consoleProblems = app.consoleErrors.filter((text) => !/favicon|net::ERR_ABORTED|Failed to load resource/i.test(String(text)));
  report.check("app.js threw nothing", pageErrors.length === 0, "no page exception from app.js",
    pageErrors.length ? pageErrors.join(" | ") : "none");
  report.check("the page logged no errors", consoleProblems.length === 0, "no console errors",
    consoleProblems.length ? consoleProblems.join(" | ") : "none");
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
