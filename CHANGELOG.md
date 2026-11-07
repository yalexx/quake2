# Changelog

## 1.2.4 — the owner's mobile HUD review

The owner marked up the 844x390 phone HUD (`design/mobile-hud-review.png`).
`docs/mobile-hud-review.md` turns the marks into six numbered acceptance
criteria, and every one is now measured in the live engine by
`scripts/mobile-input-gate.mjs`. The verification report is
`docs/release-1.2.4/README.md`.

* **Full screen moved into the menu** ("full screen needs to be in the menu
  not here"). The floating `Full screen` button and its hint are gone. VIDEO
  has a `full screen` row (on/off). Inside the desktop's sandboxed window the
  row reads `own window` and opens the app in a window that can fill the
  display. `scripts/mobile-fullscreen-test.mjs` enters and leaves full screen
  with a phone touch: 8/8.
* **The PAD button is gone** ("remove this dpad button"). MENU is now the only
  control in the top row. You can still put the on-screen pad away, from a
  new OPTIONS row, `touch controls` (shown only on touch devices). A
  "hidden" choice saved by the old button is dropped, so nobody is left with
  an invisible pad.
* **WPN works** ("the wpn buttons not doing anything"). The cause was a bug
  introduced in `5fa1aa7`: `app.js` `boot()` replaced `Module.arguments` and
  dropped the touch layer's `+exec q2touch.cfg`. As a result `[`/`]` kept
  `default.cfg`'s `invprev`/`invnext`, so the two buttons only moved the
  inventory cursor, which draws nothing, and USE (`e`) was unbound. `boot()`
  now keeps arguments that page scripts add. WPN is now one control that
  presses `/`, which `default.cfg` already binds to `weapnext`. Measured:
  `weaponIndex` 105 → 82 → 95 over two taps. With only the blaster, a note
  says there is nothing to switch to and the index stays put (61 → 61).
* **CROUCH, like the PC's C.** A hold control beside JUMP, in the same row
  and at the same size, bound to `c` (`+movedown`). Measured: the view drops
  24 units while held (view height 22 → -2), x/y do not move, and it comes
  back on release. Crouch-walking with the stick works too.
* **Fire, move and aim in one two-finger gesture.** FIRE doubles as an aim
  surface: the thumb holding it turns the view as it slides. Stick plus a
  sliding FIRE moved the player 674 units, turned 14.7° and fired (ammo
  159 → 128) in one gesture. A plain look drag still never fires: ±29.2° yaw
  and ammo 177 → 177.
* **Opacity.** Pad controls sit at 0.5 opacity at rest and jump to 1 under
  the finger. When the pad is put away (OPTIONS, the menu, portrait) nothing
  of it is drawn except MENU. No control reaches into the middle 40 % of the
  picture at 844x390 or 932x430. The portrait rotate card is unchanged.

A MENU tap the engine drops (seen right after a quick boot: the Escape went
out, key_dest stayed 0) is now sent once more after 400 ms and 6 drawn
frames. A tap on the pad also no longer turns into a click on the menu that
opens under the finger.

The input gate itself passes 45/45 on 1.2.4. The 1.2.3 tree fails it 31/34,
because of the WPN/USE bug above and because 5b sampled the jump only after
the button was released. 5b now samples during the hold too. The gate's console now waits
out the page's own boot-time console watch, which had closed the arming
console after a quick reload. New checks: L1–L3 (layout at three viewports),
5a/5e (WPN), 5h/5i (crouch), 5j (MENU), 6d (fire+move+aim), A1 (aiming
zone) and O1–O3 (opacity). 7b's second stick press now pushes back the way
the first came, instead of into the wall the first press reached. `server.js` also serves `/apps/quake2/` from a checkout folder
with a different name, so every suite can run in a worktree. The old
`scripts/mobile-controls-test.mjs` (97/97) and `scripts/boot-probe.mjs`
(17/17) now drive the new controls and check settings where 1.2.3 keeps them,
in `config.cfg`.

`scripts/store-package.mjs` builds the Store tarball reproducibly (the 1.0.0
exclusions: `docs/`, `assets/`, `baseq2/pak9.pak`), boots the extracted copy
on a spare port, and records its size and sha256. Nothing was published.

## Load Game, an audited menu, HD + RTX by default, and a measured frame loop

The owner's five reports, fixed in one tree, each with a command that proves it:
`scripts/load-menu-test.mjs` (Load Game end to end), `scripts/menu-audit-test.mjs`
(every remaining control), `scripts/perf-check.mjs` (the frame and menu numbers)
and the existing `scripts/verify-presentation.mjs`. All three new checks start
their own server with a fresh `QUAKE2_DATA_DIR`, a box-CSP proxy and headless
Chromium on free ports; the live app on 4231 and the kiosk browser on 18801 are
never touched.

### Load Game works end to end

The engine's own load menu was invisible because `rtx-renderer.js` drops every
2D draw while `cls.key_dest != 0` (the rule that keeps the old engine menu from
showing through the page panel), and the GAME row called a synthetic F9 instead
of opening anything. GAME > **load game** now opens a page-drawn **LOAD GAME**
view: every open re-reads `userdata/`, a slot counts only while
`baseq2/save/<slot>/server.ssv` exists, and rows are ordered `save0, save1…,
quick, current`, then named slots. The view shows `No saved games yet — save
with F6 or Save game.` when the store has none, joins the panel's roving focus
ring, and Enter works.

Choosing a slot shows `Loading <slot>…` and reloads with `+load <slot>` on the
engine's start-up line and **no** `+map` (a `+map` after the load wins the race
and starts that level). The engine runs the start-up save load itself: measured
`Loading game... / Savegame: loadproof`, and `scripts/load-menu-test.mjs` reads
demo3 back after making the save on demo3, reloading the page and clicking the
slot (and after pressing Enter on a focused slot). New Game drops a stale
`+load` the same way.

### The menu, audited

