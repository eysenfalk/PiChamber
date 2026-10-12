/* eslint-disable */
import React from 'react';
import type { ProjectSession } from '../workspaceTree';
import type { MainTab } from '@/stores/useUIStore';
import { useUIStore } from '@/stores/useUIStore';
import { useSessionUIStore } from '@/sync/session-ui-store';

type Args = {
  projects: ReadonlyArray<{ id: string; normalizedPath: string }>;
  /** Every session below each project, from the workspace tree. */
  projectSessions: ReadonlyMap<string, ProjectSession[]>;
  activeProjectId: string | null;
  activeSessionByProject: Map<string, string>;
  setActiveSessionByProject: React.Dispatch<React.SetStateAction<Map<string, string>>>;
  currentSessionId: string | null;
  handleSessionSelect: (sessionId: string, sessionDirectory: string | null, options?: { keepPanelOpen?: boolean }) => void;
  newSessionDraftOpen: boolean;
  mobileVariant: boolean;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null }) => void;
  setActiveMainTab: (tab: MainTab) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
};

export const useProjectSessionSelection = (args: Args): void => {
  const {
    projects,
    projectSessions,
    activeProjectId,
    activeSessionByProject,
    setActiveSessionByProject,
    currentSessionId,
    handleSessionSelect,
    newSessionDraftOpen,
    mobileVariant,
    openNewSessionDraft,
    setActiveMainTab,
    setSessionSwitcherOpen,
  } = args;

  const projectSessionMeta = React.useMemo(() => {
    const metaByProject = new Map<string, Map<string, { directory: string | null }>>();
    const firstSessionByProject = new Map<string, ProjectSession>();
    projectSessions.forEach((sessions, projectId) => {
      if (sessions.length === 0) return;
      metaByProject.set(projectId, new Map(sessions.map((session) => [session.id, { directory: session.directory }])));
      firstSessionByProject.set(projectId, sessions[0]);
    });
    return { metaByProject, firstSessionByProject };
  }, [projectSessions]);

  const previousActiveProjectRef = React.useRef<string | null>(null);

  React.useLayoutEffect(() => {
    if (!activeProjectId) {
      return;
    }

    if (newSessionDraftOpen) {
      previousActiveProjectRef.current = activeProjectId;
      return;
    }

    if (previousActiveProjectRef.current === activeProjectId) {
      return;
    }

    const project = projects.find((item) => item.id === activeProjectId);
    if (!project) {
      return;
    }
    previousActiveProjectRef.current = activeProjectId;
    const projectMap = projectSessionMeta.metaByProject.get(activeProjectId);

    if (currentSessionId && projectMap && projectMap.has(currentSessionId)) {
      setActiveSessionByProject((prev) => {
        if (prev.get(activeProjectId) === currentSessionId) {
          return prev;
        }
        const next = new Map(prev);
        next.set(activeProjectId, currentSessionId);
        return next;
      });
      return;
    }

    const isSessionOfAnotherProject = currentSessionId
      ? Array.from(projectSessionMeta.metaByProject.entries()).some(
          ([projId, map]) => projId !== activeProjectId && map.has(currentSessionId),
        )
      : false;

    // Path A' — currentSessionId is set, belongs to this project or is not indexed
    // under any other project (e.g. worktree data not yet loaded into projectMap).
    // Preserve user's explicit selection. For sessions belonging to another project,
    // continue to select the target project's session below.
    if (currentSessionId && projectMap && !isSessionOfAnotherProject) {
      return;
    }

    if (!projectMap || projectMap.size === 0) {
      setActiveMainTab('chat');
      if (mobileVariant) {
        setSessionSwitcherOpen(false);
      }
      openNewSessionDraft({
        selectedProjectId: project.id,
        directoryOverride: project.normalizedPath,
      });
      return;
    }

    const rememberedSessionId = activeSessionByProject.get(activeProjectId);
    const remembered = rememberedSessionId && projectMap.has(rememberedSessionId)
      ? rememberedSessionId
      : null;
    const fallback = projectSessionMeta.firstSessionByProject.get(activeProjectId)?.id ?? null;
    const targetSessionId = remembered ?? fallback;
    if (!targetSessionId || targetSessionId === currentSessionId) {
      return;
    }
    const targetDirectory = projectMap.get(targetSessionId)?.directory ?? null;
    handleSessionSelect(targetSessionId, targetDirectory, { keepPanelOpen: true });
  }, [
    activeProjectId,
    activeSessionByProject,
    currentSessionId,
    handleSessionSelect,
    newSessionDraftOpen,
    mobileVariant,
    openNewSessionDraft,
    projects,
    projectSessionMeta,
    setActiveMainTab,
    setSessionSwitcherOpen,
    setActiveSessionByProject,
  ]);

  React.useEffect(() => {
    if (!activeProjectId || !currentSessionId) {
      return;
    }
    const projectMap = projectSessionMeta.metaByProject.get(activeProjectId);
    if (!projectMap || !projectMap.has(currentSessionId)) {
      return;
    }
    setActiveSessionByProject((prev) => {
      if (prev.get(activeProjectId) === currentSessionId) {
        return prev;
      }
      const next = new Map(prev);
      next.set(activeProjectId, currentSessionId);
      return next;
    });
  }, [activeProjectId, currentSessionId, projectSessionMeta, setActiveSessionByProject]);

};

type ProjectSessionSelectionEffectProps = Omit<
  Args,
  'activeSessionByProject' | 'setActiveSessionByProject' | 'currentSessionId' | 'newSessionDraftOpen'
> & {
  initialActiveSessionByProject: Map<string, string>;
  persistActiveSessionByProject: (value: Map<string, string>) => void;
};

export const ProjectSessionSelectionEffect: React.FC<ProjectSessionSelectionEffectProps> = ({
  initialActiveSessionByProject,
  persistActiveSessionByProject,
  ...args
}) => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const newSessionDraftOpen = useSessionUIStore((state) => Boolean(state.newSessionDraft?.open));
  const [activeSessionByProject, setActiveSessionByProject] = React.useState(
    () => new Map(initialActiveSessionByProject),
  );
  useProjectSessionSelection({
    ...args,
    activeSessionByProject,
    setActiveSessionByProject,
    currentSessionId,
    newSessionDraftOpen,
  });
  React.useEffect(() => {
    persistActiveSessionByProject(activeSessionByProject);
  }, [activeSessionByProject, persistActiveSessionByProject]);
  return null;
};
