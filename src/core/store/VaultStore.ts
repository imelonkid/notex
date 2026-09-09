import type { HostBridge } from '../../host/HostBridge';
import { type Notebook, newCodeCell, newMarkdownCell, uid } from '../model';
import {
  applyOutputsJson,
  markdownToNotebook,
  notebookToMarkdown,
  outputsToJson,
} from '../serialize';
import type { NotebookRef, NotebookStore } from './types';

const MD_EXT = '.md';

/** 文件名里不能出现的字符换成下划线；空标题给个兜底名 */
export function slugify(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .slice(0, 80)
    .trim();
  return cleaned || '未命名笔记';
}

/**
 * 笔记直接落到磁盘目录。Markdown 是正本，输出存同名旁车 JSON。
 * 笔记的 id 就是不含扩展名的文件名，因此改标题会连带重命名文件。
 */
export class VaultStore implements NotebookStore {
  readonly kind = 'vault';
  /** 每篇笔记最后一次读写时看到的文件时间，用于发现外部改动 */
  private seen = new Map<string, string>();

  constructor(
    private host: HostBridge,
    readonly root: string,
  ) {}

  get location(): string {
    return this.root;
  }

  private mdPath(id: string): string {
    return this.host.joinPath(this.root, id + MD_EXT);
  }

  /** 输出旁车文件以点开头，在文件管理器里不碍眼 */
  private outputsPath(id: string): string {
    return this.host.joinPath(this.root, `.${id}.outputs.json`);
  }

  async init(): Promise<void> {
    await this.host.ensureDir(this.root);
  }

  async list(): Promise<NotebookRef[]> {
    await this.host.ensureDir(this.root);
    const entries = await this.host.listDir(this.root);
    const refs: NotebookRef[] = [];
    for (const entry of entries) {
      if (entry.isDir || !entry.name.endsWith(MD_EXT) || entry.name.startsWith('.')) continue;
      const id = entry.name.slice(0, -MD_EXT.length);
      refs.push({ id, title: id, updated: entry.modified });
    }
    // 最近改动的排在前面
    refs.sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''));
    return refs;
  }

  async load(id: string): Promise<Notebook | null> {
    let markdown: string;
    try {
      markdown = await this.host.readText(this.mdPath(id));
    } catch {
      return null;
    }
    this.seen.set(id, (await this.host.statFile(this.mdPath(id))) ?? '');
    const nb = markdownToNotebook(markdown, id);
    nb.id = id;
    // 标题以文件名为准，避免文件被改名后与 frontmatter 不一致
    nb.title = id;
    try {
      const outputs = await this.host.readText(this.outputsPath(id));
      applyOutputsJson(nb, outputs);
    } catch {
      // 没有旁车文件说明还没运行过
    }
    return nb;
  }

  /** 文件是否在我们读入之后被别处改过 */
  async changedOutside(id: string): Promise<boolean> {
    const known = this.seen.get(id);
    if (known === undefined) return false;
    const now = (await this.host.statFile(this.mdPath(id))) ?? '';
    return now !== '' && now !== known;
  }

  async save(nb: Notebook): Promise<void> {
    await this.host.writeText(this.mdPath(nb.id), notebookToMarkdown(nb));
    this.seen.set(nb.id, (await this.host.statFile(this.mdPath(nb.id))) ?? '');
    const outputs = outputsToJson(nb);
    // 没有任何输出就不留空文件
    if (JSON.parse(outputs).cells && Object.keys(JSON.parse(outputs).cells).length > 0) {
      await this.host.writeText(this.outputsPath(nb.id), outputs);
    } else {
      await this.host.removeFile(this.outputsPath(nb.id)).catch(() => undefined);
    }
  }

  /** 同名时追加序号，不覆盖已有文件 */
  private async uniqueId(base: string): Promise<string> {
    const taken = new Set((await this.list()).map((r) => r.id));
    if (!taken.has(base)) return base;
    for (let i = 2; i < 500; i += 1) {
      const candidate = `${base} ${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${base} ${uid('')}`;
  }

  async create(title: string): Promise<Notebook> {
    await this.host.ensureDir(this.root);
    const id = await this.uniqueId(slugify(title));
    const now = new Date().toISOString();
    const nb: Notebook = {
      id,
      title: id,
      counter: 0,
      created: now,
      updated: now,
      cells: [newMarkdownCell(`# ${id}\n\n`), newCodeCell('python', '')],
    };
    await this.save(nb);
    return nb;
  }

  async remove(id: string): Promise<void> {
    // 正文删不掉是真问题，必须抛出去；旁车文件本来就可能不存在
    await this.host.removeFile(this.mdPath(id));
    await this.host.removeFile(this.outputsPath(id)).catch(() => undefined);
    this.seen.delete(id);
  }

  async retitle(id: string, title: string): Promise<string> {
    const wanted = slugify(title);
    if (wanted === id) return id;
    const nextId = await this.uniqueId(wanted);
    await this.host.renameFile(this.mdPath(id), this.mdPath(nextId));
    await this.host
      .renameFile(this.outputsPath(id), this.outputsPath(nextId))
      .catch(() => undefined);
    // 重写一遍让 frontmatter 里的标题跟上
    const nb = await this.load(nextId);
    if (nb) await this.save(nb);
    return nextId;
  }

  /** 把一份已有的笔记写进 vault，用于从 localStorage 迁移或导入 */
  async adopt(nb: Notebook): Promise<string> {
    const id = await this.uniqueId(slugify(nb.title));
    await this.save({ ...nb, id, title: id });
    return id;
  }
}
