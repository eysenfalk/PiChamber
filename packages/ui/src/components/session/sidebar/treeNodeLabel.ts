import type { TreeNode } from './workspaceTree';

/** The text a tree row shows and announces. */
export const nodeLabel = (node: TreeNode): string => {
  switch (node.kind) {
    case 'chats':
      return 'Chats';
    case 'other':
      return 'Other folders';
    case 'more':
      return `${node.children.length} more`;
    case 'merged':
      return `${node.children.length} merged`;
    default:
      return node.label;
  }
};
