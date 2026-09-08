import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme/tokens.css';
import './ui/theme/app.css';
import { App } from './ui/App';
import { ThemeProvider, useTheme, type ThemePack } from './ui/theme/ThemeProvider';
import { RuntimeProvider } from './ui/RuntimeContext';
import { detectHost } from './host/DevServerHost';
import type { HostBridge } from './host/HostBridge';

/** 从 themes/ 目录加载主题包 */
function ThemeLoader({ children }: { children: React.ReactNode }) {
  const { registerPack } = useTheme();
  useEffect(() => {
    const packs = import.meta.glob<{ default: ThemePack }>('../themes/*.json');
    for (const load of Object.values(packs)) {
      void load().then((m) => registerPack(m.default));
    }
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
