/**
 * 主题协议测试。主题的值会写进页面样式，校验就是安全边界，必须有测试盯着。
 * 用法：tsx src/core/theme.test.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_FONT_SIZES,
  FIELDS,
  clampFontSizes,
  findField,
  normalizeSelection,
  parseTheme,
  resolveThemeVars,
  selectedThemeId,
  toCssText,
} from './theme.ts';
import { renderThemeReference, renderThemeSchema } from './themeDocs.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const results = [];

function test(name, fn) {
  try {
    fn();
    results.push(true);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push(false);
    console.log(`  ✗ ${name}\n      ${e?.message ?? e}`);
  }
}

const readJson = (rel) => JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8'));
const mustParse = (rel) => {
  const r = parseTheme(readJson(rel));
  if (!r.ok) throw new Error(`${rel}：${r.error}`);
  return r.theme;
};
const bases = { light: mustParse('themes/light.json'), dark: mustParse('themes/dark.json') };
const minimal = (extra = {}) => ({ 'notex-theme': 1, id: 'probe', name: '探针', appearance: 'dark', ...extra });

console.log('\n=== 主题协议 ===\n');

test('内置主题全部通过校验，且没有任何警告', () => {
  for (const file of readdirSync(path.join(ROOT, 'themes')).filter((f) => f.endsWith('.json'))) {
    const r = parseTheme(readJson(`themes/${file}`));
    assert.ok(r.ok, `${file}：${r.ok ? '' : r.error}`);
    assert.deepEqual(r.warnings, [], `${file}：${r.warnings.join('；')}`);
  }
});

test('示例主题通过校验，且没有任何警告', () => {
  const r = parseTheme(readJson('examples/themes/ink.json'));
  assert.ok(r.ok, r.ok ? '' : r.error);
  assert.deepEqual(r.warnings, []);
});

test('默认浅色、默认深色把所有 base 字段写全', () => {
  for (const [name, theme] of Object.entries(bases)) {
    for (const f of FIELDS) {
      if (f.fallback === 'base') assert.notEqual(theme[f.group][f.key], undefined, `${name} 缺 ${f.group}.${f.key}`);
    }
  }
});

test('派生字段跟随的是同组真实存在的字段', () => {
  for (const f of FIELDS) {
    if (f.fallback !== 'base') assert.ok(findField(f.group, f.fallback), `${f.group}.${f.key} 跟随了不存在的 ${f.fallback}`);
  }
});

test('颜色值里夹带 CSS 会被拒绝', () => {
  const attacks = [
    'red; } body { display: none } :root {',
    'red</style><script>alert(1)</script>',
    'url(https://example.com/x.png)',
    'var(--nx-fg)',
    'expression(alert(1))',
  ];
  for (const bad of attacks) {
    const r = parseTheme(minimal({ colors: { bg: bad } }));
    assert.ok(r.ok);
    assert.equal(r.theme.colors.bg, undefined, bad);
    assert.equal(r.warnings.length, 1, bad);
  }
});

test('字体栈里夹带分号、url()、注释、换行、落单引号会被拒绝', () => {
  for (const bad of ['Inter; } * { color: red', 'url(https://example.com/a.woff)', 'Inter /* x', 'Inter\n}', "'Inter", 'Inter !important']) {
    const r = parseTheme(minimal({ fonts: { body: bad } }));
    assert.equal(r.theme.fonts.body, undefined, JSON.stringify(bad));
  }
});

test('合法的颜色和字体栈原样接受', () => {
  const r = parseTheme(
    minimal({
      colors: {
        bg: '#2e3440',
        'bg-subtle': '#3b4252aa',
        shadow: 'rgba(0, 0, 0, 0.5)',
        overlay: 'hsl(220 16% 22% / 0.6)',
        'md-code-bg': 'transparent',
      },
      fonts: { title: "'Iowan Old Style', Georgia, serif", body: '"PingFang SC", sans-serif' },
    }),
  );
  assert.deepEqual(r.warnings, []);
  assert.equal(r.theme.colors.overlay, 'hsl(220 16% 22% / 0.6)');
  assert.equal(r.theme.fonts.title, "'Iowan Old Style', Georgia, serif");
});

test('css 字段一律忽略，并说明原因', () => {
  const r = parseTheme(minimal({ css: ':root { --nx-bg: red }' }));
  assert.ok(r.ok);
  assert.match(r.warnings.join('\n'), /不支持 css 字段/);
});

test('尺寸和间距不在协议里，给出提示', () => {
  const r = parseTheme(minimal({ typography: { 'line-height': 1.8 }, colors: { 'md-paragraph-gap': '#000' } }));
  assert.equal(r.warnings.length, 2);
  for (const w of r.warnings) assert.match(w, /尺寸和间距归框架/);
});

test('字重、倍数越界会被拒绝，合法的留下', () => {
  const r = parseTheme(
    minimal({ typography: { 'title-weight': 950, 'heading-weight': 550, h1: 9, 'code-scale': 0.1, h2: 1.4 } }),
  );
  assert.equal(r.warnings.length, 4);
  assert.deepEqual(r.theme.typography, { h2: 1.4 });
});

test('用字符串写的数字也接受', () => {
  const r = parseTheme(minimal({ typography: { h1: '1.8', 'title-weight': '700' } }));
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.theme.typography, { h1: 1.8, 'title-weight': 700 });
});

test('旧版 tokens 格式、缺协议版本、坏 id、坏 appearance 整个拒绝', () => {
  assert.equal(parseTheme({ 'notex-theme': 1, id: 'x', name: 'x', appearance: 'dark', tokens: {} }).ok, false);
  assert.equal(parseTheme({ id: 'x', name: 'x', appearance: 'dark' }).ok, false);
  assert.equal(parseTheme(minimal({ id: 'Bad Id' })).ok, false);
  assert.equal(parseTheme(minimal({ id: '../etc' })).ok, false);
  assert.equal(parseTheme(minimal({ appearance: 'sepia' })).ok, false);
  assert.equal(parseTheme([]).ok, false);
});

test('没写的 base 字段从同明暗的默认主题继承，不会混进另一种明暗的颜色', () => {
  const vars = resolveThemeVars(parseTheme(minimal({ colors: { bg: '#2e3440' } })).theme, bases);
  assert.equal(vars.bg, '#2e3440');
  assert.equal(vars.selection, bases.dark.colors.selection);
  assert.equal(vars['editor-active-line'], bases.dark.colors['editor-active-line']);
  assert.notEqual(vars.selection, bases.light.colors.selection);
});

test('派生字段默认跟随所指的字段，主题写了就用主题的', () => {
  const plain = resolveThemeVars(parseTheme(minimal()).theme, bases);
  assert.equal(plain['md-heading-color'], 'var(--nx-fg)');
  assert.equal(plain['md-heading-font'], 'var(--nx-font-body)');
  const own = resolveThemeVars(parseTheme(minimal({ colors: { 'md-heading': '#ff0000' } })).theme, bases);
  assert.equal(own['md-heading-color'], '#ff0000');
});

test('写样式时再兜一次底：不安全的变量名或值直接抛错', () => {
  assert.throws(() => toCssText({ bg: 'red; }' }));
  assert.throws(() => toCssText({ 'bg;x': 'red' }));
  const css = toCssText(resolveThemeVars(bases.light, bases));
  assert.ok(css.startsWith(':root {\n'));
  assert.ok(!/[{}]/.test(css.slice(':root {'.length, -2)));
});

test('字号夹到允许范围并对齐步长，坏值回到默认', () => {
  assert.deepEqual(clampFontSizes({ ui: 99, prose: 'abc', code: 12.4 }), { ui: 16, prose: DEFAULT_FONT_SIZES.prose, code: 12 });
  assert.deepEqual(clampFontSizes({ ui: 13.3 }), { ui: 13.5, prose: 15, code: 13 });
  assert.deepEqual(clampFontSizes(null), DEFAULT_FONT_SIZES);
});

test('选主题：固定一个，或跟随系统', () => {
  assert.equal(selectedThemeId({ mode: 'fixed', theme: 'nord' }, true), 'nord');
  assert.equal(selectedThemeId({ mode: 'system', light: 'solarized', dark: 'nord' }, false), 'solarized');
  assert.equal(selectedThemeId({ mode: 'system', light: 'solarized', dark: 'nord' }, true), 'nord');
  assert.equal(normalizeSelection({ mode: 'system', light: 'a' }), null);
});

test('协议映射到的每个内部变量，样式里真的用到了', () => {
  const texts = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(css|tsx?)$/.test(name)) texts.push(readFileSync(p, 'utf8'));
    }
  };
  walk(path.join(ROOT, 'src'));
  const all = texts.join('\n');
  const unused = [];
  for (const f of FIELDS) {
    for (const v of f.vars) {
      if (!new RegExp(`var\\(\\s*--nx-${v}\\s*[,)]`).test(all)) unused.push(`${f.group}.${f.key} → --nx-${v}`);
    }
  }
  assert.deepEqual(unused, [], `这些协议字段写了也不会生效：${unused.join('，')}`);
});

test('docs/ 里的字段参考和 JSON Schema 与代码一致', () => {
  const hint = '，运行 pnpm theme:docs 重新生成';
  const ref = readFileSync(path.join(ROOT, 'docs/THEME-REFERENCE.md'), 'utf8');
  const schema = readFileSync(path.join(ROOT, 'docs/theme.schema.json'), 'utf8');
  assert.ok(ref === renderThemeReference(bases), `docs/THEME-REFERENCE.md 过期了${hint}`);
  assert.ok(schema === renderThemeSchema(), `docs/theme.schema.json 过期了${hint}`);
});

const failed = results.filter((ok) => !ok).length;
if (failed) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部通过（${results.length} 项）`);
