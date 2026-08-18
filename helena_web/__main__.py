"""`helena-web` entry point — the chat UI on http://127.0.0.1:7995."""

from __future__ import annotations

import argparse
import os
import sys
import webbrowser
from pathlib import Path

import uvicorn

from . import DEFAULT_HOST, DEFAULT_PORT, __version__
from .app import UI_DIST, create_app
from helena_harness.config import VALID_MODES


def _default_port() -> int:
    raw = os.environ.get("HELENA_WEB_PORT", "")
    return int(raw) if raw.isdigit() else DEFAULT_PORT


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="helena-web",
        description="H.E.L.E.N.A in a browser — the same agent, tools and commands "
                    "as the terminal harness.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="Examples:\n"
               "  helena-web                          http://127.0.0.1:7995\n"
               "  helena-web --open                   ...and open a browser\n"
               "  helena-web -C ~/code/api --mode auto\n",
    )
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"Bind address (default {DEFAULT_HOST}).")
    parser.add_argument("--port", type=int, default=_default_port(),
                        help=f"Port (default {DEFAULT_PORT}, or HELENA_WEB_PORT).")
    parser.add_argument("-C", "--workspace", default=None,
                        help="Directory the agent works in (default: the current one).")
    parser.add_argument("--model", default=None, help="Chat model, e.g. qwen2.5:7b-instruct.")
    parser.add_argument("--vision-model", default=None, help="Model used for images, e.g. llava.")
    parser.add_argument("--server", default=None, help="HELENA model server URL.")
    parser.add_argument("--mode", choices=VALID_MODES, default=None,
                        help="Permission mode new chats start in (default: ask).")
    parser.add_argument("--allow", action="append", default=[], metavar="RULE",
                        help="Pre-approve a rule, e.g. --allow 'run_command(pytest:*)'. Repeatable.")
    parser.add_argument("--deny", action="append", default=[], metavar="RULE",
                        help="Block a rule outright. Repeatable.")
    parser.add_argument("--allow-outside-workspace", action="store_true",
                        help="Let file tools reach outside the workspace directory.")
    parser.add_argument("--no-server-autostart", action="store_true",
                        help="Fail instead of starting a local model server.")
    parser.add_argument("--open", action="store_true", help="Open the UI in a browser once it is up.")
    parser.add_argument("--log-level", default="warning",
                        choices=["critical", "error", "warning", "info", "debug"])
    parser.add_argument("--version", action="version", version=f"helena-web {__version__}")
    return parser


def main() -> None:
    args = build_parser().parse_args()
    workspace = Path(args.workspace).expanduser() if args.workspace else Path.cwd()
    if not workspace.is_dir():
        print(f"helena-web: not a directory: {workspace}", file=sys.stderr)
        raise SystemExit(2)

    overrides = {
        "model": args.model,
        "vision_model": args.vision_model,
        "server_url": args.server,
        "mode": args.mode,
        "allow": args.allow or None,
        "deny": args.deny or None,
        "allow_outside_workspace": True if args.allow_outside_workspace else None,
        "auto_start_server": False if args.no_server_autostart else None,
    }

    if not UI_DIST.is_dir():
        print("helena-web: the React client is not built yet.\n"
              "            cd helena_web/ui && npm install && npm run build",
              file=sys.stderr)

    url = f"http://{'127.0.0.1' if args.host in ('0.0.0.0', '::') else args.host}:{args.port}"
    print(f"H.E.L.E.N.A chat UI  →  {url}")
    print(f"workspace: {workspace.resolve()}")
    if args.open:
        webbrowser.open(url)

    app = create_app(workspace=workspace, overrides=overrides)
    uvicorn.run(app, host=args.host, port=args.port, log_level=args.log_level)


if __name__ == "__main__":
    main()
