import * as React from 'react';

import type { PiExtensionDialogPayload } from '@/lib/pi/protocol';
import { stripAnsi } from '@/lib/pi/ansi';
import { Button } from '@/components/ui/button';
import type { DialogAnswer } from './extensionDialogResponse';

/**
 * The answer controls of one pi extension dialog (select, confirm, input,
 * editor, form) without a frame. The caller owns the frame and the title.
 */

const CancelButton: React.FC<{ onClick: () => void }> = ({ onClick }) => (
  <Button variant="ghost" size="sm" onClick={onClick}>Cancel</Button>
);

export const ExtensionDialogBody: React.FC<{
  request: PiExtensionDialogPayload;
  onRespond: (answer: DialogAnswer) => void;
  /** The modal overlay focuses its text field; an inline list must not steal focus. */
  autoFocus?: boolean;
}> = ({ request, onRespond, autoFocus = true }) => {
  const cancel = React.useCallback(() => {
    onRespond({ cancelled: true });
  }, [onRespond]);

  const [value, setValue] = React.useState(request.method === 'editor' ? (request.prefill ?? '') : '');

  const submitValue = () => {
    onRespond({ value });
  };

  switch (request.method) {
    case 'select':
      return (
        <>
          {request.message && <p className="mb-2 text-sm text-muted-foreground">{stripAnsi(request.message)}</p>}
          <div className="flex flex-col gap-1.5">
            {(request.options ?? []).map((option) => (
              <Button
                key={option}
                variant="outline"
                size="sm"
                className="justify-start"
                onClick={() => onRespond({ value: option })}
              >
                {/* Display-only strip: the daemon still receives the original option value. */}
                {stripAnsi(option)}
              </Button>
            ))}
          </div>
          <div className="mt-3 flex justify-end">
            <CancelButton onClick={cancel} />
          </div>
        </>
      );
    case 'confirm':
      return (
        <>
          {request.message && <p className="text-sm text-muted-foreground">{stripAnsi(request.message)}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <CancelButton onClick={cancel} />
            <Button
              variant="default"
              size="sm"
              onClick={() => onRespond({ confirmed: true })}
            >
              Confirm
            </Button>
          </div>
        </>
      );
    case 'input':
    case 'editor':
      return (
        <>
          {request.message && <p className="mb-2 text-sm text-muted-foreground">{stripAnsi(request.message)}</p>}
          <textarea
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder={request.placeholder ? stripAnsi(request.placeholder) : ''}
            aria-label={stripAnsi(request.title)}
            rows={request.method === 'editor' ? 6 : 2}
            className="w-full resize-y rounded-md border bg-transparent p-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-focus"
            onKeyDown={(event) => {
              // Enter submits single-line inputs; editors keep newlines and
              // submit through the button or Cmd/Ctrl+Enter.
              if (event.key === 'Enter' && !event.shiftKey && request.method === 'input') {
                event.preventDefault();
                submitValue();
              }
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && request.method === 'editor') {
                event.preventDefault();
                submitValue();
              }
            }}
            autoFocus={autoFocus}
          />
          <div className="mt-3 flex justify-end gap-2">
            <CancelButton onClick={cancel} />
            <Button
              variant="default"
              size="sm"
              onClick={submitValue}
              disabled={request.method === 'input' && value.length === 0}
            >
              Submit
            </Button>
          </div>
        </>
      );
    case 'form': {
      const initial: Record<string, string> = {};
      for (const field of request.fields ?? []) {
        if (field.type === 'checkbox') initial[field.id] = field.initial === 'true' ? 'true' : 'false';
        else if (field.initial !== undefined) initial[field.id] = field.initial;
        else if (field.type === 'select' && field.options?.[0] !== undefined) initial[field.id] = field.options[0];
        else initial[field.id] = '';
      }
      return (
        <ExtensionFormBody
          request={request}
          initialValues={initial}
          onCancel={cancel}
          onSubmit={(values) => onRespond({ values })}
        />
      );
    }
    default:
      return null;
  }
};

const ExtensionFormBody: React.FC<{
  request: PiExtensionDialogPayload;
  initialValues: Record<string, string>;
  onCancel: () => void;
  onSubmit: (values: Record<string, string>) => void;
}> = ({ request, initialValues, onCancel, onSubmit }) => {
  const [values, setValues] = React.useState(initialValues);
  const [touchedSubmit, setTouchedSubmit] = React.useState(false);

  const missingRequired = (request.fields ?? [])
    .filter((field) => field.required && (values[field.id] ?? '').length === 0);
  const blocked = touchedSubmit && missingRequired.length > 0;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setTouchedSubmit(true);
        if (missingRequired.length > 0) return;
        onSubmit({ ...values });
      }}
    >
      {request.message && <p className="mb-2 text-sm text-muted-foreground">{stripAnsi(request.message)}</p>}
      <div className="flex max-h-72 flex-col gap-3 overflow-y-auto">
        {(request.fields ?? []).map((field) => {
          const invalid = blocked && field.required && (values[field.id] ?? '').length === 0;
          const value = values[field.id] ?? '';
          const setValue = (next: string) => setValues((previous) => ({ ...previous, [field.id]: next }));
          const inputClass = 'w-full rounded-md border bg-transparent p-2 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-interactive-focus';
          if (field.type === 'checkbox') {
            return (
              <label key={field.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={value === 'true'}
                  onChange={(event) => setValue(event.target.checked ? 'true' : 'false')}
                  className="size-4"
                />
                {/* Display-only strip: the daemon still receives the original value. */}
                {stripAnsi(field.label)}
              </label>
            );
          }
          return (
            <label key={field.id} className="flex flex-col gap-1 text-sm">
              <span>
                {stripAnsi(field.label)}
                {field.required && <span aria-hidden="true" className="text-status-error"> *</span>}
              </span>
              {field.type === 'textarea' ? (
                <textarea
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={field.placeholder ? stripAnsi(field.placeholder) : ''}
                  rows={3}
                  aria-invalid={invalid || undefined}
                  className={inputClass}
                />
              ) : field.type === 'number' ? (
                <input
                  type="number"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={field.placeholder ? stripAnsi(field.placeholder) : ''}
                  min={'min' in field && typeof field.min === 'number' ? field.min : undefined}
                  max={'max' in field && typeof field.max === 'number' ? field.max : undefined}
                  aria-invalid={invalid || undefined}
                  className={inputClass}
                />
              ) : field.type === 'select' ? (
                <select
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  aria-invalid={invalid || undefined}
                  className={inputClass}
                >
                  {(field.options ?? []).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                  placeholder={field.placeholder ? stripAnsi(field.placeholder) : ''}
                  aria-invalid={invalid || undefined}
                  className={inputClass}
                />
              )}
            </label>
          );
        })}
      </div>
      {blocked && (
        <p role="alert" className="mt-2 text-xs text-status-error">
          Fill in all required fields before submitting.
        </p>
      )}
      <div className="mt-3 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
        <Button type="submit" variant="default" size="sm">Submit</Button>
      </div>
    </form>
  );
};