Removed: the engine's MULTIPLAYER view and its four note rows (this build is
single player); every row that only printed an explanation (`renderer`,
`sound backend`, `ui scale`, `customize controls`, `go to console`); the three
OGG-music rows (the archives carry no tracks); and four controls measured dead
or harmful in this browser build — `vid_fullscreen` never enters full screen (the page's
own Full screen control and game mode do), `r_vsync` gave identical frame times
on and off (1.0x, 233.3 ms p50 both), `r_anisotropic` never makes the engine
set the anisotropy extension (instrumented `texParameterf`: zero calls), and
`gl3_colorlight` is harmful: its "no" value makes the engine's own fragment
shader fail to compile (`assign: cannot convert from 'const int' to 'mediump
float'`, then `Loading ref_gles3.wasm as rendering backend failed` and a black
page — reproduced from a saved config with only that line). Kept: GAME
(easy/medium/hard/hard+, load game, save game, credits), OPTIONS (effects
volume, mouse speed, always run, invert mouse, lookstrafe, free look,
crosshair, pause on minimized, reset defaults) and VIDEO (video mode,
brightness, field of view, color intensity, overbrights, multisampling,
texture filter, reset to default), plus game mode and the three lighting
buttons. `scripts/menu-audit-test.mjs` proves each settings row's cvar
exists in the engine binaries, that a click + Apply writes a `set` line into
`config.cfg`, that the reload shows the new value, and that the engine itself
writes every applied value into the config it emits on quit. Effects that can
be seen are checked directly: resolution → drawing buffer, crosshair → draw
count, multisampling → `GL_SAMPLES`, fov → the start-up line.

Two measured pipeline facts came out of the audit. **`seta` is a player
command in this build**: the engine's own config has 175 `set` lines and no
`seta`, and `seta sensitivity 7.5` answers `Player: seta sensitivity 7.5`
without changing the local cvar — so the old "apply writes the config" idea
with `seta` would have been settings that did nothing. The patch writes `set`.
And **the start-up line has a hard limit**: 47 arguments booted, 50 answered
`argc > MAX_NUM_ARGVS` before the first frame. Settings therefore no longer
accumulate in the URL: a reload drops the query's `+set` pairs, the config
carries the settings, and the page rebuilds only what the video init needs
(`r_mode`, `fov`, `crosshair_scale`) onto the line. The forced
`gl3_colorlight 1` repair moved into the config patch instead. The line
measures 23 arguments at boot and 26 after New Game.

A third fact: **a minimal config shadows the packaged Qwasm2 defaults.** The
restored `config.cfg` lives in `/qwasm2/baseq2` and takes the packaged
`/baseq2/config.cfg`'s place, and that file is what executes `wasm.cfg` — the
WASD binds, `r_hudscale 1`, `vid_gamma 1.6`, `sensitivity 6`. A patch that
wrote only the changed `set` lines silently lost the bindings and left
`r_hudscale` at the engine's `-1` (auto), which also stopped the page's
status-bar reader: the HUD was no longer 15x23 cells, so it found no digits
(0 reads, 3 misses). A config with no `bind` lines is now written with
`exec "wasm.cfg"` first, then the applied `set` lines; the engine's own
config, written on quit, carries every cvar and bind and needs no exec.
Measured after the fix: `r_hudscale 1`, `sensitivity 6`, and the reader back
to 4 reads / 0 misses with health 100.

### HD and RTX on a first visit

With no saved `r_mode` the page starts the engine at **HD, `r_mode 14`
(1280x720)**; a saved resolution is read from `config.cfg` and carried on the
start-up line, so the player's choice survives a visit to the bare URL. **RTX
is on by default at Performance** (the preset built for this device's frame
budget; High remains one click away with its twelve-tap halo), and the choice
is stored under a new key so a profile that once had it off — the owner's
report — starts on again. The status line now says `RTX look · …` instead of
`Raster lighting · … no ray tracing`, which read as "off".

### Menu lag and frame time: what was measured, what changed

- **The menu scrim's `backdrop-filter: blur(2px)` was the menu lag.** It sits
  over a live WebGL canvas that keeps drawing behind the panel, so the
  compositor blurred the whole viewport every frame. On one page and scene,
  toggling only that filter measured **2.17 fps with it and 3.67 fps without
  (+69%)**, and main-thread task per menu frame **505 vs 295 ms (−42%)**. With
  the final build the menu measured **4.63 fps and 250 ms per frame, 113% of
  the game's own frame rate** on the same page (the blur had held it at 54%),
  and time-to-painted-menu fell from about 2.3 s to about 1.25 s. Layout and
  style work were measured at under 1 ms per window, so layout thrash was not
  the cause; the page ships no large images, so no texture was oversized.
- **The status-bar read-back was the per-second hitch.** It is a synchronous
  `gl.readPixels` plus digit recognition, measured at **257-304 ms at 1366x768
  / 1280x720**, run every 1.2 s for a number the page never displays (it is the
  control harness's reader). It is now **on demand**: nothing runs until a
  caller asks (`window.quake2Hud.read()`, `start()` or `readNow()`), so an idle
  page performs zero reads. A/B on one page, one scene and one preset: **4.3 fps
  and 233.8 ms task per frame with it off, 4.0 fps and 258.7 ms with it on**
  (+7.5% fps, −9.6% task). The reader also now does one `readPixels` for all
  three fields instead of three.
- **The HD default** is 8.9% fewer pixels than 1366x768: measured **4.2 fps vs
  3.8 fps** on the same scene, task 233.4 ms p50 both.
- **The shipped default measured**: 4.2 fps, frame p50 233 ms / p95 350 ms,
  234-250 ms main-thread task per drawn frame in headless SwiftShader. That is
  the only renderer available to headless Chromium on this box (ANGLE reports
  `SwiftShader`); the numbers are software-renderer numbers, and the main-thread
  deltas above are the part that transfers to the owner's GPU.
- **No quality was traded.** The resolution default is the HD the owner asked
  for, the RTX shaders, bloom, grade, textures, models, crosshair and status bar
  are untouched, and the two removals are invisible: a 2 px menu blur under a
  95% scrim, and a framebuffer read whose values no page element drew.

### Checks run

`node scripts/test-userdata.js` (20/20), `node scripts/engine-state-test.mjs`
(48/48), `node scripts/route-test.mjs` (196/196), `node
scripts/load-menu-test.mjs` (22/22), `node scripts/menu-audit-test.mjs`
(43/43, including 15 applied settings found in the config the engine itself
writes on quit), `node scripts/perf-check.mjs` (12/12) and `node
scripts/verify-presentation.mjs` (the presentation gate, run against a spare
port with its own server). The absolute frame rate is the box's own
software-renderer rate and moves with the box's load (1.8-4.6 fps at 1280x720
across this session, frame p50 233-483 ms); the before/after numbers claimed
above are paired measurements on one page, scene and preset.

