# Presentation verification

Acceptance evidence for the merged Quake 2 ClawBox app: it is served at
`http://127.0.0.1:4231/apps/quake2/`, boots straight into the game, draws a
weapon in hand (`cl_gun 1`) and renders the dark interface and the RTX-style
pass in **High**, **Performance** and **Off**, at **1280x720** and at the box
display's measured **2560x1440**.

The runner is `scripts/verify-presentation.mjs`; the machine-readable result is
`docs/presentation-verification/report.json`. All screenshots below are inside
this repository.

- Run: 2026-10-30T21:08Z (`report.json` `at`)
- Branch: `clawbox/run-3zv49pxg`, worktree `.clawbox/worktrees/run-3zv49pxg`
- Node: v24.22.1
- Browser: headless Chrome 156.0.8078.47 (`--headless=new`)
- Renderer: **software** — `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device
  (Subzero) (0x0000C0DE)), SwiftShader driver)`; every frame-time row is
  labelled software for that reason
- Box display measured with `xrandr --current`:
  `HDMI-A-1 connected 2560x1440+2560+0` → 2560x1440

## Commands

```sh
cd /home/yanko/Projects/quake2/.clawbox/worktrees/run-3zv49pxg

# serve this checkout (the runner starts it if the port is free, and refuses a
# server that is serving a different checkout)
node server.js

# the acceptance run: both resolutions, three lighting modes, 20 rAF samples
node scripts/verify-presentation.mjs

node --check app.js
node --check rtx-renderer.js
node --check fullscreen.js
node --check scripts/verify-presentation.mjs

# the model counts, measured from pak0/pak10 without writing anything
node scripts/model-geometry.mjs --dry-run
```

`verify-presentation.mjs` takes `--url`, `--out` and `--frames` (default 20;
`--frames` must be at least 10 so a p95 is meaningful). It exits non-zero when
any required piece of evidence cannot be produced: no Chrome, no HTTP 200, a
server serving a different checkout, a boot/renderer failure, a `cl_gun` that is
not 1, no weapon draw, a screenshot of the wrong size, or too few frame samples.

The final run's console output is
`docs/presentation-verification/logs/final-run.log`; it ends
`PASS — 72/72 checks`.

## HTTP and boot

| Check | Result |
|---|---|
| `GET http://127.0.0.1:4231/apps/quake2/` | **200**, `redirected: false` (0 redirects) |
| Content-Type | `text/html; charset=utf-8` |
| Served page | 6,110 B, contains `id="canvas"` |
| Served checkout | `index.html`, `style.css`, `rtx-renderer.js`, `app.js`, `fullscreen.js` SHA-256 identical to this worktree |
| Server | already running on 4231 for this run; the runner checked the files instead of starting a second server |

| Boot | Time | Drawing buffer | RTX report |
|---|---|---|---|
| 1280x720 (`?+set&r_mode&14&+map&demo1`) | 3.3 s | 1280x720 | `raster-3`, world 4, post 4, model 16 (albedo 14), sky 2, failures `[]` |
| 2560x1440 (`?+set&r_mode&25&+map&demo1`) | 1.8 s | 2560x1440 | same programs, failures `[]` |

The engine's own `r_mode` table is used (14 = 1280x720, 25 = 2560x1440); the
page is booted at that mode through its query string, so the drawing buffer and
the screenshot are the same size rather than a scaled canvas. No `vid_restart`
or cvar edit is needed for the resolution.

`cl_gun` was read from the engine's own console: **`"cl_gun" is "1"`**.

## Frame times

20 `requestAnimationFrame` intervals per resolution and mode, after the mode was
applied and two frames had been drawn. Median and nearest-rank p95; all numbers
are **software-rendered** and are not the box GPU's numbers.

| Resolution | Mode | Samples | Median | p95 | Median fps | Renderer |
|---|---|---:|---:|---:|---:|---|
| 1280x720 | High | 20 | 300.0 ms | 333.4 ms | 3.33 | software |
| 1280x720 | Performance | 20 | 200.0 ms | 216.7 ms | 5.00 | software |
| 1280x720 | Off | 20 | 150.0 ms | 166.7 ms | 6.67 | software |
| 2560x1440 | High | 20 | 1300.0 ms | 1466.7 ms | 0.77 | software |
| 2560x1440 | Performance | 20 | 866.6 ms | 883.3 ms | 1.15 | software |
| 2560x1440 | Off | 20 | 716.7 ms | 766.6 ms | 1.40 | software |

For completeness, the min/max of the 20 samples: 1280 High 166.7/333.4,
1280 Performance 66.6/250.0, 1280 Off 16.7/166.7; 2560 High 1266.6/1649.9,
2560 Performance 700.1/900.0, 2560 Off 699.9/783.3 ms. High costs more than
Performance and Off costs least at both sizes, as expected; the absolute values
are SwiftShader, not the GPU.

## Screenshots

Every file is a real `Page.captureScreenshot` whose PNG header was checked
against the requested viewport; the run fails if a screenshot is the wrong size.

