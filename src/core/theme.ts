/**
 * 主题协议（版本 1）。
 *
 * 原则：稳定可控、有限度的灵活，不能因为主题引入额外风险。
 * 所以主题只能改四类东西——颜色、字体、字重、标题比例；
 * 尺寸、间距、布局、行为、内容渲染都归框架。完整说明见 docs/THEME.md。
 *
 * FIELDS 是唯一的数据源：
 *   - 主题文件只能写这张表里的 key，值按类型校验，不合法就丢弃
 *   - key 映射到内部 CSS 变量，内部变量以后改名不影响已有主题
 *   - docs/THEME-REFERENCE.md 与 docs/theme.schema.json 由它生成（pnpm theme:docs）
 *
 * 纯函数，不碰 DOM 和宿主，测试与生成脚本都能直接用。
 */

export const THEME_PROTOCOL = 1;

export type Appearance = 'light' | 'dark';
export type ThemeGroup = 'colors' | 'fonts' | 'typography';
export type FieldKind = 'color' | 'font' | 'weight' | 'scale';

export interface ThemeField {
  group: ThemeGroup;
  key: string;
  kind: FieldKind;
  /** 写入哪些内部 CSS 变量，不带 --nx- 前缀 */
  vars: string[];
  /**
   * 主题没写这个字段时取什么：
   * - 'base'：从同明暗的默认主题（themes/light.json、themes/dark.json）继承，默认主题必须写全
   * - 同组另一个字段的 key：跟随那个字段。只改基础配色时，派生出来的颜色会自动协调
   */
  fallback: 'base' | string;
  min?: number;
  max?: number;
  /** 文档里的分节 */
  section: string;
  /** 文档里的一句话说明 */
  doc: string;
}

const color = (section: string, key: string, doc: string, fallback = 'base', vars: string[] = [key]): ThemeField => ({
  group: 'colors',
  key,
  kind: 'color',
  vars,
  fallback,
  section,
  doc,
});

const font = (key: string, doc: string, vars: string[], fallback = 'base'): ThemeField => ({
  group: 'fonts',
  key,
  kind: 'font',
  vars,
  fallback,
  section: '字体',
  doc,
});

const weight = (key: string, doc: string, vars: string[]): ThemeField => ({
  group: 'typography',
  key,
  kind: 'weight',
  vars,
  fallback: 'base',
  section: '字重',
  doc,
});

const scale = (key: string, doc: string, vars: string[], min: number, max: number): ThemeField => ({
  group: 'typography',
  key,
  kind: 'scale',
  vars,
  fallback: 'base',
  min,
  max,
  section: '标题比例',
  doc,
});

