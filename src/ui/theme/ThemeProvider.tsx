import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { debug } from '@core/debug';
import {
  DEFAULT_SELECTION,
  clampFontSizes,
  fontSizeVars,
  normalizeSelection,
  parseTheme,
  resolveThemeVars,
  selectedThemeId,
  toCssText,
  type Appearance,
  type FontSizes,
  type Theme,
  type ThemeSelection,
} from '@core/theme';

/** 用户主题文件里的问题，设置界面里原样列给写主题的人看 */
export interface ThemeIssue {
  source: string;
  message: string;
}

const builtinModules = import.meta.glob<unknown>('../../../themes/*.json', { eager: true, import: 'default' });

/** 默认浅色、默认深色排最前，其余按名字排——文件名的顺序对用户没有意义 */
const PRIORITY: Record<string, number> = { light: 0, dark: 1 };
function byPriorityThenName(a: Theme, b: Theme): number {
  return (PRIORITY[a.id] ?? 2) - (PRIORITY[b.id] ?? 2) || a.name.localeCompare(b.name, 'zh-CN');
}

function loadBuiltins(): Theme[] {
  const out: Theme[] = [];
  for (const [file, raw] of Object.entries(builtinModules)) {
    const result = parseTheme(raw);
    if (!result.ok) {
      debug.error('theme', '内置主题无效', { file, error: result.error });
      continue;
    }
    for (const warning of result.warnings) debug.warn('theme', '内置主题有问题', { file, warning });
    out.push(result.theme);
  }
  return out.sort(byPriorityThenName);
}

/** 内置主题随应用打包、同步可读，所以能在首帧之前就上色 */
export const BUILTIN_THEMES: Theme[] = loadBuiltins();
export const BUILTIN_IDS = new Set(BUILTIN_THEMES.map((t) => t.id));

function requireBase(id: Appearance): Theme {
  const theme = BUILTIN_THEMES.find((t) => t.id === id);
  if (!theme) throw new Error(`缺少默认主题 themes/${id}.json`);
  return theme;
}

/** 所有主题没写的 base 字段从这两份继承；测试保证它们写全了 */
const BASES: Record<Appearance, Theme> = { light: requireBase('light'), dark: requireBase('dark') };

const SELECTION_KEY = 'nx.theme.selection';
const SIZES_KEY = 'nx.theme.fontSizes';
/** 选中的用户主题还没读到时，先用它上次的明暗顶上，免得深色主题启动时先闪一下白 */
const LAST_APPEARANCE_KEY = 'nx.theme.lastAppearance';
const STYLE_ID = 'nx-theme';

function storageGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 无痕模式等场景忽略 */
  }
}

function readSelection(): ThemeSelection {
  const stored = storageGet(SELECTION_KEY);
  if (stored) {
    try {
      const selection = normalizeSelection(JSON.parse(stored));
      if (selection) return selection;
    } catch {
      /* 坏值就走下面的默认 */
    }
  }
  // 从旧的「外观 + 主题包」两个开关迁移过来
  const oldPack = storageGet('nx.theme.pack');
  if (oldPack) return { mode: 'fixed', theme: oldPack };
  const oldMode = storageGet('nx.theme.mode');
  if (oldMode === 'light' || oldMode === 'dark') return { mode: 'fixed', theme: oldMode };
  return DEFAULT_SELECTION;
}

function readFontSizes(): FontSizes {
  const stored = storageGet(SIZES_KEY);
  try {
    return clampFontSizes(stored ? JSON.parse(stored) : {});
  } catch {
    return clampFontSizes({});
  }
}

function systemPrefersDark(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
}

interface Computed {
  css: string;
  theme: Theme;
  /** 选中的主题找不到，用了同明暗的默认主题顶替 */
  fellBack: boolean;
}

function compute(themes: Theme[], selection: ThemeSelection, systemDark: boolean, sizes: FontSizes): Computed {
  const wanted = selectedThemeId(selection, systemDark);
  const found = themes.find((t) => t.id === wanted);
  const appearance: Appearance =
    selection.mode === 'system'
      ? systemDark
        ? 'dark'
        : 'light'
      : storageGet(LAST_APPEARANCE_KEY) === 'dark'
        ? 'dark'
        : 'light';
  const theme = found ?? BASES[appearance];
  return {
    css: toCssText({ ...resolveThemeVars(theme, BASES), ...fontSizeVars(sizes) }),
    theme,
    fellBack: !found,
  };
}

function applyCss(computed: Computed) {
  let el = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = STYLE_ID;
    document.head.appendChild(el);
  }
  if (el.textContent !== computed.css) el.textContent = computed.css;
  document.documentElement.dataset.appearance = computed.theme.appearance;
}

/** 首帧之前同步上色：内置主题和本地偏好都能同步读到，不必等 React 挂载 */
export function bootstrapTheme() {
  applyCss(compute(BUILTIN_THEMES, readSelection(), systemPrefersDark(), readFontSizes()));
}

interface ThemeContextValue {
  /** 内置主题在前，用户主题在后 */
  themes: Theme[];
  selection: ThemeSelection;
  setSelection(selection: ThemeSelection): void;
  fontSizes: FontSizes;
  setFontSizes(sizes: FontSizes): void;
  /** 实际生效的主题 */
  active: Theme;
  issues: ThemeIssue[];
  setUserThemes(themes: Theme[], issues: ThemeIssue[]): void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [userThemes, setUserThemesState] = useState<Theme[]>([]);
  const [issues, setIssues] = useState<ThemeIssue[]>([]);
  const [selection, setSelection] = useState<ThemeSelection>(readSelection);
  const [fontSizes, setFontSizesState] = useState<FontSizes>(readFontSizes);
  const [systemDark, setSystemDark] = useState(systemPrefersDark);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setSystemDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const themes = useMemo(() => [...BUILTIN_THEMES, ...[...userThemes].sort(byPriorityThenName)], [userThemes]);
  const computed = useMemo(
    () => compute(themes, selection, systemDark, fontSizes),
    [themes, selection, systemDark, fontSizes],
  );

  useEffect(() => {
    applyCss(computed);
    if (!computed.fellBack) storageSet(LAST_APPEARANCE_KEY, computed.theme.appearance);
    debug.log('theme', '应用主题', {
      id: computed.theme.id,
      appearance: computed.theme.appearance,
      fellBack: computed.fellBack,
    });
  }, [computed]);

  useEffect(() => {
    storageSet(SELECTION_KEY, JSON.stringify(selection));
    // 旧的两个开关迁移过一次就不再需要
    try {
      localStorage.removeItem('nx.theme.mode');
      localStorage.removeItem('nx.theme.pack');
    } catch {
      /* 忽略 */
    }
  }, [selection]);

  const setFontSizes = useCallback((next: FontSizes) => {
    const clamped = clampFontSizes(next);
    setFontSizesState(clamped);
    storageSet(SIZES_KEY, JSON.stringify(clamped));
  }, []);

  /** 用户主题每次整组替换：文件删了，列表里也要跟着消失 */
  const setUserThemes = useCallback((next: Theme[], nextIssues: ThemeIssue[]) => {
    setUserThemesState((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    setIssues((prev) => (JSON.stringify(prev) === JSON.stringify(nextIssues) ? prev : nextIssues));
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({
      themes,
      selection,
      setSelection,
      fontSizes,
      setFontSizes,
      active: computed.theme,
      issues,
      setUserThemes,
    }),
    [themes, selection, fontSizes, setFontSizes, computed.theme, issues, setUserThemes],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme 必须在 ThemeProvider 内使用');
  return ctx;
}
