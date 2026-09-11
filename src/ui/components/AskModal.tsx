import { useEffect, useRef, useState } from 'react';

/**
 * 应用内的确认框与输入框。
 *
 * 不能用 window.confirm / window.prompt：Tauri 的 webview（wry）没有实现
 * WKUIDelegate 的那几个 JS 面板回调，WKWebView 于是走默认行为——
 * confirm 直接返回 false，prompt 直接返回 null，桌面版里点了等于取消。
 */
export interface AskRequest {
  title: string;
  message?: string;
  /** 给了就是输入框，不给就是纯确认 */
  input?: { label?: string; value: string; placeholder?: string };
  confirmLabel?: string;
  danger?: boolean;
}

export interface AskState extends AskRequest {
  /** 确认返回文本（纯确认时是空串），取消返回 null */
  resolve(value: string | null): void;
}

export function AskModal({ state }: { state: AskState }) {
  const [value, setValue] = useState(state.input?.value ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 输入框全选，直接改名不用先删
    inputRef.current?.select();
  }, []);

  const cancel = () => state.resolve(null);
  const confirm = () => {
    if (state.input && !value.trim()) return;
    state.resolve(state.input ? value.trim() : '');
  };

  return (
    <div className="nx-modal-backdrop" onMouseDown={cancel}>
      <div
        className="nx-modal"
        style={{ width: 'min(420px, 92vw)' }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            cancel();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            e.stopPropagation();
            confirm();
          }
        }}
      >
        <h2>{state.title}</h2>
        {state.message && (
          <div style={{ color: 'var(--nx-fg-muted)', lineHeight: 1.6 }}>{state.message}</div>
        )}
        {state.input && (
          <div className="nx-field">
            {state.input.label && <div className="nx-field-label">{state.input.label}</div>}
            <input
              ref={inputRef}
              className="nx-text-input"
              autoFocus
              value={value}
              placeholder={state.input.placeholder}
              onChange={(e) => setValue(e.target.value)}
            />
          </div>
        )}
        <div className="nx-modal-footer">
          <span style={{ flex: 1 }} />
          <button className="nx-btn-ghost" onClick={cancel}>
            取消
          </button>
          <button
            className="nx-btn-primary"
            data-danger={state.danger || undefined}
            autoFocus={!state.input}
            disabled={!!state.input && !value.trim()}
            onClick={confirm}
          >
            {state.confirmLabel ?? '确定'}
          </button>
        </div>
      </div>
    </div>
  );
}
