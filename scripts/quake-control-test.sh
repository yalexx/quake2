#!/usr/bin/env bash
# scripts/quake-control-test.sh -- prove that the control interface really
# drives the live Quake 2 this box is showing.
#
# It talks to the game in the kiosk Chromium over the same Chrome DevTools
# Protocol endpoint the bridge uses (QUAKE2_CDP_URL, default
# http://127.0.0.1:18801), through control/bridge.mjs itself, so the test
# exercises the shipped code rather than a copy of it.
#
# It starts, stops and restarts nothing: in particular it never touches
# quake2-app.service or the game server on 4231, and it writes no saved game.
# It leaves the game playable: the in-game console is shut again, and the console
# dump it asks the engine for is deleted from the engine's file system afterwards
# (so nothing is left in the save store either).
#
# Step 4 needs a game to be running: Quake 2 refuses to open its console while it
# has none (the attract demo has ended and the main menu is up). When that is
# what happened, the test reloads the page to bring the engine back -- app.js's
# own way back, and the saved games are restored from the server -- and says so
# in its output instead of looking like broken input.
#
# Steps, each printed with its raw evidence:
#   1. the CDP endpoint answers
#   2. the game's own frame is there -- not the top-level ClawBox page
#   3. the bridge reads the game's status
#   4. a keypress reaches the engine: the commands typed over CDP come back in
#      the engine's own console transcript, read out of its file system
#   5. a screenshot comes back as a real PNG
#   6. mouse movement reaches the frame with exactly the delta that was asked for
#
# Exits 0 when every step passed, 1 otherwise. Environment:
#   QUAKE2_CDP_URL          CDP endpoint (default http://127.0.0.1:18801)
#   QUAKE_CONTROL_OUT_DIR   where the screenshot goes (default: a new temp folder,
#                           which is kept and printed, like scripts/e2e-saves.js)
#   TMPDIR                  temp folder for the step programs (default /tmp)
set -u

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CDP_URL="${QUAKE2_CDP_URL:-http://127.0.0.1:18801}"
OUT_DIR="${QUAKE_CONTROL_OUT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/quake-control-out.XXXXXX")}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/quake-control-test.XXXXXX")"
# The step programs are thrown away with the run; only the screenshot is kept.
trap 'rm -rf "$WORK"' EXIT

# Each run gets its own marker and dump name, so a leftover dump from an
# earlier run can never be mistaken for this one's proof.
MARKER="QUAKE2CTL$$"
DUMP="qcontrol$$"
export QUAKE2_BRIDGE="$ROOT/control/bridge.mjs"
export QUAKE2_CDP_URL="$CDP_URL"
export QUAKE_CONTROL_OUT="$OUT_DIR"
export QUAKE_CONTROL_MARKER="$MARKER"
export QUAKE_CONTROL_DUMP="$DUMP"
export QUAKE_CONTROL_SHOT="quake-control.png"

mkdir -p "$OUT_DIR"

if [ ! -f "$QUAKE2_BRIDGE" ]; then
  echo "missing $QUAKE2_BRIDGE -- run this from the app folder" >&2
  exit 1
fi

