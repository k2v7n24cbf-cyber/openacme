import {
  createFileHostedIntegrationApprovalStore,
  type HostedIntegrationApprovalStore,
} from "./approvals.js";
import {
  createFileHostedIntegrationArtifactStore,
  type HostedIntegrationArtifactStore,
} from "./artifacts.js";
import {
  createFileHostedIntegrationCatalog,
  type FileHostedIntegrationCatalogOptions,
  type HostedIntegrationCatalog,
  type HostedIntegrationCatalogDiagnostic,
  type HostedIntegrationFamilyDetail,
  type HostedIntegrationFamilySummary,
} from "./catalog.js";
import {
  createFileHostedIntegrationEnvironmentConfigStore,
  type HostedIntegrationEnvironmentConfigStore,
} from "./environment-configs.js";
import {
  createFileHostedIntegrationDisablementStore,
  type HostedIntegrationDisablementStore,
} from "./disablements.js";
import {
  createFileHostedIntegrationDraftStore,
  type HostedIntegrationDraftStore,
} from "./drafts.js";
import {
  createFileHostedIntegrationExampleRegistry,
  type HostedIntegrationExampleRegistry,
} from "./examples.js";
import {
  createFileHostedIntegrationFailureBucketStore,
  type HostedIntegrationFailureBucketStore,
} from "./failure-buckets.js";
import {
  createDbHostedIntegrationFamilyDeleter,
  createFileHostedIntegrationFamilyDeleter,
  type DeleteHostedIntegrationFamilyRequest,
  type DeleteHostedIntegrationFamilyResult,
  type HostedIntegrationFamilyDeleter,
} from "./family-delete.js";
import {
  createFileHostedIntegrationGenerationStore,
  type HostedIntegrationRegistryRefreshEvent,
  type HostedIntegrationGenerationStore,
} from "./generations.js";
import {
  createFileHostedIntegrationJobStore,
  type HostedIntegrationJobStore,
} from "./jobs.js";
import {
  createFileHostedIntegrationRetentionSweeper,
  type HostedIntegrationRetentionSweeper,
} from "./retention.js";
import {
  createFileHostedIntegrationGateway,
  type HostedIntegrationGateway,
  type HostedIntegrationFailureBucketRecordedEvent,
} from "./gateway.js";
import {
  createFileHostedIntegrationLockStore,
  type HostedIntegrationLockStore,
} from "./locks.js";
import {
  createFileHostedIntegrationProposedFamilyManager,
  type HostedIntegrationProposedFamilySummary,
  type HostedIntegrationProposedFamilyManager,
} from "./proposed-family.js";
import {
  createHostedFamilyPackageManager,
  type HostedFamilyPackageManager,
} from "./packages.js";
import type { HostedIntegrationFamilyId } from "./schemas.js";
import {
  createFileHostedIntegrationSecretStore,
  type HostedIntegrationSecretStore,
} from "./secrets.js";
import {
  createFileHostedIntegrationSourceFileStore,
  type HostedIntegrationSourceFileStore,
} from "./source-files.js";
import {
  createFileHostedIntegrationDraftValidator,
  type HostedIntegrationDraftValidator,
} from "./validation.js";
import {
  createDbHostedIntegrationApprovalStore,
  createDbHostedIntegrationArtifactStore,
  createDbHostedIntegrationDisablementStore,
  createDbHostedIntegrationDraftStore,
  createDbHostedIntegrationEnvironmentConfigStore,
  createDbHostedIntegrationExecutionLogStore,
  createDbHostedIntegrationFailureBucketStore,
  createDbHostedIntegrationGenerationStore,
  createDbHostedIntegrationIdempotencyStore,
  createDbHostedIntegrationJobStore,
  createDbHostedIntegrationLockStore,
  createDbHostedIntegrationRetentionSweeper,
  createDbHostedIntegrationSecretStore,
  createDbHostedIntegrationSourceFileStore,
  type HostedIntegrationSqlDatabase,
} from "./db-store.js";

