import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  FleetTaskDecompositionRequestV1,
  FleetTaskPlanResponse,
  CloudLockConflict,
  CloudSummaryRequestV1,
  CloudSummaryResponse,
  ProjectManifestV1
} from "@belay/contracts";
import type { ManifestService } from "../indexer/manifest-service.js";
import type { VaultService } from "../vault/vault-service.js";
import {
  completeCloudRequest,
  insertCloudRequest
} from "../db/repositories/cloud-request-repository.js";
import { EgressGuard, type AllowedEgress } from "./egress-guard.js";
import type { CloudSummaryAdapter } from "./cloud-run-adapter.js";

// A manifest summary from Gemini 3.6 Flash on Cloud Run measures 7-9 seconds in practice,
// so an 8 second budget timed out the service's own healthy responses and left the cockpit
// reporting a degraded cloud plane. The advisory is never on a blocking path - callers
// fall back to local behaviour - so the budget can afford the real latency.
const DEFAULT_TIMEOUT_MILLISECONDS = 20_000;

function safeAlias(value: string, fallback: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "");
  return normalized.slice(0, 80) || fallback;
}

function manifestPayload(projectAlias: string, manifest: ProjectManifestV1): CloudSummaryRequestV1 {
  return {
    version: 1,
    kind: "manifest_summary",
    projectAlias,
    manifest: {
      frameworks: manifest.frameworks,
      scripts: manifest.scripts,
      ports: manifest.ports.map((entry) => ({
        port: entry.port,
        evidenceType: entry.evidence
      })),
      topology: manifest.topology.map((entry) => ({
        pathHashOrRelativePath: entry.path,
        symbolKinds: [...new Set(entry.exports.map((item) => item.kind))].sort()
      })),
      git: {
        branch: manifest.git.branch ?? "detached",
        dirtyFileCount: manifest.git.dirtyFileCount
      }
    }
  };
}

export class CloudIntelligenceUnavailableError extends Error {
  constructor(readonly code: "NOT_CONFIGURED" | "NO_MANIFEST" | "CLOUD_UNAVAILABLE") {
    super(`Cloud intelligence unavailable: ${code}`);
    this.name = "CloudIntelligenceUnavailableError";
  }
}

export class CloudIntelligenceService {
  private lastResult: { model: string; generatedAt: string } | undefined;
  private lastFailureAt: string | undefined;
  private readonly fleetPlans = new Map<string, FleetTaskPlanResponse>();

  constructor(
    private readonly database: Database.Database,
    private readonly manifests: ManifestService,
    private readonly vault: VaultService,
    private readonly projectRoot: string,
    private readonly adapter?: CloudSummaryAdapter,
    private readonly options: {
      now?: () => Date;
      createRequestId?: () => string;
      timeoutMilliseconds?: number;
    } = {}
  ) {}

  status(): {
    state: "online" | "degraded" | "local_only";
    message: string;
    model?: string;
    generatedAt?: string;
  } {
    if (this.lastResult) {
      return {
        state: "online",
        message: `Gemini advisory ready · ${this.lastResult.model}`,
        model: this.lastResult.model,
        generatedAt: this.lastResult.generatedAt
      };
    }
    // An unconfigured optional cloud plane is a deliberate local-only posture, not a fault.
    // Only a configured-but-failing adapter is genuinely degraded.
    if (!this.adapter) {
      return {
        state: "local_only",
        message: "Local-only mode · All coordination and approvals active"
      };
    }
    return {
      state: this.lastFailureAt ? "degraded" : "online",
      message: this.lastFailureAt
        ? "Gemini advisory unavailable · Local controls unaffected"
        : "Gemini advisory connected · Awaiting first request"
    };
  }

  projectId(): string | undefined {
    return this.manifests.getLatest(this.projectRoot)?.projectId;
  }

  localProjectRoot(): string {
    return this.projectRoot;
  }

