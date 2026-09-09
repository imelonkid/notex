import { useEffect, useMemo, useRef, useState } from 'react';
import type { NotebookRef } from '@core/store/index';
import { baseOf, compareNames, dirOf, joinId } from '@core/store/paths';

/** 每层缩进的像素，参考线画在上一层的位置 */
const INDENT = 14;
const BASE_PAD = 10;

function indentStyle(depth: number): React.CSSProperties {
  return {
    paddingLeft: BASE_PAD + depth * INDENT,
    ['--nx-guide' as string]: `${BASE_PAD + (depth - 1) * INDENT + 6}px`,
  };
}

/** 自定义类型让 dragover 不必依赖 React 状态就能判断能否放置 */
export const DRAG_MIME = 'application/x-notex-note';

interface Props {
  notes: NotebookRef[];
  folders: string[];
  activeId: string | null;
  expanded: Set<string>;
  dragId: string | null;
  /** 拖拽悬停的目标目录，null 表示没有 */
  dropDir: string | null;
  onToggle(dir: string): void;
  onOpen(id: string): void;
  onNoteMenu(id: string, x: number, y: number): void;
  onRename(id: string, title: string): void;
  /** 正在重命名的笔记，由外部控制，方便右键菜单也走同一条路径 */
  renamingId: string | null;
  onRenamingChange(id: string | null): void;
  onFolderMenu(dir: string, x: number, y: number): void;
  onDragStart(id: string): void;
  onDragEnd(): void;
  onDragOverDir(dir: string | null): void;
  onDropTo(dir: string): void;
}

interface Row extends NotebookRef {
  /** 拖拽预览行：显示笔记落到目标目录后会在哪 */
  ghost?: boolean;
}

interface TreeNode {
  dir: string;
  name: string;
  children: TreeNode[];
  notes: Row[];
}

/** 把平铺的笔记与目录列表组装成树；存储层只负责列举，树在这里拼 */
function buildTree(notes: Row[], folders: string[]): TreeNode {
  const root: TreeNode = { dir: '', name: '', children: [], notes: [] };
  const byDir = new Map<string, TreeNode>([['', root]]);

  const ensure = (dir: string): TreeNode => {
    const existing = byDir.get(dir);
    if (existing) return existing;
    const parent = ensure(dirOf(dir));
    const node: TreeNode = { dir, name: baseOf(dir), children: [], notes: [] };
    parent.children.push(node);
    byDir.set(dir, node);
    return node;
  };

  // 先按层级浅到深建目录，保证父目录先于子目录创建
  for (const dir of [...folders].sort((a, b) => a.split('/').length - b.split('/').length)) {
    ensure(dir);
  }
  for (const note of notes) ensure(note.dir).notes.push(note);

  const sortNode = (node: TreeNode) => {
    node.children.sort((a, b) => compareNames(a.name, b.name));
    node.notes.sort((a, b) => compareNames(a.title, b.title));
    node.children.forEach(sortNode);
  };
  sortNode(root);
  return root;
}

/**
 * 拖拽过程中把被拖的笔记临时挪到目标目录，
 * 树直接显示放手之后的样子。列表按名字排序，
 * 所以落点由名字决定，预览行会出现在它最终该在的位置。
 */
function withPreview(notes: NotebookRef[], dragId: string | null, dropDir: string | null): Row[] {
  if (!dragId || dropDir === null) return notes;
  const dragged = notes.find((n) => n.id === dragId);
  if (!dragged || dragged.dir === dropDir) return notes;
  return notes.map((n) => (n.id === dragId ? { ...n, dir: dropDir, ghost: true } : n));
}

