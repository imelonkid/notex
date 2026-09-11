import { Component, type ErrorInfo, type ReactNode } from 'react';
import { debug } from '@core/debug';

interface Props {
  /** 出错时显示在提示里，方便对上是哪一块 */
  index: number;
  children: ReactNode;
}

interface RootProps {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * 单个 cell 的错误边界。
 *
 * 没有它时，一个 cell 渲染抛异常会让整棵 React 树卸载——整个界面白屏，
 * 而且笔记会被轮询自动读回来，等于应用再也打不开。笔记内容什么都可能写，
 * 不能让一处坏内容毁掉整个应用。
 */
export class CellBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    debug.error('cell', '渲染出错，已被错误边界拦下', {
      index: this.props.index,
      message: error.message,
      stack: info.componentStack?.slice(0, 300),
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="nx-cell-broken">
        <div className="nx-cell-broken-title">第 {this.props.index + 1} 块渲染失败</div>
        <div className="nx-cell-broken-msg">{this.state.error.message}</div>
        <div className="nx-cell-broken-hint">
          其它内容不受影响。可以在外部编辑器里改这篇笔记的源码，改完应用会自动读回来。
        </div>
        <button className="nx-btn-ghost" onClick={() => this.setState({ error: null })}>
          重试渲染
        </button>
      </div>
    );
  }
}

/**
 * 兜底的顶层边界。
 *
 * cell 级边界拦不住渲染路径上别处抛出的异常——白屏最难受的地方是
 * 它什么都不说。这里至少把错误显示出来，并留一个重载入口。
 */
export class RootBoundary extends Component<RootProps, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    debug.error('app', '顶层渲染出错', {
      message: error.message,
      stack: info.componentStack?.slice(0, 400),
    });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ padding: 40, maxWidth: 640, lineHeight: 1.7 }}>
        <h2 style={{ marginTop: 0 }}>界面出错了</h2>
        <p style={{ color: 'var(--nx-fg-muted)' }}>
          笔记文件没有受影响。详细信息已写进 <code>~/.notex/debug-*.log</code>。
        </p>
        <pre
          style={{
            background: 'var(--nx-bg-subtle)',
            padding: 12,
            borderRadius: 4,
            overflowX: 'auto',
            fontSize: 12,
          }}
        >
          {this.state.error.message}
        </pre>
        <button className="nx-btn-primary" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    );
  }
}
