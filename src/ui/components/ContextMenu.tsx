import { useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface MenuItem {
  label: string;
  onSelect(): void;
  /** 危险操作用醒目的颜色 */
  danger?: boolean;
  disabled?: boolean;
  /** 之前插一条分隔线 */
  separatorBefore?: boolean;
}

export interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
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
    setPos({
      left: Math.min(state.x, window.innerWidth - width - margin),
      top: Math.min(state.y, window.innerHeight - height - margin),
    });
  }, [state.x, state.y, state.items]);

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
      {state.items.map((item, i) => (
        <div key={i}>
          {item.separatorBefore && <div className="nx-menu-sep" />}
          <button
            className="nx-menu-item"
            role="menuitem"
            data-danger={item.danger}
            disabled={item.disabled}
            onClick={() => {
              onClose();
              item.onSelect();
            }}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
