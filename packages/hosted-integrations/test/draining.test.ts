import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
  type HostedIntegrationRegistryRefreshEvent,
} from "../src/index.js";

let dataDir: string;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");
let generationCounter = 0;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-draining-"));
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
  generationCounter = 0;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function generationStore(
  events: HostedIntegrationRegistryRefreshEvent[] = [],
) {
  return createFileHostedIntegrationGenerationStore({
    dataDir,
    now: () => new Date(nowMs),
    createId: () => `gen_${++generationCounter}`,
    onRegistryRefresh: (event) => events.push(event),
  });
}

async function createDraft(): Promise<string> {
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
  const result = await createFileHostedIntegrationDraftStore({
    dataDir,
    lockStore,
    now: () => new Date(nowMs),
    createId: () => "draft_1",
  }).createDraftFromFiles({
    familyId: "qualys",
    lockId: "lock_1",
    sourceRevisionId: "source_rev_1",
    files: {
      "family.yaml": familyYaml(),
      "qualys.py": "def run():\n    return {'ok': True}\n",
    },
  });
  if (!result.ok) throw new Error(`draft creation failed: ${result.reason}`);
  return result.draft.id;
}

async function promoteNextGeneration(
  store: ReturnType<typeof generationStore>,
  draftId: string,
) {
  const promoted = await store.promoteDraft({
    draftId,
    promotedBy: "agent:tool-developer",
    validation: { ok: true, diagnostics: [] },
  });
  if (!promoted.ok) throw new Error(`promotion failed: ${promoted.reason}`);
  nowMs += 60_000;
  return promoted.generation;
}

describe("hosted integration request draining", () => {
  it("keeps a call started before promotion on the old generation", async () => {
    const draftId = await createDraft();
    const store = generationStore();
    await promoteNextGeneration(store, draftId);

    const lease = await store.beginInvocation({ familyId: "qualys" });
    await promoteNextGeneration(store, draftId);

    expect(lease).toMatchObject({
      ok: true,
      lease: { familyId: "qualys", generationId: "gen_1" },
    });
    await expect(store.getActiveGeneration("qualys")).resolves.toMatchObject({
      id: "gen_2",
    });
  });

  it("starts calls after promotion on the new active generation", async () => {
    const draftId = await createDraft();
    const store = generationStore();
    await promoteNextGeneration(store, draftId);
    await promoteNextGeneration(store, draftId);

    await expect(
      store.beginInvocation({ familyId: "qualys" }),
    ).resolves.toMatchObject({
      ok: true,
      lease: { generationId: "gen_2" },
    });
  });

  it("retires the old generation only after its inflight count reaches zero", async () => {
    const draftId = await createDraft();
    const store = generationStore();
    await promoteNextGeneration(store, draftId);
    const lease = await store.beginInvocation({ familyId: "qualys" });
    if (!lease.ok) throw new Error(`begin failed: ${lease.reason}`);

    await promoteNextGeneration(store, draftId);
    await expect(store.getGeneration("gen_1")).resolves.toMatchObject({
      status: "draining",
    });

    await store.completeInvocation({ leaseId: lease.lease.id });
    await expect(store.getGeneration("gen_1")).resolves.toMatchObject({
      status: "retired",
    });
  });

  it("emits a registry-refresh event when a generation changes", async () => {
    const draftId = await createDraft();
    const events: HostedIntegrationRegistryRefreshEvent[] = [];
    const store = generationStore(events);

    await promoteNextGeneration(store, draftId);

    expect(events).toEqual([
      {
        familyId: "qualys",
        generationId: "gen_1",
        reason: "promote",
        toolNames: ["qualys_tool"],
      },
    ]);
  });
});

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
  maxConcurrency: 1
  runtimePolicy:
    filesystem: run_dir_only
    processEnv: tool_context_only
    subprocess: denied
    network: denied
  dependencyPolicy:
    installDuringInvocation: false
tools:
  - name: qualys_tool
    title: Qualys tool
    description: Qualys tool.
    inputSchema:
      type: object
      properties: {}
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
`;
}
