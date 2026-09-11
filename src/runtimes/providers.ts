import type { HostBridge } from '@host/HostBridge';
import type { LangId } from '@core/model';
import type { LaunchOptions, RuntimeCandidate, RuntimeInfo, RuntimeProvider } from '@core/runtime/types';
import { MANAGED_SEGMENTS, isManagedPath, isolatedArgs, isolatedEnv } from './isolation';
import { type RawCandidate, connectStdioKernel, probeAll } from './stdioKernel';

/**
 * 收集一种语言的候选可执行文件：内置 → 环境变量 → PATH → 版本管理器目录 → 用户手动添加。
 * 顺序只决定列表里的先后和「自动」时的默认选择，用哪个由用户在设置里决定。
 */
async function candidatesFor(host: HostBridge, lang: LangId, extraPaths: string[]): Promise<RawCandidate[]> {
  const out: (RawCandidate | null)[] = [];
  const home = (await host.env('HOME')) ?? (await host.env('USERPROFILE')) ?? '';
  const win = host.platform() === 'win32';
  const exe = win ? '.exe' : '';
  const at = (path: string | null | undefined, source: string): RawCandidate | null =>
    path ? { path, source } : null;

  // 内置运行时：~/.notex/runtimes/<id>/<version>/bin/<exe>
  if (home) out.push(...(await managedCandidates(host, home, lang, exe)));

  if (lang === 'java') {
    const javaHome = await host.env('JAVA_HOME');
    if (javaHome) out.push(at(`${javaHome}/bin/java${exe}`, 'JAVA_HOME'));
    out.push(at(await host.which('java'), 'PATH'));
    if (home) {
      out.push(at(`${home}/.sdkman/candidates/java/current/bin/java`, 'sdkman'));
      out.push(at(`${home}/.jenv/shims/java`, 'jenv'));
    }
    if (host.platform() === 'darwin') {
      // /usr/bin/java 在没装 JDK 时是个会弹窗的存根，靠版本校验筛掉
      out.push(at('/usr/bin/java', '系统'));
    }
  } else if (lang === 'python') {
    const venv = await host.env('VIRTUAL_ENV');
    if (venv) out.push(at(win ? `${venv}\\Scripts\\python.exe` : `${venv}/bin/python3`, 'venv'));
    const conda = await host.env('CONDA_PREFIX');
    if (conda) out.push(at(win ? `${conda}\\python.exe` : `${conda}/bin/python3`, 'conda'));
    out.push(at(await host.which('python3'), 'PATH'));
    out.push(at(await host.which('python'), 'PATH'));
    if (home) {
      out.push(at(`${home}/.pyenv/shims/python3`, 'pyenv'));
      out.push(at(`${home}/miniconda3/bin/python3`, 'miniconda'));
      out.push(at(`${home}/anaconda3/bin/python3`, 'anaconda'));
    }
    if (host.platform() === 'darwin') {
      out.push(at('/opt/homebrew/bin/python3', 'Homebrew'));
      out.push(at('/usr/local/bin/python3', 'Homebrew'));
      out.push(at('/usr/bin/python3', '系统'));
    }
  } else {
    out.push(at(await host.which('node'), 'PATH'));
    if (home) {
      out.push(at(`${home}/.volta/bin/node`, 'volta'));
      out.push(at(`${home}/.local/share/fnm/aliases/default/bin/node`, 'fnm'));
    }
    if (host.platform() === 'darwin') {
      out.push(at('/opt/homebrew/bin/node', 'Homebrew'));
      out.push(at('/usr/local/bin/node', 'Homebrew'));
    }
  }

  for (const p of extraPaths) out.push(at(p, '手动'));
  return out.filter((c): c is RawCandidate => !!c);
}

const MANAGED_EXE: Record<LangId, string> = { java: 'java', python: 'python3', js: 'node' };

/** 扫 ~/.notex/runtimes 下已经装好的内置运行时。目录不存在是常态，静默返回空 */
async function managedCandidates(host: HostBridge, home: string, lang: LangId, exe: string): Promise<RawCandidate[]> {
  const root = host.joinPath(home, ...MANAGED_SEGMENTS);
  const out: RawCandidate[] = [];
  try {
    for (const entry of await host.listDir(root)) {
      if (!entry.isDir) continue;
      const idDir = host.joinPath(root, entry.name);
      for (const ver of await host.listDir(idDir)) {
        if (!ver.isDir) continue;
        const bin = host.joinPath(idDir, ver.name, 'bin', MANAGED_EXE[lang] + exe);
        if (await host.fileExists(bin)) out.push({ path: bin, source: `内置 ${entry.name} ${ver.name}` });
      }
    }
  } catch {
    /* 没有内置运行时 */
  }
  return out;
}

