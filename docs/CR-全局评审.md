# 全局评审：从设计到实现

> 日期：2026-09-11，基线 commit `1980009`。
> 范围：core / UI / host 全部源码、三个内核、Tauri 壳、开发服务器插件。
> 方法：通读代码；在运行中的应用里实测交互疑点；用脚本验证序列化往返；跑通 `pnpm test`（类型检查、单元测试、内核集成测试全部通过）。
> 本文只记录问题与建议，不含修复实现。每条给出位置、严重度、触发场景与修法方向。

严重度定义：

| 级别 | 含义 |
|---|---|
| 高 | 丢数据、安全、内核状态丢失，正常使用就会碰到 |
| 中 | 功能错误或明显体验缺陷，特定操作会碰到 |
| 低 | 边角情况、代码整洁、可移植性 |

---

## 1. 产品交互

### 1.1 首次体验是空的 [高]

新 vault 打开时创建的「欢迎使用 NoteX」没有任何 cell：`src/ui/useNotebook.ts:267` 调 `VaultStore.create()`，而 create 固定 `cells: []`。

那份精心写的示例内容（三种语言、富输出、`//DEPS`、中断演示）只活在 `src/core/store.ts:18` 的 localStorage 兜底路径里，桌面用户永远看不到。`examples/数据分布图.md` 也不会被复制进 vault。

**修法**：把种子内容作为欢迎笔记写进 vault，`examples/` 一并带上。种子内容从 `store.ts` 挪到独立模块，两个 store 共用。

### 1.2 删除不可撤销，且容易误触 [高]

- ⌘⌫ 删除 cell 没有确认、没有撤销（`src/ui/App.tsx:478`）。CodeMirror 的历史随 cell 卸载一起消失。
- 删笔记是硬删文件（`src/core/store/VaultStore.ts:210`）。
- 删文件夹的提示只数了笔记篇数（`App.tsx:639`），实际 `removeDir` 会连里面的图片、附件一起递归删掉。

自动保存 500 ms 落盘，误操作后 Git 也救不回未提交的内容。

**修法**：cell 删除后显示「已删除，撤销」横幅，保留最近一次删除的 cell；笔记与文件夹删除走系统废纸篓（Rust 侧用 `trash` crate）；文件夹删除提示改为「及其中所有文件」。

### 1.3 ⌘↩ 在代码编辑器里做两件事 [中]（已实测）

CodeMirror `defaultKeymap` 把 `Mod-Enter` 绑给 `insertBlankLine`，同时 `App.tsx:467` 的全局监听又新建了一个 cell。实测：按一次，编辑器多一空行，笔记多一个 cell。

和上一轮修过的 ⌘⌫ 是同一类问题。全局快捷键与编辑器键位的冲突应该系统性处理，而不是逐个打补丁。

**修法**：全局 `enter` 分支加 `inEditor` 判断；或在 `setup.ts` 的 keymap 里显式覆盖 `Mod-Enter`，把新建 cell 的动作交给编辑器内的绑定统一触发。

### 1.4 文本里写代码示例会变成可执行 cell [中]（已实测）

