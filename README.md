# H.E.L.E.N.A
### Highly Efficient Logic Engine Network Assistant

A free, local-first terminal AI assistant. Conversation runs entirely on your
machine through Ollama — no API keys, no per-token cost, no data sent to a
third party. Weather and market data come from free, keyless public APIs.

---

## Requirements

→ Node.js 18 or newer (uses native `fetch`)
→ [Ollama](https://ollama.com) installed and running, for the conversational layer
  (weather and stock commands work without it)

## Setup

```bash
# 1. Install Ollama (macOS / Linux / Windows — see ollama.com)
#    then pull a model:
ollama pull llama3.1

# 2. Install HELENA
cd helena
npm link        # makes the `helena` command available globally
# or run directly without linking:
node bin/helena.js
```

Start Ollama's server in the background (usually automatic after install,
otherwise run `ollama serve`), then launch HELENA:

```bash
helena
```

## Usage

```
you > /weather
you > /stocks
you > /stock american airlines
you > /stock AAL
you > /location set "Bend, Oregon"
you > /search when was the eiffel tower built
you > /read ./notes.md
you > /image ./photo.jpg what's in this picture?
you > /remember I'm a full-stack developer working mostly in Next.js
you > /project add "FitTrack" 
you > /schedule add stretch at 3pm
you > /schedule add call mom tomorrow at 6pm
you > /schedule list
you > what's a good rest day workout?
```

Run `/help` inside HELENA for the full command list.

## Scheduled reminders

`/schedule add <text> at <time>` accepts `3pm`, `at 3:30pm`, `in 20 minutes`,
`tomorrow at 9am`, `tomorrow`, or an ISO-ish date/time like `2026-08-12 09:00`.
HELENA checks every 15 seconds for anything due:

→ If you're idle, it interrupts the prompt with the reminder and restores
  whatever you'd half-typed.
→ If you're mid-conversation when it comes due, it waits — your message
  gets answered first, and the reminder is appended right after.

Reminders are marked as fired the moment they trigger, so they never repeat,
even across restarts (this is tracked in `profile.json`, not just in memory).

## Vision and files

`/read <filepath>` loads a text or code file into the current session's
context — HELENA can then answer questions about it for the rest of the
session (not persisted between runs). `/image <filepath> [question]` sends
an image to a locally-run vision model via Ollama. This requires pulling a
multimodal model separately, e.g.:

```bash
ollama pull llava
```

Switch which vision model is used with `/model vision <name>`.

## Search

`/search <query>` is a free, keyless "quick facts" lookup — it checks
DuckDuckGo's Instant Answer API first, then falls back to a Wikipedia
summary. It is not a general web-results engine (no free keyless one
exists), so obscure, very current, or highly specific queries may come
back empty. Full agentic web browsing is a larger project — see Roadmap.

## Real actions (not narrated ones)

