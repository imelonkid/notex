# NoteX 架构设计

> 目标：一个本地优先的可执行笔记应用。Markdown 写笔记，代码 cell 可在 Java / Python / JS 之间切换并执行。
> UI 支持主题扩展；运行时内核轻量、自动识别本地环境、缺失时引导安装。

## 1. 总览

```
┌──────────────────────────────────────────────────────────────┐
│  UI 层 (React + CodeMirror 6)                                 │
│   NotebookView · CellView · OutputRenderers · ThemeProvider   │
│   只依赖 design tokens (CSS 变量) 与 core 的模型/事件          │
├──────────────────────────────────────────────────────────────┤
│  Core 层 (纯 TS，无 DOM、无 Node 依赖)                        │
│   NotebookModel · 序列化(Markdown) · KernelProtocol 类型       │
│   RuntimeRegistry · KernelSession(状态机) · CompletionSource   │
├──────────────────────────────────────────────────────────────┤
│  Host 层 (HostBridge 接口 + 适配器)                            │
│   进程 spawn/stdin/stdout · 文件读写 · which/env 探测          │
│   适配器: TauriHost | ElectronHost | NodeServerHost | BrowserHost│
├──────────────────────────────────────────────────────────────┤
│  Kernel 进程 (每种语言一个单文件脚本，由本地运行时拉起)          │
│   JavaKernel.java (jdk.jshell) · kernel.py · kernel.mjs        │
│   协议: JSON Lines over stdio                                  │
└──────────────────────────────────────────────────────────────┘
```

三条硬约束贯穿所有层：

1. **UI 不碰进程和文件**，只通过 Core 暴露的接口工作。这样 UI 可以在纯浏览器里跑（用 BrowserHost），方便开发和做主题预览。
2. **Core 不依赖任何宿主**。Tauri / Electron / 本地 HTTP 服务三种壳都能接，将来换壳不改业务代码。
3. **Kernel 零构建、零依赖**。每个内核是一个源码文件，直接用用户本机的 `java` / `python3` / `node` 启动，不需要我们分发二进制。

## 2. 宿主壳的选择

需要拉起本地进程和读写文件，所以不能是纯网页。三个选项：

| 方案 | 体积 | 开发成本 | 备注 |
|---|---|---|---|
| Tauri v2 | 约 10MB | 中 | 用 shell 插件在前端 JS 里 spawn 子进程即可，不必写 Rust 业务逻辑 |
| Electron | 约 150MB | 低 | 全 TS，主进程直接 `child_process` |
| 本地服务 + 浏览器 | 取决于服务运行时 | 低 | Node/Bun 起一个 daemon，浏览器打开 UI |

**推荐 Tauri v2**，理由是"轻量"是这个项目的核心气质。但 `HostBridge` 接口做好隔离，先用 NodeServerHost 开发（起步最快，调试最方便），稳定后再包 Tauri，两者共存也没问题。

```ts
// packages/host/src/HostBridge.ts
export interface HostBridge {
  // 进程
  spawn(cmd: string, args: string[], opts?: SpawnOptions): Promise<ChildProcess>;
  which(bin: string): Promise<string | null>;
  env(name: string): Promise<string | undefined>;
  platform(): 'darwin' | 'win32' | 'linux';
  // 文件
  readText(path: string): Promise<string>;
  writeText(path: string, content: string): Promise<void>;
  listDir(path: string): Promise<DirEntry[]>;
  appDataDir(): Promise<string>;     // ~/.NoteX
  // 系统
  openExternal(url: string): Promise<void>;
  clipboardWrite(text: string): Promise<void>;
}

export interface ChildProcess {
  pid: number;
  write(data: string): Promise<void>;
  onStdout(cb: (chunk: string) => void): () => void;
  onStderr(cb: (chunk: string) => void): () => void;
  onExit(cb: (code: number | null) => void): () => void;
  kill(signal?: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): Promise<void>;
}
```

`BrowserHost` 实现里 `spawn` 直接抛 `HostCapabilityError`，Core 据此把 Java 标为不可用、Python 回退到 Pyodide、JS 回退到浏览器执行。

## 3. 运行时与内核

### 3.1 概念区分

- **Runtime**：一种语言的执行环境来源，例如 Python 有两个 provider：`python-local`（本机 python3）和 `python-pyodide`（浏览器内，需联网首次下载）。
- **Kernel**：一个运行中的进程或实例，持有变量状态。一个笔记本对每种语言最多一个 kernel，惰性启动。

