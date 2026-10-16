import { describe, expect, test } from 'bun:test';

import {
  isNewSessionDraftActive,
  routeSessionIdForState,
} from './session-intent';

describe('session navigation intent', () => {
  test('new-session draft wins over the Pi store selection', () => {
    const draft = { open: true };

    expect(isNewSessionDraftActive(draft, null)).toBe(true);
    expect(routeSessionIdForState({
      currentSessionId: null,
      piSelectedSessionId: 'older-session',
      draft,
    })).toBeNull();
  });

  test('an active session still wins over draft metadata', () => {
    const draft = { open: true };

    expect(isNewSessionDraftActive(draft, 'current-session')).toBe(false);
    expect(routeSessionIdForState({
      currentSessionId: 'current-session',
      piSelectedSessionId: 'older-session',
      draft,
    })).toBe('current-session');
  });

  test('a draft opened automatically because nothing was shown yields to the Pi store selection (#16)', () => {
    const draft = { open: true, automatic: true };

    expect(isNewSessionDraftActive(draft, null)).toBe(false);
    expect(routeSessionIdForState({
      currentSessionId: null,
      piSelectedSessionId: 'remembered-session',
      draft,
    })).toBe('remembered-session');
  });

  test('the Pi selection supplies the route when no draft is open', () => {
    expect(routeSessionIdForState({
      currentSessionId: null,
      piSelectedSessionId: 'remembered-session',
      draft: { open: false },
    })).toBe('remembered-session');
  });
});
