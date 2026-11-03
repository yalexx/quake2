# Release 2026-11-03 — settings in the menu, a quiet boot, 2x view weapons

Final integration notes for the five changes that landed on this branch
(`1caeae0` settings, `50fb0e5` boot and full screen, `dac5c29` weapon art,
`85994fa` neutral weapon albedo, `d1e4ae6` weapon verification). The gate
below ran on this checkout with its own server on port 4391 and its own
headless Chromium on a spare debugging port; the live server on 4231 and the
kiosk browser on 18801 were not used.

## What changed

- **LIGHTING and OPTIONS live in the menu panel.** The floating lighting chip
  and the top-right options control are gone; `LIGHTING` is the last group of
  the OPTIONS view inside `#menu`, next to the engine's own rows. The PAD
  toggle (`#mc-toggle`) and the Full screen button stay on the play layer, at
  44 px, and the interface poll never shows one while the menu is open.
- **Boot lands on the game.** `window.quake2BootFrame` records the first frame
  the engine's surface is up: `keyDest` 0 (game), `consoleOpen` false, at
  3,103 ms, and still 0 after 5 s. Every `+set` cvar of the start-up line is
  still passed and demo1 still starts (175 entities). The app watches the
  engine's `cls.key_dest` during boot and closes a console with the engine's
  own Escape if one ever appears, recording that it had to.
- **Full screen only on its button.** `document.fullscreenElement` is null
  after load, still null 3 s after the first canvas click, and a second click
  does not take the screen; the button enters full screen and Esc leaves it.
- **View weapons at 2x.** All 13 skin PCXs in `baseq2/pak10.pak` are exactly
  twice the pak0 picture (palettes byte-identical, cut-out exactly 4x); mean
  saturation 0.315 -> 0.327. The muzzle collar is bound to the barrel face it
  rides: worst material mismatch 20 (was 176), worst edge 68.3 (was 203), and
  18 of the pistol's 20 added parts are bound to their own face. The RTX
  renderer shades view weapons through its neutral albedo path
  (`weaponNeutralDraws`), so they read as weapon steel and not as grey.

## What did not change

The engine's own HUD, status bar and digit reading are untouched (no `#hud`
element exists; the health/ammo/armour band is the engine's). The desktop
1280x720 presentation is unchanged apart from the settings removal and the
boot/full-screen behaviour: `#menu` is 392 px wide with the 26 px heading, the
full-screen button sits at left 12 / bottom 52, and the canvas is letterboxed
to the engine aspect. The touch top row (PAD, MENU, Full screen) still carries
three 44 px targets and the material, model and wall art are as shipped.

## The gate

Every command below exited 0. Ports: this checkout's `server.js` on 4391 (its
own `QUAKE2_DATA_DIR`), presentation and mobile suites on their own free
debugging ports. Logs are in `logs/`, reports beside this note.

| # | command | result |
| --- | --- | --- |
| 1 | `node scripts/engine-state-test.mjs` | 35/35 checks |
| 2 | `node scripts/route-test.mjs` | 196/196 checks |
| 3 | `node scripts/control-api-test.mjs` | PASS, every route exercised against a live game on this checkout's own server and browser |
| 4 | `node scripts/mcp-smoke-test.mjs` | PASS |
| 5 | `node scripts/mobile-controls-test.mjs --url …:4391…` | 95/95 checks, 6 screenshots |
| 6 | `node scripts/verify-presentation.mjs --url …:4391…` | 248/248 checks |
| 7 | `node scripts/boot-probe.mjs --url …:4391…` | 16/16 checks |
| 8 | `node scripts/weapon-verify.mjs` | 51/51 checks, 23 in-game captures |
| 9 | `node scripts/tex-check.mjs --only models/` | 125 pictures of 611 entries: 0 wrong size, 0 unreadable, 0 unclaimed |
| 10 | `node scripts/texture-pack.mjs --dry-run --only models/` | 125 packed, 0 failed, 0 without art |
| 11 | `node scripts/model-geometry.mjs --dry-run` | 13 skins at 2x; 4,433 -> 18,034 verts, 7,991 -> 32,724 tris; nothing written |
| 12 | `node scripts/texture-audit.mjs --select` | 20 entries selected (16 skipped, listed) |

