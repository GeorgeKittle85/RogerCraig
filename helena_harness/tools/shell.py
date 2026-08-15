"""Command execution: foreground with a timeout, plus background jobs."""

from __future__ import annotations

import asyncio
import os
import signal
import time
import uuid
from pathlib import Path
from typing import Any

from ..permissions import Action, classify_command
from .base import BackgroundJob, Tool, ToolContext, ToolError, ToolResult, resolve_path, truncate

MAX_OUTPUT = 30_000


def _describe(command: str, limit: int = 90) -> str:
    one_line = " ".join(command.split())
    return one_line if len(one_line) <= limit else one_line[: limit - 1] + "…"


class RunCommandTool(Tool):
    name = "run_command"
    description = """
    Run a shell command in the workspace and get back its stdout, stderr, and exit code.
    This is real execution — the command actually runs on this machine.

    Use it for builds, tests, linters, git, package managers, and anything else a
    terminal can do. Prefer the dedicated tools where they exist: read_file over cat,
    search_text over grep, find_files over find, edit_file over sed -i.
    Long-running processes (dev servers, watchers) must set background: true, or
    they will hit the timeout and be killed.
    """
    action = Action.EXECUTE
    read_only = False
    parameters = {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "The command line to run."},
            "timeout": {"type": "integer", "description": "Seconds before the command is killed. Default 120, max 900."},
            "cwd": {"type": "string", "description": "Directory to run in. Defaults to the workspace root."},
            "background": {"type": "boolean", "description": "Start it detached and return immediately; check on it with check_job."},
            "description": {"type": "string", "description": "Short human-readable summary of what this command does and why."},
        },
        "required": ["command"],
    }

    def permission_key(self, args: dict[str, Any]) -> str:
        return (args.get("command") or "").strip()

    def preview(self, args: dict[str, Any]) -> str:
        note = args.get("description")
        bg = " (background)" if args.get("background") else ""
        cmd = _describe(args.get("command", "?"))
        return f"{cmd}{bg}" + (f"  — {note}" if note else "")

    def detail(self, args: dict[str, Any], ctx: ToolContext) -> str:
        command = args.get("command", "")
        _, risky = classify_command(command)
        where = args.get("cwd") or "."
        lines = [f"$ {command}", f"cwd: {where}"]
        if risky:
            lines.append(f"note: this {risky}")
        return "\n".join(lines)

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        command = (args.get("command") or "").strip()
        if not command:
            raise ToolError("`command` is required.")
        cwd = resolve_path(ctx, args.get("cwd") or ".", must_exist=True) if args.get("cwd") else ctx.workspace
        if not Path(cwd).is_dir():
            raise ToolError(f"{cwd} is not a directory.")

        if args.get("background"):
            return await self._run_background(command, cwd, ctx)

        timeout = min(900, max(1, int(args.get("timeout") or ctx.config.command_timeout)))
        started = time.monotonic()
        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                cwd=str(cwd),
                start_new_session=True,   # so we can kill the whole process group
                env={**os.environ, "HELENA": "1", "TERM": "dumb", "NO_COLOR": "1"},
            )
        except OSError as exc:
            raise ToolError(f"Could not start the command: {exc}") from exc

        try:
            stdout_b, stderr_b = await asyncio.wait_for(proc.communicate(), timeout=timeout)
        except asyncio.TimeoutError:
            self._kill(proc)
            elapsed = time.monotonic() - started
            return ToolResult(
                ok=False,
                content=(
                    f"Command timed out after {elapsed:.0f}s and was killed:\n$ {command}\n"
                    "If it is meant to keep running (a server, a watcher), call it again with "
                    "background: true. Otherwise raise `timeout`."
                ),
                display=f"timed out after {elapsed:.0f}s",
            )
        except asyncio.CancelledError:
            self._kill(proc)
            raise

        elapsed = time.monotonic() - started
        stdout = stdout_b.decode("utf-8", "replace")
        stderr = stderr_b.decode("utf-8", "replace")
        code = proc.returncode or 0

        parts = []
        if stdout.strip():
            parts.append(stdout.rstrip())
        if stderr.strip():
            parts.append(f"[stderr]\n{stderr.rstrip()}")
        body = "\n".join(parts) or "(no output)"
        body = truncate(body, min(MAX_OUTPUT, ctx.config.max_tool_output_chars), "command output")

        header = f"$ {command}\nexit {code} · {elapsed:.1f}s"
        return ToolResult(
            ok=code == 0,
            content=f"{header}\n{body}",
            display=f"exit {code} · {elapsed:.1f}s",
            meta={"exit_code": code, "elapsed": elapsed, "stdout": stdout, "stderr": stderr},
        )

    async def _run_background(self, command: str, cwd: Path, ctx: ToolContext) -> ToolResult:
        job_id = uuid.uuid4().hex[:6]
        log_dir = ctx.config.project_dir / "logs"
        log_dir.mkdir(parents=True, exist_ok=True)
        log_path = log_dir / f"job-{job_id}.log"
        handle = log_path.open("wb")
        try:
            proc = await asyncio.create_subprocess_shell(
                command,
                stdout=handle,
                stderr=asyncio.subprocess.STDOUT,
                cwd=str(cwd),
                start_new_session=True,
                env={**os.environ, "HELENA": "1"},
            )
        except OSError as exc:
            handle.close()
            raise ToolError(f"Could not start the background command: {exc}") from exc

        ctx.jobs[job_id] = BackgroundJob(
            id=job_id, command=command, proc=proc, stdout_path=log_path, started_at=time.time()
        )
        return ToolResult(
            ok=True,
            content=(
                f"Started job {job_id} in the background (pid {proc.pid}):\n$ {command}\n"
                f"Output is being written to {log_path}. Read it with check_job(job_id=\"{job_id}\")."
            ),
            display=f"job {job_id} started (pid {proc.pid})",
            meta={"job_id": job_id},
        )

    @staticmethod
    def _kill(proc: Any) -> None:
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
        except (ProcessLookupError, PermissionError, OSError):
            try:
                proc.kill()
            except ProcessLookupError:
                pass


