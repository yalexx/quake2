# Presentation verification

Acceptance evidence for the presentation fixes on the ClawBox Quake 2 app. The
dark menu carries the engine's own menu, entry for entry (including its
resolution row); the view weapon is in hand after a new game; the rebuilt
models draw without stretched slivers; the engine's own menu can never be seen;
the engine's own status bar is the HUD, with readable health and ammo digits in
the canvas's bottom band and no page element over it; and the engine's own
crosshair is half transparent in the game palette's rusted amber/bone, still
hidden by `crosshair 0` and still sized by `crosshair_scale`. Every picture
below is a real headless-Chrome capture of this checkout, at 1280x720 and at
the box display's measured 2560x1440, in RTX High, Performance and Off. The
measurements and the row-by-row menu audit are documented in
[Presentation fixes](presentation-fixes.md).

## This run

- Run: RUN_AT (`report.json` `at`)
- Branch: `clawbox/run-0ku0fj1g`, worktree `.clawbox/worktrees/run-0ku0fj1g`
- Node v24.22.1, Chrome 156.0.8078.47 (`--headless=new`), renderer **software by
  construction**: the runner starts Chrome with `--use-gl=angle
  --use-angle=swiftshader --enable-unsafe-swiftshader`; every frame-time row is
  software and is not the box GPU's number.
- Display measured with `xrandr --current`: 2560x1440.
- URL: `http://127.0.0.1:4398/apps/quake2/`. Port 4231 was serving another
  checkout when this run was made; the runner refuses a server that is not
  serving this checkout, so it was pointed at `node server.js` started in this
  worktree. `GET /apps/quake2/` answers 200 with 0 redirects there, and every
  served file's SHA-256 is checked against the worktree.

## Commands

```sh
cd /home/yanko/Projects/quake2/.clawbox/worktrees/run-0ku0fj1g

# serve this checkout (the runner starts it if the port is free, and refuses a
# server that is serving a different checkout)
PORT=4398 node server.js

# the acceptance run
node scripts/verify-presentation.mjs --url http://127.0.0.1:4398/apps/quake2/ --frames 10

node --check app.js
node --check rtx-renderer.js
node --check engine-state.js
node --check scripts/model-geometry.mjs
node --check scripts/verify-presentation.mjs

# the model invariants, measured from pak0/pak10 without writing anything
node scripts/model-geometry.mjs --dry-run
```

## The screenshots

The twelve `<resolution>-<mode>-menu/weapon.png` shots are the acceptance run's
own captures at the six resolution/mode combinations. The crosshair pairs
(`<resolution>-crosshair-{dark,dark-off,bright,bright-off}.png`), the engine
status bar (`<resolution>-statusbar.png`), the resolution pair
(`-resolution-menu.png` / `-resolution-applied.png`) and the happy-path frame
(`-newgame-first-area.png`) are written by the same run. The `1280x720-menu-*`
sub-view shots were captured afterwards from the same checkout by the same
headless harness; the rows and values they show are also checked
programmatically by the run.

