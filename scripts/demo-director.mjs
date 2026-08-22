/**
 * Demo director — drives the four-minute Belay recording as one continuous take.
 *
 * The recording is narrated live, so the director never races the presenter: each beat
 * starts its real command automatically, then waits for ENTER. The clock reports whether
 * the take is ahead of or behind the published timeline, but it never cuts a sentence off.
 *
 * Narration, visuals and beat timings are parsed from docs/demo-script.md so the script
 * the presenter rehearses and the script the director runs cannot drift apart. Only the
 * commands behind each beat live here.
 *
 * Usage:
 *   node scripts/demo-director.mjs --check       preflight only, nothing recorded
 *   node scripts/demo-director.mjs --rehearse    walk the beats, skip the commands
 *   node scripts/demo-director.mjs               the take (on-camera window)
 *   node scripts/demo-director.mjs --prompter    cue cards and clock (off-camera window)
 *
 * Flags: --fail-closed adds the vault-locked negative beat, --from <n> starts at beat n.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const projectRoot = resolve(process.env.BELAY_PROJECT_ROOT ?? repoRoot);
const mcpEndpoint = process.env.BELAY_MCP_URL ?? "http://127.0.0.1:3420/mcp";
const daemonOrigin = new URL(mcpEndpoint).origin;
const syncFile = join(tmpdir(), "belay-demo-director.json");
const scriptPath = join(repoRoot, "docs", "demo-script.md");
const vitestBin = join(repoRoot, "node_modules", "vitest", "vitest.mjs");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const option = (name, fallback) => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

// ---- terminal helpers ---------------------------------------------------------------
const ESC = String.fromCharCode(27);
const CTRL_C = String.fromCharCode(3);
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code, text) => (useColor ? `${ESC}[${code}m${text}${ESC}[0m` : text);
const bold = (text) => paint("1", text);
const dim = (text) => paint("2", text);
const green = (text) => paint("32", text);
const amber = (text) => paint("33", text);
const red = (text) => paint("31", text);
const cyan = (text) => paint("36", text);

/** Formats seconds as the m:ss the demo script and the Devpost outline both use. */
function clock(totalSeconds) {
  const whole = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function wrap(text, width) {
  const words = text.split(/\s+/u).filter(Boolean);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (line.length + word.length + 1 > width && line.length > 0) {
      lines.push(line);
      line = word;
    } else {
      line = line.length === 0 ? word : `${line} ${word}`;
    }
  }
  if (line.length > 0) lines.push(line);
  return lines;
}

// ---- the script ---------------------------------------------------------------------
/**
 * Parses the timed half of docs/demo-script.md. Headings look like
 * `## 0:25-0:55 - Deterministic context`, and each beat carries `**Visual:**` and
 * `**Narration:**` lines. The untimed checklist earlier in that document uses `###`
 * headings and is deliberately not matched here.
 */
function parseBeats(markdown) {
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

// ---- daemon access ------------------------------------------------------------------
async function dashboard() {
  const response = await fetch(`${daemonOrigin}/api/dashboard`, {
    signal: AbortSignal.timeout(5000)
  });
  if (!response.ok) throw new Error(`dashboard responded ${response.status}`);
  return response.json();
}

async function withClients(names, body) {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const clients = {};
  for (const name of names) {
    const client = new Client({ name: `belay-director-${name}`, version: "0.1.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpEndpoint)));
    clients[name] = client;
  }
  try {
    return await body(clients);
  } finally {
    await Promise.all(Object.values(clients).map((client) => client.close()));
  }
}

async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  return { ok: !result.isError, body: result.structuredContent ?? {} };
}

// ---- child commands -----------------------------------------------------------------
/**
 * Runs a command with its real output on camera. Node is invoked directly rather than
 * through npm so the take does not depend on Windows `.cmd` shims, and stdin stays with
 * the director so ENTER always advances the beat instead of reaching the child.
 */
function runNode(args, { capture = false } = {}) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"]
    });
    let output = "";
    if (capture) {
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
        process.stdout.write(chunk);
      });
    }
    child.on("close", (code) => settle({ code, output }));
    child.on("error", (error) => settle({ code: 1, output: String(error) }));
  });
}

