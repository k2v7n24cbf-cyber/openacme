import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHostedToolName,
  createFileHostedIntegrationCatalog,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationDraftValidator,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
  HostedIntegrationToolHelpRequestSchema,
  resolveHostedIntegrationToolHelp,
} from "../src/index.js";
import {
  withSplitToolContractFiles,
  writeSplitFamilyFixture,
} from "./test-support/split-contract-fixtures.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-help-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("hosted integration tool help", () => {
  it("resolves active generation help with full tool and parameter details", async () => {
    const generations = await promoteHelpFamily({
      files: {
        "family.yaml": familyYaml({
          fullRef: "help/count-assets.md",
          parameterFullRef: "help/filter-body.md",
        }),
        "qualys.py": "def run(): pass\n",
        "help/count-assets.md": "Full count-assets help.\n",
        "help/filter-body.md": "Full filter_body help.\n",
        "examples.yaml": `
examples:
  - id: count-smoke
    familyId: qualys
    toolName: qualys_count_assets
    category: smoke
    args:
      filter_body:
        filters:
          - field: asset.name
            operator: EQUALS
            value: definitely-missing
`,
      },
    });
    const hostedToolName = buildHostedToolName({
      familyId: "qualys",
      toolName: "qualys_count_assets",
    });

    const result = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName,
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "full",
        include_examples: true,
        parameters: [
          {
            name: "filter_body",
            detail: "full",
            include_examples: true,
          },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      help: {
        tool_name: hostedToolName,
        family_id: "qualys",
        family_tool_name: "qualys_count_assets",
        generation_id: "gen_1",
        tool_help: {
          summary: "Count Qualys assets.",
          full: "Full count-assets help.\n",
          errors: [
            "bad_arguments means the request shape or filter token is unsupported; fix the input before retrying.",
          ],
          pagination: {
            model: "count",
            truncation: "No pagination; count result only.",
          },
        },
        parameters: {
          filter_body: {
            summary: "Native Qualys FilterRequest JSON body.",
            full: "Full filter_body help.\n",
            examples: [
              {
                filter_body: {
                  filters: [
                    {
                      field: "asset.name",
                      operator: "EQUALS",
                      value: "missing",
                    },
                  ],
                },
              },
            ],
          },
        },
        examples: [
          {
            filter_body: {
              filters: [
                {
                  field: "asset.name",
                  operator: "EQUALS",
                  value: "missing",
                },
              ],
            },
          },
          expect.objectContaining({
            id: "count-smoke",
            category: "smoke",
          }),
        ],
      },
    });
  });

  it("searches and checks shared parameter vocabularies", async () => {
    const generations = await promoteHelpFamily({
      files: {
        "family.yaml": familyYaml({
          help: `
    help:
      summary: Count Qualys assets.
      parameters:
        filter_body:
          summary: Native Qualys FilterRequest JSON body.
          full: Full inline filter_body help.
        filter_body.filters.field:
          summary: Native Qualys GAV filter token.
          vocabularyRef: references/gav-filter-fields.yaml
      examples:
        - filter_body:
            filters:
              - field: asset.name
                operator: EQUALS
                value: missing
`,
        }),
        "qualys.py": "def run(): pass\n",
        "references/gav-filter-fields.yaml": `
kind: openacme.hostedParameterVocabulary
version: 1
id: qualys-gav-filter-fields
familyId: qualys
parameterPath: filter_body.filters.field
entries:
  - value: asset.name
    summary: Asset name.
    description: Host asset display name.
    operators: [EQUALS, CONTAINS]
    aliases: [hostname]
  - value: software.name
    summary: Installed software name.
    operators: [EQUALS, CONTAINS]
    source: Qualys GAV field catalog
invalidAliases:
  - value: asset_last_updated
    reason: Not a supported GAV filter field.
    use: updateDate
`,
      },
    });
    const hostedToolName = buildHostedToolName({
      familyId: "qualys",
      toolName: "qualys_count_assets",
    });

    const metadataResult = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName,
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "summary",
        include_examples: false,
        parameters: [
          {
            name: "filter_body.filters.field",
            detail: "summary",
            include_examples: false,
          },
        ],
      },
    });

    expect(metadataResult).toMatchObject({
      ok: true,
      help: {
        parameters: {
          "filter_body.filters.field": {
            vocabulary: {
              id: "qualys-gav-filter-fields",
              parameter_path: "filter_body.filters.field",
              entry_count: 2,
              invalid_alias_count: 1,
              status: "ok",
              matches: [],
            },
          },
        },
      },
    });

    const queryResult = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName,
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "summary",
        include_examples: false,
        parameters: [
          {
            name: "filter_body.filters.field",
            detail: "summary",
            include_examples: false,
            query: "software",
            limit: 10,
          },
        ],
      },
    });

    expect(queryResult).toMatchObject({
      ok: true,
      help: {
        parameters: {
          "filter_body.filters.field": {
            vocabulary: {
              id: "qualys-gav-filter-fields",
              status: "ok",
              query: "software",
              matches: [
                {
                  value: "software.name",
                  summary: "Installed software name.",
                },
              ],
            },
          },
        },
      },
    });

    const aliasResult = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName,
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "summary",
        include_examples: false,
        parameters: [
          {
            name: "filter_body.filters.field",
            detail: "summary",
            include_examples: false,
            query: "hostname",
            limit: 10,
          },
        ],
      },
    });

    expect(aliasResult).toMatchObject({
      ok: true,
      help: {
        parameters: {
          "filter_body.filters.field": {
            vocabulary: {
              status: "ok",
              query: "hostname",
              matches: [
                {
                  value: "asset.name",
                  aliases: ["hostname"],
                },
              ],
            },
          },
        },
      },
    });

    const sourceResult = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName,
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "summary",
        include_examples: false,
        parameters: [
          {
            name: "filter_body.filters.field",
            detail: "summary",
            include_examples: false,
            query: "field catalog",
            limit: 10,
          },
        ],
      },
    });

    expect(sourceResult).toMatchObject({
      ok: true,
      help: {
        parameters: {
          "filter_body.filters.field": {
            vocabulary: {
              status: "ok",
              query: "field catalog",
              matches: [
                {
                  value: "software.name",
                  source: "Qualys GAV field catalog",
                },
              ],
            },
          },
        },
      },
    });

    const mixedResult = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName,
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "summary",
        include_examples: false,
        parameters: [
          {
            name: "filter_body.filters.field",
            detail: "summary",
            include_examples: false,
            query: "asset",
            value: "asset_last_updated",
            limit: 10,
          },
        ],
      },
    });

    expect(mixedResult).toMatchObject({
      ok: true,
      help: {
        parameters: {
          "filter_body.filters.field": {
            vocabulary: {
              status: "ok",
              query: "asset",
              ignored_value: "asset_last_updated",
              warnings: [
                "query and value were both supplied; query was used and value was ignored.",
              ],
              matches: [
                {
                  value: "asset.name",
                },
              ],
            },
          },
        },
      },
    });

    const inferredNestedResult = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName,
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "summary",
        include_examples: false,
        parameters: [
          {
            name: "filter_body",
            detail: "summary",
            include_examples: false,
            query: "software",
            value: "asset_last_updated",
            limit: 10,
          },
        ],
      },
    });

    expect(inferredNestedResult).toMatchObject({
      ok: true,
      help: {
        parameters: {
          filter_body: {
            vocabulary: {
              status: "ok",
              query: "software",
              ignored_value: "asset_last_updated",
              warnings: [
                "query and value were both supplied; query was used and value was ignored.",
                "vocabulary lookup was inferred from filter_body.filters.field; request that parameter path directly for precise help.",
              ],
              matches: [
                {
                  value: "software.name",
                },
              ],
            },
          },
        },
      },
    });

    const exactResult = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName,
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "summary",
        include_examples: false,
        parameters: [
          {
            name: "filter_body.filters.field",
            detail: "summary",
            include_examples: false,
            value: "asset_last_updated",
            limit: 10,
          },
        ],
      },
    });

    expect(exactResult).toMatchObject({
      ok: true,
      help: {
        parameters: {
          "filter_body.filters.field": {
            vocabulary: {
              status: "invalid_alias",
              value: "asset_last_updated",
              invalid_alias: {
                reason: "Not a supported GAV filter field.",
                use: "updateDate",
              },
            },
          },
        },
      },
    });
  });

  it("accepts mixed query and value requests by using query and warning about the ignored value", async () => {
    const parsed = HostedIntegrationToolHelpRequestSchema.parse({
      tool_name: "hosted_qualys__qualys_count_assets",
      tool_detail: "summary",
      include_examples: false,
      parameters: [
        {
          name: "filter_body.filters.field",
          detail: "summary",
          include_examples: false,
          query: "asset",
          value: "asset.name",
          limit: 10,
        },
      ],
    });

    expect(parsed.parameters?.[0]).toMatchObject({
      query: "asset",
      value: "asset.name",
    });
  });

  it("returns not_found, truncation, and no unsafe vocabulary file paths", async () => {
    const generations = await promoteHelpFamily({
      files: {
        "family.yaml": familyYaml({
          help: `
    help:
      summary: Count Qualys assets.
      parameters:
        filter_body:
          summary: Native Qualys FilterRequest JSON body.
          full: Full inline filter_body help.
        filter_body.filters.field:
          summary: Native Qualys GAV filter token.
          vocabularyRef: references/gav-filter-fields.yaml
      examples:
        - filter_body:
            filters:
              - field: asset.name
                operator: EQUALS
                value: missing
`,
        }),
        "qualys.py": "def run(): pass\n",
        "references/gav-filter-fields.yaml": `
kind: openacme.hostedParameterVocabulary
version: 1
id: qualys-gav-filter-fields
familyId: qualys
parameterPath: filter_body.filters.field
entries:
  - value: asset.name
    summary: Asset name.
  - value: asset.trackingMethod
    summary: Asset tracking method.
  - value: asset.id
    summary: Asset id.
`,
      },
    });
    const hostedToolName = buildHostedToolName({
      familyId: "qualys",
      toolName: "qualys_count_assets",
    });

    const queryResult = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName,
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "summary",
        include_examples: false,
        parameters: [
          {
            name: "filter_body.filters.field",
            detail: "summary",
            include_examples: false,
            query: "asset",
            limit: 2,
          },
        ],
      },
    });
    expect(queryResult).toMatchObject({
      ok: true,
      help: {
        parameters: {
          "filter_body.filters.field": {
            vocabulary: {
              status: "ok",
              truncated: true,
              matches: [
                { value: "asset.name" },
                { value: "asset.trackingMethod" },
              ],
            },
          },
        },
      },
    });
    if (!queryResult.ok) throw new Error("expected query help result");
    const serialized = JSON.stringify(queryResult.help);
    expect(serialized).not.toContain("references/gav-filter-fields.yaml");
    expect(serialized).not.toContain(dataDir);

    const exactResult = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName,
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "summary",
        include_examples: false,
        parameters: [
          {
            name: "filter_body.filters.field",
            detail: "summary",
            include_examples: false,
            value: "missing.field",
            limit: 10,
          },
        ],
      },
    });

    expect(exactResult).toMatchObject({
      ok: true,
      help: {
        parameters: {
          "filter_body.filters.field": {
            vocabulary: {
              status: "not_found",
              value: "missing.field",
            },
          },
        },
      },
    });
  });

  it("reports no_vocabulary when lookup is requested without a vocabulary ref", async () => {
    const generations = await promoteHelpFamily({
      files: {
        "family.yaml": familyYaml({}),
        "qualys.py": "def run(): pass\n",
      },
    });
    const hostedToolName = buildHostedToolName({
      familyId: "qualys",
      toolName: "qualys_count_assets",
    });

    const result = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName,
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "summary",
        include_examples: false,
        parameters: [
          {
            name: "filter_body",
            detail: "summary",
            include_examples: false,
            query: "asset",
            limit: 10,
          },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      help: {
        parameters: {
          filter_body: {
            vocabulary: {
              status: "no_vocabulary",
              query: "asset",
            },
          },
        },
      },
    });
  });

  it("does not guess when object-level vocabulary lookup is ambiguous", async () => {
    const generations = await promoteHelpFamily({
      files: {
        "family.yaml": familyYaml({
          help: `
    help:
      summary: Count Qualys assets.
      parameters:
        filter_body:
          summary: Native Qualys FilterRequest JSON body.
          full: Full inline filter_body help.
        filter_body.filters.field:
          summary: Native Qualys GAV filter token.
          vocabularyRef: references/gav-filter-fields.yaml
        filter_body.filters.operator:
          summary: Native Qualys GAV filter operator.
          vocabularyRef: references/gav-filter-operators.yaml
`,
        }),
        "qualys.py": "def run(): pass\n",
        "references/gav-filter-fields.yaml": `
kind: openacme.hostedParameterVocabulary
version: 1
id: qualys-gav-filter-fields
familyId: qualys
parameterPath: filter_body.filters.field
entries:
  - value: asset.name
    summary: Asset name.
`,
        "references/gav-filter-operators.yaml": `
kind: openacme.hostedParameterVocabulary
version: 1
id: qualys-gav-filter-operators
familyId: qualys
parameterPath: filter_body.filters.operator
entries:
  - value: EQUALS
    summary: Exact match.
`,
      },
    });

    const result = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName: "hosted_qualys__qualys_count_assets",
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "summary",
        include_examples: false,
        parameters: [
          {
            name: "filter_body",
            detail: "summary",
            include_examples: false,
            query: "asset",
            limit: 10,
          },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      help: {
        parameters: {
          filter_body: {
            vocabulary: {
              status: "ambiguous_vocabulary",
              query: "asset",
              matches: [],
              candidate_parameter_paths: [
                "filter_body.filters.field",
                "filter_body.filters.operator",
              ],
              warnings: [
                "vocabulary lookup for filter_body is ambiguous; request one precise parameter path.",
              ],
            },
          },
        },
      },
    });
  });

  it("falls back to description and schema when explicit help is absent", async () => {
    const generations = await promoteHelpFamily({
      files: {
        "family.yaml": familyYaml({ help: "" }),
        "qualys.py": "def run(): pass\n",
      },
    });

    const result = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName: "hosted_qualys__qualys_count_assets",
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "summary",
        include_examples: false,
        parameters: [
          { name: "filter_body", detail: "summary", include_examples: false },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      help: {
        tool_help: { summary: "Count Qualys assets." },
        parameters: {
          filter_body: {
            summary:
              "filter_body accepts a object matching the tool input schema.",
          },
        },
        examples: [],
      },
    });
  });

  it("expands documented parameters with full detail when full tool help omits parameters", async () => {
    const generations = await promoteHelpFamily({
      files: {
        "family.yaml": familyYaml({
          parameterFullRef: "help/filter-body.md",
        }),
        "qualys.py": "def run(): pass\n",
        "help/filter-body.md": "Full filter_body help.\n",
      },
    });

    const result = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName: "hosted_qualys__qualys_count_assets",
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "full",
        include_examples: false,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      help: {
        parameters: {
          filter_body: {
            summary: "Native Qualys FilterRequest JSON body.",
            full: "Full filter_body help.\n",
          },
          "filter_body.filters.field": {
            summary: "Native Qualys GAV filter token.",
          },
        },
      },
    });
  });

  it("validates unsafe or missing help file references before promotion", async () => {
    const validator = await setupValidator({
      "family.yaml": familyYaml({ fullRef: "help/../secret.md" }),
      "qualys.py": "def run(): pass\n",
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "help_file_path_invalid",
        path: "$.tools.0.help.full",
      }),
    );
  });

  it("returns structured no-example justification when examples are omitted", async () => {
    const generations = await promoteHelpFamily({
      files: {
        "family.yaml": familyYaml({
          help: `
    help:
      summary: Count Qualys assets.
      noExampleJustification: This tool has no useful static example.
`,
        }),
        "qualys.py": "def run(): pass\n",
      },
    });

    const result = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName: "hosted_qualys__qualys_count_assets",
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "summary",
        include_examples: true,
      },
    });

    expect(result).toMatchObject({
      ok: true,
      help: {
        tool_help: {
          summary: "Count Qualys assets.",
          no_example_justification: "This tool has no useful static example.",
        },
        examples: [],
      },
    });
  });

  it("resolves unique suffix parameter requests to nested help metadata", async () => {
    const generations = await promoteHelpFamily({
      files: {
        "family.yaml": familyYaml({}),
        "qualys.py": "def run(): pass\n",
      },
    });

    const result = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      hostedToolName: "hosted_qualys__qualys_count_assets",
      familyId: "qualys",
      toolName: "qualys_count_assets",
      request: {
        tool_detail: "none",
        include_examples: false,
        parameters: [
          { name: "field", detail: "summary", include_examples: false },
        ],
      },
    });

    expect(result).toMatchObject({
      ok: true,
      help: {
        parameters: {
          field: {
            summary: "Native Qualys GAV filter token.",
          },
        },
      },
    });
  });
});