  async summarizeManifest(): Promise<CloudSummaryResponse> {
    if (!this.adapter) throw new CloudIntelligenceUnavailableError("NOT_CONFIGURED");
    const snapshot = this.manifests.getLatest(this.projectRoot);
    if (!snapshot) throw new CloudIntelligenceUnavailableError("NO_MANIFEST");
    const payload = manifestPayload(
      safeAlias(snapshot.manifest.project.name, "belay-project"),
      snapshot.manifest
    );
    return this.dispatch(payload, snapshot.projectId);
  }

  /**
   * Ask Gemini to explain a file-lock collision in terms of the overlapping work,
   * and suggest a non-conflicting split. Purely advisory: the caller still cannot
   * take the lock, and a rejected or unavailable cloud plane is not an error here —
   * the MCP tool falls back to the deterministic local split.
   */
  async explainLockConflict(conflict: CloudLockConflict): Promise<CloudSummaryResponse> {
    if (!this.adapter) throw new CloudIntelligenceUnavailableError("NOT_CONFIGURED");
    const snapshot = this.manifests.getLatest(this.projectRoot);
    const payload: CloudSummaryRequestV1 = {
      version: 1,
      kind: "lock_conflict_advice",
      projectAlias: safeAlias(
        snapshot?.manifest.project.name ?? "belay-project",
        "belay-project"
      ),
      conflict
    };
    return this.dispatch(payload, snapshot?.projectId);
  }

  /**
   * Uses Gemini as the fleet's pre-execution planner. Only a user-authored high-level
   * goal plus the bounded structural manifest crosses the egress guard; source bodies,
   * diffs, and secrets remain local. The returned lease allocation is advisory until
   * each agent acquires it through the existing SQLite-WAL coordination authority.
   */
  async decomposeFleetTask(goal: string): Promise<FleetTaskPlanResponse> {
    if (!this.adapter?.decomposeFleetTask) {
      throw new CloudIntelligenceUnavailableError("NOT_CONFIGURED");
    }
    const snapshot = this.manifests.getLatest(this.projectRoot);
    if (!snapshot) throw new CloudIntelligenceUnavailableError("NO_MANIFEST");
    const candidatePaths = snapshot.manifest.topology.slice(0, 400).map((entry) => ({
      path: entry.path,
      symbolKinds: [...new Set(entry.exports.map((item) => item.kind))].sort()
    }));
    if (candidatePaths.length === 0) {
      throw new CloudIntelligenceUnavailableError("NO_MANIFEST");
    }
    const payload: FleetTaskDecompositionRequestV1 = {
      version: 1,
      kind: "fleet_task_decomposition",
      projectAlias: safeAlias(snapshot.manifest.project.name, "belay-project"),
      goal,
      agents: ["claude-code", "codex", "antigravity"],
      manifest: {
        frameworks: snapshot.manifest.frameworks,
        candidatePaths,
        git: {
          branch: snapshot.manifest.git.branch ?? "detached",
          dirtyFileCount: snapshot.manifest.git.dirtyFileCount
        }
      }
    };
    const plan = await this.dispatchFleetTask(payload, snapshot.projectId);
    this.fleetPlans.set(plan.planId, plan);
    while (this.fleetPlans.size > 8) {
      const oldestPlanId = this.fleetPlans.keys().next().value as string | undefined;
      if (!oldestPlanId) break;
      this.fleetPlans.delete(oldestPlanId);
    }
    return plan;
  }

  fleetTaskPlan(planId: string): FleetTaskPlanResponse | undefined {
    return this.fleetPlans.get(planId);
  }