export const FIELDS: ThemeField[] = [
  color('表面', 'bg', '页面底色'),
  color('表面', 'bg-subtle', '次一档的底色：代码块、侧栏'),
  color('表面', 'bg-hover', '悬停时的底色'),
  color('表面', 'bg-active', '选中项的底色'),
  color('表面', 'border', '分隔线与弱描边'),
  color('表面', 'border-strong', '输入框、按钮等强描边'),

  color('文字', 'fg', '主文字，也是最深的一档'),
  color('文字', 'fg-soft', '次一档'),
  color('文字', 'fg-muted', '说明文字'),
  color('文字', 'fg-faint', '更弱：占位、提示'),
  color('文字', 'fg-ghost', '最弱：图标、行号'),
  color('文字', 'fg-invert', '深色按钮上的文字'),

  color('语义', 'accent', '强调色'),
  color('语义', 'danger', '危险、出错'),
  color('语义', 'warn', '警告'),
  color('语义', 'success', '成功'),
  color('语义', 'selection', '选中文字的底色'),

  color('阴影与遮罩', 'shadow', '菜单、弹层的阴影颜色'),
  color('阴影与遮罩', 'overlay', '对话框背后的遮罩'),

  color('语法高亮', 'syn-keyword', '关键字'),
  color('语法高亮', 'syn-string', '字符串'),
  color('语法高亮', 'syn-comment', '注释'),
  color('语法高亮', 'syn-number', '数字'),
  color('语法高亮', 'syn-type', '类型'),
  color('语法高亮', 'syn-function', '函数名'),
  color('语法高亮', 'syn-variable', '变量'),
  color('语法高亮', 'syn-operator', '运算符'),
  color('语法高亮', 'syn-punct', '标点'),

  color('代码编辑器', 'editor-selection', '编辑器里选中文字的底色'),
  color('代码编辑器', 'editor-active-line', '光标所在行的底色'),
  color('代码编辑器', 'editor-bg', '编辑器底色', 'bg-subtle'),
  color('代码编辑器', 'editor-caret', '光标', 'fg'),
  color('代码编辑器', 'editor-gutter', '行号', 'fg-ghost'),

  color('笔记大标题', 'title', '笔记大标题的颜色', 'fg', ['title-color']),

  color('Markdown', 'md-text', '正文', 'fg-soft', ['md-color']),
  color('Markdown', 'md-heading', '标题与表头', 'fg', ['md-heading-color']),
  color('Markdown', 'md-strong', '加粗', 'fg', ['md-strong-color']),
  color('Markdown', 'md-link', '链接', 'accent', ['md-link-color']),
  color('Markdown', 'md-code', '行内代码的文字', 'danger', ['md-code-color']),
  color('Markdown', 'md-code-bg', '行内代码的底色', 'bg-hover'),
  color('Markdown', 'md-pre', '代码块的文字', 'fg', ['md-pre-color']),
  color('Markdown', 'md-pre-bg', '代码块的底色', 'bg-subtle'),
  color('Markdown', 'md-pre-border', '代码块的描边', 'border'),
  color('Markdown', 'md-quote', '引用的文字', 'fg-muted', ['md-quote-color']),
  color('Markdown', 'md-quote-border', '引用左侧的竖线', 'border-strong'),
  color('Markdown', 'md-table-border', '表格线', 'border'),
  color('Markdown', 'md-table-head-bg', '表头底色', 'bg-subtle'),
  color('Markdown', 'md-rule', '分隔线', 'border'),

  font('body', '界面与正文', ['font-body']),
  font('mono', '代码', ['font-mono']),
  font('title', '展示用：笔记大标题、品牌名、对话框标题', ['font-heading']),
  font('heading', 'Markdown 标题', ['md-heading-font'], 'body'),

  weight('title-weight', '笔记大标题', ['title-weight']),
  weight('heading-weight', 'Markdown 标题', ['md-heading-weight']),
  weight('strong-weight', '加粗与表头', ['md-strong-weight']),

  scale('h1', '一级标题是正文字号的几倍', ['md-h1-scale'], 0.75, 3),
  scale('h2', '二级标题', ['md-h2-scale'], 0.75, 3),
  scale('h3', '三级标题', ['md-h3-scale'], 0.75, 3),
  scale('h4', '四级标题', ['md-h4-scale'], 0.75, 3),
  scale('h5', '五级标题', ['md-h5-scale'], 0.75, 3),
  scale('h6', '六级标题', ['md-h6-scale'], 0.75, 3),
  scale('code-scale', '行内代码是正文字号的几倍', ['md-code-scale'], 0.7, 1.2),
];

const FIELD_INDEX = new Map(FIELDS.map((f) => [`${f.group}.${f.key}`, f]));

export function findField(group: ThemeGroup, key: string): ThemeField | undefined {
  return FIELD_INDEX.get(`${group}.${key}`);
}

/*
 * 取值格式。这些字符串同时进 JSON Schema，所以写成 schema 能用的正则源码。
 *
 * 值会被拼进 <style>，校验就是安全边界：
 * 颜色只收颜色字面量；字体栈不许出现 ; { } ( ) < > \ / * ! 和控制字符——
 * 挡住结束声明、结束规则、url() 发请求、注释吞掉后续声明、</style> 这几条注入路径。
 */
export const ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,39}$';
export const COLOR_PATTERN =
  '^(#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(rgb|rgba|hsl|hsla)\\(\\s*[-+0-9.%\\s,/]+\\)|transparent)$';
export const FONT_PATTERN = '^[^;{}()<>\\\\/*!\\u0000-\\u001f]{1,300}$';

const ID_RE = new RegExp(ID_PATTERN);
const COLOR_RE = new RegExp(COLOR_PATTERN);
const FONT_RE = new RegExp(FONT_PATTERN);

export interface Theme {
  id: string;
  name: string;
  appearance: Appearance;
  author?: string;
  colors: Record<string, string>;
  fonts: Record<string, string>;
  typography: Record<string, number>;
}

export type ParseResult =
  | { ok: true; theme: Theme; warnings: string[] }
  | { ok: false; error: string; warnings: string[] };

