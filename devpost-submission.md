# Title

Belay

## One-line Summary

The local trust and memory plane that lets Codex, Claude Code, Antigravity, and other coding agents work as one auditable fleet without sharing private chats or plaintext secrets.

## Problem

Developers increasingly run several AI coding agents against the same codebase. Those agents behave like isolated operators: they rescan the same repository, lose important decisions between sessions, collide on files, and sometimes request credentials or production actions through prompt-visible workflows.

Existing orchestrators usually assume they own every agent. That does not fit a developer who deliberately chooses different tools for different jobs. The missing layer is neutral infrastructure that lets independent agents coordinate safely without merging their private conversations or handing one agent authority over the others.

## Solution

Belay is a local-first control plane exposed through MCP. It gives heterogeneous coding agents one bounded view of approved project knowledge, planned work, task ownership, file leases, progress, blockers, and recent activity.

Agents can propose durable project or workspace facts, but those facts remain invisible until a human approves the exact canonical payload digest. Risky commands use the same approval machinery. Secrets stay behind a local encrypted vault and are injected only into registered child processes; known raw and encoded forms are scrubbed from streamed output.

A private Genkit TypeScript service on Google Cloud Run makes Gemini 3.6 Flash the Cloud Arbiter and Fleet Intelligence Engine. Before execution, Gemini decomposes a Workbench goal into structured tasks for Claude Code, Codex, and Antigravity, assigns required repository-relative lease paths, orders dependencies, and labels risk. It also adjudicates live lock conflicts and explains sanitized audit risk. Raw source, secret-shaped content, connection strings, unknown fields, and known secret encodings are rejected locally before any network call. Gemini cannot authorize execution or mutate local state; SQLite-WAL remains the enforcement authority.

## Why This Matters

Multi-agent coding becomes much more useful when agents can operate concurrently, but concurrency without shared state creates expensive rescans, duplicated work, contradictory assumptions, and unsafe mutation paths. Belay turns those independent tools into a governable fleet while preserving their autonomy.

For a solo developer or lead architect, the result is practical: agents see the same approved facts, avoid files another agent owns, continue from durable checklist state, use credentials without receiving them, and leave a correlated audit trail. The product targets the Fortified Enterprise Fleet category as a local Memory Bank, Agent Gateway, security boundary, and observability plane for coding agents.

## How We Used AI

- Codex, Claude Code, Antigravity, and other MCP-compatible agents are the independent operators coordinated by Belay.
- Gemini 3.6 Flash runs through Genkit TypeScript on a private Google Cloud Run service and produces **pre-execution fleet decomposition**, structured repository summaries, risk explanations, and live conflict adjudication from schema-validated structural metadata.
- **Gemini is the chief orchestration intelligence.** Studio’s `Plan with Gemini` path sends a high-level goal plus bounded AST topology to `POST /v1/decompose-fleet-task`. Gemini assigns Claude Code, Codex, and Antigravity to concrete subtasks, lease paths, dependencies, acceptance criteria, and risk levels. The local daemon rejects invented paths/agents and still grants every real lease through SQLite-WAL.
- **Gemini is reachable from the agent workflow, not just the dashboard.** Before execution it turns a high-level goal into a structured fleet/lease plan; after a collision, the `explain_lock_conflict` MCP tool asks it to explain the real overlap and a non-conflicting split. These are the semantic decisions the deterministic engine should not guess: SQLite knows whether paths intersect, while Gemini interprets topology and proposes how the fleet should divide the work.
- The local egress guard enforces an exact allowlist and blocks raw source, private-key markers, connection strings, bearer tokens, known secrets and encodings, unknown keys, and oversized payloads before network activity.
- Generative output is labeled with its model, request ID, risk level, and generation time. Cloud failure leaves local coordination, memory, approvals, vault policy, and execution available.


## Key Features

- **Dual-mode visual portal (🛡️ Cockpit & ⚡ Studio):**
  - **🛡️ Cockpit:** Multi-agent fleet governance board for active tasks, file lock topologies, checklist boards, AES-256 vault posture, audit log, and Gemini conflict adjudication.
  - **⚡ Studio:** Interactive 3-column tablet & remote workbench providing direct prompt dispatching to Antigravity (`agy`), OpenAI Codex, and Claude Code with real-time Git diff inspection and cryptographic approval binding (`stdinDigest`).
