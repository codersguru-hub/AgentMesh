/**
 * Autonomous demo-video renderer.
 *
 * Produces docs/video/belay-demo.mp4 with no screen recording and no live narration:
 *
 *   1. narration is synthesized per beat from docs/demo-script.md,
 *   2. evidence is captured by running the real verifier commands and driving the running
 *      daemon, including approving the protected command in the live Cockpit,
 *   3. frames are rendered from that evidence and composited against the narration track.
 *
 * Beat length is whatever its narration takes to speak, so picture and voice stay locked
 * without manual trimming.
 *
 * Usage:
 *   node scripts/build-video.mjs --check      preflight only
 *   node scripts/build-video.mjs              full render
 *   node scripts/build-video.mjs --reuse      keep existing audio/evidence, re-render video
 *
 * Flags: --out <path>, --fps <n>, --profile <voice>, --engine <tts engine>,
 *        --tts <voicebox|edge>, --gap <seconds>, --keep-frames
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clock, loadBeats, repoRoot } from "./video/demo-script.mjs";
import * as evidence from "./video/evidence.mjs";
import * as compose from "./video/compose.mjs";
import { architectureDiagram, createRenderer, hasArchitectureDiagram } from "./video/visuals.mjs";
import { probeTts, synthesize } from "./video/tts.mjs";

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const outDir = join(repoRoot, "docs", "video");
const buildDir = join(outDir, "build");
const audioDir = join(buildDir, "audio");
const shotsDir = join(buildDir, "shots");
const outputPath = option("out", join(outDir, "belay-demo.mp4"));
const fps = Number(option("fps", "30"));
const gapSeconds = Number(option("gap", "0.7"));
const ttsOptions = {
  ttsEngine: option("tts", "voicebox"),
  profile: option("profile", "Voice Top"),
  engine: option("engine", "chatterbox")
};
const reuse = flag("reuse");

const log = (message) => process.stdout.write(`${message}\n`);
const step = (message) => process.stdout.write(`\n▸ ${message}\n`);

// ---- transcript selection -----------------------------------------------------------
/** Keeps a transcript readable on screen: the lines that carry the claim, nothing else. */
function selectLines(output, { keep, max = 30 }) {
  const lines = output.split(/\r?\n/u).map((line) => line.trimEnd());
  const picked = lines.filter((line) => line.trim().length > 0 && keep(line));
  return (picked.length > 0 ? picked : lines.filter((line) => line.trim().length > 0)).slice(-max);
}

function heroLines(output) {
  const start = output.indexOf("{");
  const end = output.lastIndexOf("}");
  const block = start >= 0 && end > start ? output.slice(start, end + 1).split(/\r?\n/u) : [];
  const summary = selectLines(output, {
    keep: (line) => /Test Files|Tests\s+\d|Duration/u.test(line),
    max: 4
  });
  return ["$ npm run demo:verify", "", ...block.slice(0, 30), "", ...summary];
}

function sweepLines(output) {
  const checks = selectLines(output, { keep: (line) => line.includes("✓"), max: 18 });
  const summary = selectLines(output, {
    keep: (line) => /Test Files|Tests\s+\d/u.test(line),
    max: 3
  });
  return ["$ npm run verify:no-leaks", "", ...checks, "", ...summary];
}

/**
 * Approves the pending card in the live Cockpit. The button's label sits in a nested
 * element, so the accessible name is not reliable on its own; text and the card's own
 * A/R keyboard shortcut are tried in turn before giving up.
 */
async function approveInCockpit(page) {
  const attempts = [
    async () => {
      const button = page.getByRole("button", { name: /approve/iu }).first();
      await button.waitFor({ state: "visible", timeout: 4000 });
      await button.click({ timeout: 4000 });
    },
    async () => {
      const byText = page.locator("button", { hasText: /approve/iu }).first();
      await byText.waitFor({ state: "visible", timeout: 4000 });
      await byText.click({ timeout: 4000 });
    },
    async () => {
      await page.locator("text=/approve\\s*&\\s*execute/i").first().click({ timeout: 4000 });
    },
    async () => {
      await page.keyboard.press("a");
      await page.waitForTimeout(600);
    }
  ];
  const failures = [];
  for (const attempt of attempts) {
    try {
      await attempt();
      return;
    } catch (error) {
      failures.push(error instanceof Error ? error.message.split("\n")[0] : String(error));
    }
  }
  throw new Error(`could not approve in the cockpit: ${failures.join(" | ")}`);
}

