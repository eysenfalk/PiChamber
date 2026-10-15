import { afterEach, describe, expect, test } from 'bun:test';

import { detectHostedSurface, type HostedSurface } from './runtimeSurface';

interface FakeDevice {
  /** Layout viewport. A keyboard shrinks the height, rotation swaps both. */
  viewport: [number, number];
  /** Physical screen as the browser reports it; a rotating screen swaps with the device. */
  screen: [number, number];
  touch?: boolean;
  search?: string;
  layoutPreference?: string;
}

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

const surfaceOf = (device: FakeDevice): HostedSurface => {
  const touch = device.touch ?? true;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      innerWidth: device.viewport[0],
      innerHeight: device.viewport[1],
      screen: { width: device.screen[0], height: device.screen[1] },
      location: { search: device.search ?? '', protocol: 'https:' },
      matchMedia: (query: string) => ({ matches: touch && /pointer: coarse|hover: none/.test(query) }),
      localStorage: {
        getItem: (key: string) => (key === 'pichamber-mobile-layout' ? device.layoutPreference ?? null : null),
      },
    },
  });
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { maxTouchPoints: touch ? 5 : 0 },
  });
  return detectHostedSurface();
};

afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
  else Reflect.deleteProperty(globalThis, 'navigator');
});

describe('hosted surface of a phone', () => {
  test('a landscape phone whose screen rotates with it is the mobile surface', () => {
    expect(surfaceOf({ viewport: [844, 390], screen: [844, 390] })).toBe('mobile');
  });

  test('the same phone with the keyboard open is still mobile', () => {
    expect(surfaceOf({ viewport: [844, 200], screen: [844, 390] })).toBe('mobile');
  });

  test('a portrait phone is mobile whichever way its screen is reported', () => {
    expect(surfaceOf({ viewport: [390, 844], screen: [390, 844] })).toBe('mobile');
    expect(surfaceOf({ viewport: [844, 390], screen: [390, 844] })).toBe('mobile');
  });

  test('a short screen side of exactly 500 px is a phone, 501 px is not', () => {
    expect(surfaceOf({ viewport: [900, 500], screen: [900, 500] })).toBe('mobile');
    expect(surfaceOf({ viewport: [900, 501], screen: [900, 501] })).toBe('desktop');
  });

  test('a large phone in landscape (932x430) is mobile', () => {
    expect(surfaceOf({ viewport: [932, 430], screen: [932, 430] })).toBe('mobile');
  });
});

describe('hosted surface of everything that is not a phone', () => {
  test('a tablet in landscape stays desktop, with and without the keyboard', () => {
    expect(surfaceOf({ viewport: [1024, 768], screen: [1024, 768] })).toBe('desktop');
    expect(surfaceOf({ viewport: [1180, 820], screen: [1180, 820] })).toBe('desktop');
    expect(surfaceOf({ viewport: [1024, 400], screen: [1024, 768] })).toBe('desktop');
  });

  test('a tablet in portrait keeps the surface it has today (width rule, unchanged)', () => {
    // 768 px is at the existing width limit, so a portrait tablet is mobile before and after.
    expect(surfaceOf({ viewport: [768, 1024], screen: [768, 1024] })).toBe('mobile');
    expect(surfaceOf({ viewport: [768, 400], screen: [768, 1024] })).toBe('mobile');
    expect(surfaceOf({ viewport: [820, 1180], screen: [820, 1180] })).toBe('desktop');
  });

  test('a laptop with a touch screen stays desktop', () => {
    expect(surfaceOf({ viewport: [1280, 800], screen: [1280, 800] })).toBe('desktop');
    expect(surfaceOf({ viewport: [1280, 400], screen: [1920, 1080] })).toBe('desktop');
  });

  test('a desktop without touch stays desktop even in a phone sized window', () => {
    expect(surfaceOf({ viewport: [844, 390], screen: [844, 390], touch: false })).toBe('desktop');
    expect(surfaceOf({ viewport: [390, 844], screen: [1920, 1080], touch: false })).toBe('desktop');
  });

  test('an unfolded foldable (673x841) is unchanged', () => {
    expect(surfaceOf({ viewport: [673, 841], screen: [673, 841] })).toBe('mobile');
  });

  test('a narrow touch window on a large screen is unchanged', () => {
    expect(surfaceOf({ viewport: [600, 900], screen: [1920, 1080] })).toBe('mobile');
  });
});

describe('what still wins over the screen rule', () => {
  test('?surface= overrides it both ways', () => {
    expect(surfaceOf({ viewport: [844, 390], screen: [844, 390], search: '?surface=desktop' })).toBe('desktop');
    expect(surfaceOf({ viewport: [1280, 800], screen: [1280, 800], search: '?surface=mobile' })).toBe('mobile');
  });

  test('the stored default layout opts a landscape phone out', () => {
    expect(surfaceOf({ viewport: [844, 390], screen: [844, 390], layoutPreference: 'default' })).toBe('desktop');
  });
});
