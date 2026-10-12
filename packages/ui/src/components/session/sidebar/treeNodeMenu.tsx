import React from 'react';
import { Icon } from '@/components/icon/Icon';
import { ContextMenuItem, ContextMenuSeparator } from '@/components/ui/context-menu';
import type { GitWorktree } from '@/lib/api/types';
import type { TreeNode } from './workspaceTree';

/** What the tree needs to rename, create and delete session folders. State lives in the sidebar. */
export type TreeFolderActions = {
  renamingFolderId: string | null;
  renameDraft: string;
  onRenameDraftChange: (value: string) => void;
  onStartRename: (node: TreeNode) => void;
  onSaveRename: (node: TreeNode) => void;
  onCancelRename: () => void;
  onCreateFolder: (scopeKey: string, parentFolderId: string | null) => void;
  onDeleteFolder: (node: TreeNode) => void;
};

type TreeNodeMenuActions = {
  folders: Pick<TreeFolderActions, 'onStartRename' | 'onDeleteFolder'>;
  /** Starts a new folder in the row's scope; on a folder row it becomes a subfolder. */
  onCreateFolder: (node: TreeNode) => void;
  onOpenProjectEditDialog: (projectId: string) => void;
  onRemoveProject: (projectId: string) => void;
  onCloseWorktree: (projectId: string, worktree: GitWorktree) => void;
};

/** The context menu items of a tree row, or undefined when the row has none. */
export const buildTreeNodeMenu = (node: TreeNode, actions: TreeNodeMenuActions): React.ReactNode => {
  const { folders } = actions;
  if (node.kind === 'folder' && node.folderScopeKey && node.folderId) {
    return (
      <>
        <ContextMenuItem onClick={() => folders.onStartRename(node)}>
          <Icon name="pencil-ai" className="mr-2 h-3.5 w-3.5" />
          <span>{'Rename'}</span>
        </ContextMenuItem>
        <ContextMenuItem onClick={() => actions.onCreateFolder(node)}>
          <Icon name="folder" className="mr-2 h-3.5 w-3.5" />
          <span>{'New subfolder'}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => folders.onDeleteFolder(node)} className="text-destructive focus:text-destructive">
          <Icon name="close" className="mr-2 h-3.5 w-3.5" />
          <span>{'Delete folder'}</span>
        </ContextMenuItem>
      </>
    );
  }
  const newFolderItem = node.folderScopeKey ? (
    <ContextMenuItem onClick={() => actions.onCreateFolder(node)}>
      <Icon name="folder" className="mr-2 h-3.5 w-3.5" />
      <span>{'New folder'}</span>
    </ContextMenuItem>
  ) : null;
  if (node.kind === 'project' && node.projectId) {
    const projectId = node.projectId;
    return (
      <>
        {newFolderItem}
        <ContextMenuItem onClick={() => actions.onOpenProjectEditDialog(projectId)}>
          <Icon name="edit" className="mr-2 h-3.5 w-3.5" />
          <span>{'Edit folder'}</span>
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => actions.onRemoveProject(projectId)} className="text-destructive focus:text-destructive">
          <Icon name="close" className="mr-2 h-3.5 w-3.5" />
          <span>{'Close folder'}</span>
        </ContextMenuItem>
      </>
    );
  }
  if (node.kind === 'worktree' && node.projectId && node.worktree) {
    const projectId = node.projectId;
    const worktree = node.worktree;
    return (
      <>
        {newFolderItem}
        {newFolderItem ? <ContextMenuSeparator /> : null}
        <ContextMenuItem
          title={node.rollup.running ? 'Stop the active session before closing this worktree.' : undefined}
          onClick={() => actions.onCloseWorktree(projectId, worktree)}
          className="text-destructive focus:text-destructive"
        >
          <Icon name="close" className="mr-2 h-3.5 w-3.5" />
          <span>{'Close worktree'}</span>
        </ContextMenuItem>
      </>
    );
  }
  // The project root (main) cannot be closed, but takes folders like any worktree.
  return newFolderItem ?? undefined;
};