The three texture suites (`tex-lib-test.mjs`, `texture-pack-test.mjs`,
`map-art-test.mjs`) need `assets/textures/`, which is not part of this
checkout, so they were not run here.

## Mobile input: six bugs fixed, one command proves them

The owner's phone report is fixed and measured: `< wpn` / `wpn >` switch the
live weapon (`weaponIndex` 105 -> 82 -> 105), a tap on the picture fires
nothing (ammo 200 -> 200, 0 new entities, 0 mousedown), JUMP raises z 33.25
units and lands, the thumbstick moves all eight directions at 70 % of the ring
(59.8–60.1 units each, 0 at centre), and a look drag turns yaw/pitch
(±31.152° / ∓18.215°) without firing or taking pointer lock. The desktop path
is unchanged: 1280x720, headful under Xvfb, pointer lock on `#canvas`, 5
trusted moves of 30/10 px turn yaw -21.116° and pitch +6.998°, a left click
fires (ammo 200 -> 194) and W moves 231.9 units.

The one command is
`CHROME_PATH=/opt/google/chrome/chrome node scripts/mobile-input-gate.mjs --phone`:
34/34 checks, exit 0, every assertion a number from the live engine
(`window.quake2Engine.read()`), every input a trusted CDP
`Input.dispatchTouchEvent` / `Input.dispatchMouseEvent` /
`Input.dispatchKeyEvent` — no page-side `dispatchEvent` drives a control. The
report, four 844x390 phone screenshots (`phone-landscape`, `phone-look-drag`,
`phone-menu`, `phone-portrait`) and the desktop shot are in
`docs/mobile-input-verification/`; the before/after table is
`docs/mobile-input-report.md`. The root cause was the engine's own canvas touch
path, which fired on any tap and took pointer lock; `#mc-look` is now a
full-picture capture surface, the touch page refuses pointer lock, and FIRE is
the only attack. `quake2Engine.read()` gained `weaponIndex` and `ammo` so the
gate can assert them. The slim Store tarball (pak0 + pak10 + engine + code,
no `docs/`, `assets/` or `pak9`) measures inside the 50 MiB cap; nothing was
published.

## Settings in the menu, a quiet boot, and view weapons at 2x

This pass finished the presentation work in four parts and then measured all
of it on one checkout: LIGHTING and OPTIONS moved into the menu panel, the
engine's console no longer greets the player on the first frame, full screen
is asked for only by its button, and all 13 view weapons ship 2x art with a
neutral albedo path. The twelve-command gate passed, and the Store tarball
came to about 47.0 MiB — roughly 3.1 MB under the 50 MiB cap (the exact bytes
are in `docs/release-2026-11-03/README.md`).

### The play layer carries no settings control

`LIGHTING` (Off / Performance / High, with the renderer's raster-lighting
status line) used to float over the game as a chip. It is now the last group
of the OPTIONS view inside `#menu`, beside the engine's own rows, and the
top-right OPTIONS control is gone with it. The PAD toggle (`#mc-toggle`) and
the Full screen button stay on the play layer; neither is ever shown while
the menu is open. Measured in the mobile suite: no `#ui > button`, no visible
`[data-lighting]` control over the game, three lighting buttons inside the
panel, and the panel's LIGHTING group reachable from the MENU control. The
desktop frame did not move: `#menu` 392 px wide, the 26 px heading, the
full-screen button at left 12 / bottom 52, and the canvas letterboxed to the
engine's aspect. On a phone at 844x390 and 932x430 the top row is PAD, MENU
and Full screen at 44 px each, no pair of them — or of them with the weapon
pair, FIRE, the stick or the hint — overlaps, and there is no horizontal
overflow.

### The first frame is the game's, and full screen has one door

A `+set` chain on the engine's start-up line is a command *session* to an id
Tech engine, and if one of those commands brings the console up the player
lands on a wall of text with the game paused. The line is load-bearing (the
page cannot type into the console), so the console is watched instead:
`window.quake2BootFrame` records who owned the keyboard on the first frame
the engine's surface was up. Measured on demo1: `keyDest` 0, `consoleOpen`
false, at 3,103 ms, and still the game after 5 s; the boot never showed a
console frame; every `+set` cvar was still on the line and the level started
with 175 entities. If a console does appear during boot the app closes it
with the engine's own Escape (one per quarter second) and records that it
had to.

Full screen is now only ever requested by its own button: `fullscreenElement`
is null after load, still null three seconds after the first click on the
canvas, and a second click does not take the screen either. The button enters
full screen and Esc leaves it, and its `aria-pressed` follows both.

### View weapons: 2x art, colour restored, the pistol collar fixed

All 13 first-person weapon skins in `baseq2/pak10.pak` are exactly twice the
pak0 picture (12,118,560 -> 13,770,565 bytes, +1,652,005): the palettes are
byte-identical, the cut-out is exactly the 2x2 expansion, and mean saturation
over opaque texels rises from 0.315 to 0.327 (every weapon rises). The added
muzzle collar is bound to the barrel face it rides instead of a shared guessed
atlas patch: worst material mismatch 20 (was 176), worst edge 68.3 (was 203),
and 18 of the pistol's 20 added parts are bound to their own face — the light,
fringed block the reference marked is gone. `rtx-renderer.js` draws view
weapons through a neutral albedo path (`weaponNeutralDraws`), so a weapon
reads as weapon steel instead of taking the room's colour and turning grey.
The engine's HUD, status bar and digit reading are untouched, and the desktop
1280x720 presentation is unchanged apart from the settings removal and the
boot/full-screen behaviour above.

### Verification — `docs/release-2026-11-03/`

Run on this checkout, with its own server on port 4391 and its own headless
Chromium on spare debugging ports (never 4231 or 18801). Every command exited
0: `engine-state-test` 35/35, `route-test` 196/196, `control-api-test` PASS
with every route exercised against a live game on this checkout's own server and browser (nothing in the kiosk was driven),
`mcp-smoke-test` PASS, `mobile-controls-test` 95/95, `verify-presentation`
248/248 checks, `boot-probe` 16/16, `weapon-verify` 51/51 checks,
`tex-check --only models/` 125 pictures with 0 wrong size / 0 unreadable / 0
unclaimed, `texture-pack --dry-run --only models/` 125 packed and 0 failed,
`model-geometry --dry-run` 13 skins at 2x with 4,433 -> 18,034 vertices and
7,991 -> 32,724 triangles and nothing written, `texture-audit --select` 20
entries selected. Logs and reports are beside the note.

