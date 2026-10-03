// control/bridge.mjs -- drive the live Quake 2 page over the Chrome DevTools
// Protocol, so an external agent can play the game the box is showing.
//
// The ClawBox desktop frames the game in the kiosk Chromium, whose CDP endpoint
// is http://127.0.0.1:18801. Input must go to the game's own frame (the target
// whose URL contains "/apps/quake2/"), never to the top-level ClawBox page: the
// shell would swallow the keys, and the engine would never see them.
//
// No call on the hot path opens the in-game console. The console is a pause --
// the engine stops simulating while it is up -- so a harness that read the
// player through it was fighting its own measurement: every step of a walk
// froze the game, and a fight could not be run honestly. Now:
//
//   * the player's position and view angles are read out of the engine's WASM
//     memory by engine-state.js, which the app serves and index.html loads;
//   * fire is the left mouse button and use is whatever key the engine's own
//     config binds to +use, both dispatched as real input;
//   * the console is only ever opened when a caller asks for it by name --
//     command(), state({ probe: true }), position({ console: true }),
//     use({ console: true }), respawn({ how: "map" }).
//
// The bridge counts every console key it sends (consoleMetrics()), and the page
// keeps its own record of `cls.key_dest` (quake2Engine.watch), so "the console
// was never opened" is something a run can show rather than assert.
//
// Zero dependencies. Node's built-in global WebSocket (Node 22+) speaks CDP
// directly, so there is nothing to install. ESM is strict by default, so no
// "use strict" pragma is needed.
//
//   import { QuakeControl, GameNotRunningError } from "./bridge.mjs";
//   const game = new QuakeControl();
//   await game.tap("w");                  // hold and release
//   await game.key("w", true);            // hold, until key("w", false)
//   await game.mouseMove(30, 0);          // turn right (pointer-locked delta)
//   await game.click("left");             // fire
//   console.log(await game.status());
//   await fs.writeFile("shot.png", await game.screenshot());
//
// Every call re-resolves the game target and opens its own short-lived CDP
// socket. The page can reload (the engine restarts itself on a fatal error),
// and a cached socket or target id would then be a stale handle; the cost of
// resolving again is a couple of milliseconds on loopback.

const DEFAULT_CDP_URL = "http://127.0.0.1:18801";
// The ClawBox serves every app under its own base path, so this marks the game
// frame and nothing else on the box.
const GAME_URL_MARK = "/apps/quake2/";
const DEFAULT_TIMEOUT_MS = 5000;
// CDP's Input.dispatchKeyEvent.modifiers is a bit field.
const MODIFIER_BITS = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

// The box of the game's own <iframe>, in the document that draws it, as a CDP
// clip wants it (viewport CSS pixels). Evaluated in whichever document holds
// the frame -- the shell's, or the top-level page's when the game is a tab.
const frameBoxExpression = (mark) => `(function () {
  const frame = document.querySelector('iframe[src*="${mark}"]') || document.querySelector("iframe");
  if (!frame) return "null";
  const box = frame.getBoundingClientRect();
  return JSON.stringify({ x: box.left, y: box.top, width: box.width, height: box.height, scale: 1 });
})()`;

// The origins of the documents that hold the game's frame, nearest ancestor
// first, as the frame itself reports them. This is the only question that
// answers "is the game framed?" for the ClawBox desktop: the desktop hosts the
// app as an out-of-process iframe, and an out-of-process child is *absent* from
// the shell's own Page.getFrameTree, so a frame tree cannot see it. The frame's
// own location can, across origins, so that is what is asked. The list is
// walked by index because DOMStringList is not iterable in every browser.
const ancestorOriginsExpression = `(function () {
  try {
    const ancestors = location.ancestorOrigins || [];
    const origins = [];
    for (let i = 0; i < ancestors.length; i++) origins.push(ancestors[i]);
    return JSON.stringify(origins);
  } catch (error) {
    return "[]";
  }
})()`;

// ---- The direct path -------------------------------------------------------
// The engine's live state is read straight out of the WASM linear memory by
// engine-state.js, a small script the app serves and index.html loads. That is
// the path every reading on the hot path takes: it is one Runtime.evaluate, it
// sends no input, and -- unlike the console probe below -- it does not stop the
// simulation. The console is still here, but only where a caller asks for it by
// name (command(), state({ probe: true }), position({ console: true })).
//
// The page-side hook answers `quake2Engine.state()`, which is the reading plus
// the page's own running record of `cls.key_dest` (see the console watch in
// engine-state.js). This expression also picks the current map out of the
// engine's console log, which is a file read and not a console visit, so
// position() keeps reporting the map without paying for a probe.
const directStateExpression = () => `(function () {
  const hook = (typeof quake2Engine !== "undefined" && quake2Engine) ? quake2Engine : null;
  const out = hook ? hook.state() : { read: { ok: false, reason: "NO_HOOK" }, watch: null };
  let map = null;
  const dirs = ${JSON.stringify(GAME_DIRS)};
  for (const dir of dirs) {
    try {
      const log = FS.readFile(dir + "/qconsole.log", { encoding: "utf8" });
      const lines = log.slice(-${CONSOLE_LOG_TAIL}).split("\\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        const m = line.match(/^mapname\\s+(\\S+)\\s*$/i)
          || line.match(/^"mapname"\\s+is\\s+"([^"]+)"/i)
          || line.match(/^Map:\\s+(\\S+)/i);
        if (m) { map = m[1]; break; }
      }
      break;
    } catch (error) { /* not this build's layout */ }
  }
  return JSON.stringify({ read: out.read, watch: out.watch, map });
})()`;

// The key the engine's own config binds to `+use`, read out of its config file.
// Quake 2 has no default `+use` binding -- a door opens by walking into it --
// so on a stock config this answers null, and useHold() says so instead of
// quietly falling back to the console. A config that binds one is honoured.
const useBindingExpression = () => `(function () {
  const dirs = ${JSON.stringify(GAME_DIRS)};
  for (const dir of dirs) {
    for (const name of ["config.cfg", "default.cfg"]) {
      let text = null;
      try { text = FS.readFile(dir + "/" + name, { encoding: "utf8" }); } catch (error) { continue; }
      const lines = text.split("\\n");
      const binds = {};
      // unbindall clears everything before it, and the engine's config opens
      // with one, so only the lines after the last unbindall count.
      let start = lines.length;
      for (let i = lines.length - 1; i >= 0; i--) if (/^\\s*unbindall\\b/i.test(lines[i])) { start = i; break; }
      for (let i = start; i < lines.length; i++) {
        const m = lines[i].match(/^\\s*bind\\s+(\\S+)\\s+"([^"]*)"/i);
        if (m) binds[m[1].toUpperCase()] = m[2];
      }
      for (const key of Object.keys(binds)) {
        if (binds[key].trim() === "+use") return JSON.stringify({ key });
      }
    }
  }
  return "null";
})()`;

// ---- Reading the game's state ---------------------------------------------
// Quake 2 has no scripting surface, and the Qwasm2 build exports no cvar or
// command accessor (its wasm exports are libc and SDL only), so the engine's
// own console was the one way to ask it anything. Everything the console prints
// is also mirrored, as the engine prints it, into a log file inside the
// engine's file system -- so an answer could be read without touching the page.
// This layer has two halves: the cheap read below (the log, the save store and
// the page: no input at all) and the probe (types Yamagi's two queries into the
// console, which is input, and reads their answers out of the same log). The
// probe is now an explicit fallback; the direct path above is what runs.
const PROBE_COMMANDS = ["viewpos", "serverinfo"];
// The answers are read back from a `condump` (the console's own "write what you
// have to a file" command) rather than from the live qconsole.log: the engine
// writes that log through C stdio, so it only reaches the file a few kilobytes
// at a time and a freshly typed command can sit in the buffer. `condump` writes
// the file there and then, which is why the live test uses it too.
const PROBE_DUMP = "q2state-probe"; // the engine appends ".txt"
// Where a Qwasm2 build mounts the game. The log is looked for in each, in
// order, because the path differs between builds and app.js's own namespace.
const GAME_DIRS = ["/qwasm2/baseq2", "/baseq2", "/quake2/baseq2"];
// The end of the log is all that matters, and the log only grows: reading the
// last few thousand characters keeps the transfer bounded for a long session.
const CONSOLE_LOG_TAIL = 12000;
// What the engine still cannot be asked for. The list is part of the answer, so
// a caller never has to guess why a field is null.
const UNREADABLE = ["health", "armour", "ammo"];
const STATE_NOTE =
  "Position and view angles come from the engine's own memory (engine-state.js), so " +
  "reading them sends no input and does not pause the game. health, armour and ammo " +
  "are null: Quake 2 has no console command that prints them and this pass did not " +
  "recover those fields from the WASM image, so they are reported as unknown rather " +
  "than guessed. alive is derived from the live view roll -- the death camera is the " +
  "one thing that moves it -- and paused is the engine's own: it is true whenever the " +
  "console or the menu holds the keyboard, and the engine draws PAUSED then. The map " +
  "and the server's running state come from the engine's console log, which the engine " +
  "writes through C stdio and can therefore lag. probe:true is the old console probe " +
  "(viewpos, serverinfo, read back out of a condump) and pauses the game while it runs.";

// The page-side half of the cheap read: where the game is mounted, what its
// console log says, which save slots exist, and the page's own state.
const stateExpression = `(function () {
  const canvas = document.getElementById("canvas");
  const dirs = ${JSON.stringify(GAME_DIRS)};
  let log = null;
  let logPath = null;
  for (const dir of dirs) {
    try {
      log = FS.readFile(dir + "/qconsole.log", { encoding: "utf8" });
      logPath = dir + "/qconsole.log";
      break;
    } catch (error) { /* not this build's layout */ }
  }
  let slots = [];
  const gameDir = logPath === null ? null : logPath.slice(0, -"/qconsole.log".length);
  if (gameDir) {
    try {
      slots = FS.readdir(gameDir + "/save").filter((name) => name !== "." && name !== "..");
    } catch (error) { /* no saves yet */ }
  }
  return JSON.stringify({
    running: !!canvas && canvas.style.display === "block",
    pointerLocked: !!(canvas && document.pointerLockElement === canvas),
    gameDir,
    slots,
    logPath,
    logLength: log === null ? 0 : log.length,
    log: log === null ? null : log.slice(-${CONSOLE_LOG_TAIL}),
  });
})()`;

// The probe's answer, read out of the file `condump` wrote in the game
// directory, and the removal of that file once it has been read.
const readDumpExpression = (dir) => `(function () {
  try {
    return FS.readFile(${JSON.stringify(dir + "/" + PROBE_DUMP + ".txt")}, { encoding: "utf8" });
  } catch (error) {
    return null;
  }
})()`;

const removeDumpExpression = (dir) => `(function () {
  try {
    FS.unlink(${JSON.stringify(dir + "/" + PROBE_DUMP + ".txt")});
    return true;
  } catch (error) {
    return false;
  }
})()`;

// The last line of a transcript that matches, as the regex's match array.
function lastMatch(lines, pattern) {
  for (let index = lines.length - 1; index >= 0; index--) {
    const match = lines[index].match(pattern);
    if (match) return match;
  }
  return null;
}

function lastLine(lines, pattern) {
  for (let index = lines.length - 1; index >= 0; index--) if (pattern.test(lines[index])) return index;
  return -1;
}

