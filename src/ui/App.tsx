import { useCallback, useEffect, useRef, useState } from 'react';
import { debug } from '@core/debug';
import { writeClipboard } from './clipboard';
import { LANGS, isCode, type LangId, type Output, type RunMark, type RunRecord } from '@core/model';
import { exportIpynb, exportMarkdown, importNotebook } from '@core/files';
import { parseDeps } from '@core/deps';
import { nextLinkTarget, resolveNoteLink, rewriteNoteLinks } from '@core/links';
import { SearchPalette } from './components/SearchPalette';
import { useRichPaste } from './useRichPaste';
import { RuntimeStrip, STATUS_WORD } from './components/RuntimeStrip';
import { FolderIcon, GearIcon } from './components/icons';
import { MAX_DIR_DEPTH, baseOf, depthOf, dirOf, joinId } from '@core/store/paths';
import type { StoreSetup } from '@core/store/index';
import { Cell } from './components/Cell';
import { NoteTree } from './components/NoteTree';
import { ContextMenu, type MenuItem, type MenuState } from './components/ContextMenu';
import { Backlinks } from './components/Backlinks';
import { Shortcuts } from './components/Shortcuts';
import { AskModal, type AskRequest, type AskState } from './components/AskModal';
import { CellBoundary } from './components/CellBoundary';
import { SidebarToggle } from './components/SidebarToggle';
import { Breadcrumb } from './components/Breadcrumb';
import { FolderPage } from './components/FolderPage';
import { useLinkIndex } from './useLinkIndex';
import { SettingsModal, type SettingsTab } from './components/SettingsModal';
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
  /** 本次会话每个 cell 的执行结果，带耗时——界面上要显示"跑了多久" */
  const [runMarks, setRunMarks] = useState<Record<string, RunRecord>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropId, setDropId] = useState<string | null>(null);
  /** 设置弹窗：null 关着，否则是打开时落到的分页 */
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const settingsOpen = settingsTab !== null;
  const setSettingsOpen = (open: boolean, tab: SettingsTab = 'vault') => setSettingsTab(open ? tab : null);
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
  /**
   * 正在看的文件夹页，笔记库根为空串；看笔记时为 null。
   * 文件夹页和笔记页共用同一块主区，由它决定显示哪一个。
   */
  const [folderView, setFolderView] = useState<string | null>(null);
  const folderViewRef = useRef(folderView);
  folderViewRef.current = folderView;
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [ask, setAsk] = useState<AskState | null>(null);
  /** 刚复制过的 cell，用于在按钮上短暂打勾 */
  const [copiedId, setCopiedId] = useState<string | null>(null);

  /** 应用内的确认/输入框。取消返回 null，确认返回输入内容（纯确认时是空串） */
  const askUser = useCallback(
    (req: AskRequest) =>
      new Promise<string | null>((resolve) => {
        debug.log('ask', '弹出对话框', { title: req.title, input: !!req.input });
        setAsk({
          ...req,
          resolve: (value) => {
            debug.log('ask', value === null ? '对话框取消' : '对话框确认', { title: req.title });
            setAsk(null);
            resolve(value);
          },
        });
      }),
    [],
  );
  const activeCellIdRef = useRef<string | null>(null);
  activeCellIdRef.current = activeCellId;
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => localStorage.getItem('nx.sidebar.collapsed') === '1',
  );

  const nbRef = useRef(book.nb);
  nbRef.current = book.nb;

  const links = useLinkIndex(setup.store, book.refs);

  /** 顶部的一次性提示条，可以带一个动作（比如删除后的「撤销」） */
  const [notice, setNotice] = useState<{ text: string; action?: { label: string; run(): void } } | null>(
    null,
  );
  const setLinkNotice = useCallback((text: string) => setNotice({ text }), []);

  /** 富文本粘贴与正文里相对路径图片的解析，都以当前笔记所在目录为基准 */
  const richPaste = useRichPaste({
    host,
    vaultPath: setup.store.kind === 'vault' ? setup.vaultPath : null,
    noteId: book.activeId,
    notify: setLinkNotice,
  });
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
        void askUser({
          title: '创建笔记',
          message: `笔记「${name}」还不存在，现在创建？`,
          confirmLabel: '创建',
        }).then(async (ok) => {
          if (ok !== null && (await book.createNotebook(name, targetDir))) setFolderView(null);
        });
        return;
      }
      if (id === activeIdRef.current) {
        if (hash) scrollToHeadingText(hash);
        return;
      }
      pendingHash.current = hash ?? null;
      setEditingId(null);
      void book.open(id).then((opened) => {
        if (opened) setFolderView(null);
      });
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

  // 存盘成功后立刻把这篇的出链更新进索引，反链和断链状态不必等下一轮轮询
  const touchIndex = links.touch;
  useEffect(() => {
    const saved = book.lastSaved;
    if (saved) touchIndex(saved.id, saved.markdown);
    // 只认 lastSaved：links 每次渲染都是新对象，放进依赖会无限循环
  }, [book.lastSaved, touchIndex]);

  useEffect(() => {
    if (!notice) return;
    // 带动作的提示多留一会儿，用户得有时间看清并点到它
    const t = setTimeout(() => setNotice(null), notice.action ? 8000 : 4000);
    return () => clearTimeout(t);
  }, [notice]);

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
          const next: Record<string, RunRecord> = {};
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
      if (!current || !isCode(current)) {
        debug.warn('run', '跳过：不是代码 cell', { cellId });
        return 'skipped';
      }
      const lang = current.lang;
      const code = current.source;
      if (runningIds[cellId]) {
        debug.warn('run', '跳过：这个 cell 正在运行', { cellId });
        return 'skipped';
      }
      const runStartedAt = performance.now();
      // 记下发起时这篇笔记是谁：跑完可能已经切走了，结果必须回到原处
      const noteId = nbRef.current?.id ?? null;
      const writeOutputs = (outs: Output[]) => {
        if (!noteId) return;
        void book.updateNote(noteId, ops.setOutputs(cellId, outs, lang));
      };
      debug.log('run', '开始运行', { cellId, lang, chars: code.length, noteId });

      const stopRunning = () =>
        setRunningIds((r) => {
          const next = { ...r };
          delete next[cellId];
          return next;
        });
      const mark = (m: RunMark, ms?: number) =>
        setRunMarks((r) => ({ ...r, [cellId]: { status: m, ms, at: Date.now() } }));

      setRunningIds((r) => ({ ...r, [cellId]: true }));
      writeOutputs([]);

      const session = await debug.op('run', `就绪 ${lang} 内核`, () => registry.ensure(lang));
      if (!session) {
        debug.error('run', '内核不可用', { cellId, lang });
        stopRunning();
        writeOutputs([{ type: 'missing-runtime', lang }]);
        mark('error', Math.round(performance.now() - runStartedAt));
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
          writeOutputs(outputs);
          mark('error', Math.round(performance.now() - runStartedAt));
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
        const ms = Math.round(performance.now() - runStartedAt);
        registry.setBusy(lang, false);
        stopRunning();
        writeOutputs(outputs);
        mark(status, ms);
        debug.log('run', '运行结束', { cellId, lang, status, ms, outputs: outputs.length });
      }
      return status;
    },
    [registry, runningIds, host, book],
  );

  // 出错或被中断就停下，避免后续 cell 在错误状态上继续跑
  const runAll = useCallback(async () => {
    debug.log('run', '全部运行', { cells: nbRef.current?.cells.length ?? 0 });
    for (const cell of nbRef.current?.cells ?? []) {
      if (!isCode(cell)) continue;
      const status = await runCell(cell.id);
      if (status === 'error' || status === 'aborted') break;
    }
  }, [runCell]);

  const doImport = useCallback(async () => {
    const imported = await debug.op('io', '导入笔记', () => importNotebook());
    if (!imported) return debug.warn('io', '导入取消或解析失败');
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
    debug.log('cell', '插入 cell', { index, type, lang: type === 'code' ? lang : undefined });
    book.update(ops.insert(index, cell), { record: true });
    setActiveCellId(cell.id);
    if (type === 'md') setEditingId(cell.id);
  };

  /** 在当前 cell 下方插入，没有当前 cell 就追加 */
  const insertBelowActive = (type: 'md' | 'code') => {
    const cells = nbRef.current?.cells ?? [];
    const i = cells.findIndex((c) => c.id === activeCellId);
    insertAt(i < 0 ? null : i + 1, type);
  };

  /**
   * 复制 cell 原文。取的是 source 而不是渲染结果：
   * 文本 cell 给回 Markdown 源码，代码 cell 的缩进和换行也原样保留。
   */
  const copyCell = useCallback(
    /** viaKeyboard：按钮自己会打勾，键盘路径看不到按钮，所以额外给条横幅 */
    async (cellId: string, viaKeyboard = false) => {
      const cell = nbRef.current?.cells.find((c) => c.id === cellId);
      if (!cell) return debug.warn('cell', '复制失败：找不到 cell', { cellId });
      if (!cell.source.trim()) {
        debug.warn('cell', '复制跳过：cell 是空的', { cellId });
        return setLinkNotice('这个 cell 是空的，没有可复制的内容');
      }
      const ok = await writeClipboard(cell.source);
      debug.log('cell', ok ? '复制 cell 原文' : '复制 cell 原文失败', {
        cellId,
        type: cell.type,
        chars: cell.source.length,
      });
      if (!ok) return setLinkNotice('复制失败：剪贴板不可用');
      setCopiedId(cellId);
      if (viaKeyboard) {
        setLinkNotice(`已复制${cell.type === 'md' ? '文本' : '代码'} cell 的原文`);
      }
    },
    [],
  );

  // 打勾一会儿就收回去
  useEffect(() => {
    if (!copiedId) return;
    const t = setTimeout(() => setCopiedId(null), 1600);
    return () => clearTimeout(t);
  }, [copiedId]);

  /** ⌘↩：在当前 cell 下方接着来一个同类型的，写文本继续写文本，写代码继续写代码 */
  const insertBelowActiveSameType = () => {
    const cells = nbRef.current?.cells ?? [];
    const i = cells.findIndex((c) => c.id === activeCellId);
    const ref = i >= 0 ? cells[i] : cells[cells.length - 1];
    insertBelowActive(ref && isCode(ref) ? 'code' : 'md');
  };

  /** 文本与代码互转，保留源码 */
  const convertCell = (cellId: string) => {
    const cells = nbRef.current?.cells ?? [];
    const cell = cells.find((c) => c.id === cellId);
    if (!cell) return debug.warn('cell', '转换失败：找不到 cell', { cellId });
    const prevCode = cells.filter(isCode).find((c) => c.id !== cellId);
    debug.log('cell', '转换 cell 类型', { cellId, from: cell.type });
    book.update(ops.convert(cellId, prevCode?.lang ?? 'python'), { record: true });
    if (isCode(cell)) setEditingId(cellId);
  };

  /**
   * 删除 cell。没有确认框——确认框会被习惯性点掉，撤销才是真正的安全网：
   * 记进撤销栈，并在顶部给一条带「撤销」的提示，⌘Z 也能拿回来。
   */
  const removeCell = (cellId: string) => {
    const cell = nbRef.current?.cells.find((c) => c.id === cellId);
    if (!cell) return;
    debug.log('cell', '删除 cell', { cellId, type: cell.type });
    book.update(ops.remove(cellId), { record: true });
    if (activeCellIdRef.current === cellId) setActiveCellId(null);
    setNotice({
      text: `已删除${isCode(cell) ? '代码' : '文本'} cell`,
      action: {
        label: '撤销（⌘Z）',
        run: () => {
          book.undo();
          setNotice(null);
        },
      },
    });
  };

  // 切到别的 cell 或退出编辑，文字编辑的会话就封口：再改是另一条撤销记录
  const sealHistory = book.sealHistory;
  useEffect(() => {
    sealHistory();
  }, [activeCellId, editingId, sealHistory]);
  // 同一个 cell 里点开别处再回来接着写，也算两段：编辑器失焦就封口
  useEffect(() => {
    const onFocusOut = (e: FocusEvent) => {
      if (inEditor(e.target)) sealHistory();
    };
    window.addEventListener('focusout', onFocusOut);
    return () => window.removeEventListener('focusout', onFocusOut);
  }, [sealHistory]);

  /** ⌘Z / ⇧⌘Z：编辑器外撤销整段编辑会话或一次结构操作；编辑器里的键由编辑器自己处理 */
  const undoStructure = (redo: boolean) => {
    const done = redo ? book.redo() : book.undo();
    setNotice({ text: done ? (redo ? '已重做' : '已撤销') : redo ? '没有可重做的操作' : '没有可撤销的操作' });
  };

  /**
   * 焦点是否在可编辑区域里。
   *
   * 全局快捷键挂在 window 上，编辑器处理完同一个键也不会阻止冒泡，
   * 于是一个键会被响应两次——⌘⌫ 在 macOS 的文本框里是"删到行首"，
   * 却把整个 cell 删了；⌘/ 在 CodeMirror 里是注释，同时又弹出面板。
   */
  const inEditor = (target: EventTarget | null): boolean => {
    if (!(target instanceof HTMLElement)) return false;
    if (target.isContentEditable) return true;
    if (target.closest('.cm-editor')) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
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

      // 文件夹页上没有 cell：只留侧栏、保存、搜索、快捷键面板几个全局键，
      // 否则 ⌘↩、⌘⌫ 会去改背后那篇看不见的笔记
      if (folderViewRef.current !== null && !['b', 's', 'k', '/'].includes(key)) return;

      if (key === 'b') {
        e.preventDefault();
        setSidebarCollapsed((c) => !c);
      } else if (key === 'k') {
        e.preventDefault();
        setSearchOpen((v) => !v);
      } else if (key === 's') {
        e.preventDefault();
        void book.flush();
      } else if (key === 'enter' && e.shiftKey) {
        e.preventDefault();
        void runAll();
      } else if (key === 'enter' && e.altKey) {
        e.preventDefault();
        insertBelowActive('code');
      } else if (key === 'enter') {
        e.preventDefault();
        insertBelowActiveSameType();
      } else if (e.altKey && (key === 'arrowdown' || key === 'arrowup')) {
        e.preventDefault();
        const cells = nbRef.current?.cells ?? [];
        const i = cells.findIndex((c) => c.id === active);
        insertAt(key === 'arrowdown' ? (i < 0 ? null : i + 1) : Math.max(i, 0), 'md');
      } else if (key === 'c' && e.shiftKey && active) {
        e.preventDefault();
        void copyCell(active, true);
      } else if (key === 'backspace' && active) {
        // 在编辑器里 ⌘⌫ 是"删到行首"，不能顺手把整个 cell 删了
        if (inEditor(e.target)) {
          return debug.log('cell', '⌘⌫ 在编辑区内，交给编辑器', { cellId: active });
        }
        e.preventDefault();
        removeCell(active);
      } else if (key === 'z') {
        // 编辑器里的 ⌘Z 撤销的是文字，那是编辑器自己的栈
        if (inEditor(e.target)) return debug.log('history', '⌘Z 在编辑器内，交给编辑器');
        e.preventDefault();
        debug.log('history', e.shiftKey ? '⇧⌘Z 重做' : '⌘Z 撤销', { active: activeCellIdRef.current });
        undoStructure(e.shiftKey);
      } else if (key === '/') {
        // CodeMirror 里 ⌘/ 是注释切换，别再抢着弹面板；
        // 工具栏上那个 ⌘/ 按钮任何时候都能打开
        if (inEditor(e.target)) return;
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [book, runAll, insertAt, insertBelowActive, insertBelowActiveSameType, copyCell, removeCell, undoStructure]);



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
        onSelect: () => void moveWithLinks(noteId, dir),
        disabled: dir === fromDir,
      };
      if (!subs.length) return self;
      return {
        label: baseOf(dir),
        children: [
          {
            label: `放到「${baseOf(dir)}」`,
            onSelect: () => void moveWithLinks(noteId, dir),
            disabled: dir === fromDir,
          },
          ...subs.map((d) => ({ ...nodeFor(d), separatorBefore: d === subs[0] })),
        ],
      };
    };

    return [
      {
        label: '根目录',
        onSelect: () => void moveWithLinks(noteId, ''),
        disabled: fromDir === '',
      },
      ...childrenOf('').map((d, i) => ({ ...nodeFor(d), separatorBefore: i === 0 })),
    ];
  };

  const openNoteMenu = (id: string, x: number, y: number) => {
    const items: MenuItem[] = [
      { label: '打开', onSelect: () => void openNote(id) },
      { label: '重命名', onSelect: () => setRenamingId(id) },
      { label: '移动到', separatorBefore: true, children: buildMoveMenu(id) },
      {
        label: '删除笔记',
        danger: true,
        separatorBefore: true,
        onSelect: () => {
          void askUser({
            title: '删除笔记',
            message: `确定删除「${baseOf(id)}」？文件会移到废纸篓，可以从那里找回。`,
            confirmLabel: '删除',
            danger: true,
          }).then((ok) => {
            if (ok !== null) void book.removeNotebook(id);
          });
        },
      },
    ];
    setMenu({ x, y, items });
  };

  const openCellMenu = (cellId: string, x: number, y: number, align?: 'left' | 'right') => {
    const cells = nbRef.current?.cells ?? [];
    const i = cells.findIndex((c) => c.id === cellId);
    if (i < 0) return;
    const cell = cells[i];
    const code = isCode(cell);
    setMenu({
      x,
      y,
      align,
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
          onSelect: () => book.update(ops.move(cellId, cells[i - 1].id), { record: true }),
        },
        {
          label: '下移',
          disabled: i === cells.length - 1,
          onSelect: () =>
            book.update(ops.move(cellId, cells[i + 2]?.id ?? 'end'), { record: true }),
        },
        ...(code
          ? [{ label: '运行  ⇧↩', onSelect: () => void runCell(cellId) }]
          : []),
        {
          label: '复制原文  ⇧⌘C',
          separatorBefore: true,
          onSelect: () => void copyCell(cellId),
        },
        {
          label: '删除 cell  ⌘⌫',
          danger: true,
          separatorBefore: true,
          onSelect: () => removeCell(cellId),
        },
      ],
    });
  };

  const openFolderMenu = (dir: string, x: number, y: number, align?: 'left' | 'right') => {
    const inside = book.refs.filter((r) => r.dir === dir || r.dir.startsWith(dir + '/'));
    const items: MenuItem[] = [
      { label: '新建笔记', onSelect: () => void createNote('未命名笔记', dir) },
      {
        label:
          depthOf(dir) >= MAX_DIR_DEPTH
            ? `新建文件夹（已达 ${MAX_DIR_DEPTH} 级上限）`
            : '新建文件夹',
        disabled: depthOf(dir) >= MAX_DIR_DEPTH,
        onSelect: () => askCreateFolder(dir),
      },
    ];
    if (dir) {
      items.push({
        label: '删除文件夹',
        danger: true,
        separatorBefore: true,
        onSelect: () => {
          void askUser({
            title: '删除文件夹',
            message: inside.length
              ? `「${baseOf(dir)}」里有 ${inside.length} 篇笔记，整个文件夹（含其中所有文件）会移到废纸篓。`
              : `确定删除空文件夹「${baseOf(dir)}」？它会移到废纸篓。`,
            confirmLabel: '删除',
            danger: true,
          }).then((ok) => {
            if (ok !== null) void book.removeFolder(dir);
          });
        },
      });
    }
    setMenu({ x, y, align, items });
  };
  const anyRunning = Object.keys(runningIds).length > 0;
  void revision;

  /** 侧栏底部的笔记库名：只要目录名，完整路径放 tooltip */
  const vaultName =
    setup.store.kind === 'vault' ? baseOf(setup.vaultPath.replace(/[/\\]+$/, '')) || setup.vaultPath : '浏览器存储';
  const vaultTip =
    setup.store.kind === 'vault'
      ? `笔记库：${setup.vaultPath}\n点击打开笔记库`
      : `当前存在浏览器里，无法落盘${setup.fallbackReason ? `：${setup.fallbackReason}` : ''}`;

  /** 点侧栏底部某个运行时：直接给动作，不必进设置 */
  const openRuntimeMenu = (lang: LangId, x: number, y: number) => {
    const s = registry.get(lang);
    const label = LANGS.find((l) => l.id === lang)?.label ?? lang;
    const alive = !!s.session?.alive;
    const items: MenuItem[] = [
      {
        label: `${label}${s.info?.version ? ` ${s.info.version}` : ''} · ${STATUS_WORD[s.status]}`,
        disabled: true,
      },
    ];
    if (s.status === 'busy') {
      items.push({ label: '中断当前执行', separatorBefore: true, onSelect: () => void s.session?.interrupt() });
    }
    if (alive) {
      items.push({
        label: s.restartNeeded ? '重启内核以应用新设置' : '重启内核',
        separatorBefore: s.status !== 'busy',
        onSelect: () => {
          debug.log('runtime', '从侧栏重启内核', { lang });
          void registry.restart(lang);
        },
      });
      items.push({
        label: '停止内核',
        onSelect: () => {
          debug.log('runtime', '从侧栏停止内核', { lang });
          void registry.stop(lang);
        },
      });
    } else if (s.status === 'available') {
      items.push({ label: '启动内核', separatorBefore: true, onSelect: () => void registry.ensure(lang) });
    } else if (s.status === 'missing' || s.status === 'error' || s.status === 'unknown') {
      items.push({
        label: '重新检测',
        separatorBefore: true,
        onSelect: () => void registry.detect(lang, true),
      });
    }
    items.push({ label: '设置…', separatorBefore: true, onSelect: () => setSettingsOpen(true, 'runtime') });
    setMenu({ x, y, items, align: 'left', placement: 'above' });
  };

  /**
   * 保存状态。自动保存的应用最需要的确认恰恰是"存住了"，
   * 以前只在左下角把路径换成"保存中…"，离正在打字的地方最远，
   * 而且没有"已保存"这个态。
   */
  const saveState: { kind: 'saving' | 'saved' | 'conflict' | 'error'; text: string } =
    book.error
      ? { kind: 'error', text: '保存出错' }
      : book.conflict
        ? { kind: 'conflict', text: '有冲突待处理' }
        : book.saving
          ? { kind: 'saving', text: '保存中…' }
          : book.hasUnsaved
            ? { kind: 'saving', text: '待保存' }
            : { kind: 'saved', text: '已保存' };

  /** 侧栏里把某个文件夹的各级父目录和它自己展开，侧栏开着时顺便滚到那一行 */
  const expandToDir = (dir: string) => {
    if (!dir) return;
    const parts = dir.split('/');
    setExpanded((prev) => {
      const next = new Set(prev);
      parts.forEach((_, i) => next.add(parts.slice(0, i + 1).join('/')));
      return next;
    });
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>(`.nx-folder[data-dir="${CSS.escape(dir)}"]`)
          ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }),
    );
  };

  /**
   * 改名或移动一篇笔记，然后把别的笔记里指向它的链接改过来。
   *
   * 反链必须在改名之前取：改完旧 id 就解析不到了，索引里查不出谁引用过它。
   * 当前打开的那篇走内存里的模型改，其余直接改文件；改完立刻更新索引，
   * 反链面板不必等下一轮轮询。
   */
  const withLinkRewrite = async (id: string, act: () => Promise<string | null>) => {
    const sources = links.index.backlinks(id).map((b) => b.from);
    const oldRefs = refsRef.current;
    const nextId = await act();
    if (!nextId || nextId === id || !sources.length) return nextId;

    // 判断新名字是否和别的笔记重名，要用改名之后的清单
    const newRefs = oldRefs.map((r) =>
      r.id === id ? { ...r, id: nextId, title: baseOf(nextId), dir: dirOf(nextId) } : r,
    );
    let notes = 0;
    let total = 0;
    for (const from of sources) {
      const rewrite = (target: string) =>
        resolveNoteLink(target, oldRefs, dirOf(from)) === id ? nextLinkTarget(target, nextId, newRefs) : null;
      try {
        if (from === activeIdRef.current) {
          let count = 0;
          book.update((d) => {
            for (const c of d.cells) {
              if (c.type !== 'md') continue;
              const r = rewriteNoteLinks(c.source, rewrite);
              if (r.count) {
                c.source = r.text;
                count += r.count;
              }
            }
          });
          if (count) {
            notes += 1;
            total += count;
          }
          continue;
        }
        if (!setup.store.readRaw || !setup.store.writeRaw) continue;
        const raw = await setup.store.readRaw(from);
        const r = rewriteNoteLinks(raw, rewrite);
        if (!r.count) continue;
        await setup.store.writeRaw(from, r.text);
        links.touch(from, r.text);
        notes += 1;
        total += r.count;
      } catch (e) {
        debug.warn('links', '改写链接失败', { from, error: String((e as Error)?.message ?? e) });
      }
    }
    debug.log('links', '改名后改写链接', { from: id, to: nextId, notes, links: total });
    if (notes) setNotice({ text: `已更新 ${notes} 篇笔记里的 ${total} 处链接，指向「${baseOf(nextId)}」` });
    return nextId;
  };

  const renameWithLinks = (id: string, title: string) =>
    withLinkRewrite(id, () => book.renameNotebook(id, title));
  const moveWithLinks = (id: string, dir: string) => withLinkRewrite(id, () => book.moveNotebook(id, dir));

  /** 打开文件夹页。当前笔记没存上就不切，和切换笔记是同一个规矩 */
  const openFolder = async (dir: string) => {
    if (!(await book.leaveCurrent())) return;
    debug.log('nav', '打开文件夹页', { dir: dir || '（笔记库根）' });
    setFolderView(dir);
    setEditingId(null);
    setActiveCellId(null);
    expandToDir(dir);
  };

  /** 所有打开笔记的入口都走这里：真打开了才离开文件夹页 */
  const openNote = async (id: string) => {
    setEditingId(null);
    if (await book.open(id)) setFolderView(null);
  };

  const createNote = async (title: string, dir = '') => {
    if (await book.createNotebook(title, dir)) setFolderView(null);
  };

  /** 把正在拖的笔记放进某个文件夹：侧栏和文件夹页共用 */
  const dropNoteInto = (dir: string) => {
    if (dragNoteId) void moveWithLinks(dragNoteId, dir);
    setDragNoteId(null);
    setDropDir(null);
  };

  const askCreateFolder = (dir: string) => {
    void askUser({
      title: '新建文件夹',
      input: { label: '名称', value: '新文件夹' },
      confirmLabel: '创建',
    }).then((name) => {
      if (name) void book.createFolder(joinId(dir, name));
    });
  };

  // 正在看的文件夹被删了（应用里或应用外）：退到还在的上一级
  useEffect(() => {
    if (!folderView || book.folders.includes(folderView)) return;
    // 列表还没读出来时什么都判断不了
    if (!book.refs.length && !book.folders.length) return;
    let up = dirOf(folderView);
    while (up && !book.folders.includes(up)) up = dirOf(up);
    debug.warn('nav', '文件夹已不存在，退到上一级', { from: folderView, to: up || '（笔记库根）' });
    setFolderView(up);
  }, [folderView, book.folders, book.refs.length]);

  return (
    <div className="nx-app" data-collapsed={sidebarCollapsed}>
      <aside className="nx-sidebar" data-collapsed={sidebarCollapsed}>
        <div className="nx-brand">
          <div className="nx-brand-name">NoteX</div>
          <div className="nx-brand-sub">可执行笔记</div>
          <span style={{ flex: 1 }} />
          <SidebarToggle collapsed={false} onToggle={() => setSidebarCollapsed(true)} />
        </div>

        <button
          className="nx-new-note"
          title="在笔记库根目录新建（想放进某个文件夹就右键那个文件夹）"
          onClick={() => void createNote('未命名笔记')}
        >
          ＋ 新建笔记
        </button>

        <div className="nx-section-label nx-section-head">
          <button
            className="nx-section-link"
            data-active={folderView === ''}
            title="打开笔记库"
            onClick={() => void openFolder('')}
          >
            我的笔记
          </button>
          <button
            className="nx-icon-btn"
            title="搜索笔记（⌘K）"
            aria-label="搜索笔记"
            onClick={() => setSearchOpen(true)}
          >
            ⌕
          </button>
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
            activeId={folderView === null ? book.activeId : null}
            activeDir={folderView}
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
            onOpenFolder={(dir) => void openFolder(dir)}
            onOpen={(id) => void openNote(id)}
            onNoteMenu={openNoteMenu}
            renamingId={renamingId}
            onRenamingChange={setRenamingId}
            onRename={(id, title) => void renameWithLinks(id, title)}
            onFolderMenu={openFolderMenu}
            onDragStart={setDragNoteId}
            onDragEnd={() => {
              setDragNoteId(null);
              setDropDir(null);
            }}
            onDragOverDir={setDropDir}
            onDropTo={dropNoteInto}
          />
        </div>


        <div className="nx-sidebar-foot">
          <RuntimeStrip onMenu={openRuntimeMenu} />
          <div className="nx-vault-line">
            <button
              className="nx-vault-name"
              data-kind={setup.store.kind}
              title={vaultTip}
              onClick={() => (setup.store.kind === 'vault' ? void openFolder('') : setSettingsOpen(true))}
            >
              <FolderIcon size={14} />
              <span>{vaultName}</span>
            </button>
            <span style={{ flex: 1 }} />
            <button className="nx-icon-btn" title="设置" aria-label="打开设置" onClick={() => setSettingsOpen(true)}>
              <GearIcon />
            </button>
          </div>
        </div>
      </aside>

      <main className="nx-main">
        <div className="nx-page">
          <div className="nx-topbar">
            {sidebarCollapsed && <SidebarToggle collapsed onToggle={() => setSidebarCollapsed(false)} />}
            {folderView !== null ? (
              <Breadcrumb dir={folderView} onOpenFolder={(dir) => void openFolder(dir)} />
            ) : (
              nb &&
              book.activeId && (
                <Breadcrumb
                  dir={dirOf(book.activeId)}
                  current={nb.title || baseOf(book.activeId)}
                  onOpenFolder={(dir) => void openFolder(dir)}
                />
              )
            )}
            <span style={{ flex: 1 }} />
            {/* 文件夹页上没有要保存的东西 */}
            {folderView === null && nb && (
              <span className="nx-save-state" data-kind={saveState.kind} title={setup.vaultPath}>
                <span className="nx-save-dot" />
                {saveState.text}
              </span>
            )}
          </div>
          {notice && (
            <div className="nx-banner" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span>{notice.text}</span>
              {notice.action && (
                <>
                  <span style={{ flex: 1 }} />
                  <button className="nx-btn-mini" onClick={notice.action.run}>
                    {notice.action.label}
                  </button>
                </>
              )}
            </div>
          )}
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

          {folderView !== null ? (
            <FolderPage
              dir={folderView}
              notes={book.refs}
              folders={book.folders}
              summaryOf={links.summaryOf}
              canCreateFolder={depthOf(folderView) < MAX_DIR_DEPTH}
              onOpenNote={(id) => void openNote(id)}
              onOpenFolder={(dir) => void openFolder(dir)}
              onCreateNote={(dir) => void createNote('未命名笔记', dir)}
              onCreateFolder={askCreateFolder}
              onFolderMenu={openFolderMenu}
              onNoteMenu={openNoteMenu}
              onDragStart={setDragNoteId}
              onDragEnd={() => {
                setDragNoteId(null);
                setDropDir(null);
              }}
              onDropNote={dropNoteInto}
            />
          ) : !nb ? (
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
                onBlur={(e) => {
                  const id = activeIdRef.current;
                  if (id) void withLinkRewrite(id, () => book.retitle(e.target.value));
                }}
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
                        book.update(ops.setLang(activeCell.id, l.id), { record: true });
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
                            book.update(ops.clearOutputs(), { record: true });
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
                <CellBoundary index={i}>
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
                  onMenu={(x, y, align) => openCellMenu(cell.id, x, y, align)}
                  dropActive={!!dragId && dropId === cell.id}
                  onSource={(v) => book.update(ops.setSource(cell.id, v), { group: cell.id })}
                  onLang={(l) => book.update(ops.setLang(cell.id, l), { record: true })}
                  onRun={() => void runCell(cell.id)}
                  onInterrupt={() => {
                    const lang = isCode(cell) ? cell.lang : 'java';
                    void registry.get(lang).session?.interrupt();
                  }}
                  onRemove={() => removeCell(cell.id)}
                  copied={copiedId === cell.id}
                  onCopy={() => void copyCell(cell.id)}
                  onEdit={() => setEditingId(cell.id)}
                  onDoneEdit={() => setEditingId(null)}
                  onDragStart={() => setDragId(cell.id)}
                  onDragEnd={() => {
                    setDragId(null);
                    setDropId(null);
                  }}
                  onDragOver={() => dragId && setDropId(cell.id)}
                  onDrop={() => {
                    if (dragId && dragId !== cell.id) book.update(ops.move(dragId, cell.id), { record: true });
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
                  onOpenSettings={() => setSettingsOpen(true, 'runtime')}
                  onRichPaste={richPaste.importClipboard}
                  resolveImage={richPaste.resolveImage}
                />
                </CellBoundary>
                </div>
              ))}

              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  if (dragId) setDropId('end');
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  if (dragId) book.update(ops.move(dragId, 'end'), { record: true });
                  setDragId(null);
                  setDropId(null);
                }}
              >
                <div className="nx-dropline" data-active={!!dragId && dropId === 'end'} />
                {nb.cells.length === 0 && (
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
                )}
              </div>

              <Backlinks
                backlinks={links.backlinksOf(book.activeId)}
                ready={links.ready}
                onOpen={(id) => void openNote(id)}
              />
            </>
          )}
        </div>
      </main>

      {shortcutsOpen && <Shortcuts onClose={() => setShortcutsOpen(false)} />}
      {searchOpen && (
        <SearchPalette
          notes={book.refs}
          ready={links.ready}
          search={links.search}
          onOpen={(id) => void openNote(id)}
          onClose={() => setSearchOpen(false)}
        />
      )}
      {ask && <AskModal state={ask} />}
      {menu && <ContextMenu state={menu} onClose={() => setMenu(null)} />}

      {settingsOpen && (
        <SettingsModal
          setup={setup}
          initialTab={settingsTab ?? undefined}
          onVaultChanged={onVaultChanged}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}