### The Store package measured 1.1.0

The tracked runtime files with `docs/`, `assets/` and `baseq2/pak9.pak` left
out — 80 files — pack to **about 47.0 MiB** (49.32 MB) with `gzip -6`, about
**3.1 MB (2.96 MiB) under** the 50 MiB cap of 52,428,800, and about 3.67 MB
(+8.05 %) above the published 1.1.0 package of 45,650,125. The exact byte
count of the committed tree is in `docs/release-2026-11-03/README.md`: this
changelog is one of the files packed, so a byte-exact figure here would be
measuring its own text. The pak10 delta is +1,652,005 bytes raw and +887,685
bytes with `gzip -6` alone — the 13 added 2x PCX entries. Nothing had to be
dropped. If the package ever needs to shrink, the two `design/` reference
PNGs are 3,115,810 bytes no runtime path reads (about 46.2 MB without them);
`pak9` is already out and would add 41,205,225 bytes back. `.gitignore` and
the git index were not changed, and nothing was published or pushed.

### Fixed (tests only; no app code changed)

- **The acceptance runner waited for a skin the engine no longer binds.** It
  read the view weapon's skin from `pak0` and required a 296x164 blaster draw,
  but the engine mounts `pak10` after `pak0` and the 2x set makes that draw
  592x328 — measured as "0 draws of the 296x164 blaster skin over 17 frames".
  A model skin is now resolved from pak10 first (pak0 as fallback, `base.pcx`
  included for v_flareg), the drawn size is checked unique among every model
  skin in both archives, and the report says which archive supplied it.
- **The mobile suite's USE check measured a scene that does not exist.** It
  aimed at "func_button *7's model centre" at (1692,1408); the map's own
  entity lump puts *7 at (640,253,-414), 1,606 units from the spawn. It then
  counted *any* entity that moved as a door opening, which a wandering monster
  satisfies and no button there can. Measured on this build: from 43 units in
  front of demo2's func_button *43, with the aim swept from 10 to 50 degrees
  down, a trusted E press, the engine's own `+use` command and the touch
  button all left every entity in place. The check now proves what the control
  does promise: the engine's own `q2touch.cfg`, read out of the engine's file
  system, binds `e` to `+use`; the USE button presses exactly that key (a
  synthetic down and up); and the game keeps the keyboard and the player.
- **Two presentation checks retake instead of failing on a lost input.** The
  first-show hint is measured while it is up (it hides itself after 9 s, which
  a loaded box outlived); a dropped trigger press is pressed again (measured:
  `fireLevel` 0.00 for 8 s on one press, 0.99 on the next); and a crosshair
  on/off pair captured with the page menu up — two pictures of the menu, mean
  luma 6.2 — is retaken with the menu closed.
- **The weapon verifier typed commands into the game when its console toggle
  was lost.** A command whose console never opened was typed into the game as
  keystrokes; a movement key left down then walked the player for the rest of
  the run (measured: the view moved 300,481 pixels between two captures, every
  weapon stayed the shotgun, and `use …` came back `ran=false`). The console is
  now opened and confirmed before typing, the movement keys are released
  before a retry, and a cvar read that echoes with no value — measured as
  `]cl_gun` followed by `==== ShutdownGame ====` in the second after the first
  frame — is retried instead of reported as a null cvar.

## The game mode, measured; the aiming crosshair, finished

This run picked up the stopped branch at `53c43e4` and finished its three
outcomes: it made the game mode's saving a measurement rather than a claim,
fixed the two acceptance checks that the extended suite could not pass, and
swept the page once more for state and per-frame defects.

### The game mode is measurably cheaper per frame

The earlier pass could show only that game mode adds no wall-clock frame time:
in the headless software renderer the frame is GPU-bound, so the page work the
mode removes hides under the render. This run measured the main thread instead.
On one page, one frozen scene and one full-screen state, six ten-second blocks
alternated page and game mode; CDP's Performance domain gave the thread's task
duration and the page counted its own rAF frames, so each adjacent page/game
pair compares main-thread work per drawn frame under the same load. Three pairs
measured **0.923, 0.925 and 0.917** of the page's task time per frame (7.7-8.3%
less), and the game presentation drew **46 frames to the page's 41** over the
same sampling. A forced status-bar read-back — the synchronous framebuffer read
plus digit recognition the page schedules every 1.2 s — cost 0.3-1.4 s per read
on this loaded box (median 1.05 s), and game mode performs none. The acceptance
runner now asserts the saving (at least 2% less main-thread work per frame in
most adjacent pairs, interleaved on the frozen scene) and keeps the wall-clock
requirement that the mode adds no frame time. The previous section's "no
percentage is claimed" is superseded by this measurement; the wall-clock
percentage is still not claimed.

### Two acceptance checks could not pass on the scene they were given

Both were written by the previous pass and never run to completion there. Each
expected value is unchanged; what changed is how the measured scene is
produced, and the measurement that made the old production wrong is recorded
here.

- **The bright pair was not bright.** The crosshair boots let the demo play for
  ten seconds before freezing, so the camera was wherever the software renderer
  had got to. Measured in the first full run: the "bright" background came out
  at luma 48.4 with **0 of 72** cross pixels above 100, against a requirement of
  at least 4. The fix is `timescale 0` on the engine's start-up line, so every
  capture is the map's spawn: four probe boots all landed at
  (128.06, -319.94, 46.19), yaw 135. On that frozen spawn the menu defaults give
  a background luma median of 44.5 (59 of 1089 centre-window pixels at or above
  100) and the menu maximum (colour intensity 5, overbrights 2) gives **102.3
  with 572 of 1089 at or above 100** — the bright background the check was
  written for.
- **The crouch pair was two pictures.** Pressing C lowers the view, and that
  interpolation runs on real time after the trigger, so the "on" and "off"
  frames were taken at two camera heights. Measured: the crouch cross's box grew
  to **22x31** against the resting 21x21 (and 40 pixels wide of the 20 px quad
  the state reported). The on/off pairs now wait for a picture that has stopped
  changing before each capture and reject a pair whose scene moved outside the
  cross, retaking it once; the scene is the same in both frames, so the diff is
  the crosshair again.

### Fixed (the second sweep)

The findings below were produced by a four-way read of the page and the control
bridge and then each checked against the source by an independent verifier;
fourteen stood up, and the ones that are page behaviour are fixed here.

