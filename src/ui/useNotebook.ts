import { useCallback, useEffect, useRef, useState } from 'react';
import {
  type Cell,
  type LangId,
  type Notebook,
  type Output,
  isCode,
  newCodeCell,
  newMarkdownCell,
} from '@core/model';
import type { NotebookRef, NotebookStore } from '@core/store/index';
import { dirOf } from '@core/store/paths';

const SAVE_DEBOUNCE_MS = 500;
const WATCH_INTERVAL_MS = 2000;

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

  const nbRef = useRef<Notebook | null>(null);
  nbRef.current = nb;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 严格模式下 effect 会跑两遍，初始化必须只做一次 */
  const initialized = useRef<NotebookStore | null>(null);
  /** 有尚未写盘的本地改动 */
  const dirty = useRef(false);
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
   */
  const flush = useCallback(
    async (force = false) => {
      const nb = nbRef.current;
      if (!store || !nb) return;
      if (timer.current) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      if (!force && missingFileRef.current) {
        // 文件已被外部删除，自动保存不该把它悄悄复活
        return;
      }
      if (!force && store.changedOutside) {
        try {
          if (await store.changedOutside(nb.id)) {
            setConflict(true);
            return;
          }
        } catch {
          // 探测失败不阻塞保存
        }
      }
      setSaving(true);
      try {
        await store.save(nb);
        dirty.current = false;
        setConflict(false);
        setError(null);
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      } finally {
        setSaving(false);
      }
    },
    [store],
  );

  const scheduleSave = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    dirty.current = true;
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
    const loaded = await store.load(activeId);
    if (loaded) {
      nbRef.current = loaded;
      setNb(loaded);
    }
    setConflict(false);
  }, [store, activeId]);

  /** 所有改动的唯一入口：克隆、应用、落库 */
  const update = useCallback(
    (fn: (draft: Notebook) => void, immediate = false) => {
      setNb((current) => {
        if (!current) return current;
        const draft: Notebook = { ...current, cells: current.cells.map((c) => ({ ...c })) };
        fn(draft);
        draft.updated = new Date().toISOString();
        nbRef.current = draft;
        return draft;
      });
      if (immediate) void flush();
      else scheduleSave();
    },
    [flush, scheduleSave],
  );

  const open = useCallback(
    async (id: string) => {
      if (!store) return;
      await flush();
      const loaded = await store.load(id);
      if (loaded) {
        nbRef.current = loaded;
        setNb(loaded);
        setActiveId(id);
        setError(null);
        setConflict(false);
        setMissingFile(false);
        dirty.current = false;
      } else {
        setError(`打不开笔记：${id}`);
      }
    },
    [store, flush],
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
          const created = await store.create('欢迎使用 NoteX');
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
        const same = prev.length === list.length && prev.every((r, i) => r.id === list[i].id);
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
      if (!store) return;
      await flush();
      const created = await store.create(title, dir);
      nbRef.current = created;
      setNb(created);
      setActiveId(created.id);
      setMissingFile(false);
      await refresh();
    },
    [store, flush, refresh],
  );

  const createFolder = useCallback(
    async (dir: string) => {
      if (!store?.createFolder) return;
      try {
        await store.createFolder(dir);
        await refresh();
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      }
    },
    [store, refresh],
  );

  /** 改笔记名：只改文件名，留在原目录 */
  const renameNotebook = useCallback(
    async (id: string, title: string) => {
      if (!store) return;
      const wasActive = id === activeIdRef.current;
      if (wasActive) await flush();
      try {
        const nextId = await store.retitle(id, title);
        await refresh();
        if (wasActive) await open(nextId);
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      }
    },
    [store, flush, refresh, open],
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
        await store.removeFolder(dir);
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

  /** 把笔记移到另一个目录 */
  const moveNotebook = useCallback(
    async (id: string, targetDir: string) => {
      if (!store?.move) return;
      if (dirOf(id) === targetDir) return;
      const wasActive = id === activeIdRef.current;
      if (wasActive) await flush();
      try {
        const nextId = await store.move(id, targetDir);
        await refresh();
        if (wasActive) await open(nextId);
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      }
    },
    [store, flush, refresh, open],
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
        await store.remove(id);
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

  const retitle = useCallback(
    async (title: string) => {
      if (!store || !nbRef.current || !activeId) return;
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
      await refresh();
    },
    [store, flush, refresh],
  );

  return {
    refs,
    folders,
    createFolder,
    removeFolder,
    moveNotebook,
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
    update,
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
  setOutputs:
    (id: string, outputs: Output[], lang: LangId, bumpExec: boolean) => (d: Notebook) => {
      const c = d.cells.find((x) => x.id === id);
      if (!c || !isCode(c)) return;
      c.outputs = outputs;
      c.ranWith = lang;
      if (bumpExec) {
        d.counter += 1;
        c.execN = d.counter;
      }
    },
  insert: (index: number | null, cell: Cell) => (d: Notebook) => {
    d.cells.splice(index == null ? d.cells.length : index, 0, cell);
  },
  remove: (id: string) => (d: Notebook) => {
    d.cells = d.cells.filter((c) => c.id !== id);
    if (!d.cells.length) d.cells.push(newMarkdownCell(''));
  },
  move: (dragId: string, targetId: string | 'end') => (d: Notebook) => {
    const from = d.cells.findIndex((c) => c.id === dragId);
    if (from < 0) return;
    const [cell] = d.cells.splice(from, 1);
    let to = targetId === 'end' ? d.cells.length : d.cells.findIndex((c) => c.id === targetId);
    if (to < 0) to = d.cells.length;
    d.cells.splice(to, 0, cell);
  },
  clearOutputs: () => (d: Notebook) => {
    for (const c of d.cells) {
      if (isCode(c)) {
        c.outputs = [];
        c.execN = undefined;
        c.ranWith = undefined;
      }
    }
    d.counter = 0;
  },
};

export { newCodeCell, newMarkdownCell };
