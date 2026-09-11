import { useCallback, useEffect, useRef, useState } from 'react';
import { debug } from '@core/debug';
import { readConfig } from '@core/config';
import type { LangId } from '@core/model';
import {
  type Catalog,
  type CatalogRuntime,
  DEFAULT_CATALOG_URL,
  parseCatalog,
  pickBuild,
  runtimesFor,
} from '@core/runtime/catalog';
import {
  type InstallProgress,
  installFromFile,
  installRuntime,
  isInstalled,
  uninstallRuntime,
} from '@core/runtime/installer';
import type { HostBridge } from '@host/HostBridge';

type LoadState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; catalog: Catalog; warnings: string[]; url: string }
  | { status: 'error'; error: string; url: string };

export interface InstallJob {
  key: string;
  progress: InstallProgress;
  error?: string;
}

const keyOf = (r: CatalogRuntime) => `${r.id}@${r.version}`;

/**
 * 内置运行时清单：读取、列出这台机器能装的、安装与卸载。
 * 清单从网络来，失败要能重试；安装是长任务，进度按 key 分开记。
 */
export function useRuntimeCatalog(host: HostBridge) {
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const [installed, setInstalled] = useState<Record<string, boolean>>({});
  const [jobs, setJobs] = useState<Record<string, InstallJob>>({});
  const homeRef = useRef('');

  const load = useCallback(async () => {
    setState({ status: 'loading' });
    let url = DEFAULT_CATALOG_URL;
    try {
      const config = await readConfig(host);
      if (config.runtimeCatalog?.trim()) url = config.runtimeCatalog.trim();
    } catch {
      /* 没有配置就用默认 */
    }
    try {
      const res = await fetch(url, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { catalog, warnings } = parseCatalog(await res.json());
      for (const w of warnings) debug.warn('catalog', '清单条目有问题', { url, warning: w });
      debug.log('catalog', '读取运行时清单', { url, runtimes: catalog.runtimes.length });
      setState({ status: 'ready', catalog, warnings, url });
    } catch (e) {
      const error = String((e as Error)?.message ?? e);
      debug.warn('catalog', '读取运行时清单失败', { url, error });
      setState({ status: 'error', error, url });
    }
  }, [host]);

  /** 哪些已经装好：入口文件在不在磁盘上 */
  const refreshInstalled = useCallback(async () => {
    if (state.status !== 'ready') return;
    try {
      if (!homeRef.current) homeRef.current = await host.homeDir();
    } catch {
      return;
    }
    const next: Record<string, boolean> = {};
    for (const r of state.catalog.runtimes) {
      next[keyOf(r)] = await isInstalled(host, homeRef.current, r).catch(() => false);
    }
    setInstalled(next);
  }, [host, state]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  const runtimesForLang = useCallback(
    (lang: LangId): CatalogRuntime[] =>
      state.status === 'ready' ? runtimesFor(state.catalog, lang, host.platform(), host.arch()) : [],
    [state, host],
  );

  const runJob = useCallback(
    async (runtime: CatalogRuntime, work: (onProgress: (p: InstallProgress) => void) => Promise<string>) => {
      const key = keyOf(runtime);
      const report = (progress: InstallProgress) => setJobs((j) => ({ ...j, [key]: { key, progress } }));
      report({ phase: 'download', received: 0, total: pickBuild(runtime, host.platform(), host.arch())?.size ?? 0 });
      try {
        const dir = await debug.op('catalog', `安装 ${key}`, () => work(report));
        setJobs((j) => {
          const next = { ...j };
          delete next[key];
          return next;
        });
        await refreshInstalled();
        return dir;
      } catch (e) {
        const error = String((e as Error)?.message ?? e);
        setJobs((j) => ({ ...j, [key]: { key, progress: j[key]?.progress ?? { phase: 'download' }, error } }));
        return null;
      }
    },
    [host, refreshInstalled],
  );

  const install = useCallback(
    async (runtime: CatalogRuntime): Promise<string | null> => {
      const build = pickBuild(runtime, host.platform(), host.arch());
      if (!build) return null;
      if (!homeRef.current) homeRef.current = await host.homeDir();
      return runJob(runtime, (p) => installRuntime(host, homeRef.current, runtime, build, p));
    },
    [host, runJob],
  );

  const installFile = useCallback(
    async (runtime: CatalogRuntime, file: string): Promise<string | null> => {
      const build = pickBuild(runtime, host.platform(), host.arch());
      if (!build) return null;
      if (!homeRef.current) homeRef.current = await host.homeDir();
      return runJob(runtime, (p) => installFromFile(host, homeRef.current, runtime, build, file, p));
    },
    [host, runJob],
  );

  const uninstall = useCallback(
    async (runtime: CatalogRuntime) => {
      if (!homeRef.current) homeRef.current = await host.homeDir();
      await debug.op('catalog', `卸载 ${keyOf(runtime)}`, () => uninstallRuntime(host, homeRef.current, runtime));
      await refreshInstalled();
    },
    [host, refreshInstalled],
  );

  const dismissError = useCallback((runtime: CatalogRuntime) => {
    setJobs((j) => {
      const next = { ...j };
      delete next[keyOf(runtime)];
      return next;
    });
  }, []);

  return {
    state,
    reload: load,
    runtimesForLang,
    isInstalled: (r: CatalogRuntime) => !!installed[keyOf(r)],
    jobOf: (r: CatalogRuntime): InstallJob | undefined => jobs[keyOf(r)],
    install,
    installFile,
    uninstall,
    dismissError,
  };
}