- **Every note row's answer was lost.** Nine clickable rows (the four
  multiplayer notes, renderer, ui scale, sound backend, customize controls, go
  to console) answer through `showBanner`, but while the panel is up this
  browser paints the banner under the panel's scrim. Measured in headless
  Chrome: the banner was the topmost element in the browser's own hit test at
  its centre (`banner-text, banner, menu-scrim`) yet no pixel of it reached the
  frame (max red channel 6 inside its rectangle, 0 amber pixels), and that held
  with its animation disabled, with it moved after the menu layer, and with the
  menu layer hidden. Clicking a note row appeared to do nothing, and so did
  Apply's "Nothing to apply". Those answers are now written into a `#menu-note`
  line inside the panel; the acceptance runner checks that line is visible,
  inside `#menu`, carries the row's text, and that the panel stays up.
- **Save game / load game from the panel unpaused the game.** `pauseForKey`
  closed the engine's menu and sent F6/F9 260 ms later, but the interface poll
  saw `key_dest` 0 with the panel still up and hid it; the game ran, unlocked,
  for about half a second, the re-pause then reopened the engine menu, and the
  panel came back on the main view instead of the one the player was on. The
  panel is held for the whole key flight and the re-pause is now explicit.
- **Alt+Enter over the panel was eaten and activated the focused row.** The
  panel's key handler (registered before game-mode.js) treated Enter as
  "activate", so the game-mode shortcut could click QUIT or start a new game.
  Alt+Enter now passes through to the shortcut, which resumes the paused game
  before it hides the interface.
- **Escape did nothing for up to 900 ms after Resume.** The closing hold gated
  both the pointer-lock pause path and the engine-menu poll. It is now released
  as soon as the engine reports `key_dest` 0, and its timer stays as a bound.
- **The first Escape after using the console was swallowed.** Any menu within
  1.5 s of a console sample was assumed to be the console's trailing Escape and
  closed, so "close the console, press Escape to pause" ate the key. The app now
  records real Escape presses (its own taps are marked synthetic) and only
  suppresses a menu that no person asked for.
- **The footer's Resume and Back were outside the keyboard ring.** `visibleButtons`
  collected the current view's rows only; the footer buttons are outside every
  view, so Tab/arrows could never reach them. They are part of the ring now.
- **Game mode had no way out where full screen is refused.** In a sandboxed
  frame (where fullscreen.js documents that full screen is disallowed) the mode
  hid every control and Esc could only reach the engine's suppressed menu.
  Escape now leaves the mode whenever the document is not full screen.
- **A refused full-screen request was never tried again.** `requestFullscreen()`
  left `state.requested` set after a refusal while its own comment promised the
  next click would ask again. The flag is cleared on both refusal paths and a
  pointerdown inside the mode (a gesture) re-asks.
- **The interface poll took a whole engine reading for one word.** `read()`
  builds position, angles, two arrays and an ISO timestamp; the poll only needs
  `cls.key_dest`, and now calls the one-word `quake2Engine.keyDest()` with the
  full reading as a fallback.
- **The crosshair's frame was counted twice.** The engine's crosshair draw was
  counted when it was recognised and the replacement draw was counted again, so
  `status().crosshairDraws` reported two per frame (the runner saw 4 over two
  frames). One draw, one count.
- **A `crosshair_scale` below 1 drew the engine's maximum cross.** The start-up
  read treated any value under 1 as "missing" and fell back to scale 3, drawing
  24 px where the engine's 8 x scale would be 4 px. Any positive value is now
  honoured up to the engine's cap of 3.
- **Two allocations per drawn frame in the renderer:** the crosshair's tint and
  opacity comparison key was rebuilt (a string and an array join) every frame,
  and an empty model-skin list was allocated every frame. Both are now built
  only when the values change / kept as one shared empty list.
- **The game-mode row searched the DOM once per row** to update `aria-pressed`;
  the list is queried once.
- **The control bridge's CDP calls had no timeout.** `CdpSession.send` settled
  only on a reply or a socket close, so a wedged target left the promise pending
  and every later call queued behind it; the project's own contract says every
  round trip is bounded. Each send now has the session's timeout, and a timeout
  drops the socket so the next call re-resolves the target.

Two control-bridge findings are recorded but not fixed here: a missing `condump`
flips the bridge's console model the wrong way (the retry can type into the
game), and the one-shot reconnect retry re-sends a partially delivered key
string. Both need the bridge to read the engine's real `key_dest` before typing;
that is a larger change than this run could verify, and the bridge is the
harness rather than what the owner plays.

### Verification

VERIFICATION_PLACEHOLDER

## Game mode, an aiming crosshair, and the interface defects behind them

### Added

- **Game mode: the game surface alone.** `game-mode.js` adds a `game mode` row
  to VIDEO and the Alt+Enter shortcut. Entering removes every page layer, paints
  the page black around the picture, lays the canvas out to fill the display at
  the engine's own aspect ratio and asks for full screen on the game's display.
  `window.quake2GameMode` exposes `enter`, `exit`, `toggle` and an honest
  `status()`. Where the Window Management API exists and the owner allows it,
  one opaque black window is opened on every additional display; with one
  display, or without the permission, `status().blackout` says so and nothing is
  claimed — a page cannot paint a monitor it has no window on, nor hide another
  application's windows, and the README says both. Esc, the browser's own way
  out of full screen, leaves the mode too, so the interface is never stranded
  hidden; fullscreen.js's full-screen-on-open and the `?v=` tags are unchanged.
