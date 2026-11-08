# Touch controls: the owner's six bugs, measured

Owner's report: `< wpn` and `wpn >` do nothing; any tap on the picture fires
the weapon; JUMP works; the left thumbstick only walks forward; holding and
dragging the picture turns the camera; "fix all mobile buttons".

Every number below came from the running WASM engine, not from reading code.
The page was served by this checkout's `server.js` (`PORT=0`,
`QUAKE2_DATA_DIR=$(mktemp -d)`) and driven by a headless Chromium
(`CHROME_PATH=/opt/google/chrome/chrome`) over trusted CDP
`Input.dispatchTouchEvent` / `Input.dispatchMouseEvent` at **844x390, touch,
mobile UA**. State was read through `window.quake2Engine.read()`,
`window.quake2Engine.entities()` and `window.quake2Engine.keyDest()`.
"Before" means the pre-fix files from `HEAD`, served from the same checkout
(they are the code the owner played); "after" means this branch.

The one root cause under most of the report:

> A finger that reaches the game canvas is handled by the engine's **own touch
> path**. That path fires (+attack), turns the camera at its own gain, and asks
> for **pointer lock**. Once the lock is held every pointer event in the page
> reports `clientX/clientY` **0,0** and is retargeted to the canvas. A stick
> press then computes "up-left" from (0,0) whatever the finger does, and the
> buttons no longer receive their own touches.

The touch layer used to be a transparent overlay (`#mc-look` had
`pointer-events: none`) over the right-hand side, so this was exactly what a
phone player got on the first tap. The fix is architectural: `#mc-look` is now
a full-picture capture surface that takes every touch, sends the engine a
synthetic mouse path for look, and the touch page never holds pointer lock.

## 1. Weapon buttons "do nothing" — partly confirmed, cause found

**Before** (`probe/wpn-before.json`, measured after one tap on the picture):

- pointer lock: **canvas** (held)
- every `pointerdown` the buttons received carried `clientX/clientY` **0,0**
  (`#mc-next` (0,0), `#mc-prev` (0,0))

**After** (`probe/wpn-after.json`):

- pointer lock: **null**
- real coordinates on every press: `#mc-next` **(807,151)**, `#mc-prev`
  **(755,151)**
- the cycle ran in both builds: `v_blast -> v_shotg -> v_hyperb/v_shotg2 ->
  v_machn -> v_hyperb/v_shotg2 -> v_shotg -> v_blast`

Honest qualification: in headless Chromium the pre-fix buttons still *cycled*
even though every event was at 0,0 — CDP's touch hit-testing delivered the
press to the button anyway. On a real phone a 0,0 pointer is delivered to
whatever is at the top-left of the page (the canvas), so the button never gets
it; that is the owner's dead button. The harness reproduces the coordinate
corruption with certainty and the "no effect" only by inference. What is
measured is that after the fix every weapon press arrives at the button's own
coordinates and the cycle is intact (the suite also checks the synthetic `[` /
`]` key down/up pair).

The engine's bindings are real at runtime, not just on disk: the console log
of a live session contains `execing q2touch.cfg.`, and the cfg text is
`bind e "+use"`, `bind [ "weapprev"`, `bind ] "weapnext"`.

## 2. Any tap fires the weapon — confirmed

**Before** (`probe/attack-before.json`), a 3 s finger press on empty picture:

- **2** new moving entities spawned, both `modelindex 45` (a blaster bolt),
  moving 100 and 200 units
- pointer lock after the press: **canvas**

**After** (`probe/attack-final.json`), the same press:

- **0** new moving entities
- yaw change **0.000 deg**, pitch **0.000 deg**
- pointer lock: **null**

FIRE is now the only control that sends `mousedown`/`mouseup`. A positive
control on the same page: holding `#mc-fire` 3 s spawns **1** bolt
(`modelindex 45`, moved 200), `fireLevel` peaks at **1.0**, yaw/pitch stay
**0.000**, lock stays **null**. `pointercancel`, `lostpointercapture` and
window `blur` release attack (`probe/after-final.json`: held firing `true` ->
after cancel `false`, no buttons, no keys).

## 3. JUMP works — confirmed working, was only unreachable after a screen tap

**Before**, once a tap had taken the lock (`probe/before.json`): `#mc-jump`
held **no keys**, z flat at **-25.812** for the whole hold (the button never
received the touch).

**After** (`probe/after.json`): keys `["jump"]`, z **62.188 -> 76.813 ->
62.188** (up, then gravity). The suite's own check on demo1: start
**46.1875**, peak **79.3125**, landed **46.1875**.

## 4. Thumbstick only walks forward — confirmed, exact failure reproduced

**Before** (`probe/before.json`): every press at ring centre or at 70 % radius
in any direction delivered `clientX/clientY` **0,0** and held
**`["forward","left"]`**; a centre press with no movement at all walked the
player **dx -118.5, dy +66**. All eight directions:

