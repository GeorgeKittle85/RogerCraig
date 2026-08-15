// Real desktop actions HELENA can execute on macOS (with basic Windows/
// Linux fallbacks where sensible). Deliberately narrow: named apps, URLs,
// map destinations, and Spotify search terms — not arbitrary shell access.
// Letting an LLM's free-text output run arbitrary commands is a real
// prompt-injection risk (malicious file/page content could try to trigger
// it); every action here is a specific, bounded operation instead.
//
// Every function returns { ok: true, message } or throws — callers (the
// tool-calling loop in bin/helena.js) feed the real result back to the
// model, so replies are grounded in what actually happened rather than
// the model guessing/narrating success.

import { exec } from "child_process";

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout, stderr) => {
      if (err) reject(new Error(stderr?.trim() || err.message));
      else resolve(stdout?.trim() || "");
    });
  });
}

const PLATFORM = process.platform;

function looksLikeUrl(s) {
  return /^https?:\/\//i.test(s) || /^[\w-]+(\.[\w-]+)+(\/.*)?$/.test(s);
}

function normalizeUrl(target) {
  if (/^https?:\/\//i.test(target)) return target;
  return `https://${target}`;
}

// --- open an app or URL ------------------------------------------------

export async function openTarget(rawTarget) {
  const target = rawTarget.trim();
  const isUrl = looksLikeUrl(target);
  const normalized = isUrl ? normalizeUrl(target) : target;

  let cmd;
  if (PLATFORM === "darwin") {
    cmd = isUrl ? `open "${normalized}"` : `open -a "${normalized}"`;
  } else if (PLATFORM === "win32") {
    cmd = `start "" "${normalized}"`;
  } else {
    cmd = `xdg-open "${normalized}"`;
  }

  try {
    await run(cmd);
    return { ok: true, message: `Opened ${normalized}${isUrl ? "" : " (app)"}.`, target: normalized, isUrl };
  } catch (err) {
    if (!isUrl && PLATFORM === "darwin") {
      throw new Error(`Couldn't find an app named "${rawTarget}". Check the exact name as it appears in Applications.`);
    }
    throw new Error(err.message);
  }
}

// --- open a URL in a specific browser -----------------------------------

export async function openUrlInBrowser(url, browser) {
  const normalized = normalizeUrl(url.trim());
  if (!browser) return openTarget(normalized);

  let cmd;
  if (PLATFORM === "darwin") {
    cmd = `open -a "${browser}" "${normalized}"`;
  } else {
    // No clean cross-platform "open in specific browser" without knowing
    // the executable name/path, so fall back to the OS default opener.
    return openTarget(normalized);
  }

  try {
    await run(cmd);
    return { ok: true, message: `Opened ${normalized} in ${browser}.`, target: normalized };
  } catch (err) {
    throw new Error(`Couldn't open ${browser}. Check the exact app name and try again. (${err.message})`);
  }
}

// --- close/quit an app ---------------------------------------------------

export async function closeApp(name) {
  if (PLATFORM === "darwin") {
    try {
      await run(`osascript -e 'tell application "${name}" to quit'`);
      return { ok: true, message: `Quit ${name}.` };
    } catch (err) {
      throw new Error(`Couldn't quit "${name}" — it may not be running, or the name doesn't match exactly. (${err.message})`);
    }
  }
  if (PLATFORM === "win32") {
    try {
      await run(`taskkill /IM "${name}.exe" /F`);
      return { ok: true, message: `Closed ${name}.` };
    } catch (err) {
      throw new Error(`Couldn't close "${name}". (${err.message})`);
    }
  }
  try {
    await run(`pkill -f "${name}"`);
    return { ok: true, message: `Closed ${name}.` };
  } catch (err) {
    throw new Error(`Couldn't close "${name}". (${err.message})`);
  }
}

// --- search the web in a browser -----------------------------------------

export async function webSearchInBrowser(query, browser) {
  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  const result = browser ? await openUrlInBrowser(url, browser) : await openTarget(url);
  return { ok: true, message: `Opened a search for "${query}"${browser ? ` in ${browser}` : ""}.`, url: result.target };
}

// --- Apple Maps directions (macOS only — uses the maps:// URL scheme) ----

export async function getDirections(destination) {
  if (PLATFORM !== "darwin") {
    throw new Error("Directions via Apple Maps are only available on macOS.");
  }
  const url = `maps://?daddr=${encodeURIComponent(destination)}`;
  try {
    await run(`open "${url}"`);
    return { ok: true, message: `Opened directions to "${destination}" in Apple Maps.` };
  } catch (err) {
    throw new Error(`Couldn't open Maps for "${destination}". (${err.message})`);
  }
}

// --- Spotify search (opens the app to search results — does not auto-play,
//     since actually starting playback requires Spotify's authenticated
//     Web API, which is out of scope for a free/keyless local tool) --------

export async function spotifySearch(query) {
  if (PLATFORM !== "darwin" && PLATFORM !== "win32") {
    throw new Error("Spotify URI handling is only wired up for macOS/Windows here.");
  }
  const uri = `spotify:search:${encodeURIComponent(query)}`;
  try {
    if (PLATFORM === "darwin") {
      await run(`open -a Spotify "${uri}"`).catch(() => run(`open "${uri}"`));
    } else {
      await run(`start "" "${uri}"`);
    }
    return {
      ok: true,
      message: `Opened Spotify with a search for "${query}". Press play yourself — HELENA can't start playback without Spotify's authenticated API, which isn't part of this free/local setup.`
    };
  } catch (err) {
    throw new Error(`Couldn't reach Spotify. Is it installed? (${err.message})`);
  }
}

// --- screenshot (macOS) ---------------------------------------------------

export async function takeScreenshot() {
  if (PLATFORM !== "darwin") {
    throw new Error("Screenshot capture is only wired up for macOS here.");
  }
  const filePath = `${process.env.HOME}/Desktop/helena-screenshot-${Date.now()}.png`;
  try {
    await run(`screencapture -x "${filePath}"`);
    return { ok: true, message: `Saved a screenshot to ${filePath}.`, path: filePath };
  } catch (err) {
    throw new Error(`Couldn't take a screenshot. (${err.message})`);
  }
}

// --- system volume (macOS) ------------------------------------------------

export async function setVolume(level) {
  if (PLATFORM !== "darwin") {
    throw new Error("Volume control is only wired up for macOS here.");
  }
  const clamped = Math.max(0, Math.min(100, Number(level)));
  if (!isFinite(clamped)) {
    throw new Error(`"${level}" isn't a valid volume level — use a number 0-100.`);
  }
  try {
    await run(`osascript -e "set volume output volume ${clamped}"`);
    return { ok: true, message: `Set system volume to ${clamped}.` };
  } catch (err) {
    throw new Error(`Couldn't set the volume. (${err.message})`);
  }
}

// --- create a note in Notes.app (macOS) ------------------------------------

export async function createNote(title, body) {
  if (PLATFORM !== "darwin") {
    throw new Error("Notes.app integration is only wired up for macOS here.");
  }
  const safeTitle = (title || "HELENA note").replace(/"/g, '\\"');
  const safeBody = (body || "").replace(/"/g, '\\"');
  const script = `tell application "Notes" to make new note at folder "Notes" with properties {name:"${safeTitle}", body:"${safeTitle}<br>${safeBody}"}`;
  try {
    await run(`osascript -e '${script}'`);
    return { ok: true, message: `Created a note titled "${title}" in Notes.` };
  } catch (err) {
    throw new Error(`Couldn't create the note — Notes.app account setup varies by system. (${err.message})`);
  }
}

// --- quick system status (battery, time) -----------------------------------

export async function getSystemStatus() {
  const status = { time: new Date().toLocaleString() };
  if (PLATFORM === "darwin") {
    try {
      const batt = await run("pmset -g batt");
      const match = batt.match(/(\d+)%/);
      if (match) status.batteryPercent = match[1];
      status.charging = /AC Power/.test(batt);
    } catch {
      // best-effort — omit battery info if pmset isn't available/fails
    }
  }
  return { ok: true, message: "Fetched system status.", ...status };
}
