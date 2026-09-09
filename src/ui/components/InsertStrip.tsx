import { useState } from 'react';

/**
 * 两个 cell 之间的插入条。
 * 平时是一条几乎看不见的空隙，鼠标移上去才出现按钮，
 * 因此既是精确插入的入口，又不占常驻空间。
 */
export function InsertStrip({ onInsert }: { onInsert(type: 'md' | 'code'): void }) {
  const [hover, setHover] = useState(false);

  return (
    <div
      className="nx-insert-strip"
      data-hover={hover}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <div className="nx-insert-line" />
      <div className="nx-insert-actions">
        <button className="nx-insert-btn" onClick={() => onInsert('md')} title="在这里插入文本">
          ＋ 文本
        </button>
        <button className="nx-insert-btn" onClick={() => onInsert('code')} title="在这里插入代码">
          ＋ 代码
        </button>
      </div>
    </div>
  );
}
