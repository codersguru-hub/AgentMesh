/**
 * Real evidence for the rendered video.
 *
 * Nothing here is staged: every log the video shows is stdout from the same commands a
 * reviewer would run, and every cockpit state is produced by driving the daemon's real
 * MCP and HTTP surfaces. The renderer only decides how that output is framed.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./demo-script.mjs";

const mcpEndpoint = process.env.BELAY_MCP_URL ?? "http://127.0.0.1:3420/mcp";
export const daemonOrigin = new URL(mcpEndpoint).origin;
const projectRoot = process.env.BELAY_PROJECT_ROOT ?? repoRoot;
const vitestBin = join(repoRoot, "node_modules", "vitest", "vitest.mjs");

/** Strips ANSI so captured output can be re-rendered with the video's own styling. */
export function stripAnsi(text) {
  const escape = String.fromCharCode(27);
  return text
    .replaceAll(new RegExp(`${escape}\\[[0-9;?]*[A-Za-z]`, "gu"), "")
    .replaceAll(new RegExp(`${escape}\\][^]*`, "gu"), "")
    .replaceAll(/\r/gu, "");
}

/** Runs a node command and captures its combined output. Never inherits a shell. */
export function runNode(args, { cwd = repoRoot, timeoutMs = 600000 } = {}) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const collect = (chunk) => {
      output += chunk.toString("utf8");
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      settle({ code, output: stripAnsi(output) });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      settle({ code: 1, output: stripAnsi(String(error)) });
    });
  });
}

export async function dashboard() {
  const response = await fetch(`${daemonOrigin}/api/dashboard`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`dashboard responded ${response.status}`);
  return response.json();
}

