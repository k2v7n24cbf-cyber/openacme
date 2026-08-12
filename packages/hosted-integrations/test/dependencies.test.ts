import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  FamilyManifestSchema,
  HostedIntegrationRuntimeSettingsSchema,
  createFileHostedIntegrationCatalog,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationDraftValidator,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
} from "../src/index.js";

let dataDir: string;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");
let generationCounter = 0;

beforeEach(async () => {
  dataDir = await mkdtemp(
    path.join(tmpdir(), "openacme-hosted-dependencies-"),
  );
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
  generationCounter = 0;
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

describe("hosted integration Python dependency policy", () => {
  it("defaults families with no dependencies to an empty dependency set", () => {
    const manifest = FamilyManifestSchema.parse(parseYaml(familyYaml()));

    expect(manifest.runtime.dependencies).toEqual([]);
  });

  it("validates a family with allowed dependencies", async () => {
    const { draftId, validator } = await createDraftWithManifest(
      familyYaml({
        dependencies: [{ name: "httpx", version: "0.28.1" }],
        allowedPackages: ["httpx"],
      }),
    );

    await expect(validator.validateDraft(draftId)).resolves.toEqual({
      ok: true,
      diagnostics: [],
    });
  });

  it("records pinned dependency metadata in promoted generation metadata", async () => {
    const { draftId } = await createDraftWithManifest(
      familyYaml({
        dependencies: [{ name: "HTTPX", version: "0.28.1" }],
        allowedPackages: ["httpx"],
      }),
    );

    await expect(generationStore().promoteDraft(validPromotion(draftId)))
      .resolves.toMatchObject({
        ok: true,
        generation: {
          dependencyResolution: {
            language: "python",
            installDuringInvocation: false,
            dependencies: [
              {
                name: "HTTPX",
                normalizedName: "httpx",
                version: "0.28.1",
                requirement: "httpx==0.28.1",
              },
            ],
            digest: expect.stringMatching(/^sha256:/),
          },
          provenance: {
            dependencyResolution: {
              digest: expect.stringMatching(/^sha256:/),
            },
          },
        },
      });
  });

  it("makes dependency changes visible in promotion provenance", async () => {
    const { draftId, draftStore } = await createDraftWithManifest(
      familyYaml({
        dependencies: [{ name: "httpx", version: "0.28.1" }],
        allowedPackages: ["httpx", "requests"],
      }),
    );
    const store = generationStore();
    const first = await store.promoteDraft(validPromotion(draftId));
    if (!first.ok) throw new Error(first.reason);

    const write = await draftStore.writeDraftFile({
      draftId,
      lockId: "lock_1",
      path: "family.yaml",
      content: familyYaml({
        dependencies: [{ name: "requests", version: "2.32.4" }],
        allowedPackages: ["httpx", "requests"],
      }),
    });
    if (!write.ok) throw new Error(write.reason);
    nowMs += 60_000;
    const second = await store.promoteDraft(validPromotion(draftId));
    if (!second.ok) throw new Error(second.reason);

    expect(first.generation.provenance?.dependencyResolution?.digest).not.toBe(
      second.generation.provenance?.dependencyResolution?.digest,
    );
  });

  it("rejects dependency installation during runtime invocation", () => {
    expect(
      HostedIntegrationRuntimeSettingsSchema.safeParse({
        ...FamilyManifestSchema.parse(parseYaml(familyYaml())).runtime,
        dependencyPolicy: {
          installDuringInvocation: true,
          allowedPackages: ["httpx"],
        },
      }).success,
    ).toBe(false);
  });
});

function generationStore() {
  return createFileHostedIntegrationGenerationStore({
    dataDir,
    now: () => new Date(nowMs),
    createId: () => `gen_${++generationCounter}`,
  });
}

async function createDraftWithManifest(manifest: string) {
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
  const created = await draftStore.createDraftFromFiles({
    familyId: "qualys",
    lockId: "lock_1",
    sourceRevisionId: "source_rev_1",
    files: {
      "family.yaml": manifest,
      "qualys.py": "def run(): pass\n",
    },
  });
  if (!created.ok) throw new Error(created.reason);
  return {
    draftId: created.draft.id,
    draftStore,
    validator: createFileHostedIntegrationDraftValidator({
      draftStore,
      catalog: createFileHostedIntegrationCatalog({ dataDir }),
    }),
  };
}

function validPromotion(draftId: string) {
  return {
    draftId,
    promotedBy: "agent:tool-developer",
    validation: { ok: true, diagnostics: [] },
  };
}

function familyYaml(options?: {
  dependencies?: Array<{ name: string; version: string }>;
  allowedPackages?: string[];
}): string {
  const dependencies =
    options?.dependencies && options.dependencies.length > 0
      ? `\n  dependencies:\n${options.dependencies
          .map(
            (dependency) =>
              `    - name: ${dependency.name}\n      version: "${dependency.version}"`,
          )
          .join("\n")}`
      : "";
  const allowedPackages = options?.allowedPackages ?? [];
  return `
id: qualys
name: Qualys
version: 1
runtime:
  language: python
  entrypoint: qualys.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 1${dependencies}
  runtimePolicy:
    filesystem: run_dir_only
    processEnv: tool_context_only
    subprocess: denied
    network: denied
  dependencyPolicy:
    installDuringInvocation: false
    allowedPackages:${formatYamlStringList(allowedPackages)}
tools:
  - name: qualys_count_assets
    title: Count assets
    description: Count assets matching a safe query.
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

function formatYamlStringList(values: string[]): string {
  if (values.length === 0) return " []";
  return `\n${values.map((value) => `      - ${value}`).join("\n")}`;
}
