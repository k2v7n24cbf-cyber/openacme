import { describe, expect, it } from "vitest";
import {
  FamilyManifestSchema,
  HostedIntegrationIdempotencyRecordSchema,
  HostedIntegrationRuntimeSettingsSchema,
  type FamilyManifest,
  type HostedIntegrationFailureBucket,
  type HostedIntegrationGeneration,
  type HostedIntegrationRun,
} from "../src/index.js";

const minimalManifest = {
  id: "qualys",
  name: "Qualys",
  version: 1,
  runtime: {
    language: "python",
    entrypoint: "qualys.py",
    defaultTimeoutMs: 30_000,
    inlineResultTokenLimit: 8_000,
    maxConcurrency: 4,
    runtimePolicy: {
      filesystem: "run_dir_and_family_home",
      processEnv: "tool_context_only",
      subprocess: "denied",
      network: "declared_egress",
    },
    dependencyPolicy: {
      installDuringInvocation: false,
      allowedPackages: ["httpx"],
    },
  },
  tools: [
    {
      name: "qualys_count_assets",
      title: "Count assets",
      description: "Count assets matching a safe query.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
        additionalProperties: false,
      },
      classification: {
        operation: "read",
        freshness: "live",
        idempotency: "idempotent",
        execution: "sync",
        approval: "none",
      },
    },
  ],
} as const;

describe("hosted integration schemas", () => {
  it("accepts a minimal valid Python family manifest", () => {
    const parsed = FamilyManifestSchema.parse(minimalManifest);

    expect(parsed.id).toBe("qualys");
    expect(parsed.runtime.language).toBe("python");
    expect(parsed.tools[0]?.classification.operation).toBe("read");

    const typed: FamilyManifest = parsed;
    expect(typed.tools[0]?.name).toBe("qualys_count_assets");
  });

  it("rejects invalid family ids", () => {
    const parsed = FamilyManifestSchema.safeParse({
      ...minimalManifest,
      id: "Qualys Prod",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects invalid tool names", () => {
    const parsed = FamilyManifestSchema.safeParse({
      ...minimalManifest,
      tools: [{ ...minimalManifest.tools[0], name: "count-assets" }],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects tools without classification metadata", () => {
    const { classification: _classification, ...toolWithoutClassification } =
      minimalManifest.tools[0];
    const parsed = FamilyManifestSchema.safeParse({
      ...minimalManifest,
      tools: [toolWithoutClassification],
    });

    expect(parsed.success).toBe(false);
  });

  it("validates family-level runtime settings", () => {
    expect(
      HostedIntegrationRuntimeSettingsSchema.parse(minimalManifest.runtime),
    ).toMatchObject({
      defaultTimeoutMs: 30_000,
      inlineResultTokenLimit: 8_000,
      maxConcurrency: 4,
    });

    expect(
      HostedIntegrationRuntimeSettingsSchema.safeParse({
        ...minimalManifest.runtime,
        installDuringInvocation: true,
        defaultTimeoutMs: 0,
      }).success,
    ).toBe(false);

    expect(
      HostedIntegrationRuntimeSettingsSchema.safeParse({
        ...minimalManifest.runtime,
        handlerDispatch: "derived",
      }).success,
    ).toBe(false);
  });

  it("exports stable lifecycle domain types", () => {
    const generation: HostedIntegrationGeneration = {
      id: "gen_123",
      familyId: "qualys",
      sourceRevisionId: "src_123",
      status: "active",
      promotedAt: "2026-08-12T00:00:00.000Z",
      promotedBy: "agent:tool-developer",
    };
    const run: HostedIntegrationRun = {
      id: "run_123",
      familyId: "qualys",
      toolName: "qualys_count_assets",
      generationId: generation.id,
      status: "succeeded",
      startedAt: generation.promotedAt,
    };
    const bucket: HostedIntegrationFailureBucket = {
      id: "bucket_123",
      familyId: "qualys",
      toolName: "qualys_count_assets",
      generationId: generation.id,
      fingerprint: "sha256:abc",
      status: "open",
      count: 1,
      firstSeenAt: generation.promotedAt,
      latestSeenAt: generation.promotedAt,
    };

    expect(run.generationId).toBe(generation.id);
    expect(bucket.status).toBe("open");
  });

  it("validates idempotency records without storing raw payloads", () => {
    const parsed = HostedIntegrationIdempotencyRecordSchema.parse({
      key: "idem_123",
      operation: "invoke",
      actorId: "agent:soc",
      target: "qualys/qualys_count_assets",
      fingerprint: "sha256:request",
      status: "completed",
      resultEnvelopeRef: "run_123/output.json",
      createdAt: "2026-08-12T00:00:00.000Z",
      updatedAt: "2026-08-12T00:00:00.000Z",
    });

    expect(parsed).not.toHaveProperty("rawArgs");
    expect(
      HostedIntegrationIdempotencyRecordSchema.safeParse({
        ...parsed,
        rawArgs: { secret: "nope" },
      }).success,
    ).toBe(false);
  });
});
