import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { HtmlRenderDocument } from './HtmlRenderDocument';
import { HTML_RENDER_ZOOM_MAX, HTML_RENDER_ZOOM_MIN, HTML_RENDER_ZOOM_STEP } from './htmlRenderModel';

/** An agent page full screen, zoomable from 50 to 200 percent. */
export const HtmlRenderDialog: React.FC<{
  src: string;
  title: string;
  onClose: () => void;
}> = ({ src, title, onClose }) => {
  const [zoom, setZoom] = React.useState(1);
  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="flex w-[92vw] max-w-[92vw] flex-col gap-2 p-3 pt-10">
        <DialogTitle className="sr-only">{`Expanded ${title} preview`}</DialogTitle>
        <div className="h-[min(80vh,calc(100vh-160px))] overflow-auto overscroll-contain rounded-lg border border-[var(--interactive-border)] bg-[var(--surface-background)] [container-type:size]">
          <div className="h-[100cqh] w-[100cqw]" style={{ zoom }} data-html-render-zoom={zoom}>
            <HtmlRenderDocument src={src} title={title} className="block size-full" />
          </div>
        </div>
        <div className="flex min-w-0 items-center justify-center gap-3">
          <span className="typography-meta truncate text-[var(--surface-mutedForeground)]">{title}</span>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label="Zoom out"
              disabled={zoom <= HTML_RENDER_ZOOM_MIN}
              onClick={() => setZoom((value) => Math.max(HTML_RENDER_ZOOM_MIN, value - HTML_RENDER_ZOOM_STEP))}
            >
              <Icon name="subtract" className="size-3.5" />
            </Button>
            <Button type="button" variant="ghost" size="xs" aria-label="Reset zoom" onClick={() => setZoom(1)}>
              {`${Math.round(zoom * 100)}%`}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              aria-label="Zoom in"
              disabled={zoom >= HTML_RENDER_ZOOM_MAX}
              onClick={() => setZoom((value) => Math.min(HTML_RENDER_ZOOM_MAX, value + HTML_RENDER_ZOOM_STEP))}
            >
              <Icon name="add" className="size-3.5" />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
