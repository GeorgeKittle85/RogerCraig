"""The web harness: event stream, chat lifecycle, command parity, permissions.

These drive the real FastAPI web app over ASGI, which in turn drives the real
`WebSession` — a subclass of the terminal `Repl` — against the real model
server with a fake Ollama underneath. A green run means the whole chain works:
HTTP in, agent loop, permission gate, events out.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path

import httpx
import pytest
import uvicorn

from helena_harness.client import ServerClient
from helena_harness.repl import COMMANDS
from helena_web.app import create_app
from helena_web.events import EventHub, markup_to_text


@pytest.fixture
def web_env(tmp_path, monkeypatch, asgi_app, fake_ollama):
    """A web app whose sessions talk to the in-process model server."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()

    def make_client(base_url, token="", timeout=900.0, transport=None):
        return ServerClient(base_url, token, timeout=timeout,
                            transport=httpx.ASGITransport(app=asgi_app))

    monkeypatch.setattr("helena_harness.repl.ServerClient", make_client)

    async def already_running(*_args, **_kwargs):
        return True, "already running"

    monkeypatch.setattr("helena_web.session.ensure_server", already_running)
    return workspace, fake_ollama


class _QuietServer(uvicorn.Server):
    """A uvicorn server that leaves pytest's signal handlers alone."""

    def install_signal_handlers(self) -> None:
        return None


@pytest.fixture
async def live_server(web_env):
    """A real socket, for the one thing ASGI-in-process cannot do.

    `httpx.ASGITransport` buffers a response until the app finishes it, so an
    endpoint that never finishes — which is exactly what an SSE stream is —
    can only be exercised over a real connection.
    """
    workspace, _ = web_env
    app = create_app(workspace=workspace)
    server = _QuietServer(uvicorn.Config(app, host="127.0.0.1", port=0, log_level="error"))
    task = asyncio.create_task(server.serve())
    while not server.started:
        await asyncio.sleep(0.02)
    port = server.servers[0].sockets[0].getsockname()[1]
    try:
        yield f"http://127.0.0.1:{port}", app
    finally:
        server.should_exit = True
        await asyncio.wait_for(task, timeout=10)


@pytest.fixture
async def client(web_env):
    workspace, _ = web_env
    app = create_app(workspace=workspace)
    async with httpx.AsyncClient(
        transport=httpx.ASGITransport(app=app), base_url="http://web"
    ) as http:
        async with app.router.lifespan_context(app):
            http.app = app          # tests reach the manager through this
            yield http


async def new_chat(client) -> str:
    res = await client.post("/api/chats", json={"title": ""})
    assert res.status_code == 201
    return res.json()["id"]


async def turn(client, chat_id: str, text: str) -> list[dict]:
    """Send a line and wait for the session's background turn to finish."""
    res = await client.post(f"/api/chats/{chat_id}/message", json={"text": text})
    assert res.status_code == 202, res.text
    session = client.app.state.manager.get(chat_id)
    await asyncio.wait_for(asyncio.shield(session._turn_task), timeout=20)
    return (await client.get(f"/api/chats/{chat_id}")).json()["events"]


def types_of(events: list[dict]) -> list[str]:
    return [event["type"] for event in events]


def first(events: list[dict], type_: str) -> dict | None:
    return next((event for event in events if event["type"] == type_), None)


# --- markup ---------------------------------------------------------------

def test_markup_becomes_markdown():
    assert markup_to_text("Model set to [bold]qwen[/bold]") == "Model set to **qwen**"
    assert markup_to_text("[dim]saved to disk[/dim]") == "saved to disk"
    assert markup_to_text("[bold yellow]⏰ Reminder:[/bold yellow] tea") == "**⏰ Reminder:** tea"
    assert markup_to_text("plain text") == "plain text"


# --- the hub --------------------------------------------------------------

def test_hub_numbers_and_replays():
    hub = EventHub()
    hub.emit("notice", text="one")
    hub.emit("notice", text="two")
    assert [e.seq for e in hub.log] == [1, 2]
    assert [e.data["text"] for e in hub.since(1)] == ["two"]
    assert hub.since(2) == []


