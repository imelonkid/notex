/**
 * 粘贴富文本：把剪贴板里的 HTML 转成 Markdown。
 *
 * 从网页复制一段带图片和代码块的内容，粘进纯 textarea 只剩 text/plain，
 * 标题、加粗、图片、代码块全没了。这里接管 text/html 那一份，转成 Markdown，
 * 图片地址先补成绝对地址，随后由调用方下载进笔记库并改写成相对路径。
 */
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

let service: TurndownService | null = null;

function turndown(): TurndownService {
  if (service) return service;
  service = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    fence: '```',
    bulletListMarker: '-',
    emDelimiter: '*',
    strongDelimiter: '**',
    hr: '---',
  });
  service.use(gfm);
  // 网页里常见的一堆装饰性元素，转出来只是噪音
  service.remove(['script', 'style', 'noscript', 'button', 'nav', 'iframe']);
  service.remove((node) => node.nodeName.toLowerCase() === 'svg');
  // 代码块的语言：<pre><code class="language-xxx"> 或 highlight.js 的 class="hljs xxx"
  service.addRule('fencedWithLang', {
    filter: (node) => node.nodeName === 'PRE' && !!node.firstChild && node.firstChild.nodeName === 'CODE',
    replacement: (_content, node) => {
      const code = node.firstChild as HTMLElement;
      const cls = code.getAttribute('class') ?? '';
      const lang = /(?:language|lang)-([\w+-]+)/.exec(cls)?.[1] ?? '';
      const text = (code.textContent ?? '').replace(/\n$/, '');
      return `\n\n\`\`\`${lang}\n${text}\n\`\`\`\n\n`;
    },
  });
  // <img> 保留 alt 和 src；宽高之类的属性没有 Markdown 对应物，扔掉
  service.addRule('image', {
    filter: 'img',
    replacement: (_content, node) => {
      const el = node as HTMLElement;
      const src = el.getAttribute('src') ?? el.getAttribute('data-src') ?? '';
      if (!src) return '';
      const alt = (el.getAttribute('alt') ?? '').replace(/[[\]]/g, '');
      return `![${alt}](${src})`;
    },
  });
  return service;
}

/** 相对地址补成绝对地址；补不了的原样返回 */
function absolutize(url: string, base?: string): string {
  if (!base || /^(?:[a-z]+:|#)/i.test(url)) return url;
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/**
 * HTML → Markdown。base 是来源页面地址，用来把 `/images/a.jpg` 这类相对路径补全；
 * 浏览器复制出来的 HTML 大多已经是绝对地址，但不能指望。
 */
export function htmlToMarkdown(html: string, base?: string): string {
  // Windows 的剪贴板会在 HTML 前面加一段 "Version:0.9 / StartHTML / SourceURL" 头，
  // 那不是内容；浏览器塞进来的还常带 <!--StartFragment--> 标记
  let cleaned = html;
  if (/^Version:\d/.test(cleaned)) {
    const start = cleaned.search(/<(?:!doctype|html|body|!--\s*StartFragment)/i);
    if (start > 0) cleaned = cleaned.slice(start);
  }
  cleaned = cleaned.replace(/<!--\s*(Start|End)Fragment\s*-->/g, '');
  const md = turndown().turndown(cleaned);
  const withUrls = md
    .replace(/!\[([^\]]*)\]\(([^)\s]+)([^)]*)\)/g, (_m, alt: string, src: string, rest: string) => `![${alt}](${absolutize(src, base)}${rest})`)
    .replace(/(^|[^!])\[([^\]]*)\]\(([^)\s]+)([^)]*)\)/g, (_m, pre: string, text: string, href: string, rest: string) => `${pre}[${text}](${absolutize(href, base)}${rest})`);
  return (
    withUrls
      // turndown 的列表标记后面跟三个空格，对齐是对齐了，写 Markdown 的人没人这么写
      .replace(/^(\s*(?:[-*+]|\d+\.))\s{2,}(?=\S)/gm, '$1 ')
      // `**输入：**l1` 按 CommonMark 不算加粗：闭合的 ** 前面是标点、后面紧跟字母，
      // 不是"右侧翼"。网页里 <strong>输入：</strong>l1 太常见了，补一个空格让它成立
      .replace(/(\*\*[^*\n]*?\p{P})\*\*(?=[\p{L}\p{N}])/gu, '$1** ')
      .replace(/(?<=[\p{L}\p{N}])\*\*(?=\p{P}[^*\n]*?\*\*)/gu, ' **')
      // 只有空白的行等于空行，别让它们撑出多余的段距
      .replace(/^[ \t]+$/gm, '')
      // 连续三个以上空行压成一个空行；网页里嵌套的 div 会留下大片空白
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  );
}

export interface ImageRef {
  /** 图片地址原文：http(s) 或 data: */
  src: string;
  alt: string;
}

/** Markdown 里所有需要落地的图片：远程地址和内嵌的 data: */
export function findImageRefs(markdown: string): ImageRef[] {
  const out: ImageRef[] = [];
  const seen = new Set<string>();
  for (const m of markdown.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const src = m[2];
    if (!/^(?:https?:|data:image\/)/i.test(src) || seen.has(src)) continue;
    seen.add(src);
    out.push({ src, alt: m[1] });
  }
  return out;
}

/** 把某个图片地址替换成本地相对路径（所有出现处一起换） */
export function replaceImageSrc(markdown: string, from: string, to: string): string {
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return markdown.replace(new RegExp(`(!\\[[^\\]]*\\]\\()${escaped}(\\s+"[^"]*")?\\)`, 'g'), `$1${to}$2)`);
}

/** 剪贴板里 HTML 的来源地址（Chrome 会写在 SourceURL 里），找不到返回 undefined */
export function sourceUrlOf(html: string): string | undefined {
  const m = /SourceURL:\s*(\S+)/.exec(html);
  return m?.[1];
}
