import * as React from 'react';
import { getPiSessionStore } from '@/apps/pi-session-store';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { dispatchPermissionControl, parsePermissionStatus, permissionModeCommand, type PermissionControlCommand, type PermissionStatus } from '@/lib/pi/permissions';
import { dropdownTriggerVariants } from '@/components/ui/dropdown-trigger';
import { Checkbox } from '@/components/ui/checkbox';
import { toast } from '@/components/ui';

const PermissionControlFields: React.FC<{ sessionId: string; state: PermissionStatus }> = ({ sessionId, state }) => {
  const [pending, setPending] = React.useState(false);
  const inFlight = React.useRef(false);
  const send = async (command: PermissionControlCommand) => {
    if (inFlight.current) return;
    inFlight.current = true; setPending(true);
    const store = getPiSessionStore(); const runtimeKey = getRuntimeKey();
    try {
      await dispatchPermissionControl(sessionId, command, (target, text) => store.prompt(target, text, 'prompt', undefined, { runtimeKey }));
    } catch {
      toast.error('Could not change permissions. Check the session and connection.');
    } finally {
      inFlight.current = false; setPending(false);
    }
  };
  return (
    <fieldset disabled={pending} aria-busy={pending || undefined} aria-label="Session permissions" className="inline-flex shrink-0 items-center gap-2 whitespace-nowrap typography-micro">
      <label className="inline-flex items-center gap-1.5">
        <span className="text-muted-foreground">Permissions</span>
        <select
          value={state.mode}
          aria-label="Permission mode"
          className={dropdownTriggerVariants({ size: 'default' })}
          onChange={event => { const command = permissionModeCommand(event.target.value); if (command) void send(command); }}
        >
          <option value="ask">Ask</option>
          <option value="auto">Auto</option>
          <option value="yolo">Yolo (unrestricted)</option>
        </select>
      </label>
      <label className="inline-flex items-center gap-1.5">
        <Checkbox checked={state.readOnly} disabled={pending} ariaLabel="Read-only override" onChange={checked => { void send(checked ? '/read-only on' : '/read-only off'); }} />
        <span className="text-muted-foreground">Read-only{state.mode === 'yolo' ? ' (bypassed)' : ''}</span>
      </label>
      {state.mode === 'yolo' && <span className="text-status-warning" role="status">All checks bypassed</span>}
    </fieldset>
  );
};

/** Controls only exist for a live, recognized native status and explicit session. */
export const PermissionsControls: React.FC<{ sessionId: string; text: string }> = ({ sessionId, text }) => {
  const state = parsePermissionStatus(text);
  return state && sessionId ? <PermissionControlFields key={sessionId} sessionId={sessionId} state={state} /> : null;
};
