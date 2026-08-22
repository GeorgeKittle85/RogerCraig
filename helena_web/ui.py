"""A `UI` that emits events instead of drawing on a terminal.

The harness sends every piece of user-visible output through `helena_harness.ui.UI`.
Subclassing it — rather than reimplementing the agent loop for the browser — is
what keeps the web client honest: the tool cards, diffs, tables and permission
prompts you see in a browser are the exact calls the terminal renders.
"""

from __future__ import annotations

import asyncio
from typing import Any, Iterable

from helena_harness.permissions import PermissionRequest, PermissionResult
from helena_harness.ui import UI

from .events import EventHub, markup_to_text

# How long a permission prompt waits for an answer before giving up. Nobody is
# obliged to be at the keyboard; the model is told it was declined and carries
# on, which is the same outcome as answering "no".
PERMISSION_TIMEOUT = 30 * 60


class WebUI(UI):
    def __init__(self, hub: EventHub) -> None:
        # quiet=True so that anything not overridden here stays silent rather
        # than leaking into the server's stdout.
        super().__init__(quiet=True)
        self.hub = hub
        self._depth = 0
        self._tool_stack: list[tuple[int, str]] = []
        self._last_tool = 0
        self._tool_seq = 0
        self._stream_open = False
        self._stream_parts: list[str] = []
        self._label = "HELENA"
        self.pending_permissions: dict[str, asyncio.Future[str]] = {}
        self.pending_questions: dict[str, asyncio.Future[str | None]] = {}

    # --- plumbing ----------------------------------------------------------

    def emit(self, type_: str, **data: Any) -> None:
        self.hub.emit(type_, depth=self._depth, **data)

    def indent(self, prefix: str) -> None:
        self._indent = prefix
        self._depth = prefix.count("│")

    # --- primitives --------------------------------------------------------

    def print(self, *args: Any, **kwargs: Any) -> None:
        text = " ".join(markup_to_text(a) for a in args).strip()
        if text:
            self.emit("text", text=text)

    def raw(self, text: str) -> None:
        if text:
            self.emit("text", text=text)

    def notice(self, message: str) -> None:
        self.emit("notice", text=markup_to_text(message))

    def warn(self, message: str) -> None:
        self.emit("warn", text=markup_to_text(message))

    def error(self, message: str) -> None:
        self.emit("error", text=markup_to_text(message))

    def rule(self, label: str = "") -> None:
        self.emit("divider", label=markup_to_text(label))

    # --- conversation ------------------------------------------------------

    def banner(self, model: str, workspace: str, mode: str, server: str) -> None:
        self.emit("banner", model=model, workspace=workspace, mode=mode, server=server)

    def assistant_prefix(self, label: str = "HELENA") -> None:
        self._label = label
        self._stream_open = True
        self._stream_parts = []
        self.emit("assistant_start", label=label)

    def stream_token(self, text: str) -> None:
        if not self._stream_open:          # a token before any prefix: open one
            self.assistant_prefix(self._label)
        self._stream_parts.append(text)
        self.emit("token", text=text)

    def end_stream(self) -> None:
        if not self._stream_open:
            return
        self._stream_open = False
        self.emit("assistant_end", text="".join(self._stream_parts), label=self._label)
        self._stream_parts = []

    def render_markdown(self, text: str) -> None:
        if text and text.strip():
            self.emit("markdown", text=text)

    # --- tools -------------------------------------------------------------

    def tool_start(self, tool: str, preview: str) -> None:
        self._tool_seq += 1
        call_id = self._tool_seq
        self._tool_stack.append((call_id, tool))
        self.emit("tool_start", id=call_id, tool=tool, preview=preview)

    def tool_result(self, tool: str, ok: bool, summary: str, detail: str = "") -> None:
        call_id = self._pop_tool(tool)
        self.emit("tool_result", id=call_id, tool=tool, ok=ok,
                  summary=summary, detail=detail)

    def tool_output(self, text: str, limit: int = 12) -> None:
        if text and text.strip():
            self.emit("tool_output", id=self._current_tool(), text=text)

    def diff(self, patch: str, max_lines: int = 40) -> None:
        if patch and patch.strip():
            self.emit("diff", id=self._current_tool(), patch=patch)

    def render_todos(self, todos: Iterable[dict[str, Any]]) -> None:
        items = [dict(t) for t in todos]
        if items:
            self.emit("todos", items=items)

    def code(self, text: str, language: str = "python") -> None:
        self.emit("code", text=text, language=language)

    def _pop_tool(self, tool: str) -> int:
        """The id `tool` was started with. A stack, because subagents nest."""
        for index in range(len(self._tool_stack) - 1, -1, -1):
            if self._tool_stack[index][1] == tool:
                self._last_tool = self._tool_stack.pop(index)[0]
                return self._last_tool
        if self._tool_stack:
            self._last_tool = self._tool_stack.pop()[0]
        return self._last_tool

    def _current_tool(self) -> int:
        """The card an output block belongs to.

        The agent reports a result *before* its diff or captured output, so the
        call is already off the stack by then — hence the fallback to the one
        that just finished.
        """
        return self._tool_stack[-1][0] if self._tool_stack else self._last_tool

    # --- structured output -------------------------------------------------

    def table(self, title: str, columns: list[str], rows: list[list[str]]) -> None:
        self.emit(
            "table",
            title=title,
            columns=list(columns),
            rows=[[markup_to_text(cell) for cell in row] for row in rows],
        )

    def usage(self, stats: dict[str, Any]) -> None:
        clean = {k: v for k, v in stats.items() if v}
        if clean:
            self.emit("usage", stats=clean)

    # --- permission prompt -------------------------------------------------

    async def ask_permission(self, req: PermissionRequest, result: PermissionResult) -> str:
        """Emit a prompt and wait for the browser to answer it."""
        loop = asyncio.get_running_loop()
        future: asyncio.Future[str] = loop.create_future()
        request_id = f"perm-{self.hub.last_seq + 1}"
        self.pending_permissions[request_id] = future

        self.emit(
            "permission",
            id=request_id,
            tool=req.tool,
            action=req.action.value,
            preview=req.preview,
            detail=req.detail,
            danger=result.danger,
            reason=result.reason,
            agent=req.agent,
        )
        try:
            answer = await asyncio.wait_for(asyncio.shield(future), timeout=PERMISSION_TIMEOUT)
        except asyncio.TimeoutError:
            answer = "no"
            self.emit("permission_resolved", id=request_id, answer="no",
                      note="timed out waiting for an answer")
        except asyncio.CancelledError:
            self.emit("permission_resolved", id=request_id, answer="no", note="interrupted")
            raise
        finally:
            self.pending_permissions.pop(request_id, None)
        return answer

    def answer_permission(self, request_id: str, answer: str) -> bool:
        """Resolve a pending prompt. Returns False if it is already gone."""
        future = self.pending_permissions.get(request_id)
        if future is None or future.done():
            return False
        future.set_result(answer)
        self.emit("permission_resolved", id=request_id, answer=answer)
        return True

    def cancel_permissions(self) -> None:
        for request_id, future in list(self.pending_permissions.items()):
            if not future.done():
                future.set_result("no")
                self.emit("permission_resolved", id=request_id, answer="no", note="interrupted")

    # --- model-asked question -----------------------------------------------

    async def ask_user_question(self, question: str, options: list[dict[str, str]]) -> str | None:
        """Emit a question prompt and wait for the browser to answer it."""
        loop = asyncio.get_running_loop()
        future: asyncio.Future[str | None] = loop.create_future()
        request_id = f"question-{self.hub.last_seq + 1}"
        self.pending_questions[request_id] = future

        self.emit("question", id=request_id, question=question, options=options)
        try:
            answer = await asyncio.wait_for(asyncio.shield(future), timeout=PERMISSION_TIMEOUT)
        except asyncio.TimeoutError:
            answer = None
            self.emit("question_resolved", id=request_id, answer=None,
                      note="timed out waiting for an answer")
        except asyncio.CancelledError:
            self.emit("question_resolved", id=request_id, answer=None, note="interrupted")
            raise
        finally:
            self.pending_questions.pop(request_id, None)
        return answer

    def answer_question(self, request_id: str, answer: str) -> bool:
        """Resolve a pending question. Returns False if it is already gone."""
        future = self.pending_questions.get(request_id)
        if future is None or future.done():
            return False
        future.set_result(answer)
        self.emit("question_resolved", id=request_id, answer=answer)
        return True

    def cancel_questions(self) -> None:
        for request_id, future in list(self.pending_questions.items()):
            if not future.done():
                future.set_result(None)
                self.emit("question_resolved", id=request_id, answer=None, note="interrupted")