| View | 1280x720 | 2560x1440 |
|---|---|---|
| Main menu, High | `docs/presentation-verification/shots/1280x720-high-menu.png` | `docs/presentation-verification/shots/2560x1440-high-menu.png` |
| Weapon in hand, High | `docs/presentation-verification/shots/1280x720-high-weapon.png` | `docs/presentation-verification/shots/2560x1440-high-weapon.png` |
| Main menu, Performance | `docs/presentation-verification/shots/1280x720-performance-menu.png` | `docs/presentation-verification/shots/2560x1440-performance-menu.png` |
| Weapon in hand, Performance | `docs/presentation-verification/shots/1280x720-performance-weapon.png` | `docs/presentation-verification/shots/2560x1440-performance-weapon.png` |
| Main menu, Off | `docs/presentation-verification/shots/1280x720-off-menu.png` | `docs/presentation-verification/shots/2560x1440-off-menu.png` |
| Weapon in hand, Off | `docs/presentation-verification/shots/1280x720-off-weapon.png` | `docs/presentation-verification/shots/2560x1440-off-weapon.png` |

The 1280 menu was visually checked: the dark Quake II panel with Resume, New
Game, Options, Controls and Quit, no error text. The 1280 High and Off weapon
shots show the first-person weapon in the lower right of a rendered sci-fi room,
with the `OPTIONS` chip, `Full screen` control and `Click to capture the mouse`
prompt; Off is visibly flatter and dimmer than the RTX modes.

## Weapon draw, not just `cl_gun`

`cl_gun 1` says the view weapon should be drawn; the run also proves a draw was
submitted. The renderer records the skin size of the **last model draw before
the first 2D (HUD) draw of each frame** — the engine draws the view weapon after
every entity and the HUD after that. The blaster's skin is `296x164`, a size no
other weapon or monster skin in `pak0` uses.

Result: `cl_gun` = 1, last-model skin `296x164`, **28 weapon-skin draws over 28
frames = 1.00 per frame**, candidate **Blaster**. The same renderer counted 84
model draws over the same 28 frames, so the weapon draw is one named draw among
the scene's models, not a stand-in for “models were drawn”.

## Merge and preserved work

The work branch was first fast-forwarded onto the live line
`clawbox/team-4jyiteaa` (`5d2b876`, which carries `48abd34`, `a2dc99a`,
`5d2b876`), then merged with `clawbox/run-brhmfvjt` (`ba4033a`, carrying
`45b075f` and `c0500ba`). Three files conflicted and were resolved semantically:

- **`index.html`** — the source branch's dark UI (boot plate, `#ui`, menu/pause
  panel, options with Off/Performance/High) plus the live line's fullscreen
  button and hint, `fullscreen.js`, and a single `?v=rtx5` cache-bust on the
  stylesheet and all four scripts.
- **`style.css`** — the whole dark interface plus the fullscreen control and
  hint rules. The removed `#render-settings` rules were dead: that element no
  longer exists; lighting moved into the menu's Options view.
- **`rtx-renderer.js`** — the live line's newer raster work is kept (world
  surface, sky gradient, haze, composite/bloom, vertex-normal model variant,
  `q2RTX`/`q2Material`, `raster-2` report fields) and the source branch's
  `q2ModelShade` albedo-relief variant is added beside it with its `q2Model`
  uniform. Both patched model shaders are classified and counted
  (`modelShaders` 16, `modelReliefShaders` 14), gated so Off restores the engine
  shader. Light/Performance/High are driven by the dark UI's
  `[data-lighting]` buttons; the report version is `raster-3`.

`app.js` merged cleanly (pak10 in `OPTIONAL_PAKS`, `+set cl_gun 1`, the dark UI,
mouse menus and pointer-lock handling), as did `scripts/model-geometry.mjs`,
`baseq2/pak10.pak`, `README.md` and `CHANGELOG.md`. No engine, map, sound or
skin asset was replaced or regenerated.

## Model geometry before/after

Measured by `node scripts/model-geometry.mjs --dry-run` (reads `pak0.pak` and
computes `pak10.pak` in memory; writes nothing):

