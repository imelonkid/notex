#!/usr/bin/env node
/** 富文本粘贴转 Markdown。用法：pnpm test:paste */
import assert from 'node:assert/strict';

const { htmlToMarkdown, findImageRefs, replaceImageSrc, sourceUrlOf } = await import('./paste.ts');
const { assetNameForUrl, assetNameForBlob, shortHash, extOfMime } = await import('./assets.ts');

let passed = 0;
function test(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
    passed += 1;
  } catch (e) {
    console.log('  ✗ ' + name);
    console.log('      ' + String(e.message ?? e).split('\n').slice(0, 6).join('\n      '));
    process.exitCode = 1;
  }
}

console.log('\nHTML → Markdown');

test('网页片段：段落、加粗、图片、代码块都保住', () => {
  const html = `<!--StartFragment--><p>将两个升序链表合并为一个新的 <strong>升序</strong> 链表并返回。</p>
<p><strong>示例 1：</strong></p>
<img alt="" src="/images/lc/uploads/2020/10/03/merge_ex1.jpg" style="width: 662px; height: 302px;" />
<pre><code>输入：l1 = [1,2,4], l2 = [1,3,4]
输出：[1,1,2,3,4,4]
</code></pre><!--EndFragment-->`;
  const md = htmlToMarkdown(html, 'https://labuladong.online/zh/algo/x/');
  assert.ok(md.includes('**升序**'));
  assert.ok(md.includes('**示例 1：**'));
  assert.ok(md.includes('![](https://labuladong.online/images/lc/uploads/2020/10/03/merge_ex1.jpg)'), md);
  assert.ok(md.includes('```\n输入：l1 = [1,2,4], l2 = [1,3,4]\n输出：[1,1,2,3,4,4]\n```'), md);
});

test('代码块语言从 class 里拿', () => {
  const md = htmlToMarkdown('<pre><code class="language-java">int a = 1;</code></pre>');
  assert.equal(md, '```java\nint a = 1;\n```');
});

test('标题、列表、链接、表格', () => {
  const md = htmlToMarkdown(
    '<h2>思路</h2><ul><li>第一</li><li>第二</li></ul><p><a href="/zh/algo/">原文</a></p><table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>',
    'https://example.com/post/',
  );
  assert.ok(md.startsWith('## 思路'));
  assert.ok(md.includes('- 第一\n- 第二'));
  assert.ok(md.includes('[原文](https://example.com/zh/algo/)'));
  assert.ok(md.includes('| a | b |'));
});

test('脚本、样式、按钮之类的噪音不进正文', () => {
  const md = htmlToMarkdown('<p>正文</p><script>alert(1)</script><style>p{}</style><button>复制</button>');
  assert.equal(md, '正文');
});

test('多余的空行压掉', () => {
  const md = htmlToMarkdown('<div><div><p>一</p></div></div><div><br></div><div><p>二</p></div>');
  assert.ok(!/\n{3,}/.test(md));
});

console.log('\n图片引用');

test('只挑远程与 data: 图片，去重', () => {
  const md = '![a](https://x/a.png) ![b](.assets/b.png) ![c](data:image/png;base64,AAAA) ![a2](https://x/a.png)';
  assert.deepEqual(
    findImageRefs(md).map((r) => r.src),
    ['https://x/a.png', 'data:image/png;base64,AAAA'],
  );
});

test('替换地址时所有出现处一起换，带标题的也认', () => {
  const md = '![a](https://x/a.png) 文 ![a](https://x/a.png "t")';
  assert.equal(replaceImageSrc(md, 'https://x/a.png', '.assets/1-a.png'), '![a](.assets/1-a.png) 文 ![a](.assets/1-a.png "t")');
});

test('加粗紧贴标点与文字时补空格，否则按 CommonMark 不算加粗', () => {
  const md = htmlToMarkdown('<p><strong>输入：</strong>l1 = [1,2,4]<br><strong>输出：</strong>[1,1,2,3,4,4]</p>');
  assert.ok(md.includes('**输入：** l1 = '), md);
  // 后面跟的是标点（转义的 [）时本来就合法，不多加空格
  assert.ok(md.includes('**输出：**\\['), md);
});

test('Windows 剪贴板的 CF_HTML 头不进正文', () => {
  const md = htmlToMarkdown('Version:0.9\nStartHTML:0000000105\nSourceURL:https://a.b/c\n<html><body><!--StartFragment--><p>正文</p><!--EndFragment--></body></html>');
  assert.equal(md, '正文');
});

test('来源地址从 SourceURL 里读', () => {
  assert.equal(sourceUrlOf('Version:0.9\nSourceURL:https://a.b/c\n<html>'), 'https://a.b/c');
  assert.equal(sourceUrlOf('<html>'), undefined);
});

console.log('\n附件命名');

test('远程图片：哈希前缀 + 原名，没扩展名用兜底', () => {
  const name = assetNameForUrl('https://labuladong.online/images/lc/uploads/2020/10/03/merge_ex1.jpg?x=1');
  assert.match(name, /^[0-9a-f]{8}-merge_ex1\.jpg$/);
  assert.match(assetNameForUrl('https://x/y/图 片!', 'webp'), /^[0-9a-f]{8}-图-片\.webp$/);
  assert.notEqual(assetNameForUrl('https://x/a.png'), assetNameForUrl('https://y/a.png'));
});

test('剪贴板图片：按类型取扩展名', () => {
  assert.match(assetNameForBlob('image/png', 'seed'), /^[0-9a-f]{8}-pasted\.png$/);
  assert.match(assetNameForBlob('image/jpeg', 'seed', 'IMG_0001.JPG'), /^[0-9a-f]{8}-IMG_0001\.jpg$/);
  assert.equal(extOfMime('image/svg+xml'), 'svg');
  assert.equal(shortHash('a').length, 8);
});

console.log(`\n${process.exitCode ? '有失败' : `全部通过（${passed} 项）`}\n`);
