import { describe, expect, it } from "vitest";
import {
  FamilyManifestSchema,
  HostedToolContractDocumentSchema,
  HostedParameterVocabularySchema,
  hostedToolContractToToolSpecs,
  HostedIntegrationGenerationSchema,
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
} as const;

const minimalToolContract = {
  kind: "openacme.hostedToolFamily",
  version: 1,
  family: { id: "qualys" },
  tools: [
    {
      mcp: {
        name: "hosted_qualys__qualys_count_assets",
        title: "Count assets",
        description: "Count assets matching a safe query.",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string" },
          },
          additionalProperties: false,
        },
        outputSchema: {
          type: "object",
          additionalProperties: true,
        },
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      openacme: {
        toolName: "qualys_count_assets",
        function: "tool_qualys_count_assets",
        lifecycle: "active",
        classification: {
          operation: "read",
          freshness: "live",
          idempotency: "idempotent",
          execution: "sync",
          approval: "none",
        },
        selectWhen: ["Need to count matching Qualys assets."],
        doNotSelectWhen: ["Need to list matching Qualys assets."],
        prerequisites: [],
        parameterHelp: {
          query: { summary: "Qualys asset query string." },
        },
        examples: [{ query: "hostname:web" }],
        errors: [],
      },
    },
  ],
} as const;

describe("hosted integration schemas", () => {
  it("accepts a minimal valid Python family manifest", () => {
    const parsed = FamilyManifestSchema.parse(minimalManifest);

    expect(parsed.id).toBe("qualys");
    expect(parsed.runtime.language).toBe("python");

    const typed: FamilyManifest = parsed;
    expect(typed.runtime.entrypoint).toBe("qualys.py");
  });

  it("accepts a minimal hosted MCP tool contract document", () => {
    const parsed = HostedToolContractDocumentSchema.parse(minimalToolContract);

    expect(parsed.tools[0]?.mcp.name).toBe(
      "hosted_qualys__qualys_count_assets",
    );
    expect(hostedToolContractToToolSpecs(parsed)[0]).toMatchObject({
      name: "qualys_count_assets",
      outputSchema: { type: "object", additionalProperties: true },
      classification: { operation: "read" },
    });
  });

  it("accepts shared parameter vocabulary references under OpenAcme help", () => {
    const parsed = HostedToolContractDocumentSchema.parse({
      ...minimalToolContract,
      tools: [
        {
          ...minimalToolContract.tools[0],
          openacme: {
            ...minimalToolContract.tools[0].openacme,
            parameterHelp: {
              "query.filters.field": {
                summary: "Allowed Qualys GAV field token.",
                vocabularyRef: "references/gav-filter-fields.yaml",
              },
            },
          },
        },
      ],
    });

    expect(
      parsed.tools[0]?.openacme.parameterHelp["query.filters.field"]
        ?.vocabularyRef,
    ).toBe("references/gav-filter-fields.yaml");
  });

  it("rejects duplicate and colliding vocabulary values", () => {
    const parsed = HostedParameterVocabularySchema.safeParse({
      kind: "openacme.hostedParameterVocabulary",
      version: 1,
      id: "qualys-gav-filter-fields",
      familyId: "qualys",
      parameterPath: "filter_body.filters.field",
      entries: [
        { value: "asset.name", summary: "Asset name." },
        { value: "ASSET.NAME", summary: "Duplicate asset name." },
      ],
      invalidAliases: [
        {
          value: "asset.name",
          reason: "This collides with a supported value.",
        },
      ],
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          "duplicate vocabulary entry ASSET.NAME",
          "invalid vocabulary alias asset.name collides with a valid entry",
        ]),
      );
    }
  });

  it("rejects invalid family ids", () => {
    const parsed = FamilyManifestSchema.safeParse({
      ...minimalManifest,
      id: "Qualys Prod",
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects invalid tool names", () => {
    const parsed = HostedToolContractDocumentSchema.safeParse({
      ...minimalToolContract,
      tools: [
        {
          ...minimalToolContract.tools[0],
          openacme: {
            ...minimalToolContract.tools[0].openacme,
            toolName: "count-assets",
          },
        },
      ],
    });

    expect(parsed.success).toBe(false);
  });

  it("rejects old-style tool ownership in family manifests", () => {
    const parsed = FamilyManifestSchema.safeParse({
      ...minimalManifest,
      tools: [],
    });

    expect(parsed.success).toBe(false);
  });

  it("requires promoted generations to carry derived tool metadata", () => {
    const parsed = HostedIntegrationGenerationSchema.safeParse({
      id: "gen_missing_tools",
      familyId: "qualys",
      sourceRevisionId: "src_123",
      status: "active",
      promotedAt: "2026-08-12T00:00:00.000Z",
      promotedBy: "agent:tool-developer",
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
      tools: hostedToolContractToToolSpecs(
        HostedToolContractDocumentSchema.parse(minimalToolContract),
      ),
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
