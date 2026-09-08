import type { Notebook } from './model';
import { markdownToNotebook, notebookToMarkdown, applyOutputsJson, outputsToJson } from './serialize';
import { ipynbToNotebook, notebookToIpynb } from './ipynb';

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** 文件名里不能出现的字符换成下划线 */
function safeName(title: string): string {
  return (title.trim() || 'notebook').replace(/[/\\:*?"<>|]/g, '_').slice(0, 80);
}

export function exportMarkdown(nb: Notebook) {
  download(`${safeName(nb.title)}.md`, notebookToMarkdown(nb), 'text/markdown');
}

export function exportOutputs(nb: Notebook) {
  download(`${safeName(nb.title)}.outputs.json`, outputsToJson(nb), 'application/json');
}

export function exportIpynb(nb: Notebook) {
  download(`${safeName(nb.title)}.ipynb`, notebookToIpynb(nb), 'application/json');
}

/** 让用户挑一个文件并解析成 Notebook。格式按扩展名判断。 */
export function importNotebook(): Promise<Notebook | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.md,.markdown,.ipynb,.json';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      const text = await file.text();
      const base = file.name.replace(/\.[^.]+$/, '');
      try {
        if (/\.ipynb$/i.test(file.name)) {
          resolve(ipynbToNotebook(text, base));
        } else {
          const nb = markdownToNotebook(text, base);
          // 同名旁车文件里的输出（如果用户一并选了就没法拿到，这里只做尽力恢复）
          resolve(nb);
        }
      } catch (e) {
        console.error('[xnotebook] 导入失败', e);
        resolve(null);
      }
    };
    input.click();
  });
}

export { applyOutputsJson };
