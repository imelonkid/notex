import {
  type ChildProcess,
  type ExecResult,
  type HostBridge,
  HostCapabilityError,
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

  async spawn(): Promise<ChildProcess> {
    throw new HostCapabilityError('启动本地进程');
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
}
