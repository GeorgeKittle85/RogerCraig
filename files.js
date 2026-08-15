import fs from "fs";
import path from "path";
import os from "os";

const MAX_TEXT_CHARS = 8000; // keep injected file content bounded

const IMAGE_EXT_TO_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp"
};

export function isImageFile(filePath) {
  return Object.prototype.hasOwnProperty.call(IMAGE_EXT_TO_MIME, path.extname(filePath).toLowerCase());
}

export function readTextFile(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  const stat = fs.statSync(resolved);
  if (stat.isDirectory()) {
    throw new Error(`${resolved} is a directory, not a file.`);
  }
  let content = fs.readFileSync(resolved, "utf-8");
  let truncated = false;
  if (content.length > MAX_TEXT_CHARS) {
    content = content.slice(0, MAX_TEXT_CHARS);
    truncated = true;
  }
  return { path: resolved, name: path.basename(resolved), content, truncated };
}

// Returns raw base64 (no data: prefix) — Ollama's /api/chat expects bare
// base64 strings in the `images` array.
export function readImageAsBase64(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`File not found: ${resolved}`);
  }
  if (!isImageFile(resolved)) {
    throw new Error(`${resolved} doesn't look like a supported image type (png, jpg, gif, webp, bmp).`);
  }
  const buffer = fs.readFileSync(resolved);
  return { path: resolved, name: path.basename(resolved), base64: buffer.toString("base64") };
}

function expandHome(p) {
  if (p.startsWith("~")) return path.join(os.homedir(), p.slice(1));
  return p;
}

// Scans free-text (a normal chat message, not a slash command) for a token
// that resolves to an existing local file — so pasting a path works without
// requiring /read or /image first. Only considers tokens that look
// path-like (contain a slash or start with ~) to avoid false positives on
// ordinary words.
export function findExistingPath(input) {
  const tokens = input.split(/\s+/);
  for (const token of tokens) {
    const stripped = token.replace(/^["'(]+|["'),.;:!?]+$/g, "");
    if (!stripped) continue;
    if (!(stripped.includes("/") || stripped.includes("\\") || stripped.startsWith("~"))) continue;
    const resolved = expandHome(stripped);
    try {
      const abs = path.resolve(resolved);
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        return { token: stripped, resolved: abs };
      }
    } catch {
      // not a valid path — ignore and keep scanning
    }
  }
  return null;
}
