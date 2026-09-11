import type { HostBridge } from '@host/HostBridge';
import { createLineSplitter, decodeLine } from '@core/runtime/protocol';
import type { KernelResponse } from '@core/runtime/protocol';
import type { KernelConnection, RuntimeCandidate } from '@core/runtime/types';

/**
 * 把一个本地子进程包装成 KernelConnection。
 * 三种语言的内核共用同一套 stdio 协议，因此只需要这一个实现。
 */
export function connectStdioKernel(proc: Awaited<ReturnType<HostBridge['spawn']>>): KernelConnection {
  const msgCbs = new Set<(m: KernelResponse) => void>();
  const rawCbs = new Set<(t: string) => void>();
  const exitCbs = new Set<(c: number | null) => void>();

  const handleLine = (line: string) => {
    const msg = decodeLine(line);
    if (msg) msgCbs.forEach((cb) => cb(msg));
    else rawCbs.forEach((cb) => cb(line));
  };

  proc.onStdout(createLineSplitter(handleLine));
  // stderr 上的内容不会是协议消息，直接当运行时自身的告警展示
  proc.onStderr((chunk) => rawCbs.forEach((cb) => cb(chunk)));
  proc.onExit((code) => exitCbs.forEach((cb) => cb(code)));

  return {
    async send(text: string) {
      await proc.write(text);
    },
    onMessage(cb) {
      msgCbs.add(cb);
      return () => msgCbs.delete(cb);
    },
    onRawOutput(cb) {
      rawCbs.add(cb);
      return () => rawCbs.delete(cb);
    },
    onExit(cb) {
      exitCbs.add(cb);
      return () => exitCbs.delete(cb);
    },
    async interrupt() {
      await proc.kill('SIGINT');
    },
    async dispose() {
      await proc.kill('SIGTERM');
      setTimeout(() => void proc.kill('SIGKILL'), 1500);
    },
  };
}

/** 从 `java -version` / `python3 --version` 之类输出里抠版本号 */
export function parseVersion(text: string): string {
  const m = /(\d+(?:\.\d+){0,3})/.exec(text);
  return m ? m[1] : text.trim().split(/\s+/)[0] || 'unknown';
}

/** 比较形如 17.0.2 的版本号 */
export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split('.').map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** 单个候选是否可用；不可用时返回原因，便于向用户解释 */
async function probe(
  host: HostBridge,
  candidate: string,
  versionArgs: string[],
  minVersion: string,
): Promise<{ path: string; version: string } | { reason: string }> {
  let text: string;
  try {
    const res = await host.exec(candidate, versionArgs);
    text = (res.stdout + '\n' + res.stderr).trim();
  } catch (e) {
    return { reason: `无法执行：${String((e as Error)?.message ?? e)}` };
  }
  if (!text) return { reason: '没有输出版本信息，可能不是有效的可执行文件' };
  const version = parseVersion(text);
  if (!versionAtLeast(version, minVersion)) {
    return { reason: `版本 ${version} 低于要求的 ${minVersion}` };
  }
  return { path: candidate, version };
}

export interface RawCandidate {
  path: string;
  source: string;
}

/**
 * 逐个验证候选，全部列出来而不是命中即停：用户要看到有哪些、为什么不可用。
 * 同一路径出现多次只算一次，保留先出现的来源。
 * validate 是语言自己的额外检查（比如 Java 必须是 JDK），返回不可用的原因。
 */
export async function probeAll(
  host: HostBridge,
  candidates: (RawCandidate | null | undefined)[],
  versionArgs: string[],
  minVersion: string,
  validate?: (path: string) => Promise<string | null>,
): Promise<RuntimeCandidate[]> {
  const out: RuntimeCandidate[] = [];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c?.path || seen.has(c.path)) continue;
    seen.add(c.path);
    // 猜出来的常见位置多半不存在，不存在的不列；用户手动添加的要列出来并说明
    if (!(await host.fileExists(c.path).catch(() => false))) {
      if (c.source === '手动') out.push({ path: c.path, source: c.source, ok: false, reason: '文件不存在' });
      continue;
    }
    const result = await probe(host, c.path, versionArgs, minVersion);
    if ('reason' in result) {
      out.push({ path: c.path, source: c.source, ok: false, reason: result.reason });
      continue;
    }
    const reason = validate ? await validate(c.path) : null;
    out.push({ path: c.path, source: c.source, version: result.version, ok: !reason, reason: reason ?? undefined });
  }
  return out;
}