/** 内置运行时隔离启动；本机的照原样 */
async function spawnKernel(host: HostBridge, lang: LangId, info: RuntimeInfo, args: string[], opts?: LaunchOptions) {
  const home = opts?.home ?? '';
  const managed = info.managed ?? isManagedPath(info.path, home);
  return await host.spawn(info.path, managed ? [...isolatedArgs(lang), ...args] : args, {
    cwd: opts?.cwd,
    env: managed ? isolatedEnv(lang, home) : undefined,
  });
}

export const javaProvider: RuntimeProvider = {
  id: 'java-local',
  lang: 'java',
  label: 'Java',
  priority: 10,
  interrupt: 'protocol',

  async discover(host, extraPaths): Promise<RuntimeCandidate[]> {
    if (!host.canSpawn) return [];
    return await probeAll(host, await candidatesFor(host, 'java', extraPaths), ['-version'], '17', async (path) => {
      // jdk.jshell 只在 JDK 里，JRE 要排除掉
      try {
        const mods = await host.exec(path, ['--list-modules']);
        return /jdk\.jshell/.test(mods.stdout + mods.stderr) ? null : '是 JRE 而不是 JDK，没有 jshell';
      } catch {
        return '无法列出模块';
      }
    });
  },

  async launch(host, info: RuntimeInfo, opts) {
    const script = await host.kernelPath('java/JavaKernel.java');
    const proc = await spawnKernel(
      host,
      'java',
      info,
      [
        // 内核进程自己不需要图形界面；headless 顺带避免 macOS 上弹出 Dock 图标
        '-Djava.awt.headless=true',
        '-Dapple.awt.UIElement=true',
        // 内核只做编译与转发，分层编译到第一层即可，启动更快
        '-XX:TieredStopAtLevel=1',
        '-XX:+UseSerialGC',
        script,
      ],
      opts,
    );
    return connectStdioKernel(proc);
  },

  install: {
    title: '未检测到 Java 运行环境',
    minVersion: 'JDK 17 或更高（必须是 JDK，JRE 不含 jshell）',
    links: [
      { label: 'Adoptium 临时版下载', url: 'https://adoptium.net/temurin/releases/' },
      { label: 'Oracle JDK', url: 'https://www.oracle.com/java/technologies/downloads/' },
    ],
    commands: {
      darwin: 'brew install openjdk@21',
      linux: 'sudo apt install openjdk-21-jdk',
      win32: 'winget install EclipseAdoptium.Temurin.21.JDK',
    },
    notes: [
      '装好后点"重新检测"，或在设置里添加 java 可执行文件路径。',
      '若已装 JDK 仍检测不到，多半是 JAVA_HOME 未设置且不在 PATH 上。',
    ],
  },
};

export const pythonProvider: RuntimeProvider = {
  id: 'python-local',
  lang: 'python',
  label: 'Python',
  priority: 10,
  interrupt: 'signal',

  async discover(host, extraPaths) {
    if (!host.canSpawn) return [];
    return await probeAll(host, await candidatesFor(host, 'python', extraPaths), ['--version'], '3.8');
  },

  async launch(host, info, opts) {
    const script = await host.kernelPath('python/kernel.py');
    // -u 关闭缓冲，保证 stream 消息实时到达
    const proc = await spawnKernel(host, 'python', info, ['-u', script], opts);
    return connectStdioKernel(proc);
  },

  install: {
    title: '未检测到 Python 运行环境',
    minVersion: 'Python 3.8 或更高',
    links: [{ label: 'python.org 下载', url: 'https://www.python.org/downloads/' }],
    commands: {
      darwin: 'brew install python@3.12',
      linux: 'sudo apt install python3',
      win32: 'winget install Python.Python.3.12',
    },
    notes: [
      '装了 jedi（pip install jedi）可以获得更准确的补全。',
      '会自动识别当前激活的 virtualenv 和 conda 环境，在设置里可以选用哪一个。',
    ],
  },
};

export const nodeProvider: RuntimeProvider = {
  id: 'js-node',
  lang: 'js',
  label: 'JavaScript',
  priority: 10,
  interrupt: 'signal',

  async discover(host, extraPaths) {
    if (!host.canSpawn) return [];
    return await probeAll(host, await candidatesFor(host, 'js', extraPaths), ['--version'], '18');
  },

  async launch(host, info, opts) {
    const script = await host.kernelPath('node/kernel.mjs');
    const proc = await spawnKernel(host, 'js', info, [script], opts);
    return connectStdioKernel(proc);
  },

  install: {
    title: '未检测到 Node.js 运行环境',
    minVersion: 'Node 18 或更高',
    links: [{ label: 'nodejs.org 下载', url: 'https://nodejs.org/' }],
    commands: {
      darwin: 'brew install node',
      linux: 'sudo apt install nodejs',
      win32: 'winget install OpenJS.NodeJS.LTS',
    },
    notes: ['本机 Node 内核可以 require 笔记库目录下 node_modules 里的模块。'],
  },
};

export const ALL_PROVIDERS: RuntimeProvider[] = [javaProvider, pythonProvider, nodeProvider];
