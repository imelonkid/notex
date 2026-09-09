#!/usr/bin/env python3
"""NoteX Python 内核

协议：JSON Lines over stdio，每条协议消息以 RS (U+001E) 开头。
启动：python3 kernel.py   （Python 3.8+，仅用标准库）
"""
import ast
import builtins
import io
import json
import os
import platform
import sys
import threading
import traceback

RS = "\x1e"
_REAL_STDOUT = sys.stdout
_emit_lock = threading.Lock()


def emit(msg):
    with _emit_lock:
        _REAL_STDOUT.write(RS + json.dumps(msg, ensure_ascii=False) + "\n")
        _REAL_STDOUT.flush()


class StreamSink(io.TextIOBase):
    """把用户代码的输出包装成 stream 消息，按行 flush。"""

    def __init__(self, name):
        self.name = name
        self.buf = ""
        self.request_id = ""

    def writable(self):
        return True

    def write(self, text):
        if not text:
            return 0
        self.buf += text
        if "\n" in self.buf:
            self.flush()
        return len(text)

    def flush(self):
        if not self.buf:
            return
        text, self.buf = self.buf, ""
        emit({"id": self.request_id, "type": "stream", "name": self.name, "text": text})


OUT_SINK = StreamSink("stdout")
ERR_SINK = StreamSink("stderr")

# 持久命名空间：跨 cell 保留变量
NS = {"__name__": "__main__", "__builtins__": builtins}


def set_request(request_id):
    OUT_SINK.request_id = request_id
    ERR_SINK.request_id = request_id


def repr_bundle(value):
    """支持 IPython 风格的富输出协议。"""
    data = {}
    for attr, mime in (
        ("_repr_html_", "text/html"),
        ("_repr_svg_", "image/svg+xml"),
        ("_repr_markdown_", "text/markdown"),
    ):
        fn = getattr(value, attr, None)
        if callable(fn):
            try:
                rendered = fn()
                if rendered:
                    data[mime] = rendered
            except Exception:
                pass
    png = getattr(value, "_repr_png_", None)
    if callable(png):
        try:
            import base64

            raw = png()
            if raw:
                data["image/png"] = base64.b64encode(raw).decode("ascii") if isinstance(raw, bytes) else raw
        except Exception:
            pass
    try:
        data["text/plain"] = repr(value)
    except Exception as exc:
        data["text/plain"] = "<repr 失败: %s>" % exc
    return data


def format_traceback(exc_type, exc, tb):
    """去掉内核自身的栈帧，只留用户代码部分。"""
    frames = traceback.extract_tb(tb)
    kept = [f for f in frames if f.filename == "<cell>"]
    lines = traceback.format_list(kept or frames[1:])
    return [line.rstrip("\n") for line in lines]


def execute(request_id, code):
    set_request(request_id)
    status = "ok"
    try:
        parsed = ast.parse(code, filename="<cell>", mode="exec")
    except SyntaxError as exc:
        emit(
            {
                "id": request_id,
                "type": "error",
                "ename": type(exc).__name__,
                "evalue": "%s (第 %s 行)" % (exc.msg, exc.lineno),
                "traceback": [],
            }
        )
        return "error"

    body = list(parsed.body)
    tail = None
    # 末尾是表达式的话单独 eval，取返回值（同 IPython 行为）
    if body and isinstance(body[-1], ast.Expr):
        tail = ast.Expression(body.pop().value)

    old_out, old_err = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = OUT_SINK, ERR_SINK
    try:
        if body:
            exec(compile(ast.Module(body=body, type_ignores=[]), "<cell>", "exec"), NS)
        if tail is not None:
            value = eval(compile(tail, "<cell>", "eval"), NS)
            if value is not None:
                NS["_"] = value
                emit({"id": request_id, "type": "result", "data": repr_bundle(value)})
    except KeyboardInterrupt:
        emit(
            {
                "id": request_id,
                "type": "error",
                "ename": "KeyboardInterrupt",
                "evalue": "执行被中断",
                "traceback": [],
            }
        )
        status = "aborted"
    except BaseException:
        exc_type, exc, tb = sys.exc_info()
        emit(
            {
                "id": request_id,
                "type": "error",
                "ename": exc_type.__name__,
                "evalue": str(exc),
                "traceback": format_traceback(exc_type, exc, tb),
            }
        )
        status = "error"
    finally:
        OUT_SINK.flush()
        ERR_SINK.flush()
        sys.stdout, sys.stderr = old_out, old_err
        set_request("")
    return status