| press | before keys | before moved |
|---|---|---|
| centre | forward + left | 118.5 units |
| E | forward + left | 59.9 |
| SE | forward + left | 117.8 |
| S | forward + left | 54.1 |
| SW | forward + left | 0 |
| W | forward + left | 0 |
| NW | forward + left | 0 |
| N | (none) | 0 |
| NE | (none) | 0 |

**After** (`probe/after-final.json`), 8 points at 70 % radius:

| press | keys during | keys after | moved |
|---|---|---|---|
| centre | (none) | (none) | **0** |
| E | right | (none) | 29.9 |
| SE | back + right | (none) | 14.5 |
| S | back | (none) | 0 (spawn is against a wall behind) |
| SW | back + left | (none) | 14.6 |
| W | left | (none) | 28.9 |
| NW | forward + left | (none) | 14.6 |
| N | forward | (none) | 28.9 |
| NE | forward + right | (none) | 30.0 |

The fix has two parts: the lock is never taken on a touch page (so events keep
their real coordinates), and `stickVector` rejects a non-finite or 0,0 reading
with the ring not at the origin, holding nothing instead of inventing a
direction.

## 5. Dragging the picture turns the camera — confirmed, kept as look

This is the intended look gesture; what was wrong is that it was the engine's
canvas path (which also fires and locks). It now happens on `#mc-look`, which
sends synthetic `mousemove` at an advancing position on the canvas.

- **Before** (`probe/before.json`): a 112 x 16 px drag turned yaw **-29.037
  deg**, pitch **+4.087 deg** (0.259 / 0.255 deg per CSS px), with the engine
  lock taken on the first touch.
- **After** (`probe/after.json`): the same drag, yaw **-29.037 deg**, pitch
  **+4.087 deg**, pointer lock **null**; releasing changes nothing further.
- After-final re-run: yaw **-25.472**, pitch **+3.560** — one of the eight
  14 px steps was coalesced by the browser, so 98 of 112 px reached the engine;
  the per-pixel gain is the same 0.259 / 0.255.
- A **tap** (no movement) changes neither: yaw 0.000, pitch 0.000, no fire.

Unit correction: an earlier measurement in this work reported 14.9 deg per
pixel. That was a bug in the probe (the engine reports `viewangles` in degrees
already and the probe converted again by 57.3). The true gain is ~0.26 deg per
CSS pixel on both axes.

## 6. All buttons, and the remaining paths

- **FIRE**: measured above; fires only on hold, releases on
  `pointerup`/`pointercancel`/`lostpointercapture`/window `blur`, never turns
  the view (0.000 deg) and never locks.
- **USE**: the engine has no `+use` binding in `config.cfg`, so the touch layer
  installs `bind e "+use"` in `q2touch.cfg` through `Module.preRun` +
  `+exec q2touch.cfg`. Live console shows `execing q2touch.cfg.`. The suite
  observes the synthetic `e` down and up, `keyDest` stays **0**, and the player
  is alive and standing where it was on demo3.
- **PAUSE/MENU**: keyDest **3**, pad display **none**, no movement/fire key
  held, Resume returns keyDest **0**. This already worked before the fix and
  is unchanged.
- **Robustness**: `pointercancel`, `lostpointercapture`, `touchend`, `blur`,
  `document.hidden` and `orientationchange` release every held key, attack and
  the look capture. `state()` reports `buttons: []`, `keys: []`,
  `fireHeld: false`, `lookActive: false` after each.
- **Portrait** overlay and the PAD/MENU/Full-screen top row are unchanged;
  the full-screen button was moved above the new look surface (`z-index: 9`)
  so its finger-sized tap test still passes.

## Extra bug found and fixed during this work

The look handler used to re-prime the engine cursor at the canvas centre on
**every** gesture. The engine keeps the last mouse position, so the first move
of a new drag included the distance from the previous drag's end to the centre:
a fresh 14 px drag jumped the view by **3.56 deg** before the finger moved.
Now the cursor is primed once; later gestures continue from it, and a new
touch produces 0.000 deg of its own.

## The hybrid-laptop case (fine pointer, then a finger)

On a page whose mouse had taken pointer lock (a W keypress on a fine-pointer
device), the first finger touch switches on the touch layer, which drops the
lock. `app.js`'s lost-lock handler treated that drop as the player pressing
Escape and opened the pause menu: one touch took `keyDest` **0 -> 3** and hid
the pad. Guarded in `app.js` with the same `touchUiActive()` check the rest of
its pointer-lock code uses. Measured after: first touch leaves `keyDest` **0**,
pad live, no lock.

## Desktop path untouched

1280x720, fine pointer, real mouse (`probe/desktop.mjs`, final build):

