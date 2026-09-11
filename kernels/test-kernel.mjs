#!/usr/bin/env node
/**
 * 内核冒烟测试：用协议驱动任一内核，检查执行、状态保持、错误、补全。
 * 用法：node test-kernel.mjs java|python|js
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RS = '\x1e';
const HERE = path.dirname(fileURLToPath(import.meta.url));

const LAUNCH = {
  java: ['java', [path.join(HERE, 'java', 'JavaKernel.java')]],
  python: ['python3', [path.join(HERE, 'python', 'kernel.py')]],
  js: ['node', [path.join(HERE, 'node', 'kernel.mjs')]],
};

const lang = process.argv[2] || 'java';
const [cmd, args] = LAUNCH[lang] || LAUNCH.java;

const proc = spawn(cmd, args, { cwd: HERE, stdio: ['pipe', 'pipe', 'pipe'] });
proc.stdout.setEncoding('utf8');
proc.stderr.setEncoding('utf8');

const waiters = new Map(); // id -> {resolve, messages}
let boot = null;
const bootReady = new Promise((r) => (boot = r));

let buf = '';
proc.stdout.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl);
    buf = buf.slice(nl + 1);
    if (!line) continue;
    if (!line.startsWith(RS)) {
      console.log('  [裸 stdout]', JSON.stringify(line));
      continue;
    }
    let msg;
    try {
      msg = JSON.parse(line.slice(1));
    } catch {
      console.log('  [坏消息]', line);
      continue;
    }
    if (msg.type === 'ready') {
      boot(msg);
      continue;
    }
    const w = waiters.get(msg.id);
    if (!w) continue;
    w.messages.push(msg);
    if (msg.type === 'done') {
      waiters.delete(msg.id);
      w.resolve(w.messages);
    }
  }
});
proc.stderr.on('data', (d) => process.stderr.write('  [内核 stderr] ' + d));
proc.on('exit', (code) => {
  if (code !== 0 && code !== null) console.error('内核退出，code =', code);
});

let n = 0;
function request(op, extra) {
  const id = 'r' + ++n;
  const payload = { id, op, ...extra };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${op} 超时: ${id}`)), 45000);
    waiters.set(id, {
      messages: [],
      resolve: (m) => {
        clearTimeout(timer);
        resolve(m);
      },
    });
    proc.stdin.write(RS + JSON.stringify(payload) + '\n');
  });
}

const summarize = (msgs) => {
  const out = [];
  for (const m of msgs) {
    if (m.type === 'stream') out.push(`${m.name}: ${JSON.stringify(m.text)}`);
    else if (m.type === 'result') out.push(`result: ${m.data['text/plain']}`);
    else if (m.type === 'error') out.push(`error: ${m.ename}: ${m.evalue}`);
    else if (m.type === 'completions') out.push(`completions(${m.anchor}): ${m.items.slice(0, 8).map((i) => i.label).join(', ')}`);
    else if (m.type === 'done') out.push(`done: ${m.status}${m.durationMs != null ? ` (${m.durationMs}ms)` : ''}`);
  }
  return out;
};

let failures = 0;
function check(name, ok, detail) {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log('     ', detail);
  }
}

const CASES = {
  java: {
    hello: 'System.out.println("你好, NoteX");\nint a = 6 * 7;\na',
    stateA: 'var nums = new java.util.ArrayList<Integer>();\nfor (int i = 1; i <= 5; i++) nums.add(i * i);',
    stateB: 'nums.stream().mapToInt(Integer::intValue).sum()',
    boom: 'int z = 1 / 0;',
    compileErr: 'int broken = "not a number";',
    completeSetup: 'import java.util.*;\nvar words = List.of("a", "b");',
    completeCode: 'words.st',
    spin: 'long n = 0; while (true) { n++; }',
    interrupt: 'protocol',
    killRemote: 'System.exit(0)',
    hugeValue: 'java.util.stream.IntStream.range(0, 200000).boxed().toList()',
  },
  python: {
    hello: 'print("你好, NoteX")\n6 * 7',
    stateA: 'nums = [i * i for i in range(1, 6)]',
    stateB: 'sum(nums)',
    boom: '1 / 0',
    compileErr: 'def broken(:',
    completeSetup: 'import os',
    completeCode: 'os.pa',
    spin: 'n = 0\nwhile True:\n    n += 1',
    interrupt: 'signal',
    hugeValue: 'list(range(200000))',
    idleSigint: true,
  },
  js: {
    hello: 'console.log("你好, NoteX");\n6 * 7',
    stateA: 'globalThis.nums = [1,2,3,4,5].map(i => i * i);',
    stateB: 'nums.reduce((a, b) => a + b, 0)',
    boom: 'null.x',
    compileErr: 'function broken( {',
    completeSetup: 'const greeting = "hi";',
    completeCode: 'JSON.pa',
    spin: 'let n = 0; for (;;) { n++; }',
    interrupt: 'signal',
    hugeValue: '"x".repeat(200000)',
    declareFn: 'function greet(name) { return "hi " + name; }',
    useFn: 'greet("NoteX")',
    declareClass: 'class Counter { constructor() { this.n = 3; } }',
    useClass: 'new Counter().n',
    pendingPromise: 'new Promise(() => {})',
    topLevelAwait: 'await Promise.resolve(41 + 1)',
  },
};

const t = CASES[lang];

async function main() {
  const t0 = Date.now();
  const ready = await Promise.race([
    bootReady,
    new Promise((_, rj) => setTimeout(() => rj(new Error('内核启动超时')), 45000)),
  ]);
  console.log(`\n内核就绪：${ready.lang} ${ready.version}  (冷启动 ${Date.now() - t0}ms)\n`);

  console.log('1. 执行与输出');
  let msgs = await request('execute', { code: t.hello });
  summarize(msgs).forEach((l) => console.log('   ', l));
  check('stdout 被捕获', msgs.some((m) => m.type === 'stream' && m.text.includes('你好')));
  check('返回值是 42', msgs.some((m) => m.type === 'result' && m.data['text/plain'].includes('42')));
  check('状态 ok', msgs.at(-1)?.status === 'ok');

  console.log('\n2. 跨 cell 状态保持');
  await request('execute', { code: t.stateA });
  msgs = await request('execute', { code: t.stateB });
  summarize(msgs).forEach((l) => console.log('   ', l));
  check('第二个 cell 看得到第一个的变量 (=55)', msgs.some((m) => m.type === 'result' && m.data['text/plain'].includes('55')));

  console.log('\n3. 运行时异常');
  msgs = await request('execute', { code: t.boom });
  summarize(msgs).forEach((l) => console.log('   ', l));
  check('报告 error', msgs.some((m) => m.type === 'error'));
  check('done 状态为 error', msgs.at(-1)?.status === 'error');

  console.log('\n4. 语法/编译错误');
  msgs = await request('execute', { code: t.compileErr });
  summarize(msgs).forEach((l) => console.log('   ', l));
  check('报告 error 而非崩溃', msgs.some((m) => m.type === 'error'));

  console.log('\n5. 补全');
  if (t.completeSetup) await request('execute', { code: t.completeSetup });
  msgs = await request('complete', { code: t.completeCode, cursor: t.completeCode.length });
  summarize(msgs).forEach((l) => console.log('   ', l));
  const comp = msgs.find((m) => m.type === 'completions');
  check('返回补全候选', !!comp && comp.items.length > 0);

  if (lang === 'js') {
    console.log('\n5b. let/const 跨 cell 保持');
    msgs = await request('execute', { code: 'greeting.toUpperCase()' });
    summarize(msgs).forEach((l) => console.log('   ', l));
    check('const 声明跨 cell 可见', msgs.some((m) => m.type === 'result' && m.data['text/plain'].includes('HI')));
  }

  console.log('\n6. 中断长时间运行的 cell');
  {
    const id = 'spin1';
    const spinMsgs = [];
    const spinDone = new Promise((resolve) => {
      waiters.set(id, { messages: spinMsgs, resolve });
    });
    proc.stdin.write(RS + JSON.stringify({ id, op: 'execute', code: t.spin }) + '\n');
    await new Promise((r) => setTimeout(r, 1200));

    const t0 = Date.now();
    if (t.interrupt === 'protocol') {
      proc.stdin.write(RS + JSON.stringify({ id: 'int1', op: 'interrupt', target: id }) + '\n');
    } else {
      proc.kill('SIGINT');
    }

    const finished = await Promise.race([
      spinDone.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 8000)),
    ]);
    waiters.delete(id);
    summarize(spinMsgs).forEach((l) => console.log('   ', l));
    check('死循环被中断', finished, '8 秒内没有收到 done，内核可能已卡死');
    if (finished) console.log(`      中断耗时 ${Date.now() - t0}ms`);
  }

  console.log('\n7. 中断后内核仍然可用');
  msgs = await request('execute', { code: t.stateB });
  check('仍能执行并保有状态', msgs.some((m) => m.type === 'result' && m.data['text/plain'].includes('55')));

  if (t.interrupt === 'protocol') {
    // 协议中断不收敛时宿主会升级发 SIGINT。内核必须把它当成"中断当前 cell"，
    // 而不是 JVM 默认的退出——否则一次中断就把所有变量清空了
    console.log('\n7b. SIGINT 升级只中断 cell，不杀内核');
    const id = 'spin2';
    const spinMsgs = [];
    const spinDone = new Promise((resolve) => {
      waiters.set(id, { messages: spinMsgs, resolve });
    });
    proc.stdin.write(RS + JSON.stringify({ id, op: 'execute', code: t.spin }) + '\n');
    await new Promise((r) => setTimeout(r, 1200));
    proc.kill('SIGINT');
    const finished = await Promise.race([
      spinDone.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 8000)),
    ]);
    waiters.delete(id);
    check('SIGINT 后收到 done', finished, '8 秒内没有收到 done');
    check('内核进程仍然存活', proc.exitCode === null, `内核已退出，code = ${proc.exitCode}`);
    msgs = await request('execute', { code: t.stateB });
    check('变量仍然保留', msgs.some((m) => m.type === 'result' && m.data['text/plain'].includes('55')));
  }

  console.log('\n8. 错误后内核仍然可用');
  await request('execute', { code: t.boom }).catch(() => []);
  msgs = await request('execute', { code: t.stateB });
  check('报错后仍能执行', msgs.some((m) => m.type === 'result' && m.data['text/plain'].includes('55')));

  if (t.hugeValue) {
    console.log('\n9. 超大结果被截断');
    msgs = await request('execute', { code: t.hugeValue });
    const text = msgs.find((m) => m.type === 'result')?.data['text/plain'] ?? '';
    check('text/plain 有上限', text.length > 0 && text.length < 30000, `长度 ${text.length}`);
    check('截断处有说明', text.includes('已截断'));
  }

  if (t.idleSigint) {
    // 宿主升级发信号的时机由它自己定，可能落在 cell 已经结束、补全正在跑的时候。
    // 空闲期和补全期连发几次 SIGINT，内核都不能退出
    console.log('\n9b. 执行区间之外的 SIGINT 不杀内核');
    proc.kill('SIGINT');
    proc.kill('SIGINT');
    const pending = request('complete', { code: t.completeCode, cursor: t.completeCode.length });
    proc.kill('SIGINT');
    await pending;
    await new Promise((r) => setTimeout(r, 300));
    check('内核进程仍然存活', proc.exitCode === null, `内核已退出，code = ${proc.exitCode}`);
    msgs = await request('execute', { code: t.stateB });
    check('变量仍然保留', msgs.some((m) => m.type === 'result' && m.data['text/plain'].includes('55')));
  }

  if (t.killRemote) {
    console.log('\n10. 远端 JVM 退出后内核自愈');
    msgs = await request('execute', { code: t.killRemote });
    await request('execute', { code: t.stateA });
    msgs = await request('execute', { code: t.stateB });
    check('重建后仍能执行', msgs.some((m) => m.type === 'result' && m.data['text/plain'].includes('55')));
  }

  if (t.declareFn) {
    console.log('\n11. 声明与异步');
    await request('execute', { code: t.declareFn });
    msgs = await request('execute', { code: t.useFn });
    check('function 声明跨 cell 可见', msgs.some((m) => m.type === 'result' && m.data['text/plain'].includes('hi NoteX')));
    await request('execute', { code: t.declareClass });
    msgs = await request('execute', { code: t.useClass });
    check('class 声明跨 cell 可见', msgs.some((m) => m.type === 'result' && m.data['text/plain'].includes('3')));
    msgs = await request('execute', { code: t.topLevelAwait });
    check('顶层 await 可用', msgs.some((m) => m.type === 'result' && m.data['text/plain'].includes('42')));

    const id = 'pend1';
    const pendMsgs = [];
    const pendDone = new Promise((resolve) => waiters.set(id, { messages: pendMsgs, resolve }));
    proc.stdin.write(RS + JSON.stringify({ id, op: 'execute', code: t.pendingPromise }) + '\n');
    await new Promise((r) => setTimeout(r, 500));
    proc.kill('SIGINT');
    const finished = await Promise.race([pendDone.then(() => true), new Promise((r) => setTimeout(() => r(false), 5000))]);
    waiters.delete(id);
    check('挂起的 Promise 能被中断', finished && pendMsgs.some((m) => m.type === 'done' && m.status === 'aborted'));
    msgs = await request('execute', { code: t.stateB });
    check('中断后仍能执行', msgs.some((m) => m.type === 'result' && m.data['text/plain'].includes('55')));
  }

  console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}\n`);
  proc.stdin.write(RS + JSON.stringify({ id: 'bye', op: 'shutdown' }) + '\n');
  setTimeout(() => {
    proc.kill('SIGKILL');
    process.exit(failures === 0 ? 0 : 1);
  }, 800);
}

main().catch((e) => {
  console.error('\n测试失败：', e.message);
  proc.kill('SIGKILL');
  process.exit(1);
});
