// Quake 2 for ClawBox: full screen by the player's own request, from the menu.
//
// Full screen is entered only when the player chooses VIDEO > full screen (the
// owner's HUD review: no control floats over the game picture any more). The
// page asks for nothing on its own: not at load, and not on the first click on
// the game. A page that took the whole screen the moment the player clicked to
// start playing was doing something the player did not ask for, and it made
// the first click mean two things at once. The row toggles the mode, its
// aria/value state follows the browser's own `fullscreenchange`, and Esc (the
// browser's own way out) leaves it too.
//
// The ClawBox desktop frames a web app in a sandboxed document when the app
// has no `launch: "window"` metadata, and Chrome refuses full screen to such
// a frame outright (`document.fullscreenEnabled` is false). That is handled,
// not hidden: the same row then reads "own window" and offers the app in its
// own window, which on the box's screen is a kiosk tab that already fills the
// display. The row is the only full-screen control in the page.
//
// No dependencies and no globals beyond one closure plus the read-only
// `window.quake2Fullscreen` status the checks use.

(function () {
  "use strict";

  var root = document.documentElement;
  var row = document.querySelector('[data-action="fullscreen"]');
  var value = document.getElementById("fullscreen-value");
  if (!row) return;

  var requestFn = root.requestFullscreen || root.webkitRequestFullscreen;
  var exitFn = document.exitFullscreen || document.webkitExitFullscreen;
  var supported = typeof requestFn === "function";
  // "Refused for want of a gesture" is not a failure worth telling anyone
  // about — every request this file makes now comes from the row's own click.
  // A document that cannot go full screen at all is, and `fullscreenEnabled`
  // is the reliable way to know: Chrome reports false inside the desktop's
  // sandboxed frame before any request is made, and its refusals there say
  // "Disallowed by permissions policy".
  var blocked = !supported || (typeof document.fullscreenEnabled === "boolean" && !document.fullscreenEnabled);
  var framed = window !== window.top;
  // Diagnostics the checks can read: how many requests this document made,
  // and the browser's own last refusal. Nothing in the page depends on them.
  var requests = 0;
  var lastRefusal = null;

  function fullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
  }

  function isFullscreen() {
    return fullscreenElement() !== null;
  }

  function request() {
    requests += 1;
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

  // The row's own words: what a tap will do now, and whether the page is in
  // the mode. A blocked document never claims "off" (a tap does not turn it
  // off); it says where full screen is possible instead.
  function label() {
    if (blocked) return "own window";
    return isFullscreen() ? "on" : "off";
  }

  function describe() {
    if (blocked) return "Full screen is blocked in this window; open the app in its own window";
    return isFullscreen() ? "Leave full screen (Esc)" : "Enter full screen";
  }

  function sync() {
    var on = isFullscreen();
    row.setAttribute("aria-pressed", on ? "true" : "false");
    row.setAttribute("aria-label", describe());
    row.title = describe();
    row.classList.toggle("is-on", on);
    if (value) value.textContent = label();
    document.body.classList.toggle("is-fullscreen", on);
  }

  function onRefused(error) {
    var message = String((error && error.message) || error || "");
    lastRefusal = message;
    // Chrome refuses a permission-policy denial with "Disallowed by
    // permissions policy" and a missing-gesture call with "API can only be
    // initiated by a user gesture" (older builds: "Permissions check
    // failed"). Only the first means this document can never do it.
    if (/policy|sandbox/i.test(message)) {
      blocked = true;
      sync();
      return;
    }
    // Everything else is this browser refusing this document for now. Nothing
    // retries on its own any more, so say so where the page's own log can see
    // it; the row stays available for another try.
    console.info("Full screen was refused:", message);
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

  row.addEventListener("click", function (event) {
    event.preventDefault();
    event.stopPropagation();
    if (blocked) openOwnWindow();
    else toggle();
  });
  document.addEventListener("fullscreenchange", sync);
  document.addEventListener("webkitfullscreenchange", sync);

  sync();

  // Read-only, for the checks and for the page's own diagnostics. Nothing else
  // in the page needs to know the mode.
  window.quake2Fullscreen = {
    status: function () {
      return {
        supported: supported,
        blocked: blocked,
        framed: framed,
        enabled: document.fullscreenEnabled,
        requests: requests,
        lastRefusal: lastRefusal,
        fullscreen: isFullscreen(),
        value: label(),
        label: describe(),
      };
    },
    toggle: toggle,
  };
})();
