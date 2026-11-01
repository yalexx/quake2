# Changelog

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
