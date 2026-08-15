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
    helpQualityMode?: "warning" | "error";
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
  await writeFile(path.join(sourceDir, "family.yaml"), sourceManifest, "utf-8");
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
    content: draftManifest,
  });
  if (options.examplesYaml) {
    await draftStore.writeDraftFile({
      draftId: "draft_1",
      lockId: "lock_1",
      path: "examples.yaml",
      content: options.examplesYaml,
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
        code: "manifest_invalid",
        path: "$.tools.0",
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
        code: "manifest_invalid",
        path: "$.tools.0.classification",
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
        code: "help_summary_missing",
        path: "$.tools.0.help.summary",
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
        code: "help_summary_missing",
        path: "$.tools.0.help.summary",
      }),
    );
  });

  it("requires full help for complex public parameters", async () => {
    const manifestWithFilterHelp = familyYaml()
      .replace("properties: {}", "properties:\n        filter_body:\n          type: object")
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
    const validator = await setupDraft(familyYaml(), manifestWithJustification, {
      helpQualityMode: "error",
    });

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
    const validator = await setupDraft(familyYaml(), manifestWithoutCountExamples, {
      examplesYaml: `
examples:
  - id: list-smoke
    familyId: qualys
    toolName: qualys_list_assets
    category: smoke
    args: {}
`,
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
