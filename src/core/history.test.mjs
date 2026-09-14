#!/usr/bin/env node
/** 撤销栈的会话合并。用法：pnpm test:history */
import assert from 'node:assert/strict';

const { History } = await import('./history.ts');

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

console.log('\n撤销栈');

test('结构操作一步一条，撤销回到之前，重做回到之后', () => {
  const h = new History();
  h.record('v0');
  h.record('v1');
  assert.equal(h.depth, 2);
  assert.equal(h.undo('v2'), 'v1');
  assert.equal(h.undo('v1'), 'v0');
  assert.equal(h.undo('v0'), null);
  assert.equal(h.redo('v0'), 'v1');
  assert.equal(h.redo('v1'), 'v2');
  assert.equal(h.redo('v2'), null);
});

test('同一个 cell 里连续敲字合并成一条，before 是会话开始前', () => {
  const h = new History();
  h.record('', 'cell-a'); // 敲了 a
  h.record('a', 'cell-a'); // 敲了 b
  h.record('ab', 'cell-a'); // 敲了 c
  assert.equal(h.depth, 1);
  assert.equal(h.undo('abc'), '');
});

test('切到别的 cell 或封口后另起一条', () => {
  const h = new History();
  h.record('', 'cell-a');
  h.record('a', 'cell-b');
  assert.equal(h.depth, 2);
  h.seal();
  h.record('ab', 'cell-b');
  assert.equal(h.depth, 3);
  assert.equal(h.undo('abc'), 'ab');
  assert.equal(h.undo('ab'), 'a');
});

test('结构操作插在中间会打断会话', () => {
  const h = new History();
  h.record('', 'cell-a');
  h.record('a'); // 删了个 cell
  h.record('a-', 'cell-a'); // 继续敲
  assert.equal(h.depth, 3);
});

test('新记录清空重做栈；撤销后的改动是新分支', () => {
  const h = new History();
  h.record('v0');
  h.undo('v1');
  assert.equal(h.canRedo, true);
  h.record('v0', 'x');
  assert.equal(h.canRedo, false);
});

test('前后一样的条目撤销时跳过，按键不会"失灵"', () => {
  const h = new History(100, (a, b) => a === b);
  h.record('v0', 'a'); // 敲了字
  h.seal();
  h.record('v1', 'a'); // 敲了又在编辑器里撤掉：会话净变化为零，现在仍是 v1
  assert.equal(h.undo('v1'), 'v0');
  assert.equal(h.redo('v0'), 'v1');
});

test('超过上限丢最旧的', () => {
  const h = new History(3);
  for (let i = 0; i < 5; i += 1) h.record(`v${i}`);
  assert.equal(h.depth, 3);
  assert.equal(h.undo('v5'), 'v4');
  assert.equal(h.undo('v4'), 'v3');
  assert.equal(h.undo('v3'), 'v2');
  assert.equal(h.undo('v2'), null);
});

console.log(`\n${process.exitCode ? '有失败' : `全部通过（${passed} 项）`}\n`);