const heroVerifier = () =>
  runNode([vitestBin, "run", "tests/hero-demo.integration.test.ts", "--reporter=verbose"]);

const noLeakSweep = () =>
  runNode([
    vitestBin,
    "run",
    "tests/executor.security.test.ts",
    "tests/cloud-egress.integration.test.ts",
    "tests/hero-demo.integration.test.ts",
    "--reporter=verbose"
  ]);

const CLOUD_SMOKE = join(repoRoot, "scripts", "smoke-cloud.mjs");

/**
 * package.json wires `smoke:cloud` to scripts/smoke-cloud.mjs, which is not in the tree.
 * A missing file must not put a Node stack trace on camera, so the beat says what is
 * missing and leaves the presenter to show the Cloud Run console instead.
 */
const cloudSmoke = () => {
  if (!existsSync(CLOUD_SMOKE)) {
    process.stdout.write(
      `  ${amber("scripts/smoke-cloud.mjs is missing")} - no local cloud evidence to print\n` +
        `  ${dim("show the Cloud Run ready revision and the Gemini result in the console instead,")}\n` +
        `  ${dim("or add the script before recording; npm run smoke:cloud references it too")}\n`
    );
    return Promise.resolve({ code: 0 });
  }
  return runNode([CLOUD_SMOKE]);
};

// ---- beat 3: the live race ----------------------------------------------------------
// Deliberately not the files seed-demo.mjs leases. The race has to be decided live on
// camera, so both paths must be free when the beat starts.
const RACE_PATHS = [
  "packages/daemon/src/coordination/coordination-service.ts",
  "packages/daemon/src/coordination/lease-service.ts"
];
// Every take gets fresh task ids. Reusing one across takes makes the second take refuse
// with IDEMPOTENCY_MISMATCH instead of LOCK_CONFLICT, which is the wrong story on camera.
const RACE_TASK_PREFIX = "director-race";

/**
 * Two MCP clients ask for an overlapping file set inside one acquisition window. The
 * point on camera is that SQLite settles it: one owner, one refusal carrying the owner,
 * lease and correlation id, and never a partial lock.
 */
async function liveRace() {
  await releaseRaceLeases({ verbose: true });
  const runId = Date.now().toString(36);
  return withClients(["Codex", "Claude Code"], async (clients) => {
    const codex = clients.Codex;
    const claude = clients["Claude Code"];

    const [codexResult, claudeResult] = await Promise.all([
      call(codex, "acquire_task", {
        projectRoot,
        taskId: `${RACE_TASK_PREFIX}-codex-${runId}`,
        agentName: "Codex",
        title: "Harden the approval service surface",
        filePaths: RACE_PATHS,
        leaseSeconds: 900,
        idempotencyKey: `director-codex-${runId}`
      }),
      call(claude, "acquire_task", {
        projectRoot,
        taskId: `${RACE_TASK_PREFIX}-claude-${runId}`,
        agentName: "Claude Code",
        title: "Review approval expiry semantics",
        filePaths: RACE_PATHS,
        leaseSeconds: 900,
        idempotencyKey: `director-claude-${runId}`
      })
    ]);

    for (const [agent, result] of [["Codex", codexResult], ["Claude Code", claudeResult]]) {
      const label = agent.padEnd(12);
      if (result.ok) {
        process.stdout.write(`  ${green("WON    ")} ${label} holds ${RACE_PATHS.length} path lease(s)\n`);
      } else {
        process.stdout.write(
          `  ${amber("REFUSED")} ${label} ${result.body.code ?? "conflict"} - ${result.body.message ?? "path already leased"}\n`
        );
        if (result.body.correlationId) {
          process.stdout.write(`           correlation ${dim(result.body.correlationId)}\n`);
        }
      }
    }

    const winners = [codexResult.ok, claudeResult.ok].filter(Boolean).length;
    process.stdout.write(
      winners === 1
        ? `\n  ${green("exactly one winner")} - no partial task and no partial lock state\n`
        : `\n  ${red(`UNEXPECTED: ${winners} winners`)} - stop the take and investigate\n`
    );

    const loser = codexResult.ok ? claude : codex;
    const advice = await call(loser, "explain_lock_conflict", {
      projectRoot,
      agentName: codexResult.ok ? "Claude Code" : "Codex",
      filePaths: RACE_PATHS
    });
    if (advice.ok) {
      process.stdout.write(
        `\n  advisory: ${advice.body.advisoryState ?? "unavailable"}, ` +
          `${advice.body.availablePaths?.length ?? 0} path(s) still free to reroute onto\n`
      );
    }
    return { code: winners === 1 ? 0 : 1 };
  });
}

