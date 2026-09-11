#!/usr/bin/env node
/** 运行时清单的解析与选择。用法：pnpm test:catalog */
import assert from 'node:assert/strict';

const { parseCatalog, pickBuild, runtimesFor, installSegments, needsStrip, formatSize, KERNEL_PROTOCOL } =
  await import('./catalog.ts');

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

const sha = 'a'.repeat(64);
const good = {
  version: 1,
  runtimes: [
    {
      id: 'python-sci',
      lang: 'python',
      label: 'Python 科学计算版',
      version: '3.12.4-1',
      protocol: 1,
      entry: 'bin/python3',
      packages: ['numpy', 'pandas'],
      builds: [
        { platform: 'darwin', arch: 'arm64', size: 100, sha256: sha, urls: ['https://a/x.tgz', 'https://b/x.tgz'] },
        { platform: 'darwin', arch: 'x64', size: 100, sha256: sha, urls: ['https://a/y.tgz'] },
      ],
    },
  ],
};

console.log('\n清单解析');

test('合法清单原样读出', () => {
  const { catalog, warnings } = parseCatalog(good);
  assert.equal(warnings.length, 0);
  assert.equal(catalog.runtimes.length, 1);
  assert.equal(catalog.runtimes[0].builds.length, 2);
  assert.deepEqual(catalog.runtimes[0].builds[0].urls, ['https://a/x.tgz', 'https://b/x.tgz']);
});

test('id、version、entry 要拼进磁盘路径，格式不对整条丢掉并说明', () => {
  const bad = {
    runtimes: [
      { ...good.runtimes[0], id: '../evil' },
      { ...good.runtimes[0], id: 'ok-id', version: 'v1/../x' },
      { ...good.runtimes[0], id: 'ok-entry', entry: '../../bin/sh' },
      { ...good.runtimes[0], id: 'ok-lang', lang: 'ruby' },
    ],
  };
  const { catalog, warnings } = parseCatalog(bad);
  assert.equal(catalog.runtimes.length, 0);
  assert.equal(warnings.length, 4);
});

test('sha256 不合法或没有 https 地址的构建被丢掉，全丢就整条丢', () => {
  const { catalog, warnings } = parseCatalog({
    runtimes: [
      {
        ...good.runtimes[0],
        builds: [
          { platform: 'darwin', arch: 'arm64', size: 1, sha256: 'xyz', urls: ['https://a'] },
          { platform: 'darwin', arch: 'x64', size: 1, sha256: sha, urls: ['ftp://a'] },
        ],
      },
    ],
  });
  assert.equal(catalog.runtimes.length, 0);
  assert.ok(warnings.some((w) => w.includes('sha256')));
  assert.ok(warnings.some((w) => w.includes('下载地址')));
});

test('不是对象的输入不会抛', () => {
  assert.equal(parseCatalog(null).catalog.runtimes.length, 0);
  assert.equal(parseCatalog('x').catalog.runtimes.length, 0);
});

console.log('\n选择');

test('按平台和架构挑构建', () => {
  const r = parseCatalog(good).catalog.runtimes[0];
  assert.equal(pickBuild(r, 'darwin', 'arm64').urls[0], 'https://a/x.tgz');
  assert.equal(pickBuild(r, 'linux', 'x64'), null);
});

test('协议太新的运行时不列出', () => {
  const { catalog } = parseCatalog({
    runtimes: [good.runtimes[0], { ...good.runtimes[0], id: 'python-next', protocol: KERNEL_PROTOCOL + 1 }],
  });
  const list = runtimesFor(catalog, 'python', 'darwin', 'arm64');
  assert.deepEqual(
    list.map((r) => r.id),
    ['python-sci'],
  );
  assert.equal(runtimesFor(catalog, 'java', 'darwin', 'arm64').length, 0);
});

test('安装目录与解压剥层判断', () => {
  assert.deepEqual(installSegments({ id: 'python-sci', version: '3.12.4-1' }), ['.notex', 'runtimes', 'python-sci', '3.12.4-1']);
  assert.equal(needsStrip('bin/python3'), false);
  assert.equal(needsStrip('./bin/'), false);
  assert.equal(needsStrip('python-sci-3.12/bin/python3'), true);
  assert.equal(needsStrip('README'), false);
});

test('体积写法', () => {
  assert.equal(formatSize(126_000_000), '120 MB');
  assert.equal(formatSize(2_048), '2 KB');
});

console.log(`\n${process.exitCode ? '有失败' : `全部通过（${passed} 项）`}\n`);
