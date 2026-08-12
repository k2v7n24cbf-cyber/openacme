import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationCatalog,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationDraftValidator,
  createFileHostedIntegrationProposedFamilyManager,
} from "../src/index.js";

let dataDir: string;
const now = new Date("2026-08-12T10:00:00.000Z");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-proposed-"));
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

async function writeSourceFamily(familyId: string): Promise<void> {
  const dir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    familyId,
  );
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "family.yaml"),
    `
id: ${familyId}
name: Existing
version: 1
runtime:
  language: python
  entrypoint: ${familyId}.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 1
  runtimePolicy:
    filesystem: run_dir_only
    processEnv: tool_context_only
    subprocess: denied
    network: denied
  dependencyPolicy:
    installDuringInvocation: false
tools:
  - name: ${familyId}_tool
    title: Existing tool
    description: Existing tool.
    inputSchema:
      type: object
      properties: {}
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
`,
    "utf-8",
  );
}

function manager() {
  return createFileHostedIntegrationProposedFamilyManager({
    dataDir,
    now: () => now,
    createLockId: () => "lock_1",
    createDraftId: () => "draft_1",
  });
}

describe("hosted integration proposed family manager", () => {
  it("creates a proposed family lock and draft from a minimal template", async () => {
    const result = await manager().createProposedFamily({
      familyId: "github",
      name: "GitHub",
      toolName: "github_search",
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    });

    expect(result).toEqual({
      ok: true,
      family: {
        id: "github",
        name: "GitHub",
        version: 1,
        toolNames: ["github_search"],
        status: "proposed",
        draftId: "draft_1",
        lockId: "lock_1",
        sourceRevisionId: "proposed_initial",
      },
      lock: expect.objectContaining({
        id: "lock_1",
        familyId: "github",
        lockedBy: "agent:tool-developer",
      }),
      draft: expect.objectContaining({
        id: "draft_1",
        familyId: "github",
        lockId: "lock_1",
        sourceRevisionId: "proposed_initial",
      }),
      sourceRevisionId: "proposed_initial",
    });

    await expect(createFileHostedIntegrationCatalog({ dataDir }).listFamilies())
      .resolves.toEqual([]);
    await expect(manager().listProposedFamilies()).resolves.toEqual([
      expect.objectContaining({
        id: "github",
        status: "proposed",
        toolNames: ["github_search"],
      }),
    ]);

    const draftStore = createFileHostedIntegrationDraftStore({ dataDir });
    await expect(
      draftStore.readDraftFile({ draftId: "draft_1", path: "family.yaml" }),
    ).resolves.toMatchObject({
      ok: true,
      content: expect.stringContaining("name: github_search"),
    });
    await expect(
      createFileHostedIntegrationDraftValidator({
        draftStore,
        catalog: createFileHostedIntegrationCatalog({ dataDir }),
      }).validateDraft("draft_1"),
    ).resolves.toEqual({ ok: true, diagnostics: [] });
  });

  it("rejects duplicate proposed or active family ids", async () => {
    await expect(
      manager().createProposedFamily({
        familyId: "github",
        name: "GitHub",
        toolName: "github_search",
        lockedBy: "agent:tool-developer",
        ttlMs: 60_000,
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      manager().createProposedFamily({
        familyId: "github",
        name: "GitHub again",
        toolName: "github_other",
        lockedBy: "agent:tool-developer",
        ttlMs: 60_000,
      }),
    ).resolves.toEqual({ ok: false, reason: "duplicate_family" });

    await writeSourceFamily("splunk");
    await expect(
      manager().createProposedFamily({
        familyId: "splunk",
        name: "Splunk",
        toolName: "splunk_search",
        lockedBy: "agent:tool-developer",
        ttlMs: 60_000,
      }),
    ).resolves.toEqual({ ok: false, reason: "duplicate_family" });
  });
});
