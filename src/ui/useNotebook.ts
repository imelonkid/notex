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

const SAVE_DEBOUNCE_MS = 500;
const WATCH_INTERVAL_MS = 2000;

/**
 * 管理笔记列表与当前打开的笔记，并把改动防抖写回存储。
 * 组件只调用这里暴露的操作，不直接碰存储。
 */
export function useNotebook(store: NotebookStore | null) {
  const [refs, setRefs] = useState<NotebookRef[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [nb, setNb] = useState<Notebook | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 文件在外部被改动，且本地有未保存改动时提示用户抉择 */
  const [conflict, setConflict] = useState(false);

  const nbRef = useRef<Notebook | null>(null);
  nbRef.current = nb;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 严格模式下 effect 会跑两遍，初始化必须只做一次 */
  const initialized = useRef<NotebookStore | null>(null);
  /** 有尚未写盘的本地改动 */
  const dirty = useRef(false);

  const refresh = useCallback(async () => {
    if (!store) return [];
    const list = await store.list();
    setRefs(list);
    return list;
  }, [store]);

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
        const list = await store.list();
        setRefs(list);
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
          setRefs(await store.list());
        }
      } catch (e) {
        setError(String((e as Error)?.message ?? e));
      }
    })();
  }, [store]);

  /**
   * 轮询文件时间，发现外部改动。
   * 本地没有未保存改动就直接重新加载，有的话交给用户决定，
   * 绝不静默覆盖别处写入的内容。
   */
  useEffect(() => {
    if (!store?.changedOutside || !activeId) return;
    const id = setInterval(() => {
      void (async () => {
        try {
          if (!(await store.changedOutside!(activeId))) return;
          if (dirty.current) setConflict(true);
          else await reloadFromDisk();
        } catch {
          // 文件被删或临时读不到，等下一轮
        }
      })();
    }, WATCH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [store, activeId, reloadFromDisk]);

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
    async (title: string) => {
      if (!store) return;
      await flush();
      const created = await store.create(title);
      nbRef.current = created;
      setNb(created);
      setActiveId(created.id);
      setRefs(await store.list());
    },
    [store, flush],
  );

  const removeNotebook = useCallback(
    async (id: string) => {
      if (!store) return;
      await store.remove(id);
      const list = await store.list();
      setRefs(list);
      if (id === activeId) {
        if (list.length) await open(list[0].id);
        else await createNotebook('未命名笔记');
      }
    },
    [store, activeId, open, createNotebook],
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
      setRefs(await store.list());
    },
    [store, activeId, update, flush],
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
      setRefs(await store.list());
    },
    [store, flush],
  );

  return {
    refs,
    activeId,
    nb,
    saving,
    error,
    conflict,
    reloadFromDisk,
    keepMine: () => {
      setConflict(false);
      void flush(true);
    },
    open,
    update,
    flush,
    refresh,
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
