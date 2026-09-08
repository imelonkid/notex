import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

/** 主题包：只提供想改的 token，其余从内置主题继承 */
export interface ThemePack {
  id: string;
  name: string;
  appearance: 'light' | 'dark';
  /** key 是去掉 --nb- 前缀的 token 名，如 bg / fg / syn-keyword */
  tokens: Record<string, string>;
  fonts?: Partial<Record<'body' | 'heading' | 'mono', string>>;
  /** 附加 CSS，用于覆盖排版细节 */
  css?: string;
}

export type ThemeMode = 'light' | 'dark' | 'auto';

interface ThemeContextValue {
  mode: ThemeMode;
  setMode(mode: ThemeMode): void;
  packId: string | null;
  setPack(id: string | null): void;
  packs: ThemePack[];
  registerPack(pack: ThemePack): void;
  /** 当前实际生效的明暗，供 CodeMirror 等需要显式知道的地方使用 */
  resolved: 'light' | 'dark';
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

const MODE_KEY = 'xnb.theme.mode';
const PACK_KEY = 'xnb.theme.pack';
const STYLE_ID = 'xnb-theme-pack';

function applyPack(pack: ThemePack | null) {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!pack) {
    el?.remove();
    return;
  }
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  const vars = Object.entries(pack.tokens)
    .map(([k, v]) => `  --nb-${k}: ${v};`)
    .join('\n');
  const fonts = Object.entries(pack.fonts ?? {})
    .map(([k, v]) => `  --nb-font-${k}: ${v};`)
    .join('\n');
  el.textContent = `:root[data-pack="${pack.id}"] {\n${vars}\n${fonts}\n}\n${pack.css ?? ''}`;
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(
    () => (localStorage.getItem(MODE_KEY) as ThemeMode) || 'auto',
  );
  const [packId, setPackIdState] = useState<string | null>(() => localStorage.getItem(PACK_KEY));
  const [packs, setPacks] = useState<ThemePack[]>([]);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: 'light' | 'dark' = mode === 'auto' ? (systemDark ? 'dark' : 'light') : mode;

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    localStorage.setItem(MODE_KEY, mode);
  }, [mode]);

  useEffect(() => {
    const pack = packs.find((p) => p.id === packId) ?? null;
    applyPack(pack);
    if (pack) {
      document.documentElement.dataset.pack = pack.id;
      localStorage.setItem(PACK_KEY, pack.id);
    } else {
      delete document.documentElement.dataset.pack;
      localStorage.removeItem(PACK_KEY);
    }
  }, [packId, packs]);

  const registerPack = useCallback((pack: ThemePack) => {
    setPacks((prev) => (prev.some((p) => p.id === pack.id) ? prev : [...prev, pack]));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      mode,
      setMode: setModeState,
      packId,
      setPack: setPackIdState,
      packs,
      registerPack,
      resolved,
    }),
    [mode, packId, packs, registerPack, resolved],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return ctx;
}
