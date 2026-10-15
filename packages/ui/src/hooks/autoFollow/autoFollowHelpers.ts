export const BOTTOM_SPACER_DESKTOP_VH = 0.10;
export const BOTTOM_SPACER_MOBILE_PX = 40;
/** Footprint of the scroll to bottom button above the composer: 32px button + 8px gap. */
export const SCROLL_BUTTON_CLEARANCE_PX = 40;
/**
 * Space under the last row of a mobile chat. The button appears once the view is
 * more than BOTTOM_SPACER_MOBILE_PX from the bottom; with the clearance on top the
 * last row is still above the button at that point instead of under it.
 */
export const MOBILE_BOTTOM_SPACE_PX = BOTTOM_SPACER_MOBILE_PX + SCROLL_BUTTON_CLEARANCE_PX;
export const TOUCH_FINGER_DOWN_THRESHOLD = 2;
export const AUTO_MARK_TTL_MS = 1500;
export const AUTO_MATCH_TOLERANCE_PX = 2;
export const ANIMATION_GUARD_MS = 350;
export const SETTLE_MS = 300;
export const ENTRY_STICK_QUIESCENCE_MS = 600;
export const ENTRY_STICK_MAX_MS = 8000;

export const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export const computeBottomZoneThreshold = (isMobile: boolean, container?: HTMLElement | null): number => {
  if (isMobile) return BOTTOM_SPACER_MOBILE_PX;
  const height = container?.clientHeight ?? 0;
  if (height <= 0) return 96;
  return Math.max(48, height * BOTTOM_SPACER_DESKTOP_VH);
};

export const distanceFromBottom = (el: HTMLElement): number => {
  return el.scrollHeight - el.scrollTop - el.clientHeight;
};

export const canScroll = (el: HTMLElement): boolean => {
  return el.scrollHeight - el.clientHeight > 1;
};

export const isNearBottom = (el: HTMLElement, isMobile: boolean): boolean => {
  return distanceFromBottom(el) <= computeBottomZoneThreshold(isMobile, el);
};

export const isReleaseKey = (event: KeyboardEvent): boolean => {
  if (event.altKey || event.ctrlKey || event.metaKey) {
    return false;
  }
  switch (event.key) {
    case 'ArrowUp':
    case 'PageUp':
    case 'Home':
      return true;
    default:
      return false;
  }
};

export const nestedScrollableTarget = (root: HTMLElement, target: EventTarget | null): HTMLElement | null => {
  if (!(target instanceof Element)) return null;
  const nested = target.closest('[data-scrollable]');
  if (!nested || nested === root || !(nested instanceof HTMLElement)) return null;
  return nested;
};

export const nestedScrollableCanConsumeUp = (root: HTMLElement, target: EventTarget | null): boolean => {
  const nested = nestedScrollableTarget(root, target);
  if (!nested) return false;
  return nested.scrollTop > 0;
};
