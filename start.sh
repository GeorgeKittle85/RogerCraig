#!/usr/bin/env bash
# Starts the H.E.L.E.N.A stack: Ollama (if not already running), helena_server,
# and the web chat UI, as background processes with pidfiles + logs under
# .helena/run/. Once this returns, open the UI or run `helena` for the terminal
# agent. Pass --no-web to leave the browser UI out.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

RUN_DIR=".helena/run"
mkdir -p "$RUN_DIR"

HOST="${HELENA_HOST:-127.0.0.1}"
PORT="${HELENA_PORT:-8080}"
WEB_PORT="${HELENA_WEB_PORT:-7995}"
OLLAMA_HOST="${HELENA_OLLAMA_HOST:-http://127.0.0.1:11434}"

WITH_WEB=1
for arg in "$@"; do
  case "$arg" in
    --no-web) WITH_WEB=0 ;;
    -h|--help)
      echo "usage: ./start.sh [--no-web]"
      echo "  HELENA_PORT=$PORT  HELENA_WEB_PORT=$WEB_PORT  HELENA_HOST=$HOST"
      exit 0
      ;;
  esac
done

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
fi

if [ -d .venv ]; then
  # shellcheck disable=SC1091
  source .venv/bin/activate
fi

PYTHON="$(command -v python3 || command -v python)"
if [ -z "$PYTHON" ]; then
  echo "error: no python3/python on PATH" >&2
  exit 1
fi

wait_for() {
  local url="$1" tries="${2:-30}"
  for _ in $(seq 1 "$tries"); do
    curl -fsS "$url" >/dev/null 2>&1 && return 0
    sleep 1
  done
  return 1
}

# --- Ollama ------------------------------------------------------------
if curl -fsS "$OLLAMA_HOST/api/version" >/dev/null 2>&1; then
  echo "ollama:       already running at $OLLAMA_HOST"
else
  if ! command -v ollama >/dev/null 2>&1; then
    echo "error: ollama not found and nothing answering at $OLLAMA_HOST" >&2
    echo "       install it from https://ollama.com" >&2
    exit 1
  fi
  echo "ollama:       starting..."
  nohup ollama serve >"$RUN_DIR/ollama.log" 2>&1 &
  echo $! >"$RUN_DIR/ollama.pid"
  if wait_for "$OLLAMA_HOST/api/version"; then
    echo "ollama:       started (pid $(cat "$RUN_DIR/ollama.pid"))"
  else
    echo "error: ollama did not become ready, check $RUN_DIR/ollama.log" >&2
    exit 1
  fi
fi

# --- helena_server -------------------------------------------------------
if curl -fsS "http://$HOST:$PORT/health" >/dev/null 2>&1; then
  echo "helena_server: already running at http://$HOST:$PORT"
else
  echo "helena_server: starting..."
  nohup "$PYTHON" -m helena_server --host "$HOST" --port "$PORT" --log-level warning \
    >"$RUN_DIR/server.log" 2>&1 &
  echo $! >"$RUN_DIR/server.pid"
  if wait_for "http://$HOST:$PORT/health"; then
    echo "helena_server: started (pid $(cat "$RUN_DIR/server.pid")) at http://$HOST:$PORT"
  else
    echo "error: helena_server did not become ready, check $RUN_DIR/server.log" >&2
    exit 1
  fi
fi

# --- web chat UI ---------------------------------------------------------
if [ "$WITH_WEB" = "1" ]; then
  if curl -fsS "http://$HOST:$WEB_PORT/api/health" >/dev/null 2>&1; then
    echo "chat UI:      already running at http://$HOST:$WEB_PORT"
  else
    # The React client is a build artifact, not a checked-in file. Build it the
    # first time, then only when the sources are newer than the bundle.
    if [ ! -d helena_web/ui/dist ] || [ -n "$(find helena_web/ui/src helena_web/ui/index.html -newer helena_web/ui/dist 2>/dev/null)" ]; then
      if command -v npm >/dev/null 2>&1; then
        echo "chat UI:      building the React client (this takes a moment)..."
        (
          cd helena_web/ui
          [ -d node_modules ] || npm install --silent
          npm run build --silent
        ) >"$RUN_DIR/ui-build.log" 2>&1 || {
          echo "error: the UI build failed, see $RUN_DIR/ui-build.log" >&2
          exit 1
        }
      elif [ ! -d helena_web/ui/dist ]; then
        echo "chat UI:      skipped — npm is not installed and helena_web/ui/dist is missing" >&2
        WITH_WEB=0
      fi
    fi
  fi

  if [ "$WITH_WEB" = "1" ] && ! curl -fsS "http://$HOST:$WEB_PORT/api/health" >/dev/null 2>&1; then
    echo "chat UI:      starting..."
    nohup "$PYTHON" -m helena_web --host "$HOST" --port "$WEB_PORT" --log-level warning \
      >"$RUN_DIR/web.log" 2>&1 &
    echo $! >"$RUN_DIR/web.pid"
    if wait_for "http://$HOST:$WEB_PORT/api/health"; then
      echo "chat UI:      started (pid $(cat "$RUN_DIR/web.pid")) at http://$HOST:$WEB_PORT"
    else
      echo "error: the chat UI did not become ready, check $RUN_DIR/web.log" >&2
      exit 1
    fi
  fi
fi

echo
if [ "$WITH_WEB" = "1" ]; then
  echo "H.E.L.E.N.A is up: http://$HOST:$WEB_PORT in a browser, 'helena' in a terminal."
else
  echo "H.E.L.E.N.A is up. Run 'helena' to start the terminal agent."
fi
echo "./stop.sh shuts it all down."
