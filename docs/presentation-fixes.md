# Presentation fixes: crosshair, old HUD, health and menu (B1-B4)

Evidence for the four owner reports on the presentation build. Every picture
below is a real headless-Chrome capture of this checkout, made by
`scripts/verify-presentation.mjs` on `node server.js` serving this worktree.
The browser is software-rendered by construction (`--use-gl=angle
--use-angle=swiftshader --enable-unsafe-swiftshader`), so the frame rates in
`docs/presentation-verification/report.json` are SwiftShader, not this box's
GPU. The final acceptance run is **126 checks, 0 failed** (`ok: true`,
`fatal: null`) at 2026-10-31T15:33Z.

## What changed

- **B1, crosshair.** The engine was already submitting its 2D crosshair; the
  fault was that at the default `crosshair_scale 1` it is a 7x7 pixel plus on
  this build, and a restored `userdata/config.cfg` can carry `crosshair 0`.
  Measured at 1280x720 by turning only the crosshair cvar off and on: 7x7 at
  scale 1, 14x14 at 2, 21x21 at 3, and no larger at 4, 6 or 8. The app's
  start-up line now sets `+set crosshair 1 +set crosshair_scale 3` (the engine's
  maximum), and a URL can still override either value.
- **B2, old HUD bleed-through.** The band's background was a
  `rgba(...,0.96)`/`rgba(...,0.9)` gradient, so the engine's digits and icons
  under it were visible. It is now a solid `#07090b` fill with no border and no
  box-shadow. The runner captures the same frame with the band hidden (the
  engine's own status bar is there) and shown (the band covers it), then checks
  every pixel outside the new read-out text.
- **B3, health read-out.** The read-outs carry no border, underline,
  text-shadow or box-shadow; the health number is text only in the same font
  and position. The line the owner saw under HEALTH was the old status bar
  showing through the translucent band, which B2's opaque fill removes.
- **B4, resolution and menu parity.** VIDEO now carries the engine's own
  `video mode` row (`r_mode`) with its 33 modes plus auto and custom, in the
  engine's order, and applies it by restarting the level at that mode. The
  other rows were audited against Qwasm2's `src/client/menu/menu.c` and
  `src/client/menu/videomenu.c`; the corrections are listed below.

## The captures

| File | What it proves |
|---|---|
| [`shots/1280x720-crosshair.png`](presentation-verification/shots/1280x720-crosshair.png) | The engine's crosshair is drawn at the centre of the live frame after boot (`crosshair 1`, `crosshair_scale 3`). |
| [`shots/1280x720-crosshair-off.png`](presentation-verification/shots/1280x720-crosshair-off.png) | The same demo1 spawn booted with only `+set crosshair 0`; the centre has no cross. The pair differs in a compact cluster at the centre (529 pixels in a 41x41 box around 640,360), and the cross measurement (mean luma on the arms minus a ring outside them) is **190.2 on / 15.4 off**. |
| [`shots/1280x720-hud-underneath.png`](presentation-verification/shots/1280x720-hud-underneath.png) | With the new HUD hidden, the engine's own status bar is visible in the band's rectangle (bright old-HUD pixels are counted, not assumed). This is what has to be hidden. |
| [`shots/1280x720-hud-covered.png`](presentation-verification/shots/1280x720-hud-covered.png) | The same frame with the new HUD shown: the band is the solid fill and no engine pixel shows through it. Outside the new read-out text, **0 of 41,920 sampled pixels** differ from `#07090b`. |
| [`shots/1280x720-resolution-menu.png`](presentation-verification/shots/1280x720-resolution-menu.png) | VIDEO > `video mode` selected at the engine's 1366x768 (`r_mode 17`), marked as one pending change with `apply`. |
| [`shots/1280x720-resolution-applied.png`](presentation-verification/shots/1280x720-resolution-applied.png) | After Apply the page reloaded with `+set r_mode 17` and the engine's drawing buffer is 1366x768; the crosshair and the opaque HUD are still there. |
| [`shots/1280x720-menu-main.png`](presentation-verification/shots/1280x720-menu-main.png), [`-game`](presentation-verification/shots/1280x720-menu-game.png), [`-multiplayer`](presentation-verification/shots/1280x720-menu-multiplayer.png), [`-options`](presentation-verification/shots/1280x720-menu-options.png), [`-video`](presentation-verification/shots/1280x720-menu-video.png) | The panel's views on this build, with the engine's rows in order (including the four skills, OGG music/free look, the crosshair/pause values, video mode and color light). |
| [`shots/1280x720-newgame-first-area.png`](presentation-verification/shots/1280x720-newgame-first-area.png) | The happy path: GAME > easy restarted demo1, and the first area has the crosshair, the opaque HUD and the text-only health on it. |
| [`shots/1280x720-high-weapon.png`](presentation-verification/shots/1280x720-high-weapon.png) and the other mode shots | The acceptance captures now show the same fixes in every lighting mode: a visible crosshair, a solid HUD band with no old digits, and text-only HEALTH/ARMOUR/AMMO. |

A nearest-neighbour enlargement of the HEALTH/100 area of
`shots/1280x720-hud-covered.png` shows plain fill under both the label and the
number; the pixel check above is the same fact in numbers.

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
  both 1280x720 and 2560x1440; the 2560 weapon capture measures an arm-vs-ring
  score of 113.8, so it is drawn there too, but the paired off/on diff was
  measured at 1280x720.
- **Rows whose application is the generic reload path.** The runner reads every
  row and its cvar/action wiring, checks the value lists called out above, and
  exercises the resolution reload end to end. The other settings rows use the
  same `+set` apply path, but this run did not restart the level once per cvar.
