/**
 * Narration synthesis for the autonomous renderer.
 *
 * The default engine is the local Voicebox app, because it holds the cloned voice this
 * project's demo is narrated in and it runs entirely on the machine - no API key, no
 * upload of the script to a third party. `edge-tts` is available as a fallback for a
 * machine that does not have Voicebox running.
 *
 * Every engine resolves to the same contract: given text, write a wav to `outputPath`.
 */
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

const VOICEBOX_ORIGIN = process.env.VOICEBOX_URL ?? "http://127.0.0.1:17493";
const VOICEBOX_CLIENT = process.env.VOICEBOX_CLIENT_ID ?? "belay-video";

// A whole beat of narration in one request runs for minutes and gives no intermediate
// signal, so narration is synthesized a sentence group at a time and joined afterwards.
const MAX_CHUNK_CHARS = 220;

/** Generation time scales with text length; allow for it rather than guessing one bound. */
const chunkTimeoutMs = (text) => Math.min(1800000, Math.max(240000, text.length * 2000));

const headers = { "X-Voicebox-Client-Id": VOICEBOX_CLIENT, "Content-Type": "application/json" };

async function voiceboxJson(path, init = {}) {
  const response = await fetch(`${VOICEBOX_ORIGIN}${path}`, {
    ...init,
    headers: { ...headers, ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30000)
  });
  if (!response.ok) {
    throw new Error(`voicebox ${path} responded ${response.status}`);
  }
  return response.json();
}

/** Resolves a profile name to its id so callers can configure a voice by name. */
export async function resolveVoiceboxProfile(name) {
  const profiles = await voiceboxJson("/profiles");
  const list = Array.isArray(profiles) ? profiles : (profiles.profiles ?? []);
  const wanted = String(name).toLocaleLowerCase("en-US");
  const match = list.find((profile) => String(profile.name).toLocaleLowerCase("en-US") === wanted);
  if (!match) {
    const available = list.map((profile) => profile.name).join(", ") || "none";
    throw new Error(`Voicebox has no profile named "${name}". Available: ${available}`);
  }
  return match;
}

/**
 * The status endpoint is a server-sent event stream that stays open for the life of the
 * generation, so it must be read incrementally - awaiting the whole body would block
 * until the stream closed and time out on any narration long enough to matter.
 */