/**
 * Frees the race paths before the beat runs. This covers the leases a previous take left
 * behind - without it the second take would show Codex losing its own race - and any
 * other task that happens to hold one of the paths, which would otherwise leave the beat
 * with no possible winner.
 */
async function releaseRaceLeases({ verbose = false } = {}) {
  try {
    const snapshot = await dashboard();
    const held = (snapshot.tasks ?? []).filter((task) => {
      if ((task.id ?? task.taskId ?? "").startsWith(RACE_TASK_PREFIX)) return true;
      return (task.lockedFiles ?? []).some((path) => RACE_PATHS.includes(path));
    });
    if (held.length === 0) return 0;
    await withClients(["cleanup"], async (clients) => {
      for (const task of held) {
        if (verbose) {
          process.stdout.write(
            dim(`  releasing ${task.id ?? task.taskId} (${task.agentName}) so both race paths start free\n`)
          );
        }
        await call(clients.cleanup, "log_completion", {
          projectRoot,
          taskId: task.id ?? task.taskId,
          agentName: task.agentName,
          summary: "Coordination review complete; path leases released for reassignment.",
          modifiedFiles: [],
          verificationEvidence: []
        });
      }
    });
    return held.length;
  } catch {
    return 0;
  }
}

// ---- beat 5: the approval intercept -------------------------------------------------
/**
 * Requests the protected command, then watches the daemon until a human decides. The
 * presenter clicks Approve in the cockpit; the director reports the recorded outcome,
 * including `indeterminate`, which is the honest result when the vault is locked.
 */
async function approvalIntercept({ failClosed }) {
  const requestScript = failClosed ? "request-demo-vault-approval.mjs" : "request-demo-approval.mjs";
  process.stdout.write(dim(`  node scripts/${requestScript}\n\n`));
  const { output } = await runNode([join(repoRoot, "scripts", requestScript)], { capture: true });

  let approvalId;
  try {
    const lastLine = output.trim().split(/\r?\n/u).pop() ?? "{}";
    approvalId = JSON.parse(lastLine).approvalId;
  } catch {
    approvalId = undefined;
  }

  process.stdout.write(
    `\n  ${amber("PENDING")} nothing executes while this card is open - approve it in the cockpit\n`
  );
  const outcome = await waitForDecision(approvalId);
  if (outcome.status === "timeout") {
    process.stdout.write(`  ${dim("still pending - continuing, the card stays valid until it expires")}\n`);
    return { code: 0 };
  }
  const colour = outcome.status === "succeeded" ? green : amber;
  process.stdout.write(`\n  ${colour(`DECIDED: ${outcome.status}`)} ${dim(outcome.detail ?? "")}\n`);
  if (outcome.status === "indeterminate") {
    process.stdout.write(
      `  ${dim("fail-closed: an ambiguous execution is recorded as indeterminate, never retried silently")}\n`
    );
  }
  return { code: 0 };
}

/**
 * The dashboard keys a pending card by `approvalId`, while the audit projection keys the
 * same request `approval-<approvalId>` and carries its state in `outcome` as
 * "<commandId> · <status>". Both shapes are read here so the beat reports the state the
 * daemon actually recorded rather than assuming the click succeeded.
 */
