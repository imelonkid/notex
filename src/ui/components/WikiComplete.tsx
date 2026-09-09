import { useEffect, useMemo, useRef, useState } from 'react';
import type { NotebookRef } from '@core/store/index';
import { dirOf } from '@core/store/paths';
import { caretPosition, wikiLinkQuery } from '../editor/caret';

interface Props {
  textarea: HTMLTextAreaElement | null;
  value: string;
  notes: NotebookRef[];
  /** 当前笔记，用于排除自己并优先同目录 */
  currentNoteId: string | null;
  onInsert(next: string, caret: number): void;
}

const MAX_ITEMS = 8;

/** 子串匹配即可，笔记名通常不长，不必上模糊算法 */
function match(notes: NotebookRef[], query: string, currentId: string | null): NotebookRef[] {
  const q = query.trim().toLowerCase();
  const fromDir = currentId ? dirOf(currentId) : '';
  const pool = notes.filter((n) => n.id !== currentId);
  const hit = q
    ? pool.filter((n) => n.title.toLowerCase().includes(q) || n.id.toLowerCase().includes(q))
    : pool;

  return [...hit]
    .sort((a, b) => {
      // 前缀匹配优先，其次同目录，最后按名字
      const ap = a.title.toLowerCase().startsWith(q) ? 0 : 1;
      const bp = b.title.toLowerCase().startsWith(q) ? 0 : 1;
      if (ap !== bp) return ap - bp;
      const ad = a.dir === fromDir ? 0 : 1;
      const bd = b.dir === fromDir ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.title.localeCompare(b.title);
    })
    .slice(0, MAX_ITEMS);
}

/**
 * 在 Markdown 编辑框里敲 [[ 时弹出的笔记补全。
 * 编辑框是原生 textarea，浮层位置靠镜像元素量出来。
 */
export function WikiComplete({ textarea, value, notes, currentNoteId, onInsert }: Props) {
  const [state, setState] = useState<{
    query: string;
    start: number;
    left: number;
    top: number;
  } | null>(null);
  const [active, setActive] = useState(0);
  const stateRef = useRef(state);
  stateRef.current = state;

  const items = useMemo(
    () => (state ? match(notes, state.query, currentNoteId) : []),
    [state, notes, currentNoteId],
  );
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const activeRef = useRef(active);
  activeRef.current = active;

  /** 把选中的笔记写成 [[...]] 插回编辑框 */
  const insert = (note: NotebookRef) => {
    const current = stateRef.current;
    if (!current || !textarea) return;
    const caret = textarea.selectionStart ?? 0;
    // 同名笔记多于一篇时带上目录，保证链接能唯一定位
    const sameName = notes.filter((n) => n.title === note.title).length > 1;
    const target = sameName ? note.id : note.title;
    const before = textarea.value.slice(0, current.start);
    const after = textarea.value.slice(caret);
    const inserted = `[[${target}]]`;
    onInsert(before + inserted + after, before.length + inserted.length);
    setState(null);
  };
  const insertRef = useRef(insert);
  insertRef.current = insert;

  useEffect(() => setActive(0), [state?.query]);

  useEffect(() => {
    if (!textarea) return;

    const sync = () => {
      const caret = textarea.selectionStart ?? 0;
      const found = wikiLinkQuery(textarea.value, caret);
      if (!found) {
        setState(null);
        return;
      }
      const pos = caretPosition(textarea, caret);
      setState({
        query: found.query,
        start: found.start,
        left: pos.left,
        top: pos.top + pos.lineHeight + 2,
      });
    };

    const onKeyDown = (e: KeyboardEvent) => {
      if (!stateRef.current || !itemsRef.current.length) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((i) => (i + 1) % itemsRef.current.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((i) => (i - 1 + itemsRef.current.length) % itemsRef.current.length);
      } else if (e.key === 'Enter' || e.key === 'Tab') {
        // 补全时 Enter 用来选中，不该触发"回到预览"
        e.preventDefault();
        e.stopPropagation();
        insertRef.current(itemsRef.current[activeRef.current]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setState(null);
      }
    };

    // 捕获阶段，抢在编辑框自己的 Shift+Enter 之前
    textarea.addEventListener('keydown', onKeyDown, true);
    textarea.addEventListener('input', sync);
    textarea.addEventListener('click', sync);
    textarea.addEventListener('keyup', sync);
    textarea.addEventListener('blur', () => setState(null));
    return () => {
      textarea.removeEventListener('keydown', onKeyDown, true);
      textarea.removeEventListener('input', sync);
      textarea.removeEventListener('click', sync);
      textarea.removeEventListener('keyup', sync);
    };
  }, [textarea, notes, onInsert, currentNoteId]);

  // 外部改了内容（比如切换笔记）就收起来
  useEffect(() => {
    if (!textarea) setState(null);
  }, [value, textarea]);

  if (!state || !items.length) return null;

  return (
    <div className="nx-wiki-complete" style={{ left: state.left, top: state.top }}>
      {items.map((note, i) => (
        <button
          key={note.id}
          className="nx-wiki-item"
          data-active={i === active}
          // mousedown 抢在 textarea 失焦之前
          onMouseDown={(e) => {
            e.preventDefault();
            insert(note);
          }}
          onMouseEnter={() => setActive(i)}
        >
          <span className="nx-wiki-name">{note.title}</span>
          {note.dir && <span className="nx-wiki-dir">{note.dir}</span>}
        </button>
      ))}
    </div>
  );
}