在文本 cell 里写一段 ```` ```python ```` 围栏说明代码，保存重开后被切成代码 cell（`src/core/serialize.ts:104`）。用户没有任何方式表达「这段代码只是展示」。

**修法**：二选一。(a) 只把带 `{id=…}` 的围栏当 cell，没有 id 的围栏留在文本里；(b) 约定 `~~~` 围栏为纯展示，写进 README。倾向 (a)，它对外部编辑器写的文件更友好，但要处理「用户在 VS Code 里新加的围栏」这个场景（可在打开时提示「发现 N 段未编号的代码，转为可执行 cell？」）。

### 1.5 没有全库搜索与快速切换 [中]

文件夹页搜索只匹配当前目录的标题和首段摘要（`src/ui/components/FolderPage.tsx:73`）。没有 ⌘K / ⌘P 快速打开，没有全文搜索。链接索引已经读过每篇全文，是现成的搜索数据源。

### 1.6 改名断链 [中]

笔记重命名后所有指向它的 `[[旧名]]` 变断链。模型里已经为此埋了 `uid`（`src/core/model.ts:48`）但没用起来。

**修法**：短期在重命名时提示「有 N 篇笔记引用了它」（反链索引现成）；中期重命名时自动改写引用。

### 1.7 内核工作目录指向应用包 [中]

`src/host/TauriHost.ts:99`、`server/hostPlugin.ts:79` 把内核 cwd 设为 `kernels/` 目录。后果：

- Python 里 `open('data.csv')` 相对路径落在只读的 bundle 里
- Node 的 `createRequire(process.cwd())` 在 `NoteX.app/…/kernels/node_modules` 找模块，README 说的「用当前目录 node_modules」实际不成立

**修法**：cwd 设为 vault 目录（或当前笔记所在目录），脚本路径用绝对路径传。

### 1.8 其它

| 问题 | 位置 | 级别 |
|---|---|---|
| 导入的笔记永远落在根目录，不是当前文件夹 | `useNotebook.ts:502` | 低 |
| 桌面版「导出」走 `<a download>`，Tauri 2 webview 默认不处理下载，大概率静默无效，需在桌面上验证 | `src/core/files.ts:5` | 中 |
| 缺运行时的引导卡是 UI 态，却被写进 `.outputs.json` 旁车 | `serialize.ts:164` | 低 |
| 两个同语言 cell 排队时，第一个跑完 `setBusy(false)` 就把状态改回 ready | `App.tsx:323` | 低 |
| 侧栏双击重命名会先触发单击打开，切换笔记再进入重命名 | `NoteTree.tsx:156` | 低 |

---

## 2. 安全

### 2.1 开发服务器可被任意网页远程执行命令 [高]

`server/hostPlugin.ts:60` 处理 WebSocket upgrade 时不校验 Origin。浏览器对跨源 WebSocket 没有同源限制，任何网页都能连 `ws://localhost:5173/__host/kernel?cmd=/bin/sh&args=[…]` 并读回输出。

`assertKernelScript`（`hostPlugin.ts:43`）只要 args 里没有 `.java/.py/.mjs/.js` 结尾的项就 `return` 放行，`cmd` 本身从不校验。

同样，`/__host/exec`、`/write`、`/remove`、`/rmdir`、`/rename` 等 POST 接口的 `readBody` 不看 content-type，任何网页用 `fetch(url, { method: 'POST', mode: 'no-cors', body })` 就能触发（text/plain 简单请求不预检，响应读不到但副作用已发生）。

只在 `pnpm dev` 期间存在，但 dev 是日常状态。

**修法**：
1. upgrade 与 HTTP 中间件都校验 `Origin` / `Host` 为 `localhost` / `127.0.0.1`
2. `cmd` 限定为 RuntimeRegistry 探测到的运行时路径；`assertKernelScript` 找不到脚本参数时应拒绝而不是放行
3. POST 要求 `content-type: application/json`

### 2.2 Tauri 命令无范围限制，安全边界只系于 DOMPurify [中]

`src-tauri/src/lib.rs:95-194` 的 `read_text` / `write_text` / `remove_dir` / `exec` / `kernel_spawn` 接受任意路径与任意命令，`tauri.conf.json` 里 `csp: null`。

目前正文与富输出都过了 DOMPurify（`src/ui/sanitize.ts`），恶意笔记拿不到 `__TAURI_INTERNALS__`。但这意味着任何一处新加的 `innerHTML` 都会把「打开别人的笔记」升级成「任意文件读写 + 任意命令执行」。

**修法**：`exec` / `kernel_spawn` 加命令白名单；文件命令限制在 vault 与 `~/.notex` 下；开 CSP。让防线不止一层。

### 2.3 子进程直写 fd 1 可伪造协议帧 [低]

三个内核都只包了语言层 stdout。Python `os.write(1, …)`、Node `process.stdout.write`（`process` 整个暴露在 sandbox 里）、Java 用户代码起的子进程都能直写真实 fd 1，一行以 `\x1e` 开头就能伪造 `done` / `result`。本地单用户场景风险低，记录在案。

---

## 3. 内核与中断

### 3.1 中断 Java 会把内核杀死 [高]

`src/core/runtime/KernelSession.ts:157`：发协议中断后 1 秒，只要 `pending.size > 0` 就发 SIGINT。`kernels/java/JavaKernel.java` 没装信号处理，JVM 收到 SIGINT 直接退出，JShell 全部状态丢失。

`pending` 里不只有被中断的那条 execute：中断后 1 秒内用户在编辑器里触发一次补全（`complete` 也进 pending，2.5 s 才超时），或紧接着运行下一个 cell，就会误杀。正常使用就会碰到。

