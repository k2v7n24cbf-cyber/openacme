import {
  createFileHostedIntegrationCatalog,
  type FileHostedIntegrationCatalogOptions,
  type HostedIntegrationCatalog,
  type HostedIntegrationCatalogDiagnostic,
  type HostedIntegrationFamilyDetail,
  type HostedIntegrationFamilySummary,
} from "./catalog.js";
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
import type { HostedIntegrationFamilyId } from "./schemas.js";
import {
  createFileHostedIntegrationSourceFileStore,
  type HostedIntegrationSourceFileStore,
} from "./source-files.js";
import {
  createFileHostedIntegrationDraftValidator,
  type HostedIntegrationDraftValidator,
} from "./validation.js";

export interface HostedIntegrationService extends HostedIntegrationCatalog {
  readonly locks: HostedIntegrationLockStore;
  readonly drafts: HostedIntegrationDraftStore;
  readonly sourceFiles: HostedIntegrationSourceFileStore;
  readonly examples: HostedIntegrationExampleRegistry;
  readonly validator: HostedIntegrationDraftValidator;
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
  return new FileHostedIntegrationService({
    catalog,
    locks,
    drafts,
    sourceFiles,
    examples,
    validator,
  });
}

class FileHostedIntegrationService implements HostedIntegrationService {
  readonly locks: HostedIntegrationLockStore;
  readonly drafts: HostedIntegrationDraftStore;
  readonly sourceFiles: HostedIntegrationSourceFileStore;
  readonly examples: HostedIntegrationExampleRegistry;
  readonly validator: HostedIntegrationDraftValidator;

  private readonly catalog: HostedIntegrationCatalog;

  constructor(parts: {
    catalog: HostedIntegrationCatalog;
    locks: HostedIntegrationLockStore;
    drafts: HostedIntegrationDraftStore;
    sourceFiles: HostedIntegrationSourceFileStore;
    examples: HostedIntegrationExampleRegistry;
    validator: HostedIntegrationDraftValidator;
  }) {
    this.catalog = parts.catalog;
    this.locks = parts.locks;
    this.drafts = parts.drafts;
    this.sourceFiles = parts.sourceFiles;
    this.examples = parts.examples;
    this.validator = parts.validator;
  }

  async start(): Promise<void> {
    // Reserved lifecycle hook for future workers, sweeps, and warm caches.
  }

  async close(): Promise<void> {
    // The file-backed catalog has no resources to release yet.
  }

  listFamilies(): Promise<HostedIntegrationFamilySummary[]> {
    return this.catalog.listFamilies();
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
