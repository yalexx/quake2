# Presentation: a half-transparent palette crosshair, and the engine's own HUD

Evidence for the two current owner changes on top of the menu and resolution
work kept below. Every picture is a real headless-Chrome capture of this
checkout, made by `scripts/verify-presentation.mjs` on `node server.js` serving
this worktree. The browser is software-rendered by construction (`--use-gl=angle
--use-angle=swiftshader --enable-unsafe-swiftshader`), so the frame rates in
`docs/presentation-verification/report.json` are SwiftShader, not this box's
GPU. The final acceptance run is **N_CHECKS checks, 0 failed** (`ok: true`,
`fatal: null`) at RUN_AT, at 1280x720 and 2560x1440.

## What changed

- **The crosshair is half transparent and in the game's palette.** The engine
  draws its crosshair as an 8x8 white picture (`pics/ch1-3.pcx`, palette index
  15) through a 2D shader that alpha-tests and does not blend. No picture is
  added or replaced: `rtx-renderer.js` patches that shader to mix the texel
  with the game palette's rusted amber (`pics/colormap.pcx` index 52, `#cf974b`)
  blended with its bone (index 251, `#ebd3c7`) — the tint is `#ddb589` — and to
  multiply the output alpha by 0.5. The draw wrapper turns on the engine's own
  `SRC_ALPHA`/`ONE_MINUS_SRC_ALPHA` blend for that one draw and restores the
  blend state afterwards. `crosshair 0` still submits no crosshair draw, and
  `crosshair_scale` still sets the engine's own quad size (21x21 at 3 on
  1280x720, 25x24 at 3 on 2560x1440: the engine's 2D size follows the display). The
  defaults are the start-up cvars `q2_crosshair_alpha 0.5` and
  `q2_crosshair_tint ddb589`, which `app.js` appends to the engine line; a URL
  can override either, and `window.quake2RTX.crosshair({alpha, tint})` changes
  them live.
- **The new health/ammo band is gone; the engine's own status bar is the HUD.**
  `#hud` is removed from `index.html`, its rules from `style.css`, and its
  read-out code, `quake2hud` listener and canvas sizing from `app.js`. The
  engine's status bar with health, armour and ammo is visible and unoccluded at
  boot and in game at both resolutions, and no page element paints over the
  canvas's bottom band. The fullscreen control keeps its 52px clearance above
  the engine bar instead of the band's old reservation; fullscreen-on-open, the
  `?v=` cache-bust tags, `+map demo1` and `+set fov 90` are unchanged.

## The acceptance suite: 126 -> N_CHECKS checks

Seventeen checks were removed and thirty-nine added. Every removal is a band
check whose subject no longer exists; every one is replaced by a check on the
engine's own status bar or on the crosshair's new presentation.

Removed (17):

| Removed check | Why it is gone | Replaced by |
|---|---|---|
| `1280x720`/`2560x1440`: the new HUD is on screen in game | the band is deleted | no #hud element; engine status bar checks |
| `1280x720`/`2560x1440`: the HUD's health is the status bar's own number | there is no page HUD to compare | status bar health readable in the canvas bottom band |
| `1280x720`/`2560x1440`: the HUD shows the ammo number | there is no page HUD | status bar ammo readable in the canvas bottom band |
| B2: the HUD band's fill is fully opaque | the band is deleted | no page element paints over the band |
| B3: the health read-out is text only | the read-out is deleted | no #hud element exists |
| screenshot `1280x720-hud-underneath.png` | the band is deleted | `-statusbar.png` (engine bar visible) |
| screenshot `1280x720-hud-covered.png` | the band is deleted | `-statusbar-no-page-ui.png` diagnostic |
| B2: the band's frame carries the old status bar | the band is deleted | engine status bar health/ammo digits |
| B2: no old HUD pixel shows through the opaque band | the band is deleted | no page element paints over the band |
| B1: crosshair on at boot | band-era 1280-only check | per-resolution crosshair on check |
| B1: crosshair at the visible scale | band-era 1280-only check | per-resolution start-up value + size bounds check |
| screenshot `1280x720-crosshair.png` | band-era pair | per-resolution dark/bright screenshots |
| screenshot `1280x720-crosshair-off.png` | band-era pair | per-resolution dark/bright off screenshots |
| B1: crosshair visible in the centre | band-era 1280-only check | per-resolution visible + alpha/tint checks |

