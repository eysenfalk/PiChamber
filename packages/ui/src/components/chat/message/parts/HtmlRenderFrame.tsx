import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { getActiveRelayTunnel } from '@/lib/relay/runtime-tunnel';
import { runtimeFetch } from '@/lib/runtime-fetch';
import { getRuntimeUrlResolver } from '@/lib/runtime-url';
import { HtmlRenderDialog } from './HtmlRenderDialog';
import { HtmlRenderDocument } from './HtmlRenderDocument';
import {
  clampHtmlRenderHeight,
  HTML_RENDER_INITIAL_HEIGHT,
  type HtmlRenderReference,
} from './htmlRenderModel';

type FrameSource =
  | { kind: 'loading' }
  | { kind: 'ready'; src: string }
  | { kind: 'failed' }
  | { kind: 'unsupported' };

const mintPageUrl = async (sessionId: string, renderId: string): Promise<string> => {
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
 * An agent's html_render page inline in the session (#155). Loading and
 * failure hold the same box, so nothing below it moves; the page then sets its
 * own height up to 2000 px.
 */
export const HtmlRenderFrame: React.FC<{
  sessionId: string;
  reference: HtmlRenderReference;
}> = ({ sessionId, reference }) => {
  const { renderId, title } = reference;
  const [source, setSource] = React.useState<FrameSource>(() => (
    getActiveRelayTunnel() ? { kind: 'unsupported' } : { kind: 'loading' }
  ));
  const [contentHeight, setContentHeight] = React.useState<number>();
  const [expandedSrc, setExpandedSrc] = React.useState<string | null>(null);
  const [expandFailed, setExpandFailed] = React.useState(false);

  React.useEffect(() => {
    if (source.kind !== 'loading') return;
    let cancelled = false;
    mintPageUrl(sessionId, renderId).then(
      (src) => { if (!cancelled) setSource({ kind: 'ready', src }); },
      () => { if (!cancelled) setSource({ kind: 'failed' }); },
    );
    return () => { cancelled = true; };
  }, [renderId, sessionId, source.kind]);

  // The dialog gets its own fresh URL; the inline frame's may have expired.
  const openExpanded = React.useCallback(() => {
    setExpandFailed(false);
    mintPageUrl(sessionId, renderId).then(setExpandedSrc, () => setExpandFailed(true));
  }, [renderId, sessionId]);

  const height = clampHtmlRenderHeight(contentHeight ?? HTML_RENDER_INITIAL_HEIGHT);

  return (
    <div
      className="group/html-render relative overflow-hidden rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-background)]"
      style={{ height }}
      data-html-render-id={renderId}
    >
      {source.kind === 'ready' ? (
        <>
          <HtmlRenderDocument
            src={source.src}
            title={title}
            className="block size-full"
            onContentHeight={setContentHeight}
          />
          <div className="absolute end-2 top-2 flex items-center gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 pointer-coarse:opacity-100">
            {expandFailed ? (
              <span className="typography-micro rounded bg-[var(--surface-elevated)] px-1.5 py-0.5 text-[var(--status-error)]">
                Page unavailable
              </span>
            ) : null}
            <Button
              type="button"
              variant="secondary"
              size="xs"
              aria-label="Open full screen"
              title="Open full screen"
              onClick={openExpanded}
            >
              <Icon name="fullscreen" className="size-3.5" />
            </Button>
          </div>
          {expandedSrc !== null ? (
            <HtmlRenderDialog src={expandedSrc} title={title} onClose={() => setExpandedSrc(null)} />
          ) : null}
        </>
      ) : source.kind === 'loading' ? (
        <p className="typography-meta flex size-full items-center justify-center text-[var(--surface-mutedForeground)]">
          Loading {title}…
        </p>
      ) : (
        <p className="typography-meta flex size-full items-center justify-center px-4 text-center text-[var(--surface-mutedForeground)]">
          {source.kind === 'unsupported'
            ? `${title} can't be shown over the private relay. Open this session on a direct connection to see it.`
            : `Unable to load ${title}`}
        </p>
      )}
    </div>
  );
};
