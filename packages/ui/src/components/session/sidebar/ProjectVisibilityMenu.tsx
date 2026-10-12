import React from 'react';
import { Icon } from '@/components/icon/Icon';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

export type ProjectVisibilityEntry = { id: string; label: string };

type Props = {
  /** Chats first, then the projects in sidebar order. */
  entries: readonly ProjectVisibilityEntry[];
  hidden: ReadonlySet<string>;
  onSetHidden: (id: string, hidden: boolean) => void;
  onShowAll: () => void;
  onHideAll: () => void;
  buttonClassName: string;
  iconClassName: string;
};

/**
 * Checklist of the tree roots. Unchecking hides a root from the tree; the quick
 * search still finds sessions inside it. The menu stays open while toggling.
 */
export const ProjectVisibilityMenu: React.FC<Props> = ({
  entries,
  hidden,
  onSetHidden,
  onShowAll,
  onHideAll,
  buttonClassName,
  iconClassName,
}) => {
  const hiddenCount = entries.reduce((count, entry) => count + (hidden.has(entry.id) ? 1 : 0), 0);
  const label = hiddenCount > 0 ? `Shown projects, ${hiddenCount} hidden` : 'Shown projects';

  return (
    <Tooltip>
      <DropdownMenu>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              className={cn(buttonClassName, 'relative', hiddenCount > 0 && 'text-primary')}
              aria-label={label}
            >
              <Icon name={hiddenCount > 0 ? 'eye-off' : 'eye'} className={iconClassName} />
              {hiddenCount > 0 ? (
                <span aria-hidden className="absolute -right-0.5 -top-0.5 min-w-3 rounded-full bg-primary px-0.5 text-center text-[9px] leading-3 text-primary-foreground tabular-nums">
                  {hiddenCount}
                </span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="bottom" sideOffset={4}><p>{label}</p></TooltipContent>
        <DropdownMenuContent align="end" className="max-h-[min(24rem,70vh)] min-w-[200px] max-w-[280px] overflow-y-auto">
        <DropdownMenuLabel className="typography-micro text-muted-foreground">{"Show in sidebar"}</DropdownMenuLabel>
        {entries.map((entry) => (
          <DropdownMenuCheckboxItem
            key={entry.id}
            data-visibility-id={entry.id}
            checked={!hidden.has(entry.id)}
            onCheckedChange={(checked) => onSetHidden(entry.id, !checked)}
          >
            <span className="min-w-0 truncate">{entry.label}</span>
          </DropdownMenuCheckboxItem>
        ))}
        <DropdownMenuSeparator />
        <div className="flex gap-1">
          <DropdownMenuItem closeOnClick={false} className="flex-1 justify-center" disabled={hiddenCount === 0} onClick={onShowAll}>
            {"Show all"}
          </DropdownMenuItem>
          <DropdownMenuItem closeOnClick={false} className="flex-1 justify-center" disabled={hiddenCount === entries.length} onClick={onHideAll}>
            {"Hide all"}
          </DropdownMenuItem>
        </div>
        </DropdownMenuContent>
      </DropdownMenu>
    </Tooltip>
  );
};
