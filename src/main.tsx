import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme/tokens.css';
import './ui/theme/app.css';
import { App } from './ui/App';
import { ThemeProvider, useTheme, type ThemePack } from './ui/theme/ThemeProvider';
import { RuntimeProvider } from './ui/RuntimeContext';
import { detectHost } from './host/DevServerHost';
import type { HostBridge } from './host/HostBridge';
import { openStore, type StoreSetup } from './core/store/index';
import { RootBoundary } from './ui/components/CellBoundary';
import { attachDebugSink, debug, installGlobalErrorLog } from './core/debug';

/**
 * 加载主题包。优先问宿主，它会合并内置 themes/ 与用户 ~/.notex/themes/；
 * 纯浏览器模式下退回打包进来的内置主题。
 */
function ThemeLoader({ host, children }: { host: HostBridge | null; children: React.ReactNode }) {
  const { registerPack } = useTheme();

  useEffect(() => {
    let cancelled = false;
    const add = (pack: ThemePack) => !cancelled && registerPack(pack);

    // 内置主题打包进了 JS，任何宿主下都可用
    const loadBundled = () => {
      const modules = import.meta.glob<{ default: ThemePack }>('../themes/*.json');
      for (const load of Object.values(modules)) void load().then((m) => add(m.default));
    };

    // 用户放在 ~/.notex/themes 里的主题，需要文件能力
    const loadUserThemes = async () => {
      if (!host) return;
      try {
        const dir = host.joinPath(await host.homeDir(), '.notex', 'themes');
        for (const entry of await host.listDir(dir)) {
          if (entry.isDir || !entry.name.endsWith('.json')) continue;
          try {
            const pack = JSON.parse(await host.readText(host.joinPath(dir, entry.name))) as ThemePack;
            if (typeof pack.css === 'string' && !pack.css.includes('{')) {
              pack.css = await host.readText(host.joinPath(dir, pack.css)).catch(() => '');
            }
            if (pack.id) add(pack);
          } catch {
            // 单个主题坏了不影响其它
          }
        }
      } catch {
        // 目录不存在是常态
      }
    };

    loadBundled();
    void loadUserThemes();

    return () => {
      cancelled = true;
    };
  }, [registerPack, host]);

  return <>{children}</>;
}

function Boot() {
  const [host, setHost] = useState<HostBridge | null>(null);
  const [setup, setSetup] = useState<StoreSetup | null>(null);
  // 改了 vault 之后重新打开存储
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    void detectHost().then((h) => {
      setHost(h);
      void attachDebugSink(h);
    });
  }, []);

  useEffect(() => {
    if (!host) return;
    let cancelled = false;
    setSetup(null);
    void debug
      .op('store', '打开笔记库', () => openStore(host))
      .then((s) => !cancelled && setSetup(s));
    return () => {
      cancelled = true;
    };
  }, [host, reloadKey]);

  if (!host || !setup) {
    return (
      <ThemeLoader host={host}>
        <div style={{ padding: 40, color: 'var(--nx-fg-faint)', fontSize: 13 }}>
          {host ? '正在打开笔记库…' : '正在连接宿主…'}
        </div>
      </ThemeLoader>
    );
  }

  return (
    <ThemeLoader host={host}>
      <RuntimeProvider host={host}>
        <App
          key={setup.vaultPath || 'local'}
          setup={setup}
          onVaultChanged={() => setReloadKey((k) => k + 1)}
        />
      </RuntimeProvider>
    </ThemeLoader>
  );
}

/**
 * 从旧的 xnotebook 命名迁移本地数据，只跑一次。
 * 不覆盖已存在的新键，避免把用户新改的设置冲掉。
 */
function migrateLegacyStorage() {
  try {
    const renames: [string, string][] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i);
      if (!key) continue;
      if (key === 'xnotebook.workspace.v1') renames.push([key, 'notex.workspace.v1']);
      else if (key.startsWith('xnb.')) renames.push([key, 'nx.' + key.slice(4)]);
    }
    for (const [from, to] of renames) {
      const value = localStorage.getItem(from);
      if (value !== null && localStorage.getItem(to) === null) localStorage.setItem(to, value);
      localStorage.removeItem(from);
    }
  } catch {
    /* 无痕模式等场景忽略 */
  }
}

migrateLegacyStorage();
installGlobalErrorLog();

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
      <RootBoundary>
        <Boot />
      </RootBoundary>
    </ThemeProvider>
  </StrictMode>,
);
