<!-- 本文件由 pnpm theme:docs 根据 src/core/theme.ts 生成，请勿手改 -->

# 主题字段参考

协议版本 `1`。这里列的是主题文件里**全部**可以写的字段，不在这里的一律忽略。
原则、格式、继承与校验规则见 [THEME.md](THEME.md)；在编辑器里引用 [theme.schema.json](theme.schema.json) 可以获得补全和校验。

「默认」两列怎么读：

- 写着具体值的字段，主题没写时从**同明暗的默认主题**继承——浅色主题取「默认浅色」列，深色主题取「默认深色」列
- 写着「跟随」的字段，主题没写时**等于同组的另一个字段**。只改基础配色，这些派生颜色会自动跟着协调

## 颜色 `colors`

### 表面

| 字段 | 类型 | 说明 | 默认浅色 | 默认深色 |
|---|---|---|---|---|
| `bg` | 颜色 | 页面底色 | `#fdfdfc` | `#1a1a18` |
| `bg-subtle` | 颜色 | 次一档的底色：代码块、侧栏 | `#f7f7f4` | `#212120` |
| `bg-hover` | 颜色 | 悬停时的底色 | `#f2f2ee` | `#282826` |
| `bg-active` | 颜色 | 选中项的底色 | `#f0f0ec` | `#2f2f2c` |
| `border` | 颜色 | 分隔线与弱描边 | `#e6e6e1` | `#33332f` |
| `border-strong` | 颜色 | 输入框、按钮等强描边 | `#d8d8d2` | `#45453f` |

### 文字

| 字段 | 类型 | 说明 | 默认浅色 | 默认深色 |
|---|---|---|---|---|
| `fg` | 颜色 | 主文字，也是最深的一档 | `#1c1c1a` | `#e8e8e2` |
| `fg-soft` | 颜色 | 次一档 | `#3a3a36` | `#d0d0c8` |
| `fg-muted` | 颜色 | 说明文字 | `#6f6f6a` | `#a0a098` |
| `fg-faint` | 颜色 | 更弱：占位、提示 | `#a3a39c` | `#75756e` |
| `fg-ghost` | 颜色 | 最弱：图标、行号 | `#c2c2bb` | `#55554f` |
| `fg-invert` | 颜色 | 深色按钮上的文字 | `#fdfdfc` | `#1a1a18` |

### 语义

| 字段 | 类型 | 说明 | 默认浅色 | 默认深色 |
|---|---|---|---|---|
| `accent` | 颜色 | 强调色 | `#3f5a7d` | `#8fb3d9` |
| `danger` | 颜色 | 危险、出错 | `#9c3423` | `#e08b7a` |
| `warn` | 颜色 | 警告 | `#8a6d1f` | `#d4b062` |
| `success` | 颜色 | 成功 | `#4b7d5b` | `#86c19b` |
| `selection` | 颜色 | 选中文字的底色 | `#e8e8e2` | `#3a3a34` |

### 阴影与遮罩

| 字段 | 类型 | 说明 | 默认浅色 | 默认深色 |
|---|---|---|---|---|
| `shadow` | 颜色 | 菜单、弹层的阴影颜色 | `rgba(0, 0, 0, 0.16)` | `rgba(0, 0, 0, 0.5)` |
| `overlay` | 颜色 | 对话框背后的遮罩 | `rgba(0, 0, 0, 0.28)` | `rgba(0, 0, 0, 0.55)` |

### 语法高亮

| 字段 | 类型 | 说明 | 默认浅色 | 默认深色 |
|---|---|---|---|---|
| `syn-keyword` | 颜色 | 关键字 | `#7c3aed` | `#c4a2f5` |
| `syn-string` | 颜色 | 字符串 | `#15803d` | `#9ed9ab` |
| `syn-comment` | 颜色 | 注释 | `#8a8a84` | `#75756e` |
| `syn-number` | 颜色 | 数字 | `#b45309` | `#f0b464` |
| `syn-type` | 颜色 | 类型 | `#0e7490` | `#7fd3e0` |
| `syn-function` | 颜色 | 函数名 | `#1d4ed8` | `#93bdf5` |
| `syn-variable` | 颜色 | 变量 | `#1c1c1a` | `#e8e8e2` |
| `syn-operator` | 颜色 | 运算符 | `#6f6f6a` | `#a0a098` |
| `syn-punct` | 颜色 | 标点 | `#6f6f6a` | `#a0a098` |

### 代码编辑器

| 字段 | 类型 | 说明 | 默认浅色 | 默认深色 |
|---|---|---|---|---|
| `editor-selection` | 颜色 | 编辑器里选中文字的底色 | `#d6e2f0` | `#3a4a5e` |
| `editor-active-line` | 颜色 | 光标所在行的底色 | `rgba(0, 0, 0, 0.025)` | `rgba(255, 255, 255, 0.03)` |
| `editor-bg` | 颜色 | 编辑器底色 | 跟随 `bg-subtle` | 跟随 `bg-subtle` |
| `editor-caret` | 颜色 | 光标 | 跟随 `fg` | 跟随 `fg` |
| `editor-gutter` | 颜色 | 行号 | 跟随 `fg-ghost` | 跟随 `fg-ghost` |

