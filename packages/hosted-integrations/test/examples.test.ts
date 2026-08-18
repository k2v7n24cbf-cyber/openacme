import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationExampleRegistry,
  createFileHostedIntegrationLockStore,
} from "../src/index.js";
import { writeSplitFamilyFixture } from "./test-support/split-contract-fixtures.js";

let dataDir: string;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-examples-"));
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function setupDraft(manifestYaml = familyYaml()): Promise<{
  registry: ReturnType<typeof createFileHostedIntegrationExampleRegistry>;
}> {
  const sourceDir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    "qualys",
  );
  await writeSplitFamilyFixture(sourceDir, manifestYaml);
  await writeFile(
    path.join(sourceDir, "examples.yaml"),
    `
examples:
  - id: smoke_count
    familyId: qualys
    toolName: qualys_count_assets
    category: smoke
    args:
      query: "status:active"
    expected:
      count: 12
`,
    "utf-8",
  );

  const lockStore = createFileHostedIntegrationLockStore({
    dataDir,
    now: () => new Date(nowMs),
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
    now: () => new Date(nowMs),
    createId: () => "draft_1",
  });
  await draftStore.createDraft({
    familyId: "qualys",
    lockId: "lock_1",
    sourceRevisionId: "source_rev_1",
  });
  return {
    registry: createFileHostedIntegrationExampleRegistry({ draftStore }),
  };
}

function familyYaml(operation = "read"): string {
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
      required: [query]
      properties:
        query:
          type: string
      additionalProperties: false
    classification:
      operation: ${operation}
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
`;
}

describe("hosted integration examples registry", () => {
  it("parses valid examples.yaml into stable examples", async () => {
    const { registry } = await setupDraft();

    await expect(registry.listExamples("draft_1")).resolves.toEqual([
      {
        id: "smoke_count",
        familyId: "qualys",
        toolName: "qualys_count_assets",
        category: "smoke",
        args: { query: "status:active" },
        expected: { count: 12 },
      },
    ]);
  });

  it("adds and updates examples in a draft with the active lock", async () => {
    const { registry } = await setupDraft();

    await expect(
      registry.upsertExample({
        draftId: "draft_1",
        lockId: "lock_1",
        example: {
          id: "live_count",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          category: "live_safe",
          args: { query: "severity:high" },
          expected: { count: 3 },
        },
      }),
    ).resolves.toEqual({ ok: true });
    await expect(
      registry.upsertExample({
        draftId: "draft_1",
        lockId: "lock_1",
        example: {
          id: "live_count",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          category: "regression",
          args: { query: "severity:critical" },
        },
      }),
    ).resolves.toEqual({ ok: true });

    await expect(registry.listExamples("draft_1")).resolves.toMatchObject([
      { id: "smoke_count" },
      {
        id: "live_count",
        category: "regression",
        args: { query: "severity:critical" },
      },
    ]);
  });

  it("rejects invalid example args against the draft manifest tool schema", async () => {
    const { registry } = await setupDraft();

    await expect(
      registry.upsertExample({
        draftId: "draft_1",
        lockId: "lock_1",
        example: {
          id: "bad_args",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          category: "smoke",
          args: { count: 1 },
        },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid_args",
      message: "$.query is required",
    });
  });

  it("allows discovery-required examples to document a prerequisite lookup instead of a ready-to-send call", async () => {
    const { registry } = await setupDraft();

    await expect(
      registry.upsertExample({
        draftId: "draft_1",
        lockId: "lock_1",
        example: {
          id: "discover_before_count",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          category: "discovery_required",
          args: {},
          expected: {
            discovery_tool: "qualys_search_assets",
            requires_discovered_asset_id: true,
            not_ready_to_send: true,
          },
        },
      }),
    ).resolves.toEqual({ ok: true });

    await expect(registry.listExamples("draft_1")).resolves.toContainEqual(
      expect.objectContaining({
        id: "discover_before_count",
        category: "discovery_required",
        args: {},
        expected: {
          discovery_tool: "qualys_search_assets",
          requires_discovered_asset_id: true,
          not_ready_to_send: true,
        },
      }),
    );
  });

  it("rejects discovery-required examples without discovery metadata", async () => {
    const { registry } = await setupDraft();

    await expect(
      registry.upsertExample({
        draftId: "draft_1",
        lockId: "lock_1",
        example: {
          id: "ambiguous_discovery",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          category: "discovery_required",
          args: {},
          expected: {
            not_ready_to_send: true,
          },
        },
      }),
    ).rejects.toThrow(/expected\.discovery_tool/);
  });

  it("requires destructive examples to be classified for human review", async () => {
    const { registry } = await setupDraft(familyYaml("destructive"));

    await expect(
      registry.upsertExample({
        draftId: "draft_1",
        lockId: "lock_1",
        example: {
          id: "delete_asset",
          familyId: "qualys",
          toolName: "qualys_count_assets",
          category: "smoke",
          args: { query: "asset:legacy" },
        },
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "destructive_example_requires_human",
    });
  });
});
