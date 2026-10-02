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
  minus: "-", dash: "-", equal: "=", equals: "=", plus: "=",
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
      await this.#sendKey(game, key, true);
      return this.#sendKey(game, key, false);
    });
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
      for (const character of characters) {
        await this.#sendKey(game, character, true);
        await this.#sendKey(game, character, false);
      }
      return { typed: characters.length };
    });
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
            display: canvas.style.display || "block",
            focused: document.activeElement === canvas,
          } : null,
          engine: {
            module: typeof Module !== "undefined" && !!Module,
            filesystem: typeof FS !== "undefined" && !!FS,
            // The save mount only exists once the engine has booted.
            saveMount: typeof FS !== "undefined" && !!FS.filesystems && !!FS.filesystems.IDBFS,
            // showConsole() hides the canvas, so a hidden canvas means the game
            // has quit or aborted.
            running: !!canvas && canvas.style.display !== "none",
          },
        });
      })()`));
      return {
        ok: true,
        cdp: { endpoint: this.cdpUrl, targetId: target.id, targetType: target.type },
        url: game.frame.url,
        framed: !game.isWholeTarget,
        ...state,
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
    return this.#withSession(async (game) => {
      const params = { format: "png" };
      if (!game.isWholeTarget) {
        // The iframe element lives in the shell's document, not the game's, so
        // its box has to be measured there (clip is in viewport CSS pixels).
        const rect = JSON.parse(await game.evaluateTop(`(function () {
          const frame = document.querySelector('iframe[src*="${this.gameUrlMark}"]') || document.querySelector("iframe");
          if (!frame) return "null";
          const box = frame.getBoundingClientRect();
          return JSON.stringify({ x: box.left, y: box.top, width: box.width, height: box.height, scale: 1 });
        })()`));
        if (rect) params.clip = rect;
      }
      const { data } = await game.session.send("Page.captureScreenshot", params);
      return Buffer.from(data, "base64");
    });
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