### 笔记大标题

| 字段 | 类型 | 说明 | 默认浅色 | 默认深色 |
|---|---|---|---|---|
| `title` | 颜色 | 笔记大标题的颜色 | 跟随 `fg` | 跟随 `fg` |

### Markdown

| 字段 | 类型 | 说明 | 默认浅色 | 默认深色 |
|---|---|---|---|---|
| `md-text` | 颜色 | 正文 | 跟随 `fg-soft` | 跟随 `fg-soft` |
| `md-heading` | 颜色 | 标题与表头 | 跟随 `fg` | 跟随 `fg` |
| `md-strong` | 颜色 | 加粗 | 跟随 `fg` | 跟随 `fg` |
| `md-link` | 颜色 | 链接 | 跟随 `accent` | 跟随 `accent` |
| `md-code` | 颜色 | 行内代码的文字 | 跟随 `danger` | 跟随 `danger` |
| `md-code-bg` | 颜色 | 行内代码的底色 | 跟随 `bg-hover` | 跟随 `bg-hover` |
| `md-pre` | 颜色 | 代码块的文字 | 跟随 `fg` | 跟随 `fg` |
| `md-pre-bg` | 颜色 | 代码块的底色 | 跟随 `bg-subtle` | 跟随 `bg-subtle` |
| `md-pre-border` | 颜色 | 代码块的描边 | 跟随 `border` | 跟随 `border` |
| `md-quote` | 颜色 | 引用的文字 | 跟随 `fg-muted` | 跟随 `fg-muted` |
| `md-quote-border` | 颜色 | 引用左侧的竖线 | 跟随 `border-strong` | 跟随 `border-strong` |
| `md-table-border` | 颜色 | 表格线 | 跟随 `border` | 跟随 `border` |
| `md-table-head-bg` | 颜色 | 表头底色 | 跟随 `bg-subtle` | 跟随 `bg-subtle` |
| `md-rule` | 颜色 | 分隔线 | 跟随 `border` | 跟随 `border` |

## 字体 `fonts`

### 字体

| 字段 | 类型 | 说明 | 默认浅色 | 默认深色 |
|---|---|---|---|---|
| `body` | 字体栈 | 界面与正文 | `'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif` | `'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', sans-serif` |
| `mono` | 字体栈 | 代码 | `ui-monospace, 'SF Mono', Menlo, Consolas, monospace` | `ui-monospace, 'SF Mono', Menlo, Consolas, monospace` |
| `title` | 字体栈 | 展示用：笔记大标题、品牌名、对话框标题 | `'Newsreader', Georgia, 'Songti SC', serif` | `'Newsreader', Georgia, 'Songti SC', serif` |
| `heading` | 字体栈 | Markdown 标题 | 跟随 `body` | 跟随 `body` |

## 字重与比例 `typography`

### 字重

| 字段 | 类型 | 说明 | 默认浅色 | 默认深色 |
|---|---|---|---|---|
| `title-weight` | 字重 | 笔记大标题 | `900` | `900` |
| `heading-weight` | 字重 | Markdown 标题 | `600` | `600` |
| `strong-weight` | 字重 | 加粗与表头 | `600` | `600` |

### 标题比例

| 字段 | 类型 | 说明 | 默认浅色 | 默认深色 |
|---|---|---|---|---|
| `h1` | 倍数 0.75–3 | 一级标题是正文字号的几倍 | `1.6` | `1.6` |
| `h2` | 倍数 0.75–3 | 二级标题 | `1.333` | `1.333` |
| `h3` | 倍数 0.75–3 | 三级标题 | `1.2` | `1.2` |
| `h4` | 倍数 0.75–3 | 四级标题 | `1.067` | `1.067` |
| `h5` | 倍数 0.75–3 | 五级标题 | `1` | `1` |
| `h6` | 倍数 0.75–3 | 六级标题 | `1` | `1` |
| `code-scale` | 倍数 0.7–1.2 | 行内代码是正文字号的几倍 | `0.87` | `0.87` |

## 取值格式

| 类型 | 允许的写法 |
|---|---|
| 颜色 | `#rgb` `#rgba` `#rrggbb` `#rrggbbaa`、`rgb()` `rgba()` `hsl()` `hsla()`、`transparent` |
| 字体栈 | 普通的 CSS 字体列表；不能出现 `; { } ( ) < > \ / * !` 和换行，引号要成对，最长 300 字符 |
| 字重 | 整数 `100`、`200` … `900` |
| 倍数 | 数字，范围见各字段；实际字号 = 正文字号（用户设置）× 倍数 |
