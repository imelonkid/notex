/**
 * 由主题协议的字段表生成用户文档：字段参考（Markdown）和 JSON Schema。
 * 生成脚本与测试共用这里，保证 docs/ 里的协议说明和代码永远一致。
 */

import {
  COLOR_PATTERN,
  FIELDS,
  FONT_PATTERN,
  ID_PATTERN,
  THEME_PROTOCOL,
  type Appearance,
  type Theme,
  type ThemeField,
  type ThemeGroup,
} from './theme';

const GROUP_TITLE: Record<ThemeGroup, string> = {
  colors: '颜色 `colors`',
  fonts: '字体 `fonts`',
  typography: '字重与比例 `typography`',
};

const GENERATED_NOTE = '本文件由 pnpm theme:docs 根据 src/core/theme.ts 生成，请勿手改';

function typeLabel(f: ThemeField): string {
  switch (f.kind) {
    case 'color':
      return '颜色';
    case 'font':
      return '字体栈';
    case 'weight':
      return '字重';
    case 'scale':
      return `倍数 ${f.min}–${f.max}`;
  }
}

function cell(text: string): string {
  return text.replace(/\|/g, '\\|');
}

function defaultCell(f: ThemeField, theme: Theme): string {
  if (f.fallback !== 'base') return `跟随 \`${f.fallback}\``;
  const v = (theme[f.group] as Record<string, string | number>)[f.key];
  return v === undefined ? '—' : `\`${cell(String(v))}\``;
}

export function renderThemeReference(bases: Record<Appearance, Theme>): string {
  const out: string[] = [
    `<!-- ${GENERATED_NOTE} -->`,
    '',
    '# 主题字段参考',
    '',
    `协议版本 \`${THEME_PROTOCOL}\`。这里列的是主题文件里**全部**可以写的字段，不在这里的一律忽略。`,
    '原则、格式、继承与校验规则见 [THEME.md](THEME.md)；在编辑器里引用 [theme.schema.json](theme.schema.json) 可以获得补全和校验。',
    '',
    '「默认」两列怎么读：',
    '',
    '- 写着具体值的字段，主题没写时从**同明暗的默认主题**继承——浅色主题取「默认浅色」列，深色主题取「默认深色」列',
    '- 写着「跟随」的字段，主题没写时**等于同组的另一个字段**。只改基础配色，这些派生颜色会自动跟着协调',
    '',
  ];

  for (const group of ['colors', 'fonts', 'typography'] as ThemeGroup[]) {
    out.push(`## ${GROUP_TITLE[group]}`, '');
    const fields = FIELDS.filter((f) => f.group === group);
    const sections = [...new Set(fields.map((f) => f.section))];
    for (const section of sections) {
      out.push(`### ${section}`, '', '| 字段 | 类型 | 说明 | 默认浅色 | 默认深色 |', '|---|---|---|---|---|');
      for (const f of fields.filter((x) => x.section === section)) {
        out.push(
          `| \`${f.key}\` | ${typeLabel(f)} | ${cell(f.doc)} | ${defaultCell(f, bases.light)} | ${defaultCell(f, bases.dark)} |`,
        );
      }
      out.push('');
    }
  }

  out.push(
    '## 取值格式',
    '',
    '| 类型 | 允许的写法 |',
    '|---|---|',
    '| 颜色 | `#rgb` `#rgba` `#rrggbb` `#rrggbbaa`、`rgb()` `rgba()` `hsl()` `hsla()`、`transparent` |',
    '| 字体栈 | 普通的 CSS 字体列表；不能出现 `; { } ( ) < > \\ / * !` 和换行，引号要成对，最长 300 字符 |',
    '| 字重 | 整数 `100`、`200` … `900` |',
    '| 倍数 | 数字，范围见各字段；实际字号 = 正文字号（用户设置）× 倍数 |',
    '',
  );
  return out.join('\n');
}

function fieldSchema(f: ThemeField): Record<string, unknown> {
  const description = f.fallback === 'base' ? f.doc : `${f.doc}（没写时跟随 ${f.fallback}）`;
  switch (f.kind) {
    case 'color':
      return { type: 'string', pattern: COLOR_PATTERN, description };
    case 'font':
      return { type: 'string', pattern: FONT_PATTERN, description };
    case 'weight':
      return { type: 'integer', minimum: 100, maximum: 900, multipleOf: 100, description };
    case 'scale':
      return { type: 'number', minimum: f.min, maximum: f.max, description };
  }
}

function groupSchema(group: ThemeGroup, description: string): Record<string, unknown> {
  return {
    type: 'object',
    description,
    additionalProperties: false,
    properties: Object.fromEntries(FIELDS.filter((f) => f.group === group).map((f) => [f.key, fieldSchema(f)])),
  };
}

export function renderThemeSchema(): string {
  const schema = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $comment: GENERATED_NOTE,
    title: 'NoteX 主题',
    description: '主题只能改颜色、字体、字重和标题比例。说明见 docs/THEME.md',
    type: 'object',
    required: ['notex-theme', 'id', 'name', 'appearance'],
    additionalProperties: false,
    properties: {
      $schema: { type: 'string' },
      'notex-theme': { const: THEME_PROTOCOL, description: '主题协议版本' },
      id: { type: 'string', pattern: ID_PATTERN, description: '唯一标识：小写字母、数字、连字符，不能和内置主题重复' },
      name: { type: 'string', minLength: 1, maxLength: 40, description: '在设置里显示的名字' },
      author: { type: 'string', maxLength: 80 },
      appearance: { enum: ['light', 'dark'], description: '这是浅色还是深色主题；没写的字段从同明暗的默认主题继承' },
      colors: groupSchema('colors', '颜色'),
      fonts: groupSchema('fonts', '字体栈'),
      typography: groupSchema('typography', '字重与标题比例'),
    },
  };
  return `${JSON.stringify(schema, null, 2)}\n`;
}
