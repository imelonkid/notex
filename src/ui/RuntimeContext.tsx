import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { HostBridge, Platform } from '@host/HostBridge';
import { RuntimeRegistry } from '@core/runtime/RuntimeRegistry';
import type { LangState } from '@core/runtime/RuntimeRegistry';
import { ALL_PROVIDERS } from '@runtimes/providers';

interface RuntimeContextValue {
  registry: RuntimeRegistry;
  host: HostBridge;
  platform: Platform;
  states: LangState[];
  /** 每次运行时状态变化都会变，用来触发重渲染 */
  revision: number;
}

const Ctx = createContext<RuntimeContextValue | null>(null);

export function RuntimeProvider({ host, children }: { host: HostBridge; children: ReactNode }) {
  const registry = useMemo(() => new RuntimeRegistry(host, ALL_PROVIDERS), [host]);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    const unsub = registry.subscribe(() => setRevision((r) => r + 1));
    void registry.detectAll();
    const onUnload = () => void registry.shutdownAll();
    window.addEventListener('beforeunload', onUnload);
    return () => {
      unsub();
      window.removeEventListener('beforeunload', onUnload);
      void registry.shutdownAll();
    };
  }, [registry]);

  const value = useMemo<RuntimeContextValue>(
    () => ({
      registry,
      host,
      platform: host.platform(),
      states: registry.all(),
      revision,
    }),
    [registry, host, revision],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useRuntimes(): RuntimeContextValue {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('useRuntimes 必须在 RuntimeProvider 内使用');
  return ctx;
}
