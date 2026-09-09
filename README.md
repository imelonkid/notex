# NoteX

本地优先的可执行笔记。Markdown 写笔记，代码 cell 可在 **Java / Python / JavaScript** 之间用 tab 切换并执行。
UI 支持主题扩展；运行时自动识别本机环境，缺失时给出安装引导。

## 快速开始

桌面应用：

```bash
pnpm install
pnpm desktop
```

或者在浏览器里跑：

```bash
pnpm dev
```

打开 http://localhost:5173 。首次进入会自动探测本机的 JDK、Python 和 Node。

出安装包：

```bash
pnpm desktop:build
```

产物在 `src-tauri/target/release/bundle/macos/NoteX.app`，约 5 MB，
内核脚本和内置主题都打在里面。

## 笔记库

笔记以 Markdown 文件存在一个目录里，代码块就是围栏块，可以直接用 Git 管理。
输出存成同名的隐藏旁车 JSON。

- 默认位置是 `~/NoteX`，在设置里可以改，桌面版还能用系统目录选择器
- 配置写在 `~/.notex/config.json`，浏览器版和桌面版共用
- 改动防抖 500 毫秒自动写盘，⌘S 立即保存
- 文件在应用外被改动会自动读回来；如果本地也有未保存的改动，
  会停下来让你选择保留哪一边，不会静默覆盖

## 现状

阶段 0 到阶段 3 的主要功能已完成：

- Markdown cell 与代码 cell，拖拽排序、执行计数、自动保存
- 三种语言内核，跨 cell 保留变量，stdout 流式回显，异常与编译错误结构化展示
- 语言 tab 切换（不清空源码），tab 上叠加运行时状态点
- 内核驱动的语义补全（Java 走 JShell，Python 优先 jedi，JS 反射上下文）
- 中断长时间运行的 cell，三种语言均在 10 毫秒内生效且内核存活
- 富输出：集合与映射渲染成表格，图像渲染成 PNG，始终附带纯文本兜底
- Java 依赖注入：`//DEPS` 声明，有 Maven 就做完整传递解析
- 运行时自动探测：手动指定 → 环境变量 → PATH → sdkman / pyenv / conda / nvm / volta
- 缺失环境时在 cell 内展示安装引导卡片，含按平台的一键复制命令
- 浅色 / 深色 / 跟随系统，主题包可放在 `~/.notex/themes/`
- 导入导出 Markdown 与 ipynb，混合语言笔记可完整往返

尚未完成：Tauri 桌面壳（目前通过 `pnpm dev` 在浏览器中使用）。

## 目录结构

```
src/
  core/         模型、Markdown 序列化、内核协议、运行时注册表   （纯 TS，无 DOM）
  host/         HostBridge 接口 + 浏览器 / 开发服务器适配器
  runtimes/     各语言的探测、启动、安装引导定义
  ui/           React 组件、design tokens、主题、CodeMirror 集成
server/         Vite 插件，开发期提供 spawn / exec / 文件能力
kernels/        三个内核脚本，零依赖，用本机运行时直接启动
themes/         主题包
docs/           架构设计
prototype/      最初的视觉稿（Claude Design 画布格式，仅供参考）
```

## 内核协议

JSON Lines over stdio，每条协议消息以 RS (U+001E) 开头。任何不以它开头的行都被当作漏网的 stdout，
因此内核里意外的 `print` 不会让通信崩掉。

```jsonc
// 请求
{"id":"r1","op":"execute","code":"1 + 1"}
{"id":"r2","op":"complete","code":"System.ou","cursor":9}
// 响应，最后一条必为 done
{"id":"r1","type":"stream","name":"stdout","text":"hello\n"}
{"id":"r1","type":"result","data":{"text/plain":"2"}}
{"id":"r1","type":"done","status":"ok","durationMs":12}
```

## 测试

```bash
pnpm test
```

依次跑类型检查、序列化往返、三个内核的冒烟测试与富输出测试。也可以单独跑：

```bash
node kernels/test-kernel.mjs java
```

