/**
 * Markdown 为正本的序列化。
 *
 * - Markdown cell 直接是正文
 * - Code cell 是围栏块，info string 形如 ```java {id=c2}
 * - outputs 不进 Markdown，由调用方存旁车 JSON
 */
import {
  type Cell,
  type CodeCell,
  type LangId,
  type NoteMeta,
  type Notebook,
  newNoteUid,
  uid,
} from './model';

const FENCE_LANG: Record<LangId, string> = { java: 'java', python: 'python', js: 'javascript' };

/** 围栏 info 串里的语言名 → LangId。解析笔记和列表页的语言标签共用这一张表 */
export const LANG_BY_FENCE: Record<string, LangId> = {
  java: 'java',
  python: 'python',
  py: 'python',
  javascript: 'js',
  js: 'js',
  node: 'js',
};

/** 选一个不与内容冲突的围栏长度 */
export function fenceFor(source: string): string {
  let max = 2;
  for (const m of source.matchAll(/^ {0,3}(`{3,})/gm)) max = Math.max(max, m[1].length);
  return '`'.repeat(max + 1);
}

/**
 * 文本 cell 的内容恰好是一段围栏代码时，转成代码 cell 应该去掉围栏、认出语言。
 * 这是「文本里的代码块只展示」这条规则的另一半：想运行，一步就能转过去。
 * 不是单个围栏块就原样返回 null，由调用方按普通文本处理。
 */
export function fenceToCode(source: string): { lang?: LangId; code: string } | null {
  const m = /^\s*(`{3,}|~{3,})[ \t]*([^\s{`~]*)[^\n]*\n([\s\S]*?)\n?[ \t]*\1[ \t]*\s*$/.exec(source);
  if (!m) return null;
  const lang = LANG_BY_FENCE[m[2].toLowerCase()];
  return { lang, code: m[3] };
}

/** 反过来：代码 cell 转文本时包上围栏，否则源码会被当 Markdown 渲染得面目全非 */
export function codeToFence(code: string, lang: LangId): string {
  const fence = fenceFor(code);
  return `${fence}${FENCE_LANG[lang]}\n${code.replace(/\n$/, '')}\n${fence}`;
}

export function notebookToMarkdown(nb: Notebook): string {
  const lines = [
    '---',
    'notex: 1',
    `title: ${JSON.stringify(nb.title)}`,
    `created: ${nb.created}`,
    `updated: ${nb.updated}`,
  ];
  // 隐藏元数据整体写成一行 JSON：frontmatter 保持行式结构，
  // 又不必为嵌套字段引入一个 YAML 解析器
  const meta = nb.meta && Object.keys(nb.meta).length ? nb.meta : null;
  if (meta) lines.push(`meta: ${JSON.stringify(meta)}`);
  lines.push('---', '');
  const head = lines.join('\n');

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
  /** 我们自己写出来的文件才有这个标记 */
  notex?: string;
  title?: string;
  created?: string;
  updated?: string;
  meta?: string;
}

function parseFrontmatter(text: string): { fm: Frontmatter; rest: string } {
  // 别的编辑器可能在文件头写 BOM，不去掉的话 frontmatter 整个失效，`---` 就进了正文
  text = text.replace(/^﻿/, '');
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

/**
 * 哪些围栏是可执行 cell：
 *
 * - 我们自己写出的文件（frontmatter 带 notex 标记）里，可执行 cell 一定带 `{id=…}`。
 *   没有 id 的围栏是用户写在文本 cell 里的展示代码，不该在重开时变成可运行的 cell。
 * - 从别处拿来的 Markdown 没有这个约定，认得的语言一律当可执行 cell，
 *   下次保存就会带上 id 和标记，从此进入前一种规则。
 */
export function markdownToNotebook(text: string, fallbackTitle = '未命名笔记'): Notebook {
  const { fm, rest } = parseFrontmatter(text);
  const ownFile = fm.notex !== undefined;
  const lines = rest.split(/\r?\n/);
  const cells: Cell[] = [];
  let buffer: string[] = [];

  const flushMarkdown = () => {
    // 只去掉首尾的空行，不动首行的缩进：四个空格开头就是缩进代码块，
    // trim 掉它就变成了普通段落
    const source = buffer
      .join('\n')
      .replace(/^(?:[ \t]*\r?\n)+/, '')
      .replace(/\s+$/, '');
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

    const idMatch = open[3] ? /id=([\w-]+)/.exec(open[3]) : null;
    if (ownFile && !idMatch) {
      // 文本 cell 里的展示代码：整段连围栏一起留在正文里
      for (let j = i; j <= end; j += 1) buffer.push(lines[j]);
      i = end;
      continue;
    }

    flushMarkdown();
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

  let meta: NoteMeta = {};
  if (fm.meta) {
    try {
      const parsed = JSON.parse(fm.meta) as NoteMeta;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
    } catch {
      // 元数据坏了不该导致整篇笔记打不开
    }
  }
  // 老笔记没有稳定标识，读的时候补一个，下次保存就落盘了
  if (!meta.uid) meta.uid = newNoteUid();

  const now = new Date().toISOString();
  return {
    id: uid('nb'),
    meta,
    title: fm.title || fallbackTitle,
    cells,
    created: fm.created || now,
    updated: fm.updated || now,
  };
}

/** 旁车输出文件：cell id → outputs */
export function outputsToJson(nb: Notebook): string {
  const map: Record<string, unknown> = {};
  for (const cell of nb.cells) {
    if (cell.type === 'code' && cell.outputs.length) {
      map[cell.id] = { outputs: cell.outputs, ranWith: cell.ranWith };
    }
  }
  return JSON.stringify({ notex: 1, cells: map }, null, 2);
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
      cell.ranWith = saved.ranWith;
    }
  }
  return nb;
}
