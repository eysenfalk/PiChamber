import { describe, expect, test } from 'bun:test';
import {
  BOTTOM_SPACER_MOBILE_PX,
  MOBILE_BOTTOM_SPACE_PX,
  SCROLL_BUTTON_CLEARANCE_PX,
  computeBottomZoneThreshold,
} from './autoFollowHelpers';

describe('mobile bottom space', () => {
  test('the scroll to bottom button never covers the last row where it first appears', () => {
    // The button shows from computeBottomZoneThreshold(true) px above the bottom on.
    // At that distance the end of the content sits MOBILE_BOTTOM_SPACE_PX - threshold
    // above the composer, which must be at least the button footprint.
    const shownFrom = computeBottomZoneThreshold(true);
    expect(MOBILE_BOTTOM_SPACE_PX - shownFrom).toBeGreaterThanOrEqual(SCROLL_BUTTON_CLEARANCE_PX);
    expect(shownFrom).toBe(BOTTOM_SPACER_MOBILE_PX);
  });
});
