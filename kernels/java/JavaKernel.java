// xnotebook Java 内核
// 协议：JSON Lines over stdio，每条协议消息以 RS (U+001E) 开头。
// 启动：java JavaKernel.java   （JDK 11+ 源码启动器，免编译；需 JDK 而非 JRE）
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import jdk.jshell.*;
import jdk.jshell.SourceCodeAnalysis.CompletionInfo;
import jdk.jshell.SourceCodeAnalysis.Documentation;
import jdk.jshell.SourceCodeAnalysis.Suggestion;

public class JavaKernel {
    static final char RS = (char) 0x1e; // RS 记录分隔符
    static final PrintStream OUT =
            new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);

    JShell shell;
    SourceCodeAnalysis analysis;
    /** 用户代码的 stdout/stderr 通过这里回流，标记当前请求 id */
    volatile String currentId = "";
    /** 用户请求中断后置位；JShell 的 stop() 不会留下可识别的事件，靠这个标记区分 */
    volatile boolean stopRequested = false;
    /** 调用注入的渲染器时置位，避免对渲染结果本身再次渲染 */
    volatile boolean rendering = false;
    final ExecutorService worker = Executors.newSingleThreadExecutor(r -> {
        Thread t = new Thread(r, "xnb-exec");
        t.setDaemon(true);
        return t;
    });

    public static void main(String[] args) throws Exception {
        new JavaKernel().run();
    }

    void run() throws Exception {
        shell = JShell.builder()
                .out(new PrintStream(new StreamSink("stdout"), true, StandardCharsets.UTF_8))
                .err(new PrintStream(new StreamSink("stderr"), true, StandardCharsets.UTF_8))
                .in(new ByteArrayInputStream(new byte[0]))
                // JShell 会另起一个 JVM 执行用户代码（这是中断和隔离的前提）。
                // 在 macOS 上它默认会注册成前台应用，弹出 Dock 图标并抢走焦点，
                // UIElement 让它以后台身份运行；其余参数只为压低启动开销。
                .remoteVMOptions(
                        "-Dapple.awt.UIElement=true",
                        "-XX:TieredStopAtLevel=1",
                        "-XX:+UseSerialGC",
                        "-Xshare:auto")
                .build();
        analysis = shell.sourceCodeAnalysis();
        try {
            shell.eval(RENDERER_SOURCE);
        } catch (Exception ignored) {
            // 渲染器注入失败只影响富输出，纯文本结果照常工作
        }

        Map<String, Object> ready = new LinkedHashMap<>();
        ready.put("id", "boot");
        ready.put("type", "ready");
        ready.put("lang", "java");
        ready.put("version", System.getProperty("java.version"));
        emit(ready);

        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            if (line.isEmpty() || line.charAt(0) != RS) continue;
            Map<String, Object> req = Json.parseObject(line.substring(1));
            String op = str(req.get("op"));
            String id = str(req.get("id"));
            switch (op) {
                case "execute" -> submitExecute(id, str(req.get("code")));
                case "complete" -> complete(id, str(req.get("code")), intOf(req.get("cursor")));
                case "inspect" -> inspect(id, str(req.get("code")), intOf(req.get("cursor")));
                case "classpath" -> addClasspath(id, req.get("paths"));
                case "interrupt" -> {
                    stopRequested = true;
                    try { shell.stop(); } catch (Exception ignored) {}
                }
                case "shutdown" -> { shutdown(); return; }
                default -> done(id, "error", 0);
            }
        }
        shutdown();
    }

    /** 把 jar 加入 JShell 类路径。已加过的跳过，重复 add 会让 JShell 报警。 */
    final Set<String> classpath = new LinkedHashSet<>();

    void addClasspath(String id, Object paths) {
        List<String> added = new ArrayList<>();
        if (paths instanceof List<?> list) {
            for (Object o : list) {
                String p = String.valueOf(o);
                if (p.isBlank() || !classpath.add(p)) continue;
                try {
                    shell.addToClasspath(p);
                    added.add(p);
                } catch (Exception e) {
                    classpath.remove(p);
                    error(id, "ClasspathError", "无法加入类路径：" + p + "（" + e.getMessage() + "）", List.of());
                }
            }
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("type", "classpath");
        m.put("added", new ArrayList<Object>(added));
        emit(m);
        done(id, "ok", 0);
    }

    void shutdown() {
        worker.shutdownNow();
        try { shell.close(); } catch (Exception ignored) {}
    }

    /**
     * 注入到用户会话里的渲染器。JShell 在独立 JVM 中执行，宿主拿不到真实对象，
     * 因此把渲染工作放进去，结果用 Base64 回传，规避 Java 字符串字面量的转义问题。
     * 返回 "mime,payload" 的 Base64，无可渲染内容时返回 null。
     */
    static final String RENDERER_SOURCE = """
        public class __XnbRender {
            static final int MAX_ROWS = 200;

            public static String render(Object o) {
                if (o == null) return null;
                String mime = "text/html";
                String payload;
                try {
                    String png = png(o);
                    if (png != null) { mime = "image/png"; payload = png; }
                    else if (o instanceof java.util.Map<?, ?> m) {
                        if (m.isEmpty()) return null;
                        payload = mapTable(m);
                    } else if (o instanceof java.util.Collection<?> c) {
                        if (c.isEmpty()) return null;
                        payload = collTable(c);
                    } else if (o.getClass().isArray()) {
                        java.util.List<Object> list = new java.util.ArrayList<>();
                        int n = java.lang.reflect.Array.getLength(o);
                        for (int i = 0; i < n && i < MAX_ROWS; i++) list.add(java.lang.reflect.Array.get(o, i));
                        if (list.isEmpty()) return null;
                        payload = collTable(list);
                    } else return null;
                } catch (Throwable t) {
                    return null;
                }
                byte[] raw = (mime + "," + payload).getBytes(java.nio.charset.StandardCharsets.UTF_8);
                return java.util.Base64.getEncoder().encodeToString(raw);
            }

            /** 用反射处理图像，避免硬依赖 java.desktop 模块 */
            static String png(Object o) {
                try {
                    Class<?> img = Class.forName("java.awt.image.RenderedImage");
                    if (!img.isInstance(o)) return null;
                    Class<?> io = Class.forName("javax.imageio.ImageIO");
                    java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
                    java.lang.reflect.Method w = io.getMethod("write", img, String.class, java.io.OutputStream.class);
                    Object ok = w.invoke(null, o, "png", bos);
                    if (!(ok instanceof Boolean b) || !b) return null;
                    return java.util.Base64.getEncoder().encodeToString(bos.toByteArray());
                } catch (Throwable t) {
                    return null;
                }
            }

            static String esc(Object v) {
                String s = String.valueOf(v);
                if (s.length() > 400) s = s.substring(0, 400) + "…";
                return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;");
            }

            static String mapTable(java.util.Map<?, ?> m) {
                StringBuilder sb = new StringBuilder("<table><thead><tr><th>键</th><th>值</th></tr></thead><tbody>");
                int i = 0;
                for (java.util.Map.Entry<?, ?> e : m.entrySet()) {
                    if (i++ >= MAX_ROWS) break;
                    sb.append("<tr><td>").append(esc(e.getKey())).append("</td><td>")
                      .append(esc(e.getValue())).append("</td></tr>");
                }
                sb.append("</tbody></table>");
                if (m.size() > MAX_ROWS) sb.append("<div>共 ").append(m.size()).append(" 项，仅显示前 ").append(MAX_ROWS).append(" 项</div>");
                return sb.toString();
            }

            static String collTable(java.util.Collection<?> c) {
                // 元素若都是 Map，按并集的键做多列表格；否则单列加序号
                java.util.List<Object> rows = new java.util.ArrayList<>();
                for (Object o : c) { rows.add(o); if (rows.size() >= MAX_ROWS) break; }
                boolean allMaps = !rows.isEmpty();
                for (Object o : rows) if (!(o instanceof java.util.Map)) { allMaps = false; break; }

                StringBuilder sb = new StringBuilder("<table><thead><tr>");
                if (allMaps) {
                    java.util.LinkedHashSet<Object> cols = new java.util.LinkedHashSet<>();
                    for (Object o : rows) cols.addAll(((java.util.Map<?, ?>) o).keySet());
                    for (Object col : cols) sb.append("<th>").append(esc(col)).append("</th>");
                    sb.append("</tr></thead><tbody>");
                    for (Object o : rows) {
                        sb.append("<tr>");
                        java.util.Map<?, ?> row = (java.util.Map<?, ?>) o;
                        for (Object col : cols) sb.append("<td>").append(esc(row.get(col))).append("</td>");
                        sb.append("</tr>");
                    }
                } else {
                    sb.append("<th>#</th><th>值</th></tr></thead><tbody>");
                    for (int i = 0; i < rows.size(); i++) {
                        sb.append("<tr><td>").append(i).append("</td><td>")
                          .append(esc(rows.get(i))).append("</td></tr>");
                    }
                }
                sb.append("</tbody></table>");
                if (c.size() > MAX_ROWS) sb.append("<div>共 ").append(c.size()).append(" 项，仅显示前 ").append(MAX_ROWS).append(" 项</div>");
                return sb.toString();
            }
        }
        """;

    /** 对表达式结果调用注入的渲染器，拿回 mime 与数据；无富输出时返回 null */
    String[] richOutput(String varName) {
        if (varName == null || varName.isBlank() || rendering) return null;
        rendering = true;
        try {
            List<SnippetEvent> events = shell.eval("__XnbRender.render(" + varName + ")");
            for (SnippetEvent ev : events) {
                if (ev.exception() != null || ev.value() == null) continue;
                String literal = ev.value();
                if (literal.equals("null") || literal.length() < 2) continue;
                // 值是 Java 字符串字面量，Base64 内容只含 ASCII，去掉首尾引号即可
                String b64 = literal.substring(1, literal.length() - 1);
                String decoded = new String(Base64.getDecoder().decode(b64), StandardCharsets.UTF_8);
                int sep = decoded.indexOf(',');
                if (sep < 0) continue;
                return new String[] { decoded.substring(0, sep), decoded.substring(sep + 1) };
            }
        } catch (Throwable ignored) {
            // 渲染失败不能影响正常结果
        } finally {
            rendering = false;
        }
        return null;
    }

    /** 执行放到单线程池，读 stdin 的主线程保持可响应 interrupt */
    void submitExecute(String id, String code) {
        worker.submit(() -> {
            long t0 = System.nanoTime();
            currentId = id;
            stopRequested = false;
            String status = "ok";
            try {
                status = execute(id, code);
            } catch (Throwable t) {
                error(id, t.getClass().getSimpleName(), String.valueOf(t.getMessage()), List.of());
                status = "error";
            } finally {
                currentId = "";
                done(id, status, (System.nanoTime() - t0) / 1_000_000);
            }
        });
    }

    String execute(String id, String code) {
        String remaining = code;
        String lastValue = null;
        String lastName = null;
        while (remaining != null && !remaining.isBlank()) {
            CompletionInfo info = analysis.analyzeCompletion(remaining);
            String snippet = info.source();
            if (snippet == null || snippet.isBlank()) {
                // 不完整的尾巴：整体交给 JShell，让它报语法错
                snippet = remaining;
                remaining = null;
            } else {
                remaining = info.remaining();
            }

            List<SnippetEvent> events;
            try {
                events = shell.eval(snippet);
            } catch (IllegalStateException e) {
                error(id, "KernelError", "内核已关闭", List.of());
                return "error";
            }

            if (stopRequested) {
                error(id, "KeyboardInterrupt", "执行被中断", List.of());
                return "aborted";
            }

            for (SnippetEvent ev : events) {
                if (ev.causeSnippet() != null) continue; // 只报顶层事件
                if (ev.status() == Snippet.Status.REJECTED) {
                    List<String> tb = new ArrayList<>();
                    shell.diagnostics(ev.snippet())
                         .forEach(d -> tb.add(d.getMessage(Locale.getDefault())));
                    error(id, "CompileError", tb.isEmpty() ? "编译失败" : tb.get(0), tb);
                    return "error";
                }
                if (ev.exception() != null) {
                    JShellException ex = ev.exception();
                    String name = "Exception";
                    String msg = String.valueOf(ex.getMessage());
                    List<String> tb = new ArrayList<>();
                    if (ex instanceof EvalException ee) {
                        name = simpleName(ee.getExceptionClassName());
                        msg = String.valueOf(ee.getMessage());
                    } else if (ex instanceof UnresolvedReferenceException ur) {
                        name = "UnresolvedReference";
                        msg = "存在未解析的引用：" + ur.getSnippet().name();
                    }
                    for (StackTraceElement el : ex.getStackTrace()) {
                        if (el.getClassName().startsWith("REPL.")) {
                            String where = el.getLineNumber() > 0 ? "line " + el.getLineNumber() : "cell";
                            String what = el.getMethodName().startsWith("$") ? "<cell>" : el.getMethodName();
                            tb.add("\tat " + what + "(" + where + ")");
                        } else if (!el.getClassName().startsWith("jdk.jshell")) {
                            tb.add("\tat " + el);
                        }
                        if (tb.size() >= 12) break;
                    }
                    error(id, name, msg, tb);
                    return "error";
                }
                String v = ev.value();
                if (v != null && !v.isEmpty()) {
                    lastValue = v;
                    lastName = ev.snippet() instanceof ExpressionSnippet es ? es.name()
                             : ev.snippet() instanceof VarSnippet vs ? vs.name()
                             : null;
                }
            }
        }
        if (lastValue != null) {
            Map<String, Object> data = new LinkedHashMap<>();
            String[] rich = richOutput(lastName);
            if (rich != null) data.put(rich[0], rich[1]);
            data.put("text/plain", lastValue);
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", id);
            m.put("type", "result");
            m.put("data", data);
            emit(m);
        }
        return "ok";
    }

    static String simpleName(String fqcn) {
        int i = fqcn.lastIndexOf('.');
        return i < 0 ? fqcn : fqcn.substring(i + 1);
    }

    void complete(String id, String code, int cursor) {
        int[] anchor = new int[] { cursor };
        List<Suggestion> suggestions;
        try {
            suggestions = analysis.completionSuggestions(code, cursor, anchor);
        } catch (Exception e) {
            suggestions = List.of();
        }
        List<Object> items = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (Suggestion s : suggestions) {
            String cont = s.continuation();
            if (!seen.add(cont)) continue;
            Map<String, Object> item = new LinkedHashMap<>();
            // JShell 的方法补全形如 stream() 或 add(，剥掉括号再给编辑器
            boolean isMethod = cont.endsWith("(") || cont.endsWith("()");
            String label = cont.endsWith("()") ? cont.substring(0, cont.length() - 2)
                    : cont.endsWith("(") ? cont.substring(0, cont.length() - 1)
                    : cont;
            item.put("label", label);
            item.put("kind", isMethod ? "method" : "property");
            items.add(item);
            if (items.size() >= 80) break;
        }
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("type", "completions");
        m.put("anchor", anchor[0]);
        m.put("items", items);
        emit(m);
        done(id, "ok", 0);
    }

    void inspect(String id, String code, int cursor) {
        StringBuilder sb = new StringBuilder();
        try {
            for (Documentation d : analysis.documentation(code, cursor, true)) {
                sb.append(d.signature()).append('\n');
                if (d.javadoc() != null) sb.append(d.javadoc()).append('\n');
            }
        } catch (Exception ignored) {}
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("type", "inspection");
        m.put("text", sb.toString().strip());
        emit(m);
        done(id, "ok", 0);
    }

    void error(String id, String ename, String evalue, List<String> traceback) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("type", "error");
        m.put("ename", ename);
        m.put("evalue", evalue);
        m.put("traceback", new ArrayList<Object>(traceback));
        emit(m);
    }

    void done(String id, String status, long ms) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", id);
        m.put("type", "done");
        m.put("status", status);
        m.put("durationMs", ms);
        emit(m);
    }

    synchronized void emit(Map<String, Object> msg) {
        OUT.print(RS);
        OUT.print(Json.write(msg));
        OUT.print('\n');
        OUT.flush();
    }

    static String str(Object o) { return o == null ? "" : String.valueOf(o); }
    static int intOf(Object o) { return o instanceof Number n ? n.intValue() : 0; }

    /** 把用户代码的输出包装成 stream 消息 */
    class StreamSink extends OutputStream {
        final String name;
        final ByteArrayOutputStream buf = new ByteArrayOutputStream();
        StreamSink(String name) { this.name = name; }

        @Override public void write(int b) {
            buf.write(b);
            if (b == '\n') flush();
        }

        @Override public void write(byte[] b, int off, int len) {
            buf.write(b, off, len);
            for (int i = off; i < off + len; i++) {
                if (b[i] == '\n') { flush(); return; }
            }
        }

        @Override public void flush() {
            if (buf.size() == 0) return;
            String text = new String(buf.toByteArray(), StandardCharsets.UTF_8);
            buf.reset();
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", currentId);
            m.put("type", "stream");
            m.put("name", name);
            m.put("text", text);
            emit(m);
        }
    }
}

