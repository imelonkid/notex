#!/usr/bin/env node
/**
 * 序列化往返测试。用 tsx 直接跑 TS 源码，不依赖构建产物。
 * 用法：pnpm test:serialize
 */
import assert from 'node:assert/strict';

const { notebookToMarkdown, markdownToNotebook, outputsToJson, applyOutputsJson } = await import(
  './serialize.ts'
);
const { notebookToIpynb, ipynbToNotebook } = await import('./ipynb.ts');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
    passed += 1;
  } catch (e) {
    console.log('  ✗ ' + name);
    console.log('      ' + (e.message ?? e).split('\n').slice(0, 6).join('\n      '));
    process.exitCode = 1;
  }
}

const sample = {
  id: 'nb1',
  title: '混合语言笔记',
  counter: 3,
  created: '2026-01-01T00:00:00.000Z',
  updated: '2026-01-02T00:00:00.000Z',
  cells: [
    { id: 'c1', type: 'md', source: '# 标题\n\n正文有 `行内代码` 和列表：\n\n- 一\n- 二' },
    {
      id: 'c2',
      type: 'code',
      lang: 'java',
      source: 'var xs = java.util.List.of(1, 2, 3);\nxs.size()',
      outputs: [
        { type: 'stream', name: 'stdout', text: '你好\n' },
        { type: 'result', data: { 'text/html': '<table><tr><td>1</td></tr></table>', 'text/plain': '3' } },
      ],
      execN: 1,
      ranWith: 'java',
    },
    { id: 'c3', type: 'md', source: '中间的说明文字' },
    {
      id: 'c4',
      type: 'code',
      lang: 'python',
      source: "print('hi')\nsum([1, 2])",
      outputs: [{ type: 'error', ename: 'ValueError', evalue: '坏了', traceback: ['  行 1'] }],
      execN: 2,
      ranWith: 'python',
    },
    { id: 'c5', type: 'code', lang: 'js', source: 'const a = 1;\na + 1', outputs: [], execN: 3 },
  ],
};

console.log('\nMarkdown 往返');

test('cell 数量与类型保持', () => {
  const back = markdownToNotebook(notebookToMarkdown(sample));
  assert.equal(back.cells.length, sample.cells.length);
  assert.deepEqual(
    back.cells.map((c) => c.type),
    sample.cells.map((c) => c.type),
  );
});

test('代码 cell 的语言与源码保持', () => {
  const back = markdownToNotebook(notebookToMarkdown(sample));
  const codes = back.cells.filter((c) => c.type === 'code');
  const orig = sample.cells.filter((c) => c.type === 'code');
  assert.deepEqual(codes.map((c) => c.lang), orig.map((c) => c.lang));
  assert.deepEqual(codes.map((c) => c.source), orig.map((c) => c.source));
});

test('cell id 保持，使旁车输出能对上', () => {
  const back = markdownToNotebook(notebookToMarkdown(sample));
  const ids = back.cells.filter((c) => c.type === 'code').map((c) => c.id);
  assert.deepEqual(ids, ['c2', 'c4', 'c5']);
});

test('标题与时间戳保持', () => {
  const back = markdownToNotebook(notebookToMarkdown(sample));
  assert.equal(back.title, sample.title);
  assert.equal(back.created, sample.created);
});

test('Markdown 文本内容保持', () => {
  const back = markdownToNotebook(notebookToMarkdown(sample));
  assert.equal(back.cells[0].source, sample.cells[0].source);
  assert.equal(back.cells[2].source, sample.cells[2].source);
});

test('源码里含围栏时用更长的围栏包裹', () => {
  const nb = {
    ...sample,
    cells: [{ id: 'x1', type: 'code', lang: 'js', source: 'const md = `\n```\ninner\n```\n`;', outputs: [] }],
  };
  const back = markdownToNotebook(notebookToMarkdown(nb));
  assert.equal(back.cells.length, 1);
  assert.equal(back.cells[0].source, nb.cells[0].source);
});

test('未闭合的围栏当作普通文本，不吞掉后续内容', () => {
  const nb = markdownToNotebook('前面的话\n\n```java\n没有收尾\n\n后面的话');
  const text = nb.cells.map((c) => c.source).join('\n');
  assert.ok(text.includes('后面的话'), '后续内容不应丢失');
});

test('旁车输出能还原', () => {
  const md = notebookToMarkdown(sample);
  const json = outputsToJson(sample);
  const back = applyOutputsJson(markdownToNotebook(md), json);
  const c2 = back.cells.find((c) => c.id === 'c2');
  assert.equal(c2.outputs.length, 2);
  assert.equal(c2.outputs[0].text, '你好\n');
  assert.equal(c2.outputs[1].data['text/html'], '<table><tr><td>1</td></tr></table>');
  assert.equal(c2.execN, 1);
});

console.log('\n隐藏元数据');

test('meta 往返保持', () => {
  const nb = { ...sample, meta: { uid: 'abc123', tags: ['工作'], aliases: ['周报'] } };
  const back = markdownToNotebook(notebookToMarkdown(nb));
  assert.equal(back.meta.uid, 'abc123');
  assert.deepEqual(back.meta.tags, ['工作']);
  assert.deepEqual(back.meta.aliases, ['周报']);
});

test('未知字段原样保留，便于以后扩展', () => {
  const nb = { ...sample, meta: { uid: 'x', 自定义: { a: 1, b: [2, 3] } } };
  const back = markdownToNotebook(notebookToMarkdown(nb));
  assert.deepEqual(back.meta['自定义'], { a: 1, b: [2, 3] });
});

