import { useEffect, useState } from 'react';
import { LANGS } from '@core/model';
import type { NoteSummary } from '@core/noteSummary';
import { formatDay, formatUpdated } from '@core/relativeTime';
import type { NotebookRef } from '@core/store/index';
import { baseOf, compareNames, dirOf } from '@core/store/paths';
import { DRAG_MIME } from './NoteTree';
import { FolderIcon, NoteIcon, SearchIcon } from './icons';

type SortKey = 'updated' | 'name';
const SORT_KEY = 'nx.folder.sort';

function readSort(): SortKey {
  try {
    return localStorage.getItem(SORT_KEY) === 'name' ? 'name' : 'updated';
  } catch {
    return 'updated';
  }
}

const LANG_LABEL: Record<string, string> = Object.fromEntries(LANGS.map((l) => [l.id, l.label]));

interface Props {
  /** 笔记库根为空串 */
  dir: string;
  notes: NotebookRef[];
  folders: string[];
  summaryOf(id: string): NoteSummary | undefined;
  /** 目录最多三级，到顶了就不能再建子文件夹 */
  canCreateFolder: boolean;
  onOpenNote(id: string): void;
  onOpenFolder(dir: string): void;
  onCreateNote(dir: string): void;
  onCreateFolder(dir: string): void;
  onFolderMenu(dir: string, x: number, y: number, align?: 'left' | 'right'): void;
  onNoteMenu(id: string, x: number, y: number): void;
  onDragStart(id: string): void;
  onDragEnd(): void;
  onDropNote(dir: string): void;
}

const inDir = (n: NotebookRef, dir: string) => n.dir === dir || (dir !== '' && n.dir.startsWith(`${dir}/`));

const latestOf = (list: NotebookRef[]) =>
  list.reduce<string | undefined>((max, n) => (n.updated && (!max || n.updated > max) ? n.updated : max), undefined);

/**
 * 文件夹页：点开一个文件夹看到的内容。
 * 这里有什么、最近动过什么，从这里新建、打开，或者把笔记拖进来。
 */
