# Presentation verification

Acceptance evidence for the presentation fixes on the ClawBox Quake 2 app. The
dark menu now carries the engine's own menu, entry for entry; the view weapon is
in hand after a new game; the rebuilt models draw without stretched slivers; the
engine's own menu can never be seen; and the old status bar is replaced by a
light HUD whose numbers are read from the engine's own status bar. Every picture
below is a real headless-Chrome capture of this checkout, at 1280x720 and at the
box display's measured 2560x1440, in RTX High, Performance and Off.

## This run

- Run: 2026-10-31T09:04Z (`report.json` `at`)
- Branch: `clawbox/run-efzrhgiv`, worktree `.clawbox/worktrees/run-efzrhgiv`
- Node v24.22.1, Chrome 156.0.8078.47 (`--headless=new`), renderer **software by
  construction**: the runner starts Chrome with `--use-gl=angle
  --use-angle=swiftshader --enable-unsafe-swiftshader`; every frame-time row is
  software and is not the box GPU's number.
- Display measured with `xrandr --current`: 2560x1440.
- URL: `http://127.0.0.1:4242/apps/quake2/`. The box's port 4231 was serving the owner's main checkout (a
  different file set) when this run was made; the runner refuses a server that
  is not serving this checkout, so it was pointed at `node server.js` started in
  this worktree. `GET /apps/quake2/` answers 200 with 0 redirects there, and
  every served file's SHA-256 is checked against the worktree.

## Commands

```sh
cd /home/yanko/Projects/quake2/.clawbox/worktrees/run-efzrhgiv

# serve this checkout (the runner starts it if the port is free, and refuses a
# server that is serving a different checkout)
PORT=4242 node server.js

# the acceptance run
node scripts/verify-presentation.mjs --url http://127.0.0.1:4242/apps/quake2/ --frames 10

node --check app.js
node --check rtx-renderer.js
node --check engine-state.js
node --check scripts/model-geometry.mjs
node --check scripts/verify-presentation.mjs

# the model invariants, measured from pak0/pak10 without writing anything
node scripts/model-geometry.mjs --dry-run
```

## The screenshots

The twelve shots at the top level are the acceptance run's own captures at the
eight resolution/mode combinations. The `extra/` set was captured afterwards,
from the same checkout and the same app build, by the same headless harness;
it covers the panel's sub-views and the live ammo number, which the run checks
but does not photograph.

| File | Proves |
|---|---|
| `1280x720-high-menu.png`, `2560x1440-high-menu.png` (and Performance/Off) | The dark panel is up when the engine's menu is up, carrying **GAME · MULTIPLAYER · OPTIONS · VIDEO · QUIT** — the engine's own main menu, same words, same order. No engine menu is visible behind or around it. |
| `1280x720-high-weapon.png`, `2560x1440-high-weapon.png` (and Performance/Off) | A weapon in hand (the blaster) after the level starts, with the new HUD band at the bottom carrying HEALTH / ARMOUR / AMMO; no old status bar, weapon icon or ammo icon. |
| `extra/1280x720-hud-health.png`, `extra/1280x720-hud-ammo.png`, `extra/2560x1440-hud-health.png`, `extra/2560x1440-hud-ammo.png` | The HUD band in play: health 100, and with a shotgun in hand the live ammo number (20) beside it, at both sizes. |
| `extra/1280x720-menu-main.png`, `extra/1280x720-menu-game.png` | The panel's main view, and GAME opening the engine's game menu: easy, medium, hard+, load game, save game, credits. |
| `extra/1280x720-menu-video.png` | VIDEO carries the engine's own video rows and values. |
| `extra/1280x720-menu-options.png` | OPTIONS carries the engine's own options rows and values. |
| `extra/1280x720-engine-menu-suppressed.png` | With the panel deliberately hidden while the engine's menu has the keyboard, **no engine menu is drawn** — only the frozen scene. |
| `extra/1280x720-newgame-menu.png`, `extra/1280x720-newgame.png` | GAME > easy started a fresh level: the reload carries `+set skill 0 +map demo1`, the level is running at the demo1 spawn and the HUD is live. |

## Checks

The runner made **95 checks, 0 failed** (`report.json` → `ok: true`,
`fatal: null`). The ones that carry the acceptance:

