#!/usr/bin/env node
import readline from "readline";
import {
  loadProfile,
  saveProfile,
  addFact,
  addProject,
  addScheduleItem,
  setLocation,
  setPreference,
  buildContextSummary,
  PROFILE_PATH
} from "../src/memory.js";
import { geocodeCity, geolocateByIp, getWeather, formatWeatherReport } from "../src/weather.js";
import { getMarketSnapshot, formatMarketReport, getStockDetail, formatStockDetail } from "../src/stocks.js";
import { chatStream, chatWithTools, checkOllamaAvailable, listModels, findAvailableVisionModel } from "../src/ai.js";
import { parseWhen, checkDueSchedule } from "../src/scheduler.js";
import { quickSearch, formatSearchResult } from "../src/search.js";
import { readTextFile, readImageAsBase64, isImageFile, findExistingPath } from "../src/files.js";
import { openTarget } from "../src/desktop.js";
import { TOOLS, describeToolCall, executeTool } from "../src/tools.js";

const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const YELLOW = "\x1b[33m";

const profile = loadProfile();
let chatHistory = []; // in-memory only for this session; durable facts live in profile.json
const attachedFiles = new Map(); // name -> { content, truncated } — session-scoped, from /read

// A small animated "thinking" indicator for the gap before tokens start
// arriving (mainly the non-streaming tool-decision call, which has to
// finish completely before anything can be shown). Rotates through a
// pool of phrases so it doesn't feel like a static "Loading..." spinner.
const THINKING_PHRASES = [
  "Triangulating...", "Mulling it over...", "Crunching the details...",
  "Consulting the neural ether...", "Running the numbers...",
  "Piecing it together...", "Percolating...", "Cross-referencing...",
  "Spinning up a thought...", "Chewing on that...", "Connecting the dots...",
  "Working the angles..."
];
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function startThinking() {
  const phrase = THINKING_PHRASES[Math.floor(Math.random() * THINKING_PHRASES.length)];
  let frame = 0;
  const render = () => {
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    process.stdout.write(`${DIM}${SPINNER_FRAMES[frame]} ${phrase}${RESET}`);
    frame = (frame + 1) % SPINNER_FRAMES.length;
  };
  render();
  const timer = setInterval(render, 90);
  return () => {
    clearInterval(timer);
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
  };
}

const SYSTEM_PROMPT_BASE = `You are H.E.L.E.N.A (Highly Efficient Logic Engine Network Assistant), a private, locally-run AI assistant modeled on JARVIS/FRIDAY. Talk like a sharp, capable assistant who's genuinely on top of things — warm, a little witty, direct. Avoid hedging like "I don't have access to..." unless it's actually true.

You have REAL tool access to these actual capabilities:
- Weather: get_weather — always use this for weather questions, never web search.
- Stocks: get_stock_price (one stock) / get_market_snapshot (indices) — always use these for market questions, never web search.
- Reminders: add_reminder — always use this when asked to schedule or be reminded of something. Don't just acknowledge it in words; actually call it, or it won't fire.
- Quick facts: quick_search — for questions the user wants answered in chat (definitions, facts, general knowledge), no browser tab opened.
- Open/close any named Mac app
- Open a URL in a browser (default, or a specific one like Chrome or Safari), or open a search results page in one (web_search_in_browser) — only when the user actually wants a browser tab opened, e.g. "pull this up in Chrome"
- Get walking/driving directions in Apple Maps, including vague destinations like "nearest mechanic"
- Search Spotify (opens the app to results — the user still presses play)
- Take a screenshot, set system volume, create a Notes.app note, check battery/system status

Tool discipline:
- When a request clearly matches one of the above, call it — don't just say you can't.
- Use the SPECIFIC matching tool (weather/stock/reminder/quick_search) instead of the generic browser-search tools whenever one exists for the category. Don't reach for web_search_in_browser out of habit.
- For ordinary conversation — opinions, small talk, questions about yourself, anything that isn't actually asking you to do or look something up — just answer directly. Not every message needs a tool call.
- Only say something is outside your ability if it genuinely doesn't match anything above (e.g. placing a phone call, sending a text, actually starting music playback, controlling non-Mac devices).

You have access to structured context about the user below; use it naturally, and don't mention that it was "provided to you" or reference a memory system.

Hard rules, no exceptions:
- Give exactly ONE reply and stop. Never simulate, continue, or invent the user's next message. Never write "you >" or prefix your own reply with "HELENA:" — the interface already displays that.
- Only claim an action happened if you actually called the matching tool this turn (you'll see its real result if so). Never narrate a fake "Done." without it.`;

