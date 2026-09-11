import DOMPurify from 'dompurify';

/**
 * HTML 净化。
 *
 * 笔记正文和内核富输出都会被直接插进 DOM，而这两处的内容都可能来自别处：
 * 导入的 ipynb、同步目录里的 .md、别人给的笔记。净化之前，
 * 一个 <img onerror> 就能在打开笔记时执行任意脚本、读遍整个笔记库。
 *
 * 只拦脚本，不动排版：标签和属性沿用 DOMPurify 的默认白名单，
 * 额外允许 SVG（Java 内核会输出图形），并禁掉所有事件属性与危险协议。
 */

let hooked = false;

function ensureHooks() {
  if (hooked) return;
  hooked = true;
  // 站内链接要交给应用自己的拦截逻辑，这里只保证协议安全，
  // 其余判断仍由 classifyLink 做
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node instanceof Element && node.hasAttribute('target')) {
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/** on* 事件属性一律不留：净化的主要目标就是它们 */
function config() {
  return {
    FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus', 'onanimationstart'],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'base', 'form'],
    ALLOW_DATA_ATTR: false,
    USE_PROFILES: { html: true, svg: true, svgFilters: true },
  };
}

/** 笔记正文渲染出来的 HTML */
export function sanitizeMarkdown(html: string): string {
  ensureHooks();
  return DOMPurify.sanitize(html, config());
}

/** 内核的富输出（text/html、image/svg+xml） */
export function sanitizeOutput(html: string): string {
  ensureHooks();
  return DOMPurify.sanitize(html, config());
}
