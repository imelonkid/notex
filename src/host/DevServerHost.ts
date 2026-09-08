import {
  type ChildProcess,
  type ExecResult,
  type HostBridge,
  type Platform,
  type SpawnOptions,
} from './HostBridge';

const BASE = '/__host';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(BASE + path);
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} → ${res.status}`);
  return (await res.json()) as T;
}

type Listener<T> = (value: T) => void;

class WsChildProcess implements ChildProcess {
  pid = 0;
  private outCbs = new Set<Listener<string>>();
  private errCbs = new Set<Listener<string>>();
  private exitCbs = new Set<Listener<number | null>>();
  private queue: string[] = [];
  private open = false;

  constructor(private ws: WebSocket, ready: (p: WsChildProcess) => void) {
    ws.onopen = () => {
      this.open = true;
      for (const q of this.queue) ws.send(q);
      this.queue = [];
    };
    ws.onmessage = (ev) => {
      let msg: { ch: string; text?: string; code?: number | null; pid?: number };
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (msg.ch === 'spawned') {
        this.pid = msg.pid ?? 0;
        ready(this);
      } else if (msg.ch === 'stdout') this.outCbs.forEach((cb) => cb(msg.text ?? ''));
      else if (msg.ch === 'stderr') this.errCbs.forEach((cb) => cb(msg.text ?? ''));
      else if (msg.ch === 'error') this.errCbs.forEach((cb) => cb(msg.text ?? ''));
      else if (msg.ch === 'exit') this.exitCbs.forEach((cb) => cb(msg.code ?? null));
    };
    ws.onclose = () => this.exitCbs.forEach((cb) => cb(null));
  }

  private post(payload: unknown) {
    const text = JSON.stringify(payload);
    if (this.open) this.ws.send(text);
    else this.queue.push(text);
  }

  async write(data: string) {
    this.post({ ch: 'stdin', text: data });
  }
  onStdout(cb: Listener<string>) {
    this.outCbs.add(cb);
    return () => this.outCbs.delete(cb);
  }
  onStderr(cb: Listener<string>) {
    this.errCbs.add(cb);
    return () => this.errCbs.delete(cb);
  }
  onExit(cb: Listener<number | null>) {
    this.exitCbs.add(cb);
    return () => this.exitCbs.delete(cb);
  }
  async kill(signal: 'SIGINT' | 'SIGTERM' | 'SIGKILL' = 'SIGTERM') {
    this.post({ ch: 'signal', signal });
    if (signal === 'SIGKILL') try { this.ws.close(); } catch { /* ignore */ }
  }
}

/** 开发期宿主：通过 Vite 插件提供的 HTTP + WebSocket 使用本机能力。 */
export class DevServerHost implements HostBridge {
  readonly id = 'dev-server';
  readonly canSpawn = true;
  private plat: Platform = 'darwin';
  private kernelsDir = '';

  static async probe(): Promise<DevServerHost | null> {
    try {
      const info = await getJson<{ platform: string; kernels: string }>('/info');
      const host = new DevServerHost();
      host.plat = (info.platform as Platform) ?? 'linux';
      host.kernelsDir = info.kernels;
      return host;
    } catch {
      return null;
    }
  }

  platform(): Platform {
    return this.plat;
  }

  async spawn(cmd: string, args: string[], _opts?: SpawnOptions): Promise<ChildProcess> {
    const params = new URLSearchParams({
      cmd,
      args: JSON.stringify(args),
      id: Math.random().toString(36).slice(2),
    });
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}${BASE}/kernel?${params}`);
    return await new Promise<ChildProcess>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('内核进程启动超时')), 15000);
      const child = new WsChildProcess(ws, (p) => {
        clearTimeout(timer);
        resolve(p);
      });
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('无法连接到宿主服务'));
      };
      void child;
    });
  }

  async exec(cmd: string, args: string[]): Promise<ExecResult> {
    return await postJson<ExecResult>('/exec', { cmd, args });
  }

  async which(bin: string): Promise<string | null> {
    const r = await getJson<{ path: string | null }>(`/which?bin=${encodeURIComponent(bin)}`);
    return r.path;
  }

  async env(name: string): Promise<string | undefined> {
    const r = await getJson<{ value: string | null }>(`/env?name=${encodeURIComponent(name)}`);
    return r.value ?? undefined;
  }

  async kernelPath(relative: string): Promise<string> {
    return this.kernelsDir ? `${this.kernelsDir}/${relative}` : relative;
  }

  async readText(path: string): Promise<string> {
    const r = await getJson<{ content: string }>(`/read?path=${encodeURIComponent(path)}`);
    return r.content;
  }

  async writeText(path: string, content: string): Promise<void> {
    await postJson('/write', { path, content });
  }

  async fileExists(path: string): Promise<boolean> {
    const r = await getJson<{ exists: boolean }>(`/exists?path=${encodeURIComponent(path)}`);
    return r.exists;
  }
}

export async function detectHost(): Promise<HostBridge> {
  const dev = await DevServerHost.probe();
  if (dev) return dev;
  const { BrowserHost } = await import('./BrowserHost');
  return new BrowserHost();
}
