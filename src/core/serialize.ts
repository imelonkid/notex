/**
 * Markdown 为正本的序列化。
 *
 * - Markdown cell 直接是正文
 * - Code cell 是围栏块，info string 形如 ```java {id=c2}
 * - outputs 不进 Markdown，由调用方存旁车 JSON
 */
import { type Cell, type CodeCell, type LangId, type Notebook, uid } from './model';

const FENCE_LANG: Record<LangId, string> = { java: 'java', python: 'python', js: 'javascript' };

const LANG_BY_FENCE: Record<string, LangId> = {
  java: 'java',
  python: 'python',
  py: 'python',
  javascript: 'js',
  js: 'js',
  node: 'js',
};

/** 选一个不与内容冲突的围栏长度 */
function fenceFor(source: string): string {
  let max = 2;
  for (const m of source.matchAll(/^ {0,3}(`{3,})/gm)) max = Math.max(max, m[1].length);
  return '`'.repeat(max + 1);
}

export function notebookToMarkdown(nb: Notebook): string {
  const head = [
    '---',
    'xnotebook: 1',
    `title: ${JSON.stringify(nb.title)}`,
    `created: ${nb.created}`,
    `updated: ${nb.updated}`,
    '---',
    '',
  ].join('\n');

  const body = nb.cells
    .map((cell) => {
      if (cell.type === 'md') return cell.source.replace(/\s+$/, '');
      const fence = fenceFor(cell.source);
      const info = `${FENCE_LANG[cell.lang]} {id=${cell.id}}`;
      return `${fence}${info}\n${cell.source.replace(/\n$/, '')}\n${fence}`;
    })
    .join('\n\n');

  return head + body + '\n';
}

interface Frontmatter {
  title?: string;
  created?: string;
  updated?: string;
}

function parseFrontmatter(text: string): { fm: Frontmatter; rest: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { fm: {}, rest: text };
  const fm: Frontmatter = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (!kv) continue;
    let value = kv[2].trim();
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string;
      } catch {
        /* 保留原样 */
      }
    }
    (fm as Record<string, string>)[kv[1]] = value;
  }
  return { fm, rest: text.slice(m[0].length) };
}

export function markdownToNotebook(text: string, fallbackTitle = '未命名笔记'): Notebook {
  const { fm, rest } = parseFrontmatter(text);
  const lines = rest.split(/\r?\n/);
  const cells: Cell[] = [];
  let buffer: string[] = [];

  const flushMarkdown = () => {
    const source = buffer.join('\n').trim();
    buffer = [];
    if (source) cells.push({ id: uid('c'), type: 'md', source });
  };

  for (let i = 0; i < lines.length; i += 1) {
    const open = /^ {0,3}(`{3,})\s*([^\s{]*)\s*(\{[^}]*\})?\s*$/.exec(lines[i]);
    const lang = open ? LANG_BY_FENCE[open[2].toLowerCase()] : undefined;
    if (!open || !lang) {
      buffer.push(lines[i]);
      continue;
    }

    // 找配对的收尾围栏；找不到就当普通文本，避免吞掉后续内容
    const marker = open[1];
    const closeRe = new RegExp('^ {0,3}' + marker + '\\s*$');
    let end = -1;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (closeRe.test(lines[j])) {
        end = j;
        break;
      }
    }
    if (end === -1) {
      buffer.push(lines[i]);
      continue;
    }

    flushMarkdown();
    const idMatch = open[3] ? /id=([\w-]+)/.exec(open[3]) : null;
    const cell: CodeCell = {
      id: idMatch ? idMatch[1] : uid('c'),
      type: 'code',
      lang,
      source: lines.slice(i + 1, end).join('\n'),
      outputs: [],
    };
    cells.push(cell);
    i = end;
  }
  flushMarkdown();

  const now = new Date().toISOString();
  return {
    id: uid('nb'),
    title: fm.title || fallbackTitle,
    cells: cells.length ? cells : [{ id: uid('c'), type: 'md', source: '' }],
    counter: 0,
    created: fm.created || now,
    updated: fm.updated || now,
  };
}

/** 旁车输出文件：cell id → outputs */
export function outputsToJson(nb: Notebook): string {
  const map: Record<string, unknown> = {};
  for (const cell of nb.cells) {
    if (cell.type === 'code' && cell.outputs.length) {
      map[cell.id] = { outputs: cell.outputs, execN: cell.execN, ranWith: cell.ranWith };
    }
  }
  return JSON.stringify({ xnotebook: 1, cells: map }, null, 2);
}

export function applyOutputsJson(nb: Notebook, json: string): Notebook {
  let parsed: { cells?: Record<string, Partial<CodeCell>> };
  try {
    parsed = JSON.parse(json) as { cells?: Record<string, Partial<CodeCell>> };
  } catch {
    return nb;
  }
  const map = parsed.cells ?? {};
  for (const cell of nb.cells) {
    const saved = cell.type === 'code' ? map[cell.id] : undefined;
    if (cell.type === 'code' && saved) {
      cell.outputs = saved.outputs ?? [];
      cell.execN = saved.execN;
      cell.ranWith = saved.ranWith;
    }
  }
  return nb;
}