async function waitForDecision(approvalId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  const before = await dashboard().catch(() => ({ summary: {} }));
  const baseline = before.summary?.pendingApprovals ?? 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 750));
    let snapshot;
    try {
      snapshot = await dashboard();
    } catch {
      continue;
    }
    const stillPending = approvalId
      ? (snapshot.approvals ?? []).some((approval) => (approval.approvalId ?? approval.id) === approvalId)
      : (snapshot.summary?.pendingApprovals ?? 0) >= baseline;
    if (stillPending) continue;

    // The card leaves the pending list the moment a human decides, but the request is
    // still `executing` for a moment after that. The beat claims a settled outcome, so
    // keep reading until the daemon records a terminal one.
    const entry = (snapshot.audit ?? []).find(
      (row) => row.id === `approval-${approvalId}` || row.correlationId === approvalId
    );
    const outcome = entry?.outcome ?? "";
    const status = outcome.includes("·") ? outcome.split("·").pop().trim() : outcome.trim();
    if (["pending", "approved", "executing"].includes(status) && Date.now() < deadline) continue;
    return {
      status: status.length > 0 ? status : "decided",
      detail: entry ? `${entry.target ?? ""} ${entry.correlationId ?? ""}`.trim() : ""
    };
  }
  return { status: "timeout" };
}

// ---- beat 7: the closing proof ------------------------------------------------------
async function closingProof() {
  process.stdout.write(
    `  architecture diagram: ${cyan(join("docs", "assets", "belay-architecture.png"))}\n`
  );
  process.stdout.write(`  repository:           ${cyan("https://github.com/codersguru-hub/Belay")}\n`);
  try {
    const snapshot = await dashboard();
    const summary = snapshot.summary ?? {};
    const manifest = snapshot.manifest ?? {};
    process.stdout.write(
      `\n  ${bold("final state")}  ` +
        `${summary.activeTasks ?? 0} active task(s), ${summary.lockedFiles ?? 0} leased file(s), ` +
        `${summary.knowledgeFacts ?? 0} shared fact(s)\n` +
        `  ${bold("manifest")}     ${manifest.estimatedTokens ?? "?"} tokens, ` +
        `${manifest.byteSize ?? "?"} bytes, ${manifest.durationMs ?? "?"} ms, ` +
        `${manifest.stale ? amber("stale - reindex before the take") : green("fresh")}\n`
    );
  } catch {
    process.stdout.write(dim("\n  (daemon snapshot unavailable)\n"));
  }
  return { code: 0 };
}

// ---- beat wiring --------------------------------------------------------------------
/** Commands behind each beat, in the order docs/demo-script.md declares them. */
const ACTIONS = [
  { expect: /problem and category/iu, label: null, run: null },
  { expect: /deterministic context/iu, label: "hero verifier - manifest metrics", run: heroVerifier },
  { expect: /collision/iu, label: "live acquisition race", run: liveRace },
  {
    expect: /zero-leak vault/iu,
    label: "no-leak sweep across sqlite, logs, mcp output, cloud fixtures",
    run: noLeakSweep
  },
  {
    expect: /approval intercept/iu,
    label: "protected command request",
    run: approvalIntercept,
    holdsPresenter: true
  },
  { expect: /gemini cloud arbiter/iu, label: "cloud run and gemini smoke", run: cloudSmoke },
  { expect: /proof and vision/iu, label: "closing proof", run: closingProof }
];

function loadRunSheet() {
  if (!existsSync(scriptPath)) {
    throw new Error("docs/demo-script.md is missing - the director reads narration from it.");
  }
  const beats = parseBeats(readFileSync(scriptPath, "utf8"));
  if (beats.length !== ACTIONS.length) {
    throw new Error(
      `docs/demo-script.md parsed to ${beats.length} timed beats but the director wires ${ACTIONS.length}. ` +
        "Update ACTIONS in scripts/demo-director.mjs to match the script."
    );
  }
  return beats.map((beat, index) => {
    const action = ACTIONS[index];
    if (!action.expect.test(beat.title)) {
      process.stderr.write(
        amber(`warning: beat ${index + 1} is titled "${beat.title}" but the director expected ${action.expect}\n`)
      );
    }
    return { ...beat, ...action, index };
  });
}

