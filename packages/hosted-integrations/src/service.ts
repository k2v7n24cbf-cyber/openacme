import {
  createFileHostedIntegrationCatalog,
  type FileHostedIntegrationCatalogOptions,
  type HostedIntegrationCatalog,
  type HostedIntegrationCatalogDiagnostic,
  type HostedIntegrationFamilyDetail,
  type HostedIntegrationFamilySummary,
} from "./catalog.js";
import type { HostedIntegrationFamilyId } from "./schemas.js";

export interface HostedIntegrationService extends HostedIntegrationCatalog {
  start(): Promise<void>;
  close(): Promise<void>;
}

export type FileHostedIntegrationServiceOptions =
  FileHostedIntegrationCatalogOptions;

export function createFileHostedIntegrationService(
  options: FileHostedIntegrationServiceOptions,
): HostedIntegrationService {
  return new FileHostedIntegrationService(
    createFileHostedIntegrationCatalog(options),
  );
}

class FileHostedIntegrationService implements HostedIntegrationService {
  constructor(private readonly catalog: HostedIntegrationCatalog) {}

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