export function FolderPage(props: Props) {
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<SortKey>(readSort);
  /** 拖拽悬停在哪个目录上：子文件夹行或底部的放置区 */
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // 换了文件夹，上一个文件夹里的搜索词就没意义了
  useEffect(() => {
    setQuery('');
  }, [props.dir]);

  const name = props.dir ? baseOf(props.dir) : '我的笔记';
  const direct = props.notes.filter((n) => n.dir === props.dir);
  const subDirs = props.folders.filter((f) => dirOf(f) === props.dir);
  const latest = latestOf(props.notes.filter((n) => inDir(n, props.dir)));

  const q = query.trim().toLowerCase();
  const hit = (text: string) => text.toLowerCase().includes(q);

  // 文件夹始终排在前面、按名字排；排序方式只作用于笔记
  const folderRows = subDirs.filter((d) => !q || hit(baseOf(d))).sort((a, b) => compareNames(baseOf(a), baseOf(b)));
  const noteRows = direct
    .filter((n) => !q || hit(n.title) || hit(props.summaryOf(n.id)?.excerpt ?? ''))
    .sort((a, b) =>
      sort === 'name'
        ? compareNames(a.title, b.title)
        : (b.updated ?? '').localeCompare(a.updated ?? '') || compareNames(a.title, b.title),
    );

  const stats = [`${direct.length} 篇笔记`];
  if (subDirs.length) stats.push(`${subDirs.length} 个子文件夹`);
  if (latest) {
    const day = formatDay(latest);
    stats.push(`最近更新于${/^\d/.test(day) ? ` ${day}` : day}`);
  }

  const acceptDrop = (e: React.DragEvent, dir: string) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (dropTarget !== dir) setDropTarget(dir);
  };

  const drop = (e: React.DragEvent, dir: string) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    setDropTarget(null);
    props.onDropNote(dir);
  };

  const onEnter = (open: () => void) => (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      open();
    }
  };

  const empty = folderRows.length === 0 && noteRows.length === 0;

  return (
    <div className="nx-folder-page">
      <h1 className="nx-folder-title">{name}</h1>
      <div className="nx-folder-stats">{stats.join(' · ')}</div>

      <div className="nx-toolbar">
        <button className="nx-btn-primary" title={`在「${name}」里新建笔记`} onClick={() => props.onCreateNote(props.dir)}>
          ＋ 新建笔记
        </button>
        <div className="nx-seg">
          <button
            className="nx-seg-btn"
            disabled={!props.canCreateFolder}
            title={props.canCreateFolder ? `在「${name}」里新建文件夹` : '文件夹最多三级，这里不能再往下建了'}
            onClick={() => props.onCreateFolder(props.dir)}
          >
            新建文件夹
          </button>
        </div>
        <span style={{ flex: 1 }} />
        <button
          className="nx-btn-ghost"
          title="更多操作"
          aria-label="更多操作"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            props.onFolderMenu(props.dir, r.right, r.bottom + 4, 'right');
          }}
        >
          ⋯
        </button>
      </div>

      <div className="nx-folder-controls">
        <label className="nx-folder-search">
          <SearchIcon />
          <input
            type="search"
            value={query}
            placeholder="搜索当前文件夹：标题与摘要"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') setQuery('');
            }}
          />
        </label>
        <select
          className="nx-select"
          value={sort}
          aria-label="排序方式"
          onChange={(e) => {
            const next: SortKey = e.target.value === 'name' ? 'name' : 'updated';
            setSort(next);
            try {
              localStorage.setItem(SORT_KEY, next);
            } catch {
              /* 无痕模式等场景忽略 */
            }
          }}
        >
          <option value="updated">最近更新</option>
          <option value="name">名称</option>
        </select>
      </div>

      {empty ? (
        <div className="nx-folder-empty">{q ? `没有找到和「${query.trim()}」相关的内容` : '这个文件夹还是空的'}</div>
      ) : (
        <ul className="nx-folder-list">
          {folderRows.map((d) => {
            const inside = props.notes.filter((n) => inDir(n, d));
            return (
              <li
                key={`dir:${d}`}
                className="nx-folder-row"
                data-kind="folder"
                data-drop={dropTarget === d}
                role="button"
                tabIndex={0}
                onClick={() => props.onOpenFolder(d)}
                onKeyDown={onEnter(() => props.onOpenFolder(d))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  props.onFolderMenu(d, e.clientX, e.clientY);
                }}
                onDragOver={(e) => acceptDrop(e, d)}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => drop(e, d)}
              >
                <span className="nx-folder-row-icon">
                  <FolderIcon size={20} />
                </span>
                <span className="nx-folder-row-main">
                  <span className="nx-folder-row-title">{baseOf(d)}</span>
                  <span className="nx-folder-row-excerpt">{inside.length} 篇笔记</span>
                </span>
                <span className="nx-folder-row-time">{formatUpdated(latestOf(inside))}</span>
                <span className="nx-folder-row-tags" />
              </li>
            );
          })}
          {noteRows.map((n) => {
            const summary = props.summaryOf(n.id);
            return (
              <li
                key={n.id}
                className="nx-folder-row"
                data-kind="note"
                role="button"
                tabIndex={0}
                draggable
                onDragStart={(e) => {
                  // WebKit 里不写 dataTransfer 就发不出拖拽
                  e.dataTransfer.setData(DRAG_MIME, n.id);
                  e.dataTransfer.setData('text/plain', n.title);
                  e.dataTransfer.effectAllowed = 'move';
                  props.onDragStart(n.id);
                }}
                onDragEnd={props.onDragEnd}
                onClick={() => props.onOpenNote(n.id)}
                onKeyDown={onEnter(() => props.onOpenNote(n.id))}
                onContextMenu={(e) => {
                  e.preventDefault();
                  props.onNoteMenu(n.id, e.clientX, e.clientY);
                }}
              >
                <span className="nx-folder-row-icon">
                  <NoteIcon size={20} />
                </span>
                <span className="nx-folder-row-main">
                  <span className="nx-folder-row-title">{n.title || '未命名笔记'}</span>
                  {summary?.excerpt ? <span className="nx-folder-row-excerpt">{summary.excerpt}</span> : null}
                </span>
                <span className="nx-folder-row-time">{formatUpdated(n.updated)}</span>
                <span className="nx-folder-row-tags">
                  {summary?.langs.map((l) => (
                    <span key={l} className="nx-lang-tag">
                      {LANG_LABEL[l] ?? l}
                    </span>
                  ))}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      <div
        className="nx-folder-drop"
        data-active={dropTarget === props.dir}
        onDragOver={(e) => acceptDrop(e, props.dir)}
        onDragLeave={() => setDropTarget(null)}
        onDrop={(e) => drop(e, props.dir)}
      >
        <NoteIcon size={18} />
        <span>将笔记拖到这里，移动到「{name}」</span>
      </div>
    </div>
  );
}
