"""H.E.L.E.N.A web harness — the terminal agent, in a browser.

`helena_web` is a thin presentation layer over `helena_harness`: the same
`Agent`, the same tools, the same `PermissionEngine`, and literally the same
slash commands, because a chat session subclasses the terminal `Repl` and
routes every line through `Repl.handle_line`. What changes is only where the
output goes — a `WebUI` turns everything the harness prints into structured
events, which the React client renders.
"""

__version__ = "1.0.0"

DEFAULT_PORT = 7995
DEFAULT_HOST = "127.0.0.1"
