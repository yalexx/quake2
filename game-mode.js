// Quake 2 for ClawBox: the native-fullscreen game mode.
//
// "Game mode" is the presentation a native game has on this box: the game
// surface alone on the display, with every piece of page interface gone --
// the chips, the panel, the full-screen button, the boot plate -- and the page
// itself black outside the picture, so the letterbox bars cannot be mistaken
// for a web page. It asks the browser for full screen on the display the game
// is on (that is what removes the browser chrome), and, where the Window
// Management API exists and the owner allows it, it opens one black window on
// every *other* display so a multi-monitor desktop shows the game on one
// monitor and black on the rest, the way a native full-screen game does.
//
// What a web page cannot do is honest and is reported, not claimed: without
// the Window Management API (or with its permission refused) a page can cover
// only the display it is on, and it cannot hide other applications' windows on
// any display. `status()` says exactly which of those happened.
//
// The mode is reachable from the VIDEO menu's `game mode` row and from
// Alt+Enter anywhere; leaving full screen with Esc (the browser's own way out)
// leaves the mode too, and the page interface comes back. fullscreen.js keeps
// its own full-screen-on-open behaviour: this file never changes its state.
//
// No dependencies and no globals beyond `window.quake2GameMode`.

(function () {
  "use strict";

  var root = document.documentElement;
  var body = document.body;
  var MODE_CLASS = "is-game-mode";
  var state = {
    active: false,
    since: null,
    source: null,
    fullscreen: false,
    requested: false,
    reason: null,
    displays: null,
    blackout: null,
    blackoutWindows: [],
    pageUiHidden: false,
    rendererGameMode: false,
  };
  var started = 0;

  function nowIso() {
    return new Date().toISOString();
  }

  function renderer(on) {
    try {
      if (window.quake2RTX && typeof window.quake2RTX.gameMode === "function") {
        window.quake2RTX.gameMode(on);
        state.rendererGameMode = Boolean(window.quake2RTX.status && window.quake2RTX.status().gameMode);
        return true;
      }
    } catch (error) {
      console.warn("Game mode: the renderer refused the mode switch:", error);
    }
    state.rendererGameMode = false;
    return false;
  }

  function uiHidden() {
    // The CSS class hides every page layer; this reads the result back rather
    // than assuming the stylesheet applied.
    var layers = ["ui", "fullscreen-button", "fullscreen-hint", "loading", "banner", "prompt"];
    var hidden = 0;
    for (var i = 0; i < layers.length; i++) {
      var element = document.getElementById(layers[i]);
      if (!element) continue;
      if (element.hidden || element.style.display === "none" || getComputedStyle(element).display === "none") hidden++;
    }
    return hidden > 0;
  }

  function requestFullscreen() {
    // fullscreen.js asks for the screen on the first gesture too; a request
    // that arrives when the document is already full screen is a success, not
    // a refusal to report.
    if (document.fullscreenElement || document.webkitFullscreenElement) {
      state.requested = true;
      state.fullscreen = true;
      return Promise.resolve(true);
    }
    if (state.requested) return Promise.resolve(state.fullscreen);
    if (typeof document.fullscreenEnabled === "boolean" && !document.fullscreenEnabled) {
      state.reason = "fullscreen-disallowed-in-this-document";
      return Promise.resolve(false);
    }
    var fn = root.requestFullscreen || root.webkitRequestFullscreen;
    if (typeof fn !== "function") {
      state.reason = "fullscreen-api-unavailable";
      return Promise.resolve(false);
    }
    state.requested = true;
    var result;
    try {
      result = fn.call(root, { navigationUI: "hide" });
    } catch (error) {
      state.reason = String((error && error.message) || error);
      return Promise.resolve(false);
    }
    return Promise.resolve(result).then(function () {
      state.fullscreen = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
      if (!state.fullscreen) state.reason = "fullscreen-request-did-not-take";
      return state.fullscreen;
    }, function (error) {
      // A missing gesture is fixed by the next click; a permission policy
      // refusal is not. Either way the page-level mode still applies.
      state.reason = String((error && error.message) || error || "fullscreen refused");
      state.fullscreen = false;
      return false;
    });
  }

  function closeBlackouts() {
    for (var i = 0; i < state.blackoutWindows.length; i++) {
      try { state.blackoutWindows[i].close(); } catch (error) { /* already gone */ }
    }
    state.blackoutWindows = [];
  }

  // One opaque black window per display other than this one. That is the only
  // way a page can turn another monitor black, and it needs the Window
  // Management API's permission. Nothing here is claimed when it is absent:
  // `status().blackout` carries the reason.
  function blankOtherDisplays() {
    if (state.blackout) return Promise.resolve(state.blackout);
    var asked = typeof window.getScreenDetails === "function";
    if (!asked) {
      state.blackout = {
        supported: false,
        reason: "window-management-unavailable",
        screens: null,
        windows: 0,
        blocked: 0,
      };
      return Promise.resolve(state.blackout);
    }
    return window.getScreenDetails().then(function (details) {
      var screens = (details && details.screens) || [];
      var current = details && details.currentScreen;
      state.displays = {
        count: screens.length,
        current: current ? { width: current.width, height: current.height, left: current.left, top: current.top } : null,
        screens: screens.map(function (screen) {
          return { left: screen.left, top: screen.top, width: screen.width, height: screen.height,
            availLeft: screen.availLeft, availTop: screen.availTop, availWidth: screen.availWidth, availHeight: screen.availHeight,
            isCurrent: screen === current };
        }),
      };
      var others = screens.filter(function (screen) { return screen !== current; });
      var blocked = 0;
      for (var i = 0; i < others.length; i++) {
        var screen = others[i];
        var left = screen.availLeft !== undefined ? screen.availLeft : screen.left;
        var top = screen.availTop !== undefined ? screen.availTop : screen.top;
        var width = screen.availWidth !== undefined ? screen.availWidth : screen.width;
        var height = screen.availHeight !== undefined ? screen.availHeight : screen.height;
        var win = null;
        try {
          win = window.open("about:blank", "q2-blackout-" + i,
            "popup=yes,left=" + left + ",top=" + top + ",width=" + width + ",height=" + height + ",menubar=no,toolbar=no,location=no,status=no,resizable=no");
        } catch (error) {
          win = null;
        }
        if (!win) { blocked++; continue; }
        try {
          win.document.title = "Quake 2 — display blackout";
          win.document.documentElement.style.background = "#000";
          win.document.documentElement.style.colorScheme = "dark";
          win.document.body.style.margin = "0";
          win.document.body.style.width = "100vw";
          win.document.body.style.height = "100vh";
          win.document.body.style.overflow = "hidden";
          win.document.body.style.background = "#000";
        } catch (error) { /* the window is still blank; it is not ours to paint */ }
        try {
          win.moveTo(left, top);
          win.resizeTo(width, height);
        } catch (error) { /* the feature string already placed it */ }
        state.blackoutWindows.push(win);
      }
      state.blackout = {
        supported: true,
        reason: blocked ? "popups-blocked" : others.length ? null : "single-display",
        screens: screens.length,
        current: state.displays.current,
        windows: state.blackoutWindows.length,
        blocked: blocked,
      };
      return state.blackout;
    }, function (error) {
      state.blackout = {
        supported: true,
        reason: "permission-refused",
        error: String((error && error.message) || error),
        screens: null,
        windows: 0,
        blocked: 0,
      };
      return state.blackout;
    });
  }

  function notify() {
    try {
      window.dispatchEvent(new CustomEvent("quake2gamemode", { detail: status() }));
    } catch (error) { /* no CustomEvent: the API still works */ }
    var value = document.getElementById("game-mode-value");
    if (value) value.textContent = state.active ? "on" : "off";
    for (var i = 0; i < document.querySelectorAll('[data-action="game-mode"]').length; i++) {
      document.querySelectorAll('[data-action="game-mode"]')[i].setAttribute("aria-pressed", state.active ? "true" : "false");
    }
  }

  function status() {
    var canvas = document.getElementById("canvas");
    var rect = canvas ? canvas.getBoundingClientRect() : null;
    return {
      active: state.active,
      since: state.since,
      source: state.source,
      fullscreen: Boolean(document.fullscreenElement || document.webkitFullscreenElement),
      requested: state.requested,
      reason: state.reason,
      displays: state.displays,
      blackout: state.blackout,
      pageUiHidden: state.active ? uiHidden() : false,
      rendererGameMode: state.rendererGameMode,
      canvas: rect ? { cssWidth: rect.width, cssHeight: rect.height } : null,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      shortcut: "Alt+Enter",
      exit: "Alt+Enter, or Esc to leave full screen",
    };
  }

  function enter(source) {
    if (state.active) return Promise.resolve(status());
    state.active = true;
    state.source = source || "api";
    state.since = nowIso();
    state.reason = null;
    state.fullscreen = false;
    state.requested = false;
    started = performance.now();
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    body.classList.add(MODE_CLASS);
    root.classList.add(MODE_CLASS);
    renderer(true);
    var full = requestFullscreen();
    var blackout = blankOtherDisplays();
    Promise.all([full, blackout]).then(function () {
      state.pageUiHidden = uiHidden();
      notify();
    });
    notify();
    return Promise.resolve(status());
  }

  // `options.keepFullscreen` leaves the page presentation but keeps the full
  // screen: it is how a measurement compares the page and game mode in the same
  // display state, so the only difference is the page work the mode removes.
  function exit(source, options) {
    if (!state.active) return status();
    var keepFullscreen = Boolean(options && options.keepFullscreen);
    state.active = false;
    state.reason = state.reason || (source ? "left-by-" + source : "left");
    body.classList.remove(MODE_CLASS);
    root.classList.remove(MODE_CLASS);
    closeBlackouts();
    state.blackout = null;
    state.displays = null;
    renderer(false);
    state.pageUiHidden = false;
    var fullElement = document.fullscreenElement || document.webkitFullscreenElement;
    if (!keepFullscreen && fullElement && (document.exitFullscreen || document.webkitExitFullscreen)) {
      try {
        var result = (document.exitFullscreen || document.webkitExitFullscreen).call(document);
        if (result && typeof result.catch === "function") result.catch(function () {});
      } catch (error) { /* already out */ }
    }
    if (!keepFullscreen) {
      state.requested = false;
      state.fullscreen = false;
    }
    notify();
    return status();
  }

  function toggle(source) {
    return state.active ? Promise.resolve(exit(source)) : enter(source);
  }

  // Alt+Enter anywhere, before any other handler sees the key. The browser's
  // own F11 is deliberately left alone: it only fills the window and leaves
  // the page interface on screen, which is not this mode.
  window.addEventListener("keydown", function (event) {
    if (!event.altKey || (event.key !== "Enter" && event.code !== "Enter")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void toggle("keyboard");
  }, true);

  // Leaving full screen by any route -- the browser's Esc, the fullscreen.js
  // control, a system gesture -- leaves game mode, so the page interface is
  // never stranded hidden.
  function onFullscreenChange() {
    var on = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
    state.fullscreen = on;
    if (!on && state.active) exit("fullscreen-exit");
    else notify();
  }
  document.addEventListener("fullscreenchange", onFullscreenChange);
  document.addEventListener("webkitfullscreenchange", onFullscreenChange);

  window.addEventListener("pagehide", function () {
    closeBlackouts();
  });

  document.addEventListener("visibilitychange", function () {
    if (document.hidden && state.active) {
      // A backgrounded page must not leave black windows on other displays.
      closeBlackouts();
      state.blackout = null;
    }
  });

  window.quake2GameMode = {
    enter: enter,
    exit: exit,
    toggle: toggle,
    status: status,
    isActive: function () { return state.active; },
    since: function () { return started; },
    enterFromMenu: function () { return enter("menu"); },
  };
  notify();
})();
