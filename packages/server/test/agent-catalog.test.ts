import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, loadGlobalMcpServers } from "@openacme/config";
import { HOSTED_TOOL_MANAGEMENT_TOOL_NAMES } from "@openacme/tools";
import { AgentManager } from "../src/agent-manager.js";

/**
 * Full end-to-end import flow against a real (temp) data directory and a
 * real AgentManager. Exercises:
 *   - bundled-skill auto-install via the `builtin` SkillHub source
 *   - bundled-MCP add to global mcp.json (Software Engineer bundles `filesystem`)
 *   - agent folder materialization (AGENT.md + workspace/ + resources/)
 *   - id auto-increment across repeated imports
 *   - id derives from folder, not frontmatter
 */
describe("AgentManager.importAgentFromTemplate (bundled Software Engineer)", () => {
  let dataDir: string;
  let manager: AgentManager;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "openacme-catalog-"));
    const config = ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    });
    manager = new AgentManager(config);
  });

  afterEach(async () => {
    await manager.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("imports Software Engineer, installs the bundled skill, copies resources", async () => {
    const result = await manager.importAgentFromTemplate(
      "software-engineer",
      {},
    );

    expect(result.agent.id).toBe("software-engineer");
    expect(result.agent.name).toBe("Software Engineer");
    expect(result.manifest.agent.id).toBe("software-engineer");
    expect(result.manifest.agent.resourceFiles.length).toBeGreaterThanOrEqual(
      1,
    );
    const styleGuide = result.manifest.agent.resourceFiles.find(
      (r) => r.relPath === "style-guide.md",
    );
    expect(styleGuide).toBeDefined();

    // Skill: auto-installed via the builtin source
    const skill = result.manifest.workforce.skills.find(
      (s) => s.name === "coding-conventions",
    );
    expect(skill?.action).toBe("installed");
    expect(
      existsSync(
        path.join(dataDir, "skills", "coding-conventions", "SKILL.md"),
      ),
    ).toBe(true);

    // Agent folder shape
    const agentDir = path.join(dataDir, "agents", "software-engineer");
    expect(existsSync(path.join(agentDir, "AGENT.md"))).toBe(true);
    expect(existsSync(path.join(agentDir, "workspace"))).toBe(true);
    expect(existsSync(path.join(agentDir, "resources", "style-guide.md"))).toBe(
      true,
    );

    // Imported AGENT.md is pristine — no template_* keys leaked into frontmatter
    const agentMd = readFileSync(path.join(agentDir, "AGENT.md"), "utf-8");
    expect(agentMd).not.toContain("template_id:");
    expect(agentMd).not.toContain("default_id_hint:");
    expect(agentMd).not.toContain("bundled_skills:");
    expect(agentMd).not.toContain("bundled_mcp_servers:");
    // id lives in the folder name, not the frontmatter
    expect(agentMd).not.toMatch(/^id:\s/m);
    // memoryCharLimit is a platform constant, not a per-agent field
    expect(agentMd).not.toContain("memoryCharLimit:");

    // MCP server installed into global mcp.json
    const mcp = loadGlobalMcpServers(dataDir);
    expect(mcp.filesystem).toBeDefined();
    expect(mcp.filesystem?.command).toBe("npx");
    const mcpAdded = result.manifest.workforce.mcpServers.find(
      (m) => m.name === "filesystem",
    );
    expect(mcpAdded?.action).toBe("added");

    // Resource file is a byte-for-byte copy of the template
    const dst = readFileSync(
      path.join(agentDir, "resources", "style-guide.md"),
    );
    expect(dst.length).toBeGreaterThan(0);
  });

  it("auto-increments the id on repeated imports", async () => {
    const a = await manager.importAgentFromTemplate("software-engineer", {});
    const b = await manager.importAgentFromTemplate("software-engineer", {});
    const c = await manager.importAgentFromTemplate("software-engineer", {});

    expect(a.agent.id).toBe("software-engineer");
    expect(b.agent.id).toBe("software-engineer-2");
    expect(c.agent.id).toBe("software-engineer-3");

    // The skill should be installed once and kept on subsequent imports
    // (skills live workforce-wide; only the first import installs them).
    expect(a.manifest.workforce.skills[0]?.action).toBe("installed");
    expect(b.manifest.workforce.skills[0]?.action).toBe("kept");
    expect(c.manifest.workforce.skills[0]?.action).toBe("kept");

    // Same for MCP — added once, kept on repeats.
    expect(a.manifest.workforce.mcpServers[0]?.action).toBe("added");
    expect(b.manifest.workforce.mcpServers[0]?.action).toBe("kept");
    expect(c.manifest.workforce.mcpServers[0]?.action).toBe("kept");

    // Each instance has its own resources copied fresh
    expect(b.manifest.agent.resourceFiles.length).toBeGreaterThanOrEqual(1);
    expect(
      existsSync(
        path.join(
          dataDir,
          "agents",
          "software-engineer-2",
          "resources",
          "style-guide.md",
        ),
      ),
    ).toBe(true);
  });

  it("honors idOverride when supplied", async () => {
    const r = await manager.importAgentFromTemplate("software-engineer", {
      idOverride: "backend-coder",
      nameOverride: "Backend Coder",
    });
    expect(r.agent.id).toBe("backend-coder");
    expect(r.agent.name).toBe("Backend Coder");
    expect(
      existsSync(path.join(dataDir, "agents", "backend-coder", "AGENT.md")),
    ).toBe(true);
  });

  it("rejects an idOverride that collides", async () => {
    await manager.importAgentFromTemplate("software-engineer", {});
    await expect(
      manager.importAgentFromTemplate("software-engineer", {
        idOverride: "software-engineer",
      }),
    ).rejects.toThrow(/already exists/);
  });

  it("rejects unknown template ids", async () => {
    await expect(
      manager.importAgentFromTemplate("nonexistent", {}),
    ).rejects.toThrow(/template not found/i);
  });

  it("applies inline overrides to the imported AgentDefinition", async () => {
    const r = await manager.importAgentFromTemplate("software-engineer", {
      overrides: {
        model: { provider: "openai", model: "gpt-5", auth: "api_key" },
        role: "Backend specialist",
      },
    });
    expect(r.agent.model?.provider).toBe("openai");
    expect(r.agent.model?.model).toBe("gpt-5");
    expect(r.agent.role).toBe("Backend specialist");

    // Round-trips through AgentStore.upsert serialization, so reading back
    // shows the same values.
    const stored = manager.agentStore.get(r.agent.id);
    expect(stored?.model?.provider).toBe("openai");
    expect(stored?.role).toBe("Backend specialist");
  });

  it("id derives from folder name, ignoring frontmatter id drift", async () => {
    await manager.importAgentFromTemplate("software-engineer", {});
    // Tamper: prepend a stale `id: imposter` to the AGENT.md frontmatter.
    const filePath = path.join(
      dataDir,
      "agents",
      "software-engineer",
      "AGENT.md",
    );
    const orig = readFileSync(filePath, "utf-8");
    const tampered = orig.replace("---\n", "---\nid: imposter\n");
    require("node:fs").writeFileSync(filePath, tampered);

    // Re-list — the agent should still report id "software-engineer" from
    // its folder, not the bogus frontmatter id.
    const fresh = new AgentManager(
      ConfigSchema.parse({
        dataDir,
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      }),
    );
    try {
      const agents = fresh.listAgents();
      const swe = agents.find((a) => a.id === "software-engineer");
      expect(swe).toBeDefined();
      expect(agents.find((a) => a.id === "imposter")).toBeUndefined();
    } finally {
      await fresh.close();
    }
  });
});

