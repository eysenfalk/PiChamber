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
   * Hosts that can relaunch the server process themselves (the desktop app)
   * supply this. `prepare` arms the relaunch and may throw; `commit` ends
   * the current process after the HTTP reply was written.
   */
  restartProcess?: {
    prepare?: () => void | Promise<void>;
    commit: () => void | Promise<void>;
  };
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
