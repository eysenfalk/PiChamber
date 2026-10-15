import React from 'react';
import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { WorkerFilterMode } from './workspaceTree';

const OPTIONS: ReadonlyArray<{ mode: WorkerFilterMode; label: string }> = [
  { mode: 'all', label: 'All sessions' },
  { mode: 'hide', label: 'Hide workers' },
  { mode: 'only', label: 'Only workers' },
];

const TRIGGER_LABEL: Record<WorkerFilterMode, string> = {
  all: 'Workers: all sessions',
  hide: 'Workers: hidden',
  only: 'Workers: only workers',
};

type Props = {
  mode: WorkerFilterMode;
  onChange: (mode: WorkerFilterMode) => void;
  /** False until the orchestration registry was read; any filter then shows every session. */
  workersKnown: boolean;
  buttonClassName: string;
  iconClassName: string;
};

/** Header picker for the session list's worker filter (#20). The tree model applies it; this only sets it. */
export const WorkerFilterMenu: React.FC<Props> = ({ mode, onChange, workersKnown, buttonClassName, iconClassName }) => {
  const unknown = mode !== 'all' && !workersKnown;
  const label = unknown ? `${TRIGGER_LABEL[mode]}, workers not loaded yet` : TRIGGER_LABEL[mode];

  return (
    <Tooltip>
      <DropdownMenu>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              data-testid="worker-filter-trigger"
              className={cn(buttonClassName, mode !== 'all' && 'text-primary')}
              aria-label={label}
            >
              <Icon name="robot-2" className={iconClassName} />
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}><p>{label}</p></TooltipContent>
        <DropdownMenuContent align="end" className="min-w-[200px] max-w-[280px]">
          <DropdownMenuRadioGroup
            value={mode}
            onValueChange={(next) => {
              const option = OPTIONS.find((entry) => entry.mode === next);
              if (option && option.mode !== mode) onChange(option.mode);
            }}
          >
            <DropdownMenuLabel className="typography-micro text-muted-foreground">{"Workers in the list"}</DropdownMenuLabel>
            {OPTIONS.map((option) => (
              <DropdownMenuRadioItem key={option.mode} value={option.mode} data-worker-filter={option.mode}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          {unknown ? (
            <p role="status" className="px-2 pb-1 pt-1.5 typography-micro text-muted-foreground">
              {"Workers are not loaded yet, so every session shows."}
            </p>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </Tooltip>
  );
};