function banner() {
  console.log(`${CYAN}${BOLD}`);
  console.log("  H . E . L . E . N . A");
  console.log(`${RESET}${DIM}  Highly Efficient Logic Engine Network Assistant${RESET}`);
  console.log(`${DIM}  Local, free, and yours. Type /help for commands.${RESET}\n`);
}

function help() {
  console.log(`${BOLD}Commands${RESET}
  /help                          Show this menu
  /weather [city]                Current weather (uses saved location if omitted)
  /stocks                        Snapshot of major indices
  /stock <name or ticker>        Detail on one stock, e.g. /stock american airlines  or  /stock AAL
  /location set <city>           Save a location manually
  /location auto                 Detect location from your network (IP-based)
  /search <query>                Quick factual lookup (DuckDuckGo + Wikipedia, no key)
  /read <filepath>                Load a text/code file into context for this session
  /image <filepath> [question]   Ask a vision-capable Ollama model about an image
  /files                          List files currently loaded into context
  /open <app or url>              Open an app or website (e.g. /open Safari, /open github.com)
  /remember <fact>                Save a durable fact about you
  /project add <name> [notes]    Track an ongoing project
  /schedule add <text> at <time> Add a reminder, e.g. /schedule add stretch at 3pm
  /schedule list                 Show upcoming/pending reminders
  /profile                       View your stored profile
  /profile path                  Show where profile.json lives on disk
  /model <name>                  Switch the Ollama text model (e.g. llama3.1, mistral)
  /model vision <name>           Switch the Ollama vision model (e.g. llava)
  /model context <n>              Cap the context window (RAM/speed tradeoff — see README)
  /exit                          Quit

Slash commands are still here for speed, but you don't need them: just ask
in plain language — "what's the weather like", "remind me to call mom at
3pm", "how's AAPL doing", "open Spotify", "pull up github.com" — or paste
a file/image path into a normal message and HELENA will read it.

Anything else you type is sent to H.E.L.E.N.A as a normal message.\n`);
}

async function handleWeather(cityArg) {
  const stopThinking = startThinking();
  try {
    let loc;
    if (cityArg) {
      loc = await geocodeCity(cityArg);
    } else if (profile.location?.lat) {
      loc = profile.location;
    } else {
      loc = await geolocateByIp();
      setLocation(profile, loc);
    }
    const weather = await getWeather({ lat: loc.lat, lon: loc.lon, units: profile.preferences.units });
    stopThinking();
    console.log("\n" + formatWeatherReport(loc.label, weather) + "\n");
  } catch (err) {
    stopThinking();
    console.log(`${YELLOW}Could not fetch weather: ${err.message}${RESET}`);
  }
}

async function handleStocks() {
  const stopThinking = startThinking();
  try {
    const snapshot = await getMarketSnapshot();
    stopThinking();
    console.log("\n" + formatMarketReport(snapshot) + "\n");
  } catch (err) {
    stopThinking();
    console.log(`${YELLOW}Could not fetch market data: ${err.message}${RESET}`);
  }
}

async function handleStock(query) {
  if (!query) {
    console.log(`${YELLOW}Usage: /stock <company name or ticker>, e.g. /stock american airlines  or  /stock AAL${RESET}`);
    return;
  }
  const stopThinking = startThinking();
  try {
    const detail = await getStockDetail(query);
    stopThinking();
    console.log("\n" + formatStockDetail(detail) + "\n");
  } catch (err) {
    stopThinking();
    console.log(`${YELLOW}${err.message}${RESET}`);
  }
}

