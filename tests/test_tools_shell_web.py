"""Command execution and web tools."""

from __future__ import annotations

import asyncio

import pytest

from helena_harness.tools.base import ToolError
from helena_harness.tools.shell import CheckJobTool, RunCommandTool
from helena_harness.tools.web import (
    FetchUrlTool,
    clean_ddg_url,
    html_to_text,
    parse_ddg_html,
)

DDG_HTML = """
<div class="results">
  <div class="result results_links">
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.python.org%2F3%2Fwhatsnew%2F3.13.html&amp;rut=abc">
      What&#39;s New In Python 3.13
    </a>
    <a class="result__snippet">Python 3.13 introduces a new interactive interpreter.</a>
  </div>
  <div class="result results_links">
    <a rel="nofollow" class="result__a" href="https://peps.python.org/pep-0719/">PEP 719</a>
    <a class="result__snippet">Python 3.13 release schedule.</a>
  </div>
</div>
"""

LITE_HTML = """
<table>
  <tr><td><a rel="nofollow" href="https://example.com/a" class='result-link'>Example A</a></td></tr>
  <tr><td class='result-snippet'>Snippet for A</td></tr>
</table>
"""


# --- run_command ------------------------------------------------------------


async def test_run_command_captures_stdout_and_exit_code(tool_ctx):
    result = await RunCommandTool().run({"command": "echo hello"}, tool_ctx)
    assert result.ok
    assert "hello" in result.content
    assert result.meta["exit_code"] == 0


async def test_run_command_reports_failure_without_raising(tool_ctx):
    result = await RunCommandTool().run({"command": "exit 3"}, tool_ctx)
    assert result.ok is False
    assert result.meta["exit_code"] == 3
    assert "exit 3" in result.content


async def test_run_command_captures_stderr(tool_ctx):
    result = await RunCommandTool().run({"command": "echo oops >&2"}, tool_ctx)
    assert "[stderr]" in result.content and "oops" in result.content


async def test_run_command_runs_in_the_workspace(tool_ctx, workspace):
    (workspace / "marker.txt").write_text("x")
    result = await RunCommandTool().run({"command": "ls"}, tool_ctx)
    assert "marker.txt" in result.content


async def test_run_command_times_out_and_says_what_to_do(tool_ctx):
    result = await RunCommandTool().run({"command": "sleep 5", "timeout": 1}, tool_ctx)
    assert result.ok is False
    assert "timed out" in result.content
    assert "background: true" in result.content


async def test_background_job_lifecycle(tool_ctx):
    started = await RunCommandTool().run(
        {"command": "echo working; sleep 30", "background": True}, tool_ctx
    )
    assert started.ok
    job_id = started.meta["job_id"]
    await asyncio.sleep(0.4)

    checked = await CheckJobTool().run({"job_id": job_id}, tool_ctx)
    assert "still running" in checked.content
    assert "working" in checked.content

    killed = await CheckJobTool().run({"job_id": job_id, "kill": True}, tool_ctx)
    assert killed.ok and "Stopped" in killed.content


async def test_check_job_lists_and_rejects_unknown_ids(tool_ctx):
    empty = await CheckJobTool().run({}, tool_ctx)
    assert "No background jobs" in empty.content

    await RunCommandTool().run({"command": "sleep 10", "background": True}, tool_ctx)
    with pytest.raises(ToolError, match="No job"):
        await CheckJobTool().run({"job_id": "zzzzzz"}, tool_ctx)
    for job in tool_ctx.jobs.values():
        job.proc.kill()


def test_run_command_preview_includes_description():
    preview = RunCommandTool().preview({"command": "pytest -q", "description": "run the tests"})
    assert "pytest -q" in preview and "run the tests" in preview


# --- DuckDuckGo parsing -----------------------------------------------------


def test_parse_ddg_html_extracts_results_and_unwraps_redirects():
    hits = parse_ddg_html(DDG_HTML)
    assert len(hits) == 2
    assert hits[0].url == "https://docs.python.org/3/whatsnew/3.13.html"
    assert hits[0].title == "What's New In Python 3.13"
    assert "interactive interpreter" in hits[0].snippet
    assert hits[1].url == "https://peps.python.org/pep-0719/"


def test_parse_ddg_html_falls_back_to_the_lite_layout():
    hits = parse_ddg_html(LITE_HTML)
    assert len(hits) == 1
    assert hits[0].url == "https://example.com/a"
    assert hits[0].snippet == "Snippet for A"


def test_parse_ddg_html_on_junk_returns_nothing():
    assert parse_ddg_html("<html><body>no results</body></html>") == []


def test_clean_ddg_url_passes_through_direct_links():
    assert clean_ddg_url("https://example.com/x") == "https://example.com/x"
    assert clean_ddg_url("//duckduckgo.com/l/?uddg=https%3A%2F%2Fa.io%2Fb") == "https://a.io/b"


def test_html_to_text_drops_scripts_and_keeps_prose():
    text = html_to_text(
        "<html><head><style>p{color:red}</style></head>"
        "<body><h1>Title</h1><script>alert(1)</script><p>Hello &amp; welcome.</p>"
        "<ul><li>one</li><li>two</li></ul></body></html>"
    )
    assert "alert(1)" not in text and "color:red" not in text
    assert "Hello & welcome." in text
    assert "• one" in text


# --- fetch_url --------------------------------------------------------------


async def test_fetch_url_converts_html(tool_ctx, monkeypatch):
    import httpx

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "text/html"},
            text="<html><head><title>Doc</title></head><body><p>Body text here.</p></body></html>",
        )

    _patch_httpx(monkeypatch, handler)
    result = await FetchUrlTool().run({"url": "example.com/doc"}, tool_ctx)
    assert result.ok
    assert result.content.startswith("Doc\nhttps://example.com/doc")
    assert "Body text here." in result.content


async def test_fetch_url_reports_http_errors(tool_ctx, monkeypatch):
    import httpx

    _patch_httpx(monkeypatch, lambda request: httpx.Response(404, text="nope"))
    result = await FetchUrlTool().run({"url": "https://example.com/missing"}, tool_ctx)
    assert result.ok is False and "HTTP 404" in result.content


async def test_fetch_url_refuses_binary(tool_ctx, monkeypatch):
    import httpx

    _patch_httpx(
        monkeypatch,
        lambda request: httpx.Response(200, headers={"content-type": "image/png"}, content=b"\x89PNG"),
    )
    result = await FetchUrlTool().run({"url": "https://example.com/a.png"}, tool_ctx)
    assert result.ok is False and "not text" in result.content


def _patch_httpx(monkeypatch, handler):
    """Route every httpx.AsyncClient created by a tool through a mock transport."""
    import httpx

    original = httpx.AsyncClient

    class MockClient(original):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(handler)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", MockClient)
