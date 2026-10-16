import type { Express } from "express";
import type { Server } from "http";

export interface WebUiServerController {
  expressApp: Express;
  httpServer: Server;
  getPort: () => number | null;
  isReady: () => boolean;
  stop: (options?: { exitProcess?: boolean }) => Promise<void>;
}

export interface StartWebUiServerOptions {
  port?: number;
  host?: string;
  attachSignals?: boolean;
  exitOnShutdown?: boolean;
  uiPassword?: string | null;
  /**
   * Hosts that relaunch the server process themselves (the desktop app)
   * supply this; without it the server replaces its own process through
   * `process.execve`, and restart is unsupported where that is missing. `prepare` arms the relaunch and may throw; `commit` ends
   * the current process after the HTTP reply was written.
   */
  restartProcess?: {
    prepare?: () => void | Promise<void>;
    commit: () => void | Promise<void>;
  };
  /** Injected by the desktop app; enables the remote browser route (lib/browser). */
  remoteBrowserHost?: RemoteBrowserHost | null;
}

export interface RemoteBrowserHost {
  attach(listener: {
    onFrame: (jpeg: Buffer) => void;
    onState: (state: { url: string; title: string; canGoBack: boolean; canGoForward: boolean; loading: boolean }) => void;
    onNotice: (notice: string) => void;
  }): { handle: (message: { type: string } & Record<string, unknown>) => void; detach: () => void };
}

export declare function startWebUiServer(
  options?: StartWebUiServerOptions
): Promise<WebUiServerController>;

export declare function gracefulShutdown(options?: { exitProcess?: boolean }): Promise<void>;
export declare function parseArgs(argv?: string[]): {
  port: number;
  host?: string;
  uiPassword: string | null;
  tryCfTunnel: boolean;
  tunnelProvider?: string;
  tunnelMode?: string;
  tunnelConfigPath?: string | null;
  tunnelToken?: string;
  tunnelHostname?: string;
};
