import type { HostBridge, ResolvedDeps } from '../../host/HostBridge';
import { curlProxyArgs, explainCurl } from '../net';

/** 坐标必须严格校验后才能拼进命令行 */
const COORD_RE = /^[\w.\-]+:[\w.\-]+:[\w.\-+]+(?::[\w.\-]+)?$/;

/**
 * 解析 Maven 坐标为本地 jar 路径。只依赖 HostBridge，
 * 因此开发服务器和桌面壳共用这一份实现。
 *
 * 有 mvn 就交给它做完整的传递依赖解析；没有则直连 Maven Central
 * 只下载显式声明的 jar，并明确告知用户不含传递依赖。
 */
export async function resolveDepsWithHost(
  host: HostBridge,
  coords: string[],
): Promise<ResolvedDeps> {
  const warnings: string[] = [];
  for (const c of coords) {
    if (!COORD_RE.test(c)) throw new Error('非法的依赖坐标：' + c);
  }
  if (!coords.length) return { classpath: [], resolver: 'direct', warnings };

  const cacheDir = host.joinPath(await host.homeDir(), '.notex', 'deps');
  await host.ensureDir(cacheDir);

  let hasMvn = false;
  try {
    const probe = await host.exec('mvn', ['-v']);
    hasMvn = probe.code === 0;
  } catch {
    hasMvn = false;
  }

  if (hasMvn) return resolveWithMaven(host, coords, cacheDir, warnings);
  return resolveDirect(host, coords, cacheDir, warnings);
}

async function resolveWithMaven(
  host: HostBridge,
  coords: string[],
  cacheDir: string,
  warnings: string[],
): Promise<ResolvedDeps> {
  const stamp = Date.now();
  const pomFile = host.joinPath(cacheDir, `pom-${stamp}.xml`);
  const outFile = host.joinPath(cacheDir, `cp-${stamp}.txt`);

  const pom = [
    '<project xmlns="http://maven.apache.org/POM/4.0.0">',
    '<modelVersion>4.0.0</modelVersion>',
    '<groupId>tech.notex</groupId><artifactId>deps</artifactId>',
    '<version>1</version><packaging>pom</packaging><dependencies>',
    ...coords.map((c) => {
      const [g, a, v, classifier] = c.split(':');
      return (
        `<dependency><groupId>${g}</groupId><artifactId>${a}</artifactId>` +
        `<version>${v}</version>` +
        (classifier ? `<classifier>${classifier}</classifier>` : '') +
        '</dependency>'
      );
    }),
    '</dependencies></project>',
  ].join('');

  await host.writeText(pomFile, pom);
  const res = await host.exec('mvn', [
    '-q',
    '-f',
    pomFile,
    'dependency:build-classpath',
    `-Dmdep.outputFile=${outFile}`,
  ]);

  if (res.code !== 0) {
    // Maven 的输出尾部是通用样板，挑出真正说明原因的那几行
    const all = `${res.stdout}\n${res.stderr}`;
    const meaningful = all
      .split('\n')
      .map((l) => l.replace(/^\[(ERROR|WARNING)\]\s?/, '').trim())
      .filter(
        (l) =>
          l &&
          !/^(To see the full|Re-run Maven|For more information|https?:\/\/cwiki)/.test(l) &&
          /(Could not resolve|Failed to |not found|was not found|Could not find|Non-resolvable)/i.test(l),
      );
    const detail = meaningful.length
      ? meaningful.slice(0, 3).join('\n')
      : all.trim().split('\n').slice(-3).join('\n');
    await host.removeFile(pomFile).catch(() => undefined);
    throw new Error('解析依赖失败：\n' + detail);
  }

  const cp = (await host.readText(outFile)).trim();
  await host.removeFile(pomFile).catch(() => undefined);
  await host.removeFile(outFile).catch(() => undefined);
  const sep = host.platform() === 'win32' ? ';' : ':';
  return { classpath: cp ? cp.split(sep).filter(Boolean) : [], resolver: 'maven', warnings };
}

async function resolveDirect(
  host: HostBridge,
  coords: string[],
  cacheDir: string,
  warnings: string[],
): Promise<ResolvedDeps> {
  warnings.push('未检测到 mvn，只下载了显式声明的 jar，不含传递依赖。装上 Maven 可获得完整解析。');
  const classpath: string[] = [];
  for (const c of coords) {
    const [g, a, v, classifier] = c.split(':');
    const name = `${a}-${v}${classifier ? '-' + classifier : ''}.jar`;
    const dest = host.joinPath(cacheDir, `${g}-${name}`);
    if (await host.fileExists(dest)) {
      classpath.push(dest);
      continue;
    }
    const url = `https://repo1.maven.org/maven2/${g.replace(/\./g, '/')}/${a}/${v}/${name}`;
    // 用 curl 落盘，避免把 jar 的二进制内容在前后端之间来回搬；代理要显式传给它
    const res = await host.exec('curl', ['-fsSL', ...(await curlProxyArgs(host, url)), '-o', dest, url], {
      timeoutMs: 10 * 60 * 1000,
    });
    if (res.code !== 0) throw new Error(`下载失败 ${c}：${explainCurl(res.code, res.stderr)}\n${url}`);
    classpath.push(dest);
  }
  return { classpath, resolver: 'direct', warnings };
}
