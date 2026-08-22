"""The agentic loop.

One `send()` is one turn from the user's point of view, but internally it runs
until the model stops asking for tools: stream a completion, execute whatever
tools it requested (each one gated by the permission engine), feed the real
results back, repeat. Nothing here decides whether a tool *may* run — that is
`permissions.py` — and nothing here formats output — that is `ui.py`.
"""

from __future__ import annotations

import asyncio
import json
import platform
import re
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Sequence

from .client import ServerError
from .permissions import Decision, PermissionRequest
from .tools.base import Tool, ToolContext, ToolError, ToolResult, truncate

SYSTEM_PROMPT = """You are {name}, a local-first AI agent working in a terminal on the user's own machine. You run entirely on locally-hosted models — nothing the user says leaves their computer.

Your character: sharp, direct, warm without being chatty. You are a capable colleague, not a customer-service voice. Say what you did and what you found; skip the preamble and the flattery.

## How you work

You have real tools. When a request calls for one, use it — do not describe what you would do, and never claim you did something you did not actually do through a tool call. The user sees every tool you run, so inventing an action is both wrong and obvious.

- Investigate before you change anything. Read the file before editing it; search before assuming a symbol exists.
- Prefer the specific tool over a shell command: read_file over cat, search_text over grep, find_files over find, edit_file over sed.
- After changing code, verify it: run the tests, the linter, or the program itself.
- Work in small, checkable steps. For anything with more than about three steps, keep todo_write updated so the user can see where you are.
- If a tool fails, read the error and adapt. Do not repeat the identical call and hope.
- If the user's request is ambiguous in a way that changes what you would build, ask. Otherwise make the sensible call and say what you assumed.
- Some tools need the user's approval. If one is declined, do not try to route around it — say what you needed and why, and offer an alternative.
- When you need the user's decision mid-task — not routine ambiguity you can just resolve — use `ask_user_question` rather than ending your turn and waiting for their next message. It hands you the answer directly, so you keep working in the same response instead of stopping the workflow. Save it for real forks in the road (which approach, a choice with no safe default, confirming something destructive); do not use it to check in or ask "should I continue?".

## Answering

Be concise by default: a couple of sentences beats a report. Expand when the user asks for depth or the material genuinely needs it. Use markdown for structure when it helps and skip it when it doesn't. Reference code as `path:line` so the user can jump to it. Give exactly one reply per turn — never write the user's next message for them.

## Environment

{environment}
{memory}{profile}"""

MAX_INLINE_TOOL_SCAN = 4000


@dataclass
class TurnResult:
    text: str = ""
    tool_calls: int = 0
    iterations: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    seconds: float = 0.0
    stopped: str = "complete"     # complete | max_iterations | error | interrupted
    error: str = ""


