import {
  type Cell,
  type CodeCell,
  type LangId,
  type Notebook,
  type Output,
  type Workspace,
  findNotebook,
  isCode,
  newCodeCell,
  newMarkdownCell,
  newNotebook,
  uid,
} from './model';

const KEY = 'xnotebook.workspace.v1';

function seed(): Workspace {
  const nb: Notebook = {
    id: 'nb-welcome',
    title: '欢迎使用 xnotebook',
    counter: 0,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    cells: [
      newMarkdownCell(
        '# 欢迎使用 xnotebook\n\n' +
          '文本用 Markdown 书写，代码可以直接在页面里运行。\n\n' +
          '- 双击任意文本 cell 进入编辑，`Shift+Enter` 完成\n' +
          '- 代码 cell 里按 `Shift+Enter` 运行\n' +
          '- 用代码 cell 左上角的 tab 切换 **Java / Python / JS**，源码不会丢失\n' +
          '- 输入时会调用对应内核做补全，`Ctrl+Space` 强制触发\n' +
          '- 拖动左侧 ⠿ 手柄调整顺序，所有改动自动保存在本地',
      ),
      newCodeCell(
        'java',
        'var squares = new java.util.ArrayList<Integer>();\n' +
          'for (int i = 1; i <= 10; i++) squares.add(i * i);\n' +
          'System.out.println("平方数: " + squares);\n' +
          'squares.stream().mapToInt(Integer::intValue).sum()',
      ),
      newMarkdownCell(
        '## 同一份笔记里混用语言\n\n每个代码 cell 独立选择语言和内核。三个内核互不共享变量，这是刻意的简化。',
      ),
      newCodeCell(
        'python',
        "squares = [n * n for n in range(1, 11)]\nprint('平方数:', squares)\nsum(squares)",
      ),
      newCodeCell(
        'js',
        "const squares = Array.from({ length: 10 }, (_, i) => (i + 1) ** 2);\n" +
          "console.log('平方数:', squares.join(', '));\n" +
          'squares.reduce((a, b) => a + b, 0)',
      ),
    ],
  };
  return { activeId: nb.id, notebooks: [nb] };
}

export function loadWorkspace(): Workspace {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Workspace;
      if (parsed?.notebooks?.length) return parsed;
    }
  } catch {
    /* 坏数据就重新播种 */
  }
  return seed();
}

export function saveWorkspace(ws: Workspace): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(ws));
  } catch {
    /* 配额满或无痕模式，静默失败 */
  }
}

/** 所有变更走这里，返回新的 Workspace（不可变更新，便于 React 比较） */
export function mutate(ws: Workspace, fn: (nb: Notebook) => void): Workspace {
  const next: Workspace = {
    activeId: ws.activeId,
    notebooks: ws.notebooks.map((n) =>
      n.id === ws.activeId ? { ...n, cells: n.cells.map((c) => ({ ...c })) } : n,
    ),
  };
  const nb = findNotebook(next);
  fn(nb);
  nb.updated = new Date().toISOString();
  return next;
}

export const actions = {
  setTitle: (ws: Workspace, title: string) => mutate(ws, (nb) => void (nb.title = title)),

  updateSource: (ws: Workspace, cellId: string, source: string) =>
    mutate(ws, (nb) => {
      const c = nb.cells.find((x) => x.id === cellId);
      if (c) c.source = source;
    }),

  setLang: (ws: Workspace, cellId: string, lang: LangId) =>
    mutate(ws, (nb) => {
      const c = nb.cells.find((x) => x.id === cellId);
      if (c && isCode(c)) c.lang = lang;
    }),

  setOutputs: (ws: Workspace, cellId: string, outputs: Output[], lang: LangId, bumpExec: boolean) =>
    mutate(ws, (nb) => {
      const c = nb.cells.find((x) => x.id === cellId);
      if (!c || !isCode(c)) return;
      c.outputs = outputs;
      c.ranWith = lang;
      if (bumpExec) {
        nb.counter += 1;
        c.execN = nb.counter;
      }
    }),

  insertCell: (ws: Workspace, index: number | null, type: 'md' | 'code', lang: LangId) => {
    const cell: Cell = type === 'md' ? newMarkdownCell() : newCodeCell(lang);
    return {
      ws: mutate(ws, (nb) => {
        nb.cells.splice(index == null ? nb.cells.length : index, 0, cell);
      }),
      id: cell.id,
    };
  },

  removeCell: (ws: Workspace, cellId: string) =>
    mutate(ws, (nb) => {
      nb.cells = nb.cells.filter((c) => c.id !== cellId);
      if (!nb.cells.length) nb.cells.push(newMarkdownCell(''));
    }),

  moveCell: (ws: Workspace, dragId: string, targetId: string | 'end') =>
    mutate(ws, (nb) => {
      const from = nb.cells.findIndex((c) => c.id === dragId);
      if (from < 0) return;
      const [cell] = nb.cells.splice(from, 1);
      let to = targetId === 'end' ? nb.cells.length : nb.cells.findIndex((c) => c.id === targetId);
      if (to < 0) to = nb.cells.length;
      nb.cells.splice(to, 0, cell);
    }),

  clearOutputs: (ws: Workspace) =>
    mutate(ws, (nb) => {
      for (const c of nb.cells) {
        if (isCode(c)) {
          c.outputs = [];
          c.execN = undefined;
          c.ranWith = undefined;
        }
      }
      nb.counter = 0;
    }),

  addNotebook: (ws: Workspace): Workspace => {
    const nb = newNotebook('未命名笔记 ' + (ws.notebooks.length + 1));
    return { activeId: nb.id, notebooks: [...ws.notebooks, nb] };
  },

  selectNotebook: (ws: Workspace, id: string): Workspace => ({ ...ws, activeId: id }),

  removeNotebook: (ws: Workspace, id: string): Workspace => {
    const rest = ws.notebooks.filter((n) => n.id !== id);
    if (!rest.length) {
      const nb = newNotebook();
      return { activeId: nb.id, notebooks: [nb] };
    }
    return { activeId: ws.activeId === id ? rest[0].id : ws.activeId, notebooks: rest };
  },
};

export function codeCells(nb: Notebook): CodeCell[] {
  return nb.cells.filter(isCode);
}

export { uid };