  private async dispatch(
    payload: CloudSummaryRequestV1,
    projectId: string | undefined
  ): Promise<CloudSummaryResponse> {
    if (!this.adapter) throw new CloudIntelligenceUnavailableError("NOT_CONFIGURED");
    const allowed = await this.inspect(payload);
    if (allowed.payload.kind === "fleet_task_decomposition") {
      throw new CloudIntelligenceUnavailableError("CLOUD_UNAVAILABLE");
    }
    const requestId = this.options.createRequestId?.() ?? randomUUID();
    const createdAt = (this.options.now?.() ?? new Date()).toISOString();
    if (projectId) {
      insertCloudRequest(this.database, { id: requestId, projectId, allowed, createdAt });
    }
    try {
      const result = await this.adapter.summarize(allowed.payload, {
        requestId,
        timeoutMilliseconds: this.options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS
      });
      if (result.requestId !== requestId) {
        throw new Error("Cloud response correlation mismatch.");
      }
      if (projectId) {
        completeCloudRequest(this.database, {
          id: requestId,
          status: "succeeded",
          completedAt: (this.options.now?.() ?? new Date()).toISOString(),
          provider: this.adapter.provider,
          model: result.model
        });
      }
      this.lastResult = { model: result.model, generatedAt: result.generatedAt };
      this.lastFailureAt = undefined;
      return result;
    } catch {
      const completedAt = (this.options.now?.() ?? new Date()).toISOString();
      if (projectId) {
        completeCloudRequest(this.database, {
          id: requestId,
          status: "failed",
          completedAt,
          provider: this.adapter.provider,
          errorCode: "CLOUD_UNAVAILABLE"
        });
      }
      this.lastFailureAt = completedAt;
      throw new CloudIntelligenceUnavailableError("CLOUD_UNAVAILABLE");
    }
  }

  private async dispatchFleetTask(
    payload: FleetTaskDecompositionRequestV1,
    projectId: string
  ): Promise<FleetTaskPlanResponse> {
    if (!this.adapter?.decomposeFleetTask) {
      throw new CloudIntelligenceUnavailableError("NOT_CONFIGURED");
    }
    const allowed = await this.inspect(payload);
    if (allowed.payload.kind !== "fleet_task_decomposition") {
      throw new CloudIntelligenceUnavailableError("CLOUD_UNAVAILABLE");
    }
    const requestId = this.options.createRequestId?.() ?? randomUUID();
    const createdAt = (this.options.now?.() ?? new Date()).toISOString();
    insertCloudRequest(this.database, { id: requestId, projectId, allowed, createdAt });
    try {
      const result = await this.adapter.decomposeFleetTask(allowed.payload, {
        requestId,
        timeoutMilliseconds: this.options.timeoutMilliseconds ?? DEFAULT_TIMEOUT_MILLISECONDS
      });
      if (result.requestId !== requestId) {
        throw new Error("Cloud response correlation mismatch.");
      }
      const allowedAgents = new Set(allowed.payload.agents);
      const allowedPaths = new Set(
        allowed.payload.manifest.candidatePaths.map((entry) => entry.path)
      );
      for (const task of result.tasks) {
        if (!allowedAgents.has(task.assignedAgent)) {
          throw new Error("Cloud plan selected an unavailable agent.");
        }
        if (task.leasePaths.some((path) => !allowedPaths.has(path))) {
          throw new Error("Cloud plan selected a path outside the manifest.");
        }
      }
      completeCloudRequest(this.database, {
        id: requestId,
        status: "succeeded",
        completedAt: (this.options.now?.() ?? new Date()).toISOString(),
        provider: this.adapter.provider,
        model: result.model
      });
      this.lastResult = { model: result.model, generatedAt: result.generatedAt };
      this.lastFailureAt = undefined;
      return result;
    } catch {
      const completedAt = (this.options.now?.() ?? new Date()).toISOString();
      completeCloudRequest(this.database, {
        id: requestId,
        status: "failed",
        completedAt,
        provider: this.adapter.provider,
        errorCode: "CLOUD_UNAVAILABLE"
      });
      this.lastFailureAt = completedAt;
      throw new CloudIntelligenceUnavailableError("CLOUD_UNAVAILABLE");
    }
  }

  private async inspect(
    payload: CloudSummaryRequestV1 | FleetTaskDecompositionRequestV1
  ): Promise<AllowedEgress> {
    const vaultStatus = this.vault.status();
    if (vaultStatus.state !== "unlocked") return new EgressGuard().inspect(payload);
    return this.vault.withUnlockedEnvironment(vaultStatus.variableNames, (environment) =>
      new EgressGuard(Object.values(environment)).inspect(payload)
    );
  }
}
