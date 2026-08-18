/** Everything that talks to the Python side. */

import type { ChatSummary, CommandInfo, HelenaEvent, ModelInfo, ToolInfo } from "./types";

async function json<T>(input: string, init?: RequestInit): Promise<T> {
  const res = await fetch(input, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      detail = (await res.json()).detail ?? detail;
    } catch {
      /* keep the status line */
    }
    throw new Error(detail);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

export const api = {
  health: () => json<Record<string, any>>("/api/health"),

  commands: () =>
    json<{ commands: CommandInfo[]; modes: string[]; agents: any[]; tools: ToolInfo[] }>(
      "/api/commands",
    ),

  models: () =>
    json<{ models: ModelInfo[]; default_model?: string; vision_model?: string; error?: string }>(
      "/api/models",
    ),

  listChats: () => json<{ chats: ChatSummary[] }>("/api/chats"),

  newChat: () => json<ChatSummary>("/api/chats", { method: "POST", body: JSON.stringify({ title: "" }) }),

  getChat: (id: string, since = 0) =>
    json<ChatSummary & { last_seq: number; events: HelenaEvent[] }>(
      `/api/chats/${id}?since=${since}`,
    ),

  deleteChat: (id: string) => json<{ deleted: string }>(`/api/chats/${id}`, { method: "DELETE" }),

  renameChat: (id: string, title: string) =>
    json<ChatSummary>(`/api/chats/${id}`, { method: "PATCH", body: JSON.stringify({ title }) }),

  send: (id: string, text: string, images: string[] = [], files: string[] = []) =>
    json<{ accepted: boolean }>(`/api/chats/${id}/message`, {
      method: "POST",
      body: JSON.stringify({ text, images, files }),
    }),

  interrupt: (id: string) => json<{ interrupted: boolean }>(`/api/chats/${id}/interrupt`, { method: "POST" }),

  answerPermission: (id: string, requestId: string, answer: string) =>
    json<{ answered: string }>(`/api/chats/${id}/permission`, {
      method: "POST",
      body: JSON.stringify({ id: requestId, answer }),
    }),

  upload: async (id: string, file: File) => {
    const body = new FormData();
    body.append("file", file);
    const res = await fetch(`/api/chats/${id}/upload`, { method: "POST", body });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).detail ?? `HTTP ${res.status}`);
    return (await res.json()) as { path: string; name: string; size: number; content_type: string };
  },
};

/**
 * Subscribe to a chat's event stream.
 *
 * `since` makes reconnection cheap: the server replays only what the client
 * missed, so a dropped connection mid-answer resumes rather than restarts.
 */
export function subscribe(
  chatId: string,
  since: number,
  onEvent: (event: HelenaEvent) => void,
  onStatus?: (connected: boolean) => void,
): () => void {
  let source: EventSource | null = null;
  let stopped = false;
  let last = since;
  let retry: number | undefined;

  const connect = () => {
    if (stopped) return;
    source = new EventSource(`/api/chats/${chatId}/events?since=${last}`);
    source.onopen = () => onStatus?.(true);
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as HelenaEvent;
        last = Math.max(last, event.seq ?? last);
        onEvent(event);
      } catch {
        /* a malformed frame is not worth tearing the stream down for */
      }
    };
    source.onerror = () => {
      onStatus?.(false);
      source?.close();
      if (!stopped) retry = window.setTimeout(connect, 1200);
    };
  };

  connect();
  return () => {
    stopped = true;
    window.clearTimeout(retry);
    source?.close();
  };
}
