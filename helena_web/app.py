"""The FastAPI app behind the chat UI.

Endpoints are deliberately thin: they hand a line of input to a `WebSession`
and get out of the way. Everything a chat produces travels back over one SSE
stream per chat, which is also what makes two browser tabs on the same chat
show the same thing.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from helena_harness.client import ServerError
from helena_harness.config import VALID_MODES
from helena_harness.subagents import AGENT_SPECS
from helena_harness.tools import build_tools

from . import __version__
from .manager import ChatManager
from .session import WebSession, command_catalog

UI_DIST = Path(__file__).parent / "ui" / "dist"
MAX_UPLOAD_BYTES = 20 * 1024 * 1024
SSE_KEEPALIVE = 20.0


# --- request bodies --------------------------------------------------------

class NewChatBody(BaseModel):
    title: str = ""


class MessageBody(BaseModel):
    text: str = Field(default="", max_length=200_000)
    # Paths on this machine, written by /api/chats/{id}/upload.
    images: list[str] = Field(default_factory=list)
    files: list[str] = Field(default_factory=list)


class PermissionBody(BaseModel):
    id: str
    answer: str


class RenameBody(BaseModel):
    title: str


def create_app(workspace: Path | None = None, overrides: dict[str, Any] | None = None) -> FastAPI:
    manager = ChatManager((workspace or Path.cwd()).resolve(), overrides)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.manager = manager
        yield
        await manager.close_all()

    app = FastAPI(title="H.E.L.E.N.A web", version=__version__, lifespan=lifespan)

    def chat_or_404(chat_id: str) -> WebSession:
        session = manager.get(chat_id)
        if session is None:
            raise HTTPException(status_code=404, detail=f"No chat {chat_id!r}.")
        return session

    # --- meta --------------------------------------------------------------

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        config = manager._config()
        payload: dict[str, Any] = {
            "ok": True,
            "version": __version__,
            "workspace": str(manager.workspace),
            "server_url": config.server_url,
            "mode": config.mode,
            "model": config.model,
            "name": config.name,
            "server": {"reachable": False, "detail": ""},
        }
        from helena_harness.client import ServerClient

        client = ServerClient(config.server_url, config.api_token, timeout=10.0)
        try:
            data = await client.health()
            payload["server"] = {"reachable": True, **data}
        except ServerError as exc:
            payload["server"] = {"reachable": False, "detail": str(exc)}
        finally:
            await client.aclose()
        return payload

    @app.get("/api/commands")
    async def commands() -> dict[str, Any]:
        return {
            "commands": command_catalog(),
            "modes": list(VALID_MODES),
            "agents": [
                {"name": spec.name, "description": " ".join(spec.description.split()),
                 "tools": spec.tools}
                for spec in AGENT_SPECS.values()
            ],
            "tools": [
                {"name": tool.name, "action": tool.action.value,
                 "description": " ".join(tool.description.split())}
                for tool in build_tools()
            ],
        }

    @app.get("/api/models")
    async def models() -> dict[str, Any]:
        from helena_harness.client import ServerClient

        config = manager._config()
        client = ServerClient(config.server_url, config.api_token, timeout=30.0)
        try:
            data = await client.models()
        except ServerError as exc:
            return {"models": [], "error": str(exc), "default_model": "", "vision_model": ""}
        finally:
            await client.aclose()
        return data

    # --- chats -------------------------------------------------------------

    @app.get("/api/chats")
    async def list_chats() -> dict[str, Any]:
        return {"chats": manager.list()}

    @app.post("/api/chats", status_code=201)
    async def new_chat(body: NewChatBody) -> dict[str, Any]:
        session = await manager.create(title=body.title)
        return session.summary()

    @app.get("/api/chats/{chat_id}")
    async def get_chat(chat_id: str, since: int = 0) -> dict[str, Any]:
        session = chat_or_404(chat_id)
        return {
            **session.summary(),
            "last_seq": session.hub.last_seq,
            "events": [event.to_dict() for event in session.hub.since(since)],
        }

    @app.delete("/api/chats/{chat_id}")
    async def delete_chat(chat_id: str) -> dict[str, Any]:
        if not await manager.delete(chat_id):
            raise HTTPException(status_code=404, detail=f"No chat {chat_id!r}.")
        return {"deleted": chat_id}

    @app.patch("/api/chats/{chat_id}")
    async def rename_chat(chat_id: str, body: RenameBody) -> dict[str, Any]:
        session = chat_or_404(chat_id)
        session.title = body.title.strip()[:120] or session.title
        session.save()
        session.emit_state()
        return session.summary()

    # --- talking to a chat -------------------------------------------------

    @app.post("/api/chats/{chat_id}/message", status_code=202)
    async def send_message(chat_id: str, body: MessageBody) -> dict[str, Any]:
        session = chat_or_404(chat_id)
        text = body.text.strip()

        # Attachments become the commands the terminal would have used, so the
        # vision fallback, the workspace guard and the permission gate are all
        # the same code. What the browser shows is the plain message.
        lines = [f"/read {path}" for path in body.files]
        if body.images:
            first, rest = body.images[0], body.images[1:]
            for extra in rest:
                session.ui.notice(f"Only one image per message — ignoring {Path(extra).name}.")
            lines.append(f"/image {first}" + (f" {text}" if text else ""))
        elif text:
            lines.append(text)

        names = [Path(path).name for path in body.files + body.images]
        display = text or (f"Look at {names[0]}" if names else "")
        if not lines:
            raise HTTPException(status_code=400, detail="Nothing to send.")
        if not session.submit(lines, display=display, attachments=names):
            raise HTTPException(status_code=409, detail="This chat is already working on a turn.")
        return {"accepted": True, "seq": session.hub.last_seq}

    @app.post("/api/chats/{chat_id}/interrupt")
    async def interrupt(chat_id: str) -> dict[str, Any]:
        session = chat_or_404(chat_id)
        return {"interrupted": session.interrupt()}

    @app.post("/api/chats/{chat_id}/permission")
    async def answer_permission(chat_id: str, body: PermissionBody) -> dict[str, Any]:
        session = chat_or_404(chat_id)
        answer = body.answer.lower()
        if answer not in ("once", "always", "session", "no"):
            raise HTTPException(status_code=400,
                                detail="answer must be once | always | session | no")
        if not session.web_ui.answer_permission(body.id, answer):
            raise HTTPException(status_code=409, detail="That prompt is no longer waiting.")
        return {"answered": answer}

    @app.post("/api/chats/{chat_id}/upload")
    async def upload(chat_id: str, file: UploadFile = File(...)) -> dict[str, Any]:
        session = chat_or_404(chat_id)
        blob = await file.read(MAX_UPLOAD_BYTES + 1)
        if len(blob) > MAX_UPLOAD_BYTES:
            raise HTTPException(status_code=413, detail="File is larger than 20 MB.")
        target_dir = session.config.project_dir / "web" / "uploads"
        target_dir.mkdir(parents=True, exist_ok=True)
        safe = Path(file.filename or "upload").name.replace("/", "_") or "upload"
        path = target_dir / f"{uuid.uuid4().hex[:8]}-{safe}"
        path.write_bytes(blob)
        return {"path": str(path), "name": safe, "size": len(blob),
                "content_type": file.content_type or ""}

    @app.get("/api/chats/{chat_id}/events")
    async def events(chat_id: str, request: Request, since: int = 0) -> StreamingResponse:
        session = chat_or_404(chat_id)
        queue = session.hub.listen()
        backlog = session.hub.since(since)

        async def stream():
            try:
                for event in backlog:
                    yield _sse(event.to_dict())
                while True:
                    if await request.is_disconnected():
                        return
                    try:
                        event = await asyncio.wait_for(queue.get(), timeout=SSE_KEEPALIVE)
                    except asyncio.TimeoutError:
                        if not session.hub.is_listening(queue):
                            return       # dropped for being slow; let it resume
                        yield ": keepalive\n\n"
                        continue
                    yield _sse(event.to_dict())
            finally:
                session.hub.unlisten(queue)

        return StreamingResponse(
            stream(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no",
                     "Connection": "keep-alive"},
        )

    # --- the built client --------------------------------------------------

    if UI_DIST.is_dir():
        app.mount("/assets", StaticFiles(directory=UI_DIST / "assets"), name="assets")

        @app.get("/{path:path}")
        async def spa(path: str):
            if path.startswith("api/"):
                # Otherwise a mistyped endpoint answers 200 with the HTML shell.
                raise HTTPException(status_code=404, detail=f"No endpoint /{path}.")
            candidate = (UI_DIST / path).resolve()
            if path and UI_DIST.resolve() in candidate.parents and candidate.is_file():
                return FileResponse(candidate)
            return FileResponse(UI_DIST / "index.html")
    else:
        @app.get("/")
        async def missing_ui() -> JSONResponse:
            return JSONResponse(
                status_code=503,
                content={
                    "detail": "The React client has not been built.",
                    "fix": "cd helena_web/ui && npm install && npm run build",
                },
            )

    return app


def _sse(payload: dict[str, Any]) -> str:
    return f"data: {json.dumps(payload, ensure_ascii=False, default=str)}\n\n"
