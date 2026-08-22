/**
 * Folds the harness's event stream into renderable items.
 *
 * Events are append-only and arrive in order, so this is a straight reduce
 * with two exceptions: streamed tokens accumulate into the assistant item that
 * is currently open, and a tool's result, output and diff land on the card its
 * `tool_start` created.
 */

import type { HelenaEvent, Item } from "./types";

export interface Transcript {
  items: Item[];
  lastSeq: number;
  openAssistant: number | null; // index into items
  toolIndex: Record<number, number>; // tool call id -> index into items
}

export const emptyTranscript = (): Transcript => ({
  items: [],
  lastSeq: 0,
  openAssistant: null,
  toolIndex: {},
});

const str = (value: unknown, fallback = ""): string =>
  typeof value === "string" ? value : fallback;

const num = (value: unknown, fallback = 0): number =>
  typeof value === "number" ? value : fallback;

export function applyEvent(state: Transcript, event: HelenaEvent): Transcript {
  if (event.seq <= state.lastSeq) return state; // replayed after a reconnect

  const items = state.items.slice();
  const toolIndex = { ...state.toolIndex };
  let openAssistant = state.openAssistant;
  const depth = num(event.depth, 0);
  const push = (item: Item) => items.push(item);

  switch (event.type) {
    case "user":
      openAssistant = null;
      push({
        kind: "user",
        seq: event.seq,
        text: str(event.text),
        files: (event.files as string[]) ?? [],
      });
      break;

    case "assistant_start":
      push({
        kind: "assistant",
        seq: event.seq,
        text: "",
        label: str(event.label, "HELENA"),
        streaming: true,
        depth,
      });
      openAssistant = items.length - 1;
      break;

    case "token": {
      if (openAssistant === null) {
        push({
          kind: "assistant",
          seq: event.seq,
          text: "",
          label: "HELENA",
          streaming: true,
          depth,
        });
        openAssistant = items.length - 1;
      }
      const current = items[openAssistant];
      if (current.kind === "assistant") {
        items[openAssistant] = { ...current, text: current.text + str(event.text) };
      }
      break;
    }

    case "assistant_end": {
      const text = str(event.text);
      if (openAssistant !== null) {
        const current = items[openAssistant];
        if (current.kind === "assistant") {
          items[openAssistant] = { ...current, text: text || current.text, streaming: false };
        }
      } else if (text) {
        push({
          kind: "assistant",
          seq: event.seq,
          text,
          label: str(event.label, "HELENA"),
          streaming: false,
          depth,
        });
      }
      openAssistant = null;
      break;
    }

    case "markdown":
      push({ kind: "markdown", seq: event.seq, text: str(event.text), depth });
      break;

    case "text":
    case "notice":
    case "warn":
    case "error":
      push({ kind: "note", seq: event.seq, text: str(event.text), tone: event.type, depth });
      break;

    case "divider":
      push({ kind: "divider", seq: event.seq, label: str(event.label) });
      break;

    case "banner":
      push({
        kind: "banner",
        seq: event.seq,
        model: str(event.model),
        workspace: str(event.workspace),
        mode: str(event.mode),
        server: str(event.server),
      });
      break;

    case "tool_start":
      push({
        kind: "tool",
        seq: event.seq,
        id: num(event.id),
        tool: str(event.tool),
        preview: str(event.preview),
        depth,
        done: false,
        ok: true,
        summary: "",
        detail: "",
        output: "",
        diff: "",
      });
      toolIndex[num(event.id)] = items.length - 1;
      break;

    case "tool_result": {
      const index = toolIndex[num(event.id)];
      const card = index === undefined ? undefined : items[index];
      if (card && card.kind === "tool") {
        items[index] = {
          ...card,
          done: true,
          ok: event.ok !== false,
          summary: str(event.summary),
          detail: str(event.detail),
        };
      }
      break;
    }

    case "tool_output": {
      const index = toolIndex[num(event.id)];
      const card = index === undefined ? undefined : items[index];
      if (card && card.kind === "tool") {
        items[index] = { ...card, output: card.output + str(event.text) };
      }
      break;
    }

    case "diff": {
      const index = toolIndex[num(event.id)];
      const card = index === undefined ? undefined : items[index];
      if (card && card.kind === "tool") {
        items[index] = { ...card, diff: str(event.patch) };
      }
      break;
    }

    case "todos":
      push({
        kind: "todos",
        seq: event.seq,
        items: (event.items as { task: string; status: string }[]) ?? [],
        depth,
      });
      break;

    case "code":
      push({
        kind: "code",
        seq: event.seq,
        text: str(event.text),
        language: str(event.language, "text"),
        depth,
      });
      break;

    case "table":
      push({
        kind: "table",
        seq: event.seq,
        title: str(event.title),
        columns: (event.columns as string[]) ?? [],
        rows: (event.rows as string[][]) ?? [],
      });
      break;

    case "usage":
      push({
        kind: "usage",
        seq: event.seq,
        stats: (event.stats as Record<string, number>) ?? {},
      });
      break;

    case "permission":
      push({
        kind: "permission",
        seq: event.seq,
        id: str(event.id),
        tool: str(event.tool),
        action: str(event.action),
        preview: str(event.preview),
        detail: str(event.detail),
        danger: str(event.danger),
        reason: str(event.reason),
        agent: str(event.agent, "helena"),
        answer: null,
        note: "",
      });
      break;

    case "permission_resolved": {
      const id = str(event.id);
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const item = items[i];
        if (item.kind === "permission" && item.id === id) {
          items[i] = { ...item, answer: str(event.answer, "no"), note: str(event.note) };
          break;
        }
      }
      break;
    }

    case "question":
      push({
        kind: "question",
        seq: event.seq,
        id: str(event.id),
        question: str(event.question),
        options: (event.options as { label: string; description: string }[]) ?? [],
        answer: null,
        note: "",
      });
      break;

    case "question_resolved": {
      const id = str(event.id);
      for (let i = items.length - 1; i >= 0; i -= 1) {
        const item = items[i];
        if (item.kind === "question" && item.id === id) {
          items[i] = {
            ...item,
            answer: event.answer === null || event.answer === undefined ? "" : str(event.answer),
            note: str(event.note),
          };
          break;
        }
      }
      break;
    }

    case "state":
      break; // handled by the app, not the transcript

    default:
      break;
  }

  return { items, lastSeq: event.seq, openAssistant, toolIndex };
}

export function applyEvents(state: Transcript, events: HelenaEvent[]): Transcript {
  return events.reduce(applyEvent, state);
}

/** The pending permission prompt, if the agent is waiting on one. */
export function pendingPermission(state: Transcript): Extract<Item, { kind: "permission" }> | null {
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const item = state.items[i];
    if (item.kind === "permission" && item.answer === null) return item;
  }
  return null;
}

/** The pending ask_user_question prompt, if the agent is waiting on one. */
export function pendingQuestion(state: Transcript): Extract<Item, { kind: "question" }> | null {
  for (let i = state.items.length - 1; i >= 0; i -= 1) {
    const item = state.items[i];
    if (item.kind === "question" && item.answer === null) return item;
  }
  return null;
}
