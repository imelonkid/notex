#!/usr/bin/env node
/**
 * NoteX JavaScript 内核
 *
 * 协议：JSON Lines over stdio，每条协议消息以 RS (U+001E) 开头。
 * 启动：node kernel.mjs   （Node 18+，仅用内置模块）
 */
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { inspect } from 'node:util';

const RS = '\x1e';
const REAL_WRITE = process.stdout.write.bind(process.stdout);

function emit(msg) {
  REAL_WRITE(RS + JSON.stringify(msg) + '\n');
}

let currentId = '';

/** 按行缓冲，把用户输出包装成 stream 消息 */
function makeSink(name) {
  let buf = '';
  return {
    push(text) {
      buf += text;
      if (buf.includes('\n')) this.flush();
    },
    flush() {
      if (!buf) return;
      const text = buf;
      buf = '';
      emit({ id: currentId, type: 'stream', name, text });
    },
  };
}

const outSink = makeSink('stdout');
const errSink = makeSink('stderr');

const fmt = (v) =>
  typeof v === 'string' ? v : inspect(v, { depth: 3, colors: false, breakLength: 100 });

const sandboxConsole = {
  log: (...a) => outSink.push(a.map(fmt).join(' ') + '\n'),
  info: (...a) => outSink.push(a.map(fmt).join(' ') + '\n'),
  debug: (...a) => outSink.push(a.map(fmt).join(' ') + '\n'),
  warn: (...a) => errSink.push(a.map(fmt).join(' ') + '\n'),
  error: (...a) => errSink.push(a.map(fmt).join(' ') + '\n'),
  table: (v) => outSink.push(fmt(v) + '\n'),
};

// 持久上下文：跨 cell 保留变量
const require_ = createRequire(process.cwd() + '/');
const sandbox = {
  console: sandboxConsole,
  require: require_,
  process,
  Buffer,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  setImmediate,
  queueMicrotask,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  fetch: globalThis.fetch,
  structuredClone,
};
sandbox.globalThis = sandbox;
const context = vm.createContext(sandbox);

/** 富输出：对象自带 toHTML() 时一并给出 text/html */
function resultBundle(value) {
  const data = { 'text/plain': fmt(value) };
  if (value && typeof value.toHTML === 'function') {
    try {
      const html = value.toHTML();
      if (html) data['text/html'] = String(html);
    } catch {
      /* 忽略渲染失败 */
    }
  }
  return data;
}

function cleanStack(err) {
  const stack = String(err?.stack ?? '');
  return stack
    .split('\n')
    .slice(1)
    .filter((l) => !l.includes('node:vm') && !l.includes('kernel.mjs') && !l.includes('node:internal'))
    .map((l) => l.trimEnd())
    .slice(0, 12);
}

async function execute(id, code) {
  currentId = id;
  let status = 'ok';
  try {
    // 先尝试编译成表达式以便拿到返回值，编译不过再按语句块编译。
    // 编译与执行分开，避免用 instanceof 判断跨 realm 的 SyntaxError。
    let script;
    try {
      script = new vm.Script(`(${code}\n)`, { filename: 'cell.js' });
    } catch {
      script = new vm.Script(code, { filename: 'cell.js' });
    }
    // breakOnSigint 让同步死循环也能被 SIGINT 打断，
    // 否则事件循环被占死，连 stdin 都读不到。
    const value = await script.runInContext(context, { breakOnSigint: true });
    if (value !== undefined) {
      emit({ id, type: 'result', data: resultBundle(value) });
    }
  } catch (err) {
    const interrupted = /interrupted by SIGINT|was interrupted/i.test(String(err?.message ?? ''));
    emit({
      id,
      type: 'error',
      ename: interrupted ? 'KeyboardInterrupt' : (err?.name ?? 'Error'),
      evalue: interrupted ? '执行被中断' : (err?.message ?? String(err)),
      traceback: interrupted ? [] : cleanStack(err),
    });
    status = interrupted ? 'aborted' : 'error';
  } finally {
    outSink.flush();
    errSink.flush();
    currentId = '';
  }
  return status;
}

