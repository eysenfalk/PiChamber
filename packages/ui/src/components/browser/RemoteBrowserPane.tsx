import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui';
import { normalizeBrowserUrl } from '@/components/layout/context-panel/browserScripts';
import {
  REMOTE_BROWSER_KEYS,
  RemoteBrowserClient,
  fetchRemoteBrowserAvailability,
  type RemoteBrowserConnection,
  type RemoteBrowserPageState,
} from '@/lib/browser/remoteBrowserClient';
import { isCapacitorApp } from '@/lib/platform';
import { subscribeRuntimeEndpointChanged, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { cn } from '@/lib/utils';

/** Pointer travel in CSS pixels before a touch becomes a scroll instead of a tap. */
const TAP_SLOP_PX = 8;
const MAX_COORDINATE = 16384;
const MAX_SCROLL_DELTA = 10000;
const MAX_TEXT_CHUNK = 2000;

type Availability =
  | { status: 'checking' }
  | { status: 'available' }
  | { status: 'desktop-app-required' }
  | { status: 'error'; message: string };

type PointerTrack = { id: number; startX: number; startY: number; lastX: number; lastY: number; scrolling: boolean };

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)));

const EMPTY_STATE: RemoteBrowserPageState = { url: '', title: '', canGoBack: false, canGoForward: false, loading: false };

const isDocumentVisible = (): boolean => typeof document === 'undefined' || document.visibilityState !== 'hidden';

/**
 * Whether the app is in the foreground: the document visibility, and in the
 * native shell also Capacitor's `appStateChange` (the same two signals the
 * native chrome uses for pause and resume).
 */