// The engine's own words, parsed: it prints its map name in three different
// places, its player position only for `viewpos`, and its level lifecycle as
// banner lines. Everything here comes from a transcript, so nothing is
// inferred from a value that is not in it.
function readEngineState(transcript) {
  const lines = String(transcript || "").split("\n");
  const map = lastMatch(lines, /^mapname\s+(\S+)\s*$/i)
    || lastMatch(lines, /^"mapname"\s+is\s+"([^"]+)"/i)
    || lastMatch(lines, /^Map:\s+(\S+)/i);
  const viewpos = lastMatch(lines, /^position:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+),\s*angles:\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)/i);
  // A level is running when the last banner of a level start is later than the
  // last banner of a shutdown.
  const started = Math.max(lastLine(lines, /server initialization/i), lastLine(lines, /^Map:\s/i));
  const stopped = Math.max(lastLine(lines, /Server was killed/i), lastLine(lines, /ShutdownGame/i));
  const angles = viewpos ? { pitch: Number(viewpos[4]), yaw: Number(viewpos[5]), roll: Number(viewpos[6]) } : null;
  return {
    map: map ? map[1] : null,
    running: started >= 0 && started > stopped,
    position: viewpos ? { x: Number(viewpos[1]), y: Number(viewpos[2]), z: Number(viewpos[3]) } : null,
    angles,
    // A living player's view never rolls: Quake 2 has no lean, and the view
    // angles are the ones the client smooths from the input, which keep roll at
    // zero. The death camera is the one thing that rolls them, so a non-zero
    // roll is how a caller learns the player is dead without a screenshot --
    // and this engine has no console command that prints health (see "Reading
    // the game's state"). It matters because every movement key does nothing at
    // all while the player is dead, which otherwise reads as a follower that has
    // walked into a wall.
    dead: !!angles && Math.abs(angles.roll) > 1,
    lines,
  };
}

// What those ancestors mean for a caller: whether the game sits inside a host
// document (the desktop shell) and which one, and therefore which page a
// screenshot has to be taken from. An empty list means the game is its own tab,
// and its target may be captured whole.
function describeFraming(ancestorOrigins) {
  const ancestors = (Array.isArray(ancestorOrigins) ? ancestorOrigins : []).filter((origin) => typeof origin === "string");
  const framed = ancestors.length > 0;
  const hostOrigin = framed ? ancestors[ancestors.length - 1] : null;
  return {
    framed,
    hostOrigin,
    screenshotFrom: framed ? "host-page" : "game-tab",
    screenshotNote: framed
      ? "from the page that draws the game's frame (" + hostOrigin + "), cropped to the frame"
      : "from the game's own tab",
  };
}

// Thrown when there is no game to drive. Its message is what an operator sees,
// so it says what was looked for and what the browser did have.
export class ControlError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ControlError";
    this.code = code;
  }
}

export class GameNotRunningError extends ControlError {
  constructor(message) {
    super(message);
    this.name = "GameNotRunningError";
    this.code = "GAME_NOT_RUNNING";
  }
}

// ---- Key table ------------------------------------------------------------
// `vk` is the legacy keyCode the engine's Emscripten/SDL layer maps back to a
// key symbol (that mapping is what Quake's bindings are looked up with).
// `text` is what a char event carries: without it a key still reaches the
// engine's bindings, but the in-game console would never receive the letter.
// `shiftText` is the same key with Shift held, e.g. "_" for the minus key.

const NAMED_KEYS = {
  Backspace: { code: "Backspace", vk: 8 },
  Tab: { code: "Tab", vk: 9, text: "\t" },
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Escape: { code: "Escape", vk: 27 },
  Space: { code: "Space", vk: 32, text: " " },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  End: { code: "End", vk: 35 },
  Home: { code: "Home", vk: 36 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  Insert: { code: "Insert", vk: 45 },
  Delete: { code: "Delete", vk: 46 },
  // The space bar, spelled as the character it types, so a command string can
  // simply be typed through.
  " ": { code: "Space", vk: 32, text: " " },
  "`": { code: "Backquote", vk: 192, text: "`", shiftText: "~" },
  "-": { code: "Minus", vk: 189, text: "-", shiftText: "_" },
  "=": { code: "Equal", vk: 187, text: "=", shiftText: "+" },
  "[": { code: "BracketLeft", vk: 219, text: "[", shiftText: "{" },
  "]": { code: "BracketRight", vk: 221, text: "]", shiftText: "}" },
  "\\": { code: "Backslash", vk: 220, text: "\\", shiftText: "|" },
  ";": { code: "Semicolon", vk: 186, text: ";", shiftText: ":" },
  "'": { code: "Quote", vk: 222, text: "'", shiftText: '"' },
  ",": { code: "Comma", vk: 188, text: ",", shiftText: "<" },
  ".": { code: "Period", vk: 190, text: ".", shiftText: ">" },
  "/": { code: "Slash", vk: 191, text: "/", shiftText: "?" },
};

// Modifier keys are pressed like any other, but they set a bit that the next
// events carry, and they never produce a character.
const MODIFIER_KEYS = {
  Shift: { code: "ShiftLeft", vk: 16, bit: MODIFIER_BITS.Shift },
  Control: { code: "ControlLeft", vk: 17, bit: MODIFIER_BITS.Control },
  Alt: { code: "AltLeft", vk: 18, bit: MODIFIER_BITS.Alt },
  Meta: { code: "MetaLeft", vk: 91, bit: MODIFIER_BITS.Meta },
};

// Spoken names an agent is likely to send, mapped onto the table above.
const KEY_ALIASES = {
  esc: "Escape", escape: "Escape", return: "Enter", cr: "Enter",
  spacebar: "Space", space: "Space", tabulator: "Tab", del: "Delete",
  ins: "Insert", pgup: "PageUp", pgdn: "PageDown",
  up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
  backtick: "`", grave: "`", tilde: "`", console: "`",
  minus: "-", dash: "-", equal: "=", equals: "=", plus: "+",
  comma: ",", period: ".", dot: ".", slash: "/", backslash: "\\",
  semicolon: ";", quote: "'", apostrophe: "'",
  shift: "Shift", ctrl: "Control", control: "Control", alt: "Alt", option: "Alt",
  meta: "Meta", cmd: "Meta", command: "Meta", super: "Meta", win: "Meta",
};

// The character each key makes with Shift held, keyed by that character: what
// lets typeText() send a command containing "_" or "(" straight through. A
// keyboard sends those as Shift plus the base key, and so does the bridge.
const DIGIT_SYMBOLS = ")!@#$%^&*(";
const SHIFTED_CHARS = {};
for (const [base, named] of Object.entries(NAMED_KEYS)) {
  if (named.shiftText) SHIFTED_CHARS[named.shiftText] = { key: named.shiftText, code: named.code, vk: named.vk };
}
for (let digit = 0; digit <= 9; digit++) {
  SHIFTED_CHARS[DIGIT_SYMBOLS[digit]] = { key: DIGIT_SYMBOLS[digit], code: "Digit" + digit, vk: 48 + digit };
}

// Everything the CDP event needs for one key, or a thrown error naming the key.
function describeKey(name, shiftHeld) {
  if (typeof name !== "string" || name === "") {
    throw new ControlError("key must be a non-empty string", "BAD_REQUEST");
  }
  // A single character stands for itself: "w", "7", "`".
  let key = name.length === 1 ? name : (KEY_ALIASES[name.toLowerCase()] ?? name);
  if (/^f([1-9]|1[0-2])$/i.test(key)) {
    const n = Number(key.slice(1));
    return { key: "F" + n, code: "F" + n, vk: 111 + n };
  }
  if (MODIFIER_KEYS[key]) {
    const mod = MODIFIER_KEYS[key];
    return { key, code: mod.code, vk: mod.vk, bit: mod.bit };
  }
  const named = NAMED_KEYS[key];
  if (named) return { key, ...named, text: shiftHeld ? named.shiftText : named.text };
  const shifted = SHIFTED_CHARS[key];
  if (shifted) return { ...shifted, text: key, needsShift: true };
  if (/^[a-z]$/i.test(key)) {
    const upper = key === key.toUpperCase();
    const up = key.toUpperCase();
    // A capital letter is Shift plus the key, exactly as a keyboard sends it.
    return { key: upper || shiftHeld ? up : key.toLowerCase(), code: "Key" + up, vk: up.charCodeAt(0), text: upper || shiftHeld ? up : key.toLowerCase(), needsShift: upper };
  }
  if (/^[0-9]$/.test(key)) {
    // Shift turns the top-row digits into their symbols, which the console needs.
    const symbols = ")!@#$%^&*(";
    return { key, code: "Digit" + key, vk: key.charCodeAt(0), text: shiftHeld ? symbols[Number(key)] : key };
  }
  throw new ControlError("unknown key " + JSON.stringify(name), "BAD_REQUEST");
}

// ---- CDP session ----------------------------------------------------------

// One WebSocket to one CDP target. CDP messages are JSON: requests carry an
// id, replies echo it, and events come without one.
class CdpSession {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 0;
    this.pending = new Map();
    this.listeners = new Set();
    socket.addEventListener("message", (event) => this.onMessage(event.data));
    socket.addEventListener("close", () => this.fail(new ControlError("the CDP socket closed", "DISCONNECTED")));
    socket.addEventListener("error", () => this.fail(new ControlError("the CDP socket failed", "DISCONNECTED")));
  }

  static open(url, timeoutMs) {
    return new Promise((resolve, reject) => {
      let socket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        reject(new ControlError("cannot reach the browser at " + url + ": " + error.message, "CDP_UNREACHABLE"));
        return;
      }
      const timer = setTimeout(() => {
        socket.close();
        reject(new ControlError("the browser at " + url + " did not answer within " + timeoutMs + " ms", "TIMEOUT"));
      }, timeoutMs);
      socket.addEventListener("open", () => {
        clearTimeout(timer);
        resolve(new CdpSession(socket));
      }, { once: true });
      socket.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new ControlError("cannot connect to the browser at " + url, "CDP_UNREACHABLE"));
      }, { once: true });
    });
  }

  onMessage(data) {
    let message;
    try {
      message = JSON.parse(data);
    } catch {
      return; // not a CDP frame; nothing useful to do with it
    }
    if (message.id === undefined) {
      for (const listener of this.listeners) listener(message);
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    if (message.error) entry.reject(new ControlError("CDP " + entry.method + " failed: " + message.error.message, "CDP_ERROR"));
    else entry.resolve(message.result);
  }

  // Rejects every call still in flight when the socket dies, so no caller waits
  // for a reply that will never come.
  fail(error) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) entry.reject(error);
  }

  send(method, params = {}) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  onEvent(listener) {
    this.listeners.add(listener);
  }

  close() {
    try {
      this.socket.close();
    } catch {
      // already gone
    }
  }
}

// ---- Navigation arithmetic ------------------------------------------------

// How long the engine is given to write its `condump` file after the keys have
// gone in. Writing is not part of the key dispatch, so it needs a moment.
const PROBE_SETTLE_MS = 150;
// The gap between characters when a string is typed into the console. Back to
// back, the engine drops them (see #typeInto).
const TYPE_KEY_GAP_MS = 15;
// Face() stops when the bearing is this close, in degrees.
const FACE_TOLERANCE_DEGREES = 4;
// How many turns in a row may come back as nothing before a method is retired.
// More than one, because a single miss is what a dead player looks like -- and
// what a key hold too short to land on a frame looks like (see #turnBy); fewer
// than many, because a method that is really gone should not keep costing a
// round of every turn for the whole run.
const TURN_MISSES_BEFORE_RETIRING = 3;
// Quake 2's own defaults: sensitivity 3 against m_yaw 0.022 is about a
// fifteenth of a degree per mouse count. Only ever a starting guess -- face()
// measures the real ratio on its first successful turn and uses that instead.
const DEFAULT_DEGREES_PER_MOUSE_UNIT = 0.066;
// cl_yawspeed, degrees per second, for the +left/+right keys.
const DEFAULT_YAW_SPEED_DEGREES_PER_SECOND = 140;
// The gap between a map's floor and the position the engine reports for the
// player standing on it: the player's origin is the middle of their 32x32x56
// box (24 up) and the view sits another 22 above that. A target that comes from
// map data is a floor, so goto() compares z loosely unless told otherwise.
const EYE_ABOVE_FEET = 46;
const DEFAULT_Z_TOLERANCE = 64;

