/**
 * 列表页摘要与时间写法的测试。摘要解析的是用户写的任意内容，边界要有测试盯着。
 * 用法：tsx src/core/noteSummary.test.mjs
 */
import assert from 'node:assert/strict';
import { summarizeMarkdown } from './noteSummary.ts';
import { formatDay, formatUpdated } from './relativeTime.ts';

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

console.log('\n=== 笔记摘要 ===\n');

test('跳过 frontmatter 和标题，取第一段正文并去掉行内标记', () => {
  const md = [
    '---',
    'notex: 1',
    'title: "采样"',
    '---',
    '',
    '# 数据分布',
    '',
    '用 **numpy** 生成样本，参考 [文档](https://numpy.org) 和 [[数据分布图#箱线图|箱线图]] 里的 `plt.hist`。',
    '同一段的第二行。',
    '',
    '另一段，不该出现在摘要里。',
  ].join('\n');
  assert.equal(summarizeMarkdown(md).excerpt, '用 numpy 生成样本，参考 文档 和 箱线图 里的 plt.hist。 同一段的第二行。');
});

test('代码块不进摘要，里面像标题、像正文的行都不算', () => {
  const md = ['```python {id=c1}', '# 这是注释', 'print("hi")', '```', '', '真正的正文。'].join('\n');
  const s = summarizeMarkdown(md);
  assert.equal(s.excerpt, '真正的正文。');
  assert.deepEqual(s.langs, ['python']);
});

test('语言按首次出现的顺序去重，认得 javascript', () => {
  const md = ['```python {id=a}', '1', '```', '```java {id=b}', '2', '```', '```python {id=c}', '3', '```', '```javascript {id=d}', '4', '```'].join('\n');
  assert.deepEqual(summarizeMarkdown(md).langs, ['python', 'java', 'js']);
});

test('更长的围栏里包着 ``` 也不会提前结束', () => {
  const md = ['````java {id=a}', '```', '不是正文', '```', '````', '', '正文在这里。'].join('\n');
  const s = summarizeMarkdown(md);
  assert.equal(s.excerpt, '正文在这里。');
  assert.deepEqual(s.langs, ['java']);
});

test('第一段是列表或引用时去掉标记', () => {
  assert.equal(summarizeMarkdown('- 不能使用除法\n- 时间复杂度 O(n)').excerpt, '不能使用除法 时间复杂度 O(n)');
  assert.equal(summarizeMarkdown('> 输入：[1,2,3,4]').excerpt, '输入：[1,2,3,4]');
});

test('变量名里的下划线原样保留', () => {
  assert.equal(summarizeMarkdown('左边的积 left_product 乘以 right_product').excerpt, '左边的积 left_product 乘以 right_product');
});

test('没有正文就是空串；太长就截断', () => {
  assert.equal(summarizeMarkdown('# 只有标题\n\n---\n').excerpt, '');
  const long = '字'.repeat(200);
  const s = summarizeMarkdown(long).excerpt;
  assert.equal(Array.from(s).length, 81);
  assert.ok(s.endsWith('…'));
});

console.log('\n=== 时间写法 ===\n');

const now = new Date(2026, 8, 11, 12, 0, 0);
const at = (...args) => new Date(...args).toISOString();

test('一小时内写相对时间', () => {
  assert.equal(formatUpdated(at(2026, 8, 11, 11, 59, 40), now), '刚刚');
  assert.equal(formatUpdated(at(2026, 8, 11, 11, 55, 0), now), '5 分钟前');
});

test('今天、昨天带时刻，更早只写日期，跨年带年份', () => {
  assert.equal(formatUpdated(at(2026, 8, 11, 10, 32), now), '今天 10:32');
  assert.equal(formatUpdated(at(2026, 8, 10, 21, 8), now), '昨天 21:08');
  assert.equal(formatUpdated(at(2026, 8, 8, 9, 0), now), '9 月 8 日');
  assert.equal(formatUpdated(at(2025, 11, 31, 9, 0), now), '2025 年 12 月 31 日');
});

test('只到天的写法', () => {
  assert.equal(formatDay(at(2026, 8, 11, 1, 0), now), '今天');
  assert.equal(formatDay(at(2026, 8, 10, 23, 0), now), '昨天');
  assert.equal(formatDay(at(2026, 8, 8, 9, 0), now), '9 月 8 日');
});

test('没有时间或时间写坏了就不显示', () => {
  assert.equal(formatUpdated(undefined, now), '');
  assert.equal(formatUpdated('不是时间', now), '');
  assert.equal(formatDay('', now), '');
});

const failed = results.filter((ok) => !ok).length;
if (failed) {
  console.log(`\n${failed} 项失败`);
  process.exit(1);
}
console.log(`\n全部通过（${results.length} 项）`);
