import React from 'react';

const LONG_PRESS_MS = 500;

/**
 * Open state for a row's context menu plus touch handlers that open it after a
 * 500 ms press. Moving or lifting the finger earlier cancels the press.
 */
export const useLongPressMenu = () => {
  const [open, setOpen] = React.useState(false);
  const timerRef = React.useRef<number | null>(null);

  const cancel = React.useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  React.useEffect(() => cancel, [cancel]);

  const onTouchStart = React.useCallback(() => {
    cancel();
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setOpen(true);
    }, LONG_PRESS_MS);
  }, [cancel]);

  const touchHandlers = React.useMemo(() => ({
    onTouchStart,
    onTouchMove: cancel,
    onTouchEnd: cancel,
    onTouchCancel: cancel,
  }), [cancel, onTouchStart]);

  return { open, setOpen, touchHandlers };
};