def test_hub_survives_a_round_trip():
    hub = EventHub()
    hub.emit("token", text="hi")
    restored = EventHub()
    restored.restore(hub.dump())
    assert restored.last_seq == 1
    assert restored.log[0].data["text"] == "hi"


def test_hub_fans_out_to_listeners():
    hub = EventHub()
    queue = hub.listen()
    hub.emit("notice", text="heard")
    assert queue.get_nowait().data["text"] == "heard"
    hub.unlisten(queue)
    hub.emit("notice", text="not heard")
    assert queue.empty()


# --- chat lifecycle -------------------------------------------------------

async def test_chat_create_list_rename_delete(client):
    chat_id = await new_chat(client)

    listing = (await client.get("/api/chats")).json()["chats"]
    assert [row["id"] for row in listing] == [chat_id]

    renamed = await client.patch(f"/api/chats/{chat_id}", json={"title": "Refactor the parser"})
    assert renamed.json()["title"] == "Refactor the parser"

    assert (await client.delete(f"/api/chats/{chat_id}")).status_code == 200
    assert (await client.get("/api/chats")).json()["chats"] == []
    assert (await client.get(f"/api/chats/{chat_id}")).status_code == 404


async def test_health_and_command_catalog(client):
    health = (await client.get("/api/health")).json()
    assert health["ok"] is True

    catalog = (await client.get("/api/commands")).json()
    # The browser completes from exactly the list the terminal completes from.
    assert [c["name"] for c in catalog["commands"]] == list(COMMANDS)
    assert catalog["modes"] == ["ask", "auto", "plan", "yolo"]
    assert any(tool["name"] == "run_command" for tool in catalog["tools"])
    assert any(agent["name"] == "explorer" for agent in catalog["agents"])


# --- talking --------------------------------------------------------------

async def test_a_message_streams_tokens_and_a_reply(client, web_env):
    _, ollama = web_env
    ollama.replies = [{"content": "Hello from a local model."}]
    chat_id = await new_chat(client)

    events = await turn(client, chat_id, "hi")
    kinds = types_of(events)
    assert kinds[0] == "user"
    assert "token" in kinds and "assistant_end" in kinds
    assert first(events, "assistant_end")["text"] == "Hello from a local model."
    # Tokens must concatenate to the same thing the final event carries.
    streamed = "".join(e["text"] for e in events if e["type"] == "token")
    assert streamed == "Hello from a local model."
    assert first(events, "usage")["stats"]["prompt_tokens"] == 120


async def test_the_chat_titles_itself_from_the_first_message(client, web_env):
    _, ollama = web_env
    ollama.replies = [{"content": "ok"}]
    chat_id = await new_chat(client)
    await turn(client, chat_id, "explain the permission engine")
    assert (await client.get(f"/api/chats/{chat_id}")).json()["title"] == (
        "explain the permission engine"
    )


async def test_one_turn_at_a_time(client, web_env):
    _, ollama = web_env
    ollama.replies = [{"content": "working"}, {"content": "second"}]
    chat_id = await new_chat(client)

    assert (await client.post(f"/api/chats/{chat_id}/message", json={"text": "one"})).status_code == 202
    busy = await client.post(f"/api/chats/{chat_id}/message", json={"text": "two"})
    assert busy.status_code == 409

    session = client.app.state.manager.get(chat_id)
    await asyncio.wait_for(asyncio.shield(session._turn_task), timeout=20)


async def test_empty_messages_are_refused(client):
    chat_id = await new_chat(client)
    assert (await client.post(f"/api/chats/{chat_id}/message", json={"text": "   "})).status_code == 400


# --- command parity -------------------------------------------------------

async def test_help_lists_every_command(client):
    chat_id = await new_chat(client)
    events = await turn(client, chat_id, "/help")
    table = first(events, "table")
    assert table["title"] == "Commands"
    assert [row[0] for row in table["rows"]] == list(COMMANDS)


async def test_mode_changes_the_permission_engine(client):
    chat_id = await new_chat(client)
    events = await turn(client, chat_id, "/mode plan")
    session = client.app.state.manager.get(chat_id)
    assert session.config.mode == "plan"
    assert session.permissions.mode == "plan"
    assert types_of(events)[-1] == "state"
    assert events[-1]["mode"] == "plan"


