import { useEffect, useState } from 'react';
import { LANGS, type LangId } from '@core/model';
import { defaultVault, setVault } from '@core/config';
import type { StoreSetup } from '@core/store/index';
import { useRuntimes } from '../RuntimeContext';
import { useTheme, type ThemeMode } from '../theme/ThemeProvider';

const MODE_LABEL: Record<ThemeMode, string> = { light: '浅色', dark: '深色', auto: '跟随系统' };

const STATUS_LABEL: Record<string, string> = {
  unknown: '未检测',
  detecting: '检测中…',
  available: '已就绪（未启动）',
  missing: '未安装',
  starting: '启动中…',
  ready: '运行中',
  busy: '执行中',
  error: '启动失败',
};

interface Props {
  setup: StoreSetup;
  onVaultChanged(): void;
  onClose(): void;
}

export function SettingsModal({ setup, onVaultChanged, onClose }: Props) {
  const { registry, revision, host } = useRuntimes();
  const { mode, setMode, packs, packId, setPack } = useTheme();
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [detecting, setDetecting] = useState(false);
  const [vaultInput, setVaultInput] = useState(setup.isDefaultVault ? '' : setup.vaultPath);
  const [vaultDefault, setVaultDefault] = useState('');
  const [vaultBusy, setVaultBusy] = useState(false);
  const [vaultError, setVaultError] = useState<string | null>(null);
  void revision;

  useEffect(() => {
    void defaultVault(host).then(setVaultDefault).catch(() => setVaultDefault(''));
  }, [host]);

  const applyVault = async (next: string | null) => {
    setVaultBusy(true);
    setVaultError(null);
    try {
      await setVault(host, next);
      onVaultChanged();
    } catch (e) {
      setVaultError(String((e as Error)?.message ?? e));
    } finally {
      setVaultBusy(false);
    }
  };

  const browseVault = async () => {
    if (!host.pickDirectory) return;
    const picked = await host.pickDirectory();
    if (!picked) return;
    setVaultInput(picked);
    await applyVault(picked);
  };

  useEffect(() => {
    const initial: Record<string, string> = {};
    for (const l of LANGS) initial[l.id] = registry.getManualPath(l.id);
    setPaths(initial);
  }, [registry]);

  const applyPath = async (lang: LangId) => {
    registry.setManualPath(lang, paths[lang]?.trim() || null);
    await registry.detect(lang, true);
  };

  const redetectAll = async () => {
    setDetecting(true);
    try {
      await registry.detectAll(true);
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="nx-modal-backdrop" onClick={onClose}>
      <div className="nx-modal" onClick={(e) => e.stopPropagation()}>
        <h2>设置</h2>

        <div className="nx-field">
          <div className="nx-field-label">笔记库</div>
          {setup.store.kind === 'vault' ? (
            <>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input
                  className="nx-text-input"
                  placeholder={vaultDefault ? `默认：${vaultDefault}` : '留空使用默认位置'}
                  value={vaultInput}
                  onChange={(e) => setVaultInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void applyVault(vaultInput || null)}
                />
                {host.pickDirectory && (
                  <button className="nx-btn-mini" onClick={() => void browseVault()} disabled={vaultBusy}>
                    浏览…
                  </button>
                )}
                <button
                  className="nx-btn-mini"
                  onClick={() => void applyVault(vaultInput || null)}
                  disabled={vaultBusy}
                >
                  {vaultBusy ? '切换中…' : '应用'}
                </button>
              </div>
              <div className="nx-runtime-detail">
                当前：{setup.vaultPath}
                {setup.isDefaultVault ? '（默认位置）' : ''}
              </div>
              {!setup.isDefaultVault && (
                <button
                  className="nx-btn-mini"
                  style={{ marginTop: 6, marginLeft: -8 }}
                  onClick={() => {
                    setVaultInput('');
                    void applyVault(null);
                  }}
                >
                  恢复默认位置
                </button>
              )}
              {vaultError && (
                <div className="nx-runtime-detail" style={{ color: 'var(--nx-danger)' }}>
                  {vaultError}
                </div>
              )}
              <div className="nx-install-note">
                笔记以 Markdown 存在这个目录里，代码块就是围栏块，可以直接用 Git 管理。
                切换目录不会移动已有文件。
              </div>
            </>
          ) : (
            <div className="nx-install-note">
              当前存在浏览器里，无法落盘。
              {setup.fallbackReason ? `原因：${setup.fallbackReason}` : ''}
            </div>
          )}
        </div>

        <div className="nx-field">
          <div className="nx-field-label">外观</div>
          <div className="nx-seg">
            {(['light', 'dark', 'auto'] as ThemeMode[]).map((m) => (
              <button key={m} data-active={mode === m} onClick={() => setMode(m)}>
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        </div>

        {packs.length > 0 && (
          <div className="nx-field">
            <div className="nx-field-label">主题包</div>
            <div className="nx-seg">
              <button data-active={packId === null} onClick={() => setPack(null)}>
                默认
              </button>
              {packs.map((p) => (
                <button key={p.id} data-active={packId === p.id} onClick={() => setPack(p.id)}>
                  {p.name}
                </button>
              ))}
            </div>
          </div>
        )}

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
            return (
              <div key={l.id} style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 5 }}>
                  <span className="nx-dot" data-status={state.status} />
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{l.label}</span>
                  <span style={{ fontSize: 11.5, color: 'var(--nx-fg-faint)' }}>
                    {STATUS_LABEL[state.status] ?? state.status}
                    {state.info?.version ? ` · ${state.info.version}` : ''}
                  </span>
                  {state.session?.alive && (
                    <button className="nx-btn-mini" onClick={() => void registry.restart(l.id)}>
                      重启内核
                    </button>
                  )}
                </div>
                <input
                  className="nx-text-input"
                  placeholder={state.info?.path ?? `手动指定 ${l.label} 可执行文件路径（留空则自动检测）`}
                  value={paths[l.id] ?? ''}
                  onChange={(e) => setPaths((p) => ({ ...p, [l.id]: e.target.value }))}
                  onBlur={() => void applyPath(l.id)}
                  onKeyDown={(e) => e.key === 'Enter' && void applyPath(l.id)}
                />
                {state.info?.path && <div className="nx-runtime-detail">{state.info.path}</div>}
                {state.error && (
                  <div className="nx-runtime-detail" style={{ color: 'var(--nx-danger)' }}>
                    {state.error}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button className="nx-btn-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
