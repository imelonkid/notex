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

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ThemeProvider>
      <ThemeLoader>
        <Boot />
      </ThemeLoader>
    </ThemeProvider>
  </StrictMode>,
);
