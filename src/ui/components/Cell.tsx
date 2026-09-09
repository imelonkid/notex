import { useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import { LANGS, type Cell as CellModel, type LangId } from '@core/model';
import { expandWikiLinks } from '@core/links';
import { CodeEditor } from '../editor/CodeEditor';
import { useRuntimes } from '../RuntimeContext';
import { Outputs } from './Outputs';

interface Props {
  cell: CellModel;
  index: number;
  editing: boolean;
  running: boolean;
  /** 运行中的额外说明，例如"正在解析依赖…" */
  busyNote?: string;
  showExecN: boolean;
  dropActive: boolean;
  onSource(value: string): void;
  onLang(lang: LangId): void;
  onRun(): void;
  onInterrupt(): void;
  onRemove(): void;
  onEdit(): void;
  onDoneEdit(): void;
  onInsert(type: 'md' | 'code'): void;
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

/** 语言 tab：切换只改 lang，不清空源码；tab 上叠加运行时状态点 */
function LangTabs({ current, onPick }: { current: LangId; onPick(l: LangId): void }) {
  const { registry, revision } = useRuntimes();
  void revision;

  return (
    <div className="nx-langtabs" role="tablist">
      {LANGS.map((l) => {
        const state = registry.get(l.id);
        const title =
          state.status === 'ready' || state.status === 'busy'
            ? `${state.provider?.label ?? l.label} ${state.info?.version ?? ''}\n${state.info?.path ?? ''}`
            : state.status === 'available'
              ? `已检测到 ${state.info?.version ?? ''}，运行时启动\n${state.info?.path ?? ''}`
              : state.status === 'missing'
                ? '未检测到运行环境，点运行会给出安装指引'
                : state.status === 'error'
                  ? `启动失败：${state.error ?? ''}`
                  : '尚未检测';
        return (
          <button
            key={l.id}
            role="tab"
            aria-selected={l.id === current}
            className="nx-langtab"
            data-active={l.id === current}
            title={title}
            onClick={() => onPick(l.id)}
          >
            <span className="nx-dot" data-status={state.status} />
            {l.short}
          </button>
        );
      })}
    </div>
  );
}

export function Cell(props: Props) {
  const { cell, editing, running, busyNote, showExecN, dropActive } = props;
  const { registry } = useRuntimes();
  const [mdDraft, setMdDraft] = useState(cell.source);
  const mdRef = useRef<HTMLTextAreaElement>(null);

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

  const isCode = cell.type === 'code';
  const badge = running ? '[*]' : cell.type === 'code' && cell.execN ? `[${cell.execN}]` : '[ ]';

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
      <div className="nx-cell">
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
          {isCode && showExecN && <span className="nx-execn">{badge}</span>}
        </div>

        <div style={{ minWidth: 0 }}>
          <div className="nx-cell-bar" data-floating={!isCode && !editing}>
            {isCode ? (
              <>
                <LangTabs current={cell.lang} onPick={props.onLang} />
                {running ? (
                  <button className="nx-btn-run" onClick={props.onInterrupt}>
                    中断
                  </button>
                ) : (
                  <button className="nx-btn-run" onClick={props.onRun}>
                    运行
                  </button>
                )}
              </>
            ) : (
              editing && (
                <button
                  className="nx-btn-primary"
                  style={{ fontSize: '11.5px', padding: '3px 14px' }}
                  // onMouseDown 抢在 textarea 的 blur 之前，避免按钮被重排后点空
                  onMouseDown={(e) => {
                    e.preventDefault();
                    commitAndPreview();
                  }}
                >
                  预览
                </button>
              )
            )}
            <span style={{ flex: 1 }} />
            <div className="nx-cell-actions">
              <button className="nx-btn-mini" title="在下方插入文本" onClick={() => props.onInsert('md')}>
                ＋文本
              </button>
              <button className="nx-btn-mini" title="在下方插入代码" onClick={() => props.onInsert('code')}>
                ＋代码
              </button>
              <button className="nx-btn-mini" data-danger="true" title="删除此 cell" onClick={props.onRemove}>
                ×
              </button>
            </div>
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
              ref={mdRef}
              onBlur={() => {
                // 切换到别的应用也会触发 blur，但那时 activeElement 仍是本编辑框。
                // 只有焦点真的落到页面里别的元素上，才回到预览。
                setTimeout(() => {
                  if (document.activeElement === mdRef.current) return;
                  commitAndPreview();
                }, 0);
              }}
            />
          ) : (
            <div
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
