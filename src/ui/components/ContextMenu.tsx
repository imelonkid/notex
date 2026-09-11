import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  onSelect?(): void;
  /** 危险操作用醒目的颜色 */
  danger?: boolean;
  disabled?: boolean;
  /** 之前插一条分隔线 */
  separatorBefore?: boolean;
  /** 有子项时悬停展开二级菜单 */
  children?: MenuItem[];
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
  /**
   * 'right' 表示 x 是右边缘。从右上角那个 ⋯ 按钮弹出时用它对齐，
   * 否则菜单永远向右溢出、只能被贴边夹住，看着像是没对齐。
   */
  align?: 'left' | 'right';
}

/** 贴着鼠标弹出的菜单，点别处或按 Esc 关闭 */
export function ContextMenu({ state, onClose }: { state: MenuState; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: state.x, top: state.y });

  // 先按鼠标位置放，量到实际尺寸后再纠正，避免超出窗口
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    const wanted = state.align === 'right' ? state.x - width : state.x;
    setPos({
      left: Math.max(margin, Math.min(wanted, window.innerWidth - width - margin)),
      top: Math.min(state.y, window.innerHeight - height - margin),
    });
  }, [state.x, state.y, state.align, state.items]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    // 捕获阶段，抢在下层元素的点击之前
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', onClose);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', onClose);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="nx-menu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      onContextMenu={(e) => e.preventDefault()}
    >
      <MenuList items={state.items} onClose={onClose} />
    </div>
  );
}

/** 一层菜单；带 children 的项悬停展开二级菜单 */
function MenuList({ items, onClose }: { items: MenuItem[]; onClose(): void }) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  return (
    <>
      {items.map((item, i) => (
        <div
          key={i}
          className="nx-menu-row"
          onMouseEnter={() => setOpenIndex(item.children?.length ? i : null)}
        >
          {item.separatorBefore && <div className="nx-menu-sep" />}
          <button
            className="nx-menu-item"
            role="menuitem"
            data-danger={item.danger}
            data-submenu={item.children?.length ? 'true' : undefined}
            disabled={item.disabled}
            onClick={() => {
              if (item.children?.length) return;
              onClose();
              item.onSelect?.();
            }}
          >
            <span>{item.label}</span>
            {item.children?.length ? <span className="nx-menu-arrow">›</span> : null}
          </button>
          {openIndex === i && item.children?.length ? (
            <Submenu items={item.children} onClose={onClose} />
          ) : null}
        </div>
      ))}
    </>
  );
}

/** 二级及更深的菜单，贴不下时朝左展开 */
function Submenu({ items, onClose }: { items: MenuItem[]; onClose(): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [flip, setFlip] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setFlip(rect.right > window.innerWidth - 8);
  }, [items]);

  return (
    <div ref={ref} className="nx-submenu" data-flip={flip ? 'true' : undefined}>
      <MenuList items={items} onClose={onClose} />
    </div>
  );
}
