import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LANGS,
  findNotebook,
  isCode,
  type LangId,
  type Output,
  type Workspace,
} from '@core/model';
import { actions, loadWorkspace, saveWorkspace } from '@core/store';
import { exportIpynb, exportMarkdown, importNotebook } from '@core/files';
import { parseDeps } from '@core/deps';
import { Cell } from './components/Cell';
import { SettingsModal } from './components/SettingsModal';
import { useRuntimes } from './RuntimeContext';

export function App() {
  const { registry, revision, host } = useRuntimes();
  const [ws, setWs] = useState<Workspace>(loadWorkspace);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<Record<string, boolean>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [depsStatus, setDepsStatus] = useState<Record<string, string>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('xnb.sidebar.collapsed') === '1',
  );
  const wsRef = useRef(ws);
  wsRef.current = ws;

  useEffect(() => {
    saveWorkspace(ws);
  }, [ws]);

  useEffect(() => {
    localStorage.setItem('xnb.sidebar.collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  // Cmd/Ctrl+B 切换侧栏，和常见编辑器一致
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        setSidebarCollapsed((c) => !c);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const nb = findNotebook(ws);

  /** 运行一个 cell：确保内核就绪 → 流式收集输出 → 落库 */
  const runCell = useCallback(
    async (cellId: string): Promise<'ok' | 'error' | 'aborted' | 'skipped'> => {
      const current = findNotebook(wsRef.current).cells.find((c) => c.id === cellId);
      if (!current || !isCode(current)) return 'skipped';
      const lang = current.lang;
      const code = current.source;
      if (runningIds[cellId]) return 'skipped';

      setRunningIds((r) => ({ ...r, [cellId]: true }));
      setWs((w) => actions.setOutputs(w, cellId, [], lang, false));

      const session = await registry.ensure(lang);
      if (!session) {
        setRunningIds((r) => {
          const next = { ...r };
          delete next[cellId];
          return next;
        });
        setWs((w) => actions.setOutputs(w, cellId, [{ type: 'missing-runtime', lang }], lang, false));
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
          push({ type: 'error', ename: 'DependencyError', evalue: String((e as Error)?.message ?? e), traceback: [] });
          setDepsStatus((d) => {
            const next = { ...d };
            delete next[cellId];
            return next;
          });
          setRunningIds((r) => {
            const next = { ...r };
            delete next[cellId];
            return next;
          });
          setWs((w) => actions.setOutputs(w, cellId, outputs, lang, true));
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
        setRunningIds((r) => {
          const next = { ...r };
          delete next[cellId];
          return next;
        });
        setWs((w) => actions.setOutputs(w, cellId, outputs, lang, true));
      }
      return status;
    },
    [registry, runningIds, host],
  );

  // 出错或被中断就停下，避免后续 cell 在错误状态上继续跑
  const runAll = useCallback(async () => {
    for (const cell of findNotebook(wsRef.current).cells) {
      if (!isCode(cell)) continue;
      const status = await runCell(cell.id);
      if (status === 'error' || status === 'aborted') break;
    }
  }, [runCell]);

  const doImport = useCallback(async () => {
    const imported = await importNotebook();
    if (!imported) return;
    setWs((w) => ({ activeId: imported.id, notebooks: [...w.notebooks, imported] }));
    setEditingId(null);
  }, []);

  const insertAfter = (index: number | null, type: 'md' | 'code') => {
    const cells = findNotebook(wsRef.current).cells;
    // 新代码 cell 沿用上一个代码 cell 的语言
    const prevCode = [...cells.slice(0, index ?? cells.length)].reverse().find(isCode);
    const lang: LangId = prevCode?.lang ?? 'java';
    const { ws: next, id } = actions.insertCell(wsRef.current, index, type, lang);
    setWs(next);
    if (type === 'md') setEditingId(id);
  };

  const anyRunning = Object.keys(runningIds).length > 0;
  void revision;

  return (
    <div className="xnb-app" data-collapsed={sidebarCollapsed}>
      {sidebarCollapsed && (
        <button
          className="xnb-sidebar-toggle"
          data-floating="true"
          title="展开侧栏（⌘B）"
          aria-label="展开侧栏"
          onClick={() => setSidebarCollapsed(false)}
        >
          ›
        </button>
      )}

      <aside className="xnb-sidebar" data-collapsed={sidebarCollapsed}>
        <div className="xnb-brand">
          <div className="xnb-brand-name">xnotebook</div>
          <div className="xnb-brand-sub">可执行笔记</div>
          <span style={{ flex: 1 }} />
          <button
            className="xnb-sidebar-toggle"
            title="折叠侧栏（⌘B）"
            aria-label="折叠侧栏"
            onClick={() => setSidebarCollapsed(true)}
          >
            ‹
          </button>
        </div>

        <div className="xnb-section-label">我的笔记</div>
        {ws.notebooks.map((n) => (
          <div
            key={n.id}
            className="xnb-nb-item"
            data-active={n.id === ws.activeId}
            onClick={() => {
              setWs((w) => actions.selectNotebook(w, n.id));
              setEditingId(null);
            }}
          >
            <span className="xnb-nb-title">{n.title || '未命名笔记'}</span>
            <button
              className="xnb-nb-remove"
              title="删除笔记"
              onClick={(e) => {
                e.stopPropagation();
                setWs((w) => actions.removeNotebook(w, n.id));
              }}
            >
              ×
            </button>
          </div>
        ))}

        <button
          className="xnb-btn-outline"
          style={{ marginTop: 12 }}
          onClick={() => setWs((w) => actions.addNotebook(w))}
        >
          ＋ 新建笔记本
        </button>

        <div style={{ flex: 1 }} />

        <div className="xnb-runtime-panel">
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
              <button key={l.id} className="xnb-runtime-row" onClick={() => setSettingsOpen(true)}>
                <span className="xnb-dot" data-status={state.status} />
                <span style={{ flex: 1 }}>{l.label}</span>
                <span style={{ color: 'var(--nb-fg-faint)' }}>{label}</span>
              </button>
            );
          })}
          <button className="xnb-btn-mini" style={{ alignSelf: 'flex-start', marginTop: 2, marginLeft: -8 }} onClick={() => setSettingsOpen(true)}>
            设置…
          </button>
        </div>
      </aside>

      <main className="xnb-main">
        <div className="xnb-page">
          <input
            className="xnb-title-input"
            value={nb.title}
            title="笔记标题"
            onChange={(e) => setWs((w) => actions.setTitle(w, e.target.value))}
          />

          <div className="xnb-toolbar">
            <button className="xnb-btn-primary" onClick={() => void runAll()} disabled={anyRunning}>
              全部运行
            </button>
            <button className="xnb-btn-ghost" onClick={() => setWs((w) => actions.clearOutputs(w))}>
              清空输出
            </button>
            <button className="xnb-btn-ghost" onClick={() => exportMarkdown(findNotebook(wsRef.current))}>
              导出 Markdown
            </button>
            <button className="xnb-btn-ghost" onClick={() => exportIpynb(findNotebook(wsRef.current))}>
              导出 ipynb
            </button>
            <button className="xnb-btn-ghost" onClick={() => void doImport()}>
              导入…
            </button>
            <span style={{ flex: 1 }} />
            <span className="xnb-hint">Shift+Enter 运行 · 双击文本编辑 · 拖 ⠿ 排序</span>
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
              onSource={(v) => setWs((w) => actions.updateSource(w, cell.id, v))}
              onLang={(l) => setWs((w) => actions.setLang(w, cell.id, l))}
              onRun={() => void runCell(cell.id)}
              onInterrupt={() => {
                const lang = isCode(cell) ? cell.lang : 'java';
                void registry.get(lang).session?.interrupt();
              }}
              onRemove={() => setWs((w) => actions.removeCell(w, cell.id))}
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
                if (dragId && dragId !== cell.id) setWs((w) => actions.moveCell(w, dragId, cell.id));
                setDragId(null);
                setDropId(null);
              }}
              onRetryDetect={() => setWs((w) => actions.setOutputs(w, cell.id, [], isCode(cell) ? cell.lang : 'java', false))}
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
              if (dragId) setWs((w) => actions.moveCell(w, dragId, 'end'));
              setDragId(null);
              setDropId(null);
            }}
          >
            <div className="xnb-dropline" data-active={!!dragId && dropId === 'end'} />
            <div className="xnb-add-row">
              <button className="xnb-btn-dashed" onClick={() => insertAfter(null, 'md')}>
                ＋ 文本
              </button>
              <button className="xnb-btn-dashed" onClick={() => insertAfter(null, 'code')}>
                ＋ 代码
              </button>
            </div>
          </div>
        </div>
      </main>

      {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}
