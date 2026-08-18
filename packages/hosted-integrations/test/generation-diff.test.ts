import { describe, expect, it } from "vitest";
import {
  buildHostedIntegrationGenerationDiff,
  type HostedIntegrationGenerationDiffSnapshot,
} from "../src/index.js";
import { withSplitToolContractFiles } from "./test-support/split-contract-fixtures.js";

describe("hosted integration generation diff", () => {
  it("rejects generations from different families", async () => {
    const diff = await buildHostedIntegrationGenerationDiff({
      base: snapshot({ familyId: "qualys", generationId: "gen_base" }),
      compare: snapshot({ familyId: "splunk", generationId: "gen_compare" }),
      options: { mode: "summary" },
    });

    expect(diff).toEqual({
      ok: false,
      error: {
        code: "family_mismatch",
        message: "generation diff requires both generations to belong to the same family",
      },
    });
  });

  it("returns summary changes with stable file ordering and changed tool names", async () => {
    const diff = await buildHostedIntegrationGenerationDiff({
      base: snapshot({
        files: {
          "family.yaml": familyYaml({
            countDescription: "Count assets.",
            timeout: 30_000,
          }),
          "qualys.py": source({ countBody: "return {'count': 1}" }),
        },
      }),
      compare: snapshot({
        generationId: "gen_compare",
        files: {
          "family.yaml": familyYaml({
            countDescription: "Count filtered assets.",
            timeout: 45_000,
          }),
          "help/count.md": "Count help.\n",
          "qualys.py": source({ countBody: "return {'count': 2}" }),
        },
      }),
      options: { mode: "summary" },
    });

    expect(diff).toMatchObject({
      ok: true,
      diff: {
        familyId: "qualys",
        baseGenerationId: "gen_base",
        compareGenerationId: "gen_compare",
        mode: "summary",
        summary: {
          changedFiles: [
            { path: "family.yaml", changeType: "modified" },
            { path: "help/count.md", changeType: "added" },
            { path: "qualys.py", changeType: "modified" },
            { path: "tools.yaml", changeType: "modified" },
          ],
          changedTools: [
            {
              name: "qualys_count_assets",
              changeType: "modified",
              changedFields: ["description", "help"],
            },
          ],
          runtimeChanged: true,
          dependencyPolicyChanged: false,
        },
      },
    });
  });

  it("returns deterministic unified patches and redacts secret-like values", async () => {
    const diff = await buildHostedIntegrationGenerationDiff({
      base: snapshot({
        files: {
          "family.yaml": familyYaml({ countDescription: "Count assets." }),
          "qualys.py": "API_TOKEN = 'raw-token-old'\nprint(API_TOKEN)\n",
        },
      }),
      compare: snapshot({
        generationId: "gen_compare",
        files: {
          "family.yaml": familyYaml({ countDescription: "Count assets." }),
          "qualys.py": "API_TOKEN = 'raw-token-new'\nprint(API_TOKEN)\n",
        },
      }),
      options: { mode: "unified" },
    });

    expect(diff).toMatchObject({
      ok: true,
      diff: {
        mode: "unified",
        files: [
          {
            path: "qualys.py",
            changeType: "modified",
            unifiedPatch: expect.stringContaining("--- a/qualys.py"),
          },
        ],
      },
    });
    expect(JSON.stringify(diff)).not.toContain("raw-token-old");
    expect(JSON.stringify(diff)).not.toContain("raw-token-new");
    expect(JSON.stringify(diff)).toContain("[REDACTED]");
  });

  it("returns manifest-only tool contract changes", async () => {
    const diff = await buildHostedIntegrationGenerationDiff({
      base: snapshot({
        files: {
          "family.yaml": familyYaml({ countDescription: "Count assets." }),
          "qualys.py": source({ countBody: "return {'count': 1}" }),
        },
      }),
      compare: snapshot({
        generationId: "gen_compare",
        files: {
          "family.yaml": familyYaml({
            countDescription: "Count filtered assets.",
            includeHelp: true,
          }),
          "qualys.py": source({ countBody: "return {'count': 1}" }),
        },
      }),
      options: { mode: "manifest" },
    });

    expect(diff).toMatchObject({
      ok: true,
      diff: {
        mode: "manifest",
        manifest: {
          changedTools: [
            {
              name: "qualys_count_assets",
              changeType: "modified",
              changedFields: ["description", "help"],
            },
          ],
        },
      },
    });
  });

  it("returns a tool-focused manifest and deterministic handler diff", async () => {
    const diff = await buildHostedIntegrationGenerationDiff({
      base: snapshot({
        files: {
          "family.yaml": familyYaml({ countDescription: "Count assets." }),
          "qualys.py": source({ countBody: "return {'count': 1}" }),
        },
      }),
      compare: snapshot({
        generationId: "gen_compare",
        files: {
          "family.yaml": familyYaml({ countDescription: "Count assets." }),
          "qualys.py": source({ countBody: "return {'count': 2}" }),
        },
      }),
      options: {
        mode: "tool_focused",
        toolName: "qualys_count_assets",
        includeSharedHelpers: true,
      },
    });

    expect(diff).toMatchObject({
      ok: true,
      diff: {
        mode: "tool_focused",
        toolName: "qualys_count_assets",
        toolFocused: {
          base: {
            manifest: { tool: { name: "qualys_count_assets" } },
            source: {
              selectedHandler: {
                source: expect.stringContaining("return {'count': 1}"),
              },
            },
          },
          compare: {
            source: {
              selectedHandler: {
                source: expect.stringContaining("return {'count': 2}"),
              },
            },
          },
          handlerPatch: expect.stringContaining(
            "def tool_qualys_count_assets(args, context):",
          ),
        },
      },
    });
    expect(JSON.stringify(diff)).not.toContain("not-focused");
  });
});

function snapshot(
  overrides: Partial<HostedIntegrationGenerationDiffSnapshot> = {},
): HostedIntegrationGenerationDiffSnapshot {
  return {
    generationId: overrides.generationId ?? "gen_base",
    familyId: overrides.familyId ?? "qualys",
    files: withSplitToolContractFiles(
      overrides.files ??
      {
        "family.yaml": familyYaml({ countDescription: "Count assets." }),
        "qualys.py": source({ countBody: "return {'count': 1}" }),
      },
    ),
  };
}

function familyYaml(args: {
  countDescription: string;
  timeout?: number;
  includeHelp?: boolean;
}): string {
  return `
id: qualys
name: Qualys
version: 1
runtime:
  language: python
  entrypoint: qualys.py
  defaultTimeoutMs: ${args.timeout ?? 30000}
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
    description: ${args.countDescription}
    lifecycle: active
    inputSchema:
      type: object
      properties:
        filter_body:
          type: object
      additionalProperties: false
${args.includeHelp ? "    help:\n      summary: Count help.\n      noExampleJustification: Unit fixture.\n" : ""}
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
  - name: qualys_search_assets
    title: Search assets
    description: Search assets.
    lifecycle: active
    inputSchema:
      type: object
      additionalProperties: true
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
`;
}

function source(args: { countBody: string }): string {
  return [
    "def normalize(args):",
    "    return args",
    "",
    "def tool_qualys_count_assets(args, context):",
    `    ${args.countBody}`,
    "",
    "def tool_qualys_search_assets(args, context):",
    "    return {'items': ['not-focused']}",
    "",
  ].join("\n");
}
