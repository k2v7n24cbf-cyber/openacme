import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@openacme/config";
import {
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
} from "@openacme/hosted-integrations";
import { createApp } from "../src/app.js";

let dataDir: string | null = null;
let closeApp: (() => Promise<void>) | null = null;

afterEach(async () => {
  await closeApp?.();
  closeApp = null;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
});

describe("/api/tools hosted integration surfacing", () => {
  it("syncs active hosted integration generations at startup", async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), "openacme-tools-hosted-"));
    writeFamily(dataDir);
    const locks = createFileHostedIntegrationLockStore({
      dataDir,
      createId: () => "lock_1",
    });
    await locks.acquireLock({
      familyId: "qualys",
      lockedBy: "agent:tool-developer",
      ttlMs: 60_000,
    });
    const drafts = createFileHostedIntegrationDraftStore({
      dataDir,
      lockStore: locks,
      createId: () => "draft_1",
    });
    const draft = await drafts.createDraft({
      familyId: "qualys",
      lockId: "lock_1",
      sourceRevisionId: "source_rev_1",
    });
    expect(draft.ok).toBe(true);
    const promoted = await createFileHostedIntegrationGenerationStore({
      dataDir,
      draftStore: drafts,
      createId: () => "gen_1",
    }).promoteDraft({
      draftId: "draft_1",
      promotedBy: "agent:tool-developer",
      validation: { ok: true, diagnostics: [] },
    });
    expect(promoted.ok).toBe(true);

    const config = ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    const { app, manager, close } = await createApp(config);
    closeApp = close;
    const member = manager.authStore.createMember({
      email: "test@example.com",
      password: "test-password-123",
    });
    const authToken = manager.authStore.createSession(member.id).token;

    const res = await app.request("http://127.0.0.1/api/tools", {
      headers: { host: "127.0.0.1", authorization: `Bearer ${authToken}` },
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      toolsets: string[];
      tools: Array<{ name: string }>;
    };
    expect(body.toolsets).toContain("hosted-integrations");
    expect(
      body.tools.find((tool) => tool.name === "qualys_count_assets"),
    ).toMatchObject({
      name: "qualys_count_assets",
      toolset: "hosted-integrations",
      source: {
        kind: "hosted_integration",
        familyId: "qualys",
        familyName: "Qualys",
        generationId: "gen_1",
      },
    });
  });
});

function writeFamily(root: string): void {
  const dir = path.join(
    root,
    "hosted-integrations",
    "source",
    "families",
    "qualys",
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "family.yaml"), familyYaml());
  writeFileSync(
    path.join(dir, "qualys.py"),
    "def call_tool(name, args, ctx):\n    return {'count': 1}\n",
  );
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
    network: denied
  dependencyPolicy:
    installDuringInvocation: false
    allowedPackages: []
tools:
  - name: qualys_count_assets
    title: Count assets
    description: Count Qualys assets.
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
`;
}
