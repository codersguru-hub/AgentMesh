# Four-minute Belay demo script

## The Winning Demo Formula — video checklist

Judges evaluate submissions largely from the three-to-four-minute video. Use this flow as the recording checklist, and replace any illustrative metric with the value printed by the current verifier before recording.

### The Hook — 0:00–0:30

**Narration:** “When you run Claude Code and Codex on the same project, two things happen: they burn 40,000 tokens rescanning static files, and they can easily leak your plaintext `.env` database secrets into prompt logs. We built Belay—the local control plane that fixes this.”

Keep the token figure only when the recording includes a measured before/after comparison. Otherwise say “tens of thousands of tokens” and show the actual benchmark output.

### The Speed & Context Win — 0:30–1:15

- Run the deterministic indexer.
- Show live timing under 100 ms when reproduced on the recording machine.
- Show the bounded canonical manifest and its estimated token count. The current hero verifier reports approximately 199 tokens; the benchmark fixture may report approximately 275 tokens.
- Explain that the manifest replaces repeated raw repository scans with stable structural context.

### The Multi-Agent Concurrency Lock — 1:15–2:00

- Show Codex claiming `/src/api/auth.ts`.
- Switch to Claude Code attempting to claim the same file.
- Show the immediate conflict rejection, owner/lease information, and stage-context rerouting.
- Emphasize that SQLite WAL and the atomic acquisition transaction produce one winner and no partial lock state.

### The “Wow Moment” — Zero-Leak Intercept & Human Approval — 2:00–3:00

- Have Claude request a protected staging deploy such as `pm2 reload` (the current built-in demo uses a safe local staging-reload simulation).
- Show the Belay cockpit’s amber approval card with the immutable SHA-256 action digest, target, and policy reason. (`demo-staging-reload` itself needs no vault secret, so it shows no masked variable; run `npm run demo:request-vault-approval` for a card that does.)
- Click **Approve** once and show the terminal outcome.
- Run `npm run verify:no-leaks` to prove that the canary secret was not persisted in SQLite, logs, MCP output, dashboard responses, or cloud fixtures.
- To show the fail-closed negative case deliberately, run `npm run demo:request-vault-approval` and approve it: the command needs a vault secret, the vault is locked/unconfigured by default, so execution throws `VAULT_LOCKED` and the approval is recorded `indeterminate` -- not silently claimed as a successful production SSH deployment.

### Google Cloud Run & Gemini Fleet Intelligence — 3:00–3:45

- Enter “Refactor auth to RS256 and add rate limiting” in Studio with **Plan with Gemini** enabled.
- Show the structured Claude/Codex/Antigravity task split, dependency order, risk labels, and assigned lease paths before any agent executes.
- Click **Reserve fleet leases** and show the atomic SQLite-WAL reservation; explain that one conflict rolls the entire fleet plan back.
- Show the Cloud Run revision and Gemini response/request evidence without exposing account identifiers, tokens, cookies, or local gcloud configuration.
- Follow with the negative test showing raw source and known secrets are blocked locally before network transmission.
- State that Gemini is the Cloud Arbiter and fleet-planning intelligence, while local SQLite-WAL remains the enforcement authority; coordination, vault policy, indexing, and approvals continue when cloud intelligence is unavailable.

### Final proof — 3:45–4:00

- Show the final verifier summary, architecture diagram, and repository README.
- Close with: “Belay is the local control plane for shared state, token-efficient context, safe execution, and human authority across heterogeneous coding agents.”

## Before recording

- Use a 1440×960 or 1920×1080 capture with terminal text at least 16 px.
- Start from a clean state directory and the prepared demo repository.
- Keep the Cloud Run console and private service URL ready, but do not show account tokens, environment values, local identities, or `.tools/gcloud-config`.
- Run `npm run demo:verify` once off-camera to confirm the machine is ready.

## Rendering the video (no recording)

The submission video is produced entirely programmatically. Nothing is screen-recorded and
nothing is narrated live:

```bash
npm run render:video
```

That writes `docs/video/belay-demo.mp4` plus a matching `.srt`. The renderer:

1. **Synthesizes narration** per beat from the `**Narration:**` lines below, through the
   local Voicebox app (`--tts edge` switches to `edge-tts` on a machine without it).
2. **Captures real evidence** — it runs the hero verifier, the no-leak sweep and the
   egress boundary test, drives a live acquisition race over MCP, and requests the
   protected command and approves it in the running Cockpit through Playwright. Every
   transcript on screen is stdout from those runs; the captures land in
   `docs/video/build/logs/`.
3. **Renders frames** at 1920×1080 — terminal panels from the captured output, real
   Cockpit screenshots, and title/diagram cards.
4. **Composites** with ffmpeg against the narration track.

Beat length is whatever its narration takes to speak, so picture and voice stay locked
without trimming. `npm run render:check` runs preflight only. `--reuse` keeps existing
audio and re-renders the picture, which is the fast loop when adjusting visuals.

Requirements: ffmpeg on PATH, the daemon running, Chrome installed (Playwright drives it
directly, so no browser download), and Voicebox running unless `--tts edge` is used.

### Render against a clean state directory

