#!/usr/bin/env node
/**
 * 从 dist/ 里的包生成 catalog.json。
 *
 *   node make-catalog.mjs --dist dist --out dist/catalog.json \
 *     --base https://notex-runtimes.oss-cn-hangzhou.aliyuncs.com/v1 \
 *     --base https://gitee.com/<owner>/notex-runtimes/releases/download/v1 \
 *     [--merge previous-catalog.json]
 *
 * 包名约定：<id>-<version>-<platform>-<arch>.tar.gz，version 里可以有 "-"。
 * --base 可以给多个，下载地址按给出的顺序排列：国内镜像放前面。
 * --merge 把上一份清单里这次没重新构建的平台保留下来（比如只重打了 arm64）。
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { dist: path.join(HERE, 'dist'), out: '', bases: [], merge: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--dist') out.dist = next();
    else if (a === '--out') out.out = next();
    else if (a === '--base') out.bases.push(next().replace(/\/+$/, ''));
    else if (a === '--merge') out.merge = next();
    else throw new Error(`未知参数 ${a}`);
  }
  if (!out.out) out.out = path.join(out.dist, 'catalog.json');
  if (!out.bases.length) throw new Error('至少给一个 --base');
  return out;
}

function sha256(file) {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file).on('data', (d) => h.update(d)).on('end', () => resolve(h.digest('hex'))).on('error', reject);
  });
}

/** 从文件名拆出 id / version / platform / arch；id 按模板里的 id 最长匹配 */
function parseName(name, ids) {
  const m = /^(.+)-(darwin|linux|win32)-(arm64|x64)\.tar\.gz$/.exec(name);
  if (!m) return null;
  const head = m[1];
  const id = ids.filter((i) => head.startsWith(i + '-')).sort((a, b) => b.length - a.length)[0];
  if (!id) return null;
  return { id, version: head.slice(id.length + 1), platform: m[2], arch: m[3] };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const src = JSON.parse(await readFile(path.join(HERE, 'catalog.src.json'), 'utf8'));
  const ids = Object.keys(src.runtimes);

  // 上一份清单：按 id@version 存 builds，这次没重打的平台沿用
  const previous = new Map();
  if (args.merge) {
    const old = JSON.parse(await readFile(args.merge, 'utf8'));
    for (const r of old.runtimes ?? []) previous.set(`${r.id}@${r.version}`, r);
  }

  const found = new Map(); // id@version → { id, version, builds: Map(platform-arch → build) }
  for (const name of (await readdir(args.dist)).sort()) {
    const parsed = parseName(name, ids);
    if (!parsed) continue;
    const file = path.join(args.dist, name);
    const size = (await stat(file)).size;
    const digest = await sha256(file);
    const key = `${parsed.id}@${parsed.version}`;
    if (!found.has(key)) found.set(key, { ...parsed, builds: new Map() });
    found.get(key).builds.set(`${parsed.platform}-${parsed.arch}`, {
      platform: parsed.platform,
      arch: parsed.arch,
      size,
      sha256: digest,
      urls: args.bases.map((b) => `${b}/${name}`),
    });
    console.log(`  ${name}  ${(size / 1024 / 1024).toFixed(1)} MB  ${digest.slice(0, 12)}…`);
  }

  // 合并旧清单里同版本的其它平台
  for (const [key, old] of previous) {
    if (!found.has(key)) {
      found.set(key, { id: old.id, version: old.version, builds: new Map(old.builds.map((b) => [`${b.platform}-${b.arch}`, b])) });
      continue;
    }
    const cur = found.get(key);
    for (const b of old.builds) {
      const k = `${b.platform}-${b.arch}`;
      if (!cur.builds.has(k)) cur.builds.set(k, b);
    }
  }

  const runtimes = [...found.values()]
    .map((r) => ({
      id: r.id,
      lang: src.runtimes[r.id].lang,
      label: src.runtimes[r.id].label,
      version: r.version,
      protocol: src.runtimes[r.id].protocol ?? 1,
      entry: src.runtimes[r.id].entry,
      packages: src.runtimes[r.id].packages,
      notes: src.runtimes[r.id].notes,
      builds: [...r.builds.values()].sort((a, b) => `${a.platform}${a.arch}`.localeCompare(`${b.platform}${b.arch}`)),
    }))
    .sort((a, b) => a.id.localeCompare(b.id) || b.version.localeCompare(a.version));

  const catalog = { version: 1, generated: new Date().toISOString(), runtimes };
  await writeFile(args.out, JSON.stringify(catalog, null, 2) + '\n');
  console.log(`\n写出 ${args.out}：${runtimes.length} 个运行时，${runtimes.reduce((n, r) => n + r.builds.length, 0)} 个构建`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
