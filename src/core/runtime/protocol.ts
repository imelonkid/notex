/**
 * 内核协议：JSON Lines over stdio。
 * 每条协议消息以 RS (\x1e) 开头，任何不以它开头的行都视为漏网的 stdout。
 */
import type { LangId } from '../model';

export const RS = '\x1e';

export type KernelRequest =
  | { id: string; op: 'execute'; code: string }
  | { id: string; op: 'complete'; code: string; cursor: number }
  | { id: string; op: 'inspect'; code: string; cursor: number }
  | { id: string; op: 'interrupt'; target: string }
  | { id: string; op: 'shutdown' };

export interface CompletionItem {
  label: string;
  kind?: string;
  detail?: string;
}

export type KernelResponse =
  | { id: string; type: 'ready'; lang: LangId; version: string }
  | { id: string; type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { id: string; type: 'result'; data: Record<string, string> }
  | { id: string; type: 'display'; data: Record<string, string> }
  | { id: string; type: 'error'; ename: string; evalue: string; traceback: string[] }
  | { id: string; type: 'completions'; anchor: number; items: CompletionItem[] }
  | { id: string; type: 'inspection'; text: string }
  | { id: string; type: 'done'; status: 'ok' | 'error' | 'aborted'; durationMs?: number };

export function encodeRequest(req: KernelRequest): string {
  return RS + JSON.stringify(req) + '\n';
}

/**
 * 把一行输出解析为协议消息；不是协议消息则返回 null（调用方当作裸 stdout）。
 */
export function decodeLine(line: string): KernelResponse | null {
  if (!line.startsWith(RS)) return null;
  try {
    return JSON.parse(line.slice(RS.length)) as KernelResponse;
  } catch {
    return null;
  }
}

/** 增量拆行器，处理跨 chunk 的半行 */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let buf = '';
  return (chunk: string) => {
    buf += chunk;
    let nl = buf.indexOf('\n');
    while (nl !== -1) {
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (line) onLine(line);
      nl = buf.indexOf('\n');
    }
  };
}
