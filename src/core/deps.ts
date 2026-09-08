/**
 * 依赖声明解析。语法沿用 JBang 的 //DEPS，用户在 Java cell 顶部写：
 *
 *   //DEPS com.google.guava:guava:33.0.0-jre
 *   //DEPS org.apache.commons:commons-lang3:3.14.0
 *
 * 一行可以写多个坐标，用空格或逗号分隔。
 */

const DEPS_LINE = /^\s*\/\/\s*DEPS\s+(.+)$/gim;
/** group:artifact:version，可选 :classifier */
const COORD = /^[\w.\-]+:[\w.\-]+:[\w.\-+]+(?::[\w.\-]+)?$/;

export interface ParsedDeps {
  coords: string[];
  /** 语法不合法的片段，原样返回给用户提示 */
  invalid: string[];
}

export function parseDeps(source: string): ParsedDeps {
  const coords: string[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  DEPS_LINE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEPS_LINE.exec(source)) !== null) {
    for (const token of m[1].split(/[\s,]+/)) {
      const t = token.trim();
      if (!t) continue;
      if (!COORD.test(t)) {
        invalid.push(t);
        continue;
      }
      if (seen.has(t)) continue;
      seen.add(t);
      coords.push(t);
    }
  }
  return { coords, invalid };
}

export function hasDeps(source: string): boolean {
  DEPS_LINE.lastIndex = 0;
  return DEPS_LINE.test(source);
}
