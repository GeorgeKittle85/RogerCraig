// Local LLM client for Ollama (https://ollama.com). Free and runs entirely
// on your machine — no API keys, no per-token cost, no data leaves your device.

const OLLAMA_HOST = process.env.HELENA_OLLAMA_HOST || "http://localhost:11434";

// Some local models, especially smaller/weaker ones, don't reliably respect
// chat turn boundaries and will keep generating past their own reply —
// hallucinating a fake "you >" / "HELENA:" back-and-forth in a single
// response. Stop sequences tell Ollama to cut generation the moment it
// starts producing something that looks like a new turn.
const TURN_STOP_SEQUENCES = ["\nyou >", "\nYou >", "\nHELENA:", "\nUSER:", "\nUser:", "\nuser:"];

// Ollama sizes its KV cache off the context window (num_ctx), and several
// models default that to something huge (llama3.1 defaults to 128k tokens
// of context capacity) — which allocates a correspondingly huge chunk of
// RAM even for a short conversation. Capping it explicitly is one of the
// biggest available levers on memory usage for a local setup like this.
const DEFAULT_NUM_CTX = 4096;

function buildOptions(numCtx) {
  return { stop: TURN_STOP_SEQUENCES, num_ctx: numCtx || DEFAULT_NUM_CTX };
}

export async function checkOllamaAvailable() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function listModels() {
  const res = await fetch(`${OLLAMA_HOST}/api/tags`);
  if (!res.ok) throw new Error(`Could not reach Ollama at ${OLLAMA_HOST}`);
  const data = await res.json();
  return (data.models || []).map(m => m.name);
}

// Heuristic: match common vision-capable model families by name, so we can
// suggest (or auto-use) a vision model the user already has pulled, instead
// of always pointing them at "llava" regardless of what's actually local.
const VISION_MODEL_HINTS = ["llava", "bakllava", "moondream", "vision", "-vl", "minicpm-v"];

export async function findAvailableVisionModel() {
  const models = await listModels().catch(() => []);
  return models.find(m => VISION_MODEL_HINTS.some(hint => m.toLowerCase().includes(hint))) ?? null;
}

async function postChat(body) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  return res;
}

async function streamResponse(res, onToken) {
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama request failed (${res.status}): ${text || "no response body"}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let full = "";
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    const lines = buffer.split("\n");
    buffer = lines.pop();

    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue;
      }
      const piece = obj?.message?.content;
      if (piece) {
        full += piece;
        onToken?.(piece);
      }
      if (obj.done) return full;
    }
  }

  return full;
}

// Streams a chat completion. Calls onToken(chunk) for each piece of text
// as it arrives, and resolves with the full response text at the end.
// `images`, if provided, is an array of base64-encoded image strings
// attached to the final user message — this is how Ollama vision models
// (llava, bakllava, qwen2-vl, etc.) accept image input.
export async function chatStream({ model, systemPrompt, history, userMessage, images, numCtx, onToken }) {
  const userMsg = { role: "user", content: userMessage };
  if (images?.length) userMsg.images = images;

  const messages = [{ role: "system", content: systemPrompt }, ...history, userMsg];
  const res = await postChat({ model, messages, stream: true, options: buildOptions(numCtx) });
  return streamResponse(res, onToken);
}

// Non-streaming call that offers the model a set of tools it can request.
// Returns { content, tool_calls }. tool_calls is [] if the model answered
// directly without needing to act on anything.
export async function chatWithTools({ model, systemPrompt, history, userMessage, tools, numCtx }) {
  const messages = [{ role: "system", content: systemPrompt }, ...history, { role: "user", content: userMessage }];
  const res = await postChat({ model, messages, tools, stream: false, options: buildOptions(numCtx) });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Ollama request failed (${res.status}): ${text || "no response body"}`);
  }
  const data = await res.json();
  const msg = data.message || {};
  return { content: msg.content || "", tool_calls: msg.tool_calls || [] };
}

// Note: an earlier version had a chatStreamAfterTools() here that replayed
// the assistant/tool message sequence with tool_call_id linking to get a
// grounded follow-up reply. Removed — several local models don't reliably
// honor that protocol and would ignore the tool results outright. The
// current approach (see bin/helena.js) states real tool results as plain
// facts in the system prompt instead, which is far more robust.
