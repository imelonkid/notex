#!/usr/bin/env node
/** 链接索引测试。用法：pnpm test:index */
import assert from 'node:assert/strict';

const { extractLinks, stripCodeFences, LinkIndex } = await import('./linkIndex.ts');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
    passed += 1;
  } catch (e) {
    console.log('  ✗ ' + name);
    console.log('      ' + String(e.message ?? e).split('\n').slice(0, 5).join('\n      '));
    process.exitCode = 1;
  }
}

const targets = (md) => extractLinks(md).map((l) => l.target);

console.log('\n链接抽取');

test('两种写法都能抽到', () => {
  assert.deepEqual(targets('见 [[项目A]] 和 [说明](工作/周报.md)'), ['项目A', '工作/周报.md']);
});

test('带显示文字的 wiki 链接取目标而不是文字', () => {
  assert.deepEqual(targets('[[项目A|随便写的文字]]'), ['项目A']);
});

test('带小节的链接拆出锚点', () => {
  const [link] = extractLinks('[[项目A#部署]]');
  assert.equal(link.target, '项目A');
  assert.equal(link.hash, '部署');
});

test('外部链接与纯锚点不计入文档关系', () => {
  assert.deepEqual(targets('[官网](https://x.com) [邮件](mailto:a@b.c) [本页](#小节)'), []);
});

test('重复链接只记一次', () => {
  assert.deepEqual(targets('[[A]] 又见 [[A]] 还有 [[A]]'), ['A']);
});

test('URL 编码的目标会解码', () => {
  assert.deepEqual(targets('[x](%E9%A1%B9%E7%9B%AEA.md)'), ['项目A.md']);
});

console.log('\n代码块里的方括号不算链接');

test('围栏代码块被剔除', () => {
  const md = ['正文 [[真链接]]', '```java', 'var a = list[[0]];', '// [[假链接]]', '```', '结尾'].join('\n');
  assert.deepEqual(targets(md), ['真链接']);
});

test('波浪号围栏同样处理', () => {
  const md = ['~~~python', 'x = d[["k"]]', '~~~', '[[真的]]'].join('\n');
  assert.deepEqual(targets(md), ['真的']);
});

test('行内代码被剔除', () => {
  assert.deepEqual(targets('用 `[[不是链接]]` 表示，真的是 [[是链接]]'), ['是链接']);
});

test('未闭合的围栏不会吞掉全文之外的内容', () => {
  const out = stripCodeFences('前面\n```\n里面\n');
  assert.ok(out.includes('前面'));
  assert.ok(!out.includes('里面'));
});

console.log('\n索引与反链');

const notes = [
  { id: '首页', title: '首页', dir: '' },
  { id: '工作/周报', title: '周报', dir: '工作' },
  { id: '工作/项目A', title: '项目A', dir: '工作' },
];

function freshIndex() {
  const idx = new LinkIndex();
  idx.setNotes(notes);
  idx.put('首页', '看 [[周报]] 和 [[项目A]]');
  idx.put('工作/周报', '回到 [[首页]]，另见 [[不存在的笔记]]');
  idx.put('工作/项目A', '无链接');
  return idx;
}

test('出链被解析成笔记 id', () => {
  const idx = freshIndex();
  assert.deepEqual(
    idx.outLinks('首页').map((l) => l.resolved),
    ['工作/周报', '工作/项目A'],
  );
});

test('反链能找到来源', () => {
  const idx = freshIndex();
  assert.deepEqual(idx.backlinks('首页'), [{ from: '工作/周报', text: '首页' }]);
  assert.deepEqual(idx.backlinks('工作/周报'), [{ from: '首页', text: '周报' }]);
});

test('没人指向的笔记反链为空', () => {
  assert.deepEqual(freshIndex().backlinks('工作/项目A').map((b) => b.from), ['首页']);
  const idx = freshIndex();
  idx.remove('首页');
  assert.deepEqual(idx.backlinks('工作/项目A'), []);
});

test('同一篇里重复指向同一目标，反链只记一条', () => {
  const idx = new LinkIndex();
  idx.setNotes(notes);
  idx.put('首页', '[[周报]] 再来 [[工作/周报]]');
  assert.equal(idx.backlinks('工作/周报').length, 1);
});

test('自引用不算反链', () => {
  const idx = new LinkIndex();
  idx.setNotes(notes);
  idx.put('首页', '指向自己 [[首页]]');
  assert.deepEqual(idx.backlinks('首页'), []);
});

test('断链能被列出来', () => {
  const idx = freshIndex();
  assert.deepEqual(idx.brokenLinks(), [{ from: '工作/周报', target: '不存在的笔记' }]);
});

test('笔记改名后重算解析，反链跟着更新', () => {
  const idx = freshIndex();
  // 「工作/周报」改名成「工作/月报」
  idx.setNotes([
    { id: '首页', title: '首页', dir: '' },
    { id: '工作/月报', title: '月报', dir: '工作' },
    { id: '工作/项目A', title: '项目A', dir: '工作' },
  ]);
  idx.reresolve();
  // 原来指向「周报」的链接解析不到了，变成断链
  assert.equal(idx.backlinks('工作/月报').length, 0);
  assert.ok(idx.brokenLinks().some((b) => b.target === '周报'));
});

test('同目录优先：两篇同名笔记时指向近的那篇', () => {
  const idx = new LinkIndex();
  idx.setNotes([
    { id: '周报', title: '周报', dir: '' },
    { id: '工作/周报', title: '周报', dir: '工作' },
    { id: '工作/日志', title: '日志', dir: '工作' },
  ]);
  idx.put('工作/日志', '见 [[周报]]');
  assert.equal(idx.outLinks('工作/日志')[0].resolved, '工作/周报');
});

console.log(`\n${process.exitCode ? '有失败' : `全部通过（${passed} 项）`}\n`);