export type HostedIntegrationManagementFamilySummary =
  | HostedIntegrationFamilySummary
  | HostedIntegrationProposedFamilySummary;

export interface HostedIntegrationService {
  readonly locks: HostedIntegrationLockStore;
  readonly drafts: HostedIntegrationDraftStore;
  readonly sourceFiles: HostedIntegrationSourceFileStore;
  readonly examples: HostedIntegrationExampleRegistry;
  readonly validator: HostedIntegrationDraftValidator;
  readonly proposedFamilies: HostedIntegrationProposedFamilyManager;
  readonly packages: HostedFamilyPackageManager;
  readonly environmentConfigs: HostedIntegrationEnvironmentConfigStore;
  readonly secrets: HostedIntegrationSecretStore;
  readonly approvals: HostedIntegrationApprovalStore;
  readonly disablements: HostedIntegrationDisablementStore;
  readonly generations: HostedIntegrationGenerationStore;
  readonly jobs: HostedIntegrationJobStore;
  readonly artifacts: HostedIntegrationArtifactStore;
  readonly failureBuckets: HostedIntegrationFailureBucketStore;
  readonly retention: HostedIntegrationRetentionSweeper;
  readonly gateway: HostedIntegrationGateway;
  listFamilies(): Promise<HostedIntegrationManagementFamilySummary[]>;
  getFamily(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<HostedIntegrationFamilyDetail | null>;
  getDiagnostics(): Promise<HostedIntegrationCatalogDiagnostic[]>;
  deleteFamily(
    request: DeleteHostedIntegrationFamilyRequest,
  ): Promise<DeleteHostedIntegrationFamilyResult>;
  start(): Promise<void>;
  close(): Promise<void>;
}

export interface FileHostedIntegrationServiceOptions extends FileHostedIntegrationCatalogOptions {
  onRegistryRefresh?: (
    event: HostedIntegrationRegistryRefreshEvent,
  ) => void | Promise<void>;
  onFailureBucketRecorded?: (
    event: HostedIntegrationFailureBucketRecordedEvent,
  ) => void | Promise<void>;
}

export interface DbHostedIntegrationServiceOptions extends FileHostedIntegrationServiceOptions {
  db: HostedIntegrationSqlDatabase;
  now?: () => Date;
  createId?: () => string;
}

export function createFileHostedIntegrationService(
  options: FileHostedIntegrationServiceOptions,
): HostedIntegrationService {
  const catalog = createFileHostedIntegrationCatalog(options);
  const locks = createFileHostedIntegrationLockStore(options);
  const drafts = createFileHostedIntegrationDraftStore({
    ...options,
    lockStore: locks,
  });
  const sourceFiles = createFileHostedIntegrationSourceFileStore(options);
  const examples = createFileHostedIntegrationExampleRegistry({
    draftStore: drafts,
  });
  const validator = createFileHostedIntegrationDraftValidator({
    draftStore: drafts,
    catalog,
  });
  const proposedFamilies = createFileHostedIntegrationProposedFamilyManager({
    ...options,
    catalog,
    lockStore: locks,
    draftStore: drafts,
  });
  const environmentConfigs = createFileHostedIntegrationEnvironmentConfigStore({
    ...options,
    catalog,
  });
  const secrets = createFileHostedIntegrationSecretStore(options);
  const approvals = createFileHostedIntegrationApprovalStore(options);
  const disablements = createFileHostedIntegrationDisablementStore(options);
  const failureBuckets = createFileHostedIntegrationFailureBucketStore(options);
  const generations = createFileHostedIntegrationGenerationStore({
    ...options,
    draftStore: drafts,
    onRegistryRefresh: options.onRegistryRefresh,
  });
  const packages = createHostedFamilyPackageManager({
    catalog,
    locks,
    drafts,
    sourceFiles,
    generations,
    validator,
    proposedFamilies,
  });
  const jobs = createFileHostedIntegrationJobStore(options);
  const artifacts = createFileHostedIntegrationArtifactStore(options);
  const retention = createFileHostedIntegrationRetentionSweeper(options);
  const gateway = createFileHostedIntegrationGateway({
    ...options,
    catalog,
    environmentConfigs,
    secrets,
    generations,
    artifacts,
    disablements,
    failureBuckets,
    onFailureBucketRecorded: options.onFailureBucketRecorded,
  });
  const deleteFamily = createFileHostedIntegrationFamilyDeleter({
    ...options,
    generations,
    disablements,
    onRegistryRefresh: options.onRegistryRefresh,
  });
  return new FileHostedIntegrationService({
    catalog,
    locks,
    drafts,
    sourceFiles,
    examples,
    validator,
    proposedFamilies,
    packages,
    environmentConfigs,
    secrets,
    approvals,
    disablements,
    generations,
    jobs,
    artifacts,
    failureBuckets,
    retention,
    gateway,
    deleteFamily,
  });
}

export function createDbHostedIntegrationService(
  options: DbHostedIntegrationServiceOptions,
): HostedIntegrationService {
  const catalog = createFileHostedIntegrationCatalog(options);
  const locks = createDbHostedIntegrationLockStore(options);
  const sourceFiles = createDbHostedIntegrationSourceFileStore(options);
  const drafts = createDbHostedIntegrationDraftStore({
    ...options,
    lockStore: locks,
  });
  const examples = createFileHostedIntegrationExampleRegistry({
    draftStore: drafts,
  });
  const validator = createFileHostedIntegrationDraftValidator({
    draftStore: drafts,
    catalog,
  });
  const proposedFamilies = createFileHostedIntegrationProposedFamilyManager({
    ...options,
    catalog,
    lockStore: locks,
    draftStore: drafts,
  });
  const environmentConfigs = createDbHostedIntegrationEnvironmentConfigStore({
    ...options,
    catalog,
  });
  const secrets = createDbHostedIntegrationSecretStore(options);
  const approvals = createDbHostedIntegrationApprovalStore(options);
  const disablements = createDbHostedIntegrationDisablementStore(options);
  const failureBuckets = createDbHostedIntegrationFailureBucketStore(options);
  const generations = createDbHostedIntegrationGenerationStore({
    ...options,
    draftStore: drafts,
    onRegistryRefresh: options.onRegistryRefresh,
  });
  const packages = createHostedFamilyPackageManager({
    catalog,
    locks,
    drafts,
    sourceFiles,
    generations,
    validator,
    proposedFamilies,
    now: options.now,
  });
  const jobs = createDbHostedIntegrationJobStore(options);
  const artifacts = createDbHostedIntegrationArtifactStore(options);
  const retention = createDbHostedIntegrationRetentionSweeper(options);
  const executionLogs = createDbHostedIntegrationExecutionLogStore(options);
  const idempotency = createDbHostedIntegrationIdempotencyStore(options);
  const gateway = createFileHostedIntegrationGateway({
    ...options,
    catalog,
    environmentConfigs,
    secrets,
    generations,
    artifacts,
    disablements,
    executionLogs,
    failureBuckets,
    idempotency,
    onFailureBucketRecorded: options.onFailureBucketRecorded,
  });
  const deleteFamily = createDbHostedIntegrationFamilyDeleter({
    ...options,
    generations,
    disablements,
    onRegistryRefresh: options.onRegistryRefresh,
  });
  return new FileHostedIntegrationService({
    catalog,
    locks,
    drafts,
    sourceFiles,
    examples,
    validator,
    proposedFamilies,
    packages,
    environmentConfigs,
    secrets,
    approvals,
    disablements,
    generations,
    jobs,
    artifacts,
    failureBuckets,
    retention,
    gateway,
    deleteFamily,
  });
}

class FileHostedIntegrationService implements HostedIntegrationService {
  readonly locks: HostedIntegrationLockStore;
  readonly drafts: HostedIntegrationDraftStore;
  readonly sourceFiles: HostedIntegrationSourceFileStore;
  readonly examples: HostedIntegrationExampleRegistry;
  readonly validator: HostedIntegrationDraftValidator;
  readonly proposedFamilies: HostedIntegrationProposedFamilyManager;
  readonly packages: HostedFamilyPackageManager;
  readonly environmentConfigs: HostedIntegrationEnvironmentConfigStore;
  readonly secrets: HostedIntegrationSecretStore;
  readonly approvals: HostedIntegrationApprovalStore;
  readonly disablements: HostedIntegrationDisablementStore;
  readonly generations: HostedIntegrationGenerationStore;
  readonly jobs: HostedIntegrationJobStore;
  readonly artifacts: HostedIntegrationArtifactStore;
  readonly failureBuckets: HostedIntegrationFailureBucketStore;
  readonly retention: HostedIntegrationRetentionSweeper;
  readonly gateway: HostedIntegrationGateway;