**修法**：升级判断只看被中断那条请求的 id 是否仍在 pending；Java 内核装 SIGINT handler，把它映射成 `JShell.stop()`。

### 3.2 Python 中断落在执行区间外会让内核整个退出 [中]

`kernels/python/kernel.py:346-384`：只有 `inbox.get()` 包在 `except KeyboardInterrupt` 里。SIGINT 落在 `execute()` 返回后到 `emit(done)` 之间、`finally` 里的 flush、`except` 分支的 `emit(error)`、或 jedi 补全期间，KeyboardInterrupt 穿到 `main()` 外面 `os._exit(0)`。连点两次中断很容易命中。

**修法**：主循环整体包 KeyboardInterrupt；补全与 inspect 期间屏蔽 SIGINT。

### 3.3 Node 内核吞掉函数与类声明 [中]

`kernels/node/kernel.mjs:108` 先按 `(code)` 表达式编译。cell 只有 `function foo() {…}` 时，`(function foo(){})` 是合法的命名函数表达式，编译成功、返回函数值，但 `foo` 不绑定进 context，下一个 cell 调 `foo()` 报 ReferenceError。`class A {}` 同理。

另外：挂起的 Promise 无法中断（`breakOnSigint` 只打断同步代码，SIGINT 被 `kernel.mjs:210` 的空 handler 吞掉，只能重启内核）；顶层 `await` 是语法错误。

**修法**：先尝试整体作为语句编译，再判断末尾是否为表达式（参考 Python 内核的 ast 做法，用 acorn 或简单启发式）；Promise 求值加超时；顶层 await 用 `vm.SourceTextModule` 或包成 async 函数。

### 3.4 Java 远端 JVM 死后内核不自愈 [中]

`JavaKernel.java:283-287`：cell 里 `System.exit(0)`、OOM 或远端崩溃后，`shell.eval` 永远抛 `IllegalStateException`，内核进程活着但每个 cell 都报「内核已关闭」，只能手动重启。应捕获后重建 JShell 并通知 UI 清标记。

### 3.5 其它

| 问题 | 位置 | 级别 |
|---|---|---|
| 执行结束后到达的 stream 被静默丢弃；Java 远端 stdout 由单独线程转发，偶发丢最后一行 print（推断，未实测） | `JavaKernel.java:260`, `kernel.py:238`, `kernel.mjs:131` | 低 |
| `interrupt()` 的 `target` 取 pending 第一个 key，可能是 complete 的 id | `KernelSession.ts:151` | 低 |
| Java `stopRequested` 只在每个 snippet eval 后检查，中断落在解析阶段会多跑一个 snippet | `JavaKernel.java:289` | 低 |
| JShell 的 complete/inspect 在 stdin 线程执行，与 worker 线程的 eval 并发，JShell 不承诺线程安全 | `JavaKernel.java:73, 249` | 低 |
| `dispose()` 发完 shutdown 立即 SIGTERM，协议 shutdown 形同虚设 | `stdioKernel.ts:45` | 低 |

---

## 4. 宿主与进程生命周期

### 4.1 Tauri 命令是同步的，会冻结整个窗口 [中]

`lib.rs:181` `exec`、`lib.rs:306` `kernel_write` 都不是 `async fn`，Tauri 2 里在主线程执行。`mvn dependency:build-classpath` 跑几十秒时窗口卡死；`kernel_write` 在内核不读 stdin（Node 同步死循环、pipe 满）时持锁阻塞，连带 `kernel_signal` 也拿不到锁，恰好是最需要中断的时刻。

**修法**：改成 `async fn`；写与信号用不同的锁。

### 4.2 Rust 读 stdout 遇到非 UTF-8 字节就永久停摆 [中]

`lib.rs:245` `read_line` 到 `String` 出错即 `break`，之后该内核所有 stdout 都不再转发，UI 永远转圈。Python 里 `subprocess.run(["ls"])` 输出带一个非 UTF-8 字节就触发。DevServer 路径用 `setEncoding('utf8')` 有 StringDecoder 兜底，不受影响。

**修法**：按字节读，`String::from_utf8_lossy` 转换。

### 4.3 应用退出不清理内核 [中]

