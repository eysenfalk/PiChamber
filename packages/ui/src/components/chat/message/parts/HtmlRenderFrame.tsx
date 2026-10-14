import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { HtmlRenderDialog } from './HtmlRenderDialog';
import { HtmlRenderDocument } from './HtmlRenderDocument';
import {
  clampHtmlRenderHeight,
  HTML_RENDER_INITIAL_HEIGHT,
  type HtmlRenderReference,
} from './htmlRenderModel';
import { mintHtmlRenderPageUrl, useHtmlRenderSource } from './useHtmlRenderSource';

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
  const source = useHtmlRenderSource(sessionId, renderId);
  const [contentHeight, setContentHeight] = React.useState<number>();
  const [expandedSrc, setExpandedSrc] = React.useState<string | null>(null);
  const [expandFailed, setExpandFailed] = React.useState(false);

  // The dialog gets its own fresh URL; the inline frame's may have expired.
  const openExpanded = React.useCallback(() => {
    setExpandFailed(false);
    mintHtmlRenderPageUrl(sessionId, renderId).then(setExpandedSrc, () => setExpandFailed(true));
  }, [renderId, sessionId]);

  const height = clampHtmlRenderHeight(contentHeight ?? HTML_RENDER_INITIAL_HEIGHT);

  return (
    <div
      className="group/html-render relative"
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
