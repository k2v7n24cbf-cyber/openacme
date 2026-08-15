export type HostedIntegrationPersistenceShape =
  | "transactional"
  | "append_only"
  | "metadata_index"
  | "derived_view"
  | "runtime_ephemeral";

export type HostedIntegrationPersistenceServiceKey =
  | "locks"
  | "drafts"
  | "sourceFiles"
  | "examples"
  | "proposedFamilies"
  | "environmentConfigs"
  | "secrets"
  | "approvals"
  | "disablements"
  | "generations"
  | "jobs"
  | "artifacts"
  | "failureBuckets"
  | "retention";

export const HOSTED_INTEGRATION_SERVICE_PERSISTENCE_KEYS = [
  "locks",
  "drafts",
  "sourceFiles",
  "examples",
  "proposedFamilies",
  "environmentConfigs",
  "secrets",
  "approvals",
  "disablements",
  "generations",
  "jobs",
  "artifacts",
  "failureBuckets",
  "retention",
] as const satisfies readonly HostedIntegrationPersistenceServiceKey[];

export interface HostedIntegrationPersistenceSurfaceContract {
  id: string;
  serviceKey?:
    | HostedIntegrationPersistenceServiceKey
    | "catalog"
    | "gateway.executionLogs"
    | "gateway.idempotency";
  currentFileFactory?: string;
  owningModule: string;
  recordKinds: string[];
  dbTableFamilies: string[];
  shape: HostedIntegrationPersistenceShape;
  transactionalWrites: string[];
  appendOnlyEvents: string[];
  immutability: string[];
  adapterContract: {
    fileBacked: "required";
    dbBacked: "required_from_17_3";
  };
  dbAdapter:
    | {
        kind: "factory";
        factory: string;
      }
    | {
        kind: "delegated";
        delegatedTo: string[];
        decision: string;
      };
}

