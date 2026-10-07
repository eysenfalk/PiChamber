export type PermissionMode = 'ask' | 'auto' | 'yolo';
export type PermissionControlCommand = `/permissions ${PermissionMode}` | '/read-only on' | '/read-only off';
export interface PermissionStatus { mode: PermissionMode; readOnly: boolean }

/** Explicit native extension v1 wire format. Unknown/legacy text is not authority. */
export function parsePermissionStatus(text: string): PermissionStatus | null {
  const match = /^permissions\/v1 mode=(ask|auto|yolo) readOnly=(on|off)$/.exec(text);
  return match ? { mode: match[1] as PermissionMode, readOnly: match[2] === 'on' } : null;
}

export function permissionModeCommand(mode: string): PermissionControlCommand | null {
  return ['ask', 'auto', 'yolo'].includes(mode) ? `/permissions ${mode as PermissionMode}` : null;
}

/** UI adapter: capture the target, never change state optimistically. */
export async function dispatchPermissionControl(sessionId: string, command: PermissionControlCommand, prompt: (target: string, text: string) => Promise<unknown>): Promise<void> {
  if (!sessionId || !/^\/(permissions (ask|auto|yolo)|read-only (on|off))$/.test(command)) throw new Error('Invalid permission control target or command.');
  await prompt(sessionId, command);
}
