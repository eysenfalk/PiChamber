import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('./mobile.css', import.meta.url), 'utf8');

const ruleBody = (selector: string): string => {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf('}', start));
};

describe('native app bottom safe area', () => {
  test('Android reserves the whole navigation bar inset, not half of it', () => {
    // The shell padding, the chat scroller and the terminal read --oc-app-bottom-safe.
    // The base token halves the inset for the thin iOS home indicator, which left half of
    // a 48px three button navigation bar on top of the composer.
    const android = ruleBody(':root.oc-capacitor-app.oc-platform-android');
    expect(android).toContain('--oc-app-bottom-safe: max(16px, var(--oc-safe-area-bottom));');
  });

  test('iOS keeps the halved inset', () => {
    const base = ruleBody(':root.oc-capacitor-app');
    expect(base).toContain('* 0.5');
  });
});
