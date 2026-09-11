import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { SearchHit } from '@core/linkIndex';
import type { NotebookRef } from '@core/store/index';
import { baseOf, dirOf } from '@core/store/paths';
import { NoteIcon, SearchIcon } from './icons';

interface Props {
  notes: NotebookRef[];
  /** 索引是否建完；没建完时正文搜索不全，要告诉用户 */
  ready: boolean;
  search(query: string): SearchHit[];
  onOpen(id: string): void;
  onClose(): void;
}

const RECENT_MAX = 12;

/** 把命中的词加粗，其余原样。只处理第一个词，多了反而花 */
function highlight(text: string, token: string): ReactNode {
  if (!token) return text;
  const at = text.toLowerCase().indexOf(token.toLowerCase());
  if (at < 0) return text;
  return (
    <>
      {text.slice(0, at)}
      <mark className="nx-palette-mark">{text.slice(at, at + token.length)}</mark>
      {text.slice(at + token.length)}
    </>
  );
}

/**
 * ⌘K 唤出的搜索面板：既是快速切换（空查询列最近改过的），也是全文搜索。
 * 搜索走链接索引里已经读进内存的正文，不再碰磁盘。
 */
export function SearchPalette({ notes, ready, search, onOpen, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const token = query.trim().split(/\s+/)[0] ?? '';

  const rows = useMemo<Array<{ id: string; snippet: string }>>(() => {
    if (!query.trim()) {
      return [...notes]
        .sort((a, b) => (b.updated ?? '').localeCompare(a.updated ?? ''))
        .slice(0, RECENT_MAX)
        .map((n) => ({ id: n.id, snippet: '' }));
    }
    return search(query).map((h) => ({ id: h.id, snippet: h.snippet }));
  }, [query, notes, search]);

  useEffect(() => setActive(0), [query]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 键盘选中项滚进视野
  useEffect(() => {
    listRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const pick = (id: string) => {
    onOpen(id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (rows.length) setActive((i) => (i + 1) % rows.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (rows.length) setActive((i) => (i - 1 + rows.length) % rows.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[active];
      if (row) pick(row.id);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div className="nx-modal-backdrop nx-palette-backdrop" onMouseDown={onClose}>
      <div className="nx-palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <label className="nx-palette-input">
          <SearchIcon />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索笔记：标题与正文，多个词用空格隔开"
            spellCheck={false}
            onChange={(e) => setQuery(e.target.value)}
          />
          <kbd className="nx-kbd">esc</kbd>
        </label>
        <div className="nx-palette-list" ref={listRef} role="listbox">
          {rows.length === 0 ? (
            <div className="nx-palette-empty">
              {query.trim() ? `没有找到和「${query.trim()}」相关的笔记` : '笔记库还是空的'}
            </div>
          ) : (
            rows.map((row, i) => (
              <button
                key={row.id}
                className="nx-palette-item"
                data-index={i}
                data-active={i === active}
                role="option"
                aria-selected={i === active}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(row.id)}
              >
                <span className="nx-palette-icon">
                  <NoteIcon />
                </span>
                <span className="nx-palette-main">
                  <span className="nx-palette-title">
                    {highlight(baseOf(row.id), token)}
                    {dirOf(row.id) && <span className="nx-palette-dir">{dirOf(row.id)}</span>}
                  </span>
                  {row.snippet && <span className="nx-palette-snippet">{highlight(row.snippet, token)}</span>}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="nx-palette-foot">
          {query.trim() ? (ready ? `${rows.length} 篇` : '索引还在建，正文搜索可能不全') : '最近更新'}
          <span style={{ flex: 1 }} />
          <kbd className="nx-kbd">↑↓</kbd> 选择 <kbd className="nx-kbd">↩</kbd> 打开
        </div>
      </div>
    </div>
  );
}