/**
 * Clears the governance queue the seed leaves behind, before the opening shot.
 *
 * Two things depend on this. The cockpit only counts *approved* facts as shared
 * knowledge, so an unapproved queue makes the fleet look idle in the first frames; and
 * the approval beat needs its own request to be the only pending card, so it cannot click
 * a leftover one by mistake.
 */
async function settlePendingApprovals(renderer) {
  const page = await renderer.cockpitPage(evidence.daemonOrigin);
  let settled = 0;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const snapshot = await evidence.dashboard().catch(() => null);
    const pending = snapshot?.summary?.pendingApprovals ?? 0;
    if (pending === 0) break;
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    try {
      await approveInCockpit(page);
    } catch {
      break;
    }
    await page.waitForTimeout(1800);
    settled += 1;
  }
  return settled;
}

// ---- the beat table -----------------------------------------------------------------
/**
 * One entry per timed beat in docs/demo-script.md, in order. `gather` collects real
 * evidence; `frames` turns it into pictures. They are separate so `--reuse` can re-render
 * pictures without re-running the daemon work.
 */
const BEATS = [
  {
    slug: "problem",
    expect: /problem and category/iu,
    async gather(ctx) {
      // The previous render's race task would otherwise still hold its leases and appear
      // in the work queue, putting renderer scaffolding in the opening shot.
      const released = await evidence.releaseRacePaths();
      if (released > 0) log(`     cleared ${released} leftover race task(s) from an earlier render`);
      const settled = await settlePendingApprovals(ctx.renderer);
      if (settled > 0) log(`     settled ${settled} seeded approval(s) so the fleet reads as live`);
      // Reindex last: anything that touched the tree earlier in preparation would
      // otherwise leave the manifest reading STALE in the opening shot.
      const tokens = await evidence.reindexProject();
      if (tokens) log(`     reindexed: manifest is ${tokens} tokens and fresh`);
      const page = await ctx.renderer.cockpitPage(evidence.daemonOrigin);
      await page.reload({ waitUntil: "networkidle" });
      await ctx.renderer.captureCockpit(evidence.daemonOrigin, join(shotsDir, "overview.png"), {
        settleMs: 1500
      });
      return {};
    },
    async frames(ctx) {
      return [
        await ctx.renderer.cardFrame({
          ...ctx.chrome,
          name: "a-title",
          sub: "Local control plane for coding agents",
          heading: "Agents don't share state.",
          body: "Independent agents rescan the same repository, collide on the same files, and ask for credentials through prompt-visible workflows.",
          pills: ["Claude Code", "Codex", "Antigravity", "OpenCode"]
        }),
        await ctx.renderer.imageFrame({
          ...ctx.chrome,
          name: "b-cockpit",
          imagePath: join(shotsDir, "overview.png")
        })
      ];
    }
  },
  {
    slug: "context",
    expect: /deterministic context/iu,
    async gather(ctx) {
      const result = await evidence.heroVerifier();
      evidence.saveLog(buildDir, "hero-verifier", result.output);
      return { lines: heroLines(result.output), ok: result.code === 0 };
    },
    frames: (ctx, data) =>
      ctx.renderer.terminalFrames({ ...ctx.chrome, label: "npm run demo:verify", lines: data.lines })
  },
  {
    slug: "collision",
    expect: /collision/iu,
    async gather() {
      const race = await evidence.runAcquisitionRace();
      evidence.saveLog(buildDir, "acquisition-race", race.lines.join("\n"));
      return { lines: race.lines, ok: race.ok };
    },
    frames: (ctx, data) =>
      ctx.renderer.terminalFrames({ ...ctx.chrome, label: "atomic acquisition", lines: data.lines })
  },
  {
    slug: "vault",
    expect: /zero-leak vault/iu,
    async gather() {
      const result = await evidence.noLeakSweep();
      evidence.saveLog(buildDir, "no-leak-sweep", result.output);
      return { lines: sweepLines(result.output), ok: result.code === 0 };
    },
    frames: (ctx, data) =>
      ctx.renderer.terminalFrames({ ...ctx.chrome, label: "npm run verify:no-leaks", lines: data.lines })
  },
  {
    slug: "approval",
    expect: /approval intercept/iu,
    /**
     * The one beat that needs the UI driven rather than read: request the protected
     * command, photograph the pending card, click Approve in the live Cockpit, then
     * photograph whatever the daemon actually recorded.
     */
    async gather(ctx) {
      const request = await evidence.requestApproval();
      const page = await ctx.renderer.cockpitPage(evidence.daemonOrigin);
      await page.reload({ waitUntil: "networkidle" });
      await page.waitForTimeout(1200);
      await ctx.renderer.captureCockpit(evidence.daemonOrigin, join(shotsDir, "approval-pending.png"), {
        settleMs: 400
      });

      await approveInCockpit(page);

      const outcome = await evidence.waitForTerminalApproval(request.approvalId);
      await page.waitForTimeout(1500);
      await ctx.renderer.captureCockpit(evidence.daemonOrigin, join(shotsDir, "approval-decided.png"), {
        settleMs: 400
      });

      const lines = [
        "$ npm run demo:request-approval",
        "",
        `  requester        ${request.requester}`,
        `  target           ${request.targetAlias}`,
        `  command          ${request.commandId}`,
        `  policy reason    ${request.policyReason}`,
        `  action digest    ${request.actionDigest}`,
        "",
        "  PENDING          nothing executes while this card is open",
        "",
        `  DECIDED          ${outcome.status}`,
        `  correlation      ${outcome.correlationId ?? request.correlationId}`
      ];
      evidence.saveLog(buildDir, "approval", lines.join("\n"));
      return { lines, status: outcome.status };
    },
    async frames(ctx, data) {
      const shots = [];
      for (const [name, file] of [
        ["a-pending", "approval-pending.png"],
        ["b-decided", "approval-decided.png"]
      ]) {
        const path = join(shotsDir, file);
        if (existsSync(path)) {
          shots.push(await ctx.renderer.imageFrame({ ...ctx.chrome, name, imagePath: path }));
        }
      }
      const terminal = await ctx.renderer.terminalFrames({
        ...ctx.chrome,
        label: "protected command",
        lines: data.lines,
        maxFrames: 14
      });
      return [shots[0], ...terminal, ...shots.slice(1)].filter(Boolean);
    }
  },
  {
    slug: "cloud",
    expect: /gemini cloud arbiter/iu,
    async gather() {
      const smoke = await evidence.cloudSmoke();
      if (smoke) {
        evidence.saveLog(buildDir, "cloud-smoke", smoke.output);
        // Show the deployment facts and the egress verdicts. The remediation block that
        // appears when this machine has no credentials is collapsed to a single honest
        // line rather than eight lines of setup instructions on screen.
        const keep =
          /^\s*(service|region|revision|url|ingress|credentials|model|generatedAt|latency|advisory|status|REFUSED|LEAKED|NOT AUTHENTICATED|\d+\/\d+ forbidden|\[\d\/3\])/u;
        const lines = smoke.output
          .split(/\r?\n/u)
          .map((line) => line.trimEnd())
          .filter((line) => keep.test(line))
          .map((line) =>
            line.includes("NOT AUTHENTICATED")
              ? "  advisory     unavailable on this machine (no application default credentials)"
              : line
          );
        return { lines: ["$ npm run smoke:cloud", "", ...lines.slice(0, 26)] };
      }
      // scripts/smoke-cloud.mjs is not in the tree, so the egress boundary itself is the
      // local evidence: what leaves the machine, and what is refused before it can.
      const result = await evidence.cloudEgressProof();
      evidence.saveLog(buildDir, "cloud-egress", result.output);
      return {
        lines: [
          "$ npx vitest run tests/cloud-egress.integration.test.ts",
          "",
          ...selectLines(result.output, { keep: (line) => line.includes("✓"), max: 14 }),
          "",
          ...selectLines(result.output, { keep: (line) => /Test Files|Tests\s+\d/u.test(line), max: 2 })
        ],
        degraded: true
      };
    },
    frames: (ctx, data) =>
      ctx.renderer.terminalFrames({ ...ctx.chrome, label: "cloud egress boundary", lines: data.lines })
  },
  {
    slug: "proof",
    expect: /proof and vision/iu,
    async gather() {
      const snapshot = await evidence.dashboard().catch(() => ({}));
      return { summary: snapshot.summary ?? {}, manifest: snapshot.manifest ?? {} };
    },
    async frames(ctx, data) {
      const frames = [];
      if (hasArchitectureDiagram()) {
        frames.push(
          await ctx.renderer.imageFrame({ ...ctx.chrome, name: "a-architecture", imagePath: architectureDiagram })
        );
      }
      frames.push(
        await ctx.renderer.cardFrame({
          ...ctx.chrome,
          name: "b-close",
          sub: "Belay",
          heading: "Shared state. Safe execution. Human authority.",
          body: "Deterministic context, atomic coordination, secret-safe execution, and a human decision gate across heterogeneous coding agents.",
          pills: [
            `${data.summary.activeTasks ?? 0} active tasks`,
            `${data.summary.lockedFiles ?? 0} leased files`,
            `${data.manifest.estimatedTokens ?? "?"} token manifest`
          ]
        })
      );
      return frames;
    }
  }
];