async function handleLocation(args) {
  const [sub, ...rest] = args;
  if (sub === "auto") {
    const stopThinking = startThinking();
    try {
      const loc = await geolocateByIp();
      setLocation(profile, loc);
      stopThinking();
      console.log(`Location set to ${BOLD}${loc.label}${RESET} (via IP geolocation).`);
    } catch (err) {
      stopThinking();
      console.log(`${YELLOW}Could not detect location: ${err.message}${RESET}`);
    }
    return;
  }
  if (sub === "set") {
    const query = rest.join(" ");
    if (!query) {
      console.log(`${YELLOW}Usage: /location set <city>${RESET}`);
      return;
    }
    try {
      const loc = await geocodeCity(query);
      setLocation(profile, loc);
      console.log(`Location set to ${BOLD}${loc.label}${RESET}.`);
    } catch (err) {
      console.log(`${YELLOW}${err.message}${RESET}`);
    }
    return;
  }
  console.log(`${YELLOW}Usage: /location set <city>  |  /location auto${RESET}`);
}

async function handleSearch(query) {
  if (!query) {
    console.log(`${YELLOW}Usage: /search <query>${RESET}`);
    return;
  }
  const stopThinking = startThinking();
  try {
    const result = await quickSearch(query);
    stopThinking();
    console.log("\n" + formatSearchResult(query, result) + "\n");
  } catch (err) {
    stopThinking();
    console.log(`${YELLOW}Search failed: ${err.message}${RESET}`);
  }
}

function handleRead(filePath) {
  if (!filePath) {
    console.log(`${YELLOW}Usage: /read <filepath>${RESET}`);
    return;
  }
  try {
    const file = readTextFile(filePath);
    attachedFiles.set(file.name, { content: file.content, truncated: file.truncated });
    console.log(
      `Loaded ${BOLD}${file.name}${RESET} into context (${file.content.length} chars${file.truncated ? ", truncated" : ""}). Ask about it anytime this session.`
    );
  } catch (err) {
    console.log(`${YELLOW}${err.message}${RESET}`);
  }
}

function handleFiles() {
  if (!attachedFiles.size) {
    console.log(`${DIM}No files loaded this session. Use /read <filepath>.${RESET}`);
    return;
  }
  console.log(`${BOLD}Files in context this session:${RESET}`);
  for (const [name, f] of attachedFiles) {
    console.log(`  → ${name} (${f.content.length} chars${f.truncated ? ", truncated" : ""})`);
  }
}

async function handleImage(filePath, question) {
  question = question || "Describe what's in this image in detail.";
  if (!filePath) {
    console.log(`${YELLOW}Usage: /image <filepath> [question]${RESET}`);
    return;
  }
  if (!isImageFile(filePath)) {
    console.log(`${YELLOW}That doesn't look like a supported image type (png, jpg, gif, webp, bmp).${RESET}`);
    return;
  }

  const ollamaUp = await checkOllamaAvailable();
  if (!ollamaUp) {
    console.log(`${YELLOW}Ollama isn't reachable at localhost:11434.${RESET}`);
    return;
  }

  let img;
  try {
    img = readImageAsBase64(filePath);
  } catch (err) {
    console.log(`${YELLOW}${err.message}${RESET}`);
    return;
  }

  const configuredModel = profile.preferences.visionModel || "llava";
  const localModels = await listModels().catch(() => []);
  let visionModel = configuredModel;

  if (!localModels.includes(configuredModel)) {
    const fallback = await findAvailableVisionModel();
    if (fallback) {
      visionModel = fallback;
      console.log(`${DIM}"${configuredModel}" isn't pulled — using "${fallback}", which is already available locally.${RESET}`);
    } else {
      console.log(`${YELLOW}No vision-capable model found locally. "${configuredModel}" isn't pulled, and none of your other local models look vision-capable.${RESET}`);
      console.log(`${DIM}Pull one to enable image analysis, e.g.:${RESET}`);
      console.log(`${DIM}  ollama pull ${configuredModel}${RESET}`);
      console.log(`${DIM}  ollama pull moondream   (smaller/faster alternative)${RESET}`);
      return;
    }
  }

  const stopThinking = startThinking();
  let printedPrefix = false;
  try {
    await chatStream({
      model: visionModel,
      systemPrompt: SYSTEM_PROMPT_BASE,
      history: [],
      userMessage: question,
      images: [img.base64],
      numCtx: profile.preferences.numCtx,
      onToken: (t) => {
        if (!printedPrefix) {
          stopThinking();
          process.stdout.write(`${CYAN}HELENA:${RESET} `);
          printedPrefix = true;
        }
        process.stdout.write(t);
      }
    });
    if (!printedPrefix) stopThinking();
    console.log("\n");
  } catch (err) {
    if (!printedPrefix) stopThinking();
    console.log(`\n${YELLOW}${err.message}${RESET}`);
    console.log(`${DIM}Try pulling the model first: ollama pull ${visionModel}${RESET}`);
  }
}

