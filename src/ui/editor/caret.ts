/**
 * 算出 textarea 里光标的像素位置。
 *
 * 浏览器没有直接的接口，通用做法是造一个样式完全一致的镜像元素，
 * 把光标之前的文本放进去，再量末尾那个标记的位置。
 */

/** 会影响文本排布的属性，必须逐条复制到镜像上 */
const COPIED_STYLES = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'fontStyle',
  'letterSpacing',
  'lineHeight',
  'textTransform',
  'textIndent',
  'whiteSpace',
  'wordSpacing',
  'wordBreak',
  'overflowWrap',
  'tabSize',
] as const;

export interface CaretPosition {
  /** 相对视口的坐标，可直接用于 position: fixed */
  left: number;
  top: number;
  /** 当前行高，用于把浮层放到光标下一行 */
  lineHeight: number;
}

export function caretPosition(el: HTMLTextAreaElement, index: number): CaretPosition {
  const style = window.getComputedStyle(el);
  const mirror = document.createElement('div');

  for (const key of COPIED_STYLES) {
    mirror.style[key] = style[key];
  }
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  // 高度交给内容撑开，否则量不到正确的换行位置
  mirror.style.height = 'auto';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';

  mirror.textContent = el.value.slice(0, index);
  const marker = document.createElement('span');
  // 放一个零宽字符，空 span 量不到位置
  marker.textContent = '​';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);

  const rect = el.getBoundingClientRect();
  const lineHeight = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.4;
  const left = rect.left + marker.offsetLeft - el.scrollLeft;
  const top = rect.top + marker.offsetTop - el.scrollTop;

  document.body.removeChild(mirror);
  return { left, top, lineHeight };
}

/**
 * 光标是否正处在一个还没写完的 [[ 里。
 * 返回查询词与 [[ 的位置，供插入时替换。
 */
export function wikiLinkQuery(
  value: string,
  caret: number,
): { query: string; start: number } | null {
  const before = value.slice(0, caret);
  const open = before.lastIndexOf('[[');
  if (open < 0) return null;
  const inner = before.slice(open + 2);
  // 已经闭合或跨行就不算
  if (inner.includes(']]') || inner.includes('\n')) return null;
  // 竖线之后是显示文字，不再补全目标
  if (inner.includes('|')) return null;
  return { query: inner, start: open };
}
