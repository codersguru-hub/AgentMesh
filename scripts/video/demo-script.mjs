/**
 * Single source of truth for the demo run sheet.
 *
 * Both the live director (scripts/demo-director.mjs) and the autonomous renderer
 * (scripts/build-video.mjs) read their beats from docs/demo-script.md through this
 * module, so narration only ever has to be edited in one place.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const demoScriptPath = join(repoRoot, "docs", "demo-script.md");

/**
 * Parses the timed half of docs/demo-script.md. Headings look like
 * `## 0:25-0:55 - Deterministic context`, and each beat carries `**Visual:**` and
 * `**Narration:**` lines. Untimed prose elsewhere in that document uses headings without
 * a leading timestamp and is deliberately not matched.
 */
export function parseBeats(markdown) {
  const heading = /^##\s+(\d+):(\d{2})[–-](\d+):(\d{2})\s*[—-]\s*(.+?)\s*$/u;
  const field = /^\*\*(Visual|Narration|Callouts):\*\*\s*(.*)$/u;
  const beats = [];
  let current;
  for (const line of markdown.split(/\r?\n/u)) {
    const match = heading.exec(line);
    if (match) {
      current = {
        startSeconds: Number(match[1]) * 60 + Number(match[2]),
        endSeconds: Number(match[3]) * 60 + Number(match[4]),
        title: match[5],
        visual: "",
        narration: "",
        callouts: "",
        notes: []
      };
      beats.push(current);
      continue;
    }
    if (!current) continue;
    if (/^#{1,3}\s/u.test(line)) {
      current = undefined;
      continue;
    }
    const fieldMatch = field.exec(line);
    if (fieldMatch) {
      const value = fieldMatch[2].replace(/[“”]/gu, "").trim();
      if (fieldMatch[1] === "Visual") current.visual = value;
      else if (fieldMatch[1] === "Narration") current.narration = value;
      else current.callouts = value;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length > 0 && !trimmed.startsWith("**")) current.notes.push(trimmed);
  }
  return beats;
}

/** Reads and parses the run sheet, failing loudly rather than rendering a partial video. */
export function loadBeats(expectedCount) {
  if (!existsSync(demoScriptPath)) {
    throw new Error("docs/demo-script.md is missing - the run sheet is read from it.");
  }
  const beats = parseBeats(readFileSync(demoScriptPath, "utf8"));
  if (typeof expectedCount === "number" && beats.length !== expectedCount) {
    throw new Error(
      `docs/demo-script.md parsed to ${beats.length} timed beats but ${expectedCount} are wired. ` +
        "Update the beat table to match the script."
    );
  }
  return beats;
}

/** Formats seconds as the m:ss used throughout the demo script. */
export function clock(totalSeconds) {
  const whole = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
