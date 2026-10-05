/**
 * Build stamps shown in Settings › About. The UI's own stamp is embedded by
 * the Vite build (`__PICHAMBER_BUILD__`); the server and daemon stamps come
 * from `/api/system/info`.
 */

declare const __PICHAMBER_BUILD__: BuildStamp | undefined;

export interface BuildStamp {
  /** Short Git commit, plus `-dirty` when the tree had uncommitted changes. */
  id: string;
  /** UTC ISO time of the build. */
  builtAt: string;
}

export interface ServerBuildStamp extends BuildStamp {
  /** `source` for a checkout without a build: the time is the server start, not a build. */
  kind?: 'build' | 'source';
}

export interface DaemonBuildStamp {
  id: string;
  builtAt?: string;
}

export interface RuntimeBuilds {
  ui: BuildStamp | null;
  server: ServerBuildStamp | null;
  daemon: DaemonBuildStamp | null;
}

const parseTime = (value: string | undefined): number | null => {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
};

const readStamp = (value: unknown): BuildStamp | null => {
  if (!value || typeof value !== 'object') return null;
  const { id, builtAt } = value as Partial<BuildStamp>;
  if (typeof id !== 'string' || id.length === 0 || typeof builtAt !== 'string' || parseTime(builtAt) === null) return null;
  return { id, builtAt };
};

export const getUiBuild = (): BuildStamp | null => (
  typeof __PICHAMBER_BUILD__ !== 'undefined' ? readStamp(__PICHAMBER_BUILD__) : null
);

/** Reads the build fields of a `/api/system/info` response; missing or malformed stamps become null. */
export const readServerBuilds = (info: unknown): Pick<RuntimeBuilds, 'server' | 'daemon'> => {
  const record = (info && typeof info === 'object' ? info : {}) as { serverBuild?: unknown; daemonBuild?: unknown };
  const server = readStamp(record.serverBuild);
  const kind = (record.serverBuild as { kind?: unknown } | null | undefined)?.kind;
  const daemonRaw = record.daemonBuild as { id?: unknown; builtAt?: unknown } | null | undefined;
  const daemonId = typeof daemonRaw?.id === 'string' && daemonRaw.id.length > 0 ? daemonRaw.id : null;
  return {
    server: server ? { ...server, ...(kind === 'build' || kind === 'source' ? { kind } : {}) } : null,
    daemon: daemonId
      ? {
          id: daemonId,
          ...(typeof daemonRaw?.builtAt === 'string' && parseTime(daemonRaw.builtAt) !== null ? { builtAt: daemonRaw.builtAt } : {}),
        }
      : null,
  };
};

export type BuildMismatch = 'ui-newer-than-server' | 'ui-older-than-server' | 'daemon-older-than-server' | 'daemon-differs-from-server';

/**
 * Names the first mismatch between the three running builds, or null.
 *
 * A source checkout (`kind: 'source'`) has no build to compare the UI with:
 * its ID is `source-<commit>`, never equal to a UI build ID, so that pair is
 * skipped. The daemon is started by the server, so its ID must equal the
 * server's; a different ID means it is from another build.
 */
export const findBuildMismatch = ({ ui, server, daemon }: RuntimeBuilds): BuildMismatch | null => {
  if (ui && server && server.kind !== 'source' && ui.id !== server.id) {
    const uiTime = parseTime(ui.builtAt);
    const serverTime = parseTime(server.builtAt);
    return uiTime !== null && serverTime !== null && uiTime < serverTime ? 'ui-older-than-server' : 'ui-newer-than-server';
  }
  if (server && daemon && daemon.id !== server.id) {
    const daemonTime = parseTime(daemon.builtAt);
    const serverTime = parseTime(server.builtAt);
    return daemonTime !== null && serverTime !== null && daemonTime < serverTime
      ? 'daemon-older-than-server'
      : 'daemon-differs-from-server';
  }
  return null;
};

export const describeBuildMismatch = (mismatch: BuildMismatch): string => {
  switch (mismatch) {
    case 'ui-newer-than-server':
      return 'This UI is newer than the server. Restart PiChamber to run the new server build.';
    case 'ui-older-than-server':
      return 'This UI is older than the server. Reload the page or the app to load the new UI.';
    case 'daemon-older-than-server':
      return 'The session daemon is from an older build than the server. Restart PiChamber to replace it.';
    case 'daemon-differs-from-server':
      return 'The session daemon is not from the server build. Restart PiChamber to replace it.';
  }
};

/** Local date and time of an ISO build time, in the viewer's locale. */
export const formatBuildTime = (builtAt: string | undefined, locale?: string): string => {
  const time = parseTime(builtAt);
  return time === null ? 'unknown time' : new Date(time).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' });
};