// ---- preflight ----------------------------------------------------------------------
async function preflight() {
  const results = [];
  const add = (level, message, hint) => results.push({ level, message, hint });

  const ffmpeg = await compose.probeFfmpeg();
  add(ffmpeg ? "ok" : "fail", ffmpeg ? ffmpeg.slice(0, 48) : "ffmpeg not on PATH", "Install ffmpeg.");

  try {
    const snapshot = await evidence.dashboard();
    add("ok", `daemon reachable at ${evidence.daemonOrigin}`);
    const summary = snapshot.summary ?? {};
    const seeded = (summary.activeTasks ?? 0) > 0 || (summary.knowledgeFacts ?? 0) > 0;
    add(seeded ? "ok" : "warn", seeded ? "cockpit seeded" : "cockpit empty (will seed)");
  } catch {
    add("fail", `daemon unreachable at ${evidence.daemonOrigin}`, "Run node bin/belay.js start first.");
  }

  const tts = await probeTts(ttsOptions);
  add(tts.ok ? "ok" : "fail", `tts: ${tts.detail}`, "Start Voicebox, or pass --tts edge.");

  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ channel: "chrome", headless: true });
    await browser.close();
    add("ok", "playwright + installed chrome");
  } catch (error) {
    add("fail", `playwright cannot launch chrome: ${error instanceof Error ? error.message.split("\n")[0] : error}`);
  }

  if (!existsSync(evidence.CLOUD_SMOKE)) {
    add("warn", "scripts/smoke-cloud.mjs missing", "The cloud beat falls back to the egress boundary test.");
  }
  if (!hasArchitectureDiagram()) {
    add("warn", "docs/assets/belay-architecture.png missing", "The closing beat will skip the diagram.");
  }

  for (const { level, message, hint } of results) {
    const badge = level === "ok" ? "  ok  " : level === "warn" ? " warn " : " fail ";
    log(`${badge} ${message}`);
    if (level !== "ok" && hint) log(`       ${hint}`);
  }
  return results.every((result) => result.level !== "fail");
}