- **What the frame measurement showed.** The mode removes the page's own
  per-frame work: the status-bar read-back (a framebuffer read every 1.2 s —
  22% of the page's main-thread samples in a Chrome profile), the interface poll
  and every page layer. In the headless software renderer the frame is GPU-bound
  (the main thread is ~30% busy), so the wall-clock difference is within noise:
  on one page, one frozen scene and one full-screen state, 161/160 interleaved
  frames gave medians of 166.7 vs 166.7 ms and means of 169.9 vs 167.4 ms, and a
  second run gave 161.6 vs 161.0 ms. The acceptance check therefore proves the
  removed work (the read counter stops in game mode and advances on the page)
  and requires the mode to add no frame time, rather than asserting a percentage
  the software renderer cannot show. No percentage is claimed.
- **The crosshair follows the aim.** The engine's 8x8 picture is drawn by the
  renderer at a size that follows the weapon in hand (the blaster is 1.00;
  heavier weapons spread 1.08–1.35, named from pak0's own skin sizes), widens
  while the trigger is held (+0.35, fast out, unhurried back) and narrows while
  C is held (−18%). `crosshair 0` still submits no draw and `crosshair_scale`
  still sets the base size (a scale-2 boot measures a 16px quad); the colour is
  unchanged. The default opacity is 0.45 rather than 0.500, and the runner
  measures 0.450 on both backgrounds.
- **The acceptance runner grew from 148 to 178 checks**: the game-mode
  presentation and its work removal, the crosshair's weapon/trigger/crouch
  behaviour with measured pixels, and the three interface defects below.

### Fixed (the sweep)

- **The panel swallowed the app's own keys.** Its window-level key handler runs
  before the engine's and called `stopImmediatePropagation`, so the synthetic
  Escape the Options chip sends never reached the engine: the chip showed the
  panel and closed it a second later without pausing anything, and Save game /
  Load game could not send F6/F9. Taps now carry `__q2synthetic` and the panel
  lets them through.
- **QUIT did not stick.** The engine stays at its menu after QUIT, so the next
  interface poll reopened the panel under the exit message and offered Resume to
  an invisible game. A `quitting` flag keeps it down.
- **A key released while the panel was open never reached the engine.** The
  keyup handler stopped propagation, so a movement key held when the panel
  opened stayed down and the player kept walking after Resume. Releases now
  reach the engine (measured: 65 units walked with W held, 0.0 drift after the
  release through the panel).
- **"Open in its own window" reloaded the page it meant to keep.** `window.open`
  with `"noopener"` returns null by specification even when the window opened,
  so the fallback reloaded the running game. The opener is severed on the
  returned window instead and the reload happens only when nothing opened.
- **A whole engine reading for one word, every rendered frame.** The renderer
  sampled `cls.key_dest` with `quake2Engine.read()`, which builds views, arrays
  and an ISO timestamp per frame. `quake2Engine.keyDest()` returns the word.
- **The status-bar reader rescanned the whole bar on every retry.** Discovery
  was keyed to successful reads, so a bar that did not read kept running the
  full-width correlation on every attempt. It is keyed to attempts now.
- **A fresh array, Set and spread on every model draw.** Skin-size bookkeeping
  is reused across draws.
- **The interface poll rewrote unchanged DOM eight times a second.** Hidden
  flags are written only when they change, and the poll stops entirely in game
  mode.

### Verification

`node scripts/verify-presentation.mjs` drives the real page at 1280x720 and
2560x1440 (headless Chrome, SwiftShader) and passes every check; the frame
numbers above come from interleaved in-page samples, and the crosshair's sizes
and opacity from on/off screenshot pairs taken with the simulation frozen.


What changed and why, newest first. The state of the art pipeline -- what is in
the archive, where the art lives, the commands and the measurements behind them
-- is in [Texture art](README.md#texture-art); the per-namespace records are in
`assets/textures/*/NOTES.md`. This file is the record of the defects found on the
way and what closed them, because those are the parts a reader cannot recover
from the files as they now stand.

## A palette-tinted, half-transparent crosshair, and the engine's own HUD

### Fixed

- **The crosshair was an opaque white plus.** The engine draws its crosshair as
  an 8x8 white picture (`pics/ch1-3.pcx`, palette index 15) through a 2D shader
  that alpha-tests and does not blend. `rtx-renderer.js` now patches that shader
  to mix the texel with the game palette's rusted amber (`pics/colormap.pcx`
  index 52, `#cf974b`) blended with its bone (index 251, `#ebd3c7`) — the tint
  is `#ddb589` — and to multiply the output alpha by 0.5, and turns on the
  engine's own source-alpha blend for that one draw. No image asset changed;
  `crosshair 0` still submits no crosshair draw and `crosshair_scale` still
  sets the engine's own size. The values are the start-up cvars
  `q2_crosshair_alpha 0.5` and `q2_crosshair_tint ddb589`, and
  `window.quake2RTX.crosshair({alpha, tint})` changes them live.
- **A page band covered the engine's status bar.** The `#hud` element, its
  styles, its read-out code, `quake2hud` listener and canvas sizing are gone.
  The engine's own status bar with health, armour and ammo is visible and
  unoccluded at boot and in game at 1280x720 and 2560x1440, and no page element
  paints over the canvas's bottom band. The fullscreen control keeps its
  clearance above the engine bar; fullscreen-on-open, the `?v=` cache-bust
  tags, `+map demo1` and `+set fov 90` are unchanged.
- **The acceptance runner now measures the new presentation.** It grew from
  126 to 148 checks: the 17 band-era checks are replaced by no-#hud, engine
  status-bar health/ammo readability, digits-inside-the-band and
  no-page-element-over-the-band checks at both resolutions, plus the
  crosshair's on/off draws, palette tint, size and measured alpha over a dark
  and a bright background. Run:
  `node scripts/verify-presentation.mjs --url http://127.0.0.1:4398/apps/quake2/`.

## Crosshair, old HUD, text-only health and menu parity

### Fixed

- **No crosshair.** The engine was drawing its own 2D crosshair, but at the
  default `crosshair_scale` of 1 it is a 7x7 pixel plus on this build (measured
  at 1280x720: 7x7 at 1, 14x14 at 2, 21x21 at 3, no larger above 3), and a
  restored `userdata/config.cfg` can carry `crosshair 0` at all. The start-up
  line now sets `+set crosshair 1 +set crosshair_scale 3`; the engine's own
  maximum scale gives a visible 21x21 cross at 1280x720 and 2560x1440, and the
  OPTIONS crosshair row now carries the engine's four values
  none/cross/dot/angle.
- **The old status bar showed through the new HUD.** The band's background was
  a 0.96/0.9-alpha gradient, so the engine's digits and icons under it were
  still visible. It is now a solid `#07090b` fill with no border or shadow.
  The acceptance runner hides the band, proves the engine's status bar is
  underneath, then shows the band and proves every pixel outside the new
  read-out is the exact fill colour (0 of 41,920 sampled pixels differ).
- **A bar under the health number.** The health read-out (and the other
  read-outs) now has no border, underline, text-shadow or box-shadow; it is
  text only, in the same font and position. The line the owner saw was the old
  status bar showing through the translucent band, which the opaque fill also
  removes.
- **The menu was not the engine's menu, and it had no resolution row.** The
  VIDEO view now carries the engine's `video mode` row (`r_mode`) with all 33
  of its modes plus auto and custom, in the engine's own order, and applying it
  restarts the level at that mode (measured: selecting 1366x768 reloads with
  `+set r_mode 17` and the drawing buffer becomes 1366x768). The rows were
  audited against Qwasm2's `src/client/menu/menu.c` and
  `src/client/menu/videomenu.c`: GAME now has easy, medium, hard, hard+, load
  game, save game, credits; OPTIONS has OGG music and free look, the engine's
  crosshair and pause values, and reset defaults before go to console; VIDEO
  has the engine's color light row, `fullscreen` (three values), no/yes
  vertical sync, the full 16x multisampling list and the engine's
  pixelated/standard/trilinear filters. See
  [Presentation fixes](docs/presentation-fixes.md) for the row-by-row audit and
  the rows this app cannot make work.

## Presentation fixes: the menu, the view weapon, the models and the HUD

### Fixed

- **The dark menu did not match the menu it replaces.** The panel now carries
  the engine's own main menu, entry for entry and in its order -- GAME,
  MULTIPLAYER, OPTIONS, VIDEO, QUIT -- with GAME opening the engine's game menu
  (easy, medium, hard+, load game, save game, credits), and VIDEO and OPTIONS
  reproducing the engine's own settings menus row for row (renderer, brightness,
  field of view, color intensity, overbrights, ui scale, full screen, vertical
  sync, aniso filtering, multisampling, texture filter, reset to default, apply;
  effects volume, OGG volume, OGG shuffle, sound backend, mouse speed, always
  run, invert mouse, lookstrafe, crosshair, pause on minimized, customize
  buttons, customize gamepad, go to console, reset defaults). The labels come
  from the engine's own strings and its rendered menus, captured at 1280x720.
  Settings that change the engine (field of view, brightness, volumes, ...) are
  applied by reloading the page with `+set` on the engine's start-up line:
  synthetic DOM keys reach the engine's bindings but not its console text
  (measured), so a console is not a command channel this page has. New Game is
  a reload with `+set skill N +map demo1` for the same reason.

- **No gun in hand after New Game.** The cause is `fov` above 90: this build
  draws no view weapon at a field of view wider than 90 degrees, whatever
  `cl_gun` says (measured with the engine console: at 90 the blaster's 296x164
  skin is drawn once a frame, at 91 and up it is not drawn at all). A
  `userdata/config.cfg` restored from an earlier session carried `fov 120`, so
  the app booted with `cl_gun 1` and no gun. The start-up line now sets
  `+set fov 90` (a URL can still override it), the new VIDEO menu stops the
  field of view at 90 and says why, and the acceptance runner that read
  `cl_gun` now measures a real weapon draw (296x164 bound once per frame).

- **The menu's GAME entry started nothing, and the console typing was fake.**
  `runCommand` typed console commands with synthetic KeyboardEvents; they
  reached the engine's key bindings but never its console text (measured: the
  cvar it tried to set did not change, and the console stayed open). It is
  gone. Actions that need an engine command now use the one channel that works
  -- start-up arguments on a reload -- and save/load use the engine's own bound
  quick-save/quick-load keys.

