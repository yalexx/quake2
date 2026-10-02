// control/bridge.mjs -- drive the live Quake 2 page over the Chrome DevTools
// Protocol, so an external agent can play the game the box is showing.
//
// The ClawBox desktop frames the game in the kiosk Chromium, whose CDP endpoint
// is http://127.0.0.1:18801. Input must go to the game's own frame (the target
// whose URL contains "/apps/quake2/"), never to the top-level ClawBox page: the
// shell would swallow the keys, and the engine would never see them.
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

// ---- Reading the game's state ---------------------------------------------
// Quake 2 has no scripting surface, and the Qwasm2 build exports no cvar or
// command accessor (its wasm exports are libc and SDL only), so the engine's
// own console is the one way to ask it anything. Everything the console prints
// is also mirrored, as the engine prints it, into a log file inside the
// engine's file system -- so an answer can be read without touching the page.
// This layer has two halves: the cheap read below (the log, the save store and
// the page: no input at all) and the probe (types Yamagi's two queries into the
// console, which is input, and reads their answers out of the same log).
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
// What the engine can and cannot be asked for. The list is part of the answer,
// so a caller never has to guess why a field is null.
const UNREADABLE = ["health", "armour", "ammo", "alive"];
const STATE_NOTE =
  "Quake 2 has no console command that prints health, armour, ammo or whether the " +
  "player is alive -- they are drawn on the HUD, so read them from a screenshot. " +
  "The map and the server's running state are read from the engine's console log, " +
  "which the engine writes through C stdio and can therefore lag by a few kilobytes " +
  "of output; probed:true asks the engine directly (viewpos, serverinfo) and reads " +
  "the answers out of a condump, so those are live.";

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
  return {
    map: map ? map[1] : null,
    running: started >= 0 && started > stopped,
    position: viewpos ? { x: Number(viewpos[1]), y: Number(viewpos[2]), z: Number(viewpos[3]) } : null,
    angles: viewpos ? { pitch: Number(viewpos[4]), yaw: Number(viewpos[5]), roll: Number(viewpos[6]) } : null,
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
// Face() stops when the bearing is this close, in degrees.
const FACE_TOLERANCE_DEGREES = 4;
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
    // What face() has learned about turning: how far one mouse count turns the
    // player, how fast the arrow keys turn, and whether each works at all.
    // null means "not measured yet".
    this.turnCalibration = {
      mouseDegreesPerUnit: this.#optionsDegreesPerUnit(options),
      keyDegreesPerMs: null,
      mouseWorks: null,
      keysWork: null,
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

  // Type a string on an open session, one key at a time.
  async #typeInto(game, text) {
    const characters = [...String(text)];
    for (const character of characters) {
      await this.#sendKey(game, character, true);
      await this.#sendKey(game, character, false);
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

  // Where the player is and which way they are looking, from the engine's own
  // `viewpos` -- plus `mapname`, which the engine keeps as a cvar and prints as
  // `"mapname" is "demo1"`. Much lighter than state(): no server info, no page
  // report, and the map name is what tells an agent whether the level it is
  // navigating is still the level it planned for.
  async position() {
    return this.#withSession(async (game) => {
      const answer = await this.#askEngine(game, ["viewpos", "mapname"]);
      const engine = readEngineState(answer.text || "");
      if (!answer.text) {
        return {
          probed: false,
          position: null,
          angles: null,
          map: null,
          running: false,
          reason: "NO_ANSWER",
          message: "the engine did not answer on its console. It refuses to open the console during the attract demo and drops keys while it boots; " +
            "if no level is running, start one first (command(\"map demo1\")).",
        };
      }
      return { probed: true, position: engine.position, angles: engine.angles, map: engine.map, running: engine.running, attempts: answer.attempts };
    });
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
      return {
        commands,
        ran: !!answer.text,
        echoFound: from !== -1,
        consoleOpen: this.consoleOpen,
        output: (from === -1 ? lines.slice(-tail) : lines.slice(from, from + tail)),
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

  // The console toggle, with the bridge's model of it kept in step.
  async #toggleConsole(game) {
    await this.#tapOn(game, "`");
    this.consoleOpen = !this.consoleOpen;
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
      if (attempted.method === "mouse" && this.turnCalibration.mouseWorks !== false) this.turnCalibration.mouseWorks = false;
      if (attempted.method === "keys" && this.turnCalibration.keysWork !== false) this.turnCalibration.keysWork = false;
      return;
    }
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
      };
    });
  }

  // The game's state as JSON, for an agent that has to decide what to do next.
  //
  // Without options.probe this sends nothing at all: it reads the engine's
  // console log, its save slots and the page, and reports what the engine has
  // already said. With options.probe it also asks the engine directly -- which
  // can only happen through the engine's own console -- by opening the console,
  // typing its two queries, closing it and reading the answers back out of the
  // log: input, exactly like every other control call, and it toggles the
  // console shut again once it has read the answer. The console is a plain
  // toggle and nothing is remembered between calls, so a probe the engine did
  // not hear leaves the toggle wherever it found it.
  //
  // Quake 2 answers only part of the question, and the answer says which part:
  // `unavailable` lists the fields the engine has no way to print. See the note
  // in the reply.
  async state(options = {}) {
    const wantsProbe = !!options.probe;
    return this.#withSession(async (game, target) => {
      let page = JSON.parse(await game.evaluate(stateExpression));
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
      return {
        ok: true,
        sampledAt: new Date().toISOString(),
        probed: probe.ran,
        probe,
        cdp: { endpoint: this.cdpUrl, targetId: target.id, targetType: target.type },
        url: game.frame.url,
        engine: { running: page.running, pointerLocked: page.pointerLocked },
        server: { running: engine.running, map: engine.map },
        player: {
          position: engine.position,
          angles: engine.angles,
          health: null,
          armour: null,
          ammo: null,
          alive: null,
        },
        unavailable: UNREADABLE.slice(),
        note: STATE_NOTE,
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
  async screenshot() {
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
        const { data } = await game.session.send("Page.captureScreenshot", { format: "png" });
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