async function withClients(names, body) {
  const { Client, StreamableHTTPClientTransport } = await import("@modelcontextprotocol/client");
  const clients = {};
  for (const name of names) {
    const client = new Client({ name: `belay-video-${name}`, version: "0.1.0" });
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

// ---- the acquisition race -----------------------------------------------------------
// Deliberately not the files seed-demo.mjs leases, so the race is decided during the run.
const RACE_PATHS = [
  "packages/daemon/src/coordination/coordination-service.ts",
  "packages/daemon/src/coordination/lease-service.ts"
];
// Named for the work, not the renderer: these ids surface in the cockpit's work queue.
const RACE_TASK_NAMES = ["codex-coordination-hardening", "claude-lease-review"];

/** Frees the race paths so every render produces the same single-winner result. */
export async function releaseRacePaths() {
  try {
    const snapshot = await dashboard();
    const held = (snapshot.tasks ?? []).filter((task) => {
      const id = task.id ?? task.taskId ?? "";
      if (RACE_TASK_NAMES.some((name) => id.startsWith(`${name}-`))) return true;
      if (id.startsWith("video-race")) return true;
      return (task.lockedFiles ?? []).some((path) => RACE_PATHS.includes(path));
    });
    if (held.length === 0) return 0;
    await withClients(["cleanup"], async (clients) => {
      for (const task of held) {
        await call(clients.cleanup, "log_completion", {
          projectRoot,
          taskId: task.id ?? task.taskId,
          agentName: task.agentName,
          summary: "Released by the video renderer so the acquisition race starts from free paths.",
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

/**
 * Two clients ask for an overlapping file set in one acquisition window. Returns rendered
 * transcript lines so the video shows the same thing a terminal would.
 */
export async function runAcquisitionRace() {
  await releaseRacePaths();
  const runId = Date.now().toString(36);
  return withClients(["Codex", "Claude Code"], async (clients) => {
    const lines = [];
    const say = (text) => lines.push(text);
    say("$ belay race --agents codex,claude-code --paths coordination-service.ts,lease-service.ts");
    say("");

    const [codexResult, claudeResult] = await Promise.all([
      call(clients.Codex, "acquire_task", {
        projectRoot,
        taskId: `${RACE_TASK_NAMES[0]}-${runId}`,
        agentName: "Codex",
        title: "Harden the coordination surface",
        filePaths: RACE_PATHS,
        leaseSeconds: 900,
        idempotencyKey: `video-codex-${runId}`
      }),
      call(clients["Claude Code"], "acquire_task", {
        projectRoot,
        taskId: `${RACE_TASK_NAMES[1]}-${runId}`,
        agentName: "Claude Code",
        title: "Review lease expiry semantics",
        filePaths: RACE_PATHS,
        leaseSeconds: 900,
        idempotencyKey: `video-claude-${runId}`
      })
    ]);

    for (const [agent, result] of [["Codex", codexResult], ["Claude Code", claudeResult]]) {
      if (result.ok) {
        say(`  WON      ${agent.padEnd(12)} holds ${RACE_PATHS.length} path leases`);
      } else {
        say(`  REFUSED  ${agent.padEnd(12)} ${result.body.code ?? "conflict"}`);
        say(`           ${result.body.message ?? "one or more requested files are already locked"}`);
        if (result.body.correlationId) say(`           correlation ${result.body.correlationId}`);
      }
    }

    const winners = [codexResult.ok, claudeResult.ok].filter(Boolean).length;
    say("");
    say(
      winners === 1
        ? "  exactly one winner - no partial task, no partial lock state"
        : `  UNEXPECTED: ${winners} winners`
    );

    const loser = codexResult.ok ? clients["Claude Code"] : clients.Codex;
    const advice = await call(loser, "explain_lock_conflict", {
      projectRoot,
      agentName: codexResult.ok ? "Claude Code" : "Codex",
      filePaths: RACE_PATHS
    });
    if (advice.ok) {
      say("");
      say(`  advisory: ${advice.body.advisoryState ?? "unavailable"}, ` +
        `${advice.body.availablePaths?.length ?? 0} paths free to reroute onto`);
    }
    return { lines, ok: winners === 1 };
  });
}

// ---- the approval intercept ---------------------------------------------------------
/** Requests the protected command and returns the pending card's identity. */
export async function requestApproval({ failClosed = false } = {}) {
  const script = failClosed ? "request-demo-vault-approval.mjs" : "request-demo-approval.mjs";
  const { output } = await runNode([join(repoRoot, "scripts", script)]);
  const lastLine = output.trim().split(/\r?\n/u).pop() ?? "{}";
  let parsed = {};
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    throw new Error(`could not read the approval request result: ${lastLine.slice(0, 200)}`);
  }
  if (!parsed.approvalId) throw new Error("the approval request returned no approvalId");
  return parsed;
}

/**
 * Reads the state the daemon recorded for a request. The pending list keys on
 * `approvalId`; the audit projection keys the same request `approval-<approvalId>` and
 * carries its state in `outcome` as "<commandId> · <status>".
 */
export async function readApprovalState(approvalId) {
  const snapshot = await dashboard();
  const pending = (snapshot.approvals ?? []).some(
    (approval) => (approval.approvalId ?? approval.id) === approvalId
  );
  if (pending) return { status: "pending" };
  const entry = (snapshot.audit ?? []).find((row) => row.id === `approval-${approvalId}`);
  const outcome = entry?.outcome ?? "";
  const status = outcome.includes("·") ? outcome.split("·").pop().trim() : outcome.trim();
  return { status: status.length > 0 ? status : "decided", correlationId: entry?.correlationId };
}

/** Waits until the daemon records a terminal state for the request. */
export async function waitForTerminalApproval(approvalId, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = { status: "pending" };
  while (Date.now() < deadline) {
    last = await readApprovalState(approvalId).catch(() => last);
    if (!["pending", "approved", "executing"].includes(last.status)) return last;
    await new Promise((settle) => setTimeout(settle, 750));
  }
  return last;
}

// ---- verifier commands --------------------------------------------------------------
export const heroVerifier = () =>
  runNode([vitestBin, "run", "tests/hero-demo.integration.test.ts", "--reporter=verbose"]);

export const noLeakSweep = () =>
  runNode([
    vitestBin,
    "run",
    "tests/executor.security.test.ts",
    "tests/cloud-egress.integration.test.ts",
    "tests/hero-demo.integration.test.ts",
    "--reporter=verbose"
  ]);

export const cloudEgressProof = () =>
  runNode([vitestBin, "run", "tests/cloud-egress.integration.test.ts", "--reporter=verbose"]);

export const CLOUD_SMOKE = join(repoRoot, "scripts", "smoke-cloud.mjs");
export const cloudSmoke = () =>
  existsSync(CLOUD_SMOKE) ? runNode([CLOUD_SMOKE]) : Promise.resolve(null);

/**
 * Ensures the cockpit shows live work before any screenshot is taken.
 *
 * Live tasks are the measure, not shared facts: approved knowledge persists across runs,
 * so counting it would let a cockpit with no active work skip seeding and look idle on
 * camera. seed-demo releases its own previous leases, so re-running it is safe.
 */
export async function ensureSeeded({ minimumActiveTasks = 2 } = {}) {
  const snapshot = await dashboard();
  if ((snapshot.summary?.activeTasks ?? 0) >= minimumActiveTasks) {
    return { seeded: true, ran: false };
  }
  const result = await runNode([join(repoRoot, "scripts", "seed-demo.mjs")]);
  const after = await dashboard();
  return {
    seeded: (after.summary?.activeTasks ?? 0) > 0,
    ran: true,
    activeTasks: after.summary?.activeTasks ?? 0,
    output: result.output
  };
}

/**
 * Refreshes the project manifest so the cockpit does not photograph a STALE badge, and
 * so the token count on screen describes the tree as it is right now.
 */
export async function reindexProject() {
  try {
    return await withClients(["reindex"], async (clients) => {
      const result = await call(clients.reindex, "reindex_project", { projectRoot });
      return result.ok ? (result.body.estimatedTokens ?? null) : null;
    });
  } catch {
    return null;
  }
}

/** Writes a captured transcript next to the render for inspection after the fact. */
export function saveLog(buildDir, name, text) {
  const dir = join(buildDir, "logs");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}.log`);
  writeFileSync(path, text, "utf8");
  return path;
}
