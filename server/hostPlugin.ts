/**
 * Vite 插件：为前端提供宿主能力（spawn / exec / which / 文件读写）。
 * 开发期让 `pnpm dev` 一条命令同时拿到 UI 和本地进程能力。
 * 生产环境会换成 Tauri 壳，这份实现不参与打包。
 */
import type { Plugin, ViteDevServer } from 'vite';
import { spawn as nodeSpawn, execFile, type ChildProcess as NodeChild } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, access, readdir, mkdir, stat, rm, rename } from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { WebSocketServer, type WebSocket } from 'ws';

const execFileAsync = promisify(execFile);
// new URL('../') 已经指向项目根目录，不要再取 dirname
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const KERNELS = path.join(ROOT, 'kernels');

interface Session {
  proc: NodeChild;
  ws: WebSocket;
}

function json(res: import('node:http').ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

async function readBody(req: import('node:http').IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

/**
 * 这个插件把本机的进程与文件能力暴露在 HTTP/WebSocket 上，
 * 而浏览器对跨源 WebSocket 不做同源限制，跨源的 no-cors POST 也能送达。
 * 不校验来源的话，开着 `pnpm dev` 时访问任意网页就等于把机器交出去。
 * 所以每个请求都要满足：Host 是本机，且 Origin（若有）也是本机。
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function hostnameOf(value: string | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value.includes('://') ? value : `http://${value}`).hostname;
  } catch {
    return null;
  }
}

function isLocalRequest(req: import('node:http').IncomingMessage): boolean {
  const host = hostnameOf(req.headers.host);
  if (!host || !LOCAL_HOSTS.has(host)) return false;
  const origin = req.headers.origin;
  if (origin) {
    const originHost = hostnameOf(origin);
    return !!originHost && LOCAL_HOSTS.has(originHost);
  }
  // 浏览器发跨源请求一定带 Origin 或 Sec-Fetch-Site；两者都没有的是 curl 之类的本机工具
  const site = req.headers['sec-fetch-site'];
  return site === undefined || site === 'same-origin' || site === 'none';
}

/** 能作为内核进程启动的命令：只有三种语言的运行时本体 */
const RUNTIME_BIN = /^(java|python3?(?:\.\d+)?|node)(?:\.exe)?$/i;
/** exec 只用于探测版本、解析依赖，命令面同样收紧 */
const EXEC_BIN = /^(java|python3?(?:\.\d+)?|node|mvn|curl|tar)(?:\.exe|\.cmd|\.bat)?$/i;

function assertBinary(cmd: unknown, allowed: RegExp): string {
  if (typeof cmd !== 'string' || !cmd.trim()) throw new Error('缺少命令');
  if (!allowed.test(path.basename(cmd))) throw new Error('不允许的命令：' + cmd);
  return cmd;
}

/** 只允许启动 kernels/ 目录下的脚本，防止任意命令执行 */
function assertKernelScript(args: unknown): string[] {
  if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) {
    throw new Error('参数格式不正确');
  }
  const script = (args as string[]).find((a) => /\.(java|py|mjs|js)$/.test(a));
  // 找不到脚本参数必须拒绝：放行就等于允许用运行时执行任意代码
  if (!script) throw new Error('缺少内核脚本参数');
  const resolved = path.resolve(script);
  if (!resolved.startsWith(KERNELS + path.sep)) {
    throw new Error('拒绝启动 kernels/ 之外的脚本：' + script);
  }
  return args as string[];
}

/**
 * 「废纸篓」的开发期实现：挪进 ~/.notex/trash，文件名前加时间戳。
 * 桌面版走 Rust 侧的系统废纸篓；这里不用 Finder 的 AppleScript，
 * 那条路实测要等几十秒（Finder 自动化授权与启动），开发时受不了。
 * Linux 上有 gio 就顺手用一下，它是即时的。
 */
async function trashPath(target: string): Promise<void> {
  if (!target) throw new Error('缺少路径');
  try {
    await access(target);
  } catch {
    return;
  }
  const abs = path.resolve(target);
  if (process.platform === 'linux') {
    try {
      await execFileAsync('gio', ['trash', abs]);
      return;
    } catch {
      /* 没有 gio 时走兜底 */
    }
  }
  const dir = path.join(os.homedir(), '.notex', 'trash');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await rename(abs, path.join(dir, `${stamp} ${path.basename(abs)}`));
}

/**
 * 当前生效的代理：先看环境变量，macOS 再问系统设置（scutil --proxy）。
 * 给应用起的 curl 用，它不像网页的 fetch 那样自动走系统代理。
 */
async function systemProxy(): Promise<string | null> {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']) {
    const v = process.env[k];
    if (v) return v;
  }
  if (process.platform !== 'darwin') return null;
  try {
    const { stdout } = await execFileAsync('scutil', ['--proxy']);
    const get = (key: string) => {
      const m = new RegExp(`^\\s*${key}\\s*:\\s*(.+)$`, 'm').exec(stdout);
      return m ? m[1].trim() : '';
    };
    if (get('HTTPSEnable') === '1' && get('HTTPSProxy')) return `http://${get('HTTPSProxy')}:${get('HTTPSPort')}`;
    if (get('HTTPEnable') === '1' && get('HTTPProxy')) return `http://${get('HTTPProxy')}:${get('HTTPPort')}`;
    if (get('SOCKSEnable') === '1' && get('SOCKSProxy')) return `socks5h://${get('SOCKSProxy')}:${get('SOCKSPort')}`;
  } catch {
    /* 没有 scutil 或没配代理 */
  }
  return null;
}

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
};

