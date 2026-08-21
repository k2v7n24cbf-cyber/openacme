import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ConfigSchema } from "@openacme/config";
import { registry as toolRegistry, toolCallContext } from "@openacme/tools";
import type { JsonValue, WorkflowExecutionPorts } from "@openacme/workflows";
import { createApp } from "../src/app.js";
import { WORKFLOW_ENGINEER_LIVE_SCENARIOS } from "../test/e2e/support/workflow-engineer-live-scenarios.js";

const workflowEngineerId = "workflow-engineer";
const dataDir =
  process.env["OPENACME_DATA_DIR"] ??
  "/Users/alenbohcelyan/.openacme-the-workflow";
const reportRoot = path.resolve(
  process.cwd(),
  "test-artifacts/workflow-engineer-live-dogfood",
);

interface ToolCallEvidence {
  toolName: string;
  sessionId: string;
  ok: boolean;
}

interface ScenarioReport {
  id: string;
  title: string;
  task: string;
  sessionId: string;
  complex: boolean;
  status: "pass" | "fail";
  workflowId?: string;
  runId?: string;
  runStatus?: string;
  diagnostics: string[];
  toolCalls: ToolCallEvidence[];
}

async function main(): Promise<void> {
  assertWorkflowDogfoodDataDir(dataDir);
  const config = ConfigSchema.parse({
    dataDir,
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  });
  const created = await createApp(config, {
    workflowExecutionPorts: dogfoodWorkflowPorts(),
  });
  try {
    const sharedSessionId = "workflow-engineer-live-dogfood:discovery";
    await created.manager.ensureManagedAgents();
    const workflowEngineer =
      created.manager.getAgentDef(workflowEngineerId);
    if (!workflowEngineer?.managed) {
      throw new Error("workflow-engineer managed agent was not materialized");
    }
    if (!workflowEngineer.skills.includes("openacme-workflow-author")) {
      throw new Error("workflow-engineer is missing openacme-workflow-author");
    }

    const reports: ScenarioReport[] = [];
    const startedAt = new Date().toISOString();
    const runStamp = Date.now().toString(36);
    const sharedCalls: ToolCallEvidence[] = [];
    const catalog = await runWorkflowTool(
      "workflow_card_catalog",
      {},
      sharedCalls,
      sharedSessionId,
    );
    if (!catalog.ok || !Array.isArray(catalog.cards)) {
      throw new Error("workflow_card_catalog did not return cards");
    }
    const toolInventory = await runWorkflowTool(
      "workflow_tool_inventory",
      {},
      sharedCalls,
      sharedSessionId,
    );
    const agentInventory = await runWorkflowTool(
      "workflow_agent_inventory",
      {},
      sharedCalls,
      sharedSessionId,
    );
    if (!toolInventory.ok || !agentInventory.ok) {
      throw new Error("workflow runtime inventories are unavailable");
    }

    for (const scenario of WORKFLOW_ENGINEER_LIVE_SCENARIOS) {
      const toolCalls = [...sharedCalls];
      const workflowId = `wf_dogfood_${scenario.id}_${runStamp}`;
      const sessionId = `workflow-engineer-live-dogfood:${scenario.id}`;
      const report: ScenarioReport = {
        id: scenario.id,
        title: scenario.title,
        task: buildScenarioTask(scenario),
        sessionId,
        complex: scenario.complex,
        status: "fail",
        workflowId,
        diagnostics: [],
        toolCalls,
      };
      reports.push(report);

      try {
        const candidate = {
          id: workflowId,
          ...scenario.definition,
        };
        const validation = await runWorkflowTool(
          "workflow_validate",
          { mode: "candidate", candidate },
          toolCalls,
          sessionId,
        );
        if (!validation.ok) {
          throw new Error(`validation failed: ${JSON.stringify(validation)}`);
        }

        const createdWorkflow = await runWorkflowTool(
          "workflow_create",
          candidate,
          toolCalls,
          sessionId,
        );
        if (!createdWorkflow.ok) {
          throw new Error(`create failed: ${JSON.stringify(createdWorkflow)}`);
        }

        const run = await runWorkflowTool(
          "workflow_test_run",
          {
            workflow_id: workflowId,
            input: scenario.input,
          },
          toolCalls,
          sessionId,
        );
        if (!run.ok || !run.run?.id) {
          throw new Error(`test run failed to start: ${JSON.stringify(run)}`);
        }
        report.runId = run.run.id;
        report.runStatus = run.run.status;
        if (run.run.status !== scenario.expectedStatus) {
          throw new Error(
            `expected ${scenario.expectedStatus}, received ${run.run.status}`,
          );
        }

        const summary = await runWorkflowTool(
          "workflow_run_get",
          { run_id: run.run.id },
          toolCalls,
          sessionId,
        );
        if (!summary.ok) {
          throw new Error(`run summary inspection failed: ${JSON.stringify(summary)}`);
        }
        if (!summary.summary) {
          throw new Error("run summary inspection did not return summary evidence");
        }

        const detail = await runWorkflowTool(
          "workflow_run_get",
          { run_id: run.run.id, detail: "full" },
          toolCalls,
          sessionId,
        );
        if (!detail.ok) {
          throw new Error(`run inspection failed: ${JSON.stringify(detail)}`);
        }
        assertScenarioEvidence(scenario, detail);

        if (scenario.id === "large_output_artifact") {
          if (!Array.isArray(detail.artifacts) || detail.artifacts.length === 0) {
            throw new Error("large output scenario did not spill an artifact");
          }
          const artifact = await runWorkflowTool(
            "workflow_artifact_get",
            {
              run_id: run.run.id,
              artifact_id: detail.artifacts[0].id,
            },
            toolCalls,
            sessionId,
          );
          if (!artifact.ok) {
            throw new Error(`artifact read failed: ${JSON.stringify(artifact)}`);
          }
        }

        if (!toolCalls.some((call) => call.toolName === "workflow_validate")) {
          throw new Error("missing workflow_validate evidence");
        }
        if (!toolCalls.some((call) => call.toolName === "workflow_test_run")) {
          throw new Error("missing workflow_test_run evidence");
        }
        if (!toolCalls.some((call) => call.toolName === "workflow_run_get")) {
          throw new Error("missing workflow_run_get evidence");
        }
        report.status = "pass";
        assertScenarioReportCompleteness(report);
      } catch (error) {
        report.diagnostics.push(error instanceof Error ? error.message : String(error));
      }
    }

    const failed = reports.filter((report) => report.status !== "pass");
    const output = {
      startedAt,
      endedAt: new Date().toISOString(),
      agentId: workflowEngineerId,
      dataDir,
      scenarios: reports,
      summary: {
        total: reports.length,
        passed: reports.length - failed.length,
        failed: failed.length,
      },
    };
    await mkdir(reportRoot, { recursive: true });
    const reportPath = path.join(reportRoot, `${runStamp}.json`);
    await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    if (failed.length > 0) {
      throw new Error(
        `workflow-engineer dogfood failed ${failed.length} scenario(s); report: ${reportPath}`,
      );
    }
    console.log(`workflow-engineer dogfood passed; report: ${reportPath}`);
  } finally {
    await created.close();
  }
}

