# 0015. A phone is decided by its physical screen, not by the viewport width

- Status: Proposed
- Date: 2026-10-15
- Waits for: the owner's choice between this record and the alternative "desktop layout with a composer height limit" (issue #148)

## Context

Issue #148: on a landscape phone 768 px or wider (844x390) the hosted web app shows the desktop layout. There is no sessions drawer button, no composer minimize handle, and the composer has the desktop line limit, so with the keyboard open (200 px visible) the composer is 335 px and the history gets no room.

What the code does, read on `origin/dev` c903e405:

- `detectHostedSurface` in `packages/ui/src/lib/runtimeSurface.ts` decides the surface. A hosted browser is the mobile surface only if `min(innerWidth, screen.width) <= 768`, the pointer is touch, and the stored layout preference is `new`. `packages/web/src/main.tsx` stamps the answer once at boot (`__PICHAMBER_SURFACE__`).
- `getDeviceInfo` in `packages/ui/src/lib/device.ts` forces `isMobile` when the surface is mobile. On the desktop surface it uses `touch && width <= 768`, so 844 px is a "tablet" (`device-tablet`), not mobile.
- Both the `data-composer-bound` third and the minimize handle (#137, PR #140) key off `isMobile`.

Measured on 2026-10-15 in the lab, hosted web, touch emulation, 844x390 viewport, first load of `/`:

| Emulated `screen` | Surface | Root class | Drawer button |
|---|---|---|---|
| 844x390 (a screen that rotates with the device) | desktop | `device-tablet` | no |
| 390x844 (a screen fixed in portrait) | mobile | `device-mobile` | yes |

So the bug depends on what `screen.width` reports in landscape. The first row is the issue. The second row was emulated, not measured on an iPhone; that iOS reports a portrait fixed `screen.width` is from memory and is not verified here. On Android Chrome `screen.width` follows the rotation, so the first row is the expected case there; not verified on a device either. Since the surface is stamped at boot, the same phone can get a different surface depending on its orientation when the page was loaded.

A viewport rule based on height would flip the layout when a tablet in portrait opens its keyboard (768x1024 becomes 768x400), so the viewport cannot tell a phone from a tablet.

Alternatives:

- **A. Phone screen rule (recommended).** Keep `width <= 768` and add: touch pointer and `min(screen.width, screen.height) <= 500`. The shortest side of a phone screen does not change with rotation or keyboard. Phones are at most about 430 css px on the short side; the smallest tablets (iPad mini) are 744, so 500 leaves room on both sides. Landscape phones get the mobile surface, so the composer follows #137: capped, text scrolls inside, can be minimized, and the drawer replaces the sidebar.
- **B. Desktop layout with a composer height limit.** Leave the surface as it is and pass a bound to the composer on short viewports. Smaller change, but the 280 px sidebar and the desktop header stay on a 390 px high screen and the drawer and handle stay missing.
- **C. Decide by viewport height or aspect ratio.** Rejected: flips with the keyboard on tablets (see above).

## Decision

Proposed, pending the owner: option A.

- `detectHostedSurface` is the single place that decides the phone surface. It treats a touch device whose shorter screen side is at most 500 css px as a phone in any orientation. The existing `width <= 768` rule stays, so nothing that is mobile today becomes desktop (an unfolded foldable at 673 px, a narrow touch window).
- The stored layout preference (`default` opts out) and the `?surface=` override keep priority as they do now.
- `getDeviceInfo` needs no new rule: it already follows the surface.

## Consequences

- Phones that report a rotating `screen.width` get the mobile layout in landscape, with the drawer, the capped composer and the minimize handle.
- Orientation at boot no longer changes the surface of a phone.
- Tablets and desktops are unaffected.
- The 500 px cut is a heuristic. A device with a short side between 500 and 768 and a rotating screen (small tablets, some foldables) still gets desktop layout when it is landscape and wider than 768, as today.
- Any later layout rule by viewport must not use the height, for the keyboard reason above.

## Revisit when

A device class shows up with a short side above 500 px that the owner wants as a phone, or a real phone with a short side at most 500 px is found on the desktop surface.
