/**
 * 内置运行时的清单（catalog.json）。
 *
 * 清单维护在独立仓库里，二进制放 Releases 并配国内镜像；应用只认这份契约：
 * 读清单、按平台挑构建、下载、校验 sha256、解压到 ~/.notex/runtimes/<id>/<version>/。
 * 解压之后它就是一个普通的候选运行时，探测、选择、隔离启动都走现成的路。
 */
import type { LangId } from '../model';

/** 当前应用能驱动的内核协议版本；清单里更高的包不装 */
export const KERNEL_PROTOCOL = 1;

export type Arch = 'arm64' | 'x64';
export type Platform = 'darwin' | 'win32' | 'linux';

export interface RuntimeBuild {
  platform: Platform;
  arch: Arch;
  /** 压缩包字节数，用来画进度条 */
  size: number;
  /** 压缩包的 sha256，十六进制小写 */
  sha256: string;
  /** 依次尝试的下载地址：Releases 一份、国内镜像一份 */
  urls: string[];
}

export interface CatalogRuntime {
  id: string;
  lang: LangId;
  label: string;
  version: string;
  /** 需要的内核协议版本 */
  protocol: number;
  /** 解压后可执行文件的相对路径，例如 bin/python3 */
  entry: string;
  /** 附带的包，展示给用户看 */
  packages?: string[];
  notes?: string;
  builds: RuntimeBuild[];
}

export interface Catalog {
  version: number;
  runtimes: CatalogRuntime[];
}

/** 默认清单地址；可在 config.json 的 runtimeCatalog 里换成镜像或自建源 */
export const DEFAULT_CATALOG_URL =
  'https://raw.githubusercontent.com/imelonkid/notex/master/runtimes/catalog.json';

const ID_RE = /^[a-z][a-z0-9-]{1,40}$/;
const VERSION_RE = /^[0-9A-Za-z.+-]{1,40}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const LANGS: LangId[] = ['java', 'python', 'js'];

/**
 * 解析并校验清单。写坏的条目整条丢掉并记下原因，不让一处错误拖垮整份清单；
 * id 和 version 要拼进磁盘路径，所以格式必须收紧。
 */
export function parseCatalog(raw: unknown): { catalog: Catalog; warnings: string[] } {
  const warnings: string[] = [];
  const empty: Catalog = { version: 1, runtimes: [] };
  if (!raw || typeof raw !== 'object') return { catalog: empty, warnings: ['清单不是对象'] };
  const obj = raw as Record<string, unknown>;
  const list = Array.isArray(obj.runtimes) ? obj.runtimes : [];
  const runtimes: CatalogRuntime[] = [];
  for (const item of list) {
    const r = item as Record<string, unknown>;
    const where = typeof r?.id === 'string' ? r.id : '(无 id)';
    const fail = (why: string) => warnings.push(`${where}：${why}`);
    if (typeof r?.id !== 'string' || !ID_RE.test(r.id)) {
      fail('id 只能是小写字母、数字和连字符');
      continue;
    }
    if (!LANGS.includes(r.lang as LangId)) {
      fail('lang 必须是 java / python / js');
      continue;
    }
    if (typeof r.version !== 'string' || !VERSION_RE.test(r.version)) {
      fail('version 格式不正确');
      continue;
    }
    if (typeof r.entry !== 'string' || !r.entry || r.entry.includes('..') || r.entry.startsWith('/')) {
      fail('entry 必须是相对路径');
      continue;
    }
    const builds: RuntimeBuild[] = [];
    for (const b of Array.isArray(r.builds) ? (r.builds as Record<string, unknown>[]) : []) {
      if (!['darwin', 'win32', 'linux'].includes(b?.platform as string)) continue;
      if (!['arm64', 'x64'].includes(b?.arch as string)) continue;
      if (typeof b.sha256 !== 'string' || !SHA_RE.test(b.sha256)) {
        fail(`${b.platform}-${b.arch} 的 sha256 不合法`);
        continue;
      }
      const urls = Array.isArray(b.urls) ? b.urls.filter((u): u is string => typeof u === 'string' && /^https?:\/\//.test(u)) : [];
      if (!urls.length) {
        fail(`${b.platform}-${b.arch} 没有可用的下载地址`);
        continue;
      }
      builds.push({
        platform: b.platform as Platform,
        arch: b.arch as Arch,
        size: typeof b.size === 'number' && b.size > 0 ? b.size : 0,
        sha256: b.sha256,
        urls,
      });
    }
    if (!builds.length) {
      fail('没有任何可用的构建');
      continue;
    }
    runtimes.push({
      id: r.id,
      lang: r.lang as LangId,
      label: typeof r.label === 'string' && r.label ? r.label : r.id,
      version: r.version,
      protocol: typeof r.protocol === 'number' ? r.protocol : 1,
      entry: r.entry,
      packages: Array.isArray(r.packages) ? r.packages.filter((p): p is string => typeof p === 'string') : undefined,
      notes: typeof r.notes === 'string' ? r.notes : undefined,
      builds,
    });
  }
  return { catalog: { version: typeof obj.version === 'number' ? obj.version : 1, runtimes }, warnings };
}

/** 这台机器能装的构建；没有就是 null */
export function pickBuild(runtime: CatalogRuntime, platform: string, arch: string): RuntimeBuild | null {
  return runtime.builds.find((b) => b.platform === platform && b.arch === arch) ?? null;
}

/** 某种语言在清单里可装的运行时，协议不兼容的过滤掉 */
export function runtimesFor(catalog: Catalog, lang: LangId, platform: string, arch: string): CatalogRuntime[] {
  return catalog.runtimes.filter(
    (r) => r.lang === lang && r.protocol <= KERNEL_PROTOCOL && pickBuild(r, platform, arch) !== null,
  );
}

/** 安装目录的相对段：~/.notex/runtimes/<id>/<version> */
export function installSegments(runtime: Pick<CatalogRuntime, 'id' | 'version'>): string[] {
  return ['.notex', 'runtimes', runtime.id, runtime.version];
}

/**
 * 压缩包顶层是不是套了一层目录。约定包内直接是 bin/…，
 * 但用 GitHub 自动打包或手工 tar 常会多一层 `<name>/`，解压时要剥掉。
 */
export function needsStrip(firstEntry: string): boolean {
  const clean = firstEntry.replace(/^\.\//, '');
  if (clean.startsWith('bin/') || clean === 'bin') return false;
  return clean.includes('/');
}

/** 人看的体积 */
export function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}
