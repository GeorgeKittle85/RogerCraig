# H.E.L.E.N.A

### Highly Efficient Logic Engine Network Assistant

A local-first agentic harness, in three parts:

1. **`helena_server`** — a FastAPI service that actually runs the models, through
   [Ollama](https://ollama.com). Chat, streaming, tool calling, vision, embeddings,
   and persisted sessions, over a clean HTTP API.
2. **`helena_harness`** — a full terminal agent that talks to that server. It reads
   and edits files, runs commands, searches the web, looks at images, delegates to
   subagents, and asks your permission before it changes anything.
3. **`helena_web`** — the same agent in a browser, on port 7995. A React chat UI
   over a thin FastAPI layer whose sessions *subclass the terminal REPL*, so every
   slash command, permission prompt and tool is the one you already know.

Nothing leaves your machine. No API keys, no per-token cost, no third party — the
only outbound traffic is what you explicitly ask for (a web search, a URL fetch,
weather, market data).

```
┌──────────────────┐
│  React chat UI   │  browser, :7995
└────────┬─────────┘
         │ HTTP + SSE (events: tokens, tool cards, permission prompts)
┌────────┴─────────┐   HTTP/SSE    ┌──────────────────┐   HTTP    ┌────────┐
│  the harness     │ ────────────► │  FastAPI server  │ ────────► │ Ollama │
│  agent · tools   │ ◄──────────── │  helena_server   │ ◄──────── │ models │
│  permissions     │  tokens +     └──────────────────┘           └────────┘
└────────┬─────────┘   tool calls     sessions · vision
         │                            embeddings · pulls
┌────────┴─────────┐
│  terminal agent  │  helena
└──────────────────┘
```

The split matters: the server never executes a tool. It reports what the model
asked for and hands the decision back to the harness, which is where the
permission system lives. Your models can also move to a beefier machine on the
LAN without the harness noticing — point `HELENA_SERVER_URL` at it.

---

## Install

Requires Python 3.10+ and [Ollama](https://ollama.com).

```bash
git clone <this repo> && cd RogerCraig
python3 -m venv .venv && source .venv/bin/activate
pip3 install -e ".[dev]"

# A tool-calling model is required for agentic work:
ollama pull qwen2.5:7b-instruct
# Optional, for images:
ollama pull llava
```

Then either surface:

```bash
helena                      # the terminal agent
helena-web                  # the chat UI at http://127.0.0.1:7995
```

Both start a model server automatically if one isn't already running. To run the
whole stack — Ollama, the model server, and the web UI — as background processes:

```bash
./start.sh                  # ./start.sh --no-web to leave the browser out
./stop.sh
```

`start.sh` builds the React client the first time (and whenever its sources
change), so Node is only needed if you want the browser UI. To run the model
server on its own — shared, remote, or long-lived:

```bash
helena-server               # http://127.0.0.1:8080, docs at /docs
```

## Using it

```
you › what does the agent loop in helena_harness do?
you › add a --json flag to the CLI and make the tests pass
you › /image ~/Desktop/error.png what's this stack trace about?
you › /search fastapi background tasks vs celery
you › /mode plan          # read-only: investigate and propose, change nothing
you › /agent explorer where is permission checking done?
```

Slash commands (`/help` for the full list):

| | |
|---|---|
| `/model`, `/models`, `/pull` | switch, list, download models |
| `/mode`, `/permissions` | permission mode and rules |
| `/tools`, `/agents`, `/agent` | what it can do; run a subagent directly |
| `/image`, `/read`, `/search` | attach an image, load a file, search the web |
| `/session`, `/compact`, `/clear`, `/cost` | conversation management |
| `/memory`, `/remember`, `/init` | project instructions and durable facts |
| `/jobs`, `/doctor`, `/cd`, `/stream` | background commands, diagnostics, setup |

One-shot mode, for scripts:

```bash
helena -p "run the tests and summarize failures" --mode auto
git diff | helena -p "review this diff" --mode plan
```

## The chat UI

```bash
helena-web                      # http://127.0.0.1:7995
helena-web --open               # ...and open a browser
helena-web -C ~/code/api --mode auto
```

Everything the terminal does, the browser does, because it is the same object: a
web chat session is a subclass of the terminal REPL, and every line you type goes
through the same `handle_line`. `/mode plan`, `/doctor`, `/agent explorer …`,
`/pull llama3.1` — all of it, with `/` opening a completion menu built from the
same command list the terminal completes from.

What the browser adds is what a browser is good at:

* **Tool cards.** Each call is a row — icon, one-line preview, result — that
  expands to the diff or the captured output.
* **Permission prompts inline.** The same four answers (`y` once, `a` always,
  `s` this session, `n` no), as buttons or as those keystrokes, with the diff of
  the pending edit above them. Nothing runs until you answer.
* **Attachments.** Drop or paste a file: images run `/image` (including the
  vision-model fallback when your chat model can't see), anything else runs
  `/read`.
* **A model picker** in the composer, and a **Launch** panel with server and
  Ollama health, the permission mode, and the diagnostic commands one click away.
* **Chats that survive a restart.** Each one keeps its own model, mode and
  workspace, and reloads from `.helena/web/chats/` with its history intact.
* **Live output.** Replies stream token by token over SSE; `Esc` or the stop
  button interrupts a running turn exactly as Ctrl-C does in the terminal.

Reconnects resume from the last event they saw rather than replaying the
conversation, and two tabs open on the same chat stay in step.

### Developing the client

```bash
cd helena_web/ui
npm install
npm run dev            # Vite on :5173, proxying /api to :7995
npm run build          # what helena-web serves from ui/dist
```

The React app is a build artifact and is not checked in; `./start.sh` builds it
when it is missing or stale. `helena-web` says so plainly if it cannot find it.

## Tools

| tool | permission | what it does |
|---|---|---|
| `read_file` | read | file contents with line numbers, offset/limit for big files |
| `list_dir`, `find_files` | read | directory listing, glob search |
| `search_text` | read | regex content search across the tree (`grep -rn`) |
| `edit_file` | write | exact-string replacement; requires a prior read |
| `write_file`, `delete_path` | write | create/overwrite, remove a file or empty dir |
| `run_command` | execute | real shell execution, with timeouts and background jobs |
| `check_job` | read | inspect or kill a background command |
| `web_search` | network | DuckDuckGo results + instant answers |
| `fetch_url` | network | fetch a page and convert it to readable text |
| `analyze_image` | read | ask a multimodal model about an image or screenshot |
| `todo_write` | — | the visible task list for multi-step work |
| `spawn_agent` | — | delegate to a subagent (below) |
| `get_weather`, `get_stock`, `add_reminder`, `remember`, `get_time` | mixed | the original HELENA assistant features, kept |

## Permissions

Every tool call is classified and checked before it runs. Four modes:

| mode | reads | file edits | commands |
|---|---|---|---|
| `ask` (default) | run | ask | ask |
| `auto` | run | run | ask |
| `plan` | run | **refused** | **refused** |
| `yolo` | run | run | run |

When asked, you get a panel showing exactly what will happen — the command, or a
diff of the edit — and four answers: yes once, yes and always allow this, yes for
this session, or no. "Always" writes a rule to `.helena/settings.json`:

```json
{
  "allow": ["run_command(pytest:*)", "read_file(*)", "write_file(src/**)"],
  "deny": ["run_command(git push:*)"],
  "mode": "auto"
}
```

Rules are `tool(pattern)`; `cmd:*` is a prefix match, `src/**` is a glob, a bare
tool name matches all its calls. Deny beats allow, always. Aliases (`Bash`,
`Read`, `Write`, `Edit`) work if you have muscle memory from elsewhere.

Two rails are not negotiable:

* **Some commands are always refused** — `rm -rf /`, `mkfs`, writing to a raw
  block device, fork bombs — in every mode including `yolo`. Commands are judged
  per segment with quoted strings removed, so `echo "rm -rf /"` and
  `git commit -m "remove rm -rf / from docs"` are correctly left alone.
* **Some are always confirmed** even in `auto` — `git push`, `sudo`, recursive
  deletes, piping a download into a shell, publishing a package.

File tools are also confined to the workspace directory unless you pass
`--allow-outside-workspace`. That's a guard against a wandering model, not a
sandbox: `run_command` can still reach the rest of the filesystem, because a
terminal agent that can't run your build is useless. If you want real isolation,
run the whole thing in a container.

## Subagents

`spawn_agent` runs a task in a *separate* conversation with its own tool set and
returns only a summary. On a local model this is mostly about context: a search
that would take fifteen tool calls and 40k tokens of file dumps comes back as a
paragraph, which matters far more when the window is 8k than when it's a million.

| agent | tools | for |
|---|---|---|
| `explorer` | read-only | "where is X handled", broad code search |
| `researcher` | web | documentation, error messages, current information |
| `coder` | read + write + shell | a scoped, well-specified implementation |
| `reviewer` | read + shell | correctness review of code or a diff |
| `generalist` | everything but nesting | multi-step work that fits nothing else |

Subagents share the parent's permission engine — approvals surface to you, and a
subagent can never do something the parent couldn't. Nesting is capped
(`subagent_max_depth`, default 2).

## The server API

Interactive docs at `http://127.0.0.1:8080/docs`.

| endpoint | |
|---|---|
| `GET /health` | server + Ollama status, model count |
| `GET /v1/models` | installed models with inferred tool/vision capability |
| `POST /v1/models/pull` | download a model, SSE progress |
| `POST /v1/chat` | one completion; `stream: true` switches to SSE |
| `POST /v1/chat/stream` | SSE: `token` → `tool_calls` → `done` (with usage) |
| `POST /v1/vision` · `/v1/vision/upload` | images as base64 or multipart upload |
| `POST /v1/embeddings` | vectors from an embedding model |
| `/v1/sessions...` | create, list, read, append, rename, delete (sqlite) |

```bash
curl -sN localhost:8080/v1/chat/stream -H 'content-type: application/json' -d '{
  "messages": [{"role": "user", "content": "explain SSE in one sentence"}]
}'
```

The web UI has its own small API on port 7995, in front of the harness rather
than the models: `/api/chats` to create, list and delete conversations,
`/api/chats/{id}/message` to send one line, `/api/chats/{id}/events` for the SSE
event stream, and `/api/chats/{id}/permission` to answer a prompt. It binds to
localhost and carries no auth of its own — it can run commands as you, so do not
expose it.

Set `HELENA_API_TOKEN` to require `Authorization: Bearer <token>` on `/v1/*`
(`/health` stays open so a client can still diagnose a bad token). Unset — the
default — means no auth, which is right for a process bound to localhost.

## Configuration

Everything has a working default. Layers, later wins:

```
~/.helena/settings.json          your defaults
<workspace>/.helena/settings.json  this project
HELENA_* environment variables   this launch
command-line flags               this run
```

`allow`/`deny` lists are merged across layers rather than overwritten, so a
project can add grants without discarding your global ones. See `.env.example`
for the server's variables, and `helena --help` for flags.

`HELENA.md` at the workspace root is loaded into the system prompt every turn —
put project conventions there. `/init` writes one by exploring the project.
(`CLAUDE.md` or `AGENTS.md` are used as fallbacks if you already keep one.)

## Choosing a model

Two levers dominate on local hardware:

* **Tool calling is required.** `qwen2.5`, `qwen3`, `llama3.1`/`3.2`/`3.3`,
  `mistral-nemo`, `gpt-oss`, and `command-r` all support it in Ollama.
  `/doctor` lists which of your installed models qualify. A model without it
  will talk about using tools instead of using them — the harness recovers
  tool calls emitted as plain JSON text, which papers over the gap, but only
  partly.
* **Context window is memory.** Ollama sizes its KV cache off `num_ctx`
  regardless of how short your conversation is, and agentic loops carry real
  tool output. 8192 is the default here; drop to 4096 if RAM is tight, raise it
  if you have headroom. Quantized tags (`:7b-instruct-q4_K_M`) cut memory
  roughly threefold for a modest quality cost.

## Development

```bash
pytest                    # 158 tests, no Ollama required
python3 -m pyflakes helena_server helena_harness helena_web
```

The tests fake Ollama and nothing else: the agent-loop suite drives the real
harness client over ASGI into the real FastAPI app, so a green run means the
whole chain works — tool schemas out, tool calls back, permission gate,
execution, results fed to the next turn.

```
helena_server/     app.py routes · ollama.py client · store.py sqlite · schemas.py
helena_harness/    agent.py loop · repl.py terminal · permissions.py · tools/
helena_web/        app.py routes · session.py (Repl subclass) · ui.py events · ui/ React
tests/             server, permissions, file tools, shell/web, agent loop, config, web
```

The web tests drive the real FastAPI app over ASGI into a real `WebSession` into
the real model server, so they cover the whole chain: a message in, a permission
prompt out, an answer back, a file actually written.

## What happened to the JavaScript version

This replaces it. The original HELENA (Node + Ollama, `helena.js` and friends) was
a conversational assistant with weather, stocks, reminders, and macOS app control.
Those features are still here as tools; what's new is that it can now actually
work on your code — read, edit, run, verify — with a permission model that makes
that safe to leave running. The old files are in git history at commit `446d81c`.

## License

MIT
