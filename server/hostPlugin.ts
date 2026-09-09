/**
 * Vite 插件：为前端提供宿主能力（spawn / exec / which / 文件读写）。
 * 开发期让 `pnpm dev` 一条命令同时拿到 UI 和本地进程能力。
 * 生产环境会换成 Tauri 壳，这份实现不参与打包。
 */
import type { Plugin, ViteDevServer } from 'vite';
import { spawn as nodeSpawn, execFile, type ChildProcess as NodeChild } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, access, readdir, mkdir, stat } from 'node:fs/promises';
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

/** Maven 坐标必须严格校验后才能拼进命令行 */
const COORD_RE = /^[\w.\-]+:[\w.\-]+:[\w.\-+]+(?::[\w.\-]+)?$/;

/**
 * 解析依赖坐标为本地 jar 路径。
 * 有 mvn 就交给它做完整的传递依赖解析；没有则直连 Maven Central
 * 只下载指定的 jar，并明确告知用户不含传递依赖。
 */
async function resolveDeps(coords: string[]): Promise<{
  classpath: string[];
  resolver: 'maven' | 'direct';
  warnings: string[];
}> {
  const warnings: string[] = [];
  for (const c of coords) {
    if (!COORD_RE.test(c)) throw new Error('非法的依赖坐标：' + c);
  }
  if (!coords.length) return { classpath: [], resolver: 'direct', warnings };

  const cacheDir = path.join(os.homedir(), '.notex', 'deps');
  await mkdir(cacheDir, { recursive: true });

  // 优先走 mvn：传递依赖、BOM、exclusions 都由它处理，不自己重造
  let hasMvn = false;
  try {
    await execFileAsync('mvn', ['-v'], { timeout: 20000 });
    hasMvn = true;
  } catch {
    hasMvn = false;
  }

  if (hasMvn) {
    const outFile = path.join(cacheDir, `cp-${Date.now()}.txt`);
    const pom = [
      '<project xmlns="http://maven.apache.org/POM/4.0.0">',
      '<modelVersion>4.0.0</modelVersion>',
      '<groupId>tech.notex</groupId><artifactId>deps</artifactId>',
      '<version>1</version><packaging>pom</packaging><dependencies>',
      ...coords.map((c) => {
        const [g, a, v, classifier] = c.split(':');
        return (
          `<dependency><groupId>${g}</groupId><artifactId>${a}</artifactId>` +
          `<version>${v}</version>` +
          (classifier ? `<classifier>${classifier}</classifier>` : '') +
          '</dependency>'
        );
      }),
      '</dependencies></project>',
    ].join('');
    const pomFile = path.join(cacheDir, `pom-${Date.now()}.xml`);
    await writeFile(pomFile, pom, 'utf8');
    try {
      await execFileAsync(
        'mvn',
        ['-q', '-f', pomFile, 'dependency:build-classpath', `-Dmdep.outputFile=${outFile}`],
        { timeout: 180000, maxBuffer: 16 * 1024 * 1024 },
      );
      const cp = (await readFile(outFile, 'utf8')).trim();
      const jars = cp ? cp.split(path.delimiter).filter(Boolean) : [];
      return { classpath: jars, resolver: 'maven', warnings };
    } catch (e: any) {
      // Maven 的输出尾部是通用样板，挑出真正说明原因的那几行
      const all = String(e?.stdout || '') + '\n' + String(e?.stderr || e?.message || e);
      const meaningful = all
        .split('\n')
        .map((l) => l.replace(/^\[(ERROR|WARNING)\]\s?/, '').trim())
        .filter(
          (l) =>
            l &&
            !/^(To see the full|Re-run Maven|For more information|https?:\/\/cwiki)/.test(l) &&
            /(Could not resolve|Failed to |not found|was not found|Could not find|Non-resolvable)/i.test(l),
        );
      const detail = meaningful.length ? meaningful.slice(0, 3).join('\n') : all.trim().split('\n').slice(-3).join('\n');
      throw new Error('解析依赖失败：\n' + detail);
    } finally {
      await Promise.allSettled([
        writeFile(pomFile, '', 'utf8').then(() => undefined),
      ]);
    }
  }

  // 没有 mvn：直连 Maven Central 下载指定 jar，不做传递解析
  warnings.push('未检测到 mvn，只下载了显式声明的 jar，不含传递依赖。装上 Maven 可获得完整解析。');
  const classpath: string[] = [];
  for (const c of coords) {
    const [g, a, v, classifier] = c.split(':');
    const name = `${a}-${v}${classifier ? '-' + classifier : ''}.jar`;
    const dest = path.join(cacheDir, `${g}-${name}`);
    try {
      const st = await stat(dest);
      if (st.size > 0) {
        classpath.push(dest);
        continue;
      }
    } catch {
      /* 缓存未命中，继续下载 */
    }
    const url = `https://repo1.maven.org/maven2/${g.replace(/\./g, '/')}/${a}/${v}/${name}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败 ${c}（HTTP ${res.status}）\n${url}`);
    await writeFile(dest, Buffer.from(await res.arrayBuffer()));
    classpath.push(dest);
  }
  return { classpath, resolver: 'direct', warnings };
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
            await writeFile(body.path, body.content, 'utf8');
            return json(res, 200, { ok: true });
          }
          if (url.pathname === '/deps' && req.method === 'POST') {
            const body = await readBody(req);
            try {
              return json(res, 200, await resolveDeps(body.coords ?? []));
            } catch (e) {
              return json(res, 200, { error: String((e as Error)?.message ?? e) });
            }
          }
          if (url.pathname === '/themes') {
            // 内置 themes/ 与用户 ~/.notex/themes/ 合并，用户的同 id 覆盖内置
            const dirs = [path.join(ROOT, 'themes'), path.join(os.homedir(), '.notex', 'themes')];
            const packs: unknown[] = [];
            const seen = new Set<string>();
            for (const dir of dirs.reverse()) {
              let entries: string[] = [];
              try {
                entries = await readdir(dir);
              } catch {
                continue;
              }
              for (const name of entries) {
                if (!name.endsWith('.json')) continue;
                try {
                  const pack = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
                  if (!pack?.id || seen.has(pack.id)) continue;
                  // 主题包可以附带同名 .css 文件
                  if (typeof pack.css === 'string' && !pack.css.includes('{')) {
                    try {
                      pack.css = await readFile(path.join(dir, pack.css), 'utf8');
                    } catch {
                      delete pack.css;
                    }
                  }
                  seen.add(pack.id);
                  packs.push(pack);
                } catch {
                  /* 单个主题坏了不影响其它 */
                }
              }
            }
            return json(res, 200, { packs, userDir: path.join(os.homedir(), '.notex', 'themes') });
          }
          if (url.pathname === '/themes/reveal' && req.method === 'POST') {
            // 确保用户主题目录存在，方便用户直接放文件进去
            const dir = path.join(os.homedir(), '.notex', 'themes');
            await mkdir(dir, { recursive: true });
            return json(res, 200, { dir });
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
