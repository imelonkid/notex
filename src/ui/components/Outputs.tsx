import type { LangId, Output } from '@core/model';
import { LANGS } from '@core/model';
import { InstallGuideCard } from './InstallGuideCard';
import { sanitizeOutput } from '../sanitize';

/** 富输出渲染：按 MIME 优先级挑一种展示 */
function RichData({ data }: { data: Record<string, string> }) {
  if (data['image/png']) {
    return <img className="nx-out-html" src={`data:image/png;base64,${data['image/png']}`} alt="输出图像" />;
  }
  if (data['image/svg+xml']) {
    return <div className="nx-out-html" dangerouslySetInnerHTML={{ __html: sanitizeOutput(data['image/svg+xml']) }} />;
  }
  if (data['text/html']) {
    return <div className="nx-out-html" dangerouslySetInnerHTML={{ __html: sanitizeOutput(data['text/html']) }} />;
  }
  return <div className="nx-out-line nx-out-result">→ {data['text/plain'] ?? ''}</div>;
}

interface Props {
  outputs: Output[];
  lang: LangId;
  ranWith?: LangId;
  onRetryDetect(): void;
  onOpenSettings(): void;
}

export function Outputs({ outputs, lang, ranWith, onRetryDetect, onOpenSettings }: Props) {
  if (!outputs.length) return null;

  const missing = outputs.find((o) => o.type === 'missing-runtime');
  if (missing && missing.type === 'missing-runtime') {
    return (
      <InstallGuideCard lang={missing.lang} onRetryDetect={onRetryDetect} onOpenSettings={onOpenSettings} />
    );
  }

  const staleLang = ranWith && ranWith !== lang ? LANGS.find((l) => l.id === ranWith)?.label : null;

  return (
    <div className="nx-outputs">
      {staleLang && <div className="nx-out-stale">上次以 {staleLang} 运行</div>}
      {outputs.map((out, i) => {
        if (out.type === 'stream') {
          return (
            <div key={i} className={`nx-out-line nx-out-${out.name}`}>
              {out.text.replace(/\n$/, '')}
            </div>
          );
        }
        if (out.type === 'result' || out.type === 'display') {
          return <RichData key={i} data={out.data} />;
        }
        if (out.type === 'notice') {
          return (
            <div
              key={i}
              className="nx-out-line"
              style={{ color: out.level === 'warn' ? 'var(--nx-warn)' : 'var(--nx-fg-muted)' }}
            >
              {out.text}
            </div>
          );
        }
        if (out.type === 'error') {
          return (
            <div key={i}>
              <div className="nx-out-line nx-out-error">
                {out.ename}: {out.evalue}
              </div>
              {out.traceback.length > 0 && (
                <div className="nx-out-line nx-out-trace">{out.traceback.join('\n')}</div>
              )}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
