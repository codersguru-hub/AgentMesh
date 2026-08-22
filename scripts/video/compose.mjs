/**
 * ffmpeg composition.
 *
 * Timing is driven by the narration, not by the nominal timings in the run sheet: each
 * beat lasts exactly as long as its synthesized audio, and that beat's frames are spread
 * across it. That keeps picture and voice locked together without any manual trimming.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const isWindows = process.platform === "win32";

function run(binary, args, { timeoutMs = 900000 } = {}) {
  return new Promise((settle, fail) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], shell: isWindows });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) settle({ stdout, stderr });
      else fail(new Error(`${binary} exited ${code}: ${stderr.trim().split(/\r?\n/u).slice(-4).join(" | ")}`));
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      fail(new Error(`${binary} could not start: ${error.message}`));
    });
  });
}

/** Seconds of audio or video in a media file. */
export async function probeDuration(path) {
  const { stdout } = await run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=nw=1:nk=1",
    quote(path)
  ]);
  const seconds = Number.parseFloat(stdout.trim());
  if (!Number.isFinite(seconds)) throw new Error(`could not read a duration from ${path}`);
  return seconds;
}

function quote(path) {
  return `"${path.replaceAll("\\", "/")}"`;
}

/** Re-encodes any TTS output to one uniform wav so concatenation cannot drift. */
export async function normalizeAudio(inputPath, outputPath) {
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", quote(inputPath),
    "-ar", "48000", "-ac", "2", "-c:a", "pcm_s16le",
    quote(outputPath)
  ]);
  return outputPath;
}

/** A gap between beats so one line of narration does not run into the next. */
export async function makeSilence(seconds, outputPath) {
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t", String(seconds), "-c:a", "pcm_s16le",
    quote(outputPath)
  ]);
  return outputPath;
}

export async function concatAudio(files, listPath, outputPath) {
  writeFileSync(listPath, files.map((file) => `file '${file.replaceAll("\\", "/")}'`).join("\n"), "utf8");
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", quote(listPath),
    "-c:a", "pcm_s16le", "-ar", "48000", "-ac", "2",
    quote(outputPath)
  ]);
  return outputPath;
}

/**
 * The concat demuxer drops the final entry's duration, so the last frame is listed twice
 * - once with its duration and once to close the list.
 */
export function writeFrameList(entries, listPath) {
  const lines = [];
  for (const entry of entries) {
    lines.push(`file '${entry.path.replaceAll("\\", "/")}'`);
    lines.push(`duration ${entry.duration.toFixed(3)}`);
  }
  const last = entries.at(-1);
  if (last) lines.push(`file '${last.path.replaceAll("\\", "/")}'`);
  writeFileSync(listPath, lines.join("\n"), "utf8");
  return listPath;
}

/** Encodes the frame list against the narration track into the final mp4. */
export async function renderVideo({ frameListPath, audioPath, outputPath, fps = 30, crf = 20 }) {
  await run("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "concat", "-safe", "0", "-i", quote(frameListPath),
    "-i", quote(audioPath),
    "-vf", `fps=${fps},format=yuv420p`,
    "-c:v", "libx264", "-preset", "medium", "-crf", String(crf),
    "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart",
    "-shortest",
    quote(outputPath)
  ]);
  return outputPath;
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const hh = String(Math.floor(ms / 3600000)).padStart(2, "0");
  const mm = String(Math.floor((ms % 3600000) / 60000)).padStart(2, "0");
  const ss = String(Math.floor((ms % 60000) / 1000)).padStart(2, "0");
  const mmm = String(ms % 1000).padStart(3, "0");
  return `${hh}:${mm}:${ss},${mmm}`;
}

/**
 * Writes a subtitle sidecar. Long narration is split into readable cues spread evenly
 * across the beat, which is accurate enough to follow and costs no extra render time.
 */
export function writeSrt(beats, outputPath) {
  const cues = [];
  let index = 0;
  for (const beat of beats) {
    const sentences = beat.narration
      .split(/(?<=[.!?])\s+/u)
      .map((part) => part.trim())
      .filter(Boolean);
    const parts = sentences.length > 0 ? sentences : [beat.narration];
    const totalChars = parts.reduce((sum, part) => sum + part.length, 0) || 1;
    let cursor = beat.startedAt;
    for (const part of parts) {
      const span = (part.length / totalChars) * beat.duration;
      index += 1;
      cues.push(`${index}\n${srtTime(cursor)} --> ${srtTime(cursor + span)}\n${part}\n`);
      cursor += span;
    }
  }
  writeFileSync(outputPath, cues.join("\n"), "utf8");
  return outputPath;
}

export async function probeFfmpeg() {
  try {
    const { stdout } = await run("ffmpeg", ["-version"], { timeoutMs: 15000 });
    return stdout.split(/\r?\n/u)[0] ?? "ffmpeg";
  } catch {
    return null;
  }
}