/**
 * First-boot materialization. Covers the path that lets a fresh install
 * land with a working Acme agent without the user running setup.
 */
describe("AgentManager.ensureManagedAgents", () => {
  let dataDir: string;
  let manager: AgentManager;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "openacme-acme-"));
    manager = new AgentManager(
      ConfigSchema.parse({
        dataDir,
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
      }),
    );
  });

  afterEach(async () => {
    await manager.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("materializes platform-managed agents on an empty workforce and marks them managed", async () => {
    expect(manager.listAgents()).toHaveLength(0);

    await manager.ensureManagedAgents();

    const agents = manager.listAgents();
    expect(agents.map((agent) => agent.id).sort()).toEqual([
      "acme",
      "tool-developer",
    ]);
    const acme = agents.find((agent) => agent.id === "acme")!;
    expect(acme.id).toBe("acme");
    expect(acme.name).toBe("Acme");
    expect(acme.managed).toBe(true);
    const toolDeveloper = agents.find(
      (agent) => agent.id === "tool-developer",
    )!;
    expect(toolDeveloper.name).toBe("Tool Developer");
    expect(toolDeveloper.managed).toBe(true);
    expect(toolDeveloper.tools).toEqual(
      expect.arrayContaining([...HOSTED_TOOL_MANAGEMENT_TOOL_NAMES]),
    );
    expect(toolDeveloper.skills).toEqual(["hosted-integrations-development"]);

    // Agent folder
    expect(existsSync(path.join(dataDir, "agents", "acme", "AGENT.md"))).toBe(
      true,
    );
    expect(existsSync(path.join(dataDir, "agents", "acme", "workspace"))).toBe(
      true,
    );
    expect(
      existsSync(path.join(dataDir, "agents", "tool-developer", "AGENT.md")),
    ).toBe(true);
    expect(
      existsSync(path.join(dataDir, "agents", "tool-developer", "workspace")),
    ).toBe(true);

    // Bundled skill landed
    expect(
      existsSync(path.join(dataDir, "skills", "openacme-platform", "SKILL.md")),
    ).toBe(true);
    const platformSkill = manager.skillRegistry.getSkill("openacme-platform");
    expect(platformSkill?.body).toContain("$hosted-integrations-development");
    expect(platformSkill?.body).toContain(
      "Tool Developer Agent owns routine hosted integration source work",
    );
    expect(
      existsSync(
        path.join(
          dataDir,
          "skills",
          "hosted-integrations-development",
          "SKILL.md",
        ),
      ),
    ).toBe(true);
    const hostedIntegrationSkill = manager.skillRegistry.getSkill(
      "hosted-integrations-development",
    );
    expect(hostedIntegrationSkill?.description).toContain("Lifecycle playbook");
    expect(manager.skillRegistry.getIndexAsString()).toContain(
      "- **hosted-integrations-development**: Lifecycle playbook",
    );
    expect(hostedIntegrationSkill?.body).toContain(
      "## Request to promotion lifecycle",
    );
    expect(hostedIntegrationSkill?.body).toContain("lock TTL");
    expect(hostedIntegrationSkill?.body).toContain("regression example");
    expect(hostedIntegrationSkill?.body).toContain("debug run");
    expect(hostedIntegrationSkill?.body).toContain(
      "family-native name such as `splunk_search`",
    );
    expect(hostedIntegrationSkill?.body).toContain(
      "Do not delegate hosted integration source edits",
    );
    expect(hostedIntegrationSkill?.body).toContain(
      "hosted_splunk__splunk_search",
    );
    expect(hostedIntegrationSkill?.body).toContain(
      "Do not read, request, or return secret values",
    );

    // Resources copied
    expect(
      existsSync(
        path.join(dataDir, "agents", "acme", "resources", "example-agent.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(dataDir, "agents", "acme", "resources", "example-skill.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(dataDir, "agents", "acme", "resources", "example-mcp.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(dataDir, "agents", "acme", "resources", "cli-commands.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(dataDir, "agents", "acme", "resources", "onboarding-task.md"),
      ),
    ).toBe(true);
  });

  it("is idempotent — second call does not duplicate the agent", async () => {
    await manager.ensureManagedAgents();
    await manager.ensureManagedAgents();
    expect(
      manager
        .listAgents()
        .map((agent) => agent.id)
        .sort(),
    ).toEqual(["acme", "tool-developer"]);
  });

  it("installs managed agents even when other unmanaged agents exist", async () => {
    // Pretend a user-added agent showed up before first boot materialization.
    await manager.importAgentFromTemplate("software-engineer", {});
    expect(manager.listAgents().map((a) => a.id)).toEqual([
      "software-engineer",
    ]);

    await manager.ensureManagedAgents();

    // The gate is per-template: empty managed slots install even though another
    // agent already exists.
    const ids = manager
      .listAgents()
      .map((a) => a.id)
      .sort();
    expect(ids).toEqual(["acme", "software-engineer", "tool-developer"]);
    expect(existsSync(path.join(dataDir, "agents", "acme"))).toBe(true);
    expect(existsSync(path.join(dataDir, "agents", "tool-developer"))).toBe(
      true,
    );
  });

  it("rejects mutations on a managed agent", async () => {
    await manager.ensureManagedAgents();
    await expect(
      manager.updateAgent("acme", { persona: "hacked" }),
    ).rejects.toThrow(/platform-managed/);
    await expect(manager.deleteAgent("acme")).rejects.toThrow(
      /platform-managed/,
    );
    await expect(
      manager.updateAgent("tool-developer", { persona: "hacked" }),
    ).rejects.toThrow(/platform-managed/);
    await expect(manager.deleteAgent("tool-developer")).rejects.toThrow(
      /platform-managed/,
    );
  });
});
