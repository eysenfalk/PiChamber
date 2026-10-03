import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { AboutBuilds } from './AboutBuilds';

const at = '2026-10-04T08:09:10.000Z';

describe('AboutBuilds', () => {
  test('shows UI, server and daemon with ID and local time, and no hint when they match', () => {
    const html = renderToStaticMarkup(
      <AboutBuilds
        locale="en-US"
        builds={{
          ui: { id: 'abc1234', builtAt: at },
          server: { id: 'abc1234', builtAt: at, kind: 'build' },
          daemon: { id: 'abc1234', builtAt: at },
        }}
      />,
    );
    for (const label of ['UI', 'Server', 'Session daemon']) expect(html).toContain(label);
    expect(html.match(/abc1234/g)).toHaveLength(3);
    expect(html).toContain('built Oct 4, 2026');
    expect(html).not.toContain('about-build-mismatch');
    expect(html).not.toContain('data-build-mismatch');
  });

  test('marks a daemon from an older build and hints to restart', () => {
    const html = renderToStaticMarkup(
      <AboutBuilds
        locale="en-US"
        builds={{
          ui: { id: 'new5678', builtAt: at },
          server: { id: 'new5678', builtAt: at, kind: 'build' },
          daemon: { id: 'old1234', builtAt: '2026-10-03T08:00:00.000Z' },
        }}
      />,
    );
    expect(html).toContain('data-build-row="daemon" data-build-mismatch="true"');
    expect(html).not.toContain('data-build-row="ui" data-build-mismatch');
    expect(html).toContain('Differs');
    expect(html).toContain('older build than the server. Restart PiChamber');
  });

  test('marks a UI newer than the server', () => {
    const html = renderToStaticMarkup(
      <AboutBuilds
        locale="en-US"
        builds={{
          ui: { id: 'new5678', builtAt: '2026-10-05T08:00:00.000Z' },
          server: { id: 'old1234', builtAt: at, kind: 'build' },
          daemon: { id: 'old1234', builtAt: at },
        }}
      />,
    );
    expect(html).toContain('data-build-row="ui" data-build-mismatch="true"');
    expect(html).toContain('This UI is newer than the server');
  });

  test('says a source server started instead of built, and a missing stamp is not available', () => {
    const html = renderToStaticMarkup(
      <AboutBuilds
        locale="en-US"
        builds={{ ui: null, server: { id: 'source-abc1234', builtAt: at, kind: 'source' }, daemon: null }}
      />,
    );
    expect(html).toContain('source-abc1234');
    expect(html).toContain('started Oct 4, 2026');
    expect(html.match(/Not available/g)).toHaveLength(2);
  });
});