async def test_model_switch_reaches_the_agent(client):
    chat_id = await new_chat(client)
    await turn(client, chat_id, "/model llama3.2:3b")
    session = client.app.state.manager.get(chat_id)
    assert session.config.model == "llama3.2:3b"
    assert session.agent.model == "llama3.2:3b"


async def test_unknown_command_warns_without_calling_the_model(client, web_env):
    _, ollama = web_env
    chat_id = await new_chat(client)
    events = await turn(client, chat_id, "/nonsense")
    assert "Unknown command" in first(events, "warn")["text"]
    assert ollama.calls == []


async def test_clear_empties_the_conversation(client, web_env):
    _, ollama = web_env
    ollama.replies = [{"content": "noted"}]
    chat_id = await new_chat(client)
    await turn(client, chat_id, "remember this")
    session = client.app.state.manager.get(chat_id)
    assert session.agent.messages

    await turn(client, chat_id, "/clear")
    assert session.agent.messages == []


async def test_exit_says_so_instead_of_stopping_the_server(client):
    chat_id = await new_chat(client)
    events = await turn(client, chat_id, "/exit")
    assert "Nothing to exit" in first(events, "notice")["text"]
    assert client.app.state.manager.get(chat_id) is not None


# --- tools and permissions ------------------------------------------------

WRITE_CALL = {
    "content": "Writing it now.",
    "tool_calls": [
        {
            "function": {
                "name": "write_file",
                "arguments": {"path": "hello.txt", "content": "hi\n"},
            }
        }
    ],
}


async def test_a_write_asks_first_then_runs(client, web_env):
    workspace, ollama = web_env
    ollama.replies = [WRITE_CALL, {"content": "Done."}]
    chat_id = await new_chat(client)

    await client.post(f"/api/chats/{chat_id}/message", json={"text": "write hello.txt"})
    session = client.app.state.manager.get(chat_id)

    # The turn parks on the permission prompt until the browser answers.
    for _ in range(200):
        if session.web_ui.pending_permissions:
            break
        await asyncio.sleep(0.02)
    request_id = next(iter(session.web_ui.pending_permissions))
    assert not (workspace / "hello.txt").exists()

    answered = await client.post(
        f"/api/chats/{chat_id}/permission", json={"id": request_id, "answer": "once"}
    )
    assert answered.status_code == 200
    await asyncio.wait_for(asyncio.shield(session._turn_task), timeout=20)

    events = (await client.get(f"/api/chats/{chat_id}")).json()["events"]
    prompt = first(events, "permission")
    assert prompt["tool"] == "write_file"
    assert prompt["detail"].startswith("---")            # the diff travels too
    assert first(events, "permission_resolved")["answer"] == "once"

    result = first(events, "tool_result")
    assert result["ok"] is True and result["id"] == first(events, "tool_start")["id"]
    assert first(events, "diff")["id"] == result["id"]   # the diff lands on its card
    assert (workspace / "hello.txt").read_text() == "hi\n"


async def test_declining_stops_the_tool(client, web_env):
    workspace, ollama = web_env
    ollama.replies = [WRITE_CALL, {"content": "Understood — I left it alone."}]
    chat_id = await new_chat(client)

    await client.post(f"/api/chats/{chat_id}/message", json={"text": "write hello.txt"})
    session = client.app.state.manager.get(chat_id)
    for _ in range(200):
        if session.web_ui.pending_permissions:
            break
        await asyncio.sleep(0.02)
    request_id = next(iter(session.web_ui.pending_permissions))
    await client.post(f"/api/chats/{chat_id}/permission", json={"id": request_id, "answer": "no"})
    await asyncio.wait_for(asyncio.shield(session._turn_task), timeout=20)

    assert not (workspace / "hello.txt").exists()
    events = (await client.get(f"/api/chats/{chat_id}")).json()["events"]
    assert first(events, "tool_result")["ok"] is False


async def test_plan_mode_refuses_without_asking(client, web_env):
    workspace, ollama = web_env
    ollama.replies = [WRITE_CALL, {"content": "Here is what I would have written."}]
    chat_id = await new_chat(client)
    await turn(client, chat_id, "/mode plan")

    events = await turn(client, chat_id, "write hello.txt")
    assert first(events, "permission") is None
    assert not (workspace / "hello.txt").exists()
    assert first(events, "tool_result")["ok"] is False


