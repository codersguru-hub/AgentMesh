/**
 * Seeds a running Belay daemon with a realistic multi-agent state so the cockpit
 * demonstrates the product instead of an empty shell.
 *
 * Everything here goes through the real MCP surface as four independent clients, so the
 * resulting state, audit trail, and agent roster are genuine rather than injected into
 * SQLite behind the daemon's back.
 *
 * Usage:  npm run demo:seed          (daemon must already be running)
 */
import { resolve } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

const endpoint = process.env.BELAY_MCP_URL ?? "http://127.0.0.1:3420/mcp";
const daemonOrigin = new URL(endpoint).origin;
const projectRoot = resolve(process.env.BELAY_PROJECT_ROOT ?? process.cwd());

const AGENTS = ["Antigravity", "Claude Desktop", "Codex", "OpenCode"];

/**
 * Task ids and idempotency keys are per-run.
 *
 * `acquire_task` treats a replayed idempotency key whose task has since completed as
 * TASK_NOT_ACTIVE rather than starting a new task, so reusing fixed keys made every seed
 * after the first produce a cockpit with no active work. Fresh ids each run, plus the
 * reset below to free the paths the previous run leased, keep this script re-runnable.
 */
const RUN_ID = Date.now().toString(36);

/**
 * Task ids read as the work an agent would actually be doing, because the cockpit shows
 * them in the work queue. The run suffix is what keeps them unique; the reset below is
 * what identifies them as this script's, so no scaffolding prefix is needed.
 */
const SEED_TASK_NAMES = [
  "codex-auth-hardening",
  "opencode-executor-streaming",
  "claude-approval-expiry",
  "claude-digest-review"
];
const taskId = (name) => `${name}-${RUN_ID}`;
const key = (name) => `seed-${name}-${RUN_ID}`;

/** Ids from earlier revisions of this script, still released on reset. */
const LEGACY_TASK_IDS = [
  "task-codex-auth",
  "task-opencode-exec",
  "task-claude-auth",
  "task-claude-review"
];
const LEGACY_PREFIXES = ["seed-"];

const TASKS = {
  codexAuth: taskId("codex-auth-hardening"),
  opencodeExec: taskId("opencode-executor-streaming"),
  claudeAuth: taskId("claude-approval-expiry"),
  claudeReview: taskId("claude-digest-review")
};

/**
 * Checklist items are per-run for the same reason tasks are. A checklist item can only be
 * acquired while it is pending or blocked and unlinked, so once the reset completes an
 * item, that id can never carry work again - a stable id would make every later seed fail
 * with CHECKLIST_CONFLICT. Completed items from earlier runs stay as finished milestones.
 */
const ITEMS = {
  coordination: taskId("integrate-coordination-hub"),
  vaultRotation: taskId("rotate-staging-credentials"),
  egressAudit: taskId("audit-cloud-egress")
};

