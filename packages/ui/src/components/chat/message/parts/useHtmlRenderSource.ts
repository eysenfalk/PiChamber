import React from 'react';

import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { usePiConnectionState } from '@/sync/sync-context';

type HtmlRenderSource =
  | { kind: 'loading'; attempt: number }
  | { kind: 'ready'; src: string }
  | { kind: 'failed' }
  | { kind: 'unsupported' };

export const mintHtmlRenderPageUrl = async (sessionId: string, renderId: string): Promise<string> => {
  const response = await runtimeFetch(
    `/api/pi/sessions/${encodeURIComponent(sessionId)}/html-renders/${encodeURIComponent(renderId)}/url`,
    { method: 'POST' },
  );
  if (!response.ok) throw new Error(`html_render url ${response.status}`);
  const body = await response.json() as { url?: unknown };
  if (typeof body.url !== 'string') throw new Error('html_render url missing');
  return getRuntimeUrlResolver().api(body.url);
};

/**
 * The page URL for one render. When the Pi connection comes back to ready, a
 * failed or still running mint starts over: a request that fell into the
 * outage may still fail late, so its result is dropped. Only that transition
 * retries, so a lasting HTTP failure does not loop; a page that already loaded
 * keeps its URL.
 */
export const useHtmlRenderSource = (sessionId: string, renderId: string): HtmlRenderSource => {
  const [source, setSource] = React.useState<HtmlRenderSource>(() => (
    getActiveRelayTunnel() ? { kind: 'unsupported' } : { kind: 'loading', attempt: 0 }
  ));
  const connection = usePiConnectionState();
  const previousConnection = React.useRef(connection);

  React.useEffect(() => {
    const previous = previousConnection.current;
    previousConnection.current = connection;
    if (connection !== 'ready' || previous === 'ready') return;
    setSource((current) => {
      if (current.kind === 'failed') return { kind: 'loading', attempt: 0 };
      if (current.kind === 'loading') return { kind: 'loading', attempt: current.attempt + 1 };
      return current;
    });
  }, [connection]);

  const pendingAttempt = source.kind === 'loading' ? source.attempt : null;
  React.useEffect(() => {
    if (pendingAttempt === null) return;
    let cancelled = false;
    mintHtmlRenderPageUrl(sessionId, renderId).then(
      (src) => { if (!cancelled) setSource({ kind: 'ready', src }); },
      () => { if (!cancelled) setSource({ kind: 'failed' }); },
    );
    return () => { cancelled = true; };
  }, [pendingAttempt, renderId, sessionId]);

  return source;
};
