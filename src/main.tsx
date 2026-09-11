import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './ui/theme/tokens.css';
import './ui/theme/app.css';
import { App } from './ui/App';
import { BUILTIN_IDS, ThemeProvider, bootstrapTheme, useTheme, type ThemeIssue } from './ui/theme/ThemeProvider';
import { parseTheme, type Theme } from './core/theme';
import { RuntimeProvider } from './ui/RuntimeContext';
import { detectHost } from './host/DevServerHost';
import type { HostBridge } from './host/HostBridge';
import { openStore, type StoreSetup } from './core/store/index';
import { RootBoundary } from './ui/components/CellBoundary';
import { attachDebugSink, debug, installGlobalErrorLog } from './core/debug';

/**
 * 读取用户主题（~/.notex/themes/*.json）。内置主题在 ThemeProvider 里同步加载，不经过这里。
 *
 * 每个文件都过主题协议的校验：不合法的字段丢掉，整个不合法的文件跳过，
 * 问题原样交给设置界面列出来——JSON 写错被静默忽略是写主题时最恼人的事。
 */
function ThemeLoader({ host, children }: { host: HostBridge | null; children: React.ReactNode }) {
  const { setUserThemes } = useTheme();

  useEffect(() => {
    let cancelled = false;
    // 切回窗口会反复读，结果没变就别重复记日志
    let lastReport = '';

    const loadUserThemes = async () => {
      if (!host) return;
      const themes: Theme[] = [];
      const issues: ThemeIssue[] = [];
      let dir = '';
      try {
        dir = host.joinPath(await host.homeDir(), '.notex', 'themes');
        for (const entry of await host.listDir(dir)) {
          if (entry.isDir || !entry.name.endsWith('.json')) continue;
          const note = (message: string) => {
            issues.push({ source: entry.name, message });
          };
          let raw: unknown;
          try {
            raw = JSON.parse(await host.readText(host.joinPath(dir, entry.name)));
          } catch (e) {
            note(`读不了或不是合法的 JSON：${String((e as Error)?.message ?? e)}`);
            continue;
          }
          const result = parseTheme(raw);
          result.warnings.forEach(note);
          if (!result.ok) {
            note(`整个文件未加载：${result.error}`);
            continue;
          }
          const { theme } = result;
          if (BUILTIN_IDS.has(theme.id)) {
            note(`id "${theme.id}" 和内置主题重复，未加载`);
            continue;
          }
          if (themes.some((t) => t.id === theme.id)) {
            note(`id "${theme.id}" 和另一个主题文件重复，未加载`);
            continue;
          }
          themes.push(theme);
        }
      } catch {
        // 目录不存在是常态
      }
      if (cancelled) return;

      const report = JSON.stringify({ ids: themes.map((t) => t.id), issues });
      if (report !== lastReport) {
        lastReport = report;
        for (const issue of issues) debug.warn('theme', `${issue.source}：${issue.message}`);
        debug.log('theme', '读取用户主题', { dir, loaded: themes.length, issues: issues.length });
      }
      setUserThemes(themes, issues);
    };

    void loadUserThemes();

    // 改完主题文件切回应用就生效，不必重启——写主题时要反复看效果
    const onBack = () => {
      if (document.visibilityState === 'visible') void loadUserThemes();
    };
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);

    return () => {
      cancelled = true;
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onBack);
    };
  }, [setUserThemes, host]);

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
      <RuntimeProvider host={host} workDir={setup.vaultPath || undefined}>
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
// 先同步上色再渲染，避免启动时闪一下没有颜色的界面
bootstrapTheme();

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