async function promoteHelpFamily(input: { files: Record<string, string> }) {
  const lockStore = createFileHostedIntegrationLockStore({
    dataDir,
    createId: () => "lock_1",
  });
  await lockStore.acquireLock({
    familyId: "qualys",
    lockedBy: "agent:tool-developer",
    ttlMs: 60_000,
  });
  const draftStore = createFileHostedIntegrationDraftStore({
    dataDir,
    lockStore,
    createId: () => "draft_1",
  });
  const draft = await draftStore.createDraftFromFiles({
    familyId: "qualys",
    lockId: "lock_1",
    sourceRevisionId: "source_rev_1",
    files: withSplitToolContractFiles(input.files),
  });
  expect(draft.ok).toBe(true);
  const generations = createFileHostedIntegrationGenerationStore({
    dataDir,
    draftStore,
    createId: () => "gen_1",
  });
  const promoted = await generations.promoteDraft({
    draftId: "draft_1",
    promotedBy: "agent:tool-developer",
    validation: { ok: true, diagnostics: [] },
  });
  expect(promoted.ok).toBe(true);
  return generations;
}

async function setupValidator(files: Record<string, string>) {
  const sourceDir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    "qualys",
  );
  await writeSplitFamilyFixture(sourceDir, familyYaml({ help: "" }));
  await writeFile(
    path.join(sourceDir, "qualys.py"),
    "def run(): pass\n",
    "utf-8",
  );
  const lockStore = createFileHostedIntegrationLockStore({
    dataDir,
    createId: () => "lock_1",
  });
  await lockStore.acquireLock({
    familyId: "qualys",
    lockedBy: "agent:tool-developer",
    ttlMs: 60_000,
  });
  const draftStore = createFileHostedIntegrationDraftStore({
    dataDir,
    lockStore,
    createId: () => "draft_1",
  });
  const draft = await draftStore.createDraftFromFiles({
    familyId: "qualys",
    lockId: "lock_1",
    sourceRevisionId: "source_rev_1",
    files: withSplitToolContractFiles(files),
  });
  expect(draft.ok).toBe(true);
  return createFileHostedIntegrationDraftValidator({
    draftStore,
    catalog: createFileHostedIntegrationCatalog({ dataDir }),
  });
}

