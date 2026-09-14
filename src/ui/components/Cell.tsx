import { useEffect, useMemo, useRef, useState } from 'react';
import { marked } from 'marked';
import {
  LANGS,
  type Cell as CellModel,
  type LangId,
  type RunRecord,
  cellBadge,
  cellStatus,
  formatDuration,
} from '@core/model';
import { expandWikiLinks, safeDecode } from '@core/links';
import { sanitizeMarkdown } from '../sanitize';
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
  /** 本次会话里这个 cell 的执行结果，未运行则没有 */
  mark?: RunRecord;
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
  onMenu(x: number, y: number, align?: 'left' | 'right'): void;
  onSource(value: string): void;
  onLang(lang: LangId): void;
  onRun(): void;
  onInterrupt(): void;
  onRemove(): void;
  /** 刚复制过，按钮上打勾 */
  copied: boolean;
  onCopy(): void;
  onEdit(): void;
  onDoneEdit(): void;
  onDragStart(): void;
  onDragEnd(): void;
  onDragOver(): void;
  onDrop(): void;
  onRetryDetect(): void;
  onOpenSettings(): void;
  /**
   * 富文本粘贴：交给应用把 HTML 转成 Markdown、把图片落地。
   * 返回要插入的文本；返回 null 表示按纯文本走
   */
  onRichPaste?(payload: { html?: string; text?: string; files: File[] }): Promise<string | null>;
  /** 正文里相对路径的图片换成能加载的地址 */
  resolveImage?(src: string): string;
}

/** 悬停提示：把括号里那个符号说清楚，用户不必猜 */
const RUN_TITLE: Record<string, string> = {
  idle: '本次会话还没运行过 — 点击运行（⇧↩）',
  ok: '本次会话已运行成功 — 点击重新运行（⇧↩）',
  error: '本次会话运行出错 — 点击重新运行（⇧↩）',
  aborted: '本次会话运行被中断 — 点击重新运行（⇧↩）',
};

interface MdSnap {
  value: string;
  caret: number;
}
/** 连续输入停顿超过这个时间就算新的一组撤销 */
const MD_UNDO_GROUP_MS = 600;
const MD_UNDO_MAX = 200;

