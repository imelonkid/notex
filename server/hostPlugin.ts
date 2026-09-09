/**
 * Vite 插件：为前端提供宿主能力（spawn / exec / which / 文件读写）。
 * 开发期让 `pnpm dev` 一条命令同时拿到 UI 和本地进程能力。
 * 生产环境会换成 Tauri 壳，这份实现不参与打包。
 */
import type { Plugin, ViteDevServer } from 'vite';
import { spawn as nodeSpawn, execFile, type ChildProcess as NodeChild } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, access, readdir, mkdir, stat, rm, rename } from 'node:fs/promises';
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

/** 只允许启动 kernels/ 目录下的脚本，防止任意命令执行 */
function assertKernelScript(args: string[]) {
  const script = args.find((a) => /\.(java|py|mjs|js)$/.test(a));
  if (!script) return;
  const resolved = path.resolve(script);
  if (!resolved.startsWith(KERNELS + path.sep)) {
    throw new Error('拒绝启动 kernels/ 之外的脚本：' + script);
  }
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
        wss.handleUpgrade(req, socket as any, head, (ws) => {
          const cmd = url.searchParams.get('cmd') ?? '';
          const args = JSON.parse(url.searchParams.get('args') ?? '[]') as string[];
          const id = url.searchParams.get('id') ?? Math.random().toString(36).slice(2);

          try {
            assertKernelScript(args);
          } catch (e) {
            ws.send(JSON.stringify({ ch: 'error', text: String((e as Error).message) }));
            ws.close();
            return;
          }

          let proc: NodeChild;
          try {
            proc = nodeSpawn(cmd, args, {
              cwd: KERNELS,
              env: { ...process.env },
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
        try {
          if (url.pathname === '/info') {
            return json(res, 200, { platform: process.platform, kernels: KERNELS, home: os.homedir() });
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
            try {
              const { stdout, stderr } = await execFileAsync(body.cmd, body.args ?? [], {
                timeout: 15000,
                maxBuffer: 4 * 1024 * 1024,
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
