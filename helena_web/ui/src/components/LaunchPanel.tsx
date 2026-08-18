import { useEffect, useState } from "react";
import { api } from "../api";
import type { ModelInfo } from "../types";
import { CloseIcon } from "./Icons";

/**
 * "Launch": the state of the stack underneath the chat — model server, Ollama,
 * what is pulled — plus the commands you would otherwise type to find out.
 */
export function LaunchPanel({
  onClose,
  onRun,
  models,
  mode,
  onMode,
  modes,
}: {
  onClose: () => void;
  onRun: (command: string) => void;
  models: ModelInfo[];
  mode: string;
  onMode: (mode: string) => void;
  modes: string[];
}) {
  const [health, setHealth] = useState<Record<string, any> | null>(null);
  const [error, setError] = useState("");
  const [pull, setPull] = useState("");

  useEffect(() => {
    api
      .health()
      .then(setHealth)
      .catch((exc: Error) => setError(exc.message));
  }, []);

  const server = health?.server ?? {};
  const reachable = Boolean(server.reachable);
  const ollama = Boolean(server.ollama_reachable);

  const run = (command: string) => {
    onRun(command);
    onClose();
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <header>
          <h2>Launch</h2>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </button>
        </header>
        <div className="body">
          {error && <div className="note error">{error}</div>}

          <dl className="kv">
            <dt>model server</dt>
            <dd>
              <span className={`status-dot${reachable ? "" : " off"}`} style={{ display: "inline-block", marginRight: 8 }} />
              {reachable ? `up — ${health?.server_url} (v${server.version ?? "?"})` : `down — ${server.detail || "unreachable"}`}
            </dd>
            <dt>ollama</dt>
            <dd>
              <span className={`status-dot${ollama ? "" : " off"}`} style={{ display: "inline-block", marginRight: 8 }} />
              {ollama
                ? `up — ${server.ollama_host} · ${server.model_count ?? 0} models`
                : server.detail || "not reachable"}
            </dd>
            <dt>workspace</dt>
            <dd className="mono">{health?.workspace ?? "…"}</dd>
            <dt>default model</dt>
            <dd className="mono">{server.default_model || health?.model || "—"}</dd>
          </dl>

          <div>
            <div className="section" style={{ color: "var(--faint)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
              Permission mode
            </div>
            <div className="actions">
              {modes.map((name) => (
                <button
                  key={name}
                  onClick={() => {
                    onMode(name);
                    onClose();
                  }}
                  style={name === mode ? { background: "var(--accent-dim)" } : undefined}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>

          <div>
            <div className="section" style={{ color: "var(--faint)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
              Run a command
            </div>
            <div className="actions">
              {["/doctor", "/models", "/tools", "/agents", "/permissions", "/cost", "/jobs", "/help"].map(
                (command) => (
                  <button key={command} className="mono" onClick={() => run(command)}>
                    {command}
                  </button>
                ),
              )}
            </div>
          </div>

          <div>
            <div className="section" style={{ color: "var(--faint)", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
              Pull a model
            </div>
            <div className="field">
              <input
                value={pull}
                placeholder="qwen2.5:7b-instruct"
                onChange={(event) => setPull(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && pull.trim()) run(`/pull ${pull.trim()}`);
                }}
              />
              <button
                className="pill"
                disabled={!pull.trim()}
                onClick={() => pull.trim() && run(`/pull ${pull.trim()}`)}
              >
                Pull
              </button>
            </div>
            {models.length > 0 && (
              <div style={{ marginTop: 10, color: "var(--faint)", fontSize: 12.5 }}>
                installed: {models.map((info) => info.name).join(", ")}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
