# 调研：Jupyter 的执行序号是什么逻辑

> 起因：NoteX 现在的序号会在重新打开笔记时变化，我实测确认了
> （`[8][7][2][4]` 重开后变成 `[7][6][1][3]`）。
> 先搞清楚 Jupyter 怎么做，再决定我们怎么改。
>
> 本机没装 Jupyter（`ipykernel` / `jupyter_client` / `nbformat` / `notebook` /
> `jupyterlab` 全部未安装），所以下面是读协议规范和 issue 得到的结论，
> 没有在本机实跑验证。

## 1. 一句话

**序号不是 cell 的属性，是内核的属性。**
它是内核里一个单调递增的计数器，数的是"执行请求"，不是"cell"。
前端从不自己算这个数，只是把内核回传的值画出来。

## 2. 协议原文怎么说

jupyter_client 的 messaging spec：

> The kernel should have a single, monotonically increasing counter of all
> execution requests that are made with `store_history=True`.

拆开看有四层意思：

**single** — 一个内核一个计数器，整个 notebook 的所有 cell 共用它。

**monotonically increasing** — 只增不减，永不回填。跑第 5 次就是 5，
哪怕跑的是第一个 cell。

**of all execution requests** — 数的是请求次数。同一个 cell 连跑三次会拿到
三个不同的号，界面上显示最后一个。所以序号回答的是
"这个 cell 最近一次是第几个跑的"，不是"这是第几个 cell"。

**with store_history=True** — 有个开关。`execute_request` 里带
`store_history: false` 就不计数，`silent: true` 会强制它为 false。
补全、变量查看、前端偷偷跑的初始化代码都走这条路，所以不会污染序号。

计数器的值通过 `execute_input` 和 `execute_reply` 两条消息回传，
**出错的执行也照样带序号**（`status: error` 的 reply 里也有 `execution_count`）。

## 3. nbformat 里存的是什么

每个 code cell 存一个 `execution_count`，类型是 **integer 或 null**。

`null` 的语义是明确的：**这个 cell 没有被运行过**。界面上画成 `[ ]`。

`[*]` 不存盘，那是前端在"已提交、还没拿到回复"这段时间画的临时状态。

（`execution_count` 这个名字是 nbformat 4.0 才定下来的，
之前叫 `prompt_number`。改名本身说明了它的定位：
从"提示符上的编号"变成"执行计数"。）

## 4. 重启内核之后会怎样

这是最关键的一段，也是最容易想当然的一段。

重启之后：

- **内核的计数器归零**，下一次执行是 `[1]`
- **文档里已有的序号原封不动**，还是 `[47]` `[48]` 那些旧数字

于是你会看到 `[1]` 和 `[47]` 并排。Jupyter **不做任何重新编号**。

看起来像 bug，其实是有意的。这个状态恰好准确：
`[1]` 是新内核里跑过的，`[47]` 是旧内核留下的、当前内核里根本不存在的状态。
两个数字看着不协调，正是因为它们描述的事实本来就不协调。

想清干净有专门的入口：**Restart Kernel and Clear Outputs**，
它把每个 cell 的 `execution_count` 设回 null，全部变 `[ ]`。
这是"重新开始"的显式动作，不是自动行为。

社区里确实有人提过"重启时自动清掉序号"（jupyter/help #95），
但官方的答案一直是那个显式菜单项。

## 5. 为什么它坚决不重新编号

两个理由，第二个是硬约束。

**一、序号是执行历史的唯一证据。**
notebook 的核心风险是隐藏状态：屏幕上的顺序和内核里的实际执行顺序可以完全不同。
序号是判断"到底按什么顺序跑的"的唯一线索。一旦重新编号，
`[8][7][2][4]` 被压成 `[4][3][1][2]`，相对顺序看着还在，
但"中间有多少次执行没留在这篇笔记里"这个信息就没了。

**二、在 IPython 里这个数字是活的引用。**
序号 n 同时是历史的句柄：

```python
In[5]      # 第 5 次执行的源码
Out[5]     # 第 5 次执行的结果
_5         # Out[5] 的简写
_i5        # In[5] 的简写
```

重新编号会让这些引用全部指错。这一条 NoteX 目前用不上（三个内核都没做历史引用），
但它解释了为什么 Jupyter 在设计上把序号当成不可变的标识，而不是显示用的装饰。

