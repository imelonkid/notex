import { LANGS, type LangId } from '@core/model';
import type { RuntimeStatus } from '@core/runtime/types';
import { useRuntimes } from '../RuntimeContext';

/** 圆点旁边的一个词。版本另算，状态只回答"能不能用、在不在忙" */
export const STATUS_WORD: Record<RuntimeStatus, string> = {
  unknown: '未检测',
  detecting: '检测中',
  available: '未启动',
  missing: '未安装',
  starting: '启动中',
  ready: '空闲',
  busy: '执行中',
  error: '出错',
};

interface Props {
  /** 点某一种语言：弹出它的操作菜单 */
  onMenu(lang: LangId, x: number, y: number): void;
}

/**
 * 侧栏底部的运行时一览：永远三颗点，高度不随笔记变。
 * 悬停看版本，点开有动作（中断、重启、停止、设置）。
 * 状态区只放"会变、且变了要马上处理"的东西，路径那种常量不该在这里。
 */
export function RuntimeStrip({ onMenu }: Props) {
  const { registry, revision } = useRuntimes();
  void revision;

  return (
    <div className="nx-runtime-strip" role="group" aria-label="运行时状态">
      {LANGS.map((l) => {
        const s = registry.get(l.id);
        const version = s.info?.version ? ` ${s.info.version}` : '';
        const tip = [
          `${l.label}${version}：${STATUS_WORD[s.status]}`,
          s.info ? `${s.info.source ?? ''} ${s.info.path}`.trim() : '',
          s.restartNeeded ? '运行时设置已更改，重启内核后生效' : '',
          s.error ?? '',
        ]
          .filter(Boolean)
          .join('\n');
        return (
          <button
            key={l.id}
            className="nx-runtime-chip"
            data-status={s.status}
            data-restart={s.restartNeeded || undefined}
            title={tip}
            aria-label={`${l.label}：${STATUS_WORD[s.status]}`}
            onClick={(e) => {
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              onMenu(l.id, r.left, r.top - 4);
            }}
          >
            <span className="nx-dot" data-status={s.status} />
            <span className="nx-runtime-chip-name">{l.short}</span>
          </button>
        );
      })}
    </div>
  );
}
