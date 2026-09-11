#!/usr/bin/env node
/** 内置运行时的隔离规则。用法：pnpm test:isolation */
import assert from 'node:assert/strict';

const { isManagedPath, isolatedEnv, isolatedArgs } = await import('./isolation.ts');

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

console.log('\n内置运行时判定');

test('只有 ~/.notex/runtimes 下的路径算内置', () => {
  const home = '/Users/me';
  assert.equal(isManagedPath('/Users/me/.notex/runtimes/python-sci/3.12/bin/python3', home), true);
  assert.equal(isManagedPath('/Users/me/.notex/runtimes-old/bin/python3', home), false);
  assert.equal(isManagedPath('/opt/homebrew/bin/python3', home), false);
  assert.equal(isManagedPath('/Users/me/.notex/runtimes/x', ''), false);
});

test('Windows 路径与反斜杠同样认得', () => {
  assert.equal(isManagedPath('C:\\Users\\me\\.notex\\runtimes\\node\\node.exe', 'C:\\Users\\me\\'), true);
});

console.log('\n隔离环境');

test('Python 清掉会改变解释器行为的变量，并给 matplotlib 一个可写缓存', () => {
  const env = isolatedEnv('python', '/Users/me');
  assert.equal(env.PYTHONPATH, null);
  assert.equal(env.CONDA_PREFIX, null);
  assert.equal(env.VIRTUAL_ENV, null);
  assert.equal(env.MPLCONFIGDIR, '/Users/me/.notex/cache/matplotlib');
  assert.deepEqual(isolatedArgs('python'), ['-I']);
});

test('Java 清掉能注入参数的变量', () => {
  const env = isolatedEnv('java', '/Users/me');
  assert.equal(env.JAVA_TOOL_OPTIONS, null);
  assert.equal(env._JAVA_OPTIONS, null);
  assert.equal(env.CLASSPATH, null);
  assert.deepEqual(isolatedArgs('java'), []);
});

test('Node 清掉 NODE_OPTIONS 与 NODE_PATH', () => {
  const env = isolatedEnv('js', '/Users/me');
  assert.equal(env.NODE_OPTIONS, null);
  assert.equal(env.NODE_PATH, null);
});

test('不碰 PATH、HOME 这些通用变量', () => {
  for (const lang of ['python', 'java', 'js']) {
    const env = isolatedEnv(lang, '/Users/me');
    assert.ok(!('PATH' in env));
    assert.ok(!('HOME' in env));
  }
});

console.log(`\n${process.exitCode ? '有失败' : `全部通过（${passed} 项）`}\n`);
