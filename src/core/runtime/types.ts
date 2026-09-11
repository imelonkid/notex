import type { LangId } from '../model';
import type { HostBridge } from '../../host/HostBridge';
import type { CompletionItem, KernelResponse } from './protocol';

export type RuntimeStatus =
  | 'unknown'
  | 'detecting'
  | 'available'
  | 'missing'
  | 'starting'
  | 'ready'
  | 'busy'
  | 'error';

/**
 * 探测到的一个候选可执行文件。全部列给用户看，用哪个由用户明确选，
 * 而不是探测链里命中即停、用户看不见为什么选了这个。
 */
export interface RuntimeCandidate {
  path: string;
  /** 从哪里找到的：环境变量、PATH、版本管理器、内置、手动 */
  source: string;
  version?: string;
  ok: boolean;
  /** 不可用的原因，例如版本太低、是 JRE 不是 JDK */
  reason?: string;
}

export interface RuntimeInfo {
  providerId: string;
  version: string;
  path: string;
  source?: string;
  /** 应用自己下载管理的运行时：启动时要隔离本机环境 */
  managed?: boolean;
  extra?: Record<string, string>;
}

export interface InstallGuide {
  title: string;
  minVersion: string;
  links: { label: string; url: string }[];
  /** 按平台给出的安装命令 */
  commands: Partial<Record<'darwin' | 'win32' | 'linux', string>>;
  /** 无需安装的备选 provider，例如浏览器内 Pyodide */
  fallbackProviderId?: string;
  notes?: string[];
}

/** 一个运行中的内核连接 */
export interface KernelConnection {
  send(text: string): Promise<void>;
  onMessage(cb: (msg: KernelResponse) => void): () => void;
  /** 非协议的裸输出，通常是运行时自身打印的警告 */
  onRawOutput(cb: (text: string) => void): () => void;
  onExit(cb: (code: number | null) => void): () => void;
  interrupt(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * 中断方式。protocol 表示内核能在执行期间读到 interrupt 消息（Java 的 JShell.stop）；
 * signal 表示执行会占死主线程，只能靠 SIGINT（Python 的 KeyboardInterrupt、Node 的 breakOnSigint）。
 */
export type InterruptStrategy = 'protocol' | 'signal';

export interface LaunchOptions {
  /**
   * 内核进程的工作目录，应是笔记库目录：
   * 用户代码里的相对路径、Node 的 require 都以它为基准。
   * 不给的话宿主会用内核脚本所在目录，那在桌面版里是只读的应用包。
   */
  cwd?: string;
  /** 用户主目录，内置运行时的缓存目录以它为基准 */
  home?: string;
}

export interface RuntimeProvider {
  id: string;
  lang: LangId;
  label: string;
  priority: number;
  interrupt: InterruptStrategy;
  /**
   * 探测所有候选并逐个验证。extraPaths 是用户手动添加的路径，
   * 一并验证后以「手动」为来源列出。
   */
  discover(host: HostBridge, extraPaths: string[]): Promise<RuntimeCandidate[]>;
  launch(host: HostBridge, info: RuntimeInfo, opts?: LaunchOptions): Promise<KernelConnection>;
  install: InstallGuide;
}

export interface ExecuteHandlers {
  onStream?(name: 'stdout' | 'stderr', text: string): void;
  onResult?(data: Record<string, string>): void;
  onDisplay?(data: Record<string, string>): void;
  onError?(ename: string, evalue: string, traceback: string[]): void;
}

export interface CompletionResult {
  anchor: number;
  items: CompletionItem[];
}