Added (39): per resolution (x2), the engine status bar's no-#hud, readable
health, readable ammo, digits-inside-band, no-page-element-over-band checks and
its screenshot (6 each); the crosshair's on-at-boot, scale-3, visible-cluster,
crosshair-0-draws-nothing, size, alpha-over-dark, alpha-over-bright,
two-backgrounds-differ, every-pixel-blended checks and four screenshots
(13 each); and one palette-tint check.

## The captures

| File | What it proves |
|---|---|
| [`shots/1280x720-crosshair-dark.png`](presentation-verification/shots/1280x720-crosshair-dark.png), [`-dark-off`](presentation-verification/shots/1280x720-crosshair-dark-off.png) | The crosshair and the same camera with `crosshair 0` over the dark spawn view. The off/on pair shares one background (the cvar is flipped by a bound engine key, not a console visit). |
| [`shots/1280x720-crosshair-bright.png`](presentation-verification/shots/1280x720-crosshair-bright.png), [`-bright-off`](presentation-verification/shots/1280x720-crosshair-bright-off.png) | The same pair with the view turned to a lit surface, so the crosshair is measured against a bright background. |
| `shots/2560x1440-crosshair-{dark,dark-off,bright,bright-off}.png` | The same four captures at the box display's native resolution. |
| [`shots/1280x720-statusbar.png`](presentation-verification/shots/1280x720-statusbar.png), `shots/2560x1440-statusbar.png` | The engine's own status bar in the canvas bottom band with health and ammo readable, and no page band over it. |
| `-statusbar-no-page-ui.png` | Diagnostic: the same band with every page interface element hidden (the engine bar is translucent, so this is reported, not used as the pass condition). |
| [`shots/1280x720-resolution-menu.png`](presentation-verification/shots/1280x720-resolution-menu.png), [`-resolution-applied`](presentation-verification/shots/1280x720-resolution-applied.png) | VIDEO > `video mode` at 1366x768 (`r_mode 17`), and Apply restarting the level at that resolution. |
| [`shots/1280x720-menu-main.png`](presentation-verification/shots/1280x720-menu-main.png), [`-game`](presentation-verification/shots/1280x720-menu-game.png), [`-multiplayer`](presentation-verification/shots/1280x720-menu-multiplayer.png), [`-options`](presentation-verification/shots/1280x720-menu-options.png), [`-video`](presentation-verification/shots/1280x720-menu-video.png) | The panel's views, with the engine's rows in order (including the four skills, OGG music/free look, the crosshair/pause values, video mode and color light). |
| [`shots/1280x720-newgame-first-area.png`](presentation-verification/shots/1280x720-newgame-first-area.png) | GAME > easy restarted demo1, with the crosshair and the engine status bar on the live frame. |

## Measured crosshair pixels

The runner selects the 72 device pixels of the 8x8 picture at `crosshair_scale
3` from the dark pair (the on/off differences above 45% of the strongest are
one cross, 21x21 at 1280x720 and 25x24 at 2560x1440; the
same offsets are then sampled on the bright pair) and solves, per channel,

    on = alpha * tint + (1 - alpha) * background

with `tint = #ddb589`, the midpoint of the game palette's rusted amber (index
52, `#cf974b`) and bone (index 251, `#ebd3c7`). A crosshair that were opaque
would give alpha 0 or a tint mismatch; one that were missing would give no
cross pixels.

