/* eslint-disable */
import React from 'react';
import type { Session } from '@/lib/chat/types';
import { toast } from '@/components/ui';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/icon/Icon';
import { BackgroundTasksMenu } from '@/components/worktree/BackgroundTasksMenu';
import { useDeviceInfo } from '@/lib/device';
import { sessionEvents } from '@/lib/sessionEvents';
import { formatDirectoryName, cn } from '@/lib/utils';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { usePiSessionSnapshot } from '@/sync/pi-session-context';
import { catalogLiveSessionIdsKey } from '@/sync/pi-session-catalog';
import { buildKnownSessionDirectories } from '@/sync/known-session-directories';
import { useCatalogUiSessions } from '@/sync/sync-context';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useUIStore } from '@/stores/useUIStore';
import { getDeferredSafeStorage } from '@/stores/utils/safeStorage';
import { buildAvailableWorktreesByProject, useWorktreeStore } from '@/stores/useWorktreeStore';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useSidebarSpaceStore } from '@/stores/useSidebarSpaceStore';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { ProjectSessionSelectionEffect } from './sidebar/hooks/useProjectSessionSelection';
import { canShowQuickArchiveAction } from './sidebar/sessionQuickActions';
import { useSessionActions } from './sidebar/hooks/useSessionActions';
import { useAuthoritativeSessionCleanup } from './sidebar/hooks/useAuthoritativeSessionCleanup';
import { createSessionOwnershipIndex } from './sidebar/sessionOwnership';
import { SidebarHeader } from './sidebar/SidebarHeader';
import { SidebarNav } from './sidebar/SidebarNav';
import { SidebarFooter } from './sidebar/SidebarFooter';
import { isKnownActiveSessionDirectory } from './sidebar/sessionOwnership';
import { SidebarWorkspaceTree } from './sidebar/SidebarWorkspaceTree';
import { treeProjectLabel, useWorkspaceTreeModel } from './sidebar/hooks/useWorkspaceTreeModel';
import { CHATS_VISIBILITY_ID, useProjectVisibilityStore } from '@/stores/useProjectVisibilityStore';
import { useWorkspaceTreeExpansion } from './sidebar/hooks/useWorkspaceTreeExpansion';
import { folderScopesByProject, sessionsByProject, type NodeKey, type TreeNode } from './sidebar/workspaceTree';
import { GLOBAL_PROJECT_ID } from '@/components/chat/composer/state/draftTargetProjects';
import { SessionNodeItem } from './sidebar/SessionNodeItem';
import type { TreeFolderActions } from './sidebar/treeNodeMenu';
import type { SessionNodeRenderExtras } from './sidebar/sessionNodeItemUtils';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { useShallow } from 'zustand/react/shallow';
import type {
  BulkDeleteSessionsConfirmState,
  CloseWorktreeConfirmState,
  DeleteFolderConfirmState,
  DeleteSessionConfirmState,
} from './sidebar/ConfirmDialogs';
import { SidebarDialogs } from './sidebar/SidebarDialogs';
import { BulkActionBar } from './sidebar/BulkActionBar';
import { useSidebarBulkActions } from './sidebar/hooks/useSidebarBulkActions';
import type { SessionNode } from './sidebar/types';
import type { SessionRenderContext } from './sidebar/sessionNodeTypes';
import { useSessionPinnedStore } from '@/stores/useSessionPinnedStore';
import { normalizePath } from './sidebar/utils';
import { SidebarSessionLikeButton } from './sidebar/sidebarRowChrome';
import {
  createSessionLifecycleComparator,
  EMPTY_SESSION_ORDER_RANKS,
  orderSessionsByLifecycleScopes,
  useSessionOrderingStore,
} from '@/sync/session-ordering';
import { useNotificationStore } from '@/sync/notification-store';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useMobileAppActions } from '@/apps/mobileAppContext';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { streamPerfCount, streamPerfMark } from '@/stores/utils/streamDebug';

const PROJECT_ACTIVE_SESSION_STORAGE_KEY = 'oc.sessions.activeSessionByProject';
const EMPTY_SUBTREE_SET: Set<string> = new Set();
const EMPTY_STRING_ARRAY: string[] = [];

const useStableRenderCallback = <Args extends unknown[], Return>(handler: (...args: Args) => Return): ((...args: Args) => Return) => {
  const handlerRef = React.useRef(handler);
  handlerRef.current = handler;
  return React.useCallback((...args: Args) => handlerRef.current(...args), []);
};

interface SessionSidebarProps {
  isVisible?: boolean;
  mobileVariant?: boolean;
  onSessionSelected?: (sessionId: string) => void;
  onNavigateAway?: () => void;
  allowReselect?: boolean;
  hideDirectoryControls?: boolean;
  showOnlyMainWorkspace?: boolean;
}

