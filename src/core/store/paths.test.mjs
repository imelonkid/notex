#!/usr/bin/env node
/** 笔记库路径与排序测试。用法：pnpm test:paths */
import assert from 'node:assert/strict';

const {
  safeSegments,
  isSafeId,
  dirOf,
  baseOf,
  joinId,
  depthOf,
  compareNames,
  shouldSkipDir,
  MAX_DIR_DEPTH,
} = await import('./paths.ts');
const { slugify } = await import('./VaultStore.ts');

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

console.log('\n路径越界防护');

for (const bad of [
  '../外面',
  '工作/../../外面',
  '../../.ssh/id_rsa',
  '..',
  '工作/..',
]) {
  test(`拒绝 ${bad}`, () => {
    assert.equal(safeSegments(bad), null, `${bad} 应被拒绝`);
    assert.equal(isSafeId(bad), false);
  });
}

test('拒绝空与纯分隔符', () => {
  assert.equal(safeSegments(''), null);
  assert.equal(safeSegments('   '), null);
  assert.equal(safeSegments('///'), null);
});

test('拒绝含控制字符或非法字符的段', () => {
  assert.equal(safeSegments('工作/a:b'), null);
  assert.equal(safeSegments('工作/a*b'), null);
  assert.equal(safeSegments('工作/a?b'), null);
});

test('拒绝以点或空格结尾的段（Windows 会静默截断）', () => {
  assert.equal(safeSegments('工作/笔记.'), null);
  assert.equal(safeSegments('工作/笔记 '), null);
});

test('绝对路径被规约成相对，不会逃逸', () => {
  assert.deepEqual(safeSegments('/etc/passwd'), ['etc', 'passwd']);
});

console.log('\n合法路径');

test('单层与多层都接受', () => {
  assert.deepEqual(safeSegments('周报'), ['周报']);
  assert.deepEqual(safeSegments('工作/项目A/周报'), ['工作', '项目A', '周报']);
});

test('反斜杠统一成正斜杠', () => {
  assert.deepEqual(safeSegments('工作\\周报'), ['工作', '周报']);
});

test('忽略多余的分隔符与单点', () => {
  assert.deepEqual(safeSegments('工作//./周报'), ['工作', '周报']);
});

console.log('\n路径拆分');

test('dirOf 与 baseOf', () => {
  assert.equal(dirOf('工作/项目A/周报'), '工作/项目A');
  assert.equal(baseOf('工作/项目A/周报'), '周报');
  assert.equal(dirOf('周报'), '');
  assert.equal(baseOf('周报'), '周报');
});

test('joinId 处理根目录', () => {
  assert.equal(joinId('', '周报'), '周报');
  assert.equal(joinId('工作', '周报'), '工作/周报');
});

test('depthOf', () => {
  assert.equal(depthOf(''), 0);
  assert.equal(depthOf('工作'), 1);
  assert.equal(depthOf('工作/项目A'), 2);
});

console.log('\n排序：按名字而不是时间');

test('数字按数值排，不按字典序', () => {
  const names = ['笔记 10', '笔记 2', '笔记 1'];
  names.sort(compareNames);
  assert.deepEqual(names, ['笔记 1', '笔记 2', '笔记 10']);
});

test('中英文混排稳定', () => {
  const names = ['zebra', '苹果', 'Apple', '香蕉'];
  const once = [...names].sort(compareNames);
  const twice = [...once].sort(compareNames);
  assert.deepEqual(once, twice, '重复排序结果应一致');
});

test('大小写不影响相对顺序', () => {
  const names = ['beta', 'Alpha'];
  names.sort(compareNames);
  assert.deepEqual(names, ['Alpha', 'beta']);
});

console.log('\n层级上限');

test('上限是三级', () => {
  assert.equal(MAX_DIR_DEPTH, 3);
});

test('三级以内的深度判断正确', () => {
  assert.ok(depthOf('a/b/c') <= MAX_DIR_DEPTH);
  assert.ok(depthOf('a/b/c/d') > MAX_DIR_DEPTH);
});

console.log('\n忽略目录');

test('点开头与常见构建目录被跳过', () => {
  for (const d of ['.git', '.obsidian', 'node_modules', 'target', '__pycache__']) {
    assert.equal(shouldSkipDir(d), true, `${d} 应被跳过`);
  }
});

test('普通目录不跳过', () => {
  for (const d of ['工作', 'Java', 'my-notes']) {
    assert.equal(shouldSkipDir(d), false, `${d} 不该被跳过`);
  }
});

console.log('\n文件名清洗');

test('分隔符与非法字符换成下划线', () => {
  assert.equal(slugify('工作/周报'), '工作_周报');
  assert.equal(slugify('a:b*c?d'), 'a_b_c_d');
});

test('去掉结尾的点和空格', () => {
  assert.equal(slugify('笔记.'), '笔记');
  assert.equal(slugify('笔记   '), '笔记');
});

test('空标题有兜底', () => {
  assert.equal(slugify('   '), '未命名笔记');
  assert.equal(slugify('///'), '___');
});

console.log(`\n${process.exitCode ? '有失败' : `全部通过（${passed} 项）`}\n`);