// ---- preflight ----------------------------------------------------------------------
async function preflight() {
  const results = [];
  const add = (level, message, hint) => results.push({ level, message, hint });

  const major = Number(process.versions.node.split(".")[0]);
  add(major >= 22 ? "ok" : "fail", `node ${process.versions.node}`, "Belay requires Node 22 or newer.");

  const built = existsSync(join(repoRoot, "packages", "daemon", "dist"));
  add(
    built ? "ok" : "fail",
    built ? "daemon build present" : "daemon is not built",
    "Run npm run build before recording."
  );

  let snapshot;
  try {
    snapshot = await dashboard();
    add("ok", `daemon reachable at ${daemonOrigin}`);
  } catch {
    add("fail", `daemon unreachable at ${daemonOrigin}`, "Run node bin/belay.js start --open, then retry.");
  }

  if (snapshot) {
    const summary = snapshot.summary ?? {};
    const seeded = (summary.activeTasks ?? 0) > 0 || (summary.knowledgeFacts ?? 0) > 0;
    add(
      seeded ? "ok" : "warn",
      seeded
        ? `cockpit seeded (${summary.activeTasks ?? 0} active, ${summary.knowledgeFacts ?? 0} facts)`
        : "cockpit looks empty",
      "Run npm run demo:seed so beat 1 opens on a populated cockpit."
    );
    if (snapshot.manifest?.stale) {
      add("warn", "project manifest is stale", "Call reindex_project so the manifest metrics on camera are current.");
    }
    const released = await releaseRaceLeases();
    if (released > 0) add("ok", `released ${released} lease(s) left by an earlier take`);
    if ((summary.pendingApprovals ?? 0) > 0) {
      add(
        "warn",
        `${summary.pendingApprovals} approval(s) already pending`,
        "Clear or approve them so the approval beat shows a single fresh card."
      );
    }
  }

  if (!existsSync(CLOUD_SMOKE)) {
    add(
      "warn",
      "scripts/smoke-cloud.mjs is missing (npm run smoke:cloud is broken)",
      "The Cloud Run beat has no local evidence to print - show the console, or add the script first."
    );
  }

  const ffmpeg = await probeFfmpeg();
  add(
    ffmpeg ? "ok" : "warn",
    ffmpeg ? `ffmpeg present (${ffmpeg})` : "ffmpeg not on PATH",
    "Install ffmpeg to use the scripted capture command below."
  );

  for (const leak of [".env", join(".tools", "gcloud-config")]) {
    if (existsSync(join(repoRoot, leak))) {
      add(
        "warn",
        `${leak} exists in the repository root`,
        "Keep it out of frame - do not list the directory on camera."
      );
    }
  }
  const identityVars = [
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GOOGLE_CLOUD_PROJECT",
    "GCLOUD_PROJECT",
    "CLOUDSDK_CORE_PROJECT"
  ];
  const set = identityVars.filter((name) => process.env[name]);
  if (set.length > 0) {
    add(
      "warn",
      `account identifiers in the environment: ${set.join(", ")}`,
      "Child output is redacted, but do not print the environment on camera."
    );
  }

  for (const { level, message, hint } of results) {
    const badge = level === "ok" ? green("  ok  ") : level === "warn" ? amber(" warn ") : red(" fail ");
    process.stdout.write(`${badge} ${message}\n`);
    if (level !== "ok" && hint) process.stdout.write(`       ${dim(hint)}\n`);
  }
  return results.every((result) => result.level !== "fail");
}

function probeFfmpeg() {
  return new Promise((settle) => {
    const child = spawn("ffmpeg", ["-version"], {
      stdio: ["ignore", "pipe", "ignore"],
      shell: process.platform === "win32"
    });
    let output = "";
    child.stdout?.on("data", (chunk) => {
      output += chunk.toString("utf8");
    });
    child.on("close", (code) => settle(code === 0 ? output.split(/\r?\n/u)[0].slice(0, 40) : null));
    child.on("error", () => settle(null));
  });
}

function captureHint() {
  const out = join("docs", "video", "belay-demo-take-1.mp4");
  const listDevices = "ffmpeg -list_devices true -f dshow -i dummy";
  const record =
    "ffmpeg -f gdigrab -framerate 30 -i desktop -f dshow -i audio=\"YOUR MIC\" " +
    `-c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p -c:a aac -b:a 192k ${out}`;
  process.stdout.write(
    `\n${bold("capture")}  list your microphone first:\n` +
      `  ${cyan(listDevices)}\n` +
      "then record the desktop with narration:\n" +
      `  ${cyan(record)}\n` +
      `${dim("Stop with q in the ffmpeg window. Give each take its own file name.")}\n`
  );
}

