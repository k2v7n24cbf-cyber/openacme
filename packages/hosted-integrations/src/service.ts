import {
  createFileHostedIntegrationCatalog,
  type FileHostedIntegrationCatalogOptions,
  type HostedIntegrationCatalog,
  type HostedIntegrationCatalogDiagnostic,
  type HostedIntegrationFamilyDetail,
  type HostedIntegrationFamilySummary,
} from "./catalog.js";
import {
  createFileHostedIntegrationConfigScopeStore,
  type HostedIntegrationConfigScopeStore,
} from "./config-scopes.js";
import {
  createFileHostedIntegrationDraftStore,
  type HostedIntegrationDraftStore,
} from "./drafts.js";
import {
  createFileHostedIntegrationExampleRegistry,
  type HostedIntegrationExampleRegistry,
} from "./examples.js";
import {
  createFileHostedIntegrationLockStore,
  type HostedIntegrationLockStore,
} from "./locks.js";
import {
  createFileHostedIntegrationProposedFamilyManager,
  type HostedIntegrationProposedFamilySummary,
  type HostedIntegrationProposedFamilyManager,
} from "./proposed-family.js";
import type { HostedIntegrationFamilyId } from "./schemas.js";
import {
  createFileHostedIntegrationSourceFileStore,
  type HostedIntegrationSourceFileStore,
} from "./source-files.js";
import {
  createFileHostedIntegrationDraftValidator,
  type HostedIntegrationDraftValidator,
} from "./validation.js";

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
  readonly configScopes: HostedIntegrationConfigScopeStore;
  listFamilies(): Promise<HostedIntegrationManagementFamilySummary[]>;
  getFamily(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<HostedIntegrationFamilyDetail | null>;
  getDiagnostics(): Promise<HostedIntegrationCatalogDiagnostic[]>;
  start(): Promise<void>;
  close(): Promise<void>;
}

export type FileHostedIntegrationServiceOptions =
  FileHostedIntegrationCatalogOptions;

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
  const configScopes = createFileHostedIntegrationConfigScopeStore({
    ...options,
    catalog,
  });
  return new FileHostedIntegrationService({
    catalog,
    locks,
    drafts,
    sourceFiles,
    examples,
    validator,
    proposedFamilies,
    configScopes,
  });
}

class FileHostedIntegrationService implements HostedIntegrationService {
  readonly locks: HostedIntegrationLockStore;
  readonly drafts: HostedIntegrationDraftStore;
  readonly sourceFiles: HostedIntegrationSourceFileStore;
  readonly examples: HostedIntegrationExampleRegistry;
  readonly validator: HostedIntegrationDraftValidator;
  readonly proposedFamilies: HostedIntegrationProposedFamilyManager;
  readonly configScopes: HostedIntegrationConfigScopeStore;

  private readonly catalog: HostedIntegrationCatalog;

  constructor(parts: {
    catalog: HostedIntegrationCatalog;
    locks: HostedIntegrationLockStore;
    drafts: HostedIntegrationDraftStore;
    sourceFiles: HostedIntegrationSourceFileStore;
    examples: HostedIntegrationExampleRegistry;
    validator: HostedIntegrationDraftValidator;
    proposedFamilies: HostedIntegrationProposedFamilyManager;
    configScopes: HostedIntegrationConfigScopeStore;
  }) {
    this.catalog = parts.catalog;
    this.locks = parts.locks;
    this.drafts = parts.drafts;
    this.sourceFiles = parts.sourceFiles;
    this.examples = parts.examples;
    this.validator = parts.validator;
    this.proposedFamilies = parts.proposedFamilies;
    this.configScopes = parts.configScopes;
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
}