// ---- the render ---------------------------------------------------------------------
async function main() {
  log("Belay video renderer\n");
  const ready = await preflight();
  if (!ready) {
    log("\npreflight failed - fix the items above");
    process.exit(1);
  }
  if (flag("check")) {
    const beats = loadBeats(BEATS.length);
    log(`\nrun sheet: ${beats.length} beats`);
    for (const [index, beat] of beats.entries()) {
      log(`  ${clock(beat.startSeconds)}-${clock(beat.endSeconds)} ${beat.title} (${BEATS[index].slug})`);
    }
    log("\nready to render");
    return;
  }

  const beats = loadBeats(BEATS.length);
  for (const [index, beat] of beats.entries()) {
    if (!BEATS[index].expect.test(beat.title)) {
      log(` warn  beat ${index + 1} is titled "${beat.title}"; the renderer expected ${BEATS[index].expect}`);
    }
  }

  for (const dir of [outDir, buildDir, audioDir, shotsDir]) mkdirSync(dir, { recursive: true });

  step("preparing the daemon");
  const seeded = await evidence.ensureSeeded();
  log(
    seeded.ran
      ? `  seeded the cockpit (${seeded.activeTasks} active task(s))`
      : "  cockpit already shows live work"
  );
  if (seeded.ran && !seeded.seeded) {
    log("  warn: seeding produced no active tasks - the opening shot will look idle");
  }

  step("synthesizing narration");
  const audio = [];
  for (const [index, beat] of beats.entries()) {
    const raw = join(audioDir, `beat-${index + 1}-raw.wav`);
    const normalized = join(audioDir, `beat-${index + 1}.wav`);
    if (reuse && existsSync(normalized)) {
      const duration = await compose.probeDuration(normalized);
      audio.push({ path: normalized, duration });
      log(`  ${index + 1}. reused (${duration.toFixed(1)}s)`);
      continue;
    }
    await synthesize(beat.narration, raw, {
      ...ttsOptions,
      onChunk: (part, total) => log(`     beat ${index + 1}: chunk ${part}/${total}`)
    });
    await compose.normalizeAudio(raw, normalized);
    const duration = await compose.probeDuration(normalized);
    audio.push({ path: normalized, duration });
    log(`  ${index + 1}. ${beat.title} - ${duration.toFixed(1)}s`);
  }

  step("capturing evidence and rendering frames");
  const renderer = await createRenderer(buildDir);
  const timeline = [];
  try {
    const totalNarration = audio.reduce((sum, item) => sum + item.duration, 0);
    let elapsed = 0;
    for (const [index, beat] of beats.entries()) {
      const plan = BEATS[index];
      const ctx = {
        renderer,
        chrome: {
          slug: plan.slug,
          title: beat.title,
          index: index + 1,
          total: beats.length,
          progress: totalNarration > 0 ? elapsed / totalNarration : 0
        }
      };
      const data = (await plan.gather(ctx)) ?? {};
      const frames = await plan.frames(ctx, data);
      if (!frames || frames.length === 0) throw new Error(`beat ${index + 1} produced no frames`);
      timeline.push({ beat, frames, duration: audio[index].duration, startedAt: elapsed });
      elapsed += audio[index].duration + gapSeconds;
      log(`  ${index + 1}. ${plan.slug} - ${frames.length} frames / ${audio[index].duration.toFixed(1)}s`);
      if (data.degraded) log("     (cloud beat used the egress boundary test as evidence)");
    }
  } finally {
    await renderer.close();
  }

  step("compositing");
  const silence = await compose.makeSilence(gapSeconds, join(buildDir, "gap.wav"));
  const audioParts = [];
  for (const [index, item] of audio.entries()) {
    audioParts.push(item.path);
    if (index < audio.length - 1) audioParts.push(silence);
  }
  const narration = await compose.concatAudio(
    audioParts,
    join(buildDir, "audio-list.txt"),
    join(buildDir, "narration.wav")
  );

  const frameEntries = [];
  for (const [index, entry] of timeline.entries()) {
    const isLast = index === timeline.length - 1;
    const span = entry.duration + (isLast ? 0 : gapSeconds);
    const per = span / entry.frames.length;
    for (const frame of entry.frames) frameEntries.push({ path: frame, duration: per });
  }
  const frameList = compose.writeFrameList(frameEntries, join(buildDir, "frames.txt"));

  await compose.renderVideo({ frameListPath: frameList, audioPath: narration, outputPath, fps });
  const srtPath = outputPath.replace(/\.mp4$/iu, ".srt");
  compose.writeSrt(
    timeline.map((entry) => ({
      narration: entry.beat.narration,
      startedAt: entry.startedAt,
      duration: entry.duration
    })),
    srtPath
  );

  const finalDuration = await compose.probeDuration(outputPath);
  const bytes = readFileSync(outputPath).length;
  if (!flag("keep-frames")) rmSync(join(buildDir, "frames"), { recursive: true, force: true });

  log(`\ndone: ${outputPath}`);
  log(`  ${clock(finalDuration)} (${finalDuration.toFixed(1)}s), ${(bytes / 1024 / 1024).toFixed(1)} MB, ${fps} fps`);
  log(`  subtitles: ${srtPath}`);
  log(`  evidence logs: ${join(buildDir, "logs")}`);
  if (finalDuration > 240) {
    log(`\n  note: ${clock(finalDuration)} is over the 4:00 outline. Shorten narration in docs/demo-script.md to fit.`);
  }
  writeFileSync(
    join(buildDir, "render.json"),
    JSON.stringify(
      {
        renderedAt: new Date().toISOString(),
        output: outputPath,
        durationSeconds: finalDuration,
        fps,
        tts: ttsOptions,
        beats: timeline.map((entry, index) => ({
          index: index + 1,
          title: entry.beat.title,
          startedAt: entry.startedAt,
          duration: entry.duration,
          frames: entry.frames.length
        }))
      },
      null,
      2
    ),
    "utf8"
  );
}

main().catch((error) => {
  process.stderr.write(`\nrender failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