async function connect(name) {
  const client = new Client({ name: `belay-seed-${name}`, version: "0.1.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(endpoint)));
  return client;
}

/**
 * Completes the tasks an earlier seed left holding leases. Without this the new run loses
 * every acquisition to its own predecessor and the cockpit shows no live work.
 */
async function resetPreviousSeed(client) {
  let snapshot;
  try {
    const response = await fetch(`${daemonOrigin}/api/dashboard`, { signal: AbortSignal.timeout(8000) });
    snapshot = await response.json();
  } catch {
    return;
  }
  const stale = (snapshot.tasks ?? []).filter((task) => {
    const id = task.id ?? task.taskId ?? "";
    if (LEGACY_TASK_IDS.includes(id)) return true;
    if (LEGACY_PREFIXES.some((prefix) => id.startsWith(prefix))) return true;
    // "<name>-<runId>" from any earlier run of this script.
    return SEED_TASK_NAMES.some((name) => id.startsWith(`${name}-`));
  });
  for (const task of stale) {
    try {
      await client.callTool({
        name: "log_completion",
        arguments: {
          projectRoot,
          taskId: task.id ?? task.taskId,
          agentName: task.agentName,
          summary: "Released by seed-demo so the next seed starts from free paths.",
          modifiedFiles: [],
          verificationEvidence: []
        }
      });
    } catch {
      // A task that cannot be completed is not worth aborting the seed over.
    }
  }
  if (stale.length > 0) {
    process.stdout.write(`00. Reset: released ${stale.length} task(s) from an earlier seed\n`);
  }
}

let stepNumber = 0;
/** Calls a tool and reports it, tolerating already-seeded state so the script is re-runnable. */
async function step(client, label, name, args) {
  stepNumber += 1;
  const prefix = `${String(stepNumber).padStart(2, "0")}. ${label}`;
  try {
    const result = await client.callTool({ name, arguments: args });
    const body = result.structuredContent ?? {};
    if (result.isError) {
      process.stdout.write(`${prefix} — skipped (${body.code ?? "already seeded"})\n`);
      return undefined;
    }
    process.stdout.write(`${prefix} — ok\n`);
    return body;
  } catch (error) {
    process.stdout.write(`${prefix} — skipped (${error instanceof Error ? error.message : String(error)})\n`);
    return undefined;
  }
}

const clients = Object.fromEntries(
  await Promise.all(AGENTS.map(async (name) => [name, await connect(name)]))
);

try {
  const antigravity = clients.Antigravity;
  const claude = clients["Claude Desktop"];
  const codex = clients.Codex;
  const opencode = clients.OpenCode;

  await resetPreviousSeed(antigravity);

  // ---- Shared plan: a completed milestone, live work, and a genuine blocker ----------
  await step(antigravity, "Plan: checklist item (auth coordination)", "add_checklist_item", {
    projectRoot,
    itemId: ITEMS.coordination,
    proposedBy: "Antigravity",
    title: "Integrate multi-agent coordination hub",
    description: "Verify multi-agent MCP connection and single-winner atomic locking.",
    acceptanceCriteria: ["Two agents race for one file set", "Exactly one winner"],
    priority: 90
  });
  await step(antigravity, "Plan: checklist item (vault rotation)", "add_checklist_item", {
    projectRoot,
    itemId: ITEMS.vaultRotation,
    proposedBy: "Antigravity",
    title: "Rotate staging credentials through the vault",
    description: "Move the staging reload command onto age-wrapped secret injection.",
    acceptanceCriteria: ["No plaintext secret in output", "Approval required before run"],
    priority: 70
  });
  await step(antigravity, "Plan: checklist item (egress audit)", "add_checklist_item", {
    projectRoot,
    itemId: ITEMS.egressAudit,
    proposedBy: "Antigravity",
    title: "Audit cloud egress payload shape",
    description: "Confirm only allowlisted structural metadata leaves the machine.",
    acceptanceCriteria: ["Raw source rejected", "Encoded secrets rejected"],
    priority: 60
  });

  // ---- Live work: two agents holding real leases on disjoint file sets ---------------
  await step(codex, "Work: Codex acquires auth surface", "acquire_task", {
    projectRoot,
    taskId: TASKS.codexAuth,
    agentName: "Codex",
    title: "Harden the auth service surface",
    filePaths: ["packages/daemon/src/approval/approval-service.ts"],
    leaseSeconds: 3600,
    idempotencyKey: key("codex-auth"),
    checklistItemId: ITEMS.coordination
  });
  await step(codex, "Work: Codex reports progress", "report_task_progress", {
    projectRoot,
    taskId: TASKS.codexAuth,
    agentName: "Codex",
    summary: "Digest binding verified; wiring replay rejection next.",
    progressPercent: 65,
    evidence: ["approval.integration.test.ts: 6 passed"],
    idempotencyKey: key("codex-progress")
  });

  await step(opencode, "Work: OpenCode acquires executor", "acquire_task", {
    projectRoot,
    taskId: TASKS.opencodeExec,
    agentName: "OpenCode",
    title: "Bound executor output streaming",
    filePaths: ["packages/daemon/src/executor/command-executor.ts"],
    leaseSeconds: 3600,
    idempotencyKey: key("opencode-exec"),
    checklistItemId: ITEMS.egressAudit
  });
  await step(opencode, "Work: OpenCode reports progress", "report_task_progress", {
    projectRoot,
    taskId: TASKS.opencodeExec,
    agentName: "OpenCode",
    summary: "Redaction holds across chunk boundaries; adding hex variant coverage.",
    progressPercent: 40,
    evidence: ["executor.security.test.ts: 9 passed"],
    idempotencyKey: key("opencode-progress")
  });

  // ---- Contention: Claude collides with Codex, then asks Gemini to adjudicate --------
  const collision = await step(claude, "Contention: Claude races Codex for auth file", "acquire_task", {
    projectRoot,
    taskId: TASKS.claudeAuth,
    agentName: "Claude Desktop",
    title: "Review approval expiry semantics",
    filePaths: [
      "packages/daemon/src/approval/approval-service.ts",
      "packages/daemon/src/approval/action-digest.ts"
    ],
    leaseSeconds: 3600,
    idempotencyKey: key("claude-auth")
  });
  if (collision === undefined) {
    process.stdout.write("    ↳ expected: exactly one winner, Claude was correctly refused\n");
  }

  const advice = await step(claude, "Contention: Gemini explains the conflict", "explain_lock_conflict", {
    projectRoot,
    agentName: "Claude Desktop",
    filePaths: [
      "packages/daemon/src/approval/approval-service.ts",
      "packages/daemon/src/approval/action-digest.ts"
    ]
  });
  if (advice) {
    process.stdout.write(`    ↳ advisory: ${advice.advisoryState}, ${advice.availablePaths?.length ?? 0} path(s) still free\n`);
  }

  // ---- A real blocker on the shared plan --------------------------------------------
  // Claude lost the race above, so it takes the one path still free to it and then blocks
  // that task on the contended file — which is how a real dependency stall looks.
  await step(claude, "Blocker: Claude takes the free path", "acquire_task", {
    projectRoot,
    taskId: TASKS.claudeReview,
    agentName: "Claude Desktop",
    title: "Review approval expiry semantics",
    filePaths: ["packages/daemon/src/approval/action-digest.ts"],
    leaseSeconds: 3600,
    idempotencyKey: key("claude-review"),
    checklistItemId: ITEMS.vaultRotation
  });
  await step(claude, "Blocker: Claude blocks on contended file", "block_task", {
    projectRoot,
    taskId: TASKS.claudeReview,
    agentName: "Claude Desktop",
    reason: "Waiting on Codex to release the approval service lease before review.",
    evidence: ["explain_lock_conflict: approval-service.ts held by Codex"],
    idempotencyKey: key("claude-block")
  });

  // ---- Governance gate: proposals that require a human decision ---------------------
  await step(antigravity, "Governance: propose a workspace convention", "propose_knowledge", {
    projectRoot,
    knowledgeId: "fact-lease-convention",
    requester: "Antigravity",
    scope: "workspace",
    kind: "convention",
    title: "Always request the complete file set in one acquire_task call",
    body: "Partial acquisition causes interleaved half-locks. Request every path a task will touch in a single call so the winner is unambiguous.",
    priority: 80
  });
  // A second proposal so that after one is approved on camera, the approved-fact panel and
  // a still-pending proposal are both visible in the same frame.
  await step(opencode, "Governance: propose a project pitfall", "propose_knowledge", {
    projectRoot,
    knowledgeId: "fact-redaction-boundary",
    requester: "OpenCode",
    scope: "project",
    kind: "pitfall",
    title: "Secret redaction must survive stream chunk boundaries",
    body: "A secret split across two stdout chunks bypasses naive per-chunk matching. Buffer a trailing window equal to the longest known secret before emitting.",
    priority: 75
  });
  await step(codex, "Governance: request a protected command", "run_project_command", {
    projectRoot,
    commandId: "demo-staging-reload",
    arguments: [],
    requester: "Codex"
  });

  process.stdout.write(
    [
      "",
      `Cockpit seeded. Open ${new URL(endpoint).origin}/ to see:`,
      "  · 4 connected agents, 2 holding live leases",
      "  · a shared plan with live progress and one real blocker",
      "  · a lock conflict that Gemini can explain (explain_lock_conflict)",
      "  · a pending protected command and a pending knowledge proposal in the governance gate",
      "",
      "The two pending items are intentionally left for a human to approve on camera.",
      ""
    ].join("\n")
  );
} finally {
  await Promise.all(Object.values(clients).map((client) => client.close()));
}
