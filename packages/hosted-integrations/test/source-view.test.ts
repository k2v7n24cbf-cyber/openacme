import { describe, expect, it } from "vitest";
import {
  FamilyManifestSchema,
  buildHostedIntegrationFocusedSourceView,
  type FamilyManifest,
} from "../src/index.js";

describe("hosted integration focused source view", () => {
  it("returns the selected handler and collapses unrelated tool handlers by default", async () => {
    const view = await buildHostedIntegrationFocusedSourceView({
      familyId: "qualys",
      generationId: "gen_1",
      manifest: manifestFixture(),
      entrypointPath: "qualys.py",
      source: sourceFixture(),
      toolName: "qualys_cloud_agent_hostasset_count",
      options: {},
    });

    expect(view).toMatchObject({
      familyId: "qualys",
      generationId: "gen_1",
      toolName: "qualys_cloud_agent_hostasset_count",
      entrypointPath: "qualys.py",
      mode: "focused",
      manifest: {
        tool: {
          name: "qualys_cloud_agent_hostasset_count",
          inputSchema: {
            properties: {
              filter_body: { type: "object" },
            },
          },
          help: {
            summary: "Count host assets with native Qualys CA filters.",
          },
          classification: {
            operation: "read",
          },
        },
      },
    });
    expect(view.source.selectedHandler?.name).toBe(
      "tool_qualys_cloud_agent_hostasset_count",
    );
    expect(view.source.selectedHandler?.source).toContain(
      "def tool_qualys_cloud_agent_hostasset_count(args, context):",
    );
    expect(view.source.selectedHandler?.source).toContain("normalize_filter");
    expect(view.source.selectedHandler?.source).not.toContain("not-focused");
    expect(view.source.helpers).toEqual([]);
    expect(view.source.hooks).toEqual([]);
    expect(view.source.collapsedToolHandlers).toEqual([
      expect.objectContaining({
        toolName: "qualys_cloud_agent_hostasset_search",
        functionName: "tool_qualys_cloud_agent_hostasset_search",
      }),
    ]);
    expect(view.source.collapsedToolHandlers[0]?.source).not.toContain(
      "not-focused",
    );
  });

  it("includes shared helpers from the selected handler and requested hooks in stable source order", async () => {
    const view = await buildHostedIntegrationFocusedSourceView({
      familyId: "qualys",
      generationId: "gen_1",
      manifest: manifestFixture(),
      entrypointPath: "qualys.py",
      source: sourceFixture(),
      toolName: "qualys_cloud_agent_hostasset_count",
      options: {
        includeHooks: true,
        includeSharedHelpers: true,
        helperDepthLimit: 2,
      },
    });

    expect(view.source.hooks.map((hook) => hook.name)).toEqual([
      "authenticate",
      "before_tool_call",
      "after_tool_call",
    ]);
    expect(view.source.helpers.map((helper) => helper.name)).toEqual([
      "build_auth",
      "normalize_filter",
      "shared_client",
    ]);
    expect(view.source.helpers.map((helper) => helper.includedBecause)).toEqual(
      [
        "referenced_by_hook",
        "referenced_by_selected_handler",
        "referenced_by_selected_handler",
      ],
    );
    expect(
      view.source.helpers.some((helper) => helper.name === "unrelated_helper"),
    ).toBe(false);
    expect(view.diagnostics).not.toContainEqual(
      expect.objectContaining({
        code: "unresolved_helper_reference",
        reference: "LocalClient",
      }),
    );
    expect(view.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unresolved_helper_reference",
          functionName: "tool_qualys_cloud_agent_hostasset_count",
          reference: "missing_helper",
        }),
      ]),
    );
  });

  it("reports deterministic truncation metadata when source-view limits are reached", async () => {
    const view = await buildHostedIntegrationFocusedSourceView({
      familyId: "qualys",
      generationId: "gen_1",
      manifest: manifestFixture(),
      entrypointPath: "qualys.py",
      source: sourceFixture(),
      toolName: "qualys_cloud_agent_hostasset_count",
      options: {
        includeSharedHelpers: true,
        maxSourceChars: 190,
      },
    });

    expect(view.limits.truncated).toBe(true);
    expect(view.limits.maxSourceChars).toBe(190);
    expect(view.source.selectedHandler?.truncated).toBe(false);
    expect(view.source.helpers.length).toBeLessThan(2);
    expect(view.diagnostics).toContainEqual(
      expect.objectContaining({
        code: "source_view_truncated",
      }),
    );
  });

  it("returns full family source only when explicitly requested", async () => {
    const view = await buildHostedIntegrationFocusedSourceView({
      familyId: "qualys",
      generationId: "gen_1",
      manifest: manifestFixture(),
      entrypointPath: "qualys.py",
      source: sourceFixture(),
      toolName: "qualys_cloud_agent_hostasset_count",
      options: {
        includeAllTools: true,
      },
    });

    expect(view.mode).toBe("full_family");
    expect(view.source.fullSource).toContain("not-focused");
    expect(view.source.selectedHandler).toBeUndefined();
    expect(view.source.collapsedToolHandlers).toEqual([]);
  });
});