- **Approved semantic memory:** durable project- and workspace-scoped facts with priority, provenance, explicit supersession, collision detection, and a separately bounded pinned context block.
- **Shared workflow state:** auditable checklists with dependencies, owners, progress, blockers, acceptance criteria, and verification evidence.
- **Atomic file ownership:** SQLite WAL transactions provide task leases and repository-relative file locks with exactly one winner for overlapping concurrent requests.
- **Deterministic compact context:** `project://manifest` provides byte-identical structural context with stable hashing, exclusion counters, token estimates, and a strict 3,200-byte ceiling.
- **Secret-safe execution:** AES-256-GCM encrypts environment payloads while `age` wraps the random DEK to a supported local SSH identity. Registered commands run with `shell: false`, minimal environment injection, time/output bounds, and streaming secret redaction.
- **Human-governed mutation:** command and knowledge proposals are bound to canonical SHA-256 digests, expire, accept one authenticated decision, reject replay or mutation, and fail closed after ambiguous restarts.
- **Privacy-filtered Gemini:** private-IAM Cloud Run service using Genkit and Gemini 3.6 Flash, with local and server-side schema validation and no callback into the local executor.
- **Gemini fleet task decomposition:** a structured Genkit flow converts a high-level Workbench goal into an agent/lease dependency plan before any agent prompt runs. Cloud output is double-validated and cannot bypass the local coordination authority.
- **Gemini conflict adjudication:** the `explain_lock_conflict` MCP tool turns a bare lock collision into an explanation of the real overlap plus a non-conflicting split, using only aliases, relative paths, and symbol kinds. It is strictly advisory — it cannot acquire, release, or override a lease — and it always returns the deterministic local split first, so an unconfigured, policy-blocked, or unreachable cloud degrades the answer instead of failing the call.
- **Reproducible proof:** integrated hero flow, no-leak scans, architecture assets, Cloud Run evidence, and documented clean-checkout commands.

## Architecture

Agent clients are treated as untrusted callers. They connect over loopback-only MCP Streamable HTTP to a local TypeScript daemon. The daemon owns canonical paths, SQLite WAL state, project/workspace knowledge, workflow checklists, file leases, indexing, vault state, command policy, approvals, audit events, and cloud egress validation.

The browser cockpit & studio workbench are privileged but secret-free. They receive sanitized local REST/WebSocket projections and a process-local HttpOnly decision token. The cloud intelligence service is separately deployed on private Cloud Run with a dedicated runtime identity. It receives only allowlisted structural metadata, invokes Gemini through Genkit, and has no route back to the repository, SQLite database, vault, or executor.

Architecture upload: `docs/assets/belay-architecture.png` (1440×900 PNG, also available as editable SVG and Mermaid source).

### Technologies Used

TypeScript, Node.js, MCP Streamable HTTP, SQLite WAL, Zod, React, Vite, WebSockets, AES-256-GCM, the `age` CLI, Genkit, Gemini 3.6 Flash, Vertex AI, Cloud Run, Cloud Build, and Vitest.

### Other Data Sources

Belay reads only the selected local repository's allowlisted structural metadata, Git branch/dirty-path metadata, agent-authored checklist and knowledge records, and sanitized local audit events. It does not use external datasets. The cloud service receives a smaller schema-validated projection and never receives raw repository bodies, vault values, private keys, or connection strings.

### Findings and Learnings

- Persistence alone is not shared memory: episodic activity, durable approved knowledge, and planned workflow state need different lifecycles and context budgets.
- Shared memory needs governance. Letting an agent silently write “truth” can amplify one mistaken conclusion across the fleet, so semantic facts use provenance, digest approval, and supersession rather than deletion.
- Exactly-once mutation needs explicit pending, approved, executing, terminal, and indeterminate states; a button and a boolean are not sufficient.
- Deployment packaging is part of the privacy boundary. A narrow Docker image is not enough if the source uploader sends a broader context first, which led us to generate and verify an exact 21-file Cloud Run build context.
- Negative evidence is more useful than a security adjective. The project tests tampering, replay, encoded secret variants, stream boundaries, restart ambiguity, and forbidden cloud payloads.

## Testing Instructions

Requirements: Node.js 22+, npm 10+, and Git on `PATH`. The vault and live cloud smoke paths are optional for basic local verification.

```bash
git clone https://github.com/codersguru-hub/Belay.git
cd Belay
npm ci
npm run build
npm test
npm run demo:verify
npm run verify:no-leaks
```

Expected verified baseline:

- Full regression: **54 tests across 12 files.** On a clean checkout without the `age` CLI this
  reports **53 passed, 1 skipped** — the real-`age` Ed25519 round-trip gates itself on `age` and
  `ssh-keygen` being present rather than silently faking the adapter. With `age` installed all 54
  run. This is the only conditional test in the suite.
- Hero flow: deterministic manifest, two MCP contenders with exactly one lock winner, durable restart recovery, secret-backed child execution with redacted output, exactly-once approval with replay rejection, one allowed cloud request, and zero forbidden cloud calls.
- No-leak suite: **19 focused tests** across executor security, cloud egress, and the integrated hero flow.
- Manifest reference result: 795 canonical bytes, approximately 199 estimated tokens; timing is measured on each machine rather than hard-coded.

