import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../../config/src/schema.js";
import { createDatabase } from "../../db/src/connection.js";
import {
  HOSTED_FAMILY_PACKAGE_KIND,
  HOSTED_FAMILY_PACKAGE_VERSION,
  buildHostedFamilyPackageDigest,
  createDbHostedIntegrationService,
  createFileHostedIntegrationService,
  validateHostedFamilyPackage,
  type HostedFamilyPackageDocument,
} from "../src/index.js";
import {
  LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY,
  LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_TOOL_NAMES,
} from "../test-support/integration-hub/fixtures.js";

describe("hosted family package validation", () => {
  it("keeps hosted test-support typecheck in the package type gate", async () => {
    const packageJson = JSON.parse(
      await readFile(path.resolve(process.cwd(), "package.json"), "utf-8"),
    ) as { scripts?: Record<string, string> };
    const testSupportTsconfig = JSON.parse(
      await readFile(
        path.resolve(process.cwd(), "tsconfig.test-support.json"),
        "utf-8",
      ),
    ) as { include?: string[] };

    expect(packageJson.scripts?.["check-types"]).toContain(
      "pnpm run check-types:test-support",
    );
    expect(packageJson.scripts?.["check-types:test-support"]).toBe(
      "tsc --noEmit -p tsconfig.test-support.json",
    );
    expect(testSupportTsconfig.include).toEqual(
      expect.arrayContaining([
        "test-support/**/*.ts",
        "test/test-support/**/*.ts",
      ]),
    );
  });

  it("accepts a valid split hosted family package", async () => {
    const result = await validateHostedFamilyPackage(validPackage());

    expect(result.diagnostics).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.package?.fileEntries.map((file) => file.path)).toEqual([
      "examples.yaml",
      "family.yaml",
      "help/count.md",
      "provider/qualys-vmdr.yaml",
      "qualys.py",
      "tools.yaml",
    ]);
    expect(result.package?.digest).toMatch(/^sha256:/);
  });

  it("fails when required files are missing", async () => {
    const result = await validateHostedFamilyPackage({
      ...validPackage(),
      files: [{ path: "family.yaml", content: familyYaml() }],
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "package_required_file_missing",
          path: "$.files.tools.yaml",
        }),
      ]),
    );
  });

  it("fails a target family mismatch before any import draft can be created", async () => {
    const result = await validateHostedFamilyPackage(validPackage(), {
      targetFamilyId: "splunk",
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "package_target_family_mismatch",
          path: "$.targetFamilyId",
        }),
      ]),
    );
  });

  it("fails old manifest tool ownership", async () => {
    const result = await validateHostedFamilyPackage({
      ...validPackage(),
      files: validPackage().files.map((file) =>
        file.path === "family.yaml"
          ? {
              ...file,
              content: `${familyYaml()}\ntools: []\n`,
            }
          : file,
      ),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "package_manifest_invalid" }),
      ]),
    );
  });

  it("fails invalid paths, duplicate normalized paths, oversized files, and binary content", async () => {
    const result = await validateHostedFamilyPackage(
      {
        ...validPackage(),
        files: [
          ...validPackage().files,
          { path: "../secret.txt", content: "secret" },
          { path: "/absolute.txt", content: "absolute" },
          { path: "help//count.md", content: "duplicate" },
          { path: ".env", content: "QUALYS_PASSWORD=value" },
          { path: "logs/invocation.json", content: "{}" },
          { path: "runs/run-1/output.json", content: "{}" },
          { path: "failure-buckets/bucket-1.json", content: "{}" },
          { path: "workspace/cache.json", content: "{}" },
          { path: "binary.txt", content: "bad\u0000content" },
          { path: "large.txt", content: "x".repeat(12) },
        ],
      },
      { maxFileBytes: 8 },
    );

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "package_file_path_invalid" }),
        expect.objectContaining({ code: "package_file_duplicate" }),
        expect.objectContaining({ code: "package_file_path_hidden" }),
        expect.objectContaining({ code: "package_file_path_operational" }),
        expect.objectContaining({ code: "package_file_binary" }),
        expect.objectContaining({ code: "package_file_too_large" }),
      ]),
    );
  });

  it("fails package total byte limit", async () => {
    const result = await validateHostedFamilyPackage(validPackage(), {
      maxTotalBytes: 10,
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "package_too_large", path: "$.files" }),
      ]),
    );
  });

  it("fails package files that contain raw secret-shaped content", async () => {
    const result = await validateHostedFamilyPackage({
      ...validPackage(),
      files: validPackage().files.map((file) =>
        file.path === "qualys.py"
          ? {
              ...file,
              content:
                pythonSource() +
                "\n# leaked token should block package export/import\n" +
                "API_TOKEN = 'raw-token-export-leak'\n" +
                "AUTH_HEADER = 'Bearer sk-live-secret-token'\n",
            }
          : file,
      ),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "package_file_secret",
          path: "$.files.2.content",
        }),
      ]),
    );
    expect(JSON.stringify(result)).not.toContain("raw-token-export-leak");
    expect(JSON.stringify(result)).not.toContain("sk-live-secret-token");
  });

  it("fails malformed YAML", async () => {
    const toolResult = await validateHostedFamilyPackage({
      ...validPackage(),
      files: validPackage().files.map((file) =>
        file.path === "tools.yaml"
          ? { ...file, content: "kind: [unterminated" }
          : file,
      ),
    });
    const examplesResult = await validateHostedFamilyPackage({
      ...validPackage(),
      files: validPackage().files.map((file) =>
        file.path === "examples.yaml"
          ? { ...file, content: "examples: [unterminated" }
          : file,
      ),
    });

    expect(toolResult.ok).toBe(false);
    expect(toolResult.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "package_tool_contract_yaml_invalid" }),
      ]),
    );
    expect(examplesResult.ok).toBe(false);
    expect(examplesResult.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "package_examples_yaml_invalid" }),
      ]),
    );
  });

  it("fails duplicate YAML keys in source-of-truth files", async () => {
    const familyDuplicate = await validateHostedFamilyPackage({
      ...validPackage(),
      files: validPackage().files.map((file) =>
        file.path === "family.yaml"
          ? { ...file, content: `${familyYaml()}\nid: splunk\n` }
          : file,
      ),
    });
    const toolsDuplicate = await validateHostedFamilyPackage({
      ...validPackage(),
      files: validPackage().files.map((file) =>
        file.path === "tools.yaml"
          ? { ...file, content: `${toolsYaml()}\nfamily:\n  id: splunk\n` }
          : file,
      ),
    });
    const examplesDuplicate = await validateHostedFamilyPackage({
      ...validPackage(),
      files: validPackage().files.map((file) =>
        file.path === "examples.yaml"
          ? { ...file, content: `${examplesYaml()}\nexamples: []\n` }
          : file,
      ),
    });

    expect(familyDuplicate.ok).toBe(false);
    expect(familyDuplicate.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "package_manifest_yaml_invalid",
          path: "$.files.family.yaml",
        }),
      ]),
    );
    expect(toolsDuplicate.ok).toBe(false);
    expect(toolsDuplicate.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "package_tool_contract_yaml_invalid",
          path: "$.files.tools.yaml",
        }),
      ]),
    );
    expect(examplesDuplicate.ok).toBe(false);
    expect(examplesDuplicate.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "package_examples_yaml_invalid",
          path: "$.files.examples.yaml",
        }),
      ]),
    );
  });

  it("fails missing required MCP output schema", async () => {
    const toolContract = contractDocument();
    delete (toolContract.tools[0] as any).mcp.outputSchema;
    const result = await validateHostedFamilyPackage({
      ...validPackage(),
      files: validPackage().files.map((file) =>
        file.path === "tools.yaml"
          ? { ...file, content: stringifyYaml(toolContract) }
          : file,
      ),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "package_tool_contract_invalid" }),
      ]),
    );
  });

  it("fails unsupported custom root fields under mcp", async () => {
    const toolContract = contractDocument();
    (toolContract.tools[0] as any).mcp.providerInternal = true;
    const result = await validateHostedFamilyPackage({
      ...validPackage(),
      files: validPackage().files.map((file) =>
        file.path === "tools.yaml"
          ? { ...file, content: stringifyYaml(toolContract) }
          : file,
      ),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "package_tool_contract_invalid" }),
      ]),
    );
  });

  it("fails unresolved provider refs and help refs inside the imported package", async () => {
    const packageDoc = validPackage({
      includeProviderFile: false,
      includeHelpFile: false,
    });

    const result = await validateHostedFamilyPackage(packageDoc);

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "provider_ref_missing" }),
        expect.objectContaining({ code: "help_file_missing" }),
      ]),
    );
  });

  it("fails unresolved vocabulary refs inside the imported package", async () => {
    const toolContract = contractDocument();
    toolContract.tools[0].openacme.parameterHelp.query.vocabularyRef =
      "references/missing-fields.yaml";

    const result = await validateHostedFamilyPackage({
      ...validPackage(),
      files: validPackage().files.map((file) =>
        file.path === "tools.yaml"
          ? { ...file, content: stringifyYaml(toolContract) }
          : file,
      ),
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "vocabulary_ref_missing" }),
      ]),
    );
  });

  it("builds deterministic digests for equivalent normalized file bundles", () => {
    const digestA = buildHostedFamilyPackageDigest({
      "tools.yaml": toolsYaml(),
      "family.yaml": familyYaml(),
      "qualys.py": pythonSource(),
    });
    const digestB = buildHostedFamilyPackageDigest({
      "qualys.py": pythonSource(),
      "nested/../tools.yaml": toolsYaml(),
      "family.yaml": familyYaml(),
    });

    expect(digestA).toBe(digestB);
  });

  it("imports a create-mode package as a package-backed proposed family without scaffold files", async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "openacme-hosted-package-import-"),
    );
    try {
      const service = createFileHostedIntegrationService({
        dataDir,
        now: () => new Date("2026-08-17T00:00:00.000Z"),
      });
      const packageDoc = twoToolPackage();

      const result = await service.packages.importPackage({
        mode: "create",
        packageDocument: packageDoc,
        importedBy: "agent:tool-developer",
        ttlMs: 60_000,
      });

      expect(result).toMatchObject({
        ok: true,
        mode: "create",
        family: {
          id: "github",
          name: "GitHub",
          version: 7,
          toolNames: ["github_search_issues", "github_get_issue"],
        },
        validation: { ok: true },
        nextAction: "run_examples",
      });
      if (!result.ok) throw new Error("expected import success");
      const files = await service.drafts.listDraftFiles(result.draft.id);
      expect(files).toMatchObject({ ok: true });
      if (!files.ok) throw new Error("expected draft files");
      expect(files.files.map((file) => file.path)).toEqual(
        [
          "examples.yaml",
          "help/issues.md",
          "runtime/github.py",
          "tools.yaml",
          "family.yaml",
        ].sort(),
      );
      await expect(
        service.drafts.readDraftFile({
          draftId: result.draft.id,
          path: "github.py",
        }),
      ).resolves.toEqual({ ok: false, reason: "not_found" });
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("imports validation failures as actionable draft diagnostics instead of promoting", async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "openacme-hosted-package-import-"),
    );
    try {
      const service = createFileHostedIntegrationService({ dataDir });
      const packageDoc = validPackage({
        includeHelpFile: false,
        includeProviderFile: true,
      });

      const result = await service.packages.importPackage({
        mode: "create",
        packageDocument: packageDoc,
        importedBy: "agent:tool-developer",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected import success");
      expect(result.validation).toEqual(
        expect.objectContaining({
          ok: false,
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ code: "help_file_missing" }),
          ]),
        }),
      );
      await expect(service.generations.listGenerations()).resolves.toEqual([]);
      await expect(service.drafts.getDraft(result.draft.id)).resolves.toEqual(
        expect.objectContaining({ id: result.draft.id }),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("requires an owned lock for update-mode imports and replaces the draft file set exactly", async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "openacme-hosted-package-import-"),
    );
    try {
      await writeActiveSource(dataDir, {
        ...validPackage(),
        files: [
          ...validPackage().files,
          { path: "stale.py", content: "# should not survive import\n" },
        ],
      });
      const service = createFileHostedIntegrationService({
        dataDir,
        now: () => new Date("2026-08-17T00:00:00.000Z"),
      });

      await expect(
        service.packages.importPackage({
          mode: "update",
          packageDocument: validPackage(),
          importedBy: "agent:tool-developer",
          targetFamilyId: "qualys",
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "lock_required" },
      });

      const lock = await service.locks.acquireLock({
        familyId: "qualys",
        lockedBy: "web-settings",
        ttlMs: 60_000,
      });
      expect(lock.ok).toBe(true);
      if (!lock.ok) throw new Error("expected lock");
      await expect(
        service.packages.importPackage({
          mode: "update",
          packageDocument: validPackage(),
          importedBy: "agent:tool-developer",
          targetFamilyId: "qualys",
          lockId: lock.lock.id,
        }),
      ).resolves.toMatchObject({
        ok: false,
        error: { code: "lock_conflict" },
      });

      await service.locks.releaseLock({
        lockId: lock.lock.id,
        lockedBy: "web-settings",
      });
      const ownedLock = await service.locks.acquireLock({
        familyId: "qualys",
        lockedBy: "agent:tool-developer",
        ttlMs: 60_000,
      });
      expect(ownedLock.ok).toBe(true);
      if (!ownedLock.ok) throw new Error("expected owned lock");
      const result = await service.packages.importPackage({
        mode: "update",
        packageDocument: validPackage(),
        importedBy: "agent:tool-developer",
        targetFamilyId: "qualys",
        lockId: ownedLock.lock.id,
      });

      expect(result).toMatchObject({ ok: true, mode: "update" });
      if (!result.ok) throw new Error("expected update import");
      const files = await service.drafts.listDraftFiles(result.draft.id);
      expect(files).toMatchObject({ ok: true });
      if (!files.ok) throw new Error("expected draft files");
      expect(files.files.some((file) => file.path === "stale.py")).toBe(false);
      expect(files.files.map((file) => file.path)).toEqual(
        validPackage()
          .files.map((file) => file.path)
          .sort(),
      );
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("exports active generations and drafts as sanitized package documents", async () => {
    const dataDir = await mkdtemp(
      path.join(tmpdir(), "openacme-hosted-package-export-"),
    );
    try {
      await writeActiveSource(dataDir, validPackage());
      const service = createFileHostedIntegrationService({
        dataDir,
        now: () => new Date("2026-08-17T00:00:00.000Z"),
      });
      const lock = await service.locks.acquireLock({
        familyId: "qualys",
        lockedBy: "agent:tool-developer",
        ttlMs: 60_000,
      });
      expect(lock.ok).toBe(true);
      if (!lock.ok) throw new Error("expected lock");
      const draft = await service.drafts.createDraft({
        familyId: "qualys",
        lockId: lock.lock.id,
        sourceRevisionId: "source_rev_1",
      });
      expect(draft.ok).toBe(true);
      if (!draft.ok) throw new Error("expected draft");
      const promoted = await service.generations.promoteDraft({
        draftId: draft.draft.id,
        promotedBy: "agent:tool-developer",
        validation: { ok: true, diagnostics: [] },
      });
      expect(promoted.ok).toBe(true);
      if (!promoted.ok) throw new Error("expected promotion");

      const activeExport = await service.packages.exportPackage({
        source: { type: "active_generation", familyId: "qualys" },
        exportedBy: "agent:tool-developer",
      });

      expect(activeExport).toMatchObject({
        ok: true,
        packageDocument: {
          kind: HOSTED_FAMILY_PACKAGE_KIND,
          metadata: {
            familyId: "qualys",
            exportedBy: "agent:tool-developer",
            sourceGenerationId: promoted.generation.id,
            sourceRevisionId: "source_rev_1",
          },
        },
      });
      if (!activeExport.ok) throw new Error("expected active export");
      expect(JSON.stringify(activeExport.packageDocument)).not.toContain(
        "raw-token",
      );
      expect(activeExport.exportedFiles).toContain("examples.yaml");

      await service.drafts.writeDraftFile({
        draftId: draft.draft.id,
        lockId: lock.lock.id,
        path: "help/draft-only.md",
        content: "Draft-only help.",
      });
      const draftExport = await service.packages.exportPackage({
        source: { type: "draft", draftId: draft.draft.id },
        exportedBy: "agent:tool-developer",
        includeExamples: false,
      });

      expect(draftExport).toMatchObject({
        ok: true,
        packageDocument: {
          metadata: {
            familyId: "qualys",
            sourceDraftId: draft.draft.id,
          },
        },
        exportedFiles: expect.arrayContaining(["help/draft-only.md"]),
      });
      if (!draftExport.ok) throw new Error("expected draft export");
      expect(draftExport.exportedFiles).not.toContain("examples.yaml");
    } finally {
      await rm(dataDir, { recursive: true, force: true });
    }
  });

  it("exports equivalent normalized packages from file-backed and DB-backed active generations", async () => {
    const fileDir = await mkdtemp(
      path.join(tmpdir(), "openacme-hosted-package-file-"),
    );
    const dbDir = await mkdtemp(
      path.join(tmpdir(), "openacme-hosted-package-db-"),
    );
    const db = createDatabase(
      ConfigSchema.parse({
        dataDir: dbDir,
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      }),
    );
    try {
      const fileService = createFileHostedIntegrationService({
        dataDir: fileDir,
        now: () => new Date("2026-08-17T00:00:00.000Z"),
      });
      const dbService = createDbHostedIntegrationService({
        dataDir: dbDir,
        db,
        now: () => new Date("2026-08-17T00:00:00.000Z"),
      });
      const fileExport = await importPromoteAndExport(fileService);
      const dbExport = await importPromoteAndExport(dbService);
      expect(fileExport.ok).toBe(true);
      expect(dbExport.ok).toBe(true);
      if (!fileExport.ok || !dbExport.ok) {
        throw new Error("expected both exports");
      }

      expect(fileExport.digest).toBe(dbExport.digest);
      expect(fileExport.packageDocument.files).toEqual(
        dbExport.packageDocument.files,
      );
    } finally {
      db.close();
      await rm(fileDir, { recursive: true, force: true });
      await rm(dbDir, { recursive: true, force: true });
    }
  });

  it("round-trips a hosted family package through isolated import, promotion, export, and fresh update import", async () => {
    const sourceDir = await mkdtemp(
      path.join(tmpdir(), "openacme-hosted-package-source-"),
    );
    const isolatedDir = await mkdtemp(
      path.join(tmpdir(), "openacme-hosted-package-isolated-"),
    );
    try {
      const sourceService = createFileHostedIntegrationService({
        dataDir: sourceDir,
        now: () => new Date("2026-08-17T00:00:00.000Z"),
      });
      const firstImport = await sourceService.packages.importPackage({
        mode: "create",
        packageDocument: validPackage(),
        importedBy: "agent:tool-developer",
        ttlMs: 60_000,
      });
      expect(firstImport).toMatchObject({
        ok: true,
        validation: { ok: true },
      });
      if (!firstImport.ok) throw new Error("expected source import");
      const firstExamples = await sourceService.examples.listExamples(
        firstImport.draft.id,
      );
      expect(firstExamples).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "count-web-prod",
            category: "smoke",
            toolName: "qualys_count_assets",
          }),
        ]),
      );
      const firstPromotion = await sourceService.generations.promoteDraft({
        draftId: firstImport.draft.id,
        promotedBy: "agent:tool-developer",
        validation: firstImport.validation,
      });
      expect(firstPromotion.ok).toBe(true);
      if (!firstPromotion.ok) throw new Error("expected source promotion");
      const exportedFromSource = await sourceService.packages.exportPackage({
        source: { type: "active_generation", familyId: "qualys" },
        exportedBy: "agent:tool-developer",
      });
      expect(exportedFromSource.ok).toBe(true);
      if (!exportedFromSource.ok) throw new Error("expected source export");

      const isolatedService = createFileHostedIntegrationService({
        dataDir: isolatedDir,
        now: () => new Date("2026-08-17T01:00:00.000Z"),
      });
      const isolatedImport = await isolatedService.packages.importPackage({
        mode: "create",
        packageDocument: exportedFromSource.packageDocument,
        importedBy: "agent:tool-developer",
        ttlMs: 60_000,
      });
      expect(isolatedImport).toMatchObject({
        ok: true,
        validation: { ok: true },
      });
      if (!isolatedImport.ok) throw new Error("expected isolated import");
      const isolatedPromotion = await isolatedService.generations.promoteDraft({
        draftId: isolatedImport.draft.id,
        promotedBy: "agent:tool-developer",
        validation: isolatedImport.validation,
      });
      expect(isolatedPromotion.ok).toBe(true);
      if (!isolatedPromotion.ok) {
        throw new Error("expected isolated promotion");
      }
      const exportedFromIsolated = await isolatedService.packages.exportPackage(
        {
          source: { type: "active_generation", familyId: "qualys" },
          exportedBy: "agent:tool-developer",
        },
      );
      expect(exportedFromIsolated.ok).toBe(true);
      if (!exportedFromIsolated.ok) throw new Error("expected isolated export");
      expect(packageFilesByPath(exportedFromIsolated.packageDocument)).toEqual(
        packageFilesByPath(exportedFromSource.packageDocument),
      );
      expect(exportedFromIsolated.digest).toBe(exportedFromSource.digest);

      if (isolatedImport.lock) {
        await isolatedService.locks.releaseLock({
          lockId: isolatedImport.lock.id,
          lockedBy: "agent:tool-developer",
        });
      }
      const updateLock = await isolatedService.locks.acquireLock({
        familyId: "qualys",
        lockedBy: "agent:tool-developer",
        ttlMs: 60_000,
      });
      expect(updateLock.ok).toBe(true);
      if (!updateLock.ok) throw new Error("expected update lock");
      const freshUpdateImport = await isolatedService.packages.importPackage({
        mode: "update",
        packageDocument: exportedFromIsolated.packageDocument,
        importedBy: "agent:tool-developer",
        targetFamilyId: "qualys",
        lockId: updateLock.lock.id,
      });
      if (!freshUpdateImport.ok) {
        throw new Error(JSON.stringify(freshUpdateImport));
      }
      expect(freshUpdateImport).toMatchObject({
        ok: true,
        validation: { ok: true },
        nextAction: "run_examples",
      });
      if (!freshUpdateImport.ok) throw new Error("expected fresh update");
      const updateFiles = await isolatedService.drafts.listDraftFiles(
        freshUpdateImport.draft.id,
      );
      expect(updateFiles).toMatchObject({ ok: true });
      if (!updateFiles.ok) throw new Error("expected update files");
      expect(updateFiles.files.map((file) => file.path).sort()).toEqual(
        exportedFromIsolated.exportedFiles.sort(),
      );
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });

  it("round-trips the current Qualys pilot package with references and examples intact", async () => {
    const sourceDir = await mkdtemp(
      path.join(tmpdir(), "openacme-hosted-qualys-pilot-source-"),
    );
    const isolatedDir = await mkdtemp(
      path.join(tmpdir(), "openacme-hosted-qualys-pilot-isolated-"),
    );
    try {
      const sourcePackage = packageFromFixture(
        LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY,
      );
      const sourceValidation = await validateHostedFamilyPackage(sourcePackage);
      expect(sourceValidation).toMatchObject({ ok: true, diagnostics: [] });

      const sourceService = createFileHostedIntegrationService({
        dataDir: sourceDir,
        now: () => new Date("2026-08-17T00:00:00.000Z"),
      });
      const firstImport = await sourceService.packages.importPackage({
        mode: "create",
        packageDocument: sourcePackage,
        importedBy: "agent:tool-developer",
        ttlMs: 60_000,
      });
      expect(firstImport).toMatchObject({
        ok: true,
        validation: { ok: true },
        importedFiles: [
          "examples.yaml",
          "family.yaml",
          "qualys.py",
          "references/gav-filter-fields.json",
          "tools.yaml",
        ],
      });
      if (!firstImport.ok) throw new Error("expected Qualys pilot import");
      expect(firstImport.importedExamples).toEqual(["examples.yaml"]);
      const firstExamples = await sourceService.examples.listExamples(
        firstImport.draft.id,
      );
      expect(firstExamples.map((example) => example.id).sort()).toEqual(
        LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_SOURCE_BACKED_FAMILY.examples
          .map((example) => example.id)
          .sort(),
      );
      expect(firstExamples.map((example) => example.toolName).sort()).toEqual(
        [...LEGACY_INTEGRATION_HUB_CURRENT_PROMOTED_READONLY_TOOL_NAMES].sort(),
      );

      const firstPromotion = await sourceService.generations.promoteDraft({
        draftId: firstImport.draft.id,
        promotedBy: "agent:tool-developer",
        validation: firstImport.validation,
      });
      expect(firstPromotion.ok).toBe(true);
      if (!firstPromotion.ok) throw new Error("expected Qualys pilot promotion");
      const exportedFromSource = await sourceService.packages.exportPackage({
        source: { type: "active_generation", familyId: "qualys" },
        exportedBy: "agent:tool-developer",
      });
      expect(exportedFromSource.ok).toBe(true);
      if (!exportedFromSource.ok) throw new Error("expected Qualys pilot export");
      expect(exportedFromSource.exportedFiles.sort()).toEqual(
        sourcePackage.files.map((file) => file.path).sort(),
      );

      const isolatedService = createFileHostedIntegrationService({
        dataDir: isolatedDir,
        now: () => new Date("2026-08-17T01:00:00.000Z"),
      });
      const isolatedImport = await isolatedService.packages.importPackage({
        mode: "create",
        packageDocument: exportedFromSource.packageDocument,
        importedBy: "agent:tool-developer",
        ttlMs: 60_000,
      });
      expect(isolatedImport).toMatchObject({ ok: true, validation: { ok: true } });
      if (!isolatedImport.ok) throw new Error("expected isolated Qualys import");
      const isolatedPromotion = await isolatedService.generations.promoteDraft({
        draftId: isolatedImport.draft.id,
        promotedBy: "agent:tool-developer",
        validation: isolatedImport.validation,
      });
      expect(isolatedPromotion.ok).toBe(true);
      if (!isolatedPromotion.ok) {
        throw new Error("expected isolated Qualys promotion");
      }
      const exportedFromIsolated = await isolatedService.packages.exportPackage(
        {
          source: { type: "active_generation", familyId: "qualys" },
          exportedBy: "agent:tool-developer",
        },
      );
      expect(exportedFromIsolated.ok).toBe(true);
      if (!exportedFromIsolated.ok) {
        throw new Error("expected isolated Qualys export");
      }
      expect(packageFilesByPath(exportedFromIsolated.packageDocument)).toEqual(
        packageFilesByPath(exportedFromSource.packageDocument),
      );
      expect(exportedFromIsolated.digest).toBe(exportedFromSource.digest);
      const exportedFiles = packageFilesByPath(
        exportedFromIsolated.packageDocument,
      );
      expect(exportedFiles["references/gav-filter-fields.json"]).toContain(
        "qualys.agent.lastCheckedInDate",
      );
      expect(exportedFiles["tools.yaml"]).toContain(
        "vocabularyRef: references/gav-filter-fields.json",
      );
      expect(exportedFiles["tools.yaml"]).toContain("errors:");
      expect(exportedFiles["tools.yaml"]).toContain("bad_arguments means");
      expect(exportedFiles["tools.yaml"]).toContain("pagination:");
      expect(exportedFiles["tools.yaml"]).toContain("model: lastSeenAssetId");
      expect(exportedFiles["tools.yaml"]).toContain("model: foWarningUrl");
    } finally {
      await rm(sourceDir, { recursive: true, force: true });
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });
});