function renderMarkdown(src: string, resolveImage?: (src: string) => string): string {
  if (!src.trim()) return '<p class="nx-md-empty">（空文本 — 双击编辑）</p>';
  try {
    // [[笔记名]] 先展开成普通链接，两种写法后续走同一条拦截逻辑；
    // 渲染结果必须净化后才能进 DOM，正文内容不一定是自己写的
    const html = marked.parse(expandWikiLinks(src), { breaks: true, gfm: true, async: false }) as string;
    const safe = sanitizeMarkdown(html);
    if (!resolveImage) return safe;
    // 相对路径的图片（.assets/x.png）换成宿主能加载的地址。放在净化之后：
    // asset:// 这类协议不在净化白名单里，先换会被剥掉
    const tpl = document.createElement('template');
    tpl.innerHTML = safe;
    tpl.content.querySelectorAll('img[src]').forEach((img) => {
      const resolved = resolveImage(img.getAttribute('src') ?? '');
      if (resolved) img.setAttribute('src', resolved);
    });
    return tpl.innerHTML;
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

/** 结果条：运行完成后贴在输出上方，回答"这次怎么样、跑了多久" */
function RunSummary({ status, ms }: { status: string; ms?: number }) {
  const label =
    status === 'ok' ? '运行成功' : status === 'error' ? '运行出错' : status === 'aborted' ? '已中断' : '';
  if (!label) return null;
  return (
    <div className="nx-run-summary" data-status={status}>
      <span className="nx-run-summary-dot" />
      <span>{label}</span>
      {ms !== undefined && <span className="nx-run-summary-ms">· {formatDuration(ms)}</span>}
    </div>
  );
}

/** 复制按钮。停在 cell 右上角，鼠标移到 cell 上或 cell 是当前项时才现身 */
function CopyButton({ copied, onCopy }: { copied: boolean; onCopy(): void }) {
  return (
    <button
      className="nx-cell-copy"
      data-copied={copied || undefined}
      title={copied ? '已复制' : '复制原文（⇧⌘C）'}
      aria-label="复制这个 cell 的原文"
      onClick={(e) => {
        e.stopPropagation();
        onCopy();
      }}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <path
            d="M3.5 8.5l3 3 6-6.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
          <rect x="5.6" y="2.4" width="8" height="9" rx="1.6" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <path
            d="M10.4 13.6H4a1.6 1.6 0 0 1-1.6-1.6V5.2"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.3"
            strokeLinecap="round"
          />
        </svg>
      )}
    </button>
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
    () => renderMarkdown(cell.type === 'md' ? cell.source : '', props.resolveImage),
    [cell.type, cell.source, props.resolveImage],
  );

  /** 富文本或图片粘贴：转成 Markdown 插到光标处；纯文本仍由浏览器处理 */
  const onMdPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!props.onRichPaste) return;
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
    if (!html && !files.length) return;
    e.preventDefault();
    const el = e.currentTarget;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    const before = mdDraft.slice(0, start);
    const after = mdDraft.slice(end);
    void props.onRichPaste({ html, text, files }).then((md) => {
      const insert = md ?? text;
      if (!insert) return;
      // 插入的块和前后文之间留空行，粘进段落中间也不会黏成一句
      const lead = md && before && !before.endsWith('\n\n') ? (before.endsWith('\n') ? '\n' : '\n\n') : '';
      const tail = md && after && !after.startsWith('\n\n') ? (after.startsWith('\n') ? '\n' : '\n\n') : '';
      const chunk = `${lead}${insert}${tail}`;
      // 粘贴单独占一组：之前的输入先封口，粘完再封口，⌘Z 正好退掉整次粘贴
      pushMdHistory(mdDraft, start, true);
      el.focus();
      el.setSelectionRange(start, end);
      // 走浏览器自己的插入，光标和滚动位置都由它管；插入会触发 onChange
      const native = document.execCommand('insertText', false, chunk);
      if (!native) {
        const next = `${before}${chunk}${after}`;
        setMdDraft(next);
        props.onSource(next);
        requestAnimationFrame(() => el.setSelectionRange(start + chunk.length, start + chunk.length));
      }
      mdHistory.current.lastAt = 0;
    });
  };

  /**
   * 文本编辑框自己的撤销栈。
   * 不用浏览器原生的：WebKit 会把一次编辑里连续的输入和粘贴合成一组，
   * ⌘Z 一下整段全没；Chromium 分组又不一样。自己记，行为在两边一致：
   * 停顿超过 600ms 算新的一组，粘贴单独一组。
   */
  const mdHistory = useRef<{ past: MdSnap[]; future: MdSnap[]; lastAt: number }>({ past: [], future: [], lastAt: 0 });

  const pushMdHistory = (value: string, caret: number, force = false) => {
    const h = mdHistory.current;
    const now = Date.now();
    const top = h.past[h.past.length - 1];
    if (top?.value === value) {
      h.lastAt = now;
      return;
    }
    if (!force && h.past.length && now - h.lastAt < MD_UNDO_GROUP_MS) {
      h.lastAt = now;
      return;
    }
    h.past.push({ value, caret });
    if (h.past.length > MD_UNDO_MAX) h.past.shift();
    h.future = [];
    h.lastAt = now;
  };

  const applyMdSnapshot = (snap: MdSnap, el: HTMLTextAreaElement) => {
    setMdDraft(snap.value);
    props.onSource(snap.value);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(snap.caret, snap.caret);
    });
  };

  const undoMd = (el: HTMLTextAreaElement) => {
    const h = mdHistory.current;
    const snap = h.past.pop();
    if (!snap) return;
    h.future.push({ value: mdDraft, caret: el.selectionStart });
    h.lastAt = 0;
    applyMdSnapshot(snap, el);
  };

  const redoMd = (el: HTMLTextAreaElement) => {
    const h = mdHistory.current;
    const snap = h.future.pop();
    if (!snap) return;
    h.past.push({ value: mdDraft, caret: el.selectionStart });
    h.lastAt = 0;
    applyMdSnapshot(snap, el);
  };

  const enterEdit = () => {
    setMdDraft(cell.source);
    mdHistory.current = { past: [], future: [], lastAt: 0 };
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
      const target = safeDecode(href.split('#')[0]);
      if (props.isBrokenLink(target)) a.dataset.broken = 'true';
      else delete a.dataset.broken;
    }
  }, [html, props.isBrokenLink]);

  const isCode = cell.type === 'code';
  const status = cellStatus(cell, running, props.mark);
  const badge = cellBadge(status);

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
        <div className="nx-cell-tools">
          <CopyButton copied={props.copied} onCopy={props.onCopy} />
          <button
            className="nx-cell-copy"
            title="更多操作（也可以右键）"
            aria-label="更多操作"
            onClick={(e) => {
              e.stopPropagation();
              props.onActivate();
              // 菜单贴着按钮左下角弹，不用鼠标位置，键盘触发时也对得上
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              props.onMenu(r.right, r.bottom + 4, 'right');
            }}
          >
            <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
              <circle cx="3.2" cy="8" r="1.25" fill="currentColor" />
              <circle cx="8" cy="8" r="1.25" fill="currentColor" />
              <circle cx="12.8" cy="8" r="1.25" fill="currentColor" />
            </svg>
          </button>
        </div>

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
              className="nx-runmark"
              data-status={status}
              title={running ? '中断执行' : RUN_TITLE[status]}
              onClick={(e) => {
                e.stopPropagation();
                running ? props.onInterrupt() : props.onRun();
              }}
            >
              <span className="nx-runmark-badge">{badge}</span>
              <span className="nx-runmark-run">{running ? '■' : '▶'}</span>
            </button>
          ) : null}
        </div>

        <div style={{ minWidth: 0 }}>
          {isCode && (
            <div className="nx-cell-bar">
              <LangChip current={cell.lang} onPick={props.onLang} />
            </div>
          )}

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
              {/* 没有输出时更该显示：否则跑完一个纯赋值的 cell，界面上什么都不动 */}
              {!running && props.mark && (
                <RunSummary status={props.mark.status} ms={props.mark.ms} />
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
              placeholder="用 Markdown 书写…  Esc 或点开别处回到预览"
              onPaste={onMdPaste}
              onChange={(e) => {
                pushMdHistory(mdDraft, Math.min(mdDraft.length, e.target.selectionStart));
                setMdDraft(e.target.value);
                props.onSource(e.target.value);
              }}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' && e.shiftKey) || e.key === 'Escape') {
                  e.preventDefault();
                  commitAndPreview();
                } else if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 'z') {
                  // 编辑框内的撤销走自己的栈，不交给浏览器
                  e.preventDefault();
                  if (e.shiftKey) redoMd(e.currentTarget);
                  else undoMd(e.currentTarget);
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