- **Grey lines through the rebuilt models.** Every hardware vertex used to pick
  its own nearest original face, so the corners of one quad could ride faces
  that move apart on an animation frame: the quad stretched into a long grey
  sliver (measured worst edge stretch 61.7x on the soldier, 17.9x on the
  blaster). Each part (quad, cap, tube ring) now anchors to one face and moves
  rigidly with it: the worst hardware-edge stretch across all 20 models is
  1.7x, and no more than 1.2x the host mesh's own deformation. The parts placed
  from guessed bounds that read as flat slabs through the gun (sight rail, vent
  louvres, trigger guard, cable, rear bevels, chest vents) are gone; the muzzle
  collar and the monster shoulder collars -- the parts that wrap geometry the
  mesh actually has -- stay. The albedo-relief model shader also stopped adding
  a light edge along every texture seam: the derivative now tilts the normal by
  at most a few degrees and no longer adds an unlit grey rim.

- **The engine's own menu could still be seen.** At Escape, on a pause and at
  boot the engine draws its own menu behind the panel. While `cls.key_dest` is
  not the game (menu or console) the renderer now drops every 2D interface draw
  (the console's fill included), so nothing of the old interface can appear;
  the 3D scene stays composited on screen. The panel follows `key_dest`, and a
  menu that opens in the moment after a console session (a harness closing the
  console) is closed again instead of being shown behind the panel.

- **The old status bar.** The engine's ammo/weapon icons and digits are covered
  by the new HUD: an opaque band on the canvas's bottom edge, in the interface's
  own type and colours, with tabular HEALTH / ARMOUR / AMMO read-outs sized
  from the canvas so it stays legible at 1280x720 and at 2560x1440. The numbers
  are the engine's own: the renderer reads the status bar back out of the
  framebuffer and recognises the engine's own digit pictures (decoded from
  `pak0.pak` at boot, no embedded font), the same technique `control/hud.mjs`
  uses for its screenshots. The verifier cross-checks the panel's health number
  against an independent read of the status bar.

## Interface, first-person weapon and model geometry

### Fixed

- **The view weapon could ship invisible.** Nothing in the renderer hides it:
  a fresh profile shows every weapon in hand in RTX High, Performance and Off.
  The state that does hide it is `cl_gun 0`, which is written into
  `userdata/config.cfg` by any session that set it (the texture-shot tools set
  it for clean screenshots), and the engine restores that config at boot. The
  page now passes `+set cl_gun 1` at startup, so every weapon is in hand in all
  three modes regardless of what a saved config last said.

### Added

- **A rebuilt model set in `baseq2/pak10.pak`**, generated by
  `scripts/model-geometry.mjs` from the meshes in `pak0.pak`: 13 first-person
  weapons and 7 enemy models, 4,433 → 25,090 vertices and 7,991 → 36,252
  triangles. Each face is split 1-to-4 with Phong-style midpoint projection;
  enemy meshes also get one Laplacian pass and a small inflation so limbs and
  heads stop reading as flat blocks while the armour keeps its bulk. Weapons
  gain a muzzle collar, sight rail, vent ribs, trigger guard, underside cable
  and rear bevels built from primitives and mapped onto the model's existing
  skin; enemies gain chest vents and shoulder collars. Every new vertex is bound
  to the original faces, so the game's own frames animate it and hit detection
  is untouched. A later PAK wins in Quake 2's file system, so pak0, the maps,
  sounds and skins are byte for byte the originals. The engine refuses models
  above its vertex cap ("has too many vertices", measured at 3,399); the build
  tops out at 1,646 (the tank). PAK: 13.61 MiB.
