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
  // Saved games and config.cfg: server.js keeps them (the page's sandbox has
  // no IndexedDB or localStorage).
  const USERDATA_URL = "userdata/";
  // Yamagi lists and loads a save slot only while its server.ssv exists.
  const SLOT_FILE = "server.ssv";
  // Startup downloads: tries per file, and the first pause between them.
  const RESTORE_TRIES = 4;
  const RESTORE_RETRY_MS = 500;
  // A failed push is retried after 1 s, 2 s, 4 s, … up to 30 s, until it lands.
  const PUSH_RETRY_MS = 1000;
  const PUSH_RETRY_MAX_MS = 30000;
  // Browsers cap keepalive request bodies at 64 KiB in flight.
  const KEEPALIVE_MAX_BYTES = 60 * 1024;
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
  let userStore = null; // what the server keeps, from boot until the engine restores it
  let userRoot = null; // the engine's IDBFS mount point (/qwasm2)
  let serverFiles = {}; // relPath -> fingerprint of the copy the server holds
  let keptFiles = new Set(); // on the server but never downloaded: never deleted there
  let refusedFiles = {}; // relPath -> fingerprint of a copy the server refused for good
  let pushWaiters = []; // syncfs callbacks the next push answers
  let pushRunning = false;
  let pushFailures = 0; // failed pushes in a row
  let pushRetryTimer = 0;
  let pageHiding = false; // the page is going away: small requests use keepalive
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

  // ---- Saved games -------------------------------------------------------
  // The engine writes saves and config.cfg under /qwasm2, an IDBFS mount it
  // restores at startup (FS.syncfs(true)) and syncs after `save` and on quit
  // (FS.syncfs(false)). IndexedDB is denied in the box's sandboxed iframe, so
  // both directions go to server.js instead: the files are downloaded before
  // the engine starts and uploaded whenever the mount changes.
  //
  // A push uploads every file whose size or content hash differs from the
  // server's copy and deletes what the game deleted. For each directory it
  // touches, the server's server.ssv goes first and the new one is uploaded
  // last, so a push cut short leaves an empty slot, never a mix of two saves.

  function userDataUrl(relPath) {
    return USERDATA_URL + relPath.split("/").map(encodeURIComponent).join("/");
  }

  // The console log changes all the time and is no use after a reload.
  function isSyncedPath(relPath) {
    return !/\.log$/i.test(relPath);
  }

  function slotFileOf(dir) {
    return dir ? dir + "/" + SLOT_FILE : SLOT_FILE;
  }

  function dirOf(relPath) {
    const slash = relPath.lastIndexOf("/");
    return slash < 0 ? "" : relPath.slice(0, slash);
  }

  // Size plus 32-bit FNV-1a: a rewrite in the same millisecond keeps the
  // mtime, so only the content tells it apart.
  function fingerprint(data) {
    let hash = 0x811c9dc5;
    for (let i = 0; i < data.length; i++) hash = Math.imul(hash ^ data[i], 0x01000193);
    return data.length + ":" + (hash >>> 0).toString(16);
  }

  // 2xx: done. 4xx other than 408/429: refused for good. Anything else (5xx,
  // 408, 429, no answer at all) may pass on a retry.
  function isRefusal(status) {
    return status >= 400 && status < 500 && status !== 408 && status !== 429;
  }

  function wait(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // GETs url, retrying what may pass. Resolves to { status, body }: body is
  // the ArrayBuffer of a 2xx answer, null for a refusal. Rejects once every
  // try failed.
  async function fetchWithRetry(url) {
    for (let attempt = 1; ; attempt++) {
      let failure;
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (response.ok) return { status: response.status, body: await response.arrayBuffer() };
        if (isRefusal(response.status)) return { status: response.status, body: null };
        failure = "HTTP " + response.status;
      } catch (error) {
        failure = "network error: " + error.message;
      }
      if (attempt >= RESTORE_TRIES) throw new Error(failure + ", " + attempt + " tries");
      await wait(RESTORE_RETRY_MS * 2 ** (attempt - 1));
    }
  }

  // Resolves to { files: { relPath: Uint8Array }, missed: [relPath] } for
  // what the server keeps, or to null when it has no save storage (the
  // engine then keeps its own IndexedDB sync, which works outside the
  // sandbox). `missed` lists the files that never downloaded.
  async function downloadUserData() {
    let listing;
    try {
      const answer = await fetchWithRetry(USERDATA_URL);
      if (!answer.body) throw new Error("HTTP " + answer.status);
      try {
        listing = JSON.parse(new TextDecoder().decode(answer.body)).files;
      } catch (error) {
        listing = null;
      }
      if (!Array.isArray(listing)) throw new Error("not a file listing");
    } catch (error) {
      console.warn("Saved games: no save storage at " + USERDATA_URL + " (" + error.message + "); saved games will not survive a reload.");
      return null;
    }
    const files = {};
    const missed = [];
    await Promise.all(listing.map(async function (entry) {
      const relPath = entry && entry.path;
      if (typeof relPath !== "string" || !isSyncedPath(relPath)) return;
      try {
        const answer = await fetchWithRetry(userDataUrl(relPath));
        if (answer.body) files[relPath] = new Uint8Array(answer.body);
        // A 404 means it was deleted since the listing: nothing left to keep.
        else if (answer.status !== 404) throw new Error("HTTP " + answer.status);
      } catch (error) {
        missed.push(relPath);
        console.warn("Saved games: could not download " + relPath + " (" + error.message + "); the server's copy is left alone.");
      }
    }));
    return { files: files, missed: missed };
  }

  // Every synced regular file under dir, as relPath -> contents.
  function readMountFiles(dir, prefix, out) {
    for (const name of FS.readdir(dir)) {
      if (name === "." || name === "..") continue;
      const path = dir + "/" + name;
      const stat = FS.stat(path);
      if (FS.isDir(stat.mode)) readMountFiles(path, prefix + name + "/", out);
      else if (FS.isFile(stat.mode) && isSyncedPath(prefix + name)) out[prefix + name] = FS.readFile(path);
    }
    return out;
  }

  function restoreUserData(root) {
    const store = userStore;
    userStore = null;
    if (!store) return;
    for (const relPath of store.missed) keptFiles.add(relPath);
    let restored = 0;
    for (const relPath in store.files) {
      const fullPath = root + "/" + relPath;
      try {
        FS.mkdirTree(fullPath.slice(0, fullPath.lastIndexOf("/")));
        FS.writeFile(fullPath, store.files[relPath]);
        serverFiles[relPath] = fingerprint(store.files[relPath]);
        restored++;
      } catch (error) {
        // Not in the mount, so a push must not read that as a deletion.
        keptFiles.add(relPath);
        console.warn("Saved games: could not restore " + relPath + ":", error);
      }
    }
    console.info("Saved games: restored " + restored + " file(s) from the server" +
      (keptFiles.size ? "; " + keptFiles.size + " could not be restored and stay on the server untouched." : "."));
  }

  // No Content-Type and no custom headers: a "simple" CORS request, which the
  // sandboxed page can send without a preflight. Resolves to the HTTP status
  // once the server took the request or refused it for good (e.g. 403 for
  // `save .x`, a dot-named slot); rejects when a retry may get it through.
  async function sendUserData(relPath, data) {
    const what = (data ? "upload " : "delete ") + relPath;
    const init = { method: "POST", body: data };
    // A keepalive request outlives the page, within the browser's 64 KiB cap.
    if (pageHiding && (!data || data.length < KEEPALIVE_MAX_BYTES)) init.keepalive = true;
    let response;
    try {
      response = await fetch(userDataUrl(relPath) + (data ? "" : "?delete"), init);
    } catch (error) {
      throw new Error("could not " + what + " (network error: " + error.message + ")");
    }
    if (response.ok || isRefusal(response.status)) return response.status;
    throw new Error("could not " + what + " (HTTP " + response.status + ")");
  }

  async function uploadToServer(relPath, data, print, done) {
    const status = await sendUserData(relPath, data);
    if (isRefusal(status)) {
      // Not retried until the game writes something else there.
      refusedFiles[relPath] = print;
      console.warn("Saved games: the server refused " + relPath + " (HTTP " + status + "); it will not survive a reload.");
      return;
    }
    serverFiles[relPath] = print;
    keptFiles.delete(relPath);
    delete refusedFiles[relPath];
    done.uploaded++;
  }

  async function deleteFromServer(relPath, done) {
    const status = await sendUserData(relPath, null);
    // A path the server refuses (e.g. a dot-named slot) cannot be stored there.
    if (isRefusal(status)) console.warn("Saved games: the server refused to delete " + relPath + " (HTTP " + status + ").");
    else done.deleted++;
    delete serverFiles[relPath];
    keptFiles.delete(relPath);
  }

  // Brings the server in line with the mount. serverFiles follows every
  // request that lands, so a push cut short resumes where it stopped.
  // Resolves to a summary line, or to null when nothing had to change.
  async function pushUserData(root) {
    // Read everything first: the game may write again before the push ends.
    const local = readMountFiles(root, "", {});
    const prints = {};
    const uploads = [];
    const dirs = new Set();
    for (const relPath in local) {
      const print = fingerprint(local[relPath]);
      prints[relPath] = print;
      if (serverFiles[relPath] === print || refusedFiles[relPath] === print) continue;
      uploads.push(relPath);
      dirs.add(dirOf(relPath));
    }
    // Only files the server was seen to hold: keptFiles are never deleted.
    const removals = Object.keys(serverFiles).filter(function (relPath) { return !(relPath in local); });
    for (const relPath of removals) dirs.add(dirOf(relPath));
    if (!dirs.size) return null;

    const done = { uploaded: 0, deleted: 0 };
    const slotFiles = new Set();
    for (const dir of dirs) {
      const slotFile = slotFileOf(dir);
      const replaced = slotFile in local && refusedFiles[slotFile] !== prints[slotFile];
      // A server.ssv that never downloaded is only taken off to be replaced.
      if (slotFile in serverFiles || (replaced && keptFiles.has(slotFile))) await deleteFromServer(slotFile, done);
      if (replaced) slotFiles.add(slotFile);
    }
    for (const relPath of uploads) {
      if (!slotFiles.has(relPath)) await uploadToServer(relPath, local[relPath], prints[relPath], done);
    }
    for (const relPath of removals) {
      if (relPath in serverFiles) await deleteFromServer(relPath, done);
    }
    for (const slotFile of slotFiles) await uploadToServer(slotFile, local[slotFile], prints[slotFile], done);

    return done.uploaded + " file(s) uploaded, " + done.deleted + " deleted in " +
      Array.from(dirs, function (dir) { return dir || "."; }).join(", ");
  }

  // One push at a time. A syncfs call is answered by the first push that
  // starts after it. A failed push is retried with backoff until it lands;
  // a new syncfs call (the next `save`) retries straight away.
  function requestPush(callback) {
    if (callback) pushWaiters.push(callback);
    if (pushRunning) return; // runPush starts the next one when it ends
    clearTimeout(pushRetryTimer);
    pushRetryTimer = 0;
    runPush();
  }

  async function runPush() {
    pushRunning = true;
    const waiters = pushWaiters;
    pushWaiters = [];
    let error = null;
    try {
      const summary = await pushUserData(userRoot);
      if (summary) console.info("Saved games: " + summary + (pushFailures ? " (after " + pushFailures + " failed tries)." : "."));
      pushFailures = 0;
    } catch (caught) {
      error = caught;
      pushFailures++;
    }
    pushRunning = false;
    const retryMs = Math.min(PUSH_RETRY_MS * 2 ** (pushFailures - 1), PUSH_RETRY_MAX_MS);
    if (error) {
      console.warn("Saved games: " + error.message + "; retrying in " + retryMs / 1000 + " s.");
      // Whoever asked meanwhile hears about it too; the retry takes their changes along.
      waiters.push(...pushWaiters);
      pushWaiters = [];
    }
    // A callback may ask for the next push at once (IDBFS's autoPersist does).
    for (const callback of waiters) {
      try {
        callback(error);
      } catch (callbackError) {
        console.error(callbackError);
      }
    }
    if (pushRunning || pushRetryTimer) return;
    if (pushWaiters.length) runPush();
    else if (error) pushRetryTimer = setTimeout(function () {
      pushRetryTimer = 0;
      requestPush(null);
    }, retryMs);
  }

  function useServerStorage(idbfs) {
    // The engine only syncs after `save` (and on quit), not after the autosave
    // on a level change, so let IDBFS sync after any write under the mount.
    const mountFs = idbfs.mount;
    idbfs.mount = function (mount) {
      mount.opts = Object.assign({}, mount.opts, { autoPersist: true });
      userRoot = mount.mountpoint;
      return mountFs(mount);
    };
    idbfs.syncfs = function (mount, populate, callback) {
      userRoot = mount.mountpoint;
      if (populate) {
        restoreUserData(mount.mountpoint);
        callback(null);
        return;
      }
      requestPush(callback);
    };
    // Leaving or reloading the page: get whatever is still unsent on its way.
    window.addEventListener("pagehide", function () {
      if (!userRoot) return;
      pageHiding = true;
      requestPush(null);
    });
    window.addEventListener("pageshow", function () {
      pageHiding = false;
    });
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
      if (userStore && FS.filesystems && FS.filesystems.IDBFS) useServerStorage(FS.filesystems.IDBFS);
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
    Module.setStatus("Loading saved games...");
    userStore = await downloadUserData();
    startEngine();
  }

  boot();
})();
