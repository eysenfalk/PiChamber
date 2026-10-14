// Ported from t3code `packages/shared/src/htmlRender.ts` (acb90279). The page
// bootstrap themes an agent page before first paint and speaks the MCP Apps
// postMessage protocol with the PiChamber frame around it. t3code's keyboard
// shortcut passthrough is left out.

const HTML_RENDER_THEME_FRAGMENT_KEY = 'pichamber-theme';
const HOST_CONTEXT_CHANGED_METHOD = 'ui/notifications/host-context-changed';
const OPEN_LINK_METHOD = 'ui/open-link';
const SIZE_CHANGED_METHOD = 'ui/notifications/size-changed';

// The frame scrolls a page taller than itself, but a scrollbar inside the
// reply reads as a box within the session, so it stays hidden.
const BASE_CSS =
  'html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:100%;scrollbar-width:none}'
  + 'html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}'
  // Focus outlines paint inside the element, so the frame edge never clips them.
  + ':where(:focus-visible){outline:2px solid var(--ring)}:focus-visible{outline-width:2px!important;outline-offset:-2px!important}';

// Without a client theme (the page opened directly) it follows the OS
// appearance through CSS system colors. Clients always pass their theme.
const DEFAULT_VARIABLES_CSS = ':root{color-scheme:light dark;'
  + '--background:Canvas;--foreground:CanvasText;'
  + '--muted:color-mix(in srgb,CanvasText 8%,Canvas);--muted-foreground:color-mix(in srgb,CanvasText 62%,Canvas);'
  + '--card:color-mix(in srgb,CanvasText 4%,Canvas);--card-foreground:CanvasText;'
  + '--popover:color-mix(in srgb,CanvasText 4%,Canvas);--popover-foreground:CanvasText;'
  + '--secondary:color-mix(in srgb,CanvasText 8%,Canvas);--secondary-foreground:CanvasText;'
  + '--border:color-mix(in srgb,CanvasText 18%,Canvas);--input:color-mix(in srgb,CanvasText 18%,Canvas);--ring:Highlight;'
  + '--primary:LinkText;--primary-foreground:Canvas;--accent:LinkText;--accent-foreground:Canvas;'
  + '--accent-surface:color-mix(in srgb,LinkText 14%,Canvas);--accent-surface-foreground:CanvasText;'
  + '--destructive:#dc2626;--destructive-foreground:#ffffff;--destructive-surface:color-mix(in srgb,#dc2626 14%,Canvas);'
  + '--warning:#d97706;--warning-foreground:#ffffff;--warning-surface:color-mix(in srgb,#d97706 14%,Canvas);'
  + '--success:#10b981;--success-foreground:#ffffff;--info:#3b82f6;--info-foreground:#ffffff;'
  + '--code-background:color-mix(in srgb,CanvasText 6%,Canvas);--code-foreground:CanvasText;'
  + '--chart-1:LinkText;--chart-2:#0d9488;--chart-3:#d97706;--chart-4:#9333ea;--chart-5:#e11d48;--chart-6:#65a30d;'
  + '--radius:0.625rem;'
  + '--font-sans:-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;'
  + '--font-mono:"SF Mono", "SFMono-Regular", Menlo, Consolas, "Liberation Mono", monospace}';

// Runs synchronously in <head>, before the page's own styles and body, so the
// first paint is already themed. It rewrites its own <style> element rather
// than setting inline properties, so a page's later `:root` rules still win,
// then drops the fragment so a page's own hash routing never sees it. A link
// the reader clicks never replaces the page inside the session: a framed page
// asks its client to open it, and a top-level page opens it as a new window. A
// framed page also reports its content height, so its client can fit the
// frame to the page.
const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById("${HTML_RENDER_THEME_FRAGMENT_KEY}"),n=0;if(!s)return;var b=${JSON.stringify(BASE_CSS)};function a(t){if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+b;}try{var m=/[#&]${HTML_RENDER_THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){a(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}window.addEventListener("message",function(e){var d=e.data,p=d&&d.params;if(d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HOST_CONTEXT_CHANGED_METHOD)}&&p&&p.styles)a({appearance:p.theme,variables:p.styles.variables});});document.addEventListener("click",function(e){var l=e.isTrusted?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;if(window.parent!==window){e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",id:"pichamber-link-"+(++n),method:${JSON.stringify(OPEN_LINK_METHOD)},params:{url:u.href,metaKey:e.metaKey,ctrlKey:e.ctrlKey}},"*");}else{l.setAttribute("target","_blank");l.setAttribute("rel","noopener");}},true);if(window.parent!==window){var h,o,z=function(){var r=document.documentElement,v=Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height);if(v===h)return;h=v;window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(SIZE_CHANGED_METHOD)},params:{height:v}},"*");};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);}})();`;

const bootstrapMarkup = (markup) => [
  /<meta\s[^>]*charset/i.test(markup.slice(0, 4096)) ? '' : '<meta charset="utf-8">',
  /<meta\s[^>]*name\s*=\s*["']?viewport/i.test(markup)
    ? ''
    : '<meta name="viewport" content="width=device-width, initial-scale=1">',
  `<style id="${HTML_RENDER_THEME_FRAGMENT_KEY}">${DEFAULT_VARIABLES_CSS}${BASE_CSS}</style>`,
  `<script>${BOOTSTRAP_SCRIPT}</script>`,
].join('');

// Comments, raw text, and template contents are blanked to the same length,
// so offsets still line up and inert tags cannot receive the bootstrap.
const blankNonMarkup = (html) => {
  const scan = html.replace(
    /<!--[\s\S]*?(?:-->|$)|<(script|style|textarea|title|xmp|iframe|noembed|noframes|noscript)\b[\s\S]*?(?:<\/\1\s*>|$)|<plaintext\b[\s\S]*$/gi,
    (match) => ' '.repeat(match.length),
  );
  const parts = [];
  let depth = 0;
  let start = 0;
  let at = 0;
  for (const match of scan.matchAll(/<(\/?)template(?:\s[^>]*)?\/?>/gi)) {
    if (!match[1]) {
      if (depth++ === 0) start = match.index;
    } else if (depth > 0 && --depth === 0) {
      const end = match.index + match[0].length;
      parts.push(scan.slice(at, start), ' '.repeat(end - start));
      at = end;
    }
  }
  if (depth > 0) {
    parts.push(scan.slice(at, start), ' '.repeat(scan.length - start));
    at = scan.length;
  }
  parts.push(scan.slice(at));
  return parts.join('');
};

/**
 * Inserts the theme bootstrap at the start of the document head, so a page's
 * own styles and scripts come after it.
 */
export const injectHtmlRenderBootstrap = (html) => {
  const scan = blankNonMarkup(html);
  const markup = bootstrapMarkup(scan);
  const headOpen = /<head(?:\s[^>]*)?>/i.exec(scan);
  if (headOpen) {
    const at = headOpen.index + headOpen[0].length;
    return html.slice(0, at) + markup + html.slice(at);
  }
  const htmlOpen = /<html(?:\s[^>]*)?>/i.exec(scan);
  if (htmlOpen) {
    const at = htmlOpen.index + htmlOpen[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) {
    const at = doctype[0].length;
    return `${html.slice(0, at)}<head>${markup}</head>${html.slice(at)}`;
  }
  return `<!doctype html><head>${markup}</head>${html}`;
};
