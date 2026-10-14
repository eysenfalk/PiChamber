// Client of the remote browser socket (`/api/browser/ws`, #163, ADR 0012).
//
// The page runs in the desktop app on the laptop; this client receives its
// JPEG frames and page state and sends navigation and input back. The wire
// format is owned by `packages/web/server/lib/browser/protocol.js`.

import { clearRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken } from '@/lib/runtime-auth';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { openRuntimeWebSocket } from '@/lib/relay/runtime-socket';
import type { RelayTunnelWebSocket } from '@/lib/relay/tunnel-client';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';

const SOCKET_OPEN = 1;
/** Server close code when another viewer took the page over. */
const REPLACED_CLOSE_CODE = 4001;
const MIN_VIEWPORT = 100;
const MAX_VIEWPORT = 4096;

export const REMOTE_BROWSER_KEYS: ReadonlySet<string> = new Set([
  'Enter', 'Backspace', 'Tab', 'Escape', 'Delete',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'Home', 'End', 'PageUp', 'PageDown',
]);

type RemoteBrowserAvailability = 'available' | 'desktop-app-required';

export type RemoteBrowserPageState = {
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  loading: boolean;
};

type RemoteBrowserNotice = 'download-blocked' | 'page-crashed';

export type RemoteBrowserCommand =
  | { type: 'navigate'; url: string }
  | { type: 'back' | 'forward' | 'reload' | 'stop' }
  | { type: 'tap'; x: number; y: number }
  | { type: 'scroll'; x: number; y: number; deltaX: number; deltaY: number }
  | { type: 'text'; text: string }
  | { type: 'key'; key: string };

/** `replaced`: another device opened the browser; the client stays closed until started again. */
export type RemoteBrowserConnection = 'connecting' | 'open' | 'reconnecting' | 'replaced' | 'stopped';

export type RemoteBrowserListener = {
  onConnection: (connection: RemoteBrowserConnection) => void;
  /** Draws one JPEG frame; the next frame is requested once this settles. */
  onFrame: (jpeg: ArrayBuffer) => Promise<void> | void;
  onPageState: (state: RemoteBrowserPageState) => void;
  onNotice: (notice: RemoteBrowserNotice) => void;
};

export type RemoteBrowserSocketDeps = {
  refreshToken: () => Promise<string | null | undefined>;
  clearToken: (token: string | null | undefined) => void;
  openSocket: (token: string | null | undefined) => RelayTunnelWebSocket;
  setTimer: (callback: () => void, ms: number) => unknown;
  clearTimer: (timer: unknown) => void;
};