function numberOr(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

// Fold any angle into (-180, 180]: the turn actually needed, not the long way.
function shortestTurn(degrees) {
  let angle = Number(degrees) % 360;
  if (angle > 180) angle -= 360;
  if (angle <= -180) angle += 360;
  return angle;
}

function horizontalDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// Quake 2's compass: 0 is +X, 90 is +Y, anticlockwise.
function bearingTo(from, to) {
  const bearing = Math.atan2(to.y - from.y, to.x - from.x) * (180 / Math.PI);
  return (bearing + 360) % 360;
}

// {x, y, z} out of whatever the caller passed, or null if it is not a point.
function describePoint(target) {
  if (!target || typeof target !== "object") return null;
  const point = { x: Number(target.x), y: Number(target.y), z: Number(target.z) };
  if (![point.x, point.y, point.z].every(Number.isFinite)) return null;
  return point;
}

// ---- The bridge -----------------------------------------------------------

export class QuakeControl {
  // options.cdpUrl overrides the endpoint (QUAKE2_CDP_URL does the same).
  // options.timeoutMs bounds every CDP round trip.
  // options.gameUrlMark overrides the substring that identifies the game frame.
  constructor(options = {}) {
    this.cdpUrl = String(options.cdpUrl || process.env.QUAKE2_CDP_URL || DEFAULT_CDP_URL).replace(/\/$/, "");
    this.timeoutMs = options.timeoutMs || Number(process.env.QUAKE2_CDP_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
    this.gameUrlMark = options.gameUrlMark || GAME_URL_MARK;
    this.modifiers = 0; // held modifier bits, kept across calls
    // Where the next mouse event is dispatched from. A pointer-locked page
    // reports movementX/Y as the change from the previous dispatch position, so
    // the bridge keeps its own virtual cursor and adds each delta to it.
    this.cursor = null;
    // The engine's console is a toggle with no way to ask which way it is. The
    // bridge is the only thing that toggles it, so it counts: every toggle it
    // makes flips this. #askEngine re-checks against reality and corrects it
    // when a dump does not come back.
    this.consoleOpen = false;
    // Whether `+attack` was the last thing sent. The bridge cannot press a key
    // the engine has already been told to hold, so a caller that dies mid-fight
    // would otherwise leave the player firing at nothing forever.
    this.attacking = false;
    // What this bridge has spent on the engine's console. `toggles` counts
    // every console key sent, `opens` only those that opened it, and
    // `roundTrips` every completed open-type-dump-close cycle. This is the
    // bridge's half of the proof that the hot path never visits the console;
    // the page's half is quake2Engine.watch, which samples cls.key_dest. Both
    // are reported by consoleMetrics().
    this.console = { toggles: 0, opens: 0, roundTrips: 0 };
    // The key the engine's own config binds to `+use`: undefined = not looked
    // up yet, null = the config binds none (which is what a stock Quake 2
    // config does), a string = the key to press.
    this.useBinding = undefined;
    // What this bridge has learned about the current level, as { name, source }.
    // The map name has no stable address in the image (see #readEngineState), so
    // it is learned instead: from a `mapname` the engine answered (its own word
    // for the level it is running), from a `map <name>` this bridge issued (a
    // request, not a fact), and from the engine's log. The reading says which
    // of the three answered.
    this.mapHint = null;
    // What face() has learned about turning: how far one mouse count turns the
    // player, how fast the arrow keys turn, and whether each works at all.
    // null means "not measured yet". `misses` counts consecutive turns that
    // came back as no turn at all, per method, because one of those is not
    // evidence of anything -- see #learnTurn.
    this.turnCalibration = {
      mouseDegreesPerUnit: this.#optionsDegreesPerUnit(options),
      keyDegreesPerMs: null,
      mouseWorks: null,
      keysWork: null,
      misses: { keys: 0, mouse: 0 },
    };
  }

  #optionsDegreesPerUnit(options) {
    const given = numberOr(options.degreesPerMouseUnit ?? process.env.QUAKE2_DEGREES_PER_MOUSE_UNIT, NaN);
    return Number.isFinite(given) && given > 0 ? given : null;
  }

  // Every debuggable target the browser knows about.
  async targets() {
    const url = this.cdpUrl + "/json/list";
    let response;
    try {
      response = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (error) {
      throw new ControlError("cannot reach the browser at " + this.cdpUrl + " (" + error.message + "). Is the ClawBox browser running?", "CDP_UNREACHABLE");
    }
    if (!response.ok) {
      throw new ControlError("the browser at " + this.cdpUrl + " answered HTTP " + response.status + " for /json/list", "CDP_UNREACHABLE");
    }
    const list = await response.json();
    if (!Array.isArray(list)) throw new ControlError("the browser's /json/list is not a target list", "CDP_UNREACHABLE");
    return list;
  }

  // The game target: a page whose URL is the app itself, or a page holding a
  // child frame with that URL (the ClawBox desktop frames the app). Which frame
  // inside that target it lands on is settled in #withSession, from the same
  // frame tree, and reported back as /json/list saw it here.
  async findGame() {
    const targets = await this.targets();
    const shareable = targets.filter((t) => t.webSocketDebuggerUrl);
    const direct = shareable.find((t) => t.url && t.url.includes(this.gameUrlMark));
    if (direct) return { target: direct, frameId: null };
    // Nothing matched by URL alone: the game may sit in a frame of the shell.
    for (const target of shareable.filter((t) => t.type === "page")) {
      const frameId = await this.#findFrame(target).catch(() => null);
      if (frameId) return { target, frameId };
    }
    const seen = targets.map((t) => t.type + " " + t.url).join("\n  ");
    throw new GameNotRunningError(
      'no Quake 2 frame on the CDP endpoint ' + this.cdpUrl + ' (looked for a target or frame whose URL contains "' + this.gameUrlMark + '").\n' +
      "Is the Quake 2 app open in the ClawBox browser? /json/list reported " + targets.length + " target(s):\n  " + seen);
  }

  // The id of the child frame whose URL is the game, or null if this target has
  // no such frame.
  async #findFrame(target) {
    const session = await CdpSession.open(target.webSocketDebuggerUrl, this.timeoutMs);
    try {
      const { frameTree } = await session.send("Page.getFrameTree");
      const stack = [frameTree];
      while (stack.length) {
        const node = stack.shift();
        if (node.frame && node.frame.url && node.frame.url.includes(this.gameUrlMark)) return node.frame.id;
        stack.push(...(node.childFrames || []));
      }
      return null;
    } finally {
      session.close();
    }
  }

  // Runs fn against the game frame. Everything public funnels through here, so
  // the target is resolved afresh each time and the socket is always released.
  async #withSession(fn) {
    const { target } = await this.findGame();
    const session = await CdpSession.open(target.webSocketDebuggerUrl, this.timeoutMs);
    try {
      // A frame's execution contexts are announced when Runtime is first enabled
      // on a socket -- a second enable announces nothing -- so the collector goes
      // in before the enable and the contexts are picked out of it afterwards.
      const contexts = [];
      session.onEvent((message) => {
        if (message.method === "Runtime.executionContextCreated") contexts.push(message.params.context);
      });
      await session.send("Page.enable");
      await session.send("Runtime.enable");
      const { frameTree } = await session.send("Page.getFrameTree");
      // Resolve the game frame inside this session: a direct hit is the main
      // frame, otherwise the marked child frame.
      let frame = frameTree.frame;
      if (!frame.url.includes(this.gameUrlMark)) {
        const stack = [frameTree];
        let found = null;
        while (stack.length) {
          const node = stack.shift();
          if (node.frame.url && node.frame.url.includes(this.gameUrlMark)) { found = node.frame; break; }
          stack.push(...(node.childFrames || []));
        }
        if (!found) throw new GameNotRunningError("the game frame disappeared while connecting to " + this.cdpUrl);
        frame = found;
      }
      // Only a target that *is* the game is captured whole; a framed game is
      // cropped to the frame, so a screenshot never includes the shell around it.
      const isWholeTarget = frame.id === frameTree.frame.id;
      const gameContext = await this.#contextOf(contexts, frame.id);
      const topContext = isWholeTarget ? gameContext : await this.#contextOf(contexts, frameTree.frame.id);
      const evaluateIn = (contextId) => (expression) => session.send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
        contextId,
      }).then((result) => {
        if (result.exceptionDetails) throw new ControlError("the game page threw: " + (result.exceptionDetails.exception?.description || result.exceptionDetails.text), "PAGE_ERROR");
        return result.result ? result.result.value : undefined;
      });
      const game = {
        session,
        frame,
        isWholeTarget,
        // The game's own world: where Module, FS and the canvas live.
        evaluate: evaluateIn(gameContext),
        // The top document: where a <iframe> holding the game can be measured.
        evaluateTop: evaluateIn(topContext),
      };
      return await fn(game, target);
    } finally {
      session.close();
    }
  }

  // The origins of the frames holding the game, asked of the game frame itself
  // (the one document that can answer for an out-of-process iframe).
  async #ancestorOriginsOf(game) {
    return JSON.parse(await game.evaluate(ancestorOriginsExpression));
  }

  // The default execution context of one frame: the world the page's own script
  // runs in, where its Module and FS globals live. The announcement can arrive a
  // moment after Runtime.enable answers, so this gives it a moment to turn up.
  async #contextOf(contexts, frameId) {
    for (let attempt = 0; attempt < 50; attempt++) {
      const match = contexts.find((c) => c.auxData && c.auxData.frameId === frameId && c.auxData.isDefault !== false);
      if (match) return match.id;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new ControlError("could not find the JavaScript context of the game frame " + frameId, "PAGE_ERROR");
  }

  // Brings the canvas to the front of the input queue. The engine only sees a
  // key when the canvas holds focus; a plain focus() is enough for the keyboard,
  // but the mouse needs pointer lock, which browsers grant only inside a user
  // gesture -- so a real click is sent when the game is not locked yet.
  async focusCanvas(game) {
    const state = await game.evaluate(`(function () {
      const canvas = document.getElementById("canvas");
      if (!canvas) return "no-canvas";
      canvas.focus();
      return document.pointerLockElement === canvas ? "locked" : "unlocked";
    })()`);
    if (state === "no-canvas") throw new ControlError("the game page has no canvas element", "PAGE_ERROR");
    if (state === "locked") return;
    const rect = await game.evaluate(`(function () {
      const canvas = document.getElementById("canvas");
      const box = canvas.getBoundingClientRect();
      return JSON.stringify({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
    })()`);
    const point = JSON.parse(rect);
    // A press and release in the middle of the canvas: the page's own click
    // handler asks for pointer lock, and the engine gets a focused canvas.
    const session = game.session;
    for (const type of ["mousePressed", "mouseReleased"]) {
      await session.send("Input.dispatchMouseEvent", {
        type, x: point.x, y: point.y, button: "left", buttons: type === "mousePressed" ? 1 : 0, clickCount: 1,
      });
    }
    this.cursor = point;
  }

  // Press (down=true) or release (down=false) one key. Named keys: "w", "Space",
  // "Enter", "Escape", "F5", "ArrowUp", "Shift", "--" (see KEY_ALIASES).
  async key(key, down = true) {
    return this.#withSession(async (game) => {
      await this.focusCanvas(game);
      return this.#sendKey(game, key, down);
    });
  }

  // Press and release, the common case.
  async tap(key) {
    return this.#withSession(async (game) => {
      await this.focusCanvas(game);
      return this.#tapOn(game, key);
    });
  }

  // Press and release one key on a session that is already focused.
  async #tapOn(game, key) {
    await this.#sendKey(game, key, true);
    return this.#sendKey(game, key, false);
  }

  // Types a string one key at a time, for the in-game console mostly. All of it
  // goes over one session, because a session costs a CDP handshake and a
  // command-long string is dozens of keys.
  async typeText(text) {
    const characters = [...String(text)];
    // Reject an untypable character before anything is sent, so a command is
    // never left half-typed into the game's console.
    for (const character of characters) describeKey(character, false);
    return this.#withSession(async (game) => {
      await this.focusCanvas(game);
      await this.#typeInto(game, text);
      return { typed: characters.length };
    });
  }

  // Type a string on an open session, one key at a time, with a small gap
  // between the keys.
  //
  // The gap is not cosmetic. Queued back to back the engine drops characters --
  // `map demo1` has arrived as `mo1` on this box -- because a key event that
  // lands in the same frame as the one before it is not read. The whole point
  // of this call is to get a command into the engine intact, so it gives each
  // key a frame's worth of room. It costs about 15 ms per character and it is
  // only ever on the console path, which is opt-in.
  async #typeInto(game, text) {
    const characters = [...String(text)];
    for (let index = 0; index < characters.length; index++) {
      if (index > 0) await new Promise((resolve) => setTimeout(resolve, TYPE_KEY_GAP_MS));
      await this.#sendKey(game, characters[index], true);
      await this.#sendKey(game, characters[index], false);
    }
    return characters.length;
  }

  // One key event on an open session. Kept separate from key()/tap() so a whole
  // string can be typed without reconnecting between characters.
  async #sendKey(game, key, down) {
    const shiftHeld = (this.modifiers & MODIFIER_BITS.Shift) !== 0 && String(key).toLowerCase() !== "shift";
    const description = describeKey(key, shiftHeld);
    // Escape is the one key Chromium keeps for itself -- it is what leaves
    // pointer lock and fullscreen -- so a trusted Escape from CDP never arrives
    // at the page at all (the page's own listeners never see it). It is rebuilt
    // inside the page instead, where the engine's handlers do not ask whether an
    // event is trusted, so Escape is Escape again: the game's menu opens and
    // shuts on it exactly as it would for a player.
    if (description.code === "Escape") {
      await game.evaluate(`(function () {
        document.dispatchEvent(new KeyboardEvent(${JSON.stringify(down ? "keydown" : "keyup")}, {
          key: "Escape", code: "Escape", keyCode: 27, which: 27, bubbles: true, cancelable: true,
        }));
        return true;
      })()`);
      return { key: "Escape", down };
    }
    // A character that only exists with Shift ("_", "A") carries the bit itself.
    const modifiers = description.needsShift ? this.modifiers | MODIFIER_BITS.Shift : this.modifiers;
    const event = {
      key: description.key,
      code: description.code,
      windowsVirtualKeyCode: description.vk,
      nativeVirtualKeyCode: description.vk,
      modifiers,
    };
    // A modifier key is held and released like any other, but its own event
    // carries no character and never the bit it is about to set.
    if (description.bit) {
      await game.session.send("Input.dispatchKeyEvent", { type: down ? "rawKeyDown" : "keyUp", ...event, modifiers: down ? this.modifiers : this.modifiers & ~description.bit });
      this.modifiers = down ? this.modifiers | description.bit : this.modifiers & ~description.bit;
      return { key: description.key, down };
    }
    const type = down ? (description.text ? "keyDown" : "rawKeyDown") : "keyUp";
    const params = { type, ...event };
    if (down && description.text) {
      params.text = description.text;
      params.unmodifiedText = description.text;
    }
    await game.session.send("Input.dispatchKeyEvent", params);
    return { key: description.key, down, text: description.text };
  }

  // Moves the mouse by a delta, as a pointer-locked game expects. The page
  // reports movementX/Y as the change from the previous dispatch position, so
  // the delta is added to the bridge's own cursor and the event is dispatched
  // there; nothing is clamped, because a game in pointer lock only reads the
  // movement, not the position.
  async mouseMove(dx, dy) {
    return this.#withSession(async (game) => {
      await this.focusCanvas(game);
      if (!this.cursor) {
        const centre = await game.evaluate(`(function () {
          const canvas = document.getElementById("canvas");
          const box = canvas.getBoundingClientRect();
          return JSON.stringify({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
        })()`);
        this.cursor = JSON.parse(centre);
      }
      this.cursor.x += Number(dx) || 0;
      this.cursor.y += Number(dy) || 0;
      await game.session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved", x: this.cursor.x, y: this.cursor.y, button: "none", buttons: 0, modifiers: this.modifiers,
      });
      return { dx: Number(dx) || 0, dy: Number(dy) || 0, x: this.cursor.x, y: this.cursor.y };
    });
  }

  // Clicks a mouse button where the cursor last was (the canvas centre at
  // worst). "left" is Quake's fire button.
  async click(button = "left") {
    const name = String(button).toLowerCase();
    if (!["left", "right", "middle"].includes(name)) {
      throw new ControlError('button must be "left", "right" or "middle"', "BAD_REQUEST");
    }
    return this.#withSession(async (game) => {
      await this.focusCanvas(game);
      const point = this.cursor || JSON.parse(await game.evaluate(`(function () {
        const canvas = document.getElementById("canvas");
        const box = canvas.getBoundingClientRect();
        return JSON.stringify({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
      })()`));
      const pressed = { left: 1, right: 2, middle: 4 }[name];
      await game.session.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: name, buttons: pressed, clickCount: 1, modifiers: this.modifiers });
      await game.session.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: name, buttons: 0, clickCount: 1, modifiers: this.modifiers });
      return { button: name };
    });
  }

  // ---- Navigation ---------------------------------------------------------
  //
  // key() and mouseMove() push a button and come back; that is enough to open a
  // door, and not enough to arrive anywhere. Closing the loop needs three things
  // the engine will only say through its console -- where the player is, which
  // way they face, and how far a mouse count actually turns them -- so this
  // section adds them on top of the same probe state() already uses.
  //
  // The console is a *toggle* and the bridge now remembers which way it left it.
  // Typing a command into a console somebody else closed sends the characters
  // into the game as keystrokes, and opening one that is already open closes it;
  // both look exactly like the engine ignoring you.
  //
  // Everything here reports what it observed. A turn that did not turn, a walk
  // into a wall and a console that refused to open all come back as such,
  // because an agent that is told "reached" when it is stuck in a corner has
  // been told something worse than nothing.

  // Where the player is and which way they are looking, read live out of the
  // engine's own memory (see "The direct path" at the top of this file) -- plus
  // the current map, which comes from the engine's console log because a file
  // read costs nothing and does not stop the game.
  //
  // This is the call the hot path is built on: goto() runs it once a round and
  // face() runs it after every turn, so it must send no input and must not
  // pause. It does neither. A caller that wants the console probe -- to check
  // this reading against the engine's own `viewpos`, or because it is driving a
  // page that does not serve engine-state.js -- asks for it by name:
  //   position({ console: true })  the old probe, explicitly
  //   position({ verify: true })   both, and a comparison of the two
  async position(options = {}) {
    return this.#withSession(async (game) => {
      const direct = await this.#readEngineState(game);
      if (direct.read.ok) {
        const result = this.#positionFromDirect(direct);
        if (options.verify === true) result.verify = await this.#verifyAgainstConsole(game, result);
        return result;
      }
      // No hook, or the engine has not laid its memory out yet. The console is
      // the fallback and it is taken only when the caller asked for it.
      if (options.console !== true && options.verify !== true) {
        return {
          probed: false,
          source: "wasm-memory",
          position: null,
          angles: null,
          map: direct.map,
          running: false,
          reason: direct.read.reason,
          message: "the page did not answer with the engine's live state (" + direct.read.reason + "). " +
            "engine-state.js is served with the app and index.html loads it; a page without it can still be " +
            "driven through the console by asking: position({ console: true }).",
          console: this.consoleMetrics(),
        };
      }
      const answer = await this.#askEngine(game, ["viewpos", "mapname"]);
      const engine = readEngineState(answer.text || "");
      if (!answer.text) {
        return {
          probed: false,
          source: "console",
          position: null,
          angles: null,
          map: null,
          running: false,
          reason: "NO_ANSWER",
          message: "the engine did not answer on its console. It refuses to open the console during the attract demo and drops keys while it boots; " +
            "if no level is running, start one first (command(\"map demo1\")).",
          console: this.consoleMetrics(),
        };
      }
      return {
        probed: true,
        source: "console",
        position: engine.position,
        angles: engine.angles,
        map: engine.map,
        mapSource: engine.map ? "console-log" : null,
        running: engine.running,
        dead: engine.dead,
        attempts: answer.attempts,
        console: this.consoleMetrics(),
      };
    });
  }

  // What the engine's console has cost this bridge so far. The companion
  // measurement is the page's own: quake2Engine.watch samples cls.key_dest and
  // counts every sample where the keyboard was not the game's, which catches a
  // console opened by anything, not just by this bridge.
  consoleMetrics() {
    return { toggles: this.console.toggles, opens: this.console.opens, roundTrips: this.console.roundTrips, open: this.consoleOpen };
  }

  // The page's answer: the live reading, the page's console watch, and the map
  // the engine last printed. One evaluate, no input.
  async #readEngineState(game) {
    let parsed = null;
    try {
      parsed = JSON.parse(await game.evaluate(directStateExpression()));
    } catch {
      // A page that threw, or an answer that was not JSON: no reading.
    }
    if (!parsed || typeof parsed !== "object") return { read: { ok: false, reason: "BAD_REPLY" }, watch: null, map: null, mapSource: null };
    const read = parsed.read && typeof parsed.read === "object" ? parsed.read : { ok: false, reason: "BAD_REPLY" };
    // The map name is the one field with no stable home in the image: this
    // build keeps it in a heap-allocated string whose address moves between
    // runs, so there is no offset to recover and none is guessed. The log is
    // the engine's own words and costs a file read; when it has nothing, the
    // level the bridge itself last asked for is the next best thing, and it
    // says which one answered.
    const fromLog = parsed.map === undefined ? null : parsed.map;
    const hint = this.mapHint && this.mapHint.name ? this.mapHint : null;
    // What the engine said about itself beats what it was asked for.
    if (hint && hint.source === "mapname") return { read, watch: parsed.watch || null, map: hint.name, mapSource: "mapname" };
    if (fromLog) return { read, watch: parsed.watch || null, map: fromLog, mapSource: "console-log" };
    if (hint) return { read, watch: parsed.watch || null, map: hint.name, mapSource: "map-command" };
    return { read, watch: parsed.watch || null, map: null, mapSource: null };
  }

  #positionFromDirect(direct) {
    const read = direct.read;
    return {
      probed: false,
      source: "wasm-memory",
      position: read.position,
      angles: read.angles,
      map: direct.map,
      mapSource: direct.mapSource === undefined ? null : direct.mapSource,
      // A reading that came back at all means the engine is up; `inGame` says
      // whether the game still owns the keyboard, and `paused` is the engine's
      // own PAUSED (it draws it whenever the console or the menu has the keys).
      running: true,
      inGame: read.inGame,
      paused: read.paused,
      consoleOpen: read.consoleOpen,
      keyDest: read.keyDest,
      keyDestName: read.keyDestName,
      dead: read.dead,
      alive: read.alive,
      aliveSource: read.aliveSource,
      health: read.health,
      armour: read.armour,
      ammo: read.ammo,
      readAt: read.readAt,
      watch: direct.watch,
      console: this.consoleMetrics(),
    };
  }

  // The independent check for the direct reading: ask the engine itself, over
  // its own console, the same question. The engine prints each of the six as an
  // integer, so the comparison is made the way the engine made the number --
  // truncated memory against printed text.
  async #verifyAgainstConsole(game, direct) {
    const answer = await this.#askEngine(game, ["viewpos", "mapname"]);
    const engine = readEngineState(answer.text || "");
    if (!engine.position || !engine.angles || !direct.position || !direct.angles) {
      return { ran: !!answer.text, match: false, reason: answer.text ? "NO_CONSOLE_POSITION" : "NO_ANSWER", console: this.consoleMetrics() };
    }
    const same = (a, b) => Math.trunc(a) === Math.trunc(b);
    const axes = ["x", "y", "z"];
    const turns = ["pitch", "yaw", "roll"];
    const positionMatch = axes.every((axis) => same(direct.position[axis], engine.position[axis]));
    const angleMatch = turns.every((turn) => same(direct.angles[turn], engine.angles[turn]));
    return {
      ran: true,
      rule: "trunc(memory) === the integer viewpos printed",
      consolePosition: engine.position,
      consoleAngles: engine.angles,
      memoryPosition: direct.position,
      memoryAngles: direct.angles,
      positionMatch,
      angleMatch,
      match: positionMatch && angleMatch,
      note: "the console probe pauses the engine and reports the pose from before the pause, so a player " +
        "still moving when it is read will read behind the live memory; compare at rest, or expect the " +
        "memory reading to be the newer one.",
      console: this.consoleMetrics(),
    };
  }

  // Run one or more console commands and return what the engine printed. This is
  // the way to start a level, turn cheats on or off, or ask anything `viewpos`
  // does not cover. The console is left closed afterwards, and it is left in the
  // state it was found in, because a console left open pauses the game and eats
  // the next keystroke.
  //
  // A `condump` is the whole console scrollback, so its tail is *not* this
  // command's answer -- it is whatever the engine happened to have printed last,
  // which on a busy line can be the answer to a command from a minute ago. The
  // reply is therefore cut at the command's own echo (the console prints `]map
  // demo1` before it runs anything) and `output` starts there. `options.tail`
  // then says how many lines of that to keep, because `cmdlist` alone prints
  // over a hundred.
  async command(text, options = {}) {
    const commands = Array.isArray(text) ? text.map(String) : [String(text)];
    const tail = Math.max(1, Math.floor(numberOr(options.tail, 24)));
    // A `map <name>` this bridge issues is remembered for position(). It is a
    // request rather than a fact, so it never displaces something the engine
    // said about itself (see the `mapname` answer below).
    for (const one of commands) {
      const asked = one.match(/^\s*map\s+(\S+)\s*$/i);
      if (asked && (!this.mapHint || this.mapHint.source === "map")) this.mapHint = { name: asked[1], source: "map" };
    }
    return this.#withSession(async (game) => {
      const answer = await this.#askEngine(game, commands);
      const lines = (answer.text || "").split("\n").filter((line) => line.trim() !== "");
      const echo = "]" + commands[0];
      let from = -1;
      // Backwards, so an earlier command that happens to read the same is not
      // mistaken for this one.
      for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index].trim();
        if (line === echo || line.startsWith(echo + " ")) { from = index; break; }
      }
      const output = (from === -1 ? lines.slice(-tail) : lines.slice(from, from + tail));
      // A `mapname` answer is the engine naming the level it is actually
      // running -- not the one it was asked for -- so it is worth keeping:
      // position() can then name the map with no console of its own, which
      // matters because the console log it would otherwise read is written
      // through C stdio and can sit unflushed for a long time.
      for (const line of output) {
        const named = line.match(/^"mapname"\s+is\s+"([^"]+)"/i);
        if (named) this.mapHint = { name: named[1], source: "mapname" };
      }
      return {
        commands,
        ran: !!answer.text,
        echoFound: from !== -1,
        consoleOpen: this.consoleOpen,
        map: this.mapHint ? this.mapHint.name : null,
        output,
        reason: answer.text ? undefined : "NO_ANSWER",
        message: answer.text ? undefined : "the engine did not answer on its console (attract demo, or it is still booting)",
      };
    });
  }

  // Open the console, run `commands`, condump and read the result back, close the
  // console. The dump file is the engine's own `condump`, which is also how
  // state() reads; it is deleted again because the save store is synced from
  // this file system.
  async #askEngine(game, commands, attempts = 2) {
    await this.focusCanvas(game);
    const page = JSON.parse(await game.evaluate(stateExpression));
    if (!page.gameDir) return { text: null, gameDir: null, attempts: 0 };
    this.console.roundTrips++;
    for (let attempt = 0; attempt < attempts; attempt++) {
      await this.#ensureConsole(game, true);
      for (const command of commands) {
        await this.#typeInto(game, command);
        await this.#tapOn(game, "Enter");
      }
      await this.#typeInto(game, "condump " + PROBE_DUMP);
      await this.#tapOn(game, "Enter");
      await this.#ensureConsole(game, false);
      // Writing the file is not part of the key dispatch, so it is given a
      // moment before it is read.
      await new Promise((resolve) => setTimeout(resolve, PROBE_SETTLE_MS));
      const dumped = await game.evaluate(readDumpExpression(page.gameDir));
      await game.evaluate(removeDumpExpression(page.gameDir));
      if (dumped) return { text: dumped, gameDir: page.gameDir, attempts: attempt + 1 };
      // No dump means the commands went somewhere other than the console, and
      // the only thing that can be wrong is where the bridge thinks the console
      // is. Flip the model and try again rather than repeat the same mistake.
      this.consoleOpen = !this.consoleOpen;
    }
    return { text: null, gameDir: page.gameDir, attempts };
  }

  // The console toggle, with the bridge's model of it kept in step. Every
  // console key this bridge sends goes through here, so the counter below is a
  // complete record of what it spent, not a sample.
  async #toggleConsole(game) {
    await this.#tapOn(game, "`");
    this.consoleOpen = !this.consoleOpen;
    this.console.toggles++;
    if (this.consoleOpen) this.console.opens++;
    return this.consoleOpen;
  }

  async #ensureConsole(game, want) {
    if (this.consoleOpen !== want) await this.#toggleConsole(game);
    return this.consoleOpen;
  }

  // Turn to an absolute bearing, in Quake 2's degrees: 0 faces +X, 90 faces +Y,
  // and the yaw grows anticlockwise. Closed loop -- it turns, measures what the
  // turn actually did, and corrects -- because how far a mouse count turns the
  // player depends on their own sensitivity cvar, which the engine will not
  // report.
  //
  // options.from skips the first probe when the caller has just read the angles.
  async face(bearing, options = {}) {
    const target = Number(bearing);
    if (!Number.isFinite(target)) throw new ControlError("face(bearing) needs a bearing in degrees", "BAD_REQUEST");
    const tolerance = numberOr(options.tolerance, FACE_TOLERANCE_DEGREES);
    const rounds = Math.max(1, Math.floor(numberOr(options.rounds, 6)));
    const start = options.from && options.from.angles ? options.from : await this.position();
    if (!start || !start.angles) {
      return { facing: false, target, reason: "NO_ANGLES", message: "the engine did not report the player's angles", history: [] };
    }
    let yaw = start.angles.yaw;
    const history = [];
    let method = null;
    for (let round = 0; round < rounds; round++) {
      const error = shortestTurn(target - yaw);
      if (Math.abs(error) <= tolerance) {
        return { facing: true, target, yaw, error, rounds: round, method, history };
      }
      const attempted = await this.#turnBy(error, options);
      if (attempted.method === "none") {
        return { facing: false, target, yaw, error, reason: "NO_TURN", message: attempted.message, rounds: round, method, history };
      }
      const after = await this.position();
      if (!after || !after.angles) {
        return { facing: false, target, yaw, error, reason: "NO_ANGLES", message: "the engine stopped answering after the turn", rounds: round, method, history };
      }
      // What the turn achieved, measured against the same yaw convention, then
      // folded back into the calibration so the next round is closer.
      const achieved = shortestTurn(after.angles.yaw - yaw);
      history.push({ method: attempted.method, wanted: error, nominal: attempted.amount, achieved, angle: after.angles });
      method = attempted.method;
      this.#learnTurn(attempted, achieved);
      yaw = after.angles.yaw;
    }
    // The last turn is not followed by another trip round the loop, so what it
    // achieved has to be judged here. A turn that landed inside the tolerance is
    // a success however late it arrived; reporting it as a failure would be a lie
    // about a state the caller can measure for itself.
    const error = shortestTurn(target - yaw);
    if (Math.abs(error) <= tolerance) return { facing: true, target, yaw, error, rounds, method, history };
    return { facing: false, target, yaw, error, reason: "NOT_CONVERGED", rounds, method, history };
  }

  // One turn of about `degrees` (positive turns left, bumping the yaw up).
  //
  // The arrow keys come first, the mouse second, and which one worked is
  // reported. The engine turns at cl_yawspeed for a held key -- a fixed rate
  // that does not depend on the player's sensitivity cvar -- and on this box's
  // build the arrow keys turn the player while the relative-motion deltas do
  // not, even though the page receives them (see the mouse step in
  // scripts/quake-control-test.sh, which proves the *events* arrive, and
  // scripts/goto-test.mjs, which proves what the engine then does with them).
  // A method that demonstrably does nothing is retired, so the other one is
  // tried next round instead of the same dead turn again.
  async #turnBy(degrees, options) {
    const wanted = Number(degrees);
    const mode = options.turn === "mouse" || options.turn === "keys" ? options.turn : "auto";
    const keysUsable = mode !== "mouse" && this.turnCalibration.keysWork !== false;
    if (keysUsable) {
      const rate = this.turnCalibration.keyDegreesPerMs === null ? DEFAULT_YAW_SPEED_DEGREES_PER_SECOND / 1000 : this.turnCalibration.keyDegreesPerMs;
      let ms = Math.abs(wanted) / rate;
      const capMs = numberOr(options.maxKeyMsPerStep, 900);
      if (ms > capMs) ms = capMs;
      // Deliberately short. The engine applies a held key once per frame, so a
      // longer floor would make the smallest possible turn *bigger* than the
      // tolerance face() is aiming for and leave it oscillating around the
      // target instead of settling on it. A hold this short is occasionally
      // missed entirely, which #learnTurn is written to expect.
      if (ms < 20) ms = 20;
      // +left raises the yaw, and Quake binds +left/+right to the arrow keys.
      const key = wanted > 0 ? "ArrowLeft" : "ArrowRight";
      await this.#withSession(async (game) => {
        await this.focusCanvas(game);
        await this.#sendKey(game, key, true);
        await new Promise((resolve) => setTimeout(resolve, ms));
        await this.#sendKey(game, key, false);
      });
      return { method: "keys", amount: Math.sign(wanted) * ms * rate, ms: Math.round(ms), key };
    }
    if (mode === "keys" || this.turnCalibration.mouseWorks === false) {
      // Both methods are believed dead. A retired method is never tried again,
      // so believing that is believing the player cannot turn for the rest of
      // the run -- and a player who cannot turn can only ever walk the bearing
      // they happen to have, which is what the legs around demo1's pocket look
      // like. So the arrow keys are put back on probation: this round answers
      // "none", and the next one tries them, which costs a short key hold.
      if (mode !== "keys" && this.turnCalibration.keysWork === false) {
        this.turnCalibration.keysWork = null;
        this.turnCalibration.misses = { keys: 0, mouse: 0 };
      }
      return { method: "none", message: "neither the arrow keys nor the mouse turned the player (the game may be paused, dead, or in a menu)" };
    }
    const perUnit = this.#mouseDegreesPerUnit() === null ? DEFAULT_DEGREES_PER_MOUSE_UNIT : this.#mouseDegreesPerUnit();
    // Quake turns the yaw *down* as the mouse moves right, so a positive
    // bearing change is a negative delta.
    let units = -wanted / perUnit;
    const capUnits = numberOr(options.maxMouseUnitsPerStep, 500);
    if (Math.abs(units) > capUnits) units = Math.sign(units) * capUnits;
    if (Math.abs(units) < 1) return { method: "none", message: "the turn needed is smaller than one mouse count" };
    await this.mouseMove(Math.round(units), 0);
    return { method: "mouse", amount: -Math.round(units) * perUnit, units: Math.round(units) };
  }

  // Fold an observed turn back into the calibration, and retire a method that
  // demonstrably did nothing -- so the next round tries the other one instead of
  // repeating a turn that cannot work.
  #learnTurn(attempted, achieved) {
    // A hold of a few milliseconds can fall between two frames and come back as
    // no turn at all, and face() asks for a turn as small as the tolerance when
    // the aim is already nearly right. A zero reading from a turn that small is
    // evidence of nothing: judging it would retire a method that works, and a
    // retired method is never tried again, so the caller would be left unable to
    // turn for the rest of the run. Only a turn big enough to be seen can retire
    // one. Learning is safe from either size -- the ratio windows below throw
    // away a measurement that is not physically possible.
    if (Math.abs(achieved) < FACE_TOLERANCE_DEGREES / 4 && Math.abs(attempted.amount) >= FACE_TOLERANCE_DEGREES) {
      // One miss is not evidence that the method is dead. A turn that comes
      // back as nothing is the *expected* reading whenever the player is not in
      // a state to be turned -- and one of those states is routine on this
      // level: the death camera holds the view, so every key and every mouse
      // count does nothing while it is up, and a player who walks into demo1's
      // soldiers dies several times a run. Retiring a method on a single miss
      // therefore retired *both* of them, one death apart, and face() then
      // answered NO_TURN without sending anything at all for the rest of the
      // run -- measured, and the reason a walk can be seen covering 0 units on
      // every leg from -427 111 while looking at a valid route out of it: the
      // view had stopped turning, so `+forward` pushed the player at the same
      // bearing into the same wall on every round of every attempt.
      const misses = this.turnCalibration.misses || (this.turnCalibration.misses = { keys: 0, mouse: 0 });
      misses[attempted.method] = (misses[attempted.method] || 0) + 1;
      if (misses[attempted.method] >= TURN_MISSES_BEFORE_RETIRING) {
        if (attempted.method === "mouse" && this.turnCalibration.mouseWorks !== false) this.turnCalibration.mouseWorks = false;
        if (attempted.method === "keys" && this.turnCalibration.keysWork !== false) this.turnCalibration.keysWork = false;
      }
      return;
    }
    // A turn that landed clears the method's misses: the counter is about a
    // method that has stopped working, not about a method that once hiccuped.
    // It is also how a method retired in error gets back into use -- see the
    // retry in #turnBy.
    if (this.turnCalibration.misses) this.turnCalibration.misses[attempted.method] = 0;
    if (attempted.method === "mouse" && attempted.units) {
      const perUnit = Math.abs(achieved / attempted.units);
      // A sanity window: a value outside it means the turn was observed while
      // something else moved the player, and believing it would poison the loop.
      if (perUnit > 0.001 && perUnit < 5) {
        const previous = this.turnCalibration.mouseDegreesPerUnit;
        this.turnCalibration.mouseDegreesPerUnit = previous === null ? perUnit : previous * 0.4 + perUnit * 0.6;
        this.turnCalibration.mouseWorks = true;
      }
    }
    if (attempted.method === "keys" && attempted.ms) {
      const perMs = Math.abs(achieved / attempted.ms);
      if (perMs > 0.0005 && perMs < 2) {
        const previous = this.turnCalibration.keyDegreesPerMs;
        this.turnCalibration.keyDegreesPerMs = previous === null ? perMs : previous * 0.4 + perMs * 0.6;
        this.turnCalibration.keysWork = true;
      }
    }
  }

  #mouseDegreesPerUnit() {
    const fromOptions = this.turnCalibration.mouseDegreesPerUnit;
    if (fromOptions !== null && Number.isFinite(fromOptions)) return fromOptions;
    return null;
  }

  // The engine's use key, as a hold rather than a tap, sent as a real key event.
  //
  // The key is the one the engine's own config binds to `+use`, read out of
  // config.cfg once and cached: a key that is not bound does nothing, so the
  // binding has to be the engine's, not this file's opinion. On a stock Quake 2
  // config nothing is bound to `+use` at all -- a door opens by walking into it
  // -- and rather than fall back to the console (which would pause the game on
  // the walker's own path) this says so and holds nothing. `{ console: true }`
  // still reaches for the old `+use` command line, explicitly.
  async useHold(down = true, options = {}) {
    if (options.console === true) {
      const answer = await this.command([down ? "+use" : "-use"]);
      if (!answer.ran) {
        return { held: false, method: "console", reason: "NO_ANSWER", message: answer.message || "the engine did not answer on its console", console: this.consoleMetrics() };
      }
      return { held: true, method: "console", key: down ? "+use" : "-use", output: answer.output, console: this.consoleMetrics() };
    }
    const bound = await this.useKey();
    if (bound.reason === "UNREADABLE") {
      return {
        held: false,
        method: "key",
        reason: "BINDING_UNREADABLE",
        message: "the engine's config could not be read, so this bridge does not know what +use is bound to and " +
          "will not guess. It holds nothing; try again, or use({ console: true }) to reach +use on the command line.",
        console: this.consoleMetrics(),
      };
    }
    if (!bound.found) {
      return {
        held: false,
        method: "key",
        reason: "NO_USE_BINDING",
        message: "the engine's own config binds no key to +use, so there is no real input to send. " +
          "Quake 2 opens a door by walking into it; use({ console: true }) is the explicit console fallback.",
        console: this.consoleMetrics(),
      };
    }
    if (!bound.pressable) {
      return {
        held: false,
        method: "key",
        reason: "USE_BINDING_UNSUPPORTED",
        binding: bound.binding,
        message: "the engine's config binds +use to " + bound.binding + ", which this bridge cannot press: " +
          "it dispatches the left, right and middle mouse buttons and keyboard keys, and nothing else. " +
          "use({ console: true }) is the explicit console fallback.",
        console: this.consoleMetrics(),
      };
    }
    if (bound.button) {
      const held = await this.mouseHold(bound.button, down);
      return { held: held.held, method: "mouse", key: bound.key, button: bound.button, console: this.consoleMetrics() };
    }
    await this.#withSession(async (game) => {
      await this.focusCanvas(game);
      await this.#sendKey(game, bound.key, down);
    });
    return { held: true, method: "key", key: bound.key, console: this.consoleMetrics() };
  }

  // Which key the engine's own config binds to `+use`, looked up once. Returns
  // null when nothing is bound. A mouse binding is returned as a button.
  async useKey() {
    if (this.useBinding === undefined) {
      let raw;
      try {
        raw = await this.#withSession((game) => game.evaluate(useBindingExpression()));
      } catch {
        // The page could not answer -- so nothing is known, and nothing is
        // remembered. Caching this would turn one unreadable moment (a page
        // still booting, a socket that dropped) into "the config binds no key"
        // for the rest of the run, which is a claim about the player's config
        // that this bridge has not earned.
        return { found: false, reason: "UNREADABLE" };
      }
      let name = null;
      try {
        const parsed = raw ? JSON.parse(raw) : null;
        if (parsed && typeof parsed.key === "string" && parsed.key !== "") name = parsed.key;
      } catch {
        name = null;
      }
      this.useBinding = this.#describeUseKey(name);
    }
    return this.useBinding;
  }

  // The engine names bindings in its own spelling ("SPACE", "MOUSE1", "e").
  //
  // Returns whether anything was bound at all, and whether this bridge can
  // actually press it. Those are different answers: a config that binds `+use`
  // to a fourth mouse button has bound something, and saying it "binds no key"
  // would be a false statement about the player's own config.
  #describeUseKey(name) {
    if (name === null || name === undefined || String(name) === "") return { found: false, binding: null, pressable: false, key: null, button: null };
    const upper = String(name).toUpperCase();
    const mouse = upper.match(/^MOUSE(\d+)$/);
    if (mouse) {
      const button = { "1": "left", "2": "right", "3": "middle" }[mouse[1]];
      return button
        ? { found: true, binding: upper, pressable: true, key: upper, button }
        : { found: true, binding: upper, pressable: false, key: null, button: null };
    }
    return { found: true, binding: String(name), pressable: true, key: String(name), button: null };
  }

  // Press use once and let go: walk into a lift, ride it. Wrapped as a pair so a
  // caller cannot leave the key stuck down. A press that could not be delivered
  // is reported as `used: false` with the engine's reason, and no release is
  // sent for a key that was never held.
  async use(holdMs = 200, options = {}) {
    const press = await this.useHold(true, options);
    if (!press.held) {
      return { used: false, holdMs: 0, reason: press.reason, message: press.message, console: this.consoleMetrics() };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, numberOr(holdMs, 200))));
    const release = await this.useHold(false, options);
    return { used: release.held !== false, holdMs: holdMs, method: press.method, key: press.key, console: this.consoleMetrics() };
  }

  // Hold a mouse button down, or let it up, without touching the console.
  //
  // `click()` is a tap; this is the two halves of it kept apart, and it exists
  // because the trigger is the one control a fight *holds* for seconds at a
  // time. The console path (`+attack` through `command()`) opens and shuts the
  // in-game console twice per firing leg, and the console is a pause: measured
  // on this box a `position()` probe costs about 1.2 s of wall clock, and a
  // firing leg spends two of those on the trigger alone. A bound mouse button
  // is the same command the engine already has bound to `+attack` in its own
  // config, issued through the input stack the engine is actually listening
  // to, and it reaches the game without a console round trip.
  async mouseHold(button = "left", down = true) {
    const name = String(button).toLowerCase();
    if (!["left", "right", "middle"].includes(name)) {
      throw new ControlError('button must be "left", "right" or "middle"', "BAD_REQUEST");
    }
    const bit = { left: 1, right: 2, middle: 4 }[name];
    return this.#withSession(async (game) => {
      await this.focusCanvas(game);
      const point = this.cursor || JSON.parse(await game.evaluate(`(function () {
        const canvas = document.getElementById("canvas");
        const box = canvas.getBoundingClientRect();
        return JSON.stringify({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
      })()`));
      this.heldButtons = this.heldButtons instanceof Set ? this.heldButtons : new Set();
      if (down) this.heldButtons.add(bit); else this.heldButtons.delete(bit);
      let buttons = 0;
      for (const held of this.heldButtons) buttons |= held;
      await game.session.send("Input.dispatchMouseEvent", {
        type: down ? "mousePressed" : "mouseReleased",
        x: point.x, y: point.y, button: name, buttons, clickCount: down ? 1 : 0, modifiers: this.modifiers,
      });
      // Whether the *left* button is held, which is what `attacking` means to
      // a caller that uses it to decide whether the trigger needs releasing.
      // Setting it from the argument alone got it wrong as soon as a second
      // button was involved: a right-press after a left-press left the left
      // button down and `attacking` false, and nothing would ever let it up.
      this.attacking = this.heldButtons.has(1);
      return { held: !!down, button: name, buttons };
    });
  }

  // The engine's fire button, as a hold rather than a tap. This is the left
  // mouse button, which is what this build's config binds to `+attack`
  // (`bind MOUSE1 "+attack"`), sent as a real input event: no console, no pause.
  // It is a *hold* because a fight on this box is won by firing while the player
  // keeps walking: a soldier takes three blaster bolts, a single click is one of
  // them, and a player who stands still to aim the second and third is the
  // player the level kills.
  //
  // Held down, the engine re-fires at the weapon's own refire rate until the
  // button is released. `{ console: true }` still sends the old `+attack`
  // command line, which is the fallback for a page with no live memory reading.
  async attackHold(down = true, options = {}) {
    if (options.console === true) {
      const answer = await this.command([down ? "+attack" : "-attack"]);
      if (!answer.ran) {
        return { held: false, method: "console", reason: "NO_ANSWER", message: answer.message || "the engine did not answer on its console", console: this.consoleMetrics() };
      }
      this.attacking = !!down;
      return { held: true, method: "console", command: down ? "+attack" : "-attack", output: answer.output, console: this.consoleMetrics() };
    }
    const held = await this.mouseHold("left", down);
    return { held: held.held, method: "mouse", button: "left", buttons: held.buttons, console: this.consoleMetrics() };
  }

  // Fire for a while and let go. The pair is wrapped so that a caller cannot
  // leave the trigger down, and the time actually spent firing is the time the
  // caller asked for -- the button dispatch around it is the bridge's.
  //
  // `fired` and `released` are reported separately on purpose. They are two
  // different failures and only one of them is harmless: a press the page did
  // not deliver means nothing was fired, while a *release* it did not deliver
  // means the player may still be firing -- and the caller has to know that,
  // because the next release is the only thing that will stop it. Reporting the
  // first from the second would say "nothing was fired" about a trigger that
  // is down.
  async fire(ms = 300, options = {}) {
    const press = await this.attackHold(true, options);
    if (!press.held) {
      return { fired: false, released: true, reason: press.reason, message: press.message, holdMs: 0, console: this.consoleMetrics() };
    }
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, numberOr(ms, 300))));
    const release = await this.attackHold(false, options);
    return { fired: true, released: release.held !== false, holdMs: ms, method: press.method, console: this.consoleMetrics() };
  }

  // Jump. One tap of the space bar, which is what every Quake 2 config binds
  // `+moveup` to; the physics gives it a fixed height, so a caller that wants to
  // clear a 40-unit lip does not have to hold it.
  async jump(key = "Space") {
    await this.tap(key);
    return { jumped: true, key };
  }

  // Get a dead player back into the level. Every movement key does nothing at
  // all while the player is dead, so a follower that does not check reads a
  // death as a wall and grinds at it forever -- which is exactly what a walk of
  // demo1 does, because the level is full of soldiers and dying is normal.
  //
  // The engine's own way back in is the fire button -- "press fire to respawn"
  // -- but on this box that is a trap: the client restores the *autosave* in
  // `/userdata`, which is wherever the last session saved, and a player who dies
  // at `128 -320` then reappears 1300 units away inside the base with no walk in
  // between. That reads exactly like a navigation system that can play a level
  // it cannot, so it is not the default: the level is started again instead.
  //
  // Starting the level is not a cheat. There is no noclip, no god, no give and
  // no teleport in it; it puts the player back on the level's own spawn with the
  // level's own weapons, and it is what a single-player game does when the
  // player dies.
  //
  // Starting the level needs a command, and a command needs the console, and
  // the console is a pause. The walker calls respawn() inside its own loops, so
  // the console is not the default any more: the default is the engine's own
  // "press fire to respawn", which is real input and does not stop the game.
  // The cost is the one described above -- it restores the autosave -- so the
  // result says `how: "fire"` and names the trap. A caller that would rather
  // have a clean spawn, and would rather pay a console round trip for it, asks:
  // `respawn({ how: "map" })`, or `{ console: true }`.
  async respawn(options = {}) {
    const before = await this.position();
    if (!before || !before.dead) return { respawned: false, reason: "ALIVE", position: before && before.position };
    // A roll says the player cannot act, and the intermission camera rolls too.
    // So a caller that knows which level it was playing hands the name in: if
    // the engine is somewhere else, the level ended and restarting it would undo
    // the very thing the caller was driving at.
    if (options.expectMap && before.map && before.map !== options.expectMap) {
      return { respawned: false, reason: "LEVEL_CHANGED", map: before.map, expected: options.expectMap, position: before.position };
    }
    const useConsole = options.how === "map" || options.console === true;
    if (!useConsole) {
      await this.click("left").catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, numberOr(options.settleMs, 2500)));
      const afterFire = await this.position();
      if (afterFire && !afterFire.dead) {
        return {
          respawned: true,
          how: "fire",
          method: "mouse",
          position: afterFire.position,
          note: "the engine restored its autosave, so the player is wherever that save left them, not on this level's spawn; " +
            "respawn({ how: \"map\" }) restarts the level instead, through the console",
          console: this.consoleMetrics(),
        };
      }
      return {
        respawned: false,
        reason: "NOT_RESPAWNED",
        how: "fire",
        position: before.position,
        message: "pressing fire did not get the player back into the level.",
        console: this.consoleMetrics(),
      };
    }
    const map = options.map || (before && before.map);
    if (!map) return { respawned: false, reason: "NO_MAP", position: before && before.position };
    await this.command(["map " + map, "cheats 0"], { tail: 8 });
    await new Promise((resolve) => setTimeout(resolve, numberOr(options.settleMs, 2500)));
    const after = await this.position();
    return {
      respawned: !!(after && !after.dead),
      how: "map",
      method: "console",
      map,
      position: after && after.position,
      message: after && after.dead ? "the player is still dead after restarting " + map : undefined,
      console: this.consoleMetrics(),
    };
  }

  // Step sideways for a while without turning: how a follower backs out of a
  // corner it has walked into. `direction` is "left" or "right".
  async strafe(ms = 300, direction = "right", options = {}) {
    const key = direction === "left" ? (options.leftKey || "a") : (options.rightKey || "d");
    return this.walk(ms, { key });
  }

  // Hold the forward key for a while and let go. The primitive under goto(): it
  // is the only way to move, and it says how long it really held.
  async walk(ms = 300, options = {}) {
    const key = options.key || "w";
    const duration = Math.max(0, numberOr(ms, 300));
    const held = await this.#withSession(async (game) => {
      await this.focusCanvas(game);
      const started = Date.now();
      await this.#sendKey(game, key, true);
      await new Promise((resolve) => setTimeout(resolve, duration));
      await this.#sendKey(game, key, false);
      return Date.now() - started;
    });
    return { key, requestedMs: duration, heldMs: held };
  }

  // Hold several keys at once for a while and let them go.
  //
  // walk() holds one key, which is all a follower needs and not all a *fight*
  // needs. Quake 2 moves a player along the way they are looking -- forward is
  // the view, strafe is the view turned a quarter turn -- so a player who has to
  // look at a soldier and still walk the corridor has to hold forward and a
  // strafe key together. That is the whole trick of shooting on the move, and it
  // is the reason this exists rather than a wider walk().
  //
  // Every key goes down before any comes up, and every release is attempted even
  // if the hold throws -- a key left down is a player walking into a wall for
  // the rest of the run. Each release is its own attempt, too: one key the
  // engine refuses must not leave the others held as well, which is what a
  // single loop over the list would do.
  async walkKeys(keys, ms = 300, options = {}) {
    const list = (Array.isArray(keys) ? keys : [keys]).map(String).filter((key) => key !== "");
    if (!list.length) throw new ControlError("walkKeys(keys) needs at least one key", "BAD_REQUEST");
    const duration = Math.max(0, numberOr(ms, 300));
    const held = await this.#withSession(async (game) => {
      await this.focusCanvas(game);
      const started = Date.now();
      try {
        for (const key of list) await this.#sendKey(game, key, true);
        await new Promise((resolve) => setTimeout(resolve, duration));
      } finally {
        for (const key of [...list].reverse()) {
          try {
            await this.#sendKey(game, key, false);
          } catch {
            // Nothing better is available: a release that cannot be delivered
            // means the socket is gone, and the remaining keys are still worth
            // releasing on the chance that it is not.
          }
        }
      }
      return Date.now() - started;
    });
    return { keys: list, requestedMs: duration, heldMs: held, stepMs: options.stepMs };
  }

  // Walk to a point and say honestly whether the player got there. Each round
  // reads the position, turns towards the target, walks a step and reads again;
  // when the position stops improving the call gives up and reports where the
  // player actually is, because "stuck in a corner" is a result an agent can
  // act on and a hopeful "reached" is not.
  //
  // tolerance is the arrival radius across the floor. z is compared with a
  // wider slack by default: map data places a floor, and the engine reports the
  // eye, which sits eyeHeight() above it -- see EYE_ABOVE_FEET.
  async goto(target, options = {}) {
    const point = describePoint(target);
    if (!point) throw new ControlError("goto(target) needs {x, y, z} numbers", "BAD_REQUEST");
    const tolerance = numberOr(options.tolerance, 48);
    const zTolerance = numberOr(options.zTolerance, DEFAULT_Z_TOLERANCE);
    const stepMs = numberOr(options.stepMs, 400);
    const deadline = Date.now() + numberOr(options.timeoutMs, 30000);
    const stuckRounds = Math.max(1, Math.floor(numberOr(options.stuckRounds, 3)));
    const maxRounds = Math.max(1, Math.floor(numberOr(options.maxRounds, 40)));

    let last = await this.position();
    if (!last || !last.position) {
      return {
        reached: false, target: point, tolerance, reason: "NO_POSITION",
        message: (last && last.message) || "the engine did not report a player position",
        position: null, rounds: 0,
      };
    }
    const startPosition = last.position;
    let best = horizontalDistance(last.position, point);
    let stagnant = 0;
    let rounds = 0;
    const trail = [{ x: last.position.x, y: last.position.y, z: last.position.z, distance: best }];

    while (rounds < maxRounds) {
      const position = last.position;
      // A dead player cannot be turned and cannot be walked, and saying so is
      // worth more than the rounds it would cost to find out: Quake 2 hands the
      // view to the death camera, so every movement key does nothing and every
      // turn comes back as no turn at all -- which is exactly the reading that
      // teaches face() that the arrow keys and the mouse both do not work, and
      // leaves the walk unable to turn for the rest of the run. demo1 kills, so
      // this is a routine state, not an error.
      if (last.dead) {
        return {
          reached: false, reason: "DEAD", target: point, tolerance, zTolerance,
          position, distance: horizontalDistance(position, point), rounds,
          travelled: horizontalDistance(startPosition, position), trail: trail.slice(-16),
          message: "the player is dead: the death camera holds the view and the movement keys do nothing",
        };
      }
      const horizontal = horizontalDistance(position, point);
      if (horizontal <= tolerance && Math.abs(position.z - point.z) <= zTolerance) {
        return {
          reached: true, reason: "reached", target: point, tolerance, zTolerance,
          position, start: startPosition, distance: horizontal, rounds,
          travelled: horizontalDistance(startPosition, position), trail: trail.slice(-16),
        };
      }
      if (Date.now() > deadline) {
        return { reached: false, reason: "timeout", target: point, tolerance, position, distance: horizontal, rounds, travelled: horizontalDistance(startPosition, position), trail: trail.slice(-16) };
      }
      const bearing = bearingTo(position, point);
      await this.face(bearing, { from: last, tolerance: numberOr(options.faceTolerance, 8), rounds: numberOr(options.faceRounds, 4) });
      await this.walk(stepMs, options);
      rounds++;
      const next = await this.position();
      if (!next || !next.position) {
        return { reached: false, reason: "NO_POSITION", target: point, tolerance, position, distance: horizontal, rounds, message: next && next.message, trail: trail.slice(-16) };
      }
      last = next;
      const distance = horizontalDistance(next.position, point);
      trail.push({ x: next.position.x, y: next.position.y, z: next.position.z, distance });
      if (distance < best - 1) { best = distance; stagnant = 0; }
      else {
        stagnant++;
        if (stagnant >= stuckRounds) {
          return {
            reached: false, reason: "stuck", target: point, tolerance, position: next.position,
            distance, rounds, travelled: horizontalDistance(startPosition, next.position),
            trail: trail.slice(-16),
            message: "the player stopped closing on the target: " + distance.toFixed(0) + " units short after " + rounds +
              " steps. Something solid, a closed door or a drop is in the way; the last position is the truth.",
          };
        }
      }
    }
    const finalPosition = last.position;
    return {
      reached: false, reason: "rounds", target: point, tolerance, position: finalPosition,
      distance: horizontalDistance(finalPosition, point), rounds,
      travelled: horizontalDistance(startPosition, finalPosition), trail: trail.slice(-16),
    };
  }

  // What the game is showing right now: enough for an agent to decide what to do
  // next, and enough for an operator to see that the frame really is the game.
  async status() {
    return this.#withSession(async (game, target) => {
      const state = JSON.parse(await game.evaluate(`(function () {
        const canvas = document.getElementById("canvas");
        const box = canvas ? canvas.getBoundingClientRect() : null;
        return JSON.stringify({
          title: document.title,
          readyState: document.readyState,
          hasFocus: document.hasFocus(),
          pointerLocked: !!(canvas && document.pointerLockElement === canvas),
          canvas: canvas ? {
            width: canvas.width, height: canvas.height,
            cssWidth: box.width, cssHeight: box.height,
            // style.css hides the canvas until app.js's hideConsole(), which the
            // engine calls once its video subsystem is up, sets it to "block".
            // So "" is a page still booting, and "none" is a game that has quit.
            display: canvas.style.display,
            focused: document.activeElement === canvas,
          } : null,
          engine: {
            module: typeof Module !== "undefined" && !!Module,
            filesystem: typeof FS !== "undefined" && !!FS,
            // engine-state.js defines this. Without it the hot path has no live
            // reading, and the console is reached only when a caller asks for
            // it by name.
            liveState: typeof quake2Engine !== "undefined" && !!quake2Engine,
            // IDBFS being available means the engine's file system is up; it does
            // not yet mean the save mount has been made.
            saveMount: typeof FS !== "undefined" && !!FS.filesystems && !!FS.filesystems.IDBFS,
            // The engine sets the canvas to "block" when it comes up, and back to
            // "none" when it quits or aborts, so that inline style is the one
            // signal that says a game is really being drawn. Defaulting it to
            // "block" would report a page that is still downloading its PAKs --
            // where the canvas's own style is still empty -- as a running game.
            running: !!canvas && canvas.style.display === "block",
          },
        });
      })()`));
      // Framing is asked of the frame itself and never inferred from
      // !isWholeTarget: the desktop hosts the app as an out-of-process iframe
      // target, whose own main frame *is* the game, so isWholeTarget is true
      // there and the old answer was backwards for the normal case.
      const framing = describeFraming(await this.#ancestorOriginsOf(game));
      return {
        ok: true,
        cdp: { endpoint: this.cdpUrl, targetId: target.id, targetType: target.type },
        url: game.frame.url,
        ...framing,
        ...state,
        // What this bridge has spent on the engine's console since it was
        // built. Zero on a run that stayed on the direct path.
        console: this.consoleMetrics(),
      };
    });
  }

  // The game's state as JSON, for an agent that has to decide what to do next.
  //
  // The live half -- position, angles, whether the game owns the keyboard,
  // whether the console is up, whether the player is dead -- is read out of the
  // engine's memory, and the rest is the engine's console log, its save slots
  // and the page. None of that is input, so a plain state() sends nothing and
  // pauses nothing.
  //
  // `options.probe` is the old console probe, kept as the explicit fallback: it
  // opens the console, types Yamagi's two queries, reads the answers back out of
  // a condump and shuts the console again. It pauses the game for as long as it
  // runs, so nothing on the hot path calls it. The console is a plain toggle and
  // nothing is remembered between calls, so a probe the engine did not hear
  // leaves the toggle wherever it found it.
  //
  // Quake 2 answers only part of the question, and the answer says which part:
  // `unavailable` lists the fields it cannot answer at all. See the note.
  async state(options = {}) {
    const wantsProbe = !!options.probe;
    return this.#withSession(async (game, target) => {
      let page = JSON.parse(await game.evaluate(stateExpression));
      const direct = await this.#readEngineState(game);
      const probe = { requested: wantsProbe, ran: false, toggles: 0, commands: [] };
      let transcript = page.log;
      if (wantsProbe && page.gameDir) {
        // The console is a toggle and the bridge remembers nothing between
        // calls, so the first attempt may have *closed* a console somebody left
        // open, sending the commands to the game as keystrokes. The dump is
        // what proves they were heard; when it is not there, one more toggle
        // opens the console and they go in again.
        for (let attempt = 0; attempt < 2; attempt++) {
          await this.focusCanvas(game);
          // Through the tracked toggle, so the bridge's idea of the console
          // survives a probe the engine did not answer.
          await this.#toggleConsole(game);
          for (const command of PROBE_COMMANDS) {
            await this.#typeInto(game, command);
            await this.#tapOn(game, "Enter");
          }
          await this.#typeInto(game, "condump " + PROBE_DUMP);
          await this.#tapOn(game, "Enter");
          await this.#toggleConsole(game);
          // Writing the file is not part of the key dispatch, so it is given a
          // moment before it is read.
          await new Promise((resolve) => setTimeout(resolve, 150));
          probe.toggles = attempt + 1;
          const dumped = await game.evaluate(readDumpExpression(page.gameDir));
          // `condump` echoes both the commands and their answers, so a dump
          // that holds the second command's answer was taken after both ran.
          if (dumped && /Server info settings:/.test(dumped) && /^\]viewpos\s*$/m.test(dumped)) {
            transcript = dumped;
            probe.ran = true;
            probe.commands = PROBE_COMMANDS.slice();
            // A file of the engine's own making must not outlive the read: the
            // save store is synced from this file system.
            await game.evaluate(removeDumpExpression(page.gameDir));
            break;
          }
          page = JSON.parse(await game.evaluate(stateExpression));
        }
        await game.evaluate(removeDumpExpression(page.gameDir));
      }
      const engine = readEngineState(transcript);
      const live = direct.read.ok ? direct.read : null;
      return {
        ok: true,
        sampledAt: new Date().toISOString(),
        // Which half answered the live fields: the memory reading when it is
        // there, the console probe when it was asked for and the reading was
        // not, and "none" when neither could.
        source: live ? "wasm-memory" : (probe.ran ? "console" : "none"),
        probed: probe.ran,
        probe: { ...probe, console: this.consoleMetrics() },
        cdp: { endpoint: this.cdpUrl, targetId: target.id, targetType: target.type },
        url: game.frame.url,
        engine: {
          running: page.running,
          pointerLocked: page.pointerLocked,
          // The live half. null, not false, when the memory could not be read:
          // "I could not tell" and "the console is shut" are different answers.
          inGame: live ? live.inGame : null,
          paused: live ? live.paused : null,
          consoleOpen: live ? live.consoleOpen : null,
          keyDest: live ? live.keyDest : null,
          keyDestName: live ? live.keyDestName : null,
        },
        server: { running: engine.running, map: direct.map || engine.map },
        player: {
          position: live ? live.position : engine.position,
          angles: live ? live.angles : engine.angles,
          health: null,
          armour: null,
          ammo: null,
          alive: live ? live.alive : null,
        },
        unavailable: UNREADABLE.slice(),
        note: STATE_NOTE,
        // The page's own record of cls.key_dest, sampled once per rendered
        // frame since the hook was first read, and this bridge's count of what
        // it spent on the console. Together they are the console-free proof.
        consoleWatch: direct.watch,
        consoleSpend: this.consoleMetrics(),
        // `lines` counts only what the tail holds, not the whole file: the log
        // grows for as long as the game runs and only its end is read.
        console: { log: page.logPath, lines: engine.lines.length, tail: engine.lines.slice(-20) },
        saves: { slots: page.slots },
      };
    });
  }

  // Runs an expression inside the game frame and returns its value, which must
  // be JSON-serialisable. The escape hatch for anything the five calls above do
  // not cover: reading the engine's files through FS, poking Module, measuring
  // the canvas.
  async evaluate(expression) {
    return this.#withSession((game) => game.evaluate(String(expression)));
  }

  // A PNG of the game frame as a Buffer. A framed game is cropped to its frame,
  // so the ClawBox shell around it never appears in the picture.
  //
  // `options.clip` is passed straight to CDP's `Page.captureScreenshot`, which
  // is how a caller that only wants part of the picture -- control/hud.mjs
  // wants the forty rows of status bar, and nothing else -- avoids decoding a
  // whole frame of level to get them.
  async screenshot(options = {}) {
    return this.#withSession(async (game, target) => {
      // Which page may take the picture is decided by the frame's own
      // ancestors, not by the target's type: the desktop frames the app in an
      // out-of-process iframe, which is a target of its own that CDP refuses to
      // capture whole, and which the shell's frame tree does not list. "clip" is
      // in the viewport's CSS pixels, so a box is always measured in whichever
      // document draws the frame.
      const ancestors = await this.#ancestorOriginsOf(game);
      const framing = describeFraming(ancestors);
      if (!framing.framed) {
        // Nothing draws the game: it is its own tab, and its target is
        // top-level, so the whole of it may be captured as it stands.
        const params = { format: "png" };
        if (options.clip) params.clip = options.clip;
        const { data } = await game.session.send("Page.captureScreenshot", params);
        return Buffer.from(data, "base64");
      }
      if (!game.isWholeTarget) {
        // The game is a child frame of the page this very session is attached
        // to, so the frame's box is measured in that page's document and the
        // capture is taken on the same socket.
        const rect = JSON.parse(await game.evaluateTop(frameBoxExpression(this.gameUrlMark)));
        const params = { format: "png" };
        if (rect) params.clip = rect;
        const { data } = await game.session.send("Page.captureScreenshot", params);
        return Buffer.from(data, "base64");
      }
      // The game frame is the whole of this target, yet it has an ancestor: the
      // desktop's out-of-process iframe. The picture is taken from the page that
      // draws the frame -- the one the browser treats as top-level -- which is
      // found from the frame's ancestor origins.
      const host = await this.#hostPageForGame(ancestors);
      const session = await CdpSession.open(host.webSocketDebuggerUrl, this.timeoutMs);
      try {
        await session.send("Page.enable");
        const measured = await session.send("Runtime.evaluate", {
          expression: frameBoxExpression(this.gameUrlMark),
          returnByValue: true,
        });
        const rect = JSON.parse(measured.result ? measured.result.value : "null");
        if (!rect) throw new GameNotRunningError("the game's frame is no longer in the top-level page");
        const { data } = await session.send("Page.captureScreenshot", { format: "png", clip: rect });
        return Buffer.from(data, "base64");
      } finally {
        session.close();
      }
    });
  }

  // The top-level page whose document draws the game's frame: the one target the
  // browser will let us screenshot a framed game from. The desktop frames the app
  // as an out-of-process iframe, which the shell's own frame tree does not list --
  // so the frame itself says where it was loaded from (ancestorOrigins works
  // across origins), and the page with that origin is the host.
  async #hostPageForGame(ancestorOrigins) {
    const origin = ancestorOrigins[ancestorOrigins.length - 1];
    const pages = (await this.targets()).filter((t) => t.type === "page" && t.webSocketDebuggerUrl);
    const host = (origin && pages.find((t) => t.url.startsWith(origin))) || pages.find((t) => !t.url.includes(this.gameUrlMark));
    if (!host) throw new GameNotRunningError("found the game's frame but not the top-level page that draws it");
    return host;
  }

  // Present for symmetry: nothing is kept open between calls.
  async close() {
    this.cursor = null;
  }
}

// A ready-made bridge pointed at the default ClawBox endpoint.
export function createControl(options) {
  return new QuakeControl(options);
}

export default QuakeControl;
