# Mobile input: the six bugs, measured, and one command that keeps them fixed

This pass integrated the three parts of the touch-control work — the controls
fix (t1), the numeric engine telemetry (t2) and the input gate (t3) — and ran
them together on one checkout. Every number below was read from the running
WASM engine, never from the source. The one command that proves it:

```sh
CHROME_PATH=/opt/google/chrome/chrome node scripts/mobile-input-gate.mjs --phone
```

Result on this checkout: **PASSED 34/34 checks, exit 0** (phone mode, 844x390,
five screenshots, desktop leg). `--phone` switches the same 34 checks from the
default 640x360 numeric mode to the phone viewport and adds the four 844x390
pictures; the default command runs the identical checks without the phone
pictures (it still writes the desktop shot).

The raw numeric report is `docs/mobile-input-verification/report.json`; the
screenshots are in `docs/mobile-input-verification/shots/`. The longer
per-fix write-up is kept in `docs/mobile-input-fixes.md`, and the telemetry
derivation in `docs/mobile-input-telemetry.md`; both are summarised below.

## What was measured, and how

- Page served by this checkout's `server.js` on a free port with a temporary
  `QUAKE2_DATA_DIR`; Chrome `/opt/google/chrome/chrome` on its own free
  debugging port. Port 4231 and debugging port 18801 were never touched.
- Phone leg: 844x390, deviceScaleFactor 1, touch emulation on, mobile UA.
  The numeric default is 640x360 with no phone screenshots (the fast logic
  mode the brief asked for).
- Assertions are numbers from `window.quake2Engine.read()` — position, yaw and
  pitch, `keyDest`, `ammo`, `weaponIndex` — and from
  `window.quake2Touch.state()` for the touch layer. No check is a screenshot
  comparison; screenshots exist only for the visual states the brief names.
- Every input is a **trusted CDP** event. The gate contains no page-side
  `dispatchEvent` at all; the complete input surface is:

| line | call | drives |
| --- | --- | --- |
| `scripts/mobile-input-gate.mjs:452` | `cdp.send("Input.dispatchTouchEvent", …)` | starts, moves, ends and cancels every finger |
| `scripts/mobile-input-gate.mjs:508` | `cdp.send("Input.dispatchKeyEvent", …)` | console arming, W/Escape, engine keys |
| `scripts/mobile-input-gate.mjs:1754`, `:1756` | `cdp.send("Input.dispatchMouseEvent", …)` | desktop click to take the pointer lock |
| `scripts/mobile-input-gate.mjs:1808`, `:1810` | same | desktop left-button FIRE |
| `scripts/mobile-input-gate.mjs:1851`, `:1868`, `:1875` | same (`mouseMoved`) | desktop look moves |
| `scripts/mobile-input-gate.mjs:1947`, `:1949` | same | desktop click on the canvas |

`grep -n dispatchEvent scripts/mobile-input-gate.mjs` returns nothing, so no
control in this gate is driven from page script. The page's own
`mobile-controls.js` does dispatch synthetic DOM events — that is the product
under test, not the test input.

## The one root cause

A finger that reached the game canvas went through the **engine's own touch
path**: it fired (+attack), turned the view at the engine's gain, and took
pointer lock. Once the lock was held every pointer event in the page reported
`clientX/clientY` **0,0** and was retargeted to the canvas. The touch layer was
a transparent overlay (`#mc-look` had `pointer-events: none`), so on a phone
the first tap handed everything to that path: the stick computed "up-left" from
(0,0), the buttons stopped receiving their own touches, and any tap shot.

The fix is architectural, not a patch to one handler: `#mc-look` is now a
full-picture capture surface (`pointer-events: auto`, above the canvas) that
takes every touch, converts look drags into a synthetic mouse path, and the
touch page refuses pointer lock. FIRE is the only control that sends
`mousedown`/`mouseup`.

What the fix changed, by file:

