/**
 * 生成主题协议的用户文档：docs/THEME-REFERENCE.md 与 docs/theme.schema.json。
 * 数据源是 src/core/theme.ts 的字段表，默认值取自 themes/light.json、themes/dark.json。
 * 用法：pnpm theme:docs
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTheme } from '../src/core/theme.ts';
import { renderThemeReference, renderThemeSchema } from '../src/core/themeDocs.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const load = (rel) => {
  const r = parseTheme(JSON.parse(readFileSync(path.join(ROOT, rel), 'utf8')));
  if (!r.ok) throw new Error(`${rel}：${r.error}`);
  return r.theme;
};

const bases = { light: load('themes/light.json'), dark: load('themes/dark.json') };
writeFileSync(path.join(ROOT, 'docs/THEME-REFERENCE.md'), renderThemeReference(bases));
writeFileSync(path.join(ROOT, 'docs/theme.schema.json'), renderThemeSchema());
console.log('已生成 docs/THEME-REFERENCE.md 与 docs/theme.schema.json');
