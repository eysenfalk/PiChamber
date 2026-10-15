/* eslint-disable */
import React from 'react';
import type { Session } from '@/lib/chat/types';
import { ContextMenu } from '@base-ui/react/context-menu';
import { cn } from '@/lib/utils';
import { canUseElectronDesktopIPC, invokeDesktop } from '@/lib/desktop';
import { Icon } from '@/components/icon/Icon';
import { AgentThinkingLoader } from '@/components/chat/AgentThinkingLoader';
import type { SessionNodeChildRenderExtras } from './sessionNodeItemUtils';
import { renderHighlightedText } from './highlightedText';
import { SessionActivityDuration } from '@/components/session/SessionActivityDuration';
import { SessionUnreadDot } from './SessionUnreadDot';
import { QuietWorkerMarker } from './QuietWorkerMarker';
import { getRuntimeBearerTokenSync } from '@/lib/runtime-auth';
import { getRuntimeApiBaseUrl } from '@/lib/runtime-switch';
import { streamPerfCount } from '@/stores/utils/streamDebug';
import { QuickSessionAction } from './QuickSessionAction';
import { SessionNodeExportDialog } from './SessionNodeExportDialog';
import { SessionRenameDialog } from './SessionRenameDialog';
import { sessionRenameSurface } from './sessionRename';
import { SessionNodeContextMenuContent, SessionNodeDropdownMenuContent } from './SessionNodeContextMenu';
import { holdSessionRowPosition } from './sessionRowAnchor';
import { collectNodeDescendantIds, useSessionExport } from './useSessionExport';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import type { SessionNodeItemProps } from './sessionNodeTypes';
import { areSessionNodeItemPropsEqual } from './sessionNodeComparators';
import { useSessionNodeItemMetadata } from './useSessionNodeItemMetadata';
export type { Folder, SecondaryMeta, SessionNodeItemProps } from './sessionNodeTypes';