async def test_answering_a_stale_prompt_is_a_conflict(client):
    chat_id = await new_chat(client)
    stale = await client.post(
        f"/api/chats/{chat_id}/permission", json={"id": "perm-99", "answer": "once"}
    )
    assert stale.status_code == 409


async def test_a_bad_answer_is_rejected(client):
    chat_id = await new_chat(client)
    bad = await client.post(
        f"/api/chats/{chat_id}/permission", json={"id": "perm-1", "answer": "maybe"}
    )
    assert bad.status_code == 400


# --- ask_user_question ------------------------------------------------------

ASK_CALL = {
    "content": "Let me check with you first.",
    "tool_calls": [
        {
            "function": {
                "name": "ask_user_question",
                "arguments": {
                    "question": "Which database do you want?",
                    "options": [{"label": "Postgres", "description": "already used elsewhere"}],
                },
            }
        }
    ],
}


async def test_ask_user_question_flow(client, web_env):
    _workspace, ollama = web_env
    ollama.replies = [ASK_CALL, {"content": "Using Postgres, as you said."}]
    chat_id = await new_chat(client)

    await client.post(f"/api/chats/{chat_id}/message", json={"text": "set up a database"})
    session = client.app.state.manager.get(chat_id)

    # The turn parks on the question until the browser answers — the turn task
    # itself is still running, unlike a completed reply.
    for _ in range(200):
        if session.web_ui.pending_questions:
            break
        await asyncio.sleep(0.02)
    request_id = next(iter(session.web_ui.pending_questions))
    assert not session._turn_task.done()

    answered = await client.post(
        f"/api/chats/{chat_id}/question", json={"id": request_id, "answer": "Postgres"}
    )
    assert answered.status_code == 200
    await asyncio.wait_for(asyncio.shield(session._turn_task), timeout=20)

    events = (await client.get(f"/api/chats/{chat_id}")).json()["events"]
    asked = first(events, "question")
    assert asked["question"] == "Which database do you want?"
    assert asked["options"] == [{"label": "Postgres", "description": "already used elsewhere"}]
    assert first(events, "question_resolved")["answer"] == "Postgres"

    result = first(events, "tool_result")
    assert result["ok"] is True and result["id"] == first(events, "tool_start")["id"]
    # The same turn continued past the question to the model's next reply.
    assert "Postgres" in ollama.calls[-1]["messages"][-1]["content"]


async def test_answering_a_stale_question_is_a_conflict(client):
    chat_id = await new_chat(client)
    stale = await client.post(
        f"/api/chats/{chat_id}/question", json={"id": "question-99", "answer": "Postgres"}
    )
    assert stale.status_code == 409


async def test_an_empty_question_answer_is_rejected(client):
    chat_id = await new_chat(client)
    bad = await client.post(
        f"/api/chats/{chat_id}/question", json={"id": "question-1", "answer": "   "}
    )
    assert bad.status_code == 400


# --- interrupting ---------------------------------------------------------

async def test_interrupt_cancels_the_turn(client, web_env):
    _, ollama = web_env

    async def slow_chat(**kwargs):
        await asyncio.sleep(30)
        yield {}                       # an async generator, like the real one

    ollama.chat_stream = slow_chat
    chat_id = await new_chat(client)
    await client.post(f"/api/chats/{chat_id}/message", json={"text": "take your time"})
    session = client.app.state.manager.get(chat_id)
    for _ in range(200):
        if session.busy:
            break
        await asyncio.sleep(0.02)

    assert (await client.post(f"/api/chats/{chat_id}/interrupt")).json()["interrupted"] is True
    await asyncio.wait_for(asyncio.shield(session._turn_task), timeout=10)

    events = (await client.get(f"/api/chats/{chat_id}")).json()["events"]
    assert any("Interrupted" in event.get("text", "") for event in events if event["type"] == "warn")
    assert session.busy is False


# --- streaming and persistence -------------------------------------------

