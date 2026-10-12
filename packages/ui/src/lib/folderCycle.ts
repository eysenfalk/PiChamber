import { buildDraftTargetProjects, GLOBAL_PROJECT_ID } from '@/components/chat/composer/state/draftTargetProjects';
import { normalizePath } from '@/lib/pathNormalization';
import { resolveProjectForSessionDirectory } from '@/lib/projectResolution';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useSidebarSpaceStore } from '@/stores/useSidebarSpaceStore';
import { buildAvailableWorktreesByProject, useWorktreeStore } from '@/stores/useWorktreeStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

/**
 * Next id in a wrapping cycle. Returns null when there is nothing to cycle
 * (zero or one entry). An unknown current id starts from the first entry.
 */
export function getNextCycleId(orderedIds: readonly string[], currentId: string | null): string | null {
  if (orderedIds.length <= 1) {
    return null;
  }
  const index = currentId ? orderedIds.indexOf(currentId) : -1;
  return orderedIds[(index + 1) % orderedIds.length] ?? null;
}

/**
 * Global folder switch (Ctrl+Shift+F, or the application menu): moves the
 * sidebar tree selection to the next project in sidebar order and points the
 * active project at it, like clicking the project row. Opens no session.
 * Wraps; never includes `__home__`. The optional direction lets the
 * application menu move backward while the keyboard shortcut moves forward.
 *
 * Returns true when it acted, false when there was nothing to cycle.
 */
export function cycleSessionFolder(direction: 1 | -1 = 1): boolean {
  const projectsState = useProjectsStore.getState();
  const projects = projectsState.projects;
  if (projects.length <= 1) {
    return false;
  }

  const orderedIds = projects.map((project) => project.id);
  let currentId = projectsState.activeProjectId;
  if (!currentId || !orderedIds.includes(currentId)) {
    const currentDir = normalizePath(useDirectoryStore.getState().currentDirectory ?? null);
    currentId = resolveProjectForSessionDirectory(
      projects,
      buildAvailableWorktreesByProject(projects, useWorktreeStore.getState()),
      currentDir,
    )?.id ?? null;
  }

  const nextId = direction === 1
    ? getNextCycleId(orderedIds, currentId)
    : orderedIds[
      ((currentId ? orderedIds.indexOf(currentId) : 0) - 1 + orderedIds.length) % orderedIds.length
    ] ?? null;
  if (!nextId) {
    return false;
  }

  projectsState.setActiveProjectIdOnly(nextId);
  useSidebarSpaceStore.getState().select(`p:${nextId}`);
  return true;
}

/**
 * Draft folder change (Ctrl+Shift+D): same effect as picking another folder
 * in the composer's draft target selector. Draft-only; no-ops unless a new
 * session draft is open. Cycles the draft picker order (global `__home__`
 * first, then projects and worktrees in registration order), clearing branch
 * and worktree intents like a manual picker change.
 *
 * Returns true when it acted, false when there was nothing to cycle.
 */
export function cycleDraftFolder(): boolean {
  const sessionUI = useSessionUIStore.getState();
  const draft = sessionUI.newSessionDraft;
  if (!draft?.open) {
    return false;
  }

  const projectsState = useProjectsStore.getState();
  const projects = projectsState.projects;
  const targets = buildDraftTargetProjects(
    projects,
    buildAvailableWorktreesByProject(projects, useWorktreeStore.getState()),
  );
  if (targets.length <= 1) {
    return false;
  }

  const explicitDirectory = normalizePath(draft.directoryOverride ?? null);
  const current = draft.selectedProjectId
    ? targets.find((target) => (
      target.ownerProjectId === draft.selectedProjectId
      && (!explicitDirectory || normalizePath(target.path) === explicitDirectory)
    ))
      ?? targets.find((target) => target.id === draft.selectedProjectId)
      ?? (explicitDirectory
        ? targets.find((target) => normalizePath(target.path) === explicitDirectory) ?? null
        : null)
    : explicitDirectory
      ? targets.find((target) => normalizePath(target.path) === explicitDirectory) ?? null
      : null;

  const nextId = getNextCycleId(
    targets.map((target) => target.id),
    current?.id ?? null,
  );
  const next = targets.find((target) => target.id === nextId);
  const nextDirectory = normalizePath(next?.path ?? null);
  if (!next || !nextDirectory) {
    return false;
  }

  if (next.ownerProjectId === GLOBAL_PROJECT_ID) {
    sessionUI.setNewSessionDraftTarget({
      projectId: GLOBAL_PROJECT_ID,
      directoryOverride: nextDirectory,
      branchIntent: null,
      worktreeIntent: null,
    });
    return true;
  }

  if (projectsState.activeProjectId !== next.ownerProjectId) {
    projectsState.setActiveProjectIdOnly(next.ownerProjectId);
    useSidebarSpaceStore.getState().select(`p:${next.ownerProjectId}`);
  }
  sessionUI.setNewSessionDraftTarget({
    projectId: next.ownerProjectId,
    directoryOverride: nextDirectory,
    branchIntent: null,
    worktreeIntent: null,
  });
  return true;
}
