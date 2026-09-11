# 调研：主题能改什么，框架守什么

> 起因：决定把「外观」和「主题包」合成一个「选主题」之前，先把边界划清——
> 主题能改到哪一层，哪些必须由框架握在手里。
>
> 看了 8 个产品的官方文档：VS Code、Zed、Warp、Sublime Text、JupyterLab、Obsidian、Typora、Notion。
> Sublime Text 和 Warp 的官网抓取失败，相关结论来自搜索结果摘要和它们的 GitHub 仓库；
> Notion 没有官方主题文档，结论来自第三方教程。

## 1. 一句话

主流做法分两派，**分界线不在"能改多少"，而在"契约是什么"**。

- **数据派**（VS Code、Zed、Warp）：主题是一份数据，只能往框架预留的槽位里填值。
  框架升级不会弄坏主题；代价是槽位以外的东西一概改不了。
- **样式表派**（Obsidian、Typora）：主题是一份 CSS，理论上什么都能改。
  靠文档化的 CSS 变量充当半个契约，变量以外的选择器不保证稳定。
- **JupyterLab 在中间**：主题也是 CSS，但变量明确分成 public 和 private——
  public 是 API，private 是实现细节，随时会变。

## 2. 八家怎么做

| 产品 | 主题载体 | 颜色 | 字体 / 字号 | 尺寸 / 间距 | 自定义 CSS | 浅深色怎么切 |
|---|---|---|---|---|---|---|
| **VS Code** | JSON：`colors` `tokenColors` `semanticTokenColors` `type` | ✓ | ✗ 字体是用户设置 | ✗ | ✗ 官方不支持 | `window.autoDetectColorScheme` + 「首选浅色主题」「首选深色主题」 |
| **Zed** | JSON 主题家族，每个主题声明 `appearance` | ✓ 含语法、终端 | ✗ `buffer_font_family` 等是设置 | ✗ | ✗ | `theme: { mode: "system", light, dark }` |
| **Warp** | YAML，十几个颜色 + `details: darker/lighter` | ✓ | ✗ | ✗ | ✗ | `details` 声明明暗 |
| **Sublime Text** | 拆成两件：配色方案管语法，主题管界面外壳 | ✓ | 外壳可以（`font.size`） | 外壳可以（边距、贴图层） | ✗ 自有规则格式 | `"theme": "auto"` + `light_theme` / `dark_theme`，配色方案同理，两件分开设 |
| **JupyterLab** | 主题扩展（npm 包），提供 `--jp-*` 变量 | ✓ | ✓ 变量里有 | ✓ 变量里有 | CSS，但约定只改 public 变量 | 浅、深是两个主题 |
| **Obsidian** | `theme.css` + manifest，400 多个文档化变量 | ✓ | ✓ 字体、字号、字重、行高、段距 | ✓ | ✓ 整份 CSS，另有 snippets | 一份主题里写 `.theme-light` / `.theme-dark`；「基础配色」是独立设置 |
| **Typora** | 一个 `.css` 就是一个主题 | ✓ | ✓ | ✓ | ✓ 全部 | 浅、深可各选一个主题；也能用 `prefers-color-scheme` 写自适应主题 |
| **Notion** | 没有主题 | — | — | — | — | 浅色 / 深色 / 跟随系统 |

## 3. 看得出的五条规律

**一、"跟随系统"几乎都是"选两个主题"。**
VS Code 的首选浅色 / 深色主题、Zed 的 `mode / light / dark`、Sublime 的 `light_theme / dark_theme`、
Typora 浅深各选一个——都是这个模型。**和我们选定的"合并成一个选主题"是同一条路。**

**二、每个主题都得说清自己是浅还是深。**
Zed、VS Code、Warp 让每个主题声明明暗；Obsidian 要求一份主题里浅深两套都写。
框架据此决定"主题没写到的槽位用哪套默认值"。
我们现在的 `appearance` 字段没有任何代码在读，这正是 Nord Dark 配浅色外观时混色的根源。