const SessionSidebarComponent: React.FC<SessionSidebarProps> = ({
  isVisible = true,
  mobileVariant = false,
  onSessionSelected,
  onNavigateAway,
  allowReselect = false,
  hideDirectoryControls = false,
  showOnlyMainWorkspace = false,
}) => {
  streamPerfMark('react.session_sidebar_render');
  streamPerfCount('ui.session_sidebar.render');
  streamPerfCount(`ui.session_sidebar.render.${mobileVariant ? 'mobile' : 'desktop'}`);
  streamPerfCount(`ui.session_sidebar.render.${isVisible ? 'visible' : 'hidden'}`);
  const [isSessionSearchOpen, setIsSessionSearchOpen] = React.useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = React.useState('');
  const sessionSearchInputRef = React.useRef<HTMLInputElement | null>(null);
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const [editTitle, setEditTitle] = React.useState('');
  const [editingProjectDialogId, setEditingProjectDialogId] = React.useState<string | null>(null);
  const safeStorage = React.useMemo(() => getDeferredSafeStorage(), []);
  const selectedNodeKey = useSidebarSpaceStore((state) => state.selectedNodeKey);
  const selectNode = useSidebarSpaceStore((state) => state.select);
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);

  const [updateDialogOpen, setUpdateDialogOpen] = React.useState(false);
  const [openSidebarMenuKey, setOpenSidebarMenuKey] = React.useState<string | null>(null);
  const [renamingFolderId, setRenamingFolderId] = React.useState<string | null>(null);
  const [renameFolderDraft, setRenameFolderDraft] = React.useState('');
  const [deleteSessionConfirm, setDeleteSessionConfirm] = React.useState<DeleteSessionConfirmState>(null);
  const [deleteFolderConfirm, setDeleteFolderConfirm] = React.useState<DeleteFolderConfirmState>(null);
  const [closeWorktreeConfirm, setCloseWorktreeConfirm] = React.useState<CloseWorktreeConfirmState>(null);
  const [bulkDeleteConfirm, setBulkDeleteConfirm] = React.useState<BulkDeleteSessionsConfirmState>(null);
  const pinnedSessionIds = useSessionPinnedStore((state) => state.ids);
  const sessionOrderRanks = useSessionOrderingStore(React.useCallback(
    (state) => isVisible ? state.rankById : EMPTY_SESSION_ORDER_RANKS,
    [isVisible],
  ));
  const catalogLiveKey = usePiSessionSnapshot((state) => (
    isVisible ? catalogLiveSessionIdsKey(state.catalog) : ''
  ), undefined, 'catalog');
  const activeSessionIds = React.useMemo(
    () => (catalogLiveKey ? catalogLiveKey.split('|') : EMPTY_STRING_ARRAY),
    [catalogLiveKey],
  );
  const activeSessionIdSet = React.useMemo(() => new Set(activeSessionIds), [activeSessionIds]);
  const unreadSessionIds = useNotificationStore(useShallow(
    (state) => isVisible
      ? Object.entries(state.index.session.unseenCount)
        .filter(([, count]) => count > 0)
        .map(([sessionId]) => sessionId)
        .sort()
      : EMPTY_STRING_ARRAY,
  ));
  const unreadSessionIdSet = React.useMemo(() => new Set(unreadSessionIds), [unreadSessionIds]);
  const togglePinnedSession = useSessionPinnedStore((state) => state.toggle);
  const initialActiveSessionByProject = React.useMemo<Map<string, string>>(() => {
    try {
      const raw = getDeferredSafeStorage().getItem(PROJECT_ACTIVE_SESSION_STORAGE_KEY);
      if (!raw) {
        return new Map();
      }
      const parsed = JSON.parse(raw) as Record<string, string>;
      const next = new Map<string, string>();
      Object.entries(parsed).forEach(([projectId, sessionId]) => {
        if (typeof sessionId === 'string' && sessionId.length > 0) {
          next.set(projectId, sessionId);
        }
      });
      return next;
    } catch {
      return new Map();
    }
  }, []);
  const persistActiveSessionByProject = React.useCallback((value: Map<string, string>) => {
    try {
      safeStorage.setItem(PROJECT_ACTIVE_SESSION_STORAGE_KEY, JSON.stringify(Object.fromEntries(value.entries())));
    } catch { /* ignored */ }
  }, [safeStorage]);


  const homeDirectory = useDirectoryStore((state) => state.homeDirectory);
  const currentDirectory = useDirectoryStore((state) => state.currentDirectory);

  const projects = useProjectsStore((state) => state.projects);
  const activeProjectId = useProjectsStore((state) => state.activeProjectId);
  const removeProject = useProjectsStore((state) => state.removeProject);
  const setActiveProjectIdOnly = useProjectsStore((state) => state.setActiveProjectIdOnly);
  const updateProjectMeta = useProjectsStore((state) => state.updateProjectMeta);

  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const setSettingsDialogOpen = useUIStore((state) => state.setSettingsDialogOpen);
  const setSettingsPage = useUIStore((state) => state.setSettingsPage);
  const toggleHelpDialog = useUIStore((state) => state.toggleHelpDialog);
  const setSessionSwitcherOpen = useUIStore((state) => state.setSessionSwitcherOpen);
  const setArchivePageOpen = useUIStore((state) => state.setArchivePageOpen);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const setShowDeletionDialog = useUIStore((state) => state.setShowDeletionDialog);

  const debouncedSessionSearchQuery = useDebouncedValue(sessionSearchQuery, 120);
  // A closed search box never narrows the tree, even if it still holds text.
  const normalizedSessionSearchQuery = React.useMemo(
    () => (isSessionSearchOpen ? debouncedSessionSearchQuery.trim().toLowerCase() : ''),
    [debouncedSessionSearchQuery, isSessionSearchOpen],
  );

  const hasSessionSearchQuery = normalizedSessionSearchQuery.length > 0;

  // Session Folders store
  const foldersMap = useSessionFoldersStore((state) => state.foldersMap);
  const getFoldersForScope = useSessionFoldersStore((state) => state.getFoldersForScope);
  const createFolder = useSessionFoldersStore((state) => state.createFolder);
  const renameFolder = useSessionFoldersStore((state) => state.renameFolder);
  const deleteFolder = useSessionFoldersStore((state) => state.deleteFolder);
  const addSessionToFolder = useSessionFoldersStore((state) => state.addSessionToFolder);
  const addSessionsToFolder = useSessionFoldersStore((state) => state.addSessionsToFolder);
  const removeSessionFromFolder = useSessionFoldersStore((state) => state.removeSessionFromFolder);
  const removeSessionsFromFolders = useSessionFoldersStore((state) => state.removeSessionsFromFolders);
  const getSessionFolderId = useSessionFoldersStore((state) => state.getSessionFolderId);

  const hiddenProjectIds = useProjectVisibilityStore((state) => state.hiddenProjectIds);
  const setProjectHidden = useProjectVisibilityStore((state) => state.setHidden);
  const showAllProjects = useProjectVisibilityStore((state) => state.showAll);
  const hideAllProjects = useProjectVisibilityStore((state) => state.hideAll);


  const { git } = useRuntimeAPIs();
  const piConnection = usePiSessionSnapshot((state) => state.connection, undefined, 'chrome');
  const catalogReady = usePiSessionSnapshot((state) => {
    for (const status of state.catalog.listStatusByDirectory.values()) {
      if (status === 'ready') return true;
    }
    return false;
  }, undefined, 'catalog');
  const catalogSessions = useCatalogUiSessions({ archived: false });
  const archivedSessions = useCatalogUiSessions({ archived: true });
  const setCurrentSession = useSessionUIStore((state) => state.setCurrentSession);
  const updateSessionTitle = useSessionUIStore((state) => state.updateSessionTitle);
  const shareSession = useSessionUIStore((state) => state.shareSession);
  const unshareSession = useSessionUIStore((state) => state.unshareSession);
  // sessionAttentionStates removed — now using notification-store directly in SessionNodeItem
  const worktreeProjects = useWorktreeStore((state) => state.projects);
  const refreshWorktreeProject = useWorktreeStore((state) => state.refreshProject);
  const availableWorktreesByProject = React.useMemo(
    () => buildAvailableWorktreesByProject(projects, { projects: worktreeProjects }),
    [projects, worktreeProjects],
  );
  const worktreeErrorsByProject = React.useMemo(() => {
    const errors = new Map<string, string>();
    for (const project of projects) {
      const projectPath = normalizePath(project.path);
      if (!projectPath) continue;
      const error = worktreeProjects.get(projectPath)?.error;
      if (error) errors.set(projectPath, error);
    }
    return errors;
  }, [projects, worktreeProjects]);
  const openNewSessionDraft = useSessionUIStore((state) => state.openNewSessionDraft);
  // The sidebar tree's +-buttons (project / group / folder) open a draft but,
  // unlike selecting an existing session, don't navigate. VS Code's compact view
  // is driven by the pichamber:navigate event, so switch to chat explicitly
  // (a no-op in the expanded side-by-side layout, which is always showing chat).
  const openNewSessionDraftFromTree = React.useCallback<typeof openNewSessionDraft>((options) => {
    // Starting a draft always leaves any full-page surface, even when a
    // draft was already open (no store transition fires in that case).
    useUIStore.getState().closeMainSurfaces();
    openNewSessionDraft(options);
    onNavigateAway?.();
  }, [onNavigateAway, openNewSessionDraft]);
  const updateStore = useUpdateStore(useShallow((s) => ({
    checkForUpdates: s.checkForUpdates,
    available: s.available,
    runtimeType: s.runtimeType,
    info: s.info,
    downloading: s.downloading,
    downloaded: s.downloaded,
    progress: s.progress,
    error: s.error,
    downloadUpdate: s.downloadUpdate,
    restartToUpdate: s.restartToUpdate,
  })));

  const knownSessionDirectories = React.useMemo(
    () => buildKnownSessionDirectories(projects, availableWorktreesByProject, { includeWorktrees: true }),
    [availableWorktreesByProject, projects],
  );

  const sessions = React.useMemo(() => {
    return catalogSessions.filter((session) => isKnownActiveSessionDirectory(session, knownSessionDirectories, {
      allowUnknownDirectory: true,
      allowEmptyDirectorySet: true,
      homeDirectory,
    }));
  }, [catalogSessions, homeDirectory, knownSessionDirectories]);

  const persistenceSessions = React.useMemo(
    () => [...sessions, ...archivedSessions],
    [archivedSessions, sessions],
  );

  const worktreeTopologyState = React.useMemo(() => {
    const unresolved = new Set<string>();
    let complete = true;
    for (const project of projects) {
      const projectPath = normalizePath(project.path);
      if (!projectPath) continue;
      const status = worktreeProjects.get(projectPath)?.status ?? 'idle';
      if (status === 'failed') unresolved.add(projectPath);
      if (status === 'idle' || status === 'loading') complete = false;
    }
    return { complete, unresolved };
  }, [projects, worktreeProjects]);
  const { isTablet } = useDeviceInfo();
  const alwaysShowSidebarActions = mobileVariant || isTablet;
  // Touch/tablet rows expose management through the always-visible menu and
  // its press-and-hold context menu. Only a pointer-oriented desktop gets the
  // one-click archive action that replaces the row timestamp on hover.
  const allowQuickArchiveAction = canShowQuickArchiveAction({ mobileVariant, isTablet });

  const orderedSessions = React.useMemo(() => {
    return orderSessionsByLifecycleScopes(sessions, pinnedSessionIds, sessionOrderRanks);
  }, [pinnedSessionIds, sessionOrderRanks, sessions]);

  const childrenMap = React.useMemo(() => {
    const map = new Map<string, Session[]>();
    orderedSessions.forEach((session) => {
      const parentID = (session as Session & { parentID?: string | null }).parentID;
      if (!parentID) {
        return;
      }
      const collection = map.get(parentID) ?? [];
      collection.push(session);
      map.set(parentID, collection);
    });
    const compare = createSessionLifecycleComparator(pinnedSessionIds, sessionOrderRanks);
    map.forEach((list) => list.sort(compare));
    return map;
  }, [orderedSessions, pinnedSessionIds, sessionOrderRanks]);

  const emptyState = React.useMemo(() => {
    if (hasSessionSearchQuery) {
      return <p className="px-3 py-2 typography-ui-label text-muted-foreground">{"No matches"}</p>;
    }
    if (hiddenProjectIds.size > 0) {
      return (
        <SidebarSessionLikeButton icon="eye" mobileVariant={mobileVariant} onClick={showAllProjects}>
          {"Show hidden projects"}
        </SidebarSessionLikeButton>
      );
    }
    return (
      <SidebarSessionLikeButton
        icon="chat-new"
        mobileVariant={mobileVariant}
        onClick={() => openNewSessionDraftFromTree()}
      >
        {"New session"}
      </SidebarSessionLikeButton>
    );
  }, [hasSessionSearchQuery, hiddenProjectIds.size, mobileVariant, openNewSessionDraftFromTree, showAllProjects]);

  const editingProject = React.useMemo(
    () => projects.find((project) => project.id === editingProjectDialogId) ?? null,
    [projects, editingProjectDialogId],
  );

  const handleSaveProjectEdit = React.useCallback((data: {
    label: string;
    defaultModel: string | null;
  }) => {
    if (!editingProjectDialogId) {
      return;
    }
    updateProjectMeta(editingProjectDialogId, {
      label: data.label,
      defaultModel: data.defaultModel ?? null,
    });
  }, [editingProjectDialogId, updateProjectMeta]);

  const handleOpenUpdateDialog = React.useCallback(() => {
    const current = useUpdateStore.getState();
    if (current.available && current.info) {
      setUpdateDialogOpen(true);
      return;
    }

    void updateStore.checkForUpdates().then(() => {
      const { available, error } = useUpdateStore.getState();
      if (error) {
        toast.error("Failed to check for updates", { description: error });
        return;
      }
      if (!available) {
        toast.success("You are on the latest version");
        return;
      }
      setUpdateDialogOpen(true);
    });
  }, [ updateStore]);

  const mobileAppActions = useMobileAppActions();
  const handleOpenSettings = React.useCallback(() => {
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    onNavigateAway?.();
    if (mobileAppActions?.openSettings) {
      mobileAppActions.openSettings();
      return;
    }
    setSettingsDialogOpen(true);
  }, [mobileAppActions, mobileVariant, onNavigateAway, setSessionSwitcherOpen, setSettingsDialogOpen]);

  const showSidebarUpdateButton =
    updateStore.available &&
    (updateStore.runtimeType === 'desktop' || updateStore.runtimeType === 'web');

  const deleteSession = useSessionUIStore((state) => state.deleteSession);
  const deleteSessions = useSessionUIStore((state) => state.deleteSessions);
  const archiveSession = useSessionUIStore((state) => state.archiveSession);
  const archiveSessions = useSessionUIStore((state) => state.archiveSessions);
  const unarchiveSession = useSessionUIStore((state) => state.unarchiveSession);
  const unarchiveSessions = useSessionUIStore((state) => state.unarchiveSessions);

  const {
    copiedSessionId,
    handleSessionSelect,
    handleSessionDoubleClick,
    handleSaveEdit,
    handleCancelEdit,
    handleShareSession,
    handleCopyShareUrl,
    handleCopySessionId,
    handleUnshareSession,
    handleDeleteSession,
    handleRestoreSession,
    confirmDeleteSession,
  } = useSessionActions({
    mobileVariant,
    allowReselect,
    onSessionSelected,
    isSessionSearchOpen,
    sessionSearchQuery,
    setSessionSearchQuery,
    setIsSessionSearchOpen,
    setActiveMainTab,
    setSessionSwitcherOpen,
    setCurrentSession,
    updateSessionTitle,
    shareSession,
    unshareSession,
    deleteSession,
    deleteSessions,
    archiveSession,
    archiveSessions,
    unarchiveSession,
    childrenMap,
    showDeletionDialog,
    setDeleteSessionConfirm,
    deleteSessionConfirm,
    setEditingId,
    setEditTitle,
    editingId,
    editTitle,
  });

  const confirmDeleteFolder = React.useCallback(() => {
    if (!deleteFolderConfirm) return;
    const { scopeKey, folderId } = deleteFolderConfirm;
    setDeleteFolderConfirm(null);
    deleteFolder(scopeKey, folderId);
  }, [deleteFolderConfirm, deleteFolder]);

  const handleOpenDirectoryDialog = React.useCallback(() => {
    sessionEvents.requestDirectoryDialog();
  }, []);

  const createFolderAndStartRename = React.useCallback(
    (scopeKey: string, parentId?: string | null) => {
      if (!scopeKey) {
        return null;
      }

      const newFolder = createFolder(scopeKey, "New folder", parentId);
      setRenamingFolderId(newFolder.id);
      setRenameFolderDraft(newFolder.name);
      return newFolder;
    },
    [createFolder],
  );

  const stableHandleSessionSelect = useStableRenderCallback(handleSessionSelect);
  const stableHandleSessionDoubleClick = useStableRenderCallback(handleSessionDoubleClick);
  const stableHandleSaveEdit = useStableRenderCallback(handleSaveEdit);
  const stableHandleCancelEdit = useStableRenderCallback(handleCancelEdit);
  const stableHandleShareSession = useStableRenderCallback(handleShareSession);
  const stableHandleCopyShareUrl = useStableRenderCallback(handleCopyShareUrl);
  const stableHandleCopySessionId = useStableRenderCallback(handleCopySessionId);
  const stableHandleUnshareSession = useStableRenderCallback(handleUnshareSession);
  const stableHandleDeleteSession = useStableRenderCallback(handleDeleteSession);
  const stableHandleRestoreSession = useStableRenderCallback(handleRestoreSession);
  const stableCreateFolderAndStartRename = useStableRenderCallback(createFolderAndStartRename);

  const normalizedProjects = React.useMemo(() => {
    return projects
      .map((project) => ({
        ...project,
        normalizedPath: normalizePath(project.path),
      }))
      .filter((project) => Boolean(project.normalizedPath)) as Array<{
        id: string;
        path: string;
        label?: string;
        normalizedPath: string;
        icon?: string;
        color?: string;
        iconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
        iconBackground?: string;
        addedAt?: number;
        lastOpenedAt?: number;
        sidebarCollapsed?: boolean;
      }>;
  }, [projects]);

  const sessionOwnership = React.useMemo(
    () => createSessionOwnershipIndex(sessions, normalizedProjects, availableWorktreesByProject, archivedSessions),
    [archivedSessions, availableWorktreesByProject, normalizedProjects, sessions],
  );
  useAuthoritativeSessionCleanup({
    enabled: isVisible,
    hasAuthoritativeGlobalSessions: catalogReady,
    sessions: persistenceSessions,
  });

  const workspaceTreeModel = useWorkspaceTreeModel({
    projects: normalizedProjects,
    worktreesByProjectPath: availableWorktreesByProject,
    ownership: sessionOwnership,
    sessions,
    foldersByScope: foldersMap,
    pinnedSessionIds,
    runningSessionIds: activeSessionIdSet,
    unseenSessionIds: unreadSessionIdSet,
    discoveryComplete: worktreeTopologyState.complete,
    hidden: hiddenProjectIds,
    query: normalizedSessionSearchQuery,
  });
  const workspaceTreeExpansion = useWorkspaceTreeExpansion(workspaceTreeModel.tree, currentSessionId, normalizedSessionSearchQuery);
  const visibilityEntries = React.useMemo(
    () => [
      { id: CHATS_VISIBILITY_ID, label: 'Chats' },
      ...normalizedProjects.map((project) => ({ id: project.id, label: treeProjectLabel(project) })),
    ],
    [normalizedProjects],
  );
  const handleHideAllProjects = React.useCallback(
    () => hideAllProjects(visibilityEntries.map((entry) => entry.id)),
    [hideAllProjects, visibilityEntries],
  );
  const handleSelectTreeNode = React.useCallback((key: NodeKey) => {
    selectNode(key);
    const projectId = workspaceTreeModel.nodesByKey.get(key)?.projectId;
    if (projectId) setActiveProjectIdOnly(projectId);
  }, [selectNode, setActiveProjectIdOnly, workspaceTreeModel.nodesByKey]);

  const treeFolderScopes = React.useMemo(
    () => folderScopesByProject(workspaceTreeModel.tree),
    [workspaceTreeModel.tree],
  );
  const treeProjectSessions = React.useMemo(
    () => sessionsByProject(workspaceTreeModel.tree),
    [workspaceTreeModel.tree],
  );
  // The worktree row rolls up the running state of every session below it.
  const worktreeHasRunningSession = React.useCallback((worktreePath: string): boolean => {
    const normalizedPath = normalizePath(worktreePath);
    return Boolean(normalizedPath && workspaceTreeModel.nodesByKey.get(`w:${normalizedPath}`)?.rollup.running);
  }, [workspaceTreeModel.nodesByKey]);
  const searchMatchCount = workspaceTreeModel.tree.matchCount;
  const hiddenProjectMatchCount = React.useMemo(
    () => workspaceTreeModel.tree.roots.filter((root) => root.hiddenMatch).length,
    [workspaceTreeModel.tree.roots],
  );

  const treeFolderActions = React.useMemo<TreeFolderActions>(() => ({
    renamingFolderId,
    renameDraft: renameFolderDraft,
    onRenameDraftChange: setRenameFolderDraft,
    onStartRename: (node) => {
      if (!node.folderId) return;
      setRenameFolderDraft(node.label);
      setRenamingFolderId(node.folderId);
    },
    onSaveRename: (node) => {
      const name = renameFolderDraft.trim();
      if (node.folderScopeKey && node.folderId && name && name !== node.label) {
        renameFolder(node.folderScopeKey, node.folderId, name);
      }
      setRenamingFolderId(null);
    },
    onCancelRename: () => setRenamingFolderId(null),
    onCreateFolder: (scopeKey, parentFolderId) => {
      createFolderAndStartRename(scopeKey, parentFolderId);
    },
    onDeleteFolder: (node) => {
      if (!node.folderScopeKey || !node.folderId) return;
      if (!showDeletionDialog) {
        deleteFolder(node.folderScopeKey, node.folderId);
        return;
      }
      setDeleteFolderConfirm({
        scopeKey: node.folderScopeKey,
        folderId: node.folderId,
        folderName: node.label,
        subFolderCount: node.children.filter((child) => child.kind === 'folder').length,
        sessionCount: node.children.filter((child) => child.kind === 'session').length,
      });
    },
  }), [createFolderAndStartRename, deleteFolder, renameFolder, renameFolderDraft, renamingFolderId, showDeletionDialog]);

  const handleOpenTreeSession = React.useCallback((sessionId: string, directory: string | null) => {
    stableHandleSessionSelect(sessionId, directory);
  }, [stableHandleSessionSelect]);


  const desktopHeaderActionButtonClass =
    'inline-flex h-6 w-6 cursor-pointer items-center justify-center rounded-md leading-none text-foreground hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed';
  const mobileHeaderActionButtonClass =
    'flex size-10 shrink-0 items-center justify-center rounded-full leading-none text-muted-foreground transition-colors hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:cursor-not-allowed';
  const headerActionButtonClass = mobileVariant ? mobileHeaderActionButtonClass : desktopHeaderActionButtonClass;
  const headerActionIconClass = mobileVariant ? 'size-5' : 'h-4.5 w-4.5';

  const renderSessionNode = useStableRenderCallback(
    (
      node: SessionNode,
      depth: number = 0,
      groupDirectory?: string | null,
      projectId?: string | null,
      archivedBucket: boolean = false,
      secondaryMeta?: { projectLabel?: string | null; branchLabel?: string | null; globalSession?: boolean } | null,
      renderContext: SessionRenderContext = 'tree',
      renderExtras?: SessionNodeRenderExtras,
    ): React.ReactNode => (
      <SessionNodeItem
        node={node}
        depth={depth}
        groupDirectory={groupDirectory}
        projectId={projectId}
        archivedBucket={archivedBucket}
        pinnedSessionIds={pinnedSessionIds}
        hasSessionSearchQuery={hasSessionSearchQuery}
        normalizedSessionSearchQuery={normalizedSessionSearchQuery}
        editingId={editingId}
        setEditingId={setEditingId}
        editTitle={editTitle}
        setEditTitle={setEditTitle}
        handleSaveEdit={stableHandleSaveEdit}
        handleCancelEdit={stableHandleCancelEdit}
        handleSessionSelect={stableHandleSessionSelect}
        handleSessionDoubleClick={stableHandleSessionDoubleClick}
        togglePinnedSession={togglePinnedSession}
        handleShareSession={stableHandleShareSession}
        copiedSessionId={copiedSessionId}
        handleCopyShareUrl={stableHandleCopyShareUrl}
        handleCopySessionId={stableHandleCopySessionId}
        handleUnshareSession={stableHandleUnshareSession}
        openSidebarMenuKey={openSidebarMenuKey}
        setOpenSidebarMenuKey={setOpenSidebarMenuKey}
        renamingFolderId={renamingFolderId}
        getFoldersForScope={getFoldersForScope}
        getSessionFolderId={getSessionFolderId}
        removeSessionFromFolder={removeSessionFromFolder}
        addSessionToFolder={addSessionToFolder}
        createFolderAndStartRename={stableCreateFolderAndStartRename}
        handleDeleteSession={stableHandleDeleteSession}
        handleRestoreSession={stableHandleRestoreSession}
        mobileVariant={mobileVariant}
        alwaysShowActions={alwaysShowSidebarActions}
        allowQuickArchiveAction={allowQuickArchiveAction}
        renderSessionNode={renderSessionNode}
        secondaryMeta={secondaryMeta}
        renderContext={renderContext}
        subtreeContainsEditing={renderExtras?.subtreeContainsEditing ?? EMPTY_SUBTREE_SET}
        menuOpenSessionId={renderExtras?.menuOpenSessionId ?? null}
        nodeStructureKey={renderExtras?.nodeStructureKey ?? ''}
        childRenderExtrasFor={renderExtras?.childRenderExtrasFor}
      />
    ),
  );

  const isInlineEditing = Boolean(renamingFolderId || editingId || editingProjectDialogId);

  const {
    selectionModeEnabled,
    hasSelection,
    selectedIdsSize,
    bulkScopeIsArchived,
    derivedSelectionScope,
    bulkScopeFolders,
    bulkCanRemoveFromFolder,
    handleToggleSelectionMode,
    handleExitSelectionMode,
    handleBulkMoveToFolder,
    handleBulkCreateFolderAndMove,
    handleBulkRemoveFromFolder,
    handleBulkDelete,
    handleBulkRestore,
    confirmBulkDelete,
  } = useSidebarBulkActions({
    isInlineEditing,
    showDeletionDialog,
    foldersMap,
    folderScopesByProject: treeFolderScopes,
    addSessionsToFolder,
    removeSessionsFromFolders,
    createFolderAndStartRename,
    archiveSessions,
    unarchiveSessions,
    deleteSessions,
    setBulkDeleteConfirm,
  });

  // A new session lands in the node's directory; Chats, or no node, starts a chat without a workspace.
  const startNewSessionIn = React.useCallback((node: TreeNode | undefined) => {
    useUIStore.getState().closeMainSurfaces();
    setActiveMainTab('chat');
    if (mobileVariant) {
      setSessionSwitcherOpen(false);
    }
    if (node?.projectId && node.directory) {
      openNewSessionDraft({ selectedProjectId: node.projectId, directoryOverride: node.directory });
    } else if (node?.kind === 'chats') {
      openNewSessionDraft({ selectedProjectId: GLOBAL_PROJECT_ID });
    } else {
      openNewSessionDraft();
    }
    onNavigateAway?.();
  }, [mobileVariant, onNavigateAway, openNewSessionDraft, setActiveMainTab, setSessionSwitcherOpen]);

  const handleOpenNewSessionDraftFromHeader = React.useCallback(() => {
    startNewSessionIn(selectedNodeKey ? workspaceTreeModel.nodesByKey.get(selectedNodeKey as NodeKey) : undefined);
  }, [selectedNodeKey, startNewSessionIn, workspaceTreeModel.nodesByKey]);

  const handleRequestCloseWorktree = React.useCallback((projectId: string, worktree: NonNullable<CloseWorktreeConfirmState>['worktree']) => {
    const project = projects.find((candidate) => candidate.id === projectId);
    if (!project) return;

    const hasActiveSession = worktreeHasRunningSession(worktree.path);
    setCloseWorktreeConfirm({
      projectId,
      projectPath: project.path,
      worktree,
      hasActiveSession,
    });
  }, [projects, worktreeHasRunningSession]);

  const confirmCloseWorktree = React.useCallback(async ({ force }: { force: boolean }) => {
    const pending = closeWorktreeConfirm;
    if (!pending) return;

    if (worktreeHasRunningSession(pending.worktree.path)) {
      setCloseWorktreeConfirm({ ...pending, hasActiveSession: true });
      toast.warning('Stop the active session before closing this worktree.');
      return;
    }

    if (!git.deleteGitWorktree) {
      toast.error('Closing worktrees is not supported by this runtime.');
      return;
    }

    try {
      const result = await git.deleteGitWorktree(pending.projectPath, {
        directory: pending.worktree.path,
        force,
      });
      if (!result?.success) {
        throw new Error('Git worktree removal was not confirmed by the server.');
      }

      // Forced: this follows an explicit remove mutation, so the freshness
      // window must not serve the pre-delete topology.
      let refreshed = await refreshWorktreeProject(pending.projectPath, git, { force: true });
      const targetPath = normalizePath(pending.worktree.path);
      // refreshProject coalesces concurrent polls for the same project. If a
      // discovery fetch started before removal, the first result can predate
      // the delete; re-read once when the removed path is still listed.
      if (
        refreshed !== null
        && targetPath !== null
        && refreshed.some((entry) => normalizePath(entry.path) === targetPath)
      ) {
        refreshed = await refreshWorktreeProject(pending.projectPath, git, { force: true });
      }
      const isCurrentWorktree = targetPath !== null && normalizePath(currentDirectory) === targetPath;
      if (targetPath !== null && selectedNodeKey === `w:${targetPath}`) {
        selectNode(`p:${pending.projectId}`);
      }
      if (isCurrentWorktree) {
        openNewSessionDraftFromTree({ selectedProjectId: pending.projectId, directoryOverride: normalizePath(pending.projectPath) });
      }

      setCloseWorktreeConfirm(null);
      if (refreshed === null) {
        toast.warning('Worktree closed, but the sidebar could not be refreshed.');
      } else {
        toast.success('Worktree closed.');
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Try again.';
      toast.error('Failed to close worktree.', { description: message });
    }
  }, [
    worktreeHasRunningSession,
    closeWorktreeConfirm,
    currentDirectory,
    git,
    openNewSessionDraftFromTree,
    refreshWorktreeProject,
    selectNode,
    selectedNodeKey,
  ]);

  return (
    // Header/action tooltips only. Session rows do not use hover/hold tooltips.
    <TooltipProvider delay={400} closeDelay={150} timeout={600}>
    <div
      className={cn(
        'relative flex h-full flex-col text-foreground overflow-x-hidden',
        mobileVariant ? '' : 'bg-transparent',
      )}
    >
      <ProjectSessionSelectionEffect
        projects={normalizedProjects}
        projectSessions={treeProjectSessions}
        activeProjectId={activeProjectId}
        initialActiveSessionByProject={initialActiveSessionByProject}
        persistActiveSessionByProject={persistActiveSessionByProject}
        handleSessionSelect={stableHandleSessionSelect}
        mobileVariant={mobileVariant}
        openNewSessionDraft={openNewSessionDraft}
        setActiveMainTab={setActiveMainTab}
        setSessionSwitcherOpen={setSessionSwitcherOpen}
      />
      {!hideDirectoryControls && !mobileVariant ? (
        <SidebarNav
          onNewSession={handleOpenNewSessionDraftFromHeader}
          showSidebarToggle
        />
      ) : null}

      <SidebarHeader
        hideDirectoryControls={hideDirectoryControls}
        handleOpenDirectoryDialog={handleOpenDirectoryDialog}
        onOpenArchive={() => {
          if (mobileVariant) setSessionSwitcherOpen(false);
          setArchivePageOpen(true);
        }}
        onOpenSettings={mobileVariant ? handleOpenSettings : undefined}
        onOpenInstances={mobileVariant ? mobileAppActions?.openInstances : undefined}
        instanceLabel={mobileVariant ? mobileAppActions?.instanceLabel : undefined}
        onOpenUpdate={mobileVariant ? mobileAppActions?.openUpdate : undefined}
        headerActionIconClass={headerActionIconClass}
        headerActionButtonClass={headerActionButtonClass}
        isSessionSearchOpen={isSessionSearchOpen}
        setIsSessionSearchOpen={setIsSessionSearchOpen}
        sessionSearchInputRef={sessionSearchInputRef}
        sessionSearchQuery={sessionSearchQuery}
        setSessionSearchQuery={setSessionSearchQuery}
        hasSessionSearchQuery={hasSessionSearchQuery}
        searchMatchCount={searchMatchCount}
        hiddenProjectMatchCount={hiddenProjectMatchCount}
        visibilityEntries={visibilityEntries}
        hiddenProjectIds={hiddenProjectIds}
        onSetProjectHidden={setProjectHidden}
        onShowAllProjects={showAllProjects}
        onHideAllProjects={handleHideAllProjects}
        selectionModeEnabled={selectionModeEnabled}
        onToggleSelectionMode={handleToggleSelectionMode}
        mobileVariant={mobileVariant}
      />

      {piConnection === 'error' || piConnection === 'unavailable' ? (
        <div
          role="alert"
          className="mx-3 mb-2 rounded border border-[var(--status-error-border)] bg-[var(--status-error-background)] p-2 text-xs text-foreground"
        >
          {"Unable to reach server"}
        </div>
      ) : null}

      <SidebarWorkspaceTree
        tree={workspaceTreeModel.tree}
        expanded={workspaceTreeExpansion.expanded}
        setOpen={workspaceTreeExpansion.setOpen}
        selectedNodeKey={selectedNodeKey}
        onSelectNode={handleSelectTreeNode}
        activeSessionId={currentSessionId}
        renderSession={(node, directory, projectId) => renderSessionNode(node, 0, directory, projectId, false, null, 'tree')}
        onOpenSession={handleOpenTreeSession}
        onNewSessionIn={startNewSessionIn}
        folders={treeFolderActions}
        onOpenProjectEditDialog={setEditingProjectDialogId}
        onRemoveProject={removeProject}
        onCloseWorktree={handleRequestCloseWorktree}
        onOpenDirectoryDialog={hideDirectoryControls ? undefined : handleOpenDirectoryDialog}
        emptyState={emptyState}
        mobileVariant={mobileVariant}
        query={normalizedSessionSearchQuery}
      />

      {/* Dedicated mobile: the new-session action floats above the session
          list, docked to the sidebar bottom with a sidebar-toned fade so the
          last rows stay readable underneath. Hidden while the bulk selection
          bar owns the bottom edge. The tablet sidebar keeps the SidebarNav
          control instead (mobileVariant is false there). */}
      {mobileVariant && !(selectionModeEnabled && hasSelection) ? (
        <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 flex flex-col gap-2 bg-gradient-to-t from-sidebar via-sidebar/85 to-transparent px-4 pb-[calc(0.75rem+var(--oc-safe-area-bottom,0px))] pt-10">
          <BackgroundTasksMenu variant="mobile" />
          <Button
            type="button"
            variant="default"
            size="lg"
            className="pointer-events-auto w-full shadow-lg"
            onClick={handleOpenNewSessionDraftFromHeader}
            aria-label="New session"
          >
            <Icon name="chat-new" className="size-4" />
          </Button>
        </div>
      ) : null}

      {selectionModeEnabled && hasSelection ? (
        <BulkActionBar
          selectedCount={selectedIdsSize}
          scopeKey={derivedSelectionScope}
          scopeFolders={bulkScopeFolders}
          archivedBucket={bulkScopeIsArchived}
          onMoveToFolder={handleBulkMoveToFolder}
          onCreateFolderAndMove={handleBulkCreateFolderAndMove}
          onRemoveFromFolder={handleBulkRemoveFromFolder}
          canRemoveFromFolder={bulkCanRemoveFromFolder}
          onRestore={handleBulkRestore}
          onDelete={handleBulkDelete}
          onDone={handleExitSelectionMode}
        />
      ) : null}

      {!mobileVariant ? (
      <SidebarFooter
        onOpenSettings={handleOpenSettings}
        onOpenShortcuts={toggleHelpDialog}
        onOpenAbout={() => {
          setSettingsPage('about');
          setSettingsDialogOpen(true);
        }}
        onOpenUpdate={handleOpenUpdateDialog}
        showRuntimeButtons
        showUpdateButton={showSidebarUpdateButton}
      />
      ) : null}

      <SidebarDialogs
        updateDialogOpen={updateDialogOpen}
        setUpdateDialogOpen={setUpdateDialogOpen}
        updateStore={updateStore}
        editingProject={editingProject}
        setEditingProjectDialogId={setEditingProjectDialogId}
        handleSaveProjectEdit={handleSaveProjectEdit}
        deleteSessionConfirm={deleteSessionConfirm}
        setDeleteSessionConfirm={setDeleteSessionConfirm}
        showDeletionDialog={showDeletionDialog}
        setShowDeletionDialog={setShowDeletionDialog}
        confirmDeleteSession={confirmDeleteSession}
        deleteFolderConfirm={deleteFolderConfirm}
        setDeleteFolderConfirm={setDeleteFolderConfirm}
        confirmDeleteFolder={confirmDeleteFolder}
        closeWorktreeConfirm={closeWorktreeConfirm}
        setCloseWorktreeConfirm={setCloseWorktreeConfirm}
        confirmCloseWorktree={confirmCloseWorktree}
        bulkDeleteConfirm={bulkDeleteConfirm}
        setBulkDeleteConfirm={setBulkDeleteConfirm}
        confirmBulkDelete={confirmBulkDelete}
      />
    </div>
    </TooltipProvider>
  );
};

export const SessionSidebar = React.memo(SessionSidebarComponent);