const defaultDeps: RemoteBrowserSocketDeps = {
  refreshToken: () => refreshRuntimeUrlAuthToken(),
  clearToken: (token) => clearRuntimeUrlAuthToken(token ?? undefined),
  openSocket: (token) => openRuntimeWebSocket(getRuntimeUrlResolver().websocket('/api/browser/ws', undefined, token ?? undefined)),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

/** Reads `/api/browser/status`. Throws when the status cannot be read, so a fetch failure never looks like a missing desktop app. */
export const fetchRemoteBrowserAvailability = async (): Promise<RemoteBrowserAvailability> => {
  const response = await runtimeFetch('/api/browser/status', { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Browser status request failed (${response.status})`);
  const body = await response.json() as { available?: unknown; reason?: unknown } | null;
  if (body?.available === true) return 'available';
  if (body?.available === false && body.reason === 'desktop-app-required') return 'desktop-app-required';
  throw new Error('Browser status response is invalid');
};

export const reconnectDelayMs = (failures: number): number => Math.min(10_000, 500 * 2 ** Math.max(0, Math.min(failures - 1, 5)));

const clampViewport = (value: number): number => Math.min(MAX_VIEWPORT, Math.max(MIN_VIEWPORT, Math.round(value)));

const readPageState = (message: Record<string, unknown>): RemoteBrowserPageState => ({
  url: typeof message.url === 'string' ? message.url : '',
  title: typeof message.title === 'string' ? message.title : '',
  canGoBack: message.canGoBack === true,
  canGoForward: message.canGoForward === true,
  loading: message.loading === true,
});

export class RemoteBrowserClient {
  private socket: RelayTunnelWebSocket | null = null;
  private running = false;
  private failures = 0;
  private generation = 0;
  private reconnectTimer: unknown = null;
  private viewport: { width: number; height: number } | null = null;

  constructor(
    private readonly listener: RemoteBrowserListener,
    private readonly deps: RemoteBrowserSocketDeps = defaultDeps,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.failures = 0;
    this.listener.onConnection('connecting');
    void this.connect();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.closeSocket();
    this.listener.onConnection('stopped');
  }

  /** Sets the page viewport in CSS pixels; sent now when connected and again after every reconnect. */
  setViewport(width: number, height: number): void {
    const next = { width: clampViewport(width), height: clampViewport(height) };
    if (this.viewport && this.viewport.width === next.width && this.viewport.height === next.height) return;
    this.viewport = next;
    this.sendRaw({ type: 'resize', ...next });
  }

  /** Returns false when the socket is not open and the command was dropped. */
  send(command: RemoteBrowserCommand): boolean {
    return this.sendRaw(command);
  }

  private sendRaw(message: Record<string, unknown>): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== SOCKET_OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  }

  private async connect(): Promise<void> {
    if (!this.running || this.socket || this.reconnectTimer) return;
    const generation = ++this.generation;
    let token: string | null | undefined;
    try {
      token = await this.deps.refreshToken();
      if (!this.running || generation !== this.generation) return;
      const socket = this.deps.openSocket(token);
      socket.binaryType = 'arraybuffer';
      this.socket = socket;
      let opened = false;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        opened = true;
        this.failures = 0;
        if (this.viewport) this.sendRaw({ type: 'resize', ...this.viewport });
        this.listener.onConnection('open');
      };
      socket.onmessage = (event) => {
        if (this.socket !== socket) return;
        if (event.data instanceof ArrayBuffer) {
          this.handleFrame(socket, event.data);
          return;
        }
        if (typeof event.data !== 'string') return;
        let message: Record<string, unknown>;
        try { message = JSON.parse(event.data); } catch { return; }
        if (message.type === 'state') this.listener.onPageState(readPageState(message));
        else if (message.type === 'notice' && (message.notice === 'download-blocked' || message.notice === 'page-crashed')) {
          this.listener.onNotice(message.notice);
        }
      };
      socket.onerror = () => {};
      socket.onclose = (event) => {
        if (this.socket !== socket) return;
        this.socket = null;
        if (!opened) this.deps.clearToken(token);
        if (!this.running) return;
        if (event.code === REPLACED_CLOSE_CODE) {
          this.running = false;
          this.listener.onConnection('replaced');
          return;
        }
        this.scheduleReconnect();
      };
    } catch {
      if (this.running && generation === this.generation) {
        this.socket = null;
        this.scheduleReconnect();
      }
    }
  }

  private handleFrame(socket: RelayTunnelWebSocket, jpeg: ArrayBuffer): void {
    // The host keeps one frame in flight: acknowledge after drawing, also when drawing failed.
    void Promise.resolve()
      .then(() => this.listener.onFrame(jpeg))
      .catch(() => {})
      .then(() => { if (this.socket === socket) this.sendRaw({ type: 'ack' }); });
  }

  private scheduleReconnect(): void {
    this.failures += 1;
    this.listener.onConnection('reconnecting');
    this.reconnectTimer = this.deps.setTimer(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, reconnectDelayMs(this.failures));
  }

  private closeSocket(): void {
    this.generation += 1;
    if (this.reconnectTimer) this.deps.clearTimer(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onmessage = null;
      try { socket.close(); } catch { /* already closed */ }
    }
  }
}
