/**
 * Captures the submission shot list.
 *
 * Each image is produced by putting the running daemon into the state the shot describes
 * and photographing the real Cockpit, so the gallery shows the product rather than a
 * mockup. The cloud shot is the actual `smoke:cloud` transcript rendered legibly, because
 * its value is the redacted text, not a terminal window.
 *
 * Usage:  node scripts/capture-screenshots.mjs [--only 3,4,5]
 *
 * The daemon must be running. Nothing here invents state: the pending proposal is a real
 * proposal, and the contention is a real acquisition race.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "./video/demo-script.mjs";
import * as evidence from "./video/evidence.mjs";
import { createRenderer } from "./video/visuals.mjs";

const outDir = join(repoRoot, "docs", "screenshots");
const workDir = join(repoRoot, "docs", "video", "build", "screenshots");
const argv = process.argv.slice(2);
const onlyArg = argv.indexOf("--only");
const only = onlyArg >= 0 && argv[onlyArg + 1] ? argv[onlyArg + 1].split(",") : null;
const wanted = (id) => !only || only.includes(String(id));

const log = (message) => process.stdout.write(`${message}\n`);

/**
 * Points the Cockpit at one section and photographs it. The manifest is refreshed
 * immediately beforehand so no shot catches a STALE badge, and the page is returned to the
 * top so the governance rail is never clipped.
 */
/**
 * Reindexes until the cockpit actually reports a fresh manifest. The daemon writes its
 * state database inside the repository when --state-dir points there, so a single
 * reindex can be stale again by the time the frame is taken.
 */
async function ensureFreshManifest(attempts = 4) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await evidence.reindexProject();
    const snapshot = await evidence.dashboard().catch(() => null);
    if (snapshot?.manifest && !snapshot.manifest.stale) return true;
  }
  return false;
}