**Totals: 4,433 → 25,090 vertices; 7,991 → 36,252 triangles** (20 models;
`pak10.pak` 13.61 MiB; the largest mesh is the tank at 1,646 vertices, under the
engine's measured 3,399-vertex cap).

| Model | Verts before → after | Tris before → after |
|---|---:|---:|
| weapons/v_blast | 158 → 940 | 260 → 1,236 |
| weapons/v_shotg | 138 → 1,124 | 252 → 1,312 |
| weapons/v_shotg2 | 221 → 1,372 | 378 → 1,804 |
| weapons/v_machn | 203 → 1,342 | 353 → 1,716 |
| weapons/v_chain | 136 → 1,104 | 240 → 1,264 |
| weapons/v_launch | 208 → 1,392 | 384 → 1,840 |
| weapons/v_rocket | 197 → 1,314 | 356 → 1,716 |
| weapons/v_rail | 185 → 1,318 | 350 → 1,704 |
| weapons/v_hyperb | 175 → 1,212 | 306 → 1,516 |
| weapons/v_bfg | 193 → 1,307 | 336 → 1,648 |
| weapons/v_disint | 193 → 1,307 | 336 → 1,648 |
| weapons/v_flareg | 188 → 1,301 | 354 → 1,708 |
| weapons/v_handgr | 213 → 1,430 | 406 → 1,928 |
| monsters/berserk | 322 → 1,429 | 614 → 2,540 |
| monsters/flyer | 215 → 830 | 362 → 1,484 |
| monsters/gunner | 329 → 1,432 | 610 → 2,524 |
| monsters/infantry | 240 → 1,118 | 460 → 1,924 |
| monsters/parasite | 287 → 1,106 | 498 → 2,028 |
| monsters/soldier | 227 → 1,066 | 434 → 1,820 |
| monsters/tank | 405 → 1,646 | 702 → 2,892 |

## Coverage: which weapons and enemies these captures cover

Coverage is computed from `baseq2/pak10.pak` (13 weapon models, 7 enemy models)
and from demo1's own BSP entity lump. **Covered** means the model is exercised
by the captured level: held in hand for a weapon, or placed as a pickup/monster
in demo1. It is **not** a per-frame visibility census: an enemy placed in demo1
may be off-camera in a given screenshot.

**Weapons (13).** Covered: **Blaster** (in hand — the build's starting weapon;
the screenshot and the 296x164 draw above name it), plus the pickups placed in
demo1: **Shotgun, Super Shotgun, Machinegun, Grenade Launcher, Rocket Launcher**
(placed, not held in the captured frame). Not covered: **BFG10K, Chaingun,
Disintegrator, Flare Gun, Hand Grenades, HyperBlaster, Railgun**.

**Enemies (7).** Covered by demo1 placement: **Infantry**, **Soldier**
(`monster_soldier`, `monster_soldier_light`, `monster_soldier_ss` all use the
soldier model). Not covered: **Berserker, Flyer, Gunner, Parasite, Tank** (those
appear in demo2/demo3, which this run does not drive).

The full per-model table, with the BSP monster classes, is in
`report.json` → `coverage`.

## Failure proof: `cl_gun` forced to 0

`app.js` line 129 starts the engine with `+set cl_gun 1`. For the proof it was
temporarily changed to `cl_gun 0`, then the same runner was run:

```sh
node scripts/verify-presentation.mjs --url http://127.0.0.1:4231/apps/quake2/ --frames 10
```

Result: **exit code 1**, stopping at the first required evidence:

```
FAIL cl_gun is 1 — 0 (expected 1)
verification failed: cl_gun is "0", not 1 — no weapon is drawn in hand
FAIL — 15/16 checks; report docs/presentation-verification/report.json
```

The full output is `docs/presentation-verification/logs/cl-gun-0-failure.log`
(it ends with the captured `EXIT=1`). `app.js` was restored to `cl_gun 1`, the
server re-served the restored file (the runner checks the served bytes against
the worktree), and the final run above passed 72/72 at both resolutions.

## Not verified / limitations

- **Software rendering only.** The headless browser had no GPU; SwiftShader's
  numbers are much slower than the kiosk Chrome on the box GPU and must not be
  read as the owner's frame rate. Every row says software.
- **Small sample.** 20 rAF intervals give a nearest-rank p95 and a median, not a
  percentile-tail measurement or a distribution.
- **One level, one weapon in hand.** Only demo1 is driven; the captured weapon
  is the Blaster. The five demo1 pickups are “covered” by placement, not held.
  Enemy coverage is placement in demo1, not per-frame visibility.
- **Not exercised headless:** audio, pointer lock and mouse look (the prompt is
  visible but no lock is taken), firing, saves/userdata, and the Fullscreen API.
  `fullscreen.js` is present and loaded, and the button renders, but fullscreen
  itself was not entered in this run.
- **The New Game menu path is not exercised** by this runner: the page is booted
  with `+map demo1` so the captured scene is deterministic. The menu is opened
  with Escape and Resume is used for every screenshot, so the panel's main view
  and its resume path are covered; the New Game button is not clicked.
- **Optional archives 404.** The app probes `baseq2/pak1.pak` and
  `baseq2/pak2.pak`, which this installation does not ship. The browser records
  two non-fatal network 404s per page load; they are kept in
  `report.json` → `networkErrors` and are not hidden. Required app files are
  hashed and checked separately.
- **No PR.** The work is committed on the project branch only.

## Files added or changed by this task

- `scripts/verify-presentation.mjs` — the runner (Node built-ins plus
  `control/bridge.mjs`; no packages).
- `docs/presentation-verification.md` — this document.
- `docs/presentation-verification/report.json`, `shots/*.png`, `logs/*.log` —
  the run's own evidence.
- Merge resolutions in `index.html`, `style.css`, `rtx-renderer.js`; `app.js`,
  `style.css`, `index.html`, `scripts/model-geometry.mjs`, `baseq2/pak10.pak`,
  `README.md`, `CHANGELOG.md` carried in from the source branch unchanged where
  their merge was clean.
