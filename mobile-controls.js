// Quake 2 for ClawBox: on-screen controls for phones and tablets.
//
// This file is inert on a desktop: nothing is shown and nothing is sent unless
// the page is being used on a touch device (pointer: coarse, or a touch point
// exists). The desktop keeps its keyboard, mouse and pointer-lock presentation
// exactly as it was.
//
// ---- How input reaches the engine ---------------------------------------
// Movement, jump, crouch, use, the weapon cycle and pause are synthetic
// keydown/keyup events in the same shape app.js's dispatchKey() builds
// (window.quake2App.dispatchKey/tapKey). CROUCH holds the PC's own crouch key,
// c (default.cfg: bind c +movedown); WPN taps / (default.cfg: bind /
// weapnext), so neither depends on a binding this page invents.
//
// Fire is mouse button 0, the button the engine's own config binds to +attack.
// FIRE is also an aim surface: the thumb that holds it can slide and the view
// turns with it, so the left thumb moves while the right thumb aims and fires
// -- one two-finger gesture (the owner's HUD review, "fire+move"). A plain
// drag on the look surface never fires.
//
// Look is a drag on #mc-look, a transparent capture surface over the whole
// game picture. The surface takes the touch itself (pointer-events: auto), so
// no finger ever reaches the canvas: a touch on the canvas is the engine's own
// touch path, which fires the weapon, turns the camera and -- the expensive
// part -- takes pointer lock. While the engine holds the lock every pointer
// event in the page reports clientX/clientY 0,0 and is retargeted to the
// canvas, which leaves the thumbstick walking diagonally for ever and every
// button dead. Measured on this build (2026-11-04): a single tap on the
// picture took the lock; the next stick touch arrived at 0,0 and held
// +forward +left; #mc-next and #mc-jump received no pointerdown at all.
//
// The drag handler turns the view with synthetic mousemove events on the
// canvas. This build's SDL layer (engine/index.js, Browser.calculateMouseEvent)
// reads pageX/pageY when document.pointerLockElement is null, so a move at an
// advancing clientX/clientY is real relative look with no lock: measured
// 0.264 deg per CSS pixel on both axes. The first gesture primes the canvas
// with one move at its centre, which the engine takes as its reference point
// without turning (measured 0.0 deg); later gestures continue from the last
// cursor without moving it, so a new touch never jerks the view. The virtual
// cursor is kept inside the canvas -- a move outside is ignored by the engine.
//
// The engine's own SDL glue still asks for pointer lock from inside the
// canvas (screen touches, and this file's own fire press). On a touch page
// that request is refused here: Element.prototype.requestPointerLock is
// wrapped, so the lock can never be taken while the touch presentation is on.
//
// The engine's own config binds no key to +use, so the touch layer installs a
// small cfg file through Module.preRun (before the engine's main runs) that
// binds the keys this layer presses (+use on e, and the weapon cycle and
// crouch again, so a player's own rebind cannot strand those controls), and
// adds `+exec q2touch.cfg` to the engine's start-up line (app.js keeps it).
// The file lives in the engine's in-memory FS and this page never writes the
// player's config.cfg. (The engine itself may save its runtime bindings when
// it writes its own config on exit, exactly as it would for any bind made at
// its console.) Desktop sessions never install it.
//
// ---- Layout -------------------------------------------------------------
// The thumbstick is bottom left. The right thumb gets a large FIRE button in
// the bottom-right corner, with JUMP and CROUCH in the same row, USE one roll
// above FIRE and the WPN control above USE along the right edge; the middle of
// the screen stays free for dragging to look. This is the layout Call of Duty
// Mobile, PUBG Mobile, Fortnite and Apex Legends Mobile converge on: the
// primary fire action is the biggest and lowest target, secondary actions sit
// within one thumb roll, and weapon/menu controls are small and out of the
// aiming path.
//
// The game is presented in landscape. In portrait a clear "rotate your device"
// card is shown (it never blocks the page: the menus stay usable, and the card
// hides while the menu is open). Where the platform allows it, the card's
// button asks for full screen and `screen.orientation.lock("landscape")`; on a
// browser without that API (iOS Safari) it says to turn the device by hand.
//
// No dependencies; one global, window.quake2Touch, for app.js to talk to.

