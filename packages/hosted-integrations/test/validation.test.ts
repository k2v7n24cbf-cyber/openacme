import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationCatalog,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationDraftValidator,
  createFileHostedIntegrationLockStore,
} from "../src/index.js";
import { splitLegacyFamilyFixture } from "./test-support/split-contract-fixtures.js";

let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-validation-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function setupDraft(
  sourceManifest = familyYaml(),
  draftManifest = sourceManifest,
  options: {
    examplesYaml?: string;
    extraFiles?: Record<string, string>;
    helpQualityMode?: "warning" | "error";
    draftFamilyYaml?: string;
    draftToolsYaml?: string;
    sourcePy?: string;
  } = {},
): Promise<ReturnType<typeof createFileHostedIntegrationDraftValidator>> {
  const sourceDir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    "qualys",
  );
  await mkdir(sourceDir, { recursive: true });
  const sourceFiles = splitLegacyFamilyFixture(sourceManifest);
  const draftFiles = splitLegacyFamilyFixture(draftManifest);
  await writeFile(
    path.join(sourceDir, "family.yaml"),
    sourceFiles.familyYaml,
    "utf-8",
  );
  await writeFile(
    path.join(sourceDir, "tools.yaml"),
    sourceFiles.toolsYaml,
    "utf-8",
  );
  await writeFile(
    path.join(sourceDir, "qualys.py"),
    options.sourcePy ?? validPythonHandlers(),
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
  await draftStore.createDraft({
    familyId: "qualys",
    lockId: "lock_1",
    sourceRevisionId: "source_rev_1",
  });
  await draftStore.writeDraftFile({
    draftId: "draft_1",
    lockId: "lock_1",
    path: "family.yaml",
    content: options.draftFamilyYaml ?? draftFiles.familyYaml,
  });
  await draftStore.writeDraftFile({
    draftId: "draft_1",
    lockId: "lock_1",
    path: "tools.yaml",
    content: options.draftToolsYaml ?? draftFiles.toolsYaml,
  });
  if (options.examplesYaml) {
    await draftStore.writeDraftFile({
      draftId: "draft_1",
      lockId: "lock_1",
      path: "examples.yaml",
      content: options.examplesYaml,
    });
  }
  for (const [filePath, content] of Object.entries(options.extraFiles ?? {})) {
    await draftStore.writeDraftFile({
      draftId: "draft_1",
      lockId: "lock_1",
      path: filePath,
      content,
    });
  }

  return createFileHostedIntegrationDraftValidator({
    draftStore,
    catalog: createFileHostedIntegrationCatalog({ dataDir }),
    helpQualityMode: options.helpQualityMode,
  });
}

