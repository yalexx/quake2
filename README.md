# Quake 2 (ClawBox app)

Quake 2 running in the browser, straight into the game — no launcher page, no
options, no extra UI.

Engine: [Qwasm2](https://github.com/GMH-Code/Qwasm2) by Gregory Maynard-Hoare,
an Emscripten/WebAssembly build of Yamagi Quake II (GPL-2.0). The prebuilt
engine files in `engine/` were copied from the project's public site
(https://qwasm2.m-h.org.uk/). Game data in `baseq2/` is the official Quake 2
3.14 demo `pak0.pak` (extracted from `q2-314-demo-x86.exe`, SHA1
`b86e8878…bcab`; licence in `engine/license.txt`). Drop the retail
`pak0.pak` (+ `pak1.pak`, `pak2.pak`) into `baseq2/` to play the full game.

## Layout

| Path | What |
|---|---|
| `index.html`, `style.css`, `app.js` | The page: a full-viewport canvas that boots the engine immediately |
| `engine/` | `index.js` (Emscripten loader), `index.wasm`, `index.data`, `game_baseq2.wasm`, `ref_gles3.wasm`, `ref_gl1.wasm`, `ref_soft.wasm`, `license.txt` |
| `baseq2/` | PAK files served as static files and copied into the engine's MemFS at boot |
| `server.js` | Zero-dependency Node static server, 127.0.0.1:4231 (`PORT`), serves `/` and `/apps/quake2/`, and keeps saved games under `/userdata/` (see [Saved games](#saved-games)) |
| `userdata/` | Created at runtime (git-ignored): the game's saves and `config.cfg`, as the engine laid them out (`baseq2/save/save1/…`). Set `QUAKE2_DATA_DIR` to keep them elsewhere |
| `scripts/` | `test-userdata.js` (the `/userdata` save store) and `e2e-saves.js` (the real game in headless Chromium), see [Tests](#tests) |
| `clawbox.json` | ClawBox app manifest |
| `reference/` | The original Qwasm2 `index.html` + `getgame.js`, for how the `Module` object is wired |

## How the engine is wired (from `reference/`)

- `engine/index.js` resolves every sibling file (`index.wasm`, `index.data`,
  `ref_*.wasm`, `game_baseq2.wasm`) relative to its own script URL, so it must
  be loaded from `engine/index.js` (relative), not moved.
- A global `var Module` must exist **before** `engine/index.js` is appended.
  Engine callbacks the page must provide: `canvas`, `print`, `printErr`,
  `setStatus`, `onRuntimeInitialized`, `monitorRunDependencies`,
  `hideConsole`, `showConsole`, `exportFile`, `setGamma`, `captureMouse`,
  `winResized`, `softExit`, `arguments`.
- PAKs: in `onRuntimeInitialized`, write each PAK into MemFS at
  `/baseq2/<name>` via `FS.open/FS.write/FS.close` (the `/baseq2` directory is
  created by `index.data`). Fetch `baseq2/pak0.pak` (then try `pak1.pak`,
  `pak2.pak`; ignore 404s) **before** starting the engine so the data is
  ready when the runtime initialises.
- `hideConsole` is called by the engine when the video subsystem is up: show
  the canvas and focus it. `showConsole` is called on shutdown/error.
- Pointer lock: the engine calls `captureMouse`; browsers only allow
  `requestPointerLock()` inside a user gesture, so fall back to locking on the
  next keydown/click (see the reference `_lockPointerOnKey`).
- Renderer can be forced with `Module.arguments = ['+set','vid_renderer','gles3']`.
- Saves go to the `/qwasm2` IDBFS mount; see [Saved games](#saved-games).

## Run

```
node server.js          # http://127.0.0.1:4231/, saves in ./userdata
PORT=4299 QUAKE2_DATA_DIR=/srv/quake2-saves node server.js
```

The box serves it at `/apps/quake2/`. The startup line names the port and the
save folder: `Quake 2 static server on http://127.0.0.1:4231/ (also
/apps/quake2/), saves in /…/userdata`.

## Saved games

### What the engine writes

Qwasm2 mounts an Emscripten IDBFS file system at `/qwasm2` and writes
everything the game keeps under `/qwasm2/baseq2/`:

- `save/<slot>/`: one folder per slot, holding `server.ssv` (the slot's
  header: Yamagi lists and loads a slot only while it exists), `game.ssv`,
  and a `<map>.sav` + `<map>.sv2` pair for each level of the unit you have
  been through. The slots are:
  - `save1`, `save2`, …: `save <slot>` in the console, or the Save Game menu.
  - `quick`: the quicksave, F6 (bound to `save quick`).
  - `current`: the running game. The engine rewrites it on every level
    change (the autosave) and copies it to `save0`, which the Load Game menu
    shows as `ENTERING <level>`.
- `config.cfg`: key bindings and settings, written when the game quits.
- `*.log` (the console log, if enabled) is never synced.

The engine restores the mount with `FS.syncfs(true)` at startup. It calls
`FS.syncfs(false)` after `save` and on quit, logging `Saving data...` and then
`Data saved.` or `Failed to save data: …` to the browser console. It never
syncs after the level-change autosave.

### Why server.js keeps them

The box frames the app with `Content-Security-Policy: sandbox` without
`allow-same-origin`, so the page has an opaque origin (`null`). There,
`indexedDB.open` and `localStorage` throw `SecurityError`, and every `fetch`
is a CORS request. Plain IDBFS would lose everything on a reload, so `app.js`
backs the mount with `server.js` instead:

1. **Restore before the engine starts.** Once the PAKs are in (status
   `Loading saved games...`), `app.js` fetches the listing `userdata/` and
   then every listed file except `*.log`, in parallel. Each GET is retried on
   a network error, 408, 429 or 5xx, up to 4 tries 0.5 s, 1 s and 2 s apart.
   When the engine calls `FS.syncfs(true)`, the files are written into
   `/qwasm2` and the console shows
   `Saved games: restored N file(s) from the server.`
   - If the listing cannot be fetched or is not a listing, the console shows
     `Saved games: no save storage at userdata/ (…); saved games will not
     survive a reload.` and the engine's own IndexedDB sync is left in place
     (it works outside the box's sandbox).
   - If a single file fails to download, the console shows
     `Saved games: could not download <path> (…); the server's copy is left
     alone.` That file is not in the game, and no later push deletes it from
     the server. The one exception is a slot's `server.ssv`, which a new save
     to that slot replaces.
2. **Push after every change.** `app.js` mounts IDBFS with `autoPersist`, so
   closing a written file, or deleting or renaming one, under `/qwasm2`
   queues a sync. It also swaps IDBFS's `syncfs` for a push to `server.js`.
   That covers:
   - `save <slot>` (console or Save Game menu): the engine's own sync. Its
     `Data saved.` only appears once the push has landed.
   - The quicksave (`save/quick`), the same way.
   - The level-change autosave (`save/current`, and its copy in `save0`),
     which the engine never syncs itself.
   - `config.cfg` when the game quits (and then the engine's quit sync).
   - Page close or reload (`pagehide`): whatever is still unsent goes out.
     Deletes and bodies under 60 KiB use `keepalive` requests, which outlive
     the page (browsers cap keepalive bodies at 64 KiB). Larger bodies go as
     normal requests, which the browser may cancel as the page closes.

How a push works:

- **Snapshot.** It reads every synced file in the mount before sending
  anything. If the game writes again meanwhile, the next push takes that.
- **Change detection.** A file's fingerprint is its size plus a 32-bit
  FNV-1a hash of its bytes (an mtime would miss a rewrite in the same
  millisecond). A file is uploaded only when its fingerprint differs from the
  copy the server is known to hold, from the restore or the last upload that
  landed. A file the server holds that is gone from the mount is deleted
  there (`?delete`), e.g. a level the game dropped from a re-saved slot.
- **Order.** Requests go one at a time. For each slot folder it touches, the
  push first deletes the server's `server.ssv`, then uploads the changed
  files, then deletes the removed ones, and uploads the new `server.ssv`
  last. A push cut short (tab closed, server down) therefore leaves at worst
  an empty slot that the Load Game menu does not list, never a slot mixing
  two saves.
- **One at a time.** A sync asked for while a push runs is answered by the
  next push, which takes every change since.
- **Retries.** A network error, 408, 429 or 5xx fails the push. The engine's
  sync gets the error (`Failed to save data: Error: could not upload
  baseq2/save/save1/game.ssv (HTTP 503)`), and `app.js` logs
  `Saved games: could not upload … (HTTP 503); retrying in 1 s.` It retries
  after 1 s, 2 s, 4 s, … and then every 30 s until the push lands, or at
  once when the game next saves or writes. Requests that already landed are
  not repeated. The success line then ends in `(after N failed tries).`
- **Refusals.** Any other 4xx is final, e.g. 403 for a dot-named slot
  (`save .x`) or 413 for a file over 16 MiB. The console shows
  `Saved games: the server refused <path> (HTTP 403); it will not survive a
  reload.` That file is not tried again until the game writes different
  bytes to it.
- **Log lines.** A push that changed something logs
  `Saved games: <n> file(s) uploaded, <m> deleted in <folders>.`, e.g. the
  folders `baseq2/save/current, baseq2/save/save1`. Successes are `console.info`
  and problems `console.warn`, so the console's warning level shows every
  save problem.

### The `/userdata` API

`server.js` answers the same routes under `/userdata/…` and
`/apps/quake2/userdata/…`. `<path>` is relative to the save folder and
percent-decoded, e.g. `baseq2/save/save1/server.ssv`.

| Request | Answer |
|---|---|
| `GET /userdata/` (also `HEAD`, or without the slash) | `200`, JSON `{"files":[{"path":"baseq2/config.cfg","size":1234},…]}`: every file in the store, recursively, except dot-named ones (uploads in progress) |
| `GET /userdata/<path>` (also `HEAD`) | `200`, the file as `application/octet-stream`; `404` if there is no such file (a folder counts as none) |
| `POST /userdata/<path>` | The body replaces the file, and missing folders are created: `204` |
| `POST /userdata/<path>?delete` | Removes the file and each folder that leaves empty (never the save folder itself): `204`, also when there was nothing to remove |
| `OPTIONS` on any of them | `204`, with the CORS headers |
| Any other method, or `POST` to the listing | `405`, with an `Allow` header |

Errors:

- `400`: a malformed percent escape.
- `403`: the path breaks the rules below.
- `409`: the path is a folder, or lies under something that is a file.
- `413`: the body is over 16 MiB, whether declared in `Content-Length` or
  counted while it streams in. Exactly 16 MiB is accepted.
- `500`: anything else.

Every failed POST and every 5xx is logged to `server.js`'s stderr (for the
box's `quake2-app.service`, its journal), e.g. `userdata POST
"/userdata/baseq2/config.cfg/x" failed (409): a parent folder is a file`.

Path rules: every `/`-separated segment must be non-empty and must not start
with `.`. That excludes `.`, `..` and dot files, including the upload temp
files. Segments may not hold a backslash or a control character. A path is at
most 240 bytes and 8 segments, and must resolve inside the save folder. So
`..`, `%2e%2e`, `//`, `\` and absolute paths all get `403`, and nothing
outside the store is read, written or deleted. The static route never serves
the store's files and refuses dot segments such as `/.git/`. `server.js`
refuses to start if `QUAKE2_DATA_DIR` contains the app folder.

CORS: every `/userdata` response, errors included, carries
`Access-Control-Allow-Origin: *`,
`Access-Control-Allow-Methods: GET, HEAD, POST, OPTIONS`,
`Access-Control-Allow-Headers: Content-Type`,
`Access-Control-Expose-Headers: Content-Length` and
`Cache-Control: no-store`. Static files carry
`Access-Control-Allow-Origin: *` too.

POSTs need no preflight. `app.js` uploads with
`fetch(url, { method: "POST", body: uint8Array })` and deletes with a
body-less `POST …?delete` (a `DELETE` would need a preflight). Neither sets a
header, and a typed-array body gets no `Content-Type`. That makes them CORS
"simple requests", which the browser sends at once, without an `OPTIONS`
round trip. The server accepts any `Content-Type` or none, and still answers
`OPTIONS` for clients that preflight anyway.

Write safety: each write goes to a dot-named temp file (`.<pid>.<n>.tmp`)
beside the target. The file is fsynced and renamed over the target, then the
folder is fsynced. Readers, and a crash, see the old file or the new one,
whole. Temp files a crash left behind are deleted at startup. Writes and
deletes run one at a time, in the order their bodies finished arriving, so
the last complete write to a path wins. A body is read before it joins that
queue, so a slow upload holds up nobody.

### On disk

The store mirrors the engine's mount (`/qwasm2/baseq2/save/save1/server.ssv`
is `userdata/baseq2/save/save1/server.ssv`) in `userdata/` next to
`server.js`, or in `QUAKE2_DATA_DIR` (resolved from the working directory):

```
userdata/
└── baseq2/
    ├── config.cfg
    └── save/
        ├── current/      server.ssv, game.ssv, demo1.sav, demo1.sv2, …   (the autosave)
        ├── save0/        the autosave at the start of a unit ("ENTERING …")
        ├── quick/        the quicksave (F6)
        └── save1/ …      save <slot>, the Save Game menu
```

`userdata/` is git-ignored. Everyone who opens the app shares this one store;
there are no accounts.

### Several tabs: last writer wins

Each tab holds its own copy of the files, restored when it loaded. It
compares against what *it* last saw on the server, and does not see another
tab's saves until it is reloaded. Whichever tab pushes last wins. A file the
last tab did not change is not re-sent, so a slot saved from two tabs can
even end up with level files from both. Play in one tab at a time, or reload
a tab before saving in it after another tab has saved.

### Back up, restore, wipe

The store is plain files, and `server.js` reads the disk on every request, so
no restart is needed after you change it. First close every game tab: an open
tab still believes the server holds what it last pushed. Use your
`QUAKE2_DATA_DIR` in place of `userdata` if you set one.

- Back up: `tar -czf quake2-saves-$(date +%F).tar.gz -C userdata .`. Writes
  are atomic, so a copy taken while the server runs holds whole files. At
  worst, a slot caught mid-push has no `server.ssv` yet and is not listed.
- Restore: `mkdir -p userdata && tar -xzf quake2-saves-….tar.gz -C userdata`,
  then reload the page.
- Delete one slot: `rm -r userdata/baseq2/save/save3`. Over HTTP,
  `curl -X POST 'http://127.0.0.1:4231/userdata/baseq2/save/save3/server.ssv?delete'`
  hides the slot at once; delete its other files the same way to remove it
  fully.
- Reset settings: `rm userdata/baseq2/config.cfg`.
- Wipe everything: `rm -r userdata`. A missing store lists as empty, and the
  next save creates it again.

## Tests

Both scripts use Node built-ins only (no `npm install`) and can be run from
anywhere:

```
node scripts/test-userdata.js    # the /userdata store: exit 0 pass, 1 fail
node scripts/e2e-saves.js        # the real game: exit 0 pass, 1 fail, 77 skipped
```

Each script starts its own `node server.js` on 127.0.0.1:4299, or on a port
the OS picks when 4299 is taken, and never on 4231. `QUAKE2_DATA_DIR` points
at a fresh folder in the OS temp dir (`$TMPDIR`, default `/tmp`). Each stops
only the processes it started and deletes its temp folders. They never
connect to port 4231, never stop or restart `quake2-app.service`, and never
write to the real `userdata/`. `test-userdata.js` only looks at that folder,
to prove its names, sizes and mtimes are unchanged afterwards.

**`scripts/test-userdata.js`** checks the save store over HTTP, through both
`/userdata/` and `/apps/quake2/userdata/`. It takes a few seconds and prints
`PASS`/`FAIL` per check. It proves that:

- Binary saves (slots `save1`, `quick`, `current`) and `config.cfg`, POSTed
  with no `Content-Type`, come back byte for byte, and the listing matches.
- Overwrites work. `?delete` removes a slot's files and then its emptied
  folder, never the store itself, and a deleted slot can be saved again.
- Wrong methods, folders, paths under a file and bad escapes get
  `405`/`409`/`404`/`400`.
- Every response, errors included, has the CORS headers, and `OPTIONS`
  gets `204`.
- `..`, `%2e%2e`, dot segments, backslashes and absolute paths never reach
  outside the store, and `/.git/config` is not served.
- 20 concurrent POSTs to one path leave one complete body, with no half file
  seen and no temp file left.
- Bodies over 16 MiB get `413` and change nothing.
- After a restart on the same folder, every file is still there and a
  crash's temp file is gone.

It reads no environment variables of its own (it honours `TMPDIR`).

**`scripts/e2e-saves.js`** plays the real game in headless Chromium. A small
proxy in front of the server adds the box's
`Content-Security-Policy: sandbox allow-scripts allow-pointer-lock` to HTML,
so `/apps/quake2/` runs with an opaque origin and no IndexedDB, as on the
box. It checks that:

- The page runs with origin `null` and `indexedDB.open` fails (it prints
  what `localStorage` does too), and it restores 0 files from the empty
  store.
- `map demo1` gets the level-change autosave (`current`, `save0`) to the
  server.
- `save save1` and F6 (quicksave) report `Data saved.` with the files on
  disk.
- `gamemap demo2` + `save save1` gives a slot holding both levels. Then
  `map demo1` + `save save1` removes the dropped `demo2.*` files from the
  server and leaves `quick` alone.
- The server holds exactly the game's files, byte for byte.
- `sensitivity 7.5` + `quit` puts `config.cfg` on disk.
- After a page reload, and again after restarting `server.js` on the same
  folder, every file is restored and `sensitivity` is `7.5`.
- `load save1` and `load quick` work (the map changes).
- Nothing went wrong along the way: no `Saved games:` warnings, no `app.js`
  exceptions and no server errors.

It also saves a screenshot of the Load Game menu (`menu_loadgame.png`). If
WebGL will not start, it retries with the software renderer. A run takes
about a minute. On failure it prints the last console lines, the store and
Chromium's stderr, and saves `failure.png`. It exits 77 (skipped) with the
reason when no usable Chromium can start. Environment:

| Variable | Use |
|---|---|
| `CHROME_BIN` | Chromium binary. By default it searches `PATH` for `chromium`, `chromium-browser`, `google-chrome`. Snap Chromium under a no-new-privileges parent falls back to the browser inside the snap, then to `--no-sandbox` |
| `E2E_CHROME_ARGS` | Extra Chromium flags, space-separated |
| `E2E_OUT_DIR` | Where the screenshots go (default: a new temp folder, kept and printed) |
| `E2E_KEEP=1` | Keep the temp save folder and browser profile |
| `E2E_VERBOSE=1` | Echo the game's console while it plays |
| `TMPDIR` | Keep it short. Chromium puts a Unix socket under it, and socket paths are capped at 107 bytes; too long a `TMPDIR` makes Chromium abort, and the script skips with "use a shorter TMPDIR" |