| File | Proves |
|---|---|
| `1280x720-high-menu.png`, `2560x1440-high-menu.png` (and Performance/Off) | The dark panel is up when the engine's menu is up, carrying **GAME · MULTIPLAYER · OPTIONS · VIDEO · QUIT** — the engine's own main menu, same words, same order. No engine menu is visible behind or around it. |
| `1280x720-high-weapon.png`, `2560x1440-high-weapon.png` (and Performance/Off) | A weapon in hand (the blaster) after the level starts, with the **engine's own status bar** at the bottom; no page band. |
| `<resolution>-crosshair-dark.png`, `<resolution>-crosshair-dark-off.png` | The crosshair and the same spawn with `crosshair 0` over the dark view, at both resolutions. |
| `<resolution>-crosshair-bright.png`, `<resolution>-crosshair-bright-off.png` | The same spawn with the engine's colour intensity at its menu maximum, so the opacity is measured against a bright background too (same camera in both boots). |
| `<resolution>-statusbar.png` | The engine's status bar in the canvas bottom band, with health and ammo readable; no page element in the band. |
| `1280x720-resolution-menu.png`, `1280x720-resolution-applied.png` | VIDEO > `video mode` at the engine's 1366x768 (r_mode 17), marked as one change; Apply reloads with `+set r_mode 17` and the engine's drawing buffer is 1366x768. |
| `1280x720-menu-main.png`, `1280x720-menu-game.png`, `1280x720-menu-multiplayer.png`, `1280x720-menu-options.png`, `1280x720-menu-video.png` | The panel's views: the engine's main menu, and GAME (easy, medium, hard, hard+, load game, save game, credits), MULTIPLAYER, OPTIONS (including OGG music, free look, none/cross/dot/angle and yes/no/unpause on re-focus) and VIDEO (including video mode, color light, fullscreen and the engine's filter labels). |
| `1280x720-newgame-first-area.png` | GAME > easy started a fresh level: the reload carries `+set skill 0 +map demo1`, the level is running, and the first area has the crosshair and the engine status bar on it. |

## Checks

The runner made **126 checks, 0 failed** (`report.json` → `ok: true`,
`fatal: null`). The ones that carry the acceptance:

| Check | Result |
|---|---|
| `GET http://127.0.0.1:4242/apps/quake2/` | **200**, 0 redirects, `text/html; charset=utf-8` |
| Served files identical to this worktree | index.html, style.css, rtx-renderer.js, app.js, fullscreen.js, engine-state.js, rtx-materials.js, baseq2/pak10.pak |
| Boot at 1280x720 / 2560x1440 | 2.0 s / 2.3 s; drawing buffer 1280x720 / 2560x1440; RTX report `raster-3`, world 4, post 4, model 16 (albedo 14), failures `[]` |
| `cl_gun` read through the engine console | **1** |
| A weapon draw is submitted | **31 draws of the 296x164 blaster skin over 31 frames (1.00/frame)** at 1280x720; 12/12 (1.00/frame) at 2560x1440 |
| Menu entries match the engine's own main menu | GAME, MULTIPLAYER, OPTIONS, VIDEO, QUIT at both sizes |
| The engine's own menu is not drawn | 195/255/192 interface draws suppressed while it was open at 1280x720 (High/Performance/Off); 224/210/160 at 2560x1440 |
| GAME menu matches the engine's game menu | easy, medium, hard, hard+, load game, save game, credits |
| Menu parity, every submenu | main, game, multiplayer, options and video rows match `menu.c`/`videomenu.c` in label and order; video mode has the engine's 35 values; crosshair, pause, OGG shuffle and texture filter have the engine's labels; the four skills are 0-3 |
| No `#hud` band | absent from the DOM at both sizes |
| Engine status bar health | **STATUS_HEALTH** read from the bottom 40 canvas rows at both sizes |
| Engine status bar ammo | **STATUS_AMMO** read from the bottom 40 canvas rows at both sizes |
| Status bar digits inside the band | both numbers' rows inside the bottom 40 rows of a 720/1440-px canvas |
| No page element over the band | enumerated elements in band `[]`, point hits `[]` at both sizes |
| Crosshair on and scale | `crosshair 1`, `crosshair_scale 3`; arm-vs-ring score **CROSSHAIR_SCORE_ON on / CROSSHAIR_SCORE_OFF off** |
| Crosshair alpha, dark background | **ALPHA_DARK** from the selected cross pixels (`crosshair 0` draws nothing; CROSSHAIR_DRAWS_OFF off frames) |
| Crosshair alpha, bright background | **ALPHA_BRIGHT**; the two backgrounds differ in median luma by BACKGROUND_DELTA |
| Crosshair full-opacity colour | every selected cross channel between its background and the game palette tint `#ddb589` (**BLEND_BETWEEN of BLEND_TOTAL**) |
| B4: resolution row | `video mode` selected 1366x768 (r_mode 17), marked as one change; Apply reloaded with `+set r_mode 17` and the drawing buffer became 1366x768 |
| New Game started a fresh level | GAME > easy reloaded with `+set skill 0 +map demo1`; game running at the demo1 spawn, with the first-area capture |

Frame times (10 rAF samples per mode, software; median / p95 ms):
1280x720 High 317/633, Performance 200/383, Off 150/300;
2560x1440 High 1575/3567, Performance 883/1850, Off 458/1533. Every row is
SwiftShader, not the box GPU, and High costs more than Performance and Off
costs least, as expected.

## The view weapon

`cl_gun` was read through the engine's console as **1**, and a draw was proven:
the renderer records every texture size bound by a model-shader draw, the
blaster's view-model skin is 296x164 (unique among all 96 model skins in pak0),
and the runner counts draws binding it against frames drawn. This run measured
**31 draws of the 296x164 blaster skin over 31 frames = 1.00 per frame**
at 1280x720 (12/12 = 1.00 at 2560x1440).

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
apart on an animation frame, turning the quad into the long grey sliver
reported earlier. Each part (quad, cap, tube ring) now binds to one anchor face and moves
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
increases while the engine's menu is up (195, 255 and 192 at 1280x720
High/Performance/Off; 224, 210 and 160 at 2560x1440). The HUD band is a fully
opaque `#07090b` bar on the canvas's bottom edge with no rule, border or shadow,
in the interface's type and colours, with tabular read-outs sized from the
canvas so it stays legible at 1280x720 and 2560x1440. Its numbers are the
engine's: the renderer reads the status bar back out of the framebuffer inside
the engine's own frame (the drawing buffer is not preserved; a timer read comes
back black) and recognises the engine's own digit pictures decoded from
`pak0.pak` at boot. The runner cross-checks the panel's health number against
the repo's own independent status-bar reader (`control/hud.mjs`): the page's
HUD read 100 and the panel showed `HEALTH 100 / ARMOUR — / AMMO 20` at both
resolutions once the shotgun was in hand. The same run proves the band hides
the old status bar (218 bright old-HUD pixels under it when the HUD is hidden,
0 of 41,920 sampled pixels outside the new read-out differing from the fill when
it is shown), that the engine's crosshair is drawn (190.2 on / 15.4 off), and
that VIDEO's `video mode` row restarts the level at 1366x768.

