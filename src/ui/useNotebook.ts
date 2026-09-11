import { useCallback, useEffect, useRef, useState } from 'react';
import { debug } from '@core/debug';
import {
  type Cell,
  type LangId,
  type Notebook,
  type Output,
  isCode,
  newCodeCell,
  newMarkdownCell,
} from '@core/model';
import { codeToFence, fenceToCode, notebookToMarkdown } from '@core/serialize';
import type { NotebookRef, NotebookStore } from '@core/store/index';
import { dirOf } from '@core/store/paths';
import { WELCOME_TITLE, welcomeCells } from '@core/welcome';

/** 一次写盘的结果。调用方要能区分"存好了"和"没存成" */
export type SaveResult = 'saved' | 'nothing' | 'conflict' | 'error' | 'missing';

/** 刚落盘的内容，供链接索引即时更新 */
interface LastSaved {
  id: string;
  markdown: string;
  at: number;
}

const SAVE_DEBOUNCE_MS = 500;
const WATCH_INTERVAL_MS = 2000;
/** 结构操作的撤销深度。五十步足够找回一次误删，再多只是占内存 */
const HISTORY_MAX = 50;

export interface UpdateOptions {
  /** 跳过防抖立即写盘 */
  immediate?: boolean;
  /**
   * 记入撤销栈。只给结构操作用（删除、移动、转换、换语言、插入），
   * 打字不记：编辑器自己有撤销，两套栈叠在一起会互相打架。
   */
  record?: boolean;
}

/**
 * 把快照恢复回来时保留当前各 cell 的源码与输出。
 * 撤销「删除 B」时用户可能已经在 A 里又写了几行，那些不该跟着消失；
 * 快照只负责结构：有哪些 cell、什么顺序、什么类型和语言。
 */
function mergeSnapshot(snapshot: Notebook, current: Notebook): Notebook {
  const live = new Map(current.cells.map((c) => [c.id, c]));
  return {
    ...current,
    cells: snapshot.cells.map((c) => {
      const cur = live.get(c.id);
      if (!cur) return { ...c };
      if (c.type === 'code' && cur.type === 'code') {
        return { ...c, source: cur.source, outputs: cur.outputs, ranWith: cur.ranWith };
      }
      return { ...c, source: cur.source };
    }),
  };
}

/**
 * 管理笔记列表与当前打开的笔记，并把改动防抖写回存储。
 * 组件只调用这里暴露的操作，不直接碰存储。
 */
