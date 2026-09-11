/**
 * 侧栏开关。
 *
 * 用 macOS 通行的侧栏图标（Finder、备忘录、Xcode 都是它），不用箭头：
 * 单个 ‹ 容易被读成「返回」，« 又像「快退」——笔记之间能跳转，以后多半要有前进后退。
 * 展开和折叠用同一个样式，只是侧栏那一格实心与否。
 */
export function SidebarToggle({ collapsed, onToggle }: { collapsed: boolean; onToggle(): void }) {
  const label = collapsed ? '展开侧栏' : '折叠侧栏';
  return (
    <button
      className="nx-sidebar-toggle"
      title={`${label}（⌘B）`}
      aria-label={label}
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
        <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        {!collapsed && <rect x="2.4" y="3.4" width="3.6" height="9.2" rx="1.2" fill="currentColor" opacity="0.28" />}
        <path d="M6.25 3v10" stroke="currentColor" strokeWidth="1.3" />
      </svg>
    </button>
  );
}
