// Quake 2 for ClawBox: boots the Qwasm2 engine straight into the game.
// Ported from the upstream Qwasm2 page (reference/reference-qwasm2-index.html)
// with the launcher UI removed: fetch the PAKs, define the global Module the
// engine expects, then load engine/index.js.

// The engine's loader (engine/index.js) picks up this global when it runs.
// Everything else lives inside the closure so none of our names can clash
// with the loader's own top-level declarations.
var Module;

(function () {
  "use strict";

  // Relative URLs only: the box serves this app under /apps/quake2/.
  const PAK_DIR = "baseq2/";
  const REQUIRED_PAK = "pak0.pak";
  const OPTIONAL_PAKS = ["pak1.pak", "pak2.pak"];
  const ENGINE_DIR = "engine/";
  const ENGINE_SCRIPT = ENGINE_DIR + "index.js";
  // Matches Emscripten-style progress, e.g. "Downloading data... (123/456)".
  const PROGRESS_RE = /([^(]+)\((\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?|\?)\)/;
  // How long the canvas must stay hidden after showConsole before we treat it
  // as a real exit (the engine may hide and re-show it around a vid_restart).
  const EXIT_MESSAGE_DELAY_MS = 1000;

  const canvasElement = document.getElementById("canvas");
  const loadingElement = document.getElementById("loading");
  const statusElement = document.getElementById("status");
  const progressElement = document.getElementById("progress");
  const progressBarElement = document.getElementById("progress-bar");
  const detailElement = document.getElementById("detail");

  let pakDict = {};
  let engineRunning = false; // set once the runtime is up; later statuses are only logged
  let messageShown = false; // an error/exit message owns the indicator
  let lastStatus = { time: 0, text: null };
  let lastError = "";
  let exitStatus = null;
  let exitMessageTimer = 0;

  // ---- Loading indicator -------------------------------------------------

  function formatBytes(bytes) {
    return bytes >= 1048576
      ? (bytes / 1048576).toFixed(1) + " MiB"
      : Math.round(bytes / 1024) + " KiB";
  }

  function setIndicator(label, detail, fraction) {
    statusElement.textContent = label;
    detailElement.textContent = detail;
    if (fraction === null) {
      progressElement.hidden = true;
    } else {
      progressBarElement.style.transform = "scaleX(" + Math.min(Math.max(fraction, 0), 1) + ")";
      progressElement.hidden = false;
    }
    loadingElement.hidden = false;
  }

  function hideIndicator() {
    loadingElement.hidden = true;
  }

  function showMessage(label, detail) {
    messageShown = true;
    setIndicator(label, detail, null);
  }

  function clearMessage() {
    clearTimeout(exitMessageTimer);
    if (messageShown) {
      messageShown = false;
      hideIndicator();
    }
  }

  // ---- Engine helpers ----------------------------------------------------

  function noteEngineOutput(text) {
    // Yamagi's Sys_Error prints "Error: <reason>" just before the engine stops.
    const match = /^Error:\s*(.+)/.exec(String(text));
    if (match) lastError = match[1].trim();
  }

  function releasePointer() {
    if (document.pointerLockElement && document.exitPointerLock) document.exitPointerLock();
  }

  function scheduleExitMessage() {
    clearTimeout(exitMessageTimer);
    exitMessageTimer = setTimeout(function () {
      if (canvasElement.style.display !== "none") return;
      let label = "Quake 2 has quit.";
      if (lastError) label = "Quake 2 stopped: " + lastError;
      else if (exitStatus) label = "Quake 2 stopped (exit code " + exitStatus + ").";
      showMessage(label, "Reload the page to play again.");
    }, EXIT_MESSAGE_DELAY_MS);
  }

  function buildArguments() {
    let args = ["+set", "vid_renderer", "gles3"];
    if (window.location.search.length > 1) {
      const extra = window.location.search.substr(1).split("&").filter(Boolean).map(function (arg) {
        try {
          return decodeURIComponent(arg);
        } catch (error) {
          return arg;
        }
      });
      args = args.concat(extra);
    }
    return args;
  }

  // ---- Module: every callback the Qwasm2 engine uses ---------------------

  Module = {
    _canLockPointer: true,
    _depsLastLeft: 0,
    _depsDone: 0,
    _depsTotal: 0,

    canvas: (function () {
      canvasElement.addEventListener("webglcontextlost", function (e) {
        e.preventDefault();
        releasePointer();
        showMessage("The graphics context was lost.", "Reload the page to keep playing.");
      }, false);
      return canvasElement;
    })(),

    print: function (text) {
      console.log(text);
      noteEngineOutput(text);
    },

    printErr: function (text) {
      console.error(text);
      noteEngineOutput(text);
    },

    setStatus: function (text) {
      text = text ? String(text) : "";
      if (messageShown || text === lastStatus.text) return;
      if (!text) {
        lastStatus.text = text;
        hideIndicator();
        return;
      }
      if (engineRunning) {
        // The game is up: never draw the indicator over it again.
        console.info(text);
        return;
      }
      const m = text.match(PROGRESS_RE);
      if (m) {
        const now = performance.now();
        // Throttle to ~60 updates/s, but always show a finished step.
        if (now - lastStatus.time < 16.67 && m[2] !== m[3]) return;
        lastStatus.time = now;
        const label = m[1].trim();
        const from = Number(m[2]);
        if (m[3] !== "?") {
          const to = Number(m[3]);
          setIndicator(label, formatBytes(from) + " of " + formatBytes(to), to > 0 ? from / to : 0);
        } else {
          setIndicator(label, formatBytes(from), null);
        }
      } else {
        setIndicator(text, "", null);
      }
      lastStatus.text = text;
    },

    onRuntimeInitialized: function () {
      for (const pakFilename in pakDict) {
        const pakData = pakDict[pakFilename];
        const pakSize = pakData.length;
        console.info("Writing to MemFS: " + pakFilename + " (" + pakSize + " bytes)");
        const pakDestFile = FS.open("/baseq2/" + pakFilename, "w");
        FS.write(pakDestFile, pakData, 0, pakSize, 0);
        FS.close(pakDestFile);
      }
      // MemFS holds its own copy now; drop ours so the buffers can be freed.
      pakDict = {};
      engineRunning = true;
      hideIndicator();
    },

    monitorRunDependencies: function (left) {
      const depsDiff = Module._depsLastLeft - left;
      if (depsDiff !== 0) {
        if (depsDiff > 0) Module._depsDone += depsDiff;
        else Module._depsTotal -= depsDiff;
        Module._depsLastLeft = left;
        Module.setStatus("Preparing dependencies... (" + Module._depsDone + " done, " + Module._depsTotal + " found)");
      }
    },

    // Called by the engine once its video subsystem is up.
    hideConsole: function () {
      clearMessage();
      hideIndicator();
      canvasElement.style.display = "block";
      canvasElement.focus();
    },

    // Called by the engine on shutdown/error.
    showConsole: function () {
      canvasElement.style.display = "none";
      releasePointer();
      scheduleExitMessage();
    },

    exportFile: function (filePath) {
      try {
        const filePathSplit = filePath.split("/");
        const dataArray = new Uint8Array(FS.readFile(filePath));
        const dataBlob = new Blob([dataArray], { type: "application/octet-stream" });
        const objURL = URL.createObjectURL(dataBlob);
        const exportElement = document.createElement("a");
        exportElement.href = objURL;
        exportElement.download = filePathSplit[filePathSplit.length - 1];
        exportElement.hidden = true;
        document.body.appendChild(exportElement);
        exportElement.click();
        exportElement.remove();
        setTimeout(function () { URL.revokeObjectURL(objURL); }, 1000);
      } catch (error) {
        console.error("Error exporting file:", error);
      }
    },

    setGamma: function (vidGamma) {
      vidGamma = Number(Number(vidGamma).toFixed(2));
      console.info("Detected canvas gamma change: " + vidGamma);
      canvasElement.style.filter = vidGamma < 0 ? "" : "brightness(" + (vidGamma * 2.0) + ")";
    },

    captureMouse: function () {
      if (Module._canLockPointer && !Module._attemptPointerLock()) {
        Module._canLockPointer = false;
        console.info("Delayed pointer lock requested.");
        document.addEventListener("keydown", Module._lockPointerOnKey);
      }
    },

    winResized: function () {
      console.info("Detected window resize: " + canvasElement.width + "x" + canvasElement.height);
      if (!canvasElement.width || !canvasElement.height) return;
      let dVW, dVH;
      if (window.CSS && window.CSS.supports("height", "1dvh")) {
        dVW = "100dvw";
        dVH = "100dvh";
      } else {
        dVW = "100vw";
        dVH = "100vh";
      }
      const aspX = canvasElement.width + " / " + canvasElement.height;
      const aspY = canvasElement.height + " / " + canvasElement.width;
      canvasElement.style.width = "calc(min(" + dVW + ", " + dVH + " * " + aspX + "))";
      canvasElement.style.height = "calc(min(" + dVH + ", " + dVW + " * " + aspY + "))";
      canvasElement.style.marginTop = "calc(0.5 * (" + dVH + " - (min(" + dVH + ", " + dVW + " * " + aspY + "))))";
    },

    softExit: function (status) {
      console.info("Program exited with code", status);
      exitStatus = status;
      releasePointer();
    },

    // Qwasm2 reports a fatal WASM error here (e.g. the engine failed to start).
    onAbort: function (what) {
      canvasElement.style.display = "none";
      releasePointer();
      showMessage("Quake 2 stopped unexpectedly.", "Reload the page to try again.");
      console.error("Engine aborted:", what);
    },

    _attemptPointerLock: function () {
      if (document.pointerLockElement === null) {
        try {
          const request = canvasElement.requestPointerLock();
          // Newer browsers return a promise that rejects outside a user gesture.
          if (request && typeof request.catch === "function") request.catch(function () {});
        } catch (error) {
          // Not allowed right now; the keydown/click fallback will retry.
        }
      }
      return document.pointerLockElement !== null;
    },

    _lockPointerOnKey: function (event) {
      if ((event.key === "Escape") || Module._attemptPointerLock()) {
        Module._finishDelayedLock();
      }
    },

    _finishDelayedLock: function () {
      document.removeEventListener("keydown", Module._lockPointerOnKey);
      if (!Module._canLockPointer) console.info("Delayed pointer lock complete.");
      Module._canLockPointer = true;
    },

    arguments: buildArguments(),

    // The engine resolves index.wasm and the ref_*/game_*.wasm libraries
    // against its own script directory, but the file packager asks for
    // index.data with an empty prefix, which would resolve against this page
    // (…/apps/quake2/index.data, a 404). Point that one at engine/ as well.
    locateFile: function (path, prefix) {
      return (prefix || ENGINE_DIR) + path;
    },
  };

  // ---- Page wiring -------------------------------------------------------

  // The engine renames the window; keep the tab titled "Quake 2".
  try {
    const pageTitle = document.title;
    Object.defineProperty(document, "title", {
      configurable: true,
      get: function () { return pageTitle; },
      set: function (value) { console.info(value); },
    });
  } catch (error) {
    // Leave the title writable if the browser refuses the override.
  }

  canvasElement.addEventListener("contextmenu", function (event) {
    event.preventDefault();
  });

  // Clicking the game grabs the mouse (browsers only allow pointer lock
  // inside a user gesture, so this also completes a delayed lock request).
  canvasElement.addEventListener("click", function () {
    canvasElement.focus();
    if (document.pointerLockElement !== canvasElement) Module._attemptPointerLock();
  });

  document.addEventListener("pointerlockchange", function () {
    if (document.pointerLockElement === canvasElement) Module._finishDelayedLock();
  });

  // Keep keyboard focus on the game when clicking the letterbox bars or
  // coming back to the tab.
  document.addEventListener("mousedown", function (event) {
    if (event.target !== canvasElement && canvasElement.style.display === "block") {
      event.preventDefault();
      canvasElement.focus();
    }
  });
  window.addEventListener("focus", function () {
    if (canvasElement.style.display === "block") canvasElement.focus();
  });

  // ---- Boot ----------------------------------------------------------------

  // Downloads baseq2/<name> with progress. Resolves to a Uint8Array, or to
  // null for an optional PAK that is missing (404) or unreachable.
  async function downloadPak(name, required) {
    const url = PAK_DIR + name;
    const label = "Downloading " + name + "...";
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      if (required) throw new Error("Could not reach the server for " + url + ".", { cause: error });
      console.warn("Skipping " + url + ":", error);
      return null;
    }
    if (!response.ok) {
      if (required) throw new Error("The server answered HTTP " + response.status + " for " + url + ".");
      if (response.status !== 404) console.warn("Skipping " + url + ": HTTP " + response.status);
      return null;
    }

    try {
      if (!response.body || !response.body.getReader) {
        return new Uint8Array(await response.arrayBuffer());
      }
      const total = Number(response.headers.get("Content-Length")) || 0;
      // With Content-Encoding the length is the compressed size, so it cannot
      // be used to preallocate (it still drives the progress estimate).
      const encoded = response.headers.has("Content-Encoding");
      const reader = response.body.getReader();
      let buffer = total && !encoded ? new Uint8Array(total) : null;
      let chunks = buffer ? null : [];
      let loaded = 0;
      Module.setStatus(label + " (0/" + (total || "?") + ")");
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (buffer && loaded + value.length > buffer.length) {
          chunks = [buffer.subarray(0, loaded)];
          buffer = null;
        }
        if (buffer) buffer.set(value, loaded);
        else chunks.push(value);
        loaded += value.length;
        Module.setStatus(label + " (" + loaded + "/" + (total && loaded <= total ? total : "?") + ")");
      }
      if (buffer) {
        if (loaded !== buffer.length) throw new Error("cut short at " + loaded + " of " + buffer.length + " bytes");
        return buffer;
      }
      const data = new Uint8Array(loaded);
      let offset = 0;
      for (const chunk of chunks) {
        data.set(chunk, offset);
        offset += chunk.length;
      }
      return data;
    } catch (error) {
      if (required) throw new Error("The download of " + url + " was interrupted.", { cause: error });
      console.warn("Skipping " + url + ":", error);
      return null;
    }
  }

  function startEngine() {
    Module.setStatus("Starting Quake 2...");
    const mainScript = document.createElement("script");
    mainScript.src = ENGINE_SCRIPT;
    mainScript.async = true;
    mainScript.onerror = function () {
      showMessage("Could not load the game engine.", "Reload the page to try again.");
    };
    document.body.appendChild(mainScript);
  }

  async function boot() {
    try {
      pakDict[REQUIRED_PAK] = await downloadPak(REQUIRED_PAK, true);
    } catch (error) {
      console.error("Could not download game data:", error);
      showMessage("Could not download the game data.", error.message + " Reload the page to try again.");
      return;
    }
    for (const name of OPTIONAL_PAKS) {
      const data = await downloadPak(name, false);
      if (data) pakDict[name] = data;
    }
    startEngine();
  }

  boot();
})();