`lib.rs` 没有 `RunEvent::Exit` 处理；`src/ui/RuntimeContext.tsx:24` 的 `beforeunload → shutdownAll()` 是异步 invoke，窗口关闭时不保证送达。空闲内核靠 stdin EOF 自行退出，但正在跑死循环的 Python / Node 不读 stdin，应用退出后继续吃 CPU。

开发态页面 reload 同样泄漏：`TauriChild` 句柄随 JS 状态丢失，Rust 侧 `Kernels` map 仍持有 stdin，旧内核（Java 是两个 JVM）活到应用退出。

**修法**：Rust 侧在 Exit 事件里遍历 `Kernels` 发 SIGTERM；页面 reload 时（`kernel_spawn` 前）清掉上一代的进程。

### 4.4 运行时缓存失效后不会自动重探 [中]

`src/core/runtime/RuntimeRegistry.ts:147`：`ensure()` 只对 `unknown` / `missing` 重探。路径被删（卸载、换版本管理器）后 `launch` 抛错、状态变 `error`，此后永远失败，直到用户手动「重新检测」。同时缓存里的 `version` 不随升级更新。更糟的是界面上显示的是「未检测到 Java」的安装引导卡，误导用户。

**修法**：`error` 状态也重探；launch 前先 `fileExists(info.path)`；引导卡区分「未安装」与「启动失败」。

### 4.5 其它

| 问题 | 位置 | 级别 |
|---|---|---|
| `TauriChild.listen()` 异步注册，注册完成前的事件丢失；启动即崩的内核可能错过 exit | `TauriHost.ts:34` | 低 |
| DevServer exit 回调触发两次，靠 `s.session === session` 侥幸兜住 | `hostPlugin.ts:96`, `DevServerHost.ts:61` | 低 |
| `tauri-plugin-fs` 注册了没用，capabilities 里也没给权限 | `lib.rs:345` | 低 |

---

## 5. 存储与序列化

### 5.1 写盘期间的输入会被标成已保存 [中]

`src/ui/useNotebook.ts:120`：`flush` 在 `await store.save(nb)` 之后无条件 `dirty.current = false`。但 save 期间的按键已经把 `dirty` 置回 true 并修改了 `nbRef.current`，保存的是旧快照。结果那几个字符留在内存里、界面显示「已保存」，下一次 flush 因 `!dirty` 跳过，切换笔记时被丢弃。

窗口只有写盘那几毫秒，但打字是连续的，且这是唯一一处能在「已保存」状态下丢数据的路径。

**修法**：用代数计数器。`scheduleSave` 时 `gen++`，flush 记下 `savedGen`，写完只在 `gen === savedGen` 时清 dirty。

### 5.2 序列化往返丢信息 [中]（已用脚本实测）

