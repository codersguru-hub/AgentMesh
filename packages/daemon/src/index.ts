import { main } from "./cli.js";

// If executed directly as script, run CLI main
if (process.argv[1]?.endsWith("index.js") || process.argv[1]?.endsWith("index.ts")) {
  void main().catch((error) => {
    process.stderr.write(`[Belay Fatal] ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}

export { createBelayApp, type BelayApp, type CreateBelayAppOptions } from "./app.js";
export { loadConfig, type BelayConfig, type ProjectConfigFile } from "./config.js";
export { CoordinationService } from "./coordination/coordination-service.js";
export { openStateDatabase } from "./db/connection.js";
export { migrateDatabase } from "./db/migrate.js";
export { bootstrapProject } from "./db/repositories/project-repository.js";
export { ManifestService } from "./indexer/manifest-service.js";
export { VaultService } from "./vault/vault-service.js";
export { CommandExecutor } from "./executor/command-executor.js";
export { ApprovalService } from "./approval/approval-service.js";
export { CloudIntelligenceService } from "./cloud/cloud-intelligence-service.js";
export { CloudRunSummaryAdapter } from "./cloud/cloud-run-adapter.js";
export { EgressGuard, EgressRejectedError } from "./cloud/egress-guard.js";
