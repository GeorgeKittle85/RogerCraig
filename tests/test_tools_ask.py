"""ask_user_question: the terminal prompt primitive and the tool that drives it."""

from __future__ import annotations

from helena_harness.tools.ask import AskUserQuestionTool
from helena_harness.ui import UI


class FakePromptSession:
    """Stands in for prompt_toolkit's PromptSession.prompt_async."""

    def __init__(self, answer: str | None = None, raises: Exception | None = None) -> None:
        self.answer = answer
        self.raises = raises
        self.prompts: list[str] = []

    async def prompt_async(self, message: str) -> str:
        self.prompts.append(message)
        if self.raises is not None:
            raise self.raises
        return self.answer or ""


def make_ui(answer: str | None = None, raises: Exception | None = None) -> UI:
    ui = UI(quiet=False, no_color=True)
    ui.prompt_session = FakePromptSession(answer, raises)
    return ui


# --- UI.ask_user_question ---------------------------------------------------


async def test_ask_user_question_returns_typed_free_text():
    ui = make_ui(answer="use FastAPI")
    result = await ui.ask_user_question("Which framework?", [])
    assert result == "use FastAPI"


async def test_ask_user_question_resolves_a_numbered_option():
    ui = make_ui(answer="2")
    options = [{"label": "FastAPI", "description": ""}, {"label": "Flask", "description": ""}]
    result = await ui.ask_user_question("Which framework?", options)
    assert result == "Flask"


async def test_ask_user_question_free_text_overrides_options():
    ui = make_ui(answer="something else entirely")
    options = [{"label": "FastAPI", "description": ""}]
    result = await ui.ask_user_question("Which framework?", options)
    assert result == "something else entirely"


async def test_ask_user_question_blank_answer_is_no_answer():
    ui = make_ui(answer="   ")
    assert await ui.ask_user_question("Which framework?", []) is None


async def test_ask_user_question_eof_is_no_answer():
    ui = make_ui(raises=EOFError())
    assert await ui.ask_user_question("Which framework?", []) is None


async def test_ask_user_question_quiet_ui_never_prompts():
    ui = UI(quiet=True)
    ui.prompt_session = FakePromptSession(answer="should not be seen")
    assert await ui.ask_user_question("Which framework?", []) is None


async def test_ask_user_question_no_prompt_session_is_no_answer():
    ui = UI(quiet=False)
    assert ui.prompt_session is None
    assert await ui.ask_user_question("Which framework?", []) is None


# --- AskUserQuestionTool -----------------------------------------------------


async def test_tool_relays_the_users_answer(tool_ctx):
    async def fake_ask(question: str, options: list[dict[str, str]]) -> str:
        assert question == "Which framework?"
        assert options == [{"label": "FastAPI", "description": "already used elsewhere"}]
        return "FastAPI"

    tool_ctx.ui.ask_user_question = fake_ask
    result = await AskUserQuestionTool().run(
        {
            "question": "Which framework?",
            "options": [{"label": "FastAPI", "description": "already used elsewhere"}],
        },
        tool_ctx,
    )
    assert result.ok
    assert result.content == "The user answered: FastAPI"
    assert result.display == "FastAPI"


async def test_tool_reports_no_answer_gracefully(tool_ctx):
    # tool_ctx's SilentUI is quiet, so ask_user_question naturally returns None —
    # exactly the "nobody's at the keyboard" path a non-interactive run hits.
    result = await AskUserQuestionTool().run({"question": "Which framework?"}, tool_ctx)
    assert result.ok is False
    assert "reasonable assumption" in result.content
    assert result.display == "no answer"


async def test_tool_requires_a_question(tool_ctx):
    from helena_harness.tools.base import ToolError
    import pytest

    with pytest.raises(ToolError):
        await AskUserQuestionTool().run({"question": "   "}, tool_ctx)


async def test_tool_accepts_plain_string_options(tool_ctx):
    async def fake_ask(question: str, options: list[dict[str, str]]) -> str:
        assert options == [{"label": "yes", "description": ""}, {"label": "no", "description": ""}]
        return "yes"

    tool_ctx.ui.ask_user_question = fake_ask
    result = await AskUserQuestionTool().run(
        {"question": "Continue?", "options": ["yes", "no"]}, tool_ctx
    )
    assert result.ok
    assert result.display == "yes"