  private readonly catalog: HostedIntegrationCatalog;
  private readonly deleteFamilyImpl: HostedIntegrationFamilyDeleter;

  constructor(parts: {
    catalog: HostedIntegrationCatalog;
    locks: HostedIntegrationLockStore;
    drafts: HostedIntegrationDraftStore;
    sourceFiles: HostedIntegrationSourceFileStore;
    examples: HostedIntegrationExampleRegistry;
    validator: HostedIntegrationDraftValidator;
    proposedFamilies: HostedIntegrationProposedFamilyManager;
    packages: HostedFamilyPackageManager;
    environmentConfigs: HostedIntegrationEnvironmentConfigStore;
    secrets: HostedIntegrationSecretStore;
    approvals: HostedIntegrationApprovalStore;
    disablements: HostedIntegrationDisablementStore;
    generations: HostedIntegrationGenerationStore;
    jobs: HostedIntegrationJobStore;
    artifacts: HostedIntegrationArtifactStore;
    failureBuckets: HostedIntegrationFailureBucketStore;
    retention: HostedIntegrationRetentionSweeper;
    gateway: HostedIntegrationGateway;
    deleteFamily: HostedIntegrationFamilyDeleter;
  }) {
    this.catalog = parts.catalog;
    this.locks = parts.locks;
    this.drafts = parts.drafts;
    this.sourceFiles = parts.sourceFiles;
    this.examples = parts.examples;
    this.validator = parts.validator;
    this.proposedFamilies = parts.proposedFamilies;
    this.packages = parts.packages;
    this.environmentConfigs = parts.environmentConfigs;
    this.secrets = parts.secrets;
    this.approvals = parts.approvals;
    this.disablements = parts.disablements;
    this.generations = parts.generations;
    this.jobs = parts.jobs;
    this.artifacts = parts.artifacts;
    this.failureBuckets = parts.failureBuckets;
    this.retention = parts.retention;
    this.gateway = parts.gateway;
    this.deleteFamilyImpl = parts.deleteFamily;
  }

  async start(): Promise<void> {
    // Reserved lifecycle hook for future workers, sweeps, and warm caches.
  }

  async close(): Promise<void> {
    // The file-backed catalog has no resources to release yet.
  }

  async listFamilies(): Promise<HostedIntegrationManagementFamilySummary[]> {
    const families = [
      ...(await this.catalog.listFamilies()),
      ...(await this.proposedFamilies.listProposedFamilies()),
    ];
    families.sort((a, b) => a.id.localeCompare(b.id));
    return families;
  }

  getFamily(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<HostedIntegrationFamilyDetail | null> {
    return this.catalog.getFamily(familyId);
  }

  getDiagnostics(): Promise<HostedIntegrationCatalogDiagnostic[]> {
    return this.catalog.getDiagnostics();
  }

  deleteFamily(
    request: DeleteHostedIntegrationFamilyRequest,
  ): Promise<DeleteHostedIntegrationFamilyResult> {
    return this.deleteFamilyImpl(request);
  }
}
