/**
 * 链接分类。
 *
 * 笔记正文和富输出里的 HTML 都可能带链接，而且内容可能来自导入的文件，
 * 所以这里按"只放行明确安全的协议"来判断，其余一律拒绝。
 */

export type LinkKind =
  | { kind: 'external'; url: string }
  /** 当前笔记内的锚点，值是去掉 # 的目标 */
  | { kind: 'anchor'; target: string }
  /** 指向另一篇笔记，target 是原始写法，解析留给后续阶段 */
  | { kind: 'internal'; target: string; hash?: string }
  /** 不认识或不安全，一律不处理 */
  | { kind: 'blocked'; reason: string };

/** 只有这三种协议允许交给系统打开 */
const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/**
 * 明确拒绝的协议。javascript: 和 data: 能执行脚本，
 * file: 能读本机任意文件，都不该由笔记内容触发。
 */
const DENIED_PROTOCOLS = new Set([
  'javascript:',
  'data:',
  'file:',
  'vbscript:',
  'blob:',
  'about:',
]);

function protocolOf(href: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec(href.trim());
  return m ? m[1].toLowerCase() : null;
}

export function classifyLink(rawHref: string): LinkKind {
  const href = rawHref.trim();
  if (!href) return { kind: 'blocked', reason: '空链接' };

  // 纯锚点
  if (href.startsWith('#')) {
    return { kind: 'anchor', target: decodeURIComponent(href.slice(1)) };
  }

  const protocol = protocolOf(href);

  if (protocol) {
    if (DENIED_PROTOCOLS.has(protocol)) {
      return { kind: 'blocked', reason: `不允许的协议 ${protocol}` };
    }
    if (SAFE_PROTOCOLS.has(protocol)) {
      return { kind: 'external', url: href };
    }
    // 其它自定义协议（slack:、zoom: 之类）不放行：
    // 它们能唤起本机应用，风险和收益不成比例
    return { kind: 'blocked', reason: `未知协议 ${protocol}` };
  }

  // 协议相对写法 //example.com 等同于 https
  if (href.startsWith('//')) {
    return { kind: 'external', url: 'https:' + href };
  }

  // 剩下的都是相对路径，指向库内的另一篇笔记
  const hashAt = href.indexOf('#');
  if (hashAt >= 0) {
    return {
      kind: 'internal',
      target: decodeURIComponent(href.slice(0, hashAt)),
      hash: decodeURIComponent(href.slice(hashAt + 1)),
    };
  }
  return { kind: 'internal', target: decodeURIComponent(href) };
}

/** 把标题文本转成可作为锚点的 id，与 Markdown 渲染时的规则保持一致 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '');
}

/** 供解析用的笔记条目，只需要 id 和标题 */
export interface LinkTarget {
  id: string;
  title: string;
}

/**
 * 把站内链接的写法解析成笔记 id。
 *
 * 依次尝试：原样、去掉 .md、去掉 ./ 前缀、忽略大小写匹配标题。
 * 找不到返回 null，由调用方提示断链，而不是跳到一篇不相干的笔记。
 */
export function resolveNoteLink(target: string, notes: LinkTarget[]): string | null {
  const cleaned = target
    .trim()
    .replace(/^\.\//, '')
    .replace(/\.md$/i, '');
  if (!cleaned) return null;

  const exact = notes.find((n) => n.id === cleaned);
  if (exact) return exact.id;

  const byTitle = notes.find((n) => n.title === cleaned);
  if (byTitle) return byTitle.id;

  const lower = cleaned.toLowerCase();
  const insensitive = notes.find(
    (n) => n.id.toLowerCase() === lower || n.title.toLowerCase() === lower,
  );
  return insensitive ? insensitive.id : null;
}

/**
 * 把 [[笔记名]] 与 [[笔记名#小节]] 转成普通链接，交给 Markdown 渲染器。
 * 在渲染前做，这样后续的链接拦截对两种写法一视同仁。
 */
export function expandWikiLinks(markdown: string): string {
  return markdown.replace(/\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g, (_all, target, label) => {
    const href = String(target).trim();
    const text = (label ?? target).toString().trim();
    return `[${escapeMd(text)}](${encodeURI(href)})`;
  });
}

/** 链接文字里的方括号会破坏 Markdown 结构 */
function escapeMd(text: string): string {
  return text.replace(/([[\]])/g, '\\$1');
}