@dataclass
class Agent:
    """A conversation with a model plus the tools it is allowed to use."""

    ctx: ToolContext
    tools: Sequence[Tool]
    label: str = "HELENA"
    model: str | None = None
    max_iterations: int | None = None
    system_prompt: str | None = None
    nested: bool = False
    messages: list[dict[str, Any]] = field(default_factory=list)
    totals: dict[str, float] = field(
        default_factory=lambda: {"prompt_tokens": 0, "completion_tokens": 0, "seconds": 0.0, "turns": 0, "tool_calls": 0}
    )

    def __post_init__(self) -> None:
        self._by_name = {t.name: t for t in self.tools}

    # --- prompt assembly ---------------------------------------------------

    def environment_block(self) -> str:
        cfg = self.ctx.config
        lines = [
            f"Working directory: {self.ctx.workspace}",
            f"Platform: {platform.system()} {platform.release()} ({platform.machine()})",
            f"Today: {datetime.now().strftime('%A, %d %B %Y')}",
            f"Permission mode: {cfg.mode}"
            + {
                "ask": " — writes and commands need the user's approval, reads are free.",
                "auto": " — file edits are pre-approved; commands still ask.",
                "plan": " — READ-ONLY. You cannot write files or run commands; investigate and propose instead.",
                "yolo": " — everything is pre-approved. Be correspondingly careful.",
            }.get(cfg.mode, ""),
        ]
        return "\n".join(lines)

    def build_system_prompt(self) -> str:
        if self.system_prompt:
            return self.system_prompt
        from . import profile as profile_store

        memory = self.ctx.config.read_memory()
        memory_block = f"\n\n## Project instructions (from HELENA.md)\n\n{memory}" if memory else ""
        summary = profile_store.context_summary()
        profile_block = f"\n\n## About the user\n\n{summary}" if summary else ""
        return SYSTEM_PROMPT.format(
            name=self.ctx.config.name,
            environment=self.environment_block(),
            memory=memory_block,
            profile=profile_block,
        )

    def tool_specs(self) -> list[dict[str, Any]]:
        return [t.spec() for t in self.tools]

    # --- history -----------------------------------------------------------

    def trimmed_history(self) -> list[dict[str, Any]]:
        """Keep the conversation inside the context window.

        Trimming has one hard rule: never start the window on a `tool` message
        whose assistant call was dropped — models reject or hallucinate around
        an orphaned result.
        """
        limit = self.ctx.config.history_messages
        if len(self.messages) <= limit:
            return list(self.messages)
        window = self.messages[-limit:]
        while window and window[0].get("role") == "tool":
            window.pop(0)
        first_user = next((m for m in self.messages if m.get("role") == "user"), None)
        if first_user and first_user not in window:
            note = {
                "role": "user",
                "content": f"[earlier context trimmed] The original request was: {first_user.get('content', '')[:800]}",
            }
            window.insert(0, note)
        return window

    def compact(self) -> int:
        """Drop tool chatter, keeping the user/assistant thread. Returns removed count."""
        before = len(self.messages)
        kept = []
        for msg in self.messages:
            if msg.get("role") == "tool":
                continue
            if msg.get("role") == "assistant" and msg.get("tool_calls") and not (msg.get("content") or "").strip():
                continue
            trimmed = dict(msg)
            trimmed.pop("tool_calls", None)
            kept.append(trimmed)
        self.messages = kept
        return before - len(self.messages)

    # --- the loop ----------------------------------------------------------

    async def send(self, user_text: str, images: list[str] | None = None) -> TurnResult:
        message: dict[str, Any] = {"role": "user", "content": user_text}
        if images:
            message["images"] = images
        self.messages.append(message)
        return await self._run_loop()

    async def _run_loop(self) -> TurnResult:
        result = TurnResult()
        started = time.monotonic()
        max_iterations = self.max_iterations or self.ctx.config.max_iterations
        options = {"num_ctx": self.ctx.config.num_ctx, "temperature": self.ctx.config.temperature}

        for iteration in range(1, max_iterations + 1):
            result.iterations = iteration
            try:
                completion = await self._complete(options)
            except ServerError as exc:
                result.stopped, result.error = "error", str(exc)
                self.ctx.ui.end_stream()
                self.ctx.ui.error(str(exc))
                break
            except asyncio.CancelledError:
                self.ctx.ui.end_stream()
                self.messages.append({
                    "role": "assistant",
                    "content": "[interrupted by the user before finishing]",
                })
                result.stopped = "interrupted"
                raise

            text, tool_calls, usage = completion
            result.text = text or result.text
            result.prompt_tokens += int(usage.get("prompt_tokens") or 0)
            result.completion_tokens += int(usage.get("completion_tokens") or 0)

            assistant_msg: dict[str, Any] = {"role": "assistant", "content": text}
            if tool_calls:
                assistant_msg["tool_calls"] = tool_calls
            self.messages.append(assistant_msg)

            if not tool_calls:
                result.stopped = "complete"
                break

            result.tool_calls += len(tool_calls)
            for call in tool_calls:
                tool_message = await self._execute_call(call)
                self.messages.append(tool_message)
        else:
            result.stopped = "max_iterations"
            self.ctx.ui.warn(
                f"Stopped after {max_iterations} steps without a final answer. "
                "Ask me to continue, or raise max_iterations in settings."
            )

        result.seconds = time.monotonic() - started
        self.totals["prompt_tokens"] += result.prompt_tokens
        self.totals["completion_tokens"] += result.completion_tokens
        self.totals["seconds"] += result.seconds
        self.totals["tool_calls"] += result.tool_calls
        self.totals["turns"] += 1
        return result

    async def _complete(self, options: dict[str, Any]) -> tuple[str, list[dict[str, Any]], dict[str, Any]]:
        """One model call. Streams when configured, falls back to a plain call."""
        messages = [{"role": "system", "content": self.build_system_prompt()}] + self.trimmed_history()
        specs = self.tool_specs()
        model = self.model or self.ctx.config.model or None

        if not self.ctx.config.stream:
            reply = await self.ctx.client.chat(messages, model=model, tools=specs, options=options)
            if reply.content.strip():
                self.ctx.ui.assistant_prefix(self.label)
                self.ctx.ui.stream_token(reply.content)
                self.ctx.ui.end_stream()
            return reply.content, self._normalize_calls(reply.tool_calls, reply.content), reply.usage

        text_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        usage: dict[str, Any] = {}
        printed = False

        async for event in self.ctx.client.chat_stream(messages, model=model, tools=specs, options=options):
            kind = event.get("type")
            if kind == "token":
                if not printed:
                    self.ctx.ui.assistant_prefix(self.label)
                    printed = True
                text_parts.append(event["text"])
                self.ctx.ui.stream_token(event["text"])
            elif kind == "tool_calls":
                tool_calls = event.get("tool_calls") or []
            elif kind == "done":
                usage = event.get("usage") or {}
            elif kind == "error":
                if printed:
                    self.ctx.ui.end_stream()
                raise ServerError(event.get("error", "unknown server error"))

        if printed:
            self.ctx.ui.end_stream()
        text = "".join(text_parts)
        return text, self._normalize_calls(tool_calls, text), usage

    # --- tool calls --------------------------------------------------------

    def _normalize_calls(self, raw_calls: list[dict[str, Any]], text: str) -> list[dict[str, Any]]:
        calls: list[dict[str, Any]] = []
        for i, call in enumerate(raw_calls or []):
            fn = call.get("function") or {}
            args = fn.get("arguments")
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {}
            calls.append({
                "id": call.get("id") or f"call_{i}",
                "type": "function",
                "function": {"name": fn.get("name", ""), "arguments": args or {}},
            })
        if not calls and text:
            calls = self._inline_tool_calls(text)
        return calls

    def _inline_tool_calls(self, text: str) -> list[dict[str, Any]]:
        """Recover tool calls from models that emit them as text.

        Plenty of small local models know the *shape* of a tool call but not
        the protocol, and answer with a bare JSON object or a ```json block.
        Parsing that back is the difference between a working agent and one
        that narrates its intentions forever.
        """
        snippet = text.strip()[:MAX_INLINE_TOOL_SCAN]
        if "{" not in snippet:
            return []
        candidates: list[str] = []
        for match in re.finditer(r"```(?:json|tool_call)?\s*(\{.*?\})\s*```", snippet, re.DOTALL):
            candidates.append(match.group(1))
        if snippet.startswith("{") and snippet.endswith("}"):
            candidates.append(snippet)
        for match in re.finditer(r'\{[^{}]*"(?:name|tool)"\s*:\s*"[\w_]+".*?\}', snippet, re.DOTALL):
            candidates.append(match.group(0))

        for raw in candidates:
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict):
                continue
            name = obj.get("name") or obj.get("tool") or obj.get("function")
            if isinstance(name, dict):
                name = name.get("name")
            if not isinstance(name, str) or name not in self._by_name:
                continue
            args = obj.get("arguments") or obj.get("parameters") or obj.get("args") or {}
            if isinstance(args, str):
                try:
                    args = json.loads(args)
                except json.JSONDecodeError:
                    args = {}
            if not isinstance(args, dict):
                continue
            return [{"id": "inline_0", "type": "function", "function": {"name": name, "arguments": args}}]
        return []

    async def _execute_call(self, call: dict[str, Any]) -> dict[str, Any]:
        fn = call.get("function") or {}
        name = fn.get("name", "")
        args = fn.get("arguments") or {}
        tool = self._by_name.get(name)

        if tool is None:
            known = ", ".join(sorted(self._by_name)) or "(none)"
            return self._tool_message(
                call, name,
                f"Error: no tool named {name!r}. Available tools: {known}.",
            )

        try:
            preview = tool.preview(args)
        except Exception:
            preview = name
        self.ctx.ui.tool_start(name, preview)

        # Permission gate.
        try:
            detail = tool.detail(args, self.ctx)
        except Exception:
            detail = ""
        request = PermissionRequest(
            tool=name,
            action=tool.action,
            key=tool.permission_key(args) or "",
            preview=preview,
            detail=detail,
            agent=self.ctx.agent_name,
        )
        verdict = await self.ctx.permissions.check(request)
        if verdict.decision is Decision.DENY:
            self.ctx.ui.tool_result(name, False, f"declined — {verdict.reason}")
            return self._tool_message(
                call, name,
                f"Not run: {verdict.reason} Do not retry this call; tell the user what you "
                "needed it for, or take a different approach.",
            )

        # Execution.
        self.ctx.tool_calls_made += 1
        try:
            result = await tool.run(args, self.ctx)
        except ToolError as exc:
            self.ctx.ui.tool_result(name, False, str(exc))
            return self._tool_message(call, name, f"Error: {exc}")
        except asyncio.CancelledError:
            raise
        except Exception as exc:  # a tool bug shouldn't kill the session
            self.ctx.ui.tool_result(name, False, f"{type(exc).__name__}: {exc}")
            return self._tool_message(call, name, f"Error: {type(exc).__name__}: {exc}")

        self._render_result(tool, result)
        content = truncate(result.content, self.ctx.config.max_tool_output_chars, "tool output")
        return self._tool_message(call, name, content)

    def _render_result(self, tool: Tool, result: ToolResult) -> None:
        summary = result.display or ("done" if result.ok else "failed")
        self.ctx.ui.tool_result(tool.name, result.ok, summary)
        if result.meta.get("diff"):
            self.ctx.ui.diff(result.meta["diff"])
        elif self.ctx.config.show_tool_output and tool.name in ("run_command", "check_job"):
            body = result.content.split("\n", 2)[-1] if result.content else ""
            self.ctx.ui.tool_output(body)

    @staticmethod
    def _tool_message(call: dict[str, Any], name: str, content: str) -> dict[str, Any]:
        return {
            "role": "tool",
            "content": content,
            "name": name,
            "tool_call_id": call.get("id") or "call_0",
        }
