import { injectHtmlRenderBootstrap } from './bootstrap.js';
import {
  HTML_RENDER_MAX_PAGE_BYTES,
  imagesNotFoundError,
  inlineLocalImages,
  pageTooLargeError,
} from './images.js';
import { createHtmlRenderStore } from './store.js';

// The `html_render` tool of t3code (acb90279) as an inline Pi extension the
// daemon adds to every session runtime, like the orchestration tools. The
// runtime knows the calling session, so the page is stored with it and the
// tool result names it; the UI shows it from that persisted result.

const HTML_RENDER_TOOL_NAME = 'html_render';
const HTML_RENDER_MAX_TITLE_LENGTH = 200;
const HTML_RENDER_MAX_HTML_LENGTH = 512_000;

const PAGE_RULES = 'Write one self-contained document with inline <style> and <script>. Local images written as absolute file paths (src="/abs/shot.png", CSS url(/abs/bg.webp), or a JS string) are inlined automatically; remote http(s) URLs, such as a CDN chart library, load as-is.';

const LAYOUT_GUIDE = [
  'The frame is borderless on the session\'s background, as wide as the reply column (about 720px on desktop, about 360px on phones), and its left edge lines up with your reply text.',
  'The page sits on the session\'s own background, so by default leave html, body, and the outermost element with no background color. This overrides general style preferences such as a fixed black page background.',
  'Use a fluid width with no horizontal padding on the outermost element, and no outer card, border, or banner title: the page is part of your reply.',
  'If a box needs its own background (a mock of a specific screen, a panel that must stand apart), give it at least 16px of padding on every side and var(--radius) corners, so content never touches its edge.',
  'Give charts fixed pixel heights rather than heights that scale with width.',
  'Let content set the page\'s height. Avoid viewport-based heights such as 100vh or height:100% on html or body; the frame grows to fit the page, so they can make it grow again and again.',
].join(' ');

const THEME_GUIDE = [
  'PiChamber injects its active theme as CSS custom properties on :root, and they follow the user\'s theme and light/dark mode live:',
  '--background (page background, identical to the session around the frame), --foreground, --muted, --muted-foreground,',
  '--card, --card-foreground, --popover, --popover-foreground, --secondary, --secondary-foreground, --border, --input, --ring,',
  '--primary, --primary-foreground (solid buttons), --accent, --accent-foreground (brand accent), --accent-surface, --accent-surface-foreground,',
  '--destructive, --destructive-foreground, --destructive-surface, --warning, --warning-foreground, --warning-surface,',
  '--success, --success-foreground, --info, --info-foreground, --code-background, --code-foreground,',
  '--chart-1 … --chart-6 (categorical series for charts), --radius, --font-sans, --font-mono.',
  'The base stylesheet sets html background/color/font from these, body margin to 0, and hides the page\'s scrollbar; your own CSS overrides it.',
].join(' ');

export const HTML_RENDER_TOOL = {
  name: HTML_RENDER_TOOL_NAME,
  label: 'Render HTML',
  description: `Show a finished HTML page (chart, table, diagram, collage, mockup) inline in this session, above your final text reply; call it before writing that reply. The reader already sees the page, so the reply should not announce it, say where it is, or restate it: add only what the page doesn't say. PiChamber fits the frame to the page's height, up to 2000px; taller content scrolls inside it. ${PAGE_RULES} ${LAYOUT_GUIDE} ${THEME_GUIDE}`,
  parameters: {
    type: 'object',
    additionalProperties: false,
    required: ['html'],
    properties: {
      html: {
        type: 'string',
        minLength: 1,
        maxLength: HTML_RENDER_MAX_HTML_LENGTH,
        description: 'A complete, self-contained HTML document.',
      },
      title: {
        type: 'string',
        minLength: 1,
        maxLength: HTML_RENDER_MAX_TITLE_LENGTH,
        description: 'Short name for the page.',
      },
    },
  },
};

export const HTML_RENDER_RESULT_MESSAGE = 'Shown to the reader above your reply. Don\'t mention or describe the page; reply with only what it doesn\'t already say.';

const normalizeTitle = (title) => (typeof title === 'string' ? title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH) : '') || 'HTML';

/**
 * The self-contained page that gets stored: local images inlined, theme
 * bootstrap injected. Throws an `HtmlRenderRequestError` the agent can act on.
 */
const prepareHtmlRenderPage = async (html) => {
  const inlined = await inlineLocalImages(html);
  if (inlined.missing.length > 0) throw imagesNotFoundError(inlined.missing);
  const page = injectHtmlRenderBootstrap(inlined.html);
  const pageBytes = Buffer.byteLength(page);
  if (pageBytes > HTML_RENDER_MAX_PAGE_BYTES) throw pageTooLargeError(pageBytes);
  return page;
};

/** @param {{ store?: ReturnType<typeof createHtmlRenderStore> }} [options] */
export const createHtmlRenderExtension = ({ store = createHtmlRenderStore() } = {}) => ({
  name: 'pichamber-html-render',
  hidden: true,
  factory: (pi) => {
    pi.registerTool({
      ...HTML_RENDER_TOOL,
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        if (typeof params?.html !== 'string' || params.html.length === 0) {
          throw new Error('html must be a complete HTML document.');
        }
        const page = await prepareHtmlRenderPage(params.html);
        let renderId;
        try {
          renderId = await store.save(ctx.sessionManager.getSessionId(), page);
        } catch {
          throw new Error('The HTML render could not be saved.');
        }
        const htmlRender = { renderId, title: normalizeTitle(params.title) };
        return {
          content: [{ type: 'text', text: HTML_RENDER_RESULT_MESSAGE }],
          details: { htmlRender },
        };
      },
    });
  },
});