```ts
// packages/core/src/runtime/types.ts
export type LangId = 'java' | 'python' | 'js';

export interface RuntimeProvider {
  id: string;                 // 'java-local' | 'python-local' | 'python-pyodide' | 'js-node' | 'js-browser'
  lang: LangId;
  label: string;              // 'Java (本机 JDK)'
  priority: number;           // 同一语言多个 provider 时的优先级
  detect(host: HostBridge, prefs: RuntimePrefs): Promise<RuntimeInfo | null>;
  launch(host: HostBridge, info: RuntimeInfo): Promise<KernelTransport>;
  install: InstallGuide;      // 缺失时展示
}

export interface RuntimeInfo {
  providerId: string;
  version: string;            // '21.0.3'
  path: string;               // '/usr/bin/java'
  extra?: Record<string, string>;   // 例如 { jshell: 'true' }
}

export interface InstallGuide {
  title: string;
  minVersion: string;
  links: { label: string; url: string }[];
  commands: Partial<Record<'darwin' | 'win32' | 'linux', string>>;  // brew / winget / apt
  fallbackProviderId?: string;  // 'python-pyodide'：没装也能用的备选
}
```

### 3.2 自动识别策略

探测顺序固定，命中即停，结果缓存到 `~/.NoteX/runtimes.json`，UI 上提供"重新检测"和"手动指定路径"：

1. 用户在设置里手动指定的路径
2. 环境变量：`JAVA_HOME`、`VIRTUAL_ENV`、`CONDA_PREFIX`
3. `PATH` 上的 `which java` / `python3` / `node`
4. 常见版本管理器目录：
   - macOS: `/usr/libexec/java_home -V`
   - `~/.sdkman/candidates/java/current`、`~/.jenv/versions`
   - `~/.pyenv/versions`、`~/miniconda3/bin`、`~/anaconda3/bin`
   - `~/.nvm/versions/node/*/bin`、`~/.volta/bin`、`~/.fnm`
5. 版本校验：执行 `java -version` / `python3 --version` / `node --version`，低于最低版本视为不可用并说明原因

Java 有一个额外校验：**必须是 JDK 而非 JRE**，因为 `jdk.jshell` 模块只在 JDK 里。用 `java --list-modules | grep jdk.jshell` 判断。

运行时状态机（每个 provider 一份，Sidebar 上用小圆点展示）：

```
unknown ─detect→ detecting ─┬→ available ─launch→ starting → ready ⇄ busy
                            └→ missing                          │
                                                                └→ error / exited
```

### 3.3 缺失环境时的引导

用户点"运行"时，若该语言没有可用 provider：

1. cell 输出区显示一个 **安装引导卡片**（不弹全局对话框，保持在上下文里）：
   - 标题：`未检测到 Java 运行环境（需要 JDK 17+）`
   - 一键复制的安装命令（按当前 OS 选择，如 `brew install openjdk@21`）
   - 官方下载链接
   - 按钮：`重新检测` · `手动选择路径…`
   - 如果有 `fallbackProviderId`：`改用浏览器内置 Python 运行（无需安装，首次需联网）`
2. 不做自动安装。原因：需要管理员权限、网络、且各平台差异大，收益低于风险。

### 3.4 内核协议（JSON Lines over stdio）

不用 Jupyter 的 ZMQ 协议，太重。自定义一个极简协议，三种内核共用：

**请求**（UI → kernel，一行一个 JSON）

```jsonc
{"id":"r1","op":"execute","code":"int x = 1 + 2;\nx * 10"}
{"id":"r2","op":"complete","code":"System.ou","cursor":9}
{"id":"r3","op":"inspect","code":"list.stream()","cursor":11}
{"id":"r4","op":"interrupt","target":"r1"}
{"id":"r5","op":"shutdown"}
```

**响应**（kernel → UI，可多条，最后一条必为 `done`）

```jsonc
{"id":"r1","type":"stream","name":"stdout","text":"hello\n"}
{"id":"r1","type":"result","data":{"text/plain":"30"}}
{"id":"r1","type":"display","data":{"text/html":"<table>…</table>"}}
{"id":"r1","type":"error","ename":"ArithmeticException","evalue":"/ by zero","traceback":["..."]}
{"id":"r1","type":"done","status":"ok","durationMs":12}
{"id":"r2","type":"completions","anchor":7,"items":[{"label":"out","kind":"field","detail":"PrintStream"}]}
```

**用户 stdout 与协议如何不打架**：内核内部把用户代码的 stdout/stderr 捕获后包装成 `stream` 消息发出（Java 用 `JShell.builder().out()`，Python 重定向 `sys.stdout`，Node 给 vm 注入自定义 `console`）。协议消息统一以 ASCII 记录分隔符 `\x1e` 开头；任何不以它开头的行，客户端都当作漏网的 stdout 显示，绝不会崩。