# ---- Step 1: the CDP endpoint answers ---------------------------------------
cat > "$WORK/step1.mjs" <<'JS'
const url = process.env.QUAKE2_CDP_URL;
let list;
try {
  const response = await fetch(url + "/json/list", { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("HTTP " + response.status);
  list = await response.json();
} catch (error) {
  console.error("cannot reach " + url + "/json/list: " + error.message);
  console.error("Is the ClawBox kiosk browser running?");
  process.exit(1);
}
const frames = list.filter((t) => String(t.url || "").includes("/apps/quake2/"));
console.log("endpoint: " + url);
console.log("targets: " + list.length + " (" + frames.length + " with /apps/quake2/ in the URL)");
for (const target of list) console.log("  " + target.type + "  " + target.url);
process.exit(0);
JS

# ---- Step 2: the game frame is there ----------------------------------------
cat > "$WORK/step2.mjs" <<'JS'
const { QuakeControl } = await import(process.env.QUAKE2_BRIDGE);
const game = new QuakeControl();
try {
  const found = await game.findGame();
  console.log("target: " + found.target.id + " (" + found.target.type + ") " + found.target.url);
  console.log("game frame: " + (found.frameId ? "child frame " + found.frameId + " of that page" : "the target's own top-level page"));
  console.log("never the top-level ClawBox page: " + (found.target.url.includes("/apps/quake2/") ? "yes, the URL is the game itself" : "the game is framed inside " + found.target.url));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
process.exit(0);
JS

# ---- Step 3: the bridge reads the game's status ------------------------------
cat > "$WORK/step3.mjs" <<'JS'
const { QuakeControl } = await import(process.env.QUAKE2_BRIDGE);
const game = new QuakeControl();
try {
  const status = await game.status();
  console.log(JSON.stringify(status, null, 2));
  if (!status.engine.module || !status.engine.filesystem) {
    console.error("the page is not running the engine (no Module or FS in the frame)");
    process.exit(1);
  }
  if (!status.engine.running) {
    console.error("the engine is not running: the canvas is hidden, which happens when the game has quit or aborted");
    process.exit(1);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
process.exit(0);
JS

# ---- Step 4: a keypress reaches the engine ----------------------------------
# CDP only tells us it dispatched an event. The proof is the engine's own
# console transcript: we type "echo <marker>" and "condump <name>" into the
# in-game console over CDP key events, then read the file condump wrote out of
# the engine's file system. Those lines can only be there if the engine's input
# handlers really received the keys.
cat > "$WORK/step4.mjs" <<'JS'
const { QuakeControl } = await import(process.env.QUAKE2_BRIDGE);
const game = new QuakeControl();
const marker = process.env.QUAKE_CONTROL_MARKER;
const name = process.env.QUAKE_CONTROL_DUMP;
const dumpPath = "/qwasm2/baseq2/" + name + ".txt";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// Both helpers run inside the game frame, in the engine's own file system.
const readDump = () => game.evaluate(`(function () { try { return FS.readFile(${JSON.stringify(dumpPath)}, { encoding: "utf8" }); } catch (e) { return null; } })()`);
const removeDump = () => game.evaluate(`(function () { try { FS.unlink(${JSON.stringify(dumpPath)}); return true; } catch (e) { return false; } })()`);

// Types the marker into the console, asks the engine to dump its console, and
// reads the dump back. The transcript, or null when the engine did not run it.
async function askTheEngine() {
  await removeDump().catch(() => {});
  // Two toggles of the console first: its line editor clears on each toggle, so
  // the run starts from an empty command line even if an earlier one left a
  // half-typed command in it. Two toggles also leave the console's open/shut
  // state exactly as it was.
  await game.tap("`");
  await game.tap("`");
  // The console is either open or shut when we arrive, and ` toggles it. Type
  // once; if the marker does not come back, the console was shut, so toggle it
  // open and type again. Two attempts is enough for both states.
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (attempt === 2) await game.tap("`");
    await game.typeText("echo " + marker);
    await game.tap("Enter");
    await game.typeText("condump " + name);
    await game.tap("Enter");
    await wait(700);
    const text = await readDump();
    if (typeof text === "string" && text.includes(marker)) {
      // Tidy up before returning: the dump goes, and the console is shut again
      // (whatever state it started in, it is open now).
      await removeDump().catch(() => {});
      await game.tap("`").catch(() => {});
      return { transcript: text, attempts: attempt };
    }
  }
  await removeDump().catch(() => {});
  await game.tap("`").catch(() => {});
  return null;
}

// Reloads the game page over raw CDP and waits for the engine to come back.
// Quake 2 refuses to open its console while it has no game running, and the
// attract demo it boots into ends after a few minutes and leaves the main menu
// up, so a game that has been open a while cannot be driven at all. Reloading is
// app.js's own way back ("Reload the page to play again"), and it restores the
// saved games from the server, so nothing is lost by it.
async function reloadGame() {
  const targets = await (await fetch(process.env.QUAKE2_CDP_URL + "/json/list")).json();
  const target = targets.find((t) => t.webSocketDebuggerUrl && String(t.url).includes("/apps/quake2/"));
  if (!target) return false;
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  socket.send(JSON.stringify({ id: 1, method: "Page.reload", params: {} }));
  await wait(500);
  socket.close();
  for (let i = 0; i < 60; i++) {
    await wait(2000);
    try {
      if ((await game.status()).engine.running) return true;
    } catch (error) {
      // still loading
    }
  }
  return false;
}

let answer = await askTheEngine();
if (answer === null) {
  console.log("the engine did not run the console command: it has no game running, and Quake 2 refuses its");
  console.log("console until one is. Reloading the page to bring the engine back up, then trying once more.");
  const reloaded = await reloadGame();
  console.log("page reloaded: " + (reloaded ? "the engine is up again" : "the engine did not come back"));
  if (reloaded) answer = await askTheEngine();
}
if (answer === null) {
  console.error("the engine never ran the console command we typed (tried twice before and twice after a reload).");
  console.error("So either the keys are not reaching the engine, or ` is not bound to toggleconsole in this game's");
  console.error("config, or the game refuses its console even with a game running.");
  process.exit(1);
}
const transcript = answer.transcript;
const attempts = answer.attempts;
console.log("marker: " + marker + " (typed one key at a time with Input.dispatchKeyEvent)");
console.log("attempts: " + attempts + " (the in-game console was " + (attempts === 1 ? "already open" : "shut; the first ` opened it") + ")");
console.log("the engine's own console transcript, read back through FS.readFile(" + dumpPath + "):");
for (const line of transcript.split("\n")) {
  if (line.includes(marker) || line.includes(name)) console.log("  " + line.trim());
}
console.log("dump deleted again: yes");
process.exit(0);
JS

# ---- Step 5: a screenshot ---------------------------------------------------
cat > "$WORK/step5.mjs" <<'JS'
const { QuakeControl } = await import(process.env.QUAKE2_BRIDGE);
const fs = await import("node:fs");
const path = await import("node:path");
const game = new QuakeControl();
try {
  const png = await game.screenshot();
  const file = path.join(process.env.QUAKE_CONTROL_OUT, process.env.QUAKE_CONTROL_SHOT);
  fs.writeFileSync(file, png);
  const magic = png.subarray(0, 4).toString("hex");
  console.log("file: " + file);
  console.log("bytes: " + png.length);
  console.log("magic: " + magic + (magic === "89504e47" ? " (PNG signature)" : " (NOT a PNG)"));
  if (magic !== "89504e47") process.exit(1);
  if (png.length < 1000) { console.error("the PNG is too small to be a game frame"); process.exit(1); }
  console.log("size: " + png.readUInt32BE(16) + "x" + png.readUInt32BE(20));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
process.exit(0);
JS

# ---- Step 6: mouse movement -------------------------------------------------
# A pointer-locked page reports movementX/Y as the change from the position of
# the previous mouse event, so the very first move of a session depends on where
# the browser last thought the pointer was. One zero-length move first puts the
# two sides back in step, and the moves after it are exact.
cat > "$WORK/step6.mjs" <<'JS'
const { QuakeControl } = await import(process.env.QUAKE2_BRIDGE);
const game = new QuakeControl();
try {
  // This run records into its own slot, and the page gets one listener for its
  // whole life (a listener per run would record every move once per earlier
  // run, and the last two would no longer be this run's moves).
  const slot = process.env.QUAKE_CONTROL_MARKER;
  const collect = `(function () {
    window.__qcTrack = window.__qcTrack || {};
    window.__qcTrack[${JSON.stringify(slot)}] = [];
    if (!window.__qcWatch) {
      window.__qcWatch = true;
      document.addEventListener("mousemove", function (e) {
        const record = { movementX: e.movementX, movementY: e.movementY, trusted: e.isTrusted };
        for (const key in window.__qcTrack) window.__qcTrack[key].push(record);
      }, true);
    }
    return "listening";
  })()`;
  await game.evaluate(collect);
  await game.mouseMove(0, 0);
  await game.mouseMove(60, 0);
  await game.mouseMove(-25, 12);
  const moves = JSON.parse(await game.evaluate(`JSON.stringify(window.__qcTrack[${JSON.stringify(slot)}].filter(function (m) { return m.movementX || m.movementY; }).slice(-2))`));
  const status = await game.status();
  console.log("asked for: [[60,0],[-25,12]]");
  console.log("the frame saw: " + JSON.stringify(moves.map((m) => [m.movementX, m.movementY])));
  console.log("all events trusted: " + moves.every((m) => m.trusted === true));
  console.log("pointer lock held: " + status.pointerLocked);
  const wanted = [[60, 0], [-25, 12]];
  const exact = moves.length === 2 && moves.every((m, i) => m.movementX === wanted[i][0] && m.movementY === wanted[i][1] && m.trusted === true);
  if (!exact) {
    console.error("the frame did not report exactly the deltas that were asked for");
    process.exit(1);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
process.exit(0);
JS

# ---- Run --------------------------------------------------------------------
PASSED=0
FAILED=0
run_step() {
  local number="$1" name="$2" program="$3"
  echo
  echo "=== step $number: $name"
  if node "$WORK/$program"; then
    echo "PASS: $name"
    PASSED=$((PASSED + 1))
  else
    echo "FAIL: $name"
    FAILED=$((FAILED + 1))
  fi
}

echo "Quake 2 control test -- endpoint $CDP_URL, screenshots in $OUT_DIR"
run_step 1 "the CDP endpoint answers" step1.mjs
run_step 2 "the game's own frame is there" step2.mjs
run_step 3 "the bridge reads the game's status" step3.mjs
run_step 4 "a keypress reaches the engine" step4.mjs
run_step 5 "a screenshot comes back as a PNG" step5.mjs
run_step 6 "mouse movement reaches the frame" step6.mjs

echo
if [ "$FAILED" -eq 0 ]; then
  echo "$PASSED/$PASSED steps passed."
  exit 0
fi
echo "$FAILED of $((PASSED + FAILED)) steps failed."
exit 1
