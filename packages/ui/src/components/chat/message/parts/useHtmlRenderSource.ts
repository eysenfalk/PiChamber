import React from 'react';

import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { usePiConnectionState } from '@/sync/sync-context';

type HtmlRenderSource =
  | { kind: 'loading' }
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
 * The page URL for one render. A failed mint is tried again when the Pi
 * connection comes back, so a page whose first request fell into an outage
 * loads after the reconnect; a page that already loaded keeps its URL.
 */
export const useHtmlRenderSource = (sessionId: string, renderId: string): HtmlRenderSource => {
  const [source, setSource] = React.useState<HtmlRenderSource>(() => (
    getActiveRelayTunnel() ? { kind: 'unsupported' } : { kind: 'loading' }
  ));
  const connection = usePiConnectionState();

  React.useEffect(() => {
    if (connection === 'ready') setSource((current) => (current.kind === 'failed' ? { kind: 'loading' } : current));
  }, [connection]);

  React.useEffect(() => {
    if (source.kind !== 'loading') return;
    let cancelled = false;
    mintHtmlRenderPageUrl(sessionId, renderId).then(
      (src) => { if (!cancelled) setSource({ kind: 'ready', src }); },
      () => { if (!cancelled) setSource({ kind: 'failed' }); },
    );
    return () => { cancelled = true; };
  }, [renderId, sessionId, source.kind]);

  return source;
};
