// Quake 2 for ClawBox: full screen on open.
//
// The owner wants the game the whole screen as soon as they open the app, so
// this asks for full screen at once and, because every browser refuses a
// request that did not come from a user gesture, repeats it on the first
// click/keypress — which is also the click that grabs the mouse, so the game
// goes full screen the moment the owner starts playing. A small button in the
// corner toggles it back and forth afterwards, and Esc (the browser's own way
// out) leaves it too.
//
// The ClawBox desktop frames a web app in a sandboxed document when the app
// has no `launch: "window"` metadata, and Chrome refuses full screen to such
// a frame outright (`document.fullscreenEnabled` is false). That is handled,
// not hidden: the corner button then offers the app in its own window, which
// on the box's screen is a kiosk tab that already fills the display.
//
// No dependencies and no globals beyond one closure: app.js keeps the engine.

(function () {
  "use strict";

  var root = document.documentElement;
  var button = document.getElementById("fullscreen-button");
  var hint = document.getElementById("fullscreen-hint");
  var hintOpen = document.getElementById("fullscreen-open-window");
  if (!button) return;

  var requestFn = root.requestFullscreen || root.webkitRequestFullscreen;
  var exitFn = document.exitFullscreen || document.webkitExitFullscreen;
  var supported = typeof requestFn === "function";
  // "Refused for want of a gesture" is not a failure worth telling anyone
  // about — the next click fixes it. A document that cannot go full screen at
  // all is, and `fullscreenEnabled` is the reliable way to know: Chrome
  // reports false inside the desktop's sandboxed frame before any request is
  // made, and its refusals there say "Disallowed by permissions policy".
  var blocked = typeof document.fullscreenEnabled === "boolean" && !document.fullscreenEnabled;
  var framed = window !== window.top;
  var hintTimer = 0;
  var armed = true;

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function isFullscreen() {
    return fullscreenElement() !== null;
  }

  function request() {
    if (!supported) return Promise.reject(new Error("Full screen is not available in this browser."));
    try {
      // `navigationUI: "hide"` is the plain full screen: no tab strip next to
      // the game. Older browsers ignore the argument.
      var result = requestFn.call(root, { navigationUI: "hide" });
      return result && typeof result.then === "function" ? result : Promise.resolve();
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function exit() {
    if (typeof exitFn !== "function") return;
    try {
      var result = exitFn.call(document);
      if (result && typeof result.catch === "function") result.catch(function () {});
    } catch (error) {
      // Already out of full screen.
    }
  }

  function toggle() {
    if (isFullscreen()) exit();
    else void request().then(sync).catch(onRefused);
  }

  function sync() {
    var on = isFullscreen();
    button.setAttribute("aria-pressed", on ? "true" : "false");
    if (blocked) {
      // Never full screen in this document: the button's job becomes opening
      // one where it is possible.
      button.title = "Open in its own window for full screen";
      button.setAttribute("aria-label", "Open in its own window for full screen");
    } else {
      button.title = on ? "Leave full screen (Esc)" : "Full screen";
      button.setAttribute("aria-label", on ? "Leave full screen" : "Enter full screen");
    }
    button.classList.toggle("is-on", on);
    document.body.classList.toggle("is-fullscreen", on);
    if (on) hideHint();
  }

  function showHint(sticky) {
    if (!hint) return;
    hint.hidden = false;
    clearTimeout(hintTimer);
    // A refusal a click fixes is a passing note; one no click can fix stays
    // until the owner acts on it.
    if (!sticky) hintTimer = setTimeout(hideHint, 12000);
  }

  function hideHint() {
    if (!hint) return;
    clearTimeout(hintTimer);
    hint.hidden = true;
  }

  function onRefused(error) {
    var message = String((error && error.message) || error || "");
    // Chrome refuses a permission-policy denial with "Disallowed by
    // permissions policy" and a missing-gesture call with "API can only be
    // initiated by a user gesture" (older builds: "Permissions check
    // failed"). Only the first means this document can never do it.
    if (/policy|sandbox/i.test(message)) {
      blocked = true;
      showHint(true);
      sync();
      return;
    }
    // Everything else is the gesture rule: the next click asks again.
    console.info("Full screen is waiting for a click:", message);
  }

  function onFirstGesture(event) {
    if (!armed) return;
    if (event && event.target === button) return;
    armed = false;
    if (isFullscreen() || blocked) return;
    // Best effort inside the gesture that also grabs the mouse; a refusal
    // here is expected where full screen is disallowed and is handled above.
    void request().then(sync).catch(onRefused);
  }

  function openOwnWindow() {
    // A top-level document is what full screen needs; on the box's screen the
    // desktop opens it as a kiosk tab that already fills the display.
    //
    // "noopener" in the feature string makes window.open return null even when
    // the window *did* open (the spec says so), so the old fallback reloaded
    // this page and threw away the running game after successfully opening the
    // new window. Sever the opener from the new window instead, and reload only
    // when nothing was opened at all.
    var opened = window.open(window.location.href, "_blank");
    if (opened) {
      try { opened.opener = null; } catch (error) { /* already cross-origin or closed */ }
    } else {
      window.location.href = window.location.href;
    }
  }

  button.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    if (blocked) openOwnWindow();
    else toggle();
  });
  // The game's own click handler keeps focus and the mouse; this one only
  // asks for the screen, and runs first (capture) so both share the gesture.
  ["pointerdown", "touchstart", "keydown"].forEach(function (name) {
    document.addEventListener(name, onFirstGesture, { capture: true, passive: true });
  });
  document.addEventListener("fullscreenchange", sync);
  document.addEventListener("webkitfullscreenchange", sync);

  if (hintOpen) {
    hintOpen.addEventListener("click", function (event) {
      event.preventDefault();
      event.stopPropagation();
      openOwnWindow();
      hideHint();
    });
  }

  if (!supported) {
    blocked = true;
    button.hidden = true;
    return;
  }

  sync();
  if (blocked) {
    // The desktop framed this app in a sandboxed document: say where full
    // screen does work instead of pretending a click will fix it.
    if (framed) showHint(true);
    return;
  }
  // At load the browser will refuse for want of a gesture; that refusal is
  // the normal path, and the first click picks it up.
  void request().then(sync).catch(onRefused);
})();
