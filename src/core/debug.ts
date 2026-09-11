/**
 * 调试日志。
 *
 * 桌面版没有开发者工具，控制台看不见，出问题只能靠猜。
 * 所以这里一份写控制台（开发时用），一份写 ~/.notex/debug.log（桌面版用）。
 * 发布前默认开着；要关掉，在控制台执行 localStorage.setItem('notex.debug', 'off')。
 */

import type { HostBridge } from '@host/HostBridge';

export type LogLevel = 'info' | 'warn' | 'error';

interface Entry {
  time: number;
  level: LogLevel;
  scope: string;
  msg: string;
  data?: unknown;
}

/** 内存里只留最近这么多条，防止长时间开着把内存吃满 */
const MAX_ENTRIES = 2000;

const buffer: Entry[] = [];
let host: HostBridge | null = null;
let logPath: string | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let dirty = false;

function enabled(): boolean {
  try {
    return localStorage.getItem('notex.debug') !== 'off';
  } catch {
    return true;
  }
}

function stamp(t: number): string {
  const d = new Date(t);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** 只留得下摘要：长字符串截断，Error 取 message，避免日志被单条撑爆 */
function brief(v: unknown, depth = 0): unknown {
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  // 函数体会把日志撑得没法看（内核会话对象就有一堆方法）
  if (typeof v === 'function') return `[fn ${(v as { name?: string }).name || 'anonymous'}]`;
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + `…(${v.length})` : v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  if (Array.isArray(v)) return depth > 1 ? `[${v.length} 项]` : v.slice(0, 10).map((x) => brief(x, depth + 1));
  if (typeof v === 'object') {
    if (depth > 1) return '{…}';
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = brief(val, depth + 1);
    return out;
  }
  return String(v);
}

function format(e: Entry): string {
  const tail = e.data === undefined ? '' : ' ' + JSON.stringify(brief(e.data));
  return `${stamp(e.time)} [${e.scope}] ${e.msg}${tail}`;
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer || !host || !logPath) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushNow();
  }, 800);
}

async function flushNow() {
  if (!dirty || !host || !logPath) return;
  dirty = false;
  try {
    await host.writeText(logPath, buffer.map(format).join('\n') + '\n');
  } catch {
    // 日志写不进去不该影响正事，也不该再记一条日志引发递归
  }
}

function push(level: LogLevel, scope: string, msg: string, data?: unknown) {
  if (!enabled()) return;
  const e: Entry = { time: Date.now(), level, scope, msg, data };
  buffer.push(e);
  if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  const line = format(e);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
  scheduleFlush();
}

export const debug = {
  log: (scope: string, msg: string, data?: unknown) => push('info', scope, msg, data),
  warn: (scope: string, msg: string, data?: unknown) => push('warn', scope, msg, data),
  error: (scope: string, msg: string, data?: unknown) => push('error', scope, msg, data),

  /**
   * 包住一次操作：开始、成功（带耗时）、失败各记一条。
   * 静默失败最难查，所以这里连返回值也顺手记下。
   */
  async op<T>(scope: string, msg: string, fn: () => Promise<T> | T, data?: unknown): Promise<T> {
    const t0 = performance.now();
    push('info', scope, `${msg} …`, data);
    try {
      const out = await fn();
      push('info', scope, `${msg} 完成 ${Math.round(performance.now() - t0)}ms`, out);
      return out;
    } catch (e) {
      push('error', scope, `${msg} 失败 ${Math.round(performance.now() - t0)}ms`, e);
      throw e;
    }
  },

  /** 全部日志文本，供"复制日志"之类的入口使用 */
  dump: () => buffer.map(format).join('\n'),

  path: () => logPath,
};

/**
 * 宿主就绪后接上文件输出。同时把上一次的日志留一份，
 * 崩溃后重开还能看到崩之前发生了什么。
 *
 * 文件名带上宿主 id：桌面版和开发服务器可能同时开着，
 * 每次落盘写的都是整份缓冲，共用一个文件会互相覆盖。
 */
export async function attachDebugSink(bridge: HostBridge) {
  try {
    const dir = bridge.joinPath(await bridge.homeDir(), '.notex');
    await bridge.ensureDir(dir);
    const current = bridge.joinPath(dir, `debug-${bridge.id}.log`);
    if (await bridge.fileExists(current)) {
      const prev = await bridge.readText(current).catch(() => '');
      if (prev) await bridge.writeText(bridge.joinPath(dir, `debug-${bridge.id}.prev.log`), prev);
    }
    host = bridge;
    logPath = current;
    push('info', 'app', '日志已接上', { file: current, host: bridge.id, platform: bridge.platform() });
    await flushNow();
  } catch (e) {
    console.warn('[notex] 调试日志无法落盘', e);
  }
}

/** 未捕获的异常也进日志，否则桌面版里什么都看不到 */
export function installGlobalErrorLog() {
  window.addEventListener('error', (e) => {
    push('error', 'window', '未捕获异常', { message: e.message, source: e.filename, line: e.lineno });
  });
  window.addEventListener('unhandledrejection', (e) => {
    push('error', 'window', '未处理的 Promise 拒绝', e.reason);
  });
}
