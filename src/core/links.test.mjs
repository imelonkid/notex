#!/usr/bin/env node
/** 链接分类测试。用法：pnpm test:links */
import assert from 'node:assert/strict';

const { classifyLink, headingSlug, resolveNoteLink, expandWikiLinks } = await import('./links.ts');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
    passed += 1;
  } catch (e) {
    console.log('  ✗ ' + name);
    console.log('      ' + String(e.message ?? e).split('\n').slice(0, 4).join('\n      '));
    process.exitCode = 1;
  }
}

console.log('\n外部链接');

test('http 与 https 放行', () => {
  assert.deepEqual(classifyLink('https://example.com/a?b=1'), {
    kind: 'external',
    url: 'https://example.com/a?b=1',
  });
  assert.equal(classifyLink('http://example.com').kind, 'external');
});

test('mailto 放行', () => {
  assert.equal(classifyLink('mailto:a@b.com').kind, 'external');
});

test('协议相对写法补成 https', () => {
  assert.deepEqual(classifyLink('//example.com/x'), {
    kind: 'external',
    url: 'https://example.com/x',
  });
});

test('大小写与前后空白不影响判断', () => {
  assert.equal(classifyLink('  HTTPS://example.com  ').kind, 'external');
});

console.log('\n危险协议一律拦截');

for (const [href, label] of [
  ['javascript:alert(1)', 'javascript'],
  ['JavaScript:alert(1)', 'javascript 大小写变形'],
  ['data:text/html,<script>alert(1)</script>', 'data'],
  ['file:///etc/passwd', 'file'],
  ['vbscript:msgbox', 'vbscript'],
  ['blob:https://x/y', 'blob'],
]) {
  test(`拦截 ${label}`, () => {
    assert.equal(classifyLink(href).kind, 'blocked', `${href} 应被拦截`);
  });
}

test('未知自定义协议也拦截', () => {
  assert.equal(classifyLink('slack://channel?id=1').kind, 'blocked');
  assert.equal(classifyLink('notex-evil://x').kind, 'blocked');
});

test('空链接拦截', () => {
  assert.equal(classifyLink('   ').kind, 'blocked');
});

console.log('\n锚点与站内链接');

test('纯锚点', () => {
  assert.deepEqual(classifyLink('#部署步骤'), { kind: 'anchor', target: '部署步骤' });
});

test('锚点做百分号解码', () => {
  assert.deepEqual(classifyLink('#%E9%83%A8%E7%BD%B2'), { kind: 'anchor', target: '部署' });
});

test('相对路径识别为站内链接', () => {
  assert.deepEqual(classifyLink('工作/项目A.md'), { kind: 'internal', target: '工作/项目A.md' });
  assert.deepEqual(classifyLink('./同级.md'), { kind: 'internal', target: './同级.md' });
});

test('站内链接带锚点时拆开', () => {
  assert.deepEqual(classifyLink('项目A.md#部署'), {
    kind: 'internal',
    target: '项目A.md',
    hash: '部署',
  });
});

test('上跳路径此阶段仍归为站内，由解析层做越界校验', () => {
  // 这里只做分类；是否越界属于路径解析的职责，留给目录阶段
  assert.equal(classifyLink('../外面.md').kind, 'internal');
});

console.log('\n标题锚点');

test('中英文标题都能生成锚点', () => {
  assert.equal(headingSlug('部署 步骤'), '部署-步骤');
  assert.equal(headingSlug('Deploy Steps'), 'deploy-steps');
  assert.equal(headingSlug('Hello, World!'), 'hello-world');
});

console.log('\n笔记链接解析');

const notes = [
  { id: '项目A', title: '项目A' },
  { id: '欢迎使用 NoteX', title: '欢迎使用 NoteX' },
  { id: 'Deploy Guide', title: 'Deploy Guide' },
];

test('按 id 精确匹配', () => {
  assert.equal(resolveNoteLink('项目A', notes), '项目A');
});

test('自动去掉 .md 扩展名', () => {
  assert.equal(resolveNoteLink('项目A.md', notes), '项目A');
  assert.equal(resolveNoteLink('项目A.MD', notes), '项目A');
});

test('去掉 ./ 前缀', () => {
  assert.equal(resolveNoteLink('./项目A.md', notes), '项目A');
});

test('忽略大小写兜底', () => {
  assert.equal(resolveNoteLink('deploy guide', notes), 'Deploy Guide');
});

test('带空格的标题可解析', () => {
  assert.equal(resolveNoteLink('欢迎使用 NoteX', notes), '欢迎使用 NoteX');
});

test('找不到时返回 null，不乱跳', () => {
  assert.equal(resolveNoteLink('不存在的笔记', notes), null);
  assert.equal(resolveNoteLink('   ', notes), null);
});

console.log('\nwiki 链接展开');

test('[[名称]] 变成普通链接', () => {
  assert.equal(expandWikiLinks('见 [[项目A]] 一文'), '见 [项目A](%E9%A1%B9%E7%9B%AEA) 一文');
});

test('[[名称|显示文字]] 用后者作为链接文字', () => {
  const out = expandWikiLinks('[[项目A|那个项目]]');
  assert.ok(out.startsWith('[那个项目]('), out);
});

test('带小节的写法保留 #', () => {
  const out = expandWikiLinks('[[项目A#部署]]');
  assert.ok(out.includes('#'), out);
});

test('普通方括号不受影响', () => {
  assert.equal(expandWikiLinks('数组 a[0] 与 [文字](x.md)'), '数组 a[0] 与 [文字](x.md)');
});

test('跨行不误匹配', () => {
  assert.equal(expandWikiLinks('[[前半\n后半]]'), '[[前半\n后半]]');
});

console.log(`\n${process.exitCode ? '有失败' : `全部通过（${passed} 项）`}\n`);