| 输入 | 往返后 | 位置 |
|---|---|---|
| 带 BOM 的文件 | frontmatter 整个失效，`---` 行进入正文 | `serialize.ts:72`（`noteSummary.ts:52` 有去 BOM，这里没有） |
| 文本 cell 首行是四空格缩进的代码块 | `.trim()` 吃掉缩进，变成普通段落 | `serialize.ts:98` |
| 相邻两个文本 cell | 合并成一个 | 格式使然，需明确这是预期 |
| 代码 cell 末尾多个换行 | 只保留一个 | `serialize.ts:57` |
| 围栏带其它属性如 ```` ```python title="x" ```` | 不识别，留在文本里 | `serialize.ts:104` |

**修法**：去 BOM；`flushMarkdown` 只去首尾空行不 trim 行内空白；README 里说明文本 cell 合并是预期行为。

### 5.3 其它

| 问题 | 位置 | 级别 |
|---|---|---|
| 每次自动保存都改写 frontmatter 的 `updated:` 行，Git diff 噪音大。`flush` 的注释说明作者在意这一点，但这条还没处理 | `serialize.ts:43` | 低 |
| `text/plain` 结果无长度上限：Python `repr(value)`、Java `ev.value()` 不截断，`list(range(10**7))` 作为末尾表达式会把几十 MB 塞进 React。Node 靠 `inspect` 有界，是三者中唯一安全的 | `kernel.py:141`, `JavaKernel.java:328` | 中 |
| 调试日志默认开启，每 800 ms 把整份缓冲（最多 2000 条）重写一遍文件；日志里含笔记路径 | `src/core/debug.ts:79` | 低 |
| `actions` / `mutate` / `codeCells` 无人引用 | `src/core/store.ts:139-230` | 低 |

---

## 6. Windows 可移植性

当前有多处硬伤，建议 README 明确只支持 macOS / Linux，等上面的问题收敛后单独立项：

| 问题 | 位置 |
|---|---|
| 中断等于 kill：非 unix 分支对任何信号都 `child.kill()`，一次中断丢全部状态 | `lib.rs:334`, `hostPlugin.ts:115` |
| venv 是 `Scripts\python.exe`，conda 是 `%CONDA_PREFIX%\python.exe`，不是 `bin/` | `providers.ts:29, 31` |
| `mvn` 找不到 `mvn.cmd`，总是退回直连下载 | `resolve.ts:27` |
| `kernel_spawn` 没设 `CREATE_NO_WINDOW`，每个内核闪一个控制台窗口 | `lib.rs` |

---

## 7. 做得对的地方

评审也要记下应该保持的东西，免得后续重构时丢掉：

- **分层干净**。Core 不依赖宿主，HostBridge 让 dev-server 与 Tauri 共用一套逻辑；换壳不改业务代码这条约束真的守住了。
- **协议简单可靠**。RS 前缀 + 行拆分 + 「非协议行当裸输出」，`createLineSplitter` 正确处理跨 chunk 半行与 `\r`。
- **Python 内核的线程模型正确**：reader 放后台线程、执行留主线程，SIGINT 才能到达用户代码；`except BaseException` 让 `sys.exit()` 不杀内核。
- **Java 内核考虑周到**：渲染器注入远端 JVM、反射避开 `java.desktop` 硬依赖、`.in()` 给空流、远端加 `UIElement` 防 Dock 图标；`esc()` 400 字截断、表格 200 行上限。
- **依赖注入面封住了**：坐标严格正则校验后才拼 pom 与 URL，命令走参数数组不经 shell。
- **富输出统一过 DOMPurify**，是目前挡住「恶意笔记 → Tauri 命令」链路的关键一环。
- **主题协议**用同一张字段表驱动校验、文档生成与 JSON Schema，测试保证三者不脱节。
- **路径安全放在存储层**（`paths.ts`），所有 id 入口共用一次校验。
- **注释解释「为什么」**而不是「是什么」，尤其是 `useNotebook.ts` 里对每条防御的来由说明，质量很高。
- 手动指定运行时路径失败时明确报错而非静默换候选。

---

## 8. 测试的空白

core 的纯函数测试扎实，但本次发现的高危问题全在没有测试的层：

| 问题 | 所在层 |
|---|---|
| dirty 竞争（5.1） | useNotebook |
| ⌘↩ 双响（1.3） | App 快捷键 |
| Java 中断误杀（3.1） | KernelSession |
| Node 声明吞掉（3.3） | kernel.mjs |

建议补：

1. `useNotebook` 基于假 store 的测试，覆盖「切换笔记前未保存」「外部改动冲突」「写盘期间继续输入」三条路径
2. `KernelSession` 用假 connection 测中断升级逻辑
3. `kernels/test-kernel.mjs` 加「函数声明跨 cell 可见」「中断后立刻补全不杀内核」两个用例
4. 快捷键与编辑器键位冲突的清单测试：枚举全局快捷键，断言每个在 CodeMirror 与 textarea 内的行为

---

## 9. 修复顺序

按「影响 × 工作量」排：

| 批次 | 内容 | 条目 | 估算 |
|---|---|---|---|
| 1 | 开发服务器 Origin / Host 校验与 cmd 白名单；Java 中断只看目标 id + 装 SIGINT handler | 2.1, 3.1 | 半天到一天 |
| 2 | 欢迎笔记写进 vault；⌘↩ 双响；dirty 代数计数 | 1.1, 1.3, 5.1 | 半天 |
| 3 | Tauri 命令改 async；退出清理内核；stdout 按字节读；运行时缓存失效重探 | 4.1, 4.2, 4.3, 4.4 | 一天 |
| 4 | Python 中断窗口；Node 声明与 Promise；Java 远端自愈；结果长度上限 | 3.2, 3.3, 3.4, 5.3 | 一到两天 |
| 5 | 内核 cwd；序列化边角；删除撤销与废纸篓；文本围栏语义 | 1.7, 5.2, 1.2, 1.4 | 两天 |
| 6 | 搜索与快速切换；改名改写引用 | 1.5, 1.6 | 另立方案 |

批次 1 和 2 加起来不到两天，覆盖了全部「正常使用就会碰到」的高危项。

---

## 10. 修复记录

2026-09-11，批次 1 至 4 全部完成，批次 5 完成两项。每项都有对应测试或实测。

| 条目 | 修法 | 验证 |
|---|---|---|
| 2.1 开发服务器远程执行 | `hostPlugin.ts` 校验 Host / Origin / Sec-Fetch-Site；内核命令限定为三种运行时，exec 限定为 java/python/node/mvn/curl；缺脚本参数一律拒绝；POST 要求 JSON | curl 实测：跨源 Origin 与坏 Host 403、text/plain POST 415、`sh` 被拒 |
| 3.1 Java 中断误杀 | `KernelSession.interrupt` 只看正在执行的那条 id；`JavaKernel` 经反射装 SIGINT handler 映射到 `JShell.stop()` | `test:session` 5 项；内核测试 7b |
| 1.1 欢迎笔记为空 | 种子内容挪到 `core/welcome.ts`，vault 与 localStorage 共用；顺带删掉 `store.ts` 里的死代码 | 代码审阅 |
| 1.3 ⌘↩ 双响 | `setup.ts` keymap 吞掉 `Mod-Enter` 的编辑器动作，事件照常冒泡 | 浏览器实测：一次按键只新建 cell，不插空行 |
| 5.1 写盘期间输入被标成已保存 | `useNotebook` 加改动代数，写完只在代数没变时清 dirty | 代码审阅 |
| 4.1 Tauri 同步命令冻结窗口 | `exec` / `which` / `kernel_write` 改 async 并走 `spawn_blocking`；stdin 与 child 分开加锁 | `cargo test` 5 项 |
| 4.2 stdout 非 UTF-8 停摆 | `read_until` 按字节读，`from_utf8_lossy` 解码 | 代码审阅 |
| 4.3 退出不清理内核 | `RunEvent::Exit` 里 `kill_all_kernels`；新增 `kernel_kill_all` 命令，`TauriHost.create` 启动时调用清掉上一页的内核 | 代码审阅 |
| 4.4 缓存失效不重探 | `ensure()` 对 `error` 也重探；启动前 `fileExists` 核对路径；引导卡区分「未安装」与「启动失败」 | 代码审阅 |
| 3.2 Python 中断窗口 | 只在执行区间安装 `default_int_handler`，其余时间 `SIG_IGN`；main 里兜住收尾期的 KeyboardInterrupt | 内核测试 9b：空闲与补全期连发 SIGINT 不退出 |
| 3.3 Node 声明与 Promise | 以声明开头的 cell 不按表达式编译；挂起的 Promise 用 SIGINT 监听打断；顶层 await 包进 async 函数 | 内核测试 11：function/class 跨 cell、顶层 await、挂起 Promise 可中断 |
| 3.4 Java 远端自愈 | `onShutdown` 标记远端死亡，eval 后检查并 `rebuildShell()`，报错说明变量已丢 | 内核测试 10 |
| 5.3 结果长度上限 | 三个内核 `text/plain` 截到 20k 字符并注明；Python HTML 截到 1M | 内核测试 9 |
| 1.7 内核 cwd | `LaunchOptions.cwd` 贯穿 provider → host；`RuntimeProvider` 组件把 vault 路径设进 registry | 浏览器实测：`os.getcwd()` 返回笔记库 |
| 5.2 BOM 与缩进 | 解析前去 BOM；`flushMarkdown` 只去首尾空行不 trim 首行缩进 | `test:serialize` 新增 2 项 |

同日第二轮，四项产品级改动也已落地：

| 条目 | 做法 | 验证 |
|---|---|---|
| 1.2 删除撤销与废纸篓 | `useNotebook` 加结构操作的撤销栈（删除、移动、转换、换语言、插入、清空输出），恢复时保留各 cell 当前的源码与输出；⌘Z / ⇧⌘Z 在编辑器外撤销重做，删除后顶部提示条带「撤销」按钮。笔记与文件夹删除走 `HostBridge.trash`：桌面版用 `trash` crate 进系统废纸篓，开发服务器挪到 `~/.notex/trash`（Finder 的 AppleScript 实测要等几十秒，弃用） | 浏览器实测：删除 → 提示条 → ⌘Z 恢复且源码还在 → ⇧⌘Z 重做；删除笔记文件从 vault 消失 |
| 1.4 文本围栏语义 | 带 `notex` 标记的文件里，只有 `{id=…}` 的围栏是可执行 cell，没 id 的留在文本里；外来文件首次打开所有认得的围栏都可执行。「转为代码」会去掉围栏并认出语言，「转为文本」会包上围栏，来回转不丢源码。README 写明规则 | `test:serialize` 新增 5 项 |
| 1.5 全库搜索 | 链接索引顺带保存每篇正文，`LinkIndex.search` 做标题与正文的多词子串匹配；`SearchPalette` 组件用 ⌘K 唤出，空查询列最近更新，↑↓↩ 键盘操作，命中词高亮；侧栏加搜索按钮 | 浏览器实测：搜正文关键词命中并打开 |
| 1.6 改名改写引用 | `rewriteNoteLinks` 改写 `[[…]]` 与 `[…](…)`，跳过围栏与行内代码，沿用原来的编码写法；`nextLinkTarget` 决定新写法（按名字的仍按名字，重名才写路径，`.md` 保留）。App 在改名、移动、标题栏改名三条路径上先取反链再改，当前笔记走模型、其它直接改文件并即时更新索引 | `test:links` 新增 5 项；浏览器实测：改名后另一篇里的 2 处链接被改写，行内代码里的不动，提示条报数 |

其余低级别条目（调试日志、`updated:` 噪音、ipynb 等）未动。

### 同日第三轮：界面与运行时

| 内容 | 做法 | 验证 |
|---|---|---|
| 侧栏底部重排 | 三颗常驻的运行时圆点（点开有中断 / 重启 / 停止 / 启动 / 重新检测）；笔记库只显示目录名，齿轮进设置；修掉 RTL 截断把斜杠挪到末尾的 bug | 浏览器实测启动、停止、菜单 |
| 设置弹窗 | 三个分页（笔记库 / 外观 / 运行时）；所有改动进草稿，保存才生效，取消丢弃；标题栏可拖动；Esc 关闭 | 浏览器实测：选深色未保存不变、保存后变、取消不变；拖动 120px |
| 窗口固定尺寸 | `resizable: false`，自建菜单栏，「窗口 › 缩放 ⌃⌘Z」临时放开可缩放做系统最大化再收回 | 仅编译通过，需在桌面版手动确认 |
| 运行时候选与显式选择 | `discover` 探测所有候选（内置 / 环境变量 / PATH / 版本管理器 / Homebrew / 系统 / 手动），不存在的猜测路径不列，不可用的列出原因；选择存 `~/.notex/config.json`；「自动」优先内置；选中的不可用时明确报错不偷偷换；内核活着时改选只标记「重启后生效」 | 浏览器实测：候选列表、改选写入 config、重启标记出现与消失 |
| 内置运行时隔离启动 | `~/.notex/runtimes` 下的运行时启动时清掉 PYTHON* / conda / JAVA_TOOL_OPTIONS / NODE_OPTIONS 等变量，Python 加 `-I`，matplotlib 缓存指到 `~/.notex/cache`；两个宿主都支持按键删除环境变量 | `test:isolation` 6 项；用假的内置 Python 实测 `sys.flags.isolated == 1`、`CONDA_PREFIX` 被清、`MPLCONFIGDIR` 生效 |
| 内置运行时的清单与安装 | `catalog.json` 契约（id / lang / version / protocol / entry / builds[platform, arch, size, sha256, urls]），解析时校验 id、version、entry 的格式，坏条目整条丢；`installer.ts` 用本机 curl 依次试各地址、`-C -` 续传、按文件大小轮询进度、sha256 校验后才解压、先解到 `.partial` 再改名；顶层多套一层目录自动剥掉；清单地址可在 config.json 的 `runtimeCatalog` 换成镜像。设置里每种语言下多一栏「内置运行时」：下载并安装、从文件安装、卸载，装完自动重探；缺运行时的引导卡多了「安装内置运行时…」直达 | `test:catalog` 8 项；本地起 CORS 服务放假清单与假包实测：第一个地址 404 自动换第二个、校验通过、剥层解压、候选里出现「内置」且「自动」选中它、卸载后回到本机 |

**构建与发布流水线**（`runtimes/`）：`build-python.sh`（python-build-standalone 加钉死版本的科学计算包，隔离模式自检并用 Agg 画图）、`build-java.sh`（Temurin 用 jlink 裁到 JShell 所需模块，源码启动器自检 JShell 与 AWT）、`build-node.sh`（官方二进制去文档，npmmirror 下载）、`make-catalog.mjs`（从包名与哈希生成清单，多个 `--base` 决定下载顺序，`--merge` 保留其它平台）、`publish.sh`（阿里云 OSS 用 ossutil、码云 Release 走 API，同名附件先删后传）、`github-workflow.yml`（两台 macOS runner 各出一种架构，汇总生成清单，勾选后发布）。本机实测：三个包都构建成功并通过自检（Node 31 MB、JDK 46 MB、Python 缩减包 25 MB），清单生成正确，JDK 包通过应用安装后 Java 内核在内置 JDK 上跑通。

**还没有的**：OSS 桶与码云仓库本身（需要账号）。清单仓库已是 `imelonkid/notex-runtimes`（公开），`DEFAULT_CATALOG_URL` 已指向它。

### 后续修补

| 内容 | 做法 | 验证 |
|---|---|---|
| curl 不走系统代理 | 宿主新增 `systemProxy()`：先看环境变量，macOS 再问 `scutil --proxy`；下载运行时包与 Maven jar 时把代理用 `-x` 显式传给 curl，本机地址不走；curl 退出码翻译成人话并注明是否经过代理 | 开发服务器实测从 GitHub Release 经代理下载 Node 包 4.4 s，校验解压正常 |
| ⌘Z 只能撤销结构操作，文字编辑退出编辑框后拿不回来 | 撤销栈改成快照式并带会话合并（`core/history.ts`）：结构操作一步一条，文字编辑按「同一 cell 里连续的改动」合并成一条，切 cell、退出编辑、编辑器失焦时封口。编辑器内 ⌘Z 仍由编辑器逐字撤销，编辑器外 ⌘Z 撤销整段会话或一次结构操作；撤销时保留后来跑出的运行结果。关键修复：撤销把源码同步回 CodeMirror 时的事务标成外部同步，既不回调 onChange（否则会记成新编辑并清空重做栈），也不进编辑器自己的历史（否则编辑器里 ⌘Z 会把刚撤销的又撤回来）。文本编辑框不再依赖浏览器原生撤销（WebKit 把一次编辑里的连续输入和粘贴合成一组，⌘Z 一下整段全没），自己记一份栈：停顿 600ms 分组，粘贴单独一组，⌘Z / ⇧⌘Z 在编辑框内逐组撤销重做。没用 Git 做撤销：自动保存半秒一次，每次保存一个 commit 粒度不对，也和用户自己用 Git 冲突；Git 留给有历史版本的备份 | `test:history` 6 项；浏览器实测两段编辑分别撤销、重做，编辑器内 ⌘Z 只撤自己敲的 |
| 从网页复制带图片的内容粘进来只剩纯文本 | 文本 cell 的编辑框接管 `text/html` 与图片文件：HTML 用 turndown 转 Markdown（标题、加粗、列表、表格、带语言的代码块、图片），远程图片用 curl（带系统代理）下载、`data:` 图片解码、截图文件直接落盘，都存到笔记同目录的 `.assets/<哈希>-<原名>` 并改写成相对路径。预览时相对路径图片经宿主换成可加载地址：桌面壳 `asset://`（开了 `protocol-asset`），开发服务器 `/__host/file`。相对路径写在文件里，Git、GitHub、别的编辑器照常显示 | `test:paste` 11 项；浏览器实测 labuladong 页面片段：图片 662×302 落盘并渲染 |
| 正文密度太松 | 行距 1.68→1.6、段距 0.9em→0.75em、标题上下距收紧、引用块去掉首尾子元素外边距（原来上下各空一层）、列表项间距 0.25em→0.15em、cell 内边距 10/14→8/10、代码编辑器行距 1.6→1.5 内边距 13→10。这些间距做成用户设置「密度」（紧凑 / 标准 / 宽松），和字号一样不属于主题；主题协议不接受间距字段 | `test:theme` 新增 2 项（三档变量、变量都被样式用到）；浏览器实测三档切换 |