async function handleOpen(target) {
  if (!target) {
    console.log(`${YELLOW}Usage: /open <app name or URL>, e.g. /open Safari  or  /open github.com${RESET}`);
    return;
  }
  try {
    const { target: resolved, isUrl } = await openTarget(target);
    console.log(`Opened ${BOLD}${resolved}${RESET}${isUrl ? "" : " (app)"}.`);
  } catch (err) {
    console.log(`${YELLOW}${err.message}${RESET}`);
  }
}

function handleRemember(text) {
  if (!text) {
    console.log(`${YELLOW}Usage: /remember <fact>${RESET}`);
    return;
  }
  addFact(profile, text);
  console.log("Noted.");
}

function handleProject(args) {
  const [sub, ...rest] = args;
  if (sub === "add") {
    const name = rest.join(" ");
    if (!name) {
      console.log(`${YELLOW}Usage: /project add <name> [notes]${RESET}`);
      return;
    }
    addProject(profile, name);
    console.log(`Project "${name}" added.`);
    return;
  }
  console.log(`${YELLOW}Usage: /project add <name>${RESET}`);
}

function handleSchedule(args) {
  const [sub, ...rest] = args;

  if (sub === "list") {
    const upcoming = profile.schedule.filter(s => !s.notified);
    if (!upcoming.length) {
      console.log(`${DIM}No pending reminders.${RESET}`);
      return;
    }
    console.log(`${BOLD}Pending reminders:${RESET}`);
    for (const s of upcoming) {
      const when = s.whenISO ? new Date(s.whenISO).toLocaleString() : `unparsed time ("${s.when}")`;
      console.log(`  → ${s.text} — ${when}`);
    }
    return;
  }

  if (sub === "add") {
    const rawText = rest.join(" ");
    if (!rawText) {
      console.log(`${YELLOW}Usage: /schedule add <text> at <time>, e.g. /schedule add stretch at 3pm${RESET}`);
      return;
    }
    // Split "<text> at <time>" — take the LAST " at " as the separator, so
    // reminder text itself can still contain the word "at".
    const idx = rawText.toLowerCase().lastIndexOf(" at ");
    const text = idx === -1 ? rawText : rawText.slice(0, idx).trim();
    const whenText = idx === -1 ? null : rawText.slice(idx + 4).trim();

    const whenDate = whenText ? parseWhen(whenText) : null;
    addScheduleItem(profile, text, whenText, whenDate ? whenDate.toISOString() : null);

    if (whenText && !whenDate) {
      console.log(`${YELLOW}Saved, but couldn't parse "${whenText}" as a time — it won't trigger a reminder. Try formats like "3pm", "tomorrow at 9am", or "in 20 minutes".${RESET}`);
    } else if (whenDate) {
      console.log(`Reminder set: "${text}" at ${whenDate.toLocaleString()}.`);
    } else {
      console.log(`Schedule note added (no time given, so no reminder will fire).`);
    }
    return;
  }

  console.log(`${YELLOW}Usage: /schedule add <text> at <time>  |  /schedule list${RESET}`);
}

function handleProfile(args) {
  if (args[0] === "path") {
    console.log(PROFILE_PATH);
    return;
  }
  console.log(JSON.stringify(profile, null, 2));
}