**中断**：客户端先发 `interrupt` 消息，超时 1 秒后发 `SIGINT`，再超时发 `SIGKILL` 并重启内核。

### 3.5 三个内核的实现要点

| | Java | Python | JS |
|---|---|---|---|
| 文件 | `kernels/java/JavaKernel.java` | `kernels/python/kernel.py` | `kernels/node/kernel.mjs` |
| 启动 | `java JavaKernel.java`（源码启动器，JDK 11+，免编译） | `python3 kernel.py` | `node kernel.mjs` |
| 状态保持 | 一个 `JShell` 实例 | 一个持久 `globals` dict | 一个 `vm.createContext()` |
| 执行 | `SourceCodeAnalysis.analyzeCompletion` 切 snippet 后逐个 `eval` | `ast` 解析，最后一个表达式单独 `eval` 得返回值（同 IPython 行为） | `vm.runInContext`，最后表达式值即返回值 |
| 补全 | `SourceCodeAnalysis.completionSuggestions` + `documentation` | `rlcompleter`；若装了 `jedi` 则用 jedi | 反射 context 对象属性 |
| 中断 | 控制线程调 `JShell.stop()` | 主线程执行，读 stdin 线程收到 interrupt 后 `_thread.interrupt_main()` | `worker_threads` 跑代码，中断即 `terminate()` |
| 富输出 | 返回值若为 `Map`/`Collection`/`BufferedImage` 转 HTML 表格 / PNG | 对象有 `_repr_html_` / `_repr_png_` 就用 | 对象有 `toHTML()` 就用 |
| 依赖 | `//DEPS g:a:v` 魔法注释，Maven Resolver 下载后 `addToClasspath`（二期） | 就用用户环境已装的包 | 就用 node 全局/当前目录 node_modules |
| 预估行数 | ~300 | ~150 | ~100 |

JShell 默认在**独立 JVM** 中执行用户代码（JDI 远程执行），死循环可以 `stop()`，主内核进程不会挂。冷启动约 1 秒，因此内核在用户第一次聚焦某语言的 cell 时预热，而不是点运行时才启动。

### 3.6 浏览器回退 provider

原型里已有的两种执行方式保留为 provider：

- `js-browser`：`AsyncFunction` 直接 eval，零成本，永远可用。
- `python-pyodide`：CDN 加载，首次 10 到 20 秒，无文件系统访问。

它们让"没装环境也能先用起来"成立，同时也是纯浏览器开发模式下的默认实现。Java 没有合适的浏览器回退（CheerpJ 过重），不做。

## 4. 笔记模型与存储

```ts
export interface Notebook {
  id: string;
  title: string;
  cells: Cell[];
  meta: { created: string; updated: string; defaultLang: LangId };
}

export type Cell = MarkdownCell | CodeCell;

export interface CodeCell {
  id: string;
  type: 'code';
  lang: LangId;             // Tab 切换只改这个字段
  source: string;
  outputs: Output[];        // 运行结果，MIME bundle
  execN?: number;           // 执行序号
  meta?: { collapsed?: boolean; providerId?: string };
}

export type Output =
  | { type: 'stream'; name: 'stdout' | 'stderr'; text: string }
  | { type: 'result' | 'display'; data: Record<string, string> }   // mime → data
  | { type: 'error'; ename: string; evalue: string; traceback: string[] };
```

**存储格式：Markdown 为正本，输出存旁车文件。**

```
~/NoteX/
  我的笔记/
    jshell 入门.md              ← 正文，代码 cell 就是 ```java 围栏块
    .jshell 入门.outputs.json   ← 各 cell 的 outputs，按 cell id 索引
```

Markdown 文件示例：

```markdown
---
NoteX: 1
title: jshell 入门
---

# 欢迎

正文……

```java {id=c2}
var list = List.of(1, 2, 3);
list.stream().mapToInt(i -> i).sum()
```

```python {id=c4}
print(sum(i*i for i in range(10)))
```
```

选择 Markdown 的理由：Git 友好、任何编辑器可读、语言 tab 天然对应围栏块的 info string。围栏块的 `{id=…}` 属性用来关联输出，缺失时按顺序生成。`.ipynb` 作为导出格式支持，不作为正本。

## 5. 编辑器与语言切换

用 **CodeMirror 6** 替换原型里的 `textarea + highlight.js 叠层`。每个 code cell 一个 `EditorView`，但语言扩展、主题、补全 source 三者在 Notebook 级别共享，通过 `Compartment` 动态切换：

```ts
const langCompartment = new Compartment();
const themeCompartment = new Compartment();

