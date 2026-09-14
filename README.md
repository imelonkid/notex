<div align="center">

<img src="assets/icon.png" alt="NoteX" width="104" />

# NoteX

**代码即笔记，笔记可运行。**

用 Markdown 记录思考，在同一篇笔记里运行 Java、Python 和 JavaScript。  
文件保存在本地，可用 Git 管理，也可用任何编辑器打开。

![平台](https://img.shields.io/badge/平台-macOS-1c1c1a?style=flat-square)
![体积](https://img.shields.io/badge/安装包-4.8_MB-3f5a7d?style=flat-square)
![内核](https://img.shields.io/badge/内核-Java_·_Python_·_JS-4b7d5b?style=flat-square)
![存储](https://img.shields.io/badge/存储-纯_Markdown-8a6d1f?style=flat-square)

</div>

---

## 写下思路，运行验证

NoteX 是一个本地优先的可执行笔记本。文字、代码和结果放在一起，从记录思路到运行验证，都在同一篇笔记里完成。

磁盘上的笔记就是普通的 `.md` 文件：

````markdown
# 采样分布

用 numpy 生成一组样本，查看分布形状。

```python {id=c1}
import numpy as np, matplotlib.pyplot as plt
rng = np.random.default_rng(42)
plt.hist(rng.normal(170, 7, 2000), bins=45)
```
````

同一个代码块，在 GitHub 上能高亮，在 VS Code 里能编辑，在 NoteX 里能运行。

从网页复制一段带图片的内容粘进文本 cell，会自动转成 Markdown：标题、加粗、列表、表格、代码块都保留，图片下载到笔记同目录的 `.assets/` 里并写成相对路径，截图直接粘也行。文件里只有相对路径，用 Git 或别的编辑器打开照常显示。

围栏上的 `{id=…}` 标记它是一个可执行 cell。文本 cell 里也可以写代码块，那只用来展示，不会变成可运行的 cell；想运行就右键「转为代码」，围栏会被自动去掉。从别处拿来的 Markdown 没有这个约定，首次打开时所有认得的代码块都可运行，保存后就带上标记。

## 三种语言，一篇笔记

每个代码块都可以选择 `JAVA`、`PY` 或 `JS`。点击左上角的标签即可切换，已有源码会保留。

每种语言有独立内核：同一种语言的变量跨代码块保留，不同语言之间互不共享。

| 语言 | 冷启动 | 中断响应 | 补全来源 |
|---|---|---|---|
| Java | ~0.9 s | 6 ms | JShell 语义补全 |
| Python | ~20 ms | 1 ms | 优先使用 jedi，未安装时使用 rlcompleter |
| JavaScript | ~20 ms | 1 ms | 运行时上下文反射 |

三个内核都是零依赖的单文件脚本，直接使用本机的 `java` / `python3` / `node` 启动，无需额外安装内核组件。

### 补全跟得上上下文

Java 补全基于 JShell 的 `SourceCodeAnalysis`，能识别变量及其类型。

在上一个代码块中声明变量，下一个代码块就能接着用。输入 `.`，即可查看带类型信息的方法补全。

### 运行结果，就地呈现

- **Python**：matplotlib 图表自动显示，无需显式返回，行为与 Jupyter 的 inline 后端一致。
- **Java**：集合和映射渲染为表格，`BufferedImage` 渲染为图片。

### Java 依赖，写进笔记

通过 `//DEPS` 声明依赖，即可在代码中使用：

```java
//DEPS org.apache.commons:commons-lang3:3.14.0

import org.apache.commons.lang3.StringUtils;
StringUtils.reverse("NoteX")
```

已安装 Maven 时，自动解析传递依赖；未安装时，只下载显式声明的 jar。

## 笔记相连，思路相通

支持 wiki 链接和标准 Markdown 链接，也可以直接指向某个小节：

```markdown
[[数据分布图]]              链接到笔记，输入 [[ 可触发补全
[[数据分布图#箱线图]]       链接到笔记中的小节
[看看图表](数据分布图.md)   标准 Markdown 链接
```

- **边写边建**：目标笔记不存在时，链接显示为虚线，点击即可创建。
- **回看引用**：笔记末尾的反向链接面板会列出谁引用了这一篇。
- **改名不断链**：笔记改名或移动后，其它笔记里指向它的链接会自动改写。
- **打开外链**：外部链接交给系统浏览器，不打断当前笔记。

`⌘K` 打开搜索面板：按标题和正文搜全库，空着不填就列最近更新的笔记，`↑↓` 选择 `↩` 打开。

## 文件在本地，选择在你

笔记正文保存在 Markdown 文件中，运行结果单独保存在同目录的隐藏文件里。

```text
~/NoteX/
├── 工作/
│   ├── 周报.md
│   └── 项目A/
│       └── 设计文档.md
├── 数据分布图.md
├── .数据分布图.outputs.json    ← 运行结果，隐藏文件
└── .assets/                    ← 粘贴进来的图片，正文里用相对路径引用
```

你可以用 Git 管理版本，也可以随时换一个编辑器继续写。

在 Finder 或其他编辑器中修改文件后，NoteX 会自动读取更新。如果应用内外都改过，会提示你选择保留哪一份，不会静默覆盖。

删除笔记或文件夹会移到系统废纸篓，不会直接抹掉。

`⌘Z` 在编辑框里逐段撤销文字，在编辑框外撤销整段编辑或一次结构操作：删掉的 cell 能拿回来，移动、转换、换语言、粘贴同样可以撤销，`⇧⌘Z` 重做。撤销不会抹掉后来跑出的运行结果。

## 快速开始

启动桌面应用：

```bash
pnpm install
pnpm desktop
```

在浏览器中启动：

```bash
pnpm dev          # 打开 http://localhost:5173
```

构建桌面应用：

```bash
pnpm desktop:build   # → src-tauri/target/release/bundle/macos/NoteX.app
```

### 按需安装语言环境

只需安装你要使用的语言环境，缺少某一种不会影响其他语言的代码块。

| 语言 | 最低版本 | 说明 |
|---|---|---|
| Java | JDK 17 | 必须是 JDK，JRE 不含 `jdk.jshell` |
| Python | 3.8 | 自动识别 venv 与 conda |
| JavaScript | Node 18 | |

首次启动会按以下顺序查找运行时：

1. 手动指定的路径
2. 环境变量
3. `PATH`
4. sdkman / pyenv / conda / nvm / volta 等版本管理器的常见位置

找不到对应环境时，运行按钮会提示当前平台的安装命令，也可以在设置里一键下载内置运行时：Python 科学计算版（numpy、pandas、matplotlib、scipy）、jlink 裁过的 JDK 17、Node 20，装到 `~/.notex/runtimes`，启动时与本机的 `PYTHONPATH`、conda、`JAVA_TOOL_OPTIONS` 之类隔离，不碰系统里的环境。包和清单维护在 [imelonkid/notex-runtimes](https://github.com/imelonkid/notex-runtimes)，下载走系统代理，网络不通时也可以先手动下好再「选择本地包」安装。

装了多个环境时，设置里会列出全部候选，用哪个由你选；换了选择要重启内核才生效，侧栏的圆点会提醒。

## 换个主题，继续写

一个 JSON 文件就是一个主题。主题只能改四类东西：**颜色、字体、字重、标题比例**。尺寸、间距、布局归应用自己管，主题碰不到——换主题不会把界面弄乱，也不会引入额外风险。

```json
{
  "notex-theme": 1,
  "id": "nord",
  "name": "Nord Dark",
  "appearance": "dark",
  "colors": { "bg": "#2e3440", "fg": "#eceff4", "syn-keyword": "#81a1c1" }
}
```

没写的字段从同明暗的默认主题继承，只改几个颜色也能得到完整的主题。放进 `~/.notex/themes/`，在设置里选中；改完切回应用即生效。

设置里可以「跟随系统」，分别指定浅色和深色时用哪个主题。字号和密度（行距、段距、cell 间距，紧凑 / 标准 / 宽松三档）是个人偏好，单独设置，换主题不会改变它们。设置里的改动点「保存」才生效。

- [主题说明](docs/THEME.md)：原则、格式、继承与校验规则
- [字段参考](docs/THEME-REFERENCE.md)：全部可写字段与默认值
- [theme.schema.json](docs/theme.schema.json)：在编辑器里补全和校验
- [示例主题](examples/themes/ink.json)

## 架构

UI 负责交互，Core 负责笔记与执行逻辑，Host 提供文件和进程能力。三种语言分别交给各自的内核执行。

```mermaid
flowchart TB
    UI["UI 层<br/>React + CodeMirror 6<br/>统一使用 design token"]
    Core["Core 层<br/>笔记模型 · Markdown 序列化<br/>内核协议 · 链接索引<br/>纯 TS，无 DOM 或宿主依赖"]
    Host["Host 层<br/>HostBridge 接口"]
    Tauri["TauriHost<br/>桌面壳"]
    Dev["DevServerHost<br/>开发服务器"]
    Browser["BrowserHost<br/>纯浏览器"]
    K1["JavaKernel.java<br/>JShell"]
    K2["kernel.py<br/>持久 globals"]
    K3["kernel.mjs<br/>vm context"]

    UI --> Core
    Core --> Host
    Host --> Tauri
    Host --> Dev
    Host --> Browser
    Tauri -.JSON Lines over stdio.-> K1
    Tauri -.-> K2
    Tauri -.-> K3
```

三条设计约束：

1. **UI 不直接操作文件和进程**：通过 Core 工作，可在纯浏览器中运行。
2. **Core 不依赖宿主**：更换宿主时，无需修改业务代码。
3. **内核无需构建，也无额外依赖**：以源码文件分发，由本机运行时直接启动。

### 内核协议

应用与内核通过标准输入输出交换 JSON Lines 消息。每条协议消息以 RS（U+001E）开头，其余行按普通 stdout 处理，避免意外的 `print` 干扰通信。

以下省略 RS 前缀：

```jsonc
{"id":"r1","op":"execute","code":"1 + 1"}
{"id":"r1","type":"result","data":{"text/plain":"2"}}
{"id":"r1","type":"done","status":"ok","durationMs":12}
```

无需启动界面，也可以单独测试内核：

```bash
node kernels/test-kernel.mjs java     # 也接受 python / js
```

## 测试

```bash
pnpm test
```

依次执行类型检查、序列化往返、链接解析、路径安全、链接索引、主题协议、内核中断升级、运行时隔离与清单、富文本粘贴、撤销栈，以及三个内核的冒烟测试和富输出测试。

重点覆盖以下边界：

- Markdown 与 ipynb 的往返一致性
- 路径越界防护和危险协议拦截
- 跨目录链接的消歧，改名后的链接改写
- 内核中断只升级到被中断的那条请求，SIGINT 不杀 Java 内核
- 运行时清单的校验（id、版本、sha256、下载地址）
- ISO8601 转换的闰年边界

Rust 侧测试单独运行：

```bash
pnpm test:rust
```

## 目录结构

```text
src/
  core/         模型 · Markdown 序列化 · 内核协议 · 链接索引 · 运行时注册表
  host/         HostBridge 接口及三个宿主适配器
  runtimes/     各语言的探测、启动与安装引导
  ui/           React 组件 · design token · 主题 · CodeMirror 集成
server/         Vite 插件，开发期提供 spawn / exec / 文件能力
kernels/        三个零依赖内核脚本
runtimes/       内置运行时包的构建与发布脚本（正式流水线在 notex-runtimes 仓库）
src-tauri/      桌面壳，以 Rust 实现文件与进程能力
themes/         主题包
assets/         标识源文件与应用图标底稿
public/         favicon 等随页面分发的静态文件
docs/           架构设计与方案
```

## 已知限制

- 目前仅在 macOS 上验证。Windows 的中断功能仍需适配信号机制。
- 三种语言的内核独立运行，不共享变量。
- 不支持标准输入，`Scanner` 和 `input()` 会挂起。
- 每种语言同一时刻只用一个运行时，切换后要重启内核。
- 笔记移到别的文件夹时，`.assets/` 里的图片不会跟着走。
- 目录最多支持三级。

## 设计文档

- [架构设计](docs/ARCHITECTURE.md)
- [全局评审与修补记录](docs/CR-全局评审.md)
- [主题](docs/THEME.md)
- [主题边界调研](docs/RESEARCH-主题边界.md)
- [目录与超链方案](docs/PROPOSAL-目录与超链.md)
- [cell 操作重构](docs/PROPOSAL-cell操作重构.md)
- [执行序号调研](docs/RESEARCH-执行序号.md)
