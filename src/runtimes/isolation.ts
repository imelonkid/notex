/**
 * 内置运行时的隔离启动。
 *
 * 应用自己下载的 Python / Java / Node 放在 ~/.notex/runtimes 下。
 * 它们最容易出的诡异问题是被本机环境悄悄污染：用户的 PYTHONPATH、
 * conda 的一堆变量、~/.local 里的 site-packages、JAVA_TOOL_OPTIONS……
 * 表现为「同一段代码在别人机器上能跑」。所以内置运行时启动时把这些全清掉。
 *
 * 用户自己选的本机运行时保持原样，他要的就是自己的环境。
 */
import type { LangId } from '@core/model';

/** 内置运行时的根目录（相对主目录） */
export const MANAGED_SEGMENTS = ['.notex', 'runtimes'] as const;

function normalize(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 路径是否落在内置运行时目录里 */
export function isManagedPath(path: string, home: string): boolean {
  if (!home) return false;
  const root = `${normalize(home)}/${MANAGED_SEGMENTS.join('/')}/`;
  return normalize(path).startsWith(root);
}

/**
 * 隔离用的环境变量。值为 null 表示从子进程环境里删掉。
 * 只删会改变解释器行为的那些，PATH、HOME、LANG 这类照旧继承。
 */
export function isolatedEnv(lang: LangId, home: string): Record<string, string | null> {
  const cache = `${normalize(home)}/.notex/cache`;
  switch (lang) {
    case 'python':
      return {
        PYTHONPATH: null,
        PYTHONHOME: null,
        PYTHONSTARTUP: null,
        PYTHONUSERBASE: null,
        PYTHONNOUSERSITE: '1',
        VIRTUAL_ENV: null,
        CONDA_PREFIX: null,
        CONDA_DEFAULT_ENV: null,
        // matplotlib 的字体缓存要有个可写的地方，别写进只读的运行时目录
        MPLCONFIGDIR: `${cache}/matplotlib`,
      };
    case 'java':
      return {
        JAVA_TOOL_OPTIONS: null,
        _JAVA_OPTIONS: null,
        JDK_JAVA_OPTIONS: null,
        CLASSPATH: null,
        JAVA_HOME: null,
      };
    case 'js':
      return {
        NODE_OPTIONS: null,
        NODE_PATH: null,
      };
  }
}

/**
 * 隔离用的解释器参数，放在脚本路径之前。
 * Python 的 -I 一次关掉 PYTHON* 变量、用户 site 和脚本目录进 sys.path，
 * 运行时自己的 site-packages 不受影响。
 */
export function isolatedArgs(lang: LangId): string[] {
  return lang === 'python' ? ['-I'] : [];
}
