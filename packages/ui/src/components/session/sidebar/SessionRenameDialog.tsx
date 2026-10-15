import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

interface SessionRenameDialogProps {
  open: boolean;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void | Promise<void>;
  onCancel: () => void;
}

/**
 * Name field of a session on a phone. Enter or Save saves; Escape, Cancel or a
 * tap outside cancels, so a stray tap never renames. When saving fails the
 * dialog stays open with the draft and says so.
 */
export const SessionRenameDialog = React.memo(function SessionRenameDialog({
  open,
  value,
  onChange,
  onSave,
  onCancel,
}: SessionRenameDialogProps) {
  const [failed, setFailed] = React.useState(false);

  const save = async () => {
    setFailed(false);
    try {
      await onSave();
    } catch {
      setFailed(true);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{'Rename session'}</DialogTitle>
          </DialogHeader>
          <Input
            value={value}
            onChange={(event) => {
              setFailed(false);
              onChange(event.target.value);
            }}
            onFocus={(event) => event.currentTarget.select()}
            aria-label={'Session name'}
            placeholder={'Session name'}
            enterKeyHint="done"
            autoFocus
          />
          {failed ? (
            <p role="alert" className="typography-meta text-[var(--status-error)]">
              {'Could not rename the session. Check the connection and try again.'}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={onCancel}>
              {'Cancel'}
            </Button>
            <Button type="submit" size="sm">
              {'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
});
