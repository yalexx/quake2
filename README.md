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
| `server.js` | Zero-dependency Node static server, 127.0.0.1:4231, serves `/` and `/apps/quake2/` |
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

## Run

```
node server.js          # http://127.0.0.1:4231/
```

The box serves it at `/apps/quake2/`.
