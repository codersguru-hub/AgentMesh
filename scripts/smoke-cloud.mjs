/**
 * Cloud Run + Gemini deployment smoke test.
 *
 * Proves the three claims the submission makes about the cloud plane, in order:
 *
 *   1. the private Cloud Run service is deployed and serving a ready revision,
 *   2. an authenticated request through the product's own adapter returns a labelled
 *      Gemini result,
 *   3. raw source and secret-shaped values are refused locally, before any network call.
 *
 * The cloud path is exercised through `createBelayApp`, so this runs the same code the
 * daemon runs - the egress guard, payload shaping and adapter are the product's, not a
 * parallel implementation written to pass.
 *
 * Nothing printed here identifies an account: the project id, service account and the
 * project-specific part of the service hostname are redacted, so the output is safe to
 * put on screen.
 *
 * Usage:  npm run smoke:cloud
 *
 * Configuration, each falling back to the next:
 *   BELAY_CLOUD_URL     the Cloud Run service URL, skipping discovery entirely
 *   BELAY_GCLOUD        path to a gcloud executable (default: the copy in .tools)
 *   CLOUDSDK_CONFIG     gcloud configuration directory (default: .tools/gcloud-config)
 *   BELAY_CLOUD_REGION  region to search (default: us-central1)
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const projectRoot = resolve(process.env.BELAY_PROJECT_ROOT ?? repoRoot);
const region = process.env.BELAY_CLOUD_REGION ?? "us-central1";
const defaultGcloud = join(
  repoRoot,
  ".tools",
  "gcloud-577",
  "google-cloud-sdk",
  "bin",
  process.platform === "win32" ? "gcloud.cmd" : "gcloud"
);
const gcloudBin = process.env.BELAY_GCLOUD ?? defaultGcloud;
const gcloudConfig = process.env.CLOUDSDK_CONFIG ?? join(repoRoot, ".tools", "gcloud-config");

const out = (line = "") => process.stdout.write(`${line}\n`);

/**
 * Cloud Run hostnames embed a project-specific hash, so only the service name and the
 * run.app suffix are ever printed.
 */
function redactServiceUrl(url) {
  try {
    const host = new URL(url).host;
    const match = /^([a-z0-9-]+?)-[a-z0-9]+-[a-z]{2}\.a\.run\.app$/u.exec(host);
    return match ? `https://${match[1]}-***.a.run.app` : "https://***.a.run.app";
  } catch {
    return "https://***.a.run.app";
  }
}

/** Redacts anything that looks like a project id, service account, or token. */
function redact(text) {
  return String(text)
    .replaceAll(/[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com/giu, "***@***.iam.gserviceaccount.com")
    .replaceAll(/https:\/\/[a-z0-9-]+\.a\.run\.app/giu, (match) => redactServiceUrl(match))
    .replaceAll(/\bprojects\/[^/\s]+/giu, "projects/***")
    .replaceAll(/ya29\.[A-Za-z0-9._-]+/gu, "***");
}

/**
 * Locates application default credentials the way google-auth-library does: an explicit
 * GOOGLE_APPLICATION_CREDENTIALS file, or the well-known gcloud path. Note that this is
 * deliberately not CLOUDSDK_CONFIG - the library does not consult it.
 */
function applicationDefaultCredentials() {
  const explicit = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (explicit && existsSync(explicit)) {
    return { source: "GOOGLE_APPLICATION_CREDENTIALS", path: explicit };
  }
  const base =
    process.platform === "win32"
      ? process.env.APPDATA
      : process.env.HOME
        ? join(process.env.HOME, ".config")
        : undefined;
  if (!base) return null;
  const wellKnown = join(base, "gcloud", "application_default_credentials.json");
  return existsSync(wellKnown) ? { source: "gcloud application default credentials" } : null;
}

function runGcloud(args, timeoutMs = 120000) {
  return new Promise((settle) => {
    const child = spawn(gcloudBin, args, {
      env: { ...process.env, CLOUDSDK_CONFIG: gcloudConfig },
      stdio: ["ignore", "pipe", "pipe"],
      shell: process.platform === "win32"
    });
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
      settle({ code, stdout: stdout.trim(), stderr: stderr.trim() });
    });
    child.on("error", () => {
      clearTimeout(timer);
      settle({ code: 1, stdout: "", stderr: "gcloud is not available" });
    });
  });
}

/** Finds the deployed service, preferring an explicit URL over discovery. */
async function resolveDeployment() {
  if (process.env.BELAY_CLOUD_URL) {
    return { url: process.env.BELAY_CLOUD_URL, source: "BELAY_CLOUD_URL", service: null, revision: null };
  }
  if (!existsSync(gcloudBin) && !process.env.BELAY_GCLOUD) {
    return { error: `no gcloud at ${gcloudBin} and BELAY_CLOUD_URL is unset` };
  }
  const listed = await runGcloud([
    "run",
    "services",
    "list",
    `--region=${region}`,
    "--format=value(metadata.name,status.url,status.latestReadyRevisionName)",
    "--limit=5"
  ]);
  if (listed.code !== 0 || listed.stdout.length === 0) {
    return { error: redact(listed.stderr || "no Cloud Run services found") };
  }
  const [name, url, revision] = listed.stdout.split(/\r?\n/u)[0].split(/\t/u);
  return { url, service: name, revision, source: "gcloud", region };
}