class CheckJobTool(Tool):
    name = "check_job"
    description = """
    Check on a background job started by run_command: whether it is still running,
    its exit code if it finished, and its most recent output.
    """
    action = Action.READ
    read_only = True
    parameters = {
        "type": "object",
        "properties": {
            "job_id": {"type": "string", "description": "Omit to list every job."},
            "lines": {"type": "integer", "description": "How many trailing output lines to show. Default 60."},
            "kill": {"type": "boolean", "description": "Stop the job instead of just inspecting it."},
        },
    }

    def preview(self, args: dict[str, Any]) -> str:
        if args.get("kill"):
            return f"Stop background job {args.get('job_id', '?')}"
        return f"Check background job {args.get('job_id') or '(all)'}"

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        if not ctx.jobs:
            return ToolResult(ok=True, content="No background jobs have been started.", display="none")

        job_id = args.get("job_id")
        if not job_id:
            rows = []
            for job in ctx.jobs.values():
                state = "running" if job.proc.returncode is None else f"exited {job.proc.returncode}"
                rows.append(f"{job.id}  {state}  ({time.time() - job.started_at:.0f}s)  $ {_describe(job.command, 60)}")
            return ToolResult(ok=True, content="\n".join(rows), display=f"{len(rows)} job(s)")

        job = ctx.jobs.get(job_id)
        if not job:
            raise ToolError(f"No job {job_id!r}. Known jobs: {', '.join(ctx.jobs) or 'none'}.")

        if args.get("kill"):
            if job.proc.returncode is None:
                RunCommandTool._kill(job.proc)
                await asyncio.sleep(0.2)
            return ToolResult(ok=True, content=f"Stopped job {job_id}.", display=f"job {job_id} stopped")

        lines = max(1, min(500, int(args.get("lines") or 60)))
        try:
            output = job.stdout_path.read_text("utf-8", errors="replace")
        except OSError:
            output = ""
        tail = "\n".join(output.splitlines()[-lines:]) or "(no output yet)"
        state = "still running" if job.proc.returncode is None else f"exited with code {job.proc.returncode}"
        return ToolResult(
            ok=True,
            content=f"Job {job_id} ({state}, {time.time() - job.started_at:.0f}s)\n$ {job.command}\n\n{tail}",
            display=state,
        )
