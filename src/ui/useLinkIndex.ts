import { useCallback, useEffect, useRef, useState } from 'react';
import { LinkIndex } from '@core/linkIndex';
import type { Backlink } from '@core/linkIndex';
import type { NotebookRef, NotebookStore } from '@core/store/index';

/**
 * 维护全库链接索引。
 *
 * 建索引要读每一篇笔记，所以放在后台分批做，先把界面显示出来。
 * 笔记列表变化时按修改时间增量更新，不整库重扫。
 */
export function useLinkIndex(store: NotebookStore | null, refs: NotebookRef[]) {
  const index = useRef(new LinkIndex());
  const [ready, setReady] = useState(false);
  /** 索引内容变化的计数，供组件重新取反链 */
  const [revision, setRevision] = useState(0);
  const building = useRef(false);

  const rebuild = useCallback(async () => {
    if (!store?.readRaw || building.current) return;
    building.current = true;
    try {
      const idx = index.current;
      idx.setNotes(refs);

      // 删掉的笔记要从索引里清掉，否则反链会指向不存在的来源
      let changed = idx.retain(new Set(refs.map((r) => r.id)));

      // 按修改时间增量更新，没变过的笔记不重读
      for (const ref of refs) {
        const stamp = ref.updated ?? '';
        if (idx.has(ref.id) && idx.stampOf(ref.id) === stamp) continue;
        try {
          idx.put(ref.id, await store.readRaw(ref.id), stamp);
          changed = true;
        } catch {
          // 单篇读不到不影响整体
        }
      }

      // 解析结果依赖笔记清单，清单一变就要重算
      idx.reresolve();
      if (changed || !ready) setRevision((r) => r + 1);
      setReady(true);
    } finally {
      building.current = false;
    }
  }, [store, refs, ready]);

  // 笔记列表变化就对一次索引，读文件是异步的，不阻塞界面
  useEffect(() => {
    void rebuild();
  }, [rebuild]);

  /** 某篇笔记刚保存，立刻更新它的出链，不必等下一轮 */
  const touch = useCallback(
    (id: string, markdown: string) => {
      index.current.put(id, markdown, '');
      setRevision((r) => r + 1);
    },
    [],
  );

  const backlinksOf = useCallback(
    (id: string | null): Backlink[] => (id ? index.current.backlinks(id) : []),
    // revision 变化时组件要重新取值
    [revision],
  );

  const isBroken = useCallback(
    (from: string | null, target: string): boolean => {
      if (!from) return false;
      const link = index.current.outLinks(from).find((l) => l.target === target);
      return link ? link.resolved === null : false;
    },
    [revision],
  );

  /** 列表页的摘要与语言；索引在后台建，没建到的笔记先返回 undefined */
  const summaryOf = useCallback(
    (id: string) => index.current.summaryOf(id),
    // revision 变化时组件要重新取值
    [revision],
  );

  return { ready, revision, backlinksOf, isBroken, summaryOf, touch, index: index.current };
}
