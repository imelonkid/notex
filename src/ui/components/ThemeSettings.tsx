import {
  DEFAULT_FONT_SIZES,
  DENSITIES,
  FONT_SIZE_LIMITS,
  type Appearance,
  type Density,
  type FontSizes,
  type Theme,
  type ThemeSelection,
} from '@core/theme';
import { useTheme } from '../theme/ThemeProvider';

const SIZE_LABEL: Record<keyof FontSizes, string> = { ui: '界面', prose: '正文', code: '代码' };

function ThemeSelect({ value, themes, onChange }: { value: string; themes: Theme[]; onChange(id: string): void }) {
  const exists = themes.some((t) => t.id === value);
  return (
    <select className="nx-select" value={value} onChange={(e) => onChange(e.target.value)}>
      {/* 选中的用户主题文件被删了或写坏了：照实显示，而不是悄悄换成别的 */}
      {!exists && (
        <option value={value} disabled>
          未找到：{value}
        </option>
      )}
      {themes.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  );
}

interface Props {
  /** 草稿，由设置弹窗持有；点「保存」才写进 ThemeProvider */
  selection: ThemeSelection;
  fontSizes: FontSizes;
  density: Density;
  onSelection(next: ThemeSelection): void;
  onFontSizes(next: FontSizes): void;
  onDensity(next: Density): void;
}

/**
 * 设置里的「主题」「字号」与「密度」。
 * 主题只管颜色、字体、字重和标题比例；字号和密度是用户偏好，换主题不会改变它们。
 * 这里只改草稿，不直接改生效值——改了没保存就关掉，什么都不该变。
 */
export function ThemeSettings({ selection: sel, fontSizes, density, onSelection, onFontSizes, onDensity }: Props) {
  const t = useTheme();
  const byAppearance = (a: Appearance) => t.themes.filter((x) => x.appearance === a);

  const toSystem = () => {
    const cur = t.active;
    onSelection({
      mode: 'system',
      light: cur.appearance === 'light' ? cur.id : 'light',
      dark: cur.appearance === 'dark' ? cur.id : 'dark',
    });
  };

  const step = (k: keyof FontSizes, dir: 1 | -1) => {
    const lim = FONT_SIZE_LIMITS[k];
    const next = Math.min(lim.max, Math.max(lim.min, fontSizes[k] + dir * lim.step));
    onFontSizes({ ...fontSizes, [k]: Number(next.toFixed(2)) });
  };

  const sizeKeys = Object.keys(SIZE_LABEL) as (keyof FontSizes)[];
  const sizesAreDefault = sizeKeys.every((k) => fontSizes[k] === DEFAULT_FONT_SIZES[k]);

  return (
    <>
      <div className="nx-field">
        <div className="nx-field-label">主题</div>
        <div className="nx-seg" style={{ marginBottom: 10 }}>
          <button data-active={sel.mode === 'system'} onClick={() => sel.mode !== 'system' && toSystem()}>
            跟随系统
          </button>
          <button
            data-active={sel.mode === 'fixed'}
            onClick={() => sel.mode !== 'fixed' && onSelection({ mode: 'fixed', theme: t.active.id })}
          >
            固定一个
          </button>
        </div>

        {sel.mode === 'system' ? (
          <>
            <label className="nx-theme-row">
              <span>浅色时</span>
              <ThemeSelect
                value={sel.light}
                themes={byAppearance('light')}
                onChange={(id) => onSelection({ ...sel, light: id })}
              />
            </label>
            <label className="nx-theme-row">
              <span>深色时</span>
              <ThemeSelect
                value={sel.dark}
                themes={byAppearance('dark')}
                onChange={(id) => onSelection({ ...sel, dark: id })}
              />
            </label>
          </>
        ) : (
          <label className="nx-theme-row">
            <span>使用</span>
            <ThemeSelect value={sel.theme} themes={t.themes} onChange={(id) => onSelection({ mode: 'fixed', theme: id })} />
          </label>
        )}

        <div className="nx-install-note">
          自定义主题放在 <code>~/.notex/themes</code>，改完切回应用即可选到。主题只能改颜色、字体、字重和标题比例，写法见项目里的{' '}
          <code>docs/THEME.md</code>。
        </div>

        {t.issues.length > 0 && (
          <div className="nx-theme-issues">
            <div className="nx-theme-issues-title">主题文件有 {t.issues.length} 处问题</div>
            <ul>
              {t.issues.map((issue, i) => (
                <li key={i}>
                  <code>{issue.source}</code> {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="nx-field">
        <div className="nx-field-label">字号</div>
        {sizeKeys.map((k) => {
          const lim = FONT_SIZE_LIMITS[k];
          const v = fontSizes[k];
          return (
            <div key={k} className="nx-theme-row">
              <span>{SIZE_LABEL[k]}</span>
              <div className="nx-stepper">
                <button aria-label={`${SIZE_LABEL[k]}字号减小`} disabled={v <= lim.min} onClick={() => step(k, -1)}>
                  −
                </button>
                <span className="nx-stepper-value">{v}px</span>
                <button aria-label={`${SIZE_LABEL[k]}字号增大`} disabled={v >= lim.max} onClick={() => step(k, 1)}>
                  ＋
                </button>
              </div>
            </div>
          );
        })}
        <div className="nx-theme-row">
          <span />
          <button className="nx-btn-mini" disabled={sizesAreDefault} onClick={() => onFontSizes(DEFAULT_FONT_SIZES)}>
            恢复默认
          </button>
        </div>
        <div className="nx-install-note">字号是你的偏好，换主题不会改变它；主题只决定标题比正文大多少。</div>
      </div>

      <div className="nx-field">
        <div className="nx-field-label">密度</div>
        <div className="nx-seg" style={{ marginBottom: 8 }}>
          {DENSITIES.map((d) => (
            <button key={d.id} data-active={density === d.id} onClick={() => onDensity(d.id)}>
              {d.label}
            </button>
          ))}
        </div>
        <div className="nx-install-note">
          行距、段距、代码块和 cell 之间的留白一起变。紧凑同屏能多看两成，宽松适合长文慢读。
        </div>
      </div>
    </>
  );
}
