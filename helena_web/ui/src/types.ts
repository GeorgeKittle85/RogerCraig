/** The event vocabulary the harness emits — see helena_web/events.py. */

export type EventType =
  | "user"
  | "assistant_start"
  | "token"
  | "assistant_end"
  | "markdown"
  | "text"
  | "notice"
  | "warn"
  | "error"
  | "divider"
  | "banner"
  | "tool_start"
  | "tool_result"
  | "tool_output"
  | "diff"
  | "todos"
  | "code"
  | "table"
  | "usage"
  | "permission"
  | "permission_resolved"
  | "state";

export interface HelenaEvent {
  seq: number;
  type: EventType;
  at: number;
  depth?: number;
  [key: string]: unknown;
}

export interface ChatSummary {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  messages: number;
  model: string;
  mode: string;
  busy: boolean;
}

export interface SessionState {
  model: string;
  mode: string;
  workspace: string;
  stream: boolean;
  name: string;
  server: string;
  busy: boolean;
  title: string;
}

export interface ModelInfo {
  name: string;
  parameter_size?: string;
  size?: number;
  supports_tools?: boolean;
  supports_vision?: boolean;
}

export interface CommandInfo {
  name: string;
  description: string;
}

export interface ToolInfo {
  name: string;
  action: string;
  description: string;
}

/** A rendered item in the transcript, folded from one or more events. */
export type Item =
  | { kind: "user"; seq: number; text: string; files: string[] }
  | { kind: "assistant"; seq: number; text: string; label: string; streaming: boolean; depth: number }
  | { kind: "markdown"; seq: number; text: string; depth: number }
  | { kind: "note"; seq: number; text: string; tone: "text" | "notice" | "warn" | "error"; depth: number }
  | { kind: "divider"; seq: number; label: string }
  | { kind: "banner"; seq: number; model: string; workspace: string; mode: string; server: string }
  | {
      kind: "tool";
      seq: number;
      id: number;
      tool: string;
      preview: string;
      depth: number;
      done: boolean;
      ok: boolean;
      summary: string;
      detail: string;
      output: string;
      diff: string;
    }
  | { kind: "todos"; seq: number; items: { task: string; status: string }[]; depth: number }
  | { kind: "code"; seq: number; text: string; language: string; depth: number }
  | { kind: "table"; seq: number; title: string; columns: string[]; rows: string[][] }
  | { kind: "usage"; seq: number; stats: Record<string, number> }
  | {
      kind: "permission";
      seq: number;
      id: string;
      tool: string;
      action: string;
      preview: string;
      detail: string;
      danger: string;
      reason: string;
      agent: string;
      answer: string | null;
      note: string;
    };
