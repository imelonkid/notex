import { useMemo } from 'react';
import type { NotebookRef } from '@core/store/index';
import { baseOf, compareNames, dirOf, joinId } from '@core/store/paths';

interface Props {
  notes: NotebookRef[];
  folders: string[];
  activeId: string | null;
  expanded: Set<string>;
  dragId: string | null;
  dropDir: string | null;
  onToggle(dir: string): void;
  onOpen(id: string): void;
  onNoteMenu(id: string, x: number, y: number): void;
  onFolderMenu(dir: string, x: number, y: number): void;
  onDragStart(id: string): void;
  onDragEnd(): void;
  onDragOverDir(dir: string | null): void;
  onDropTo(dir: string): void;
}

interface TreeNode {
  dir: string;
  name: string;
  children: TreeNode[];
  notes: NotebookRef[];
}

/** 把平铺的笔记与目录列表组装成树；存储层只负责列举，树在这里拼 */
function buildTree(notes: NotebookRef[], folders: string[]): TreeNode {
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

export function NoteTree(props: Props) {
  const tree = useMemo(
    () => buildTree(props.notes, props.folders),
    [props.notes, props.folders],
  );

  const renderNotes = (notes: NotebookRef[], depth: number) =>
    notes.map((ref) => (
      <div
        key={ref.id}
        className="nx-nb-item"
        data-active={ref.id === props.activeId}
        style={{ paddingLeft: 10 + depth * 12 }}
        draggable
        onDragStart={(e) => {
          // 不写 dataTransfer 的话真实鼠标拖拽在 WebKit 里根本起不来
          e.dataTransfer.setData('text/plain', ref.id);
          e.dataTransfer.effectAllowed = 'move';
          props.onDragStart(ref.id);
        }}
        onDragEnd={props.onDragEnd}
        onClick={() => props.onOpen(ref.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          props.onNoteMenu(ref.id, e.clientX, e.clientY);
        }}
        title={ref.id}
      >
        <span className="nx-nb-title">{ref.title || '未命名笔记'}</span>
      </div>
    ));

  const renderFolder = (node: TreeNode, depth: number) => {
    const open = props.expanded.has(node.dir);
    const isDropTarget = props.dragId !== null && props.dropDir === node.dir;
    return (
      <div key={node.dir}>
        <div
          className="nx-folder"
          data-drop={isDropTarget}
          style={{ paddingLeft: 10 + depth * 12 }}
          onClick={() => props.onToggle(node.dir)}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            props.onFolderMenu(node.dir, e.clientX, e.clientY);
          }}
          onDragOver={(e) => {
            if (!props.dragId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            props.onDragOverDir(node.dir);
          }}
          onDragLeave={() => props.onDragOverDir(null)}
          onDrop={(e) => {
            e.preventDefault();
            props.onDropTo(node.dir);
          }}
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

  const rootIsDropTarget = props.dragId !== null && props.dropDir === '';

  return (
    <div
      className="nx-tree"
      data-drop={rootIsDropTarget}
      onDragOver={(e) => {
        if (!props.dragId) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        props.onDragOverDir('');
      }}
      onDrop={(e) => {
        e.preventDefault();
        props.onDropTo('');
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
