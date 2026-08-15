import fs from "fs";
import os from "os";
import path from "path";

const HELENA_DIR = path.join(os.homedir(), ".helena");
const PROFILE_PATH = path.join(HELENA_DIR, "profile.json");

const DEFAULT_PROFILE = {
  meta: {
    createdAt: new Date().toISOString(),
    version: 1
  },
  location: {
    // set via `helena location set "<city>"`
    label: null,
    lat: null,
    lon: null,
    timezone: null
  },
  preferences: {
    // free-form key/value, e.g. units: "imperial", model: "llama3.1"
    units: "imperial",
    model: "llama3.1",
    visionModel: "llava",
    // Caps Ollama's context window (and thus its KV-cache RAM usage) —
    // see src/ai.js for why this matters. Lower = less RAM, faster, but
    // less conversation history the model can actually see at once.
    numCtx: 4096
  },
  schedule: [
    // { id, text, when, createdAt }
  ],
  projects: [
    // { id, name, status, notes, createdAt, updatedAt }
  ],
  facts: [
    // { id, text, createdAt } — durable facts HELENA should recall about you
  ]
};

function ensureDir() {
  if (!fs.existsSync(HELENA_DIR)) {
    fs.mkdirSync(HELENA_DIR, { recursive: true });
  }
}

export function loadProfile() {
  ensureDir();
  if (!fs.existsSync(PROFILE_PATH)) {
    fs.writeFileSync(PROFILE_PATH, JSON.stringify(DEFAULT_PROFILE, null, 2));
    return structuredClone(DEFAULT_PROFILE);
  }
  try {
    const raw = fs.readFileSync(PROFILE_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    // Merge one level deep: without this, an existing profile.json's
    // top-level "preferences" object fully replaces the defaults, silently
    // dropping any new preference keys (like visionModel) added after that
    // file was first created.
    const merged = { ...structuredClone(DEFAULT_PROFILE), ...parsed };
    merged.preferences = { ...DEFAULT_PROFILE.preferences, ...(parsed.preferences || {}) };
    merged.location = { ...DEFAULT_PROFILE.location, ...(parsed.location || {}) };
    return merged;
  } catch (err) {
    console.error("Profile file is corrupted. Reinitializing with defaults.");
    fs.writeFileSync(PROFILE_PATH, JSON.stringify(DEFAULT_PROFILE, null, 2));
    return structuredClone(DEFAULT_PROFILE);
  }
}

export function saveProfile(profile) {
  ensureDir();
  fs.writeFileSync(PROFILE_PATH, JSON.stringify(profile, null, 2));
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

export function addFact(profile, text) {
  profile.facts.push({ id: genId(), text, createdAt: new Date().toISOString() });
  saveProfile(profile);
}

export function addProject(profile, name, status = "active", notes = "") {
  const now = new Date().toISOString();
  profile.projects.push({ id: genId(), name, status, notes, createdAt: now, updatedAt: now });
  saveProfile(profile);
}

export function addScheduleItem(profile, text, when = null, whenISO = null) {
  profile.schedule.push({
    id: genId(),
    text,
    when, // raw text the user typed, e.g. "tomorrow at 9am"
    whenISO, // parsed Date, ISO string, or null if unparseable
    notified: false,
    createdAt: new Date().toISOString()
  });
  saveProfile(profile);
}

export function setLocation(profile, { label, lat, lon, timezone }) {
  profile.location = { label, lat, lon, timezone };
  saveProfile(profile);
}

export function setPreference(profile, key, value) {
  profile.preferences[key] = value;
  saveProfile(profile);
}

// Builds a compact context block injected into the AI system prompt.
export function buildContextSummary(profile) {
  const lines = [];

  if (profile.location?.label) {
    lines.push(`Location: ${profile.location.label}`);
  }

  if (profile.facts.length) {
    lines.push("Known facts about the user:");
    for (const f of profile.facts.slice(-20)) {
      lines.push(`  - ${f.text}`);
    }
  }

  if (profile.projects.length) {
    lines.push("Ongoing projects:");
    for (const p of profile.projects.filter(p => p.status !== "archived").slice(-10)) {
      lines.push(`  - ${p.name} (${p.status})${p.notes ? ": " + p.notes : ""}`);
    }
  }

  if (profile.schedule.length) {
    lines.push("Upcoming schedule notes:");
    for (const s of profile.schedule.slice(-10)) {
      lines.push(`  - ${s.text}${s.when ? " [" + s.when + "]" : ""}`);
    }
  }

  return lines.join("\n");
}

export { PROFILE_PATH, HELENA_DIR };
