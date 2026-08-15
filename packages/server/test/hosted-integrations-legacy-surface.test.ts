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
