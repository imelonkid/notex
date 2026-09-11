import { useState } from 'react';
import type { LangId } from '@core/model';
import { type CatalogRuntime, formatSize, pickBuild } from '@core/runtime/catalog';
import type { InstallProgress } from '@core/runtime/installer';
import type { HostBridge } from '@host/HostBridge';
import type { useRuntimeCatalog } from '../useRuntimeCatalog';

type CatalogApi = ReturnType<typeof useRuntimeCatalog>;

interface Props {
  lang: LangId;
  host: HostBridge;
  catalog: CatalogApi;
  /** 装好或卸载后让注册表重新探测，新运行时才会出现在候选里 */
  onChanged(): void;
}

function phaseText(p: InstallProgress): string {
  switch (p.phase) {
    case 'download': {
      const got = p.received ?? 0;
      const total = p.total ?? 0;
      const pct = total ? Math.min(100, Math.round((got / total) * 100)) : 0;
      const tail = p.attempt && p.attempt > 1 ? `（第 ${p.attempt} 个地址）` : '';
      return total ? `下载中 ${pct}%，${formatSize(got)} / ${formatSize(total)}${tail}` : `下载中 ${formatSize(got)}${tail}`;
    }
    case 'verify':
      return '校验中…';
    case 'unpack':
      return '解压中…';
    case 'done':
      return '完成';
  }
}

/** 设置 › 运行时里每种语言下面的「内置运行时」一栏 */
export function RuntimeInstall({ lang, host, catalog, onChanged }: Props) {
  const [filePath, setFilePath] = useState<Record<string, string>>({});
  const { state } = catalog;

  if (state.status === 'loading' || state.status === 'idle') {
    return <div className="nx-rt-install-note">正在获取内置运行时清单…</div>;
  }
  if (state.status === 'error') {
    return (
      <div className="nx-rt-install-note">
        无法获取内置运行时清单（{state.error}）
        <button className="nx-btn-mini" style={{ marginLeft: 8 }} onClick={() => void catalog.reload()}>
          重试
        </button>
      </div>
    );
  }

  const list = catalog.runtimesForLang(lang);
  if (!list.length) {
    return <div className="nx-rt-install-note">清单里没有适用于这台机器的内置运行时。</div>;
  }

  const runInstall = async (r: CatalogRuntime) => {
    if (await catalog.install(r)) onChanged();
  };
  const runInstallFile = async (r: CatalogRuntime) => {
    let file = filePath[r.id]?.trim() ?? '';
    if (!file && host.pickFile) file = (await host.pickFile()) ?? '';
    if (!file) return;
    if (await catalog.installFile(r, file)) {
      setFilePath((f) => ({ ...f, [r.id]: '' }));
      onChanged();
    }
  };

  return (
    <div className="nx-rt-install">
      {list.map((r) => {
        const build = pickBuild(r, host.platform(), host.arch());
        const installed = catalog.isInstalled(r);
        const job = catalog.jobOf(r);
        const busy = !!job && !job.error;
        const pct =
          job?.progress.phase === 'download' && job.progress.total
            ? Math.min(100, Math.round(((job.progress.received ?? 0) / job.progress.total) * 100))
            : job?.progress.phase === 'verify' || job?.progress.phase === 'unpack'
              ? 100
              : 0;
        return (
          <div key={`${r.id}@${r.version}`} className="nx-rt-install-row">
            <div className="nx-rt-install-main">
              <div className="nx-rt-install-title">
                <span>{r.label}</span>
                <span className="nx-rt-option-source">{r.version}</span>
                {build && <span className="nx-rt-install-size">{formatSize(build.size)}</span>}
                {installed && <span className="nx-rt-install-ok">已安装</span>}
              </div>
              {r.packages?.length ? <div className="nx-rt-install-pkgs">{r.packages.join(' · ')}</div> : null}
              {r.notes && <div className="nx-rt-install-pkgs">{r.notes}</div>}
              {busy && (
                <div className="nx-rt-progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                  <div className="nx-rt-progress-bar" style={{ width: `${pct}%` }} data-indeterminate={job.progress.phase !== 'download' || undefined} />
                  <span className="nx-rt-progress-text">{phaseText(job.progress)}</span>
                </div>
              )}
              {job?.error && (
                <div className="nx-rt-option-reason">
                  {job.error}
                  <button className="nx-btn-mini" style={{ marginLeft: 8 }} onClick={() => catalog.dismissError(r)}>
                    知道了
                  </button>
                </div>
              )}
              {!installed && !busy && !host.pickFile && (
                <div className="nx-input-row" style={{ marginTop: 6 }}>
                  <input
                    className="nx-text-input"
                    placeholder="已经下好的 .tar.gz 路径，从本地安装"
                    value={filePath[r.id] ?? ''}
                    onChange={(e) => setFilePath((f) => ({ ...f, [r.id]: e.target.value }))}
                  />
                  <button className="nx-btn-mini" disabled={!filePath[r.id]?.trim()} onClick={() => void runInstallFile(r)}>
                    从文件安装
                  </button>
                </div>
              )}
            </div>
            <div className="nx-rt-install-actions">
              {installed ? (
                <button className="nx-btn-mini" disabled={busy} onClick={() => void catalog.uninstall(r).then(onChanged)}>
                  卸载
                </button>
              ) : (
                <>
                  <button className="nx-btn-primary" disabled={busy || !build} onClick={() => void runInstall(r)}>
                    {busy ? '安装中…' : '下载并安装'}
                  </button>
                  {host.pickFile && (
                    <button className="nx-btn-mini" disabled={busy} onClick={() => void runInstallFile(r)}>
                      从文件安装…
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
