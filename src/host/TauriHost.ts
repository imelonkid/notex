import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import { open as openInSystem } from '@tauri-apps/plugin-shell';
import { resolveDepsWithHost } from '@core/deps/resolve';
import {
  type ChildProcess,
  type DirEntry,
  type ExecResult,
  type HostBridge,
  type Platform,
  type ResolvedDeps,
} from './HostBridge';

type Listener<T> = (value: T) => void;

interface StreamChunk {
  id: number;
  text: string;
}
interface ExitInfo {
  id: number;
  code: number | null;
}

/** 内核 stdio 走事件，这里按内核 id 分发到各自的回调 */
class TauriChild implements ChildProcess {
  private outCbs = new Set<Listener<string>>();
  private errCbs = new Set<Listener<string>>();
  private exitCbs = new Set<Listener<number | null>>();
  private disposers: Array<() => void> = [];

  constructor(readonly pid: number) {
    void listen<StreamChunk>('kernel://stdout', (e) => {
      if (e.payload.id === pid) this.outCbs.forEach((cb) => cb(e.payload.text));
    }).then((un) => this.disposers.push(un));
    void listen<StreamChunk>('kernel://stderr', (e) => {
      if (e.payload.id === pid) this.errCbs.forEach((cb) => cb(e.payload.text));
    }).then((un) => this.disposers.push(un));
    void listen<ExitInfo>('kernel://exit', (e) => {
      if (e.payload.id !== pid) return;
      this.exitCbs.forEach((cb) => cb(e.payload.code));
      this.disposers.forEach((d) => d());
      this.disposers = [];
    }).then((un) => this.disposers.push(un));
  }

  async write(data: string) {
    await invoke('kernel_write', { id: this.pid, data });
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
    await invoke('kernel_signal', { id: this.pid, signal }).catch(() => undefined);
  }
}

/** 桌面壳宿主：文件与进程能力都由 Rust 侧提供 */
export class TauriHost implements HostBridge {
  readonly id = 'tauri';
  readonly canSpawn = true;
  private plat: Platform = 'darwin';
  private kernels = '';

  static isAvailable(): boolean {
    return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  }

  static async create(): Promise<TauriHost> {
    const host = new TauriHost();
    const ua = navigator.userAgent;
    host.plat = /Mac/i.test(ua) ? 'darwin' : /Win/i.test(ua) ? 'win32' : 'linux';
    try {
      host.kernels = await invoke<string>('kernels_dir');
    } catch {
      host.kernels = '';
    }
    return host;
  }

  platform(): Platform {
    return this.plat;
  }

  async spawn(cmd: string, args: string[]): Promise<ChildProcess> {
    const id = await invoke<number>('kernel_spawn', {
      cmd,
      args,
      cwd: this.kernels || null,
    });
    return new TauriChild(id);
  }

  async exec(cmd: string, args: string[]): Promise<ExecResult> {
    return await invoke<ExecResult>('exec', { cmd, args });
  }

  async which(bin: string): Promise<string | null> {
    return (await invoke<string | null>('which', { bin })) ?? null;
  }

  async env(name: string): Promise<string | undefined> {
    return (await invoke<string | null>('env_var', { name })) ?? undefined;
  }

  async kernelPath(relative: string): Promise<string> {
    return this.kernels ? this.joinPath(this.kernels, relative) : relative;
  }

  async readText(path: string): Promise<string> {
    return await invoke<string>('read_text', { path });
  }

  async writeText(path: string, content: string): Promise<void> {
    await invoke('write_text', { path, content });
  }

  async fileExists(path: string): Promise<boolean> {
    return await invoke<boolean>('file_exists', { path });
  }

  async homeDir(): Promise<string> {
    return await invoke<string>('home_dir');
  }

  async listDir(path: string): Promise<DirEntry[]> {
    return await invoke<DirEntry[]>('list_dir', { path });
  }

  async statFile(path: string): Promise<string | null> {
    return (await invoke<string | null>('stat_file', { path })) ?? null;
  }

  async ensureDir(path: string): Promise<void> {
    await invoke('ensure_dir', { path });
  }

  async removeFile(path: string): Promise<void> {
    await invoke('remove_file', { path });
  }

  async renameFile(from: string, to: string): Promise<void> {
    await invoke('rename_file', { from, to });
  }

  async openExternal(url: string): Promise<void> {
    await openInSystem(url);
  }

  joinPath(...parts: string[]): string {
    const sep = this.plat === 'win32' ? '\\' : '/';
    return parts
      .filter(Boolean)
      .map((p, i) => (i === 0 ? p.replace(/[/\\]+$/, '') : p.replace(/^[/\\]+|[/\\]+$/g, '')))
      .join(sep);
  }

  async resolveDeps(coords: string[]): Promise<ResolvedDeps> {
    return await resolveDepsWithHost(this, coords);
  }

  async pickDirectory(): Promise<string | null> {
    const picked = await openDialog({ directory: true, multiple: false, title: '选择笔记库目录' });
    return typeof picked === 'string' ? picked : null;
  }
}
