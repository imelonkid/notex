import { type LinkTarget, classifyLink, resolveNoteLink, safeDecode } from './links';
import { dirOf } from './store/paths';

/**
 * 全库的链接索引：谁指向了谁。
 * 反链面板和断链提示都读它。
 */

export interface OutLink {
  /** 链接里写的原始目标 */
  target: string;
  /** 解析到的笔记 id；解析不到为 null，就是断链 */
  resolved: string | null;
  /** 小节锚点 */
  hash?: string;
}

export interface Backlink {
  /** 来源笔记 id */
  from: string;
  /** 来源笔记里写的链接文字 */
  text: string;
}

/** 去掉围栏代码块，避免把代码里的方括号当成链接 */
export function stripCodeFences(markdown: string): string {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (open && line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (open) {
      fence = open[1];
      continue;
    }
    // 行内代码同理
    out.push(line.replace(/`[^`\n]*`/g, ''));
  }
  return out.join('\n');
}

const WIKI_LINK = /\[\[([^\]\n|]+?)(?:\|[^\]\n]*?)?\]\]/g;
const MD_LINK = /\[[^\]\n]*?\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/**
 * 抽出一篇笔记里指向其它笔记的链接。
 * 外部链接与纯锚点不算，它们不构成文档之间的关系。
 */
export function extractLinks(markdown: string): Array<{ target: string; hash?: string }> {
  const body = stripCodeFences(markdown);
  const found: Array<{ target: string; hash?: string }> = [];
  const seen = new Set<string>();

  const push = (raw: string) => {
    const link = classifyLink(raw);
    if (link.kind !== 'internal') return;
    const key = link.target + '#' + (link.hash ?? '');
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ target: link.target, hash: link.hash });
  };

  WIKI_LINK.lastIndex = 0;
  for (let m = WIKI_LINK.exec(body); m; m = WIKI_LINK.exec(body)) push(m[1].trim());
  MD_LINK.lastIndex = 0;
  for (let m = MD_LINK.exec(body); m; m = MD_LINK.exec(body)) push(safeDecode(m[1].trim()));

  return found;
}

/** 一篇笔记在索引里的记录 */
interface Entry {
  links: OutLink[];
  /** 建索引时文件的修改时间，用于增量更新 */
  stamp: string;
}

export class LinkIndex {
  private entries = new Map<string, Entry>();
  private notes: LinkTarget[] = [];

  /** 全量重建时先更新笔记清单，解析才有依据 */
  setNotes(notes: LinkTarget[]): void {
    this.notes = notes;
  }

  /** 记录某篇笔记的出链 */
  put(id: string, markdown: string, stamp = ''): void {
    const fromDir = dirOf(id);
    const links = extractLinks(markdown).map<OutLink>((l) => ({
      target: l.target,
      hash: l.hash,
      resolved: resolveNoteLink(l.target, this.notes, fromDir),
    }));
    this.entries.set(id, { links, stamp });
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  /** 只保留仍然存在的笔记，删掉的来源不该再产生反链 */
  retain(ids: Set<string>): boolean {
    let removed = false;
    for (const id of [...this.entries.keys()]) {
      if (!ids.has(id)) {
        this.entries.delete(id);
        removed = true;
      }
    }
    return removed;
  }

  stampOf(id: string): string | undefined {
    return this.entries.get(id)?.stamp;
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  /** 笔记改名或移动后，已建的解析结果会失效，重算一遍 */
  reresolve(): void {
    for (const [id, entry] of this.entries) {
      const fromDir = dirOf(id);
      entry.links = entry.links.map((l) => ({
        ...l,
        resolved: resolveNoteLink(l.target, this.notes, fromDir),
      }));
      this.entries.set(id, entry);
    }
  }

  outLinks(id: string): OutLink[] {
    return this.entries.get(id)?.links ?? [];
  }

  /** 指向这篇笔记的其它笔记 */
  backlinks(id: string): Backlink[] {
    const out: Backlink[] = [];
    for (const [from, entry] of this.entries) {
      if (from === id) continue;
      for (const link of entry.links) {
        if (link.resolved === id) {
          out.push({ from, text: link.target });
          break;
        }
      }
    }
    return out.sort((a, b) => a.from.localeCompare(b.from));
  }

  /** 全库的断链，用于将来做体检 */
  brokenLinks(): Array<{ from: string; target: string }> {
    const out: Array<{ from: string; target: string }> = [];
    for (const [from, entry] of this.entries) {
      for (const link of entry.links) {
        if (!link.resolved) out.push({ from, target: link.target });
      }
    }
    return out;
  }

  get size(): number {
    return this.entries.size;
  }
}