function handleModel(args) {
  if (args[0] === "vision") {
    const name = args.slice(1).join(" ");
    if (!name) {
      console.log(`Current vision model: ${BOLD}${profile.preferences.visionModel || "llava"}${RESET}`);
      return;
    }
    setPreference(profile, "visionModel", name);
    console.log(`Vision model set to ${BOLD}${name}${RESET}.`);
    return;
  }
  if (args[0] === "context") {
    const n = parseInt(args[1], 10);
    if (!n || n < 512) {
      console.log(`Current context window: ${BOLD}${profile.preferences.numCtx}${RESET} tokens.`);
      console.log(`${DIM}Usage: /model context <n>, e.g. /model context 2048. Lower = less RAM and faster, but less conversation the model can see at once. 4096 is a reasonable default; try 2048 if RAM is tight.${RESET}`);
      return;
    }
    setPreference(profile, "numCtx", n);
    console.log(`Context window set to ${BOLD}${n}${RESET} tokens.`);
    return;
  }
  const name = args.join(" ");
  if (!name) {
    console.log(`Current model: ${BOLD}${profile.preferences.model}${RESET}`);
    return;
  }
  setPreference(profile, "model", name);
  console.log(`Model set to ${BOLD}${name}${RESET}.`);
}

function buildSystemPrompt() {
  let prompt = `${SYSTEM_PROMPT_BASE}\n\n${buildContextSummary(profile)}`;
  if (attachedFiles.size) {
    prompt += "\n\nFiles the user has loaded into this session:\n";
    for (const [name, f] of attachedFiles) {
      prompt += `\n--- ${name}${f.truncated ? " (truncated)" : ""} ---\n${f.content}\n`;
    }
  }
  return prompt;
}

