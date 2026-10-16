import type { Part } from '@/lib/chat/types';
import type { Theme } from '@/types/theme';

// Client side of the html_render page protocol (#155). The server-injected
// bootstrap (packages/web/server/lib/pi/html-render/bootstrap.js) reads the
// theme from the URL fragment, follows theme changes posted to it, and posts
// its content height and link requests to this frame.

const HTML_RENDER_TOOL_NAME = 'html_render';
const HTML_RENDER_MIN_HEIGHT = 80;
const HTML_RENDER_MAX_HEIGHT = 2000;
/** Box height before the page reports its own. */
export const HTML_RENDER_INITIAL_HEIGHT = 320;
export const HTML_RENDER_ZOOM_MIN = 0.5;
export const HTML_RENDER_ZOOM_MAX = 2;
export const HTML_RENDER_ZOOM_STEP = 0.25;

const THEME_FRAGMENT_KEY = 'pichamber-theme';
const HOST_CONTEXT_CHANGED_METHOD = 'ui/notifications/host-context-changed';
const OPEN_LINK_METHOD = 'ui/open-link';
const SIZE_CHANGED_METHOD = 'ui/notifications/size-changed';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export interface HtmlRenderReference {
  renderId: string;
  title: string;
}

export interface HtmlRenderTheme {
  appearance: 'light' | 'dark';
  variables: Record<string, string>;
}

interface HtmlRenderLinkRequest {
  url: string;
  metaKey: boolean;
  ctrlKey: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/**
 * The stored page a completed html_render tool call published, or undefined
 * for any other part. The daemon projects the tool's `details.htmlRender` to
 * the part's metadata.
 */
export const readHtmlRenderReference = (part: Part): HtmlRenderReference | undefined => {
  if (part.type !== 'tool') return undefined;
  const tool = part as Part & { tool?: unknown; state?: { status?: unknown; metadata?: unknown } };
  if (tool.tool !== HTML_RENDER_TOOL_NAME || tool.state?.status !== 'completed') return undefined;
  const metadata = tool.state.metadata;
  const reference = isRecord(metadata) ? metadata.htmlRender : undefined;
  if (!isRecord(reference)) return undefined;
  const { renderId, title } = reference;
  if (typeof renderId !== 'string' || !ID_PATTERN.test(renderId)) return undefined;
  return { renderId, title: typeof title === 'string' && title.trim() ? title : 'HTML' };
};

export const clampHtmlRenderHeight = (height: number): number =>
  Math.min(HTML_RENDER_MAX_HEIGHT, Math.max(HTML_RENDER_MIN_HEIGHT, Math.ceil(height)));

const readJsonRpc = (data: unknown, method: string): Record<string, unknown> | undefined => {
  if (!isRecord(data) || data.jsonrpc !== '2.0' || data.method !== method) return undefined;
  return isRecord(data.params) ? data.params : undefined;
};

/** The content height a page reported, or undefined for any other message. */
export const readHtmlRenderContentHeight = (data: unknown): number | undefined => {
  const height = readJsonRpc(data, SIZE_CHANGED_METHOD)?.height;
  return typeof height === 'number' && Number.isFinite(height) && height >= 0 ? height : undefined;
};

/** An http(s) link the page asks its client to open, or undefined. */
export const readHtmlRenderLinkRequest = (data: unknown): HtmlRenderLinkRequest | undefined => {
  const params = readJsonRpc(data, OPEN_LINK_METHOD);
  if (!params || typeof params.url !== 'string') return undefined;
  let url: URL;
  try {
    url = new URL(params.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  return { url: url.href, metaKey: params.metaKey === true, ctrlKey: params.ctrlKey === true };
};

const DEFAULT_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif';
const DEFAULT_MONO = '"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace';
const DEFAULT_CHARTS = ['#0d9488', '#d97706', '#9333ea', '#e11d48', '#65a30d'];

/** The app theme as CSS variables for an agent page. */
export const htmlRenderTheme = (theme: Theme): HtmlRenderTheme => {
  const { surface, interactive, primary, status, syntax, charts } = theme.colors;
  const series = Array.isArray(charts?.series) ? charts.series.filter((color) => typeof color === 'string') : [];
  const chartColors = [primary.base, ...DEFAULT_CHARTS].map((fallback, index) => series[index] ?? fallback);
  const variables: Record<string, string> = {
    '--background': surface.background,
    '--foreground': surface.foreground,
    '--muted': surface.muted,
    '--muted-foreground': surface.mutedForeground,
    '--card': surface.elevated,
    '--card-foreground': surface.elevatedForeground,
    '--popover': surface.elevated,
    '--popover-foreground': surface.elevatedForeground,
    '--secondary': surface.subtle,
    '--secondary-foreground': surface.foreground,
    '--border': interactive.border,
    '--input': interactive.border,
    '--ring': interactive.focusRing,
    '--primary': primary.base,
    '--primary-foreground': primary.foreground ?? surface.background,
    '--accent': primary.base,
    '--accent-foreground': primary.foreground ?? surface.background,
    '--accent-surface': interactive.selection,
    '--accent-surface-foreground': interactive.selectionForeground,
    '--destructive': status.error,
    '--destructive-foreground': status.errorForeground,
    '--destructive-surface': status.errorBackground,
    '--warning': status.warning,
    '--warning-foreground': status.warningForeground,
    '--warning-surface': status.warningBackground,
    '--success': status.success,
    '--success-foreground': status.successForeground,
    '--info': status.info,
    '--info-foreground': status.infoForeground,
    '--code-background': syntax.base.background,
    '--code-foreground': syntax.base.foreground,
    '--radius': '0.625rem',
    '--font-sans': theme.config?.fonts?.sans ?? DEFAULT_SANS,
    '--font-mono': theme.config?.fonts?.mono ?? DEFAULT_MONO,
  };
  chartColors.forEach((color, index) => {
    variables[`--chart-${index + 1}`] = color;
  });
  return { appearance: theme.metadata.variant === 'light' ? 'light' : 'dark', variables };
};

/** The URL fragment that themes a page before its first paint. */
export const htmlRenderThemeFragment = (theme: HtmlRenderTheme): string =>
  `#${THEME_FRAGMENT_KEY}=${encodeURIComponent(JSON.stringify(theme))}`;

/** The message that re-themes a loaded page. */
export const htmlRenderThemeMessage = (theme: HtmlRenderTheme) => ({
  jsonrpc: '2.0' as const,
  method: HOST_CONTEXT_CHANGED_METHOD,
  params: { theme: theme.appearance, styles: { variables: theme.variables } },
});
