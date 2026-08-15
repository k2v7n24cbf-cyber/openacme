import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { isNodeError, safePathSegment } from "./file-access.js";

const SecretValuesSchema = z.record(z.string(), z.string());

export interface HostedIntegrationSecretMetadata {
  environmentConfigId: string;
  secrets: Record<string, { configured: boolean }>;
}

export interface WriteHostedIntegrationHumanSecretsRequest {
  environmentConfigId: string;
  secrets: Record<string, string>;
  updatedBy: string;
}

export type WriteHostedIntegrationHumanSecretsResult = {
  ok: true;
  metadata: HostedIntegrationSecretMetadata;
};

export interface GetHostedIntegrationSecretMetadataRequest {
  environmentConfigId: string;
  secretNames?: string[];
}

export interface ReadHostedIntegrationRuntimeSecretsRequest {
  environmentConfigId: string;
}

export interface HostedIntegrationSecretStore {
  writeHumanOwnedSecrets(
    request: WriteHostedIntegrationHumanSecretsRequest,
  ): Promise<WriteHostedIntegrationHumanSecretsResult>;
  getSecretMetadata(
    request: GetHostedIntegrationSecretMetadataRequest,
  ): Promise<HostedIntegrationSecretMetadata>;
  readSecretsForRuntime(
    request: ReadHostedIntegrationRuntimeSecretsRequest,
  ): Promise<Record<string, string>>;
}

export interface FileHostedIntegrationSecretStoreOptions {
  dataDir: string;
}

export function createFileHostedIntegrationSecretStore(
  options: FileHostedIntegrationSecretStoreOptions,
): HostedIntegrationSecretStore {
  return new FileHostedIntegrationSecretStore(options.dataDir);
}

class FileHostedIntegrationSecretStore implements HostedIntegrationSecretStore {
  private readonly secretsDir: string;

  constructor(dataDir: string) {
    this.secretsDir = path.join(dataDir, "hosted-integrations", "secrets");
  }

  async writeHumanOwnedSecrets(
    request: WriteHostedIntegrationHumanSecretsRequest,
  ): Promise<WriteHostedIntegrationHumanSecretsResult> {
    assertNonEmpty("environmentConfigId", request.environmentConfigId);
    assertNonEmpty("updatedBy", request.updatedBy);
    const secrets = {
      ...(await this.readSecretValues(request.environmentConfigId)),
      ...SecretValuesSchema.parse(request.secrets),
    };
    await this.writeSecretValues(request.environmentConfigId, secrets);
    return {
      ok: true,
      metadata: metadataFromSecrets(request.environmentConfigId, secrets),
    };
  }

  async getSecretMetadata(
    request: GetHostedIntegrationSecretMetadataRequest,
  ): Promise<HostedIntegrationSecretMetadata> {
    const secrets = await this.readSecretValues(request.environmentConfigId);
    if (request.secretNames) {
      return {
        environmentConfigId: request.environmentConfigId,
        secrets: Object.fromEntries(
          request.secretNames.map((name) => [
            name,
            { configured: Object.prototype.hasOwnProperty.call(secrets, name) },
          ]),
        ),
      };
    }
    return metadataFromSecrets(request.environmentConfigId, secrets);
  }

  async readSecretsForRuntime(
    request: ReadHostedIntegrationRuntimeSecretsRequest,
  ): Promise<Record<string, string>> {
    return this.readSecretValues(request.environmentConfigId);
  }

  private async readSecretValues(
    environmentConfigId: string,
  ): Promise<Record<string, string>> {
    assertNonEmpty("environmentConfigId", environmentConfigId);
    try {
      return SecretValuesSchema.parse(
        JSON.parse(await readFile(this.secretPath(environmentConfigId), "utf-8")),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return {};
      throw error;
    }
  }

  private async writeSecretValues(
    environmentConfigId: string,
    secrets: Record<string, string>,
  ): Promise<void> {
    await mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
    await bestEffortChmod(this.secretsDir, 0o700);
    const filePath = this.secretPath(environmentConfigId);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(tmpPath, `${JSON.stringify(secrets, null, 2)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
      });
      await bestEffortChmod(tmpPath, 0o600);
      await rename(tmpPath, filePath);
      await bestEffortChmod(filePath, 0o600);
    } catch (error) {
      await rm(tmpPath, { force: true });
      throw error;
    }
  }

  private secretPath(environmentConfigId: string): string {
    return path.join(
      this.secretsDir,
      `${safePathSegment("environmentConfigId", environmentConfigId)}.json`,
    );
  }
}

function metadataFromSecrets(
  environmentConfigId: string,
  secrets: Record<string, string>,
): HostedIntegrationSecretMetadata {
  return {
    environmentConfigId,
    secrets: Object.fromEntries(
      Object.keys(secrets)
        .sort((a, b) => a.localeCompare(b))
        .map((name) => [name, { configured: true }]),
    ),
  };
}

async function bestEffortChmod(filePath: string, mode: number): Promise<void> {
  try {
    await chmod(filePath, mode);
  } catch {
    // Windows and restricted filesystems may ignore POSIX mode updates.
  }
}

function assertNonEmpty(name: string, value: string): void {
  if (!value) throw new Error(`${name} is required`);
}
