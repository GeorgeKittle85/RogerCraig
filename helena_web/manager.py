"""Keeps the set of open chats, and their files on disk."""

from __future__ import annotations

import asyncio
import json
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from helena_harness.config import Config

from .session import WebSession


class ChatManager:
    def __init__(self, workspace: Path, overrides: dict[str, Any] | None = None) -> None:
        self.workspace = workspace
        self.overrides = overrides or {}
        self.chats: dict[str, WebSession] = {}
        self._lock = asyncio.Lock()

    # --- config ------------------------------------------------------------

    def _config(self) -> Config:
        """A fresh config per chat, so /mode and /model are per-conversation."""
        config = Config.load(self.workspace)
        for key, value in self.overrides.items():
            if value is None:
                continue
            if key in ("allow", "deny"):
                target = getattr(config, key)
                target.extend(rule for rule in value if rule not in target)
            elif hasattr(config, key):
                setattr(config, key, value)
        return config

    @property
    def store_dir(self) -> Path:
        return self.workspace / ".helena" / "web" / "chats"

    # --- lifecycle ---------------------------------------------------------

    async def create(self, title: str = "") -> WebSession:
        async with self._lock:
            chat_id = f"{datetime.now().strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:4]}"
            session = WebSession(chat_id, self._config(), title=title)
            self.chats[chat_id] = session
            session.save()
            return session

    def get(self, chat_id: str) -> WebSession | None:
        session = self.chats.get(chat_id)
        if session is not None:
            return session
        path = self.store_dir / f"{chat_id}.json"
        if not path.is_file():
            return None
        try:
            session = WebSession.load(path, self._config())
        except (OSError, ValueError):
            return None
        self.chats[session.id] = session
        return session

    async def delete(self, chat_id: str) -> bool:
        session = self.get(chat_id)
        if session is None:
            return False
        await session.close()
        session.delete()
        self.chats.pop(chat_id, None)
        return True

    def list(self, limit: int = 200) -> list[dict[str, Any]]:
        """Open chats plus whatever is on disk, newest first."""
        rows: dict[str, dict[str, Any]] = {}
        if self.store_dir.is_dir():
            for path in self.store_dir.glob("*.json"):
                try:
                    data = json.loads(path.read_text("utf-8"))
                except (OSError, ValueError):
                    continue
                rows[data.get("id", path.stem)] = {
                    "id": data.get("id", path.stem),
                    "title": data.get("title") or "New chat",
                    "created_at": data.get("created_at", ""),
                    "updated_at": data.get("updated_at", ""),
                    "messages": data.get("messages", 0),
                    "model": data.get("model", ""),
                    "mode": data.get("mode", ""),
                    "busy": False,
                }
        for session in self.chats.values():          # live state wins
            rows[session.id] = session.summary()
        ordered = sorted(rows.values(), key=lambda r: r.get("updated_at") or "", reverse=True)
        return ordered[:limit]

    async def close_all(self) -> None:
        for session in list(self.chats.values()):
            await session.close()
        self.chats.clear()
