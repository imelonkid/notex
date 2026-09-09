import { useCallback, useEffect, useRef, useState } from 'react';
import { LANGS, isCode, type LangId, type Output, type RunMark } from '@core/model';
import { exportIpynb, exportMarkdown, importNotebook } from '@core/files';
import { parseDeps } from '@core/deps';
import { resolveNoteLink } from '@core/links';
import { MAX_DIR_DEPTH, baseOf, depthOf, dirOf, joinId } from '@core/store/paths';
import type { StoreSetup } from '@core/store/index';
import { Cell } from './components/Cell';
import { NoteTree } from './components/NoteTree';
import { ContextMenu, type MenuItem, type MenuState } from './components/ContextMenu';
import { Backlinks } from './components/Backlinks';
import { InsertStrip } from './components/InsertStrip';
import { Shortcuts } from './components/Shortcuts';
import { useLinkIndex } from './useLinkIndex';
import { SettingsModal } from './components/SettingsModal';
import { useRuntimes } from './RuntimeContext';
import { scrollToHeadingText, useLinkInterceptor } from './useLinkInterceptor';
import { newCodeCell, newMarkdownCell, ops, useNotebook } from './useNotebook';

export function App({ setup, onVaultChanged }: { setup: StoreSetup; onVaultChanged(): void }) {
  const { registry, revision, host } = useRuntimes();
  const book = useNotebook(setup.store);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [runningIds, setRunningIds] = useState<Record<string, boolean>>({});
  /**
   * 每个 cell 在本次会话里的执行结果，只活在内存里。
   * 刷新页面就没了，因为那时内核也是全新的，装订线上不该再声称"跑过"。
   * 放在笔记外面，切换笔记再切回来标记还在。
   */
  const [runMarks, setRunMarks] = useState<Record<string, RunMark>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [depsStatus, setDepsStatus] = useState<Record<string, string>>({});
  const [refreshing, setRefreshing] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(`nx.tree.expanded.${setup.vaultPath}`);
      return new Set<string>(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      return new Set<string>();
    }
  });
  const [dragNoteId, setDragNoteId] = useState<string | null>(null);
  const [dropDir, setDropDir] = useState<string | null>(null);
  const [menu, setMenu] = useState<MenuState | null>(null);
  /** 侧栏里正在就地重命名的笔记 */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  /** 当前 cell，工具栏与快捷键作用于它 */
  const [activeCellId, setActiveCellId] = useState<string | null>(null);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const activeCellIdRef = useRef<string | null>(null);
  activeCellIdRef.current = activeCellId;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('nx.sidebar.collapsed') === '1',
  );

  const nbRef = useRef(book.nb);
  nbRef.current = book.nb;

  const links = useLinkIndex(setup.store, book.refs);

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
      const fromDir = activeIdRef.current ? dirOf(activeIdRef.current) : '';
      const id = resolveNoteLink(target, refsRef.current, fromDir);
      if (!id) {
        // 断链：直接问要不要按链接里写的路径建出来，
        // 先写下想法再补内容是很自然的写作顺序
        const clean = target.replace(/\.md$/i, '').replace(/^\.\//, '');
        const targetDir = dirOf(clean) || fromDir;
        const name = baseOf(clean);
        if (window.confirm(`笔记「${name}」还不存在，现在创建？`)) {
          void book.createNotebook(name, targetDir);
        }
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

  useEffect(() => {
    try {
      localStorage.setItem(
        `nx.tree.expanded.${setup.vaultPath}`,
        JSON.stringify([...expanded]),
      );
    } catch {
      /* 无痕模式忽略 */
    }
  }, [expanded, setup.vaultPath]);

  // 当前笔记所在的各级目录自动展开，否则跳转过去看不到选中项
  useEffect(() => {
    if (!book.activeId) return;
    const parts = dirOf(book.activeId).split('/').filter(Boolean);
    if (!parts.length) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let acc = '';
      for (const p of parts) {
        acc = acc ? `${acc}/${p}` : p;
        next.add(acc);
      }
      return next;
    });
  }, [book.activeId]);

  // 内核重启后，这门语言的 cell 在新内核里都没跑过，清掉标记
  useEffect(
    () =>
      registry.onRestart((lang) => {
        setRunMarks((r) => {
          const next: Record<string, RunMark> = {};
          for (const cell of nbRef.current?.cells ?? []) {
            const m = r[cell.id];
            if (m && isCode(cell) && cell.lang !== lang) next[cell.id] = m;
          }
          return next;
        });
      }),
    [registry],
  );

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
      const mark = (m: RunMark) => setRunMarks((r) => ({ ...r, [cellId]: m }));

      setRunningIds((r) => ({ ...r, [cellId]: true }));
      book.update(ops.setOutputs(cellId, [], lang));

      const session = await registry.ensure(lang);
      if (!session) {
        stopRunning();
        book.update(ops.setOutputs(cellId, [{ type: 'missing-runtime', lang }], lang));
        mark('error');
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
          book.update(ops.setOutputs(cellId, outputs, lang));
          mark('error');
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
        book.update(ops.setOutputs(cellId, outputs, lang));
        mark(status);
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

  /** 在指定下标插入，index 为 null 表示追加到末尾 */
  const insertAt = (index: number | null, type: 'md' | 'code') => {
    const cells = nbRef.current?.cells ?? [];
    // 新代码 cell 沿用上一个代码 cell 的语言
    const prevCode = [...cells.slice(0, index ?? cells.length)].reverse().find(isCode);
    const lang: LangId = prevCode?.lang ?? 'python';
    const cell = type === 'md' ? newMarkdownCell() : newCodeCell(lang);
    book.update(ops.insert(index, cell));
    setActiveCellId(cell.id);
    if (type === 'md') setEditingId(cell.id);
  };

  /** 在当前 cell 下方插入，没有当前 cell 就追加 */
  const insertBelowActive = (type: 'md' | 'code') => {
    const cells = nbRef.current?.cells ?? [];
    const i = cells.findIndex((c) => c.id === activeCellId);
    insertAt(i < 0 ? null : i + 1, type);
  };

  /** 文本与代码互转，保留源码 */
  const convertCell = (cellId: string) => {
    const cells = nbRef.current?.cells ?? [];
    const cell = cells.find((c) => c.id === cellId);
    if (!cell) return;
    const prevCode = cells.filter(isCode).find((c) => c.id !== cellId);
    book.update(ops.convert(cellId, prevCode?.lang ?? 'python'));
    if (isCode(cell)) setEditingId(cellId);
  };

  /**
   * 快捷键。全部带修饰键，不引入 Jupyter 那样的命令模式：
   * 这个应用大部分时间在输入文字，模态切换的摩擦比省下的键位更贵。
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      const active = activeCellIdRef.current;

      if (key === 'b') {
        e.preventDefault();
        setSidebarCollapsed((c) => !c);
      } else if (key === 's') {
        e.preventDefault();
        void book.flush();
      } else if (key === 'enter' && e.shiftKey) {
        e.preventDefault();
        void runAll();
      } else if (key === 'enter' && e.altKey) {
        e.preventDefault();
        insertBelowActive('code');
      } else if (e.altKey && (key === 'arrowdown' || key === 'arrowup')) {
        e.preventDefault();
        const cells = nbRef.current?.cells ?? [];
        const i = cells.findIndex((c) => c.id === active);
        insertAt(key === 'arrowdown' ? (i < 0 ? null : i + 1) : Math.max(i, 0), 'md');
      } else if (key === 'backspace' && active) {
        e.preventDefault();
        book.update(ops.remove(active));
        setActiveCellId(null);
      } else if (key === '/') {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [book, runAll, insertAt, insertBelowActive]);



  const nb = book.nb;
  const activeCell = nb?.cells.find((c) => c.id === activeCellId) ?? null;

  /**
   * 「移动到」按目录层级做成多级子菜单，而不是把 "工作/项目A" 这种
   * 完整路径平铺出来。有子目录的目录自己也可当落点，放在子菜单第一项。
   */
  const buildMoveMenu = (noteId: string): MenuItem[] => {
    const fromDir = dirOf(noteId);
    const childrenOf = (parent: string) =>
      book.folders.filter((d) => dirOf(d) === parent);

    const nodeFor = (dir: string): MenuItem => {
      const subs = childrenOf(dir);
      const self: MenuItem = {
        label: baseOf(dir),
        onSelect: () => void book.moveNotebook(noteId, dir),
        disabled: dir === fromDir,
      };
      if (!subs.length) return self;
      return {
        label: baseOf(dir),
        children: [
          {
            label: `放到「${baseOf(dir)}」`,
            onSelect: () => void book.moveNotebook(noteId, dir),
            disabled: dir === fromDir,
          },
          ...subs.map((d) => ({ ...nodeFor(d), separatorBefore: d === subs[0] })),
        ],
      };
    };

    return [
      {
        label: '根目录',
        onSelect: () => void book.moveNotebook(noteId, ''),
        disabled: fromDir === '',
      },
      ...childrenOf('').map((d, i) => ({ ...nodeFor(d), separatorBefore: i === 0 })),
    ];
  };

  const openNoteMenu = (id: string, x: number, y: number) => {
    const items: MenuItem[] = [
      { label: '打开', onSelect: () => void book.open(id) },
      { label: '重命名', onSelect: () => setRenamingId(id) },
      { label: '移动到', separatorBefore: true, children: buildMoveMenu(id) },
      {
        label: '删除笔记',
        danger: true,
        separatorBefore: true,
        onSelect: () => {
          if (window.confirm(`确定删除「${baseOf(id)}」？文件会从笔记库里移除。`)) {
            void book.removeNotebook(id);
          }
        },
      },
    ];
    setMenu({ x, y, items });
  };

  const openCellMenu = (cellId: string, x: number, y: number) => {
    const cells = nbRef.current?.cells ?? [];
    const i = cells.findIndex((c) => c.id === cellId);
    if (i < 0) return;
    const cell = cells[i];
    const code = isCode(cell);
    setMenu({
      x,
      y,
      items: [
        { label: '在上方插入文本', onSelect: () => insertAt(i, 'md') },
        { label: '在上方插入代码', onSelect: () => insertAt(i, 'code') },
        { label: '在下方插入文本  ⌥⌘↓', onSelect: () => insertAt(i + 1, 'md') },
        { label: '在下方插入代码', onSelect: () => insertAt(i + 1, 'code') },
        {
          label: code ? '转为文本' : '转为代码',
          separatorBefore: true,
          onSelect: () => convertCell(cellId),
        },
        {
          label: '上移',
          separatorBefore: true,
          disabled: i === 0,
          onSelect: () => book.update(ops.move(cellId, cells[i - 1].id)),
        },
        {
          label: '下移',
          disabled: i === cells.length - 1,
          onSelect: () =>
            book.update(ops.move(cellId, cells[i + 2]?.id ?? 'end')),
        },
        ...(code
          ? [{ label: '运行  ⌘↩', onSelect: () => void runCell(cellId) }]
          : []),
        {
          label: '删除 cell  ⌘⌫',
          danger: true,
          separatorBefore: true,
          onSelect: () => book.update(ops.remove(cellId)),
        },
      ],
    });
  };

  const openFolderMenu = (dir: string, x: number, y: number) => {
    const inside = book.refs.filter((r) => r.dir === dir || r.dir.startsWith(dir + '/'));
    const items: MenuItem[] = [
      { label: '新建笔记', onSelect: () => void book.createNotebook('未命名笔记', dir) },
      {
        label:
          depthOf(dir) >= MAX_DIR_DEPTH
            ? `新建文件夹（已达 ${MAX_DIR_DEPTH} 级上限）`
            : '新建文件夹',
        disabled: depthOf(dir) >= MAX_DIR_DEPTH,
        onSelect: () => {
          const name = window.prompt('新文件夹名称', '新文件夹');
          if (name?.trim()) void book.createFolder(joinId(dir, name.trim()));
        },
      },
    ];
    if (dir) {
      items.push({
        label: '删除文件夹',
        danger: true,
        separatorBefore: true,
        onSelect: () => {
          const msg = inside.length
            ? `「${baseOf(dir)}」里有 ${inside.length} 篇笔记，一并删除？`
            : `确定删除空文件夹「${baseOf(dir)}」？`;
          if (window.confirm(msg)) void book.removeFolder(dir);
        },
      });
    }
    setMenu({ x, y, items });
  };
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

        <div className="nx-section-label nx-section-head">
          <span>我的笔记</span>
          <button
            className="nx-icon-btn"
            title="重新读取笔记库目录"
            aria-label="刷新笔记列表"
            data-busy={refreshing}
            disabled={refreshing}
            onClick={async () => {
              setRefreshing(true);
              try {
                await book.checkExternal();
              } finally {
                setRefreshing(false);
              }
            }}
          >
            ↻
          </button>
        </div>
        <div className="nx-nb-list">
          <NoteTree
            notes={book.refs}
            folders={book.folders}
            activeId={book.activeId}
            expanded={expanded}
            dragId={dragNoteId}
            dropDir={dropDir}
            onToggle={(dir) =>
              setExpanded((prev) => {
                const next = new Set(prev);
                if (next.has(dir)) next.delete(dir);
                else next.add(dir);
                return next;
              })
            }
            onOpen={(id) => {
              void book.open(id);
              setEditingId(null);
            }}
            onNoteMenu={openNoteMenu}
            renamingId={renamingId}
            onRenamingChange={setRenamingId}
            onRename={(id, title) => void book.renameNotebook(id, title)}
            onFolderMenu={openFolderMenu}
            onDragStart={setDragNoteId}
            onDragEnd={() => {
              setDragNoteId(null);
              setDropDir(null);
            }}
            onDragOverDir={setDropDir}
            onDropTo={(dir) => {
              if (dragNoteId) void book.moveNotebook(dragNoteId, dir);
              setDragNoteId(null);
              setDropDir(null);
            }}
          />
        </div>


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
          {book.missingFile && (
            <div className="nx-banner nx-banner-warn">
              <span>这篇笔记的文件已不在笔记库里，可能是在应用外被删除或移动了。自动保存已暂停。</span>
              <span style={{ flex: 1 }} />
              <button className="nx-btn-mini" onClick={() => void book.flush(true)}>
                重新写回磁盘
              </button>
            </div>
          )}
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
                  ▶ 全部运行
                </button>

                <div className="nx-seg">
                  <button className="nx-seg-btn" onClick={() => insertBelowActive('md')}>
                    ＋ 文本
                  </button>
                  <button className="nx-seg-btn" onClick={() => insertBelowActive('code')}>
                    ＋ 代码
                  </button>
                </div>

                {/* 类型切换作用于当前 cell，是换语言的主入口 */}
                <div className="nx-seg" title={activeCell ? '切换当前 cell 的类型' : '先选中一个 cell'}>
                  <button
                    className="nx-seg-btn"
                    data-active={activeCell ? !isCode(activeCell) : false}
                    disabled={!activeCell}
                    onClick={() => activeCell && !isCode(activeCell) ? undefined : activeCell && convertCell(activeCell.id)}
                  >
                    文本
                  </button>
                  {LANGS.map((l) => (
                    <button
                      key={l.id}
                      className="nx-seg-btn"
                      data-active={!!activeCell && isCode(activeCell) && activeCell.lang === l.id}
                      disabled={!activeCell}
                      onClick={() => {
                        if (!activeCell) return;
                        if (!isCode(activeCell)) convertCell(activeCell.id);
                        book.update(ops.setLang(activeCell.id, l.id));
                      }}
                    >
                      {l.label}
                    </button>
                  ))}
                </div>

                {anyRunning && (
                  <button
                    className="nx-btn-ghost"
                    onClick={() => {
                      for (const l of LANGS) void registry.get(l.id).session?.interrupt();
                    }}
                  >
                    ⏹ 中断
                  </button>
                )}

                <span style={{ flex: 1 }} />

                <button
                  className="nx-btn-mini"
                  title="快捷键（⌘/）"
                  onClick={() => setShortcutsOpen(true)}
                >
                  ⌘/
                </button>

                <button
                  className="nx-btn-mini"
                  title="更多"
                  onClick={(e) => {
                    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
                    setMenu({
                      x: r.left,
                      y: r.bottom + 4,
                      items: [
                        {
                          label: '清空输出',
                          onSelect: () => {
                            book.update(ops.clearOutputs());
                            setRunMarks({});
                          },
                        },
                        { label: '导入…', separatorBefore: true, onSelect: () => void doImport() },
                        { label: '导出 Markdown', onSelect: () => exportMarkdown(nb) },
                        { label: '导出 ipynb', onSelect: () => exportIpynb(nb) },
                      ],
                    });
                  }}
                >
                  ⋯
                </button>
              </div>

              {nb.cells.map((cell, i) => (
                <div key={cell.id}>
                <InsertStrip onInsert={(type) => insertAt(i, type)} />
                <Cell
                  key={cell.id}
                  cell={cell}
                  index={i}
                  editing={editingId === cell.id}
                  running={!!runningIds[cell.id]}
                  mark={runMarks[cell.id]}
                  busyNote={depsStatus[cell.id]}
                  isBrokenLink={(target) => links.isBroken(book.activeId, target)}
                  allNotes={book.refs}
                  currentNoteId={book.activeId}
                  active={cell.id === activeCellId}
                  onActivate={() => setActiveCellId(cell.id)}
                  onMenu={(x, y) => openCellMenu(cell.id, x, y)}
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
                  onRetryDetect={() => {
                    book.update(ops.setOutputs(cell.id, [], isCode(cell) ? cell.lang : 'java'));
                    setRunMarks((r) => {
                      const next = { ...r };
                      delete next[cell.id];
                      return next;
                    });
                  }}
                  onOpenSettings={() => setSettingsOpen(true)}
                />
                </div>
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
                {nb.cells.length === 0 ? (
                  <div className="nx-empty-note">
                    <div className="nx-empty-title">这篇笔记还是空的</div>
                    <div className="nx-seg">
                      <button className="nx-seg-btn" onClick={() => insertAt(null, 'md')}>
                        ＋ 文本
                      </button>
                      <button className="nx-seg-btn" onClick={() => insertAt(null, 'code')}>
                        ＋ 代码
                      </button>
                    </div>
                  </div>
                ) : (
                  <InsertStrip onInsert={(type) => insertAt(null, type)} />
                )}
              </div>

              <Backlinks
                backlinks={links.backlinksOf(book.activeId)}
                ready={links.ready}
                onOpen={(id) => {
                  setEditingId(null);
                  void book.open(id);
                }}
              />
            </>
          )}
        </div>
      </main>

      {shortcutsOpen && <Shortcuts onClose={() => setShortcutsOpen(false)} />}
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}

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
