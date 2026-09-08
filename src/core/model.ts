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

export interface Notebook {
  id: string;
  title: string;
  cells: Cell[];
  counter: number;
  created: string;
  updated: string;
}

export interface Workspace {
  activeId: string;
  notebooks: Notebook[];
}

let seq = 0;
export function uid(prefix = 'c'): string {
  seq += 1;
  return `${prefix}${Date.now().toString(36)}${seq.toString(36)}`;
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
    cells: [newMarkdownCell('# ' + title + '\n\n双击这里开始编辑。'), newCodeCell('java', '')],
  };
}

export function findNotebook(ws: Workspace): Notebook {
  return ws.notebooks.find((n) => n.id === ws.activeId) ?? ws.notebooks[0];
}