test('meta 不出现在正文里', () => {
  const md = notebookToMarkdown({ ...sample, meta: { uid: 'zzz' } });
  const body = md.slice(md.indexOf('---', 3) + 3);
  assert.ok(!body.includes('zzz'), '元数据不该进入正文');
  const back = markdownToNotebook(md);
  assert.ok(!back.cells.some((c) => c.source.includes('zzz')), '元数据不该变成 cell');
});

test('没有 meta 的老笔记读出来会补上稳定标识', () => {
  const plain = '---\nnotex: 1\ntitle: "旧笔记"\n---\n正文';
  const back = markdownToNotebook(plain);
  assert.ok(back.meta.uid && back.meta.uid.length > 8, '应自动补 uid');
});

test('meta 内容损坏不影响笔记打开', () => {
  const broken = '---\nnotex: 1\ntitle: "坏的"\nmeta: {不是合法JSON\n---\n# 正文还在';
  const back = markdownToNotebook(broken);
  assert.equal(back.title, '坏的');
  assert.ok(back.cells.some((c) => c.source.includes('正文还在')));
});

test('含引号与换行的 meta 不破坏 frontmatter 结构', () => {
  const nb = { ...sample, meta: { uid: 'x', 备注: '带"引号"\n和换行' } };
  const md = notebookToMarkdown(nb);
  const fmLines = md.split('\n').slice(1, md.split('\n').indexOf('---', 1));
  assert.ok(fmLines.every((l) => l.includes(':')), 'frontmatter 每行都该是键值对');
  const back = markdownToNotebook(md);
  assert.equal(back.meta['备注'], '带"引号"\n和换行');
});

console.log('\nipynb 往返');

test('产出合法的 nbformat 4 结构', () => {
  const doc = JSON.parse(notebookToIpynb(sample));
  assert.equal(doc.nbformat, 4);
  assert.ok(Array.isArray(doc.cells));
  assert.ok(doc.metadata.kernelspec);
});

test('cell 类型、语言、源码保持', () => {
  const back = ipynbToNotebook(notebookToIpynb(sample));
  assert.deepEqual(back.cells.map((c) => c.type), sample.cells.map((c) => c.type));
  const codes = back.cells.filter((c) => c.type === 'code');
  const orig = sample.cells.filter((c) => c.type === 'code');
  assert.deepEqual(codes.map((c) => c.lang), orig.map((c) => c.lang), '混合语言应逐 cell 还原');
  assert.deepEqual(codes.map((c) => c.source), orig.map((c) => c.source));
});

test('输出与执行计数保持', () => {
  const back = ipynbToNotebook(notebookToIpynb(sample));
  const c2 = back.cells.filter((c) => c.type === 'code')[0];
  assert.equal(c2.execN, 1);
  assert.equal(c2.outputs[0].type, 'stream');
  assert.equal(c2.outputs[0].text, '你好\n');
  assert.equal(c2.outputs[1].data['text/plain'], '3');
  assert.equal(c2.outputs[1].data['text/html'], '<table><tr><td>1</td></tr></table>');
});

test('错误输出保持', () => {
  const back = ipynbToNotebook(notebookToIpynb(sample));
  const c4 = back.cells.filter((c) => c.type === 'code')[1];
  assert.equal(c4.outputs[0].type, 'error');
  assert.equal(c4.outputs[0].ename, 'ValueError');
  assert.equal(c4.outputs[0].evalue, '坏了');
});

test('base64 图像不被按行切分', () => {
  const nb = {
    ...sample,
    cells: [
      { id: 'i1', type: 'code', lang: 'java', execN: 1, outputs: [
        { type: 'result', data: { 'image/png': 'iVBORw0KGgoAAAANSUhEUg==', 'text/plain': 'img' } },
      ], source: 'im' },
    ],
  };
  const doc = JSON.parse(notebookToIpynb(nb));
  assert.equal(typeof doc.cells[0].outputs[0].data['image/png'], 'string');
  const back = ipynbToNotebook(notebookToIpynb(nb));
  assert.equal(back.cells[0].outputs[0].data['image/png'], 'iVBORw0KGgoAAAANSUhEUg==');
});

test('missing-runtime 不写进交换格式', () => {
  const nb = {
    ...sample,
    cells: [{ id: 'm1', type: 'code', lang: 'java', source: 'x', outputs: [{ type: 'missing-runtime', lang: 'java' }] }],
  };
  const doc = JSON.parse(notebookToIpynb(nb));
  assert.equal(doc.cells[0].outputs.length, 0);
});

test('外部 ipynb（无 NoteX 元数据）按 kernelspec 判定语言', () => {
  const foreign = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', language: 'python', display_name: 'Python 3' } },
    cells: [
      { cell_type: 'markdown', source: ['# 外部笔记\n'], metadata: {} },
      { cell_type: 'code', execution_count: 1, source: ['print(1)\n'], outputs: [
        { output_type: 'stream', name: 'stdout', text: ['1\n'] },
      ], metadata: {} },
    ],
  });
  const nb = ipynbToNotebook(foreign);
  assert.equal(nb.cells.length, 2);
  assert.equal(nb.cells[1].lang, 'python');
  assert.equal(nb.cells[1].outputs[0].text, '1\n');
});

console.log(`\n${process.exitCode ? '有失败' : `全部通过（${passed} 项）`}\n`);
