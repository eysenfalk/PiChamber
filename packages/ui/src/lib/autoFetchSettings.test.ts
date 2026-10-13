import { describe, expect, test } from 'bun:test';
import {
  AUTO_FETCH_INTERVAL_MINUTES,
  DEFAULT_AUTO_FETCH_INTERVAL_MINUTES,
  isAutoFetchIntervalMinutes,
  normalizeAutoFetchIntervalMinutes,
} from './autoFetchSettings';

describe('Auto fetch settings', () => {
  test('allows exactly 5, 15, 30 and 60 minutes, defaulting to 15', () => {
    expect([...AUTO_FETCH_INTERVAL_MINUTES]).toEqual([5, 15, 30, 60]);
    expect(DEFAULT_AUTO_FETCH_INTERVAL_MINUTES).toBe(15);
  });

  test('rejects every other value and falls back to the default', () => {
    for (const value of [0, 1, 10, 45, 61, -15, 15.5, NaN, '15', null, undefined, {}]) {
      expect(isAutoFetchIntervalMinutes(value)).toBe(false);
      expect(normalizeAutoFetchIntervalMinutes(value)).toBe(15);
    }
    for (const value of [5, 15, 30, 60]) {
      expect(isAutoFetchIntervalMinutes(value)).toBe(true);
      expect(normalizeAutoFetchIntervalMinutes(value)).toBe(value);
    }
  });
});