const useAppForeground = (): boolean => {
  const [documentVisible, setDocumentVisible] = React.useState(isDocumentVisible);
  const [nativeActive, setNativeActive] = React.useState(true);

  React.useEffect(() => {
    if (typeof document === 'undefined') return;
    const update = () => setDocumentVisible(isDocumentVisible());
    update();
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  React.useEffect(() => {
    if (!isCapacitorApp()) return;
    let disposed = false;
    let remove: (() => void) | null = null;
    void import('@capacitor/app').then(async ({ App }) => {
      if (disposed) return;
      const handle = await App.addListener('appStateChange', ({ isActive }) => setNativeActive(isActive === true));
      if (disposed) {
        void handle.remove();
        return;
      }
      remove = () => void handle.remove();
    }).catch(() => undefined);
    return () => {
      disposed = true;
      remove?.();
    };
  }, []);

  return documentVisible && nativeActive;
};

type RemoteBrowserPaneProps = {
  /** Address to open once the remote page is connected. */
  initialUrl?: string;
  /** The socket is open only while the pane is visible and the app is in the foreground. */
  visible: boolean;
  /** `touch` uses 36px toolbar targets (mobile drawer); `compact` matches the desktop context panel toolbar. */
  density?: 'touch' | 'compact';
};

/**
 * Remote view of the browser that runs in the desktop app on the laptop
 * (#163, ADR 0012). Frames arrive as JPEG and are drawn on a canvas; taps,
 * drags, wheel and the hidden keyboard input go back as page input.
 */
export const RemoteBrowserPane: React.FC<RemoteBrowserPaneProps> = ({ initialUrl = '', visible, density = 'compact' }) => {
  const [availability, setAvailability] = React.useState<Availability>({ status: 'checking' });
  const [connection, setConnection] = React.useState<RemoteBrowserConnection>('stopped');
  const [pageState, setPageState] = React.useState<RemoteBrowserPageState>(EMPTY_STATE);
  const [hasFrame, setHasFrame] = React.useState(false);
  const [addressDraft, setAddressDraft] = React.useState<string | null>(null);
  const [statusAttempt, setStatusAttempt] = React.useState(0);
  const [keyboardOpen, setKeyboardOpen] = React.useState(false);
  const [endpointEpoch, setEndpointEpoch] = React.useState(0);
  const foreground = useAppForeground();
  const active = visible && foreground;

  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const stageRef = React.useRef<HTMLDivElement | null>(null);
  const inputRef = React.useRef<HTMLTextAreaElement | null>(null);
  const clientRef = React.useRef<RemoteBrowserClient | null>(null);
  const viewportRef = React.useRef<{ width: number; height: number } | null>(null);
  const hasFrameRef = React.useRef(false);
  const pendingUrlRef = React.useRef(initialUrl.trim());
  const pointerRef = React.useRef<PointerTrack | null>(null);
  const backspaceSentRef = React.useRef(false);
  const scrollRef = React.useRef<{ x: number; y: number; deltaX: number; deltaY: number; frame: number | null }>({ x: 0, y: 0, deltaX: 0, deltaY: 0, frame: null });

  const isAvailable = availability.status === 'available';

  // A runtime endpoint switch (LAN/relay) releases the viewer before the switch;
  // afterwards the status is read again at the new endpoint, which starts one new client.
  React.useEffect(() => {
    const unsubscribeWillChange = subscribeRuntimeEndpointWillChange(() => {
      clientRef.current?.stop();
      clientRef.current = null;
    });
    const unsubscribeChanged = subscribeRuntimeEndpointChanged(() => {
      setAvailability({ status: 'checking' });
      setEndpointEpoch((value) => value + 1);
    });
    return () => {
      unsubscribeWillChange();
      unsubscribeChanged();
    };
  }, []);

  // Status is read each time the pane becomes active until the desktop app is found.
  React.useEffect(() => {
    if (!active || isAvailable) return;
    let cancelled = false;
    setAvailability({ status: 'checking' });
    fetchRemoteBrowserAvailability()
      .then((result) => { if (!cancelled) setAvailability({ status: result }); })
      .catch((error: unknown) => {
        if (!cancelled) setAvailability({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      });
    return () => { cancelled = true; };
  }, [active, isAvailable, statusAttempt, endpointEpoch]);

  const drawFrame = React.useCallback(async (jpeg: ArrayBuffer) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const bitmap = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' }));
    try {
      if (canvas.width !== bitmap.width) canvas.width = bitmap.width;
      if (canvas.height !== bitmap.height) canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    } finally {
      bitmap.close();
    }
    if (!hasFrameRef.current) {
      hasFrameRef.current = true;
      setHasFrame(true);
    }
  }, []);

  React.useEffect(() => {
    if (!active || !isAvailable) return;
    const client = new RemoteBrowserClient({
      onConnection: (next) => {
        setConnection(next);
        if (next === 'open' && pendingUrlRef.current) {
          const url = normalizeBrowserUrl(pendingUrlRef.current);
          pendingUrlRef.current = '';
          if (url !== 'about:blank') client.send({ type: 'navigate', url });
        }
      },
      onFrame: drawFrame,
      onPageState: setPageState,
      onNotice: (notice) => {
        if (notice === 'download-blocked') toast.info("Downloads are blocked in the remote browser.");
        else toast.error("The page in the remote browser crashed. Reload to try again.");
      },
    });
    clientRef.current = client;
    if (viewportRef.current) client.setViewport(viewportRef.current.width, viewportRef.current.height);
    client.start();
    const pending = scrollRef.current;
    return () => {
      client.stop();
      if (clientRef.current === client) clientRef.current = null;
      if (pending.frame !== null) cancelAnimationFrame(pending.frame);
      pending.frame = null;
      pending.deltaX = 0;
      pending.deltaY = 0;
    };
  }, [active, isAvailable, drawFrame, endpointEpoch]);

  // The page viewport follows the stage size in CSS pixels.
  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.floor(entry.contentRect.width);
      const height = Math.floor(entry.contentRect.height);
      if (width <= 0 || height <= 0) return;
      viewportRef.current = { width, height };
      clientRef.current?.setViewport(width, height);
    });
    observer.observe(stage);
    return () => observer.disconnect();
  }, [isAvailable]);

  React.useEffect(() => () => {
    const frame = scrollRef.current.frame;
    if (frame !== null) cancelAnimationFrame(frame);
  }, []);

  const toPagePoint = React.useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    const viewport = viewportRef.current;
    if (!canvas || !viewport) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: clamp((clientX - rect.left) * (viewport.width / rect.width), 0, MAX_COORDINATE),
      y: clamp((clientY - rect.top) * (viewport.height / rect.height), 0, MAX_COORDINATE),
      scale: viewport.width / rect.width,
    };
  }, []);

  // Scroll input is coalesced to one message per animation frame.
  const queueScroll = React.useCallback((x: number, y: number, deltaX: number, deltaY: number) => {
    const pending = scrollRef.current;
    pending.x = x;
    pending.y = y;
    pending.deltaX += deltaX;
    pending.deltaY += deltaY;
    if (pending.frame !== null) return;
    pending.frame = requestAnimationFrame(() => {
      pending.frame = null;
      const message = {
        type: 'scroll' as const,
        x: pending.x,
        y: pending.y,
        deltaX: clamp(pending.deltaX, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA),
        deltaY: clamp(pending.deltaY, -MAX_SCROLL_DELTA, MAX_SCROLL_DELTA),
      };
      pending.deltaX = 0;
      pending.deltaY = 0;
      if (message.deltaX || message.deltaY) clientRef.current?.send(message);
    });
  }, []);

  const handlePointerDown = React.useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.button !== 0 || pointerRef.current) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = { id: event.pointerId, startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastY: event.clientY, scrolling: false };
  }, []);

  const handlePointerMove = React.useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const track = pointerRef.current;
    if (!track || track.id !== event.pointerId) return;
    if (!track.scrolling && Math.hypot(event.clientX - track.startX, event.clientY - track.startY) < TAP_SLOP_PX) return;
    track.scrolling = true;
    const point = toPagePoint(track.startX, track.startY);
    if (point) queueScroll(point.x, point.y, (track.lastX - event.clientX) * point.scale, (track.lastY - event.clientY) * point.scale);
    track.lastX = event.clientX;
    track.lastY = event.clientY;
  }, [queueScroll, toPagePoint]);

  const handlePointerUp = React.useCallback((event: React.PointerEvent<HTMLCanvasElement>) => {
    const track = pointerRef.current;
    if (!track || track.id !== event.pointerId) return;
    pointerRef.current = null;
    if (track.scrolling) return;
    const point = toPagePoint(event.clientX, event.clientY);
    if (point) clientRef.current?.send({ type: 'tap', x: point.x, y: point.y });
    // A mouse click also routes the physical keyboard to the page; touch keeps the soft keyboard closed.
    if (event.pointerType === 'mouse') inputRef.current?.focus({ preventScroll: true });
  }, [toPagePoint]);

  const handlePointerCancel = React.useCallback(() => { pointerRef.current = null; }, []);

  const handleWheel = React.useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    const point = toPagePoint(event.clientX, event.clientY);
    if (!point) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? (viewportRef.current?.height ?? 800) : 1;
    queueScroll(point.x, point.y, event.deltaX * unit, event.deltaY * unit);
  }, [queueScroll, toPagePoint]);

  const sendText = React.useCallback((text: string) => {
    for (let index = 0; index < text.length; index += MAX_TEXT_CHUNK) {
      clientRef.current?.send({ type: 'text', text: text.slice(index, index + MAX_TEXT_CHUNK) });
    }
  }, []);

  const flushInput = React.useCallback(() => {
    const input = inputRef.current;
    if (!input || !input.value) return;
    const text = input.value;
    input.value = '';
    sendText(text);
  }, [sendText]);

  const handleKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing || !REMOTE_BROWSER_KEYS.has(event.key)) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    event.stopPropagation();
    flushInput();
    backspaceSentRef.current = event.key === 'Backspace';
    clientRef.current?.send({ type: 'key', key: event.key });
  }, [flushInput]);

  const handleInput = React.useCallback((event: React.FormEvent<HTMLTextAreaElement>) => {
    if ((event.nativeEvent as InputEvent).isComposing) return;
    flushInput();
  }, [flushInput]);

  // Soft keyboards (IME) often report Backspace on the empty field only as a
  // native `beforeinput` with `deleteContentBackward`, which React's
  // `onBeforeInput` does not deliver, so the listener sits on the element.
  React.useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const handleBeforeInput = (event: InputEvent) => {
      if (event.inputType !== 'deleteContentBackward' || event.isComposing || input.value) return;
      event.preventDefault();
      // The physical key path already sent this Backspace.
      if (backspaceSentRef.current) {
        backspaceSentRef.current = false;
        return;
      }
      clientRef.current?.send({ type: 'key', key: 'Backspace' });
    };
    input.addEventListener('beforeinput', handleBeforeInput);
    return () => input.removeEventListener('beforeinput', handleBeforeInput);
  }, []);

  const toggleKeyboard = React.useCallback(() => {
    const input = inputRef.current;
    if (!input) return;
    if (document.activeElement === input) input.blur();
    else input.focus({ preventScroll: true });
  }, []);

  const submitAddress = React.useCallback((event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const url = normalizeBrowserUrl(addressDraft ?? pageState.url);
    if (url === 'about:blank') {
      toast.error("Enter an http or https address.");
      return;
    }
    if (clientRef.current?.send({ type: 'navigate', url })) {
      setAddressDraft(null);
      (document.activeElement as HTMLElement | null)?.blur();
    }
  }, [addressDraft, pageState.url]);

  const open = connection === 'open';
  const buttonClass = density === 'touch' ? 'size-9 p-0' : 'h-7 w-7 p-0';
  const iconClass = density === 'touch' ? 'size-4' : 'h-3.5 w-3.5';

  const toolbar = (
    <div className={cn('flex shrink-0 items-center gap-1 border-b border-border bg-[var(--surface-background)]', density === 'touch' ? 'h-11 px-2' : 'px-2 py-1')}>
      <Button type="button" variant="ghost" size="sm" className={buttonClass} disabled={!open || !pageState.canGoBack} onClick={() => clientRef.current?.send({ type: 'back' })} aria-label={"Back"} title={"Back"}>
        <Icon name="arrow-left" className={iconClass} />
      </Button>
      <Button type="button" variant="ghost" size="sm" className={buttonClass} disabled={!open || !pageState.canGoForward} onClick={() => clientRef.current?.send({ type: 'forward' })} aria-label={"Forward"} title={"Forward"}>
        <Icon name="arrow-right" className={iconClass} />
      </Button>
      {pageState.loading ? (
        <Button type="button" variant="ghost" size="sm" className={buttonClass} disabled={!open} onClick={() => clientRef.current?.send({ type: 'stop' })} aria-label={"Stop loading"} title={"Stop loading"}>
          <Icon name="close" className={iconClass} />
        </Button>
      ) : (
        <Button type="button" variant="ghost" size="sm" className={buttonClass} disabled={!open || !pageState.url} onClick={() => clientRef.current?.send({ type: 'reload' })} aria-label={"Reload"} title={"Reload"}>
          <Icon name="refresh" className={iconClass} />
        </Button>
      )}
      <form className="min-w-0 flex-1" onSubmit={submitAddress}>
        <input
          value={addressDraft ?? pageState.url}
          onChange={(event) => setAddressDraft(event.target.value)}
          onBlur={() => setAddressDraft(null)}
          disabled={!open}
          inputMode="url"
          enterKeyHint="go"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={"Enter an address"}
          className={cn(
            'w-full rounded-md border border-border/50 bg-[var(--surface-elevated)] px-2 text-foreground outline-none focus:border-[var(--interactive-focus-ring)] disabled:opacity-60',
            density === 'touch' ? 'h-9 typography-ui-label' : 'h-7 typography-micro',
          )}
          aria-label={"Browser address"}
        />
      </form>
      <Button
        type="button"
        variant={keyboardOpen ? 'secondary' : 'ghost'}
        size="sm"
        className={buttonClass}
        disabled={!open}
        onPointerDown={(event) => event.preventDefault()}
        onClick={toggleKeyboard}
        aria-label={"Type into the page"}
        aria-pressed={keyboardOpen}
        title={"Type into the page"}
      >
        <Icon name="keyboard-box" className={iconClass} />
      </Button>
    </div>
  );

  let overlay: React.ReactNode = null;
  if (availability.status === 'desktop-app-required') {
    overlay = (
      <PaneMessage
        icon="global"
        title={"The browser needs the PiChamber desktop app"}
        body={"Pages open in the desktop app on your laptop, with its logins. Connect to PiChamber running in the desktop app to use the browser here."}
        action={<Button type="button" variant="outline" size="sm" onClick={() => setStatusAttempt((value) => value + 1)}>{"Check again"}</Button>}
      />
    );
  } else if (availability.status === 'error') {
    overlay = (
      <PaneMessage
        icon="error-warning"
        title={"Could not check the browser"}
        body={availability.message}
        action={<Button type="button" variant="outline" size="sm" onClick={() => setStatusAttempt((value) => value + 1)}>{"Retry"}</Button>}
      />
    );
  } else if (connection === 'replaced') {
    overlay = (
      <PaneMessage
        icon="global"
        title={"The browser is open on another device"}
        body={"Only one device can show the browser at a time."}
        action={<Button type="button" variant="outline" size="sm" onClick={() => clientRef.current?.start()}>{"Show it here"}</Button>}
      />
    );
  } else if (!hasFrame) {
    overlay = (
      <div className="absolute inset-0 flex items-center justify-center gap-2 bg-background typography-micro text-muted-foreground">
        <Icon name="loader-4" className="size-4 animate-spin" />
        {connection === 'reconnecting' ? "Reconnecting to the desktop app…" : "Connecting to the desktop app…"}
      </div>
    );
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-background">
      {toolbar}
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-background" data-no-drawer-swipe="true">
        <canvas
          ref={canvasRef}
          className="absolute inset-0 h-full w-full touch-none select-none"
          aria-label={pageState.title || "Remote browser page"}
          role="img"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerCancel}
          onWheel={handleWheel}
          onContextMenu={(event) => event.preventDefault()}
        />
        <textarea
          ref={inputRef}
          className="pointer-events-none absolute bottom-0 left-0 h-px w-px resize-none opacity-0"
          aria-label={"Text for the remote page"}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          tabIndex={-1}
          onKeyDown={handleKeyDown}
          onKeyUp={() => { backspaceSentRef.current = false; }}
          onInput={handleInput}
          onCompositionEnd={flushInput}
          onFocus={() => setKeyboardOpen(true)}
          onBlur={() => setKeyboardOpen(false)}
        />
        {hasFrame && connection === 'reconnecting' ? (
          <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded-full bg-[var(--surface-elevated)] px-3 py-1 typography-micro text-muted-foreground shadow">
            {"Reconnecting…"}
          </div>
        ) : null}
        {overlay}
      </div>
    </div>
  );
};

const PaneMessage: React.FC<{ icon: 'global' | 'error-warning'; title: string; body: string; action: React.ReactNode }> = ({ icon, title, body, action }) => (
  <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-background p-6 text-center" role="status">
    <Icon name={icon} className="size-10 text-muted-foreground/60" />
    <span className="typography-ui-header text-foreground">{title}</span>
    <span className="max-w-sm typography-micro text-muted-foreground">{body}</span>
    {action}
  </div>
);
