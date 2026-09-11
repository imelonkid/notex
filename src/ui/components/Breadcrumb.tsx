import { Fragment } from 'react';

interface Props {
  /** 所在文件夹，笔记库根为空串 */
  dir: string;
  /** 当前笔记的标题。文件夹页上不传：那时最后一段文件夹就是当前位置 */
  current?: string;
  onOpenFolder(dir: string): void;
}

/**
 * 当前位置。第一段固定是「我的笔记」：根目录的笔记否则只剩一个和大标题重复的名字，
 * 看不出层级。除了当前位置，每一段都能点，点了打开那个文件夹页。
 */
export function Breadcrumb({ dir, current, onOpenFolder }: Props) {
  const parts = dir.split('/').filter(Boolean);
  const segments = [
    { name: '我的笔记', dir: '' },
    ...parts.map((name, i) => ({ name, dir: parts.slice(0, i + 1).join('/') })),
  ];

  return (
    <nav className="nx-crumbs" aria-label="当前位置">
      {segments.map((s, i) => {
        const isCurrent = current === undefined && i === segments.length - 1;
        return (
          <Fragment key={s.dir || '/'}>
            {i > 0 && (
              <span className="nx-crumb-sep" aria-hidden="true">
                /
              </span>
            )}
            {isCurrent ? (
              <span className="nx-crumb" data-current="true" aria-current="page">
                {s.name}
              </span>
            ) : (
              <button className="nx-crumb" title={s.dir ? `打开「${s.dir}」` : '打开笔记库'} onClick={() => onOpenFolder(s.dir)}>
                {s.name}
              </button>
            )}
          </Fragment>
        );
      })}
      {current !== undefined && (
        <>
          <span className="nx-crumb-sep" aria-hidden="true">
            /
          </span>
          <span className="nx-crumb" data-current="true" aria-current="page">
            {current}
          </span>
        </>
      )}
    </nav>
  );
}