async def test_sse_streams_a_live_turn(live_server, web_env):
    """A browser subscribing mid-flight sees the backlog, then live tokens."""
    base, app = live_server
    _, ollama = web_env
    ollama.replies = [{"content": "streamed to the browser"}]

    async with httpx.AsyncClient(base_url=base, timeout=20) as http:
        chat_id = (await http.post("/api/chats", json={"title": ""})).json()["id"]
        await http.post(f"/api/chats/{chat_id}/message", json={"text": "hi"})

        frames: list[dict] = []
        async with http.stream("GET", f"/api/chats/{chat_id}/events?since=0") as res:
            assert res.status_code == 200
            assert res.headers["content-type"].startswith("text/event-stream")
            async for line in res.aiter_lines():
                if line.startswith("data:"):
                    frames.append(json.loads(line[5:]))
                if any(frame["type"] == "assistant_end" for frame in frames):
                    break

    kinds = [frame["type"] for frame in frames]
    assert kinds[0] == "user"
    assert "token" in kinds
    assert [frame["seq"] for frame in frames] == sorted(frame["seq"] for frame in frames)
    assert next(f for f in frames if f["type"] == "assistant_end")["text"] == (
        "streamed to the browser"
    )

    session = app.state.manager.get(chat_id)
    await asyncio.wait_for(asyncio.shield(session._turn_task), timeout=20)


async def test_sse_resumes_from_a_sequence_number(live_server, web_env):
    base, _ = live_server
    async with httpx.AsyncClient(base_url=base, timeout=20) as http:
        chat_id = (await http.post("/api/chats", json={"title": ""})).json()["id"]
        await http.post(f"/api/chats/{chat_id}/message", json={"text": "/mode"})
        await asyncio.sleep(0.4)

        everything = (await http.get(f"/api/chats/{chat_id}")).json()["events"]
        assert len(everything) > 2

        resumed: list[dict] = []
        async with http.stream("GET", f"/api/chats/{chat_id}/events?since=2") as res:
            async for line in res.aiter_lines():
                if line.startswith("data:"):
                    resumed.append(json.loads(line[5:]))
                if len(resumed) >= len(everything) - 2:
                    break
    assert resumed[0]["seq"] == 3      # nothing already seen is sent again


async def test_a_chat_reloads_from_disk(client, web_env):
    workspace, ollama = web_env
    ollama.replies = [{"content": "persisted"}]
    chat_id = await new_chat(client)
    await turn(client, chat_id, "remember me")

    stored = Path(workspace) / ".helena" / "web" / "chats" / f"{chat_id}.json"
    assert stored.is_file()

    manager = client.app.state.manager
    manager.chats.clear()                       # as if the server restarted
    reloaded = manager.get(chat_id)
    assert reloaded is not None
    assert reloaded.title == "remember me"
    assert any(event.type == "assistant_end" for event in reloaded.hub.log)
    assert reloaded.agent.messages                # the model keeps its context


async def test_an_attachment_becomes_the_terminal_command(client, web_env):
    """A file attached in the browser is `/read <path>` under the covers."""
    workspace, ollama = web_env
    ollama.replies = [{"content": "It defines the parser."}]
    target = workspace / "parser.py"
    target.write_text("def parse():\n    return 1\n")

    chat_id = await new_chat(client)
    res = await client.post(
        f"/api/chats/{chat_id}/message",
        json={"text": "what does this do?", "files": [str(target)]},
    )
    assert res.status_code == 202
    session = client.app.state.manager.get(chat_id)
    await asyncio.wait_for(asyncio.shield(session._turn_task), timeout=20)

    events = (await client.get(f"/api/chats/{chat_id}")).json()["events"]
    said = first(events, "user")
    # The bubble shows what the user typed, not the command it expanded into.
    assert said["text"] == "what does this do?"
    assert said["files"] == ["parser.py"]
    assert any("parser.py" in str(message.get("content", "")) for message in session.agent.messages)
    assert first(events, "assistant_end")["text"] == "It defines the parser."


async def test_uploads_land_in_the_workspace(client, web_env):
    workspace, _ = web_env
    chat_id = await new_chat(client)
    res = await client.post(
        f"/api/chats/{chat_id}/upload",
        files={"file": ("shot.png", b"\x89PNG fake", "image/png")},
    )
    assert res.status_code == 200
    path = Path(res.json()["path"])
    assert path.is_file() and path.read_bytes() == b"\x89PNG fake"
    assert str(workspace) in str(path)