The layout re-check in `layout/layout.json` repeats the owner's three
questions with numbers: at 844x390 and 932x430 the top row does not collide
with itself, the weapon pair, FIRE, the stick or the hint, and the page has no
horizontal overflow; at 1280x720 `#menu` is 392 px and the heading 26 px.

## The Store package (1.1.0 measurement)

Measured the way `docs/store-package-1.0.0.md` describes: the tracked runtime
files with `docs/`, `assets/` and `baseq2/pak9.pak` left out, listed from git
and packed in a temp directory with `tar | gzip -6`. The .gitignore and the
index were not changed; no publish was made and nothing was pushed.

| | bytes |
| --- | ---: |
| tarball (80 files) | **49,324,080** (47.04 MiB) |
| cap (`PACKAGE_MAX_BYTES`, 50 MiB) | 52,428,800 |
| **margin under the cap** | **3,104,720** (2.96 MiB), 5.92 % |
| published 1.1.0 | 45,650,125 |
| difference vs 1.1.0 | +3,673,955 (+8.05 %) |

This is the measurement of the committed tree, and it reproduces exactly: the
same list and `tar | gzip -6` give the same bytes, sha256
`8fd76cb550f9dfc535ab10ddb2201407e5618d9fe3bc528190a0fb910510c06a`. This note
and every other file under `docs/` are not in the package, so editing it does
not move the number; `CHANGELOG.md` is in the package, which is why it states
the size approximately.

`baseq2/pak10.pak` accounts for most of the difference: 12,118,560 ->
13,770,565 bytes (+1,652,005 raw, +887,685 with `gzip -6` alone) — exactly
the 13 added 2x view-weapon PCX entries.

The package is 3.1 MB under the cap, so nothing had to be dropped. The levers,
in order, if it ever needs to shrink: the two `design/` reference PNGs are
3,115,810 bytes of already-compressed picture that no runtime path reads
(without them the same tarball is 46,203,692 bytes); `pak9` is already out and
would add 41,205,225 bytes of nearly incompressible wall art if it came back;
and every other runtime file together (scripts, control, mcp, README) is
940,956 bytes compressed.

## Fixed (test-only, no app code)

- `scripts/verify-presentation.mjs` read the view weapon's skin from
  `baseq2/pak0.pak` and waited for a 296x164 draw. The engine mounts pak10
  after pak0, so the blaster binds pak10's 592x328 skin and the check failed
  with "0 draws of the 296x164 blaster skin over 17 frames". It now resolves a
  model skin from pak10 first (pak0 as the fallback, `base.pcx` included for
  v_flareg), checks the drawn size is unique among every model skin in both
  archives, and reports which archive supplied it.
- `scripts/mobile-controls-test.mjs`'s USE check aimed at "func_button *7's
  model centre" at (1692,1408) — the map puts *7 at (640,253,-414), 1,606
  units from the spawn — and counted any entity that moved as a door opening,
  which a wandering monster satisfies and no button there can. It now checks
  the control's actual contract: the engine's own `q2touch.cfg` (read from the
  engine's file system) binds `e` to `+use`, the USE button presses exactly
  that key, and the keyboard stays with the game.
- The same suite measured the first-show hint only after the game-state wait,
  by which time the 9 s hint had hidden itself on a loaded box; the box is now
  measured while the hint is up. Two presentation checks gained the suite's
  own retry pattern: a dropped trigger press and a crosshair pair captured
  with the page menu up both retake instead of failing the run.
- `scripts/weapon-verify.mjs` gained three read/typing guards that its own
  evidence needed on a loaded box: a cvar read that echoes but carries no
  value (measured: `]cl_gun` answered with `==== ShutdownGame ====` in the
  second after the first frame) is retried; the console is opened and
  *confirmed* before a command is typed, because a lost toggle typed the
  command into the game as movement (measured: the view moved 300,481 pixels
  between two captures, every weapon stayed the shotgun); and any movement
  key that might have been left down is released before a retry.