- `quake2Touch.isTouchUi()` **false**, pad `display: none`, "Click to capture
  the mouse" prompt shown
- a real click takes pointer lock (`pointerLockElement` = **canvas**)
- 100 CSS px of locked mouse movement turns yaw **-13.991 deg**
  (0.14 deg/CSS px at this canvas scale), lock retained
- the touch layer never turns on

## Verification

```
CHROME_PATH=/opt/google/chrome/chrome node scripts/mobile-controls-test.mjs
# PASSED: 95/95 checks, 6 screenshot(s)
```

Screenshots (in this run's evidence folder,
`.../run-js7rxlm5/mobile-verification/shots`): `landscape-844x390.png`,
`landscape-844x390-settings.png`, `landscape-932x430.png`,
`portrait-390x844-rotate.png`, `portrait-390x844-menu.png`,
`desktop-1280x720.png`. Raw before/after engine readings are under
`.../run-js7rxlm5/probe/`: `before.json`, `after.json`,
`attack-before.json`, `attack-final.json`, `wpn-before.json`,
`wpn-after.json`, `after-final.json`, `desktop-1280.png`.

The one modified assertion in `scripts/mobile-controls-test.mjs`: the look
centre's topmost element is now `#mc-look` with the canvas directly beneath,
instead of the canvas itself — the capture surface is the point of the fix.

## Files changed

- `mobile-controls.js` — full-picture look capture surface and synthetic look
  path; FIRE at the tracked cursor with full release handling; stick
  coordinate guards; pointer-lock refusal on touch pages; single cursor prime.
- `style.css` — `#mc-look` covers the picture and takes pointer events; the
  full-screen button sits above it; comments corrected.
- `index.html` — cache-busting versions bumped (`style.css?v=touch5`,
  `mobile-controls.js?v=touch4`).
- `app.js` — one guard in the lost-pointer-lock handler: a lock dropped on a
  touch page is not a pause (measured, see above).
- `scripts/mobile-controls-test.mjs` — the look-area expectation above.
- `docs/mobile-input-fixes.md` — this file.

No pak, WASM or art file was touched; nothing was added to the store package
but source and this document.

## Touch look: the view turns all the way round

The owner's report on 1.2.4: dragging the picture turns the view only
part-way, so you cannot turn fully round and come back the other way.
Reproduced at both landscape sizes, fixed, and measured again on the live
engine.

### Why a swipe could not turn more than one canvas width

The engine turns by the **distance between the positions of two successive
synthetic `mousemove` events** on `#canvas`. It reads `pageX/pageY`; the
event's `movementX`/`movementY` are ignored, so the touch layer keeps a
virtual cursor and moves it by the finger's own delta. The gain is about a
quarter of a degree per CSS pixel — 0.264 in the layer's own note, and the
sweeps below measure ~0.243 at 844x390 and ~0.221 at 932x430, the gain
following the canvas size.

The old `aimBy()` moved that cursor by the finger delta and then ran the
result through `clampToCanvas()`, which pinned both axes inside the canvas
rect. Once a horizontal swipe reached an edge the cursor stopped, so the
engine was told about no further travel: **one swipe could turn at most one
canvas width (~169 deg at 844x390), and from the centre only about half of
that**, and the next same-direction swipe started pinned at the edge with
nowhere left to go. That is the bug, measured on the unfixed tree (t1's
failing run, headless Chrome, identical across three runs):

| viewport | direction | per-swipe yaw before the fix (deg) | total (deg) | first move (deg) |
|---|---|---|---|---|
| 844x390 | left | 83.815, 0, 0, 0 | 83.815 | 0 |
| 844x390 | right | −97.542, −70.356, 0, 0 | −167.899 | 0 |
| 932x430 | left | 83.947, 0, 0, 0 | 83.947 | 0 |
| 932x430 | right | −88.434, −79.728, 0, 0 | −168.162 | 0 |

In the left sweep every swipe after the first added exactly 0.000 deg: the
cursor was pinned. The mirrored sweep got a second, shorter turn (−70.356 /
−79.728 deg) only because the cursor still had that much canvas to walk back
across; the two turns sum to one canvas width, and then it stopped too. The
first-move check passed before the fix for the wrong reason: with the cursor
pinned at the edge, a new swipe could not move it, so its first move measured
0 deg.

### The fix: unbounded travel, handed across the canvas without turning

Probing the engine showed the rule the old code missed: a move turns the
view by its start-to-destination distance **only while its start point is
inside the canvas**. A move that starts outside turns nothing, yet still
becomes the engine's new reference point. (Measured at both sizes, with and
without FIRE held.)

So horizontal travel is now unbounded. `aimBy()` accumulates the finger's
delta in `lookPending` and lets the cursor walk past the canvas edge instead
of clamping it. When the cursor passes a hand-off line 12 px beyond the edge,
`handOff()` sends two moves:

