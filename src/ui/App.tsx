import { useCallback, useEffect, useRef, useState } from 'react';
import { LANGS, isCode, type LangId, type Output } from '@core/model';
import { exportIpynb, exportMarkdown, importNotebook } from '@core/files';
import { parseDeps } from '@core/deps';
import { resolveNoteLink } from '@core/links';
import type { StoreSetup } from '@core/store/index';
import { Cell } from './components/Cell';
import { SettingsModal } from './components/SettingsModal';
import { useRuntimes } from './RuntimeContext';
import { scrollToHeadingText, useLinkInterceptor } from './useLinkInterceptor';
import { newCodeCell, newMarkdownCell, ops, useNotebook } from './useNotebook';

export function App({ setup, onVaultChanged }: { setup: StoreSetup; onVaultChanged(): void }) {
  const { registry, revision, host } = useRuntimes();
  const book = useNotebook(setup.store);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<Record<string, boolean>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [depsStatus, setDepsStatus] = useState<Record<string, string>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('nx.sidebar.collapsed') === '1',
  );

  const nbRef = useRef(book.nb);
  nbRef.current = book.nb;

  /** 正文与输出里的链接一律由应用接管，webview 绝不自己导航 */
  const [linkNotice, setLinkNotice] = useState<string | null>(null);
  /** 跳转到目标笔记后要滚到的小节，等目标渲染完再用 */
  const pendingHash = useRef<string | null>(null);
  const refsRef = useRef(book.refs);
  refsRef.current = book.refs;
  const activeIdRef = useRef(book.activeId);
  activeIdRef.current = book.activeId;

  const openInternalLink = useCallback(
    (target: string, hash?: string) => {
      // 只写了 #小节 的情况已在拦截器里当锚点处理，这里一定有 target
      const id = resolveNoteLink(target, refsRef.current);
      if (!id) {
        setLinkNotice(`找不到这篇笔记：${target}`);
        return;
      }
      if (id === activeIdRef.current) {
        if (hash) scrollToHeadingText(hash);
        return;
      }
      pendingHash.current = hash ?? null;
      setEditingId(null);
      void book.open(id);
    },
    [book],
  );

  useLinkInterceptor({
    host,
    onInternal: openInternalLink,
    onBlocked: useCallback((href: string, reason: string) => {
      setLinkNotice(`已拦截链接（${reason}）：${href}`);
    }, []),
  });

  // 目标笔记渲染完成后再滚动到小节
  useEffect(() => {
    if (!book.nb || !pendingHash.current) return;
    const hash = pendingHash.current;
    pendingHash.current = null;
    const t = setTimeout(() => scrollToHeadingText(hash), 80);
    return () => clearTimeout(t);
  }, [book.nb]);

  useEffect(() => {
    if (!linkNotice) return;
    const t = setTimeout(() => setLinkNotice(null), 4000);
    return () => clearTimeout(t);
  }, [linkNotice]);

  useEffect(() => {
    localStorage.setItem('nx.sidebar.collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  // Cmd/Ctrl+B 切换侧栏，Cmd/Ctrl+S 立即保存
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === 'b') {
        e.preventDefault();
        setSidebarCollapsed((c) => !c);
      } else if (key === 's') {
        e.preventDefault();
        void book.flush();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [book]);

  /** 运行一个 cell：确保内核就绪 → 解析依赖 → 流式收集输出 → 落库 */
  const runCell = useCallback(
    async (cellId: string): Promise<'ok' | 'error' | 'aborted' | 'skipped'> => {
      const current = nbRef.current?.cells.find((c) => c.id === cellId);
      if (!current || !isCode(current)) return 'skipped';
      const lang = current.lang;
      const code = current.source;
      if (runningIds[cellId]) return 'skipped';

      const stopRunning = () =>
        setRunningIds((r) => {
          const next = { ...r };
          delete next[cellId];
          return next;
        });

      setRunningIds((r) => ({ ...r, [cellId]: true }));
      book.update(ops.setOutputs(cellId, [], lang, false));

      const session = await registry.ensure(lang);
      if (!session) {
        stopRunning();
        book.update(ops.setOutputs(cellId, [{ type: 'missing-runtime', lang }], lang, false));
        return 'error';
      }

      const outputs: Output[] = [];
      // 同名流合并成一条，避免每行一个 div
      const push = (out: Output) => {
        const last = outputs[outputs.length - 1];
        if (out.type === 'stream' && last?.type === 'stream' && last.name === out.name) {
          last.text += out.text;
        } else {
          outputs.push(out);
        }
      };

      // Java 的 //DEPS：先解析依赖并注入类路径，再执行
      const { coords, invalid } = parseDeps(code);
      for (const bad of invalid) {
        push({ type: 'notice', level: 'warn', text: `无法识别的依赖坐标：${bad}` });
      }
      if (lang === 'java' && coords.length) {
        setDepsStatus((d) => ({ ...d, [cellId]: `正在解析 ${coords.length} 个依赖…` }));
        try {
          const resolved = await host.resolveDeps(coords);
          await session.addClasspath(resolved.classpath);
          push({
            type: 'notice',
            level: 'info',
            text: `已加入 ${resolved.classpath.length} 个 jar（${resolved.resolver === 'maven' ? 'Maven 传递解析' : '直接下载'}）`,
          });
          for (const w of resolved.warnings) push({ type: 'notice', level: 'warn', text: w });
        } catch (e) {
          push({
            type: 'error',
            ename: 'DependencyError',
            evalue: String((e as Error)?.message ?? e),
            traceback: [],
          });
          stopRunning();
          book.update(ops.setOutputs(cellId, outputs, lang, true));
          return 'error';
        } finally {
          setDepsStatus((d) => {
            const next = { ...d };
            delete next[cellId];
            return next;
          });
        }
      }

      registry.setBusy(lang, true);
      let status: 'ok' | 'error' | 'aborted' = 'ok';
      try {
        status = await session.execute(code, {
          onStream: (name, text) => push({ type: 'stream', name, text }),
          onResult: (data) => push({ type: 'result', data }),
          onDisplay: (data) => push({ type: 'display', data }),
          onError: (ename, evalue, traceback) => push({ type: 'error', ename, evalue, traceback }),
        });
      } catch (e) {
        push({ type: 'error', ename: 'KernelError', evalue: String(e), traceback: [] });
        status = 'error';
      } finally {
        registry.setBusy(lang, false);
        stopRunning();
        book.update(ops.setOutputs(cellId, outputs, lang, true));
      }
      return status;
    },
    [registry, runningIds, host, book],
  );

  // 出错或被中断就停下，避免后续 cell 在错误状态上继续跑
  const runAll = useCallback(async () => {
    for (const cell of nbRef.current?.cells ?? []) {
      if (!isCode(cell)) continue;
      const status = await runCell(cell.id);
      if (status === 'error' || status === 'aborted') break;
    }
  }, [runCell]);

  const doImport = useCallback(async () => {
    const imported = await importNotebook();
    if (!imported) return;
    await book.adopt(imported);
    setEditingId(null);
  }, [book]);

  const insertAfter = (index: number | null, type: 'md' | 'code') => {
    const cells = nbRef.current?.cells ?? [];
    // 新代码 cell 沿用上一个代码 cell 的语言
    const prevCode = [...cells.slice(0, index ?? cells.length)].reverse().find(isCode);
    const lang: LangId = prevCode?.lang ?? 'python';
    const cell = type === 'md' ? newMarkdownCell() : newCodeCell(lang);
    book.update(ops.insert(index, cell));
    if (type === 'md') setEditingId(cell.id);
  };

  const nb = book.nb;
  const anyRunning = Object.keys(runningIds).length > 0;
  void revision;

  const storeLabel =
    setup.store.kind === 'vault'
      ? book.saving
        ? '保存中…'
        : setup.vaultPath
      : '浏览器本地存储';

  return (
    <div className="nx-app" data-collapsed={sidebarCollapsed}>
      {sidebarCollapsed && (
        <button
          className="nx-sidebar-toggle"
          data-floating="true"
          title="展开侧栏（⌘B）"
          aria-label="展开侧栏"
          onClick={() => setSidebarCollapsed(false)}
        >
          ›
        </button>
      )}

      <aside className="nx-sidebar" data-collapsed={sidebarCollapsed}>
        <div className="nx-brand">
          <div className="nx-brand-name">NoteX</div>
          <div className="nx-brand-sub">可执行笔记</div>
          <span style={{ flex: 1 }} />
          <button
            className="nx-sidebar-toggle"
            title="折叠侧栏（⌘B）"
            aria-label="折叠侧栏"
            onClick={() => setSidebarCollapsed(true)}
          >
            ‹
          </button>
        </div>

        <div className="nx-section-label">我的笔记</div>
        <div className="nx-nb-list">
          {book.refs.map((ref) => (
            <div
              key={ref.id}
              className="nx-nb-item"
              data-active={ref.id === book.activeId}
              onClick={() => {
                void book.open(ref.id);
                setEditingId(null);
              }}
            >
              <span className="nx-nb-title">{ref.title || '未命名笔记'}</span>
              <button
                className="nx-nb-remove"
                title="删除笔记"
                onClick={(e) => {
                  e.stopPropagation();
                  void book.removeNotebook(ref.id);
                }}
              >
                ×
              </button>
            </div>
          ))}
        </div>

        <button
          className="nx-btn-outline"
          style={{ marginTop: 12 }}
          onClick={() => void book.createNotebook('未命名笔记')}
        >
          ＋ 新建笔记本
        </button>

        <div style={{ flex: 1 }} />

        <div className="nx-runtime-panel">
          <button
            className="nx-vault-row"
            title={setup.store.kind === 'vault' ? `笔记库：${setup.vaultPath}` : '当前存在浏览器里'}
            onClick={() => setSettingsOpen(true)}
          >
            <span className="nx-dot" data-status={setup.store.kind === 'vault' ? 'ready' : 'missing'} />
            <span className="nx-vault-path">{storeLabel}</span>
          </button>

          {LANGS.map((l) => {
            const state = registry.get(l.id);
            const label =
              state.status === 'ready' || state.status === 'busy'
                ? `就绪 ${state.info?.version ?? ''}`
                : state.status === 'starting'
                  ? '启动中…'
                  : state.status === 'detecting'
                    ? '检测中…'
                    : state.status === 'available'
                      ? `已安装 ${state.info?.version ?? ''}`
                      : state.status === 'missing'
                        ? '未安装'
                        : state.status === 'error'
                          ? '启动失败'
                          : '未检测';
            return (
              <button key={l.id} className="nx-runtime-row" onClick={() => setSettingsOpen(true)}>
                <span className="nx-dot" data-status={state.status} />
                <span style={{ flex: 1 }}>{l.label}</span>
                <span style={{ color: 'var(--nx-fg-faint)' }}>{label}</span>
              </button>
            );
          })}
          <button
            className="nx-btn-mini"
            style={{ alignSelf: 'flex-start', marginTop: 2, marginLeft: -8 }}
            onClick={() => setSettingsOpen(true)}
          >
            设置…
          </button>
        </div>
      </aside>

      <main className="nx-main">
        <div className="nx-page">
          {linkNotice && <div className="nx-banner">{linkNotice}</div>}
          {book.error && <div className="nx-banner nx-banner-error">{book.error}</div>}
          {book.conflict && (
            <div className="nx-banner nx-banner-warn">
              <span>这篇笔记的文件在应用之外被修改了，而你这里也有未保存的改动。</span>
              <span style={{ flex: 1 }} />
              <button className="nx-btn-mini" onClick={() => void book.reloadFromDisk()}>
                用磁盘上的版本
              </button>
              <button className="nx-btn-mini" onClick={book.keepMine}>
                用我的版本覆盖
              </button>
            </div>
          )}
          {setup.migrated > 0 && (
            <div className="nx-banner">
              已把 {setup.migrated} 篇原先存在浏览器里的笔记迁移到 {setup.vaultPath}
            </div>
          )}

          {!nb ? (
            <div style={{ color: 'var(--nx-fg-faint)', fontSize: 13, padding: '20px 0' }}>
              正在打开笔记…
            </div>
          ) : (
            <>
              <input
                className="nx-title-input"
                value={nb.title}
                title="笔记标题"
                onChange={(e) => book.update((d) => void (d.title = e.target.value))}
                onBlur={(e) => void book.retitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
              />

              <div className="nx-toolbar">
                <button className="nx-btn-primary" onClick={() => void runAll()} disabled={anyRunning}>
                  全部运行
                </button>
                <button className="nx-btn-ghost" onClick={() => book.update(ops.clearOutputs())}>
                  清空输出
                </button>
                <button className="nx-btn-ghost" onClick={() => exportMarkdown(nb)}>
                  导出 Markdown
                </button>
                <button className="nx-btn-ghost" onClick={() => exportIpynb(nb)}>
                  导出 ipynb
                </button>
                <button className="nx-btn-ghost" onClick={() => void doImport()}>
                  导入…
                </button>
                <span style={{ flex: 1 }} />
                <span className="nx-hint">Shift+Enter 运行/预览 · 双击文本编辑 · 拖 ⠿ 排序</span>
              </div>

              {nb.cells.map((cell, i) => (
                <Cell
                  key={cell.id}
                  cell={cell}
                  index={i}
                  editing={editingId === cell.id}
                  running={!!runningIds[cell.id]}
                  busyNote={depsStatus[cell.id]}
                  showExecN
                  dropActive={!!dragId && dropId === cell.id}
                  onSource={(v) => book.update(ops.setSource(cell.id, v))}
                  onLang={(l) => book.update(ops.setLang(cell.id, l))}
                  onRun={() => void runCell(cell.id)}
                  onInterrupt={() => {
                    const lang = isCode(cell) ? cell.lang : 'java';
                    void registry.get(lang).session?.interrupt();
                  }}
                  onRemove={() => book.update(ops.remove(cell.id))}
                  onEdit={() => setEditingId(cell.id)}
                  onDoneEdit={() => setEditingId(null)}
                  onInsert={(type) => insertAfter(i + 1, type)}
                  onDragStart={() => setDragId(cell.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropId(null);
                  }}
                  onDragOver={() => dragId && setDropId(cell.id)}
                  onDrop={() => {
                    if (dragId && dragId !== cell.id) book.update(ops.move(dragId, cell.id));
                    setDragId(null);
                    setDropId(null);
                  }}
                  onRetryDetect={() =>
                    book.update(ops.setOutputs(cell.id, [], isCode(cell) ? cell.lang : 'java', false))
                  }
                  onOpenSettings={() => setSettingsOpen(true)}
                />
              ))}

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragId) setDropId('end');
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId) book.update(ops.move(dragId, 'end'));
                  setDragId(null);
                  setDropId(null);
                }}
              >
                <div className="nx-dropline" data-active={!!dragId && dropId === 'end'} />
                <div className="nx-add-row">
                  <button className="nx-btn-dashed" onClick={() => insertAfter(null, 'md')}>
                    ＋ 文本
                  </button>
                  <button className="nx-btn-dashed" onClick={() => insertAfter(null, 'code')}>
                    ＋ 代码
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </main>

      {settingsOpen && (
        <SettingsModal
          setup={setup}
          onVaultChanged={onVaultChanged}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
