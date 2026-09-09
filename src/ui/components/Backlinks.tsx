import { useState } from 'react';
import type { Backlink } from '@core/linkIndex';
import { baseOf, dirOf } from '@core/store/paths';

interface Props {
  backlinks: Backlink[];
  ready: boolean;
  onOpen(id: string): void;
}

/** 谁引用了这篇笔记。默认收起，避免占据正文视线。 */
export function Backlinks({ backlinks, ready, onOpen }: Props) {
  const [open, setOpen] = useState(false);

  // 索引还没建完时不显示"0 条"，那会让人误以为真的没有
  if (!ready) return null;

  return (
    <div className="nx-backlinks">
      <button className="nx-backlinks-head" onClick={() => setOpen((v) => !v)}>
        <span className="nx-folder-caret" data-open={open}>
          ›
        </span>
        <span>反向链接</span>
        <span className="nx-backlinks-count">{backlinks.length}</span>
      </button>
      {open && (
        <div className="nx-backlinks-body">
          {backlinks.length === 0 ? (
            <div className="nx-backlinks-empty">还没有其它笔记引用这一篇。</div>
          ) : (
            backlinks.map((b) => (
              <button key={b.from} className="nx-backlink-item" onClick={() => onOpen(b.from)}>
                <span className="nx-backlink-name">{baseOf(b.from)}</span>
                {dirOf(b.from) && <span className="nx-backlink-dir">{dirOf(b.from)}</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