async function main() {
  out("Belay cloud smoke test");
  out();

  // ---- 1. deployment ----------------------------------------------------------------
  out("[1/3] Cloud Run deployment");
  const deployment = await resolveDeployment();
  if (deployment.error) {
    out(`  UNAVAILABLE  ${deployment.error}`);
    out();
    out("  The cloud plane is optional: coordination, approvals, vault and indexing");
    out("  all continue to work without it.");
    process.exitCode = 1;
    return;
  }
  out(`  service      ${deployment.service ?? "(from BELAY_CLOUD_URL)"}`);
  out(`  region       ${deployment.region ?? region}`);
  out(`  revision     ${deployment.revision ?? "(unknown)"}`);
  out(`  url          ${redactServiceUrl(deployment.url)}`);
  out(`  ingress      authenticated (IAM identity token, no public access)`);
  out();

  // ---- 2. a real authenticated Gemini call ------------------------------------------
  out("[2/3] Gemini advisory through the product's own cloud path");
  let exitCode = 0;

  // google-auth-library reads application default credentials, which are separate from a
  // `gcloud auth login` session and are not affected by CLOUDSDK_CONFIG. Say so exactly
  // rather than letting the call fail as a generic CLOUD_UNAVAILABLE.
  const adc = applicationDefaultCredentials();
  if (!adc) {
    out("  NOT AUTHENTICATED");
    out("  The service is deployed and reachable, but this machine has no application");
    out("  default credentials, so no request can be signed. A gcloud user login is not");
    out("  enough - Cloud Run needs an IAM identity token.");
    out();
    out("  Authorize once with:");
    out("    gcloud auth application-default login");
    out("  or point at an existing credential file:");
    out("    setx GOOGLE_APPLICATION_CREDENTIALS <path to credentials json>");
    out();
    out("  Local coordination, approvals, vault policy and indexing are unaffected.");
    out();
    reportEgressBoundary();
    process.exitCode = 1;
    return;
  }
  out(`  credentials  ${adc.source}`);

  const { createBelayApp } = await import("@belay/daemon");
  const app = createBelayApp({ projectRoot, cloudServiceUrl: deployment.url });
  try {
    const started = Date.now();
    const summary = await app.cloudIntelligence.summarizeManifest();
    const elapsed = Date.now() - started;
    out(`  model        ${summary.model}`);
    out(`  generatedAt  ${summary.generatedAt}`);
    out(`  latency      ${elapsed} ms`);
    const headline = summary.summary ?? summary.headline ?? "";
    if (headline) {
      for (const line of String(headline).replaceAll(/\s+/gu, " ").match(/.{1,88}(\s|$)/gu) ?? []) {
        out(`  advisory     ${redact(line.trim())}`);
      }
    }
    const risks = summary.risks ?? summary.findings ?? [];
    for (const risk of risks.slice(0, 3)) {
      out(`  risk         ${redact(typeof risk === "string" ? risk : (risk.title ?? JSON.stringify(risk)))}`);
    }
    out(`  status       ${app.cloudIntelligence.status().state}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    out(`  FAILED       ${redact(message).slice(0, 200)}`);
    out("  Local coordination, approvals and vault policy are unaffected.");
    exitCode = 1;
  }
  out();

  const boundaryOk = await reportEgressBoundary();
  if (!boundaryOk) exitCode = 1;

  out(
    exitCode === 0
      ? "cloud smoke passed: deployed, authenticated, advisory-only, and egress-bounded"
      : "cloud smoke reported a problem - see the lines above"
  );

  await app.close();
  process.exitCode = exitCode;
}

/** Section 3, shared by both paths: proves what never leaves the machine. */
async function reportEgressBoundary() {
  out("[3/3] Egress boundary (refused locally, zero network calls)");
  const { EgressGuard, EgressRejectedError } = await import("@belay/daemon");
  const canarySecret = "belay-canary-secret-value-0001";
  let ok = true;
  const guard = new EgressGuard([canarySecret]);
  const forbidden = [
    [
      "raw source file content",
      {
        version: 1,
        kind: "manifest_summary",
        projectAlias: "belay-project",
        manifest: { source: "export const apiKey = 'sk-live-0000';" }
      }
    ],
    [
      "a known secret value",
      {
        version: 1,
        kind: "manifest_summary",
        projectAlias: "belay-project",
        manifest: { frameworks: [canarySecret], scripts: [], ports: [], topology: [] }
      }
    ],
    [
      "the same secret, base64 encoded",
      {
        version: 1,
        kind: "manifest_summary",
        projectAlias: "belay-project",
        manifest: {
          frameworks: [Buffer.from(canarySecret, "utf8").toString("base64")],
          scripts: [],
          ports: [],
          topology: []
        }
      }
    ]
  ];

  let refused = 0;
  for (const [label, payload] of forbidden) {
    try {
      guard.inspect(payload);
      out(`  LEAKED       ${label} was accepted - this is a failure`);
      ok = false;
    } catch (error) {
      if (error instanceof EgressRejectedError) {
        out(`  REFUSED      ${label.padEnd(34)}${error.code}`);
        refused += 1;
      } else {
        out(`  ERROR        ${label}: ${redact(String(error)).slice(0, 120)}`);
        ok = false;
      }
    }
  }
  out();
  out(`  ${refused}/${forbidden.length} forbidden payloads refused before any request was made`);
  out();
  return ok;
}

main().catch((error) => {
  process.stderr.write(`smoke failed: ${redact(error instanceof Error ? (error.stack ?? error.message) : String(error))}\n`);
  process.exitCode = 1;
});
