/**
 * Auto fetch setting (slice 6 of #95): the allowed intervals and the one place
 * that turns an untrusted value into a valid one. The store, the settings
 * sanitizers, the Settings page and the sidebar timer all import it.
 */

export const AUTO_FETCH_INTERVAL_MINUTES = [5, 15, 30, 60] as const;

export type AutoFetchIntervalMinutes = (typeof AUTO_FETCH_INTERVAL_MINUTES)[number];

export const DEFAULT_AUTO_FETCH_INTERVAL_MINUTES: AutoFetchIntervalMinutes = 15;

export const isAutoFetchIntervalMinutes = (value: unknown): value is AutoFetchIntervalMinutes => (
  typeof value === 'number' && (AUTO_FETCH_INTERVAL_MINUTES as readonly number[]).includes(value)
);

/** A stored or received interval, or the default when it is not one of the allowed values. */
export const normalizeAutoFetchIntervalMinutes = (value: unknown): AutoFetchIntervalMinutes => (
  isAutoFetchIntervalMinutes(value) ? value : DEFAULT_AUTO_FETCH_INTERVAL_MINUTES
);
