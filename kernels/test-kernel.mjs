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
    hello: 'System.out.println("你好, xnotebook");\nint a = 6 * 7;\na',
    stateA: 'var nums = new java.util.ArrayList<Integer>();\nfor (int i = 1; i <= 5; i++) nums.add(i * i);',
    stateB: 'nums.stream().mapToInt(Integer::intValue).sum()',
    boom: 'int z = 1 / 0;',
    compileErr: 'int broken = "not a number";',
    completeSetup: 'import java.util.*;\nvar words = List.of("a", "b");',
    completeCode: 'words.st',
    spin: 'long n = 0; while (true) { n++; }',
    interrupt: 'protocol',
  },
  python: {
    hello: 'print("你好, xnotebook")\n6 * 7',
    stateA: 'nums = [i * i for i in range(1, 6)]',
    stateB: 'sum(nums)',
    boom: '1 / 0',
    compileErr: 'def broken(:',
    completeSetup: 'import os',
    completeCode: 'os.pa',
    spin: 'n = 0\nwhile True:\n    n += 1',
    interrupt: 'signal',
  },
  js: {
    hello: 'console.log("你好, xnotebook");\n6 * 7',
    stateA: 'globalThis.nums = [1,2,3,4,5].map(i => i * i);',
    stateB: 'nums.reduce((a, b) => a + b, 0)',
    boom: 'null.x',
    compileErr: 'function broken( {',
    completeSetup: 'const greeting = "hi";',
    completeCode: 'JSON.pa',
    spin: 'let n = 0; for (;;) { n++; }',
    interrupt: 'signal',
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

  console.log('\n8. 错误后内核仍然可用');
  await request('execute', { code: t.boom }).catch(() => []);
  msgs = await request('execute', { code: t.stateB });
  check('报错后仍能执行', msgs.some((m) => m.type === 'result' && m.data['text/plain'].includes('55')));

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
