import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentDefinitionSchema, ConfigSchema } from "@openacme/config";
import {
  WORKFLOW_CONSUMER_TOOL_NAMES,
  registry as toolRegistry,
  toolCallContext,
} from "@openacme/tools";
import type { WorkflowExecutionPorts } from "@openacme/workflows";
import { withSplitToolContractFiles } from "../../hosted-integrations/test/test-support/split-contract-fixtures.js";
import { createApp } from "../src/app.js";
import type { ServerRuntime } from "../src/runtime.js";

let dataDir: string;
let runtime: ServerRuntime;
let closeApp: (() => Promise<void>) | null = null;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-workflow-tools-"));
  await bootRuntime();
});

afterEach(async () => {
  await closeApp?.();
  closeApp = null;
  rmSync(dataDir, { recursive: true, force: true });
});

describe("workflow management tools", () => {
  it("returns workflow authoring overview help", async () => {
    const help = await runTool("workflow_help", {
      target: { kind: "overview" },
    });

    expect(help).toMatchObject({
      ok: true,
      target: { kind: "overview" },
      detail: "summary",
      summary: expect.stringContaining("Discover"),
      recommendedLoop: [
        "workflow_help",
        "workflow_card_catalog",
        "workflow_validate",
        "workflow_card_test_run",
        "workflow_test_run",
        "workflow_run_get",
        "workflow_publish",
      ],
    });
    expect(help).not.toHaveProperty("examples");
  });

  it("returns card type help with parameter details and examples on request", async () => {
    const help = await runTool("workflow_help", {
      target: { kind: "card_type", card_type: "builtin.if" },
      detail: "full",
      include_examples: true,
      parameters: [{ name: "condition", detail: "full" }],
    });

    expect(help).toMatchObject({
      ok: true,
      target: { kind: "card_type", cardType: "builtin.if" },
      detail: "full",
      card: {
        type: "builtin.if",
        label: "If",
        family: "logic",
        outputSchema: {
          type: "object",
          properties: { matched: { type: "boolean" } },
        },
      },
      parameters: [
        {
          name: "condition",
          summary: expect.stringContaining("condition"),
          schema: { type: "string", minLength: 1 },
        },
      ],
      examples: [{ condition: "$.workflowTrigger.input.enabled == true" }],
    });
    expect(help.full).toContain("Route execution");
  });

  it("returns structured suggestions for unknown workflow help targets", async () => {
    const help = await runTool("workflow_help", {
      target: { kind: "card_type", card_type: "builtin.missing" },
    });

    expect(help).toMatchObject({
      ok: false,
      error: { code: "unknown_card_type" },
      suggestions: expect.arrayContaining(["builtin.if"]),
    });
  });

  it("upserts workflow help and preserves it across runtime restart", async () => {
    await expect(
      runTool("workflow_help_upsert", {
        target: { kind: "card_type", card_type: "builtin.if" },
        help: {
          summary: "Use If for deterministic true/false routing.",
          full: "Prefer If when both paths can be selected from explicit workflow state.",
          whenToUse: ["Need boolean routing."],
          whenNotToUse: ["Need fuzzy AI judgment."],
          parameters: {
            condition: {
              summary: "Boolean condition expression.",
              full: "Use $.workflowTrigger.input.* or $.steps.<id>.output.*.",
              examples: ["$.workflowTrigger.input.enabled == true"],
            },
          },
          examples: [{ condition: "$.workflowTrigger.input.enabled == true" }],
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      target: { kind: "card_type", cardType: "builtin.if" },
      help: { summary: "Use If for deterministic true/false routing." },
    });

    await bootRuntime();

    const help = await runTool("workflow_help", {
      target: { kind: "card_type", card_type: "builtin.if" },
      detail: "full",
      include_examples: true,
      parameters: [{ name: "condition", detail: "full" }],
    });

    expect(help).toMatchObject({
      ok: true,
      summary: "Use If for deterministic true/false routing.",
      full: "Prefer If when both paths can be selected from explicit workflow state.",
      whenToUse: ["Need boolean routing."],
      whenNotToUse: ["Need fuzzy AI judgment."],
      parameters: [
        {
          name: "condition",
          summary: "Boolean condition expression.",
          full: "Use $.workflowTrigger.input.* or $.steps.<id>.output.*.",
        },
      ],
      examples: [{ condition: "$.workflowTrigger.input.enabled == true" }],
    });
  });

  it("denies workflow help writes from non-authoring agents", async () => {
    await expect(
      runTool(
        "workflow_help_upsert",
        {
          target: { kind: "card_type", card_type: "builtin.if" },
          help: { summary: "Nope." },
        },
        "unknown-agent",
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "policy_denied" },
    });
  });

  it("creates, validates, test-runs, and inspects a workflow through the tool binding", async () => {
    const created = await runTool("workflow_create", {
      id: "wf_tool_smoke",
      name: "Workflow tool smoke",
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [
        {
          id: "start_log",
          type: "builtin.log.info",
          message: "$.workflowTrigger.input.name",
        },
      ],
    });

    expect(created).toMatchObject({
      ok: true,
      workflow: { id: "wf_tool_smoke", name: "Workflow tool smoke" },
    });

    await expect(
      runTool("workflow_validate", {
        mode: "saved",
        workflow_id: "wf_tool_smoke",
      }),
    ).resolves.toMatchObject({ ok: true, issues: [] });

    const run = await runTool("workflow_test_run", {
      workflow_id: "wf_tool_smoke",
      input: { name: "OpenAcme" },
    });

    expect(run).toMatchObject({
      ok: true,
      run: { workflowId: "wf_tool_smoke", status: "succeeded" },
    });
    expect(run.steps).toHaveLength(1);
    expect(
      run.events.find((event: { kind: string }) => event.kind === "log"),
    ).toMatchObject({ message: "OpenAcme" });

    const detail = await runTool("workflow_run_get", { run_id: run.run.id });
    expect(detail).toMatchObject({
      ok: true,
      run: { id: run.run.id, status: "succeeded" },
      summary: {
        stepCount: 1,
        steps: [{ stepId: "start_log", status: "succeeded" }],
        logs: [{ level: "info", message: "OpenAcme" }],
      },
    });
    expect(detail).not.toHaveProperty("steps");
    expect(detail).not.toHaveProperty("events");

    const stepDetail = await runTool("workflow_run_get", {
      run_id: run.run.id,
      detail: "step",
      step_id: "start_log",
      include: ["input", "output", "logs"],
    });
    expect(stepDetail.error).toBeUndefined();
    expect(stepDetail).toMatchObject({
      ok: true,
      run: { id: run.run.id, status: "succeeded" },
      stepId: "start_log",
      steps: [
        {
          nodeId: "start_log",
          status: "succeeded",
          input: { message: "OpenAcme" },
          output: { message: "OpenAcme" },
        },
      ],
      logs: [{ level: "info", message: "OpenAcme" }],
    });

    const fullDetail = await runTool("workflow_run_get", {
      run_id: run.run.id,
      detail: "full",
    });
    expect(fullDetail.steps[0]?.input).toMatchObject({
      message: "OpenAcme",
    });
    expect(fullDetail.steps[0]?.output).toEqual({ message: "OpenAcme" });
  });

  it("manages workflow definition lifecycle through tools", async () => {
    const created = await runTool("workflow_create", {
      id: "wf_lifecycle",
      name: "Lifecycle Draft",
      nodes: [
        {
          id: "start_log",
          type: "builtin.log.info",
          message: "start",
        },
      ],
    });
    expect(created).toMatchObject({
      ok: true,
      workflow: { id: "wf_lifecycle", status: "draft" },
    });

    await expect(
      runTool("workflow_get", { workflow_id: "wf_lifecycle" }),
    ).resolves.toMatchObject({
      ok: true,
      workflow: { id: "wf_lifecycle", name: "Lifecycle Draft" },
    });

    await expect(
      runTool("workflow_update", {
        workflow_id: "wf_lifecycle",
        name: "Lifecycle Updated",
      }),
    ).resolves.toMatchObject({
      ok: true,
      workflow: { id: "wf_lifecycle", name: "Lifecycle Updated" },
    });

    await expect(
      runTool("workflow_test_run", { workflow_id: "wf_lifecycle" }),
    ).resolves.toMatchObject({
      ok: true,
      run: { workflowId: "wf_lifecycle", status: "succeeded" },
    });

    await expect(
      runTool("workflow_publish", { workflow_id: "wf_lifecycle" }),
    ).resolves.toMatchObject({
      ok: true,
      workflow: { id: "wf_lifecycle", status: "published" },
    });

    const exported = await runTool("workflow_export", {
      workflow_id: "wf_lifecycle",
    });
    expect(exported).toMatchObject({
      ok: true,
      package: {
        format: "openacme.workflow.definition.v1",
        workflow: { id: "wf_lifecycle" },
      },
    });

    await expect(
      runTool("workflow_import", { package_document: exported.package }),
    ).resolves.toMatchObject({
      ok: true,
      workflow: { name: "Lifecycle Updated", status: "draft" },
    });

    await expect(
      runTool("workflow_list", { status: "draft" }),
    ).resolves.toMatchObject({
      ok: true,
      workflows: expect.arrayContaining([
        expect.objectContaining({ status: "draft" }),
      ]),
    });

    await expect(
      runTool("workflow_delete", { workflow_id: "wf_lifecycle" }),
    ).resolves.toMatchObject({
      ok: true,
      workflow: { id: "wf_lifecycle", status: "archived" },
    });
  });

  it("test-runs until a selected step and evaluates inline assertions", async () => {
    await runTool("workflow_create", {
      id: "wf_stop_after",
      name: "Stop after run",
      nodes: [
        {
          id: "start",
          type: "builtin.log.info",
          message: "start",
          next: ["middle"],
        },
        {
          id: "middle",
          type: "builtin.log.info",
          message: "$.workflowTrigger.input.message",
          next: ["after_middle"],
        },
        {
          id: "after_middle",
          type: "builtin.log.info",
          message: "should not run",
        },
      ],
    });

    const run = await runTool("workflow_test_run", {
      workflow_id: "wf_stop_after",
      input: { message: "stop here" },
      stop_after_step_id: "middle",
      assertions: [
        {
          path: "$.steps.middle.status",
          operator: "equals",
          value: "succeeded",
        },
        {
          path: "$.steps.middle.output.message",
          operator: "contains",
          value: "stop",
        },
      ],
    });

    expect(run).toMatchObject({
      ok: true,
      run: { workflowId: "wf_stop_after", status: "succeeded" },
      assertionResults: {
        ok: true,
        results: [
          { ok: true, path: "$.steps.middle.status" },
          { ok: true, path: "$.steps.middle.output.message" },
        ],
      },
    });
    expect(typeof run.draftHash).toBe("string");
    expect(run.steps.map((step: { nodeId: string }) => step.nodeId)).toEqual([
      "start",
      "middle",
    ]);
  });

  it("requires a successful full test run for the current draft before publishing", async () => {
    await runTool("workflow_create", {
      id: "wf_publish_gate",
      name: "Publish gate",
      nodes: [
        {
          id: "start_log",
          type: "builtin.log.info",
          message: "start",
        },
      ],
    });

    await expect(
      runTool("workflow_publish", { workflow_id: "wf_publish_gate" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "publish_gate_failed" },
      issues: [{ code: "missing_successful_current_draft_test" }],
    });

    await expect(
      runTool("workflow_test_run", {
        workflow_id: "wf_publish_gate",
        stop_after_step_id: "start_log",
      }),
    ).resolves.toMatchObject({
      ok: true,
      run: { status: "succeeded" },
    });

    await expect(
      runTool("workflow_publish", { workflow_id: "wf_publish_gate" }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [{ code: "missing_successful_current_draft_test" }],
    });

    await expect(
      runTool("workflow_test_run", { workflow_id: "wf_publish_gate" }),
    ).resolves.toMatchObject({
      ok: true,
      run: { status: "succeeded" },
    });

    await expect(
      runTool("workflow_update", {
        workflow_id: "wf_publish_gate",
        name: "Publish gate changed",
      }),
    ).resolves.toMatchObject({
      ok: true,
      workflow: { name: "Publish gate changed" },
    });

    await expect(
      runTool("workflow_publish", { workflow_id: "wf_publish_gate" }),
    ).resolves.toMatchObject({
      ok: false,
      issues: [{ code: "missing_successful_current_draft_test" }],
    });

    await expect(
      runTool("workflow_test_run", { workflow_id: "wf_publish_gate" }),
    ).resolves.toMatchObject({
      ok: true,
      run: { status: "succeeded" },
    });

    await expect(
      runTool("workflow_publish", { workflow_id: "wf_publish_gate" }),
    ).resolves.toMatchObject({
      ok: true,
      workflow: { id: "wf_publish_gate", status: "published" },
    });
  });

  it("test-runs a candidate card without saving a workflow", async () => {
    const run = await runTool("workflow_card_test_run", {
      mode: "candidate",
      node: {
        id: "log_candidate",
        type: "builtin.log.info",
        message: "$.workflowTrigger.input.message",
      },
      input: { message: "candidate hello" },
    });

    expect(run).toMatchObject({
      ok: true,
      cardTest: { mode: "candidate", stepId: "log_candidate" },
      run: { status: "succeeded", mode: "test" },
      summary: {
        stepCount: 1,
        steps: [{ stepId: "log_candidate", status: "succeeded" }],
        logs: [{ level: "info", message: "candidate hello" }],
      },
    });

    const detail = await runTool("workflow_run_get", {
      run_id: run.run.id,
      detail: "step",
      step_id: "log_candidate",
      include: ["input", "output", "logs"],
    });
    expect(detail).toMatchObject({
      ok: true,
      steps: [
        {
          nodeId: "log_candidate",
          input: { message: "candidate hello" },
          output: { message: "candidate hello" },
        },
      ],
    });
  });

  it("test-runs a candidate transformer card and returns output.value", async () => {
    const run = await runTool("workflow_card_test_run", {
      mode: "candidate",
      node: {
        id: "resolve_customer",
        type: "builtin.transform.value_resolve",
        transform: {
          kind: "value.resolve",
          value: "$.workflowTrigger.input.customer",
        },
      },
      input: { customer: "Acme" },
    });

    expect(run).toMatchObject({
      ok: true,
      cardTest: { mode: "candidate", stepId: "resolve_customer" },
      summary: {
        stepCount: 1,
        steps: [{ stepId: "resolve_customer", status: "succeeded" }],
      },
    });

    await expect(
      runTool("workflow_run_get", {
        run_id: run.run.id,
        detail: "step",
        step_id: "resolve_customer",
        include: ["output"],
      }),
    ).resolves.toMatchObject({
      ok: true,
      steps: [
        {
          nodeId: "resolve_customer",
          output: { value: "Acme" },
        },
      ],
    });
  });

  it("test-runs a saved workflow card with explicit context", async () => {
    await runTool("workflow_create", {
      id: "wf_card_from_workflow",
      name: "Card from workflow",
      nodes: [
        {
          id: "log_context",
          type: "builtin.log.info",
          message: "$.context.greeting",
        },
      ],
    });

    const run = await runTool("workflow_card_test_run", {
      mode: "from_workflow",
      workflow_id: "wf_card_from_workflow",
      step_id: "log_context",
      context: { greeting: "hello from context" },
    });

    expect(run).toMatchObject({
      ok: true,
      cardTest: {
        mode: "from_workflow",
        sourceWorkflowId: "wf_card_from_workflow",
        stepId: "log_context",
      },
      summary: {
        steps: [{ stepId: "log_context", status: "succeeded" }],
        logs: [{ message: "hello from context" }],
      },
    });
  });

  it("reruns a card using a previous workflow run state", async () => {
    await runTool("workflow_create", {
      id: "wf_card_from_run",
      name: "Card from run",
      nodes: [
        {
          id: "capture_customer",
          type: "builtin.set",
          assign: { customer: "$.workflowTrigger.input.customer" },
          next: ["log_customer"],
        },
        {
          id: "log_customer",
          type: "builtin.log.info",
          message: "$.context.customer",
        },
      ],
    });
    const fullRun = await runTool("workflow_test_run", {
      workflow_id: "wf_card_from_run",
      input: { customer: "Acme" },
    });

    const cardRun = await runTool("workflow_card_test_run", {
      mode: "from_run",
      run_id: fullRun.run.id,
      step_id: "log_customer",
    });

    expect(cardRun).toMatchObject({
      ok: true,
      cardTest: {
        mode: "from_run",
        sourceWorkflowId: "wf_card_from_run",
        sourceRunId: fullRun.run.id,
        stepId: "log_customer",
      },
      summary: {
        stepCount: 1,
        steps: [{ stepId: "log_customer", status: "succeeded" }],
        logs: [{ message: "Acme" }],
      },
    });
  });

  it("persists async test assertions and evaluates them on later run inspection", async () => {
    await runTool("workflow_create", {
      id: "wf_async_assertions",
      name: "Async assertions",
      nodes: [
        {
          id: "wait",
          type: "builtin.sleep",
          delayMs: 25,
          reason: "async assertion test",
        },
      ],
    });

    const started = await runTool("workflow_test_run", {
      workflow_id: "wf_async_assertions",
      async: true,
      assertions: [
        {
          path: "$.steps.wait.output.delayMs",
          operator: "equals",
          value: 25,
        },
      ],
    });

    expect(started).toMatchObject({
      ok: true,
      acceptedAssertions: [
        { path: "$.steps.wait.output.delayMs", operator: "equals", value: 25 },
      ],
    });

    let detail: any = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      detail = await runTool("workflow_run_get", { run_id: started.run.id });
      if (detail.run.status === "succeeded") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    expect(detail).toMatchObject({
      ok: true,
      run: { id: started.run.id, status: "succeeded" },
      assertionResults: {
        ok: true,
        results: [{ ok: true, path: "$.steps.wait.output.delayMs" }],
      },
    });
  });

  it("manages workflow run lifecycle and spilled artifacts through tools", async () => {
    await bootRuntime({
      python: {
        async execute() {
          return { output: "x".repeat(70_000) };
        },
      },
    });
    await runTool("workflow_create", {
      id: "wf_artifact_run",
      name: "Artifact run",
      nodes: [
        {
          id: "large_output",
          type: "builtin.python",
          code: "output = 'x' * 70000",
          timeoutMs: 1000,
        },
      ],
    });

    const run = await runTool("workflow_test_run", {
      workflow_id: "wf_artifact_run",
      input: { marker: "artifact" },
    });
    expect(run).toMatchObject({
      ok: true,
      run: { workflowId: "wf_artifact_run", status: "succeeded" },
    });

    await expect(
      runTool("workflow_run_list", { workflow_id: "wf_artifact_run" }),
    ).resolves.toMatchObject({
      ok: true,
      runs: [expect.objectContaining({ id: run.run.id })],
    });

    const detail = await runTool("workflow_run_get", { run_id: run.run.id });
    expect(detail.artifacts.length).toBeGreaterThan(0);
    await expect(
      runTool("workflow_artifact_get", {
        run_id: run.run.id,
        artifact_id: detail.artifacts[0].id,
      }),
    ).resolves.toMatchObject({ ok: true });

    await expect(
      runTool("workflow_run_rerun", { run_id: run.run.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: { workflowId: "wf_artifact_run", status: "succeeded" },
    });

    await runTool("workflow_create", {
      id: "wf_cancel_tool",
      name: "Cancelable run",
      nodes: [
        {
          id: "wait",
          type: "builtin.sleep",
          delayMs: 10_000,
          reason: "cancel test",
        },
      ],
    });
    const running = await runTool("workflow_test_run", {
      workflow_id: "wf_cancel_tool",
      async: true,
    });
    expect(running).toMatchObject({
      ok: true,
      run: { workflowId: "wf_cancel_tool" },
    });

    await expect(
      runTool("workflow_run_cancel", { run_id: running.run.id }),
    ).resolves.toMatchObject({
      ok: true,
      run: { id: running.run.id, status: "canceled" },
    });
  });

  it("exposes runtime MCP tool and agent inventory", async () => {
    await bootRuntime({
      mcp: {
        async listTools() {
          return [
            {
              server: "qualys",
              tool: "list_assets",
              name: "mcp_qualys__list_assets",
              description: "List Qualys assets",
              inputSchema: { type: "object" },
            },
          ];
        },
        async callTool() {
          return { output: {} };
        },
      },
      hosted: {
        async listTools() {
          return [
            {
              name: "hosted_qualys__qualys_gav_asset_count",
              familyId: "qualys",
              familyName: "Qualys",
              toolName: "qualys_gav_asset_count",
              description: "Count Qualys assets",
              inputSchema: { type: "object" },
            },
          ];
        },
        async callTool() {
          return { output: {} };
        },
      },
      agent: {
        listAgents() {
          return [{ id: "risk-agent", name: "Risk Agent" }];
        },
        async callAgent() {
          return { output: { response: "ok" } };
        },
      },
    });

    await expect(runTool("workflow_tool_inventory", {})).resolves.toMatchObject(
      {
        ok: true,
        tools: [{ server: "qualys", tool: "list_assets" }],
        hostedTools: [
          {
            name: "hosted_qualys__qualys_gav_asset_count",
            familyId: "qualys",
            toolName: "qualys_gav_asset_count",
          },
        ],
      },
    );
    await expect(
      runTool("workflow_agent_inventory", {}),
    ).resolves.toMatchObject({
      ok: true,
      agents: [{ id: "risk-agent", name: "Risk Agent" }],
    });
  });

  it("executes hosted workflow cards through an internal workflow binding", async () => {
    const imported =
      await runtime.hostedIntegrationService.packages.importPackage({
        mode: "create",
        packageDocument: workflowHostedPackageDocument(),
        importedBy: "tool-developer",
        ttlMs: 60_000,
      });
    expect(imported).toMatchObject({
      ok: true,
      draft: { familyId: "workflow_echo" },
      lock: { id: expect.any(String) },
    });
    const draftId = stringField(imported.draft.id);
    const lockId = stringField(imported.lock.id);
    await runtime.hostedIntegrationService.examples.upsertExample({
      draftId,
      lockId,
      example: {
        id: "workflow_echo_smoke",
        familyId: "workflow_echo",
        toolName: "workflow_echo",
        category: "smoke",
        args: { value: "ok" },
        expected: {},
      },
    });
    const validation =
      await runtime.hostedIntegrationService.validator.validateDraft(draftId);
    expect(validation).toMatchObject({ ok: true });
    const source =
      await runtime.hostedIntegrationService.sourceFiles.replaceSourceFiles({
        familyId: "workflow_echo",
        files: await collectHostedDraftFiles(draftId),
        updatedBy: "tool-developer",
      });
    const promoted =
      await runtime.hostedIntegrationService.generations.promoteDraft({
        draftId,
        promotedBy: "tool-developer",
        validation,
        draftRevisionId: stringField(imported.draft.updatedAt),
        sourceRevisionId: source.sourceRevisionId,
      });
    expect(promoted).toMatchObject({ ok: true });

    await expect(runTool("workflow_tool_inventory", {})).resolves.toMatchObject({
      ok: true,
      hostedTools: [
        expect.objectContaining({
          name: "hosted_workflow_echo__workflow_echo",
          familyId: "workflow_echo",
          toolName: "workflow_echo",
        }),
      ],
    });

    await runTool("workflow_create", {
      id: "wf_hosted_internal_binding",
      name: "Hosted internal binding",
      nodes: [
        {
          id: "call_echo",
          type: "hosted.tool",
          toolName: "hosted_workflow_echo__workflow_echo",
          input: { value: "ok" },
        },
      ],
    });
    const run = await runTool("workflow_test_run", {
      workflow_id: "wf_hosted_internal_binding",
      input: {},
    });

    expect(run).toMatchObject({
      ok: true,
      run: { workflowId: "wf_hosted_internal_binding", status: "succeeded" },
      steps: [
        expect.objectContaining({
          nodeId: "call_echo",
          status: "succeeded",
        }),
      ],
    });
  });

  it("rejects unknown MCP tool and agent references during validation", async () => {
    await bootRuntime({
      mcp: {
        async listTools() {
          return [{ server: "qualys", tool: "list_assets", name: "qualys" }];
        },
        async callTool() {
          return { output: {} };
        },
      },
      hosted: {
        async listTools() {
          return [
            {
              name: "hosted_qualys__qualys_gav_asset_count",
              familyId: "qualys",
              toolName: "qualys_gav_asset_count",
            },
          ];
        },
        async callTool() {
          return { output: {} };
        },
      },
      agent: {
        listAgents() {
          return [{ id: "known-agent", name: "Known Agent" }];
        },
        async callAgent() {
          return { output: {} };
        },
      },
    });

    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Bad MCP",
          nodes: [
            { id: "call", type: "mcp.tool", server: "missing", tool: "x" },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "unknown_mcp_tool" },
    });

    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Bad agent",
          nodes: [
            {
              id: "ask",
              type: "agent.call",
              agentId: "missing-agent",
              prompt: "Help",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "unknown_agent" },
    });

    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Bad hosted",
          nodes: [
            {
              id: "hosted",
              type: "hosted.tool",
              toolName: "hosted_missing__tool",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "unknown_hosted_tool" },
    });
  });

  it("rejects unsupported card types and detached graph candidates during validation", async () => {
    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Bad card",
          nodes: [{ id: "bad", type: "builtin.nope" }],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "unsupported_card_type" },
      issues: [{ code: "unsupported_card_type", nodeId: "bad" }],
    });

    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Detached graph",
          nodes: [
            { id: "start_log", type: "builtin.log.info", message: "start" },
            {
              id: "detached_log",
              type: "builtin.log.info",
              message: "detached",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "validation_failed" },
      issues: [
        {
          code: "validation_failed",
          issue: { nodeId: "detached_log", field: "entry" },
        },
      ],
    });
  });

  it("rejects unsupported and unknown workflow reference expressions during validation", async () => {
    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Bad reference family",
          nodes: [
            {
              id: "log_bad_family",
              type: "builtin.log.info",
              message: "$.input.customer",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_reference" },
      issues: [
        {
          severity: "error",
          code: "invalid_reference",
          nodeId: "log_bad_family",
          path: "$.nodes.log_bad_family.message",
        },
      ],
    });

    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Unknown step reference",
          nodes: [
            {
              id: "log_unknown_step",
              type: "builtin.log.info",
              message: "$.steps.normalize.output.value",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_reference" },
      issues: [
        {
          severity: "error",
          code: "invalid_reference",
          nodeId: "log_unknown_step",
          reference: "$.steps.normalize.output.value",
        },
      ],
    });
  });

  it("requires explicit output coverage when an output schema is declared", async () => {
    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Missing output",
          outputSchema: {
            type: "object",
            required: ["result"],
            properties: { result: { type: "string" } },
          },
          nodes: [
            {
              id: "log_only",
              type: "builtin.log.info",
              message: "done",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "missing_output_card" },
      issues: [
        {
          code: "missing_output_card",
          path: "$.outputSchema",
        },
      ],
    });

    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Covered output",
          outputSchema: {
            type: "object",
            required: ["result"],
            properties: { result: { type: "string" } },
          },
          nodes: [
            {
              id: "set_output",
              type: "builtin.output.set",
              path: "result",
              value: "ok",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ ok: true, issues: [] });
  });

  it("validates card configs against card catalog schemas", async () => {
    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Bad card config",
          nodes: [
            {
              id: "pick_fields",
              type: "builtin.transform.object_pick",
              input: { source: "$.workflowTrigger.input.asset" },
              transform: {
                kind: "object_pick",
                source: "source",
              },
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_card_config" },
      issues: [
        {
          severity: "error",
          code: "invalid_card_config",
          nodeId: "pick_fields",
          path: "$.nodes.pick_fields.transform.fields",
        },
      ],
    });
  });

  it("returns warning diagnostics for non-deterministic authoring choices", async () => {
    await bootRuntime({
      agent: {
        listAgents() {
          return [{ id: "known-agent", name: "Known Agent" }];
        },
        async callAgent() {
          return { output: {} };
        },
      },
    });

    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Agent-only transform",
          nodes: [
            {
              id: "ask_agent",
              type: "agent.call",
              agentId: "known-agent",
              prompt: "Extract the hostname from $.workflowTrigger.input.url",
              input: { url: "$.workflowTrigger.input.url" },
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: true,
      issues: [],
      warnings: [
        {
          severity: "warning",
          code: "deterministic_first",
          nodeId: "ask_agent",
          path: "$.nodes.ask_agent",
        },
      ],
    });
  });

  it("rejects parallel and foreach child routes that escape their parent scope", async () => {
    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Parallel escape",
          nodes: [
            {
              id: "parallel",
              type: "builtin.parallel",
              branches: [{ id: "branch_a", nodes: ["branch_log"] }],
              next: ["after_parallel"],
            },
            {
              id: "branch_log",
              type: "builtin.log.info",
              message: "branch",
              next: ["after_parallel"],
            },
            {
              id: "after_parallel",
              type: "builtin.log.info",
              message: "after",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_route_scope" },
      issues: [
        {
          code: "invalid_route_scope",
          nodeId: "branch_log",
          path: "$.nodes.parallel.branches.branch_a.nodes",
        },
      ],
    });

    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Foreach escape",
          nodes: [
            {
              id: "each",
              type: "builtin.foreach",
              items: "$.workflowTrigger.input.items",
              body: ["body_start"],
              next: ["after_each"],
            },
            {
              id: "body_start",
              type: "builtin.log.info",
              message: "body",
              next: ["after_each"],
            },
            {
              id: "after_each",
              type: "builtin.log.info",
              message: "after",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_route_scope" },
      issues: [
        {
          code: "invalid_route_scope",
          nodeId: "body_start",
          path: "$.nodes.each.body",
        },
      ],
    });

    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Scoped foreach",
          nodes: [
            {
              id: "each",
              type: "builtin.foreach",
              items: "$.workflowTrigger.input.items",
              body: ["body_start"],
              next: ["after_each"],
            },
            {
              id: "body_start",
              type: "builtin.log.info",
              message: "body",
              next: ["body_end"],
            },
            {
              id: "body_end",
              type: "builtin.log.info",
              message: "body done",
            },
            {
              id: "after_each",
              type: "builtin.log.info",
              message: "after",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ ok: true, issues: [] });
  });

  it("rejects if and switch branch routes that escape their parent scope", async () => {
    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "If branch escapes",
          nodes: [
            {
              id: "gate",
              type: "builtin.if",
              condition: "$.workflowTrigger.input.enabled == true",
              then: ["true_log"],
              else: ["false_log"],
              next: ["after_gate"],
            },
            {
              id: "true_log",
              type: "builtin.log.info",
              message: "true",
              next: ["after_gate"],
            },
            {
              id: "false_log",
              type: "builtin.log.info",
              message: "false",
            },
            {
              id: "after_gate",
              type: "builtin.log.info",
              message: "after",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_route_scope" },
      issues: [
        {
          code: "invalid_route_scope",
          nodeId: "true_log",
          path: "$.nodes.gate.then",
          reference: "after_gate",
        },
      ],
    });

    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Switch branch escapes",
          nodes: [
            {
              id: "kind_switch",
              type: "builtin.switch",
              value: "$.workflowTrigger.input.kind",
              cases: [
                { id: "case_a", value: "a", nodes: ["case_a_log"] },
                { id: "case_b", value: "b", nodes: ["case_b_log"] },
              ],
            },
            {
              id: "case_a_log",
              type: "builtin.log.info",
              message: "a",
              next: ["case_b_log"],
            },
            {
              id: "case_b_log",
              type: "builtin.log.info",
              message: "b",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "invalid_route_scope" },
      issues: [
        {
          code: "invalid_route_scope",
          nodeId: "case_a_log",
          path: "$.nodes.kind_switch.cases.case_a.nodes",
          reference: "case_b_log",
        },
      ],
    });

    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Branch merge",
          nodes: [
            {
              id: "gate",
              type: "builtin.if",
              condition: "$.workflowTrigger.input.enabled == true",
              then: ["true_log"],
              else: ["false_log"],
            },
            {
              id: "true_log",
              type: "builtin.log.info",
              message: "true",
              next: ["merged"],
            },
            {
              id: "false_log",
              type: "builtin.log.info",
              message: "false",
              next: ["merged"],
            },
            {
              id: "merged",
              type: "builtin.log.info",
              message: "merged",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({ ok: true, issues: [] });
  });

  it("rejects duplicated explicit route ownership", async () => {
    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Duplicate branch owner",
          nodes: [
            {
              id: "gate",
              type: "builtin.if",
              condition: "$.workflowTrigger.input.enabled == true",
              then: ["shared_start"],
              else: ["shared_start"],
            },
            {
              id: "shared_start",
              type: "builtin.log.info",
              message: "shared",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "duplicate_route_ownership" },
      issues: [
        {
          code: "duplicate_route_ownership",
          nodeId: "shared_start",
          path: "$.nodes.gate.else",
          reference: "then",
        },
      ],
    });

    await expect(
      runTool("workflow_validate", {
        mode: "candidate",
        candidate: {
          name: "Duplicate parallel owner",
          nodes: [
            {
              id: "parallel",
              type: "builtin.parallel",
              branches: [
                { id: "branch_a", nodes: ["shared_start"] },
                { id: "branch_b", nodes: ["shared_start"] },
              ],
            },
            {
              id: "shared_start",
              type: "builtin.log.info",
              message: "shared",
            },
          ],
        },
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "duplicate_route_ownership" },
      issues: [
        {
          code: "duplicate_route_ownership",
          nodeId: "shared_start",
          path: "$.nodes.parallel.branches.branch_b.nodes",
          reference: "branch_a",
        },
      ],
    });
  });

  it("denies agents that do not have the workflow tool enabled", async () => {
    const result = await runTool("workflow_list", {}, "unknown-agent");

    expect(result).toMatchObject({
      ok: false,
      error: { code: "policy_denied" },
    });
  });

  it("lets normal agents discover and run only published workflow callables", async () => {
    await createWorkflowConsumerAgent("workflow-consumer");

    await runTool("workflow_create", {
      id: "wf_consumer_draft",
      name: "Consumer Draft",
      nodes: [{ id: "log", type: "builtin.log.info", message: "draft" }],
    });

    await runTool("workflow_create", {
      id: "wf_consumer_published",
      name: "Consumer Published",
      description: "Returns a stable greeting.",
      inputSchema: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
      outputSchema: {
        type: "object",
        required: ["greeting"],
        properties: { greeting: { type: "string" } },
      },
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [
        {
          id: "set_output",
          type: "builtin.output.set",
          path: "greeting",
          value: "$.workflowTrigger.input.name",
        },
      ],
    });
    await runTool("workflow_test_run", {
      workflow_id: "wf_consumer_published",
      input: { name: "Ada" },
    });
    await runTool("workflow_publish", {
      workflow_id: "wf_consumer_published",
    });

    await expect(
      runTool("workflow_callable_list", {}, "workflow-consumer"),
    ).resolves.toMatchObject({
      ok: true,
      workflows: [
        {
          id: "wf_consumer_published",
          name: "Consumer Published",
          status: "published",
          inputSchema: {
            type: "object",
            required: ["name"],
          },
          outputSchema: {
            type: "object",
            required: ["greeting"],
          },
        },
      ],
    });

    await expect(
      runTool(
        "workflow_help",
        { target: { kind: "output_schema" } },
        "workflow-consumer",
      ),
    ).resolves.toMatchObject({
      ok: true,
      target: { kind: "output_schema" },
    });

    await expect(
      runTool(
        "workflow_callable_get",
        { workflow_id: "wf_consumer_draft" },
        "workflow-consumer",
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "not_published" },
    });

    const run = await runTool(
      "workflow_run",
      { workflow_id: "wf_consumer_published", input: { name: "Ada" } },
      "workflow-consumer",
    );

    expect(run).toMatchObject({
      ok: true,
      run: {
        workflowId: "wf_consumer_published",
        mode: "live",
        definitionSource: "published",
        status: "succeeded",
      },
      output: { greeting: "Ada" },
    });

    await expect(
      runTool(
        "workflow_run_get",
        { run_id: run.run.id, detail: "summary" },
        "workflow-consumer",
      ),
    ).resolves.toMatchObject({
      ok: true,
      run: {
        id: run.run.id,
        workflowId: "wf_consumer_published",
        mode: "live",
      },
      summary: { status: "succeeded" },
    });

    await expect(
      runTool(
        "workflow_update",
        { workflow_id: "wf_consumer_published", name: "Mutated" },
        "workflow-consumer",
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "policy_denied" },
    });
  });
});

