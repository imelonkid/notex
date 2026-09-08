import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme/tokens.css';
import './ui/theme/app.css';
import { App } from './ui/App';
import { ThemeProvider, useTheme, type ThemePack } from './ui/theme/ThemeProvider';
import { RuntimeProvider } from './ui/RuntimeContext';
import { detectHost } from './host/DevServerHost';
import type { HostBridge } from './host/HostBridge';

/**
 * 加载主题包。优先问宿主，它会合并内置 themes/ 与用户 ~/.xnotebook/themes/；
 * 纯浏览器模式下退回打包进来的内置主题。
 */
function ThemeLoader({ children }: { children: React.ReactNode }) {
  const { registerPack } = useTheme();

  useEffect(() => {
    let cancelled = false;

    const loadBundled = () => {
      const modules = import.meta.glob<{ default: ThemePack }>('../themes/*.json');
      for (const load of Object.values(modules)) {
        void load().then((m) => !cancelled && registerPack(m.default));
      }
    };

    void (async () => {
      try {
        const res = await fetch('/__host/themes');
        if (!res.ok) throw new Error(String(res.status));
        const { packs } = (await res.json()) as { packs: ThemePack[] };
        if (cancelled) return;
        if (packs.length) packs.forEach(registerPack);
        else loadBundled();
      } catch {
        loadBundled();
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [registerPack]);

  return <>{children}</>;
}

function Boot() {
  const [host, setHost] = useState<HostBridge | null>(null);

  useEffect(() => {
    void detectHost().then(setHost);
  }, []);

  if (!host) {
    return (
      <div style={{ padding: 40, color: 'var(--nb-fg-faint)', fontSize: 13 }}>正在连接宿主…</div>
    );
  }

  return (
    <RuntimeProvider host={host}>
      <App />
    </RuntimeProvider>
  );
}

const container = document.getElementById('root')!;

// HMR 时复用同一个 root，否则两个 root 会争抢同一容器，
// 触发 CodeMirror 卸载期的 removeChild 报错
declare global {
  interface Window {
    __xnbRoot?: ReturnType<typeof createRoot>;
  }
}
const root = (window.__xnbRoot ??= createRoot(container));

root.render(
  <StrictMode>
    <ThemeProvider>
      <ThemeLoader>
        <Boot />
      </ThemeLoader>
    </ThemeProvider>
  </StrictMode>,
);
