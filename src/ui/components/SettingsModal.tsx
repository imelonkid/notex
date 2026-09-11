import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LANGS, type LangId } from '@core/model';
import { defaultVault, setVault } from '@core/config';
import type { StoreSetup } from '@core/store/index';
import type { FontSizes, ThemeSelection } from '@core/theme';
import { useRuntimes } from '../RuntimeContext';
import { useTheme } from '../theme/ThemeProvider';
import { useRuntimeCatalog } from '../useRuntimeCatalog';
import { RuntimeInstall } from './RuntimeInstall';
import { STATUS_WORD } from './RuntimeStrip';
import { ThemeSettings } from './ThemeSettings';

export type SettingsTab = 'vault' | 'appearance' | 'runtime';
type Tab = SettingsTab;

const TABS: Array<{ id: Tab; label: string; hint: string }> = [
  { id: 'vault', label: '笔记库', hint: '笔记存在哪里' },
  { id: 'appearance', label: '外观', hint: '主题与字号' },
  { id: 'runtime', label: '运行时', hint: 'Java / Python / Node' },
];

const TAB_KEY = 'nx.settings.tab';

function readTab(): Tab {
  try {
    const v = localStorage.getItem(TAB_KEY);
    return TABS.some((t) => t.id === v) ? (v as Tab) : 'vault';
  } catch {
    return 'vault';
  }
}

/**
 * 拖动标题栏移动弹窗。只记偏移量，不改定位方式，
 * 弹窗仍由 backdrop 居中，偏移叠在上面，重新打开就归零。
 */
function useDrag() {
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // 标题栏里的按钮照常点，只有空白处才拖
    if ((e.target as HTMLElement).closest('button, input, select, a')) return;
    e.preventDefault();
    const start = { x: e.clientX - offsetRef.current.x, y: e.clientY - offsetRef.current.y };
    const move = (ev: MouseEvent) => setOffset({ x: ev.clientX - start.x, y: ev.clientY - start.y });
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }, []);

  return { offset, onMouseDown };
}

interface Props {
  setup: StoreSetup;
  /** 打开时直接落到某一页，比如缺运行时的引导卡跳过来 */
  initialTab?: SettingsTab;
  onVaultChanged(): void;
  onClose(): void;
}

/**
 * 设置。所有改动先进草稿，点「保存」才生效；取消或点到外面就丢弃。
 * 「重新检测」「重启内核」「安装内置运行时」是动作不是设置，点了立刻做。
 */
