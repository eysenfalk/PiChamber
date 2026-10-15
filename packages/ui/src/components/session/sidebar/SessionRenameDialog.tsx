import React from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export interface SessionRenameDialogProps {
  open: boolean;
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/**
 * Name field of a session on a phone. Enter or Save saves; Escape, Cancel or a
 * tap outside cancels, so a stray tap never renames.
 */
export const SessionRenameDialog = React.memo(function SessionRenameDialog({
  open,
  value,
  onChange,
  onSave,
  onCancel,
}: SessionRenameDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent showCloseButton={false} className="max-w-sm gap-5">
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            onSave();
          }}
        >
          <DialogHeader>
            <DialogTitle>{'Rename session'}</DialogTitle>
          </DialogHeader>
          <Input
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onFocus={(event) => event.currentTarget.select()}
            aria-label={'Session name'}
            placeholder={'Session name'}
            enterKeyHint="done"
            autoFocus
          />
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