`seed-demo` is re-runnable, but each run adds its own checklist items, so a state
directory that has been seeded many times accumulates milestones and the opening shot
shows duplicates. For the submission render, point the daemon at a disposable state
directory first:

```bash
node bin/belay.js start --state-dir .belay-demo
```

`.belay-demo/` is gitignored. Delete it to start over; the renderer seeds it from empty.

## Running the take with the director

The director is the manual fallback, kept for rehearsing a beat or recording a live take by
hand. The rendered video above is the delivery path.

`scripts/demo-director.mjs` runs the timed beats below as a single narrated take. It reads
the narration, visuals and timings straight out of this file, so editing a beat here
changes what the director shows and when it expects that beat to end.

```bash
npm run demo:check
```

Preflight: Node version, daemon build, daemon reachability, whether the cockpit is seeded,
manifest freshness, leases left by an earlier take, ffmpeg, and anything on disk or in the
environment that should stay out of frame. It also prints the ffmpeg capture command.

Then two windows:

- **off camera** — `npm run demo:prompter` shows the cue card for the current beat, the
  take clock against the target timeline, and whether the take is ahead or behind.
- **on camera** — `node scripts/demo-director.mjs` runs the take. Each beat starts its real
  command automatically and then waits for ENTER, so narration is never cut short.

The director never advances on its own. The approval beat additionally waits for a human
to decide in the cockpit and reports the state the daemon recorded, including
`indeterminate`. Add `--fail-closed` to run the vault-locked negative beat instead of the
staging reload, `--from <n>` to restart at one beat, and `--rehearse` to walk the beats
without running any command.

Takes are repeatable: the director frees the acquisition-race paths before the race beat,
so a second take shows the same single-winner result as the first.

## 0:00–0:25 — Problem and category

**Visual:** Belay cockpit overview.

**Narration:** “Coding agents are independent operators. They rescan the same repository, collide on files, and ask for credentials through unsafe prompt-visible workflows. Belay is not another orchestrator—it is the local control plane that gives those agents shared rails and a secure execution boundary.”

## 0:25–0:55 — Deterministic context

**Visual:** Run `npm run demo:verify`; pause on manifest metrics.

**Callouts:** byte size, estimated tokens, warm indexing time, stable SHA-256 version.

**Narration:** “Static facts are computed, not generated. The same repository produces byte-identical bounded context. Secret-shaped files and local tool state are excluded before parsing.”

## 0:55–1:30 — Heterogeneous agent collision prevention

**Visual:** Show the two MCP contenders and then the cockpit/task context.

**Narration:** “Codex and Claude Code race for the shared schema. SQLite `BEGIN IMMEDIATE` gives exactly one winner. The other agent receives the current owner, lease, path conflict, and correlation ID—no partial task or lock state.”

## 1:30–2:10 — Zero-leak vault execution

**Visual:** Hero verifier vault section and `[REDACTED]` output; show the artifact scan result.

**Narration:** “The random environment secret is encrypted with AES-GCM, while `age` wraps only the DEK to the local SSH identity. The agent requests a registered command, never a value. The child receives the secret in memory, but raw, Base64, Base64url, hex, and URL-encoded output are scrubbed across chunk boundaries. SQLite, vault, API captures, and cloud fixtures scan clean.”

## 2:10–2:55 — Judge wow moment: approval intercept

**Visual:** [`screenshots/belay-cockpit-approval.png`](screenshots/belay-cockpit-approval.png), then live cockpit if available.

**Narration:** “Claude Code requests a protected staging reload. Belay freezes the exact command, target, working directory, environment names, policy version, and expiry into one SHA-256 digest. Nothing executes while pending. One human decision authorizes that digest once; replay or mutation is rejected.”

Optional negative beat: run `npm run demo:request-vault-approval`, approve the card, and show the resulting `indeterminate` audit entry live -- or use [`screenshots/belay-cockpit-fail-closed.png`](screenshots/belay-cockpit-fail-closed.png) -- and explain that an ambiguous execution never auto-retries.

## 2:55–3:30 — Gemini Cloud Arbiter on Cloud Run

**Visual:** Studio’s `Plan with Gemini` mode produces a three-agent lease plan; then show the Cloud Run ready revision, sanitized request evidence, and local forbidden-egress test.

**Narration:** “Gemini is our Cloud Arbiter and Fleet Intelligence Engine. Before an agent executes, Genkit on private Cloud Run decomposes the goal across Claude, Codex, and Antigravity, assigning dependencies, risk, and required lease paths from sanitized AST topology. The local daemon rejects invented paths and SQLite-WAL still enforces every lease. Raw source or known secrets are blocked locally with zero network calls, and all local controls stay active if the cloud is unavailable.”

## 3:30–4:00 — Proof and vision

**Visual:** Final verifier summary, architecture diagram, repository README.

**Narration:** “Belay proves the infrastructure layer: deterministic context, atomic coordination, secret-safe execution, and human authority across heterogeneous agents. The MVP is local-first and single-user; production SSH fleet adapters and team identity are intentionally next, not falsely claimed today.”

End card: **Belay — shared state, safe execution, human authority.**
