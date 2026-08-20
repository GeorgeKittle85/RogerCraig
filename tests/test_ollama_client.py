"""OllamaClient tests, against a mocked Ollama HTTP layer.

These exercise the real `OllamaClient` (not the `FakeOllama` stand-in used
elsewhere), because the retry behaviour under test lives inside the client
itself, one layer below where `FakeOllama` intercepts.
"""

from __future__ import annotations

import json

import httpx
import pytest

from helena_server.ollama import CHAT_TEMPLATE_RETRY_NUDGE, OllamaClient, OllamaError

# The exact (double-encoded) body Ollama sends for the known Qwen3-family
# chat-template bug: a hard `raise_exception('No user query found in
# messages.')` in the model's own Jinja template.
TEMPLATE_BUG_BODY = json.dumps({
    "error": json.dumps({
        "error": {
            "code": 500,
            "message": (
                "\n------------\nWhile executing CallExpression at line 79, "
                "column 24 in source:\n...lti_step_tool %}\n    {{- "
                "raise_exception('No user query found in messages.') }}\n..."
                "\nError: Jinja Exception: No user query found in messages."
            ),
            "type": "server_error",
        }
    }),
})


def make_client(handler) -> OllamaClient:
    return OllamaClient("http://fake-ollama", transport=httpx.MockTransport(handler))


async def test_chat_retries_once_on_the_known_template_bug():
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body)
        if len(calls) == 1:
            return httpx.Response(500, text=TEMPLATE_BUG_BODY)
        return httpx.Response(200, json={
            "model": "qwen3:8b",
            "message": {"role": "assistant", "content": "back on track"},
            "done": True,
        })

    client = make_client(handler)
    try:
        result = await client.chat(
            model="qwen3:8b",
            messages=[{"role": "user", "content": "hi"}],
        )
    finally:
        await client.aclose()

    assert result["message"]["content"] == "back on track"
    assert len(calls) == 2
    # The retry anchors the template's backward scan with one more plain
    # user turn, without disturbing what was actually sent the first time.
    assert calls[0]["messages"] == [{"role": "user", "content": "hi"}]
    assert calls[1]["messages"] == [{"role": "user", "content": "hi"}, CHAT_TEMPLATE_RETRY_NUDGE]


async def test_chat_does_not_retry_unrelated_server_errors():
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content))
        return httpx.Response(500, text='{"error": "model requires more system memory"}')

    client = make_client(handler)
    try:
        with pytest.raises(OllamaError, match="model requires more system memory"):
            await client.chat(model="qwen3:8b", messages=[{"role": "user", "content": "hi"}])
    finally:
        await client.aclose()

    assert len(calls) == 1


async def test_chat_does_not_retry_client_errors():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text=TEMPLATE_BUG_BODY)

    client = make_client(handler)
    try:
        with pytest.raises(OllamaError):
            await client.chat(model="qwen3:8b", messages=[{"role": "user", "content": "hi"}])
    finally:
        await client.aclose()


async def test_chat_stream_retries_once_on_the_known_template_bug():
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body)
        if len(calls) == 1:
            return httpx.Response(500, text=TEMPLATE_BUG_BODY)
        lines = [
            json.dumps({"model": "qwen3:8b", "message": {"role": "assistant", "content": "back "}, "done": False}),
            json.dumps({"model": "qwen3:8b", "message": {"role": "assistant", "content": "on track"}, "done": False}),
            json.dumps({"model": "qwen3:8b", "message": {"role": "assistant", "content": ""}, "done": True}),
        ]
        return httpx.Response(200, text="\n".join(lines))

    client = make_client(handler)
    try:
        chunks = [
            chunk
            async for chunk in client.chat_stream(
                model="qwen3:8b", messages=[{"role": "user", "content": "hi"}]
            )
        ]
    finally:
        await client.aclose()

    text = "".join(c.get("message", {}).get("content", "") for c in chunks)
    assert text == "back on track"
    assert len(calls) == 2
    assert calls[1]["messages"][-1] == CHAT_TEMPLATE_RETRY_NUDGE


async def test_chat_stream_does_not_retry_once_tokens_have_started(monkeypatch):
    """A failure after tokens already streamed must propagate, not retry.

    Retrying at that point would replay the whole answer and duplicate
    output onto the client — the template already rendered fine, so
    whatever broke isn't the bug this retry exists for.
    """
    client = OllamaClient("http://fake-ollama")
    calls = 0

    async def fake_stream_ndjson(path, payload):
        nonlocal calls
        calls += 1
        yield {"message": {"role": "assistant", "content": "partial"}, "done": False}
        raise OllamaError(TEMPLATE_BUG_BODY, status_code=502)

    monkeypatch.setattr(client, "_stream_ndjson", fake_stream_ndjson)

    chunks = []
    with pytest.raises(OllamaError):
        async for chunk in client.chat_stream(model="qwen3:8b", messages=[{"role": "user", "content": "hi"}]):
            chunks.append(chunk)

    await client.aclose()
    assert calls == 1
    assert len(chunks) == 1
