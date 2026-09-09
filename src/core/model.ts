/** 笔记数据模型。纯数据，无 DOM / 无宿主依赖。 */

export type LangId = 'java' | 'python' | 'js';

export const LANGS: { id: LangId; label: string; short: string }[] = [
  { id: 'java', label: 'Java', short: 'JAVA' },
  { id: 'python', label: 'Python', short: 'PY' },
  { id: 'js', label: 'JavaScript', short: 'JS' },
];

export type Output =
  | { type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { type: 'result'; data: Record<string, string> }
  | { type: 'display'; data: Record<string, string> }
  | { type: 'error'; ename: string; evalue: string; traceback: string[] }
  /** 运行时缺失时的引导卡片，由 UI 特殊渲染 */
  | { type: 'missing-runtime'; lang: LangId }
  /** 依赖解析的提示信息 */
  | { type: 'notice'; level: 'info' | 'warn'; text: string };

export interface MarkdownCell {
  id: string;
  type: 'md';
  source: string;
}

export interface CodeCell {
  id: string;
  type: 'code';
  lang: LangId;
  source: string;
  outputs: Output[];
  execN?: number;
  /** 产生当前 outputs 的语言，用于提示"上次以 X 运行" */
  ranWith?: LangId;
}

export type Cell = MarkdownCell | CodeCell;

/**
 * 笔记的隐藏元数据。写在 frontmatter 里，随文件走，界面不渲染。
 * 用来维护文档之间的关系等信息，字段可以按需扩展。
 */
export interface NoteMeta {
  /**
   * 稳定标识，创建时生成后不再变。
   * 文件改名或移动都不影响它，是将来做重命名不断链的基础。
   */
  uid?: string;
  /** 别名，供链接按别名引用 */
  aliases?: string[];
  tags?: string[];
  /** 留给后续扩展，未知字段原样保留 */
  [key: string]: unknown;
}

export interface Notebook {
  id: string;
  title: string;
  cells: Cell[];
  counter: number;
  created: string;
  updated: string;
  meta?: NoteMeta;
}

export interface Workspace {
  activeId: string;
  notebooks: Notebook[];
}

/** 笔记的稳定标识，与文件名无关 */
export function newNoteUid(): string {
  const rand =
    globalThis.crypto?.randomUUID?.() ??
    Math.random().toString(36).slice(2) + Date.now().toString(36);
  return rand.replace(/-/g, '').slice(0, 22);
}

let seq = 0;
export function uid(prefix = 'c'): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
}

/**
 * 代码 cell 的执行状态，决定装订线上序号的颜色。
 * 参考 Jupyter 的 [ ] / [*] / [n]，但用颜色额外区分成功与失败。
 */
export type CellStatus = 'idle' | 'running' | 'ok' | 'error' | 'aborted';

export function cellStatus(cell: Cell, running: boolean): CellStatus {
  if (running) return 'running';
  if (cell.type !== 'code') return 'idle';
  const err = cell.outputs.find((o) => o.type === 'error');
  if (err && err.type === 'error') {
    // 中断不是失败，用不同的颜色提示
    return err.ename === 'KeyboardInterrupt' ? 'aborted' : 'error';
  }
  if (cell.outputs.some((o) => o.type === 'missing-runtime')) return 'error';
  return cell.execN ? 'ok' : 'idle';
}

/** 装订线上显示的标记 */
export function cellBadge(cell: Cell, running: boolean): string {
  if (running) return '[*]';
  if (cell.type !== 'code') return '';
  return cell.execN ? `[${cell.execN}]` : '[ ]';
}

export function isCode(cell: Cell): cell is CodeCell {
  return cell.type === 'code';
}

export function newMarkdownCell(source = ''): MarkdownCell {
  return { id: uid('c'), type: 'md', source };
}

export function newCodeCell(lang: LangId = 'java', source = ''): CodeCell {
  return { id: uid('c'), type: 'code', lang, source, outputs: [] };
}

export function newNotebook(title = '未命名笔记'): Notebook {
  const now = new Date().toISOString();
  return {
    id: uid('nb'),
    title,
    counter: 0,
    created: now,
    updated: now,
    meta: { uid: newNoteUid() },
    cells: [],
  };
}

export function findNotebook(ws: Workspace): Notebook {
  return ws.notebooks.find((n) => n.id === ws.activeId) ?? ws.notebooks[0];
}
