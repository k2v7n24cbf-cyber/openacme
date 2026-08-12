import type { HostedIntegrationConfigScope } from "./hosted-integration-agent-settings";

export interface HostedIntegrationFamilySummary {
  id: string;
  name: string;
  version: number;
  toolNames: string[];
  status: "active";
}

export interface HostedIntegrationToolSpec {
  name: string;
  title: string;
  description: string;
  lifecycle: "active" | "deprecated" | "hidden" | "disabled" | "removed";
  classification: {
    operation: "read" | "write" | "destructive";
    freshness: "live" | "cached" | "sync";
    idempotency: "idempotent" | "non_idempotent";
    execution: "sync" | "async";
    approval: "none" | "confirm" | "human";
  };
}

export interface HostedIntegrationFamilyDetail {
  summary: HostedIntegrationFamilySummary;
  manifest: {
    id: string;
    name: string;
    version: number;
    tools: HostedIntegrationToolSpec[];
  };
}

export interface HostedIntegrationGenerationSummary {
  id: string;
  familyId: string;
  sourceRevisionId: string;
  status: "active" | "superseded";
  promotedAt: string;
  promotedBy: string;
}

export interface HostedIntegrationFailureBucket {
  id: string;
  familyId: string;
  toolName: string;
  generationId: string;
  status: "open" | "closed";
  count: number;
  latestSeenAt: string;
  assignedTo?: string;
}

export interface HostedIntegrationFamilyLock {
  id: string;
  familyId: string;
  lockedBy: string;
  draftId?: string;
  expiresAt: string;
}

export interface HostedIntegrationAdminFamilyRow {
  id: string;
  name: string;
  version: number;
  activeGeneration: HostedIntegrationGenerationSummary | null;
  tools: HostedIntegrationToolSpec[];
  configScopes: Array<{
    id: string;
    environment: string;
    revision: number;
    configKeyCount: number;
    configuredSecretCount: number;
  }>;
  openFailureBucketCount: number;
  lock: HostedIntegrationFamilyLock | null;
}

export function buildHostedIntegrationsAdminRows(input: {
  families: HostedIntegrationFamilySummary[];
  familyDetails: HostedIntegrationFamilyDetail[];
  generations: HostedIntegrationGenerationSummary[];
  configScopes: HostedIntegrationConfigScope[];
  failureBuckets: HostedIntegrationFailureBucket[];
  locks: Array<HostedIntegrationFamilyLock | null>;
}): HostedIntegrationAdminFamilyRow[] {
  const detailsByFamily = new Map(
    input.familyDetails.map((detail) => [detail.summary.id, detail]),
  );
  const locksByFamily = new Map(
    input.locks
      .filter((lock): lock is HostedIntegrationFamilyLock => lock !== null)
      .map((lock) => [lock.familyId, lock]),
  );
  return input.families.map((family) => {
    const detail = detailsByFamily.get(family.id);
    return {
      id: family.id,
      name: family.name,
      version: family.version,
      activeGeneration:
        input.generations.find(
          (generation) =>
            generation.familyId === family.id && generation.status === "active",
        ) ?? null,
      tools: detail?.manifest.tools ?? [],
      configScopes: input.configScopes
        .filter((scope) => scope.familyId === family.id)
        .map((scope) => ({
          id: scope.id,
          environment: scope.environment,
          revision: scope.revision,
          configKeyCount: Object.keys(scope.config).length,
          configuredSecretCount: Object.values(scope.secrets).filter(
            (secret) => secret.configured,
          ).length,
        })),
      openFailureBucketCount: input.failureBuckets.filter(
        (bucket) => bucket.familyId === family.id && bucket.status === "open",
      ).length,
      lock: locksByFamily.get(family.id) ?? null,
    };
  });
}