**三、数据派一律不让主题碰字体。**
VS Code 和 Zed 都把字体、字号做成用户设置，和主题并列放在 settings 里。
理由不难猜：字号关乎视力和屏幕，是人的偏好；换个配色不该把人调好的字号冲掉。

但**笔记类产品恰恰相反**：Obsidian、Typora 都让主题管排版，因为对笔记来说排版就是主题的个性。
NoteX 是笔记本，更像后者。两边的道理其实可以兼得——
**基准字号归用户，排版比例归主题**（见 §4 灰区二）。

**四、放开得越多，稳定性越难保证。**
Obsidian 的文档没有对类名做任何稳定性承诺。
VS Code 干脆不开 CSS——社区扩展 Custom CSS and JS Loader 靠改安装目录里的文件注入样式，
VS Code 的完整性校验会随之报「安装似乎已损坏」。需求真实存在，框架明确拒绝。
JupyterLab 用 public / private 变量划线，是两者之间最干净的做法。

**五、没有一家允许主题带代码。**

## 4. NoteX 的边界（提案）

### 框架守住的：主题碰不到

| 范围 | 为什么 |
|---|---|
| 布局结构：侧栏、主区、装订线怎么摆，组件由哪些部件组成 | 改了就是另一个应用，也没法保证功能完整 |
| 交互与行为：快捷键、编辑与预览切换、拖拽、菜单内容 | 行为不属于外观 |
| 内容语义：Markdown 渲染成什么 HTML、净化规则、链接拦截 | 这是安全边界，主题不能放宽 |
| 状态的含义：运行标记 `[ ] [*] [✓] [✗] [–]` 各代表什么 | 颜色可以换，符号和状态机不能换 |
| 布局几何：侧栏宽、装订线宽、页边距、编辑器行高 | 改了会错位，比如运行标记和代码首行对不齐 |
| 可访问性底线：焦点可见、点击区域够大、状态不只靠颜色表达 | 主题再怎么调也不能低于这条线 |
| 脚本 | 主题不能带 JS |

### 主题负责的：通过 token

| 范围 | 现状 |
|---|---|
| 明暗声明 `appearance` | 有字段，**没生效** |
| 配色：表面、文字五档、语义色、选中 | 已是 token |
| 阴影与遮罩 | **还有 6 处写死**（阴影 5、遮罩 1），暗色主题下不对 |
| 语法高亮、编辑器配色 | 已是 token |
| 字体族：界面、正文、标题、等宽 | 已是 token |
| 排版风格：标题比例、字重、行高、段距、引用 / 行内代码 / 表格 / 分隔线 | 已是 token（37 个 `md-*`） |
| 笔记大标题 | 已是 token（4 个 `title-*`） |
| 圆角 | 已是 token |

### 用户设置：不随主题变

| 项目 | 参照 |
|---|---|
| 跟随系统时，浅色用哪个主题、深色用哪个主题 | VS Code、Zed、Sublime、Typora |
| 基准字号：界面、正文、代码 | VS Code、Zed |

### 灰区：需要拍板

> 三处灰区都已拍板，结论见 §6。

**一、`css` 字段留不留？**

| | 留（Obsidian、Typora 路线） | 不留（VS Code、Zed 路线） |
|---|---|---|
| 灵活度 | token 没覆盖到的也能改 | 只能改 token |
| 升级 | 可能打碎主题 | 不会 |
| 安全 | 插进页面的 CSS 不做过滤 | 无此问题 |

建议：**留，但明确分级**，学 JupyterLab——文档只承诺 token 和一小撮公开类名，其余一概不保证。

**二、字号归主题还是归用户？**

建议：**基准字号归用户，主题只定比例。**
`md-h1-size` 从 `24px` 改成 `1.6em` 这类相对值；正文基准字号挪进设置。
这样用户调大字号后换主题，字号不会被冲掉；主题的"标题比正文大多少"依然成立。

