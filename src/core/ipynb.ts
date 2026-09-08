/**
 * .ipynb 导出与导入。作为交换格式，不是正本。
 * 正本是 Markdown，见 serialize.ts。
 */
import { type Cell, type LangId, type Notebook, type Output, uid } from './model';

/** Jupyter 内核规格。这些名字对应社区常用的内核，导出的文件在 Jupyter 里能直接打开。 */
const KERNELSPEC: Record<LangId, { name: string; display_name: string; language: string }> = {
  java: { name: 'java', display_name: 'Java', language: 'java' },
  python: { name: 'python3', display_name: 'Python 3', language: 'python' },
  js: { name: 'javascript', display_name: 'JavaScript', language: 'javascript' },
};

const LANGUAGE_INFO: Record<LangId, Record<string, unknown>> = {
  java: { name: 'java', file_extension: '.java', mimetype: 'text/x-java-source' },
  python: { name: 'python', version: '3', file_extension: '.py', mimetype: 'text/x-python' },
  js: { name: 'javascript', file_extension: '.js', mimetype: 'application/javascript' },
};

/** ipynb 里的 source 是按行切分的数组，每行保留结尾换行 */
function toLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split('\n');
  return lines.map((l, i) => (i === lines.length - 1 ? l : l + '\n')).filter((l, i) => l !== '' || i === 0);
}

function fromLines(source: string | string[] | undefined): string {
  if (!source) return '';
  return Array.isArray(source) ? source.join('') : source;
}

function outputToIpynb(out: Output, execN?: number): Record<string, unknown> | null {
  switch (out.type) {
    case 'stream':
      return { output_type: 'stream', name: out.name, text: toLines(out.text) };
    case 'result':
      return {
        output_type: 'execute_result',
        execution_count: execN ?? null,
        data: mimeBundle(out.data),
        metadata: {},
      };
    case 'display':
      return { output_type: 'display_data', data: mimeBundle(out.data), metadata: {} };
    case 'error':
      return {
        output_type: 'error',
        ename: out.ename,
        evalue: out.evalue,
        traceback: out.traceback,
      };
    default:
      // missing-runtime 是 UI 内部状态，不写进交换格式
      return null;
  }
}

/** 文本类 MIME 在 ipynb 里是行数组，二进制（base64）保持单个字符串 */
function mimeBundle(data: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [mime, value] of Object.entries(data)) {
    out[mime] = mime.startsWith('image/') && mime !== 'image/svg+xml' ? value : toLines(value);
  }
  return out;
}

function ipynbToOutput(raw: Record<string, any>): Output | null {
  switch (raw.output_type) {
    case 'stream':
      return {
        type: 'stream',
        name: raw.name === 'stderr' ? 'stderr' : 'stdout',
        text: fromLines(raw.text),
      };
    case 'execute_result':
    case 'display_data': {
      const data: Record<string, string> = {};
      for (const [mime, value] of Object.entries(raw.data ?? {})) {
        data[mime] = fromLines(value as string | string[]);
      }
      return { type: raw.output_type === 'execute_result' ? 'result' : 'display', data };
    }
    case 'error':
      return {
        type: 'error',
        ename: String(raw.ename ?? 'Error'),
        evalue: String(raw.evalue ?? ''),
        traceback: Array.isArray(raw.traceback) ? raw.traceback.map(String) : [],
      };
    default:
      return null;
  }
}

const LANG_FROM_IPYNB: Record<string, LangId> = {
  java: 'java',
  python: 'python',
  python3: 'python',
  javascript: 'js',
  js: 'js',
  node: 'js',
  nodejs: 'js',
};

export function notebookToIpynb(nb: Notebook): string {
  // 以出现最多的语言作为整篇的 kernelspec；每个 cell 自己的语言记在 metadata 里
  const counts = new Map<LangId, number>();
  for (const c of nb.cells) {
    if (c.type === 'code') counts.set(c.lang, (counts.get(c.lang) ?? 0) + 1);
  }
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'python';

  const cells = nb.cells.map((cell) => {
    if (cell.type === 'md') {
      return { cell_type: 'markdown', metadata: {}, source: toLines(cell.source) };
    }
    return {
      cell_type: 'code',
      execution_count: cell.execN ?? null,
      // 保留每个 cell 的语言，回读时才能还原混合语言的笔记
      metadata: { xnotebook: { lang: cell.lang } },
      source: toLines(cell.source),
      outputs: cell.outputs
        .map((o) => outputToIpynb(o, cell.execN))
        .filter((o): o is Record<string, unknown> => o !== null),
    };
  });

  const doc = {
    cells,
    metadata: {
      kernelspec: KERNELSPEC[dominant],
      language_info: LANGUAGE_INFO[dominant],
      xnotebook: { version: 1, title: nb.title },
    },
    nbformat: 4,
    nbformat_minor: 5,
  };
  return JSON.stringify(doc, null, 1) + '\n';
}

export function ipynbToNotebook(text: string, fallbackTitle = '导入的笔记'): Notebook {
  const doc = JSON.parse(text) as Record<string, any>;
  const docLang: LangId =
    LANG_FROM_IPYNB[String(doc?.metadata?.kernelspec?.language ?? '').toLowerCase()] ??
    LANG_FROM_IPYNB[String(doc?.metadata?.kernelspec?.name ?? '').toLowerCase()] ??
    'python';

  const cells: Cell[] = [];
  for (const raw of doc.cells ?? []) {
    const source = fromLines(raw.source);
    if (raw.cell_type === 'markdown' || raw.cell_type === 'raw') {
      cells.push({ id: uid('c'), type: 'md', source });
      continue;
    }
    if (raw.cell_type !== 'code') continue;
    const lang: LangId = LANG_FROM_IPYNB[String(raw?.metadata?.xnotebook?.lang ?? '')] ?? docLang;
    cells.push({
      id: uid('c'),
      type: 'code',
      lang,
      source,
      execN: typeof raw.execution_count === 'number' ? raw.execution_count : undefined,
      ranWith: lang,
      outputs: (raw.outputs ?? [])
        .map((o: Record<string, any>) => ipynbToOutput(o))
        .filter((o: Output | null): o is Output => o !== null),
    });
  }

  const now = new Date().toISOString();
  return {
    id: uid('nb'),
    title: String(doc?.metadata?.xnotebook?.title ?? fallbackTitle),
    cells: cells.length ? cells : [{ id: uid('c'), type: 'md', source: '' }],
    counter: cells.reduce((max, c) => (c.type === 'code' ? Math.max(max, c.execN ?? 0) : max), 0),
    created: now,
    updated: now,
  };
}
