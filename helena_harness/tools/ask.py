"""The ask_user_question tool — a mid-task question that doesn't end the turn."""

from __future__ import annotations

from typing import Any

from ..permissions import Action
from .base import Tool, ToolContext, ToolError, ToolResult

MAX_OPTIONS = 6


class AskUserQuestionTool(Tool):
    name = "ask_user_question"
    description = """
    Ask the user a question and get their answer back as this tool's result —
    unlike ending your turn on a question, the conversation does not stop:
    once you have the answer you keep working in the same response.

    Use it only when you are genuinely blocked on a decision that is the
    user's to make: which of several real approaches to take, a choice with
    no safe default, or confirming something destructive or hard to reverse.
    Do not use it for ambiguity you can resolve yourself — pick the sensible
    default and say what you assumed — and never use it just to check in
    ("should I continue?"); if the next step is obvious, take it.

    Give 2-6 concrete `options` when the choice is between known
    alternatives — lead with the one you would recommend and say why in its
    description. Omit `options` for a genuinely open-ended question (a name,
    a value, free text); the user can always answer with something outside
    the options you offered.
    """
    action = Action.NONE
    read_only = True
    parameters = {
        "type": "object",
        "properties": {
            "question": {
                "type": "string",
                "description": "The question, phrased clearly enough to answer without more context.",
            },
            "options": {
                "type": "array",
                "description": "Optional. 2-6 concrete choices the user can pick with one keystroke. "
                               "Omit for an open-ended question.",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {"type": "string", "description": "Short choice, shown to the user."},
                        "description": {"type": "string", "description": "Why this option, or what it means."},
                    },
                    "required": ["label"],
                },
                "maxItems": MAX_OPTIONS,
            },
        },
        "required": ["question"],
    }

    def preview(self, args: dict[str, Any]) -> str:
        question = (args.get("question") or "?").strip()
        return question if len(question) <= 100 else question[:97] + "…"

    async def run(self, args: dict[str, Any], ctx: ToolContext) -> ToolResult:
        question = (args.get("question") or "").strip()
        if not question:
            raise ToolError("`question` is required.")

        options: list[dict[str, str]] = []
        for opt in (args.get("options") or [])[:MAX_OPTIONS]:
            if isinstance(opt, dict) and str(opt.get("label") or "").strip():
                options.append({
                    "label": str(opt["label"]).strip(),
                    "description": str(opt.get("description") or "").strip(),
                })
            elif isinstance(opt, str) and opt.strip():
                options.append({"label": opt.strip(), "description": ""})

        answer = await ctx.ui.ask_user_question(question, options)
        if answer is None:
            return ToolResult(
                ok=False,
                content=(
                    "No one answered — nobody is at the keyboard right now. Make the most "
                    "reasonable assumption, say clearly what you assumed, and keep going; "
                    "do not ask again for the same thing."
                ),
                display="no answer",
            )
        return ToolResult(ok=True, content=f"The user answered: {answer}", display=answer)
