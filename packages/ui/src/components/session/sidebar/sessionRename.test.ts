import { describe, expect, test } from 'bun:test';

import { sessionRenameSurface } from './sessionRename';

describe('session rename surface', () => {
  test('renames in the row on layouts with room for it', () => {
    expect(sessionRenameSurface({ mobileVariant: false })).toBe('inline');
  });

  // The drawer row keeps about 55 px for the field after its indentation, check, cross and age (#143).
  test('renames in a dialog in the dedicated mobile drawer', () => {
    expect(sessionRenameSurface({ mobileVariant: true })).toBe('dialog');
  });
});