export function SettingsModal({ setup, initialTab, onVaultChanged, onClose }: Props) {
  const { registry, revision, host } = useRuntimes();
  const theme = useTheme();
  void revision;

  const [tab, setTab] = useState<Tab>(() => initialTab ?? readTab());
  const drag = useDrag();
  const catalog = useRuntimeCatalog(host);

  // ---- 草稿 ----
  /** 每种语言选中的路径，空串表示「自动」 */
  const [rtSelected, setRtSelected] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const l of LANGS) initial[l.id] = registry.get(l.id).selected ?? '';
    return initial;
  });
  /** 待添加的手动路径，保存时验证并加入候选 */
  const [rtCustom, setRtCustom] = useState<Record<string, string>>({});
  const [redetecting, setRedetecting] = useState<Record<string, boolean>>({});
  const currentVaultValue = setup.isDefaultVault ? '' : setup.vaultPath;
  const [vaultInput, setVaultInput] = useState(currentVaultValue);
  const [selection, setSelection] = useState<ThemeSelection>(theme.selection);
  const [fontSizes, setFontSizes] = useState<FontSizes>(theme.fontSizes);

  const [vaultDefault, setVaultDefault] = useState('');
  const [busy, setBusy] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void defaultVault(host).then(setVaultDefault).catch(() => setVaultDefault(''));
  }, [host]);

  useEffect(() => {
    try {
      localStorage.setItem(TAB_KEY, tab);
    } catch {
      /* 忽略 */
    }
  }, [tab]);

  // ---- 哪些变了 ----
  const pathsDirty = LANGS.some(
    (l) => (rtSelected[l.id] ?? '') !== (registry.get(l.id).selected ?? '') || !!rtCustom[l.id]?.trim(),
  );
  const vaultDirty = setup.store.kind === 'vault' && vaultInput.trim() !== currentVaultValue;
  const themeDirty =
    JSON.stringify(selection) !== JSON.stringify(theme.selection) ||
    JSON.stringify(fontSizes) !== JSON.stringify(theme.fontSizes);
  const dirty = pathsDirty || vaultDirty || themeDirty;

  const dirtyTabs = useMemo(
    () => new Set<Tab>([...(vaultDirty ? ['vault' as Tab] : []), ...(themeDirty ? ['appearance' as Tab] : []), ...(pathsDirty ? ['runtime' as Tab] : [])]),
    [vaultDirty, themeDirty, pathsDirty],
  );

  /** 选完目录只填进输入框，仍由「保存」提交 */
  const browseVault = async () => {
    if (!host.pickDirectory) return;
    const picked = await host.pickDirectory();
    if (picked) setVaultInput(picked);
  };

  /** 一次提交所有草稿 */
  const save = async () => {
    if (!dirty) return onClose();
    setBusy(true);
    setError(null);
    try {
      if (themeDirty) {
        theme.setSelection(selection);
        theme.setFontSizes(fontSizes);
      }
      if (pathsDirty) {
        for (const l of LANGS) {
          const custom = rtCustom[l.id]?.trim();
          if (custom) {
            const found = await registry.addCustomPath(l.id, custom);
            if (!found?.ok) {
              // 路径不可用就停在这一页，让用户看到原因，别把弹窗关了
              setRtCustom((c) => ({ ...c, [l.id]: '' }));
              setRtSelected((s) => ({ ...s, [l.id]: registry.get(l.id).selected ?? '' }));
              throw new Error(`${l.label} 路径不可用（${custom}）：${found?.reason ?? '无法执行'}`);
            }
            continue;
          }
          const want = rtSelected[l.id] ?? '';
          if (want !== (registry.get(l.id).selected ?? '')) await registry.select(l.id, want || null);
        }
      }
      if (vaultDirty) {
        await setVault(host, vaultInput.trim() || null);
        onVaultChanged();
      }
      onClose();
    } catch (e) {
      setError(String((e as Error)?.message ?? e));
    } finally {
      setBusy(false);
    }
  };

  const redetectAll = async () => {
    setDetecting(true);
    try {
      await registry.detectAll(true);
    } finally {
      setDetecting(false);
    }
  };

  const redetect = async (lang: LangId) => {
    setRedetecting((r) => ({ ...r, [lang]: true }));
    try {
      await registry.detect(lang, true);
    } finally {
      setRedetecting((r) => ({ ...r, [lang]: false }));
    }
  };

  /** 移除手动添加的路径是列表操作，点了就做，不进草稿 */
  const removeCustom = async (lang: LangId, path: string) => {
    await registry.removeCustomPath(lang, path);
    setRtSelected((s) => ({ ...s, [lang]: registry.get(lang).selected ?? '' }));
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter' && (e.target as HTMLElement).tagName === 'INPUT') {
      e.preventDefault();
      void save();
    }
  };

  return (
    <div className="nx-modal-backdrop" onMouseDown={onClose}>
      <div
        className="nx-modal nx-settings"
        style={{ transform: `translate(${drag.offset.x}px, ${drag.offset.y}px)` }}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
        role="dialog"
        aria-label="设置"
      >
        <div className="nx-settings-head" onMouseDown={drag.onMouseDown} title="拖动移动">
          <h2>设置</h2>
          <span style={{ flex: 1 }} />
          <button className="nx-icon-btn" aria-label="关闭" title="关闭（Esc）" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="nx-settings-body">
          <nav className="nx-settings-tabs" aria-label="设置分类">
            {TABS.map((t) => (
              <button
                key={t.id}
                className="nx-settings-tab"
                data-active={tab === t.id}
                data-dirty={dirtyTabs.has(t.id) || undefined}
                onClick={() => setTab(t.id)}
              >
                <span className="nx-settings-tab-label">{t.label}</span>
                <span className="nx-settings-tab-hint">{t.hint}</span>
              </button>
            ))}
          </nav>

          <div className="nx-settings-pane">
            {tab === 'vault' && (
              <div className="nx-field">
                <div className="nx-field-label">笔记库位置</div>
                {setup.store.kind === 'vault' ? (
                  <>
                    <div className="nx-input-row">
                      <input
                        className="nx-text-input"
                        placeholder={vaultDefault ? `默认：${vaultDefault}` : '留空使用默认位置'}
                        value={vaultInput}
                        onChange={(e) => setVaultInput(e.target.value)}
                      />
                      {host.pickDirectory && (
                        <button className="nx-btn-mini" onClick={() => void browseVault()} disabled={busy}>
                          浏览…
                        </button>
                      )}
                    </div>
                    <div className="nx-runtime-detail">
                      当前：{setup.vaultPath}
                      {setup.isDefaultVault ? '（默认位置）' : ''}
                    </div>
                    {!setup.isDefaultVault && (
                      <div className="nx-theme-row" style={{ marginTop: 8 }}>
                        <span />
                        <button className="nx-btn-mini" disabled={!vaultInput.trim()} onClick={() => setVaultInput('')}>
                          恢复默认位置
                        </button>
                      </div>
                    )}
                    <div className="nx-install-note">
                      笔记以 Markdown 存在这个目录里，代码块就是围栏块，可以直接用 Git 管理。
                      切换目录不会移动已有文件，保存后会重新打开笔记库。
                    </div>
                  </>
                ) : (
                  <div className="nx-install-note">
                    当前存在浏览器里，无法落盘。
                    {setup.fallbackReason ? `原因：${setup.fallbackReason}` : ''}
                  </div>
                )}
              </div>
            )}

            {tab === 'appearance' && (
              <ThemeSettings
                selection={selection}
                fontSizes={fontSizes}
                onSelection={setSelection}
                onFontSizes={setFontSizes}
              />
            )}

            {tab === 'runtime' && (
              <div className="nx-field">
                <div className="nx-field-label" style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  运行时
                  <button className="nx-btn-mini" onClick={redetectAll} disabled={detecting}>
                    {detecting ? '检测中…' : '全部重新检测'}
                  </button>
                </div>

                {!host.canSpawn && (
                  <div className="nx-install-note" style={{ marginBottom: 12 }}>
                    当前以纯浏览器模式运行，无法启动本机进程。用 <code>pnpm dev</code> 启动可获得本机内核。
                  </div>
                )}

                {LANGS.map((l) => {
                  const state = registry.get(l.id);
                  const want = rtSelected[l.id] ?? '';
                  const auto = state.candidates.find((c) => c.ok && c.path.includes('/.notex/runtimes/')) ?? state.candidates.find((c) => c.ok);
                  return (
                    <div key={l.id} className="nx-rt-lang">
                      <div className="nx-rt-head">
                        <span className="nx-dot" data-status={state.status} />
                        <span className="nx-rt-name">{l.label}</span>
                        <span className="nx-rt-status">
                          {STATUS_WORD[state.status]}
                          {state.info?.version ? ` · ${state.info.version}` : ''}
                        </span>
                        <span style={{ flex: 1 }} />
                        {state.session?.alive && (
                          <button className="nx-btn-mini" onClick={() => void registry.restart(l.id)}>
                            {state.restartNeeded ? '重启内核以应用' : '重启内核'}
                          </button>
                        )}
                        <button className="nx-btn-mini" disabled={!!redetecting[l.id]} onClick={() => void redetect(l.id)}>
                          {redetecting[l.id] ? '检测中…' : '重新检测'}
                        </button>
                      </div>
                      {state.restartNeeded && (
                        <div className="nx-runtime-detail" style={{ color: 'var(--nx-warn)' }}>
                          运行时已更改，内核仍在用旧的跑，重启后生效。
                        </div>
                      )}
                      {state.error && (
                        <div className="nx-runtime-detail" style={{ color: 'var(--nx-danger)' }}>
                          {state.error}
                        </div>
                      )}

                      <div className="nx-rt-list" role="radiogroup" aria-label={`${l.label} 运行时`}>
                        <label className="nx-rt-option" data-checked={want === ''}>
                          <input type="radio" name={`rt-${l.id}`} checked={want === ''} onChange={() => setRtSelected((s) => ({ ...s, [l.id]: '' }))} />
                          <span className="nx-rt-option-main">
                            <span className="nx-rt-option-title">自动</span>
                            <span className="nx-rt-option-sub">
                              {auto ? `当前会选：${auto.source} ${auto.version ?? ''}` : '没有可用的候选'}
                            </span>
                          </span>
                        </label>
                        {state.candidates.map((c) => (
                          <label key={c.path} className="nx-rt-option" data-checked={want === c.path} data-disabled={!c.ok || undefined}>
                            <input
                              type="radio"
                              name={`rt-${l.id}`}
                              disabled={!c.ok}
                              checked={want === c.path}
                              onChange={() => setRtSelected((s) => ({ ...s, [l.id]: c.path }))}
                            />
                            <span className="nx-rt-option-main">
                              <span className="nx-rt-option-title">
                                {c.version ?? '?'}
                                <span className="nx-rt-option-source">{c.source}</span>
                              </span>
                              <span className="nx-rt-option-sub" title={c.path}>
                                {c.path}
                              </span>
                              {!c.ok && c.reason && <span className="nx-rt-option-reason">{c.reason}</span>}
                            </span>
                            {c.source === '手动' && (
                              <button
                                className="nx-btn-mini"
                                title="从列表移除"
                                onClick={(e) => {
                                  e.preventDefault();
                                  void removeCustom(l.id, c.path);
                                }}
                              >
                                移除
                              </button>
                            )}
                          </label>
                        ))}
                        {state.status === 'detecting' && state.candidates.length === 0 && (
                          <div className="nx-rt-option-sub" style={{ padding: '6px 10px' }}>检测中…</div>
                        )}
                      </div>

                      <div className="nx-input-row" style={{ marginTop: 8 }}>
                        <input
                          className="nx-text-input"
                          placeholder={`添加 ${l.label} 可执行文件路径，保存时验证`}
                          value={rtCustom[l.id] ?? ''}
                          onChange={(e) => setRtCustom((c) => ({ ...c, [l.id]: e.target.value }))}
                        />
                      </div>

                      <div className="nx-rt-sub-label">内置运行时</div>
                      {host.canSpawn ? (
                        <RuntimeInstall
                          lang={l.id}
                          host={host}
                          catalog={catalog}
                          onChanged={() => {
                            void registry.detect(l.id, true).then(() => {
                              setRtSelected((s) => ({ ...s, [l.id]: registry.get(l.id).selected ?? '' }));
                            });
                          }}
                        />
                      ) : (
                        <div className="nx-rt-install-note">纯浏览器模式下无法安装。</div>
                      )}
                    </div>
                  );
                })}
                <div className="nx-install-note">
                  「自动」优先用内置运行时，其次是第一个可用的本机环境。选定的运行时对下一次启动的内核生效；
                  内置运行时启动时会隔离本机的 PYTHONPATH、conda、JAVA_TOOL_OPTIONS 之类的环境变量。
                </div>
              </div>
            )}
          </div>
        </div>

        <div className="nx-modal-footer">
          {error && (
            <span className="nx-runtime-detail" style={{ color: 'var(--nx-danger)' }}>
              {error}
            </span>
          )}
          {!error && dirty && <span className="nx-runtime-detail">有未保存的改动</span>}
          <span style={{ flex: 1 }} />
          <button className="nx-btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="nx-btn-primary" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
