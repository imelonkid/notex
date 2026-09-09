import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import {
  LANGS,
  type Cell as CellModel,
  type LangId,
  cellBadge,
  cellStatus,
} from '@core/model';
import { expandWikiLinks } from '@core/links';
import { CodeEditor } from '../editor/CodeEditor';
import { useRuntimes } from '../RuntimeContext';
import { Outputs } from './Outputs';
import { WikiComplete } from './WikiComplete';
import type { NotebookRef } from '@core/store/index';

interface Props {
  cell: CellModel;
  index: number;
  editing: boolean;
  running: boolean;
  /** 运行中的额外说明，例如"正在解析依赖…" */
  busyNote?: string;
  /** 判断一个站内链接是否解析不到目标 */
  isBrokenLink?(target: string): boolean;
  /** 供 [[ 补全用的笔记清单 */
  allNotes?: NotebookRef[];
  currentNoteId?: string | null;
  dropActive: boolean;
  /** 当前 cell，工具栏和快捷键作用于它 */
  active: boolean;
  onActivate(): void;
  onMenu(x: number, y: number): void;
  onSource(value: string): void;
  onLang(lang: LangId): void;
  onRun(): void;
  onInterrupt(): void;
  onRemove(): void;
  onEdit(): void;
  onDoneEdit(): void;
  onDragStart(): void;
  onDragEnd(): void;
  onDragOver(): void;
  onDrop(): void;
  onRetryDetect(): void;
  onOpenSettings(): void;
}

function renderMarkdown(src: string): string {
  if (!src.trim()) return '<p class="nx-md-empty">（空文本 — 双击编辑）</p>';
  try {
    // [[笔记名]] 先展开成普通链接，两种写法后续走同一条拦截逻辑
    return marked.parse(expandWikiLinks(src), { breaks: true, gfm: true, async: false }) as string;
  } catch {
    return `<p>${src.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[c] ?? c)}</p>`;
  }
}

/**
 * 语言 chip：平时只显示当前语言，点开才列出三种语言与各自的运行时状态。
 * 此前每个 cell 常驻三个标签，信息与操作混在一起，占地方也不必要。
 */