- **`q2ModelShade` in `rtx-renderer.js`.** The 14 model fragment programs the
  engine links now get a tangent-space normal from the skin's luminance
  gradient, a key-lit relief term, a painted-metal sheen and a rim, gated by a
  `q2Model` uniform so `Off` restores the engine's shader exactly. This is the
  only colour those draws receive beyond the texture: the engine supplies no
  normal or light to them.
- **A new interface layer** (`index.html`, `style.css`, `app.js`): a dark boot
  plate with one progress rule, a near-black translucent menu/pause/options
  panel with thin borders and muted amber accents, a bottom band framing the
  engine's HUD, a small Options chip, a click-to-capture prompt and restrained
  map-change banners. The panel appears when `cls.key_dest` reads 3 and covers
  the engine's own menu; its items respond to mouse hover and clicks while
  ↑ ↓ / Tab / Enter / Esc continue to work, and Resume closes the engine menu
  and re-locks the pointer from the click. New Game runs `map demo1|demo2|demo3`
  through the game's own console; Options switches lighting live through
  `window.quake2RTX`.

## Texture art in the game

### Shipped

- **475 of the manifest's 603 pictures are now inside `baseq2/pak0.pak`**, in
  place of the demo's own: the walls, floors, ceilings and trim of all three
  levels, the weapons, monsters and items, the HUD status bar, the menu, the
  console font and the sprite animations. The other **631 entries are byte for
  byte what they were**. Archive sha1 `9ddbf5276c7f8fbc3b3e719f97b0fc05a3ee51ea`,
  reproducible from the archive as the demo shipped it
  (`b86e8878a8e8706595ceebe88b3e6b4c1ba5bcab`) plus this repository's art and
  nothing else.
- `scripts/map-art.mjs` now draws the surfaces of **every map in the archive**,
  not just `maps/demo1.bsp`: 141 more entries, so demo2's and demo3's walls and
  floors are new too.

### Fixed

- **The model, weapon, item and monster skins were shipping mangled art.** What
  was committed for them was 99.8% off the entries' own palettes -- 2652 of 2657
  distinct colours on one skin -- so `scripts/texture-pack.mjs` snapped every
  pixel to the nearest colour at pack time and the archive stopped being the art
  on disk. **Cause:** the art on disk was not what `scripts/model-art.mjs`
  produces (the tool's own output is fully on-palette; its `--fallback` route
  reproduces commit `44c1dd4` byte for byte on all 125 entries, which is how this
  was established). **Fix:** re-derived all 125 entries with the repository's own
  tool. The skins now keep the original's structure instead of being replaced:
  Pearson r 0.93 to 0.97 per family over the packed pixels (the tool's own
  measure before packing reads 0.955 to 0.992), against a mean of ~0 for the art
  they had.
- **Skin cut-outs were being punched through, and lost.** The dither that snaps
  a skin onto its palette was free to choose **index 255** -- the engine's
  transparent colour -- as the "nearest" colour for a mid-brown pixel, so an
  opaque pixel came back see-through; separately the stale art above had dropped
  1814 pixels of the cut-out on `models/monsters/parasite/tip/base.pcx` alone and
  invented 1076 on `models/monsters/infantry/skin.pcx`. **Fix:** index 255 is out
  of the dither's search (`palettise(..., { exclude: [TRANSPARENT_INDEX] })`) and
  the original's real cut-out is set back afterwards (`restoreCutout`), which is
  the other half of the rule `texture-pack.mjs` already applied. **Measured over
  all 475 packed entries: 0 silhouette faults of any size**, from 76.
- **26 tiles were shipping flatter than the surface they replaced.** A generated
  1024x1024 picture cropped to an entry's aspect and box-averaged onto a 16x16 or
  32x32 entry becomes a single tone: `textures/e1u1/ceil1_4` (16x16) arrived at
  luminance spread 4.0 against the original's 58.5, and `sky1` at 3.8 with mean
  luminance 35 against 201 -- which is why the sky read as night. **Fix:** drawn
  again procedurally, which draws at the entry's own size. The test is on what
  *ships*, through the packer's own re-indexing; every textured entry is now at
  half its original contrast or better, except three animated frames (left whole
  on purpose) and two entries at 46% and 48% whose originals are the set's
  highest-contrast (sd 90.6 and 87.5, against the recipes' 42-43).
- **`tex-check.mjs --only` reported every other namespace's art as "art no entry
  claims"** (350 of them for `--only models/`), which is how a genuinely stray
  picture hides in plain sight. A run now claims the entries it did not check.
- **The 15 pictures under `assets/textures/hud/` were reported as unclaimed.**
  They are not orphans: they are the generation sources `scripts/hud-art.mjs`
  derives the HUD, menu and sprite entries from, and it reproduces the 101
  shipped pictures from them exactly. The source folders are now declared
  (`SOURCE_ART_DIRS` in `scripts/texture-lib.mjs`) and counted as `sourceArt`,
  while anything else under the art directory that no entry claims is still
  reported -- checked with a planted stray file.

### Left alone, on purpose

128 pictures stay on the art the demo shipped: 66 `pics/*.pcx` (item and weapon
icons, menu cursors, status glyphs, `colormap.pcx`, `field_3.pcx`), 51 WALs no
map in the archive draws, 6 `env/` sky faces, the 3 animated frames whose
families are left whole (redrawing frame 0 of an animation makes it flicker) and
`sprites/s_bubble_0..1`. The reason for each group is in the NOTES file for its
namespace.

### Tooling and tests

- `scripts/tex-lib-test.mjs` -- the checker's own rules: source art against art
  no entry claims, the `--only` claim, and the two gates that stop a run (a
  wrong-size picture, and `--require-all`).
- `scripts/texture-pack-test.mjs` -- what the packer refuses and what it leaves
  behind, including that a refused run writes no archive and that `--out` never
  touches its input. Its last check proves it: the shipped archive is compared
  byte for byte with the blob the commit holds.
- `scripts/map-art-test.mjs` -- which surfaces the map art covers, that a shared
  texture carries every map's uses, and that the animated frames are still
  refused.
- `README.md` gained the [Texture art](README.md#texture-art) section (it had
  none), naming the tools, the three routes the art came from and how to check
  the result; the three `assets/textures/*/NOTES.md` are in sync with what
  shipped.
