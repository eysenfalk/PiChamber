import { describe, expect, mock, test } from 'bun:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

type FakeRequest = { requestId: string; method: 'confirm'; title: string; message: string };
const confirmRequest = (requestId: string, title: string): FakeRequest => ({ requestId, method: 'confirm', title, message: 'Proceed?' });

const fakeState = {
  selectedSessionId: 'session-a' as string | null,
  reducer: {
    bySession: new Map([
      ['session-a', { extensionDialogs: [] as FakeRequest[] }],
      ['session-b', { extensionDialogs: [confirmRequest('req-b', 'Dialog of session B')] }],
    ]),
  },
};

mock.module('@/sync/pi-session-context', () => ({
  usePiSessionSnapshot: (selector: (state: typeof fakeState) => unknown) => selector(fakeState),
}));

const { ExtensionDialogOverlay } = await import('./ExtensionDialogOverlay');

describe('ExtensionDialogOverlay scoping', () => {
  test('a foreign session dialog does not show over the open chat', () => {
    fakeState.selectedSessionId = 'session-a';
    expect(renderToStaticMarkup(<ExtensionDialogOverlay />)).toBe('');
    expect(renderToStaticMarkup(<ExtensionDialogOverlay sessionId="session-a" />)).toBe('');
  });

  test('an explicit null session shows no dialog, even when another session is selected', () => {
    fakeState.selectedSessionId = 'session-b';
    expect(renderToStaticMarkup(<ExtensionDialogOverlay sessionId={null} />)).toBe('');
  });

  test('the dialog shows in its own session chat', () => {
    fakeState.selectedSessionId = 'session-b';
    expect(renderToStaticMarkup(<ExtensionDialogOverlay />)).toContain('Dialog of session B');
    expect(renderToStaticMarkup(<ExtensionDialogOverlay sessionId="session-b" />)).toContain('Dialog of session B');
  });
});
