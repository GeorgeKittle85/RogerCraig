"""The event stream a chat produces, and the hub that fans it out.

Everything the harness would have printed to a terminal becomes one of these
events. They are append-only and numbered, so a browser that reconnects can
say "I have up to 41" and get the rest instead of the whole conversation.
"""

from __future__ import annotations

import asyncio
import re
import time
from dataclasses import dataclass, field
from typing import Any

# Rich markup the harness writes into strings ("[bold]qwen2.5[/bold]").
# Bold survives as markdown because it carries meaning; colours are dropped —
# a colour in a terminal is emphasis, and the web UI has its own styling for
# notice/warn/error, which is where that emphasis actually lives.
_BOLD_OPEN = re.compile(r"\[bold(?:\s+[\w #]+)?\]")
_BOLD_CLOSE = re.compile(r"\[/bold(?:\s+[\w #]+)?\]")
_ANY_TAG = re.compile(r"\[/?(?:dim|red|green|yellow|cyan|blue|magenta|white|black|italic|"
                      r"bright_black|bold|underline|reverse|on\s+\w+|#[0-9a-fA-F]{6})"
                      r"(?:\s+[\w #]+)?\]")


def markup_to_text(value: Any) -> str:
    """Turn rich console markup into plain markdown."""
    text = value if isinstance(value, str) else str(value)
    text = _BOLD_OPEN.sub("**", text)
    text = _BOLD_CLOSE.sub("**", text)
    text = _ANY_TAG.sub("", text)
    return text


@dataclass
class Event:
    seq: int
    type: str
    data: dict[str, Any]
    at: float = field(default_factory=time.time)

    def to_dict(self) -> dict[str, Any]:
        return {"seq": self.seq, "type": self.type, "at": self.at, **self.data}


class EventHub:
    """Per-chat broadcast: keeps the log, feeds every attached listener.

    The log is the chat. It is what a reloading browser replays, what the
    sidebar derives titles from, and what gets written to disk — so events are
    recorded even when nobody is watching.
    """

    def __init__(self, max_log: int = 4000) -> None:
        self.log: list[Event] = []
        self.max_log = max_log
        self._seq = 0
        self._listeners: set[asyncio.Queue[Event]] = set()

    # --- producing ---------------------------------------------------------

    def emit(self, type_: str, **data: Any) -> Event:
        self._seq += 1
        event = Event(seq=self._seq, type=type_, data=data)
        self.log.append(event)
        if len(self.log) > self.max_log:
            # Drop from the front; `since` lookups clamp to what survives.
            del self.log[: len(self.log) - self.max_log]
        for queue in list(self._listeners):
            try:
                queue.put_nowait(event)
            except asyncio.QueueFull:      # a listener that stopped reading
                self._listeners.discard(queue)
        return event

    # --- consuming ---------------------------------------------------------

    def listen(self) -> asyncio.Queue[Event]:
        queue: asyncio.Queue[Event] = asyncio.Queue(maxsize=2048)
        self._listeners.add(queue)
        return queue

    def unlisten(self, queue: asyncio.Queue[Event]) -> None:
        self._listeners.discard(queue)

    def is_listening(self, queue: asyncio.Queue[Event]) -> bool:
        """False once a listener has been dropped — a stream that sees this
        should close so the browser reconnects and resumes from `since`."""
        return queue in self._listeners

    def since(self, seq: int) -> list[Event]:
        return [e for e in self.log if e.seq > seq]

    @property
    def last_seq(self) -> int:
        return self._seq

    # --- persistence -------------------------------------------------------

    def dump(self) -> list[dict[str, Any]]:
        return [e.to_dict() for e in self.log]

    def restore(self, raw: list[dict[str, Any]]) -> None:
        self.log = []
        self._seq = 0
        for item in raw:
            data = {k: v for k, v in item.items() if k not in ("seq", "type", "at")}
            self._seq += 1
            self.log.append(Event(seq=self._seq, type=item.get("type", "notice"),
                                  data=data, at=item.get("at", time.time())))
