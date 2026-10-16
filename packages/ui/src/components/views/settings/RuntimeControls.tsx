import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { reloadPiRuntime, restartPiRuntime } from '@/lib/pi/runtime-control';
import { cn } from '@/lib/utils';
import { RestartConfirmDialog } from './RestartConfirmDialog';
import {
  initialRuntimeControlsState,
  RELOAD_PI_LABEL,
  RESTART_PICHAMBER_LABEL,
  runtimeControlsReducer,
} from './runtimeControlsState';

const RELOAD_PI_HINT = 'Reload Pi: extensions, skills, prompts and settings in every loaded session';
const RESTART_PICHAMBER_HINT = 'Restart PiChamber: server and session daemon';



type RuntimeControlButtonProps = {
  label: string;
  hint: string;
  icon: 'refresh' | 'restart';
  busy: boolean;
  onClick: () => void;
  className?: string;
};

function RuntimeControlButton({ label, hint, icon, busy, onClick, className }: RuntimeControlButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={busy}
          aria-label={label}
          aria-busy={busy || undefined}
          className={cn(
            'inline-flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors',
            'hover:bg-interactive-hover hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
            'disabled:pointer-events-none disabled:opacity-60',
            className,
          )}
        >
          <Icon name={busy ? 'loader-4' : icon} className={cn('size-4', busy && 'animate-spin')} />
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{hint}</p>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Reload Pi (first) and Restart PiChamber, placed next to the settings search.
 * Reload acts at once; Restart always confirms and lists working sessions.
 */
export function RuntimeControlButtons({ buttonClassName }: { buttonClassName?: string }): React.ReactNode {
  const [state, dispatch] = React.useReducer(runtimeControlsReducer, initialRuntimeControlsState);
  const mountedRef = React.useRef(true);
  React.useEffect(() => () => { mountedRef.current = false; }, []);

  const reload = React.useCallback(async () => {
    dispatch({ type: 'reload-started' });
    try {
      await reloadPiRuntime();
    } finally {
      if (mountedRef.current) dispatch({ type: 'reload-finished' });
    }
  }, []);

  const restart = React.useCallback(async () => {
    dispatch({ type: 'restart-confirmed' });
    try {
      await restartPiRuntime();
    } finally {
      if (mountedRef.current) dispatch({ type: 'restart-finished' });
    }
  }, []);

  return (
    <>
      <RuntimeControlButton
        label={RELOAD_PI_LABEL}
        hint={RELOAD_PI_HINT}
        icon="refresh"
        busy={state.reloading}
        onClick={() => { void reload(); }}
        className={buttonClassName}
      />
      <RuntimeControlButton
        label={RESTART_PICHAMBER_LABEL}
        hint={RESTART_PICHAMBER_HINT}
        icon="restart"
        busy={state.restarting}
        onClick={() => dispatch({ type: 'restart-requested' })}
        className={buttonClassName}
      />
      <RestartConfirmDialog
        open={state.confirmOpen}
        onCancel={() => dispatch({ type: 'restart-cancelled' })}
        onConfirm={() => { void restart(); }}
      />
    </>
  );
}