/** 反射上下文对象的属性做补全 */
function complete(id, code, cursor) {
  const prefix = code.slice(0, cursor);
  const m = /([\w$]+(?:\.[\w$]+)*)\.?([\w$]*)$/.exec(prefix);
  const items = [];
  let anchor = cursor;

  const collect = (obj, token) => {
    const seen = new Set();
    let cur = obj;
    for (let depth = 0; cur && depth < 4; depth += 1) {
      for (const key of Object.getOwnPropertyNames(cur)) {
        if (seen.has(key) || !key.startsWith(token)) continue;
        if (/^\d/.test(key)) continue;
        seen.add(key);
        let kind = 'property';
        try {
          kind = typeof obj[key] === 'function' ? 'method' : 'property';
        } catch {
          /* getter 抛错就当属性 */
        }
        items.push({ label: key, kind });
        if (items.length >= 80) return;
      }
      cur = Object.getPrototypeOf(cur);
    }
  };

  try {
    if (m && prefix.endsWith('.')) {
      // obj. 的形式：补全成员
      const target = vm.runInContext(m[1], context, { filename: 'complete.js' });
      anchor = cursor;
      collect(target, '');
    } else if (m && m[1].includes('.')) {
      const path = m[1].slice(0, m[1].lastIndexOf('.'));
      const token = m[1].slice(m[1].lastIndexOf('.') + 1);
      const target = vm.runInContext(path, context, { filename: 'complete.js' });
      anchor = cursor - token.length;
      collect(target, token);
    } else {
      const token = m ? m[1] : '';
      anchor = cursor - token.length;
      collect(context, token);
      for (const kw of ['const', 'let', 'var', 'function', 'return', 'await', 'async', 'class', 'if', 'else', 'for', 'while', 'try', 'catch']) {
        if (kw.startsWith(token) && !items.some((i) => i.label === kw)) {
          items.push({ label: kw, kind: 'keyword' });
        }
      }
    }
  } catch {
    /* 表达式求值失败就返回空列表 */
  }

  emit({ id, type: 'completions', anchor: Math.max(0, anchor), items });
  emit({ id, type: 'done', status: 'ok', durationMs: 0 });
}

function inspectOp(id, code, cursor) {
  const m = /([\w$.]+)$/.exec(code.slice(0, cursor));
  let text = '';
  if (m) {
    try {
      const v = vm.runInContext(m[1], context, { filename: 'inspect.js' });
      text = typeof v === 'function' ? String(v).slice(0, 400) : fmt(v).slice(0, 400);
    } catch {
      text = '';
    }
  }
  emit({ id, type: 'inspection', text });
  emit({ id, type: 'done', status: 'ok', durationMs: 0 });
}

// 空闲时收到 SIGINT 不要退出；执行期间 breakOnSigint 会接管这个信号
process.on('SIGINT', () => {});

emit({ id: 'boot', type: 'ready', lang: 'js', version: process.versions.node });

// 串行处理请求，保证 cell 执行顺序
let chain = Promise.resolve();
let buf = '';

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).replace(/\r$/, '');
    buf = buf.slice(nl + 1);
    if (!line || line[0] !== RS) continue;

    let req;
    try {
      req = JSON.parse(line.slice(1));
    } catch {
      continue;
    }

    if (req.op === 'execute') {
      chain = chain.then(async () => {
        const t0 = Date.now();
        const status = await execute(req.id, req.code ?? '');
        emit({ id: req.id, type: 'done', status, durationMs: Date.now() - t0 });
      });
    } else if (req.op === 'complete') {
      chain = chain.then(() => complete(req.id, req.code ?? '', req.cursor ?? 0));
    } else if (req.op === 'inspect') {
      chain = chain.then(() => inspectOp(req.id, req.code ?? '', req.cursor ?? 0));
    } else if (req.op === 'shutdown') {
      chain = chain.then(() => process.exit(0));
    }
  }
});

process.stdin.on('end', () => process.exit(0));
