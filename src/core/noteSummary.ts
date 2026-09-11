/**
 * 从笔记原文里提取列表页要展示的摘要和代码语言。
 * 链接索引建索引时已经读过每篇原文，顺带算出来，不额外读盘。
 */

import type { LangId } from './model';
import { LANG_BY_FENCE } from './serialize';

export interface NoteSummary {
  /** 第一段正文的纯文本，去掉了 Markdown 标记 */
  excerpt: string;
  /** 代码块用到的语言，按首次出现的顺序 */
  langs: LangId[];
}

const EXCERPT_MAX = 80;

/** 行内 Markdown 标记去掉，只留读得出来的文字 */
function plainText(line: string): string {
  return (
    line
      .replace(/^\s{0,3}>\s?/, '')
      .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      // [[目标#小节|别名]] 显示别名，没有别名显示目标
      .replace(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, target: string, alias?: string) => alias ?? target)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/__(.+?)__/g, '$1')
      .replace(/\*(\S(?:.*?\S)?)\*/g, '$1')
      // 单个下划线只在两侧是空白时才算强调，免得把 answer_i 这种变量名吞掉
      .replace(/(^|\s)_(\S(?:.*?\S)?)_(?=\s|$)/g, '$1$2')
      .replace(/~~(.+?)~~/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function truncate(text: string): string {
  const chars = Array.from(text);
  return chars.length > EXCERPT_MAX ? `${chars.slice(0, EXCERPT_MAX).join('')}…` : text;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s{`~]*)/;
const HEADING = /^ {0,3}#{1,6}(\s|$)/;
const RULE = /^ {0,3}([-*_])(\s*\1){2,}\s*$/;

export function summarizeMarkdown(markdown: string): NoteSummary {
  let body = markdown.replace(/^﻿/, '');
  const frontmatter = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(body);
  if (frontmatter) body = body.slice(frontmatter[0].length);

  const langs: LangId[] = [];
  const paragraph: string[] = [];
  let excerptDone = false;
  let fence: string | null = null;

  for (const line of body.split(/\r?\n/)) {
    const m = FENCE_OPEN.exec(line);
    if (fence) {
      // 只有同种字符、长度不短于开头、后面不带 info 的那一行才是收尾
      if (m && m[1][0] === fence[0] && m[1].length >= fence.length && !m[2] && !line.slice(m[0].length).trim()) {
        fence = null;
      }
      continue;
    }
    if (m) {
      fence = m[1];
      const lang = LANG_BY_FENCE[m[2].toLowerCase()];
      if (lang && !langs.includes(lang)) langs.push(lang);
      if (paragraph.length) excerptDone = true;
      continue;
    }
    if (excerptDone) continue;

    const blank = !line.trim();
    if (blank || HEADING.test(line) || RULE.test(line)) {
      if (paragraph.length) excerptDone = true;
      continue;
    }
    const text = plainText(line);
    if (text) paragraph.push(text);
  }

  return { excerpt: truncate(paragraph.join(' ')), langs };
}