function dogfoodWorkflowPorts(): WorkflowExecutionPorts {
  return {
    mcp: {
      async listTools() {
        return [
          {
            server: "dogfood",
            tool: "list_assets",
            name: "mcp_dogfood__list_assets",
            description: "Return deterministic dogfood assets.",
            inputSchema: {
              type: "object",
              properties: { limit: { type: "integer", minimum: 1, maximum: 5 } },
            },
          },
        ];
      },
      async callTool(req) {
        const limit =
          typeof req.input === "object" &&
          req.input !== null &&
          !Array.isArray(req.input) &&
          typeof req.input["limit"] === "number"
            ? req.input["limit"]
            : 2;
        return {
          output: {
            assets: [
              { id: "asset_1", hostname: "vm-1", vulnerabilities: [{ qid: "1001", severity: 5 }] },
              { id: "asset_2", hostname: "vm-2", vulnerabilities: [{ qid: "1002", severity: 3 }] },
              { id: "asset_3", hostname: "vm-3", vulnerabilities: [{ qid: "1003", severity: 4 }] },
            ].slice(0, Math.max(1, Math.min(limit, 3))),
          },
        };
      },
    },
    agent: {
      listAgents() {
        return [{ id: "risk-agent", name: "Risk Agent" }];
      },
      async callAgent(req) {
        return {
          output: {
            response: `priority selected for ${req.prompt}`,
          },
          sessionId: `dogfood-${req.agentId}`,
        };
      },
    },
    python: {
      async execute(req) {
        if (req.code.includes("70000")) {
          return { output: "x".repeat(70_000) };
        }
        return { output: req.input };
      },
    },
  };
}