function SessionNodeItemComponent(props: SessionNodeItemProps): React.ReactNode {
  streamPerfCount('ui.sidebar_session_node.render');
  const {
    node,
    depth = 0,
    groupDirectory,
    projectId,
    archivedBucket = false,
    pinnedSessionIds,
    hasSessionSearchQuery,
    normalizedSessionSearchQuery,
    editingId,
    setEditingId,
    editTitle,
    setEditTitle,
    handleSaveEdit,
    handleCancelEdit,
    handleSessionSelect,
    handleSessionDoubleClick,
    togglePinnedSession,
    handleShareSession,
    copiedSessionId,
    handleCopyShareUrl,
    handleCopySessionId,
    handleUnshareSession,
    openSidebarMenuKey,
    setOpenSidebarMenuKey,
    renamingFolderId,
    getFoldersForScope,
    getSessionFolderId,
    removeSessionFromFolder,
    addSessionToFolder,
    createFolderAndStartRename,
    handleDeleteSession,
    handleRestoreSession,
    alwaysShowActions,
    allowQuickArchiveAction,
    renderSessionNode,
    secondaryMeta,
    renderContext = 'tree',
    mobileVariant,
    subtreeContainsEditing,
    menuOpenSessionId,
    childRenderExtrasFor,
  } = props;

  const isElectron = React.useMemo(() => canUseElectronDesktopIPC(), []);
  const showQuickArchiveAction = !archivedBucket && allowQuickArchiveAction;
  const suppressNextSelectRef = React.useRef(false);
  const editingIdRef = React.useRef(editingId);
  editingIdRef.current = editingId;
  const pendingRenameRef = React.useRef<{ id: string; title: string } | null>(null);
  const handleSaveEditRef = React.useRef(handleSaveEdit);
  handleSaveEditRef.current = handleSaveEdit;
  const [renameDraft, setRenameDraft] = React.useState(editTitle);
  const renameDraftRef = React.useRef(renameDraft);
  renameDraftRef.current = renameDraft;
  const renameTargetRef = React.useRef<string | null>(null);
  const formRef = React.useRef<HTMLFormElement>(null);
  const renameInDialog = sessionRenameSurface({ mobileVariant }) === 'dialog';

  const menuInstanceKey = `${renderContext}:${archivedBucket ? 'archived' : 'active'}:${node.session.id}`;

  const {
    session,
    sessionDirectory,
    isActive,
    tooltipProjectLabel,
    tooltipBranchLabel,
    isGitRepo,
    subtaskCount,
    agentName,
    selectionScopeKey,
    selectionModeEnabled,
    isRowSelected,
    toggleRowSelected,
    setRowRange,
    isStreaming,
    hasActivityDuration,
    sessionTitle,
    hasChildren,
    isPinnedSession,
    needsAttention,
    sessionCompactUpdatedLabel,
    forkSolid,
    rowBackground,
  } = useSessionNodeItemMetadata({
    node,
    groupDirectory,
    projectId,
    secondaryMeta,
    pinnedSessionIds,
  });

  const {
    exportDialogOpen,
    setExportDialogOpen,
    exportIncludeSubtasks,
    setExportIncludeSubtasks,
    descendantCount,
    handleExportSession,
    doExportSession,
  } = useSessionExport(node, sessionDirectory);

  const [isContextMenuOpen, setIsContextMenuOpen] = React.useState(false);

  const handleOpenMiniChatWindow = React.useCallback(() => {
    if (!sessionDirectory) return;
    void invokeDesktop('desktop_open_session_mini_chat_window', {
      sessionId: session.id,
      directory: sessionDirectory,
      apiBaseUrl: getRuntimeApiBaseUrl(),
      clientToken: getRuntimeBearerTokenSync(),
    }).catch((error) => {
      console.warn('[session-sidebar] failed to open mini chat window', error);
    });
  }, [session.id, sessionDirectory]);

  React.useEffect(() => {
    if (editingId !== session.id || renameInDialog) return;
    const handleDocMouseDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const withinRenameForm = target?.closest?.(`[data-session-rename-form="${CSS.escape(session.id)}"]`);
      if (formRef.current && !withinRenameForm) {
        handleSaveEditRef.current(renameDraftRef.current);
      }
    };
    document.addEventListener('mousedown', handleDocMouseDown);
    return () => document.removeEventListener('mousedown', handleDocMouseDown);
  }, [editingId, renameInDialog, session.id]);

  React.useLayoutEffect(() => {
    if (editingId !== session.id) {
      if (renameTargetRef.current === session.id) {
        renameTargetRef.current = null;
      }
      return;
    }
    if (renameTargetRef.current === session.id) return;
    renameTargetRef.current = session.id;
    setRenameDraft(editTitle);
  }, [editingId, editTitle, session.id]);

  const showUnreadCompleteDot = !isStreaming && needsAttention && !isActive;
  const showActivityDuration = isStreaming && hasActivityDuration;
  const showPinnedMarker = isPinnedSession;
  const pinnedMarkerContent = (
    <Icon name="pushpin" className="h-3 w-3 flex-shrink-0 text-primary" aria-label={'Pinned session'} />
  );
  const leadingIndicators = showPinnedMarker || session.parentID ? (
    <>
      {showPinnedMarker ? (
        <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">{pinnedMarkerContent}</span>
      ) : null}
      {session.parentID && !archivedBucket ? <QuietWorkerMarker sessionId={session.id} /> : null}
    </>
  ) : null;
  const handleMenuOpenChange = (open: boolean) => {
    if (open) {
      setIsContextMenuOpen(false);
    }
    setOpenSidebarMenuKey(open ? menuInstanceKey : null);
  };

  const handleMenuOpenChangeComplete = (open: boolean) => {
    if (!open && pendingRenameRef.current) {
      const { id, title } = pendingRenameRef.current;
      pendingRenameRef.current = null;
      setEditingId(id);
      setEditTitle(title);
    }
  };

  const handleContextMenuOpenChange = (open: boolean) => {
    setIsContextMenuOpen(open);
  };

  const handleQuickArchivePointerDown = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleQuickArchiveMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
  };

  const handleQuickArchiveClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenSidebarMenuKey(null);
    handleDeleteSession(session, { archivedBucket });
  };

  const handleQuickDeleteClick = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setOpenSidebarMenuKey(null);
    handleDeleteSession(session, { archivedBucket, hardDelete: true, skipConfirm: true });
  };

  const handleRowSelect = (event?: React.MouseEvent<HTMLButtonElement>) => {
    if (suppressNextSelectRef.current) {
      suppressNextSelectRef.current = false;
      return;
    }
    if (selectionModeEnabled) {
      event?.preventDefault();
      event?.stopPropagation();
      if (event?.shiftKey) {
        const rows =
          typeof document !== 'undefined'
            ? Array.from(document.querySelectorAll<HTMLElement>('[data-session-row]'))
            : [];
        const orderedIds = rows
          .map((el) => el.getAttribute('data-session-row'))
          .filter((id): id is string => typeof id === 'string' && id.length > 0);
        const currentAnchor = useSessionMultiSelectStore.getState().anchorId;
        const descendantsById = new Map<string, string[]>();
        descendantsById.set(session.id, collectNodeDescendantIds(node));
        setRowRange(currentAnchor, session.id, orderedIds, selectionScopeKey, descendantsById);
        return;
      }
      toggleRowSelected(session.id, selectionScopeKey, collectNodeDescendantIds(node));
      return;
    }
    if (event?.currentTarget) holdSessionRowPosition(event.currentTarget);
    handleSessionSelect(session.id, sessionDirectory);
  };

  const handleRowBackgroundClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    if (target?.closest('button, a, input, [role="menuitem"], [role="menu"]')) return;
    handleRowSelect(event as unknown as React.MouseEvent<HTMLButtonElement>);
  };

  const handleRowMouseDown = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (event.button === 2 || (event.button === 0 && event.ctrlKey && !selectionModeEnabled)) {
      suppressNextSelectRef.current = true;
    }
  };

  const menuItemsProps = {
    session,
    sessionTitle,
    sessionDirectory,
    isPinnedSession,
    archivedBucket,
    isElectron,
    renamingFolderId,
    editingIdRef,
    pendingRenameRef,
    handleCopySessionId,
    togglePinnedSession,
    handleExportSession,
    handleOpenMiniChatWindow,
    handleDeleteSession,
    handleRestoreSession,
  };

  const contextMenuContent = <SessionNodeContextMenuContent {...menuItemsProps} />;

  return (
    <React.Fragment key={session.id}>
        <ContextMenu.Root
          open={isContextMenuOpen}
          onOpenChange={handleContextMenuOpenChange}
          onOpenChangeComplete={handleMenuOpenChangeComplete}
        >
          <ContextMenu.Trigger
            render={
              <div
                data-session-row={session.id}
                data-session-scope={selectionScopeKey ?? ''}
                data-session-archived={archivedBucket ? '1' : '0'}
                data-fork-color={forkSolid ? node.forkColorId : undefined}
                data-global-session={secondaryMeta?.globalSession ? '1' : undefined}
                onClick={handleRowBackgroundClick}
                style={{
                  ...(rowBackground ? { backgroundColor: rowBackground } : undefined),
                }}
                className={cn(
                  'group relative flex min-h-6 min-w-0 flex-1 cursor-pointer items-center rounded-md px-1.5 transition-colors',
                  !rowBackground
                    ? 'hover:bg-interactive-hover'
                    : 'hover:brightness-[1.07] dark:hover:brightness-[1.18]',
                  !rowBackground && isActive && !isRowSelected && 'bg-interactive-selection',
                  !rowBackground && isRowSelected && 'bg-interactive-selection',
                )}
              />
            }
          >
            <div className="flex min-w-0 flex-1 items-center gap-1.5">
              {leadingIndicators}
              {editingId === session.id && !renameInDialog ? (
                <form
                  ref={formRef}
                  data-session-rename-form={session.id}
                  className="flex min-h-8 min-w-0 flex-1 items-center gap-2"
                  onPointerDown={(event) => event.stopPropagation()}
                  onMouseDown={(event) => event.stopPropagation()}
                  onSubmit={(event) => {
                    event.preventDefault();
                    handleSaveEdit(renameDraft);
                  }}
                >
                  <input
                    value={renameDraft}
                    onChange={(event) => setRenameDraft(event.target.value)}
                    className="min-w-0 flex-1 bg-transparent typography-ui-label text-foreground outline-none placeholder:text-muted-foreground"
                    autoFocus
                    placeholder={'Rename'}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Escape') {
                        handleCancelEdit();
                      }
                    }}
                  />
                  <button
                    type="submit"
                    aria-label={'Save session name'}
                    title={'Save session name'}
                    className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  >
                    <Icon name="check" className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelEdit}
                    aria-label={'Cancel renaming session'}
                    title={'Cancel renaming session'}
                    className="shrink-0 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                  >
                    <Icon name="close" className="size-4" />
                  </button>
                </form>
              ) : (
                <button
                  type="button"
                  onMouseDown={handleRowMouseDown}
                  onClick={(event) => handleRowSelect(event)}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    handleSessionDoubleClick(session.id, sessionTitle);
                  }}
                  className="flex min-w-0 flex-1 cursor-pointer flex-col gap-0.5 overflow-hidden text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 text-foreground select-none"
                >
                  <div className="flex w-full items-center min-w-0 flex-1 gap-1.5 overflow-hidden">
                    <div
                      className={cn(
                        'block min-w-0 flex-1 truncate font-normal typography-ui-label',
                        needsAttention ? 'text-foreground' : 'text-foreground/90',
                      )}
                    >
                      {renderHighlightedText(sessionTitle, normalizedSessionSearchQuery)}
                    </div>
                  </div>

                </button>
              )}
            </div>

            {isPinnedSession ? <Icon name="star-fill" className="h-3 w-3 text-primary shrink-0" /> : null}

            <div className="relative ml-1 flex h-6 min-w-6 shrink-0 items-center justify-end">
              <div
                className={cn(
                  'flex items-center justify-end',
                  showQuickArchiveAction && (alwaysShowActions || isContextMenuOpen)
                    ? 'opacity-0'
                    : showQuickArchiveAction
                      ? 'group-hover:opacity-0 group-focus-within:opacity-0'
                      : null,
                )}
              >
                {isStreaming ? (
                  <AgentThinkingLoader
                    variant="inline"
                    text={null}
                    animationType="spinner"
                    speedMs={80}
                    className="text-primary text-xs shrink-0"
                  />
                ) : showUnreadCompleteDot ? (
                  <SessionUnreadDot label={'Session complete'} />
                ) : (
                  <span className="text-[11px] text-muted-foreground/75 whitespace-nowrap">
                    {sessionCompactUpdatedLabel}
                  </span>
                )}
              </div>
              {showQuickArchiveAction ? (
                <div
                  className={cn(
                    'absolute inset-0 flex items-center justify-end',
                    alwaysShowActions || isContextMenuOpen
                      ? 'opacity-100'
                      : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100',
                  )}
                >
                  <QuickSessionAction
                    archiveLabel={'Archive'}
                    deleteLabel={'Delete'}
                    buttonSizeClass="h-6 w-6"
                    iconSizeClass="h-3.5 w-3.5"
                    onPointerDown={handleQuickArchivePointerDown}
                    onMouseDown={handleQuickArchiveMouseDown}
                    onArchive={handleQuickArchiveClick}
                    onDelete={handleQuickDeleteClick}
                  />
                </div>
              ) : null}
            </div>
          </ContextMenu.Trigger>
          {contextMenuContent}
        </ContextMenu.Root>
      {renameInDialog && editingId === session.id ? (
        <SessionRenameDialog
          open
          value={renameDraft}
          onChange={setRenameDraft}
          onSave={() => handleSaveEdit(renameDraft)}
          onCancel={handleCancelEdit}
        />
      ) : null}
      <SessionNodeExportDialog
        open={exportDialogOpen}
        onOpenChange={setExportDialogOpen}
        descendantCount={descendantCount}
        exportIncludeSubtasks={exportIncludeSubtasks}
        setExportIncludeSubtasks={setExportIncludeSubtasks}
        onExport={doExportSession}
      />
    </React.Fragment>
  );
}

export const SessionNodeItem = React.memo(SessionNodeItemComponent, areSessionNodeItemPropsEqual);
