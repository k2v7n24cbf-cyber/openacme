import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  FamilyManifestSchema,
  HostedIntegrationExampleSchema,
  HostedIntegrationPythonRuntime,
  JsonObjectSchema,
  resolveHostedIntegrationExecutionConfig,
  type HostedIntegrationFailureBucket,
  type HostedIntegrationService,
} from "@openacme/hosted-integrations";

const ExamplesDocumentSchema = z
  .object({
    examples: z.array(HostedIntegrationExampleSchema).default([]),
  })
  .strict();

export type HostedIntegrationRegressionCloseErrorCode =
  | "regression_example_required"
  | "draft_required"
  | "generation_required"
  | "generation_not_found"
  | "generation_family_mismatch"
  | "fix_generation_mismatch"
  | "regression_example_not_found"
  | "tool_not_found"
  | "regression_example_failed";

export type HostedIntegrationRegressionCloseValidationResult =
  | { ok: true; runId: string }
  | {
      ok: false;
      code: HostedIntegrationRegressionCloseErrorCode;
      runId?: string;
    };

export async function validateHostedIntegrationRegressionClose(input: {
  service: HostedIntegrationService;
  dataDir: string;
  actorId: string;
  bucket: HostedIntegrationFailureBucket;
  draftId: string | null;
  generationId: string | null;
  regressionExampleId: string | null;
}): Promise<HostedIntegrationRegressionCloseValidationResult> {
  if (!input.regressionExampleId) {
    return { ok: false, code: "regression_example_required" };
  }
  if (!input.draftId) return { ok: false, code: "draft_required" };
  if (!input.generationId) return { ok: false, code: "generation_required" };

  const generation = await input.service.generations.getGeneration(
    input.generationId,
  );
  if (!generation) return { ok: false, code: "generation_not_found" };
  if (generation.familyId !== input.bucket.familyId) {
    return { ok: false, code: "generation_family_mismatch" };
  }
  if (generation.provenance?.draftId !== input.draftId) {
    return { ok: false, code: "fix_generation_mismatch" };
  }

  const draftExamples = await input.service.examples.listExamples(
    input.draftId,
  );
  const draftHasRegression = draftExamples.some(
    (example) =>
      example.id === input.regressionExampleId &&
      example.familyId === input.bucket.familyId &&
      example.toolName === input.bucket.toolName &&
      example.category === "regression",
  );
  if (!draftHasRegression) {
    return { ok: false, code: "regression_example_not_found" };
  }

  const filesRoot = hostedIntegrationGenerationFilesRoot(
    input.dataDir,
    generation.id,
  );
  const manifest = FamilyManifestSchema.parse(
    parseYaml(await readFile(path.join(filesRoot, "family.yaml"), "utf-8")),
  );
  const generationExamplesContent = await readOptionalTextFile(
    path.join(filesRoot, "examples.yaml"),
  );
  if (!generationExamplesContent) {
    return { ok: false, code: "regression_example_not_found" };
  }
  const generationExamples = ExamplesDocumentSchema.parse(
    parseYaml(generationExamplesContent),
  ).examples;
  const example = generationExamples.find(
    (candidate) =>
      candidate.id === input.regressionExampleId &&
      candidate.familyId === input.bucket.familyId &&
      candidate.toolName === input.bucket.toolName &&
      candidate.category === "regression",
  );
  if (!example) return { ok: false, code: "regression_example_not_found" };

  const tool = manifest.tools.find(
    (candidate) => candidate.name === example.toolName,
  );
  if (!tool) return { ok: false, code: "tool_not_found" };

  const { run, familyHome, runDir } = await input.service.artifacts.createRun({
    familyId: input.bucket.familyId,
    toolName: example.toolName,
    generationId: generation.id,
    actorId: input.actorId,
    input: example.args,
  });
  const environmentConfig =
    await input.service.environmentConfigs.getEnvironmentConfig(
      input.bucket.familyId,
      "test_debug",
    );
  const executionConfig = resolveHostedIntegrationExecutionConfig({
    familyId: input.bucket.familyId,
    environment: "test_debug",
    generation,
    policyDecision: { ok: true, resolvedEnvironment: "test_debug" },
    environmentConfig,
    executionPurpose: "regression",
  });
  if (!executionConfig.ok)
    return { ok: false, code: "regression_example_failed", runId: run.id };
  await input.service.gateway.executionLogs.startLog({
    runId: run.id,
    familyId: input.bucket.familyId,
    toolName: example.toolName,
    generationId: generation.id,
    actorId: input.actorId,
    environmentConfigId: executionConfig.environmentConfigId ?? null,
    configRevision: executionConfig.configRevision ?? null,
    executionPurpose: executionConfig.executionPurpose,
    sanitizedArgs: JsonObjectSchema.parse(example.args),
    status: "running",
    startedAt: run.startedAt,
  });

  const runtimeResult = await new HostedIntegrationPythonRuntime().callTool({
    familyId: input.bucket.familyId,
    generationId: generation.id,
    filesRoot,
    runtime: manifest.runtime,
    timeoutMs: manifest.runtime.defaultTimeoutMs,
    toolName: example.toolName,
    args: JsonObjectSchema.parse(example.args),
    context: {
      familyId: input.bucket.familyId,
      generationId: generation.id,
      runId: run.id,
      familyHome,
      runDir,
      config: executionConfig.config,
      secrets: executionConfig.secretsEnvironmentConfigId
        ? await input.service.secrets.readSecretsForRuntime({
            environmentConfigId: executionConfig.secretsEnvironmentConfigId,
          })
        : {},
    },
  });
  if (!runtimeResult.ok) {
    const error = {
      code: runtimeResult.error.code,
      message: runtimeResult.error.message,
      ...(runtimeResult.error.details === undefined
        ? {}
        : { details: runtimeResult.error.details }),
    };
    await input.service.artifacts.completeRunError({
      familyId: input.bucket.familyId,
      runId: run.id,
      error: JsonObjectSchema.parse(error),
    });
    await input.service.gateway.executionLogs.finishLog(run.id, {
      status: "failed",
      endedAt: new Date().toISOString(),
      error,
    });
    return { ok: false, code: "regression_example_failed", runId: run.id };
  }

  await input.service.artifacts.completeRunSuccess({
    familyId: input.bucket.familyId,
    runId: run.id,
    result: runtimeResult.result,
    inlineResultTokenLimit: manifest.runtime.inlineResultTokenLimit,
  });
  await input.service.gateway.executionLogs.finishLog(run.id, {
    status: "succeeded",
    endedAt: new Date().toISOString(),
    resultEnvelopeRef: `${run.id}/output.json`,
  });
  return { ok: true, runId: run.id };
}

async function readOptionalTextFile(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

function hostedIntegrationGenerationFilesRoot(
  dataDir: string,
  generationId: string,
): string {
  return path.join(
    dataDir,
    "hosted-integrations",
    "generations",
    generationId,
    "files",
  );
}
