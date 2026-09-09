import { useEffect } from 'react';
import { classifyLink, headingSlug } from '@core/links';
import type { HostBridge } from '@host/HostBridge';

interface Options {
  host: HostBridge;
  /** 指向其它笔记的链接，解析与跳转由调用方决定 */
  onInternal(target: string, hash?: string): void;
  /** 被拦下的链接，用于给出提示 */
  onBlocked?(href: string, reason: string): void;
}

/**
 * 在应用根上统一拦截 <a> 的点击。
 *
 * 必须拦截，而不是给链接加 target="_blank"：桌面版的 webview 一旦自己导航，
 * 整个应用界面就被网页替换掉，且没有后退入口。
 * 用事件委托而不是逐个绑定，因为链接可能出现在正文、富输出等多处，
 * 而且这些内容是 innerHTML 渲染出来的。
 */
export function useLinkInterceptor({ host, onInternal, onBlocked }: Options) {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0) return;
      const anchor = (e.target as HTMLElement | null)?.closest?.('a');
      if (!anchor) return;

      const href = anchor.getAttribute('href');
      if (href === null) return;

      // 无论哪一类都先拦下，绝不让 webview 自己导航
      e.preventDefault();

      const link = classifyLink(href);
      switch (link.kind) {
        case 'external':
          void host.openExternal(link.url).catch((err) => {
            console.warn('[NoteX] 打开外部链接失败', link.url, err);
          });
          break;
        case 'anchor':
          if (!scrollToHeading(link.target)) {
            onBlocked?.(href, `找不到小节「${link.target}」`);
          }
          break;
        case 'internal':
          onInternal(link.target, link.hash);
          break;
        case 'blocked':
          onBlocked?.(href, link.reason);
          console.warn('[NoteX] 已拦截链接', href, link.reason);
          break;
      }
    };

    // 捕获阶段处理，抢在其它组件之前
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, [host, onInternal, onBlocked]);
}

/**
 * 平滑滚动依赖动画帧：页面不可见或系统开了减弱动效时不会执行，
 * 那种情况下直接定位，保证跳转一定发生。
 */
function scrollBehavior(): ScrollBehavior {
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  return document.visibilityState === 'visible' && !reduced ? 'smooth' : 'auto';
}

/** 滚动到当前笔记里匹配的标题 */
function scrollToHeading(target: string): boolean {
  const wanted = headingSlug(target);
  const headings = document.querySelectorAll<HTMLElement>(
    '.nx-md h1, .nx-md h2, .nx-md h3, .nx-md h4, .nx-md h5, .nx-md h6',
  );
  for (const h of headings) {
    if (h.id === target || headingSlug(h.textContent ?? '') === wanted) {
      h.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
      return true;
    }
  }
  return false;
}

/** 供组件在切换笔记后补滚动用；返回是否找到了目标小节 */
export function scrollToHeadingText(target: string): boolean {
  return scrollToHeading(target);
}
