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

const KEY = 'notex.workspace.v1';

function seed(): Workspace {
  const nb: Notebook = {
    id: 'nb-welcome',
    title: '欢迎使用 NoteX',
    counter: 0,
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    cells: [
      newMarkdownCell(
        '# 欢迎使用 NoteX\n\n' +
          '文本用 Markdown 书写，代码直接在页面里运行。点代码块上的**运行**试试。\n\n' +
          '- 双击文本 cell 进入编辑，`Shift+Enter` 回到预览，点开别处也会自动预览\n' +
          '- 代码 cell 里 `Shift+Enter` 运行，运行中按**中断**可以停下来\n' +
          '- 用左上角的 tab 切换 **Java / Python / JS**，源码不会丢失\n' +
          '- 输入时会调用对应内核做补全，`Ctrl+Space` 强制触发\n' +
          '- 拖左侧 ⠿ 排序，改动自动保存在本地',
      ),
      newMarkdownCell('## 三种语言\n\n每个代码 cell 独立选择语言和内核。三个内核互不共享变量，这是刻意的简化。'),
      newCodeCell(
        'java',
        'var squares = new java.util.ArrayList<Integer>();\n' +
          'for (int i = 1; i <= 10; i++) squares.add(i * i);\n' +
          'System.out.println("平方数: " + squares);\n' +
          'squares.stream().mapToInt(Integer::intValue).sum()',
      ),
      newCodeCell(
        'python',
        "squares = [n * n for n in range(1, 11)]\nprint('平方数:', squares)\nsum(squares)",
      ),
      newCodeCell(
        'js',
        'const squares = Array.from({ length: 10 }, (_, i) => (i + 1) ** 2);\n' +
          "console.log('平方数:', squares.join(', '));\n" +
          'squares.reduce((a, b) => a + b, 0)',
      ),
      newMarkdownCell(
        '## 富输出\n\n返回值是集合或映射时会渲染成表格，是图像时渲染成 PNG。Python 的 `_repr_html_`、JS 的 `toHTML()` 同样生效。',
      ),
      newCodeCell(
        'java',
        'java.util.List.of(\n' +
          '  java.util.Map.of("语言", "Java", "内核", "JShell"),\n' +
          '  java.util.Map.of("语言", "Python", "内核", "本机解释器"),\n' +
          '  java.util.Map.of("语言", "JavaScript", "内核", "Node vm")\n' +
          ')',
      ),
      newCodeCell(
        'java',
        'var im = new java.awt.image.BufferedImage(120, 60, java.awt.image.BufferedImage.TYPE_INT_RGB);\n' +
          'var g = im.createGraphics();\n' +
          'g.setColor(java.awt.Color.decode("#fdfdfc"));\n' +
          'g.fillRect(0, 0, 120, 60);\n' +
          'g.setColor(java.awt.Color.decode("#3f5a7d"));\n' +
          'g.fillOval(8, 8, 44, 44);\n' +
          'g.setColor(java.awt.Color.decode("#9c3423"));\n' +
          'g.fillOval(64, 8, 44, 44);\n' +
          'g.dispose();\n' +
          'im',
      ),
      newMarkdownCell(
        '## Java 依赖\n\n在 cell 顶部用 `//DEPS` 声明 Maven 坐标，运行前会自动下载并注入类路径。' +
          '装了 Maven 会做完整的传递依赖解析。第一次运行需要等下载。',
      ),
      newCodeCell(
        'java',
        '//DEPS org.apache.commons:commons-lang3:3.14.0\n\n' +
          'import org.apache.commons.lang3.StringUtils;\n' +
          'System.out.println(StringUtils.reverse("NoteX"));\n' +
          'StringUtils.capitalize("来自 maven 的依赖")',
      ),
      newMarkdownCell(
        '## 试试中断\n\n下面这个 cell **不会自己停下来**。点**运行**，再点**中断**，' +
          '内核不会挂掉，之前 cell 里的变量也还在。\n\n' +
          '> 因为它是死循环，**全部运行**走到这里会停在这一步，等你手动中断。',
      ),
      newCodeCell('python', 'n = 0\nwhile True:\n    n += 1'),
      newMarkdownCell(
        '## 还能做什么\n\n' +
          '- 左下角能看到三种运行时的状态，点开是设置：切换主题、手动指定运行时路径、重启内核\n' +
          '- 上方可以导出 Markdown 或 ipynb，也能把它们导入回来\n' +
          '- 把主题包 JSON 放进 `~/.notex/themes/` 就会自动出现在设置里',
      ),
    ],
  };
  return { activeId: nb.id, notebooks: [nb] };
}

/**
 * localStorage 里是否真的存过工作区。
 * loadWorkspace 在没有数据时会返回种子，迁移必须区分这两种情况，
 * 否则新装的客户端会把种子笔记写进 vault。
 */
export function hasStoredWorkspace(): boolean {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
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
