import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  FamilyManifestSchema,
  HostedIntegrationFamilyIdSchema,
  type FamilyManifest,
  type HostedIntegrationFamilyId,
  type HostedIntegrationToolName,
} from "./schemas.js";

export interface HostedIntegrationActiveFamilySummary {
  id: HostedIntegrationFamilyId;
  name: string;
  version: number;
  toolNames: HostedIntegrationToolName[];
  status: "active";
}

export type HostedIntegrationFamilySummary =
  HostedIntegrationActiveFamilySummary;

export interface HostedIntegrationFamilyDetail {
  summary: HostedIntegrationFamilySummary;
  manifest: FamilyManifest;
}

export interface HostedIntegrationCatalogDiagnostic {
  familyId: string;
  severity: "error";
  message: string;
}

export interface HostedIntegrationCatalog {
  listFamilies(): Promise<HostedIntegrationFamilySummary[]>;
  getFamily(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<HostedIntegrationFamilyDetail | null>;
  getDiagnostics(): Promise<HostedIntegrationCatalogDiagnostic[]>;
}

export interface FileHostedIntegrationCatalogOptions {
  dataDir: string;
}

interface CatalogSnapshot {
  families: HostedIntegrationFamilyDetail[];
  diagnostics: HostedIntegrationCatalogDiagnostic[];
}

export function createFileHostedIntegrationCatalog(
  options: FileHostedIntegrationCatalogOptions,
): HostedIntegrationCatalog {
  return new FileHostedIntegrationCatalog(options.dataDir);
}

class FileHostedIntegrationCatalog implements HostedIntegrationCatalog {
  private readonly familiesDir: string;

  constructor(dataDir: string) {
    this.familiesDir = path.join(
      dataDir,
      "hosted-integrations",
      "source",
      "families",
    );
  }

  async listFamilies(): Promise<HostedIntegrationFamilySummary[]> {
    const snapshot = await this.loadSnapshot();
    return snapshot.families.map((family) => family.summary);
  }

  async getFamily(
    familyId: HostedIntegrationFamilyId | string,
  ): Promise<HostedIntegrationFamilyDetail | null> {
    const parsedId = HostedIntegrationFamilyIdSchema.safeParse(familyId);
    if (!parsedId.success) return null;
    const snapshot = await this.loadSnapshot();
    return (
      snapshot.families.find((family) => family.summary.id === parsedId.data) ??
      null
    );
  }

  async getDiagnostics(): Promise<HostedIntegrationCatalogDiagnostic[]> {
    const snapshot = await this.loadSnapshot();
    return snapshot.diagnostics;
  }

  private async loadSnapshot(): Promise<CatalogSnapshot> {
    let entries;
    try {
      entries = await readdir(this.familiesDir, { withFileTypes: true });
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { families: [], diagnostics: [] };
      }
      throw error;
    }

    const families: HostedIntegrationFamilyDetail[] = [];
    const diagnostics: HostedIntegrationCatalogDiagnostic[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const loaded = await this.loadFamily(entry.name);
      if ("diagnostic" in loaded) {
        diagnostics.push(loaded.diagnostic);
      } else {
        families.push(loaded.family);
      }
    }

    families.sort((a, b) => a.summary.id.localeCompare(b.summary.id));
    diagnostics.sort((a, b) => a.familyId.localeCompare(b.familyId));

    return { families, diagnostics };
  }

  private async loadFamily(
    familyId: string,
  ): Promise<
    | { family: HostedIntegrationFamilyDetail }
    | { diagnostic: HostedIntegrationCatalogDiagnostic }
  > {
    const manifestPath = path.join(this.familiesDir, familyId, "family.yaml");
    let raw: string;
    try {
      raw = await readFile(manifestPath, "utf-8");
    } catch (error) {
      return {
        diagnostic: {
          familyId,
          severity: "error",
          message: `failed to read family.yaml: ${messageFromUnknown(error)}`,
        },
      };
    }

    let parsedYaml: unknown;
    try {
      parsedYaml = parseYaml(raw);
    } catch (error) {
      return {
        diagnostic: {
          familyId,
          severity: "error",
          message: `failed to parse family.yaml: ${messageFromUnknown(error)}`,
        },
      };
    }

    const parsedManifest = FamilyManifestSchema.safeParse(parsedYaml);
    if (!parsedManifest.success) {
      return {
        diagnostic: {
          familyId,
          severity: "error",
          message: z.prettifyError(parsedManifest.error),
        },
      };
    }

    if (parsedManifest.data.id !== familyId) {
      return {
        diagnostic: {
          familyId,
          severity: "error",
          message: `family id mismatch: directory ${familyId} contains manifest ${parsedManifest.data.id}`,
        },
      };
    }

    const family = detailFromManifest(parsedManifest.data);
    return { family };
  }
}

function detailFromManifest(
  manifest: FamilyManifest,
): HostedIntegrationFamilyDetail {
  return {
    summary: {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      toolNames: manifest.tools.map((tool) => tool.name),
      status: "active",
    },
    manifest,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
