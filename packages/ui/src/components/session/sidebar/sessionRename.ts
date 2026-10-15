/**
 * Where a session row is renamed. The dedicated mobile drawer indents rows by
 * their depth and keeps check, cross and age beside the field, which leaves it
 * about 55 px; there the name is edited in a dialog instead.
 */
export const sessionRenameSurface = ({ mobileVariant }: { mobileVariant: boolean }): 'inline' | 'dialog' =>
  mobileVariant ? 'dialog' : 'inline';