function familyYaml(): string {
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
    description: Count assets matching a query.
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means the request shape is unsupported; fix input before retrying.
    help:
      summary: Count Qualys assets.
      examples:
        - {}
  - name: qualys_list_assets
    title: List assets
    description: List assets matching a query.
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
    errors:
      - bad_arguments means the request shape is unsupported; fix input before retrying.
    help:
      summary: List Qualys assets.
      examples:
        - {}
`;
}

function validPythonHandlers(): string {
  return [
    "def authenticate(ctx):",
    "    return {}",
    "",
    "def before_tool_call(tool_name, args, ctx, auth):",
    "    return args",
    "",
    "def after_tool_call(tool_name, args, ctx, result, auth):",
    "    return result",
    "",
    "def tool_qualys_count_assets(args, context):",
    "    return {}",
    "",
    "def tool_qualys_list_assets(args, context):",
    "    return {}",
    "",
  ].join("\n");
}

describe("hosted integration draft validation", () => {
  it("passes a valid draft", async () => {
    const validator = await setupDraft();

    await expect(validator.validateDraft("draft_1")).resolves.toEqual({
      ok: true,
      diagnostics: [],
    });
  });

  it("accepts a valid shared parameter vocabulary reference", async () => {
    const manifest = familyYaml()
      .replace(
        "properties: {}",
        "properties:\n        filter_body:\n          type: object",
      )
      .replace(
        "summary: Count Qualys assets.",
        "summary: Count Qualys assets.\n      parameters:\n        filter_body:\n          summary: Native Qualys filter body.\n          full: Full inline filter help.\n        filter_body.filters.field:\n          summary: Native Qualys GAV field token.\n          vocabularyRef: references/gav-filter-fields.yaml",
      );
    const validator = await setupDraft(familyYaml(), manifest, {
      extraFiles: {
        "references/gav-filter-fields.yaml": `
kind: openacme.hostedParameterVocabulary
version: 1
id: qualys-gav-filter-fields
familyId: qualys
parameterPath: filter_body.filters.field
entries:
  - value: asset.name
    summary: Asset name field.
invalidAliases:
  - value: asset_last_updated
    reason: Use updateDate instead.
    use: updateDate
`,
      },
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "vocabulary_ref_missing" }),
    );
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "vocabulary_ref_invalid" }),
    );
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "vocabulary_parameter_path_mismatch" }),
    );
  });

  it("accepts the same shared parameter vocabulary referenced by multiple tools", async () => {
    const manifest = familyYaml()
      .replace(
        "properties: {}",
        "properties:\n        filter_body:\n          type: object",
      )
      .replace(
        "properties: {}",
        "properties:\n        filter_body:\n          type: object",
      )
      .replace(
        "summary: Count Qualys assets.",
        "summary: Count Qualys assets.\n      parameters:\n        filter_body:\n          summary: Native Qualys filter body.\n          full: Use filters[] with native Qualys GAV field tokens.\n        filter_body.filters.field:\n          summary: Native Qualys GAV field token.\n          vocabularyRef: references/gav-filter-fields.yaml",
      )
      .replace(
        "summary: List Qualys assets.",
        "summary: List Qualys assets.\n      parameters:\n        filter_body:\n          summary: Native Qualys filter body.\n          full: Use filters[] with native Qualys GAV field tokens.\n        filter_body.filters.field:\n          summary: Native Qualys GAV field token.\n          vocabularyRef: references/gav-filter-fields.yaml",
      );
    const validator = await setupDraft(familyYaml(), manifest, {
      extraFiles: {
        "references/gav-filter-fields.yaml": `
kind: openacme.hostedParameterVocabulary
version: 1
id: qualys-gav-filter-fields
familyId: qualys
parameterPath: filter_body.filters.field
entries:
  - value: asset.name
    summary: Asset name field.
`,
      },
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([]);
  });

  it("fails when a vocabulary reference is missing", async () => {
    const manifest = familyYaml().replace(
      "summary: Count Qualys assets.",
      "summary: Count Qualys assets.\n      parameters:\n        query:\n          summary: Query field.\n          vocabularyRef: references/missing.yaml",
    );
    const validator = await setupDraft(familyYaml(), manifest);

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "vocabulary_ref_missing",
        path: "$.tools.0.openacme.parameterHelp.query.vocabularyRef",
      }),
    );
  });

  it("fails when vocabulary familyId does not match the draft family", async () => {
    const manifest = familyYaml().replace(
      "summary: Count Qualys assets.",
      "summary: Count Qualys assets.\n      parameters:\n        query:\n          summary: Query field.\n          vocabularyRef: references/query-fields.yaml",
    );
    const validator = await setupDraft(familyYaml(), manifest, {
      extraFiles: {
        "references/query-fields.yaml": `
kind: openacme.hostedParameterVocabulary
version: 1
id: query-fields
familyId: splunk
parameterPath: query
entries:
  - value: asset.name
    summary: Asset name field.
`,
      },
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "vocabulary_family_mismatch",
        path: "$.tools.0.openacme.parameterHelp.query.vocabularyRef",
      }),
    );
  });

  it("fails when vocabulary parameterPath does not match the help parameter", async () => {
    const manifest = familyYaml().replace(
      "summary: Count Qualys assets.",
      "summary: Count Qualys assets.\n      parameters:\n        query:\n          summary: Query field.\n          vocabularyRef: references/query-fields.yaml",
    );
    const validator = await setupDraft(familyYaml(), manifest, {
      extraFiles: {
        "references/query-fields.yaml": `
kind: openacme.hostedParameterVocabulary
version: 1
id: query-fields
familyId: qualys
parameterPath: filter_body.filters.field
entries:
  - value: asset.name
    summary: Asset name field.
`,
      },
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "vocabulary_parameter_path_mismatch",
        path: "$.tools.0.openacme.parameterHelp.query.vocabularyRef",
      }),
    );
  });

  it("fails complex filter bodies without nested field vocabulary help in blocking mode", async () => {
    const manifest = familyYaml()
      .replace(
        "properties: {}",
        "properties:\n        filter_body:\n          type: object",
      )
      .replace(
        "summary: Count Qualys assets.",
        "summary: Count Qualys assets.\n      parameters:\n        filter_body:\n          summary: Native Qualys filter body.\n          full: Full inline filter help.",
      );
    const validator = await setupDraft(familyYaml(), manifest, {
      helpQualityMode: "error",
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "help_parameter_vocabulary_missing",
        path: "$.tools.0.help.parameters.filter_body.filters.field",
      }),
    );
  });

  it("fails complex query/body filter DSLs without nested field vocabulary help in blocking mode", async () => {
    const manifest = familyYaml()
      .replace(
        "properties: {}",
        [
          "properties:",
          "        query_body:",
          "          type: object",
          "          properties:",
          "            filters:",
          "              type: array",
          "              items:",
          "                type: object",
          "                properties:",
          "                  field:",
          "                    type: string",
        ].join("\n"),
      )
      .replace(
        "summary: Count Qualys assets.",
        "summary: Count Qualys assets.\n      parameters:\n        query_body:\n          summary: Native provider query body.\n          full: Full inline query body help.",
      );
    const validator = await setupDraft(familyYaml(), manifest, {
      helpQualityMode: "error",
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "help_parameter_vocabulary_missing",
        path: "$.tools.0.help.parameters.query_body.filters.field",
      }),
    );
  });

  it("does not require vocabulary help for generic complex bodies without filter field catalogs", async () => {
    const manifest = familyYaml()
      .replace(
        "properties: {}",
        [
          "properties:",
          "        request_body:",
          "          type: object",
          "          properties:",
          "            include_metadata:",
          "              type: boolean",
        ].join("\n"),
      )
      .replace(
        "summary: Count Qualys assets.",
        "summary: Count Qualys assets.\n      parameters:\n        request_body:\n          summary: Native provider request body.\n          full: Full inline request body help.",
      );
    const validator = await setupDraft(familyYaml(), manifest, {
      helpQualityMode: "error",
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: "help_parameter_vocabulary_missing",
      }),
    );
  });

  it("fails when a new-format Python entrypoint lacks a derived tool handler", async () => {
    const validator = await setupDraft(familyYaml(), familyYaml(), {
      sourcePy: [
        "def tool_qualys_count_assets(args, context):",
        "    return {}",
        "",
      ].join("\n"),
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "python_handler_missing",
        path: "$.tools.1.name",
        message:
          "tool qualys_list_assets requires Python handler tool_qualys_list_assets(args, context)",
      }),
    );
  });

  it("fails when a derived Python handler does not accept args and context", async () => {
    const validator = await setupDraft(familyYaml(), familyYaml(), {
      sourcePy: [
        "def tool_qualys_count_assets(args, context):",
        "    return {}",
        "",
        "def tool_qualys_list_assets(args, ctx):",
        "    return {}",
        "",
      ].join("\n"),
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "python_handler_signature_invalid",
        path: "$.tools.1.name",
        message:
          "handler tool_qualys_list_assets must be defined as tool_qualys_list_assets(args, context)",
      }),
    );
  });

  it("fails when a legacy Python entrypoint lacks explicit compatibility metadata", async () => {
    const validator = await setupDraft(familyYaml(), familyYaml(), {
      sourcePy: [
        "def call_tool(name, args, context):",
        "    return {}",
        "",
      ].join("\n"),
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "python_handler_missing",
        path: "$.tools.0.name",
      }),
    );
  });

  it("rejects explicit legacy dispatch metadata", async () => {
    const validator = await setupDraft(
      familyYaml().replace(
        "entrypoint: qualys.py",
        "entrypoint: qualys.py\n  handlerDispatch: legacy_call_tool",
      ),
      familyYaml().replace(
        "entrypoint: qualys.py",
        "entrypoint: qualys.py\n  handlerDispatch: legacy_call_tool",
      ),
      {
        sourcePy: [
          "def call_tool(name, args, context):",
          "    return {}",
          "",
        ].join("\n"),
      },
    );

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "manifest_invalid",
        path: "$.runtime",
        message: expect.stringContaining("handlerDispatch"),
      }),
    );
  });

  it("fails when a new-format entrypoint omits a standard hook without justification", async () => {
    const validator = await setupDraft(familyYaml(), familyYaml(), {
      sourcePy: [
        "def authenticate(ctx):",
        "    return {}",
        "",
        "def before_tool_call(tool_name, args, ctx, auth):",
        "    return args",
        "",
        "def tool_qualys_count_assets(args, context):",
        "    return {}",
        "",
        "def tool_qualys_list_assets(args, context):",
        "    return {}",
        "",
      ].join("\n"),
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "python_hook_missing",
        path: "$.hookJustifications.after_tool_call",
      }),
    );
  });

  it("accepts a missing standard hook with an explicit manifest justification", async () => {
    const validator = await setupDraft(
      familyYaml(),
      familyYaml().replace(
        "tools:",
        [
          "hookJustifications:",
          "  after_tool_call: No shared post-processing is needed for these read-only tools.",
          "tools:",
        ].join("\n"),
      ),
      {
        sourcePy: [
          "def authenticate(ctx):",
          "    return {}",
          "",
          "def before_tool_call(tool_name, args, ctx, auth):",
          "    return args",
          "",
          "def tool_qualys_count_assets(args, context):",
          "    return {}",
          "",
          "def tool_qualys_list_assets(args, context):",
          "    return {}",
          "",
        ].join("\n"),
      },
    );

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(true);
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ code: "python_hook_missing" }),
    );
  });

  it("fails when a standard hook uses the wrong signature", async () => {
    const validator = await setupDraft(familyYaml(), familyYaml(), {
      sourcePy: validPythonHandlers().replace(
        "def before_tool_call(tool_name, args, ctx, auth):",
        "def before_tool_call(name, args, ctx, auth):",
      ),
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "python_hook_signature_invalid",
        path: "$.runtime.entrypoint.before_tool_call",
      }),
    );
  });

  it("rejects manifest handler aliases instead of accepting custom mapping", async () => {
    const validator = await setupDraft(
      familyYaml(),
      familyYaml().replace(
        "    inputSchema:",
        "    handler: custom_count_handler\n    inputSchema:",
      ),
    );

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "tool_contract_invalid",
        path: "$.tools.0.openacme.function",
      }),
    );
  });

  it("returns structured diagnostics for missing classification", async () => {
    const validator = await setupDraft(
      familyYaml(),
      familyYaml().replace(
        /\n    classification:\n      operation: read\n      freshness: live\n      idempotency: idempotent\n      execution: sync\n      approval: none/,
        "",
      ),
    );

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "tool_contract_invalid",
        path: "$.tools.0.openacme.classification",
      }),
    );
  });

  it("fails duplicate tool names", async () => {
    const validator = await setupDraft(
      familyYaml(),
      familyYaml().replace("qualys_list_assets", "qualys_count_assets"),
    );

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "duplicate_tool_name",
        path: "$.tools.1.name",
      }),
    );
  });

  it("fails duplicate YAML keys in draft source-of-truth files", async () => {
    const baseSplit = splitLegacyFamilyFixture(familyYaml());
    const manifestValidator = await setupDraft(familyYaml(), familyYaml(), {
      draftFamilyYaml: `${familyYaml()}\nid: splunk\n`,
    });
    await expect(manifestValidator.validateDraft("draft_1")).resolves.toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({ code: "manifest_yaml_invalid", path: "$" }),
      ],
    });

    const toolsValidator = await setupDraft(familyYaml(), familyYaml(), {
      draftToolsYaml: `${baseSplit.toolsYaml}\nfamily:\n  id: splunk\n`,
    });
    await expect(toolsValidator.validateDraft("draft_1")).resolves.toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "tool_contract_yaml_invalid",
          path: "$",
        }),
      ],
    });

    const examplesValidator = await setupDraft(familyYaml(), familyYaml(), {
      examplesYaml: `
examples: []
examples: []
`,
    });
    await expect(examplesValidator.validateDraft("draft_1")).resolves.toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "examples_invalid",
          path: "$.examples",
        }),
      ],
    });
  });

  it("fails direct removal of an existing source tool", async () => {
    const validator = await setupDraft(
      familyYaml(),
      familyYaml().replace(
        /\n  - name: qualys_list_assets[\s\S]*?      examples:\n        - \{\}\n/,
        "\n",
      ),
    );

    await expect(validator.validateDraft("draft_1")).resolves.toMatchObject({
      ok: false,
      diagnostics: [
        expect.objectContaining({
          code: "breaking_tool_removal",
          path: "$.tools",
          message:
            "tool qualys_list_assets exists in source and cannot be removed directly",
        }),
      ],
    });
  });

  it("returns structured diagnostics for invalid runtime settings", async () => {
    const validator = await setupDraft(
      familyYaml(),
      familyYaml().replace("defaultTimeoutMs: 30000", "defaultTimeoutMs: 0"),
    );

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "manifest_invalid",
        path: "$.runtime.defaultTimeoutMs",
      }),
    );
  });

  it("warns for missing help quality while migration mode is non-blocking", async () => {
    const manifestWithoutHelp = familyYaml().replace(
      /\n    help:\n      summary: Count Qualys assets\.\n      examples:\n        - \{\}/,
      "",
    );
    const validator = await setupDraft(familyYaml(), manifestWithoutHelp);

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(true);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "help_example_missing",
        path: "$.tools.0.help.examples",
      }),
    );
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        code: "help_example_missing",
        path: "$.tools.0.help.examples",
      }),
    );
  });

  it("fails for missing help quality when blocking mode is enabled", async () => {
    const manifestWithoutHelp = familyYaml().replace(
      /\n    help:\n      summary: Count Qualys assets\.\n      examples:\n        - \{\}/,
      "",
    );
    const validator = await setupDraft(familyYaml(), manifestWithoutHelp, {
      helpQualityMode: "error",
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "help_example_missing",
        path: "$.tools.0.help.examples",
      }),
    );
  });

  it("requires full help for complex public parameters", async () => {
    const manifestWithFilterHelp = familyYaml()
      .replace(
        "properties: {}",
        "properties:\n        filter_body:\n          type: object",
      )
      .replace(
        "summary: Count Qualys assets.",
        "summary: Count Qualys assets.\n      parameters:\n        filter_body:\n          summary: Native Qualys filter body.",
      );
    const validator = await setupDraft(familyYaml(), manifestWithFilterHelp, {
      helpQualityMode: "error",
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "help_parameter_full_missing",
        path: "$.tools.0.help.parameters.filter_body.full",
      }),
    );
  });

  it("accepts a structured no-example justification for tools without examples", async () => {
    const manifestWithJustification = familyYaml().replace(
      "summary: Count Qualys assets.\n      examples:\n        - {}",
      "summary: Count Qualys assets.\n      noExampleJustification: Count-only tool has no extra meaningful payload example.",
    );
    const validator = await setupDraft(
      familyYaml(),
      manifestWithJustification,
      {
        helpQualityMode: "error",
      },
    );

    const result = await validator.validateDraft("draft_1");

    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: "help_example_missing",
        path: "$.tools.0.help.examples",
      }),
    );
  });

  it("does not let examples for another tool satisfy the target tool", async () => {
    const manifestWithoutCountExamples = familyYaml().replace(
      /\n      examples:\n        - \{\}/,
      "",
    );
    const validator = await setupDraft(
      familyYaml(),
      manifestWithoutCountExamples,
      {
        examplesYaml: `
examples:
  - id: list-smoke
    familyId: qualys
    toolName: qualys_list_assets
    category: smoke
    args: {}
`,
        helpQualityMode: "error",
      },
    );

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "help_example_missing",
        path: "$.tools.0.help.examples",
      }),
    );
  });

  it("reports unknown help parameter roots through help quality diagnostics", async () => {
    const manifestWithUnknownParameterHelp = familyYaml().replace(
      "summary: Count Qualys assets.",
      "summary: Count Qualys assets.\n      parameters:\n        made_up:\n          summary: Unknown parameter.",
    );
    const validator = await setupDraft(
      familyYaml(),
      manifestWithUnknownParameterHelp,
      { helpQualityMode: "error" },
    );

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "help_parameter_unknown",
        path: "$.tools.0.help.parameters.made_up",
      }),
    );
  });

  it("requires actionable error guidance in help quality diagnostics", async () => {
    const manifestWithoutErrors = familyYaml().replace(
      /    errors:\n      - bad_arguments means the request shape is unsupported; fix input before retrying\.\n/g,
      "",
    );
    const validator = await setupDraft(familyYaml(), manifestWithoutErrors, {
      helpQualityMode: "error",
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "help_errors_missing",
        path: "$.tools.0.openacme.errors",
      }),
    );
  });

  it("requires pagination guidance when public inputs expose pagination controls", async () => {
    const paginatedManifest = familyYaml().replace(
      "properties: {}",
      "properties:\n        page_size:\n          type: integer",
    );
    const validator = await setupDraft(familyYaml(), paginatedManifest, {
      helpQualityMode: "error",
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "help_pagination_missing",
        path: "$.tools.0.openacme.pagination",
      }),
    );
  });

  it("requires destructive tool help to mention approval or risk", async () => {
    const destructiveManifest = familyYaml().replace(
      "operation: read",
      "operation: destructive",
    );
    const validator = await setupDraft(familyYaml(), destructiveManifest, {
      helpQualityMode: "error",
    });

    const result = await validator.validateDraft("draft_1");

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        severity: "error",
        code: "destructive_help_risk_missing",
        path: "$.tools.0.help",
      }),
    );
  });
});