function packageFilesByPath(
  packageDoc: HostedFamilyPackageDocument,
): Record<string, string> {
  return Object.fromEntries(
    packageDoc.files.map((file) => [file.path, file.content]),
  );
}

function packageFromFixture(fixture: {
  familyId: string;
  sourceFiles: Record<string, string>;
  examples: Array<Record<string, unknown>>;
}): HostedFamilyPackageDocument {
  return {
    kind: HOSTED_FAMILY_PACKAGE_KIND,
    version: HOSTED_FAMILY_PACKAGE_VERSION,
    metadata: { familyId: fixture.familyId },
    files: [
      ...Object.entries(fixture.sourceFiles).map(([path, content]) => ({
        path,
        content,
      })),
      {
        path: "examples.yaml",
        content: stringifyYaml({ examples: fixture.examples }),
      },
    ],
  };
}

function validPackage(
  options: { includeProviderFile?: boolean; includeHelpFile?: boolean } = {},
): HostedFamilyPackageDocument {
  const includeProviderFile = options.includeProviderFile ?? true;
  const includeHelpFile = options.includeHelpFile ?? true;
  return {
    kind: HOSTED_FAMILY_PACKAGE_KIND,
    version: HOSTED_FAMILY_PACKAGE_VERSION,
    metadata: { familyId: "qualys" },
    files: [
      { path: "family.yaml", content: familyYaml() },
      { path: "tools.yaml", content: toolsYaml() },
      { path: "qualys.py", content: pythonSource() },
      { path: "examples.yaml", content: examplesYaml() },
      ...(includeHelpFile
        ? [{ path: "help/count.md", content: "Full count help." }]
        : []),
      ...(includeProviderFile
        ? [{ path: "provider/qualys-vmdr.yaml", content: "openapi: 3.1.0\n" }]
        : []),
    ],
  };
}

