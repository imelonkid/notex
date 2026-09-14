/**
 * 笔记附带的图片放在笔记同目录的 .assets/ 下。
 *
 * 点开头的目录不进侧栏的文件树，Git 和 GitHub 照常识别相对路径，
 * 用别的编辑器打开 .md 也能显示。文件名带来源的哈希：同一张图粘两次只落一份，
 * 不同来源的同名图也不会互相覆盖。
 */

export const ASSETS_DIR = '.assets';

const MAX_BASE = 48;

/** FNV-1a，够用来给文件名去重，不需要密码学强度 */
export function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

/** data:image/png;base64,… 的类型对应的扩展名 */
export function extOfMime(mime: string): string {
  return EXT_BY_MIME[mime.toLowerCase()] ?? 'bin';
}

/** 地址里的文件名部分，去掉查询串、非法字符，太长就截断 */
function baseNameOf(url: string): { base: string; ext: string } {
  let path = url;
  try {
    path = new URL(url).pathname;
  } catch {
    /* 不是完整 URL 就当路径 */
  }
  const last = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '');
  const dot = last.lastIndexOf('.');
  const rawBase = dot > 0 ? last.slice(0, dot) : last;
  const rawExt = dot > 0 ? last.slice(dot + 1) : '';
  const base = rawBase.replace(/[^\w一-鿿.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_BASE) || 'image';
  const ext = /^[a-z0-9]{1,5}$/i.test(rawExt) ? rawExt.toLowerCase() : '';
  return { base, ext };
}

/**
 * 远程图片落地后的文件名：`<哈希>-<原名>.<扩展名>`。
 * 原地址没有扩展名时用 fallbackExt（通常从 Content-Type 或 data: 类型来）。
 */
export function assetNameForUrl(url: string, fallbackExt = 'png'): string {
  const { base, ext } = baseNameOf(url);
  return `${shortHash(url)}-${base}.${ext || fallbackExt}`;
}

/** 剪贴板里的图片文件（截图之类）：按内容哈希和时间取名 */
export function assetNameForBlob(mime: string, seed: string, originalName?: string): string {
  const ext = originalName && /\.([a-z0-9]{1,5})$/i.test(originalName) ? originalName.split('.').pop()!.toLowerCase() : extOfMime(mime);
  const base = originalName ? baseNameOf(originalName).base : 'pasted';
  return `${shortHash(seed)}-${base}.${ext}`;
}

/** Markdown 里写的相对路径 */
export function assetRelPath(name: string): string {
  return `${ASSETS_DIR}/${name}`;
}
