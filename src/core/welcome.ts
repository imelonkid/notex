/**
 * 首次打开时的欢迎笔记。
 *
 * 它是用户认识这个应用的第一篇内容，所以要能直接跑：三种语言各一个 cell、
 * 富输出、依赖注入、中断演示。vault 模式与 localStorage 兜底共用这一份，
 * 以前只有后者有内容，桌面用户打开看到的是一篇空笔记。
 */
import { type Cell, newCodeCell, newMarkdownCell } from './model';

export const WELCOME_TITLE = '欢迎使用 NoteX';

export function welcomeCells(): Cell[] {
  return [
    newMarkdownCell(
      '# 欢迎使用 NoteX\n\n' +
        '文本用 Markdown 书写，代码直接在页面里运行。点代码块左侧的 **▶** 或按 `⇧↩` 试试。\n\n' +
        '- 双击文本 cell 进入编辑，`⇧↩` 回到预览，点开别处也会自动预览\n' +
        '- 代码 cell 里 `⇧↩` 运行，运行中再点一次左侧按钮可以中断\n' +
        '- 点代码块上方的语言标签切换 **Java / Python / JS**，源码不会丢失\n' +
        '- 输入时会调用对应内核做补全，`Ctrl+Space` 强制触发\n' +
        '- 右键任一 cell 有完整菜单；`⌘/` 打开快捷键清单\n' +
        '- 拖左侧 ⠿ 排序，改动自动保存到本地文件',
    ),
    newMarkdownCell('## 三种语言\n\n每个代码 cell 独立选择语言和内核。三个内核互不共享变量，这是刻意的简化。'),
    newCodeCell(
      'java',
      'var squares = new java.util.ArrayList<Integer>();\n' +
        'for (int i = 1; i <= 10; i++) squares.add(i * i);\n' +
        'System.out.println("平方数: " + squares);\n' +
        'squares.stream().mapToInt(Integer::intValue).sum()',
    ),
    newCodeCell(
      'python',
      "squares = [n * n for n in range(1, 11)]\nprint('平方数:', squares)\nsum(squares)",
    ),
    newCodeCell(
      'js',
      'const squares = Array.from({ length: 10 }, (_, i) => (i + 1) ** 2);\n' +
        "console.log('平方数:', squares.join(', '));\n" +
        'squares.reduce((a, b) => a + b, 0)',
    ),
    newMarkdownCell(
      '## 富输出\n\n返回值是集合或映射时会渲染成表格，是图像时渲染成 PNG。Python 的 `_repr_html_`、JS 的 `toHTML()` 同样生效，matplotlib 图表会自动显示。',
    ),
    newCodeCell(
      'java',
      'java.util.List.of(\n' +
        '  java.util.Map.of("语言", "Java", "内核", "JShell"),\n' +
        '  java.util.Map.of("语言", "Python", "内核", "本机解释器"),\n' +
        '  java.util.Map.of("语言", "JavaScript", "内核", "Node vm")\n' +
        ')',
    ),
    newCodeCell(
      'java',
      'var im = new java.awt.image.BufferedImage(120, 60, java.awt.image.BufferedImage.TYPE_INT_RGB);\n' +
        'var g = im.createGraphics();\n' +
        'g.setColor(java.awt.Color.decode("#fdfdfc"));\n' +
        'g.fillRect(0, 0, 120, 60);\n' +
        'g.setColor(java.awt.Color.decode("#3f5a7d"));\n' +
        'g.fillOval(8, 8, 44, 44);\n' +
        'g.setColor(java.awt.Color.decode("#9c3423"));\n' +
        'g.fillOval(64, 8, 44, 44);\n' +
        'g.dispose();\n' +
        'im',
    ),
    newMarkdownCell(
      '## Java 依赖\n\n在 cell 顶部用 `//DEPS` 声明 Maven 坐标，运行前会自动下载并注入类路径。' +
        '装了 Maven 会做完整的传递依赖解析。第一次运行需要等下载。',
    ),
    newCodeCell(
      'java',
      '//DEPS org.apache.commons:commons-lang3:3.14.0\n\n' +
        'import org.apache.commons.lang3.StringUtils;\n' +
        'System.out.println(StringUtils.reverse("NoteX"));\n' +
        'StringUtils.capitalize("来自 maven 的依赖")',
    ),
    newMarkdownCell(
      '## 试试中断\n\n下面这个 cell **不会自己停下来**。运行它，再点左侧的 **■** 中断，' +
        '内核不会挂掉，之前 cell 里的变量也还在。\n\n' +
        '> 因为它是死循环，**全部运行**走到这里会停在这一步，等你手动中断。',
    ),
    newCodeCell('python', 'n = 0\nwhile True:\n    n += 1'),
    newMarkdownCell(
      '## 笔记之间可以相连\n\n' +
        '输入 `[[` 会弹出笔记名补全，`[[笔记名#小节]]` 能直接跳到某个标题。' +
        '目标笔记还不存在时链接显示为虚线，点击即可创建。笔记末尾的「反向链接」列出谁引用了这一篇。',
    ),
    newMarkdownCell(
      '## 还能做什么\n\n' +
        '- 左下角能看到三种运行时的状态，点开是设置：切换主题、手动指定运行时路径、重启内核\n' +
        '- 右上角的 ⋯ 菜单可以导出 Markdown 或 ipynb，也能把它们导入回来\n' +
        '- 笔记就是普通的 `.md` 文件，用别的编辑器改过会自动读回来\n' +
        '- 把主题包 JSON 放进 `~/.notex/themes/` 就会自动出现在设置里',
    ),
  ];
}