async function pollGeneration(generationId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastStatus = "unknown";

  while (Date.now() < deadline) {
    const controller = new AbortController();
    const guard = setTimeout(() => controller.abort(), 60000);
    try {
      const response = await fetch(`${VOICEBOX_ORIGIN}/generate/${generationId}/status`, {
        headers,
        signal: controller.signal
      });
      if (!response.ok || !response.body) throw new Error(`status stream responded ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const statuses = [...buffer.matchAll(/"status":\s*"([a-z_]+)"/gu)].map((match) => match[1]);
        lastStatus = statuses.at(-1) ?? lastStatus;
        if (lastStatus === "completed") {
          await reader.cancel().catch(() => {});
          return;
        }
        if (lastStatus === "error" || lastStatus === "failed") {
          await reader.cancel().catch(() => {});
          const detail = /"error":\s*"([^"]*)"/u.exec(buffer)?.[1] ?? "unknown error";
          throw new Error(`voicebox generation ${generationId} failed: ${detail}`);
        }
        buffer = buffer.slice(-4000);
      }
    } catch (error) {
      if (error instanceof Error && /generation .* failed/u.test(error.message)) throw error;
      // A dropped or timed-out stream is not fatal: reconnect and keep watching.
    } finally {
      clearTimeout(guard);
    }
    await new Promise((settle) => setTimeout(settle, 1500));
  }
  throw new Error(`voicebox generation ${generationId} did not finish (last status: ${lastStatus})`);
}

/** Splits narration on sentence boundaries, grouping up to `maxChars` per request. */
export function chunkNarration(text, maxChars = MAX_CHUNK_CHARS) {
  const sentences = text
    .split(/(?<=[.!?])\s+/u)
    .map((part) => part.trim())
    .filter(Boolean)
    // A single sentence longer than the limit has no sentence boundary to split on, so
    // fall back to clause boundaries rather than sending one very long request.
    .flatMap((sentence) =>
      sentence.length <= maxChars
        ? [sentence]
        : sentence
            .split(/(?<=[,;:—])\s+/u)
            .map((part) => part.trim())
            .filter(Boolean)
    );
  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    if (current.length > 0 && current.length + sentence.length + 1 > maxChars) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current.length === 0 ? sentence : `${current} ${sentence}`;
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks.length > 0 ? chunks : [text];
}

async function generateOne(text, outputPath, profileId, options) {
  const created = await voiceboxJson("/generate", {
    method: "POST",
    body: JSON.stringify({
      profile_id: profileId,
      text,
      language: options.language ?? "en",
      engine: options.engine ?? null,
      personality: options.personality ?? false,
      normalize: true
    })
  });
  const generationId = created.generation_id ?? created.id;
  if (!generationId) throw new Error("voicebox did not return a generation id");

  await pollGeneration(generationId, chunkTimeoutMs(text));

  const audio = await fetch(`${VOICEBOX_ORIGIN}/audio/${generationId}`, {
    headers: { "X-Voicebox-Client-Id": VOICEBOX_CLIENT },
    signal: AbortSignal.timeout(120000)
  });
  if (!audio.ok) throw new Error(`voicebox audio download responded ${audio.status}`);
  writeFileSync(outputPath, Buffer.from(await audio.arrayBuffer()));
  return generationId;
}

async function synthesizeWithVoicebox(text, outputPath, options) {
  const profile = options.profileId
    ? { id: options.profileId }
    : await resolveVoiceboxProfile(options.profile ?? "Voice Top");

  const chunks = chunkNarration(text);
  if (chunks.length === 1) {
    const generationId = await generateOne(text, outputPath, profile.id, options);
    return { engine: "voicebox", generationId, chunks: 1 };
  }

  const { concatAudio } = await import("./compose.mjs");
  const parts = [];
  const ids = [];
  for (const [index, chunk] of chunks.entries()) {
    const part = outputPath.replace(/\.wav$/iu, `-part${index + 1}.wav`);
    options.onChunk?.(index + 1, chunks.length, chunk);
    ids.push(await generateOne(chunk, part, profile.id, options));
    parts.push(part);
  }
  await concatAudio(parts, outputPath.replace(/\.wav$/iu, "-parts.txt"), outputPath);
  return { engine: "voicebox", generationId: ids.at(-1), chunks: chunks.length };
}

/**
 * edge-tts writes mp3, so the caller normalises everything to wav downstream. It needs
 * `pip install edge-tts` and no account.
 */
function synthesizeWithEdge(text, outputPath, options) {
  return new Promise((settle, fail) => {
    const voice = options.voice ?? "en-US-AndrewNeural";
    const child = spawn(
      "python",
      ["-m", "edge_tts", "--voice", voice, "--text", text, "--write-media", outputPath],
      { stdio: ["ignore", "ignore", "pipe"], shell: process.platform === "win32" }
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (code === 0) settle({ engine: "edge-tts", voice });
      else fail(new Error(`edge-tts exited ${code}: ${stderr.trim().split(/\r?\n/u).pop() ?? ""}`));
    });
    child.on("error", (error) => fail(new Error(`edge-tts could not start: ${error.message}`)));
  });
}

/** Synthesizes one narration line to `outputPath`. */
export async function synthesize(text, outputPath, options = {}) {
  const engine = options.ttsEngine ?? "voicebox";
  if (engine === "voicebox") return synthesizeWithVoicebox(text, outputPath, options);
  if (engine === "edge") return synthesizeWithEdge(text, outputPath, options);
  throw new Error(`Unknown TTS engine "${engine}". Use "voicebox" or "edge".`);
}

/** Reports whether the configured engine is reachable, for preflight. */
export async function probeTts(options = {}) {
  const engine = options.ttsEngine ?? "voicebox";
  if (engine !== "voicebox") return { ok: true, detail: `engine ${engine} (not probed)` };
  try {
    const profile = await resolveVoiceboxProfile(options.profile ?? "Voice Top");
    return { ok: true, detail: `voicebox profile "${profile.name}" (${profile.voice_type ?? "?"})` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
