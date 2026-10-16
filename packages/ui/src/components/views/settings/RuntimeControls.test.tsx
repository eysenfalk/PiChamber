import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/sync/pi-session-context', () => ({ usePiSessionSnapshot: () => '' }));
mock.module('@/sync/sync-refs', () => ({ getActiveSyncSessions: () => [] }));

const { RestartWorkingSessions } = await import('./RestartConfirmDialog');
const { describeRestartConfirm } = await import('./restartConfirm');
const { RuntimeControlButtons } = await import('./RuntimeControls');
const {
  RELOAD_PI_LABEL,
  RESTART_PICHAMBER_LABEL,
  initialRuntimeControlsState,
  runtimeControlsReducer,
} = await import('./runtimeControlsState');
const { SettingsNav } = await import('./SettingsNav');
const { MobileSettingsHeader } = await import('./MobileSettingsHeader');

describe('RuntimeControlButtons', () => {
  test('renders an icon button for reload first and restart second, each with an aria label', () => {
    const html = renderToStaticMarkup(<RuntimeControlButtons />);
    const reload = html.indexOf(`aria-label="${RELOAD_PI_LABEL}"`);
    const restart = html.indexOf(`aria-label="${RESTART_PICHAMBER_LABEL}"`);
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(restart).toBeGreaterThan(reload);
    expect(html).not.toContain('Interrupt and restart');
  });
});

describe('restart confirmation', () => {
  test('lists the working sessions and says they are interrupted', () => {
    const sessions = [
      { id: 'a', title: 'Fix the build', directory: '/work' },
      { id: 'b', title: null, directory: '/work' },
    ];
    const html = renderToStaticMarkup(<RestartWorkingSessions sessions={sessions} />);
    expect(html).toContain('2 sessions are working');
    expect(html).toContain('Fix the build');
    expect(html).toContain('Untitled session');
    expect(html).toContain('interrupts running turns and subagents');
    expect(describeRestartConfirm(sessions)).toEqual({ confirmLabel: 'Interrupt and restart', destructive: true });
  });

  test('uses the singular for one session', () => {
    const html = renderToStaticMarkup(<RestartWorkingSessions sessions={[{ id: 'a', title: 'Only one', directory: '/work' }]} />);
    expect(html).toContain('1 session is working');
  });

  test('still asks, with a plain confirm, when nothing is working', () => {
    const html = renderToStaticMarkup(<RestartWorkingSessions sessions={[]} />);
    expect(html).toContain('No session is working right now.');
    expect(html).not.toContain('restart-working-sessions');
    expect(describeRestartConfirm([])).toEqual({ confirmLabel: 'Restart PiChamber', destructive: false });
  });

  test('the restart button only opens the confirmation; a confirm starts the restart', () => {
    const requested = runtimeControlsReducer(initialRuntimeControlsState, { type: 'restart-requested' });
    expect(requested).toEqual({ reloading: false, restarting: false, confirmOpen: true });

    const cancelled = runtimeControlsReducer(requested, { type: 'restart-cancelled' });
    expect(cancelled).toEqual(initialRuntimeControlsState);

    const confirmed = runtimeControlsReducer(requested, { type: 'restart-confirmed' });
    expect(confirmed).toEqual({ reloading: false, restarting: true, confirmOpen: false });

    // A restart in progress cannot be requested again.
    expect(runtimeControlsReducer(confirmed, { type: 'restart-requested' })).toBe(confirmed);
    expect(runtimeControlsReducer(confirmed, { type: 'restart-finished' })).toEqual(initialRuntimeControlsState);
  });

  test('reload acts at once and never opens a confirmation', () => {
    const started = runtimeControlsReducer(initialRuntimeControlsState, { type: 'reload-started' });
    expect(started).toEqual({ reloading: true, restarting: false, confirmOpen: false });
    expect(runtimeControlsReducer(started, { type: 'reload-finished' })).toEqual(initialRuntimeControlsState);
  });
});

describe('Settings placement', () => {
  test('desktop navigation puts reload, then restart, to the left of the search field', () => {
    const html = renderToStaticMarkup(
      <SettingsNav
        isMobile={false}
        isMobileSettingsSearchOpen={false}
        settingsSearchQuery=""
        setSettingsSearchQuery={() => {}}
        handleSettingsSearchKeyDown={() => {}}
        settingsSearchResults={[]}
        groupedSettingsSearchResults={[]}
        activeSearchResultIndex={0}
        setActiveSearchResultIndex={() => {}}
        searchResultRefs={{ current: [] }}
        keyboardSearchNavigationRef={{ current: false }}
        openSearchResult={() => {}}
        sortedFilteredPages={[]}
        settingsSlug="general"
        mobileStage="nav"
        openPage={() => {}}
        getPageTitle={() => 'General'}
        activeRemoteLabel={null}
      />,
    );
    const reload = html.indexOf(`aria-label="${RELOAD_PI_LABEL}"`);
    const restart = html.indexOf(`aria-label="${RESTART_PICHAMBER_LABEL}"`);
    const search = html.indexOf('aria-label="Search settings"');
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(restart).toBeGreaterThan(reload);
    expect(search).toBeGreaterThan(restart);
  });

  test('mobile header puts reload, then restart, before the search button on the navigation stage only', () => {
    const props = {
      activePageMeta: null,
      getPageTitle: () => 'Settings',
      showBackButton: false,
      mobileBackButtonLabel: 'Close settings',
      onBack: () => {},
      showOpenPageSidebarButton: false,
      onOpenPageSidebar: () => {},
      isMobileSettingsSearchOpen: false,
      setIsMobileSettingsSearchOpen: () => {},
      mobileSettingsSearchInputRef: { current: null },
      settingsSearchQuery: '',
      setSettingsSearchQuery: () => {},
      handleSettingsSearchKeyDown: () => {},
      shortcutKey: 'Ctrl',
    };
    const nav = renderToStaticMarkup(<MobileSettingsHeader {...props} mobileStage="nav" />);
    const reload = nav.indexOf(`aria-label="${RELOAD_PI_LABEL}"`);
    const restart = nav.indexOf(`aria-label="${RESTART_PICHAMBER_LABEL}"`);
    const search = nav.indexOf('aria-label="Search settings"');
    expect(reload).toBeGreaterThanOrEqual(0);
    expect(restart).toBeGreaterThan(reload);
    expect(search).toBeGreaterThan(restart);

    const page = renderToStaticMarkup(<MobileSettingsHeader {...props} mobileStage="page-content" />);
    expect(page).not.toContain(RELOAD_PI_LABEL);
  });
});
