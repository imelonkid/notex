import { useEffect, useState } from 'react';
import { LANGS, type LangId } from '@core/model';
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

export function SettingsModal({ onClose }: { onClose(): void }) {
  const { registry, revision, host } = useRuntimes();
  const { mode, setMode, packs, packId, setPack } = useTheme();
  const [paths, setPaths] = useState<Record<string, string>>({});
  const [detecting, setDetecting] = useState(false);
  void revision;

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
