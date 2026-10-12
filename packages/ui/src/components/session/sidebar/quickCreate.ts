import { GLOBAL_PROJECT_ID } from '@/components/chat/composer/state/draftTargetProjects';
import type { TreeNode } from './workspaceTree';

/** The part of a tree row a new session needs. */
type QuickCreateTarget = Pick<TreeNode, 'kind' | 'projectId' | 'directory'>;

/**
 * Rows that take a new session with one click: Chats, every worktree, and a flat
 * project (one checkout, sessions directly beneath it). A project with worktrees
 * creates in its worktrees; its own row has no folder scope. Never sessions,
 * folders, "N more", merged groups or Other folders.
 */
export const canQuickCreate = (node: Pick<TreeNode, 'kind' | 'projectId' | 'directory' | 'folderScopeKey'>): boolean => {
  if (node.kind === 'chats') return true;
  if (node.kind === 'worktree') return Boolean(node.projectId && node.directory);
  if (node.kind === 'project') return Boolean(node.projectId && node.directory && node.folderScopeKey);
  return false;
};

/** The hover button needs a hovering pointer; touch devices reach the same action through the row menu. */
export const canShowQuickCreateButton = (
  node: Pick<TreeNode, 'kind' | 'projectId' | 'directory' | 'folderScopeKey'>,
  { mobileVariant, hasTouchOnlyPointer }: { mobileVariant: boolean; hasTouchOnlyPointer: boolean },
): boolean => !mobileVariant && !hasTouchOnlyPointer && canQuickCreate(node);

export type CreateSessionInWorkspaceDeps = {
  /** Leaves any full-page surface (settings, archive, ...). */
  closeMainSurfaces: () => void;
  showChat: () => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null }) => void;
  /** Closes the mobile sessions drawer or switches a compact layout to chat. */
  onNavigateAway?: () => void;
  /** Left out where focusing would raise the on-screen keyboard (dedicated mobile). */
  focusComposer?: () => void;
};

/**
 * Starts a new session where `target` lives and puts the cursor in the composer.
 * A session is a draft until its first prompt (`createSession` in
 * `session-ui-draft-helpers.ts` runs on send), so no server call happens here.
 * Chats starts a chat without a folder (the store resolves the home directory,
 * `~` when unknown); a missing or other target starts a plain draft.
 */
export const createSessionInWorkspace = (target: QuickCreateTarget | undefined, deps: CreateSessionInWorkspaceDeps): void => {
  deps.closeMainSurfaces();
  deps.showChat();
  if (target?.projectId && target.directory) {
    deps.openNewSessionDraft({ selectedProjectId: target.projectId, directoryOverride: target.directory });
  } else if (target?.kind === 'chats') {
    deps.openNewSessionDraft({ selectedProjectId: GLOBAL_PROJECT_ID });
  } else {
    deps.openNewSessionDraft();
  }
  deps.onNavigateAway?.();
  deps.focusComposer?.();
};