## 6. 对照我们现在的做法

| | Jupyter | NoteX 现在 |
|---|---|---|
| 计数器在哪 | 内核里，随内核生死 | `Notebook.counter`，随文件持久化 |
| 重启内核 | 计数器归零，已有序号不动 | 内核重启和序号无关 |
| 重新打开 | 序号原样，因为它就存在文件里 | **每次 load 重新编号 1..n** |
| 没跑过的 cell | `null` → `[ ]` | `undefined` → `[ ]`（一致） |
| 清空 | 显式菜单项设回 null | 有"清空输出"，会把 counter 归零 |

问题出在第三行。`normalizeExecCounters` 每次 `load()` 都按原有先后压成 1..n，
于是同一个 cell 的号会在**没有被运行**的情况下变化。

这正是 Jupyter 明确拒绝做的事，而且我们做得更彻底——它每次打开都做一遍。

它当初是为了解决"三个 cell 显示 `[1][14][3]` 看起来像坏了"。
但那个现象的真正原因不是数字不连续，是
**计数器跨会话累加，而内核状态不跨会话**。
重开一篇笔记，Java 内核是全新的，里面什么变量都没有，
界面却显示 `[1][2][3]`，像是刚跑完一样。**压缩序号不是修好了它，是把它藏得更深了。**

## 7. 最终决定：不要序号

调研完之后结论反而更简单了：**序号这件事本身在 NoteX 里不值得做。**

Jupyter 需要它，是因为那个数字在 IPython 里是活的句柄（`In[5]`、`_5`），
而且一个内核跑一整篇笔记，"第几次执行"确实是有用的历史坐标。
NoteX 两条都不成立：没有历史引用，而且刷新之后内核全新，
一个跨会话累加的数字既不能用来引用，也不能用来判断顺序。

所以括号里不再放数字，改放**这次会话里发生了什么**：

| 标记 | 含义 | 颜色 |
|---|---|---|
| `[ ]` | 本次会话还没运行过 | 灰 |
| `[*]` | 正在运行，带呼吸动效 | 琥珀 |
| `[✓]` | 运行成功 | 绿 |
| `[✗]` | 运行出错 | 红 |
| `[–]` | 运行被中断 | 琥珀 |

配套规则：

- **标记不进文件。** 只活在内存里，刷新页面全部回到 `[ ]`。
  那时内核是全新的，画对号就是骗人。
- **切换笔记不丢。** 标记按 cell id 存在笔记外面，
  切走再切回来还在，因为内核确实还活着。
- **重启某门语言的内核，清掉这门语言的标记。** 别的语言不受影响。
- **输出照常保留。** 刷新后你仍然看得见上次跑出来的结果，
  只是装订线不再声称"这是本次会话跑的"。两件事分开表达。
- 导出 ipynb 时 `execution_count` 一律写 `null`，
  在 nbformat 里就是"未运行"，与我们实际知道的情况一致。

比起原来的方案，少了一个概念（计数器），少了一处会说谎的地方（重开后的 `[1][2][3]`），
而且五个符号不用解释也看得懂。

## 参考

- [jupyter_client — Messaging in Jupyter](https://jupyter-client.readthedocs.io/en/stable/messaging.html)
- [nbformat — Format Description](https://nbformat.readthedocs.io/en/latest/format_description.html)
- [JupyterLab API — nbformat.ExecutionCount](https://jupyterlab.readthedocs.io/en/stable/api/types/nbformat.ExecutionCount.html)
- [jupyter/help #95 — clear cell numbers on kernel restart](https://github.com/jupyter/help/issues/95)
- [jupyterlab/jupyterlab #11570 — Remove execution # of cells pasted between notebooks](https://github.com/jupyterlab/jupyterlab/issues/11570)
- [jupyterlab/jupyterlab #3999 — Restart Kernel and Clear All Outputs](https://github.com/jupyterlab/jupyterlab/issues/3999)
- [Python Data Science Handbook — Input and Output History](https://jakevdp.github.io/PythonDataScienceHandbook/01.04-input-output-history.html)
- [IPython reference — output caching](https://ipython.org/ipython-doc/stable/interactive/reference.html)
