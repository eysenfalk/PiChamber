import React from 'react';
import { Icon } from '@/components/icon/Icon';

type Props = {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
};

/**
 * Inline name field of a folder row. Enter or the check button saves, Escape
 * or the close button cancels. It does not save on blur, because the context
 * menu that started the rename hands focus back to its row when it closes.
 */
export const TreeFolderRename: React.FC<Props> = ({ value, onChange, onSave, onCancel }) => {
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    const focusInput = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    const frameId = requestAnimationFrame(focusInput);
    const timeoutId = window.setTimeout(focusInput, 0);
    return () => {
      cancelAnimationFrame(frameId);
      window.clearTimeout(timeoutId);
    };
  }, []);

  return (
    <form
      className="flex min-w-0 flex-1 items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            onCancel();
          }
        }}
        aria-label="Folder name"
        placeholder="Folder name"
        className="min-w-0 flex-1 bg-transparent typography-ui-label outline-none placeholder:text-muted-foreground"
      />
      <button
        type="submit"
        aria-label="Save folder name"
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Icon name="check" className="size-4" />
      </button>
      <button
        type="button"
        aria-label="Cancel renaming"
        onClick={onCancel}
        className="shrink-0 text-muted-foreground hover:text-foreground"
      >
        <Icon name="close" className="size-4" />
      </button>
    </form>
  );
};