def complete(request_id, code, cursor):
    """优先用 jedi（若用户环境装了），否则退回 rlcompleter。"""
    prefix = code[:cursor]
    items = []
    anchor = cursor

    try:
        import jedi  # type: ignore

        line = prefix.count("\n") + 1
        column = len(prefix) - (prefix.rfind("\n") + 1)
        script = jedi.Interpreter(code, [NS])
        for c in script.complete(line=line, column=column)[:80]:
            items.append({"label": c.name, "kind": c.type or "property", "detail": c.description or ""})
            # c.complete 是还没敲的那部分，已敲部分的长度即 len(name) - len(complete)
            anchor = cursor - (len(c.name) - len(c.complete or ""))
    except Exception:
        items = []

    if not items:
        import keyword
        import re
        import rlcompleter

        match = re.search(r"[\w.]*$", prefix)
        token = match.group(0) if match else ""
        anchor = cursor - len(token.split(".")[-1]) if "." in token else cursor - len(token)

        # rlcompleter 只看 NS，补不到的名字再从 builtins 和关键字里找
        namespace = dict(vars(builtins))
        namespace.update(NS)
        completer = rlcompleter.Completer(namespace)
        seen = set()
        for i in range(200):
            try:
                got = completer.complete(token, i)
            except Exception:
                break
            if got is None:
                break
            label = got.split(".")[-1]
            label = label[:-1] if label.endswith("(") else label
            if label in seen:
                continue
            seen.add(label)
            items.append({"label": label, "kind": "method" if got.endswith("(") else "property"})
            if len(items) >= 80:
                break

        if "." not in token:
            for kw in keyword.kwlist:
                if kw.startswith(token) and kw not in seen:
                    seen.add(kw)
                    items.append({"label": kw, "kind": "keyword"})

    emit({"id": request_id, "type": "completions", "anchor": max(0, anchor), "items": items})
    emit({"id": request_id, "type": "done", "status": "ok", "durationMs": 0})


def inspect_(request_id, code, cursor):
    import re

    match = re.search(r"[\w.]+$", code[:cursor])
    text = ""
    if match:
        try:
            obj = eval(match.group(0), NS)  # noqa: S307 - 仅用于取文档
            text = (getattr(obj, "__doc__", "") or "").strip()
        except Exception:
            text = ""
    emit({"id": request_id, "type": "inspection", "text": text})
    emit({"id": request_id, "type": "done", "status": "ok", "durationMs": 0})


def main():
    emit(
        {
            "id": "boot",
            "type": "ready",
            "lang": "python",
            "version": platform.python_version(),
        }
    )

    # 用户代码必须在主线程执行：SIGINT 只会向主线程投递 KeyboardInterrupt。
    # 因此 stdin 由后台线程读取，请求经队列交给主线程处理。
    import queue
    import time

    inbox = queue.Queue()

    def reader():
        for raw in sys.stdin:
            raw = raw.rstrip("\n").rstrip("\r")
            if not raw or raw[0] != RS:
                continue
            try:
                inbox.put(json.loads(raw[1:]))
            except Exception:
                continue
        inbox.put(None)

    threading.Thread(target=reader, daemon=True).start()

    while True:
        try:
            req = inbox.get()
        except KeyboardInterrupt:
            continue  # 空闲时收到中断，忽略
        if req is None:
            break

        op = req.get("op")
        request_id = req.get("id", "")

        if op == "execute":
            t0 = time.time()
            status = execute(request_id, req.get("code", ""))
            emit(
                {
                    "id": request_id,
                    "type": "done",
                    "status": status,
                    "durationMs": int((time.time() - t0) * 1000),
                }
            )
        elif op == "complete":
            complete(request_id, req.get("code", ""), int(req.get("cursor", 0)))
        elif op == "inspect":
            inspect_(request_id, req.get("code", ""), int(req.get("cursor", 0)))
        elif op == "interrupt":
            pass  # 中断由宿主发 SIGINT 实现，主线程执行中会抛 KeyboardInterrupt
        elif op == "shutdown":
            break


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    finally:
        os._exit(0)