export const HOSTED_INTEGRATION_PERSISTENCE_CONTRACTS = [
  {
    id: "catalog",
    serviceKey: "catalog",
    currentFileFactory: "createFileHostedIntegrationCatalog",
    owningModule: "catalog.ts",
    recordKinds: ["family_manifest", "catalog_diagnostic"],
    dbTableFamilies: ["hosted_integration_families"],
    shape: "derived_view",
    transactionalWrites: [],
    appendOnlyEvents: [],
    immutability: [],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "delegated",
      delegatedTo: ["sourceFiles", "generations"],
      decision:
        "Catalog remains a derived view until DB service composition owns family snapshot refresh.",
    },
  },
  {
    id: "source_files",
    serviceKey: "sourceFiles",
    currentFileFactory: "createFileHostedIntegrationSourceFileStore",
    owningModule: "source-files.ts",
    recordKinds: ["source_revision", "source_file"],
    dbTableFamilies: [
      "hosted_integration_source_revisions",
      "hosted_integration_source_files",
    ],
    shape: "transactional",
    transactionalWrites: ["replaceSourceFiles"],
    appendOnlyEvents: [],
    immutability: ["source_revision"],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "factory",
      factory: "createDbHostedIntegrationSourceFileStore",
    },
  },
  {
    id: "drafts",
    serviceKey: "drafts",
    currentFileFactory: "createFileHostedIntegrationDraftStore",
    owningModule: "drafts.ts",
    recordKinds: ["draft", "draft_file", "draft_revision"],
    dbTableFamilies: ["hosted_integration_drafts", "hosted_integration_draft_files"],
    shape: "transactional",
    transactionalWrites: [
      "createDraft",
      "createDraftFromFiles",
      "writeDraftFile",
      "deleteDraftFile",
    ],
    appendOnlyEvents: [],
    immutability: [],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "factory",
      factory: "createDbHostedIntegrationDraftStore",
    },
  },
  {
    id: "examples",
    serviceKey: "examples",
    currentFileFactory: "createFileHostedIntegrationExampleRegistry",
    owningModule: "examples.ts",
    recordKinds: ["example"],
    dbTableFamilies: ["hosted_integration_examples"],
    shape: "transactional",
    transactionalWrites: ["upsertExample"],
    appendOnlyEvents: [],
    immutability: [],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "delegated",
      delegatedTo: ["drafts"],
      decision:
        "Examples are edited as draft-owned examples.yaml until DB composition introduces a DB example registry.",
    },
  },
  {
    id: "proposed_families",
    serviceKey: "proposedFamilies",
    currentFileFactory: "createFileHostedIntegrationProposedFamilyManager",
    owningModule: "proposed-family.ts",
    recordKinds: ["proposed_family", "proposed_family_draft"],
    dbTableFamilies: ["hosted_integration_proposed_families"],
    shape: "transactional",
    transactionalWrites: ["createProposedFamily"],
    appendOnlyEvents: [],
    immutability: [],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "delegated",
      delegatedTo: ["locks", "drafts"],
      decision:
        "Proposed family creation is represented by lock and draft creation until DB composition persists proposed summaries directly.",
    },
  },
  {
    id: "locks",
    serviceKey: "locks",
    currentFileFactory: "createFileHostedIntegrationLockStore",
    owningModule: "locks.ts",
    recordKinds: ["lock"],
    dbTableFamilies: ["hosted_integration_locks"],
    shape: "transactional",
    transactionalWrites: ["acquireLock", "renewLock", "releaseLock"],
    appendOnlyEvents: [],
    immutability: [],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "factory",
      factory: "createDbHostedIntegrationLockStore",
    },
  },
  {
    id: "environment_configs",
    serviceKey: "environmentConfigs",
    currentFileFactory: "createFileHostedIntegrationEnvironmentConfigStore",
    owningModule: "environment-configs.ts",
    recordKinds: ["environment_config", "secret_metadata"],
    dbTableFamilies: ["hosted_integration_environment_configs"],
    shape: "transactional",
    transactionalWrites: ["upsertEnvironmentConfig"],
    appendOnlyEvents: [],
    immutability: [],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "factory",
      factory: "createDbHostedIntegrationEnvironmentConfigStore",
    },
  },
  {
    id: "secrets",
    serviceKey: "secrets",
    currentFileFactory: "createFileHostedIntegrationSecretStore",
    owningModule: "secrets.ts",
    recordKinds: ["secret_metadata"],
    dbTableFamilies: ["hosted_integration_secret_metadata"],
    shape: "metadata_index",
    transactionalWrites: ["writeHumanSecrets"],
    appendOnlyEvents: [],
    immutability: [],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "factory",
      factory: "createDbHostedIntegrationSecretStore",
    },
  },
  {
    id: "approvals",
    serviceKey: "approvals",
    currentFileFactory: "createFileHostedIntegrationApprovalStore",
    owningModule: "approvals.ts",
    recordKinds: ["approval", "promotion_provenance"],
    dbTableFamilies: ["hosted_integration_approvals"],
    shape: "append_only",
    transactionalWrites: ["createApproval"],
    appendOnlyEvents: ["approval_created"],
    immutability: ["approval"],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "factory",
      factory: "createDbHostedIntegrationApprovalStore",
    },
  },
  {
    id: "disablements",
    serviceKey: "disablements",
    currentFileFactory: "createFileHostedIntegrationDisablementStore",
    owningModule: "disablements.ts",
    recordKinds: ["disablement"],
    dbTableFamilies: ["hosted_integration_disablements"],
    shape: "transactional",
    transactionalWrites: ["setDisabled"],
    appendOnlyEvents: [],
    immutability: [],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "factory",
      factory: "createDbHostedIntegrationDisablementStore",
    },
  },
  {
    id: "generations",
    serviceKey: "generations",
    currentFileFactory: "createFileHostedIntegrationGenerationStore",
    owningModule: "generations.ts",
    recordKinds: [
      "generation",
      "generation_file",
      "active_generation_pointer",
      "generation_status",
      "generation_invocation_lease",
      "promotion_provenance",
    ],
    dbTableFamilies: [
      "hosted_integration_generations",
      "hosted_integration_generation_files",
      "hosted_integration_active_generations",
      "hosted_integration_generation_invocations",
    ],
    shape: "transactional",
    transactionalWrites: ["promoteDraft", "rollbackGeneration"],
    appendOnlyEvents: ["generation_promoted", "generation_rolled_back"],
    immutability: ["generation", "generation_file", "promotion_provenance"],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "factory",
      factory: "createDbHostedIntegrationGenerationStore",
    },
  },
  {
    id: "jobs",
    serviceKey: "jobs",
    currentFileFactory: "createFileHostedIntegrationJobStore",
    owningModule: "jobs.ts",
    recordKinds: ["job", "job_result", "progress_event"],
    dbTableFamilies: ["hosted_integration_jobs", "hosted_integration_job_events"],
    shape: "append_only",
    transactionalWrites: ["startJob", "markRunning", "completeJob", "failJob", "cancelJob"],
    appendOnlyEvents: ["progress_event"],
    immutability: ["progress_event"],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "factory",
      factory: "createDbHostedIntegrationJobStore",
    },
  },
  {
    id: "artifacts",
    serviceKey: "artifacts",
    currentFileFactory: "createFileHostedIntegrationArtifactStore",
    owningModule: "artifacts.ts",
    recordKinds: ["run", "artifact_metadata", "artifact_bytes_ref", "diagnostic_artifact"],
    dbTableFamilies: ["hosted_integration_runs", "hosted_integration_artifacts"],
    shape: "metadata_index",
    transactionalWrites: [
      "createRun",
      "completeRunSuccess",
      "completeRunError",
      "writeDiagnostics",
    ],
    appendOnlyEvents: [],
    immutability: ["artifact_bytes_ref"],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "factory",
      factory: "createDbHostedIntegrationArtifactStore",
    },
  },
  {
    id: "execution_logs",
    serviceKey: "gateway.executionLogs",
    currentFileFactory: "createFileHostedIntegrationExecutionLogStore",
    owningModule: "gateway.ts",
    recordKinds: ["execution_log"],
    dbTableFamilies: ["hosted_integration_execution_logs"],
    shape: "append_only",
    transactionalWrites: ["startLog", "finishLog"],
    appendOnlyEvents: ["execution_started", "execution_finished"],
    immutability: [],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "factory",
      factory: "createDbHostedIntegrationExecutionLogStore",
    },
  },
  {
    id: "failure_buckets",
    serviceKey: "failureBuckets",
    currentFileFactory: "createFileHostedIntegrationFailureBucketStore",
    owningModule: "failure-buckets.ts",
    recordKinds: ["failure_bucket", "failure_bucket_event"],
    dbTableFamilies: [
      "hosted_integration_failure_buckets",
      "hosted_integration_failure_bucket_events",
    ],
    shape: "append_only",
    transactionalWrites: ["recordFailure", "closeBucket"],
    appendOnlyEvents: ["failure_recorded", "bucket_closed"],
    immutability: ["failure_bucket_event"],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "factory",
      factory: "createDbHostedIntegrationFailureBucketStore",
    },
  },
  {
    id: "idempotency",
    serviceKey: "gateway.idempotency",
    currentFileFactory: "createFileHostedIntegrationIdempotencyStore",
    owningModule: "gateway.ts",
    recordKinds: ["idempotency_record"],
    dbTableFamilies: ["hosted_integration_idempotency"],
    shape: "transactional",
    transactionalWrites: ["reserve", "complete"],
    appendOnlyEvents: [],
    immutability: ["request_hash"],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "factory",
      factory: "createDbHostedIntegrationIdempotencyStore",
    },
  },
  {
    id: "retention",
    serviceKey: "retention",
    currentFileFactory: "createFileHostedIntegrationRetentionSweeper",
    owningModule: "retention.ts",
    recordKinds: ["retention_state"],
    dbTableFamilies: ["hosted_integration_artifacts", "hosted_integration_runs"],
    shape: "metadata_index",
    transactionalWrites: ["sweep"],
    appendOnlyEvents: ["artifact_retained", "artifact_deleted"],
    immutability: [],
    adapterContract: { fileBacked: "required", dbBacked: "required_from_17_3" },
    dbAdapter: {
      kind: "factory",
      factory: "createDbHostedIntegrationRetentionSweeper",
    },
  },
] as const satisfies readonly HostedIntegrationPersistenceSurfaceContract[];