function twoToolPackage(): HostedFamilyPackageDocument {
  const family = {
    id: "github",
    name: "GitHub",
    version: 7,
    runtime: {
      language: "python",
      entrypoint: "runtime/github.py",
      defaultTimeoutMs: 30000,
      inlineResultTokenLimit: 8000,
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
  };
  const classification = {
    operation: "read",
    freshness: "live",
    idempotency: "idempotent",
    execution: "sync",
    approval: "none",
  };
  return {
    kind: HOSTED_FAMILY_PACKAGE_KIND,
    version: HOSTED_FAMILY_PACKAGE_VERSION,
    metadata: { familyId: "github" },
    files: [
      { path: "family.yaml", content: stringifyYaml(family) },
      {
        path: "tools.yaml",
        content: stringifyYaml({
          kind: "openacme.hostedToolFamily",
          version: 1,
          family: { id: "github" },
          tools: [
            {
              mcp: {
                name: "hosted_github__github_search_issues",
                title: "Search issues",
                description: "Search GitHub issues.",
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
                outputSchema: { type: "object", additionalProperties: true },
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                  idempotentHint: true,
                  openWorldHint: true,
                },
              },
              openacme: {
                toolName: "github_search_issues",
                function: "tool_github_search_issues",
                lifecycle: "active",
                classification,
                selectWhen: ["Need to search issues."],
                doNotSelectWhen: ["Need one known issue."],
                prerequisites: [],
                parameterHelp: {},
                examples: [{}],
                errors: [],
              },
            },
            {
              mcp: {
                name: "hosted_github__github_get_issue",
                title: "Get issue",
                description: "Retrieve one GitHub issue.",
                inputSchema: {
                  type: "object",
                  properties: {},
                  additionalProperties: false,
                },
                outputSchema: { type: "object", additionalProperties: true },
                annotations: {
                  readOnlyHint: true,
                  destructiveHint: false,
                  idempotentHint: true,
                  openWorldHint: true,
                },
              },
              openacme: {
                toolName: "github_get_issue",
                function: "tool_github_get_issue",
                lifecycle: "active",
                classification,
                selectWhen: ["Need one known issue."],
                doNotSelectWhen: ["Need to search issues."],
                prerequisites: [],
                parameterHelp: {},
                examples: [{}],
                errors: [],
              },
            },
          ],
        }),
      },
      { path: "runtime/github.py", content: twoToolPythonSource() },
      { path: "help/issues.md", content: "Issue help." },
      { path: "examples.yaml", content: stringifyYaml({ examples: [] }) },
    ],
  };
}

