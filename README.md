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
receiving CDP events, the same test fails at that step, and the fix is an
in-page hook in `app.js` driven over `Runtime.evaluate`.

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
same) plus `ControlError` / `GameNotRunningError`. Every call resolves the game
frame afresh and opens its own short-lived CDP socket, so a game that has
reloaded under it is picked up rather than talked to on a stale handle.

| Call | What it does |
|---|---|
| `key(key, down)` | Press (`true`) or release (`false`) one key: `"w"`, `"Space"`, `"Enter"`, `"Escape"`, `"F5"`, `"ArrowUp"`, `"Shift"`, `"`"`, `"-"` … Holding a modifier sets its bit on the events that follow, so `key("Shift", true)` then `tap("w")` sends a capital `W` |
| `tap(key)` | Press and release |
| `mouseMove(dx, dy)` | Turn/look by a delta. `dx` turns right, `dy` looks down |
| `click(button)` | `"left"` (fire), `"right"` or `"middle"` |
| `status()` | What the game is showing: the frame's URL, whether it is framed and by which origin (`framed`, `hostOrigin`, `screenshotFrom`), the engine's state, the canvas size, focus and pointer lock, and the CDP target behind it |
| `state({probe})` | What the game is *doing*: the map, whether a level is up, the player's position and angles, the save slots, and the tail of the engine's own console log. No input unless `probe: true` (see [Reading the game's state](#reading-the-games-state)) |
| `screenshot()` | A PNG of the game frame as a `Buffer` (cropped to the frame when the game is framed) |
| `typeText(text)` | Type a whole string, one key at a time: how a console command is entered |
| `evaluate(expression)` | Run an expression inside the game frame and get its JSON value back (an escape hatch: read `FS`, poke `Module`) |
| `position()` | Where the player is, which way they look and which map is up -- read from the engine's console, no page report |
| `command(text)` | Run a console command (or an array of them) and read the answer back |
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
doing, and Quake 2 offers exactly one way to ask: its own console. The Qwasm2
build exports nothing else (its wasm exports are libc and SDL, with no cvar or
command accessor), so console commands and the engine's console *log* -- which
the engine keeps inside its file system, at `baseq2/qconsole.log` -- are the
whole state interface. `state()` reads that log, so it sends no input at all;
`state({ probe: true })` additionally opens the console, types the two queries
Yamagi answers (`viewpos`, `serverinfo`), shuts it again and reads the answers
back out of the same log.

| Wanted | Reachable? | Where it comes from |
|---|---|---|
| Engine running, canvas, focus, pointer lock | yes | the page (`status()`) |
| Whether a level is up, and its map | yes | the console log (the `serverinfo`/`mapname` lines, the `Map:` banners) |
| Player position and angles | yes, with `probe: true` | the engine's own `viewpos` |
| Save slots on the engine's file system | yes | `baseq2/save/` |
| Health, armour, ammo, whether the player is alive | **no** | Quake 2 prints none of them: there is no console command for them, and the build exports no cvar or command accessor. They are drawn on the HUD, so read them from `screenshot()` |

The reply says so itself: `player.health`, `armour`, `ammo` and `alive` are
always `null`, `unavailable` names them, `note` says why, and `probed` says
whether the engine was asked. A `null` field here means the engine cannot answer
it, not that a read came back empty.

`probe: true` is input -- it focuses the canvas like any other control call and
opens the console for about a second -- and it toggles the console shut again
once it has read the answer. (The console is a plain toggle and the bridge
remembers nothing between calls, so a probe the engine did not hear leaves the
toggle wherever it found it.) Two engine habits are worth knowing:

- The engine writes `qconsole.log` through C stdio, so the file lags behind by a
  few kilobytes of output, and the cheap read is only as fresh as that. The
  probe does not read it: it asks the engine for a `condump`, which is written
  where and when the command runs, and deletes the dump again afterwards (the
  save store is synced from the same file system).
- Quake 2 can refuse the console key while it is playing a demo cinematic (the
  attract demo it boots into), and it drops the first keys of an engine that is
  still starting. When the console will not take the commands the probe reports
  `probed: false` with `probe.ran: false` rather than pretending, and it waits
  for no one -- call it again once a menu or a level is showing.

### Navigating: `position`, `face`, `walk` and `goto`

Pushing keys is enough to open a door and not enough to arrive anywhere. The
bridge closes the loop on top of the same console probe `state()` uses:

| Call | What it does |
|---|---|
| `position()` | Where the player is and which way they look, from the engine's `viewpos`, plus the map name from the `mapname` cvar and `dead`. Much lighter than `state()` -- no server info, no page report |
| `command(text)` | Open the console, run one command (or an array of them), read the answer back, close it. How a level is started (`map demo1`) and how a cheat is turned on, said out loud |
| `face(bearing)` | Turn the player to an absolute bearing, in Quake 2's degrees: `0` is `+X`, `90` is `+Y`, the yaw grows anticlockwise |
| `walk(ms)` | Hold forward for `ms` and let go. The primitive underneath `goto()` |
| `walkKeys(keys, ms)` | Hold several keys at once for `ms` and let go: forward *and* a strafe, which is how a player looks one way and walks another. What a firing leg uses |
| `goto({x,y,z}, opts)` | Turn towards a point, walk, read the position again, and keep going until the player is there -- or until the position stops improving |
| `use(ms)` / `useHold(down)` | The use key, as `+use` on the engine's command line: what opens a door, calls a lift and presses a button. Held rather than tapped, because a door opens when the player walks into it |
| `fire(ms)` / `attackHold(down)` | The fire button, as `+attack` on the engine's command line: the command behind every fire binding, so it works whatever the player's config says. Held for the same reason `use` is -- see [The fight](#the-fight-controlcombatmjs) |
| `jump()` | One tap of space, the engine's fixed-height jump |
| `strafe(ms, "left")` | Step sideways without turning: how a follower backs out of a corner |
| `respawn()` | Put a dead player back in the level by starting the level again (`how: "map"`). `{ how: "fire" }` uses the engine's own fire-to-respawn instead, which restores the autosave |

`position()` reports **`dead`**. A living player's view never rolls -- Quake 2 has
no lean -- so a non-zero roll is the death camera, and it is the only way to
learn the player has died, because this engine has no console command that
prints health (see [Reading the game's state](#reading-the-games-state)). It
matters more than it sounds: every movement key does nothing at all while the
player is dead, so a navigation loop that does not check it reads a death as a
wall. `respawn()` is the way back in, and it is not a cheat -- no noclip, no god,
no teleport; it starts the level again and the player lands on the level's own
spawn.

It deliberately does **not** press fire first. The engine's own fire-to-respawn
restores the autosave in `/userdata`, which is wherever the last session saved --
so a player killed at `128 -320 32` reappears 1300 units away inside the base
with no walk in between, and a walk that never happened is indistinguishable from
one that did. `{ how: "fire" }` asks for it anyway, and the result says
`note: "the engine restored its autosave"` when it happens.

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
-- a fixed rate that does not depend on the player's sensitivity cvar -- and on
this box's build the arrow keys turn the player while the relative-motion deltas
do not, even though the page receives them. (The mouse step in
`scripts/quake-control-test.sh` proves the *events* arrive; `scripts/goto-test.mjs`
proves what the engine then does with them.) `face()` measures the real rate on
its first turn and uses the measurement afterwards.

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
console is open, and the console is what these calls read through, so the
console is always shut again before a step is taken.

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
  rather than merely see.
* **`clearWalk()` has to follow the floor, and the point it hands back has to be
  one worth walking to.** Both were measured to be wrong in ways that look
  identical from outside -- a leg that covers 0 units:

  * Sampling the straight *chord* between two route points and lifting the body
    off it is only right while the floor is level. `demo1` drops 48 units in the
    24 the route takes to get from the start room down into the west corridor,
    and halfway along that chord the sample is *inside* the floor it is supposed
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
`-856 584 -24`; the exit room by three more. `finish` has never finished: every
run has ended with the engine still answering `"mapname" is "demo1"`.

**What changed is where it stops.** Before this pass a run ended in demo1's
dead-end pocket at `-427 111`, with the walker's own note naming the two
`func_wall`s it was standing against and the attempt budget spent on legs that
covered 0 units. Measured since, over seven `finish` runs and two traced ones, no
run spends an attempt standing still: the walk gets out of the pocket, down the
corridor and out the far side of it, and the deepest it has been measured is
`-951 1023`, **976 units short** of the exit -- 3,717 of the route's 4,693 units.

**The honest read of the numbers.** The seven `finish` runs after the changes
reached 976, 1,313, 1,554, 1,580, 1,604, 1,718 and 1,828 units short. One
`finish` run on the unchanged code reached 1,315, and two traced runs on it
stopped at 2,032 and 2,333 with the pocket named in the walker's own note. So the
best run is 625 units deeper than the best any earlier run reported (1,601), and
the *worst* of the new runs is not: the spread across runs is about 850 units, and
what a single run proves is limited. What the traces and the regression checks
pin down is the mechanism -- no leg covers 0 units at a frozen yaw, no attempt is
spent standing still, and the pocket is walked out of rather than walled into.

**The constraint now is the fight, not the traversing.** Three of the seven runs,
including the deepest, ended on the **restart budget** (`DEATHS`) rather than the
re-plan budget (`ATTEMPTS`), each having lived through **nine level restarts**:
the player is killed, the level puts them back at the spawn, and the walk covers
the same ground again. The run that got deepest fired on 20 legs and 18 of them
had the turn landed on the soldier, and it was still killed at `-951 1023`. That
-- not the geometry, and not the pocket -- is what stands between this build and
`"mapname" is "demo2"`.

**What the level's monsters do to a player, measured.** Two live experiments
on demo1 in the corridor, both with 100 health and no armour, both read off the
HUD in a screenshot (`position()` cannot report health -- see
[Reading the game's state](#reading-the-games-state)):

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
holds, how many firing legs the run took, and -- when it does not finish -- the
closest the player was ever *measured* to be to the exit, with the walker's own
last notes.

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
  on every round of every attempt -- which is exactly what the traced legs at
  `-427 111` show: unchanged yaw (`135`), 0 units covered, `keysWork: false` and
  `mouseWorks: false` in the same reading, and the plan's own way out 92 units
  away. That is why a stall at a spot with 26 units of clear floor in five of
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
| `POST /control/attack` | `{"ms":500}` holds the fire button for that long and lets go (default 300, maximum 5000); `{"down":true}` and `{"down":false}` hold and release it explicitly. The `+attack` console command, so it works whatever the fire key is bound to. See [The fight](#the-fight-controlcombatmjs) |
| `POST /control/status` (also `GET`) | `200` with the page's state as JSON, framing included |
| `GET /control/state` | `200` with the game's state as JSON: the map, whether a level is up, the position and angles, the save slots and the console log tail. Sends no input |
| `POST /control/state` | `{"probe":true}` also asks the engine over its own console for a live `viewpos`/`serverinfo` (input: the console is opened and shut again) |
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
its range and its arc, orders what it finds by what the fight costs, honours a
caller's `skip` and returns nothing on a level with no monsters. It pins the
three faults that all look the same from outside -- a leg that covers 0 units:
that `clearWalk()` is blocked by the 16-unit brush that closes demo1's dead-end
pocket, that it is clear along the way the plan actually goes out of it, and
that it follows the *floor* down the 48-unit drop into the west corridor rather
than the chord, which cuts it; that a walk stopped at `-427 111` aims at the
plan's own way out of the pocket and not at the point beyond it through the
wall; and, on a stub whose `goto()` answers `reached` and leaves the position
alone, that the walker re-plans instead of spending the attempt standing on the
same 24 units, and that a level restart costs a restart rather than an attempt.
78 checks in all.

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
leaves unbound -- plus the console probe `state` uses, which is read-only and
toggles the console shut again once it has read the answer.

**`scripts/goto-test.mjs`** is the one test that proves *navigation*, and it
cannot be faked: it drives the live game, reads the player's position out of the
engine's own console, and checks that the player really moved. It finds the game
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