export function NoteTree(props: Props) {
  const rows = useMemo(
    () => withPreview(props.notes, props.dragId, props.dropDir),
    [props.notes, props.dragId, props.dropDir],
  );
  const tree = useMemo(() => buildTree(rows, props.folders), [rows, props.folders]);

  /** 拖到笔记上等同于拖到它所在的目录，这样目标好命中得多 */
  const allowDrop = (e: React.DragEvent, dir: string) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    props.onDragOverDir(dir);
  };

  const handleDrop = (e: React.DragEvent, dir: string) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.stopPropagation();
    props.onDropTo(dir);
  };

  const renderNotes = (notes: Row[], depth: number) =>
    notes.map((ref) =>
      props.renamingId === ref.id ? (
        <RenameInput
          key={ref.id}
          initial={ref.title}
          depth={depth}
          onCommit={(next) => {
            props.onRenamingChange(null);
            if (next && next !== ref.title) props.onRename(ref.id, next);
          }}
          onCancel={() => props.onRenamingChange(null)}
        />
      ) : (
      <div
        key={ref.id}
        className="nx-nb-item"
        data-active={ref.id === props.activeId}
        data-ghost={ref.ghost ? 'true' : undefined}
        style={indentStyle(depth)}
        data-depth={depth}
        draggable
        onDragStart={(e) => {
          // WebKit 里不写 dataTransfer 就发不出拖拽
          e.dataTransfer.setData(DRAG_MIME, ref.id);
          e.dataTransfer.setData('text/plain', ref.title);
          e.dataTransfer.effectAllowed = 'move';
          props.onDragStart(ref.id);
        }}
        onDragEnd={props.onDragEnd}
        onDragOver={(e) => allowDrop(e, ref.dir)}
        onDrop={(e) => handleDrop(e, ref.dir)}
        onClick={() => props.onOpen(ref.id)}
        onDoubleClick={(e) => {
          e.preventDefault();
          props.onRenamingChange(ref.id);
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          props.onNoteMenu(ref.id, e.clientX, e.clientY);
        }}
        title={ref.id}
      >
        <span className="nx-nb-title">{ref.title || '未命名笔记'}</span>
      </div>
      ),
    );

  const renderFolder = (node: TreeNode, depth: number) => {
    const open = props.expanded.has(node.dir);
    const isTarget = props.dragId !== null && props.dropDir === node.dir;
    return (
      <div key={node.dir}>
        <div
          className="nx-folder"
          data-drop={isTarget}
          style={indentStyle(depth)}
          data-depth={depth}
          onClick={() => props.onToggle(node.dir)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            props.onFolderMenu(node.dir, e.clientX, e.clientY);
          }}
          onDragOver={(e) => allowDrop(e, node.dir)}
          onDrop={(e) => handleDrop(e, node.dir)}
          title={node.dir}
        >
          <span className="nx-folder-caret" data-open={open}>
            ›
          </span>
          <span className="nx-nb-title">{node.name}</span>
          <span className="nx-folder-count">{node.notes.length || ''}</span>
        </div>
        {open && (
          <>
            {node.children.map((child) => renderFolder(child, depth + 1))}
            {renderNotes(node.notes, depth + 1)}
          </>
        )}
      </div>
    );
  };

  return (
    <div
      className="nx-tree"
      data-drop={props.dragId !== null && props.dropDir === ''}
      onDragOver={(e) => allowDrop(e, '')}
      onDrop={(e) => handleDrop(e, '')}
      onDragLeave={(e) => {
        // 只有真正离开整棵树才清掉高亮，在内部元素之间移动不算
        if (!e.currentTarget.contains(e.relatedTarget as Node)) props.onDragOverDir(null);
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onFolderMenu('', e.clientX, e.clientY);
      }}
    >
      {tree.children.map((child) => renderFolder(child, 0))}
      {renderNotes(tree.notes, 0)}
    </div>
  );
}

export { joinId };

/** 侧栏里的就地重命名输入框 */
function RenameInput({
  initial,
  depth,
  onCommit,
  onCancel,
}: {
  initial: string;
  depth: number;
  onCommit(next: string): void;
  onCancel(): void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  // 提交与取消都会卸载这个组件，用标记避免 blur 时重复触发
  const done = useRef(false);

  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const finish = (commit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (commit) onCommit(value.trim());
    else onCancel();
  };

  return (
    <div className="nx-nb-item" style={indentStyle(depth)} data-depth={depth}>
      <input
        ref={ref}
        className="nx-rename-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            finish(true);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            finish(false);
          }
        }}
        onClick={(e) => e.stopPropagation()}
      />
    </div>
  );
}
