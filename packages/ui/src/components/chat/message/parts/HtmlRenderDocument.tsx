import React from 'react';

import { useThemeSystem } from '@/contexts/useThemeSystem';
import { openExternalUrl } from '@/lib/url';
import { cn } from '@/lib/utils';
import {
  htmlRenderTheme,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
  type HtmlRenderTheme,
} from './htmlRenderModel';

const useHtmlRenderTheme = (): HtmlRenderTheme | undefined => {
  const { currentTheme } = useThemeSystem();
  return React.useMemo(() => (currentTheme ? htmlRenderTheme(currentTheme) : undefined), [currentTheme]);
};

/**
 * A sandboxed agent page. It never gets allow-same-origin, so the page has an
 * opaque origin and cannot reach the app's cookies, storage, or DOM. The page
 * reads the theme from its URL fragment before first paint and follows later
 * changes posted to it. The first URL is kept for the frame's lifetime, since a
 * new src would reload the page.
 */
export const HtmlRenderDocument: React.FC<{
  src: string;
  title: string;
  className?: string;
  onContentHeight?: (height: number) => void;
}> = ({ src: initialSrc, title, className, onContentHeight }) => {
  const theme = useHtmlRenderTheme();
  const frameRef = React.useRef<HTMLIFrameElement>(null);
  const [src] = React.useState(() => `${initialSrc.split('#', 1)[0]}${theme ? htmlRenderThemeFragment(theme) : ''}`);
  const postTheme = React.useCallback(() => {
    if (theme) frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), '*');
  }, [theme]);
  React.useEffect(postTheme, [postTheme]);

  // The page cannot open windows itself. It asks this client, which opens an
  // http(s) link only while the frame has focus and the reader has just used
  // the app, so a page cannot open links on load.
  React.useEffect(() => {
    const openLink = (event: MessageEvent) => {
      const frame = frameRef.current;
      const request = readHtmlRenderLinkRequest(event.data);
      if (
        !request
        || !frame
        || event.source !== frame.contentWindow
        || document.activeElement !== frame
        || (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation?.isActive === false
      ) {
        return;
      }
      void openExternalUrl(request.url);
    };
    window.addEventListener('message', openLink);
    return () => window.removeEventListener('message', openLink);
  }, []);

  // Listen from the commit that inserts the frame; a passive effect could run
  // after a fast page's first height report.
  React.useLayoutEffect(() => {
    if (!onContentHeight) return;
    const resize = (event: MessageEvent) => {
      const height = readHtmlRenderContentHeight(event.data);
      if (height !== undefined && event.source === frameRef.current?.contentWindow) onContentHeight(height);
    };
    window.addEventListener('message', resize);
    return () => window.removeEventListener('message', resize);
  }, [onContentHeight]);

  return (
    <iframe
      ref={frameRef}
      src={src}
      title={title}
      // Never allow-same-origin: the opaque origin keeps the page out of the app's session.
      sandbox="allow-scripts allow-forms"
      loading="lazy"
      onLoad={postTheme}
      className={cn('border-0', className)}
      style={theme ? { colorScheme: theme.appearance } : undefined}
    />
  );
};
