import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import type { CompletionContext, CompletionResult, CompletionSource } from '@codemirror/autocomplete';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { java } from '@codemirror/lang-java';
import { javascript } from '@codemirror/lang-javascript';
import { python } from '@codemirror/lang-python';
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from '@codemirror/language';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  highlightSpecialChars,
  keymap,
  rectangularSelection,
} from '@codemirror/view';
import { tags as t } from '@lezer/highlight';
import type { LangId } from '@core/model';
import type { KernelSession } from '@core/runtime/KernelSession';

/** 语法高亮从 CSS 变量取色，与 Markdown 代码块、主题包共用同一套 token */
export const xnbHighlight = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.controlKeyword, t.operatorKeyword], color: 'var(--nb-syn-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--nb-syn-string)' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: 'var(--nb-syn-comment)', fontStyle: 'italic' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--nb-syn-number)' },
  { tag: [t.typeName, t.className, t.namespace, t.annotation], color: 'var(--nb-syn-type)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.definition(t.function(t.variableName))], color: 'var(--nb-syn-function)' },
  { tag: [t.variableName, t.propertyName, t.attributeName], color: 'var(--nb-syn-variable)' },
  { tag: [t.operator, t.derefOperator, t.compareOperator, t.logicOperator], color: 'var(--nb-syn-operator)' },
  { tag: [t.punctuation, t.bracket, t.paren, t.brace, t.squareBracket], color: 'var(--nb-syn-punct)' },
  { tag: t.invalid, color: 'var(--nb-danger)' },
]);

export const xnbEditorTheme = EditorView.theme({
  '&': {
    fontSize: 'var(--nb-font-size-code)',
    color: 'var(--nb-fg)',
    backgroundColor: 'transparent',
  },
  '.cm-content': {
    fontFamily: 'var(--nb-font-mono)',
    padding: '13px 15px',
    caretColor: 'var(--nb-editor-caret)',
    lineHeight: '1.6',
  },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--nb-editor-caret)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: 'var(--nb-editor-selection)',
  },
  '.cm-activeLine': { backgroundColor: 'var(--nb-editor-active-line)' },
  '.cm-scroller': { fontFamily: 'var(--nb-font-mono)', overflow: 'auto' },
  '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
    backgroundColor: 'var(--nb-bg-active)',
    outline: '1px solid var(--nb-border-strong)',
  },
  '.cm-tooltip': {
    backgroundColor: 'var(--nb-bg)',
    border: '1px solid var(--nb-border-strong)',
    borderRadius: 'var(--nb-radius-sm)',
    boxShadow: '0 4px 14px rgba(0,0,0,0.10)',
    color: 'var(--nb-fg)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'var(--nb-font-mono)',
    fontSize: '12.5px',
    maxHeight: '16em',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 8px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    backgroundColor: 'var(--nb-bg-active)',
    color: 'var(--nb-fg)',
  },
  '.cm-completionIcon': { paddingRight: '10px', opacity: '0.6' },
  '.cm-completionDetail': { color: 'var(--nb-fg-faint)', fontStyle: 'normal', marginLeft: '1em' },
});

const LANG_EXT: Record<LangId, () => Extension> = {
  java: () => java(),
  python: () => python(),
  js: () => javascript(),
};

export function langExtension(lang: LangId): Extension {
  return (LANG_EXT[lang] ?? LANG_EXT.js)();
}

const KIND_MAP: Record<string, string> = {
  method: 'method',
  property: 'property',
  keyword: 'keyword',
  class: 'class',
  module: 'namespace',
  function: 'function',
  statement: 'variable',
  instance: 'variable',
};

/**
 * 内核补全 source。内核不可用或超时就返回 null，
 * CodeMirror 会自动落到语言包自带的关键字补全上。
 */
export function kernelCompletionSource(getSession: () => KernelSession | null): CompletionSource {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const session = getSession();
    if (!session?.alive) return null;
    // 内核正忙时跳过，避免排在长任务后面拖住编辑器
    if (session.busy) return null;

    const before = ctx.matchBefore(/[\w$.]*/);
    if (!ctx.explicit && (!before || (before.from === before.to && !ctx.matchBefore(/\.$/)))) {
      return null;
    }

    const code = ctx.state.doc.toString();
    const res = await session.complete(code, ctx.pos);
    if (!res || !res.items.length) return null;

    return {
      from: Math.min(res.anchor, ctx.pos),
      options: res.items.map((item) => ({
        label: item.label,
        type: KIND_MAP[item.kind ?? ''] ?? 'variable',
        detail: item.detail || undefined,
      })),
      validFor: /^[\w$]*$/,
    };
  };
}

export interface CellEditorOptions {
  lang: LangId;
  doc: string;
  onChange(value: string): void;
  onRun(): void;
  onFocus?(): void;
  getSession(): KernelSession | null;
}

export const langCompartment = new Compartment();

export function buildExtensions(opts: CellEditorOptions): Extension[] {
  return [
    history(),
    drawSelection(),
    highlightSpecialChars(),
    highlightActiveLine(),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
    rectangularSelection(),
    indentUnit.of('    '),
    EditorView.lineWrapping,
    syntaxHighlighting(xnbHighlight),
    xnbEditorTheme,
    langCompartment.of(langExtension(opts.lang)),
    autocompletion({
      override: [kernelCompletionSource(opts.getSession)],
      activateOnTyping: true,
      closeOnBlur: true,
      icons: true,
    }),
    keymap.of([
      {
        key: 'Shift-Enter',
        run: () => {
          opts.onRun();
          return true;
        },
      },
      { key: 'Mod-Enter', run: () => { opts.onRun(); return true; } },
      ...closeBracketsKeymap,
      ...completionKeymap,
      ...historyKeymap,
      ...defaultKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((update) => {
      if (update.docChanged) opts.onChange(update.state.doc.toString());
      if (update.focusChanged && update.view.hasFocus) opts.onFocus?.();
    }),
    EditorState.allowMultipleSelections.of(true),
  ];
}