| Resolution | Background | Background luma (median) | Measured alpha | Cross pixels | Cross bounds |
|---|---|---|---|---|---|
| 1280x720 | dark spawn | ALPHA_1280_DARK_BG | ALPHA_1280_DARK | ALPHA_1280_DARK_N | ALPHA_1280_DARK_BBOX |
| 1280x720 | brightened spawn (colour intensity 5) | ALPHA_1280_BRIGHT_BG | ALPHA_1280_BRIGHT | ALPHA_1280_BRIGHT_N | ALPHA_1280_BRIGHT_BBOX |
| 2560x1440 | dark spawn | ALPHA_2560_DARK_BG | ALPHA_2560_DARK | ALPHA_2560_DARK_N | ALPHA_2560_DARK_BBOX |
| 2560x1440 | brightened spawn (colour intensity 5) | ALPHA_2560_BRIGHT_BG | ALPHA_2560_BRIGHT | ALPHA_2560_BRIGHT_N | ALPHA_2560_BRIGHT_BBOX |

Every selected cross channel with enough contrast lies between its background
and the full-opacity tint (BLEND_ON_DARK of BLEND_TOTAL on the dark pair), and
`crosshair 0` submits zero crosshair draws over the sampled frames
(DRAWS_OFF on both backgrounds). The live draw counter is CROSSHAIR_DRAWS_ON
with the crosshair on.

## The engine status bar

| Resolution | Health | Ammo | Band rows | Page elements in the band |
|---|---|---|---|---|
| 1280x720 | STATUS_1280_HEALTH | STATUS_1280_AMMO | STATUS_1280_ROWS | STATUS_1280_OVERLAYS |
| 2560x1440 | STATUS_2560_HEALTH | STATUS_2560_AMMO | STATUS_2560_ROWS | STATUS_2560_OVERLAYS |

The two numbers are read by the page's own canvas-pixel status-bar reader
inside the renderer (`window.quake2Hud`), with the repository's independent
`control/hud.mjs` reader as a second reading; the band is the bottom 40 rows of
the canvas's drawing buffer at each resolution. The overlay check enumerates
every visible, painted DOM element whose box intersects those rows (and
hit-tests sample points in them); the list is empty at both resolutions.

## Crosshair colour and opacity controls

The defaults live on the app's start-up line, which is the existing engine
argument path:

    +set q2_crosshair_alpha 0.5 +set q2_crosshair_tint ddb589

A URL can override either (`?+set&q2_crosshair_alpha&0.35&+set&q2_crosshair_tint&c8a55e`);
`q2_crosshair_tint` takes `rrggbb` or `r,g,b`. The same values can be changed
live from the page with `window.quake2RTX.crosshair({ alpha: 0.35, tint: "#c8a55e" })`.
They are deliberately not rows in the OPTIONS menu: that menu must remain the
engine's own rows, row for row, and the acceptance runner checks it.

## Previous run: menu and resolution work

The menu audit below, the engine's own resolution row and the model/texture
work were the preceding change; they are unchanged by this run and still
checked by the same runner.


## The menu audit

The engine's tree was read from Qwasm2's own menu source and cross-checked
against its strings and rendered menus. The panel now matches it row for row:

| Menu | Engine rows (now in the panel) |
|---|---|
| main | GAME, MULTIPLAYER, OPTIONS, VIDEO, QUIT |
| game | easy, medium, hard, hard+, *(separator)*, load game, save game, credits |
| multiplayer | join network server, start network server, player setup, customize controls |
| options | effects volume, OGG volume, OGG music, OGG shuffle, sound backend, mouse speed, always run, invert mouse, lookstrafe, free look, crosshair, pause on minimized, customize controls, reset defaults, go to console |
| video | renderer, video mode, brightness, field of view, color intensity, overbrights, color light, ui scale, fullscreen, vertical sync, aniso filtering, multisampling, texture filter, reset to default, apply |

