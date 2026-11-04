# Mobile input verification gate

One command runs the whole input gate against the real app in Chrome:

```sh
node scripts/mobile-input-gate.mjs
```

Exit code 0 means every check passed; any failure exits 1 (and a watchdog exit 3
if the run wedges). The numeric report lands in
`docs/mobile-input-verification/report.json`; screenshots, when requested, in
`docs/mobile-input-verification/shots/`.

## What it proves

Every input is a trusted CDP event (`Input.dispatchTouchEvent`,
`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`). Nothing is dispatched
from page script, and every assertion is a number read out of the live engine
through `window.quake2Engine.read()` — position, angles, `keyDest`, `ammo`,
`weaponIndex` — or out of `window.quake2Touch.state()` for the touch layer.

The checks:

1. A tap away from the controls fires nothing and turns nothing.
2. FIRE press/hold fires (ammo falls and/or a new entity appears), release
   stops it, the view stays within 1°, and `pointercancel` releases it.
3. A look drag on `#mc-look` turns yaw and pitch by more than 5° in the
   expected directions without firing; a tap there fires nothing.
4. The thumbstick: centre press holds no keys and moves < 1 unit; the 8
   directions at 70% of the ring radius move the player in the right
   direction; release stops.
5. Buttons: JUMP raises z and lands; USE presses/releases the engine `+use`
   key and the cfg that binds it really executed; PREV/NEXT change
   `weaponIndex` with the give-all loadout and leave it alone with only the
   blaster; PAUSE opens the engine menu (`keyDest 3`) with the pad hidden and
   Resume returns; PAD hides and shows the pad.
6. Two fingers: stick+fire, look+fire and stick+look work in the same window.
7. `touchCancel` on held fire and held stick releases them, stops the
   player/ammo and the next press works. The stick stop is compared with the
   floor's own drift measured just before the press and with the distance the
   held stick produced: demo2's ground slides the player with no key held and
   the engine carries a little slide after any release, so the check must prove
   the cancel released the stick (under a fifth of the held push), not that the
   floor is perfectly flat. A CDP touch the page misses is re-sent once; it is
   not counted as the control failing.
8. Hiding the tab releases held stick+fire (position and ammo stop) and the
   next press after returning works.
9. Portrait (390x844): the rotate guide is visible, the pad hidden, pause
   reachable, and a tap where FIRE would be fires nothing. The player is
   brought back and re-armed while the landscape pad is still on screen (the
   rotate guide hides it), and the ammo is read until the engine yields a
   number — the stats array is briefly unreadable while the page resizes.
10. Desktop (1280x720, touch emulation off): no touch layer; a trusted click
    takes pointer lock; trusted mouse moves change yaw/pitch; the left button
    fires; W moves the player. If headless Chrome refuses pointer lock, or
    reports its CDP moves as net-zero pairs, the gate retries headful under
    Xvfb with its own display and debugging port, and the report says which was
    used.

## Options

```sh
node scripts/mobile-input-gate.mjs --phone      # also capture 844x390 phone screenshots
node scripts/mobile-input-gate.mjs --url http://127.0.0.1:PORT/apps/quake2/
node scripts/mobile-input-gate.mjs --only 4     # debug aid: report only one check group
node scripts/mobile-input-gate.mjs --out DIR    # report elsewhere
```

Numeric checks run at 640x360 with `deviceScaleFactor: 1`; the desktop shot is
always captured, and `--phone` switches the same checks to 844x390 and adds
the phone screenshots of the visual states.

## Fixture

The gate starts `server.js` on a free port with a temporary
`QUAKE2_DATA_DIR`, boots the app through headless Chrome, and looks for a
free-roam map as the brief asks. It tries demo2 in deathmatch, then demo3 in
deathmatch, and for each requires `keyDest 0`, an alive player, a forward key
move of more than 100 units, and then measures all 8 movement directions from
the spawn itself (out and back, so the next direction starts from the spawn
again) with a 200-unit bar. When a return walk cannot get back to the spawn,
the map is loaded again before the next direction, so a direction is never
measured from a room the walk happened to end in. Demo3 single-player is
measured only if neither deathmatch boot is controllable: a deathmatch death is
one trusted FIRE press away from a respawn and an arming, a single-player death
is not.

No candidate meets 200 units in all 8 directions on this build: demo2 has walls
and a short east side, demo3's spawn faces a wall. The gate therefore ranks the
candidates by how many directions qualify and then by the smallest clearance,
picks the best one (in practice demo2 in deathmatch), and records the shortfall in
`report.json` (`fixture.qualified: false`, a `fixture-shortfall` note, and every
per-direction distance). A shortfall is never counted as a failed check; the
map actually used, its spawn and its numbers are in the report.

The movement checks run at the chosen map's own spawn — the only spot whose
eight clearances were measured. The stick group itself runs with the engine's
`noclip` on (cheats are already on): demo2's spawn sits on a ledge above a
100-unit pit and this box runs the engine at several hundred units/s, so even a
20-unit excursion crossed the step and the return walks fell in, leaving the
player dead for every later check. Noclip removes geometry from the
measurement, not the assertion: each of the eight directions is one fixed push
and release, and its displacement must put at least 80% of the travel on the
expected axis (at least 35% on each axis for a diagonal) — a wrong or swapped
direction fails. The gate reloads the map after the stick group, so the button
checks run from the fixture spawn with normal physics.

`+set&cheats&1` is added to the boot query so the engine console accepts
`sv_cheats 1;give all`; this build refuses `give all` otherwise. The arming
keys are trusted CDP key events typed into the engine's own console. In this
deathmatch fixture a death respawns the player with the blaster only, so before
each check group that reads ammo the gate verifies the player is alive and
re-runs the same trusted arming if the loadout was lost. The desktop leg arms
the same way and repeats the pass up to three times if the page misses a
keystroke and the loadout stays empty (a dead player is first brought back with
a trusted left press, the player's own deathmatch respawn gesture).

No door is provable on demo2/demo3 in this harness, so the USE check proves the
installed `+use` binding and the key the button presses instead of a door.

The desktop leg runs in its own freshly launched Chrome, so the phone and
portrait emulation cannot leave the pointer at a stale position. On that page
app.js takes the pointer lock itself inside the key event that closes the
engine console; the look check measures under that lock first. If this Chrome
then reports the CDP moves as net-zero pairs (it can pin the cursor at a stale
point), the check releases the lock and takes a fresh one with its own trusted
click — inside app.js's lost-lock window, so the game does not read the gap as
Escape — and measures again. When even a fresh lock yields net-zero pairs, the
whole desktop leg is re-run headful under Xvfb, which is where this box
measures the look correctly; `report.json` then records `mode: headful-xvfb`.
