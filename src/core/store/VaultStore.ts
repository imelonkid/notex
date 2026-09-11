import type { HostBridge } from '../../host/HostBridge';
import { type Notebook, newNoteUid, uid } from '../model';
import {
  applyOutputsJson,
  markdownToNotebook,
  notebookToMarkdown,
  outputsToJson,
} from '../serialize';
import {
  MAX_DIR_DEPTH,
  baseOf,
  compareNames,
  depthOf,
  dirOf,
  joinId,
  safeSegments,
  shouldSkipDir,
} from './paths';
import type { NotebookRef, NotebookStore, VaultListing } from './types';

const MD_EXT = '.md';
/** 目录再深就不再往下扫，防止符号链接成环 */
const MAX_DEPTH = 8;

/** 文件名里不能出现的字符换成下划线；空标题给个兜底名 */
export function slugify(title: string): string {
  const cleaned = title
    .trim()
    .replace(/[/\\:*?"<>|\x00-\x1f]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 80)
    .trim();
  return cleaned || '未命名笔记';
}

/**
 * 笔记直接落到磁盘目录，支持多级子目录。
 * Markdown 是正本，输出存同目录下的同名旁车 JSON。
 * 笔记 id 是相对笔记库根的路径，不含扩展名，例如 "工作/周报"。
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

  /** 由 id 推导磁盘路径，顺带做越界校验 */
  private resolve(id: string, suffix: (base: string) => string): string {
    const parts = safeSegments(id);
    if (!parts) throw new Error(`非法的笔记路径：${id}`);
    const base = parts.pop()!;
    return this.host.joinPath(this.root, ...parts, suffix(base));
  }

  private mdPath(id: string): string {
    return this.resolve(id, (base) => base + MD_EXT);
  }

  /** 输出旁车文件以点开头，和笔记放在同一个目录，移动时自然跟随 */
  private outputsPath(id: string): string {
    return this.resolve(id, (base) => `.${base}.outputs.json`);
  }

  private dirPath(dir: string): string {
    if (!dir) return this.root;
    const parts = safeSegments(dir);
    if (!parts) throw new Error(`非法的目录路径：${dir}`);
    return this.host.joinPath(this.root, ...parts);
  }

  async init(): Promise<void> {
    await this.host.ensureDir(this.root);
  }

  /** 递归扫描笔记库，同时收集空目录，否则新建的文件夹会立刻消失 */
  async listAll(): Promise<VaultListing> {
    await this.host.ensureDir(this.root);
    const notes: NotebookRef[] = [];
    const folders: string[] = [];

    const walk = async (relDir: string): Promise<void> => {
      if (depthOf(relDir) >= MAX_DEPTH) return;
      let entries;
      try {
        entries = await this.host.listDir(this.dirPath(relDir));
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.isDir) {
          if (shouldSkipDir(entry.name)) continue;
          const child = joinId(relDir, entry.name);
          folders.push(child);
          await walk(child);
          continue;
        }
        if (!entry.name.endsWith(MD_EXT) || entry.name.startsWith('.')) continue;
        const name = entry.name.slice(0, -MD_EXT.length);
        notes.push({
          id: joinId(relDir, name),
          title: name,
          dir: relDir,
          updated: entry.modified,
        });
      }
    };

    await walk('');

    // 按名字排序，不按修改时间。
    // 按时间排的话，自动保存会让正在编辑的笔记不停跳到列表最前面。
    notes.sort((a, b) => compareNames(a.title, b.title));
    folders.sort((a, b) => compareNames(a, b));
    return { notes, folders };
  }

  async list(): Promise<NotebookRef[]> {
    return (await this.listAll()).notes;
  }

  async load(id: string): Promise<Notebook | null> {
    let markdown: string;
    try {
      markdown = await this.host.readText(this.mdPath(id));
    } catch {
      return null;
    }
    this.seen.set(id, (await this.host.statFile(this.mdPath(id))) ?? '');
    const nb = markdownToNotebook(markdown, baseOf(id));
    nb.id = id;
    // 标题以文件名为准，避免文件被改名后与 frontmatter 不一致
    nb.title = baseOf(id);
    try {
      const outputs = await this.host.readText(this.outputsPath(id));
      applyOutputsJson(nb, outputs);
    } catch {
      // 没有旁车文件说明还没运行过
    }
    return nb;
  }

  /** 只读原始 Markdown，建链接索引用；不读输出旁车，省一次往返 */
  async readRaw(id: string): Promise<string> {
    return await this.host.readText(this.mdPath(id));
  }

  /** 原样写回，并记下新的修改时间，免得被当成外部改动 */
  async writeRaw(id: string, markdown: string): Promise<void> {
    await this.host.writeText(this.mdPath(id), markdown);
    this.seen.set(id, (await this.host.statFile(this.mdPath(id))) ?? '');
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
    const hasOutputs = Object.keys(JSON.parse(outputs).cells ?? {}).length > 0;
    if (hasOutputs) {
      await this.host.writeText(this.outputsPath(nb.id), outputs);
    } else {
      // 没有任何输出就不留空文件
      await this.host.removeFile(this.outputsPath(nb.id)).catch(() => undefined);
    }
  }

  /** 同名时追加序号，不覆盖已有文件 */
  private async uniqueId(dir: string, base: string): Promise<string> {
    const taken = new Set((await this.list()).map((r) => r.id));
    const first = joinId(dir, base);
    if (!taken.has(first)) return first;
    for (let i = 2; i < 500; i += 1) {
      const candidate = joinId(dir, `${base} ${i}`);
      if (!taken.has(candidate)) return candidate;
    }
    return joinId(dir, `${base} ${uid('')}`);
  }

  async create(title: string, dir = ''): Promise<Notebook> {
    if (depthOf(dir) > MAX_DIR_DEPTH) throw new Error(`目录最多 ${MAX_DIR_DEPTH} 级`);
    await this.host.ensureDir(this.dirPath(dir));
    const id = await this.uniqueId(dir, slugify(title));
    const name = baseOf(id);
    const now = new Date().toISOString();
    const nb: Notebook = {
      id,
      title: name,
      created: now,
      updated: now,
      meta: { uid: newNoteUid() },
      // 不预置 cell：标题已经在侧栏和标题栏里，正文写什么由用户决定
      cells: [],
    };
    await this.save(nb);
    return nb;
  }

  /** 能进废纸篓就进废纸篓；宿主做不到才真删 */
  private async discard(path: string): Promise<void> {
    if (this.host.trash) await this.host.trash(path);
    else await this.host.removeFile(path);
  }

  async remove(id: string): Promise<void> {
    // 正文删不掉是真问题，必须抛出去；旁车文件本来就可能不存在
    await this.discard(this.mdPath(id));
    await this.discard(this.outputsPath(id)).catch(() => undefined);
    this.seen.delete(id);
  }

  /** 改标题只改文件名，留在原目录；换目录是 move */
  async retitle(id: string, title: string): Promise<string> {
    const wanted = slugify(title);
    if (wanted === baseOf(id)) return id;
    const nextId = await this.uniqueId(dirOf(id), wanted);
    await this.relocate(id, nextId);
    return nextId;
  }

  /** 移动到另一个目录，文件名不变 */
  async move(id: string, targetDir: string): Promise<string> {
    if (dirOf(id) === targetDir) return id;
    if (targetDir && !safeSegments(targetDir)) throw new Error(`非法的目录：${targetDir}`);
    if (depthOf(targetDir) > MAX_DIR_DEPTH) {
      throw new Error(`目录最多 ${MAX_DIR_DEPTH} 级`);
    }
    await this.host.ensureDir(this.dirPath(targetDir));
    const nextId = await this.uniqueId(targetDir, baseOf(id));
    await this.relocate(id, nextId);
    return nextId;
  }

  /** 改名与移动共用：搬正文、搬旁车、重写 frontmatter */
  private async relocate(id: string, nextId: string): Promise<void> {
    await this.host.renameFile(this.mdPath(id), this.mdPath(nextId));
    await this.host
      .renameFile(this.outputsPath(id), this.outputsPath(nextId))
      .catch(() => undefined);
    this.seen.delete(id);
    // 重写一遍让 frontmatter 里的标题跟上
    const nb = await this.load(nextId);
    if (nb) await this.save(nb);
  }

  /** 整个目录连同其中的一切移到废纸篓；宿主做不到才递归删除 */
  async removeFolder(dir: string): Promise<void> {
    if (!dir || !safeSegments(dir)) throw new Error(`非法的目录：${dir}`);
    if (this.host.trash) await this.host.trash(this.dirPath(dir));
    else await this.host.removeDir(this.dirPath(dir));
    for (const id of [...this.seen.keys()]) {
      if (id === dir || id.startsWith(dir + '/')) this.seen.delete(id);
    }
  }

  async createFolder(dir: string): Promise<void> {
    if (!safeSegments(dir)) throw new Error(`非法的目录名：${dir}`);
    if (depthOf(dir) > MAX_DIR_DEPTH) {
      throw new Error(`目录最多 ${MAX_DIR_DEPTH} 级，无法再往下建`);
    }
    await this.host.ensureDir(this.dirPath(dir));
  }

  /** 把一份已有的笔记写进笔记库，用于迁移或导入 */
  async adopt(nb: Notebook, dir = ''): Promise<string> {
    const id = await this.uniqueId(dir, slugify(nb.title));
    await this.save({ ...nb, id, title: baseOf(id) });
    return id;
  }
}