async function bootRuntime(workflowExecutionPorts?: WorkflowExecutionPorts) {
  await closeApp?.();
  const created = await createApp(
    ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    }),
    { workflowExecutionPorts },
  );
  runtime = created.runtime;
  closeApp = created.close;
}

async function runTool(
  name: string,
  args: Record<string, unknown>,
  actorId = "web-settings",
) {
  const tool = toolRegistry.get(name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  const output = await toolCallContext.run(
    {
      agentId: actorId,
      sessionId: "session_1",
      workspaceDir: "/tmp/openacme",
    },
    () => tool.handler(args),
  );
  return JSON.parse(output);
}

async function createWorkflowConsumerAgent(id: string) {
  await runtime.agentManager.createAgent(
    AgentDefinitionSchema.parse({
      id,
      name: "Workflow Consumer",
      role: "Runs published workflows.",
      tools: [...WORKFLOW_CONSUMER_TOOL_NAMES],
      mcpServers: {},
      mcpDisabled: [],
      skills: [],
    }),
  );
}

function stringField(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("expected string field");
  }
  return value;
}

async function collectHostedDraftFiles(draftId: string) {
  const listed =
    await runtime.hostedIntegrationService.drafts.listDraftFiles(draftId);
  if (!listed.ok) throw new Error("failed to list hosted draft files");
  const files: Record<string, string> = {};
  for (const file of listed.files) {
    const read = await runtime.hostedIntegrationService.drafts.readDraftFile({
      draftId,
      path: file.path,
    });
    if (!read.ok) throw new Error("failed to read hosted draft file");
    files[file.path] = read.content;
  }
  return files;
}

