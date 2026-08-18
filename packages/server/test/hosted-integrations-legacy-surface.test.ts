import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);

const activeSurfaceFiles = [
  "apps/web/app/lib/hosted-integration-agent-settings.ts",
  "apps/web/app/lib/hosted-integrations-admin.ts",
  "apps/web/app/routes/agents.tsx",
  "apps/web/app/routes/hosted-tools.tsx",
  "apps/web/app/routes/settings.tsx",
  "packages/tools/src/builtins/hosted-integration-management.ts",
  "packages/tools/src/builtins/hosted-integration-help.ts",
  "packages/skills/builtin/hosted-integrations-development/SKILL.md",
  "packages/agent-catalog/templates/tool-developer/AGENT.md",
  "packages/server/scripts/integration-hub-parity.ts",
] as const;

describe("hosted integrations legacy surface cleanup", () => {
  it("does not expose legacy management tools on active surfaces", () => {
    const forbidden = [
      ["hosted_integration_config", "scope_"].join("_"),
      ["allowedConfig", "Ids"].join("Scope"),
      ["defaultConfig", "Id"].join("Scope"),
      ["config", "id"].join("_scope_"),
      ["config", "Id"].join("Scope"),
      ["/api/hosted-integrations/config", "scopes"].join("-"),
      ["config", "scope"].join(" "),
      ["config", "scope"].join("-"),
    ];

    for (const relativePath of activeSurfaceFiles) {
      const content = readActiveSurface(relativePath);
      for (const token of forbidden) {
        expect(content, `${relativePath} contains ${token}`).not.toContain(
          token,
        );
      }
    }
  });

  it("teaches environment configs, hosted-tool bindings, and readiness instead of legacy config terminology", () => {
    const skill = readActiveSurface(
      "packages/skills/builtin/hosted-integrations-development/SKILL.md",
    );

    expect(skill).toContain("environment config");
    expect(skill).toContain("hosted-tool binding");
    expect(skill).toContain("readiness");
    expect(skill).not.toContain(["config", "scope"].join(" "));
    expect(skill).not.toContain(["config", "scope"].join("-"));
  });

  it("keeps Hosted Tools as the public product wording", () => {
    const architecture = readActiveSurface(
      "docs/hosted-integrations-architecture.md",
    );
    const route = readActiveSurface("apps/web/app/routes/hosted-tools.tsx");

    expect(architecture).toContain("**Hosted Tools**: The product");
    expect(architecture).toContain("Hosted Tools: qualys");
    expect(architecture).toContain("Do not use `managed tool`");
    expect(architecture).toContain("**Hosted integration**: The internal");
    expect(architecture).toContain("discovery_required");
    expect(architecture).toContain("not ready-to-send invocation payloads");
    expect(architecture).toContain("not executed directly");
    expect(architecture).not.toContain("Hosted Integrations: qualys");
    expect(architecture).not.toContain("managed tools");
    expect(route).toContain("Hosted Tools");
    expect(route).not.toContain("Hosted Integrations");
    expect(route).not.toContain("managed tools");
  });

  it("keeps the platform skill as a router for Hosted Tools without duplicating lifecycle rules", () => {
    const platformSkill = readActiveSurface(
      "packages/skills/builtin/openacme-platform/SKILL.md",
    );

    expect(platformSkill).toContain("read\n`$hosted-integrations-development`");
    expect(platformSkill).toContain("Use **Hosted Tools**");
    expect(platformSkill).toContain("product and human-facing wording");
    expect(platformSkill).toContain("internal package/API/storage/runtime layer");
    expect(platformSkill).toContain("Do not call this feature managed tools");
    expect(platformSkill).toContain("remote MCP\nservers");
    expect(platformSkill).toContain(
      "rather than duplicating them here",
    );
  });

  it("teaches tools.yaml MCP surface ownership and evidence-required provider boundaries", () => {
    const skill = readActiveSurface(
      "packages/skills/builtin/hosted-integrations-development/SKILL.md",
    );
    const template = readActiveSurface(
      "packages/agent-catalog/templates/tool-developer/AGENT.md",
    );

    expect(skill).toContain("tools.yaml");
    expect(skill).toContain("official MCP tool fields");
    expect(skill).toContain("EVIDENCE_REQUIRED");
    expect(skill).toContain("Do not invent complex provider API behavior");
    expect(skill).toContain("actionable `openacme.errors` guidance");
    expect(skill).toContain("`openacme.pagination` guidance");
    expect(skill).toContain("repository-owned scenario");
    expect(skill).toContain("Unguided scenario prompts must not name");
    expect(skill).toContain("legacy `managed_*` tool");
    expect(skill).toContain("analyzers own the required evidence");
    expect(skill).toContain(
      "docs/hosted-tools-vocabulary-acceptance-matrix.yaml",
    );
    expect(skill).toContain("example-readiness changes");
    expect(skill).toContain(
      "docs/hosted-tools-live-evaluation-scenarios.yaml",
    );
    expect(skill).toContain("acceptedArtifacts");
    expect(skill).toContain("`status: pass`");
    expect(skill).toContain("`secretScan: pass`");
    expect(skill).toContain("matches the JSON artifact filename");
    expect(skill).toContain("Use `discovery_required`");
    expect(skill).toContain("Do not run `discovery_required` examples");
    expect(skill).toContain("not a ready-to-send invocation payload");
    expect(skill).toContain("must not include placeholder");
    expect(skill).toContain("external source repositories or");
    expect(skill).toContain("packages/hosted-integrations/families/");
    expect(skill).toContain("test-support fixtures as canonical deployable");
    expect(template).toContain("tools.yaml");
    expect(template).toContain("hosted MCP surface source of truth");
    expect(template).toContain("EVIDENCE_REQUIRED");
    expect(template).toContain("Do not invent complex provider API behavior");
    expect(template).toContain("hosted_tool_family_import");
    expect(template).toContain("hosted_tool_family_export");
    expect(template).toContain("acceptedArtifacts");
    expect(template).toContain("matching `runId` and JSON filename");
    expect(template).toContain("`secretScan: pass`");
    expect(template).toContain("Use `discovery_required` examples only");
    expect(template).toContain("must not contain placeholder");
    expect(template).toContain("must not be run directly");
    expect(template).toContain("external repositories or package artifacts");
    expect(template).toContain("packages/hosted-integrations/families/");
    expect(template).toContain("test-support fixtures as canonical deployable");
  });

  it("keeps hosted lifecycle ownership on Tool Developer instead of generic engineering personas", () => {
    const skill = readActiveSurface(
      "packages/skills/builtin/hosted-integrations-development/SKILL.md",
    );
    const template = readActiveSurface(
      "packages/agent-catalog/templates/tool-developer/AGENT.md",
    );

    expect(skill).toContain("Tool Developer");
    expect(template).toContain("Tool Developer");
    for (const content of [skill, template]) {
      expect(content).not.toMatch(/\b[Ss]oftware [Ee]ngineer\b/);
      expect(content).not.toMatch(/\bgeneric engineering maintainer\b/i);
    }
  });

  it("teaches shared vocabulary references instead of per-tool enum duplication", () => {
    const skill = readActiveSurface(
      "packages/skills/builtin/hosted-integrations-development/SKILL.md",
    );
    const template = readActiveSurface(
      "packages/agent-catalog/templates/tool-developer/AGENT.md",
    );
    const architecture = readActiveSurface(
      "docs/hosted-integrations-architecture.md",
    );

    expect(skill).toContain("family-local `references/`");
    expect(skill).toContain("`parameterHelp` with `vocabularyRef`");
    expect(skill).toContain("do not copy the same catalog");
    expect(skill).toContain("Complex filter/query/body parameters");
    expect(skill).toContain("Treat aliases as search synonyms only");
    expect(skill).toContain("documented `invalidAliases`");
    expect(template).toContain("family-local `references/`");
    expect(template).toContain("`parameterHelp` with `vocabularyRef`");
    expect(template).toContain("do not copy provider field catalogs");
    expect(architecture).toContain("vocabularyRef");
    expect(architecture).toContain("family-local shared vocabulary");
  });

  it("keeps hosted tools constrained to prod and test_debug environment labels", () => {
    const managementTools = readActiveSurface(
      "packages/tools/src/builtins/hosted-integration-management.ts",
    );

    expect(managementTools).toContain('z.enum(["prod", "test_debug"])');
    for (const forbidden of ['"test"', '"demo"', '"parity"', '"stage"']) {
      expect(
        managementTools,
        `management tool schema contains ${forbidden}`,
      ).not.toContain(forbidden);
    }
  });

  it("keeps live dogfood hosted tool variables out of legacy managed naming", () => {
    const dogfoodScript = readActiveSurface(
      "packages/server/scripts/hosted-integrations-real-llm-dogfood.ts",
    );

    expect(dogfoodScript).not.toMatch(/\bmanaged[A-Z][A-Za-z0-9]*Tool\b/);
    expect(dogfoodScript).toContain("hostedEchoTool");
    expect(dogfoodScript).toContain("hostedLargeTool");
    expect(dogfoodScript).toContain("hostedFlakyTool");
  });

  it("keeps integration-hub replacement and parity runner code out of server runtime source", () => {
    const runtimeSources = [
      "packages/server/src/app.ts",
      "packages/server/src/runtime.ts",
      "packages/server/src/routes/hosted-integrations.ts",
    ];
    const forbidden = [
      "LEGACY_INTEGRATION_HUB",
      "integration-hub-parity",
      "hosted-integration-live-parity",
    ];

    for (const relativePath of runtimeSources) {
      const content = readActiveSurface(relativePath);
      for (const token of forbidden) {
        expect(content, `${relativePath} contains ${token}`).not.toContain(
          token,
        );
      }
    }
  });
});

function readActiveSurface(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf-8");
}
