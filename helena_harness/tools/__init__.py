"""Tool registry.

`build_tools(ctx)` returns the full set for the main agent. Subagents get a
filtered view of the same list, so there is exactly one definition of what any
tool does and what permission it needs.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .agent import SpawnAgentTool
from .ask import AskUserQuestionTool
from .base import Tool, ToolContext, ToolError, ToolResult
from .extras import RememberTool, RemindTool, StockTool, TimeTool, WeatherTool
from .files import (
    DeletePathTool,
    EditFileTool,
    FindFilesTool,
    ListDirTool,
    ReadFileTool,
    SearchTextTool,
    TodoWriteTool,
    WriteFileTool,
)
from .shell import CheckJobTool, RunCommandTool
from .vision import AnalyzeImageTool
from .web import FetchUrlTool, WebSearchTool

if TYPE_CHECKING:  # pragma: no cover
    pass

# Ordered roughly by how often they get used, which is also the order the model
# sees them in — cheap nudge toward reading before writing.
TOOL_CLASSES: list[type[Tool]] = [
    ReadFileTool,
    ListDirTool,
    FindFilesTool,
    SearchTextTool,
    EditFileTool,
    WriteFileTool,
    DeletePathTool,
    RunCommandTool,
    CheckJobTool,
    WebSearchTool,
    FetchUrlTool,
    AnalyzeImageTool,
    TodoWriteTool,
    SpawnAgentTool,
    AskUserQuestionTool,
    WeatherTool,
    StockTool,
    RemindTool,
    RememberTool,
    TimeTool,
]


def build_tools(ctx: "ToolContext | None" = None) -> list[Tool]:
    """Instantiate every tool. `ctx` is accepted for symmetry and future gating."""
    return [cls() for cls in TOOL_CLASSES]


def tool_names() -> list[str]:
    return [cls.name for cls in TOOL_CLASSES]


__all__ = [
    "Tool",
    "ToolContext",
    "ToolError",
    "ToolResult",
    "build_tools",
    "tool_names",
    "TOOL_CLASSES",
]
