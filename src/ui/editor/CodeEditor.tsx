import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { LangId } from '@core/model';
import type { KernelSession } from '@core/runtime/KernelSession';
import { buildExtensions, langCompartment, langExtension } from './setup';

interface Props {
  value: string;
  lang: LangId;
  onChange(value: string): void;
  onRun(): void;
  onFocus?(): void;
  getSession(): KernelSession | null;
}

/**
 * 一个 code cell 一个 EditorView。
 * 语言通过 Compartment 热切换，不重建编辑器，因此不丢历史和光标。
 */
export function CodeEditor({ value, lang, onChange, onRun, onFocus, getSession }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  // 回调放进 ref，避免每次渲染重建整个编辑器
  const cbs = useRef({ onChange, onRun, onFocus, getSession });
  cbs.current = { onChange, onRun, onFocus, getSession };

  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: buildExtensions({
        lang,
        doc: value,
        onChange: (v) => cbs.current.onChange(v),
        onRun: () => cbs.current.onRun(),
        onFocus: () => cbs.current.onFocus?.(),
        getSession: () => cbs.current.getSession(),
      }),
    });
    const v = new EditorView({ state, parent: host.current });
    view.current = v;
    return () => {
      v.destroy();
      view.current = null;
    };
    // 只在挂载时建一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 外部改了源码（撤销、加载文件）时同步进编辑器
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (current === value) return;
    v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  // 切换语言只 reconfigure 语法分区
  useEffect(() => {
    view.current?.dispatch({ effects: langCompartment.reconfigure(langExtension(lang)) });
  }, [lang]);

  return <div ref={host} className="nx-editor" />;
}
