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
  const OPTIONAL_PAKS = ["pak1.pak", "pak2.pak", "pak9.pak", "pak10.pak"];
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
    // r_retexturing makes the engine look for textures/<map>/<name>.png before
    // the .wal it is about to draw, which is how the 4x wall art in pak9 reaches
    // the game (Yamagi draws it at the WAL's own size). The query string is
    // appended after these, so a URL can still turn any of it off.
    //
    // `fov 90` is not a preference: on this build the engine draws no view
    // weapon at a field of view above 90 (measured: 90 draws the blaster every
    // frame, 91 and up draws none, whatever cl_gun says), and a restored
    // config.cfg from an older session can carry a wider one. Without this the
    // app boots with cl_gun 1 and no gun in hand. A URL can still override it.
    // The crosshair is the engine's own 2D cross. At its default
    // `crosshair_scale` of 1 it is a 7x7 pixel plus on this build (measured at
    // 1280x720: 7x7 at scale 1, 14x14 at scale 2, 21x21 at scale 3, and no
    // larger above 3), so at the box's 2560x1440 display it disappears against
    // the scene. Scale 3 is the engine's own maximum and makes it a visible
    // 21x21 cross at both sizes. `crosshair 1` is set explicitly because a
    // restored userdata/config.cfg can carry `crosshair 0`, which would leave
    // no crosshair at all whatever the scale. A URL can still override either
    // value, as it can every default here.
    // The crosshair's colour and opacity are presentation, not engine state:
    // rtx-renderer.js reads these two values off this start-up line and applies
    // them in the 2D shader that draws the engine's 8x8 crosshair picture. The
    // defaults are a little under half opacity (0.45: the cross reads over both
    // the dark base and the lit floor without covering the target, and it
    // measured ~0.45 against the palette tint) and the game palette's rusted
    // amber blended with its bone (#ddb589; palette entries 52 and 251 in
    // pics/colormap.pcx). A URL can still override either, as it can every
    // default here. The colour and opacity are unchanged by the crosshair's
    // weapon/fire/crouch spread: only its size follows the aim.
    let args = ["+set", "vid_renderer", "gles3", "+set", "r_retexturing", "1", "+set", "gl3_usefbo", "1",
      "+set", "cl_gun", "1", "+set", "fov", "90", "+set", "crosshair", "1", "+set", "crosshair_scale", "3",
      "+set", "q2_crosshair_alpha", "0.45", "+set", "q2_crosshair_tint", "ddb589"];
    const extra = queryArguments();
    args = args.concat(extra);
    // Boot straight into the game, as the app is meant to: with no map on the
    // start-up line the engine sits in its attract-demo loop (and the engine's
    // own main menu is one key away). The query can still choose a map.
    const asksForMap = extra.some(function (arg) { return arg === "+map" || arg === "map"; });
    if (!asksForMap) args = args.concat(["+map", "demo1"]);
    return args;
  }

  // The query string as engine arguments, decoded one per "&".
  function queryArguments() {
    if (window.location.search.length <= 1) return [];
    return window.location.search.substr(1).split("&").filter(Boolean).map(function (arg) {
      try {
        return decodeURIComponent(arg);
      } catch (error) {
        return arg;
      }
    });
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

  // The exact start-up line handed to the engine. The acceptance runner reads
  // this from the page to prove the app's own defaults (crosshair 1, scale 3,
  // the palette tint and opacity) without a console visit; it is the same array
  // the engine receives.
  const engineArguments = buildArguments();
  try { window.quake2StartupArguments = engineArguments.slice(); } catch (error) { /* optional */ }

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
      // The HUD reader needs the engine's own digit pictures; hand it the
      // archives before MemFS copies are the only ones left.
      if (window.quake2Hud && window.quake2Hud.usePaks) window.quake2Hud.usePaks(pakDict);
      // The weapon-aware crosshair names the view model by the skin size the
      // engine binds; the skin headers come from these same archives.
      if (window.quake2RTX && window.quake2RTX.usePaks) window.quake2RTX.usePaks(pakDict);
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

    arguments: engineArguments,

    // The engine resolves index.wasm and the ref_*/game_*.wasm libraries
    // against its own script directory, but the file packager asks for
    // index.data with an empty prefix, which would resolve against this page
    // (…/apps/quake2/index.data, a 404). Point that one at engine/ as well.
    locateFile: function (path, prefix) {
      return (prefix || ENGINE_DIR) + path;
    },
  };

  // ---- Interface ---------------------------------------------------------
  // The engine's menu is replaced by this panel, entry for entry: its main
  // menu is GAME, MULTIPLAYER, OPTIONS, VIDEO, QUIT; GAME opens easy, medium,
  // hard+, load game, save game, credits; OPTIONS and VIDEO are the engine's
  // own settings menus, row for row. The engine still runs its menu state --
  // that is what pauses a single-player game -- but rtx-renderer.js drops its
  // pixels while the keyboard is away from the game, so the old menu can never
  // be seen on Escape, on a pause or at boot.
  //
  // Nothing here types into the engine's console: synthetic DOM keys reach the
  // engine's key bindings but not its console text (measured), so a command is
  // either a start-up argument on a reload or one of the engine's own bound
  // keys. That is also why a New Game reloads the page with `+map` on the
  // start-up line instead of typing `map` at a console nobody can read.

  const menuLayer = document.getElementById("menu-layer");
  const menuPanel = document.getElementById("menu");
  const optionsChip = document.getElementById("options-chip");
  const lightingChip = document.getElementById("lighting-chip");
  const lightingPanel = document.getElementById("lighting-panel");
  const bannerElement = document.getElementById("banner");
  const bannerTextElement = document.getElementById("banner-text");
  const promptElement = document.getElementById("prompt");
  const menuViews = Array.from(document.querySelectorAll(".menu-view"));

  const ui = {
    open: false,
    view: "main",
    closing: false, // Resume/map close: ignore key_dest 3 for a moment
    bannerTimer: 0,
    prompt: false,
    consoleAt: 0, // when the engine's console last owned the keyboard
    quitting: false, // QUIT was chosen: the panel must not come back
  };

  const ESCAPE_KEY = { key: "Escape", code: "Escape", vk: 27, ch: 27 };
  // The engine's own quick save/load keys: F6 is bound to "Quick Saving…;
  // save quick" and F9 to the load in the shipped config. A keydown reaches the
  // engine's bindings (a synthetic Escape opens its menu), unlike console text.
  const QUICK_SAVE_KEY = { key: "F6", code: "F6", vk: 117 };
  const QUICK_LOAD_KEY = { key: "F9", code: "F9", vk: 120 };

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function engineSnapshot() {
    try {
      return window.quake2Engine && window.quake2Engine.read ? window.quake2Engine.read() : null;
    } catch (error) {
      return null;
    }
  }

  function engineKeyDest() {
    const state = engineSnapshot();
    return state && typeof state.keyDest === "number" ? state.keyDest : null;
  }

  // A synthetic keyboard event the engine's SDL layer reads exactly like a real
  // one: keyCode/which/charCode are defined because KeyboardEvent's constructor
  // leaves them at zero.
  function dispatchKey(type, descriptor) {
    const event = new KeyboardEvent(type, {
      key: descriptor.key,
      code: descriptor.code,
      bubbles: true,
      cancelable: true,
      shiftKey: !!descriptor.shift,
    });
    Object.defineProperty(event, "keyCode", { get: function () { return descriptor.vk; } });
    Object.defineProperty(event, "which", { get: function () { return descriptor.vk; } });
    Object.defineProperty(event, "charCode", { get: function () { return type === "keypress" ? descriptor.ch || 0 : 0; } });
    // The panel's own key handler owns the keyboard while it is up, and an
    // event dispatched on window reaches it first. These are the app's own
    // keys for the engine (Resume's Escape, F6/F9), so they are marked and the
    // panel lets them through -- otherwise every tap the app makes while the
    // panel is open was swallowed and never reached the engine.
    Object.defineProperty(event, "__q2synthetic", { value: true });
    window.dispatchEvent(event);
  }

  function tapKey(descriptor) {
    dispatchKey("keydown", descriptor);
    dispatchKey("keypress", descriptor);
    dispatchKey("keyup", descriptor);
  }

  // ---- Reloading with engine arguments ------------------------------------
  // Every action that needs an engine command the app cannot type is done by
  // reloading with it on the engine's start-up line: the same arguments the
  // page was opened with, then the new ones (the last +set/+map wins). The
  // boot is local and cached, so this is a second or two.

  function reloadWith(commands) {
    const parts = window.location.search.replace(/^\?/, "").split("&").filter(Boolean);
    const next = parts.concat(commands);
    window.location.search = "?" + next.join("&");
  }

  // ---- Menu presentation -------------------------------------------------

  function visibleView() {
    return menuViews.find(function (view) { return !view.hidden; }) || menuViews[0];
  }

  function visibleButtons() {
    return Array.from(visibleView().querySelectorAll("button")).filter(function (button) {
      return !button.disabled && (button.offsetParent !== null || button.getClientRects().length > 0);
    });
  }

  function setView(view) {
    ui.view = view;
    for (const section of menuViews) section.hidden = section.dataset.view !== view;
    // The main view opens with Resume focused, not GAME. The panel also comes
    // up when the engine's own menu opens by itself (a console command, a lost
    // pointer lock), and a stray Enter must not start a new game from there;
    // Enter on Resume puts the game back exactly where it was.
    const resume = view === "main" ? menuPanel.querySelector('[data-action="resume"]') : null;
    const first = resume || visibleButtons()[0];
    if (first) first.focus({ preventScroll: true });
  }

  function gameModeActive() {
    return Boolean(window.quake2GameMode && window.quake2GameMode.isActive && window.quake2GameMode.isActive());
  }

  function showMenu(view) {
    // Game mode is the game surface alone: the panel must not appear behind it
    // (an Esc that reaches the engine, a lost pointer lock) and then be
    // uncovered when the mode ends. After QUIT the panel stays down too: the
    // engine's menu is still open, and the page says the game has quit.
    if (gameModeActive() || ui.quitting) return;
    if (ui.open) {
      if (view) setView(view);
      return;
    }
    ui.open = true;
    menuLayer.hidden = false;
    document.body.classList.add("menu-open");
    optionsChip.hidden = true;
    lightingChip.hidden = true;
    lightingPanel.hidden = true;
    lightingChip.setAttribute("aria-expanded", "false");
    promptElement.hidden = true;
    setView(view || "main");
  }

  function hideMenu() {
    if (!ui.open) return;
    ui.open = false;
    menuLayer.hidden = true;
    document.body.classList.remove("menu-open");
    if (document.activeElement && menuPanel.contains(document.activeElement)) document.activeElement.blur();
  }

  // DOM writes cost layout even when the value does not change; the interface
  // poll runs every 120 ms, so it writes only when something moved.
  function setHidden(element, hidden) {
    if (element && element.hidden !== Boolean(hidden)) element.hidden = Boolean(hidden);
  }

  function showBanner(text, milliseconds) {
    clearTimeout(ui.bannerTimer);
    bannerTextElement.textContent = text;
    bannerElement.hidden = !text;
    if (text && milliseconds) {
      ui.bannerTimer = setTimeout(function () { bannerElement.hidden = true; }, milliseconds);
    }
  }

  function resumeGame() {
    hideMenu();
    ui.closing = true;
    tapKey(ESCAPE_KEY); // the engine's own menu closes and the game resumes
    clearTimeout(resumeGame.closingTimer);
    resumeGame.closingTimer = setTimeout(function () { ui.closing = false; }, 900);
    canvasElement.focus();
    if (Module._attemptPointerLock) Module._attemptPointerLock();
  }

  function pauseForKey(key) {
    // The engine only reads its bindings while the game has the keyboard, so a
    // paused menu is closed first and reopened after the key.
    const dest = engineKeyDest();
    if (dest === 3) tapKey(ESCAPE_KEY);
    setTimeout(function () {
      tapKey(key);
      // Put the pause back: an unlocked pointer or a saved game would otherwise
      // leave the game running behind the panel.
      setTimeout(function () {
        if (!ui.open && engineKeyDest() === 0) tapKey(ESCAPE_KEY);
        ui.closing = false;
      }, 300);
    }, dest === 3 ? 260 : 0);
  }

  // ---- Settings -----------------------------------------------------------
  // Each row cycles through the values the engine accepts; `apply` reloads with
  // the changed cvars on the start-up line, which is the one command channel
  // this page has. The engine reads its own config.cfg first, so a value set
  // here is a start-up override, not a rewrite of the player's config.

  function settingButton(button) {
    return button.classList && button.classList.contains("setting");
  }

  // A row can carry one cvar (`data-cvar`) or several it sets together
  // (`data-cvars`), as the engine's ui scale row does with the menu, console
  // and HUD scales. The row's displayed value is the first cvar's value.
  function rowCvars(button) {
    if (button.dataset.cvars) return button.dataset.cvars.split(",").map(function (one) { return one.trim(); }).filter(Boolean);
    return button.dataset.cvar ? [button.dataset.cvar] : [];
  }

  function defaultIndex(button) {
    const values = button.dataset.values ? button.dataset.values.split(",") : [];
    const wanted = button.dataset.default;
    if (wanted === undefined) return 0;
    let index = values.indexOf(wanted);
    if (index < 0) index = values.findIndex(function (one) { return Number(one) === Number(wanted); });
    return index >= 0 ? index : 0;
  }

  function readValue(button) {
    const values = button.dataset.values ? button.dataset.values.split(",") : [];
    const labels = button.dataset.labels ? button.dataset.labels.split(",") : null;
    const suffix = button.dataset.suffix || "";
    if (!values.length) return null;
    let index = Number(button.dataset.index || 0);
    if (!Number.isFinite(index) || index < 0 || index >= values.length) index = 0;
    const value = values[index];
    const label = labels ? (labels[index] || value) : value + suffix;
    // `data-default` is what Reset returns to; `data-baseline` is what the
    // page was actually started with. A value handed to the engine on the
    // start-up line (r_mode from the URL, a cvar chosen in an earlier visit)
    // is the running value, not a pending change.
    const baseline = button.dataset.baseline !== undefined ? button.dataset.baseline : button.dataset.default;
    return { value: value, label: label, index: index, count: values.length, changed: value !== baseline };
  }

  function showSetting(button) {
    const read = readValue(button);
    const valueElement = button.querySelector(".value");
    if (read && valueElement) valueElement.textContent = read.label;
    if (read) button.classList.toggle("changed", read.changed);
  }

  function cycleSetting(button) {
    const values = button.dataset.values ? button.dataset.values.split(",") : [];
    if (!values.length) return;
    const index = (Number(button.dataset.index || 0) + 1) % values.length;
    button.dataset.index = String(index);
    showSetting(button);
    refreshApply();
  }

  // The values this page was started with, from its own query (`+set cvar
  // value` pairs). Applying a setting reloads with the pair on the start-up
  // line, and the menu then opens showing the value that is actually running
  // rather than the build's default again.
  function appliedSettings() {
    const args = queryArguments();
    const values = {};
    for (let i = 0; i + 2 < args.length; i++) {
      if ((args[i] === "+set" || args[i] === "set") && args[i + 1] !== undefined) values[args[i + 1].toLowerCase()] = args[i + 2];
    }
    return values;
  }

  function initializeSettings() {
    for (const button of menuPanel.querySelectorAll(".setting[data-cvar], .setting[data-cvars]")) {
      button.dataset.index = String(defaultIndex(button));
      if (button.dataset.default !== undefined) button.dataset.baseline = button.dataset.default;
      showSetting(button);
    }
  }

  function syncSettingsFromUrl() {
    const applied = appliedSettings();
    for (const button of menuPanel.querySelectorAll(".setting[data-cvar], .setting[data-cvars]")) {
      const cvar = rowCvars(button)[0];
      if (!cvar) continue;
      const value = applied[cvar.toLowerCase()];
      if (value === undefined) continue;
      const values = (button.dataset.values || "").split(",");
      const index = values.findIndex(function (one) { return one === value || Number(one) === Number(value); });
      if (index >= 0) {
        button.dataset.index = String(index);
        button.dataset.baseline = values[index];
      }
      showSetting(button);
    }
    refreshApply();
  }

  function changedSettings() {
    const changed = [];
    for (const button of menuPanel.querySelectorAll(".setting[data-cvar], .setting[data-cvars]")) {
      const read = readValue(button);
      if (!read || !read.changed) continue;
      for (const cvar of rowCvars(button)) changed.push([cvar, read.value]);
    }
    return changed;
  }

  function refreshApply() {
    const changed = changedSettings();
    const text = changed.length ? changed.length + " change" + (changed.length === 1 ? "" : "s") : "no changes";
    for (const hint of menuPanel.querySelectorAll("#apply-hint, #apply-hint-options")) hint.textContent = text;
  }

  function applySettings() {
    const changed = changedSettings();
    if (!changed.length) { showBanner("Nothing to apply", 2500); return; }
    const commands = [];
    for (const [cvar, value] of changed) {
      // The engine's "fullscreen window" mode also switches r_mode to auto
      // (video mode -2), exactly as its own video menu does.
      commands.push("+set", cvar, value);
      if (cvar === "vid_fullscreen" && value === "2") commands.push("+set", "r_mode", "-2");
    }
    showBanner("Restarting the level with " + changed.length + " change" + (changed.length === 1 ? "" : "s") + "…", 6000);
    reloadWith(commands);
  }

  function resetSettings(view) {
    const commands = [];
    for (const button of menuPanel.querySelectorAll('.menu-view[data-view="' + view + '"] .setting[data-cvar], .menu-view[data-view="' + view + '"] .setting[data-cvars]')) {
      if (button.dataset.default === undefined) continue;
      button.dataset.index = String(defaultIndex(button));
      showSetting(button);
      for (const cvar of rowCvars(button)) commands.push("+set", cvar, button.dataset.default);
    }
    refreshApply();
    showBanner("Restoring the defaults…", 5000);
    reloadWith(commands);
  }

  // ---- Actions ------------------------------------------------------------

  function startNewGame(skill) {
    showBanner("Starting a new game…", 6000);
    reloadWith(["+set", "skill", String(skill), "+map", "demo1"]);
  }

  function quickSave() {
    showBanner("Quick saving…", 2500);
    pauseForKey(QUICK_SAVE_KEY);
  }

  function quickLoad() {
    showBanner("Quick loading…", 2500);
    pauseForKey(QUICK_LOAD_KEY);
  }

  function quitGame() {
    // Leave the engine paused (its menu is what pauses a single-player game)
    // and stop showing it. The page cannot run the engine's `quit` -- that
    // needs typed console text -- but a paused, dark page is what leaving
    // looks like, and reloading brings the game back.
    ui.quitting = true;
    if (engineKeyDest() === 0) tapKey(ESCAPE_KEY);
    hideMenu();
    canvasElement.style.display = "none";
    showMessage("Quake 2 has quit.", "Reload the page to play again.");
  }

  function doAction(action, button) {
    if (action === "resume") resumeGame();
    else if (action === "back") setView("main");
    else if (action === "game") setView("game");
    else if (action === "multiplayer") setView("multiplayer");
    else if (action === "options") setView("options");
    else if (action === "video") setView("video");
    else if (action === "credits") setView("credits");
    else if (action === "newgame" && button) startNewGame(button.dataset.skill || "1");
    else if (action === "loadgame") quickLoad();
    else if (action === "savegame") quickSave();
    else if (action === "apply") applySettings();
    else if (action === "reset-video") resetSettings("video");
    else if (action === "reset-options") resetSettings("options");
    else if (action === "quit") quitGame();
    else if (action === "game-mode") {
      // From the menu the game is paused behind the panel: resume it, then
      // hand the screen to the game. Both run inside the click's own gesture,
      // which is what the full-screen request needs.
      resumeGame();
      if (window.quake2GameMode) void window.quake2GameMode.enter("menu");
    }
    else if (action === "note") showBanner(button && button.dataset.note ? button.dataset.note : "That is not part of this box build.", 4200);
  }

  initializeSettings();
  syncSettingsFromUrl();

  // Roving focus: the item under the pointer becomes the focused item, so mouse
  // hover and keyboard selection are always the same single highlight.
  menuPanel.addEventListener("pointerover", function (event) {
    const button = event.target.closest("button");
    if (button && menuPanel.contains(button) && button !== document.activeElement) {
      button.focus({ preventScroll: true });
    }
  });

  menuPanel.addEventListener("click", function (event) {
    const button = event.target.closest("button");
    if (!button || !menuPanel.contains(button)) return;
    if (settingButton(button) && button.dataset.cvar) { cycleSetting(button); return; }
    if (button.dataset.action) doAction(button.dataset.action, button);
  });

  // While the panel is up it owns the keyboard: the engine's own menu must not
  // scroll underneath it, and pointer lock must not be requested behind it.
  window.addEventListener("keydown", function (event) {
    if (!ui.open) return;
    // The app's own engine taps (Resume, F6, F9, the Options chip's Escape):
    // the panel must not eat them. It still owns every real key.
    if (event.__q2synthetic) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const buttons = visibleButtons();
    const index = buttons.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "Tab" && !event.shiftKey) {
      const next = buttons[(index + 1) % (buttons.length || 1)];
      if (next) next.focus();
    } else if (event.key === "ArrowUp" || event.key === "Tab" && event.shiftKey) {
      const next = buttons[(index - 1 + buttons.length) % (buttons.length || 1)];
      if (next) next.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      const button = document.activeElement && document.activeElement.matches("button")
        ? document.activeElement : buttons[0];
      if (button) button.click();
    } else if (event.key === "Escape") {
      if (ui.view !== "main") setView("main");
      else resumeGame();
    }
  }, true);

  window.addEventListener("keyup", function (event) {
    if (!ui.open || event.__q2synthetic) return;
    // A key held when the panel opened must still reach the engine as a
    // release, or the player keeps walking (or firing) after the panel closes;
    // only the page's own default action is stopped.
    event.preventDefault();
  }, true);

  lightingChip.addEventListener("click", function () {
    const open = lightingPanel.hidden;
    lightingPanel.hidden = !open;
    lightingChip.setAttribute("aria-expanded", String(open));
  });

  optionsChip.addEventListener("click", function () {
    // Opening from the chip asks the engine for its menu, which is the pause.
    showMenu("options");
    tapKey(ESCAPE_KEY);
    ui.closing = true;
    clearTimeout(optionsChip.closingTimer);
    optionsChip.closingTimer = setTimeout(function () { ui.closing = false; }, 900);
  });

  // The engine's own status bar is the only HUD: nothing is drawn over the
  // canvas's bottom band. rtx-renderer.js still reads its digits back out of
  // the frame for the control harness (`window.quake2Hud`); that reader is
  // independent of the page's DOM and stays.

  // `cls.key_dest` is the engine's own word for who owns the keyboard: 0 game,
  // 1 console, 3 menu. Polling it is how the panel follows the real game state
  // rather than guessing from focused elements.
  function syncInterface() {
    // Game mode owns the screen: no page layer may be shown or toggled while it
    // is up, and the engine's own menu is dropped by the renderer. The mode's
    // own fullscreenchange handler is what brings the interface back.
    if (gameModeActive()) {
      if (ui.open) hideMenu();
      return;
    }
    // After QUIT the panel must not be reopened: the engine is still at its
    // menu, and showing the panel under the "Quake 2 has quit." plate would
    // offer Resume and put a running game back behind an invisible canvas.
    if (ui.quitting) return;
    const state = engineSnapshot();
    const dest = state && typeof state.keyDest === "number" ? state.keyDest : null;
    const visible = canvasElement.style.display === "block";
    const locked = document.pointerLockElement === canvasElement;
    const playing = dest === 0 && !ui.open && visible;
    const chipsHidden = ui.open || locked || !engineRunning || !visible || dest !== 0;
    setHidden(optionsChip, chipsHidden);
    setHidden(lightingChip, chipsHidden);
    if (chipsHidden && !lightingPanel.hidden) {
      lightingPanel.hidden = true;
      lightingChip.setAttribute("aria-expanded", "false");
    }
    const showPrompt = playing && visible && !locked && engineRunning;
    if (showPrompt !== ui.prompt) {
      ui.prompt = showPrompt;
      setHidden(promptElement, !showPrompt);
    }
    if (dest === 1) ui.consoleAt = performance.now();
    if (dest === 3 && !ui.open && !ui.closing) {
      // A menu that opens within a moment of the console is the console's own
      // trailing Escape (the way a harness closes it), not the player asking
      // for the menu: close it again instead of putting the panel up, so a
      // console session cannot leave the menu owning the keyboard behind the
      // panel.
      if (performance.now() - ui.consoleAt < 1500) tapKey(ESCAPE_KEY);
      else showMenu("main");
    } else if (dest !== 3 && ui.open && !ui.closing) hideMenu();
  }
  // One poll for the whole page. Game mode has no interface to keep in sync,
  // so the poll is stopped while it is up (a page that hides every layer still
  // paid for an engine reading and a set of style decisions eight times a
  // second) and started again when the mode ends.
  let interfaceTimer = 0;
  function startInterfacePoll() {
    if (!interfaceTimer) interfaceTimer = setInterval(syncInterface, 120);
  }
  function stopInterfacePoll() {
    if (interfaceTimer) {
      clearInterval(interfaceTimer);
      interfaceTimer = 0;
    }
  }
  window.addEventListener("quake2gamemode", function (event) {
    if (event.detail && event.detail.active) stopInterfacePoll();
    else {
      syncInterface();
      startInterfacePoll();
    }
  });
  startInterfacePoll();

  // Browsers take Escape for themselves while the pointer is locked: it leaves
  // the lock and the page never sees the key, so the engine's own menu would
  // stay shut until a second press. When the lock is lost with the game still
  // running, ask the engine for its menu (that is the pause) and show the panel.
  document.addEventListener("pointerlockchange", function () {
    if (document.pointerLockElement === canvasElement) return;
    setTimeout(function () {
      if (document.pointerLockElement === canvasElement) return;
      if (gameModeActive()) return;
      if (!engineRunning || ui.open || ui.closing) return;
      const dest = engineKeyDest();
      if (dest === 3) { showMenu("main"); return; }
      if (dest !== 0) return;
      tapKey(ESCAPE_KEY);
      setTimeout(function () {
        if (!ui.open && engineKeyDest() === 3) showMenu("main");
      }, 260);
    }, 220);
  });

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
  // coming back to the tab -- but never steal it from the interface layer.
  document.addEventListener("mousedown", function (event) {
    if (event.target.closest && event.target.closest("#ui")) return;
    if (event.target !== canvasElement && canvasElement.style.display === "block") {
      event.preventDefault();
      canvasElement.focus();
    }
  });
  window.addEventListener("focus", function () {
    if (canvasElement.style.display === "block" && !ui.open) canvasElement.focus();
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
