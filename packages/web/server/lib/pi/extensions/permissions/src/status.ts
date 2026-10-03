import type { PermissionMode } from './types.ts';

/** Display-safe v1 wire contract consumed by PiChamber, not policy authority. */
export function permissionStatus(mode: PermissionMode, readOnly: boolean, error?: string): string {
  if (error && mode !== 'yolo') return 'permissions: unavailable (invalid configuration)';
  return `permissions/v1 mode=${mode} readOnly=${readOnly ? 'on' : 'off'}`;
}