1. the segment's destination — this move started inside the canvas, so the
   engine turns by its full delta;
2. a re-seat 24 px inside the **far** edge — this move started outside the
   canvas, so it turns **0.000 deg** and simply becomes the new reference
   point.

The next segment therefore starts on the far side with the view exactly
where the turn left it: a re-seat adds no rotation and takes none away,
however many times it happens inside one gesture. A move that would stop
between the edge and the hand-off line is held in `lookPending` and carried
by the next move, or flushed when the gesture ends (`pointerup`, FIRE
release, `releaseAll()`), so the finger's last few pixels are neither lost
nor turned twice. Vertical travel keeps the old clamp to the canvas rect,
and `window.quake2Touch.state()` now reports `lookPending` and `lookReSeats`
for introspection. `index.html` bumps the script's cache-bust to
`mobile-controls.js?v=look125`, or the kiosk browser would keep serving the
cached, clamped file.

### Measured after the fix

The same test, same swipes, on the fixed tree (t3's green run, read from the
live engine with wrap-aware deltas):

| viewport | direction | per-swipe yaw after the fix (deg) | total (deg) | first move (deg) |
|---|---|---|---|---|
| 844x390 | left | 97.284, 97.548, 97.416, 97.416 | **+389.663** | 1.978 |
| 844x390 | right | −97.416, −97.284, −97.416, −97.679 | **−389.795** | −1.978 |
| 932x430 | left | 88.303, 88.440, 88.176, 88.440 | **+353.359** | 1.719 |
| 932x430 | right | −88.440, −88.308, −88.440, −88.308 | **−353.496** | −1.846 |

Every swipe clears the 60 deg floor, every four-swipe sweep clears 350 deg
(so a player passes 360 deg and can stop at any angle), and it works in both
directions at both sizes. The 932x430 sweep is the tight one: the canvas is
764 px wide, so four full-width swipes of 400 px each turn ~353 deg — the fix
has to deliver every pixel of finger travel, which it does.

A new gesture continues from the last cursor and is **not** re-primed, so its
first 8 px turned 1.978 deg at 844x390 (−1.978 the other way) and 1.719 /
−1.846 at 932x430: the ordinary gain for 8 px, under the 5 deg ceiling, with
no jump at gesture start. The hand-off move itself measured 0.000 deg.

### The rest of the input path is unchanged

- **FIRE** still presses at the look cursor and fires only on hold; a FIRE
  slide uses the same `aimBy()` accumulator, so it turns at the same gain and
  the hand-off stays turn-neutral with the button held.
- **Pitch** is still clamped by the engine: vertical finger travel is clamped
  to the canvas rect exactly as before, and the engine keeps its own pitch
  limit.
- **Desktop mouse look is untouched.** The touch layer only binds on a touch
  page. t3 added a guard to the suite: a real click still takes pointer lock
  on the canvas, and 300 px of locked movement turned yaw −39.595 deg
  (≈13.2 deg per 100 px, matching the gate's desktop leg) with the lock held.
- Stick, jump, WPN, menu, the pad toggle, multi-touch, portrait rotate and the
  hybrid-laptop path all pass their existing checks unchanged.

### Verification (t3's run)

```
node scripts/mobile-controls-test.mjs
# PASSED: 123/123 checks, exit 0, 0 console errors, 0 uncaught exceptions
# screenshots: 844x390, 932x430, 390x844 (portrait) + desktop, settings, portrait menu
node scripts/boot-probe.mjs        # 17/17, exit 0
node scripts/control-api-test.mjs  # PASS, exit 0 (5 skips: no game open on 127.0.0.1:18801)
node scripts/mobile-input-gate.mjs # 46/46, 0 failures, exit 0
```

The gate's look drags (3a/3b), "FIRE does not turn the view" (2a) and
fire+move+aim (6d) all PASS. This tree's gate has 46 checks; the file is
unchanged from 1.2.4's head, so the count is pre-existing (the 1.2.4 entry
quotes an older 45). No script bound port 4231 — the suite, probes and gate
each started their own server on a free port.

### Files changed

- `mobile-controls.js` — `aimBy()` drops the horizontal clamp for an
  unbounded accumulator; `handOff()` and `flushLook()` re-seat the cursor
  across the canvas without turning; `state()` reports `lookPending` and
  `lookReSeats`.
- `index.html` — cache-bust `mobile-controls.js?v=look125`.
- `scripts/mobile-controls-test.mjs` — `runLookSweep()` at 844x390 and
  932x430, both directions: four 400 px swipes, per-swipe >= 60 deg, total
  >= 350 deg, first move < 5 deg; plus t3's desktop pointer-lock guard.
- `docs/mobile-input-fixes.md` — this section.
- `CHANGELOG.md` — the 1.2.5 entry.
