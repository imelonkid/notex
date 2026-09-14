/**
 * 网络相关的小工具：给 curl 配代理。
 *
 * 网页里的 fetch 走系统代理，用户感觉不到；但应用起的 curl 只认环境变量，
 * 从 Finder 启动的应用根本没有 HTTPS_PROXY，于是清单能拉到、包下不动，
 * 报的还是一句 SSL_ERROR_SYSCALL。所以下载前问宿主要一次系统代理，显式传给 curl。
 */
import type { HostBridge } from '../host/HostBridge';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLocalUrl(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** 给 curl 的代理参数；本机地址不走代理，宿主查不到代理就返回空 */
export async function curlProxyArgs(host: HostBridge, url: string): Promise<string[]> {
  if (isLocalUrl(url) || !host.systemProxy) return [];
  try {
    const proxy = await host.systemProxy();
    return proxy ? ['-x', proxy] : [];
  } catch {
    return [];
  }
}

/**
 * 用本机 curl 把一个地址下载到文件。代理、跟随跳转、超时都处理好；
 * 失败返回人话原因。给粘贴图片这类小文件用，大包走 installer 的带进度版本。
 */
export async function fetchToFile(
  host: HostBridge,
  url: string,
  dest: string,
  timeoutMs = 60_000,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const proxy = await curlProxyArgs(host, url);
    const res = await host.exec('curl', ['-fsSL', '--max-time', String(Math.ceil(timeoutMs / 1000)), ...proxy, '-o', dest, url], {
      timeoutMs: timeoutMs + 5000,
    });
    if (res.code !== 0) return { ok: false, error: explainCurl(res.code, res.stderr) };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

/** curl 的退出码翻译成人话，附上下一步该干什么 */
export function explainCurl(code: number, stderr: string): string {
  const last = stderr.trim().split('\n').filter(Boolean).slice(-1)[0] ?? '';
  const hint: Record<number, string> = {
    6: '域名解析失败',
    7: '连不上服务器',
    22: '服务器返回错误（文件可能不存在）',
    28: '连接超时',
    35: '建立 TLS 连接失败，常见于网络被干扰或代理未生效',
    56: '传输中断',
  };
  const why = hint[code] ? `${hint[code]}。` : '';
  return `${why}${last}`.trim();
}