These counts are the actual output of the commands above on a clean checkout of the submitted
revision. If a future commit changes them, treat the command output as authoritative over this
document.

To populate the cockpit with a realistic multi-agent state for review (four connected agents,
two live leases, a genuine lock conflict, a blocked plan item, and pending approvals):

```bash
npm run start
# in a second terminal:
npm run demo:seed
```

`demo:seed` drives the real MCP surface as four independent clients, so the resulting state and
audit trail are genuine rather than fixture data written behind the daemon. It deliberately
leaves the protected command and the knowledge proposals pending, because granting them is the
human authority step.

To run the local cockpit:

```bash
npm run start
# equivalently, to also open the Cockpit automatically:
node bin/belay.js start --open
```

(Run these from inside the cloned repository. Belay is not published to the public npm
registry, so there is no `npx belay` entry point.)

Then connect MCP clients to `http://127.0.0.1:3420/mcp` (or use 1-click config snippets inside the Cockpit UI). The cockpit is served at `http://127.0.0.1:3420/`.

## Public Demo Link

**TODO:** Add a hosted project URL if one is prepared. The current product is intentionally a loopback-only local control plane. The private Cloud Run intelligence service is deployment proof, not a public user interface.

## Public Repository Link

https://github.com/codersguru-hub/Belay (Commit: `9fe90e5`)

## Demo Video

https://www.youtube.com/watch?v=AYwDyCFjJwQ

### Outline (2:30, 1920×1080)

1. **0:00–0:18 — Problem and category:** independent coding agents rescan the same repository, collide on files, and ask for credentials through prompt-visible workflows; the Cockpit opens on a live fleet.
2. **0:19–0:31 — Deterministic context:** the hero verifier prints the bounded manifest — byte size, estimated tokens, warm index time, and a stable SHA-256 version.
3. **0:32–0:47 — Concurrent work:** Codex and Claude Code request an overlapping file set in one acquisition window; SQLite produces exactly one winner and one actionable `LOCK_CONFLICT` with a correlation ID and no partial locks.
4. **0:48–1:13 — Secret-safe action:** the no-leak sweep shows the vault value reaching the child process while raw, Base64, Base64url, hex, and URL-encoded forms stay absent from returned and persisted artifacts.
5. **1:13–1:34 — Human authority:** the amber protected-command card with its exact digest, approved once in the live Cockpit, ending in the state the daemon actually recorded.
6. **1:34–2:05 — Gemini and Cloud Run:** `npm run smoke:cloud` shows the private ready revision, a labelled Gemini 3.6 Flash advisory, and forbidden raw-source and secret-shaped payloads refused before any network call.
7. **2:06–2:28 — Proof:** the architecture diagram and the closing claim — shared state, safe execution, human authority.

The video is rendered programmatically by `npm run render:video`, not screen-recorded: narration is synthesized per beat, and every terminal panel is stdout captured from those same commands while every Cockpit frame is a screenshot of the running UI. Beat length follows the narration, so the timings above are the rendered result rather than a target. Output is 1080p, shows visible Google Cloud proof, and reveals no account identifiers, tokens, browser cookies, identities, vault values, or local Cloud SDK configuration. Captured transcripts for every claim are kept in `docs/video/build/logs/`.

## Screenshot Shot List

1. `docs/screenshots/belay-cockpit-approval.png` — pending protected-command approval with requester, target, digest, expiry, and policy reason. (`demo-staging-reload` registers no environment variables, so no masked names appear on this specific card; commands that do would show them redacted.)
2. `docs/screenshots/belay-cockpit-fail-closed.png` — a real `demo-vault-reload` request, approved while the vault is locked/unconfigured, ending `indeterminate` rather than silently succeeding; reproducible with `npm run demo:request-vault-approval`.
3. `docs/screenshots/belay-cockpit-knowledge.png` — the governance gate holding a real workspace-scoped proposal with its requester, digest, expiry, and policy reason, beside the shared-knowledge panel of already-approved facts. No repository-sensitive content appears.
4. `docs/screenshots/belay-cockpit-contention.png` — the work queue after a live acquisition race: owning agent, task id, locked paths, and remaining lease per task, with the audit stream beneath carrying the correlation ID for each event.
5. `docs/screenshots/belay-cloud-smoke.png` — `npm run smoke:cloud` showing the ready Cloud Run revision, a labelled Gemini 3.6 Flash advisory, and three forbidden payloads refused before any network call. Project ids, service accounts, tokens, and the project-specific part of the Cloud Run hostname are redacted.