function workflowHostedPackageDocument(): Record<string, unknown> {
  const files = withSplitToolContractFiles({
    "family.yaml": [
      "id: workflow_echo",
      "name: Workflow Echo",
      "version: 1",
      "runtime:",
      "  language: python",
      "  entrypoint: workflow_echo.py",
      "  defaultTimeoutMs: 30000",
      "  inlineResultTokenLimit: 8000",
      "  maxConcurrency: 1",
      "  runtimePolicy:",
      "    filesystem: run_dir_and_family_home",
      "    processEnv: tool_context_only",
      "    subprocess: denied",
      "    network: denied",
      "  dependencyPolicy:",
      "    installDuringInvocation: false",
      "    allowedPackages: []",
      "runtimeConfig:",
      "  requiredConfigKeys: []",
      "  requiredSecretKeys: []",
      "tools:",
      "  - name: workflow_echo",
      "    title: Workflow Echo",
      "    description: Echo workflow-hosted invocation arguments.",
      "    inputSchema:",
      "      type: object",
      "      properties:",
      "        value:",
      "          type: string",
      "      additionalProperties: false",
      "    classification:",
      "      operation: read",
      "      freshness: live",
      "      idempotency: idempotent",
      "      execution: sync",
      "      approval: none",
      "",
    ].join("\n"),
    "workflow_echo.py": [
      "def authenticate(ctx):",
      "    return {}",
      "",
      "def before_tool_call(tool_name, args, ctx, auth):",
      "    return args",
      "",
      "def after_tool_call(tool_name, args, ctx, result, auth):",
      "    return result",
      "",
      "def tool_workflow_echo(args, context):",
      "    return {'echo': args}",
      "",
    ].join("\n"),
  });
  return {
    kind: "openacme.hostedFamilyPackage",
    version: 1,
    metadata: { familyId: "workflow_echo" },
    files: Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      content,
    })),
  };
}