function familyYaml(input: {
  help?: string;
  fullRef?: string;
  parameterFullRef?: string;
}): string {
  const help =
    input.help ??
    `
    help:
      summary: Count Qualys assets.
      full: ${input.fullRef ?? "Full inline count-assets help."}
      whenToUse:
        - Use for read-only asset counts.
      whenNotToUse:
        - Do not use for listing asset records.
      parameters:
        filter_body:
          summary: Native Qualys FilterRequest JSON body.
          full: ${input.parameterFullRef ?? "Full inline filter_body help."}
          rules:
            - Use native Qualys GAV filter field tokens.
          examples:
            - filter_body:
                filters:
                  - field: asset.name
                    operator: EQUALS
                    value: missing
        filter_body.filters.field:
          summary: Native Qualys GAV filter token.
      examples:
        - filter_body:
            filters:
              - field: asset.name
                operator: EQUALS
                value: missing
`;
  return `
id: qualys
name: Qualys
version: 1
runtime:
  language: python
  entrypoint: qualys.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 2
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: declared_egress
  dependencyPolicy:
    installDuringInvocation: false
    allowedPackages: []
tools:
  - name: qualys_count_assets
    title: Count assets
    description: Count Qualys assets.
    inputSchema:
      type: object
      properties:
        filter_body:
          type: object
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means the request shape or filter token is unsupported; fix the input before retrying.
    pagination:
      model: count
      truncation: No pagination; count result only.
${help}
`;
}