All three are reproducible with `node scripts/capture-screenshots.mjs`, which puts the daemon into each state and photographs the running Cockpit rather than composing a mockup.

## Submission Readiness Notes

- Registered for the All Things Agentic Hackathon; live status was `submissions_open` when this draft was prepared.
- Official deadline: September 1, 2026 at 00:00 UTC (August 31 at 5:00 PM Pacific Time).
- Target category: **Fortified Enterprise Fleet**.
- Required Google stack is implemented: **Genkit**, **Cloud Run**, and **Gemini 3.6 Flash** through the Google AI/Vertex integration.
- Required architecture asset exists in an accepted PNG format and is below the 35 MiB limit.
- Reproducible README instructions and automated verification exist.
- A hosted website is optional; a demo video is required and remains outstanding.
- Final personal form answers, repository revision, video URL, and optional bonus links remain open.

## Known Limitations

- The MVP supports one local developer profile and one machine; it does not provide multi-user identity, cross-machine locks, or enterprise RBAC.
- Agent names are caller-declared rather than cryptographically signed identities.
- The built-in protected-action demo uses a disposable local process; production SSH/SFTP host onboarding, pinned host keys, rollback, and fleet lifecycle management are not implemented.
- The vault's `age` adapter supports readable RSA/Ed25519 SSH identity files, not `ssh-agent` or hardware-backed keys. On Windows, vault-file confidentiality relies on the containing user directory ACL.
- JavaScript cannot guarantee compiler-level memory zeroization; buffers are short-lived and overwritten on a best-effort basis.
- Gemini is advisory and cannot authorize or mutate local state. Cloud unavailability leaves local features operating in degraded mode.
- The Genkit dependency graph carries 59 transitive npm advisories (52 moderate, 7 high, 0 critical), every one of which reports `fixAvailable: false` — they resolve through `@genkit-ai/*` and its OpenTelemetry chain, so no non-breaking upgrade exists. They are scoped entirely to the Cloud Run advisory service: `npm audit --omit=dev --workspace @belay/daemon` reports **0 vulnerabilities**, so the local security boundary that holds the vault, executor, approval gate, and SQLite state is unaffected. The cloud service additionally runs under private IAM, receives only allowlisted structural metadata, and has no route back to the repository, database, vault, or executor.
- Three historical pre-fix Cloud Run source archives remain in the participant-owned Google Cloud project and are disclosed in `docs/hackathon-build/cloud-run-evidence.md`.

## TODO Official Form Fields

| Field ID | Official field | Draft answer / action |
| --- | --- | --- |
| `28083` | Submitter Type | **TODO confirm:** likely `Individuals`; do not finalize without Ahmed's confirmation. |
| `28084` | Country of residence | **TODO confirm.** |
| `28085` | Category | `Fortified Enterprise Fleet`. |
| `28086` | Organization name | **TODO confirm:** organization name if applicable, otherwise `N/A` if accepted by the form. |
| `28087` | Project start date | **TODO confirm:** repository evidence currently indicates `08-15-26`, within the submission period. Confirm no project code predates the hackathon. |
| `28141` | Code repository | `https://github.com/codersguru-hub/Belay`. Verify the final revision is pushed. |
| `28089` | Reproducible testing instructions in README | `Yes`. |
| `28088` | Hosted project URL | Optional; currently none. Do not use the private Cloud Run endpoint as a public UI. |
| `28090` | Private testing instructions | Use the commands in **Testing Instructions** above; mention Windows sandbox `spawn EPERM` may require running Vite/npm outside a restricted host. |
| `28091` | Google SDKs | `Genkit`. Do not claim the standalone Google GenAI SDK. |
| `28142` | Google Cloud services | `Cloud Run`. |
| `28092` | Architecture diagram upload | Upload `docs/assets/belay-architecture.png`; this is a file upload, not a text answer. |
| `28093`, `28101` | Startup Prize organization/email | Leave blank unless submitting for an eligible incorporated organization. |
| `28143` | Google AI models | `gemini-3.6-flash`. |
| `28106` | Optional public build content | **TODO optional:** add a public article/video that states it was created for this hackathon. |
| `28107` | Optional social post | **TODO optional:** add a public post containing `#AllThingsAgenticHackathon`. |


## Assisted and Pre-existing Work Disclosure

Ahmed Soliman directed all product, architecture, security boundary, and cloud deployment decisions. AI coding assistants were used to accelerate implementation and testing. Superdesign produced an initial cockpit canvas from an approved design-system reference. Gemini is a runtime feature used only for privacy-filtered structural summaries and did not receive the local repository or vault values. No project code predates the hackathon start.

**TODO:** Ahmed to confirm the pre-existing work statement above before final submission.