// ---- stage and prompter sync --------------------------------------------------------
function publish(state) {
  try {
    writeFileSync(syncFile, JSON.stringify(state), "utf8");
  } catch {
    /* the prompter is optional; a failed write must never interrupt a take */
  }
}

async function runPrompter() {
  const width = Math.max(60, Math.min(process.stdout.columns ?? 90, 100));
  let lastRender = "";
  process.stdout.write(`${ESC}[?25l`);
  process.on("SIGINT", () => {
    process.stdout.write(`${ESC}[?25h\n`);
    process.exit(0);
  });

  for (;;) {
    let state;
    try {
      state = JSON.parse(readFileSync(syncFile, "utf8"));
    } catch {
      state = null;
    }
    const frame = renderPrompter(state, width);
    if (frame !== lastRender) {
      process.stdout.write(`${ESC}[2J${ESC}[H${frame}`);
      lastRender = frame;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

function renderPrompter(state, width) {
  if (!state) {
    return (
      `${dim("waiting for the stage window...")}\n\n` +
      `${dim("start it with:")} node scripts/demo-director.mjs\n`
    );
  }
  const elapsed = state.takeStartedAt ? (Date.now() - state.takeStartedAt) / 1000 : 0;
  const drift = elapsed - state.startSeconds;
  const pace =
    Math.abs(drift) <= 8
      ? green("ON PACE")
      : drift > 0
        ? amber(`BEHIND ${clock(Math.abs(drift))}`)
        : cyan(`AHEAD ${clock(Math.abs(drift))}`);

  const rule = dim("-".repeat(width));
  const lines = [
    rule,
    `${bold(`BEAT ${state.index + 1}/${state.total}`)}  ${dim(`${clock(state.startSeconds)}-${clock(state.endSeconds)}`)}  ${bold(state.title)}`,
    `${bold(`TAKE ${clock(elapsed)}`)}   ${dim(`target ${clock(state.startSeconds)}`)}   ${pace}`,
    rule,
    ""
  ];
  if (state.visual) {
    lines.push(dim("VISUAL"), ...wrap(state.visual, width - 2).map((line) => `  ${line}`), "");
  }
  lines.push(bold("NARRATION"));
  for (const line of wrap(state.narration || "(no narration for this beat)", width - 4)) {
    lines.push(`  ${line}`);
    lines.push("");
  }
  if (state.callouts) {
    lines.push(dim("CALLOUTS"), ...wrap(state.callouts, width - 2).map((line) => `  ${line}`), "");
  }
  lines.push(rule);
  lines.push(`${dim("status:")} ${state.status}`);
  lines.push(
    dim(
      state.holdsPresenter
        ? "approve the card in the cockpit, then ENTER in the stage window"
        : "ENTER in the stage window advances"
    )
  );
  return `${lines.join("\n")}\n`;
}

// ---- the take -----------------------------------------------------------------------
let stdinEnded = false;

function waitForEnter(prompt) {
  return new Promise((settle) => {
    process.stdout.write(prompt);
    // A scripted rehearsal runs out of newlines before it runs out of beats.
    if (stdinEnded) {
      process.stdout.write("\n");
      settle();
      return;
    }
    const onData = (chunk) => {
      const key = chunk.toString("utf8");
      if (key === CTRL_C) {
        process.stdout.write("\n");
        process.exit(130);
      }
      if (key.includes("\r") || key.includes("\n")) {
        process.stdin.removeListener("data", onData);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdout.write("\n");
        settle();
      }
    };
    // A piped stdin (a scripted rehearsal) runs out of newlines before the beats run out;
    // treat that as an advance rather than hanging the walk.
    const onEnd = () => {
      stdinEnded = true;
      process.stdin.removeListener("data", onData);
      process.stdout.write("\n");
      settle();
    };
    process.stdin.once("end", onEnd);
    if (process.stdin.isTTY) process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

function beatState(beat, total, takeStartedAt, status) {
  return {
    index: beat.index,
    total,
    title: beat.title,
    startSeconds: beat.startSeconds,
    endSeconds: beat.endSeconds,
    visual: beat.visual,
    narration: beat.narration,
    callouts: beat.callouts,
    holdsPresenter: Boolean(beat.holdsPresenter),
    takeStartedAt,
    status
  };
}

async function runTake({ rehearse, failClosed, startAt }) {
  const beats = loadRunSheet();
  const takeStartedAt = Date.now();
  const width = Math.min(process.stdout.columns ?? 80, 100);

  for (const beat of beats.slice(startAt)) {
    const header =
      `${bold(`BEAT ${beat.index + 1}/${beats.length}`)}  ` +
      `${dim(`${clock(beat.startSeconds)}-${clock(beat.endSeconds)}`)}  ${bold(beat.title)}`;
    process.stdout.write(`\n${dim("=".repeat(width))}\n${header}\n\n`);

    publish(beatState(beat, beats.length, takeStartedAt, beat.run ? `running ${beat.label}` : "narration only"));

    if (beat.run && !rehearse) {
      if (beat.label) process.stdout.write(`${dim(`> ${beat.label}`)}\n\n`);
      const result = await beat.run({ failClosed });
      if (result?.code !== 0) {
        process.stdout.write(`\n${amber("that command did not exit clean - decide whether to restart the take")}\n`);
      }
    } else if (beat.run) {
      process.stdout.write(`${dim(`> would run: ${beat.label}`)}\n`);
    }

    publish(beatState(beat, beats.length, takeStartedAt, "narrating - waiting for ENTER"));

    const elapsed = (Date.now() - takeStartedAt) / 1000;
    const drift = elapsed - beat.endSeconds;
    const pace =
      Math.abs(drift) <= 8
        ? green("on pace")
        : drift > 0
          ? amber(`behind ${clock(Math.abs(drift))}`)
          : cyan(`ahead ${clock(Math.abs(drift))}`);
    const status = dim(`take ${clock(elapsed)}, beat ends ${clock(beat.endSeconds)}, ${pace}`);
    if (beat.index < beats.length - 1) {
      await waitForEnter(`\n${status}  ${dim("ENTER for the next beat")} `);
    } else {
      process.stdout.write(`\n${status}\n`);
    }
  }

  process.stdout.write(`\n${green("take complete")} - stop the recording.\n`);
  process.stdout.write(dim("End card: Belay - shared state, safe execution, human authority.\n"));
}

// ---- entry point --------------------------------------------------------------------
try {
  if (flag("prompter")) {
    await runPrompter();
  } else if (flag("check")) {
    process.stdout.write(`${bold("Belay demo director - preflight")}\n\n`);
    const ready = await preflight();
    const beats = loadRunSheet();
    process.stdout.write(`\n${dim(`run sheet: ${beats.length} beats parsed from docs/demo-script.md`)}\n`);
    for (const beat of beats) {
      process.stdout.write(
        `  ${dim(`${clock(beat.startSeconds)}-${clock(beat.endSeconds)}`)} ${beat.title}` +
          `${beat.label ? dim(` -> ${beat.label}`) : dim(" -> narration only")}\n`
      );
    }
    process.stdout.write(`\n${ready ? green("ready to record") : red("not ready - fix the failures above")}\n`);
    captureHint();
    process.exit(ready ? 0 : 1);
  } else {
    process.stdout.write(`${bold("Belay demo director")}\n\n`);
    const ready = await preflight();
    if (!ready && !flag("rehearse")) {
      process.stdout.write(
        `\n${red("preflight failed - fix the items above, or pass --rehearse to walk the beats anyway")}\n`
      );
      process.exit(1);
    }
    captureHint();
    process.stdout.write(
      `\n${dim("tip: open a second window with")} node scripts/demo-director.mjs --prompter ${dim("for cue cards")}\n`
    );
    await waitForEnter(`\n${bold("start the recorder, then press ENTER to begin the take")} `);
    await runTake({
      rehearse: flag("rehearse"),
      failClosed: flag("fail-closed"),
      startAt: Math.max(0, Number(option("from", "1")) - 1)
    });
    rmSync(syncFile, { force: true });
  }
} catch (error) {
  process.stderr.write(`${red("director error")}: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
