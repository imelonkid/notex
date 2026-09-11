/**
 * 内置运行时的安装：下载 → 校验 → 解压 → 落到 ~/.notex/runtimes/<id>/<version>/。
 *
 * 只依赖 HostBridge，开发服务器和桌面壳共用。下载用本机 curl，解压用本机 tar，
 * 和解析 Maven 依赖是同一个思路：不把几十 MB 的二进制在前后端之间来回搬。
 */
import type { HostBridge } from '../../host/HostBridge';
import { type CatalogRuntime, type RuntimeBuild, installSegments, needsStrip } from './catalog';

export interface InstallProgress {
  phase: 'download' | 'verify' | 'unpack' | 'done';
  /** 已下载字节数，下载阶段有效 */
  received?: number;
  total?: number;
  /** 正在用第几个地址（从 1 起） */
  attempt?: number;
}

export type ProgressFn = (p: InstallProgress) => void;

/** 下载阶段最长等这么久；国内下 100 多 MB 的包可能要好几分钟 */
const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const POLL_MS = 400;

function tmpArchive(host: HostBridge, home: string, runtime: CatalogRuntime): string {
  return host.joinPath(home, '.notex', 'cache', 'downloads', `${runtime.id}-${runtime.version}.tar.gz`);
}

/** 安装目录，与 catalog.installSegments 一致 */
export function installDir(host: HostBridge, home: string, runtime: Pick<CatalogRuntime, 'id' | 'version'>): string {
  return host.joinPath(home, ...installSegments(runtime));
}

/** 已经装好了吗：入口文件在不在 */
export async function isInstalled(host: HostBridge, home: string, runtime: CatalogRuntime): Promise<boolean> {
  return await host.fileExists(host.joinPath(installDir(host, home, runtime), runtime.entry));
}

/**
 * 从清单里的构建安装。依次尝试各个地址，一个下不动换下一个；
 * 校验失败的包直接删掉，绝不解压。
 */
export async function installRuntime(
  host: HostBridge,
  home: string,
  runtime: CatalogRuntime,
  build: RuntimeBuild,
  onProgress: ProgressFn = () => undefined,
): Promise<string> {
  const archive = tmpArchive(host, home, runtime);
  await host.ensureDir(host.joinPath(home, '.notex', 'cache', 'downloads'));

  // 上次下了一半或已经下好的包：哈希对得上就直接用，省一次下载
  if (await host.fileExists(archive)) {
    onProgress({ phase: 'verify' });
    if ((await host.sha256(archive)) === build.sha256) {
      return await unpackVerified(host, home, runtime, archive, onProgress);
    }
    await host.removeFile(archive).catch(() => undefined);
  }

  let lastError = '';
  for (let i = 0; i < build.urls.length; i += 1) {
    const url = build.urls[i];
    onProgress({ phase: 'download', received: 0, total: build.size, attempt: i + 1 });
    const ok = await download(host, url, archive, build.size, (received) =>
      onProgress({ phase: 'download', received, total: build.size, attempt: i + 1 }),
    );
    if (!ok.ok) {
      lastError = ok.error;
      await host.removeFile(archive).catch(() => undefined);
      continue;
    }
    onProgress({ phase: 'verify' });
    const digest = await host.sha256(archive);
    if (digest !== build.sha256) {
      lastError = `校验失败：${url}`;
      await host.removeFile(archive).catch(() => undefined);
      continue;
    }
    return await unpackVerified(host, home, runtime, archive, onProgress);
  }
  throw new Error(`下载失败：${lastError || '所有地址都不可用'}`);
}

/** 用户自己下好的包：只校验不下载 */
export async function installFromFile(
  host: HostBridge,
  home: string,
  runtime: CatalogRuntime,
  build: RuntimeBuild,
  file: string,
  onProgress: ProgressFn = () => undefined,
): Promise<string> {
  onProgress({ phase: 'verify' });
  const digest = await host.sha256(file);
  if (digest !== build.sha256) {
    throw new Error('这个文件的校验值和清单不一致，可能下载不完整或不是这个版本');
  }
  return await unpackVerified(host, home, runtime, file, onProgress);
}

async function download(
  host: HostBridge,
  url: string,
  dest: string,
  total: number,
  onBytes: (received: number) => void,
): Promise<{ ok: true } | { ok: false; error: string }> {
  // curl 在后台写文件，这边按文件大小轮询画进度；-C - 让中断的下载能续
  let stop = false;
  const poll = (async () => {
    while (!stop) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const size = await host.fileSize(dest).catch(() => null);
      if (size !== null) onBytes(Math.min(size, total || size));
    }
  })();
  try {
    const res = await host.exec('curl', ['-fL', '--retry', '2', '-C', '-', '-o', dest, url], {
      timeoutMs: DOWNLOAD_TIMEOUT_MS,
    });
    stop = true;
    await poll;
    if (res.code !== 0) return { ok: false, error: `${url}\n${res.stderr.trim().split('\n').slice(-1)[0] ?? ''}` };
    return { ok: true };
  } catch (e) {
    stop = true;
    await poll;
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** 校验通过的包解压到安装目录。先解到临时目录，成功了再改名过去，装一半的目录不会被当成装好了 */
async function unpackVerified(
  host: HostBridge,
  home: string,
  runtime: CatalogRuntime,
  archive: string,
  onProgress: ProgressFn,
): Promise<string> {
  onProgress({ phase: 'unpack' });
  const dest = installDir(host, home, runtime);
  const staging = `${dest}.partial`;
  await host.removeDir(staging).catch(() => undefined);
  await host.ensureDir(staging);

  const listing = await host.exec('tar', ['-tzf', archive]);
  if (listing.code !== 0) throw new Error(`压缩包读不了：${listing.stderr.trim()}`);
  const first = listing.stdout.split('\n').find((l) => l.trim()) ?? '';
  const args = ['-xzf', archive, '-C', staging];
  if (needsStrip(first)) args.push('--strip-components=1');
  const res = await host.exec('tar', args, { timeoutMs: 10 * 60 * 1000 });
  if (res.code !== 0) {
    await host.removeDir(staging).catch(() => undefined);
    throw new Error(`解压失败：${res.stderr.trim()}`);
  }
  if (!(await host.fileExists(host.joinPath(staging, runtime.entry)))) {
    await host.removeDir(staging).catch(() => undefined);
    throw new Error(`包里没有 ${runtime.entry}，清单和包对不上`);
  }
  await host.removeDir(dest).catch(() => undefined);
  await host.renameFile(staging, dest);
  await host.removeFile(archive).catch(() => undefined);
  onProgress({ phase: 'done' });
  return dest;
}

/** 卸载：整个版本目录删掉 */
export async function uninstallRuntime(host: HostBridge, home: string, runtime: Pick<CatalogRuntime, 'id' | 'version'>): Promise<void> {
  await host.removeDir(installDir(host, home, runtime));
}
