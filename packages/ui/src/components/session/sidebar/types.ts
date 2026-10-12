import type { GitWorktree } from '@/lib/api/types';
import type { Session } from '@/lib/chat/types';

export type SessionNode = {
  session: Session;
  children: SessionNode[];
  worktree?: GitWorktree | null;
  /** Session id used to assign a stable color; null when unrelated to a fork. */
  forkColorId?: string | null;
};
