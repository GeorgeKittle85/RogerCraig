// Tool definitions passed to Ollama's /api/chat `tools` parameter (the
// same function-calling schema OpenAI-style APIs use — supported by
// Ollama for tool-capable models like llama3.1, qwen2.5, mistral-nemo,
// etc.). Each tool maps 1:1 to a real action in desktop.js — nothing here
// is narrated or assumed; execute() always runs the actual command and
// returns what genuinely happened.

import { openTarget, openUrlInBrowser, closeApp, webSearchInBrowser, getDirections, spotifySearch, takeScreenshot, setVolume, createNote, getSystemStatus } from "./desktop.js";

export const TOOLS = [
  {
    type: "function",
    function: {
      name: "open_app",
      description: "Open a native application by name.",
      parameters: {
        type: "object",
        properties: { app: { type: "string", description: "Exact app name, e.g. 'Spotify', 'Safari', 'Google Chrome'" } },
        required: ["app"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "close_app",
      description: "Quit/close a running native application.",
      parameters: {
        type: "object",
        properties: { app: { type: "string", description: "Exact app name to quit" } },
        required: ["app"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "open_url",
      description: "Open a URL in a web browser.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to open" },
          browser: { type: "string", description: "Optional specific browser app name, e.g. 'Google Chrome'. Omit to use the default browser." }
        },
        required: ["url"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "web_search_in_browser",
      description: "Search the web for a query by opening a search-results page in a browser.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          browser: { type: "string", description: "Optional specific browser app name, e.g. 'Google Chrome'." }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_directions",
      description: "Open Apple Maps with directions to a destination (macOS only).",
      parameters: {
        type: "object",
        properties: { destination: { type: "string", description: "Address, place name, or 'nearest <thing>' query" } },
        required: ["destination"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "spotify_search",
      description: "Open Spotify and search for a song, artist, or album. Does not start playback automatically — the user still presses play.",
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "take_screenshot",
      description: "Capture a screenshot of the current screen and save it to the Desktop (macOS).",
      parameters: { type: "object", properties: {} }
    }
  },
  {
    type: "function",
    function: {
      name: "set_volume",
      description: "Set the system output volume (macOS).",
      parameters: {
        type: "object",
        properties: { level: { type: "number", description: "Volume level, 0-100" } },
        required: ["level"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "create_note",
      description: "Create a new note in Notes.app (macOS).",
      parameters: {
        type: "object",
        properties: {
          title: { type: "string" },
          body: { type: "string" }
        },
        required: ["title"]
      }
    }
  },
  {
    type: "function",
    function: {
      name: "get_system_status",
      description: "Check basic system status: current time and, on macOS, battery percentage and charging state.",
      parameters: { type: "object", properties: {} }
    }
  }
];

export function describeToolCall(name, args) {
  switch (name) {
    case "open_app": return `Opening ${args.app}...`;
    case "close_app": return `Closing ${args.app}...`;
    case "open_url": return `Opening ${args.url}${args.browser ? ` in ${args.browser}` : ""}...`;
    case "web_search_in_browser": return `Searching for "${args.query}"${args.browser ? ` in ${args.browser}` : ""}...`;
    case "get_directions": return `Getting directions to "${args.destination}"...`;
    case "spotify_search": return `Searching Spotify for "${args.query}"...`;
    case "take_screenshot": return `Taking a screenshot...`;
    case "set_volume": return `Setting volume to ${args.level}...`;
    case "create_note": return `Creating a note titled "${args.title}"...`;
    case "get_system_status": return `Checking system status...`;
    default: return `Running ${name}...`;
  }
}

// Executes a tool call for real and returns a result object suitable for
// feeding back to the model as a tool message. Never throws to the
// caller — failures are captured as { ok: false, error } so the model
// gets an honest, grounded result either way.
export async function executeTool(name, args) {
  try {
    switch (name) {
      case "open_app":
        return await openTarget(args.app);
      case "close_app":
        return await closeApp(args.app);
      case "open_url":
        return await openUrlInBrowser(args.url, args.browser);
      case "web_search_in_browser":
        return await webSearchInBrowser(args.query, args.browser);
      case "get_directions":
        return await getDirections(args.destination);
      case "spotify_search":
        return await spotifySearch(args.query);
      case "take_screenshot":
        return await takeScreenshot();
      case "set_volume":
        return await setVolume(args.level);
      case "create_note":
        return await createNote(args.title, args.body);
      case "get_system_status":
        return await getSystemStatus();
      default:
        return { ok: false, error: `Unknown tool: ${name}` };
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
