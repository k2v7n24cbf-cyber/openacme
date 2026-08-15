import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHostedIntegrationManagedToolName,
  createFileHostedIntegrationCatalog,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationDraftValidator,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
  resolveHostedIntegrationToolHelp,
} from "../src/index.js";

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
    const managedToolName = buildHostedIntegrationManagedToolName({
      familyId: "qualys",
      toolName: "qualys_count_assets",
    });

    const result = await resolveHostedIntegrationToolHelp({
      dataDir,
      generations,
      managedToolName,
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
        tool_name: managedToolName,
        family_id: "qualys",
        family_tool_name: "qualys_count_assets",
        generation_id: "gen_1",
        tool_help: {
          summary: "Count Qualys assets.",
          full: "Full count-assets help.\n",
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
      managedToolName: "managed_qualys__qualys_count_assets",
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
      managedToolName: "managed_qualys__qualys_count_assets",
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
      managedToolName: "managed_qualys__qualys_count_assets",
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
      managedToolName: "managed_qualys__qualys_count_assets",
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
    files: input.files,
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
  await mkdir(sourceDir, { recursive: true });
  await writeFile(
    path.join(sourceDir, "family.yaml"),
    familyYaml({ help: "" }),
    "utf-8",
  );
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
    files,
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
${help}
`;
}
