import { encodeRequest, type CompletionItem, type KernelResponse } from './protocol';
import type { ExecuteHandlers, KernelConnection, CompletionResult } from './types';

let counter = 0;
const nextId = () => `q${++counter}`;

interface Pending {
  handlers?: ExecuteHandlers;
  resolve(status: 'ok' | 'error' | 'aborted'): void;
  completions?: (r: CompletionResult) => void;
  inspection?: (text: string) => void;
}

/**
 * 一个运行中内核的会话：负责请求编号、消息分发、超时与中断。
 * 与具体语言无关，三种内核共用。
 */
export class KernelSession {
  private pending = new Map<string, Pending>();
  private disposed = false;
  private rawCbs = new Set<(text: string) => void>();
  private exitCbs = new Set<(code: number | null) => void>();

  constructor(
    private conn: KernelConnection,
    readonly providerId: string,
    readonly version: string,
    private interruptStrategy: 'protocol' | 'signal' = 'protocol',
  ) {
    conn.onMessage((msg) => this.dispatch(msg));
    conn.onRawOutput((text) => this.rawCbs.forEach((cb) => cb(text)));
    conn.onExit((code) => {
      this.disposed = true;
      // 内核意外退出时，让所有挂起的请求收敛，避免 UI 永远转圈
      for (const p of this.pending.values()) p.resolve('error');
      this.pending.clear();
      this.exitCbs.forEach((cb) => cb(code));
    });
  }

  onRawOutput(cb: (text: string) => void) {
    this.rawCbs.add(cb);
    return () => this.rawCbs.delete(cb);
  }

  onExit(cb: (code: number | null) => void) {
    this.exitCbs.add(cb);
    return () => this.exitCbs.delete(cb);
  }

  private dispatch(msg: KernelResponse) {
    const p = this.pending.get(msg.id);
    if (!p) return;
    switch (msg.type) {
      case 'stream':
        p.handlers?.onStream?.(msg.name, msg.text);
        break;
      case 'result':
        p.handlers?.onResult?.(msg.data);
        break;
      case 'display':
        p.handlers?.onDisplay?.(msg.data);
        break;
      case 'error':
        p.handlers?.onError?.(msg.ename, msg.evalue, msg.traceback);
        break;
      case 'completions':
        p.completions?.({ anchor: msg.anchor, items: msg.items as CompletionItem[] });
        break;
      case 'inspection':
        p.inspection?.(msg.text);
        break;
      case 'done':
        this.pending.delete(msg.id);
        p.resolve(msg.status);
        break;
      case 'classpath':
      case 'ready':
        break;
    }
  }

  async execute(code: string, handlers: ExecuteHandlers): Promise<'ok' | 'error' | 'aborted'> {
    if (this.disposed) return 'error';
    const id = nextId();
    const done = new Promise<'ok' | 'error' | 'aborted'>((resolve) => {
      this.pending.set(id, { handlers, resolve });
    });
    await this.conn.send(encodeRequest({ id, op: 'execute', code }));
    return done;
  }

  /** 补全带超时，内核卡住时不拖累编辑器 */
  async complete(code: string, cursor: number, timeoutMs = 2500): Promise<CompletionResult | null> {
    if (this.disposed) return null;
    const id = nextId();
    let result: CompletionResult | null = null;
    const done = new Promise<void>((resolve) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        completions: (r) => {
          result = r;
        },
      });
    });
    await this.conn.send(encodeRequest({ id, op: 'complete', code, cursor }));
    await Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs))]);
    this.pending.delete(id);
    return result;
  }

  async inspect(code: string, cursor: number, timeoutMs = 2500): Promise<string | null> {
    if (this.disposed) return null;
    const id = nextId();
    let text: string | null = null;
    const done = new Promise<void>((resolve) => {
      this.pending.set(id, {
        resolve: () => resolve(),
        inspection: (t) => {
          text = t;
        },
      });
    });
    await this.conn.send(encodeRequest({ id, op: 'inspect', code, cursor }));
    await Promise.race([done, new Promise((r) => setTimeout(r, timeoutMs))]);
    this.pending.delete(id);
    return text;
  }

  /** 把 jar 加入内核类路径。仅 Java 内核有意义，其它内核会忽略。 */
  async addClasspath(paths: string[]): Promise<void> {
    if (this.disposed || !paths.length) return;
    const id = nextId();
    const done = new Promise<void>((resolve) => {
      this.pending.set(id, { resolve: () => resolve() });
    });
    await this.conn.send(encodeRequest({ id, op: 'classpath', paths }));
    await Promise.race([done, new Promise((r) => setTimeout(r, 15000))]);
    this.pending.delete(id);
  }

  /**
   * 中断。信号型内核执行时读不到 stdin，直接发信号；
   * 协议型先发消息，1 秒仍未收敛再升级到信号。
   */
  async interrupt(): Promise<void> {
    if (this.interruptStrategy === 'signal') {
      await this.conn.interrupt();
      return;
    }
    const target = [...this.pending.keys()][0] ?? '';
    try {
      await this.conn.send(encodeRequest({ id: nextId(), op: 'interrupt', target }));
    } catch {
      /* 连接已断 */
    }
    setTimeout(() => {
      if (this.pending.size > 0) void this.conn.interrupt();
    }, 1000);
  }

  get busy(): boolean {
    return this.pending.size > 0;
  }

  get alive(): boolean {
    return !this.disposed;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    try {
      await this.conn.send(encodeRequest({ id: nextId(), op: 'shutdown' }));
    } catch {
      /* 忽略 */
    }
    await this.conn.dispose();
  }
}