async function runWorkflowTool(
  toolName: string,
  args: Record<string, unknown>,
  evidence: ToolCallEvidence[],
  sessionId: string,
): Promise<Record<string, any>> {
  const tool = toolRegistry.get(toolName);
  if (!tool) throw new Error(`Tool not registered: ${toolName}`);
  const raw = await toolCallContext.run(
    {
      agentId: workflowEngineerId,
      sessionId,
      workspaceDir: process.cwd(),
    },
    () => tool.handler(args),
  );
  const parsed = JSON.parse(raw) as Record<string, any>;
  evidence.push({ toolName, sessionId, ok: parsed.ok !== false });
  return parsed;
}

function buildScenarioTask(
  scenario: (typeof WORKFLOW_ENGINEER_LIVE_SCENARIOS)[number],
): string {
  return [
    `Create and test workflow: ${scenario.title}.`,
    `Use required cards: ${scenario.requiredCards.join(", ")}.`,
    `Expected run status: ${scenario.expectedStatus}.`,
    "Use workflow_card_catalog before authoring, workflow_validate before saving, workflow_test_run to execute, and workflow_run_get to inspect evidence.",
  ].join(" ");
}

function assertScenarioReportCompleteness(report: ScenarioReport): void {
  if (!report.task.trim()) throw new Error("report is missing task prompt");
  if (!report.sessionId.trim()) throw new Error("report is missing session id");
  if (!report.workflowId) throw new Error("report is missing workflow id");
  if (!report.runId) throw new Error("report is missing run id");
  const observed = new Set(report.toolCalls.map((call) => call.toolName));
  for (const required of [
    "workflow_card_catalog",
    "workflow_validate",
    "workflow_test_run",
    "workflow_run_get",
  ]) {
    if (!observed.has(required)) {
      throw new Error(`report is missing ${required} tool-call evidence`);
    }
  }
}

function assertScenarioEvidence(
  scenario: (typeof WORKFLOW_ENGINEER_LIVE_SCENARIOS)[number],
  detail: Record<string, any>,
): void {
  if (!detail.definition?.nodes) {
    throw new Error("run detail is missing definition snapshot");
  }
  const nodeTypes = new Set(
    detail.definition.nodes.map((node: { type: string }) => node.type),
  );
  for (const type of scenario.requiredCards) {
    if (!nodeTypes.has(type)) {
      throw new Error(`definition is missing required card ${type}`);
    }
  }
  if (!Array.isArray(detail.steps) || detail.steps.length === 0) {
    throw new Error("run detail is missing step attempts");
  }
  if (!Array.isArray(detail.events) || detail.events.length === 0) {
    throw new Error("run detail is missing timeline events");
  }
}

function assertWorkflowDogfoodDataDir(value: string): void {
  const resolved = path.resolve(value);
  if (
    resolved.endsWith(".openacme") ||
    (!resolved.includes("openacme-the-workflow") &&
      !resolved.includes("openacme-workflow"))
  ) {
    throw new Error(
      `Refusing to run workflow dogfood outside an isolated workflow data dir: ${resolved}`,
    );
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