Earlier versions of HELENA would sometimes *claim* to open apps, search the
web, or control Spotify in plain conversation without actually doing
anything — the model was just narrating what a JARVIS-style assistant would
plausibly say, since nothing was stopping it. That's fixed: action-shaped
messages ("close spotify", "search for X on chrome", "get directions to
the nearest donut shop") now route through real Ollama tool-calling. The
model is offered a fixed set of actual tools; if it calls one, HELENA
executes it for real via the OS and feeds the true result back before
replying — so the reply is grounded in what actually happened, not guessed.

Supported actions: open/close an app, open a URL (optionally in a specific
browser), search the web in a browser, get Apple Maps directions (macOS),
search Spotify (opens the app to results — it can't start playback
automatically, since that needs Spotify's authenticated Web API, which is
out of scope for a free/keyless local tool), take a screenshot, set system
volume, create a Notes.app note, and check battery/system status. Weather,
stock lookups, market snapshots, and reminders are also real tools now
(see below) — not lumped in with generic web search anymore.

Every plain message is offered the full tool set — there's no keyword
gate deciding whether to bother checking anymore, since that reliably
missed real requests phrased less predictably ("using chrome find out X").
It costs one extra round trip before the reply starts streaming, worth it
for actually doing what's asked instead of guessing wrong about intent.

If a tool call succeeds or fails, the model is told the literal true
result as plain fact before it replies — not replayed through Ollama's
tool-message protocol, which several local models don't reliably honor
and would otherwise let the model contradict an action that just
genuinely worked.

This requires a tool-calling-capable model (llama3.1, qwen2.5, and
mistral-nemo all support it in Ollama). If your model doesn't, HELENA falls
back to a plain reply rather than erroring out.

Scope is intentionally narrow: named apps, URLs, and search/map queries —
not general shell access. Letting an LLM's free-text output execute
arbitrary commands is a real prompt-injection risk (a malicious file or
webpage could try to trigger it); every action here is bounded to a
specific, harmless operation instead.

## Weather, stocks, and reminders without slash commands

These now work as real tools the model can call directly from plain
language — "what's the weather like", "how's AAPL doing", "remind me to
call mom at 3pm" — using the actual weather/stock/scheduling code paths,
not a browser search. The system prompt explicitly tells the model to
prefer these specific tools over generic web search for their categories,
and to only call a tool when a message is actually asking for one of these
things — not for ordinary conversation, opinions, or small talk. The
`/weather`, `/stock`, `/stocks`, and `/schedule` commands still work too,
as an instant deterministic fast path when you want it.

## RAM, speed, and model choice

Ollama sizes its memory usage largely off two things: which model you've
pulled, and its context window (`num_ctx`). Two concrete levers:

→ **Use a quantized model.** `ollama pull llama3.1` grabs a large default
  quantization; `ollama pull llama3.1:8b-instruct-q4_K_M` (or similar
  `q4_K_M` tags) uses roughly a third of the RAM with a modest quality
  trade-off. `qwen2.5:7b-instruct-q4_K_M` is a good balance of size, speed,
  and tool-calling reliability if you want to try something other than
  llama3.1.
→ **Context window is capped at 4096 tokens by default** (`/model context
  <n>` to change it). Some models default their context capacity far
  higher than that (llama3.1 defaults to 128k), and Ollama allocates KV
  cache proportional to that number regardless of how short your actual
  conversation is — which is very likely the biggest single contributor to
  unexpectedly high RAM usage. Dropping to 2048 saves more RAM at the cost
  of the model "seeing" less conversation history at once.

Neither of these makes the underlying model itself smarter — that's a
property of which model you choose, not this tool. `qwen2.5` and `llama3.1`
are both solid, well-rounded choices; heavier models (`qwen2.5:14b`,
`llama3.1:70b`) are meaningfully more capable but need proportionally more
RAM even quantized.



→ **Weather** — [Open-Meteo](https://open-meteo.com) (forecast + geocoding)
→ **Location auto-detect** — chained across [ipapi.co](https://ipapi.co), [ipwho.is](https://ipwho.is), and [ip-api.com](https://ip-api.com); each has its own free-tier rate limit, so this tries each in turn before giving up
→ **Market data** — [Yahoo Finance](https://finance.yahoo.com)'s public chart/search endpoints (Stooq's quote endpoint started requiring an emailed/captcha API key in April 2026 and was dropped)
→ **Search** — [DuckDuckGo Instant Answer API](https://duckduckgo.com/api) + [Wikipedia](https://www.wikipedia.org)
→ **Conversation and vision** — [Ollama](https://ollama.com), any locally pulled text or multimodal model

## A note on "real-time" stock data

Yahoo's free, unauthenticated feed is what every keyless tool like this
ultimately relies on — it typically runs ~15 minutes behind during live
trading, and outside market hours it correctly shows the last actual trade
(not stale data — the market genuinely isn't moving). `/stock` also surfaces
pre-market/after-hours indicative prices when Yahoo has them, which is the
closest thing to "more current" outside the 9:30am-4:00pm ET window. Truly
real-time, tick-by-tick data requires a paid feed; there's no free keyless
source for that.

## Roadmap ideas

→ Tool-calling: let the model decide when to pull weather/stock/search data
  mid-conversation instead of requiring explicit `/commands`
→ Full agentic web browsing (e.g. via a local SearXNG instance) beyond
  quick-answer search
→ Persistent multi-session conversation history, not just the structured profile
→ Voice input/output
→ Recurring reminders (currently one-shot only)

## Configuration

Set `HELENA_OLLAMA_HOST` as an environment variable if Ollama runs somewhere
other than `http://localhost:11434`. Switch models anytime with `/model <name>`
or `/model vision <name>`.
