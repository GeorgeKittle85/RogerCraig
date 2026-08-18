"""One browser chat = one harness session.

`WebSession` subclasses the terminal `Repl`, which is the whole point: slash
commands, permission handling, transcripts and the agent loop are inherited
rather than reimplemented, so `/mode plan` or `/doctor` in the browser runs the
identical code as in the terminal. Only the two things that assume a TTY are
replaced — the prompt loop (there is none; input arrives over HTTP) and the
SIGINT handler (a web server must keep its own Ctrl-C).
"""

from __future__ import annotations

import asyncio
import contextlib
import json
from datetime import datetime
from pathlib import Path
from typing import Any

from helena_harness.client import ensure_server
from helena_harness.config import Config
from helena_harness.repl import COMMANDS, Repl

from .events import EventHub
from .ui import WebUI

EXIT_COMMANDS = {"/exit", "/quit", "exit", "quit"}


class WebSession(Repl):
    def __init__(self, chat_id: str, config: Config, title: str = "") -> None:
        self.id = chat_id
        self.hub = EventHub()
        self.web_ui = WebUI(self.hub)
        super().__init__(config, ui=self.web_ui)
        self.title = title
        self.created_at = datetime.now().isoformat(timespec="seconds")
        self.updated_at = self.created_at
        self.ready = False
        self.closed = False
        self.default_model = ""      # what the server falls back to
        self._ready_lock = asyncio.Lock()
        self._turn_task: asyncio.Task | None = None

    # --- startup -----------------------------------------------------------

    async def ensure_ready(self) -> bool:
        """Bring the model server up, once, on the first message."""
        async with self._ready_lock:
            if self.ready:
                return True
            ok, note = await ensure_server(
                self.config.server_url, self.config.api_token, self.config.auto_start_server
            )
            if not ok:
                self.ui.error(f"No HELENA server: {note}.")
                self.ui.notice(
                    "Start one with `helena-server` (or `python3 -m helena_server`), or point "
                    f"at another with HELENA_SERVER_URL. Trying {self.config.server_url}."
                )
                return False
            if note.startswith("started"):
                self.ui.notice(f"Started a model server for this session ({note}).")

            health = await self.client.health()
            self.default_model = health.get("default_model", "") or ""
            model_label = self.config.model or self.default_model or "?"
            if not health.get("ollama_reachable"):
                self.ui.warn(health.get("detail")
                             or "Ollama is not reachable — the model layer is down.")
            self.ui.banner(model_label, str(self.config.workspace),
                           self.config.mode, self.config.server_url)
            self.ready = True
            self._reminder_task = asyncio.create_task(self._reminder_loop())
            self.emit_state()
            return True

    def emit_state(self) -> None:
        self.hub.emit(
            "state",
            model=self.config.model or self.default_model,
            mode=self.config.mode,
            workspace=str(self.config.workspace),
            stream=self.config.stream,
            name=self.config.name,
            server=self.config.server_url,
            busy=self.busy,
            title=self.title,
        )

    # --- input -------------------------------------------------------------

    def submit(
        self,
        lines: list[str],
        display: str = "",
        attachments: list[str] | None = None,
    ) -> bool:
        """Accept one message. Returns False if a turn is already running.

        A message can expand to more than one harness line — attaching a file
        is `/read <path>` followed by whatever the user typed — but the browser
        showed it as one thing, so it runs as one uninterruptible sequence and
        appears in the log as one `user` event.
        """
        if self._turn_task and not self._turn_task.done():
            return False
        lines = [line.strip() for line in lines if line and line.strip()]
        if not lines:
            return False
        shown = (display or lines[-1]).strip()
        if not self.title:
            self.title = self._derive_title(shown or lines[0])
        self.hub.emit("user", text=shown, files=list(attachments or []),
                      images=len(attachments or []))
        self._turn_task = asyncio.create_task(self._run(lines))
        return True

    async def _run(self, lines: list[str]) -> None:
        try:
            if not await self.ensure_ready():
                return
            for line in lines:
                if line.lower() in EXIT_COMMANDS:
                    self.ui.notice("Nothing to exit in the browser — this chat stays in "
                                   "the sidebar. /clear starts the conversation over.")
                    continue
                await self.handle_line(line)
        except asyncio.CancelledError:
            self.ui.warn("Interrupted.")
        except Exception as exc:            # one bad turn must not kill the chat
            self.ui.error(f"{type(exc).__name__}: {exc}")
        finally:
            self.busy = False
            self.updated_at = datetime.now().isoformat(timespec="seconds")
            self.emit_state()
            self.save()

    def interrupt(self) -> bool:
        """Ctrl-C, from a browser: cancel the running turn."""
        self.web_ui.cancel_permissions()
        task = self._current_task or self._turn_task
        if task and not task.done():
            task.cancel()
            return True
        return False

    # --- the turn ----------------------------------------------------------

    async def _guarded_turn(self, text: str) -> None:
        """`Repl._guarded_turn` without the signal handling.

        The terminal binds SIGINT to cancel the turn; here the server owns
        SIGINT and the browser cancels through /interrupt instead.
        """
        images, self._pending_images = self._pending_images, []
        self.busy = True
        self.emit_state()
        task = asyncio.create_task(self.agent.send(text, images=images or None))
        self._current_task = task
        try:
            result = await task
        except asyncio.CancelledError:
            self.web_ui.end_stream()
            self.ui.warn("Interrupted. The conversation is intact — say what to do differently.")
            return
        finally:
            self.busy = False
            self._current_task = None

        self.ui.usage({
            "prompt_tokens": result.prompt_tokens,
            "completion_tokens": result.completion_tokens,
            "total_seconds": result.seconds,
            "tool_calls": result.tool_calls,
        })
        self.transcript.save(self.agent.messages, self.agent.totals)
        self._flush_reminders()

    # --- persistence -------------------------------------------------------

    @staticmethod
    def _derive_title(text: str) -> str:
        flat = " ".join(text.split())
        return flat[:60] + ("…" if len(flat) > 60 else "")

    @property
    def store_dir(self) -> Path:
        return self.config.project_dir / "web" / "chats"

    @property
    def store_path(self) -> Path:
        return self.store_dir / f"{self.id}.json"

    def summary(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title or "New chat",
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "messages": len([m for m in self.agent.messages if m.get("role") == "user"]),
            "model": self.config.model,
            "mode": self.config.mode,
            "busy": self.busy,
        }

    def save(self) -> Path:
        self.store_dir.mkdir(parents=True, exist_ok=True)
        payload = {
            **self.summary(),
            "workspace": str(self.config.workspace),
            "totals": self.agent.totals,
            "events": self.hub.dump(),
            "history": [_strip_images(m) for m in self.agent.messages],
        }
        tmp = self.store_path.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.store_path)
        return self.store_path

    @classmethod
    def load(cls, path: Path, config: Config) -> "WebSession":
        data = json.loads(path.read_text("utf-8"))
        session = cls(chat_id=data.get("id", path.stem), config=config,
                      title=data.get("title", ""))
        session.created_at = data.get("created_at", session.created_at)
        session.updated_at = data.get("updated_at", session.updated_at)
        session.hub.restore(data.get("events", []))
        session.agent.messages = data.get("history", [])
        totals = data.get("totals") or {}
        session.agent.totals.update({k: v for k, v in totals.items() if k in session.agent.totals})
        return session

    def delete(self) -> None:
        with contextlib.suppress(OSError):
            self.store_path.unlink()

    # --- shutdown ----------------------------------------------------------

    async def close(self) -> None:
        if self.closed:
            return
        self.closed = True
        self.interrupt()
        if self._reminder_task:
            self._reminder_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._reminder_task
        for job in self.ctx.jobs.values():
            if job.proc.returncode is None:
                with contextlib.suppress(ProcessLookupError, OSError):
                    job.proc.terminate()
        if self.agent.messages:
            self.transcript.save(self.agent.messages, self.agent.totals)
        self.save()
        await self.client.aclose()


def _strip_images(message: dict[str, Any]) -> dict[str, Any]:
    if not message.get("images"):
        return message
    copy = dict(message)
    copy["images"] = [f"<image omitted: {len(img)} base64 chars>" for img in message["images"]]
    return copy


def command_catalog() -> list[dict[str, str]]:
    """The slash commands, for the browser's autocomplete — one source of truth."""
    return [{"name": name, "description": text} for name, text in COMMANDS.items()]