export function useNotebook(store: NotebookStore | null) {
  const [refs, setRefs] = useState<NotebookRef[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [nb, setNb] = useState<Notebook | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 文件在外部被改动，且本地有未保存改动时提示用户抉择 */
  const [conflict, setConflict] = useState(false);
  /** 当前这篇的文件在应用之外被删掉了 */
  const [missingFile, setMissingFile] = useState(false);
  /** 最近一次成功写盘，链接索引靠它即时跟上，不必等下一轮轮询 */
  const [lastSaved, setLastSaved] = useState<LastSaved | null>(null);
  /**
   * 有改动还没落盘。dirty 本来只是个 ref，界面读不到——
   * 而"已保存"这个指示只有在它可信时才有意义，所以单独出一份 state。
   */
  const [hasUnsaved, setHasUnsaved] = useState(false);

  const nbRef = useRef<Notebook | null>(null);
  nbRef.current = nb;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 严格模式下 effect 会跑两遍，初始化必须只做一次 */
  const initialized = useRef<NotebookStore | null>(null);
  /** 有尚未写盘的本地改动 */
  const dirty = useRef(false);
  /**
   * 改动的代数。写盘是异步的，写的是开始时的快照；写盘期间再敲的字
   * 只在 dirty 上留了个 true，写完后一句 dirty = false 就把它抹掉了——
   * 那几个字留在内存里，界面却显示「已保存」，切走就丢。
   * 所以写盘前记下代数，写完只在代数没变时才算干净。
   */
  const generation = useRef(0);
  /** 结构操作的撤销栈；换笔记时清空，它只对当前这篇有意义 */
  const history = useRef<{ past: Notebook[]; future: Notebook[] }>({ past: [], future: [] });
  const [historyRev, setHistoryRev] = useState(0);
  /** 回调里要读最新的选中项，state 会被闭包捕获成旧值 */
  const activeIdRef = useRef<string | null>(null);
  const missingFileRef = useRef(false);

  activeIdRef.current = activeId;
  missingFileRef.current = missingFile;

  /** 列举笔记与目录；只有落盘的实现有目录概念 */
  const listBoth = useCallback(async () => {
    if (!store) return { notes: [] as NotebookRef[], folders: [] as string[] };
    if (store.listAll) return await store.listAll();
    return { notes: await store.list(), folders: [] as string[] };
  }, [store]);

  const refresh = useCallback(async () => {
    const { notes, folders: dirs } = await listBoth();
    setRefs(notes);
    setFolders(dirs);
    return notes;
  }, [listBoth]);

  /**
   * 写盘。写之前先确认文件没被别处改过，
   * 否则宁可停下来问用户，也不能覆盖掉外部写入的内容。
   * force 用于用户明确选择"用我的版本覆盖"。
   *
   * 返回值必须让调用方能判断"到底存进去没有"：以前它什么都不返回，
   * 冲突和异常都只是默默 return，切换笔记的路径照样往下走，
   * 于是没存下的改动被新加载的笔记直接顶掉。
   */
  const flush = useCallback(
    async (force = false): Promise<SaveResult> => {
      const nb = nbRef.current;
      if (!store || !nb) return 'nothing';
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      // 没有改动就不写盘。以前这里不看改动，每次切走一篇笔记都会把它原样重写一遍：
      // 修改时间跟着变，「最近更新」就成了「最近看过」，Git 也会看到一堆假改动；
      // 文件在外部被动过时，一篇没改的笔记切走也会弹冲突提示
      if (!force && !dirty.current) return 'nothing';
      if (!force && missingFileRef.current) {
        // 文件已被外部删除，自动保存不该把它悄悄复活
        debug.warn('save', '文件已在外部删除，跳过保存', { id: nb.id });
        return 'missing';
      }
      if (!force && store.changedOutside) {
        try {
          if (await store.changedOutside(nb.id)) {
            debug.warn('save', '文件在外部被改过，转为冲突提示', { id: nb.id });
            setConflict(true);
            return 'conflict';
          }
        } catch {
          // 探测失败不阻塞保存
        }
      }
      setSaving(true);
      const saved = generation.current;
      try {
        await debug.op('save', '写盘', () => store.save(nb), { id: nb.id, cells: nb.cells.length });
        if (generation.current === saved) {
          dirty.current = false;
          setHasUnsaved(false);
        } else {
          // 写盘期间又有改动：scheduleSave 已经排好下一次，这里只是不能把它标成干净
          debug.log('save', '写盘期间有新改动，保持待保存', { id: nb.id });
        }
        setConflict(false);
        setError(null);
        // 存成功了才更新链接索引，索引反映的是磁盘上的内容
        setLastSaved({ id: nb.id, markdown: notebookToMarkdown(nb), at: Date.now() });
        return 'saved';
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
        return 'error';
      } finally {
        setSaving(false);
      }
    },
    [store],
  );

  /**
   * 切换笔记前先确认当前这篇已经安全落盘。
   * 没存成功又确实有改动时，宁可不切——切过去就再也找不回来了。
   */
  const leaveCurrent = useCallback(async (): Promise<boolean> => {
    const result = await flush();
    if (result === 'saved' || result === 'nothing') return true;
    if (!dirty.current) return true;
    debug.warn('note', '当前笔记未保存，暂停切换', { result, id: nbRef.current?.id });
    setError(
      result === 'conflict'
        ? '这篇笔记的文件在外部被改过，未保存的改动还留在这里。请先选择保留哪一份，再切换笔记。'
        : '这篇笔记没有保存成功，未保存的改动还留在这里。请先处理保存错误，再切换笔记。',
    );
    return false;
  }, [flush]);

  const scheduleSave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    dirty.current = true;
    generation.current += 1;
    setHasUnsaved(true);
    timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }, [flush]);

  /** 丢弃内存里的改动，重新从磁盘读 */
  const reloadFromDisk = useCallback(async () => {
    if (!store || !activeId) return;
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    dirty.current = false;
    setHasUnsaved(false);
    const loaded = await debug.op('note', '从磁盘重新读取', () => store.load(activeId), { id: activeId });
    if (loaded) {
      nbRef.current = loaded;
      setNb(loaded);
    }
    setConflict(false);
  }, [store, activeId]);

  const resetHistory = useCallback(() => {
    history.current = { past: [], future: [] };
    setHistoryRev((r) => r + 1);
  }, []);

  /**
   * 所有改动的唯一入口：克隆、应用、落库。
   * 以 nbRef 为准同步计算，而不是放进 setState 的更新函数里：
   * 记撤销栈是副作用，严格模式下更新函数会跑两遍。
   */
  const update = useCallback(
    (fn: (draft: Notebook) => void, opts: UpdateOptions = {}) => {
      const current = nbRef.current;
      if (!current) return;
      if (opts.record) {
        const h = history.current;
        h.past.push(current);
        if (h.past.length > HISTORY_MAX) h.past.shift();
        h.future = [];
        setHistoryRev((r) => r + 1);
      }
      const draft: Notebook = { ...current, cells: current.cells.map((c) => ({ ...c })) };
      fn(draft);
      draft.updated = new Date().toISOString();
      nbRef.current = draft;
      setNb(draft);
      if (opts.immediate) {
        // 立即保存不经过 scheduleSave，这里得自己标上"有改动"，否则 flush 会当成没改而跳过
        dirty.current = true;
        generation.current += 1;
        setHasUnsaved(true);
        void flush();
      } else {
        scheduleSave();
      }
    },
    [flush, scheduleSave],
  );

  /** 撤销上一步结构操作。返回是否真的撤销了什么 */
  const undo = useCallback((): boolean => {
    const current = nbRef.current;
    const prev = history.current.past.pop();
    if (!current || !prev) return false;
    history.current.future.push(current);
    const restored = mergeSnapshot(prev, current);
    restored.updated = new Date().toISOString();
    nbRef.current = restored;
    setNb(restored);
    setHistoryRev((r) => r + 1);
    scheduleSave();
    debug.log('note', '撤销', { id: current.id, remaining: history.current.past.length });
    return true;
  }, [scheduleSave]);

  const redo = useCallback((): boolean => {
    const current = nbRef.current;
    const next = history.current.future.pop();
    if (!current || !next) return false;
    history.current.past.push(current);
    const restored = mergeSnapshot(next, current);
    restored.updated = new Date().toISOString();
    nbRef.current = restored;
    setNb(restored);
    setHistoryRev((r) => r + 1);
    scheduleSave();
    return true;
  }, [scheduleSave]);

  /**
   * 把改动应用到指定的那篇笔记。
   *
   * 运行是异步的，跑完时用户可能已经切走了。以前一律写"当前笔记"，
   * 结果轻则输出丢失，重则写进另一篇同 cell id 的笔记。
   */
  const updateNote = useCallback(
    async (id: string, fn: (draft: Notebook) => void) => {
      if (activeIdRef.current === id && nbRef.current) {
        update(fn);
        return;
      }
      if (!store) return;
      const loaded = await store.load(id);
      if (!loaded) return debug.warn('note', '结果无处安放：笔记已不在', { id });
      fn(loaded);
      loaded.updated = new Date().toISOString();
      await debug.op('save', '把结果写进已切走的笔记', () => store.save(loaded), { id });
    },
    [store, update],
  );

  const open = useCallback(
    /**
     * 返回是否真的打开了：当前笔记没存上会被拦下，调用方据此决定要不要切页面。
     * skipFlush 用于改名/移动——文件已经迁走了，旧身份不能再写回磁盘。
     */
    async (id: string, opts: { skipFlush?: boolean } = {}): Promise<boolean> => {
      if (!store) return false;
      if (!opts.skipFlush && !(await leaveCurrent())) return false;
      const loaded = await debug.op('note', '打开笔记', () => store.load(id), { id });
      if (loaded) {
        nbRef.current = loaded;
        setNb(loaded);
        setActiveId(id);
        resetHistory();
        setError(null);
        setConflict(false);
        setMissingFile(false);
        dirty.current = false;
        setHasUnsaved(false);
        return true;
      }
      debug.error('note', '打不开笔记', { id });
      setError(`打不开笔记：${id}`);
      return false;
    },
    [store, leaveCurrent, resetHistory],
  );

  // 初次加载：列出笔记，打开第一篇；空 vault 则建一篇。
  // 严格模式会挂载两次，这里用 ref 保证只跑一次，因此不再用 cancelled 标记
  // 取消状态更新，否则第一次会被清理函数取消、第二次又被守卫拦下，结果什么都不加载。
  useEffect(() => {
    if (!store || initialized.current === store) return;
    initialized.current = store;
    void (async () => {
      try {
        const { notes: list, folders: dirs } = await listBoth();
        setRefs(list);
        setFolders(dirs);
        if (list.length) {
          const loaded = await store.load(list[0].id);
          nbRef.current = loaded;
          setNb(loaded);
          setActiveId(list[0].id);
        } else {
          // 空笔记库：欢迎笔记要带上能跑的示例，一篇空白页教不会任何人
          const created = await store.create(WELCOME_TITLE);
          created.cells = welcomeCells();
          await store.save(created);
          nbRef.current = created;
          setNb(created);
          setActiveId(created.id);
          await refresh();
        }
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  /**
   * 检查笔记库与内存是否一致：目录里有哪些笔记，当前这篇是否被改动或删除。
   * 目录是唯一事实来源，应用只是展示它。
   */
  const checkExternal = useCallback(async () => {
    if (!store) return;
    try {
      const { notes: list, folders: dirs } = await listBoth();
      setRefs((prev) => {
        // 必须连修改时间一起比。只比 id 的话，改完正文文件集合没变，
        // refs 就原样留着，链接索引靠 updated 判断增量，于是永远不刷新
        const same =
          prev.length === list.length &&
          prev.every((r, i) => r.id === list[i].id && r.updated === list[i].updated);
        return same ? prev : list;
      });
      setFolders((prev) => {
        const same = prev.length === dirs.length && prev.every((d, i) => d === dirs[i]);
        return same ? prev : dirs;
      });

      const active = activeIdRef.current;
      if (!active) return;

      const stillThere = list.some((r) => r.id === active);
      setMissingFile(!stillThere);
      if (!stillThere || !store.changedOutside) return;

      // 文件还在但内容变了：没有本地改动就直接读回来，
      // 有的话交给用户决定，绝不静默覆盖别处写入的内容
      if (await store.changedOutside(active)) {
        if (dirty.current) setConflict(true);
        else await reloadFromDisk();
      }
    } catch {
      // 目录临时读不到，等下一轮
    }
  }, [store, listBoth, reloadFromDisk]);

  useEffect(() => {
    if (!store) return;
    const timerId = setInterval(() => void checkExternal(), WATCH_INTERVAL_MS);
    // 窗口在后台时浏览器会把定时器降频，切回来要立刻对一次，
    // 否则用户在别处改完文件回到应用还会看到旧状态
    const onBack = () => {
      if (document.visibilityState === 'visible') void checkExternal();
    };
    window.addEventListener('focus', onBack);
    document.addEventListener('visibilitychange', onBack);
    return () => {
      clearInterval(timerId);
      window.removeEventListener('focus', onBack);
      document.removeEventListener('visibilitychange', onBack);
    };
  }, [store, checkExternal]);

  // 关页面前把没写完的改动落盘
  useEffect(() => {
    const onUnload = () => {
      if (timer.current) void flush();
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      if (timer.current) void flush();
    };
  }, [flush]);

  const createNotebook = useCallback(
    async (title: string, dir = '') => {
      if (!store) {
        debug.warn('note', '新建笔记：没有存储，忽略', { title, dir });
        return false;
      }
      debug.log('note', '新建笔记', { title, dir });
      if (!(await leaveCurrent())) return false;
      const created = await store.create(title, dir);
      nbRef.current = created;
      setNb(created);
      setActiveId(created.id);
      setMissingFile(false);
      resetHistory();
      await refresh();
      return true;
    },
    [store, leaveCurrent, refresh, resetHistory],
  );

  const createFolder = useCallback(
    async (dir: string) => {
      if (!store?.createFolder) return debug.warn('folder', '新建文件夹：当前存储不支持', { dir });
      try {
        await debug.op('folder', '新建文件夹', () => store.createFolder!(dir), { dir });
        await refresh();
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      }
    },
    [store, refresh],
  );

  /** 改笔记名：只改文件名，留在原目录。返回新 id，没改成返回 null */
  const renameNotebook = useCallback(
    async (id: string, title: string): Promise<string | null> => {
      if (!store) return null;
      const wasActive = id === activeIdRef.current;
      if (wasActive && !(await leaveCurrent())) return null;
      try {
        const nextId = await debug.op('note', '重命名笔记', () => store.retitle(id, title), { id, title });
        await refresh();
        // 前面已经存过一次，文件也改好名了。这里必须跳过 open() 里的写盘：
        // 内存副本的 id 还是旧的，再存一次会把刚改名的文件原样复活出来
        if (wasActive) await open(nextId, { skipFlush: true });
        return nextId;
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
        return null;
      }
    },
    [store, leaveCurrent, refresh, open],
  );

  const removeFolder = useCallback(
    async (dir: string) => {
      if (!store?.removeFolder) return;
      const active = activeIdRef.current;
      // 当前笔记在被删的目录里时，先丢弃内存副本，避免被写回复活
      if (active && (active === dir || active.startsWith(dir + '/'))) {
        if (timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
        }
        dirty.current = false;
        nbRef.current = null;
        setNb(null);
        setActiveId(null);
      }
      try {
        await debug.op('folder', '删除文件夹', () => store.removeFolder!(dir), { dir });
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
        return;
      }
      const list = await refresh();
      if (!activeIdRef.current) {
        if (list.length) await open(list[0].id);
        else await createNotebook('未命名笔记');
      }
    },
    [store, refresh, open, createNotebook],
  );

  /** 把笔记移到另一个目录。返回新 id，没动返回 null */
  const moveNotebook = useCallback(
    async (id: string, targetDir: string): Promise<string | null> => {
      if (!store?.move) return null;
      if (dirOf(id) === targetDir) return null;
      const wasActive = id === activeIdRef.current;
      if (wasActive && !(await leaveCurrent())) return null;
      try {
        const nextId = await debug.op('note', '移动笔记', () => store.move!(id, targetDir), { id, targetDir });
        await refresh();
        // 同重命名：旧路径的文件已经不在了，不能再写回去
        if (wasActive) await open(nextId, { skipFlush: true });
        return nextId;
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
        return null;
      }
    },
    [store, leaveCurrent, refresh, open],
  );

  const removeNotebook = useCallback(
    async (id: string) => {
      if (!store) return;
      // 删的是当前这篇时，必须先取消待写盘的改动并清空内存副本。
      // 否则接下来切换笔记时的 flush 会把刚删掉的内容原样写回磁盘。
      if (id === activeIdRef.current) {
        if (timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
        }
        dirty.current = false;
        nbRef.current = null;
        setNb(null);
      }
      try {
        await debug.op('note', '删除笔记', () => store.remove(id), { id });
      } catch (e) {
        setError(`删除失败：${String((e as Error)?.message ?? e)}`);
        return;
      }
      const list = await refresh();
      if (id === activeIdRef.current) {
        setActiveId(null);
        if (list.length) await open(list[0].id);
        else await createNotebook('未命名笔记');
      }
    },
    [store, open, createNotebook, refresh],
  );

  /** 标题栏里改名。返回新 id；文件名没变时返回原 id */
  const retitle = useCallback(
    async (title: string): Promise<string | null> => {
      if (!store || !nbRef.current || !activeId) return null;
      update((d) => void (d.title = title));
      await flush();
      const nextId = await store.retitle(activeId, title);
      if (nextId !== activeId) {
        setActiveId(nextId);
        const reloaded = await store.load(nextId);
        if (reloaded) {
          nbRef.current = reloaded;
          setNb(reloaded);
        }
      }
      await refresh();
      return nextId;
    },
    [store, activeId, update, flush, refresh],
  );

  /** 导入来的笔记：写进存储再打开 */
  const adopt = useCallback(
    async (imported: Notebook) => {
      if (!store) return;
      await flush();
      const created = await store.create(imported.title);
      const merged: Notebook = { ...imported, id: created.id, title: created.title };
      await store.save(merged);
      nbRef.current = merged;
      setNb(merged);
      setActiveId(created.id);
      resetHistory();
      await refresh();
    },
    [store, flush, refresh, resetHistory],
  );

  return {
    refs,
    folders,
    createFolder,
    removeFolder,
    moveNotebook,
    updateNote,
    lastSaved,
    hasUnsaved,
    renameNotebook,
    activeId,
    nb,
    saving,
    error,
    conflict,
    missingFile,
    reloadFromDisk,
    keepMine: () => {
      setConflict(false);
      void flush(true);
    },
    open,
    /** 离开当前笔记前确认它已落盘；打开文件夹页时也要走这一步 */
    leaveCurrent,
    update,
    undo,
    redo,
    canUndo: history.current.past.length > 0,
    canRedo: history.current.future.length > 0,
    /** 撤销栈变化的计数，让 canUndo/canRedo 的读者跟着重渲染 */
    historyRev,
    flush,
    refresh,
    checkExternal,
    createNotebook,
    removeNotebook,
    retitle,
    adopt,
    setError,
  };
}

/** 单篇笔记上的常用改动，供 update() 调用 */
export const ops = {
  setSource: (id: string, source: string) => (d: Notebook) => {
    const c = d.cells.find((x) => x.id === id);
    if (c) c.source = source;
  },
  setLang: (id: string, lang: LangId) => (d: Notebook) => {
    const c = d.cells.find((x) => x.id === id);
    if (c && isCode(c)) c.lang = lang;
  },
  setOutputs: (id: string, outputs: Output[], lang: LangId) => (d: Notebook) => {
    const c = d.cells.find((x) => x.id === id);
    if (!c || !isCode(c)) return;
    c.outputs = outputs;
    c.ranWith = lang;
  },
  insert: (index: number | null, cell: Cell) => (d: Notebook) => {
    d.cells.splice(index == null ? d.cells.length : index, 0, cell);
  },
  remove: (id: string) => (d: Notebook) => {
    d.cells = d.cells.filter((c) => c.id !== id);
  },
  move: (dragId: string, targetId: string | 'end') => (d: Notebook) => {
    const from = d.cells.findIndex((c) => c.id === dragId);
    if (from < 0) return;
    const [cell] = d.cells.splice(from, 1);
    let to = targetId === 'end' ? d.cells.length : d.cells.findIndex((c) => c.id === targetId);
    if (to < 0) to = d.cells.length;
    d.cells.splice(to, 0, cell);
  },
  /**
   * 文本与代码互转。代码转文本时包上围栏，文本恰好是一段围栏时去掉围栏并认出语言：
   * 这样来回转不会把源码弄丢，也让「文本里的代码块只展示」有一条顺手的出路。
   */
  convert: (id: string, fallbackLang: LangId) => (d: Notebook) => {
    const i = d.cells.findIndex((c) => c.id === id);
    if (i < 0) return;
    const cell = d.cells[i];
    if (isCode(cell)) {
      d.cells[i] = { id: cell.id, type: 'md', source: cell.source.trim() ? codeToFence(cell.source, cell.lang) : '' };
      return;
    }
    const fenced = fenceToCode(cell.source);
    d.cells[i] = {
      id: cell.id,
      type: 'code',
      lang: fenced?.lang ?? fallbackLang,
      source: fenced ? fenced.code : cell.source,
      outputs: [],
    };
  },
  clearOutputs: () => (d: Notebook) => {
    for (const c of d.cells) {
      if (isCode(c)) {
        c.outputs = [];
        c.ranWith = undefined;
      }
    }
  },
};

export { newCodeCell, newMarkdownCell };
