// Quake 2 for ClawBox: on-screen controls for phones and tablets.
//
// This file is inert on a desktop: nothing is shown and nothing is sent unless
// the page is being used on a touch device (pointer: coarse, or a touch point
// exists). The desktop keeps its keyboard, mouse and pointer-lock presentation
// exactly as it was.
//
// ---- How input reaches the engine ---------------------------------------
// Movement, jump, use, the weapon cycle and pause are synthetic keydown/keyup
// events in the same shape app.js's dispatchKey() builds
// (window.quake2App.dispatchKey/tapKey).
//
// Fire is mouse button 0, the button the engine's own config binds to +attack.
//
// Look is the engine's own touch input: the right-hand area is deliberately
// transparent to touches (#mc-look has pointer-events: none), so a finger
// dragging there lands on the game canvas, exactly as a finger dragging in the
// picture does. That is the engine's native touch path, it needs no pointer
// lock, and it produces both yaw and pitch. Nothing synthesizes mouse
// movement: this build's SDL layer only reads relative mouse motion under a
// real pointer lock, and a touch page must not take one.
//
// The engine's own config binds no key to +use and no key to weapprev, so the
// touch layer installs a small cfg file through Module.preRun (before the
// engine's main runs) that binds the keys this layer presses. The file lives in
// the engine's in-memory FS and this page never writes the player's
// config.cfg. (The engine itself may save its runtime bindings when it writes
// its own config on exit, exactly as it would for any bind made at its
// console.) Desktop sessions never install it.
//
// ---- Layout -------------------------------------------------------------
// The thumbstick is bottom left. The right thumb gets a large FIRE button in
// the bottom-right corner, with JUMP and USE in the same thumb arc and the
// small weapon-cycle pair above them along the right edge; the centre-right of
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

  var STORE_KEY = "quake2-touch-controls";
  var HINT_KEY = "quake2-touch-hint";
  var STICK_DEADZONE = 0.22;
  var STICK_RADIUS_FRACTION = 0.42;
  var HINT_MS = 9000;

  var root = document.getElementById("mobile-controls");
  var stick = document.getElementById("mc-stick");
  var knob = document.getElementById("mc-stick-knob");
  var toggleButton = document.getElementById("mc-toggle");
  var hintElement = document.getElementById("mc-hint");
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

  function readStore(key) {
    try {
      return window.localStorage.getItem(key);
    } catch (error) {
      // The ClawBox desktop may frame the app in an opaque-origin sandbox,
      // where storage is denied. The toggle still works for this session.
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
    use: { key: "e", code: "KeyE", vk: 69 },
    prev: { key: "[", code: "BracketLeft", vk: 219 },
    next: { key: "]", code: "BracketRight", vk: 221 },
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

  function canvasCentre() {
    var box = canvas ? canvas.getBoundingClientRect() : { left: 0, top: 0, width: 0, height: 0 };
    return { x: box.left + box.width / 2, y: box.top + box.height / 2 };
  }

  // Fire is mouse button 0, the engine's +attack. movementX/Y stay 0, and the
  // press is at the canvas centre every time: the press can never turn the
  // view, whether or not a look drag came before it.
  function fire(down) {
    if (down === fireHeld) return;
    fireHeld = down;
    if (!canvas) return;
    var centre = canvasCentre();
    canvas.dispatchEvent(new MouseEvent(down ? "mousedown" : "mouseup", {
      bubbles: true,
      cancelable: true,
      button: 0,
      buttons: down ? 1 : 0,
      clientX: centre.x,
      clientY: centre.y,
      movementX: 0,
      movementY: 0,
    }));
  }

  function actionDown(action) {
    hideHint();
    if (action === "fire") { fire(true); return; }
    if (action === "pause") {
      // A pause must not leave a movement key down behind the menu.
      releaseKeys();
      fire(false);
      tapKey(ACTION_KEYS.pause);
      return;
    }
    var descriptor = ACTION_KEYS[action];
    if (descriptor) holdKey(action, descriptor, true);
  }

  function actionUp(action) {
    if (action === "fire") { fire(false); return; }
    if (action === "pause") return; // it is a tap, not a hold
    var descriptor = ACTION_KEYS[action];
    if (descriptor) holdKey(action, descriptor, false);
  }

  function releaseAll() {
    releaseKeys();
    fire(false);
    stickPointer = null;
    if (knob) knob.style.transform = "translate(0px, 0px)";
    if (stick) stick.classList.remove("is-active");
    // A lost touchend must not leave a button believing it still owns a
    // pointer: the next press would then be ignored for the rest of the
    // session, which is exactly how a FIRE that works once stops working.
    buttonPointers = Object.create(null);
    for (var i = 0; i < actionButtons.length; i++) actionButtons[i].classList.remove("is-down");
  }

  // ---- The thumbstick -----------------------------------------------------

  var stickPointer = null;

  function stickVector(event) {
    var box = stick.getBoundingClientRect();
    var radius = box.width * STICK_RADIUS_FRACTION;
    var dx = event.clientX - (box.left + box.width / 2);
    var dy = event.clientY - (box.top + box.height / 2);
    var length = Math.hypot(dx, dy);
    if (length > radius) {
      dx = dx / length * radius;
      dy = dy / length * radius;
    }
    return { dx: dx, dy: dy, radius: radius || 1 };
  }

  function setStick(event) {
    var vector = stickVector(event);
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
      actionDown(action);
    });
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
    if (toggleButton) {
      toggleButton.setAttribute("aria-pressed", padOn ? "true" : "false");
      toggleButton.setAttribute("aria-label", padOn ? "Hide touch controls" : "Show touch controls");
      toggleButton.classList.toggle("is-off", !padOn);
    }
    if (!padOn) releaseAll();
  }

  function syncLive() {
    if (!root) return;
    var show = uiEnabled && live;
    if (root.hidden !== !show) root.hidden = !show;
    document.body.classList.toggle("mc-live", show);
    if (!show) releaseAll();
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

  // If the page is already in full screen (fullscreen.js asks for it on the
  // first gesture), the orientation lock is allowed there and costs nothing.
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
    applyPadVisibility();
    syncOrientation();
    syncLive();
  }

  // ---- Engine bindings ----------------------------------------------------

  function touchCfg() {
    return [
      "// ClawBox touch controls (session only; not written back)",
      'bind e "+use"',
      'bind [ "weapprev"',
      'bind ] "weapnext"',
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
  bindActionButtons();

  stick.addEventListener("pointerdown", stickDown);
  stick.addEventListener("pointermove", stickMove);
  stick.addEventListener("pointerup", stickUp);
  stick.addEventListener("pointercancel", stickUp);
  stick.addEventListener("lostpointercapture", stickUp);
  stick.addEventListener("contextmenu", function (event) { event.preventDefault(); });

  if (toggleButton) toggleButton.addEventListener("click", togglePad);
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
      };
    },
  };
})();
