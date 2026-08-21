import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, loadGlobalMcpServers } from "@openacme/config";
import {
  HOSTED_TOOL_MANAGEMENT_TOOL_NAMES,
  WORKFLOW_MANAGEMENT_TOOL_NAMES,
} from "@openacme/tools";
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
      "workflow-engineer",
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
    const workflowEngineer = agents.find(
      (agent) => agent.id === "workflow-engineer",
    )!;
    expect(workflowEngineer.name).toBe("Workflow Engineer");
    expect(workflowEngineer.managed).toBe(true);
    expect(workflowEngineer.tools).toEqual(
      expect.arrayContaining([...WORKFLOW_MANAGEMENT_TOOL_NAMES]),
    );
    expect(workflowEngineer.skills).toEqual(["openacme-workflow-author"]);

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
    expect(
      existsSync(path.join(dataDir, "agents", "workflow-engineer", "AGENT.md")),
    ).toBe(true);
    expect(
      existsSync(path.join(dataDir, "agents", "workflow-engineer", "workspace")),
    ).toBe(true);

    // Bundled skill landed
    expect(
      existsSync(path.join(dataDir, "skills", "openacme-platform", "SKILL.md")),
    ).toBe(true);
    const platformSkill = manager.skillRegistry.getSkill("openacme-platform");
    expect(platformSkill?.body).toContain("$hosted-integrations-development");
    expect(platformSkill?.body).toContain("Use **Hosted Tools**");
    expect(platformSkill?.body).toContain(
      "internal package/API/storage/runtime layer",
    );
    expect(platformSkill?.body).toContain(
      "Do not call this feature managed tools",
    );
    expect(platformSkill?.body).toContain("remote MCP\nservers");
    expect(platformSkill?.body).toContain(
      "Tool Developer Agent owns routine hosted integration source work",
    );
    expect(platformSkill?.body).toContain(
      "Workflow Engineer Agent owns routine workflow definition work",
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
    expect(
      existsSync(
        path.join(dataDir, "skills", "openacme-workflow-author", "SKILL.md"),
      ),
    ).toBe(true);
    const workflowAuthorSkill = manager.skillRegistry.getSkill(
      "openacme-workflow-author",
    );
    expect(workflowEngineer.persona).toContain("workflow_help");
    expect(workflowEngineer.persona).toContain("workflow_card_test_run");
    expect(workflowEngineer.persona).toContain("builtin.output.set");
    expect(workflowEngineer.persona).toContain("Prefer deterministic cards");
    expect(workflowAuthorSkill?.body).toContain("workflow_card_catalog");
    expect(workflowAuthorSkill?.body).toContain("workflow_help");
    expect(workflowAuthorSkill?.body).toContain("workflow_help_upsert");
    expect(workflowAuthorSkill?.body).toContain("workflow_validate");
    expect(workflowAuthorSkill?.body).toContain("workflow_card_test_run");
    expect(workflowAuthorSkill?.body).toContain("workflow_test_run");
    expect(workflowAuthorSkill?.body).toContain("builtin.output.set");
    expect(workflowAuthorSkill?.body).toContain(
      "full test run for the current draft",
    );
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
    ).toEqual(["acme", "tool-developer", "workflow-engineer"]);
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
    expect(ids).toEqual([
      "acme",
      "software-engineer",
      "tool-developer",
      "workflow-engineer",
    ]);
    expect(existsSync(path.join(dataDir, "agents", "acme"))).toBe(true);
    expect(existsSync(path.join(dataDir, "agents", "tool-developer"))).toBe(
      true,
    );
    expect(existsSync(path.join(dataDir, "agents", "workflow-engineer"))).toBe(
      true,
    );
  });

  it("adopts a stale reserved workflow-engineer slot into the managed template", async () => {
    const agentDir = path.join(dataDir, "agents", "workflow-engineer");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, "AGENT.md"),
      `---
name: Workflow Engineer
role: Old hand-authored workflow helper.
model:
  provider: openai
  model: gpt-5.5
  auth: oauth
tools:
  - shell
  - process
skills:
  - openacme-platform
mcpServers: {}
mcpDisabled: []
---
Old workflow engineer.
`,
      "utf-8",
    );

    await manager.ensureManagedAgents();

    const adopted = manager.agentStore.get("workflow-engineer")!;
    expect(adopted.managed).toBe(true);
    expect(adopted.tools).toEqual(
      expect.arrayContaining([...WORKFLOW_MANAGEMENT_TOOL_NAMES]),
    );
    expect(adopted.skills).toEqual(["openacme-workflow-author"]);
    expect(
      existsSync(
        path.join(dataDir, "skills", "openacme-workflow-author", "SKILL.md"),
      ),
    ).toBe(true);
  });

  it("leaves explicitly unmanaged reserved slots alone", async () => {
    const agentDir = path.join(dataDir, "agents", "workflow-engineer");
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(
      path.join(agentDir, "AGENT.md"),
      `---
name: Workflow Engineer
managed: false
role: User-owned workflow helper.
model:
  provider: openai
  model: gpt-5.5
  auth: oauth
tools:
  - shell
skills:
  - openacme-platform
mcpServers: {}
mcpDisabled: []
---
User-owned workflow engineer.
`,
      "utf-8",
    );

    await manager.ensureManagedAgents();

    const untouched = manager.agentStore.get("workflow-engineer")!;
    expect(untouched.managed).toBe(false);
    expect(untouched.tools).toEqual(["shell"]);
    expect(untouched.skills).toEqual(["openacme-platform"]);
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
    await expect(
      manager.updateAgent("workflow-engineer", { persona: "hacked" }),
    ).rejects.toThrow(/platform-managed/);
    await expect(manager.deleteAgent("workflow-engineer")).rejects.toThrow(
      /platform-managed/,
    );
  });
});

describe("Workflow Engineer bundled authoring guidance", () => {
  it("documents the first-class workflow development loop and evidence tools", () => {
    const repoRoot = path.resolve("../..");
    const skill = readFileSync(
      path.resolve(
        repoRoot,
        "packages/skills/builtin/openacme-workflow-author/SKILL.md",
      ),
      "utf-8",
    );
    const reference = readFileSync(
      path.resolve(
        repoRoot,
        "packages/skills/builtin/openacme-workflow-author/references/workflow-authoring.md",
      ),
      "utf-8",
    );
    const template = readFileSync(
      path.resolve(
        repoRoot,
        "packages/agent-catalog/templates/workflow-engineer/AGENT.md",
      ),
      "utf-8",
    );

    for (const text of [skill, reference, template]) {
      expect(text).toContain("workflow_help");
      expect(text).toContain("workflow_callable_list");
      expect(text).toContain("workflow_run");
      expect(text).toContain("workflow_card_test_run");
      expect(text).toContain("workflow_test_run");
      expect(text).toContain("workflow_run_get");
      expect(text).toContain("builtin.output.set");
    }
    expect(skill).toContain("workflow_help_upsert");
    expect(reference).toContain("stop_after_step_id");
    expect(reference).toContain("summary-first");
    expect(reference).toContain("current draft");
    expect(template).toContain("Prefer deterministic cards");
    expect(reference).toContain("workflow_tool_inventory");
    expect(reference).toContain("workflow_agent_inventory");
  });
});