function LangChip({ current, onPick }: { current: LangId; onPick(l: LangId): void }) {
  const { registry, revision } = useRuntimes();
  const [open, setOpen] = useState(false);
  void revision;

  const state = registry.get(current);
  const label = LANGS.find((l) => l.id === current)?.short ?? current;

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    // 捕获阶段，点任何地方都收起
    document.addEventListener('mousedown', close, true);
    return () => document.removeEventListener('mousedown', close, true);
  }, [open]);

  return (
    <div className="nx-langchip-wrap">
      <button
        className="nx-langchip"
        data-open={open}
        title={`${state.provider?.label ?? ''} ${state.info?.version ?? ''}`.trim() || '尚未检测'}
        onMouseDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
      >
        <span className="nx-dot" data-status={state.status} />
        {label}
        <span className="nx-langchip-caret">▾</span>
      </button>
      {open && (
        <div className="nx-langmenu">
          {LANGS.map((l) => {
            const st = registry.get(l.id);
            return (
              <button
                key={l.id}
                className="nx-langmenu-item"
                data-active={l.id === current}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onPick(l.id);
                  setOpen(false);
                }}
              >
                <span className="nx-dot" data-status={st.status} />
                <span className="nx-langmenu-name">{l.label}</span>
                <span className="nx-langmenu-ver">{st.info?.version ?? ''}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export function Cell(props: Props) {
  const { cell, editing, running, busyNote, dropActive } = props;
  const { registry } = useRuntimes();
  const [mdDraft, setMdDraft] = useState(cell.source);
  const [mdEl, setMdEl] = useState<HTMLTextAreaElement | null>(null);
  const mdRef = useRef<HTMLTextAreaElement | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  // 编辑态只显示编辑框，预览态才渲染，因此始终用已提交的 source
  const html = useMemo(
    () => renderMarkdown(cell.type === 'md' ? cell.source : ''),
    [cell.type, cell.source],
  );

  const enterEdit = () => {
    setMdDraft(cell.source);
    props.onEdit();
  };

  const commitAndPreview = () => {
    props.onSource(mdDraft);
    props.onDoneEdit();
  };

  // 渲染完再标断链：直接在 DOM 上打标记，比对 HTML 字符串做替换稳妥
  useEffect(() => {
    const root = previewRef.current;
    if (!root || !props.isBrokenLink) return;
    for (const a of root.querySelectorAll('a')) {
      const href = a.getAttribute('href') ?? '';
      // 只判断站内链接，外部链接与锚点不涉及断链
      if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('#') || href.startsWith('//')) {
        continue;
      }
      const target = decodeURIComponent(href.split('#')[0]);
      if (props.isBrokenLink(target)) a.dataset.broken = 'true';
      else delete a.dataset.broken;
    }
  }, [html, props.isBrokenLink]);

  const isCode = cell.type === 'code';
  const status = cellStatus(cell, running);
  const badge = cellBadge(cell, running);

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        props.onDragOver();
      }}
      onDrop={(e) => {
        e.preventDefault();
        props.onDrop();
      }}
      style={{ position: 'relative' }}
    >
      <div className="nx-dropline" data-active={dropActive} />
      <div
        className="nx-cell"
        data-active={props.active}
        data-status={status}
        onMouseDown={props.onActivate}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          props.onActivate();
          props.onMenu(e.clientX, e.clientY);
        }}
      >
        <div className="nx-gutter">
          <span
            className="nx-grip"
            draggable
            title="拖动排序"
            onDragStart={props.onDragStart}
            onDragEnd={props.onDragEnd}
          >
            ⠿
          </span>
          {isCode ? (
            <button
              className="nx-execn"
              data-status={status}
              title={running ? '中断执行' : '运行这个 cell（⌘↩）'}
              onClick={(e) => {
                e.stopPropagation();
                running ? props.onInterrupt() : props.onRun();
              }}
            >
              <span className="nx-execn-badge">{badge}</span>
              <span className="nx-execn-run">{running ? '■' : '▶'}</span>
            </button>
          ) : null}
        </div>

        <div style={{ minWidth: 0 }}>
          <div className="nx-cell-bar" data-floating={!isCode && !editing}>
            {isCode ? (
              <LangChip current={cell.lang} onPick={props.onLang} />
            ) : (
              editing && (
                <button
                  className="nx-btn-primary"
                  style={{ fontSize: '11.5px', padding: '3px 14px' }}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commitAndPreview();
                  }}
                >
                  预览
                </button>
              )
            )}
          </div>

          {isCode ? (
            <>
              <CodeEditor
                value={cell.source}
                lang={cell.lang}
                onChange={props.onSource}
                onRun={props.onRun}
                onFocus={() => registry.prewarm(cell.lang)}
                getSession={() => registry.get(cell.lang).session ?? null}
              />
              {running && (
                <div className="nx-outputs" style={{ color: 'var(--nx-fg-muted)' }}>
                  {busyNote ?? (registry.get(cell.lang).status === 'starting' ? '正在启动内核…' : '运行中…')}
                </div>
              )}
              {!running && (
                <Outputs
                  outputs={cell.outputs}
                  lang={cell.lang}
                  ranWith={cell.ranWith}
                  onRetryDetect={props.onRetryDetect}
                  onOpenSettings={props.onOpenSettings}
                />
              )}
            </>
          ) : editing ? (
            <>
            <textarea
              className="nx-md-editor"
              autoFocus
              value={mdDraft}
              rows={Math.max(3, mdDraft.split('\n').length + 1)}
              spellCheck={false}
              placeholder="用 Markdown 书写…  Shift+Enter 预览，点开别处也会自动预览"
              onChange={(e) => {
                setMdDraft(e.target.value);
                props.onSource(e.target.value);
              }}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' && e.shiftKey) || e.key === 'Escape') {
                  e.preventDefault();
                  commitAndPreview();
                }
              }}
              ref={(el) => {
                mdRef.current = el;
                setMdEl(el);
              }}
              onBlur={() => {
                // 切换到别的应用也会触发 blur，但那时 activeElement 仍是本编辑框。
                // 只有焦点真的落到页面里别的元素上，才回到预览。
                setTimeout(() => {
                  if (document.activeElement === mdRef.current) return;
                  commitAndPreview();
                }, 0);
              }}
            />
            {props.allNotes && (
              <WikiComplete
                textarea={mdEl}
                value={mdDraft}
                notes={props.allNotes}
                currentNoteId={props.currentNoteId ?? null}
                onInsert={(next, caret) => {
                  setMdDraft(next);
                  props.onSource(next);
                  requestAnimationFrame(() => {
                    mdRef.current?.focus();
                    mdRef.current?.setSelectionRange(caret, caret);
                  });
                }}
              />
            )}
            </>
          ) : (
            <div
              ref={previewRef}
              className="nx-md"
              onDoubleClick={enterEdit}
              dangerouslySetInnerHTML={{ __html: html }}
              style={{ padding: '2px 0', cursor: 'text' }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