async function writeActiveSource(
  dataDir: string,
  packageDoc: HostedFamilyPackageDocument,
): Promise<void> {
  const familyDir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    "qualys",
  );
  await mkdir(familyDir, { recursive: true });
  for (const file of packageDoc.files) {
    const filePath = path.join(familyDir, file.path);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, file.content, "utf-8");
  }
}

async function importPromoteAndExport(
  service: ReturnType<typeof createFileHostedIntegrationService>,
) {
  const imported = await service.packages.importPackage({
    mode: "create",
    packageDocument: validPackage(),
    importedBy: "agent:tool-developer",
    ttlMs: 60_000,
  });
  if (!imported.ok) throw new Error("expected import");
  const promoted = await service.generations.promoteDraft({
    draftId: imported.draft.id,
    promotedBy: "agent:tool-developer",
    validation: imported.validation,
  });
  if (!promoted.ok) throw new Error("expected promotion");
  return service.packages.exportPackage({
    source: { type: "active_generation", familyId: "qualys" },
    exportedBy: "agent:tool-developer",
  });
}

function familyYaml(): string {
  return stringifyYaml({
    id: "qualys",
    name: "Qualys",
    version: 1,
    runtime: {
      language: "python",
      entrypoint: "qualys.py",
      defaultTimeoutMs: 30000,
      inlineResultTokenLimit: 8000,
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
  });
}

function toolsYaml(): string {
  return stringifyYaml(contractDocument());
}

function contractDocument(): Record<string, any> {
  return {
    kind: "openacme.hostedToolFamily",
    version: 1,
    family: { id: "qualys" },
    tools: [
      {
        mcp: {
          name: "hosted_qualys__qualys_count_assets",
          title: "Count assets",
          description: "Count Qualys assets matching a query.",
          inputSchema: {
            type: "object",
            properties: {
              query: { type: "string", description: "Provider query." },
            },
            additionalProperties: false,
          },
          outputSchema: {
            type: "object",
            additionalProperties: true,
          },
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: true,
          },
        },
        openacme: {
          toolName: "qualys_count_assets",
          function: "tool_qualys_count_assets",
          lifecycle: "active",
          classification: {
            operation: "read",
            freshness: "live",
            idempotency: "idempotent",
            execution: "sync",
            approval: "none",
          },
          fullHelp: "help/count.md",
          selectWhen: ["Need a count of matching Qualys assets."],
          doNotSelectWhen: ["Need the asset records themselves."],
          prerequisites: ["Qualys credentials are configured."],
          parameterHelp: {
            query: {
              summary: "Qualys asset query.",
              full: "help/count.md",
            },
          },
          examples: [{ query: "hostname:web-prod-01" }],
          errors: ["Authentication failures require credential repair."],
          providerRef: {
            path: "provider/qualys-vmdr.yaml",
            operationId: "countAssets",
          },
        },
      },
    ],
  };
}

function examplesYaml(): string {
  return stringifyYaml({
    examples: [
      {
        id: "count-web-prod",
        familyId: "qualys",
        toolName: "qualys_count_assets",
        category: "smoke",
        args: { query: "hostname:web-prod-01" },
        expected: {
          ok: true,
          contains: ["total"],
        },
      },
    ],
  });
}

function pythonSource(): string {
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
    "    return {'total': 1}",
    "",
  ].join("\n");
}

function twoToolPythonSource(): string {
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
    "def tool_github_search_issues(args, context):",
    "    return {'items': []}",
    "",
    "def tool_github_get_issue(args, context):",
    "    return {'item': {}}",
    "",
  ].join("\n");
}