function isJsonPost(req: import('node:http').IncomingMessage): boolean {
  return req.method === 'POST' && /^application\/json\b/i.test(req.headers['content-type'] ?? '');
}

export function hostPlugin(): Plugin {
  const sessions = new Map<string, Session>();

  return {
    name: 'notex-host',
    configureServer(server: ViteDevServer) {
      const wss = new WebSocketServer({ noServer: true });

      server.httpServer?.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (url.pathname !== '/__host/kernel') return;
        if (!isLocalRequest(req)) {
          socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket as any, head, (ws) => {
          const id = url.searchParams.get('id') ?? Math.random().toString(36).slice(2);

          let cmd: string;
          let args: string[];
          try {
            cmd = assertBinary(url.searchParams.get('cmd'), RUNTIME_BIN);
            args = assertKernelScript(JSON.parse(url.searchParams.get('args') ?? '[]'));
          } catch (e) {
            ws.send(JSON.stringify({ ch: 'error', text: String((e as Error).message) }));
            ws.close();
            return;
          }

          // 工作目录由前端指定（笔记库）；没给或不存在就退回 kernels 目录
          const wanted = url.searchParams.get('cwd');
          const cwd = wanted && existsSync(wanted) ? wanted : KERNELS;

          // 环境变量覆盖：内置运行时要隔离本机环境，null 表示删掉
          const env: NodeJS.ProcessEnv = { ...process.env };
          try {
            const overrides = JSON.parse(url.searchParams.get('env') ?? '{}') as Record<string, string | null>;
            for (const [k, v] of Object.entries(overrides)) {
              if (v === null) delete env[k];
              else if (typeof v === 'string') env[k] = v;
            }
          } catch {
            /* 没有或写坏了就不覆盖 */
          }

          let proc: NodeChild;
          try {
            proc = nodeSpawn(cmd, args, {
              cwd,
              env,
              stdio: ['pipe', 'pipe', 'pipe'],
            });
          } catch (e) {
            ws.send(JSON.stringify({ ch: 'error', text: String(e) }));
            ws.close();
            return;
          }

          sessions.set(id, { proc, ws });
          ws.send(JSON.stringify({ ch: 'spawned', pid: proc.pid ?? 0 }));

          proc.stdout?.setEncoding('utf8');
          proc.stderr?.setEncoding('utf8');
          proc.stdout?.on('data', (d: string) => ws.readyState === 1 && ws.send(JSON.stringify({ ch: 'stdout', text: d })));
          proc.stderr?.on('data', (d: string) => ws.readyState === 1 && ws.send(JSON.stringify({ ch: 'stderr', text: d })));
          proc.on('exit', (code) => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ ch: 'exit', code }));
            sessions.delete(id);
            ws.close();
          });
          proc.on('error', (err) => {
            if (ws.readyState === 1) ws.send(JSON.stringify({ ch: 'error', text: String(err) }));
          });

          ws.on('message', (raw) => {
            let msg: { ch?: string; text?: string; signal?: NodeJS.Signals };
            try {
              msg = JSON.parse(String(raw));
            } catch {
              return;
            }
            if (msg.ch === 'stdin' && msg.text != null) proc.stdin?.write(msg.text);
            else if (msg.ch === 'signal') {
              try {
                proc.kill(msg.signal ?? 'SIGINT');
              } catch {
                /* 已退出 */
              }
            }
          });

          ws.on('close', () => {
            sessions.delete(id);
            try {
              proc.kill('SIGKILL');
            } catch {
              /* 已退出 */
            }
          });
        });
      });

      server.middlewares.use('/__host', async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        if (!isLocalRequest(req)) return json(res, 403, { error: '只接受来自本机页面的请求' });
        // 改动本机状态的接口一律要求 JSON POST：text/plain 的简单请求跨源也能送达
        if (req.method === 'POST' && !isJsonPost(req)) {
          return json(res, 415, { error: '需要 content-type: application/json' });
        }
        try {
          if (url.pathname === '/info') {
            return json(res, 200, { platform: process.platform, arch: process.arch, kernels: KERNELS, home: os.homedir() });
          }
          if (url.pathname === '/proxy') {
            return json(res, 200, { proxy: await systemProxy() });
          }
          if (url.pathname === '/file') {
            // 正文里相对路径的图片由这里提供。只接受本机页面的请求（上面已校验），
            // 和 /read 一样不限定目录：开发服务器本来就等价于本机用户的权限
            const p = url.searchParams.get('path') ?? '';
            try {
              const st = await stat(p);
              if (!st.isFile()) return json(res, 404, { error: '不是文件' });
              res.writeHead(200, {
                'content-type': MIME_BY_EXT[path.extname(p).slice(1).toLowerCase()] ?? 'application/octet-stream',
                'content-length': st.size,
                'cache-control': 'no-cache',
              });
              createReadStream(p).pipe(res);
              return;
            } catch {
              return json(res, 404, { error: '文件不存在' });
            }
          }
          if (url.pathname === '/write-binary' && req.method === 'POST') {
            const body = await readBody(req);
            if (typeof body.path !== 'string' || typeof body.base64 !== 'string') throw new Error('参数格式不正确');
            await mkdir(path.dirname(body.path), { recursive: true });
            await writeFile(body.path, Buffer.from(body.base64, 'base64'));
            return json(res, 200, { ok: true });
          }
          if (url.pathname === '/sha256') {
            const p = url.searchParams.get('path') ?? '';
            const hash = createHash('sha256');
            await new Promise<void>((resolve, reject) => {
              createReadStream(p).on('data', (d) => hash.update(d)).on('end', resolve).on('error', reject);
            });
            return json(res, 200, { sha256: hash.digest('hex') });
          }
          if (url.pathname === '/which') {
            const bin = url.searchParams.get('bin') ?? '';
            const finder = process.platform === 'win32' ? 'where' : 'which';
            try {
              const { stdout } = await execFileAsync(finder, [bin]);
              const first = stdout.split(/\r?\n/).find(Boolean) ?? null;
              return json(res, 200, { path: first });
            } catch {
              return json(res, 200, { path: null });
            }
          }
          if (url.pathname === '/env') {
            return json(res, 200, { value: process.env[url.searchParams.get('name') ?? ''] ?? null });
          }
          if (url.pathname === '/exec' && req.method === 'POST') {
            const body = await readBody(req);
            const cmd = assertBinary(body.cmd, EXEC_BIN);
            const args: unknown[] = Array.isArray(body.args) ? body.args : [];
            if (!args.every((a) => typeof a === 'string')) throw new Error('参数格式不正确');
            // 默认 15 秒够探测版本；下载与解压运行时包要放长，上限一小时
            const timeout = Math.min(Math.max(Number(body.timeoutMs) || 15000, 1000), 60 * 60 * 1000);
            try {
              const { stdout, stderr } = await execFileAsync(cmd, args as string[], {
                timeout,
                maxBuffer: 16 * 1024 * 1024,
              });
              return json(res, 200, { code: 0, stdout, stderr });
            } catch (e: any) {
              return json(res, 200, { code: e?.code ?? 1, stdout: e?.stdout ?? '', stderr: e?.stderr ?? String(e) });
            }
          }
          if (url.pathname === '/read') {
            const p = url.searchParams.get('path') ?? '';
            return json(res, 200, { content: await readFile(p, 'utf8') });
          }
          if (url.pathname === '/write' && req.method === 'POST') {
            const body = await readBody(req);
            await mkdir(path.dirname(body.path), { recursive: true });
            await writeFile(body.path, body.content, 'utf8');
            return json(res, 200, { ok: true });
          }
          if (url.pathname === '/home') {
            return json(res, 200, { home: os.homedir() });
          }
          if (url.pathname === '/list') {
            const dir = url.searchParams.get('path') ?? '';
            try {
              const items = await readdir(dir, { withFileTypes: true });
              const entries = await Promise.all(
                items.map(async (it) => {
                  let modified: string | undefined;
                  try {
                    modified = (await stat(path.join(dir, it.name))).mtime.toISOString();
                  } catch {
                    /* 读不到时间不影响列举 */
                  }
                  return { name: it.name, isDir: it.isDirectory(), modified };
                }),
              );
              return json(res, 200, { entries });
            } catch (e) {
              return json(res, 200, { entries: [], error: String(e) });
            }
          }
          if (url.pathname === '/stat') {
            const target = url.searchParams.get('path') ?? '';
            try {
              const st = await stat(target);
              return json(res, 200, { modified: st.mtime.toISOString(), size: st.size });
            } catch {
              return json(res, 200, { modified: null, size: 0 });
            }
          }
          if (url.pathname === '/mkdir' && req.method === 'POST') {
            const body = await readBody(req);
            await mkdir(body.path, { recursive: true });
            return json(res, 200, { ok: true });
          }
          if (url.pathname === '/remove' && req.method === 'POST') {
            const body = await readBody(req);
            await rm(body.path, { force: true });
            return json(res, 200, { ok: true });
          }
          if (url.pathname === '/trash' && req.method === 'POST') {
            const body = await readBody(req);
            await trashPath(String(body.path ?? ''));
            return json(res, 200, { ok: true });
          }
          if (url.pathname === '/rmdir' && req.method === 'POST') {
            const body = await readBody(req);
            await rm(body.path, { recursive: true, force: true });
            return json(res, 200, { ok: true });
          }
          if (url.pathname === '/rename' && req.method === 'POST') {
            const body = await readBody(req);
            await mkdir(path.dirname(body.to), { recursive: true });
            await rename(body.from, body.to);
            return json(res, 200, { ok: true });
          }
          if (url.pathname === '/exists') {
            const p = url.searchParams.get('path') ?? '';
            try {
              await access(p);
              return json(res, 200, { exists: true });
            } catch {
              return json(res, 200, { exists: false });
            }
          }
        } catch (e) {
          return json(res, 500, { error: String(e) });
        }
        next();
      });

      server.httpServer?.on('close', () => {
        for (const { proc } of sessions.values()) {
          try {
            proc.kill('SIGKILL');
          } catch {
            /* ignore */
          }
        }
        sessions.clear();
      });
    },
  };
}