(function () {
  "use strict";

  // The pad's on/off choice, made in OPTIONS > touch controls. The PAD button
  // that used to sit over the game (and kept its choice under the old key) is
  // gone: the owner's HUD review. A value an earlier visit left under the old
  // key is deleted rather than honoured, so nobody is left with a hidden pad
  // and no button they remember to bring it back with.
  var STORE_KEY = "quake2-touch-pad";
  var LEGACY_STORE_KEY = "quake2-touch-controls";
  var HINT_KEY = "quake2-touch-hint";
  var STICK_DEADZONE = 0.22;
  var STICK_RADIUS_FRACTION = 0.42;
  var HINT_MS = 9000;
  // A weapon switch is the old weapon's lowering animation and then the new
  // one's model: a handful of Quake 2 game frames (10 Hz), well under a second
  // on a phone. The engine runs at most one game frame per drawn frame, so on
  // a slow device the same switch takes longer in wall time (measured in
  // headless software rendering: over 3 s). A WPN tap is judged to have had
  // nothing to switch to only when both a wall-time window AND a count of
  // drawn frames have passed with the engine's weapon unchanged; then the pad
  // says so instead of doing nothing.
  var WEAPON_SWITCH_MS = 2000;
  var WEAPON_SWITCH_FRAMES = 20;
  var WEAPON_NOTE_MS = 2200;
  // MENU: the engine answers Escape on its next frame. A press it has not
  // answered after both of these (key_dest still the game's) was dropped --
  // measured right after a quick boot: the touch layer's Escape went out and
  // key_dest never left 0 -- so it is sent once more.
  var MENU_CONFIRM_MS = 400;
  var MENU_CONFIRM_FRAMES = 6;

  var root = document.getElementById("mobile-controls");
  var lookSurface = document.getElementById("mc-look");
  var stick = document.getElementById("mc-stick");
  var knob = document.getElementById("mc-stick-knob");
  var padGroup = document.querySelector(".menu-touch");
  var padRow = document.querySelector('[data-action="touch-pad"]');
  var padRowValue = document.getElementById("touch-pad-value");
  var hintElement = document.getElementById("mc-hint");
  var weaponNote = document.getElementById("mc-weapon-note");
  var rotateOverlay = document.getElementById("rotate-overlay");
  var rotateButton = document.getElementById("rotate-action");
  var rotateNote = document.getElementById("rotate-note");
  var canvas = document.getElementById("canvas");

  // A phone or tablet: a coarse pointer. A hybrid laptop reports a fine pointer
  // but has a touch point; it gets the engine bindings, and the layer appears
  // when the first real touch arrives. navigator.maxTouchPoints is the honest
  // hardware answer for the binding decision.
  var coarseQuery = window.matchMedia ? window.matchMedia("(pointer: coarse)") : null;
  var hoverQuery = window.matchMedia ? window.matchMedia("(hover: none)") : null;
  var portraitQuery = window.matchMedia ? window.matchMedia("(orientation: portrait)") : null;
  var touchPoints = Number(navigator.maxTouchPoints) || 0;
  var touchHardware = (coarseQuery && coarseQuery.matches) || touchPoints > 0;
  var autoTouchUi = (coarseQuery && coarseQuery.matches) ||
    (touchPoints > 0 && hoverQuery && hoverQuery.matches);

  var storedChoice = readStore(STORE_KEY);
  var padOn = storedChoice !== "off";
  var uiEnabled = false;
  var live = false;
  var bindingsInstalled = false;
  var hintSeen = readStore(HINT_KEY) === "seen";
  var hintTimer = 0;
  var hintShownAt = 0;
  var keysHeld = Object.create(null); // action name -> descriptor
  var fireHeld = false;
  var fireDrag = null; // { pointerId, x, y } -- the FIRE thumb, while it aims
  var weaponWatch = 0;
  var weaponWatchId = 0;
  var menuWatchId = 0;
  var menuRetries = 0;
  var weaponNoteTimer = 0;
  var weaponTaps = 0;
  var weaponSwitches = 0;

  function readStore(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      // The ClawBox desktop may frame the app in an opaque-origin sandbox,
      // where storage is denied. The menu row still works for this session.
      return null;
    }
  }

  function writeStore(key, value) {
    try {
      window.localStorage.setItem(key, value);
    } catch (error) {
      // No persistence in a sandboxed frame; the current session keeps its state.
    }
  }

  function dropLegacyChoice() {
    try {
      window.localStorage.removeItem(LEGACY_STORE_KEY);
    } catch (error) {
      // Nothing to remove, or storage is denied.
    }
  }

  // ---- Engine input -------------------------------------------------------

  function dispatchKey(type, descriptor) {
    var api = window.quake2App;
    if (api && typeof api.dispatchKey === "function") {
      api.dispatchKey(type, descriptor);
      return;
    }
    var event = new KeyboardEvent(type, {
      key: descriptor.key,
      code: descriptor.code,
      bubbles: true,
      cancelable: true,
      shiftKey: !!descriptor.shift,
    });
    Object.defineProperty(event, "keyCode", { get: function () { return descriptor.vk; } });
    Object.defineProperty(event, "which", { get: function () { return descriptor.vk; } });
    Object.defineProperty(event, "charCode", { get: function () { return type === "keypress" ? descriptor.ch || 0 : 0; } });
    Object.defineProperty(event, "__q2synthetic", { value: true });
    window.dispatchEvent(event);
  }

  function tapKey(descriptor) {
    dispatchKey("keydown", descriptor);
    dispatchKey("keypress", descriptor);
    dispatchKey("keyup", descriptor);
  }

  var MOVEMENT = {
    forward: { key: "w", code: "KeyW", vk: 87 },
    back: { key: "s", code: "KeyS", vk: 83 },
    left: { key: "a", code: "KeyA", vk: 65 },
    right: { key: "d", code: "KeyD", vk: 68 },
  };
  var ACTION_KEYS = {
    jump: { key: " ", code: "Space", vk: 32 },
    // CROUCH: the PC's crouch key (default.cfg: bind c +movedown). A hold:
    // keydown on press, keyup on release, exactly the key on a keyboard.
    crouch: { key: "c", code: "KeyC", vk: 67 },
    use: { key: "e", code: "KeyE", vk: 69 },
    // WPN: the next weapon the player carries (default.cfg: bind / weapnext).
    // The old pair pressed [ and ], which default.cfg binds to the inventory
    // cursor (invprev/invnext) -- it drew nothing, so the buttons looked dead.
    weapon: { key: "/", code: "Slash", vk: 191 },
    pause: { key: "Escape", code: "Escape", vk: 27, ch: 27 },
  };

  function holdKey(action, descriptor, down) {
    var held = keysHeld[action];
    if (down && !held) {
      keysHeld[action] = { descriptor: descriptor };
      dispatchKey("keydown", descriptor);
    } else if (!down && held) {
      delete keysHeld[action];
      dispatchKey("keyup", held.descriptor);
    }
  }

  function releaseKeys() {
    for (var action in keysHeld) holdKey(action, keysHeld[action].descriptor, false);
  }

  function canvasBox() {
    if (!canvas) return null;
    var box = canvas.getBoundingClientRect();
    if (!box || !(box.width > 0) || !(box.height > 0)) return null;
    return box;
  }

  function canvasCentre() {
    var box = canvasBox();
    return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : { x: 0, y: 0 };
  }

  // The engine reads the mouse position from the canvas's own event stream and
  // turns by the difference between two events. The touch layer is the only
  // source of those events on a phone, so it keeps a virtual cursor here, in
  // page coordinates, and moves it by the finger's own delta.
  var lookCursor = null; // { x, y } -- last position the canvas was told about
  var lookPointer = null;
  var lookLast = null;

  function clampToCanvas(x, y) {
    var box = canvasBox();
    if (!box) return { x: x, y: y };
    var inset = 2;
    return {
      x: Math.min(Math.max(x, box.left + inset), box.right - inset),
      y: Math.min(Math.max(y, box.top + inset), box.bottom - inset),
    };
  }

  function sendMouseMove(x, y) {
    if (!canvas) return;
    canvas.dispatchEvent(new MouseEvent("mousemove", {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      pageX: x,
      pageY: y,
      movementX: 0,
      movementY: 0,
      // A move while FIRE is held is a drag with the button down; the SDL
      // layer reads the button state from the event it is handed.
      buttons: fireHeld ? 1 : 0,
    }));
  }

  // Put the engine's reference point where the touch layer wants it without
  // turning the view. Measured on this build: a move to the canvas centre from
  // an unknown prior position (fresh page, or after a gesture elsewhere) is
  // taken as the new reference and produces 0.0 deg of yaw and pitch; the next
  // move turns by exactly its delta.
  function primeLook(x, y) {
    var p = clampToCanvas(x, y);
    lookCursor = p;
    sendMouseMove(p.x, p.y);
    return p;
  }

  function lookDown(event) {
    if (!live || !canvas) return;
    if (lookPointer !== null) return;
    if (event.pointerType && event.pointerType !== "touch" && event.pointerType !== "pen") return;
    event.preventDefault();
    event.stopPropagation();
    hideHint();
    lookPointer = event.pointerId;
    lookLast = { x: event.clientX, y: event.clientY };
    if (lookSurface) {
      try { lookSurface.setPointerCapture(event.pointerId); } catch (error) { /* no capture */ }
      lookSurface.classList.add("is-looking");
    }
    // Prime the canvas with a cursor position only once. The engine keeps the
    // last mouse position, so a later gesture must continue from it: priming
    // every gesture at the centre moves the view by the distance between the
    // last drag's end and the centre (measured: -3.56 deg for a 14 px offset).
    if (!lookCursor) primeLook(canvasCentre().x, canvasCentre().y);
  }

  // One aim step, shared by the look surface and a FIRE slide: move the
  // virtual cursor by the finger's own delta and tell the canvas.
  function aimBy(dx, dy) {
    if (!dx && !dy) return;
    var cursor = lookCursor || primeLook(canvasCentre().x, canvasCentre().y);
    var next = clampToCanvas(cursor.x + dx, cursor.y + dy);
    lookCursor = next;
    sendMouseMove(next.x, next.y);
  }

  function lookMove(event) {
    if (event.pointerId !== lookPointer) return;
    event.preventDefault();
    var dx = event.clientX - lookLast.x;
    var dy = event.clientY - lookLast.y;
    lookLast = { x: event.clientX, y: event.clientY };
    aimBy(dx, dy);
  }

  function lookUp(event) {
    if (event && event.pointerId !== undefined && event.pointerId !== lookPointer) return;
    if (lookPointer === null) return;
    lookPointer = null;
    lookLast = null;
    if (lookSurface) {
      lookSurface.classList.remove("is-looking");
      if (event && lookSurface.hasPointerCapture && lookSurface.hasPointerCapture(event.pointerId)) {
        try { lookSurface.releasePointerCapture(event.pointerId); } catch (error) { /* gone */ }
      }
    }
  }

  // Fire is mouse button 0, the engine's +attack. movementX/Y stay 0, and the
  // press is sent at the look cursor: the engine's reference point is already
  // there (the cursor moves by every look event), so the press moves the view
  // by zero. Measured: a press at the cursor after a drag turned 0.0 deg and
  // still fired; a press at the canvas centre without the priming move turned
  // the view by hundreds of degrees.
  function fire(down) {
    if (down === fireHeld) return;
    fireHeld = down;
    if (!canvas) return;
    var at = lookCursor || primeLook(canvasCentre().x, canvasCentre().y);
    canvas.dispatchEvent(new MouseEvent(down ? "mousedown" : "mouseup", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: down ? 1 : 0,
      clientX: at.x,
      clientY: at.y,
      pageX: at.x,
      pageY: at.y,
      movementX: 0,
      movementY: 0,
    }));
  }

  // FIRE as an aim surface: the pointer that pressed it turns the view as it
  // slides. The press itself turns nothing (it is sent at the look cursor).
  function fireDragStart(event) {
    if (!event || typeof event.clientX !== "number" || typeof event.clientY !== "number") return;
    fireDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
  }

  function fireDragMove(event) {
    if (!fireDrag || event.pointerId !== fireDrag.pointerId) return;
    var dx = event.clientX - fireDrag.x;
    var dy = event.clientY - fireDrag.y;
    fireDrag.x = event.clientX;
    fireDrag.y = event.clientY;
    aimBy(dx, dy);
  }

  // ---- WPN ------------------------------------------------------------------
  // One tap: the engine's weapnext. The engine's own weapon model index
  // (`gunindex`, engine-state.js) tells whether anything changed; when it has
  // not changed by WEAPON_SWITCH_MS the player carries nothing else to switch
  // to (every fresh spawn without cheats: the blaster only), and the pad says
  // so rather than leave a tap that does nothing. An unreadable engine state
  // says nothing at all.
  function engineWeaponIndex() {
    try {
      var engine = window.quake2Engine;
      var state = engine && typeof engine.read === "function" ? engine.read() : null;
      return state && typeof state.weaponIndex === "number" && state.weaponIndex > 0 ? state.weaponIndex : null;
    } catch (error) {
      return null;
    }
  }

  function showWeaponNote() {
    if (!weaponNote) return;
    weaponNote.hidden = false;
    clearTimeout(weaponNoteTimer);
    weaponNoteTimer = setTimeout(hideWeaponNote, WEAPON_NOTE_MS);
  }

  function hideWeaponNote() {
    clearTimeout(weaponNoteTimer);
    if (weaponNote) weaponNote.hidden = true;
  }

  function nextWeapon() {
    var before = engineWeaponIndex();
    hideWeaponNote();
    tapKey(ACTION_KEYS.weapon);
    weaponTaps += 1;
    clearTimeout(weaponWatch);
    if (before === null) return;
    var startedAt = Date.now();
    var frames = 0;
    var watchId = ++weaponWatchId;
    var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
    (function count() {
      if (watchId !== weaponWatchId) return;
      frames += 1;
      if (frames < WEAPON_SWITCH_FRAMES) raf(count);
    })();
    (function watch() {
      if (watchId !== weaponWatchId) return;
      var now = engineWeaponIndex();
      if (now !== null && now !== before) {
        weaponSwitches += 1;
        return;
      }
      if (Date.now() - startedAt >= WEAPON_SWITCH_MS && frames >= WEAPON_SWITCH_FRAMES) {
        if (live) showWeaponNote();
        return;
      }
      weaponWatch = setTimeout(watch, 100);
    })();
  }

  // ---- MENU -----------------------------------------------------------------
  function engineKeyDest() {
    try {
      var engine = window.quake2Engine;
      var dest = engine && typeof engine.keyDest === "function" ? engine.keyDest() : null;
      return typeof dest === "number" ? dest : null;
    } catch (error) {
      return null;
    }
  }

  function openEngineMenu() {
    tapKey(ACTION_KEYS.pause);
    var watchId = ++menuWatchId;
    var startedAt = Date.now();
    var frames = 0;
    var raf = window.requestAnimationFrame || function (fn) { return setTimeout(fn, 16); };
    (function count() {
      if (watchId !== menuWatchId) return;
      frames += 1;
      if (frames < MENU_CONFIRM_FRAMES) raf(count);
    })();
    (function watch() {
      if (watchId !== menuWatchId) return;
      // Anything but the game owning the keyboard means the engine took the
      // press (its menu, or the console); an unreadable state says nothing.
      if (engineKeyDest() !== 0) return;
      if (Date.now() - startedAt >= MENU_CONFIRM_MS && frames >= MENU_CONFIRM_FRAMES) {
        menuWatchId += 1;
        menuRetries += 1;
        tapKey(ACTION_KEYS.pause);
        return;
      }
      setTimeout(watch, 50);
    })();
  }

  function actionDown(action, event) {
    hideHint();
    if (action === "fire") { fireDragStart(event); fire(true); return; }
    if (action === "weapon") { nextWeapon(); return; }
    if (action === "pause") {
      // A pause must not leave a movement key down behind the menu.
      releaseKeys();
      fire(false);
      openEngineMenu();
      return;
    }
    var descriptor = ACTION_KEYS[action];
    if (descriptor) holdKey(action, descriptor, true);
  }

  function actionUp(action) {
    if (action === "fire") { fireDrag = null; fire(false); return; }
    if (action === "pause" || action === "weapon") return; // taps, not holds
    var descriptor = ACTION_KEYS[action];
    if (descriptor) holdKey(action, descriptor, false);
  }

  function releaseAll() {
    releaseKeys();
    fireDrag = null;
    fire(false);
    stickPointer = null;
    if (knob) knob.style.transform = "translate(0px, 0px)";
    if (stick) stick.classList.remove("is-active");
    lookPointer = null;
    lookLast = null;
    if (lookSurface) lookSurface.classList.remove("is-looking");
    // A lost touchend must not leave a button believing it still owns a
    // pointer: the next press would then be ignored for the rest of the
    // session, which is exactly how a FIRE that works once stops working.
    buttonPointers = Object.create(null);
    for (var i = 0; i < actionButtons.length; i++) actionButtons[i].classList.remove("is-down");
  }

  // ---- The thumbstick -----------------------------------------------------

  var stickPointer = null;

  function stickVector(event) {
    if (!stick) return null;
    var box = stick.getBoundingClientRect();
    var radius = box.width * STICK_RADIUS_FRACTION;
    var clientX = event.clientX;
    var clientY = event.clientY;
    // A pointer event with no usable coordinates is not a direction. The
    // known cause is a locked pointer: every event then reports 0,0, which
    // this ring (never at the top-left of the page) turns into "up-left for
    // ever" -- measured before the lock was refused: a centre press held
    // +forward and +left and the player walked diagonally with no finger
    // movement at all.
    if (typeof clientX !== "number" || typeof clientY !== "number" ||
        !isFinite(clientX) || !isFinite(clientY)) {
      return null;
    }
    if (clientX === 0 && clientY === 0 && (box.left > 1 || box.top > 1)) return null;
    var dx = clientX - (box.left + box.width / 2);
    var dy = clientY - (box.top + box.height / 2);
    var length = Math.hypot(dx, dy);
    if (length > radius) {
      dx = dx / length * radius;
      dy = dy / length * radius;
    }
    return { dx: dx, dy: dy, radius: radius || 1 };
  }

  function setStick(event) {
    var vector = stickVector(event);
    if (!vector) {
      // No reading: hold nothing and leave the knob centred.
      if (knob) knob.style.transform = "translate(0px, 0px)";
      holdKey("forward", MOVEMENT.forward, false);
      holdKey("back", MOVEMENT.back, false);
      holdKey("left", MOVEMENT.left, false);
      holdKey("right", MOVEMENT.right, false);
      return;
    }
    if (knob) knob.style.transform = "translate(" + vector.dx.toFixed(1) + "px, " + vector.dy.toFixed(1) + "px)";
    var nx = vector.dx / vector.radius;
    var ny = vector.dy / vector.radius;
    holdKey("forward", MOVEMENT.forward, ny < -STICK_DEADZONE);
    holdKey("back", MOVEMENT.back, ny > STICK_DEADZONE);
    holdKey("left", MOVEMENT.left, nx < -STICK_DEADZONE);
    holdKey("right", MOVEMENT.right, nx > STICK_DEADZONE);
  }

  function stickDown(event) {
    if (!live) return;
    if (stickPointer !== null) return;
    event.preventDefault();
    event.stopPropagation();
    hideHint();
    stickPointer = event.pointerId;
    try { stick.setPointerCapture(event.pointerId); } catch (error) { /* no capture */ }
    stick.classList.add("is-active");
    setStick(event);
  }

  function stickMove(event) {
    if (event.pointerId !== stickPointer) return;
    event.preventDefault();
    setStick(event);
  }

  function stickUp(event) {
    if (event.pointerId !== stickPointer) return;
    event.preventDefault();
    stickPointer = null;
    stick.classList.remove("is-active");
    if (knob) knob.style.transform = "translate(0px, 0px)";
    holdKey("forward", MOVEMENT.forward, false);
    holdKey("back", MOVEMENT.back, false);
    holdKey("left", MOVEMENT.left, false);
    holdKey("right", MOVEMENT.right, false);
  }

  // ---- Buttons ------------------------------------------------------------

  var actionButtons = root ? Array.prototype.slice.call(root.querySelectorAll("[data-mc-action]")) : [];

  function bindActionButtons() {
    for (var i = 0; i < actionButtons.length; i++) bindActionButton(actionButtons[i]);
  }

  var buttonPointers = Object.create(null);

  function bindActionButton(button) {
    var action = button.getAttribute("data-mc-action");
    button.addEventListener("pointerdown", function (event) {
      if (!live) return;
      event.preventDefault();
      event.stopPropagation();
      if (buttonPointers[action]) return;
      buttonPointers[action] = event.pointerId;
      button.classList.add("is-down");
      try { button.setPointerCapture(event.pointerId); } catch (error) { /* no capture */ }
      actionDown(action, event);
    });
    if (action === "fire") {
      button.addEventListener("pointermove", function (event) {
        if (buttonPointers[action] !== event.pointerId) return;
        event.preventDefault();
        fireDragMove(event);
      });
    }
    function release(event) {
      if (buttonPointers[action] !== event.pointerId) return;
      event.preventDefault();
      event.stopPropagation();
      delete buttonPointers[action];
      button.classList.remove("is-down");
      actionUp(action);
    }
    button.addEventListener("pointerup", release);
    button.addEventListener("pointercancel", release);
    button.addEventListener("lostpointercapture", release);
    button.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
    });
  }

  // ---- Show / hide, portrait and the hint ---------------------------------

  function applyPadVisibility() {
    if (!root) return;
    root.classList.toggle("controls-hidden", !padOn);
    if (padRow) {
      padRow.setAttribute("aria-pressed", padOn ? "true" : "false");
      padRow.setAttribute("aria-label", padOn ? "Touch controls on: hide the on-screen pad" : "Touch controls off: show the on-screen pad");
    }
    if (padRowValue) padRowValue.textContent = padOn ? "on" : "off";
    if (!padOn) releaseAll();
  }

  function syncLive() {
    if (!root) return;
    var show = uiEnabled && live;
    if (root.hidden !== !show) root.hidden = !show;
    document.body.classList.toggle("mc-live", show);
    if (!show) {
      releaseAll();
      weaponWatchId += 1;
      clearTimeout(weaponWatch);
      hideWeaponNote();
    }
  }

  function setPlaying(playing) {
    var wasLive = live;
    live = Boolean(playing) && uiEnabled;
    syncLive();
    // The mapping hint belongs to the first moment the pad is actually over a
    // running game, not to the boot plate or the menu.
    if (live && !wasLive) showHint();
  }

  function togglePad(event) {
    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }
    padOn = !padOn;
    writeStore(STORE_KEY, padOn ? "on" : "off");
    applyPadVisibility();
  }

  function showHint() {
    // In portrait the rotate card is the guidance; showing the control hint
    // behind it would only burn its one showing before the player turns.
    if (!hintElement || hintSeen || !uiEnabled || isPortrait()) return;
    hintElement.hidden = false;
    hintShownAt = Date.now();
    clearTimeout(hintTimer);
    hintTimer = setTimeout(hideHint, HINT_MS);
  }

  function hideHint() {
    if (!hintElement || hintElement.hidden) return;
    hintElement.hidden = true;
    clearTimeout(hintTimer);
    if (!hintSeen) {
      hintSeen = true;
      writeStore(HINT_KEY, "seen");
    }
  }

  // A touch on the game picture (the look area) is the last thing the hint
  // waits for. It is a window listener because the look area itself stays
  // transparent to touches.
  function onPictureTouch() {
    if (!uiEnabled || !live) return;
    if (Date.now() - hintShownAt > 700) hideHint();
  }

  // ---- Orientation --------------------------------------------------------

  function isPortrait() {
    return !!(portraitQuery && portraitQuery.matches);
  }

  function syncOrientation() {
    var portrait = uiEnabled && isPortrait();
    document.body.classList.toggle("mc-portrait", portrait);
    if (rotateOverlay) rotateOverlay.hidden = !portrait;
    if (!portrait && live) showHint();
  }

  function setRotateNote(text) {
    if (rotateNote) rotateNote.textContent = text;
  }

  // Android Chrome can lock the orientation, but only from a user gesture and
  // normally only in full screen. iOS Safari has no Screen Orientation API; the
  // overlay stays and asks the player to turn the device. Nothing here is
  // claimed when the platform refuses it: the note says what happened.
  var lockAttempted = false;
  function tryLandscapeLock() {
    if (lockAttempted) return;
    lockAttempted = true;
    var orientation = window.screen && window.screen.orientation;
    if (!orientation || typeof orientation.lock !== "function") {
      setRotateNote("This browser cannot rotate the screen for you. Turn the device sideways.");
      return;
    }
    var rootElement = document.documentElement;
    var full = Promise.resolve();
    if (!document.fullscreenElement && typeof rootElement.requestFullscreen === "function") {
      full = rootElement.requestFullscreen({ navigationUI: "hide" }).catch(function () { /* not allowed; the lock attempt below still speaks */ });
    }
    full.then(function () {
      return orientation.lock("landscape");
    }).then(function () {
      setRotateNote("Landscape locked.");
      syncOrientation();
    }, function () {
      setRotateNote("This browser cannot rotate the screen for you. Turn the device sideways.");
    });
  }

  // If the page is already in full screen (the player chose VIDEO > full
  // screen, fullscreen.js), the orientation lock is allowed there and costs
  // nothing.
  function lockIfFullscreen() {
    if (!uiEnabled || !isPortrait() || !document.fullscreenElement) return;
    var orientation = window.screen && window.screen.orientation;
    if (!orientation || typeof orientation.lock !== "function") return;
    orientation.lock("landscape").then(syncOrientation, function () { /* refused; the card stays */ });
  }

  function enableTouchUi() {
    if (uiEnabled) return;
    uiEnabled = true;
    document.body.classList.add("touch-ui");
    // The pad's on/off row exists only where there is a pad to put away.
    if (padGroup) padGroup.hidden = false;
    dropLegacyChoice();
    applyPadVisibility();
    syncOrientation();
    syncLive();
    refusePointerLock();
  }

  // ---- Pointer lock -------------------------------------------------------
  // The engine's SDL glue asks the canvas for pointer lock from inside a
  // canvas event (engine/index.js, Browser.init). On a touch page that is
  // poison: once the lock is held, every pointer event in the page reports
  // clientX/clientY 0,0 and is delivered to the canvas, so the stick can only
  // read "up-left" and the buttons stop receiving touches -- measured on this
  // build (2026-11-04): after one tap on the picture, a stick press at its
  // centre held +forward and +left and #mc-jump received no pointerdown.
  // The touch presentation never wants a locked pointer, so its request is
  // refused here. A desktop session (uiEnabled false) is passed through to
  // whatever app.js installed, unchanged.

  function refusePointerLock() {
    if (!uiEnabled) return;
    try {
      if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
    } catch (error) { /* no lock to release */ }
  }

  function guardPointerLock() {
    var proto = window.Element && Element.prototype;
    if (!proto || typeof proto.requestPointerLock !== "function" || proto.__q2touchGuard) return;
    var nativeRequest = proto.requestPointerLock;
    var guarded = function requestPointerLock() {
      if (!uiEnabled) return nativeRequest.apply(this, arguments);
      refusePointerLock();
      return Promise.resolve();
    };
    proto.requestPointerLock = guarded;
    try { proto.__q2touchGuard = true; } catch (error) { /* frozen prototype */ }
  }

  // ---- Engine bindings ----------------------------------------------------

  function touchCfg() {
    return [
      "// ClawBox touch controls (session only; not written back)",
      'bind e "+use"',
      'bind / "weapnext"',
      'bind c "+movedown"',
      "",
    ].join("\n");
  }

  function installEngineBindings() {
    if (!touchHardware || bindingsInstalled) return;
    if (typeof Module === "undefined" || !Module) return;
    bindingsInstalled = true;
    Module.preRun = Module.preRun || [];
    Module.preRun.push(function () {
      try {
        // config.cfg already execs wasm.cfg at startup; adding the exec there
        // makes the bindings apply even if the command line's +exec is read
        // before the configs. The extra file is written to both likely search
        // roots, so +exec finds it either way. This is the engine's memory, not
        // the player's saved config.
        var files = ["/baseq2/q2touch.cfg", "/q2touch.cfg"];
        for (var i = 0; i < files.length; i++) {
          try { FS.mkdirTree(files[i].slice(0, files[i].lastIndexOf("/"))); } catch (error) { /* exists */ }
          FS.writeFile(files[i], touchCfg());
        }
        try {
          var wasmPath = "/baseq2/wasm.cfg";
          var wasm = FS.readFile(wasmPath, { encoding: "utf8" });
          if (wasm.indexOf("q2touch.cfg") < 0) {
            FS.writeFile(wasmPath, wasm + '\n// ClawBox touch controls\nexec "q2touch.cfg"\n');
          }
        } catch (error) {
          // The command-line +exec below is the other route.
        }
      } catch (error) {
        console.warn("Touch controls: could not install the engine key bindings:", error);
      }
    });
    Module.arguments = Module.arguments || [];
    Module.arguments.push("+exec", "q2touch.cfg");
  }

  // ---- First real touch ---------------------------------------------------
  // A hybrid device whose primary pointer is a mouse gets the layer the first
  // time a finger touches the page, not before.

  function onFirstTouch(event) {
    if (event && event.pointerType && event.pointerType !== "touch") return;
    if (!uiEnabled) enableTouchUi();
  }

  // ---- Wiring -------------------------------------------------------------

  if (!root) return;

  installEngineBindings();
  guardPointerLock();
  bindActionButtons();

  if (lookSurface) {
    lookSurface.addEventListener("pointerdown", lookDown);
    lookSurface.addEventListener("pointermove", lookMove);
    lookSurface.addEventListener("pointerup", lookUp);
    lookSurface.addEventListener("pointercancel", lookUp);
    lookSurface.addEventListener("lostpointercapture", lookUp);
    lookSurface.addEventListener("contextmenu", function (event) { event.preventDefault(); });
  }

  // A touch on the pad must not turn into a click on whatever lies under the
  // finger once the pad is gone. MENU is the case that matters: the menu can
  // appear before the finger lifts (measured: the menu up 120 ms after the
  // press, the lift at 150 ms), and the browser's compatibility click for
  // that touch then lands on the panel that has just appeared under it.
  // Cancelling the touch's default action on the layer stops the
  // compatibility mouse events and that click; the pointer events that drive
  // every control still arrive.
  function cancelTouchDefault(event) {
    if (event.cancelable) event.preventDefault();
  }
  root.addEventListener("touchstart", cancelTouchDefault, { passive: false });
  root.addEventListener("touchend", cancelTouchDefault, { passive: false });

  stick.addEventListener("pointerdown", stickDown);
  stick.addEventListener("pointermove", stickMove);
  stick.addEventListener("pointerup", stickUp);
  stick.addEventListener("pointercancel", stickUp);
  stick.addEventListener("lostpointercapture", stickUp);
  stick.addEventListener("contextmenu", function (event) { event.preventDefault(); });

  if (padRow) padRow.addEventListener("click", togglePad);
  if (rotateButton) rotateButton.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    tryLandscapeLock();
  });

  window.addEventListener("pointerdown", onFirstTouch, true);
  window.addEventListener("touchstart", onFirstTouch, { capture: true, passive: true });
  // When the last finger leaves the glass, nothing should still be held. A
  // touchend that the browser turns into a scroll/cancel can skip the button's
  // own pointerup, and a button that still believes it owns a pointer would
  // ignore every later press.
  window.addEventListener("touchend", function (event) {
    if (!event.touches || event.touches.length === 0) releaseAll();
  }, true);
  window.addEventListener("touchcancel", function (event) {
    if (!event.touches || event.touches.length === 0) releaseAll();
  }, true);
  window.addEventListener("touchstart", onPictureTouch, { capture: true, passive: true });
  document.addEventListener("fullscreenchange", lockIfFullscreen);
  document.addEventListener("webkitfullscreenchange", lockIfFullscreen);
  window.addEventListener("orientationchange", function () {
    releaseAll();
    syncOrientation();
  });
  window.addEventListener("resize", syncOrientation);
  if (portraitQuery && typeof portraitQuery.addEventListener === "function") {
    portraitQuery.addEventListener("change", syncOrientation);
  }

  // A hidden page must not leave a key down in the engine.
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) releaseAll();
  });
  window.addEventListener("blur", releaseAll);

  if (autoTouchUi) enableTouchUi();
  applyPadVisibility();
  syncOrientation();

  window.quake2Touch = {
    isTouchUi: function () { return uiEnabled; },
    isPadOn: function () { return padOn; },
    isPortrait: function () { return uiEnabled && isPortrait(); },
    setPlaying: setPlaying,
    toggle: togglePad,
    releaseAll: releaseAll,
    tryLandscapeLock: tryLandscapeLock,
    hideHint: hideHint,
    state: function () {
      return {
        uiEnabled: uiEnabled, padOn: padOn, live: live, bindingsInstalled: bindingsInstalled,
        portrait: uiEnabled && isPortrait(), hintSeen: hintSeen,
        fireHeld: fireHeld, buttons: Object.keys(buttonPointers), keys: Object.keys(keysHeld),
        fireAiming: fireDrag !== null,
        weaponTaps: weaponTaps, weaponSwitches: weaponSwitches, menuRetries: menuRetries,
        weaponNote: Boolean(weaponNote && !weaponNote.hidden),
        lookActive: lookPointer !== null,
        lookCursor: lookCursor ? { x: lookCursor.x, y: lookCursor.y } : null,
        pointerLock: !!document.pointerLockElement,
      };
    },
  };
})();