**三、主题能不能改尺寸密度（侧栏宽、行距、页边距）？**

建议：**暂不开放。** 320 处写死的 px 大多和对齐有关，逐个开放成 token 得不偿失。
以后真有需求，给一个「紧凑 / 标准 / 宽松」三档，而不是几十个数字。

## 5. 落地清单

按依赖顺序：

1. 默认浅色、默认深色做成主题文件，`tokens.css` 只留兜底
2. `appearance` 生效：主题没写的 token，从同明暗的默认主题继承
3. 设置里「外观」+「主题包」合并成「主题」；「跟随系统」= 选一个浅色主题 + 一个深色主题
4. 6 处写死的颜色改成 `shadow` / `overlay` token
5. token 分 public / private：public 写进 `THEME.md` 并承诺兼容，其余标 private
6. 看灰区二的结论：`md-*` 字号改相对单位，基准字号挪进设置
7. 看灰区一的结论：`css` 字段是标实验性，还是删掉

## 6. 结论（已定）

两条原则：**稳定可控**——不能因为主题引入额外风险；**有限度的灵活**——只开放少数、明确的维度。

| 问题 | 结论 |
|---|---|
| 外观与主题包 | 合并成一个「主题」：固定一个，或跟随系统（浅色时 A、深色时 B）。每个主题必须声明 `appearance` |
| `css` 字段 | **不支持**。另外，主题的值本身也会拼进样式表，所以值也要按类型白名单校验，否则值里照样能注入 CSS |
| 字号 | 基准字号（界面、正文、代码）归用户设置；主题只定标题、行内代码相对正文的倍数 |
| 尺寸与间距 | **不开放**，包括正文行距、段距、标题上下间距、列表缩进、边框粗细、圆角 |
| 主题能改的 | 颜色、字体、字重、标题比例，只有这四类 |
| 契约 | 协议字段与内部 CSS 变量解耦。字段表是唯一数据源，字段参考和 JSON Schema 由它生成，测试保证不脱节 |

和 §4 的提案相比收紧了一处：§4 把行高、段距列在"主题负责"，结论是归框架。

用户文档见 [THEME.md](THEME.md)。

## 参考

- [VS Code — Color Theme 扩展指南](https://code.visualstudio.com/api/extension-guides/color-theme)
- [VS Code — Themes（自动跟随系统、首选浅深主题）](https://code.visualstudio.com/docs/configure/themes)
- [Zed — Themes（`mode / light / dark`、theme_overrides）](https://zed.dev/docs/themes)
- [Zed — 主题扩展格式（主题家族、appearance）](https://zed.dev/docs/extensions/themes)
- [Zed — 配置（字体是设置不是主题）](https://zed.dev/docs/configuring-zed)
- [Warp — Custom Themes](https://docs.warp.dev/terminal/appearance/custom-themes/)（官网抓取失败，据搜索摘要）
- [warpdotdev/themes](https://github.com/warpdotdev/themes)
- [Sublime Text — Color Schemes](https://www.sublimetext.com/docs/color_schemes.html)、[Themes](https://www.sublimetext.com/docs/themes.html)（官网抓取失败，据搜索摘要）
- [JupyterLab — CSS 约定（public / private 变量）](https://jupyterlab.readthedocs.io/en/stable/developer/css.html)
- [Obsidian — Build a theme](https://docs.obsidian.md/Themes/App+themes/Build+a+theme)
- [Obsidian — Typography 变量](https://docs.obsidian.md/Reference/CSS+variables/Foundations/Typography)
- [Typora — About Themes](https://support.typora.io/About-Themes/)
- [vscode-custom-css #66 — 注入 CSS 触发"安装已损坏"](https://github.com/be5invis/vscode-custom-css/issues/66)
- [Notion 外观设置（第三方教程）](https://www.notionapps.com/blog/dark-mode-notion-complete-guide-2025)
