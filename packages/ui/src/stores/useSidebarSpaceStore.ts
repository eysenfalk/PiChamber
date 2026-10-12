import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

interface SidebarSpaceStore {
  /**
   * Node selected in the sidebar workspace tree (a `NodeKey` from
   * `components/session/sidebar/workspaceTree.ts`, for example `p:<id>`,
   * `w:<dir>` or `chats`). It is where "New session" lands and what the folder
   * cycle shortcuts move. It filters nothing and opens no session.
   */
  selectedNodeKey: string | null;
  select: (key: string | null) => void;
}

export const useSidebarSpaceStore = create<SidebarSpaceStore>()(
  devtools(
    (set) => ({
      selectedNodeKey: null,
      select: (key) => {
        set({ selectedNodeKey: key });
      },
    }),
    { name: 'sidebar-space' },
  ),
);