The value lists that changed: GAME gained the fourth difficulty (`hard+`,
skill 3) and the engine's `hard`; OPTIONS gained OGG music
(disabled/enabled), free look, the engine's crosshair values
(none/cross/dot/angle), the engine's pause values
(yes/no/unpause on re-focus) and the engine's OGG shuffle list; VIDEO gained
`video mode` and `color light`, `full screen` became the engine's `fullscreen`
with no/native fullscreen/fullscreen window, vertical sync uses no/yes,
multisampling carries the full off/2x/4x/8x/16x list, and texture filter uses
the engine's pixelated/standard/trilinear labels. The engine's Options menu has
no `apply` row (it applies each change immediately); the panel's apply control
sits below the rows, because this page can only carry values on its start-up
line. Every settings row is one of the engine's rows; none was hidden.

The acceptance runner reads all four submenus from the live page,
compares every label and order with `ENGINE_MENU_TREE`, and checks the key
value lists (`video mode`, crosshair, pause, OGG shuffle, texture filter, the
four new-game skills). It then selects 1366x768 in VIDEO, presses Apply, and
reads the engine's drawing buffer back as 1366x768.

## What remains unverified, and rows this app cannot fully make work

- **Field of view 91-120 is not offered.** The engine's slider runs 60-120,
  but this build draws no view weapon above 90 (measured in the earlier run and
  kept as the `+set fov 90` start-up default). The panel lists 60-90; listing
  the rest would let a menu row silently remove the gun.
- **UI scale is fixed at 1x.** The engine's `ui scale` sets the HUD, menu,
  console and crosshair scales together. This page reads the engine's HUD
  numbers back out of the status bar's own 15x23 digit pictures, so a scaled
  status bar would no longer match those pictures; the row is shown as
  `1x (fixed)` and explains why. The engine's *custom* scale is therefore not
  offered.
- **Renderer is fixed to OpenGL ES3.** The engine's list also offers a custom
  renderer; this app boots and verifies `gles3` only, so the row is
  informational.
- **Sound backend is informational.** The engine's `s_openal` is not a
  registered cvar in this build; the running backend is SDL.
- **Texture filter's *custom* value is not offered.** The engine shows it only
  when `gl_texturemode` is a value outside pixelated/standard/trilinear; the
  panel offers the three values it can set.
- **Load/save use the engine's quick keys.** The engine's GAME menu opens save
  slot lists; this page cannot draw or enumerate those slots, so F9/F6
  quick-load/quick-save is what the rows do. Save game and load game were not
  exercised in this headless run.
- **Customize controls and go to console are notes.** The engine opens its
  key-binding menu and console; this page has no console text input (measured
  in the earlier run), so the rows say what they would do rather than pretending.
- **The gamepad row is absent, as the engine itself hides it when no gamepad is
  connected.** If a gamepad is attached, the engine would show it; this page
  cannot detect that.
- **Video mode auto/custom.** `auto` (-2) and `custom` (-1) are in the list and
  are passed to the engine as the engine's own values. This run exercised a
  numeric mode (17); `custom` uses the engine's saved `r_customwidth`/
  `r_customheight` (1024x768 on a fresh run), not a page-side size picker.
- **Fullscreen.** The engine's three values are in the row and are passed as
  `vid_fullscreen` (with `r_mode -2` for fullscreen window). The Fullscreen API
  and the resulting display mode were not exercised headless; the app's own
  full-screen-on-open button is a separate DOM control and is unchanged.
- **Multiplayer rows are informational.** This box build is single-player;
  its network menus exist in the engine but networking is not part of the app.
- **Software rendering only.** Every frame time and capture is SwiftShader, not
  the box GPU. The crosshair size is the engine's own pixel size (21x21) at
  1280x720 and 25x24 at 2560x1440;
  both 1280x720 and 2560x1440; the 2560 weapon capture measures an arm-vs-ring
  score of 113.8, so it is drawn there too, but the paired off/on diff was
  measured at 1280x720.
- **Rows whose application is the generic reload path.** The runner reads every
  row and its cvar/action wiring, checks the value lists called out above, and
  exercises the resolution reload end to end. The other settings rows use the
  same `+set` apply path, but this run did not restart the level once per cvar.