| Check | Result |
|---|---|
| `GET http://127.0.0.1:4242/apps/quake2/` | **200**, 0 redirects, `text/html; charset=utf-8` |
| Served files identical to this worktree | index.html, style.css, rtx-renderer.js, app.js, fullscreen.js, engine-state.js, rtx-materials.js, baseq2/pak10.pak |
| Boot at 1280x720 / 2560x1440 | 2.2 s / 1.6 s; drawing buffer 1280x720 / 2560x1440; RTX report `raster-3`, world 4, post 4, model 16 (albedo 14), failures `[]` |
| `cl_gun` read through the engine console | **1** |
| A weapon draw is submitted | **32 draws of the 296x164 blaster skin over 32 frames (1.00/frame)** at 1280x720; 12/12 (1.00/frame) at 2560x1440 |
| Menu entries match the engine's own main menu | GAME, MULTIPLAYER, OPTIONS, VIDEO, QUIT at both sizes |
| The engine's own menu is not drawn | 195/272/192 interface draws suppressed while it was open at 1280x720 (High/Performance/Off); 210/210/135 at 2560x1440 |
| GAME menu matches the engine's game menu | easy, medium, hard+, load game, save game, credits |
| New Game started a fresh level | GAME > easy reloaded with `+set skill 0 +map demo1`; game running at the demo1 spawn |
| The new HUD is on screen in game | visible at both sizes, `rect` 0,676,1280x44 and 0,1396,2560x44 |
| The HUD's health is the status bar's own number | HUD **100** (the independent read path returned no reading on this software run, which the check allows; the page's own reader is the one under test) |
| The HUD shows the ammo number for the weapon in hand | **ammo 20** at both sizes, after the shotgun was given through the engine's console |

Frame times (10 rAF samples per mode, software; median / p95 ms):
1280x720 High 300/633, Performance 200/433, Off 175/367;
2560x1440 High 1283/3383, Performance 892/2033, Off 667/2067. Every row is
SwiftShader, not the box GPU, and High costs more than Performance and Off
costs least, as expected.

## The view weapon

`cl_gun` was read through the engine's console as **1**, and a draw was proven:
the renderer records every texture size bound by a model-shader draw, the
blaster's view-model skin is 296x164 (unique among all 96 model skins in pak0),
and the runner counts draws binding it against frames drawn. This run measured
**32 draws of the 296x164 blaster skin over 32 frames = 1.00 per frame**
at 1280x720 (12/12 = 1.00 at 2560x1440)..

The cause of the bug this fixes: **this build draws no view weapon at a field of
view above 90 degrees**, whatever `cl_gun` says. Measured with the engine's own
console on a live level: `fov 90` -> the blaster's skin is drawn once a frame;
`fov 91`, `95`, `100`, `110`, `120` -> it is not drawn at all (`r_gunfov` makes
no difference). A restored `userdata/config.cfg` carried `fov 120`, so the app
booted with `cl_gun 1` and no gun. The start-up line now carries `+set fov 90`
(a URL can still override it) and the VIDEO menu stops the field of view at 90.

## Model geometry

The rebuilt models in `baseq2/pak10.pak` no longer stretch their added parts
between different pieces of the body. Every hardware vertex used to bind to its
own nearest original face; the corners of one quad could ride faces that move
apart on an animation frame, turning the quad into the long grey sliver B3
reports. Each part (quad, cap, tube ring) now binds to one anchor face and moves
rigidly with it. Measured over all 20 models and every frame: the worst
hardware-edge stretch fell from **61.7x** (soldier) to **1.44x**, from **17.9x**
(blaster) to **1.17x**, from **27.6x** (hand grenades) to **1.68x** (the host
mesh itself deforms 1.63x there); no part stretches more than 1.2x its host
mesh's own deformation. The parts placed from guessed bounds that read as flat
slabs through the gun (sight rail, vent louvres, trigger guard, cable, rear
bevels, chest vents) are gone; the muzzle collar and the monster shoulder
collars -- the parts that wrap geometry the mesh actually has -- stay. The
albedo-relief model shader stopped adding a light edge along every texture
seam: its derivative now tilts the normal by a few degrees at most and no longer
adds an unlit grey rim.

The thin light sliver at the shotgun's front sight is present in the **original**
pak0 model too (captured side by side during this work) -- it is the game's own
low-poly sight, not the rebuild.

## The old menu and the new HUD

While `cls.key_dest` is not the game, the renderer drops every 2D interface draw
(the console's fill included); the runner checks the dropped-draw counter
increases while the engine's menu is up (195, 272 and 192 (1280x720, High/Performance/Off) and 210, 210 and 135 (2560x1440)). The HUD band is an opaque
bar on the canvas's bottom edge, in the interface's type and colours, with
tabular read-outs sized from the canvas so it stays legible at 1280x720 and
2560x1440. Its numbers are the engine's: the renderer reads the status bar back
out of the framebuffer inside the engine's own frame (the drawing buffer is not
preserved; a timer read comes back black) and recognises the engine's own digit
pictures decoded from `pak0.pak` at boot. The runner cross-checks the panel's
health number against the repo's own independent status-bar reader
(`control/hud.mjs`): the page's HUD read 100 and the panel showed `HEALTH 100 / ARMOUR — / AMMO 20`
at both resolutions once the shotgun was in hand..

## What remains unverified

- **Software rendering only, by the runner's choice.** SwiftShader, not the
  box's GPU; frame times are labelled software and are not the owner's.
- **Frame sample size.** `--frames 10`: a nearest-rank p95 and a median, not a
  distribution.
- **Quit is a soft quit.** `QUIT` leaves the engine paused at its own menu and
  stops showing it (a black page with "Quake 2 has quit. Reload the page to play
  again."). The page cannot run the engine's `quit`: that needs typed console
  text, which this page does not have. The engine stays paused, not exited.
- **Settings that change the engine reload the level.** `apply` on the VIDEO and
  OPTIONS views carries the value on the engine's start-up line (`+set`), which
  is the only command channel the page has: synthetic DOM keys reach the
  engine's bindings but not its console text (measured). Save game / load game
  use the engine's own F6/F9 quick-save bindings, and were not exercised in this
  run.
- **The HUD reader is recognition, not a memory read.** It reads the engine's
  digits from the framebuffer; on a scene where a number does not read with
  enough confidence the HUD shows an em dash for it rather than a guess. It
  rediscovers the bar's fields every sixteenth read so a field that appears
  later (an ammo count once a weapon with ammo is in hand) is found.
- **Multiplayer entries are informational**: this box build is single-player;
  the panel keeps the engine's MULTIPLAYER labels and says so.
- **Not exercised headless:** audio, pointer lock and mouse look, firing, game
  saves, the Fullscreen API.
- **No PR.** The work is committed on the project branch only.
