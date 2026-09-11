import { useState } from 'react';
import type { LangId } from '@core/model';
import { useRuntimes } from '../RuntimeContext';

interface Props {
  lang: LangId;
  onRetryDetect(): void;
  onOpenSettings(): void;
}

/** 运行时缺失时展示在 cell 输出区，不弹全局对话框，保持在上下文里 */
export function InstallGuideCard({ lang, onRetryDetect, onOpenSettings }: Props) {
  const { registry, platform } = useRuntimes();
  const [copied, setCopied] = useState(false);
  const [detecting, setDetecting] = useState(false);

  const provider = registry.providersFor(lang)[0];
  if (!provider) return null;
  const guide = provider.install;
  const state = registry.get(lang);
  // 「找到了但启动失败」和「没找到」是两回事：前者给安装命令只会误导
  const launchFailed = state.status === 'error' && !!state.info;
  const command = launchFailed ? undefined : guide.commands[platform];

  const copy = async () => {
    if (!command) return;
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* 剪贴板不可用就算了，用户可以手选 */
    }
  };

  const retry = async () => {
    setDetecting(true);
    try {
      await registry.detect(lang, true);
      onRetryDetect();
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="nx-install">
      <div className="nx-install-title">
        {launchFailed ? `${provider.label} 内核启动失败` : guide.title}
      </div>
      <div className="nx-install-sub">
        {launchFailed ? state.error || `无法启动 ${state.info?.path ?? ''}` : `需要 ${guide.minVersion}`}
      </div>

      {command && (
        <div className="nx-install-cmd">
          <code>{command}</code>
          <button className="nx-btn-mini" onClick={copy}>
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      )}

      <div className="nx-install-actions">
        <button className="nx-btn-primary" onClick={retry} disabled={detecting}>
          {detecting ? '检测中…' : '重新检测'}
        </button>
        <button className="nx-btn-ghost" onClick={onOpenSettings}>
          手动指定路径…
        </button>
        {guide.links.map((link) => (
          <a
            key={link.url}
            href={link.url}
            target="_blank"
            rel="noreferrer noopener"
            style={{ fontSize: '12px' }}
          >
            {link.label}
          </a>
        ))}
      </div>

      {guide.notes?.length ? (
        <div className="nx-install-note">
          {guide.notes.map((n, i) => (
            <div key={i}>· {n}</div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