const TOP_LEVEL = new Set(['$schema', 'notex-theme', 'id', 'name', 'author', 'appearance', 'colors', 'fonts', 'typography']);
const GROUPS: ThemeGroup[] = ['colors', 'fonts', 'typography'];

type Checked = { ok: true; value: string | number } | { ok: false; reason: string };

function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') return Number(v);
  return Number.NaN;
}

function checkValue(field: ThemeField, v: unknown): Checked {
  switch (field.kind) {
    case 'color':
      return typeof v === 'string' && COLOR_RE.test(v.trim())
        ? { ok: true, value: v.trim() }
        : { ok: false, reason: '颜色只接受 #rgb、#rgba、#rrggbb、#rrggbbaa、rgb()、rgba()、hsl()、hsla() 或 transparent' };
    case 'font': {
      if (typeof v !== 'string' || !FONT_RE.test(v)) {
        return { ok: false, reason: '字体栈里不能出现 ; { } ( ) < > \\ / * ! 或换行，长度 1 到 300' };
      }
      const count = (ch: string) => v.split(ch).length - 1;
      if (count("'") % 2 !== 0 || count('"') % 2 !== 0) return { ok: false, reason: '引号没有成对' };
      return { ok: true, value: v.trim() };
    }
    case 'weight': {
      const n = toNumber(v);
      return Number.isInteger(n) && n >= 100 && n <= 900 && n % 100 === 0
        ? { ok: true, value: n }
        : { ok: false, reason: '字重只能是 100、200 … 900' };
    }
    case 'scale': {
      const n = toNumber(v);
      return Number.isFinite(n) && n >= (field.min ?? 0) && n <= (field.max ?? Infinity)
        ? { ok: true, value: n }
        : { ok: false, reason: `倍数只能在 ${field.min} 到 ${field.max} 之间` };
    }
  }
}