也接受 `python` 或 `js`，检查执行、跨 cell 状态、异常、编译错误、补全、中断、错误后恢复。
`node kernels/test-rich.mjs all` 单独检查富输出。

## Java 依赖

在 Java cell 顶部用 JBang 风格的注释声明，运行前会自动解析并注入类路径：

```java
//DEPS org.apache.commons:commons-lang3:3.14.0
//DEPS com.google.guava:guava:33.0.0-jre

import org.apache.commons.lang3.StringUtils;
StringUtils.reverse("NoteX")
```

装了 Maven 就用它做完整的传递依赖解析；没装则只下载显式声明的 jar，
并在输出里说明不含传递依赖。下载的 jar 缓存在 `~/.notex/deps/`。

## 运行时要求

| 语言 | 最低版本 | 说明 |
|---|---|---|
| Java | JDK 17 | 必须是 JDK，JRE 不含 `jdk.jshell` 模块 |
| Python | 3.8 | 装了 `jedi` 补全更准；自动识别 venv 和 conda |
| JavaScript | Node 18 | |

三者都不是必需的，缺哪个就只影响哪个语言的 cell。

## 主题

主题包是一个 JSON，只需提供想改的 token：

```jsonc
{
  "id": "solarized",
  "name": "Solarized Light",
  "appearance": "light",
  "tokens": { "bg": "#fdf6e3", "fg": "#657b83", "syn-keyword": "#859900" },
  "fonts": { "heading": "'Iowan Old Style', serif" }
}
```

放进项目的 `themes/` 或用户的 `~/.notex/themes/` 即被自动加载，在设置里切换。
两处同 id 时用户目录优先。主题包可以附带一个 CSS 文件，在 `css` 字段里写文件名。组件不写死任何颜色，
CodeMirror 高亮与 Markdown 代码块共用同一组 `--nx-syn-*` 变量，三处配色永远一致。

## Python 绘图

matplotlib 的图会自动显示，不需要写返回值，行为和 Jupyter 的 inline 后端一致：

```python
import matplotlib.pyplot as plt
plt.plot([1, 4, 9, 16])
```

内核在用户代码之前把 `MPLBACKEND` 锁成 `Agg`，所以不会弹出绘图窗口，
在 macOS 上也不会抢焦点。把 figure 作为末尾表达式返回同样能出图。

画中文标签需要指定含中文字形的字体，否则显示成方框：

```python
plt.rcParams["font.sans-serif"] = ["PingFang SC", "Heiti SC", "Arial Unicode MS"]
plt.rcParams["axes.unicode_minus"] = False
```

## Markdown cell 的编辑

- **双击**正文进入编辑框，编辑态只有编辑框，没有并排预览
- **Shift+Enter** 或 **Esc** 回到预览
- 焦点移到页面上别的地方也会自动回到预览
- 切换到别的应用不会退出编辑，回来时还在原处

## 布局与快捷键

- `⌘B` / `Ctrl+B` 折叠或展开左侧栏，状态记在本地
- 内容区宽度、页面留白、左侧装订线宽度都是 token，可在主题包里覆盖：
  `content-width`、`page-pad-x`（左）、`page-pad-right`（右）、
  `page-pad-top`、`gutter-width`

## 关于 Java 的两个进程

运行 Java 时会看到两个 `java` 进程，这是 JShell 的设计：一个是内核本身，
负责编译与消息转发；另一个是隔离的执行 JVM，用户代码跑在里面。
正因为隔离，死循环才能被中断，用户代码也无法把内核搞崩。

两个进程都带了 `-Dapple.awt.UIElement=true`，在 macOS 上不会弹出 Dock 图标，
也不会抢走当前窗口的焦点。内核进程另外带 `-Djava.awt.headless=true`。

## 已知限制

- 三个内核相互独立，不共享变量。这是刻意的简化。
- 不支持标准输入，`Scanner` 和 `input()` 会挂起。
- Windows 上信号语义不同，中断目前只在 macOS 和 Linux 验证过。
- Markdown 是正本，输出存在旁车 JSON 里；目前导入 Markdown 不会自动带回输出。

后续计划见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) 第 8 节。
