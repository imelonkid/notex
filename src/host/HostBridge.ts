/**
 * 宿主能力抽象。UI 与 Core 只依赖这个接口，
 * 由 BrowserHost / DevServerHost / (将来) TauriHost 实现。
 */

export class HostCapabilityError extends Error {
  constructor(capability: string) {
    super(`当前宿主不支持：${capability}`);
    this.name = 'HostCapabilityError';
  }
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
}

export interface ChildProcess {
  pid: number;
  write(data: string): Promise<void>;
  onStdout(cb: (chunk: string) => void): () => void;
  onStderr(cb: (chunk: string) => void): () => void;
  onExit(cb: (code: number | null) => void): () => void;
  kill(signal?: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<void>;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Platform = 'darwin' | 'win32' | 'linux';

export interface DirEntry {
  name: string;
  isDir: boolean;
  /** 最后修改时间，ISO 字符串 */
  modified?: string;
}

export interface ResolvedDeps {
  classpath: string[];
  resolver: 'maven' | 'direct';
  warnings: string[];
}

export interface HostBridge {
  readonly id: string;
  /** 能否 spawn 本地进程。false 时只有浏览器内 provider 可用。 */
  readonly canSpawn: boolean;

  platform(): Platform;
  spawn(cmd: string, args: string[], opts?: SpawnOptions): Promise<ChildProcess>;
  /** 一次性执行并收集输出，用于版本探测 */
  exec(cmd: string, args: string[], opts?: SpawnOptions): Promise<ExecResult>;
  which(bin: string): Promise<string | null>;
  env(name: string): Promise<string | undefined>;
  /** 内核脚本在宿主上的绝对路径 */
  kernelPath(relative: string): Promise<string>;

  /** 解析 Maven 坐标为本地 jar 路径 */
  resolveDeps(coords: string[]): Promise<ResolvedDeps>;

  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  fileExists(path: string): Promise<boolean>;

  /** 用户主目录，用于推导默认 vault */
  homeDir(): Promise<string>;
  listDir(path: string): Promise<DirEntry[]>;
  /** 文件的最后修改时间；不存在时返回 null */
  statFile(path: string): Promise<string | null>;
  ensureDir(path: string): Promise<void>;
  removeFile(path: string): Promise<void>;
  /** 递归删除目录 */
  removeDir(path: string): Promise<void>;
  /**
   * 移到系统废纸篓，文件与目录都可以；不存在时静默返回。
   * 能做到的宿主才实现，存储层没有它时才真删。
   */
  trash?(path: string): Promise<void>;
  renameFile(from: string, to: string): Promise<void>;
  /** 路径拼接由宿主做，避免前端猜分隔符 */
  joinPath(...parts: string[]): string;

  /**
   * 用系统默认浏览器打开外部链接。
   * 绝不能让应用自己的 webview 去导航：那样整个界面会被网页替换掉。
   */
  openExternal(url: string): Promise<void>;

  /**
   * 打开系统的目录选择器。只有桌面壳能做到，
   * 浏览器与开发服务器下返回 null，由界面退回手工填路径。
   */
  pickDirectory?(): Promise<string | null>;
}