async function shootCockpit(renderer, section, outPath, { settleMs = 1800, focus = null } = {}) {
  await ensureFreshManifest();
  const page = await renderer.cockpitPage(evidence.daemonOrigin);
  await page.goto(`${evidence.daemonOrigin}/#${section}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(settleMs);
  // The Cockpit scrolls an inner container, so window.scrollTo does nothing: the rail ends
  // up clipped at the top of the frame. `focus` puts one panel at the top of the viewport
  // instead, for shots that need two panels in the same frame.
  await page.evaluate((selector) => {
    if (selector) {
      document.querySelector(selector)?.scrollIntoView({ block: "start" });
      return;
    }
    const scroller = document.querySelector("main.cockpit") ?? document.scrollingElement;
    if (scroller) scroller.scrollTop = 0;
  }, focus);
  await page.waitForTimeout(600);
  await page.screenshot({ path: outPath, type: "png" });
  return outPath;
}

/**
 * The knowledge shot needs both halves of the governance story in one frame: at least one
 * approved fact in the shared panel, and at least one proposal still waiting. On fresh
 * state every proposal is pending, so approvals are made one at a time and stop as soon as
 * both conditions hold.
 */
async function ensureKnowledgeMix(renderer) {
  const page = await renderer.cockpitPage(evidence.daemonOrigin);
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const snapshot = await evidence.dashboard().catch(() => null);
    const approved = snapshot?.summary?.knowledgeFacts ?? 0;
    const pendingKnowledge = (snapshot?.approvals ?? []).filter(
      (approval) => (approval.actionKind ?? "") === "knowledge"
    ).length;
    if (approved >= 1 && pendingKnowledge >= 1) return { approved, pendingKnowledge };
    if (pendingKnowledge === 0) {
      await evidence.proposeDemoKnowledge();
      continue;
    }
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(900);
    try {
      const button = page.locator("button", { hasText: /approve/iu }).first();
      await button.waitFor({ state: "visible", timeout: 5000 });
      await button.click({ timeout: 5000 });
    } catch {
      break;
    }
    await page.waitForTimeout(1800);
  }
  const final = await evidence.dashboard().catch(() => null);
  return {
    approved: final?.summary?.knowledgeFacts ?? 0,
    pendingKnowledge: (final?.approvals ?? []).filter((a) => (a.actionKind ?? "") === "knowledge").length
  };
}

/**
 * Makes one successful advisory call so the cockpit reports the cloud plane as connected
 * rather than degraded from an earlier failure. Absent or unreachable cloud is fine - the
 * shots are about local state - so a failure here is not fatal.
 */
async function warmCloudAdvisory() {
  const snapshot = await evidence.dashboard().catch(() => null);
  const state = snapshot?.service?.cloudIntelligence;
  if (state !== "degraded") return state;
  await evidence.explainRaceConflict().catch(() => undefined);
  const after = await evidence.dashboard().catch(() => null);
  return after?.service?.cloudIntelligence;
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const seeded = await evidence.ensureSeeded();
  log(seeded.ran ? `seeded the cockpit (${seeded.activeTasks} active)` : "cockpit already shows live work");
  await evidence.reindexProject();

  const cloudState = await warmCloudAdvisory();
  log(`cloud plane: ${cloudState ?? "unknown"}`);

  const renderer = await createRenderer(join(repoRoot, "docs", "video", "build"));
  try {
    // ---- 3. approved knowledge beside a pending proposal ----------------------------
    if (wanted(3)) {
      const proposed = await evidence.proposeDemoKnowledge();
      log(proposed ? `proposed a pending fact (${proposed})` : "a pending proposal already exists");
      const mix = await ensureKnowledgeMix(renderer);
      log(`  governance: ${mix.approved} approved fact(s), ${mix.pendingKnowledge} pending proposal(s)`);
      const path = await shootCockpit(renderer, "knowledge", join(outDir, "belay-cockpit-knowledge.png"));
      log(`  shot 3 -> ${path}`);
    }

    // ---- 4. exactly one winner, with owner, lease and correlation --------------------
    if (wanted(4)) {
      const race = await evidence.runAcquisitionRace();
      log(`  race resolved with ${race.ok ? "exactly one winner" : "an unexpected result"}`);
      // Focused on the work queue so the lease table and the audit stream beneath it -
      // owner, locked paths, lease, and the correlation ids - land in one frame.
      const path = await shootCockpit(renderer, "tasks", join(outDir, "belay-cockpit-contention.png"), {
        focus: "#tasks"
      });
      log(`  shot 4 -> ${path}`);
    }

    // ---- 5. Cloud Run revision and Gemini result, redaction reviewed ------------------
    if (wanted(5)) {
      const smoke = await evidence.cloudSmoke();
      if (!smoke) {
        log("  shot 5 skipped: scripts/smoke-cloud.mjs is missing");
      } else {
        evidence.saveLog(join(repoRoot, "docs", "video", "build"), "cloud-smoke", smoke.output);
        // The panel's own title already says what this is, and the frame is one line
        // short of fitting the closing verdict otherwise.
        // Gemini's advisory varies in length between runs and can push the closing verdict
        // out of frame. The proof is that a live model answered, so the excerpt is capped
        // and the verdict always survives.
        const maxAdvisoryLines = 3;
        let advisorySeen = 0;
        const lines = [];
        for (const raw of smoke.output.split(/\r?\n/u)) {
          const line = raw.trimEnd();
          if (line.trim() === "Belay cloud smoke test") continue;
          if (/^\s*advisory\s/u.test(line)) {
            advisorySeen += 1;
            if (advisorySeen === maxAdvisoryLines + 1) lines.push("  advisory     ...");
            if (advisorySeen > maxAdvisoryLines) continue;
          }
          lines.push(line);
        }
        const frames = await renderer.terminalFrames({
          slug: "shot-cloud",
          title: "Cloud Run revision and Gemini advisory",
          index: null,
          total: null,
          progress: 0,
          label: "npm run smoke:cloud",
          lines: ["$ npm run smoke:cloud", "", ...lines.filter((line) => line.trim().length > 0)],
          maxFrames: 1
        });
        const path = join(outDir, "belay-cloud-smoke.png");
        copyFileSync(frames.at(-1), path);
        log(`  shot 5 -> ${path}`);
      }
    }
  } finally {
    await renderer.close();
  }
}

main().catch((error) => {
  process.stderr.write(`capture failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
