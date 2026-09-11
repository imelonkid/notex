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

/**
 * 容错解码。链接里出现未编码的 % 时 decodeURIComponent 会抛 URIError，
 * 而链接文本来自笔记正文，什么都可能写——解不开就按原样用，绝不能抛。
 */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function protocolOf(href: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*:)/i.exec(href.trim());
  return m ? m[1].toLowerCase() : null;
}

export function classifyLink(rawHref: string): LinkKind {
  const href = rawHref.trim();
  if (!href) return { kind: 'blocked', reason: '空链接' };

  // 纯锚点
  if (href.startsWith('#')) {
    return { kind: 'anchor', target: safeDecode(href.slice(1)) };
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
      target: safeDecode(href.slice(0, hashAt)),
      hash: safeDecode(href.slice(hashAt + 1)),
    };
  }
  return { kind: 'internal', target: safeDecode(href) };
}

/** 把标题文本转成可作为锚点的 id，与 Markdown 渲染时的规则保持一致 */
export function headingSlug(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[\s]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '');
}

/** 供解析用的笔记条目 */
export interface LinkTarget {
  id: string;
  title: string;
  /** 所在目录，用于同名笔记的消歧 */
  dir?: string;
}

/**
 * 把站内链接的写法解析成笔记 id。
 *
 * 有了目录之后按这个顺序找：
 * 1. 相对当前笔记所在目录的路径
 * 2. 相对笔记库根的路径
 * 3. 按名字匹配，同名时优先同目录的那个
 * 4. 忽略大小写再试一遍
 *
 * 找不到返回 null，由调用方提示断链，而不是跳到一篇不相干的笔记。
 */
export function resolveNoteLink(
  target: string,
  notes: LinkTarget[],
  fromDir = '',
): string | null {
  const cleaned = target
    .trim()
    .replace(/^\.\//, '')
    .replace(/\.md$/i, '');
  if (!cleaned) return null;

  // 1. 相对当前目录
  if (fromDir) {
    const relative = `${fromDir}/${cleaned}`;
    const hit = notes.find((n) => n.id === relative);
    if (hit) return hit.id;
  }

  // 2. 相对笔记库根
  const exact = notes.find((n) => n.id === cleaned);
  if (exact) return exact.id;

  // 3. 按名字，同名优先同目录
  const byTitle = notes.filter((n) => n.title === cleaned);
  if (byTitle.length) {
    const sameDir = byTitle.find((n) => (n.dir ?? '') === fromDir);
    return (sameDir ?? byTitle[0]).id;
  }

  // 4. 忽略大小写
  const lower = cleaned.toLowerCase();
  const loose = notes.filter(
    (n) => n.id.toLowerCase() === lower || n.title.toLowerCase() === lower,
  );
  if (!loose.length) return null;
  const sameDir = loose.find((n) => (n.dir ?? '') === fromDir);
  return (sameDir ?? loose[0]).id;
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

const WIKI_RE = /\[\[([^\]\n|#]+?)(#[^\]\n|]*)?(\|[^\]\n]*)?\]\]/g;
const MD_RE = /\[([^\]\n]*)\]\(([^)\s]+)((?:\s+"[^"]*")?)\)/g;
/** 行内代码：反引号数量要配对 */
const INLINE_CODE_RE = /(`+)[^`\n]*?\1/g;

/**
 * 改写正文里的站内链接。笔记改名或移动后，指向它的 `[[旧名]]` 与 `[文字](旧路径.md)`
 * 都要跟上，否则一次改名就留下一堆断链。
 *
 * `rewrite` 收到链接里写的目标（不含小节锚点），返回新写法；返回 null 表示这条不动。
 * 围栏代码块和行内代码里的内容不碰，那里的方括号不是链接。
 */
export function rewriteNoteLinks(
  markdown: string,
  rewrite: (target: string) => string | null,
): { text: string; count: number } {
  let count = 0;

  const rewriteSegment = (segment: string): string =>
    segment
      .replace(WIKI_RE, (all, target: string, hash?: string, label?: string) => {
        const next = rewrite(target.trim());
        if (next === null) return all;
        count += 1;
        return `[[${next}${hash ?? ''}${label ?? ''}]]`;
      })
      .replace(MD_RE, (all, text: string, href: string, title: string) => {
        const link = classifyLink(href);
        if (link.kind !== 'internal') return all;
        const next = rewrite(link.target);
        if (next === null) return all;
        count += 1;
        // 沿用原链接的写法：原来百分号编码的继续编码，原来直接写中文的继续写中文
        const encode = href.includes('%') ? encodeURI : (s: string) => s.replace(/ /g, '%20');
        const hash = link.hash !== undefined ? `#${encode(link.hash)}` : '';
        return `[${text}](${encode(next)}${hash}${title})`;
      });

  const rewriteLine = (line: string): string => {
    // 行内代码原样保留，其余片段改写
    let out = '';
    let last = 0;
    INLINE_CODE_RE.lastIndex = 0;
    for (let m = INLINE_CODE_RE.exec(line); m; m = INLINE_CODE_RE.exec(line)) {
      out += rewriteSegment(line.slice(last, m.index)) + m[0];
      last = m.index + m[0].length;
    }
    return out + rewriteSegment(line.slice(last));
  };

  const lines = markdown.split('\n');
  let fence: string | null = null;
  const result = lines.map((line) => {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && line.trim().startsWith(fence)) fence = null;
      return line;
    }
    if (open) {
      fence = open[1];
      return line;
    }
    return rewriteLine(line);
  });
  return { text: result.join('\n'), count };
}

/**
 * 改名或移动后，别的笔记里的链接该改成什么写法。
 *
 * 原来按名字写的（`[[项目A]]`）仍按名字写，除非新名字和别的笔记重了，那就写全路径；
 * 原来写路径的继续写路径；原来带 `.md` 的继续带。尽量不改变用户的书写习惯。
 */
export function nextLinkTarget(
  oldTarget: string,
  newId: string,
  notes: LinkTarget[],
): string {
  const hadMd = /\.md$/i.test(oldTarget);
  const bareName = !oldTarget.replace(/^\.\//, '').includes('/');
  const newTitle = newId.slice(newId.lastIndexOf('/') + 1);
  const ambiguous = notes.filter((n) => n.title === newTitle).length > 1;
  const next = bareName && !ambiguous ? newTitle : newId;
  return hadMd ? `${next}.md` : next;
}