function manifestFixture(): FamilyManifest {
  return FamilyManifestSchema.parse({
    id: "qualys",
    name: "Qualys",
    version: 1,
    runtime: {
      language: "python",
      entrypoint: "qualys.py",
      defaultTimeoutMs: 30_000,
      inlineResultTokenLimit: 8_000,
      maxConcurrency: 2,
      runtimePolicy: {
        filesystem: "run_dir_and_family_home",
        processEnv: "tool_context_only",
        subprocess: "denied",
        network: "declared_egress",
      },
      dependencyPolicy: {
        installDuringInvocation: false,
        allowedPackages: [],
      },
    },
    tools: [
      {
        name: "qualys_cloud_agent_hostasset_count",
        title: "Qualys Cloud Agent HostAsset Count",
        description: "Count Cloud Agent HostAsset records.",
        lifecycle: "active",
        inputSchema: {
          type: "object",
          properties: {
            filter_body: { type: "object" },
          },
          additionalProperties: false,
        },
        help: {
          summary: "Count host assets with native Qualys CA filters.",
          full: "help/hostasset-count.md",
          parameters: {
            filter_body: {
              summary: "Native Qualys CA filter body.",
              full: "help/ca-filter-body.md",
            },
          },
          noExampleJustification: "Unit fixture.",
        },
        classification: {
          operation: "read",
          freshness: "live",
          idempotency: "idempotent",
          execution: "sync",
          approval: "none",
        },
      },
      {
        name: "qualys_cloud_agent_hostasset_search",
        title: "Qualys Cloud Agent HostAsset Search",
        description: "Search Cloud Agent HostAsset records.",
        lifecycle: "active",
        inputSchema: { type: "object", additionalProperties: true },
        help: {
          summary: "Search host assets.",
          noExampleJustification: "Unit fixture.",
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
  });
}

function sourceFixture(): string {
  return [
    "import requests",
    "",
    "def build_auth(context):",
    "    return {'token': context['secrets'].get('token')}",
    "",
    "def normalize_filter(args):",
    "    return dict(args.get('filter_body') or {})",
    "",
    "def shared_client(auth):",
    "    return {'auth': auth}",
    "",
    "class LocalClient:",
    "    pass",
    "",
    "def unrelated_helper():",
    "    return 'not-focused'",
    "",
    "def authenticate(context):",
    "    return build_auth(context)",
    "",
    "def before_tool_call(tool_name, args, context, auth):",
    "    if tool_name.endswith('_count'):",
    "        return {'filter_body': normalize_filter(args)}",
    "    return args",
    "",
    "def after_tool_call(tool_name, args, context, result, auth):",
    "    result['tool'] = tool_name",
    "    return result",
    "",
    "def tool_qualys_cloud_agent_hostasset_count(args, context):",
    "    filter_body = normalize_filter(args)",
    "    client = shared_client(context['auth'])",
    "    local_client = LocalClient()",
    "    missing_helper(args)",
    "    globals()[args.get('helper', 'normalize_filter')](args)",
    "    return {'count': 1, 'filter_body': filter_body, 'client': client, 'local_client': local_client}",
    "",
    "def tool_qualys_cloud_agent_hostasset_search(args, context):",
    "    return {'items': [unrelated_helper()]}",
    "",
  ].join("\n");
}
