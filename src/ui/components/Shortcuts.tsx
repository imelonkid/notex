const GROUPS: Array<{ title: string; items: Array<[string, string]> }> = [
  {
    title: '运行',
    items: [
      ['⌘↩', '运行当前 cell'],
      ['⇧↩', '运行并移到下一个 / 文本回到预览'],
      ['⌘⇧↩', '全部运行'],
    ],
  },
  {
    title: '编辑',
    items: [
      ['⌥⌘↩', '在下方插入代码 cell'],
      ['⌥↓ / ⌥↑', '在下方 / 上方插入文本 cell'],
      ['⌘⌫', '删除当前 cell'],
      ['[[', '在文本里唤出笔记补全'],
    ],
  },
  {
    title: '其它',
    items: [
      ['⌘S', '立即保存'],
      ['⌘B', '折叠或展开侧栏'],
      ['⌘/', '打开这个面板'],
    ],
  },
];

/** 快捷键速查。右键菜单里也标了键位，这里是完整清单。 */
export function Shortcuts({ onClose }: { onClose(): void }) {
  return (
    <div className="nx-modal-backdrop" onClick={onClose}>
      <div className="nx-modal" style={{ width: 'min(460px, 92vw)' }} onClick={(e) => e.stopPropagation()}>
        <h2>快捷键</h2>
        {GROUPS.map((g) => (
          <div key={g.title} className="nx-field">
            <div className="nx-field-label">{g.title}</div>
            {g.items.map(([key, desc]) => (
              <div key={key} className="nx-shortcut-row">
                <kbd className="nx-kbd">{key}</kbd>
                <span>{desc}</span>
              </div>
            ))}
          </div>
        ))}
        <div className="nx-modal-footer">
          <span style={{ flex: 1 }} />
          <button className="nx-btn-primary" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  );
}
