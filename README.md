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
| `engine-state.js` | Loaded by `index.html` before `app.js`. Defines `window.quake2Engine`, which reads the player's position, view angles and `cls.key_dest` straight out of the WASM linear memory, plus the frame-loop console watch. No console, no input, no pause. See [Reading the game's state](#reading-the-games-state) |
| `engine/` | `index.js` (Emscripten loader), `index.wasm`, `index.data`, `game_baseq2.wasm`, `ref_gles3.wasm`, `ref_gl1.wasm`, `ref_soft.wasm`, `license.txt` |
| `baseq2/` | PAK files served as static files and copied into the engine's MemFS at boot |
| `server.js` | Zero-dependency Node static server, 127.0.0.1:4231 (`PORT`), serves `/` and `/apps/quake2/`, and keeps saved games under `/userdata/` (see [Saved games](#saved-games)) |
| `userdata/` | Created at runtime (git-ignored): the game's saves and `config.cfg`, as the engine laid them out (`baseq2/save/save1/…`). Set `QUAKE2_DATA_DIR` to keep them elsewhere |
| `control/` | `bridge.mjs` (drives the running game over CDP: navigation *and* the fire button), `route.mjs` (reads a level's own BSP for its exit, waypoints and walkable floor plan, brush entities included), `walker.mjs` (follows a route through a live level, opening doors and re-planning when stuck), `combat.mjs` (the same walker, shooting back at the level's own monsters) and `server.mjs` (an HTTP front door to the bridge on 127.0.0.1:4233), see [Control interface](#control-interface) |
| `mcp/` | `server.mjs`: a zero-dependency MCP stdio server exposing the bridge as seven tools, see [The MCP server](#the-mcp-server) |
| `deploy/` | `quake2-control.service`: the systemd **user** unit that keeps the control API (4233) up without a manual step, see [Keeping the HTTP API up](#keeping-the-http-api-up) |
| `scripts/` | `test-userdata.js` (the `/userdata` save store), `e2e-saves.js` (the real game in headless Chromium), `quake-control-test.sh` (the live game over CDP), `control-api-test.mjs` (every control route), `goto-test.mjs` (navigation, against the live game), `route-test.mjs` (the route planner, off the archive), `demo1-run.mjs` (play demo1 and prove it) and `mcp-smoke-test.mjs` (the MCP handshake), plus `control-server.sh` (run the API in the foreground), see [Tests](#tests) |
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

## Control interface

An external agent on the box -- OpenClaw, or anything that speaks HTTP or MCP --
can play the game the kiosk Chromium is showing. Nothing is added to the page:
the control code drives the live game over the Chrome DevTools Protocol (CDP)
that the kiosk browser already exposes at `http://127.0.0.1:18801`, so
`server.js`, the save store and `app.js` are untouched.

| Path | What |
|---|---|
| `control/bridge.mjs` | The driver: a zero-dependency ESM module for Node 22+ (the built-in `WebSocket`, no `npm install`) that speaks CDP to the game |
| `control/walker.mjs` | Follows a route through the live level: doors, lifts, re-planning when a leg fails. Its two seams -- which point a leg aims at, and how the leg is walked -- are what `combat.mjs` overrides |
| `control/combat.mjs` | The level's monsters, from the level's own entity lump: which of them a level shot can reach, which of them are on the way, and a walker that shoots them as it passes. See [The fight](#the-fight-controlcombatmjs) |
| `control/server.mjs` | A small HTTP API on `127.0.0.1:4233` (`CONTROL_PORT`) for anything that would rather use `curl` than MCP. A front door to the bridge only: it never serves game files and never touches the server on 4231 |
| `mcp/server.mjs` | A Model Context Protocol server (JSON-RPC 2.0 over stdin/stdout) exposing the same calls as tools |
| `scripts/quake-control-test.sh` | The end-to-end proof against the live game |

### Which frame it drives

The box frames the app in the kiosk Chromium. CDP sees each frame as a target,
and the input has to go to the game's own frame -- the target (or the child
frame of the ClawBox page) whose URL contains `/apps/quake2/` -- because the
top-level ClawBox page is a different document whose UI would swallow the keys
and the engine would never see them. The bridge looks for the game frame by URL
and nothing else; if it is not there it raises `GAME_NOT_RUNNING`, naming the
endpoint and listing every target the browser did have, rather than quietly
driving the wrong page.

Whether the game is *framed* is asked of the frame itself: `status()` reads
`location.ancestorOrigins` inside the game frame. That is the only answer that
works for the ClawBox desktop, which frames the app as an out-of-process iframe:
such a child is absent from the shell's own `Page.getFrameTree` (a frame tree
cannot see it), and the target's own top-level-ness says the opposite of the
truth (an out-of-process iframe is a target whose main frame *is* the game, so
`isWholeTarget` is true there). `status()` therefore reports `framed`, the
hosting page's `hostOrigin` (the ClawBox desktop's origin), and `screenshotFrom`
-- `"host-page"` or `"game-tab"` -- which says plainly which page the next
screenshot will be taken from.

Every call that sends input -- `key`, `tap`, `typeText`, `mouseMove`, `click` --
first focuses the canvas (`canvas.focus()`), and, when the game does not hold the
pointer lock yet, sends a real click in the middle of the canvas: browsers only
grant `requestPointerLock()` inside a user gesture, and a game that is not
pointer-locked cannot be aimed. An already-locked game is not clicked, because a
click is Quake's fire button. `status`, `screenshot` and `evaluate` send no input
and so touch nothing.

### Input really reaches the engine: no `app.js` hook needed

The engine's input handlers are Emscripten/SDL ones registered on the game's own
document, and a CDP `Input.dispatchKeyEvent` arrives there as a trusted browser
event -- `isTrusted` is true and the target is the canvas -- so keys, mouse
movement and clicks go straight in, and `app.js` was left alone. This is not
taken on trust: `scripts/quake-control-test.sh` types a command into the in-game
console over CDP and then reads the engine's own console transcript back out of
the engine's file system (`condump` writes it, `FS.readFile` reads it), so the
proof comes from the game, not from CDP's "ok". If a future engine build stops
receiving CDP events, the same test fails at that step.

Reading the engine's *state* is the one thing that did need something in the
page, and it is a script rather than a change to `app.js`: `engine-state.js` is
loaded by `index.html` before `app.js` and defines `window.quake2Engine`, which
reads the engine's live state out of the WASM linear memory. It is a separate
file on purpose -- if it is missing or fails, the game still boots exactly as it
did, and the bridge says which reading it has rather than pretending. See
[Reading the game's state](#reading-the-games-state).

Two consequences of driving someone else's browser are worth knowing:

- **Pointer lock is what makes the mouse work.** A pointer-locked page reports
  `movementX`/`movementY` as the change from the *previous* dispatch position, so
  the bridge keeps its own cursor, starts it in the middle of the canvas and adds
  each delta to it. The very first move after the browser has not seen a mouse
  event for a while can be off by where the browser last thought the pointer was;
  send one zero-length move (`quake2_mouse` with `dx: 0, dy: 0`) after connecting
  and every move after it is exact.
- **A key is a key.** The game is a first-person shooter with the game's own
  bindings, so a stray keystroke does what it would do for a player at the
  keyboard: `w` walks, `Escape` opens the menu and a click fires. The test closes
  the console behind itself for that reason.

### The bridge

`control/bridge.mjs` exports `QuakeControl` (and `createControl`, which does the
same) plus `ControlError` / `GameNotRunningError`. One CDP connection is made on
the first call and reused by every call after it -- the target, the game's
frame, its execution contexts and the canvas's pointer-lock state are all
settled once, on that connection, rather than re-derived per call. It is thrown
away, and re-resolved from `/json/list`, only when the socket dies or the game
frame goes away -- and "goes away" includes its execution contexts being
cleared, which is what a reload of it looks like from the wire: the ids the
game's `evaluate` closed over are dead ones, and an evaluate naming a context
the page no longer has is answered `Invalid parameters` on this build
(measured). A socket that dies, a game frame that navigates somewhere else or
detaches, a target that crashes, and cleared contexts all drop the connection;
the next call re-resolves it. See
[the pass that made the input path cheap](#the-pass-after-that-the-input-path-and-the-lag)
for what that changed and what it measured.

| Call | What it does |
|---|---|
| `key(key, down)` | Press (`true`) or release (`false`) one key: `"w"`, `"Space"`, `"Enter"`, `"Escape"`, `"F5"`, `"ArrowUp"`, `"Shift"`, `"`"`, `"-"` … Holding a modifier sets its bit on the events that follow, so `key("Shift", true)` then `tap("w")` sends a capital `W` |
| `tap(key)` | Press and release |
| `mouseMove(dx, dy)` | Turn/look by a delta. `dx` turns right, `dy` looks down |
| `click(button)` | `"left"` (fire), `"right"` or `"middle"` |
| `status()` | What the game is showing: the frame's URL, whether it is framed and by which origin (`framed`, `hostOrigin`, `screenshotFrom`), the engine's state, the canvas size, focus and pointer lock, and the CDP target behind it |
| `state({probe})` | What the game is *doing*: the map, whether a level is up, the player's position and angles (read live out of the engine's memory), whether the console is up, the save slots, and the tail of the engine's own console log. No input unless `probe: true` (see [Reading the game's state](#reading-the-games-state)) |
| `screenshot()` | A PNG of the game frame as a `Buffer` (cropped to the frame when the game is framed) |
| `typeText(text)` | Type a whole string, one key at a time: how a console command is entered |
| `evaluate(expression)` | Run an expression inside the game frame and get its JSON value back (an escape hatch: read `FS`, poke `Module`) |
| `position()` | Where the player is and which way they look, read live out of the engine's own memory: no input, no pause, no page report. Also the map name, `dead`, and whether the console is up |
| `command(text)` | Run a console command (or an array of them) and read the answer back. `output` starts at the command's own echo; when the engine did not echo it (the console drops a keystroke now and then) `output` is empty, `echoFound` is `false` and `reason` is `"NO_ECHO"` -- never another command's lines |
| `level()` | The level the engine itself says it is running, asked on its own console: `map` is `"mapname"`'s answer, or `null` when the engine did not answer. `position().map` is cached and can name the level a run started in, so this is the one to use to ask whether the level has changed |
| `face(bearing)` / `walk(ms)` / `goto(point, opts)` | Closed-loop navigation on top of the probe -- see [Navigating](#navigating-position-face-walk-and-goto) |

Escape is the one key Chromium will not pass through from CDP: it is the key that
leaves pointer lock and fullscreen, so the browser takes it before the page ever
sees it. The bridge rebuilds that one inside the page, where the engine's
handlers do not care that an event is untrusted, so `quake2_key` with `"Escape"`
opens and shuts the game's menu like the real thing.

```js
import { QuakeControl } from "./control/bridge.mjs";
const game = new QuakeControl();               // or new QuakeControl({ cdpUrl })
await game.tap("`");                            // open the in-game console
await game.typeText("god"); await game.tap("Enter");
await fs.writeFile("screen.png", await game.screenshot());
```

Point it at another endpoint with `new QuakeControl({ cdpUrl })` or
`QUAKE2_CDP_URL`; `QUAKE2_CDP_TIMEOUT_MS` bounds each CDP round trip (5 s).

### Reading the game's state

An agent that has to finish a level needs to know where it is and how it is
doing, and the console used to be the only way to ask. It is not any more.

**The engine's own live state is read straight out of the WASM linear memory.**
`engine-state.js` is a small script served with the app and loaded by
`index.html`; it defines one page global, `window.quake2Engine`, whose `read()`
answers with the floats the engine is rendering from:

```js
// in the page, or over Runtime.evaluate
quake2Engine.read()
// { ok: true, position: {x, y, z}, angles: {pitch, yaw, roll},
//   keyDest: 0, keyDestName: "game", inGame: true, paused: false,
//   dead: false, alive: true, health: null, armour: null, ammo: null, ... }
```

The bridge calls it over `Runtime.evaluate`. That is one evaluation, it sends no
input, and -- the point of the whole exercise -- **it does not pause the game**.
`position()` and `state()` are built on it.

Where the offsets came from, since a guessed offset would be worse than no
reading at all (see [Recovering the offsets](#recovering-the-offsets)):

| Field | Address | How it was proved |
|---|---|---|
| `position`, `angles` | `0x597c8`, `0x597d4` | The three floats `viewpos` prints, and the three it prints for angles. The engine prints each as an integer, so the live heap was scanned for float triples inside those integer windows, the player was turned and walked, and the scan was repeated: the pair that survived is 12 bytes apart, which is `refdef_t`'s layout (`vieworg` immediately followed by `viewangles`). Over six poses -- including one taken mid-motion and one while the death camera held the view -- `trunc()` of each of the six floats equalled the six integers `viewpos` printed, every time |
| `keyDest` (whether the game, the console or the menu owns the keyboard) | `0x8d8b8` | Three snapshots of 4 MiB of heap around one console toggle left four words that ran `0 -> 1 -> 0`; `0x8d8b8` tracked every toggle, and reading 3 while the engine's own menu was up settled which end was which. That 0 is the game and 1 the console was settled by *drawing* it: with the word at 0 the frame is a clean in-game view, with it at 1 the console and PAUSED are both on screen |

What that gives, and what it does not:

| Wanted | Reachable? | Where it comes from |
|---|---|---|
| Engine running, canvas, focus, pointer lock | yes | the page (`status()`) |
| Player position and angles | **yes, live** | the engine's own memory, from the floats it renders from |
| Whether the console is up, whether the game is paused | **yes, live** | `cls.key_dest`, sampled from inside the engine's frame loop |
| Whether a level is up, and its map | yes | the console log, or the last `map` command the bridge issued |
| Whether the player is dead | yes | the live view roll, above the lean the same build puts on a strafing player. See [Which roll is a death](#which-roll-is-a-death) |
| Save slots on the engine's file system | yes | `baseq2/save/` |
| Health, armour, ammo | **still not** | no console command prints them, and this pass did not recover those fields from the image either -- see [What this pass could not do](#what-this-pass-could-not-do) |

The reply says so itself: `player.health`, `armour` and `ammo` are always
`null`, `unavailable` names them, and `note` says why. A `null` field here means
*unknown*, not *zero*, and it is never filled in with a guess. `alive` is not a
memory field: it is derived from the live view roll and says so
(`aliveSource: "view-roll-above-strafe-lean"`).

#### Which roll is a death

The view roll is the only thing that says whether the player is alive -- this
engine prints no health, and every movement key does nothing while the death
camera holds the view -- so where the threshold sits decides whether a walk can
trust its own reading of the player. Two populations share that one field:

| What | Roll | How it was measured |
|---|---|---|
| Standing still | 0 | one reading per CDP round trip, live player, `demo1` |
| Walking forward | at most 0.72 | same |
| Strafe lean | up to 2.00, either way | 47 samples of pure strafe, none above 2.0 |
| Death camera | **40, held** | walking a player into demo1's soldiers with nothing fired: roll 40 for the whole death, position frozen, mouse turn moving the yaw 0 degrees |

The lean is Yamagi Quake II's own `cl_rollangle`, which stock Quake 2 does not
have. An earlier pass wrote that "Quake 2 has no lean, so a non-zero roll is the
death camera" and drew the line at **1** -- inside the lean. Measured, 24 of the
171 readings taken while walking a player into demo1's corridor were called
deaths by a roll the player was strafing through. A false death is not cosmetic:
the walker restarts the level for one, which restores the engine's autosave and
puts the player back at the spawn, and the fight walker's own `movementKeys()`
strafes on *every* firing leg. It is the single fault that most limited the
runs.

The line is now at **20** -- ten times the largest lean measured, half the death
camera's own 40 -- and both readers of the field draw it there:
`engine-state.js` in the page, and `deadFromRoll()` in `control/bridge.mjs`,
which decides for itself rather than passing the page's verdict through. That
second copy is not redundancy for its own sake: the app server on this box
serves the *deployed* app, not the checkout an agent is working in, so a run can
be driving a page whose reader still says 1. The control layer is the part that
promises the walk a reading it can act on, so it does not hand that promise to a
file it cannot change. `scripts/engine-state-test.mjs` checks the two agree on
every roll either population can produce.

Measured after the change, on the live game: 45 readings taken while strafing
left, right and forward-and-strafe, **0 of them read as dead** (12 of 47 did
before).

**The console is now an explicit fallback, and only that.** `state({ probe:
true })` still does what it always did -- opens the console, types the two
queries Yamagi answers (`viewpos`, `serverinfo`), shuts it again and reads the
answers back out of a `condump` -- but nothing on the hot path calls it, and the
live half of every ordinary call no longer touches it. It is still worth having:
it is the independent check the memory reading is proved against
(`position({ verify: true })` runs both and compares them), and it is the
fallback for a page that does not serve `engine-state.js`.

Two engine habits are worth knowing, both of them about the fallback:

- The engine writes `qconsole.log` through C stdio, so the file lags behind by a
  few kilobytes of output. The probe does not read it: it asks the engine for a
  `condump`, which is written where and when the command runs, and deletes the
  dump again afterwards (the save store is synced from the same file system).
- Quake 2 can refuse the console key while it is playing a demo cinematic (the
  attract demo it boots into), and it drops the first keys of an engine that is
  still starting. When the console will not take the commands the probe reports
  `probed: false` with `probe.ran: false` rather than pretending, and it waits
  for no one -- call it again once a menu or a level is showing.

#### The console watch, and why it samples from the frame loop

The bridge counts every console key it sends (`consoleMetrics()`), but that is
the bridge talking about itself. `quake2Engine.watch` is the page's own,
independent record: it samples `cls.key_dest` and counts every sample where the
keyboard was not the game's -- so a console opened by anything at all is on the
record, not just one opened by the bridge.

It samples from inside the engine's own `requestAnimationFrame` loop, **not from
a timer**, and that is not a detail. A console opened by a client typing over
CDP is up for only a handful of frames, and while the keys are being dispatched
the page's main thread is busy enough that `setInterval` callbacks do not fire.
Measured on this box: a 100 ms timer saw *nothing at all* during a probe that
per-frame sampling showed the console open for ten frames. A timer-based watch
would have reported "the console was never opened" about a console that was up
and drawing PAUSED.

#### Recovering the offsets

`engine/index.wasm` keeps its data section but **not** its name section -- the
only custom section is `dylink.0` -- so there are no symbols to look up, and the
build exports only libc and SDL. Every offset above was therefore recovered by
scanning the live image, anchored by a fact the engine itself produced, and each
one is backed by a check that would have failed if the offset were wrong: the
engine's own `viewpos` output for the floats, the engine's own console toggle
and menu for `key_dest`. None of them was found by looking for a plausible
number in the binary.

What could not be recovered that way is named rather than faked: the map name
lives in a heap-allocated string whose address moves between runs, so there is
no offset to ship -- it is learned instead, from a `mapname` the engine answered
(its own word for the level it is running), from a `map <name>` the bridge
issued (a request, not a fact), or from the engine's log, and `mapSource` says
which of the three answered. Health, armour and ammo are still unread.

### Reading the HUD: `control/hud.mjs`

Health, armour and ammo are drawn on the status bar and printed nowhere, so the
only way to read them is off a picture of it. `control/hud.mjs` is that picture
and the reader for it, and the fight report in
[The fight](#the-fight-controlcombatmjs) is built on it: without a per-leg
health reading, "the fight got better" is not a claim a run can make about
itself.

```js
import { hudShot, readHealth } from "./control/hud.mjs";
const shot = await hudShot(game);          // a 1:1 picture of the status bar
const { health } = readHealth(shot.png, shot.readOptions);
```

Three measured facts make it work, and each of them was wrong at first.

* **The HUD does not scale with resolution.** Quake 2's status bar blits
  `pics/num_0.pcx` -- 16x24 -- at 16x24 however big the canvas is. On this box
  the canvas is 1366x768 and the digit row sits in its bottom 24 rows, so the
  numbers are *small*: about ten pixels wide each, drawn on a lit wall.
* **A plain screenshot is smaller than the canvas.** The canvas is 1366 wide
  inside an 837-wide CSS box, so `screenshot()` has thrown away 39% of the HUD's
  pixels before anything can read them. At that size the ring of a `0` and the
  bowl of a `6` are the same blur and a matcher against the level's own digits
  scores every digit alike. `hudShot()` displays the canvas at its own size,
  slid so the status bar is what the viewport shows, captures that 1:1, and puts
  the canvas's style back -- the engine keeps drawing into the same backing
  store (measured: `canvas.width` stays 1366x768 across the move), so the
  picture is of the same game, framed differently for one screenshot. The
  capture is clipped to the forty rows that can hold the status bar, which is
  four kilobytes instead of six hundred.
* **A clip is in the game frame's pixels, and the capture is not always of the
  game frame.** On this box the desktop frames the app as an out-of-process
  iframe, so the picture is taken from the page that *draws* the frame, and a
  clip has to ride on the frame's own box there. It did not: `screenshot()`
  dropped the caller's clip on that branch and captured the whole desktop.
  Measured, on a live game: the strip `hudShot()` asks for came back **1625x1158
  instead of 1625x48**, so every read was made over the desktop, not the status
  bar. The visible symptom was a `finish` run whose per-leg record said "0
  firing legs with a health reading" while the picture it had just kept plainly
  showed a number. `scripts/control-api-test.mjs` now checks that a 400x40 clip
  comes back 400x40, and that the strip a caller reads health from carries the
  band it was read with and has a number in it, whenever a game is open.
  Measured after the fix, on the live game: health reads **100** off the strip
  both standing still and with the trigger held while walking.
* **The digits are the level's own pictures.** `pics/num_*.pcx` are what the
  engine blits for health and ammo and `pics/anum_*.pcx` for armour. They are
  8-bit paletted, index 255 is transparent, and the picture's *background* is
  its own most common remaining index -- not index 0. Reading them wrong turns
  every digit into the same solid rectangle; that is a matcher that "reads" 100
  for every screenshot, which is worse than one that reads nothing.

The reading itself is normalised cross-correlation against those pictures, not a
brightness threshold: the status bar sits on top of the level and its strokes
and the wall behind them overlap in luminance (measured), so "bright pixel" is
not "glyph pixel". Correlation does not care what the background is doing, and
`scripts/route-test.mjs` paints a status bar out of the archive's own digits on
a noisy background and reads it back, including a number on a dark wall and the
same number on a lit one. The family -- health or armour -- is read off the
ink's colour: the `num_*` pictures carry a grey ink and the `anum_*` a red one,
and their *shapes* are the same font and do not separate them (measured: a
painted "100" reads as its own family only by a hair).

`hudShot()` reads the status bar's pixels out of the canvas *in the page*
(`canvasStrip`, the same module): the engine's WebGL backing store is cleared as
soon as a frame is composited, so `toDataURL()` from outside a frame comes back
black (measured) and the read has to happen inside the engine's own animation
frame. It wraps one frame of `requestAnimationFrame`, takes the canvas's bottom
rows with `gl.readPixels` after the engine has drawn them, flips them back to
screen order and encodes them with a scratch 2D canvas. On this box that is
**68 ms** a read against **392 ms** for the screenshot it replaced: the
screenshot path -- restyle the canvas, wait 150 ms for a frame to be composited,
capture the desktop through the compositor, decode a PNG -- is still there and
still used whenever the page has no readable WebGL canvas, and both paths return
the same strip layout and the same `readOptions`. The read is bounded to the
rows the status bar must be on, because the player is standing still while it
happens and on `demo1` standing still is the thing that kills. When the player
is *dead* there is no status bar to read, and `health` comes back `null` rather
than a guess -- `finish` prints those legs as `?`.

### Navigating: `position`, `face`, `walk` and `goto`

Pushing keys is enough to open a door and not enough to arrive anywhere. The
bridge closes the loop on top of the same console probe `state()` uses:

| Call | What it does |
|---|---|
| `position()` | Where the player is and which way they look, read live out of the engine's memory, plus the map name and `dead`. No input, so it never pauses the game -- which is what makes a walk a walk. `{ verify: true }` also runs the old console probe and compares |
| `command(text)` | Open the console, run one command (or an array of them), read the answer back, close it. How a level is started (`map demo1`) and how a cheat is turned on, said out loud |
| `face(bearing)` | Turn the player to an absolute bearing, in Quake 2's degrees: `0` is `+X`, `90` is `+Y`, the yaw grows anticlockwise |
| `walk(ms)` | Hold forward for `ms` and let go. The primitive underneath `goto()` |
| `walkKeys(keys, ms)` | Hold several keys at once for `ms` and let go: forward *and* a strafe, which is how a player looks one way and walks another. What a firing leg uses |
| `goto({x,y,z}, opts)` | Turn towards a point, walk, read the position again, and keep going until the player is there -- or until the position stops improving |
| `use(ms)` / `useHold(down)` | The use key, as a real key event on the key the engine's **own config** binds to `+use` (read out of `config.cfg`, cached). A stock Quake 2 config binds nothing to `+use` -- a door opens by walking into it -- so on this box it reports `reason: "NO_USE_BINDING"` and holds nothing rather than falling back to the console. `{ console: true }` reaches for the old `+use` command line, and says so in its result |
| `fire(ms)` / `attackHold(down)` | The fire button, as a real left-mouse-button event -- this build's config binds `MOUSE1` to `+attack`. Held rather than tapped, because a fight is won by firing while the player keeps walking -- see [The fight](#the-fight-controlcombatmjs). `{ console: true }` uses the old `+attack` command line |
| `jump()` | One tap of space, the engine's fixed-height jump |
| `strafe(ms, "left")` | Step sideways without turning: how a follower backs out of a corner |
| `respawn()` | Put a dead player back in the level. The default is the engine's own fire-to-respawn, which is real input and opens no console -- but it restores the autosave, so the result says `how: "fire"` and names that trap. `{ how: "map" }` starts the level again instead, which needs a command and therefore the console |

`position()` reports **`dead`**. The view roll is the only thing that says so --
this engine has no console command that prints health (see
[Reading the game's state](#reading-the-games-state)) -- and the same build also
leans the view when the player strafes, so the threshold has to sit between the
lean and the death camera rather than at the first non-zero value. See
[Which roll is a death](#which-roll-is-a-death). It matters more than it sounds:
every movement key does nothing at all while the player is dead, so a navigation
loop that does not check it reads a death as a wall -- and, read the other way, a
*false* death costs the walk its ground, because `respawn()` restores the
engine's autosave. `respawn()` is the way back in, and it is not a cheat -- no noclip, no god,
no teleport; it starts the level again and the player lands on the level's own
spawn.

Restarting the level needs a command, and a command needs the console, and the
console is a pause. `respawn()` sits inside the walker's own loops, so a pause
there would be exactly the thing this pass removed, and the default is now the
engine's own fire-to-respawn instead: real input, no console, no pause.

The cost of that default is the trap above. The engine's fire-to-respawn
restores the autosave in `/userdata`, which is wherever the last session saved --
so a player killed at `128 -320 32` can reappear 1300 units away inside the base
with no walk in between, and a walk that never happened is indistinguishable from
one that did. The result therefore says `how: "fire"` and carries
`note: "the engine restored its autosave, so the player is wherever that save
left them, not on this level's spawn"`. A caller that would rather have a clean
spawn, and would rather pay a console round trip for it, asks for it:
`respawn({ how: "map" })`, and the result says `method: "console"`.

```js
import { QuakeControl } from "./control/bridge.mjs";
const game = new QuakeControl();
const where = await game.position();          // { position, angles, map, running }
await game.face(90);                          // face +Y
await game.walk(500);                         // half a second forward
const trip = await game.goto({ x: -1744, y: 1576, z: 48 }, { tolerance: 64 });
if (!trip.reached) console.log(trip.reason, trip.distance, trip.position);
```

`goto()` reports honestly, because a navigation call that lies is worse than one
that fails. It returns `reached: true` only when it read a position inside
`tolerance` of the target; otherwise `reached: false` with a `reason` of
`"stuck"` (the position stopped closing on the target for `stuckRounds` steps),
`"timeout"`, `"rounds"` (out of `maxRounds`), or `"NO_POSITION"` / `"NO_ANGLES"`
(the engine would not answer). A miss carries the **last position it actually
saw**, the distance left and a `trail` of the last few positions, so a caller can
tell "walked into a wall" from "the console stopped answering".

Three things are worth knowing before trusting a number from it.

**How it turns.** `face()` uses the arrow keys first and the mouse second, and
says which one worked. The engine turns a held `+left`/`+right` at `cl_yawspeed`
-- a fixed rate that does not depend on the player's sensitivity cvar, measured
on this box at 145 degrees per second -- and the relative-motion deltas turn the
player too. An earlier pass recorded the opposite, that the mouse deltas "do not"
reach the player's own angles; that is wrong, and it is wrong in a way worth
naming, because the obvious way to measure it measures the death camera instead.
A dead player turns to nothing at all -- no key and no mouse count reaches the
player's angles while the death camera holds the view -- so a mouse test run
against a corpse reads exactly like a mouse that does not work. Measured on a
live player on `demo1`: `mouseMove(-400, 0)` moved the yaw by 44 degrees, and
`face(40, { turn: "mouse" })` converges to 0.04 degrees in two rounds and 242 ms
against the arrow keys' 415 ms and default 6-degree tolerance. `face()` measures
the real rate on its first turn and uses the measurement afterwards, which is
why the two paths can be swapped by a caller: `{ turn: "mouse" }`, `{ turn:
"keys" }` or the default `"auto"`. A method the caller names explicitly is put
back on probation rather than refused when it is believed dead, because refusing
it would leave a caller that asked for the mouse with no way to turn at all.

(The mouse step in `scripts/quake-control-test.sh` proves the *events* arrive;
`scripts/goto-test.mjs` proves what the engine then does with them.)

**A method is retired after three turns in a row that came back as nothing, not
after one.** A zero reading is not rare and it is not evidence: the engine
applies a held key once per frame, so a hold of thirty-odd milliseconds can fall
between two frames and do nothing at all, and a dead player turns nothing at all
-- the death camera holds the view, so no key and no mouse count reaches the
player's own angles. Retiring on a single zero reading therefore retired the
arrow keys on the first hiccup and the mouse on the next attempt to turn, one
missed frame or one death apart, and `face()` then answered `NO_TURN` without
sending anything for the rest of the run. That is what a stalled walk looks
like from the outside: every leg covering 0 units at the same frozen yaw while
the level's own plan sits 91 units away, which is exactly the note four
`finish` runs wrote at `-427 111`. A method retired in error is now put back on
probation whenever both are believed dead, so the view can always be turned
again.

**A dead player is said so, not walked at.** `goto()` returns
`reason: "DEAD"` at the first round rather than spending the rounds -- and the
calibration -- on a player whose keys do nothing. `follow()` already restarts
the level when it sees a death; this only stops the walk from paying for the
death on the way there.

**How it compares `z`.** A point from the map is the *floor* -- the level's own
`info_player_start` for `demo1` is at `z = 32` -- and the engine reports the
*eye*, which is `EYE_ABOVE_FEET` (46) higher: the player's origin is the middle
of their 32x32x56 box (24 up) and the view sits another 22 above that. `goto()`
therefore compares `x` and `y` against `tolerance` and `z` against `zTolerance`
(64 by default), so a floor point from `control/route.mjs` can be passed in
unchanged.

**What moves the player.** `walk()` is `key("w", true)` for `ms` and then
`key("w", false)`, so a game that is paused, a player who is dead, or a menu on
screen all come back as "it did not move". The engine draws `PAUSED` while the
console is open -- which is why the console is no longer on the path these calls
read through. A step is measured with `position()`, and `position()` reads the
engine's memory; nothing on the walk pauses the game, so "the player did not
move" is a fact about the level rather than about the harness.

The `cls.key_dest` reading says which of those it is, for free: `paused` is true
whenever the console or the menu owns the keyboard, and `position()` reports it
alongside `dead`.

### The route: where to go

`control/route.mjs` answers "where do I go?" from the level's own data. A Quake 2
map ships as a BSP whose entity lump holds the player start, the exit trigger,
the monsters and the items, and whose planes, nodes and leafs describe the solids
a player can walk between. Nothing here is guessed.

```js
import { loadMap, exitPoint, waypoints, nearest } from "./control/route.mjs";
const map = await loadMap("demo1");              // from baseq2/pak0.pak
map.exitPoint();                                  // { nextMap: "demo2", landmark: "base1", position: {...} }
map.waypoints("enemy");                           // every monster_*, with its position
map.nearest(playerPos, "item");                   // the closest pickup, with `distance`
map.path(map.playerStart().position, map.exitPoint().position);   // a walkable route, or why not
```

| Call | What it does |
|---|---|
| `loadMap(name, opts)` | Read a map, by `"demo1"`, `"demo1.bsp"` or `"maps/demo1.bsp"`. `opts.control` reads it out of the *running engine's* file system instead of off the disk; `opts.pak` names a different archive |
| `exitPoint(name)` | Where the level ends: the `target_changelevel`'s map (`demo2$base1`, split into `nextMap` and `landmark`), the `trigger_*` that fires it, whether the `worldspawn` `nextmap` agrees, and both `position` (the mapper's marker) and `aim` (the middle of the trigger volume -- see below) |
| `map.modelBounds("*27")` | The bounding box, centre and size of an inline brush model. A brush entity usually has no `origin`, and the marker a mapper leaves next to it is not where it is |
| `waypoints(name, kind)` | Every entity worth steering towards, tagged with a `kind`: `start`, `exit`, `enemy`, `key`, `item`, `path`, `secret`, `goal`, `hint`, `teleport`, `dead`, `trigger` |
| `nearest(name, from, kind)` | The closest one of those to a point. `kind` also accepts a classname, so `nearest(p, "monster_soldier")` works |
| `path(name, from, to)` | A\* over a walkable grid built from the BSP's own solids. Returns `points`, or an empty list with a `reason` |
| `map.pathCorners()` | The mapper's authored patrol graph: `path_corner` entities chained through `target` |
| `map.entities()` / `bounds()` / `summary()` / `pointContents(x,y,z)` / `isSolid(x,y,z)` | The rest of a BSP, for when a caller wants to ask its own question |

A map that is **not in the archive fails with a clear error** (`RouteError`,
code `MAP_NOT_FOUND`) naming the maps that are -- never a silent empty answer,
because "no exit here" and "I could not read the map" would send an agent to
opposite conclusions. A map with no `target_changelevel` throws `NO_EXIT` and
says so. `map.summary()` is the one call that does not throw: it is meant to be
asked about any map, so it reports the error in a field.

`path()` is best-effort and says so. It builds a grid of walkable floor points by
walking the BSP's node tree -- each node is a splitting plane, and a negative
child is a leaf -- and finds a floor wherever open space stops and solid begins,
which is where a mapper put one. It then connects neighbouring cells a player
could really cross, and runs A\* over them.

**The world model is not the whole level.** A Quake 2 map's brush entities --
`func_door`, `func_wall`, `func_plat`, `func_train` -- are separate models (the
models lump's `*n` entries), each with its own `headnode` into the *shared* node
and leaf lumps, and the world's tree contains none of them. The engine collides
with them separately, so a reader that only walks the world tree gets both halves
wrong: a `func_wall` platform is a floor the level really has, and a closed
`func_door` is a wall the level really has until it opens. `route.mjs` reads them
all, and splits them in two, because they are not the same kind of thing:

* **static brushes** (`func_wall`, `func_explosive`) are geometry, always. A
  point inside one is solid and its top can be a floor.
* **movers** (`func_door`, `func_plat`, `func_train`, `func_rotating`,
  `func_button`) move when the player opens, shoots or rides them, so they are
  *not* treated as solid: a route may cross them, and `path()` reports every one
  it crosses in `crossings`, with the `action` -- `open`, `press` or `ride` --
  that gets the player through.

A brush entity placed by an `origin` key (`func_rotating`, sometimes
`func_train`) is built around `0 0 0` and moved by that key, so its box is
shifted onto it; one without an `origin` is already in world coordinates. Getting
that backwards puts a fan in the wrong room.

Two more things the search knows about the player:

* **a column can have several floors.** `map.floorGrid()` keeps every standable
  level in a column -- a ledge over a floor, the top and bottom of a lift shaft,
  two storeys of one room -- and `path()` treats each as a candidate neighbour,
  rather than only the one nearest the height it is standing at.
* **a gap can be jumped.** `path(from, to, { maxJump: 160 })` also considers
  floors across open air, provided the line between them is clear at the player's
  height; the points that need it come back flagged `jump`. It is off by default:
  a route that silently leaps a chasm is not the same promise as one that walks.

When it finds nothing it says **what** stopped it, not just that nothing was
found: `reason: "NO_ROUTE"`, the point the search reached (`reached`), and
`blockers` -- the brush entities nearest that point, each with its classname,
model, centre, distance and a one-line `why` ("static brush entity, solid",
"moves: the route may pass once it is opened, pressed or ridden"). The message
repeats their names, so a log line reads "the floor grid does not connect ...,
and the brush entities nearest that point are func_wall *9 at 11 units".

### The walker: following the route, not just drawing it

`control/walker.mjs` turns a route into a player who arrives. A grid route is a
line over a floor plan and a level is not a floor plan: the doors are shut, the
lift is at the wrong end, the follower drifts into a corner the grid does not
know is there. So `RouteWalker.follow(goal)` walks the route one leg at a time
and, when a leg fails, works out why and does the one thing that fixes it:

* a leg that stops **next to a mover** gets `+use` held while the leg is retried
  -- which is what opens a door, and is sent as the engine command rather than as
  a key, because `+use` is what every binding points at and the key itself is the
  player's own choice;
* a leg that stops **anywhere else** is first **backed off** -- the player is
  turned away from the point the leg was aiming at and walked 400 ms on that
  bearing -- and then the route is re-planned **from where the player actually
  is**, which is how a follower recovers from a drift the grid route did not
  intend. Re-planning on its own is not enough: a follower pressed square against
  something the grid does not know about draws the same line again from the same
  spot and walks it at the same view, which is the same wall at the same angle on
  every round of every attempt;
* a waypoint that will not come is **skipped** once (a grid point can land on a
  crate the grid calls a floor); two in a row is a wall and the plan is rebuilt;
* a plan that fails twice gets a **sideways step**, because a follower pressed
  square against a wall never learns which way is open;
* a waypoint flagged `jump` gets the **space bar**, run at rather than aimed;
* a level that **restarts the player** costs a restart, not an attempt: the plan
  did not fail, the player died, and the next attempt is the same plan from the
  same spawn. demo1 kills -- six and seven of the eight attempts in two measured
  `finish` runs went on restarts, which is most of the walk's budget spent on
  ground it had already covered.
* a **missed respawn is pressed for again** rather than ending the walk. One
  press of fire is enough in a clean experiment -- measured live: a click, 2.5 s,
  roll -1.50 to 0.00, alive -- and evidently not always enough under fire, and a
  `finish` run ended on a single `NOT_RESPAWNED` at attempt 3 of 8 with the
  player 1,802 units short and four attempts unspent. The retry is free: it is
  the same death, and the restart budget is charged once. A player who is *still*
  dead after it is another death rather than the end of the walk, and the restart
  budget is what ends a walk that cannot hold on to a player. `ALIVE` and
  `LEVEL_CHANGED` are answers rather than failures and do not retry.

**What counts as progress**, and it takes all three readings. A leg is progress
when it *moved the player* **and** either arrived at the point it aimed at,
closed on that point, or came out closer to the goal:

* **moved.** `goto()` answers `reached` for a target it is already inside its own
  tolerance of, *without taking a step*, so arrival on its own is not evidence of
  anything. Measured: seven consecutive legs aimed at `(-120,-72,4)` from
  `(-99,-84,46)`, each one `reached, rounds: 0`, 0 units covered, and the walker
  clearing its stall counter on every one of them until the attempt was gone.
* **closed on the point**, not only on the goal. The way out of demo1's pocket at
  `-427 111` is 100 units of walking *away* from the exit before the route turns
  back towards it. Judged on distance to the goal alone, every one of those legs
  is "no progress": two of them abandon the attempt, the re-plan from the same
  spot draws the same dog-leg, and four consecutive `finish` runs ended there
  with the attempt budget spent and a valid 35-point route to the exit in the
  walker's own hand.

It gives up honestly: `reached: false` with the position the player really
stopped at, how far short it was, the plan's own `blockers` for that spot, and a
`log` of everything it tried.

**A brush entity is where its volume is, not where its marker is.** This is the
one thing about `demo1`'s exit that is easy to get wrong, and getting it wrong
looks exactly like a broken level. `target_changelevel` `t37` sits at
`-1744 1576 48`, and that is where a naive reader aims -- but the thing that
actually ends the level is the `trigger_multiple` volume next to it, model `*27`,
which spans `-1840,-1712` by `1448,1640` by `-24,32`. The marker is **outside its
own trigger**, 16 units above its ceiling. Stand on the marker and nothing
happens; walk into the volume and the level ends. `exitPoint()` therefore reports
`position` (the marker), `triggerVolume` (the box), `aim` (the middle of the box,
which is what to steer towards), and `markerInsideTrigger` to make the
discrepancy visible rather than a surprise. Inline model bounds come straight out
of the BSP's models lump; an entity's `model "*27"` is an index into it.

The reader is also useful without a browser at all:

```
node control/route.mjs list              # every map in the archive
node control/route.mjs summary demo1     # message, bounds, counts, start, exit
node control/route.mjs exit demo1        # the aim point for the exit, as JSON
node control/route.mjs waypoints demo1 enemy
node control/route.mjs path demo1        # spawn -> exit, or why there is no route
```

And the end-to-end one, which drives the running game rather than the archive:

```
node scripts/demo1-run.mjs plan          # what the level says about the way out
node scripts/demo1-run.mjs walk X,Y,Z    # walk the route to a point, and report
node scripts/demo1-run.mjs finish        # fresh demo1, walk to the exit, prove it
```

### The fight: `control/combat.mjs`

The walker gets a player to the exit of a level that does not want them to
leave. `demo1` is a level that wants them dead: its corridor is held by
`monster_soldier` entities whose blasters do 10 damage a bolt, the player has
100 health and no armour, and the walker above does not shoot. That is why
`finish` used to stop two-thirds of the way in.

`control/combat.mjs` is the same walker with two decisions replaced, both of
them about the level's *own* entity list -- the `monster_*` entities a mapper
placed, which `route.mjs` reads out of the BSP's entity lump:

* **`threats(map, from, options)`** -- what is worth shooting from here, best
  first. It is a pure function over the map data: no browser, no game, and the
  new checks in `scripts/route-test.mjs` run it off the archive. A soldier is a
  target when it is within `engageRange` (1,100 units -- about where a Quake 2
  soldier opens fire), within `engageArc` (80 degrees) of the way the walk is
  already going, and when a *level shot* can reach it.
* **`levelShotReaches(map, eye, origin)`** -- the geometry behind that last
  filter. A Quake 2 bolt leaves the muzzle along the view and flies straight, so
  a shot fired with the view level crosses the world at the player's eye height,
  46 units above the floor they stand on. A soldier standing on that same floor
  is 56 units tall with its origin 24 above its feet -- its box runs from 24
  below that origin to 32 above it, which on the player's own floor is from 46
  below the eye to 10 above it. The eye is *inside* that span, so a level shot
  hits the chest with no pitch at all. A soldier on the floor above, or one
  behind the corridor's own wall, is
  not reachable, and both are ruled out from the level's data alone -- which
  matters, because this engine has no way to print pitch, and the pitch controls
  it does have are useless for aiming (holding the key bound to `+lookup` even
  30 ms moves the view 67 degrees).

`CombatWalker` extends `RouteWalker` and overrides its two seams:

| Seam | What the fighting walker does with it |
|---|---|
| `_legTarget(position, points)` | Hands back the soldier when `threats()` finds one where the route goes, and a route point when it does not. Each soldier is counted against `maxEngagements` (3) from wherever the player stands, so a walk never spends its whole budget on one of them -- a level restart, which puts the player hundreds of units away, hands every soldier a clean slate -- and a soldier inside `closeRange` (250 units) is shot at whatever the count says, because a monster is solid and the one at arm's length may be what the leg keeps stopping against |
| `_leg(target, options)` | A leg with a soldier on it looks at it, holds `+attack` down and **walks the route anyway**, with the strafe key that keeps the two apart (`movementKeys`) |

That last row is the whole tactic, and it was arrived at by measurement rather
than taste:

* **Standing still is what kills the player, and it is not close.** In
  `demo1`'s corridor with 100 health and no armour, a live player who stood still
  for six seconds was dead; a player who walked the same ground into the same
  soldiers, holding the fire button down, finished the fight at 43 health with
  35 armour and a soldier's body on the floor. A driver that stops to aim is
  worse than one that never fires at all, which is the result the earlier runs
  reported.
* **Walking *at* the soldier is the wrong walk.** The first version of the
  fighting leg aimed at the soldier and walked at it. On `demo1` its first leg
  travelled 28 units in half a second, its second travelled none at all -- the
  aim had left the route and pinned the player against a wall beside the
  corridor -- and the player, standing still in the open, was dead before the
  third leg. Quake 2 moves a player along the view, so looking at a soldier to
  the side of the corridor *costs the walker the corridor*; `movementKeys()`
  buys it back by holding forward and a strafe key together, which is what a
  player at the keyboard does.
* **The leg has to be short.** The base walker's `goto()` runs until it arrives,
  which on open ground is several hundred units of walking in which no combat
  decision is taken -- and the leg that enters `demo1`'s corridor is decided
  while the soldiers are still out of sight. `walkRounds: 2` caps an ordinary leg
  at about 240 units, comfortably inside the range a soldier opens fire at.
* **The walk has to follow the plan, not a chord across it.** The base walker
  aims each leg at the farthest route point it can see. That is a straight line
  between two points the planner cleared, and the line itself is only checked for
  clear *air* -- not for a walkable floor. On `demo1` it is enough to walk the
  player off the plan and into the dead-end pocket at `-427 111`: three `finish`
  runs ended with the walker's own note naming that position and the `func_wall`s
  it was standing against, while the planner was holding a route the whole time
  -- `route.mjs` plans 35 points and 4,067 units to the exit from that pocket, and
  29 points and 3,511 units from `-703 278`, which is where an earlier run had
  stopped 1,660 units short. `CombatWalker` aims every leg at a route point a few steps ahead on
  the plan instead (`walkAhead`, `walkReach`), and checks the line to it with
  `clearWalk()`, whose step is 10 units rather than 16 because the brush that
  walls that pocket off is 16 units thick in x and a 16-unit stride steps
  straight over it. A point with no walkable line to it is skipped and the next
  one back is tried, so a leg aims at something the player can actually walk to
  rather than merely see -- with one measured exception, added by the pass that
  stopped a leg aiming at a point the player was already standing on. When
  *nothing* beyond the leg's own arrival radius has a clear line, the last
  resort is the nearest point ahead whatever its line looks like, on the
  reasoning that a leg which walks at a wall still covers ground and a leg aimed
  inside the arrival radius covers none. Measured on 105 positions along
  demo1's own route, that last resort is taken 11 times; it is the exception and
  not the rule, and it is why a leg can still end against something the plan
  called clear.
* **`clearWalk()` has to follow the floor, and the point it hands back has to be
  one worth walking to.** Both were measured to be wrong in ways that look
  identical from outside -- a leg that covers 0 units:

  * Sampling the straight *chord* between two route points and lifting the body
    off it is only right while the floor is level. The route's own second step
    drops 52 units in the 24 it takes -- from `-120 -72 4` down to
    `-144 -72 -48`, just west of the start room -- and halfway along that chord
    the sample is *inside* the floor it is supposed
    to be standing on. Every point past the drop was rejected, every leg
    collapsed to the nearest next point, and the nearest next point is one
    `goto()` answers `reached` to without moving. The line is now sampled on the
    **floor**, looked for from the chord's own height outwards (a step up, a step
    down, whichever is nearer), with the old chord test kept as the fallback for
    a sample with no floor under it -- a gap, a shaft -- so nothing that was
    walkable stopped being walkable.
  * The leg may now aim at **the point the player is nearest to** as well as the
    ones after it, whenever the player has not actually arrived at it. The
    planner snaps the start of a route onto the nearest floor, so a walk that
    stops 111 units short of the plan's own first point still reads as "nearest
    to point 1" -- which is exactly what the pocket does. Aiming only *after*
    that point aims at point 2, whose straight line crosses the 16-unit
    `func_wall`, and the leg stops dead against it twice and the attempt is
    abandoned. Measured on the plan that did it (43 points, made from
    `-429 10 6`): the leg target was `(-480,24,-48)`, through the wall; with the
    nearest point allowed as a target it is `(-456,24,-48)`, the plan's own way
    out, 92 units away and walkable.

  A point the player's own 32 units of shoulder fit to is preferred over one the
  centre line merely clears, and that preference is a tie-break rather than a
  policy: measured against the planner's own 37-point route, only **13 of the
  138** legs in its four-point lookahead are clear with a 16-unit half-width --
  because the planner draws its route with no player width at all, and 26 of its
  36 consecutive point-to-point steps are inside 16 units of something. So the
  shoulder test mostly falls through to the centre line, which is why the
  fallback exists and why it is the fallback: a level genuinely narrower than a
  player is still walked.

`CombatWalker.follow()` adds a `combat` summary to the walker's result --
`enemiesInLevel`, `firingLegs`, and a `fights` array with each firing leg's
aim error, the keys it held and the ground it covered -- so a run says what the
fight did rather than only where the player got to.

#### One press of the trigger, for the whole leg

A firing leg is one decision, and it used to be taken with the trigger up for
most of it. One leg timed on the running game, before this pass:

| Part of the leg | Wall clock | Trigger |
|---|---|---|
| the turn onto the soldier (`face()`, arrow keys) | 415 ms | **up** |
| the walk (`walkKeys`, 500 ms) | 538 ms | down |
| the two `position()` reads around it | 246 ms | **up** |
| `hudShot()` + `readHealth()` for the health series | 1,026 ms | **up** |

So 2.2 s of a leg was 1.4 s of the player standing still in the open with
nothing fired back, being shot at by the level's own soldiers. That is the
health series the fight instrument reports -- 23 to 72 health lost on a firing
leg, more than one soldier's blaster can do in half a second -- turned into a
mechanism, and it was the harness's doing rather than the level's. Two changes,
both measured:

* **The turn is taken with the mouse**, which this build does apply to the
  player's own angles (see [How it turns](#navigating-position-face-walk-and-goto)).
  `face(40, { turn: "mouse" })` converges to **0.04 degrees in two rounds and
  242 ms**, against the arrow keys' 415 ms and 6-degree tolerance -- and every
  bolt of that turn is a bolt on the way to a soldier that is already shooting
  back. The engage defaults put the tolerance at 2 degrees for the same reason:
  at 300 units a 6-degree miss passes a 32-unit-wide soldier by the width of its
  own body.
* **The status-bar read is taken inside the hold.** `hudShot()`'s restyle does
  not touch a held key -- the engine goes on applying them -- so the leg goes on
  walking and firing while the reading is taken, and the reading costs the fight
  no time standing still at all. The keys come up once the reading has had
  `readWalkMs` (600 ms) of the walk, so the reading may drag the leg out a little
  rather than the leg standing still for the whole of its second.

The trigger goes down before either and comes up after both. Nothing is spent on
it: this build's starting weapon is the blaster, which uses no ammo, so the only
question is whether the bolts land. `scripts/route-test.mjs` pins the whole
shape against a stub -- trigger down first, the mouse turn and the status-bar
capture between the press and the release, the walk's keys up before the trigger.

Two smaller things came out of the same measurement:

* **A firing leg does not start on a corpse.** A dead player's keys and turns do
  nothing at all, so the leg would spend its aim on nothing -- and, because a
  turn that cannot be taken is exactly how a turning method earns its way to
  being retired, spend the mouse on it too. A dead player takes the ordinary leg
  instead, which reports the death for the price of a `goto()` that says DEAD.
* **The aim is retried once if it does not land**, the bridge's own way
  (`turn: "auto"`), because a leg that walks off with the aim wherever it
  happened to be is a leg that fires at the wall it is walking past.

#### The fight is measured, leg by leg

A body count tells you nothing about a fight that ends in a corpse, and until
this pass a `finish` run could not say what the fight had cost. It can now:
`readHud: true` makes every firing leg take a picture of the status bar, read
the player's health and armour off it ([Reading the
HUD](#reading-the-hud-controlhudmjs)) and record them with the soldier it was
fighting and where that soldier stood. `finish` prints the series, and the
crops are kept, so a number that is wrong is visible in the picture it came
from.

Point `QUAKE2_HUD_DIR` at a directory and the crops are kept as well, one per
firing leg, named `leg-a<attempt>l<leg>-<n>.png`, so every number in the report
can be checked against the picture it came from:

```
QUAKE2_HUD_DIR=./hud-crops node scripts/demo1-run.mjs finish
```

That is what turned "the walk dies in the corridor" into a mechanism. Run 5 of
the instrument, firing at `monster_soldier` with the aim landing within 0 to 3
degrees on every leg it took:

```
leg  soldier          aimed        covered  health after
  1  monster_soldier  yes (3deg)      128   9
  2  monster_soldier  yes (0deg)        0   ?   DIED ON THIS LEG
  3  monster_soldier  yes (-1deg)     195   76
  4  monster_soldier  yes (0deg)       38   47
  5  monster_soldier  yes (1deg)        1   ?   DIED ON THIS LEG
```

The aim was never the problem -- 0 to 3 degrees, over distances of 150 to 365
units. The problem was that the player arrived at the corridor with 9 health
left and then lost 29 on a leg. It was being shot the whole way in by soldiers
it never fired at, and the per-leg record says why: at the deepest point that
run reached (`-728 321 -1`) the level shot could reach two soldiers, one at 58
units and one at 151, and the walker fired on neither. They stood 116 and 82
degrees off the way forward; the arc is 80. **The second of those misses by two
degrees.** That is the one fight rule this pass changed, and it is the only one
the measurements argued for:

* **`answerRange` (200).** The arc decides what is worth *walking towards*.
  Inside 200 units it stops deciding what is worth *answering*: a soldier that
  close can shoot the player wherever it stands, and a walker that will not turn
  for one is a walker that takes damage it could have prevented. The leg still
  walks the route -- `movementKeys()` holds forward and a strafe, or backpedals,
  according to the route, not the view -- so the walk goes on either way.
* **`minimumRange` stays 40.** It was lowered to 24 and put back. Measured on
  run 7, the one leg that answered a soldier inside the old radius
  (`monster_soldier` at 39 units, 95 degrees off) covered 0 units and died on
  the spot, which is exactly the fault the radius was there to avoid. A soldier
  at arm's length is a collision to be walked out of, not a target to spin for.

Two instrument faults were found by using it, and both are fixed: a whole-page
capture is smaller than the canvas, so the status bar has to be photographed
1:1 (`hudShot`), and a clipped capture races the layout change that frames it,
so it waits 150 ms -- measured, two of three reads on a live player came back
framed for the un-framed canvas and read nothing.

### What this branch adds to the fight

`clawbox/team-s5p49gdb` already carries the console-free harness, the
turn-on-the-move firing leg and the `binding()` reader that answers "which key
does the engine's own config press for this command" -- `use supershotgun`
included. What this branch adds on top of it is four levers on the fight, one
hardening in the bridge and one guard in the walker. The numbers quoted below
are from runs of `node scripts/demo1-run.mjs finish` against the live game made
while these were developed; the raw reports are the pass's own evidence, not
this file.

**Choosing a weapon is now an act, not an assumption.** `selectWeapon(name)`
presses and releases the key that `binding("use <weapon>")` answers, as a real
key event -- no console, so no pause. A weapon the player does not own is not an
error: Quake 2 ignores the command and keeps the weapon in hand, so this reports
what it pressed and lets the caller judge the fight by its health. Measured
live: `{"selected":true,"weapon":"Super Shotgun","method":"key","key":"3",
"command":"use Super Shotgun"}`.

The walker asks once per **life**, not once per attempt (`weapon: "Super
Shotgun"`). A death restarts the level and gives the player the level's own
starting loadout, and the walker does not spend an attempt on that restart
(`attempt--` in `follow`) -- so an attempt-keyed switch counts the ask as
already made, and every life after the first is fought with the blaster while
the report says shotgun. `RouteWalker.restarts` is the counter that makes the
difference visible, and `scripts/route-test.mjs` checks it.

**How a firing leg moves is a lever.** `fireWhile` is `advance` (walk the route,
the behaviour the fight was measured with, and the default), `retreat` (walk the
route backwards, away from the soldier being shot), `hold` (stand, which the
level punishes and which is here to be measured rather than recommended), or
`adapt`, which gives each of the three `fireModeWarmup` legs and then follows the
health the status bar cost, counted per life. What each way cost is in the report
(`fireModes`), and in the run that used it, `advance legs 4 covered 336 spent 48
per leg 12 readings 3`.

**Health and armour on the route: measured, and demo1 has none.** `pickupRange`
### The fight's levers, and the measurements that kept or dropped them

This pass added five levers to the fight and dropped two of them on the
evidence. Every run below is `node scripts/demo1-run.mjs finish` against the
live game; the raw reports are the pass's own evidence, not this file.

**The weapon is now the engine's, not this file's.** `bridge.binds()` reads the
keys the engine's own `config.cfg` binds, once, and caches them; `binding(what)`
answers "which key does the engine itself press for this command";
`weaponKey("Super Shotgun")` answers `3`; `selectWeapon(name)` presses and
releases it as a real key event -- no console, so no pause. Measured live:
`{"selected":true,"weapon":"Super Shotgun","key":"3","command":"use Super
Shotgun"}`. The same reader answers `+use`, which on this box is bound to
nothing (`reason: "NO_BINDING"`) -- that is why the walker's door handling has
always been a no-op here and why a door opens only by walking into it.

**Taking the level's own super shotgun: tried, measured, dropped.**
An earlier form of this walked to `weapon_supershotgun` before the exit route,
behind a `QUAKE2_ARM=1` knob. The arm walk reached it (`239 65 47`) and the
weapon was selected, and the run finished *no further than* the same run without
it -- deepest reading `short 1618` against `1739` and `1544` unarmed. The gun's
spread over the 150-300 units this walker fires across is the likely reason. The
knob is gone; what remains is the errand list above (`supplyCalls`), which walks
out to the nearest weapon and the ammunition that feeds it once per life, and is
on unless `QUAKE2_NO_SUPPLY` is set.

**Health and armour on the route: measured, and there is none.** `pickupRange`
lets a plan point whose pickup is close be nudged onto it, guarded by a walkable
line and by a `pickupTurn` limit so that taking an item never bends the route.
Measured at range 96 on demo1's exit route: exactly two points move, onto the
level's two `item_health_small` at route units 629 and 677, for 53 extra units
of walking -- **and the player is at full health when it passes unit 630** (the
first firing leg of every traced run is past unit 900), so both items are picked
up and thrown away. Measured against the route *line* rather than its points,
the one item this route could use -- `item_health_large` at `-1176 1520`, 50
health, 64 units off the line at unit 2770 -- is more than 96 units from any
plan point, so no nudge reaches it. That measurement is what the pass after this
one acted on: `pickupRange` is now **96**, and the *step*-based insert reaches
the `item_health_large` the point-based nudge could not. See
plan point, so no nudge reaches it. That measurement is what this pass acted on:
`pickupRange` is now **96**, and the *step*-based insert below reaches the
`item_health_large` the point-based nudge could not. See
[the pass after](#the-pass-after-why-the-walk-was-standing-still).

**How a firing leg moves is now a lever.** `fireWhile` is `advance` (walk the
route, the behaviour the fight was measured with), `retreat` (back along the
route, away from the soldier being shot), `hold` (stand), or `adapt` -- which
gives each of the three `fireModeWarmup` legs and then follows the health the
status bar cost, per life. The cost of each way is in the report
(`fireModes`), and in the run that used it, `advance legs 4 covered 336 spent 48
per leg 12 readings 3`.

**The walker finishes the soldier it started.** The threat list is scored fresh
every leg, and the score moves as the player walks; the per-leg record of four
traced runs shows legs aimed at `monster_soldier` from 127 to 407 units, with
the aim landing every time and the trigger down every time, and the player dead
at 1 health. A soldier is 30 health and shoots until it is dead, so the leg
targets the soldier the last leg fired at until it leaves `found`.

**A point that is not all three coordinates ends a walk rather than failing
inside one.** `finitePoint()` refuses a goal with a non-finite `x`, `y` or `z`
at the seam, with a reason, before any distance against it is computed -- every
comparison against a NaN is false, so a bad goal does not degrade the walk, it
grinds out the whole budget aiming at a place the engine can never report the
player as standing.

**The fire press is held across a frame, not clicked.** Quake 2 restarts the
level from its death camera on the *edge* of the attack button, and the engine
samples its buttons once a frame: a click is a press and a release dispatched
back to back, so on a 60 Hz game both can land between two samples and the edge
never happens. `respawn()` therefore holds the button for 400 ms (`pressMs`)
rather than clicking it. This branch keeps the base's own fallback behind it --
fire, then the console restart by name -- which is the path that actually
brought the traced runs back.
**Two instrument faults, found by using it.** *The budget knobs threw a zero
away.* `QUAKE2_ATTEMPTS` / `QUAKE2_DEATHS` now read so that an explicit `0`
survives (`Number(x) || default` cannot say "one life"), and a run reports the
budget it is spending. *A point that is not all three coordinates ends a walk
rather than failing inside one.* `finitePoint()` refuses a goal with a
non-finite `x`, `y` or `z` at the seam, with a reason, before any distance
against it is computed -- every comparison against a NaN is false, so a bad
goal does not degrade the walk, it grinds out the whole budget aiming at a place
the engine can never report the player as standing.

**And the reading the fight is judged by is not trustworthy on this box.** The
per-leg health numbers in the report disagree with the pictures they were read
from: crop `leg-a2l5-002.png` shows **100** health on the status bar where the
reader returned **4**, and `leg-a2l7-004.png` shows **25** where it returned
**80**. The crops are kept with the run's evidence. The outcome measures this
pass reports are therefore the ones read out of the engine's own memory -- where
the player was, and whether it was alive -- and the health series is reported
beside them, labelled as the reading it is.

**What a run of this fight looked like.** The deepest a traced run of this work
reached was `short 955` from the exit (at `-952 1063`), over 8 attempts and 5
level restarts it lived through, with 26 firing legs -- and it did not finish.
A level restart puts the player back on the spawn, so the attempts a life spends
before it dies are spent again: the deepest reading came at attempt 3, the run
died there, and the restarts after it re-walked ground it had already covered.
The level is not finished.
**A death used to end the run, and fixing that is what moved the numbers.**
Quake 2 restarts the level from its death camera when the player presses attack,
and on four traced runs that press never took: every one logged
`NOT_RESPAWNED` on all three tries and then `deaths: 9, allowed: 8` -- one death
spending a whole restart budget -- and the walk stopped 1,544 to 2,011 units
short with 0 to 5 firing legs and 10 to 20 engine positions reported. So the
fire press is now *held* across a frame rather than clicked (the engine samples
its buttons once a frame; a click's press and release can both land between two
samples), and when it still does not take, the walker falls back to the engine's
own restart by name -- `map demo1`, the one console command this harness sends,
and the same thing a player's own death does to the level.

Measured, same command, same eight attempts, after the fix:

```
walker reason: ATTEMPTS            (was DEATHS, with deaths 9 of 8 allowed)
level restarts lived through: 5
firing legs: 26 (20 with the turn landed on the soldier)   (was 0 to 5)
positions the engine reported: 116                          (was 10 to 20)
furthest position reached: -952 1063, short 955             (was 1255 to 2011)
```

That is the deepest any run of this pass reached, and the walk is now spending
the budget it was given instead of dying into a dead loop. It is still 955 units
short of the exit: a level restart puts the player back on the spawn, so the
attempts a life spends before it dies are spent again -- the deepest reading
came at attempt 3, the run died there, and the restarts after it re-walked
ground it had already covered. The level is not finished.

### The pass after: why the walk was standing still

The pass above named the blocker as damage -- 12 to 18 health a firing leg, a
life arriving at the exit complex on 1 to 4 health -- and left the deepest run
at `-952 1063`, 955 units short. This pass re-ran the same command before
changing anything, and **the run it measured did not get that far**:

```
walker reason: ATTEMPTS
firing legs: 8 (5 with the turn landed on the soldier)
positions the engine reported: 99
furthest position reached: -888 323, short 1509
level restarts lived through: 3
```

Five of its eight attempts never got past the corridor's west end: attempts 3,
4, 6, 7 and 8 each ended within 1,924 to 2,011 units of the exit, and their own
position lists show why. `-464 20` on attempt 1 legs 6 and 7, the same place on
attempt 6 legs 1 to 3, `-456 20` on attempt 8 legs 1 to 4 -- a walk that has
stopped is not a walk that is being shot at, and the damage model was not what
was ending this run. What was ending it was one line of `_walkPoint`.

**A leg was aiming at a point the player was already standing on.** `goto()` is
called with a tolerance of `max(24, tolerance/2)` -- **48** on a `finish` run --
and it answers `reached` to a target it is already inside that of *without
taking a step and without reading the position again*. `CombatWalker._legTarget`
hands it `_walkPoint`'s answer, and `_walkPoint`'s three passes were written
like this:

```js
for (const radius of [bodyRadius, 0])       // radius outermost
  for (const candidate of within)           // farthest-first
    if (clearWalk(map, feet, candidate, { radius })) return candidate;
```

The radius was the outer loop, so *every* candidate was tried with the shoulder
test before *any* was tried without it -- and the shoulder test is the stricter
one. Measured offline against demo1's own plan from the spot the run stalled at
(`-438 13`): the line to `-600 48`, four points along, is 166 units and clears
at radius 0 but not at 16; the line to `-456 24`, the next point, is **21 units**
and clears at both. So a point 21 units away -- inside `goto`'s own arrival
radius of 48 -- beat a point 166 units away, `goto` returned
`reached, rounds: 0, 0 units covered`, and the walker's own `moved > 8` test
called it a stall. The traced run is exactly that: legs covering 3, 0 and 0
units in a row, with a clear 166-unit line sitting right there unused, three
`func_wall`s named 20 and 46 units away that were never the obstruction.

The fix is to make distance the outer question and the margin the inner one,
and to refuse a point the leg's own arrival radius already covers:

```js
for (const candidate of within)
  for (const radius of [bodyRadius, 0])
    if (clearWalk(map, feet, candidate, { radius })) return candidate;
```

A short leg is not a cheaper leg. It spends one of the attempt's eight legs to
cross a fifth of the ground, and at 21 units it spends one to cross none -- and
the walker's stall handling is the only thing that pays for the difference,
one back-off and one re-plan at a time. Measured on the same command, after the
fix:

| Measured per `finish` run | Before this pass | After (leg targeting) | After (and top-ups) |
|---|---|---|---|
| firing legs | 8 | 25 | **30** |
| firing legs with the turn landed | 5 | 12 | **29** |
| firing legs with a health reading | 4 | 24 | 24 |
| ground covered on firing legs | 814 | 4,426 | **7,386** |
| positions the engine reported | 99 | 80 | 100 |
| furthest position reached | `-888 323`, short 1,509 | `-935 1262`, short 887 | **`-951 1550`, short 825** |
| health spent / firing leg | 9.88 over 8 legs | 17.44 over 25 legs | **11.63 over 30 legs** |

The last row is the one that says the fight is finally being fought rather than
merely arrived at: 349 health over 30 firing legs, against the 9.88 over 8 legs
the stalled run was spending. The best run reached route unit ~2,750 of 4,693 --
`-951 1550`, 825 units short, past the corridor's north end and inside the last
straight before the exit complex. That is 130 units short of nothing: the
`item_health_large` the top-up inserts is at route unit 2,887. The run died
between the two.

Four `finish` runs of the fixed code reached **887, 825, 1,224 and 1,297** units
short, against a stalled baseline of 1,509 -- so the honest claim is a walk that
now fights its way through the corridor and dies in or past it, not a walk that
has a repeatable position, and the deepest of the four is one sample rather than
a best case. What did *not* move between them is the shape: 25, 30, 31 and 31
firing legs, and 4,426, 7,386, 6,643 and 6,357 units of ground covered on them --
against 8 legs and 814 units for the run whose legs were being thrown away. Runs
before this pass spent their budget standing still; these spend it walking and
shooting. The distance moved much less than the fighting did, and it is the
distance that the exit is measured in.

The spread belongs to the level, and it did not narrow: the pass before this one
measured ten runs at 1,331 to 1,989 short, and this pass's four at 825 to 1,297.
A `finish` run is still one sample of a walk through a level that shoots back.

**The turn, and what the table above is really a measurement of.** A firing leg
that stands still through its aim is the other way this level kills, and the
branch fixes it in `#turnOnTheMove`: the movement keys go down before the first
turn, are re-chosen once the view has moved, and the leg's duration is counted
from the moment they went down, so the turn is spent walking rather than added
to the leg (see
[What this branch adds to the fight](#what-this-branch-adds-to-the-fight)). That
is the same conclusion this pass reached independently, in a weaker form -- a
per-leg helper holding the keys by hand, and the turn still added to the leg --
so the merge dropped this pass's version and kept the branch's. What that means
for the table above: its runs were made with this branch's *earlier* firing leg,
so the rows are an A/B of the leg-targeting change and of the top-ups -- which
is what they are about -- and not a measurement of the leg this branch now
ships.
**The walk now starts before the aim, not after it.** `face()` is the longest
thing in a firing leg that is not walking -- 242 ms when the mouse converges
first time, and the whole of the trigger-down period when it does not -- and the
movement keys used to go down only once it had finished. So every firing leg
began with the player standing still in the open with the trigger down, which is
the one posture this file's own measurements say demo1 kills: 100 health and no
armour is a corpse after six seconds of standing still in the corridor. The keys
for the view the player *has* now go down first, so the leg is already walking
when the turn starts, and `holdKeys()` then swaps them for the set the view the
aim actually left behind wants -- a diff, not a release and a re-press, so a key
both sets want is never let go and there is no gap in the walk. `route-test.mjs`
pins the new shape: the walk starts before the turn, it is corrected after it,
and the keys are still down when the status bar is photographed.

**And the level's own top-ups were re-measured, with the answer changed.**
`pickupRange` nudges plan *points* onto items near them, and the pass above
measured that on demo1 it moves two points onto two `item_health_small` for 53
units of walking the player does not need -- it is at full health when it passes
them. The one item the route could use, `item_health_large` at `-1176 1520`,
is 64 units off the route *line* at unit 2,770 and more than twice `pickupRange`
from any of the plan's own points, so no nudge reached it. The plan has 37 points
over 4,693 units -- a step is 130 units long -- and that is the gap the nudge
could not see. `snapPickups` now also asks the question of each *step*: an item
whose perpendicular lands in the middle of a step is inserted into the plan as a
waypoint of its own, at the foot of the detour and at the item.

Three measurements decided how that insert is guarded, and all three were the
difference between the mechanism working and not:

* **The detour is approached from its own perpendicular, not from the plan's
  vertex.** `clearWalk` from `-1176 1520` to the vertex at `-960 1584` -- 216
  units back up the line -- is **false** at every radius, because the two rooms
  share a wall. From the perpendicular at `-1176 1584` it is true, body width and
  all. The first version asked the vertex and refused the one item it was written
  for.
* **`pickupTurn` is not applied to an insert.** It measures a deflection from
  the line, and every insert is a step straight off the line and back, so its
  angle is 90 degrees by construction. Measured at 45, it refused all of them.
  What bounds an insert is `pickupDetour` -- the round trip -- which is 128 units
  for this item against a default of 140, set between it and the next item out
  (the 91-unit `item_health_small` at `-384 80`, 182 of round trip, measured
  harmful from demo1's pocket by the pass before this one).
* **The line along the route to the foot is tested at the radius the plan's own
  rows were built on.** The plan's step from `-960 1584` to `-1488 1584` does not
  clear the shoulder test at any point along it, so requiring it of a part of
  that same step would refuse the route's own ground.

Measured, `pickupRange: 96` takes exactly one pickup on demo1's exit route --
`item_health_large` at `-1176 1520 -48`, 64 units off the line at route unit
2,887 -- and inserts two points for it, the foot of the detour on the line and
the item itself, so the plan's 37 points become 39 and the walk is 123 units
longer. It is 50 health, and it is now the
default rather than a knob with no measurement behind it. The next items out are
208 units off the line, and a 416-unit round trip through a corridor this level
shoots down is a different route with a health item at the end of it, not a
top-up; 96 is where the measurement puts the ceiling. Whether the player is
still alive at unit 2,887 to take it is the trail's answer and not this
paragraph's -- the best run of this pass died 130 units short of it -- and the
run reports the insertions it made (`top-ups the plan was routed over`) so that
the claim can be checked against the run rather than believed.

**What still ends a run is not the fight.** The last four attempts of the
leg-targeting run (the middle column above) are legs 18 to 25 of its fight
record: eight firing legs with `covered 0`, the aim reported as `keys` with
residuals of 177 and -126.83
degrees, and the engine's own position unchanged at `-1007 208` throughout. The
floor there is clear in five of eight directions at every body height (checked
against the level's own BSP), so it is not a wall and not the route: the player
cannot be turned, and a leg that cannot turn walks the bearing it happens to
have. That is the same fault the pass before this one traced at `-427 111` --
`face()` retiring both its turning methods on readings a dead player produces --
and it is a `bridge.mjs` calibration problem, not a combat or a routing one. It
cost this run four of its eight attempts, and it is the largest single thing
still between the walk and the exit.

**The level is still not finished, and the engine said so every time.** All five
`finish` runs of this pass -- the stalled baseline, the one-life diagnostic, and
the three with the fixes in -- ended with the engine's own answer, taken from
its console after the walk gave up:

```
engine says the map is: demo1
proof: ["\"mapname\" is \"demo1\""]
result: NOT finished -- the engine is still on demo1
```

The raw reports are the run's evidence, not this file. `"mapname" is "demo2"`
appears in none of them.

### The pass after that: the turn that could not be taken, and the walk's own rate

This pass forked from `clawbox/run-a5pmsnnv` and folded in the review pass from
`run-esar8xa7` -- the per-life weapon switch in `control/combat.mjs` and the
check that pins it. `node scripts/route-test.mjs` runs **131 checks, all
passing** (125 after the merge, plus the six this pass added);
`node scripts/engine-state-test.mjs` runs 35, all passing.

**`demo1` is still not finished.** Three complete `finish` runs were measured
this pass and every one of them ended with the engine saying so:

```
engine says the map is: demo1
proof: ["\"mapname\" is \"demo1\""]
result: NOT finished -- the engine is still on demo1
```

#### The aim: fixed, pinned, and measured

`face()` could be left unable to turn at all. Two rules were added to
`control/bridge.mjs`:

* **A turn that could not be taken is not evidence about the method that could
  not take it.** The death camera, the console and the menu each take the
  keyboard off the game, and each stops *every* method at once -- so a blank
  turn read in one of those states neither counts a miss against the method nor
  switches methods. `turnIsBlocked()` reads the answer out of the engine's own
  `position()` (`dead`, `inGame`, `paused`), which costs nothing and sends no
  input. Before this, three such misses retired a method for the rest of the
  run, and a level that kills several times a run earned that on its own.
* **Two blank turns in a row, and the other method is tried inside the same
  call.** `#turnBy` honours a method the caller asked for by name -- and the
  fighting walker asks for the mouse (`aimTurn: "mouse"`) -- so a mouse that had
  stopped turning the player used to spend every round of every call on the
  mouse. The keys were reachable only from a *second* `face()` call, which only
  `#fight`'s retry makes and only with `turn: "auto"`, at two rounds. A walk
  whose first method is dead therefore ended the leg with the view wherever it
  happened to be, which is how a firing leg comes to be recorded as `aimed no`
  with a residual of 177 degrees and a coverage of 0 units.

Six checks were added to `scripts/route-test.mjs` for both halves -- six states
of `turnIsBlocked`, the mouse surviving four misses a death camera caused and
still turning the player after it, and a dead mouse being abandoned after
exactly two rounds. Measured on the runs of this pass, the turn landed on:

| run | firing legs | legs the turn did not land on |
|---|---|---|
| 8 attempts, before the fix | 34 | 2 |
| 8 attempts, after the fix | 40 | 3 |
| 20 attempts, after the fix | 86 | **1** |

The 8-attempt figures are too small to say anything on their own, and the three
misses in the middle row are all on legs the player *died* on -- the aim is
taken at the start of a leg, so a death that happens later in it cannot be
excused by this rule and is not claimed to be. What the 20-attempt run says is
that a walk can now be 86 firing legs long and lose its aim once.

#### The walk's own rate, which is where the corridor's cost is

A firing leg holds the trigger down for the whole of its step, so the leg's own
clock is the time the player is exposed. That clock is now in the report
(`held <ms>` on every firing leg, and a summary line), along with two things
that were being inferred rather than read:

* `ground covered per second with the trigger down` -- the leg's coverage
  divided by the time its trigger was down, which is the number that says
  whether the walk is walking or standing;
* `firing legs the turn did not land on` and `firing legs the engine had taken
  the keyboard off the game for`, counted rather than left to be spotted in the
  per-leg list, which now carries the engine's own `inGame`, `paused` and
  `keyDest` on every leg.

The engine's config was read out of its own file system to know what the player
*can* do: `set cl_run "1"`, so the player runs -- **300 units per second**. The
two runs that carry the clock:

| run | firing legs | ground covered | trigger-down time | units per second | deepest reading |
|---|---|---|---|---|---|
| 8 attempts, status bar read on | 40 | 8,612 | 53.1 s | **162** | `-804 944`, 1,142 short |
| 20 attempts, status bar read off | 86 | 16,651 | 62.7 s | **265** | `-952 1435`, 831 short |

**The status bar costs about 40% of the ground a firing leg makes.** The read is
a `Page.captureScreenshot` and an image decode taken inside the hold, and while
the screenshot is being encoded and sent the page is not running the game: the
keys stay down and the player does not walk. A leg in the open room of demo1
covers 306 units a second; the legs that cover least -- 23, 38, 48, 73, 77 and
92 units over the same 1.2 to 1.7 seconds, 14 to 75 units a second -- are the
legs in the corridor, and they are the legs that cost the health.
`QUAKE2_READ_HUD=0` turns the read off, and it is
the default only for the diagnostic: the health series is the one thing reading
it buys.

`QUAKE2_STEP_ROUNDS` is the other half of the same question. A leg's step was
one bearing held from where the player stood when the leg began -- up to
`walkReach` (240) units of route -- and half a second later the player is
somewhere else on a bearing that no longer points down the corridor. At
`QUAKE2_STEP_ROUNDS=2` the step is walked in two pieces with a `position()` read
between them, and the seconds piece re-aims at the leg's own route point from
where the player actually is. The keys never come up for it and the trigger
never comes up for it.

#### What is still between the walk and the exit

The exit's aim point is `-1776 1544 4`, the route from the spawn to it is
**4,693 units over 37 points**, and every report measures the walk as a
straight-line distance to that point. That number is not how much of the level
is left. At the deepest reading of the 20-attempt run, `-952 1435`, the player
is 831 units from the exit *through the air* -- and on the plan they are at
route unit **2,439**, because the route turns west and south before it turns
back east into the exit room. Mapped onto the route:

| run | deepest reading | straight-line short | route unit | of the route |
|---|---|---|---|---|
| this pass, 8 attempts, before the fixes | `-987 735` | 1,130 | 1,729 | 37% |
| this pass, 8 attempts, after them | `-804 944` | 1,142 | 1,938 | 41% |
| this pass, 20 attempts | `-952 1435` | 831 | 2,439 | **52%** |
| the pass before this one, its best of ten | `-951 1550` | 825 | 2,554 | **54%** |

**The furthest this project has ever got is 54% of the route, with 2,139 units
still to walk.** That is the honest shape of the blocker, and it is why a run
that reports "825 units short" has not nearly finished: the number is measured
across the level, not along it.

What ends a life is still the same thing and this pass moved it less than it
moved the aim. A life dies somewhere between route unit 1,700 and 2,500 -- the
west corridor and its north end, where the plan has one 552-unit straight from
`-936 432` to `-936 984` with the level's soldiers along it -- and the engine
restarts the level at the spawn, so the ground a life already covered is spent
again. Twenty attempts and 86 firing legs bought **52%**, against 54% for a run
of eight attempts the pass before: the extra attempts are not accumulating
anything, because a death takes the level back to the beginning.

#### What this pass did not reach

* **`demo1` was not finished**, on any of the three runs, and the engine said
  so each time. Nothing here reached the exit trigger.
* **The walk still cannot out-run the corridor.** At 265 units a second of
  trigger-down time -- the best this pass measured, and only with the status bar
  unread -- the 4,693-unit route is about 20 seconds of walking, and the file's
  own measurement of the corridor is that 100 health and no armour is a corpse
  after six seconds of standing still in it. A life does not have enough health
  to walk it, and nothing this pass found changes that. The two levers that would close
  that gap were both measured and neither is shipped: taking the level's own
  super shotgun, and routing over the level's health and armour. Every health
  and armour item within reach of the route was re-checked against the plan this
  pass, and the answer did not change -- the `item_health_large` at `-1176 1520`
  is the only one the walk passes, the two `item_health` at `-728 845` and
  `-728 880` are inserted into the plan for a 418-unit round trip each, and the
  two `item_health_large` at `-2156` are 290 units off the route line and have
  no walkable line to it at all (`map.path` answers `NO_ROUTE` from the nearest
  plan point, `-1896 1344`). The route's own health budget is about 200 against
  a corridor that costs about 200.
* **`QUAKE2_STEP_ROUNDS=2` is in the code and its run had not been read when
  this was written.** Its measurement is the one thing here that is a claim
  without a number behind it yet, and it is not counted above.

### The pass after that: the input path and the lag

This pass forked from `clawbox/team-s5p49gdb` and went after the one thing the
previous passes had been paying for without naming: **the harness, not the game,
was the thing that hitched whenever the bot shot.** The owner's report was that
the game lags and hitches on every shot. It does not: sampled from inside the
engine's own `requestAnimationFrame` while six `fire(120)` calls ran back to
back, the engine drew **47 frames with an average gap of 16.7 ms and a maximum
of 16.8 ms** -- a steady 60 Hz with no stall in it. What stalls is the control
loop that drives it.

**Per call, before and after.** Wall clock for one call, `demo1` running, 20
reads and 10 of each pair, measured with `lag-bench.mjs` (kept in the run's
evidence folder, not in the repository):

| Call | median | p95 | max | | median | p95 | max |
|---|---|---|---|---|---|---|---|
| `position()` | 31 ms | 48 | 48 | → | **1 ms** | 2 | 2 |
| key down+up | 53 ms | 58 | 58 | → | **3 ms** | 5 | 5 |
| `attackHold` on+off | 54 ms | 57 | 57 | → | **34 ms** | 38 | 38 |
| `fire(120)` | 203 ms | 227 | 227 | → | **135 ms** | 143 | 143 |
| -- of which overhead over the 120 ms hold | 83 ms | | 107 | → | **15 ms** | | 23 |
| `hudShot()` | 392 ms | 403 | 403 | → | **68 ms** | 75 | 75 |
| engine frames during 6 fires | 68 frames | avg 16.7 | max 16.8 | → | 48 frames | avg 16.7 | max 16.8 |

The burst of six fires took 1140 ms of wall clock before and 803 ms after, with
the same 16.7 ms frame cadence on both sides -- 720 ms of that is the six 120 ms
holds the caller asked for, so the harness's share of it went from about 420 ms
to about 80 ms.

**And the leg, which is the unit the owner actually sees.** One firing leg -- a
position read, the turn onto the soldier, the trigger down, the walk, the
status-bar read, the trigger up, a position read again -- costs **195 ms** of
control overhead at the median (269 ms at its worst of eight), against the
700 ms of trigger-down walking it wraps. Before this pass the same leg's
overhead was the 600-1000 ms that made every shot hitch, so it is roughly a
quarter to a fifth of what it was.

| One leg, hold 700 ms | before | after |
|---|---|---|
| turn onto the soldier | 415 ms (keys) | **26 ms** (mouse) |
| trigger down | 45 ms | **5 ms** |
| health read: capture | 732 ms | **85 ms** |
| health read: correlation | 294 ms | **69 ms** |
| trigger up + position | 50 ms | **3 ms** |
| **control overhead** | **~600-1000 ms** | **195 ms** |

The target this pass set itself was under 150 ms, and it did not reach it: 195 ms
is what a leg costs with the game running and firing under it. Where the rest
goes is now known rather than suspected, and it is two things. One animation
frame -- the read has to happen inside the engine's own frame, so it waits for
one, about 17 ms. And a normalised cross-correlation of ten 16x24 glyphs against
every column of three rows of a 1366-pixel strip, which is 41,000 correlations
and cannot be made much smaller without betting that the status bar stays inside
a narrower window of the canvas (measured: the health number's left edge sits at
x=525 of 1366, but the level behind it inks the whole width, so a window would
be a bet and not a fact).

**The cause was one line of design.** Every public call went through
`#withSession`, which resolved the target with a fresh HTTP `/json/list`, opened
a **new CDP WebSocket**, sent `Page.enable` + `Runtime.enable` +
`Page.getFrameTree`, polled up to 50 x 20 ms for the game frame's execution
context, and closed the socket on the way out -- and `focusCanvas` sent a real
left click, which is Quake's fire button, whenever the game was not already
pointer-locked. A firing leg (a turn, a fire, a status-bar read and a few
position reads) spent most of 600-1000 ms in that, sending no input at all.

Six changes, each measured:

* **One long-lived connection.** `#withSession` now reuses a single connection
  and settles the target, the frame, the contexts and the pointer-lock state
  once, on it. It is dropped -- and re-resolved from `/json/list` -- only when
  the socket dies, the target crashes, the game frame navigates away or
  detaches, or its execution contexts are cleared (a reload), all of which are
  watched as CDP events rather than checked per call. The cleared-contexts case
  is the one that has to drop the *connection* and not just the cached ids: the
  `evaluate` the game object carries closed over the ids it resolved at open, so
  clearing the cache alone would leave every later call naming a dead context,
  which this build answers `Invalid parameters` (measured).
* **The context wait is an event with a deadline, not a poll.** The
  announcement of a frame's execution context wakes the waiter in the same tick
  it arrives; `CONTEXT_WAIT_MS` (500 ms) is only there for a frame that never
  announces one. A target's *own* main frame does not wait at all: CDP's "no
  context named" is that frame's default world, so no id is asked for.
* **The focus click is not sent on faith.** The page watches its own
  `pointerlockchange` and pushes the state to the bridge over a
  `Runtime.addBinding`, so a game that holds pointer lock (this one does,
  measured: `document.pointerLockElement` is the canvas) costs nothing at all.
  The click is sent only when the page reports unlocked, which is the only case
  where it buys the lock back. `bridge.focusClicks` counts them.
* **Press and release share the connection**, because there is only one -- and
  the canvas centre is measured once per connection rather than once per mouse
  event.
* **The status bar is read out of the canvas in the page** (`canvasStrip`) rather
  than photographed through the compositor: one wrapped animation frame,
  `gl.readPixels` over the canvas's bottom 40 rows, flipped and PNG-encoded in
  the page. 68 ms against 392 ms, and it reads the same number: back to back on
  a live game the two paths returned health `1`, numbers `[1, 100]`, score
  0.639 and margin 0.192 -- identical -- and 30 reads in a row each carried a
  number. When the player is dead both paths read nothing at all, which is the
  behaviour and not a fault (there is no status bar to read). The screenshot
  path is kept as the fallback for a page with no readable WebGL canvas.
* **The rest of the health read was made cheap too**, which the capture alone
  did not do. `control/hud.mjs` re-read the level archive and re-decoded twenty
  PCX glyphs on *every* read (`loadDigits`), and re-rendered and re-centred the
  ten digit templates on every call (`coverage`, `correlate`): 49 ms and about
  20 ms of a read that cost 110 ms in total. Both are now done once per archive
  and kept, and the glyph's mean and variance are computed once instead of once
  per cell. Isolated, a health read went from 110 ms to **40 ms**, and
  `scripts/route-test.mjs` -- which paints status bars out of the archive's own
  digits and reads them back -- is unchanged at 132 checks, all passing.

**The tests, after the change.** `node scripts/route-test.mjs` runs **132
checks, all passing**; `node scripts/control-api-test.mjs` passes every route
("a 400x40 clip came back 400x40; the status-bar strip 1366x40 (canvas-pixels)
read 4,100"); `node scripts/engine-state-test.mjs` runs 35, all passing. One
assertion in `control-api-test.mjs` was changed rather than worked around: it
pinned `hudShot()`'s strip at exactly 48 rows, which is a property of the
screenshot path's viewport slack, not of the reading. It now pins what the test
was always about -- that the strip carries the band it was read with and has a
number in it -- so it holds for both capture paths.

**`demo1` is still not finished, and the engine said so.** A two-attempt run
(`QUAKE2_ATTEMPTS=2 QUAKE2_DEATHS=1`) reached 1224 units from the exit and ended
`"mapname" is "demo1"`.

**The 0-unit legs with the 177 and -126 degree residuals did not come back.**
That was the fault the previous pass traced (legs of `covered 0`, the aim
reported as `keys` with residuals of 177 and -126.83 degrees, the engine's own
position unchanged throughout). This pass's firing record is **11 legs, 11 of
them with the turn landed on the soldier**, every one of them turned with the
*mouse*, and residuals of 0.07, 0.29, -0.25, 0.12, 0.12, 0.24, 0.02, -0.14,
0.06, 0 and 0.14 degrees. Ten of the eleven covered ground (209, 42, 4, 219,
312, 193, 209, 176, 212, 149 and 203 units); the one 4-unit leg was aimed and
fired like the rest. 158 units covered per second with the trigger down. The lag
was not what was holding that fault in place -- it was the `face()` calibration
the previous pass fixed -- but the readings that used to make it look like a
stall are gone, and the legs are now cheap enough that a stall would be visible
as a stall rather than as a slow leg.

### The play pass: the reset that was not a start

This pass was a *play* pass: run `finish`, keep the game alive between attempts,
and repeat until the engine's own line says `"mapname" is "demo2"`. **The engine
never said it.** Every run in this pass ended with the engine answering
`"mapname" is "demo1"`, and the numbers below are what it did say instead.

**The first thing it said was that nothing had started.** The first run of the
pass stopped before walking a step, with

```
map after reset: q2demo1.dm2
result: could not start demo1; stopping rather than walking an unknown level
```

`q2demo1.dm2` is the engine's own attract demo: a freshly opened page boots into
it, and until a real level is loaded its `mapname` is that name. The `map demo1`
the reset sent had been mangled by the console's keystroke drop -- the echo in
the scrollback is `]ap demo1`, and the engine answered `Unknown command "ap"` --
so the level never loaded and `freshDemo1()` read the attract demo's name and
refused to walk. The same drop is documented above (`mo1`, `cheas 0`); what was
new here is that the *reset* trusted a single send, and a reset that silently
does not happen costs the whole run. `freshDemo1()` now asks again and checks
what the engine says it is running, up to `RESET_TRIES` (6) sends, and only then
hands the walk a level. Measured after the fix, on the same command:
`map after reset: demo1`, `player at: 128 -320 46`, the level's own spawn.

**What the walk did, once it was walking.** Five runs, all with `cheats 0`,
the fight's default `advance` mode unless noted, and the status bar unread
(`QUAKE2_READ_HUD=0` -- the read costs about 40% of the ground a firing leg
makes, and no firing leg in these runs made a damage decision from health):

| run | attempts | deepest reading | at | level restarts | firing legs | ground covered |
|---|---|---|---|---|---|---|
| `finish-3` | 24 | **1,006 short** | -979 930 | 18 | 90 | 9,982 |
| `finish-4` | 40 | **743 short** | -1037 1622 | 29 | 141 | 15,548 |
| `finish-retreat` | 24, `fireWhile:retreat` | **1,633 short** | -814 224 | 17 | 57 | 3,548 |
| `finish-5` | 60 | **901 short** | -952 1181 | 48 | 256 | 27,998 |
| `finish-6` | 60, status bar read **on** | **827 short** | -952 1475 | 48 | 237 | 45,985 |

**Kiting was tried and is worse.** `QUAKE2_FIRE_WHILE=retreat` walks the route
*backwards* while the trigger is down, away from the soldier being shot -- the
"fall back while firing" tactic. At the same 24-attempt budget as `finish-3` it
reached **1,633 units short against 1,006**, covered **3,548 units of ground
against 9,982**, and every one of its 17 deaths was between 1,500 and 2,500
units short, so no life ever got past the corridor's entrance. Backing away
while shooting buys the ground back at the price of the ground: the walk trades
its whole advance for the retreat and never arrives. `advance` stays.

**More attempts do not buy depth, and that is the finding of this pass.** Three
runs at 24, 40 and 60 attempts reached 1,006, 743 and 901 units short: the best
reading moves inside a 263-unit spread with no trend, while the deaths scale
with the budget (18, 29, 48 -- about three restarts for every four attempts in
all three). What more attempts buy is more *lives*, not a better walk: in the
60-attempt run, 256 firing legs over 48 deaths is a life that survives about
five of them, and then the corridor kills it and takes its ground back. The walk
is not plan-limited and not distance-limited -- it covered 27,998 units of a
4,693-unit route -- and 60 attempts did not change that. **Every death clusters
in the same place.** Of the 48 restarts in the 60-attempt run, 31 were between
1,000 and 1,500 units short of the exit, 16 between 1,500 and 2,000, and one
reached 901. That is the corridor, and it is the same corridor the earlier
passes describe: the walk survives the open ground and the pocket, enters the
corridor, and is ground down in it.

**Reading the status bar did not cost the ground, and it bought the health
series.** `finish-5` and `finish-6` are the same command at the same 60-attempt
budget with one difference: the second reads the status bar on every firing leg
(`finish`'s own default), the first was run with `QUAKE2_READ_HUD=0`. Read on,
the walk covered **45,985 units of ground against 27,998** and reached **827**
units short against 901 -- inside the same spread -- and it produced the fight's
own numbers: **151 of 237 firing legs with a health reading, 3,038 health spent
across them, 12.82 a leg**, the lowest the fight took the player to **1**, and
21 health left after the last firing leg. That is the corridor's price at this
budget: about 63 health a life against a level the earlier pass measured at
about 200 health of top-ups along the route. The "40% of a firing leg's ground"
the earlier pass attributed to the read is **not** reproduced at this budget.
What these numbers still do not say is whether the reader was *right* on each
leg -- the crops are the evidence for that, and none were kept in this pass.

**Two things the per-leg record says about the corridor.** First, the walk
stalls in the pocket: the trail shows four consecutive legs of one attempt at
`-464 20` (2,011 short) -- the dead-end pocket at `-427 111` the walker's own
note names -- before a leg breaks out of it. Legs spent standing against a wall
are legs spent being shot at. Second, of the 141 firing legs in the 40-attempt
run, **114 were aimed more than 120 degrees off the way the route goes** (2
between 91 and 120, 25 at 90 or less). The walker finishes the soldier it
started -- that is deliberate, and documented above -- and on this level the
soldiers it has walked past are behind it, so most of the shooting happens over
its shoulder while it advances. Whether that is what the health is being spent
on is not answerable from these runs: the status bar was unread, and the reader
is not trustworthy anyway (see below).

**The health reading: a phantom number, and the floor that rejects it.** No run
in this pass made a decision from health, but the reader was measured in the one
state where the engine's truth is known -- a fresh spawn, where the bar carries
exactly one number and it is 100. The reader returned that 100 (score 0.819)
**and a phantom `4` at x=662 (score 0.619)** read out of the bar's own art; a
picture of the strip (`hud-fresh-spawn.png`) put to the vision pass reads the
100 and no other number. With no confidence floor, a leg whose real digits could
not be read hands that phantom back as the player's health -- which is the `4`
the earlier pass's kept crop shows against a bar reading **100**. `readHealth`
now judges the whole number: a reading below **0.65** comes back as *no* reading
(`health: null`, which the fight report already writes as `?`) instead of as a
number nobody should trust.

The floor is deliberately **not** on `readBar`'s cells. That was the first
attempt and the review pass caught what it costs: a cell floor is what a number
is grown out of, cell by cell, so raising it does not reject a weak reading, it
*splits* one. Measured on bars painted from the archive's own digits with one
glyph dimmed towards the background: a `100` whose trailing `0` is faint reads
**`10`** (score 0.849) at a 0.65 cell floor and **`100`** at the 0.6 the cells
still use, and a `100` whose leading `1` is faint reads `0` at 0.65 and `100` at
0.6. A truncated number is worse than a phantom: it is a wrong value wearing a
good score. Verified after the correction, on a fresh live strip in the review
pass: the reader returns **100** at the default floor, **100** at
`numberScore: 0.8`, and **null** at 0.9 -- the miss that is the point -- with
`scripts/route-test.mjs` at all 132 checks. The measurement, the picture and the
verification are in `HUD-READING.md` in the run's evidence.

What is still **not** claimed is that the read is trustworthy under fire: one
state was measured, and the earlier pass's two crops where the bar and the
reading disagreed (`leg-a2l5-002.png`, **100** on the bar against a reading of
**4**; `leg-a2l7-004.png`, **25** against **80**) are the reason a per-leg
health number is quoted here with its crop and never steered on.

**The leftmost-wins rule was the fault, and the fix is measured off 38 live
strips.** `readHealth` took the leftmost number it could read, on the reasoning
that health is the first number on the bar. It is not: the bar's own *art* reads
as numbers too, and when the real digits were weak or absent the art to their
left won. Captured live off the running game with `hudShot()` -- the same pixels
the fight is handed -- and put to the vision pass as ground truth, strip
`crops/strip-002.png` shows the bar reading **100** beside the red cross, and the
old rule returned **1** (score 0.654, at x=227). In the second set the old rule
returned **1** for a bar whose only readable glyph was the *armour* number at
x=1265, and **1** again on a strip whose health number it could not read at all.

What tells them apart is where the number **ends**. Q2 draws health right-aligned
in a fixed field, so the number ends on the same column whatever its width. On
every strip where a health number was there to read -- **100, 78, 72, 71, 62, 47,
43, 13, 9, 6, 5** -- it ended on column **573** of the strip's 1366 (100 at x=525,
the two-digit values at 541, the one-digit ones at 557). The bar-art phantoms
ended on 557, 667, 678, 698, 717, 804 and 1281. `readHealth` now takes the number
that ends where the health field ends -- the surest of them when more than one
does -- and when nothing does, it returns `health: null`: a miss, which the fight
report already writes as `?`, instead of a number read out of the scenery. The
field is `573/1366` of the strip rather than a pixel count, so a resize scales it
with the bar; `healthFieldRight` moves it and `healthFieldRight: null` drops it.

Two things the review pass found in that fix, and fixed. The edge was computed
from the *decimal length of the value*, which is not how wide a reading is when
a run carries a leading zero: `digits [0,0]` is `0` as a value and two cells on
the bar, and on two of the kept strips the decimal length put that run's edge at
557 for a run that ends on 573 -- a run like `07` (value `7`) would have been
rejected by one cell. The edge now comes from the cells the reader grew, which is
what `readBar`'s own overlap rule already calls the span. And the fraction is a
property of the strip, not of the bar: `hudShot`'s screenshot *fallback* returns
the canvas slid left by `round(canvasWidth/2 - 360)` -- 323 px on this box -- so
reading that strip with the canvas fraction put the field 323 px off and every
read on the fallback path came back a miss; the fallback now hands over its own
fraction (`healthFieldRightForStrip`). Both are checked out of the archive's own
digit pictures -- the same technique `scripts/route-test.mjs` uses, but as a
standalone check in the review run's evidence, because `route-test.mjs` exercises
`readBar` and not `readHealth`.

Re-read through both rules on the identical 38 pictures: **36 readings unchanged,
2 changed, and both of those were wrong before** -- one bar-art phantom and one
armour number, now misses. `scripts/route-test.mjs` is at all 132 checks. The
before/after table, the strips and the reader are in the run's evidence
(`health-reader-before-after.txt`, `crops/`, `crops2/`).

The same field rule is what makes `fireWhile: "adapt"` mean anything: that mode
chooses between `advance`, `retreat` and `hold` on the *health the status bar
cost*, so while the reader was returning bar art and armour numbers it was
choosing on noise. What is still not claimed is that the digit is right: the
field rule decides *which number* is the health number, not what each glyph
says -- a `102` (impossible for health, which the level caps at 100) was still
read out of a real field placement, and that is a glyph-level fault this pass did
not touch.

**Nothing else was changed, and the review branch held nothing to fold in.**
`clawbox/run-gvr292q5` (tip `0c9744f`) was inspected commit by commit: its one
substantive change is gating `useHold()` and `attackHold()` on
`answer.echoFound` rather than `answer.ran` -- "the engine ran the command"
rather than "a dump came back" -- and this line already has that rule in both
methods (`control/bridge.mjs`). No substantive fix was left unlanded, so nothing
was taken from a branch that diverges everywhere else.

### What finishing `demo1` means

`demo1` is the first single-player level, "Outer Base" (`worldspawn` `message`),
and the only single-player map in the pack: `demo2` and `demo3` are the
deathmatch maps the demo shipped with. Its exit is a `trigger_multiple` brush
that fires `target_changelevel` `t37`, whose `map` field is `demo2$base1` -- that
is, "load `demo2`, and start the player at the entity tagged `base1`". The
`worldspawn` `nextmap` says the same thing, which is a good sign for a level and
is not guaranteed.

So finishing the level is one event with a visible consequence: **the player
walks into that trigger, the level runs its intermission, and the engine loads
the next map.** An agent can tell it happened without watching the screen -- the
`mapname` in `position()` stops being `demo1`, and the engine prints its new
`Map:` banner. Reaching the trigger is the whole of it. There is no key to fetch
on this level (`route.mjs` finds no `key_*` entity in it) and nothing else gates
the exit.

**Where the walk gets to, measured.** The spawn is `128 -320 32` and the trigger
volume is around `-1776 1544 4`, 2664 units away in a straight line. The route
from the spawn to the trigger is **37 points and 4,693 units** (`node
scripts/demo1-run.mjs plan`), and it opens two doors on the way in: `func_door
*31`, which `func_button *34` fires, and `func_door *32`, which opens on touch.

Walking it is a fight rather than a stroll, and the fight is what stops it. The
corridor west and north of the start room is covered by `monster_soldier` at
`-672 336 -16` and `-856 240 -16` and by `monster_soldier_light` at
`-856 584 -24`; the exit room by three more. **It has finished.** On one of the
four `finish` runs measured this pass the engine answered `"mapname" is
"demo2"`, and what that run exposed -- two defects that between them made the
proof unsound -- is in [the pass that finished
it](#the-pass-that-finished-it). The other three runs ended with the engine
still answering `"mapname" is "demo1"`, and the reason is measured below: it is
the fight, not the walk.

**Where the walk gets to, measured on this pass.** The pass before this one ran
ten `finish` attempts to completion. The deepest was `-960 492`, **1,331 units
short** of the exit, on 18 firing legs with 11 of them carrying a health reading;
the ten reached 1,331, 1,604, 1,611, 1,633, 1,685, 1,697, 1,699, 1,907, 1,983
and 1,989 units short.

**This pass did not beat that.** The best `finish` run of this pass reached
`-982 461 -1`, **1,343 units short**, and the engine's own answer at the end of
it was `"mapname" is "demo1"` -- not finished. Three complete runs were measured
this pass: 1,802 units short (ended `DEAD`, on a single missed respawn), 1,650
(`ATTEMPTS`), and 1,343 (`ATTEMPTS`). Two further runs were cut off by the
kiosk browser being taken over by hand mid-run, and are not counted.

What moved is not the distance but the mechanism, and it moved a long way:

| Measured per `finish` run | Before this pass | After |
|---|---|---|
| firing legs | 2, 2, 0 | **25** |
| firing legs with a health reading | 0 | **21** |
| level restarts the walk lived through | 1 | 5 |
| the aim landing inside 2 degrees | 0 of 18 | **12 of 25** |
| legs the player "died" on that were a strafe | 24 of 171 readings | **0 of 45** |

The aim row is the one number here that a later fix has moved underneath. A
review pass found that a *failed* aim's retry was handed the view from before
the first attempt turned the player, so it re-aimed at an error the first
attempt had already spent -- the 10-to-30-degree residuals in those same leg
records, and one of 109. That is fixed and pinned by
`scripts/route-test.mjs`; the 12-of-25 above was measured before the fix, and a
live run to re-measure it could not be made because the kiosk's game was being
played by hand for the rest of the session. The other three rows are unaffected
-- none of them goes through the retry.

The run that reached 1,343 covered 152, 332, 184, 312, 339, 263 and 236 units on
its firing legs -- ground the player used to spend standing still -- and its own
health series shows the fight being fought and sometimes won: 100, 9, 19, 5
(died), 6, 52, **104**, 80, 56, 27, 1 (died), 82, 8, 1, 64, 40. Health going *up*
to 104 is a pickup the walk happened to cross, and the falls are the cost.

**The one blocker that ends every run is the death penalty, not the walking.**
When the player is killed, `respawn()` presses fire and the engine restores its
autosave -- which on this box is the level's own start. Measured on the 1,343
run, from its own attempt starts: attempt 4 began at `-858 411`, **1,458 units**
into the route, and every attempt after a death began at `128 -320 46`, the
spawn: 4 of the 8 attempts were spent walking ground the walk had already paid
for. The player reaches the corridor 1,400 to 1,900 units in, is killed by the
level's own soldiers, and the walk starts again from the spawn. The fight is
what kills -- the per-leg health series above, 25 firing legs, health down to 1
on two of them -- and the restart is what makes the kill final.

So the route is not the problem and the harness is no longer the problem: an
attempt reaches the corridor reliably now, where before this pass half the runs
never left the start area (`0` firing legs, 9 restarts). What stands between
this build and `"mapname" is "demo2"` is that a level that kills the player
undoes the whole walk, and `finish` is allowed eight attempts, not eight lives.

**The last reading and the deepest one are different readings.** This was a real
fault and it is fixed: the walker's `position` is the last thing the engine
said, and after a level restart that is where the *corpse* was. Run 9 ended with
`position` at `-463 19 -19` and its deepest reading at `-960 492` -- **686 units
apart** -- and a report that printed one while meaning the other would have
understated the walk by two thirds of the corridor. The walker now returns
`deepest` next to `position` (`control/walker.mjs`, `deepestReading()`), and
`finish` prints both, says by how far they disagree, and names the attempt and
leg that took the deepest one.

What the traces and the regression checks pin down is the mechanism, and it is
narrower than "the walk never stalls" -- legs that cover nothing still happen.
Counted over the traced runs, the longest unbroken run of legs that moved the
player less than a unit fell from **7** (of the eight legs in one attempt -- an
attempt spent entirely standing still) to **3** and **2**, and the number of such
legs fell from 17 of 36 and 11 of 34 to 14 of 32 and 14 of 51. What is gone is
the attempt that stands still from end to end, and the frozen yaw that caused it;
what is left is a leg here and there against a wall, followed by a leg that backs
off and a leg that moves.

**The constraint now is the fight, not the traversing.** All ten runs ended on
the **restart budget** (`DEATHS`), each having lived through **nine level
restarts**: the player is killed, the level puts them back at the spawn, and the
walk covers the same ground again. The deepest, run 9, fired on 18 legs and the
turn landed on the soldier on 14 of them; it took the player from `128 -320 32`
to `-960 492`, through seven firing legs in a row without dying (the last four
of them holding 41 health), and then lost four legs in a row dying on each. What
stands between this build and `"mapname" is "demo2"` is that the player is
outgunned, not out-manoeuvred. The per-leg record says so directly: the aim
lands (0 to 6 degrees, at 95 to 365 units), the surviving legs cover ground (38
to 186 units each), and on the legs where two health readings are next to each
other the cost is **23 to 72 health per leg** -- more than one soldier's blaster
can do in half a second, which is the arithmetic of several firing at once while
the walker answers one of them.

**What the level's monsters do to a player, measured.** Two live experiments
on demo1 in the corridor, both with 100 health and no armour, both read off the
HUD in a screenshot (`position()` cannot report health -- see
[Reading the HUD](#reading-the-hud-controlhudmjs)):

| What the player did | Result |
|---|---|
| Walked in without firing, then stood still for six seconds | **Dead.** The death camera rolls and the view is level no longer |
| Walked the same ground in, then stood still for seven seconds with the trigger held down | **Alive**, at 43 health with 35 armour, a soldier's body and blood on the floor, and a level view |

The reading is not subtle: on this level it is *stopping* that kills, and the
fire button is what buys the right to stop. A leg that *walked* at a soldier
instead of the route was therefore the worst of both -- it left the plan, ended
against a wall beside the corridor, and stood the player still in the open (28
units covered in half a second, then none at all, then a corpse). The
fighting walker's `_leg` walks the *route* with the strafe key that keeps the aim
off it (`movementKeys`), and `walkRounds` keeps an ordinary leg to about 240
units so the decision to shoot is taken every couple of hundred units rather
than once a plan.

`finish` reports the fight as well as the walk: how many soldiers the level
holds, how many firing legs the run took, the health the player had left after
each of them, and -- when it does not finish -- both the **last reading** and
the **deepest reading** of the player's position, which are not the same number.

#### The pass that finished it

`node scripts/demo1-run.mjs finish` starts a fresh `demo1` with `cheats 0`, walks
the route with `control/combat.mjs`, and asks the engine which map it is on. On
the first run of this pass the engine's own answer at the end of it was

```
"mapname" is "demo2"
```

-- read back a second and a half after the walk gave up, and confirmed three more
times afterwards with a bare `mapname`, each read with the engine's echo `]mapname`
intact immediately above the answer and with `viewpos` from the same dump showing
the player standing in `demo2` (`246 2064 -233`, on the death camera that map
gives a single player). That is the finish: not a position the script believed it
had reached, but the level the engine says it loaded.

**What it exposed was not the walk.** The run reached `-1696 1539`, 80 units from
the exit's aim point, the engine loaded `demo2`, and the walk -- still reading its
own trail -- went on planning `demo2`'s coordinates on `demo1`'s grid for another
attempt and a half before giving up on `START_OFF_GRID`. Two defects made that
possible, and both were fixed this pass.

* **The proof could have been a false positive, and one of its commands silently
  did nothing.** `command()` cut the condump at the command's own echo, and when
  the echo was *not* there it fell back to the last `tail` lines of the **whole
  console scrollback** -- which is not this command's answer at all, but whatever
  the engine happened to print last. The console does drop keystrokes: on the
  first run of this pass `cheats 0` arrived as `cheas 0` and the engine answered
  `Unknown command "cheas 0"`. So the fallback and the drop together could report
  a `mapname` answer that a *different* command produced -- and a `mapname` whose
  own `t` was dropped would have been answered with the level name from a minute
  ago. `#askEngine` now retypes any command whose echo is missing (measured: the
  drop is intermittent, 0 in 14 typed commands afterwards), and an answer with no
  echo comes back as `output: []` with `reason: "NO_ECHO"` instead of somebody
  else's lines. Nothing in the repo pinned the old fallback -- `echoFound` was
  written and never read -- so this is a pure narrowing.
* **The walk could not tell that the level had ended.** `position().map` is not a
  live reading: the map name has no address in the image, so the bridge caches
  the last `mapname` the engine answered and gives it priority over everything
  else. `freshDemo1()` runs a `mapname` at the start of every run, so for the
  whole walk `position().map` returned `"demo1"` -- verified on the live engine
  by handing a bridge a stale `{name: "demo1", source: "mapname"}` hint while the
  engine was really on `demo2`: `position()` answered `demo1` and `mapSource
  "mapname"`, and the same call with the hint cleared answered `demo2` and
  `mapSource "console-log"`. The walker's `LEVEL_CHANGED` check had been in
  `control/walker.mjs` all along and could never fire. There is now
  `bridge.level()`, which asks the engine on its own console and returns what it
  said, and the walker calls it at the one moment the cheap reading cannot be
  trusted -- when the planner finds no route at all -- returning `LEVEL_CHANGED`
  instead of `START_OFF_GRID` when the engine names another level. A game with no
  console to ask (a stub in a test) answers nothing, so no test drives a console
  round trip it did not ask for.

**The finish is not yet reliable, and this is the honest number.** Three `finish`
runs were run to completion this pass. The first finished. The two after it, on
the fixed code and with the runner's defaults (`attempts 8`, `deaths 8`), did
not: their deepest readings were `-1648 1640 15`, **160 units short**, and
`-952 1481 -2`, **827 units short**, and the engine answered `"mapname" is
"demo1"` to both. The
fight record says why. The walk reaches the exit room's floor (`z 15`, inside the
trigger volume's `z` range) but the player is ground down on the way: health fell
to `1` on six of run 3's firing legs, one leg was recorded `DIED ON THIS LEG` at
`health 3`, and run 3 lived through **5 level restarts**. A death does not spend
an attempt -- it puts the player back on the level-start autosave at the spawn --
so a run is `attempts` independent trips down the same corridor rather than
`attempts` lives, and each trip carries only the health the spawn gives it. The
lever that exists today is the one the runner already exposes:
`QUAKE2_ATTEMPTS` / `QUAKE2_DEATHS`, the number of trips.

#### What the pass before this one could not do

The section above is this pass; the list below is the one before it, kept
because its reasoning still stands. It did not finish `demo1`, and the things it
did not reach are worth saying plainly rather than burying.

```
"mapname" is "demo2"
```

-- read back a second and a half after the walk gave up, and confirmed three more
times afterwards with a bare `mapname`, each read with the engine's echo `]mapname`
intact immediately above the answer and with `viewpos` from the same dump showing
the player standing in `demo2` (`246 2064 -233`, on the death camera that map
gives a single player). That is the finish: not a position the script believed it
had reached, but the level the engine says it loaded.

**What it exposed was not the walk.** The run reached `-1696 1539`, 80 units from
the exit's aim point, the engine loaded `demo2`, and the walk -- still reading its
own trail -- went on planning `demo2`'s coordinates on `demo1`'s grid for another
attempt and a half before giving up on `START_OFF_GRID`. Two defects made that
possible, and both were fixed this pass.

* **The proof could have been a false positive, and one of its commands silently
  did nothing.** `command()` cut the condump at the command's own echo, and when
  the echo was *not* there it fell back to the last `tail` lines of the **whole
  console scrollback** -- which is not this command's answer at all, but whatever
  the engine happened to print last. The console does drop keystrokes: on the
  first run of this pass `cheats 0` arrived as `cheas 0` and the engine answered
  `Unknown command "cheas 0"`. So the fallback and the drop together could report
  a `mapname` answer that a *different* command produced -- and a `mapname` whose
  own `t` was dropped would have been answered with the level name from a minute
  ago. `#askEngine` now retypes any command whose echo is missing (measured: the
  drop is intermittent, 0 in 14 typed commands afterwards), and an answer with no
  echo comes back as `output: []` with `reason: "NO_ECHO"` instead of somebody
  else's lines. Nothing in the repo pinned the old fallback -- `echoFound` was
  written and never read -- so this is a pure narrowing.
* **The walk could not tell that the level had ended.** `position().map` is not a
  live reading: the map name has no address in the image, so the bridge caches
  the last `mapname` the engine answered and gives it priority over everything
  else. `freshDemo1()` runs a `mapname` at the start of every run, so for the
  whole walk `position().map` returned `"demo1"` -- verified on the live engine
  by handing a bridge a stale `{name: "demo1", source: "mapname"}` hint while the
  engine was really on `demo2`: `position()` answered `demo1` and `mapSource
  "mapname"`, and the same call with the hint cleared answered `demo2` and
  `mapSource "console-log"`. The walker's `LEVEL_CHANGED` check had been in
  `control/walker.mjs` all along and could never fire. There is now
  `bridge.level()`, which asks the engine on its own console and returns what it
  said, and the walker calls it at the one moment the cheap reading cannot be
  trusted -- when the planner finds no route at all -- returning `LEVEL_CHANGED`
  instead of `START_OFF_GRID` when the engine names another level. A game with no
  console to ask (a stub in a test) answers nothing, so no test drives a console
  round trip it did not ask for.

**The finish is not yet reliable, and this is the honest number.** Three `finish`
runs were run to completion this pass. The first finished. The two after it, on
the fixed code and with the runner's defaults (`attempts 8`, `deaths 8`), did
not: their deepest readings were `-1648 1640 15`, **160 units short**, and
`-952 1481 -2`, **827 units short**, and the engine answered `"mapname" is
"demo1"` to both. The
fight record says why. The walk reaches the exit room's floor (`z 15`, inside the
trigger volume's `z` range) but the player is ground down on the way: health fell
to `1` on six of run 3's firing legs, one leg was recorded `DIED ON THIS LEG` at
`health 3`, and run 3 lived through **5 level restarts**. A death does not spend
an attempt -- it puts the player back on the level-start autosave at the spawn --
so a run is `attempts` independent trips down the same corridor rather than
`attempts` lives, and each trip carries only the health the spawn gives it. The
lever that exists today is the one the runner already exposes:
`QUAKE2_ATTEMPTS` / `QUAKE2_DEATHS`, the number of trips.

#### What the pass before this one could not do

The section above is this pass; the list below is the one before it, kept
because its reasoning still stands. It did not finish `demo1`, and the things it
did not reach are worth saying plainly rather than burying.

* **`demo1` was not finished.** `"mapname" is "demo1"` on every run that
  completed, this pass's three included; the deepest of them is `-982 461 -1`,
  **1,343 units short**. Nothing here reached the exit trigger. The blocker is
  named and measured above and it is not the walk: a death undoes the whole
  attempt, because the engine's fire-to-respawn restores the level-start
  autosave, so eight attempts are eight trips down the same corridor rather than
  eight lives. The obvious next move -- and the one this pass did not make,
  because it writes to the owner's save store -- is to stop throwing the walk
  away: quicksave on progress and load it instead of taking the autosave, or
  find the engine's `in_use`/health fields so the fight can be fought to a
  finish rather than to a schedule.
* **The fight's health series is not yet trustworthy leg by leg.** The series
  exists and is now populated (21 of 25 firing legs had a reading, against 0
  before the capture fix above), but the reader still mis-reads some live
  strips: of the four crops kept from a cut-off run, one read `100` correctly,
  two read a fragment of it (`0`, `7`) and one read a plausible but unverifiable
  `56`. `readHealth()` takes the leftmost cell in the row band without a score
  threshold, so a weak correlation to the left of the real number can win. The
  reading is good enough to show a trend and not yet good enough to quote leg by
  leg. The archive-painted checks in `scripts/route-test.mjs` all pass, so the
  reader is right about the font; what it is not yet right about is a lit,
  moving, 1,366-pixel-wide status bar.
* **Health, armour and ammo are still unread, from anywhere.** The fix that
  took position and angles out of the console has not been extended to them.
  They live in the game DLL's own edict and client structs rather than in the
  client's `refdef`, and this pass did not find an anchor for them that survived
  a check: `engine/game_baseq2.wasm` carries no name section either, and no
  candidate field could be made to change under a controlled action, so none is
  claimed. `player.health`, `armour` and `ammo` are `null` and `unavailable`
  names them. Reading the HUD off a screenshot is still the way to get them --
  see [Reading the HUD](#reading-the-hud-controlhudmjs).
* **The map name has no address in the image.** It is a heap-allocated string
  whose address moves between runs, so there is no offset to recover and none
  was shipped: `position().map` comes from the engine's console log or from the
  last `map` command the bridge issued, or from a `mapname` answer the engine
  gave, and `mapSource` says which. All three cost nothing, and all three mean
  the name arrives a little late on a cold start. It is
  not in the hot path's way -- the walk does not need it to *walk* -- but a
  caller that wants the name the instant a level starts should use
  `command("map demo1")`, which is what makes it immediate. The pass above found
  the other half of this: because a `mapname` answer is cached and given
  priority over the log, `position().map` can go on naming the level a run
  started in, and the walk *does* need the name for one thing -- to know that the
  level has ended. `level()` is the reading that asks the engine every time; see
  [the pass that finished it](#the-pass-that-finished-it).
* **`use` cannot be driven as real input on this build.** The engine has a
  `+use` command, and the bridge can find it, but the config in `/userdata`
  binds no key to it -- Quake 2 opens doors by walking into them -- so a real
  key event has nowhere to go. `useHold()` reports `reason: "NO_USE_BINDING"`
  and holds nothing rather than reaching for the console behind the caller's
  back; `{ console: true }` is the explicit fallback. Two things this pass did
  *not* do about it: it did not bind a key (that would edit the player's own
  config) and it did not find the engine's `in_use` flag to write directly
  (a full-heap differential across `+use`/`-use` did not produce a candidate
  that survived two cycles, so there is nothing to write to that this pass can
  stand behind).

#### The proof: a walk with no console

`console-free-test.mjs` is the live measurement, and it is kept with the run's
evidence rather than in `scripts/` because it drives a real game and is only
meaningful against one. It was run against this box's game on `demo1`, and it
reloads the page with `ignoreCache` first so that the hook under test is the one
being served.

| Check | Result |
|---|---|
| The live memory reading against the engine's own console probe, at six poses, `position({ verify: true })` | **agrees on 6/6** -- `trunc(memory)` equalled the six integers `viewpos` printed, position and angles, every time |
| 60 position samples taken the ordinary way | the engine never left the game: **0 non-game frames**, 0 transitions, 0 console keys sent by the bridge |
| One real walk leg (`face` + `walk` + `position`, three times) | **271 units covered**, 0 console keys sent, **0 non-game frames of 370** sampled from inside the engine's own frame loop |
| Console round trips per leg -- the same leg run against the committed bridge | **11 before, 0 after** (the before leg is `bridge-before.mjs`, taken from git, driving the same game) |
| Control: can the instrument see a console at all? | yes -- the same watch saw the committed bridge's console open for **50 of 412 frames**, 22 transitions |

The run was repeated four times and passed every time. The numbers that depend
on the live game moved between them -- 11, 13, 14 and 11 console round trips on
the before leg, 189, 263, 283 and 271 units on the measured walk -- which is
what numbers taken from a running game should do. The two that carry the claim
did not move at all: **0 console round trips and 0 non-game frames on the
measured leg, in every run.**

The control is the part that makes the rest worth anything. "The console was
never opened" is only a measurement if the instrument used to say so can see a
console being opened, and the before leg is that instrument watching the old
bridge do exactly what this pass removed.

Two things that only turned up by measuring:

- **A 100 ms timer sees nothing.** The console in the before leg is up for
  about ten frames -- a fifth of a second -- and while CDP is dispatching the
  keys the page's main thread is busy enough that `setInterval` callbacks do not
  fire. A timer-based watch reported zero non-game samples for a console that
  was demonstrably open (screenshotted mid-probe). The watch samples from the
  engine's own `requestAnimationFrame` loop for that reason.
- **The engine's log is written a few kilobytes late.** After a cold start the
  log holds `]map demo1` and nothing else: no `Map:` banner and no `"mapname"
  is "demo1"` line, because the engine only prints the latter when something
  asks for it and `qconsole.log` goes through C stdio. The map name from the
  log is therefore a slow answer, not a wrong one, and the bridge's own record
  of the level it asked for covers the gap.

It also prints **every engine position it read**, leg by leg, as
`a<attempt> leg <n>  x y z  short <units>`. That is deliberate: "where it
stopped" is an argument about a run, and this is the run's own record of where it
was, so a stall is visible in the output as a run of readings that do not move --
which is how the pocket fault in this pass was first seen, and how a reader can
check the claim rather than take it.

Two traps are worth knowing before reading any single run's "furthest position":

* **`CONTENTS_PLAYERCLIP` is not solid to this engine.** The planner used to fold
  it into its blocking mask, the way stock Quake 2's `MASK_PLAYERSOLID` does. On
  this build that walls the level off for no reason: a live player stands with
  their own origin *inside* a clip leaf (`0x08030000`,
  detail|monsterclip|playerclip) and walks on through it. Counting clip as solid
  put the whole of demo1 into a 128,221-voxel bubble around the spawn and reported
  `NO_ROUTE`; counting it as walkable produces the route above.
  `STOCK_PLAYER_SOLID` is exported for a caller that wants the stock mask back.
* **The straight-line walker slides.** `goto()` walks at its target and slides
  along whatever it touches, so from the start room it sometimes takes the corridor
  at `y -80` (which reaches `-929 420`) and sometimes the dead-end pocket at
  `-427 111`. That -- not a bad reading -- is why one run printed a furthest
  position near `-1007 495` and another stopped at `-427 111`: both positions are
  real, and the `-1007 495` one is the corridor. `walker.mjs`'s forward-only leg
  selection exists to keep a walk heading down the corridor instead of back up it;
  `maxLegDistance` is only a guard rail against one leg aiming the length of the
  level, because a *tight* cap (360) was measured to stall walks sooner rather
  than later.
* **A stall can be the view, not the geometry.** The single largest cause of a
  leg covering 0 units on `demo1` turned out not to be a wall at all. `face()`
  used to retire a turning method on *one* turn that came back as nothing, and a
  zero reading is what a dead player gives every time -- the death camera holds
  the view, so neither the arrow keys nor the mouse reach the player's own
  angles. Retire the keys on one miss, then the mouse on the next, and there is
  no method left: `face()` answers `NO_TURN` without sending anything, for the
  rest of the run. A player who cannot turn can only ever walk the bearing they
  happen to have, so `+forward` pushes them into the same wall at the same angle
  on every round of every attempt -- which is what the traced legs at `-427 111`
  show: unchanged yaw and 0 units covered, with `keysWork: false` and
  `mouseWorks: false` recorded on the same leg (`trace-r5.json`, legs 12 and 13),
  and `mouseWorks: false` with the keys on probation on the legs that followed
  (45 and 47). The same file shows the calibration recovering -- `keysWork: true`
  again within two legs, because of the probation rule this pass added -- and
  the plan's own way out sitting 92 units away the whole time. That is why a
  stall at a spot with 26 units of clear floor in five of
  eight directions is not a wall, and why the fix is in `bridge.mjs`'s
  calibration and not in the planner.

The save slots say the same thing. `save1` is a demo1 save whose player stood at
`-928 855 5`, on that corridor; `current` and `save0` are level-start autosaves
whose client state is zeroed, and they record no position at all.

### The HTTP API

`node control/server.mjs` (or `CONTROL_PORT=… node control/server.mjs`, or
`./scripts/control-server.sh` for a foreground try) serves one game on
`127.0.0.1:4233`. It prints the port it bound and a one-line `curl` to start
with. Every response has `Access-Control-Allow-Origin: *` and no caching. Bodies
are JSON objects of at most 64 KiB.

| Request | Answer |
|---|---|
| `POST /control/key` | `{"key":"w"}` taps it; `{"key":"w","down":true}` holds it and `false` releases it; `{"text":"map demo1","enter":true}` types a whole string and presses Enter |
| `POST /control/mouse` | `{"dx":120,"dy":0}` turns the view |
| `POST /control/click` | `{"button":"left"}` (the default), `"right"` or `"middle"` -- one press and release |
| `POST /control/attack` | `{"ms":500}` holds the fire button for that long and lets go (default 300, maximum 5000); `{"down":true}` and `{"down":false}` hold and release it explicitly. A real left-mouse-button event, which is what this build binds to `+attack`, so it opens no console and pauses nothing. See [The fight](#the-fight-controlcombatmjs) |
| `POST /control/status` (also `GET`) | `200` with the page's state as JSON, framing included |
| `GET /control/state` | `200` with the game's state as JSON: the map, whether a level is up, the position and angles, the save slots and the console log tail. Sends no input |
| `POST /control/state` | `{"probe":true}` also asks the engine over its own console for a live `viewpos`/`serverinfo` (input: the console is opened and shut again, which pauses the game while it is open). The live half of the plain `GET` comes from the engine's memory either way |
| `GET /control/health` | `200` with the CDP endpoint, whether the browser answered, and whether the game is there and how it is framed. Read-only, needs no game, and always answers |
| `GET /control/screenshot.png` (also `HEAD`) | `200`, `image/png` |
| `OPTIONS` on any of them | `204`, with the CORS headers |

```sh
curl -s -X POST 127.0.0.1:4233/control/key -d '{"key":"Escape"}'      # tap Escape
curl -s -X POST 127.0.0.1:4233/control/mouse -d '{"dx":60,"dy":0}'    # turn right
curl -s -X POST 127.0.0.1:4233/control/attack -d '{"ms":500}'         # hold the trigger for half a second
curl -s -X POST 127.0.0.1:4233/control/status                          # what the game is showing
curl -s 127.0.0.1:4233/control/state                                   # what the game is doing (no input)
curl -s -X POST 127.0.0.1:4233/control/state -d '{"probe":true}'       # ... and ask the engine live
curl -s 127.0.0.1:4233/control/health                                  # browser there? game there? framed?
curl -s 127.0.0.1:4233/control/screenshot.png -o screen.png
```

`/control/health` is the one to poll: it reports
`{"ok":true,"cdp":{"endpoint":"http://127.0.0.1:18801","reachable":true},"game":{"present":true,…}}`,
with `game.framed`, `game.hostOrigin` and `game.screenshotFrom` as `status()`
reports them. A closed game is a healthy API (`present:false`); only a browser
that cannot be reached makes `ok:false`.

Failures are JSON: `400` for a bad request, `503` (`GAME_NOT_RUNNING`) when the
app is not open, `502` when the browser cannot be reached, `504` when a route
ran past its deadline, `500` otherwise. A route that does not exist is a `404`,
and a wrong method a `405` with `Allow`. Nothing here can hang a socket: every
route runs under a hard 15 s deadline (`CONTROL_TIMEOUT_MS`), a body over 64 KiB
is refused, and a request whose headers or body never arrive is dropped
(`CONTROL_REQUEST_TIMEOUT_MS`), so the caller always gets an answer.

#### Keeping the HTTP API up

Nothing starts `control/server.mjs` on its own, so
`deploy/quake2-control.service` is a systemd **user** unit for it:
`Restart=on-failure`, `WorkingDirectory` at the app folder,
`ExecStart=/usr/bin/node control/server.mjs`, `WantedBy=default.target`. Install
it as yourself -- no root, no system unit:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/quake2-control.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now quake2-control.service
systemctl --user status quake2-control.service   # log: journalctl --user -u quake2-control -f
```

From a shell that is not your desktop session (an SSH login, a cron job), set
`XDG_RUNTIME_DIR=/run/user/1000` first, or `systemctl --user` cannot find the
session bus:

```sh
XDG_RUNTIME_DIR=/run/user/1000 systemctl --user enable --now quake2-control.service
```

Two things not to "fix" later:

- The API stays on `127.0.0.1:4233` only. It drives whatever the browser is
  showing, so anything that can reach it can play the game and read the screen;
  the loopback is the boundary.
- The control routes are deliberately **not** mounted on `server.js` (4231).
  That server *is* reachable through the ClawBox proxy, so putting `/control/*`
  there would publish the game's keyboard to the network. The two processes stay
  separate, and the API never serves game files.

### The MCP server

`mcp/server.mjs` is a stdio MCP server: JSON-RPC 2.0, one message per line on
stdin and stdout, `initialize` / `tools/list` / `tools/call`, and nothing but
protocol on stdout. It drives the bridge directly, so it needs no HTTP server
and no other process running than the browser showing the game.

| Tool | Arguments |
|---|---|
| `quake2_key` | `key` (a key to tap), or `down` to hold/release it, or `text` (a whole string to type) with `enter` to press Enter after it |
| `quake2_mouse` | `dx`, `dy` |
| `quake2_click` | `button`: `"left"`, `"right"`, `"middle"` -- one press and release |
| `quake2_attack` | `ms` (default 300, maximum 5000) to hold the fire button for that long, or `down` to hold and release it explicitly |
| `quake2_status` | -- |
| `quake2_state` | `probe` (optional): `true` asks the engine over its console for a live position; omit for a read that sends no input |
| `quake2_screenshot` | -- (answers with an image content block, `image/png`) |

A failed call comes back as a normal tool result with `isError: true`, so the
agent reads the reason rather than seeing the connection die. `quake2_state` is
the one an agent planning a level should call first: it says which map is up,
where the player is and what the engine's console has been saying -- and it says
plainly which questions Quake 2 cannot answer (see
[Reading the game's state](#reading-the-games-state)).

Register it with OpenClaw as a stdio server, pointing `command`/`args` at the
app folder (its own MCP settings file -- this app does not touch gateway
configuration):

```json
{
  "mcpServers": {
    "quake2": {
      "command": "node",
      "args": ["/home/yanko/Projects/quake2/mcp/server.mjs"],
      "env": { "QUAKE2_CDP_URL": "http://127.0.0.1:18801" }
    }
  }
}
```

`QUAKE2_CDP_URL` is optional -- it is the default, and the same value
`control/server.mjs` and the bridge use. Use an absolute path for the script:
an MCP client starts it with a working directory of its own choosing.

**Restart the gateway after changing that file.** An MCP client reads its server
list once, at startup, and spawns each server then; a new or edited entry is not
picked up until the gateway is restarted. This app never edits gateway
configuration -- the snippet above goes in the gateway's own settings file.

## Tests

The scripts use Node built-ins only (no `npm install`). The first two can be run
from anywhere:

```
node scripts/test-userdata.js    # the /userdata store: exit 0 pass, 1 fail
node scripts/e2e-saves.js        # the real game: exit 0 pass, 1 fail, 77 skipped
node scripts/control-api-test.mjs # every control route: exit 0 pass, 1 fail
node scripts/mcp-smoke-test.mjs   # the MCP handshake: exit 0 pass, 1 fail
node scripts/goto-test.mjs        # the navigation loop, live: exit 0 pass, 1 fail
node scripts/route-test.mjs       # the route planner, off the archive: exit 0 pass, 1 fail
node scripts/engine-state-test.mjs # what the reader makes of the memory: exit 0 pass, 1 fail
./scripts/quake-control-test.sh  # the live game over CDP: exit 0 pass, 1 fail
```

**`scripts/route-test.mjs`** needs no browser and no game: it reads
`baseq2/pak0.pak` and checks what the planner makes of it -- that all 34 inline
brush models are read and classified (four static, eight movers, the triggers
none), that a mover placed by its `origin` lands on it rather than at the world
origin, that a `func_explosive` standing in a gap the world tree leaves open is
still solid, that the exit volume and aim point agree with the trigger entity,
that a route inside the start area is found and a route to the exit is not (and
that the failure names the brushes nearest the point it reached), and that the
walker's `brushesNear` finds the door when standing in one and nothing when
standing in open air.

It also checks the fighting walker, all of it off the archive and with no
browser: that `movementKeys()` turns a bearing into the right forward/strafe
combination and never walks a player sideways at a soldier behind them, that
`levelShotReaches()` reaches a soldier on the corridor's own floor and not one
two storeys up or through the wall between two rooms, that `threats()` keeps to
its range and its arc -- and that a soldier behind the way forward *and out of
answering range* is not a target, while one behind and close enough to shoot
back at is -- orders what it finds by what the fight costs, honours a
caller's `skip` and returns nothing on a level with no monsters. It pins the
three faults that all look the same from outside -- a leg that covers 0 units:
that `clearWalk()` is blocked by the 16-unit brush that closes demo1's dead-end
pocket, that it is clear along the way the plan actually goes out of it, and
that it follows the *floor* down the route's own 52-unit step into the west
corridor, and down the longer chord from the start room that was rejected with
it, rather than the straight line between the two ends, which cuts the floor;
that a walk stopped at `-427 111` aims at the
plan's own way out of the pocket and not at the point beyond it through the
wall; and, on a stub whose `goto()` answers `reached` and leaves the position
alone, that the walker re-plans instead of spending the attempt standing on the
same 24 units, and that a level restart costs a restart rather than an attempt.

It also pins the two readings this pass added, again with no browser. That the
furthest reading is kept apart from the last one: handed a trail whose last
point is a corpse 500 units back from the deepest point, `deepestReading()`
returns the deeper one and says which attempt and leg took it there. And that
the status bar can be read: it paints a bar out of the archive's *own* digit
pictures -- on a background that is not flat, because the one the HUD really
sits on is a lit wall -- and reads every number back, including a health number
on a dark background and the same number on a lit one, and it checks that an
armour number (the archive's other family of digits) is read as armour and not
as health.

This pass added a third group, and it is the one about the harness rather than
the level: **a firing leg holds the trigger for the whole of it.** Against a
stub that records the order of every call, it pins that the press comes before
the turn and before any movement key, that the turn is the mouse's, that the
status bar is photographed between the keys going down and coming up, and that
the trigger is the last thing released -- the shape of the fix above, with no
browser. And **a missed respawn does not end the walk**: one stub whose respawn
fails once and then succeeds must be asked again and must not come back `DEAD`,
and one whose player never comes back must end on the restart budget with three
presses spent on each restart it was allowed.

And **a failed aim is retried against the view the player actually has**: a stub
whose first turn misses is checked to be asked again *without* the `from` it was
first handed -- `face()` skips its opening probe when it is given a view, and
that view is from before the first attempt turned the player, so handing it back
re-aims the second attempt at the error the first one has already spent. The
stub's retry ends 175 degrees from where the first attempt stopped, and the test
reads the leg's own keys back out to prove they were computed from the retry's
view and not the spent one. 120 checks in all.

**`scripts/engine-state-test.mjs`** needs no browser and no game either: it
loads `engine-state.js` into a Node `vm` sandbox with a synthetic WASM linear
memory standing in for the engine's, writes known floats at the offsets the
script publishes, and checks what it makes of them. 35 checks, in four groups:

- the offsets it reads are the ones it publishes, and a reading comes back as
  the floats that were written -- with `health`, `armour` and `ammo` still
  `null`, because a made-up zero there is worse than an honest gap;
- a memory too small to hold the offsets, and no engine at all, are reported as
  reasons rather than as values, and neither claims the player is alive or dead;
- `cls.key_dest` 0/1/3 are the game, the console and the engine's own menu;
- **which roll is a death.** Every roll the two measured populations can produce
  -- the whole strafe-lean band up to 2.0 either way, and the death camera's own
  40 -- plus the boundary, checked against *both* readers of the field: the page
  script's `dead` and `control/bridge.mjs`'s `deadFromRoll()`. The two have to
  agree, because the bridge decides for itself and a run can be driving a page
  that still draws the line at 1. It also pins the threshold into the gap the
  measurements leave: at least five times the largest lean, at most half the
  death camera.

**`scripts/control-api-test.mjs`** starts its own `control/server.mjs` -- one on
a free port the OS picks (`CONTROL_PORT=0`), and a second one pointed at a CDP
endpoint that is not there, for the error paths -- and exercises every route the
API has: `health`, `status`, `state` (plain and `probe`), `key`, `mouse`,
`click`, `attack` and `screenshot`. It asserts status codes and content types,
that a screenshot is a real PNG (signature, IHDR, dimensions, and `HEAD`
agreeing), and that failures are JSON with a code: an empty key, a non-numeric
delta, an unknown button, an `ms` that is not a number or is longer than the
hold the API will wait for, a body over 64 KiB, a body that is not JSON, an unknown route
(`404`), a wrong method (`405` with `Allow`), and `502 CDP_UNREACHABLE` for
every route when the browser is gone. It never touches the live API on 4233, the
game server on 4231 or `quake2-app.service`, and it stops only the two children
it started.

It needs **no game open**: the routes that only read or reject are checked either
way, and the ones that can only answer with a game open are `SKIP`ped with the
reason (no game in the browser) rather than failed. When a game *is* open they
run for real, with the least intrusive input there is -- a Shift tap (a modifier
changes no binding), a zero mouse delta, and the middle button, which Quake 2
leaves unbound -- plus the console probe `state({probe:true})` uses, which is
read-only in the sense that it sends no game input, and toggles the console shut
again once it has read the answer. (It does pause the game while the console is
open; that is why it is opt-in and nothing on the hot path calls it.)

**`scripts/goto-test.mjs`** is the one test that proves *navigation*, and it
cannot be faked: it drives the live game, reads the player's position out of the
engine's own memory (it no longer opens the console to do it), and checks that
the player really moved. It finds the game
and the running level, reads the running map out of the archive with `route.mjs`
and checks the player is inside that map's bounds -- so the archive and the
engine have to be talking about the same level -- then turns to a bearing and
asserts the engine's reported yaw agrees, walks and asserts the position changed,
runs `goto()` back to a point the player just stood on and asserts it arrived
within tolerance, and finally asks `goto()` for the level's exit from far away
with only two steps allowed and asserts it says `reached: false` with a reason
and a last position. That last step matters as much as the others: a navigation
call that claims an arrival it did not make is worse than one that fails. The
test moves the player a few hundred units and walks them back; it says so in its
own output.

It **skips rather than fails** in three situations, each with its reason printed:
no browser at the CDP endpoint; no game open; and a game that is open with a
level running whose player *cannot be driven* -- it turns with the arrow keys and
walks once before the navigation steps, and if neither moves anything it says so
instead of blaming `goto()`. The third case is real: finish `demo1` and the
engine drops the player onto `demo2`, a deathmatch map with no single-player
start, where the player ends up on a death camera and no key turns them. The gate
only skips when *nothing* moves, so a genuine navigation bug still fails loudly.
`game.command("map demo1")` starts a fresh level and the test passes.

**`scripts/mcp-smoke-test.mjs`** spawns `mcp/server.mjs` and speaks its real
transport to it: `initialize` (protocol version and server name), a
`notifications/initialized` that must produce no answer, `ping`, `tools/list`
(every tool, each with an object `inputSchema`), `tools/call` for
`quake2_status` and `quake2_state` (a well-formed result either way; `isError`
with a reason when no game is open), an **unknown tool call**, which must come
back as `isError: true` rather than a JSON-RPC error, a bad argument that must
not kill the stream, an unknown method (`-32601`) and a line that is not JSON
(`-32700`). It then asserts that **nothing but JSON-RPC ever reached stdout** --
a log line there would corrupt the stream -- and that closing stdin ends the
server with exit code 0. It proves the protocol, not the game.

**`scripts/quake-control-test.sh`** is the one test that needs the game **open
in the box's browser**, because that is what it drives: it starts nothing, stops
nothing and writes no saved game. It prints `PASS`/`FAIL` for six steps with the
raw evidence for each -- the CDP endpoint's target list, the game frame it
picked, the status JSON, the engine's own console transcript, the PNG's
signature and size, and the mouse deltas the frame reported -- and exits 0 only
when all six passed. It goes, in order:

1. The CDP endpoint answers, and the target list is printed.
2. The game's own frame is there (never the top-level ClawBox page).
3. The bridge reads the game's status.
4. A keypress reaches the engine: the test types `echo <marker>` and
   `condump <name>` into the in-game console over CDP key events, then reads the
   file `condump` wrote out of the engine's file system and looks for the marker.
   Those lines can only be there if the engine's input handlers really received
   the keys.
5. A screenshot comes back as a real PNG (signature, size, dimensions).
6. Mouse movement arrives with exactly the delta that was asked for.

It leaves the game playable: the console is shut again, taking the command it
typed with it, and the dump is deleted from the engine's file system (so nothing
is left in the save store either). It cannot start a game, and Quake 2 refuses to
open its console while it has none running -- the attract demo it boots into ends
after a few minutes and leaves the main menu up -- so when that is what happened,
the test reloads the page to bring the engine back (`app.js`'s own way back, with
the saved games restored from the server) and says so in its output before trying
again. `QUAKE2_CDP_URL` picks another endpoint, `QUAKE_CONTROL_OUT_DIR` says
where the screenshot goes (default: a new temp folder, kept and printed).

Each of the two Node scripts starts its own `node server.js` on 127.0.0.1:4299,
or on a port the OS picks when 4299 is taken, and never on 4231.
`QUAKE2_DATA_DIR` points
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
