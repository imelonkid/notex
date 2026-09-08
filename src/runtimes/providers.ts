import type { HostBridge } from '@host/HostBridge';
import type { RuntimeInfo, RuntimeProvider } from '@core/runtime/types';
import { connectStdioKernel, firstWorking } from './stdioKernel';

/** 收集一种语言的候选可执行文件：手动指定 → 环境变量 → PATH → 版本管理器目录 */
function manualPathFor(lang: 'java' | 'python' | 'js'): string | null {
  return localStorage.getItem(`xnb.runtime.path.${lang}`);
}

async function candidatesFor(host: HostBridge, lang: 'java' | 'python' | 'js'): Promise<string[]> {
  const out: (string | null | undefined)[] = [];
  const home = (await host.env('HOME')) ?? (await host.env('USERPROFILE')) ?? '';
  const win = host.platform() === 'win32';

  if (lang === 'java') {
    const javaHome = await host.env('JAVA_HOME');
    if (javaHome) out.push(`${javaHome}/bin/java${win ? '.exe' : ''}`);
    out.push(await host.which('java'));
    if (home) {
      out.push(`${home}/.sdkman/candidates/java/current/bin/java`);
      out.push(`${home}/.jenv/shims/java`);
    }
    if (host.platform() === 'darwin') {
      // /usr/bin/java 在没装 JDK 时是个会弹窗的存根，靠版本校验筛掉
      out.push('/usr/bin/java');
    }
  } else if (lang === 'python') {
    const venv = await host.env('VIRTUAL_ENV');
    if (venv) out.push(`${venv}/bin/python${win ? '.exe' : '3'}`);
    const conda = await host.env('CONDA_PREFIX');
    if (conda) out.push(`${conda}/bin/python${win ? '.exe' : '3'}`);
    out.push(await host.which('python3'));
    out.push(await host.which('python'));
    if (home) {
      out.push(`${home}/.pyenv/shims/python3`);
      out.push(`${home}/miniconda3/bin/python3`);
      out.push(`${home}/anaconda3/bin/python3`);
    }
  } else {
    out.push(await host.which('node'));
    if (home) {
      out.push(`${home}/.volta/bin/node`);
      out.push(`${home}/.local/share/fnm/aliases/default/bin/node`);
    }
  }

  return out.filter((p): p is string => !!p);
}

export const javaProvider: RuntimeProvider = {
  id: 'java-local',
  lang: 'java',
  label: 'Java (本机 JDK)',
  priority: 10,
  interrupt: 'protocol',

  async detect(host) {
    if (!host.canSpawn) return null;
    const found = await firstWorking(
      host,
      await candidatesFor(host, 'java'),
      ['-version'],
      '17',
      manualPathFor('java'),
    );
    if (!found) return null;

    // jdk.jshell 只在 JDK 里，JRE 要排除掉
    try {
      const mods = await host.exec(found.path, ['--list-modules']);
      if (!/jdk\.jshell/.test(mods.stdout + mods.stderr)) return null;
    } catch {
      return null;
    }

    return { providerId: 'java-local', version: found.version, path: found.path };
  },

  async launch(host, info: RuntimeInfo) {
    const script = await host.kernelPath('java/JavaKernel.java');
    const proc = await host.spawn(info.path, [
      // 内核进程自己不需要图形界面；headless 顺带避免 macOS 上弹出 Dock 图标
      '-Djava.awt.headless=true',
      '-Dapple.awt.UIElement=true',
      // 内核只做编译与转发，分层编译到第一层即可，启动更快
      '-XX:TieredStopAtLevel=1',
      '-XX:+UseSerialGC',
      script,
    ]);
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
      '装好后点"重新检测"，或在设置里手动指定 java 可执行文件路径。',
      '若已装 JDK 仍检测不到，多半是 JAVA_HOME 未设置且不在 PATH 上。',
    ],
  },
};

export const pythonProvider: RuntimeProvider = {
  id: 'python-local',
  lang: 'python',
  label: 'Python (本机)',
  priority: 10,
  interrupt: 'signal',

  async detect(host) {
    if (!host.canSpawn) return null;
    const found = await firstWorking(
      host,
      await candidatesFor(host, 'python'),
      ['--version'],
      '3.8',
      manualPathFor('python'),
    );
    if (!found) return null;
    return { providerId: 'python-local', version: found.version, path: found.path };
  },

  async launch(host, info) {
    const script = await host.kernelPath('python/kernel.py');
    // -u 关闭缓冲，保证 stream 消息实时到达
    const proc = await host.spawn(info.path, ['-u', script]);
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
      '会自动识别当前激活的 virtualenv 和 conda 环境。',
    ],
  },
};

export const nodeProvider: RuntimeProvider = {
  id: 'js-node',
  lang: 'js',
  label: 'JavaScript (本机 Node)',
  priority: 10,
  interrupt: 'signal',

  async detect(host) {
    if (!host.canSpawn) return null;
    const found = await firstWorking(
      host,
      await candidatesFor(host, 'js'),
      ['--version'],
      '18',
      manualPathFor('js'),
    );
    if (!found) return null;
    return { providerId: 'js-node', version: found.version, path: found.path };
  },

  async launch(host, info) {
    const script = await host.kernelPath('node/kernel.mjs');
    const proc = await host.spawn(info.path, [script]);
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
    notes: ['本机 Node 内核可以 require 本地模块，浏览器内执行则不行。'],
  },
};

export const ALL_PROVIDERS: RuntimeProvider[] = [javaProvider, pythonProvider, nodeProvider];