/** 极简 JSON 读写，避免引入任何外部依赖。 */
final class Json {
    private final String s;
    private int i;

    private Json(String s) { this.s = s; }

    static Map<String, Object> parseObject(String text) {
        Json p = new Json(text);
        p.ws();
        Object v = p.value();
        return v instanceof Map ? castMap(v) : new LinkedHashMap<>();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> castMap(Object o) { return (Map<String, Object>) o; }

    private void ws() { while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++; }

    private Object value() {
        ws();
        if (i >= s.length()) return null;
        char c = s.charAt(i);
        switch (c) {
            case '{': return object();
            case '[': return array();
            case '"': return string();
            case 't': i += 4; return Boolean.TRUE;
            case 'f': i += 5; return Boolean.FALSE;
            case 'n': i += 4; return null;
            default: return number();
        }
    }

    private Map<String, Object> object() {
        Map<String, Object> m = new LinkedHashMap<>();
        i++; // {
        ws();
        if (i < s.length() && s.charAt(i) == '}') { i++; return m; }
        while (i < s.length()) {
            ws();
            String k = string();
            ws();
            if (i < s.length() && s.charAt(i) == ':') i++;
            m.put(k, value());
            ws();
            if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
            if (i < s.length() && s.charAt(i) == '}') { i++; }
            break;
        }
        return m;
    }

    private List<Object> array() {
        List<Object> out = new ArrayList<>();
        i++; // [
        ws();
        if (i < s.length() && s.charAt(i) == ']') { i++; return out; }
        while (i < s.length()) {
            out.add(value());
            ws();
            if (i < s.length() && s.charAt(i) == ',') { i++; continue; }
            if (i < s.length() && s.charAt(i) == ']') { i++; }
            break;
        }
        return out;
    }

    private String string() {
        StringBuilder sb = new StringBuilder();
        if (i < s.length() && s.charAt(i) == '"') i++;
        while (i < s.length()) {
            char c = s.charAt(i++);
            if (c == '"') break;
            if (c != '\\') { sb.append(c); continue; }
            char e = s.charAt(i++);
            switch (e) {
                case 'n' -> sb.append('\n');
                case 't' -> sb.append('\t');
                case 'r' -> sb.append('\r');
                case 'b' -> sb.append('\b');
                case 'f' -> sb.append('\f');
                case 'u' -> { sb.append((char) Integer.parseInt(s.substring(i, i + 4), 16)); i += 4; }
                default -> sb.append(e);
            }
        }
        return sb.toString();
    }

    private Object number() {
        int start = i;
        while (i < s.length() && "+-0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
        String raw = s.substring(start, i);
        try {
            if (raw.contains(".") || raw.contains("e") || raw.contains("E")) return Double.parseDouble(raw);
            return Long.parseLong(raw);
        } catch (NumberFormatException e) {
            return 0;
        }
    }

    static String write(Object o) {
        StringBuilder sb = new StringBuilder();
        writeTo(sb, o);
        return sb.toString();
    }

    private static void writeTo(StringBuilder sb, Object o) {
        if (o == null) { sb.append("null"); return; }
        if (o instanceof String str) { escape(sb, str); return; }
        if (o instanceof Number || o instanceof Boolean) { sb.append(o); return; }
        if (o instanceof Map<?, ?> m) {
            sb.append('{');
            boolean first = true;
            for (Map.Entry<?, ?> e : m.entrySet()) {
                if (!first) sb.append(',');
                first = false;
                escape(sb, String.valueOf(e.getKey()));
                sb.append(':');
                writeTo(sb, e.getValue());
            }
            sb.append('}');
            return;
        }
        if (o instanceof Iterable<?> it) {
            sb.append('[');
            boolean first = true;
            for (Object e : it) {
                if (!first) sb.append(',');
                first = false;
                writeTo(sb, e);
            }
            sb.append(']');
            return;
        }
        escape(sb, String.valueOf(o));
    }

    private static void escape(StringBuilder sb, String v) {
        sb.append('"');
        for (int k = 0; k < v.length(); k++) {
            char c = v.charAt(k);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
                }
            }
        }
        sb.append('"');
    }
}