- `mobile-controls.js` — full-picture look capture and synthetic look path;
  FIRE at the tracked cursor with full release handling (`pointerup`,
  `pointercancel`, `lostpointercapture`, `blur`, `document.hidden`); the stick
  rejects non-finite/`0,0` readings; pointer-lock request is refused on a
  touch page; the look cursor is primed once per page, not once per gesture.
- `style.css` — `#mc-look` covers the picture and takes pointer events; the
  full-screen button sits above it (`z-index: 9`).
- `index.html` — cache-busting versions bumped (`style.css?v=touch5`,
  `mobile-controls.js?v=touch4`).
- `app.js` — a pointer lock dropped on a touch page is not treated as Escape
  (the hybrid-laptop pause bug).
- `engine-state.js` — `weaponIndex` and `ammo` readings (the telemetry needed
  to assert a weapon switch and a shot).
- `scripts/mobile-controls-test.mjs` — one expectation updated to the new
  look surface (its centre's topmost element is `#mc-look`); it now passes
  95/95 unchanged on this checkout.

## The six owner bugs, before and after

### #1 `< wpn` and `wpn >` do nothing — hypothesis partly confirmed

**Hypothesis:** `[` and `]` are not default binds and the generated
`q2touch.cfg` may not be installed/exec'd. **Verdict:** the binds were present
and executed — the dead-button cause was the pointer lock above, not a missing
bind. Measured at runtime, not on disk: the boot query carried
`+exec q2touch.cfg`, the console logged `execing q2touch.cfg.`, and
`FS.readFile("/baseq2/q2touch.cfg")` returned
`bind [ "weapprev"` / `bind ] "weapnext"` (gate check 5c,
`engineExecutedCfg: true`).

- **Before** (`docs/mobile-input-fixes.md`): pointer lock = **canvas**; every
  press the buttons received carried `clientX/clientY` **0,0** (`#mc-next`
  (0,0), `#mc-prev` (0,0)).
- **After** (gate 5e): real coordinates on the buttons — `#mc-next` **(807,151)**,
  `#mc-prev` **(755,151)** at 844x390; trusted NEXT then PREV moved the live
  weapon **`weaponIndex` 105 -> 82 -> 105** with the give-all loadout. With
  only the blaster the same buttons leave it at **61 -> 61 -> 61** (`5a`),
  which is the correct "nothing to switch to" result.

### #2 Any tap on the picture fires the weapon — confirmed

**Hypothesis:** `#mc-look`'s `pointer-events: none` lets the engine's canvas
path fire. **Verdict:** confirmed.

- **Before:** a 3 s press on empty picture spawned **2** moving entities (both
  `modelindex 45`, a blaster bolt) and took pointer lock.
- **After** (gate 1, three taps at 422,70 / 253,98 / 591,86):
  **ammo 200 -> 200**, yaw **0.000°**, pitch **0.000°**, new entities **0**,
  `mousedown` counter **0**, `fireHeld` false.
- **Positive control** (gate 2a): holding `#mc-fire` fired **10 rounds**
  (ammo **200 -> 190**), `fireHeld: true`, exactly **1** `mousedown`, and the
  view stayed at **0.000° / 0.000°**. Release left ammo stable at 190 (`2b`).

### #3 JUMP works — confirmed, and made reachable again

**Hypothesis:** Space is a default Quake 2 bind, so the synthetic key already
reaches the engine; only the lock made the button unreachable. **Verdict:**
confirmed.

- **Before:** once a tap had taken the lock, `#mc-jump` held no keys and `z`
  stayed flat at **-25.812** for the whole hold (the button never got the
  touch).
- **After** (gate 5b, demo2 spawn): z **-105.8125 -> -72.5625 -> -105.8125**,
  rose **33.25** units and landed; the touch layer reported the `jump` key
  held during the press.

### #4 The thumbstick only walks forward — confirmed, reproduced exactly

**Hypothesis:** `stickVector()` reads `getBoundingClientRect()` correctly but
the locked-pointer `0,0` reading makes every press "up-left". **Verdict:**
confirmed.

- **Before:** every press at ring centre or at 70 % radius delivered
  `clientX/clientY` **0,0** and held **`["forward","left"]`**; a centre press
  with no movement walked the player **dx -118.5, dy +66**.
- **After** (gate 4a–4c, at 70 % of the ring radius):
  centre press holds **no keys** and moves **0.0 units**;
  the eight directions move **59.8–60.1 units** with the expected components —
  N `fwd 60.0 / right 0.0`, NE `fwd 42.5 / right 42.3`,
  E `fwd 0.0 / right 60.0`, SE `fwd -42.3 / right 42.3`,
  S `fwd -60.0 / right 0.0`, SW `fwd -42.3 / right -42.5`,
  W `fwd 0.0 / right -60.0`, NW `fwd 42.5 / right -42.5`;
  release moves **0.0 units**.

### #5 Holding and dragging turns the camera — confirmed, kept as the look gesture

**Hypothesis:** this is the engine's canvas mouselook path, which also fires
and locks. **Verdict:** confirmed; the drag itself is the intended control and
now runs on `#mc-look` without firing or locking.

- **Before:** a 112 x 16 px drag turned yaw **-29.037°**, pitch **+4.087°**,
  with the engine lock taken on the first touch.
- **After** (gate 3a/3b): a 120 x 70 px drag left+up turned yaw
  **+31.152°**, pitch **-18.215°**; the mirrored drag right+down turned yaw
  **-31.152°**, pitch **+18.215°**; ammo unchanged (**184 -> 184**) and
  **0** new entities. A tap on the same surface turned **0.000° / 0.000°** and
  fired nothing (3c). Pointer lock stayed **null**.

### #6 Fix all mobile buttons and prove them — done

The gate's 34 checks cover FIRE, JUMP, USE, PREV, NEXT, PAUSE/MENU, PAD,
the 8-way stick, look, two-finger combinations, `touchCancel`, tab hide, the
portrait guide and the desktop path. All passed with numbers:

| group | checks | result |
| --- | --- | --- |
| setup / setup-arm | 2 | pass: `keyDest 0`, not dead at the spawn; ammo **200**, `weaponIndex` **105** |
| 1 tap on the picture | 1 | pass: 3 taps, 0 shots, 0.000° |
| 2 FIRE hold / release / pointercancel | 3 | pass: 200 -> 190, stable 190, cancel 184 -> 184 |
| 3 look drag both directions / tap | 3 | pass: ±31.152°, ∓18.215°, no shot |
| 4 stick centre / 8 directions / release | 3 | pass: 0 units, 59.8–60.1 units, 0 units |
| 5 JUMP / USE / PREV+NEXT / PAUSE / PAD | 7 | pass (numbers below) |
| 6 two fingers (stick+FIRE, look+FIRE, stick+look) | 3 | pass: 185.8 units + 9 rounds; 30.9° + 18 rounds; 54.2 units + 20.85° |
| 7 touchCancel FIRE / stick | 2 | pass: released, ammo stable, next press works |
| 8 tab hide / return | 2 | pass: keys [] fireHeld false, ammo 147 -> 147, next press fires |
| 9 portrait guide / stray tap / pause | 3 | pass |
| 10 desktop | 5 | pass (numbers below) |

Buttons in detail:

- **USE** (5c): held and released the engine's `+use` key; the observed
  keylog is `down e vk 69` then `up e vk 69`; the cfg really executed
  (`engineExecutedCfg: true`); `keyDest` stayed **0** and the player alive.
  No door is provable on these maps, so the check proves the binding and the
  key the button presses, stated honestly in the report.
- **PAUSE/MENU** (5f): `keyDest` **3** while paused, pad display **none**,
  `menu-open` true, and Resume returned `keyDest` **0**.
- **PAD** (5g): pad on -> off (`stickDisplay: none`) -> on
  (`stickDisplay: block`).

## The movement map (and why this one)

The gate ranks two free-roam deathmatch candidates and uses the best:
**demo2 in deathmatch**, spawn **(-911.9375, -71.9375, -105.8125)**. demo1 (the
intro demo) is not used. Ranking:

| candidate | directions open at 200+ units | smallest clearance |
| --- | --- | --- |
| demo2-dm | **5 / 8** | 34 units |
| demo3-dm | 3 / 8 | 0 units |

No candidate is fully open, so the report records `fixture.qualified: false`
with every per-direction distance; a shortfall is never counted as a failed
check. The eight stick directions are measured under the engine's `noclip`
(cheats are already on): demo2's spawn sits on a ledge above a pit and this
box's engine speed makes even a short excursion fall in, which would kill the
player for later checks. Noclip removes the geometry, not the assertion: each
direction is one fixed push and release and must put at least 80 % of the
travel on the expected axis (35 % per axis for a diagonal). The map is
reloaded after the stick group so checks 5–8 run from the spawn with normal
physics.

## Desktop path: still works, headful under Xvfb

At **1280x720**, touch emulation off (`10a`): `isTouchUi false`,
`touchUiClass false`, controls `display: none`.

Headless Chrome was tried first and reported the locked look moves as
**net-zero**, so the leg was re-run **headful under Xvfb** on its own display
(`:96`) and debugging port; that is the mode that worked and the report records
`mode: headful-xvfb`.

| check | measurement |
| --- | --- |
| 10b pointer lock | `document.pointerLockElement` = **`canvas`** (before and after the look) |
| 10c mouse look | 5 trusted moves of +30/+10 px delivered `movementX 30, movementY 10` each; yaw **-21.116°**, pitch **+6.998°**, roll 0, lock retained |
| 10d left click | ammo **200 -> 194** (6 rounds) |
| 10e keyboard | W moved the player **231.9 units**, `keyDest 0` |

The desktop look signs match the touch look signs (right/down lowers yaw and
raises pitch); the desktop page never turns the touch layer on.

## Small extra bugs found and absorbed

- **Look jumped at the start of a drag.** The engine keeps the last mouse
  position; re-priming the cursor at the canvas centre on every gesture added
  the distance from the previous drag's end to the centre: a fresh 14 px drag
  turned **3.56°** before the finger moved. The cursor is now primed once and
  later gestures continue from it.
- **A lost touch could brick FIRE.** A missed `touchend` left a pointer id
  owned by a button, so the next press was ignored for the rest of the
  session. `releaseAll()` now clears the button-pointer map; `touchCancel`,
  `blur`, `document.hidden` and page hide all release every key, attack and the
  look capture. Measured in gate 7/8: cancel leaves `keys []`,
  `fireHeld false`; the next press fires again.
- **A first finger touch on a hybrid laptop opened the pause menu.** A mouse
  that had taken the pointer lock dropped it when the touch layer woke; app.js
  read the lost lock as Escape. Guarded with the same `touchUiActive()` check
  the rest of its pointer-lock code uses; a first touch now leaves `keyDest`
  0.
- **FIRE could turn the view.** A `mousedown` at the canvas centre moved the
  engine's reference point (measured: hundreds of degrees after a drag). FIRE
  now presses at the tracked look cursor and sends `movementX/Y 0`; measured
  **0.000°** in check 2a.
- **The stick invented a direction from a non-reading.** A non-finite or
  `0,0` pointer event now holds nothing instead of "up-left".
- **The engine telemetry had no weapon or ammo.** `read()` now reports
  `weaponIndex` (`gunindex`, int32 at **0x058830**) and `ammo`
  (`stats[3]`, int16 at **0x058850**), each `null` with a reason when
  unreadable, never a fabricated zero. This is what lets the gate assert a
  weapon switch and a shot as numbers; the derivation and the eight-weapon
  trace are in `docs/mobile-input-telemetry.md`.
- **Harness-only bugs found and absorbed:** the deathmatch fixture respawns
  with the blaster only, so every ammo group re-arms through trusted CDP keys;
  headless Chrome can report CDP mouse moves as net-zero pairs, so the desktop
  leg retries headful; the stats array is momentarily unreadable while the page
  resizes for portrait, so the portrait ammo read polls instead of failing on
  null; and a CDP touch the page misses is re-sent once rather than counted as
  a control failure.

## Phone screenshots (844x390)

All four are in `docs/mobile-input-verification/shots/` and were captured by
the gate itself:

| file | state |
| --- | --- |
| `phone-landscape.png` | pad live in the game: stick, FIRE, JUMP, USE, WPN pair, PAD/MENU/Full screen; HUD 100 health / 200 armour / 200 ammo |
| `phone-look-drag.png` | look drag **mid-gesture** (finger still down): the view is visibly turned off the spawn axis, controls still overlaid, no fire |
| `phone-menu.png` | engine/page menu open over the game, touch pad hidden, GAME/MULTIPLAYER/OPTIONS/VIDEO/QUIT |
| `phone-portrait.png` | 390x844 rotate guide: "Rotate your device — Quake 2 plays in landscape…" with the pad hidden |

The portrait check also proves a tap where FIRE would be fires nothing
(ammo **138 -> 138**, `mousedown 0`) and that pause/Resume still work
(`keyDest 3 -> 0`).

## The Store package (measurement only; nothing published)

Reproduced the slim tarball from `docs/store-package-1.0.0.md` without
touching the branch, the real index or the working tree. A throwaway index was
built from `HEAD` and the same three paths were removed the same way:

```sh
TMPIDX=$(mktemp -u /tmp/q2-slim-index.XXXXXX)
GIT_INDEX_FILE=$TMPIDX git read-tree HEAD
GIT_INDEX_FILE=$TMPIDX git rm -r -q --cached docs assets baseq2/pak9.pak
GIT_INDEX_FILE=$TMPIDX git ls-files -z --cached --others --exclude-standard \
  | tar --null -T - -czf /tmp/q2-slim.tgz
stat -c %s /tmp/q2-slim.tgz
```

This leaves `HEAD`, the branch, the real index and every tracked file
untouched (the only writes are the temporary index and the temporary tarball).
The archive is `baseq2` (pak0 + pak10), `engine/`, app code, icons, control,
scripts and the root files: `docs/`, `assets/` and `baseq2/pak9.pak` are
excluded, exactly as the 1.0.0 publish did.

**Measured compressed size: 49,357,810 bytes** (47.071 MiB; 81 files; the
archive holds only `baseq2/pak0.pak` and `baseq2/pak10.pak` under `baseq2/`,
with no `docs/`, `assets/` or `pak9` entry). The limit is 52,428,800 bytes
(50 MiB): **under it by 3,070,990 bytes (5.9 %)**. Nothing was published,
pushed or merged by this pass.

## Verification commands

```sh
CHROME_PATH=/opt/google/chrome/chrome node scripts/mobile-input-gate.mjs --phone
# PASSED: 34/34 checks, exit 0  (this run; 11 min)

CHROME_PATH=/opt/google/chrome/chrome node scripts/mobile-controls-test.mjs
# PASSED: 95/95 checks, 6 screenshots, exit 0  (this checkout; no check needed
# changing -- the look-surface expectation already matched the fix)

node scripts/engine-state-test.mjs
# all 48 checks passed (vm/stub tests for the weapon/ammo reader)
```

## Files changed by this pass

- `scripts/mobile-input-gate.mjs` — three phone-only captures added (pad live,
  look drag mid-gesture, menu open); the checks themselves are unchanged.
- `docs/mobile-input-verification/report.json`, `.../shots/*.png` — the
  passing 34/34 phone-mode report and its five screenshots.
- `docs/mobile-input-report.md` — this document, which absorbs the six-bug
  before/after table from `docs/mobile-input-fixes.md` and the
  weapon/ammo derivation from `docs/mobile-input-telemetry.md`; both source
  documents are kept.
- `CHANGELOG.md` — the release note.

No pak, WASM or art file was touched; nothing is published.
