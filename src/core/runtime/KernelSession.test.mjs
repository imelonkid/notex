#!/usr/bin/env node
/** KernelSession 的中断升级逻辑。用法：pnpm test:session */
import assert from 'node:assert/strict';

const { KernelSession } = await import('./KernelSession.ts');
const { decodeLine } = await import('./protocol.ts');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log('  ✓ ' + name);
    passed += 1;
  } catch (e) {
    console.log('  ✗ ' + name);
    console.log('      ' + String(e.message ?? e).split('\n').slice(0, 4).join('\n      '));
    process.exitCode = 1;
  }
}

/** 假连接：记下发出的请求，由测试决定何时回 done */
function fakeConnection() {
  const sent = [];
  let onMessage = () => {};
  let signals = 0;
  const conn = {
    async send(text) {
      sent.push(decodeLine(text.trimEnd()) ?? JSON.parse(text.slice(1)));
    },
    onMessage(cb) {
      onMessage = cb;
      return () => {};
    },
    onRawOutput() {
      return () => {};
    },
    onExit() {
      return () => {};
    },
    async interrupt() {
      signals += 1;
    },
    async dispose() {},
  };
  return {
    conn,
    sent,
    get signals() {
      return signals;
    },
    finish(id, status = 'ok') {
      onMessage({ id, type: 'done', status });
    },
    lastRequest(op) {
      return [...sent].reverse().find((r) => r.op === op);
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

console.log('\n中断升级');

await test('没有正在执行的请求时，中断什么都不发', async () => {
  const f = fakeConnection();
  const s = new KernelSession(f.conn, 'java-local', '17', 'protocol');
  await s.interrupt();
  assert.equal(f.sent.length, 0);
  assert.equal(f.signals, 0);
});

await test('协议中断指向正在执行的那条，而不是补全请求', async () => {
  const f = fakeConnection();
  const s = new KernelSession(f.conn, 'java-local', '17', 'protocol');
  void s.complete('foo.', 4, 5000);
  const run = s.execute('while (true) {}', {});
  await s.interrupt();
  const req = f.lastRequest('interrupt');
  const exec = f.lastRequest('execute');
  assert.ok(req, '应发出协议中断');
  assert.equal(req.target, exec.id);
  f.finish(exec.id, 'aborted');
  assert.equal(await run, 'aborted');
});

await test('执行在一秒内收敛就不升级到信号，即使还有补全挂着', async () => {
  const f = fakeConnection();
  const s = new KernelSession(f.conn, 'java-local', '17', 'protocol');
  void s.complete('foo.', 4, 5000);
  const run = s.execute('while (true) {}', {});
  await s.interrupt();
  f.finish(f.lastRequest('execute').id, 'aborted');
  await run;
  await sleep(1100);
  assert.equal(f.signals, 0, '补全还挂着不该成为发信号的理由');
});

await test('执行一秒后仍未收敛才升级到信号', async () => {
  const f = fakeConnection();
  const s = new KernelSession(f.conn, 'java-local', '17', 'protocol');
  const run = s.execute('while (true) {}', {});
  await s.interrupt();
  await sleep(1100);
  assert.equal(f.signals, 1);
  f.finish(f.lastRequest('execute').id, 'aborted');
  await run;
});

await test('信号型内核直接发信号', async () => {
  const f = fakeConnection();
  const s = new KernelSession(f.conn, 'python-local', '3.12', 'signal');
  void s.execute('while True: pass', {});
  await s.interrupt();
  assert.equal(f.signals, 1);
  assert.equal(f.lastRequest('interrupt'), undefined);
});

console.log(`\n${process.exitCode ? '有失败' : `全部通过（${passed} 项）`}\n`);