// Info tools: weather, stocks, reminders, and quick search — plugged into
// the SAME tool-calling pipeline as the desktop actions in src/tools.js,
// so natural language ("what's the weather like", "remind me at 3pm")
// works without slash commands, AND uses the real APIs directly instead
// of the model defaulting to "open a browser search for it" for
// everything, which is what happened before these existed.
const INFO_TOOLS = [
  {
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather and today's forecast for a city, or the user's saved location if no city is given. Always use this for weather questions — never web search.",
      parameters: {
        type: "object",
        properties: { city: { type: "string", description: "Optional city name. Omit to use the user's saved location." } }
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_stock_price",
      description: "Get the current price and details for a single stock by company name or ticker. Always use this for a specific stock — never web search.",
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Company name or ticker, e.g. 'Apple' or 'AAPL'" } },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_market_snapshot",
      description: "Get a snapshot of major stock market indices (S&P 500, Dow, Nasdaq). Use for general 'how's the market doing' questions — never web search.",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "add_reminder",
      description: "Schedule a reminder that will actually notify the user at the given time. Always call this when asked to be reminded of something or to schedule something — acknowledging it in words alone does not create a real reminder.",
      parameters: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to remind the user about" },
          when: { type: "string", description: "When to remind them, e.g. '3pm', 'tomorrow at 9am', 'in 20 minutes'" }
        },
        required: ["text", "when"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "quick_search",
      description: "Get a quick factual answer (definitions, facts, general knowledge) without opening a browser. Prefer this over web_search_in_browser when the user just wants an answer in chat. Not for weather or stock prices — use those specific tools instead.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    }
  }
];
const INFO_TOOL_NAMES = new Set(INFO_TOOLS.map(t => t.function.name));
const ALL_TOOLS = [...TOOLS, ...INFO_TOOLS];

async function executeInfoTool(name, args) {
  try {
    switch (name) {
      case "get_weather": {
        let loc;
        if (args.city) loc = await geocodeCity(args.city);
        else if (profile.location?.lat) loc = profile.location;
        else loc = await geolocateByIp();
        const weather = await getWeather({ lat: loc.lat, lon: loc.lon, units: profile.preferences.units });
        return { ok: true, location: loc.label, current: weather.current, today: weather.today };
      }
      case "get_stock_price": {
        const detail = await getStockDetail(args.query);
        return { ok: true, ...detail };
      }
      case "get_market_snapshot": {
        const snapshot = await getMarketSnapshot();
        return { ok: true, snapshot };
      }
      case "add_reminder": {
        const whenDate = parseWhen(args.when);
        addScheduleItem(profile, args.text, args.when, whenDate ? whenDate.toISOString() : null);
        if (!whenDate) {
          return { ok: false, error: `Couldn't parse "${args.when}" as a time. Try formats like "3pm", "tomorrow at 9am", or "in 20 minutes".` };
        }
        return { ok: true, message: `Reminder set for ${whenDate.toLocaleString()}.`, text: args.text, when: whenDate.toISOString() };
      }
      case "quick_search": {
        const result = await quickSearch(args.query);
        if (!result) return { ok: false, error: `No quick answer found for "${args.query}".` };
        return { ok: true, text: result.text, source: result.source, url: result.url };
      }
      default:
        return { ok: false, error: `Unknown info tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function describeAnyTool(name, args) {
  switch (name) {
    case "get_weather": return `Checking the weather${args.city ? ` in ${args.city}` : ""}...`;
    case "get_stock_price": return `Looking up ${args.query}...`;
    case "get_market_snapshot": return `Checking the markets...`;
    case "add_reminder": return `Scheduling: "${args.text}"...`;
    case "quick_search": return `Looking that up...`;
    default: return describeToolCall(name, args);
  }
}

async function executeAnyTool(name, args) {
  return INFO_TOOL_NAMES.has(name) ? executeInfoTool(name, args) : executeTool(name, args);
}

// Returns reminder text for any schedule items that just came due, or null.
function drainDueReminders() {
  const due = checkDueSchedule(profile, saveProfile);
  if (!due.length) return null;
  return due.map(d => `It's time for: ${d.text}`).join("\n");
}

async function handleChat(input) {
  const ollamaUp = await checkOllamaAvailable();
  if (!ollamaUp) {
    console.log(`${YELLOW}Ollama isn't reachable at localhost:11434.${RESET}`);
    console.log(`${DIM}Install it from https://ollama.com, run "ollama pull ${profile.preferences.model}", then leave "ollama serve" running.${RESET}\n`);
    return;
  }
  await handleActionChat(input);
}

function trimHistory() {
  if (chatHistory.length > 20) chatHistory = chatHistory.slice(-20);
}

// Every plain-text message goes through Ollama's tool-calling: the model is
// always offered the full tool set and decides for itself whether the
// message needs a real action. This used to be gated behind a keyword
// heuristic ("open", "search", etc.), which reliably missed real requests
// phrased in less predictable ways ("using chrome find out X", "google Y").
// Always offering tools costs one extra non-streaming round trip before
// the reply streams, but that's a small, worthwhile price for actually
// doing what's asked instead of guessing wrong about intent.
async function handleActionChat(input) {
  const systemPrompt = buildSystemPrompt();
  const model = profile.preferences.model;
  const numCtx = profile.preferences.numCtx;

  const stopThinking = startThinking();
  let decision;
  try {
    decision = await chatWithTools({ model, systemPrompt, history: chatHistory, userMessage: input, tools: ALL_TOOLS, numCtx });
  } catch (err) {
    stopThinking();
    // Model may not support tool calling at all — fall back to a plain,
    // honestly-worded reply rather than erroring out.
    return handlePlainChatFallback(input, systemPrompt);
  }
  stopThinking();

  if (!decision.tool_calls?.length) {
    console.log(`${CYAN}HELENA:${RESET} ${decision.content}\n`);
    chatHistory.push({ role: "user", content: input });
    chatHistory.push({ role: "assistant", content: decision.content });
    trimHistory();
    return;
  }

  // Execute every requested tool call for real, then hand the model the
  // TRUE results as plain facts in the system prompt for a follow-up call.
  // (Earlier version tried to replay the assistant/tool message sequence
  // with tool_call_id linking — several local models don't reliably honor
  // that protocol and would ignore the results entirely, producing replies
  // that contradicted actions that had just genuinely succeeded. Stating
  // results as plain, unambiguous facts is far more robust across models.)
  const results = [];
  for (const call of decision.tool_calls) {
    const name = call.function?.name;
    let args = {};
    try {
      args = typeof call.function?.arguments === "string" ? JSON.parse(call.function.arguments) : (call.function?.arguments || {});
    } catch {
      args = {};
    }
    console.log(`${DIM}→ ${describeAnyTool(name, args)}${RESET}`);
    const result = await executeAnyTool(name, args);
    results.push({ name, args, result });
  }

  const toolSummary = results
    .map(r => `- ${r.name}(${JSON.stringify(r.args)}) → ${JSON.stringify(r.result)}`)
    .join("\n");
  const groundedPrompt = `${systemPrompt}\n\nYou just executed the following real action(s) on the user's behalf — these already happened, for real, via your actual tools:\n${toolSummary}\n\nReply based on these true results. If a result's "ok" field is true, confirm naturally what you did/found — don't just repeat the raw JSON, and don't second-guess it. If "ok" is false, explain the actual error shown, briefly — don't invent a different reason. Never say you lack a capability you just used.`;

  process.stdout.write(`${CYAN}HELENA:${RESET} `);
  let full = "";
  try {
    full = await chatStream({
      model,
      systemPrompt: groundedPrompt,
      history: chatHistory,
      userMessage: input,
      numCtx,
      onToken: (t) => process.stdout.write(t)
    });
  } catch (err) {
    console.log(`\n${YELLOW}${err.message}${RESET}`);
    return;
  }
  console.log("\n");

  chatHistory.push({ role: "user", content: input });
  chatHistory.push({ role: "assistant", content: full });
  trimHistory();
}

async function handlePlainChatFallback(input, systemPrompt) {
  process.stdout.write(`${CYAN}HELENA:${RESET} `);
  let full = "";
  try {
    full = await chatStream({
      model: profile.preferences.model,
      systemPrompt,
      history: chatHistory,
      userMessage: input,
      numCtx: profile.preferences.numCtx,
      onToken: (t) => process.stdout.write(t)
    });
  } catch (err) {
    console.log(`\n${YELLOW}${err.message}${RESET}`);
    return;
  }
  console.log("\n");
  chatHistory.push({ role: "user", content: input });
  chatHistory.push({ role: "assistant", content: full });
  trimHistory();
}

async function main() {
  banner();

  const ollamaUp = await checkOllamaAvailable();
  if (!ollamaUp) {
    console.log(`${YELLOW}Note: Ollama not detected at localhost:11434. Weather, stock, and search commands will still work — install Ollama for conversational and vision features.${RESET}\n`);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${BOLD}you >${RESET} `
  });

  // Whether HELENA is actively processing something. While true, incoming
  // "line" events are dropped immediately and silently — key-mashing or
  // impatient Enter presses while HELENA is thinking should have zero
  // effect, not queue up and fire off as delayed replies to garbage input.
  // `busy` flips true synchronously the instant the first line event
  // fires (before any await), so even a burst of Enter presses delivered
  // in one input chunk gets rejected past the first line. `rl.pause()`
  // also stops readline from echoing further keystrokes while busy, so
  // nothing visually collides with the streamed response either.
  let busy = false;

  rl.prompt();

  rl.on("line", (line) => {
    if (busy) return; // silently dropped — see note above
    busy = true;
    rl.pause();

    routeLine(line).finally(() => {
      const reminder = drainDueReminders();
      if (reminder) {
        console.log(`\n${CYAN}HELENA:${RESET} ${reminder}\n`);
      }
      // Node buffers raw input at the OS level while a stream is paused,
      // then delivers all of it at once the moment resume() is called.
      // If we flipped `busy = false` before resuming, that buffered burst
      // (anything typed while HELENA was thinking) would fire as "fresh"
      // line events an instant later and get processed for real — which
      // is exactly the bug being fixed here. Instead: resume the stream,
      // but hold the busy flag a little longer so anything that flushes
      // in gets silently dropped too, then open up for real input only
      // after that flush window has passed.
      rl.resume();
      setTimeout(() => {
        busy = false;
        rl.prompt();
      }, 150);
    });
  });

  async function routeLine(line) {
    const input = line.trim();
    if (!input) return;

    if (input.startsWith("/")) {
      const [cmd, ...args] = input.slice(1).split(" ");
      switch (cmd) {
        case "help":
          help();
          break;
        case "weather":
          await handleWeather(args.join(" ") || null);
          break;
        case "stocks":
          await handleStocks();
          break;
        case "stock":
          await handleStock(args.join(" "));
          break;
        case "location":
          await handleLocation(args);
          break;
        case "search":
          await handleSearch(args.join(" "));
          break;
        case "read":
          handleRead(args.join(" "));
          break;
        case "files":
          handleFiles();
          break;
        case "image":
          await handleImage(args[0], args.slice(1).join(" "));
          break;
        case "open":
          await handleOpen(args.join(" "));
          break;
        case "remember":
          handleRemember(args.join(" "));
          break;
        case "project":
          handleProject(args);
          break;
        case "schedule":
          handleSchedule(args);
          break;
        case "profile":
          handleProfile(args);
          break;
        case "model":
          handleModel(args);
          break;
        case "exit":
        case "quit":
          console.log("Goodbye.");
          rl.close();
          process.exit(0);
        default:
          console.log(`${YELLOW}Unknown command. Type /help for the list.${RESET}`);
      }
      return;
    }

    // Plain-text shortcuts, no slash required:

    // "open <app or url>" — mirrors /open, since telling an assistant to
    // "open Spotify" or "pull up github.com" is the natural way to say it.
    // Guarded to short, non-sentence-like phrases so it doesn't misfire on
    // ordinary chat like "open a PR for me" or "open to feedback on this".
    const openMatch = input.match(/^(?:open|launch|pull up)\s+(.+)$/i);
    if (openMatch) {
      const candidate = openMatch[1].trim();
      const wordCount = candidate.split(/\s+/).length;
      const looksConversational = /[?]|^(a |an |the |to |up )/i.test(candidate);
      if (wordCount <= 4 && !looksConversational) {
        await handleOpen(candidate);
        return;
      }
    }

    // Paste a file path in an ordinary message and HELENA figures out what
    // to do with it — no /read or /image needed. Images go to the vision
    // model, text/code files get loaded into context, either way the rest
    // of the message (if any) is used as the actual question.
    const found = findExistingPath(input);
    if (found) {
      const remainder = input.replace(found.token, "").trim();
      if (isImageFile(found.resolved)) {
        await handleImage(found.resolved, remainder);
      } else {
        try {
          const file = readTextFile(found.resolved);
          attachedFiles.set(file.name, { content: file.content, truncated: file.truncated });
          console.log(`${DIM}Loaded ${file.name} into context.${RESET}`);
        } catch (err) {
          console.log(`${YELLOW}${err.message}${RESET}`);
          return;
        }
        await handleChat(remainder || `I just shared a file called "${found.resolved}". What can you tell me about it?`);
      }
      return;
    }

    await handleChat(input);
  }

  // Checks for due reminders on a timer, independent of user input, so a
  // reminder fires even if the user is away from the keyboard. If HELENA
  // is mid-response when one comes due, it's picked up by the "line"
  // handler's .finally() block instead, once that response finishes,
  // rather than interrupting output mid-stream.
  setInterval(() => {
    if (busy) return; // picked up by the "line" handler's .finally() instead
    const reminder = drainDueReminders();
    if (!reminder) return;

    // Redraw cleanly: clear the current prompt line, print the reminder,
    // then restore the prompt (and anything the user had half-typed).
    const partialLine = rl.line;
    const cursor = rl.cursor;
    readline.cursorTo(process.stdout, 0);
    readline.clearLine(process.stdout, 0);
    console.log(`${CYAN}HELENA:${RESET} ${reminder}\n`);
    rl.prompt(true);
    if (partialLine) {
      rl.write(partialLine);
      rl.cursor = cursor;
    }
  }, 15000);

  rl.on("close", () => {
    process.exit(0);
  });
}

main();