// Tab 切换语言时
view.dispatch({ effects: langCompartment.reconfigure(langSupport(cell.lang)) });
```

语言 Tab 的行为：

- 三个 tab：`JAVA` `PY` `JS`，当前语言高亮。
- 切换只改 `cell.lang` 和编辑器语法模式，**不清空源码**，不清空旧输出（输出区标注"上次以 Python 运行"）。
- tab 上叠加运行时状态点：绿=就绪，黄=启动中，灰=未检测/未启动，红=缺失。悬停显示版本和路径。
- 新建 code cell 默认沿用上一个 code cell 的语言。

补全 source 的降级链：内核 `complete` 请求（就绪时）→ 语言关键字 + 文档内标识符（`@codemirror/autocomplete` 自带）。请求做 150ms debounce，内核 busy 时跳过。

## 6. 主题系统

> 这一节早期的设想（主题 = token + 可选 CSS 覆盖）已被取代。
> 现行设计见 [THEME.md](THEME.md)，为什么这样划边界见 [RESEARCH-主题边界.md](RESEARCH-主题边界.md)。

- **原则**：稳定可控、有限度的灵活。主题只能改颜色、字体、字重、标题比例；不能带 CSS 或脚本，不能改尺寸、间距、布局
- **协议字段表**在 `src/core/theme.ts`，是唯一数据源：校验、合并、生成 `docs/THEME-REFERENCE.md` 与 `docs/theme.schema.json` 都用它，测试保证文档不脱节
- **公开与内部分离**：主题只写协议字段，由框架映射到内部 CSS 变量；组件只消费 CSS 变量，零硬编码颜色
- **校验是安全边界**：值会写进 `<style>`，所以按类型白名单校验，不合法的字段直接丢弃
- **默认主题也是主题文件**：`themes/light.json`、`themes/dark.json`。其他主题没写的基础字段从同明暗的默认主题继承，派生字段跟随另一个字段
- **选择模型**：固定一个主题，或跟随系统（浅色时 A、深色时 B）
- **字号是用户设置**，不属于主题；主题里的标题字号是相对正文的倍数

## 7. 仓库结构

```
NoteX/
  apps/
    desktop/          # Tauri 壳，仅装配
    dev-server/       # NodeServerHost，开发期用浏览器跑
  packages/
    core/             # 模型、序列化、协议、RuntimeRegistry、KernelSession
    ui/               # React 组件、tokens、ThemeProvider、CodeMirror 集成
    host/             # HostBridge 接口 + Tauri/Node/Browser 适配器
    runtimes/         # 各 RuntimeProvider 的 detect/launch/install 定义
  kernels/
    java/JavaKernel.java
    python/kernel.py
    node/kernel.mjs
  themes/             # 内置主题
  docs/
```

现有的 `Notebook.dc.html` 是 Claude Design 的画布格式（`DCLogic` 组件由 `support.js` 渲染），适合出视觉稿，不适合作为生产代码基础。迁移时**保留它的视觉设计和交互细节**（拖拽排序、执行序号、双击编辑 Markdown 等），代码重写到 React + Vite。

## 8. 实施阶段

| 阶段 | 内容 | 产出 | 估算 |
|---|---|---|---|
| 0 | 把原型迁到 React + Vite；提炼 tokens；CodeMirror 替换 textarea；Markdown 存储；保留 js-browser 和 python-pyodide 两个 provider | 纯浏览器可用的笔记，视觉与原型一致 | 3 到 5 天 |
| 1 | HostBridge + NodeServerHost；三个内核脚本；协议客户端；运行时探测与安装引导 | 本机 Java/Python/Node 能跑 | 5 到 7 天 |
| 2 | 内核补全接入 CodeMirror；中断；富输出渲染器；执行状态点 | 日常可用 | 3 到 5 天 |
| 3 | Tauri 壳；主题包加载；ipynb 导出；Java `//DEPS` | 可分发 | 5 到 8 天 |

每个阶段结束都有可用版本。阶段 0 结束时就已经比原型好用。

## 9. 已知风险与取舍

- **JShell 冷启动 1 秒**：靠聚焦预热掩盖；Sidebar 显示"启动中"避免用户以为卡住。
- **Python 中断**：`interrupt_main` 对 C 扩展里的长计算无效，兜底靠 SIGINT 和重启。
- **stdin 输入**：三个内核初期都不支持 `input()` / `Scanner`，遇到直接报"笔记本模式不支持标准输入"。
- **Windows**：进程 spawn 与信号语义不同，`SIGINT` 需换成 `GenerateConsoleCtrlEvent` 或直接 kill 重启。阶段 1 先保 macOS/Linux。
- **多语言共享变量**：不做。三个内核相互独立，这是刻意的简化。