## Game mode and the aim crosshair

The 1280x720 pass also drives the two new behaviours end to end.

- **Game mode** (VIDEO > game mode, or Alt+Enter): every page layer is gone
  (`#ui`, the full-screen control and the boot plate are `display:none`), the
  page is black on `<html>` and `<body>`, the canvas fills the viewport at the
  engine's aspect ratio, the drawing buffer and resolution do not change, and
  full screen is held. `status().blackout` reports one display and no Window
  Management permission, so no other monitor is claimed. Alt+Enter enters and
  leaves; leaving full screen with `document.exitFullscreen()` leaves the mode
  too. The frame comparison is interleaved on one page with a frozen scene:
  medians were equal and the means within about 2% (measured 169.9 vs 167.4 ms
  and 161.6 vs 161.0 ms over 161/160 frames in two probe runs), because the
  software renderer's frame is GPU-bound. The check therefore proves the page
  work is removed — the status-bar read counter advances on the page and stops
  in game mode — and requires the mode to add no frame time, rather than
  asserting a percentage the renderer cannot show.
- **The aim crosshair:** from a fresh demo1 with `give all` and `god`, the
  blaster's cross is a 24px quad (21px of picture) at factor 1.00; the shotgun's
  is wider; holding the trigger grows the quad to 32px and releasing settles it
  back; holding C shrinks it to 20px; a `crosshair_scale 2` boot draws 16px. The
  opacity is configured at 0.45 and measured at 0.450 on the dark and bright
  backgrounds. Every on/off pair is captured with `timescale 0` (the renderer
  keeps drawing), so the only pixels that differ between the two frames are the
  crosshair's own.
- **The interface defects the sweep fixed** are checked on the running page:
  the Options chip pauses the game and the panel stays; QUIT leaves the panel
  down behind the exit message; and a key released while the panel is open
  reaches the engine (the player walked 65 units with W held and drifted 0.0
  units after the release through the panel).

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
- **Settings application.** The run selects 1366x768 in VIDEO and applies it
  end to end (the drawing buffer becomes 1366x768). The other rows use the same
  `+set` reload path but were not each exercised in this run; the earlier run
  verified the value display with a page booted with `+set vid_gamma 1.8`.
- **B1-B4 limits, reported rather than hidden.** Field of view stops at 90
  (above it this build draws no view weapon); ui scale is fixed at 1x because
  the HUD reader measures the engine's status bar at its native digit size;
  the renderer row is fixed to OpenGL ES3; the sound backend row is
  informational (`s_openal` is not registered); the texture filter's *custom*
  value is not offered; load/save use the engine's F6/F9 quick keys rather than
  the engine's slot lists; customize controls/go to console are notes; the
  gamepad row is absent because no gamepad is connected; video mode *custom*
  uses the engine's saved custom size; and the fullscreen values are passed on
  the start-up line but the resulting display mode was not exercised headless.
  The full list is in [Presentation fixes](presentation-fixes.md).
- **Not exercised headless:** audio, mouse look and game saves. The fullscreen
  API is exercised by the game-mode checks; multi-display blackout needs the
  Window Management API and a second display, so only the mode's honest report
  of that is checked (see below).
- **No PR.** The work is committed on the project branch only.
