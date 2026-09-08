#!/usr/bin/env node
/**
 * 富输出测试：检查集合、映射、图像是否被渲染成 HTML 表格或 PNG。
 * 用法：node test-rich.mjs [java|python|js|all]
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

const CASES = {
  java: [
    {
      name: '集合渲染成表格',
      code: 'java.util.List.of("ada", "bob", "cy")',
      expectMime: 'text/html',
      expectIn: ['<table>', 'ada', 'bob'],
    },
    {
      name: '映射渲染成两列表格',
      code: 'java.util.Map.of("x", 1)',
      expectMime: 'text/html',
      expectIn: ['<table>', 'x'],
    },
    {
      name: '记录列表渲染成多列表格',
      code:
        'java.util.List.of(java.util.Map.of("名字", "ada", "年龄", 36), ' +
        'java.util.Map.of("名字", "bob", "年龄", 41))',
      expectMime: 'text/html',
      expectIn: ['名字', '年龄', 'ada'],
    },
    {
      name: '图像渲染成 PNG',
      code:
        'var im = new java.awt.image.BufferedImage(8, 8, java.awt.image.BufferedImage.TYPE_INT_RGB);\n' +
        'im.setRGB(0, 0, 0xff0000);\nim',
      expectMime: 'image/png',
      expectIn: [],
    },
    {
      name: '标量不产生富输出',
      code: '1 + 1',
      expectMime: null,
      expectIn: [],
    },
  ],
  python: [
    {
      name: '_repr_html_ 被采用',
      code:
        'class T:\n'
        + '    def _repr_html_(self):\n'
        + '        return "<table><tr><td>from python</td></tr></table>"\n'
        + 'T()',
      expectMime: 'text/html',
      expectIn: ['<table>', 'from python'],
    },
    {
      name: '标量不产生富输出',
      code: '2 + 2',
      expectMime: null,
      expectIn: [],
    },
  ],
  js: [
    {
      name: 'toHTML() 被采用',
      code: '({ toHTML: () => "<table><tr><td>from js</td></tr></table>" })',
      expectMime: 'text/html',
      expectIn: ['<table>', 'from js'],
    },
    {
      name: '标量不产生富输出',
      code: '3 + 3',
      expectMime: null,
      expectIn: [],
    },
  ],
};

function startKernel(lang) {
  const [cmd, args] = LAUNCH[lang];
  const proc = spawn(cmd, args, { cwd: HERE, stdio: ['pipe', 'pipe', 'pipe'] });
  proc.stdout.setEncoding('utf8');
  const waiters = new Map();
  let onReady;
  const ready = new Promise((r) => (onReady = r));
  let buf = '';

  proc.stdout.on('data', (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (!line.startsWith(RS)) continue;
      let msg;
      try {
        msg = JSON.parse(line.slice(1));
      } catch {
        continue;
      }
      if (msg.type === 'ready') {
        onReady(msg);
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

  let n = 0;
  const execute = (code) => {
    const id = 'x' + ++n;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('超时: ' + id)), 40000);
      waiters.set(id, {
        messages: [],
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
      proc.stdin.write(RS + JSON.stringify({ id, op: 'execute', code }) + '\n');
    });
  };

  return { proc, ready, execute };
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}`);
  if (!ok) {
    failures++;
    if (detail) console.log('      ' + detail);
  }
};

async function runLang(lang) {
  console.log(`\n=== ${lang} ===`);
  const k = startKernel(lang);
  const info = await Promise.race([
    k.ready,
    new Promise((_, rj) => setTimeout(() => rj(new Error('内核启动超时')), 40000)),
  ]);
  console.log(`内核就绪：${info.lang} ${info.version}\n`);

  for (const c of CASES[lang]) {
    const msgs = await k.execute(c.code);
    const result = msgs.find((m) => m.type === 'result');
    const err = msgs.find((m) => m.type === 'error');
    if (err) {
      check(c.name, false, `内核报错 ${err.ename}: ${err.evalue}`);
      continue;
    }
    const data = result?.data ?? {};
    const mimes = Object.keys(data);

    if (c.expectMime === null) {
      check(c.name, mimes.length === 1 && mimes[0] === 'text/plain', `实际 MIME: ${mimes.join(', ')}`);
      continue;
    }

    if (!mimes.includes(c.expectMime)) {
      check(c.name, false, `缺少 ${c.expectMime}，实际: ${mimes.join(', ') || '(无结果)'}`);
      continue;
    }
    const payload = data[c.expectMime];
    const missing = c.expectIn.filter((frag) => !payload.includes(frag));
    const hasPlain = 'text/plain' in data;
    check(
      c.name,
      missing.length === 0 && hasPlain,
      missing.length ? `内容缺少: ${missing.join(', ')}` : '缺少 text/plain 兜底',
    );
    if (c.expectMime === 'image/png') {
      console.log(`      PNG ${payload.length} 字节 base64`);
    }
  }

  k.proc.stdin.write(RS + JSON.stringify({ id: 'bye', op: 'shutdown' }) + '\n');
  setTimeout(() => k.proc.kill('SIGKILL'), 500);
}

const target = process.argv[2] || 'all';
const langs = target === 'all' ? ['java', 'python', 'js'] : [target];

for (const lang of langs) {
  await runLang(lang).catch((e) => {
    console.error(`  ✗ ${lang} 测试异常: ${e.message}`);
    failures++;
  });
}

console.log(`\n${failures === 0 ? '全部通过' : failures + ' 项失败'}\n`);
setTimeout(() => process.exit(failures === 0 ? 0 : 1), 800);