function preview(v: unknown): string {
  const s = JSON.stringify(v) ?? String(v);
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/** 不在协议里的字段，如果看起来是尺寸或间距，多给一句为什么不行 */
function hintFor(key: string): string {
  return /line-height|gap|indent|padding|margin|width|radius|size|spacing/.test(key)
    ? '——尺寸和间距归框架管，主题不能改'
    : '';
}

export function parseTheme(raw: unknown): ParseResult {
  const warnings: string[] = [];
  const fail = (error: string): ParseResult => ({ ok: false, error, warnings });

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return fail('主题文件必须是一个 JSON 对象');
  const r = raw as Record<string, unknown>;

  if ('tokens' in r) {
    return fail('这是旧版主题格式（tokens 字段），已不再支持。请按 docs/THEME.md 改写成 colors / fonts / typography 三组');
  }
  if (r['notex-theme'] !== THEME_PROTOCOL) return fail(`缺少 "notex-theme": ${THEME_PROTOCOL}，或协议版本不受支持`);
  if (typeof r.id !== 'string' || !ID_RE.test(r.id)) {
    return fail('id 只能用小写字母、数字和连字符，以字母或数字开头，最长 40 个字符');
  }
  if (typeof r.name !== 'string' || !r.name.trim() || r.name.length > 40) return fail('name 必须是 1 到 40 个字符');
  if (r.appearance !== 'light' && r.appearance !== 'dark') return fail('appearance 只能是 "light" 或 "dark"');

  for (const k of Object.keys(r)) {
    if (TOP_LEVEL.has(k)) continue;
    warnings.push(
      k === 'css' ? '不支持 css 字段：主题只能改颜色、字体、字重和标题比例，已忽略' : `未知字段 "${k}"，已忽略`,
    );
  }

  const theme: Theme = {
    id: r.id,
    name: r.name.trim(),
    appearance: r.appearance,
    colors: {},
    fonts: {},
    typography: {},
  };
  if (typeof r.author === 'string') theme.author = r.author.slice(0, 80);

  for (const group of GROUPS) {
    const g = r[group];
    if (g === undefined) continue;
    if (typeof g !== 'object' || g === null || Array.isArray(g)) {
      warnings.push(`${group} 必须是对象，整组已忽略`);
      continue;
    }
    for (const [key, value] of Object.entries(g)) {
      const field = findField(group, key);
      if (!field) {
        warnings.push(`${group}.${key} 不是协议里的字段，已忽略${hintFor(key)}`);
        continue;
      }
      const checked = checkValue(field, value);
      if (!checked.ok) {
        warnings.push(`${group}.${key} 的值 ${preview(value)} 不合法：${checked.reason}，已忽略`);
        continue;
      }
      (theme[group] as Record<string, string | number>)[key] = checked.value;
    }
  }

  return { ok: true, theme, warnings };
}

function ownValue(theme: Theme, field: ThemeField): string | number | undefined {
  return (theme[field.group] as Record<string, string | number>)[field.key];
}

/**
 * 算出一个主题最终写进 :root 的全部变量。
 * 主题自己写的 > 同明暗默认主题的（base 字段）/ 跟随另一个字段（派生字段）。
 */
export function resolveThemeVars(theme: Theme, bases: Record<Appearance, Theme>): Record<string, string> {
  const base = bases[theme.appearance];
  const out: Record<string, string> = {};
  for (const field of FIELDS) {
    const own = ownValue(theme, field);
    let value: string | undefined;
    if (own !== undefined) {
      value = String(own);
    } else if (field.fallback === 'base') {
      const inherited = ownValue(base, field);
      value = inherited === undefined ? undefined : String(inherited);
    } else {
      const target = findField(field.group, field.fallback);
      value = target ? `var(--nx-${target.vars[0]})` : undefined;
    }
    if (value === undefined) continue;
    for (const name of field.vars) out[name] = value;
  }
  return out;
}

/** 变量表转成样式文本。值在 parseTheme 里校验过，这里再兜一次底，绝不写出能跳出声明的字符 */
export function toCssText(vars: Record<string, string>): string {
  const lines = Object.entries(vars).map(([name, value]) => {
    if (!/^[a-z0-9-]+$/.test(name) || /[;{}<>\\]/.test(value)) {
      throw new Error(`拒绝写入不安全的主题变量：${name}`);
    }
    return `  --nx-${name}: ${value};`;
  });
  return `:root {\n${lines.join('\n')}\n}\n`;
}

/* ---------- 用户设置：字号不属于主题 ---------- */

export interface FontSizes {
  /** 界面 */
  ui: number;
  /** Markdown 正文，标题按主题的比例跟着它走 */
  prose: number;
  /** 代码编辑器 */
  code: number;
}

export const DEFAULT_FONT_SIZES: FontSizes = { ui: 13.5, prose: 15, code: 13 };

export const FONT_SIZE_LIMITS: Record<keyof FontSizes, { min: number; max: number; step: number }> = {
  ui: { min: 12, max: 16, step: 0.5 },
  prose: { min: 13, max: 20, step: 1 },
  code: { min: 11, max: 18, step: 1 },
};

/** 读进来的字号一律夹到范围内并对齐步长：本地存的值也可能是坏的 */
export function clampFontSizes(input: unknown): FontSizes {
  const src = typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
  const pick = (k: keyof FontSizes): number => {
    const lim = FONT_SIZE_LIMITS[k];
    const n = toNumber(src[k]);
    if (!Number.isFinite(n)) return DEFAULT_FONT_SIZES[k];
    const snapped = Number((Math.round(n / lim.step) * lim.step).toFixed(2));
    return Math.min(lim.max, Math.max(lim.min, snapped));
  };
  return { ui: pick('ui'), prose: pick('prose'), code: pick('code') };
}

export function fontSizeVars(sizes: FontSizes): Record<string, string> {
  return {
    'font-size': `${sizes.ui}px`,
    'font-size-prose': `${sizes.prose}px`,
    'font-size-code': `${sizes.code}px`,
  };
}

/* ---------- 选主题：固定一个，或跟随系统 ---------- */

export type ThemeSelection = { mode: 'fixed'; theme: string } | { mode: 'system'; light: string; dark: string };

export const DEFAULT_SELECTION: ThemeSelection = { mode: 'system', light: 'light', dark: 'dark' };

export function normalizeSelection(input: unknown): ThemeSelection | null {
  if (typeof input !== 'object' || input === null) return null;
  const s = input as Record<string, unknown>;
  if (s.mode === 'fixed' && typeof s.theme === 'string') return { mode: 'fixed', theme: s.theme };
  if (s.mode === 'system' && typeof s.light === 'string' && typeof s.dark === 'string') {
    return { mode: 'system', light: s.light, dark: s.dark };
  }
  return null;
}

export function selectedThemeId(selection: ThemeSelection, systemDark: boolean): string {
  if (selection.mode === 'fixed') return selection.theme;
  return systemDark ? selection.dark : selection.light;
}
