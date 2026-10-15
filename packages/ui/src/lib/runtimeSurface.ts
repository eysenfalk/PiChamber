import { isDesktopShell } from '@/lib/desktop';
import { isCapacitorApp } from '@/lib/platform';
import { getStoredMobileLayoutPreference } from '@/lib/mobileLayoutPreference';

export type HostedSurface = 'desktop' | 'mobile';

declare global {
  interface Window {
    __PICHAMBER_SURFACE__?: HostedSurface;
  }
}

const MOBILE_SURFACE_MAX_WIDTH = 768;

/**
 * A touch device whose shorter physical screen side is at most this many css
 * px is a phone in any orientation (ADR 0015). Phones measure about 430 px at
 * most, the smallest tablets 744 px. The screen does not change with the
 * keyboard, unlike the viewport.
 */
const PHONE_SCREEN_MAX_SHORT_SIDE = 500;

const isTouchOrCoarsePointer = (): boolean => {
  if (typeof window === 'undefined') return false;

  const coarsePointer = typeof window.matchMedia === 'function'
    ? window.matchMedia('(pointer: coarse)').matches || window.matchMedia('(hover: none)').matches
    : false;
  const touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints ?? 0 : 0;
  return coarsePointer || touchPoints > 0;
};

/**
 * Single authority for the mobile-vs-desktop surface decision.
 *
 * Priority: explicit stamp (set once at boot) → URL override → Capacitor
 * shell (always the mobile surface) → desktop shells → phone heuristic
 * gated by the stored mobile layout preference. The heuristic needs a touch
 * pointer plus either a narrow viewport and screen, or a phone sized
 * physical screen (so a landscape phone, 844 px wide, is still a phone).
 */
export const detectHostedSurface = (): HostedSurface => {
  if (typeof window === 'undefined') return 'desktop';

  const explicitSurface = window.__PICHAMBER_SURFACE__;
  if (explicitSurface === 'mobile' || explicitSurface === 'desktop') {
    return explicitSurface;
  }

  const override = new URLSearchParams(window.location.search).get('surface');
  if (override === 'mobile' || override === 'desktop') {
    return override;
  }

  if (isCapacitorApp()) return 'mobile';
  if (isDesktopShell()) return 'desktop';

  const width = Math.min(
    window.innerWidth || Number.POSITIVE_INFINITY,
    window.screen?.width || Number.POSITIVE_INFINITY,
  );
  const screenShortSide = Math.min(
    window.screen?.width || Number.POSITIVE_INFINITY,
    window.screen?.height || Number.POSITIVE_INFINITY,
  );
  const likelyPhone = (width <= MOBILE_SURFACE_MAX_WIDTH || screenShortSide <= PHONE_SCREEN_MAX_SHORT_SIDE)
    && isTouchOrCoarsePointer();
  return likelyPhone && getStoredMobileLayoutPreference() === 'new' ? 'mobile' : 'desktop';
};

/**
 * Decides the surface once and stamps it on `window` so every later
 * `isMobileSurfaceRuntime()` call (perf tuning, sync paging, device info)
 * reads the same stable answer instead of re-running viewport heuristics.
 */
export const resolveHostedSurface = (): HostedSurface => {
  const surface = detectHostedSurface();
  if (typeof window !== 'undefined') {
    window.__PICHAMBER_SURFACE__ = surface;
  }
  return surface;
};

export const isMobileSurfaceRuntime = (): boolean => detectHostedSurface() === 'mobile';
