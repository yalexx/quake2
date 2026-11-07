# The owner's mobile HUD review: acceptance criteria for 1.2.4

Source: `design/mobile-hud-review.png` (commit `318067b`), an 852x393 capture of
the 844x390 phone presentation with red notes and arrows. The picture carries
four notes; the commit that added it names six topics ("full screen, PAD, WPN,
crouch, fire+move, opacity"), so the last two criteria come from the commit
title and are written as this round's reading of it.

| # | Note in the picture (verbatim) | Arrow points at |
| --- | --- | --- |
| 1 | "full screen needs to be in the menu not here" | the **Full screen** button, top row, third from the left |
| 2 | "remove this dpad button" | the **PAD** button, top-left corner |
| 3 | "the wpn buttons not doing anything" | the **‹ WPN** / **WPN ›** pair on the right edge |
| 4 | "add crouch button similiar to pc "C"" | the **JUMP** button, bottom right |
| 5 | *(commit title: "fire+move")* | — |
| 6 | *(commit title: "opacity")* | — |

Terms used below. A *target* is any element on the play layer that takes a
touch: `#mc-stick`, every `.mc-btn`, and any page control drawn over the game.
The *aiming zone* is the middle of the picture, where the look drag starts and
the crosshair sits: x from 30 % to 70 % of the viewport width, full height.
*Engine numbers* are read from `window.quake2Engine.read()`: `position` (the
view origin, `cl.refdef.vieworg`), `angles`, `weaponIndex` (the first-person
model index, `gunindex`) and `ammo`.

## The six criteria

### 1. Full screen lives in the menu, not on the game picture

1. `#fullscreen-button` and `#fullscreen-hint` do not exist in the page, at
   844x390, at 390x844 and on the 1280x720 desktop.
2. The VIDEO view carries exactly one full-screen control: a row
   `[data-action="fullscreen"]` in its page-control list (`.menu-page-list`),
   label `full screen`, value `off` / `on`, at least 44 px tall on a touch
   device.
3. A trusted tap on the row enters full screen (`document.fullscreenElement`
   is set, the row reads `on`); a second tap leaves it (`null`, `off`).
4. Inside the box's sandboxed window, where the browser refuses full screen,
   the row reads `own window` and opens the app in its own window instead of
   failing silently. A browser with no Fullscreen API at all (iPhone Safari)
   is not offered the row, since no window could go full screen there.

Proved by `scripts/mobile-fullscreen-test.mjs` (phone), the menu audit and the
presentation gate (desktop), and the input gate's layout check (absence).

### 2. The PAD button is gone; the top row is uncluttered

1. `#mc-toggle` does not exist. The only control in the play layer's top row
   is MENU (`#mc-pause`).
2. The touch controls are on by default on a touch device. Hiding them is no
   longer a button over the game: it is an OPTIONS row, `touch controls`
   (`on` / `off`), inside the menu.
3. No two targets overlap at 844x390 or at 390x844 (pairwise intersection of
   their `getBoundingClientRect()` boxes is 0 px²), and every target is at
   least 44 px wide and 44 px tall.

Proved by the input gate's layout check at both viewports and its screenshots.

### 3. WPN does something

Measured cause on the starting tree: since `5fa1aa7` the page's `boot()`
replaces `Module.arguments`, which drops the touch layer's
`+exec q2touch.cfg`. The engine therefore keeps `default.cfg`'s
`bind [ invprev` / `bind ] invnext`, so the two WPN buttons moved the
*inventory* cursor, which draws nothing. The same lost cfg left `e` (USE)
unbound.

1. The engine executes the touch bindings: its console prints
   `execing q2touch.cfg`, and `[`/`]` no longer reach `invprev`/`invnext`.
2. WPN is one control, at least 44 px, that switches to the next weapon the
   player carries: with more than one weapon, each tap changes the engine's
   `weaponIndex`. (A switch is the old weapon's lowering animation, about a
   dozen game frames: about a second on a phone, 4-5 s in the gate's
   headless software rendering at ~2.5 frames a second, so the gate allows
   20 s.)
3. With only the blaster (every fresh spawn without cheats), a tap is not
   silent: once 2 s and 20 drawn frames have passed with `weaponIndex`
   unchanged, a note on the pad says there is no other weapon to switch to.

Proved by input-gate checks on engine numbers (`weaponIndex` before/after).

### 4. A CROUCH control, like the PC's C

1. `#mc-crouch` sits beside JUMP, in the same row and at JUMP's size, at
   least 44 px.
2. It holds the PC's crouch key, `c` (`default.cfg`: `bind c +movedown`):
   keydown on press, keyup on release.
3. While it is held, the engine's view height drops: `position.z` falls by at
   least 15 units (the duck is 24: view height 22 to -2) with x/y unchanged;
   after release `position.z` is back within 2 units.
4. It works with the other thumb on the stick: a crouch-walk moves the player
   and keeps `position.z` lowered.

Proved by input-gate checks on engine numbers (`position.z`).

### 5. Fire and move (and aim) in one two-finger gesture

1. Left thumb on the stick, right thumb on FIRE, in one gesture: within the
   same window `ammo` falls AND the player moves at least 50 units.
2. The FIRE thumb can slide to aim while it fires: in that same gesture the
   yaw changes by at least 5 degrees while `ammo` keeps falling.
3. A plain look drag changes yaw and pitch with `ammo` unchanged and no
   mouse press reaching the canvas.

Proved by input-gate checks on engine numbers (`ammo`, `position`, `angles`).

### 6. Opacity and ergonomics

1. Idle (no finger on it): every pad control's computed opacity
   (`getComputedStyle().opacity`) is between 0.3 and 0.6, so the picture
   shows through; the look surface has no background.
2. Pressed: the control under the finger has computed opacity 1.
3. PAD hidden (OPTIONS › touch controls off, the menu open, or portrait): the
   stick and the action controls are not rendered (`display: none`) and take
   no touch; MENU stays reachable.
4. No target intersects the aiming zone at 844x390 or 932x430.
5. Portrait is untouched: at 390x844 the rotate card is shown with the same
   text, the pad is hidden and MENU is reachable.

Proved by the input gate (computed styles, rects) and its screenshots.

## Baseline: the starting tree (`318067b`)

`scripts/mobile-input-gate.mjs --phone`, run on a copy of the starting tree
served from its own temp folder on a spare port (the live app, the kiosk
browser and the control API were not used): **FAILED, 31/34 checks**
(`docs/mobile-hud-review/baseline/gate-stdout.txt`).

| Check | Result | Cause (measured) |
| --- | --- | --- |
| 5b JUMP raises z and lands | FAIL | The gate's own timing: it holds JUMP for 600 ms and only samples z after the release, by which time the jump (about 0.6 s) has landed. A probe that samples during the hold saw z rise 15 units at 300 ms; a synthetic Space rose 22.5. JUMP works. |
| 5c USE + the engine cfg executed | FAIL | `q2touch.cfg` never executes (no `execing q2touch.cfg`; the start-up line has no `+exec`), so `e` is not bound to `+use`. |
| 5e NEXT/PREV change the weapon | FAIL | Same cause: `[`/`]` stay `invprev`/`invnext` (read from the engine's console: `"[" = "invprev"`). This is note 3. |

Baseline screenshots, taken by the gate with touch emulation:

* `docs/mobile-hud-review/baseline/landscape-844x390.png`: the pad over the
  game. Top row PAD, MENU, Full screen; stick bottom left; ‹WPN WPN› above USE
  on the right edge; JUMP and FIRE bottom right.
* `docs/mobile-hud-review/baseline/landscape-844x390-menu.png`: the menu over
  the game.
* `docs/mobile-hud-review/baseline/portrait-390x844.png`: the rotate card.

Measured boxes at 844x390 (left, top, width, height; computed opacity):
PAD 10,8,52,44 (1) · MENU 70,8,46,44 (1) · Full screen 125,8,106,44 (0.72) ·
‹WPN 732,128,46,46 · WPN› 784,128,46,46 · USE 772,186,58,58 ·
JUMP 682,276,58,58 · FIRE 752,256,78,78 · stick 14,196,138,138 (all 1). Every
pad control is drawn at full opacity; only its fill is translucent.

## The salvage branch `clawbox/run-1l0y7504` (commit `3f033ff`)

One commit directly on `318067b`, 26 files, +3963/-608, never verified on this
tree (its run died of a context overflow). What it already solves, and what
this round does with it:

| Criterion | What `3f033ff` does | Decision |
| --- | --- | --- |
| 1 Full screen | Removes `#fullscreen-button`/`#fullscreen-hint`; VIDEO page-control row `full screen` owned by `fullscreen.js` (on/off/own window, `window.quake2Fullscreen.status()`); new `scripts/mobile-fullscreen-test.mjs`; menu audit and presentation gate pointed at the row. | **Reuse**: `fullscreen.js` and the test almost as written; the audit/presentation edits are re-done against this tree. |
| 2 PAD | Deletes `#mc-toggle`, its stored flag and every `padOn` path; the pad can never be hidden. | **Partly**: the button goes; hiding moves into OPTIONS (`touch controls`) so the PAD-hidden state the criteria measure stays reachable. |
| 3 WPN | Replaces the pair with a `1-8` button that opens a 4x2 slot picker and guesses the held slot from `gunindex`. | **Rewrite**: it does not fix the cause (the lost cfg) and shows seven unusable slots at every fresh spawn. One WPN control bound to `weapnext`, with the cfg actually executed and a note when there is nothing to switch to. |
| 4 CROUCH | `#mc-crouch` beside JUMP holding `c`; `bind c "+movedown"` added to `q2touch.cfg`; keyup repeated at 80/400/1200/3000 ms against a "lost release". | **Reuse** the control and binding. The keyup repeats go: a release that only works when repeated is a bug to measure, not to paper over. |
| 5 fire+move | FIRE is drag-to-aim (`aimBy`, `buttons` on the moves, per-pointer fire holds) plus a second FIRE on the left edge; `docs/mobile-fire-move.md`. | **Reuse** drag-to-aim and per-pointer holds. The left FIRE goes: drag-to-aim already gives move + aim + fire with two thumbs, and the owner asked for fewer controls, not more. |
| 6 opacity | Rest 0.6, idle fade to 0.24 after 4 s, labels only while pressed. | **Adapt**: rest 0.5, pressed 1, hidden not rendered; no extra idle fade, so a control never drops below the visible floor in criterion 6.1. |
| harness | `server.js` also strips `/apps/quake2/` when the checkout folder is named otherwise (a worktree). | **Reuse**: every suite addresses `/apps/quake2/`. |

## Status in 1.2.4

All six criteria are implemented and measured in the final input gate run,
45/45 (`docs/release-1.2.4/README.md` has the numbers for each one). One part
is implemented but not measured: criterion 1.4, the `own window` path. No
harness here produced a document that refuses full screen: the box's CSP
`sandbox` header, applied by the menu audit's proxy, still let headless
Chrome go full screen, so that audit took the enter/leave branch.
