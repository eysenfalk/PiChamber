import type { IconName } from '@/components/icon/icons';

/**
 * Capacitor mobile workspace tabs (phone drawer + tablet side panel/header).
 *
 * Intentional v1 parity differences with the desktop rail (see
 * `packages/ui/src/apps/DOCUMENTATION.md` and `packages/mobile/README.md`):
 * - Labels are short ("PRs", "Issues") for the narrow drawer tab strip.
 * - PR detail shows Overview and Checks: the drawer renders
 *   `PullRequestsSurface hideFilesTab`. Files/review on mobile is a follow-up.
 * - No composer link picker on mobile (no attach-menu entry point).
 * - Browser is the remote view of the laptop desktop app's browser (#163,
 *   ADR 0012), the same view hosted web shows outside Electron.
 */
export type MobileWorkspaceTab = 'changes' | 'files' | 'terminal' | 'browser' | 'pull-requests' | 'issues';

export type MobileWorkspaceTabDef = {
  id: MobileWorkspaceTab;
  label: string;
  icon: IconName;
};

export const MOBILE_WORKSPACE_TABS: readonly MobileWorkspaceTabDef[] = [
  { id: 'changes', label: 'Changes', icon: 'git-branch' },
  { id: 'files', label: 'Files', icon: 'file-text' },
  { id: 'terminal', label: 'Terminal', icon: 'terminal-box' },
  { id: 'browser', label: 'Browser', icon: 'global' },
  // Intentional mobile difference: GitHub tabs are availability-gated (see
  // `getVisibleMobileWorkspaceTabs`) and keep-alive mounted like the core
  // tabs once visited, while desktop remounts these singleton surfaces on
  // every switch. Stores restore filters/selection either way.
  { id: 'pull-requests', label: 'PRs', icon: 'git-pull-request' },
  { id: 'issues', label: 'Issues', icon: 'task' },
];

const KNOWN_TABS: ReadonlySet<string> = new Set(MOBILE_WORKSPACE_TABS.map((tab) => tab.id));

export const isMobileWorkspaceTab = (value: unknown): value is MobileWorkspaceTab => {
  return typeof value === 'string' && KNOWN_TABS.has(value);
};

/**
 * Sanitize any persisted or external tab value (older builds stored only the
 * three core tabs; unknown values fall back to Changes, never throw).
 */
export const sanitizeMobileWorkspaceTab = (value: unknown): MobileWorkspaceTab => {
  return isMobileWorkspaceTab(value) ? value : 'changes';
};

export const isMobileGitHubTab = (tab: MobileWorkspaceTab): boolean => {
  return tab === 'pull-requests' || tab === 'issues';
};

/**
 * Visible drawer/header tabs under the shared `github-repo` rule: the caller
 * resolves availability with `isGitHubRepoAvailable` from
 * `lib/surfaces/registry` and passes the boolean here so this module stays
 * free of store subscriptions (and stays unit-testable in isolation).
 */
export const getVisibleMobileWorkspaceTabs = (githubAvailable: boolean): readonly MobileWorkspaceTabDef[] => {
  if (githubAvailable) return MOBILE_WORKSPACE_TABS;
  return MOBILE_WORKSPACE_TABS.filter((tab) => !isMobileGitHubTab(tab.id));
};

/**
 * Fall back to Changes when the active tab is a GitHub tab but GitHub is not
 * available (scope loading with no result, or resolved with zero repos).
 * Scope failures count as available upstream, so the failure renders.
 */
export const resolveMobileWorkspaceTab = (
  active: MobileWorkspaceTab,
  githubAvailable: boolean,
): MobileWorkspaceTab => {
  if (!githubAvailable && isMobileGitHubTab(active)) return 'changes';
  return active;
};
