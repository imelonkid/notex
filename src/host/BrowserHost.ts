import {
  type Arch,
  type ChildProcess,
  type ExecResult,
  type HostBridge,
  HostCapabilityError,
  type DirEntry,
  type Platform,
  type ResolvedDeps,
} from './HostBridge';

/** 纯浏览器宿主：没有进程和文件系统，只能跑浏览器内的 provider。 */
export class BrowserHost implements HostBridge {
  readonly id = 'browser';
  readonly canSpawn = false;

  platform(): Platform {
    const ua = navigator.userAgent;
    if (/Mac/i.test(ua)) return 'darwin';
    if (/Win/i.test(ua)) return 'win32';
    return 'linux';
  }

  arch(): Arch {
    return 'arm64';
  }

  async spawn(): Promise<ChildProcess> {
    throw new HostCapabilityError('启动本地进程');
  }
  async fileSize(): Promise<number | null> {
    return null;
  }
  async writeBinary(): Promise<void> {
    throw new HostCapabilityError('写入本地文件');
  }
  fileUrl(path: string): string {
    return path;
  }
  async sha256(): Promise<string> {
    throw new HostCapabilityError('计算文件哈希');
  }
  async exec(): Promise<ExecResult> {
    throw new HostCapabilityError('执行本地命令');
  }
  async which(): Promise<string | null> {
    return null;
  }
  async env(): Promise<string | undefined> {
    return undefined;
  }
  async kernelPath(relative: string): Promise<string> {
    return relative;
  }
  async resolveDeps(): Promise<ResolvedDeps> {
    throw new HostCapabilityError('解析依赖');
  }
  async readText(): Promise<string> {
    throw new HostCapabilityError('读取本地文件');
  }
  async writeText(): Promise<void> {
    throw new HostCapabilityError('写入本地文件');
  }
  async fileExists(): Promise<boolean> {
    return false;
  }
  async homeDir(): Promise<string> {
    throw new HostCapabilityError('访问主目录');
  }
  async listDir(): Promise<DirEntry[]> {
    throw new HostCapabilityError('列举目录');
  }
  async statFile(): Promise<string | null> {
    return null;
  }
  async ensureDir(): Promise<void> {
    throw new HostCapabilityError('创建目录');
  }
  async removeFile(): Promise<void> {
    throw new HostCapabilityError('删除文件');
  }
  async removeDir(): Promise<void> {
    throw new HostCapabilityError('删除目录');
  }
  async renameFile(): Promise<void> {
    throw new HostCapabilityError('重命名文件');
  }
  async openExternal(url: string): Promise<void> {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  joinPath(...parts: string[]): string {
    return parts.filter(Boolean).join('/');
  }
}
