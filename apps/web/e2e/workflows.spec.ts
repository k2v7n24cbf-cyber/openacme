import { test, expect, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

test("renders workflow canvas and opens selected node inspector", async ({
  page,
  request,
}) => {
  const workflowId = `wf_ui_canvas_${Date.now().toString(36)}`;

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Canvas Smoke",
      triggers: [{ id: "manual_review", kind: "manual", enabled: true }],
      nodes: [
        {
          id: "branch",
          type: "builtin.if_else",
          condition: "$.workflowTrigger.input.risky",
          then: ["call_mcp"],
          else: ["call_agent"],
        },
        {
          id: "call_mcp",
          type: "mcp.tool",
          server: "demo",
          tool: "echo",
          input: { message: "$.workflowTrigger.input.message" },
        },
        {
          id: "call_agent",
          type: "agent.call",
          agentId: "demo-agent",
          prompt: "Review $.workflowTrigger.input",
          input: { payload: "$.workflowTrigger.input" },
        },
        {
          id: "each_item",
          type: "builtin.foreach",
          items: "$.workflowTrigger.input.items",
          itemVar: "item",
          body: ["python_score"],
        },
        {
          id: "python_score",
          type: "builtin.python",
          input: { item: "$.context.item" },
          code: "result = input",
        },
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.context",
        },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto(`/workflows?id=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Canvas Smoke" }),
  ).toBeVisible();
  await expect(page.getByLabel("Workflow List", { exact: true })).toContainText(
    "Workflow Canvas Smoke",
  );

  const canvas = page.getByLabel("Workflow Canvas", { exact: true });
  await expect(canvas).toContainText("branch");
  await expect(canvas).toContainText("call_mcp");
  await expect(canvas).toContainText("call_agent");
  await expect(canvas).toContainText("each_item");

  await canvas.locator('[data-workflow-canvas-node-id="branch"]').click();
  const inspector = page.getByLabel("Workflow Inspector", { exact: true });
  await expect(inspector).toContainText("branch");
  await expect(inspector).toContainText("builtin.if_else");

  await canvas.locator('[data-workflow-canvas-node-id="call_mcp"]').click();
  await expect(inspector).toContainText("call_mcp");
  await expect(inspector).toContainText("mcp.tool");

  await expect(page.getByLabel("Run Console", { exact: true })).toBeHidden();

  await page.getByRole("tab", { name: "Run History", exact: true }).click();
  await expect(page.getByLabel("Run Console", { exact: true })).toBeVisible();
  await expect(canvas).toContainText("branch");

  await page
    .getByRole("button", { name: "Exit Run History", exact: true })
    .click();
  await expect(page.getByLabel("Run Console", { exact: true })).toBeHidden();

  await page
    .getByRole("button", { name: "Workflow settings", exact: true })
    .click();
  await expect(
    page.getByRole("tab", { name: "Test Configuration", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await page
    .getByLabel("Run input", { exact: true })
    .fill(JSON.stringify({ risky: true, message: "hello" }, null, 2));
  await expect(page.getByLabel("Run input", { exact: true })).toHaveValue(
    /"message": "hello"/,
  );
});

test("starts new workflows empty and opens the manual trigger picker", async ({
  page,
}) => {
  await page.goto("/workflows");
  await page.getByRole("button", { name: "New", exact: true }).click();

  const canvas = page.getByLabel("Workflow Canvas", { exact: true });
  await expect(canvas).toContainText("0 nodes");
  await expect(canvas).not.toContainText("set_customer");
  await expect(canvas).not.toContainText("normalize");

  const dialog = page.getByRole("dialog", {
    name: "Select Trigger",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("heading", { name: "Select Trigger" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "Trigger", exact: true }),
  ).toBeHidden();
  await expect(
    dialog.getByRole("button", { name: "Built-in", exact: true }),
  ).toBeHidden();
  await expect(
    dialog.getByRole("button", { name: "Logic", exact: true }),
  ).toBeHidden();
  await expect(
    dialog.getByRole("button", { name: "Manual Trigger", exact: true }),
  ).toBeEnabled();
  await dialog
    .getByRole("button", { name: "Manual Trigger", exact: true })
    .click();
  await expect(dialog).toBeHidden();
  await expect(canvas).toContainText("manual:manual");
});

test("deletes workflow from the list and keeps archived API history", async ({
  page,
  request,
}) => {
  const workflowId = `wf_ui_delete_${Date.now().toString(36)}`;
  const workflowName = "Workflow Delete Smoke";

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: workflowName,
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [{ id: "exit", type: "builtin.exit", status: "succeeded" }],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto(`/workflows?id=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: workflowName }),
  ).toBeVisible();
  const workflowList = page.getByLabel("Workflow List", { exact: true });
  await expect(workflowList).toContainText(workflowName);

  page.once("dialog", (dialog) => dialog.accept());
  await workflowList
    .getByRole("button", { name: `Delete workflow ${workflowName}` })
    .click();

  await expect(workflowList).not.toContainText(workflowName);
  const archived = await request.get("/api/workflows?status=archived");
  expect(archived.ok(), await archived.text()).toBeTruthy();
  const archivedBody = (await archived.json()) as {
    workflows: Array<{ id: string; status: string }>;
  };
  expect(archivedBody.workflows).toContainEqual(
    expect.objectContaining({ id: workflowId, status: "archived" }),
  );
});

test("edits selected workflow canvas node settings from inspector", async ({
  page,
  request,
}) => {
  const workflowId = `wf_ui_canvas_inspector_${Date.now().toString(36)}`;

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Canvas Inspector Edit",
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [
        {
          id: "set_customer",
          type: "builtin.set",
          assign: { customer: "$.workflowTrigger.input.customer" },
        },
        {
          id: "normalize",
          type: "builtin.transform.object_pick",
          input: { customer: "$.context.customer" },
          transform: {
            kind: "object_pick",
            source: "customer",
            fields: ["id", "name"],
          },
        },
        {
          id: "if_else",
          type: "builtin.if_else",
          condition: "$.workflowTrigger.input.risky",
          then: ["mcp_echo"],
          else: ["agent_review"],
        },
        {
          id: "mcp_echo",
          type: "mcp.tool",
          server: "demo",
          tool: "echo",
          input: { message: "$.workflowTrigger.input.message" },
        },
        {
          id: "agent_review",
          type: "agent.call",
          agentId: "demo-agent",
          prompt: "Review $.workflowTrigger.input",
          input: { payload: "$.workflowTrigger.input" },
        },
        {
          id: "foreach_items",
          type: "builtin.foreach",
          items: "$.workflowTrigger.input.items",
          itemVar: "item",
          body: ["python_score"],
        },
        {
          id: "python_score",
          type: "builtin.python",
          input: { item: "$.context.item" },
          code: "result = input",
        },
        {
          id: "log_done",
          type: "builtin.log.info",
          message: "done",
          payload: "$.context",
        },
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.context",
        },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto(`/workflows?id=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Canvas Inspector Edit" }),
  ).toBeVisible();

  const canvas = page.getByLabel("Workflow Canvas", { exact: true });
  const inspector = page.getByLabel("Workflow Inspector", { exact: true });

  await canvas.locator('[data-workflow-canvas-node-id="set_customer"]').click();
  let settings = inspector.getByLabel("Inspector settings set_customer");
  await settings
    .getByLabel("set_customer assignment target")
    .fill("review.customer");
  await settings
    .getByLabel("set_customer assignment source")
    .fill("$.workflowTrigger.input.reviewCustomer");
  await settings.getByLabel("set_customer card label").fill("Load customer");

  await canvas.locator('[data-workflow-canvas-node-id="if_else"]').click();
  settings = inspector.getByLabel("Inspector settings if_else");
  await expect(settings.getByLabel("if_else branch condition")).toHaveValue(
    "$.workflowTrigger.input.risky",
  );
  await settings
    .getByLabel("if_else branch condition")
    .fill("$.workflowTrigger.input.riskScore >= 70");

  await canvas.locator('[data-workflow-canvas-node-id="mcp_echo"]').click();
  settings = inspector.getByLabel("Inspector settings mcp_echo");
  await settings
    .getByLabel("mcp_echo MCP input JSON")
    .fill(JSON.stringify({ message: "$.workflowTrigger.input.reviewMessage" }, null, 2));

  await canvas.locator('[data-workflow-canvas-node-id="agent_review"]').click();
  settings = inspector.getByLabel("Inspector settings agent_review");
  await settings
    .getByLabel("agent_review agent prompt")
    .fill("Review customer risk");

  await canvas
    .locator('[data-workflow-canvas-node-id="foreach_items"]')
    .click();
  settings = inspector.getByLabel("Inspector settings foreach_items");
  await expect(settings.getByLabel("foreach_items foreach items")).toHaveValue(
    "$.workflowTrigger.input.items",
  );

  await canvas.locator('[data-workflow-canvas-node-id="python_score"]').click();
  settings = inspector.getByLabel("Inspector settings python_score");
  await settings
    .getByLabel("python_score python code")
    .fill("result = {'score': input['item']}");

  await canvas.locator('[data-workflow-canvas-node-id="log_done"]').click();
  settings = inspector.getByLabel("Inspector settings log_done");
  await expect(settings.getByText("Basics")).toBeVisible();
  const logSection = settings.getByText("Log", { exact: true }).last();
  await logSection.click();
  await expect(settings.getByLabel("log_done log message")).toBeHidden();
  await logSection.click();
  await expect(settings.getByLabel("log_done log message")).toHaveValue("done");

  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect
    .poll(async () => {
      const detail = await request.get(`/api/workflows/${workflowId}`);
      expect(detail.ok(), await detail.text()).toBeTruthy();
      const payload = (await detail.json()) as {
        workflow: {
          nodes: Array<{
            id: string;
            label?: string;
            assign?: Record<string, unknown>;
            condition?: string;
            input?: unknown;
            prompt?: string;
            code?: string;
          }>;
        };
      };
      return payload.workflow.nodes;
    })
    .toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "set_customer",
          label: "Load customer",
          assign: { "review.customer": "$.workflowTrigger.input.reviewCustomer" },
        }),
        expect.objectContaining({
          id: "if_else",
          condition: "$.workflowTrigger.input.riskScore >= 70",
        }),
        expect.objectContaining({
          id: "mcp_echo",
          input: { message: "$.workflowTrigger.input.reviewMessage" },
        }),
        expect.objectContaining({
          id: "agent_review",
          prompt: "Review customer risk",
        }),
        expect.objectContaining({
          id: "python_score",
          code: "result = {'score': input['item']}",
        }),
      ]),
    );
});

test("edits a transform card with a preset and verifies test run output", async ({
  page,
  request,
}) => {
  const workflowId = `wf_ui_transform_preset_${Date.now().toString(36)}`;

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Transform Preset Smoke",
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [
        {
          id: "normalize",
          type: "builtin.transform.value_resolve",
          transform: { kind: "value.resolve", value: "$.workflowTrigger.input.value" },
          assign: {
            value: "$.steps.normalize.output",
          },
        },
        {
          id: "log_value",
          type: "builtin.log.info",
          message: "normalized",
          payload: "$.context.value",
        },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto(`/workflows?id=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Transform Preset Smoke" }),
  ).toBeVisible();

  const canvas = page.getByLabel("Workflow Canvas", { exact: true });
  await canvas.locator('[data-workflow-canvas-node-id="normalize"]').click();
  const settings = page
    .getByLabel("Workflow Inspector", { exact: true })
    .getByLabel("Inspector settings normalize");
  await settings
    .getByRole("combobox", { name: "normalize transform preset" })
    .click();
  await page.getByRole("option", { name: "String Replace" }).click();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect
    .poll(async () => {
      const detail = await request.get(`/api/workflows/${workflowId}`);
      expect(detail.ok(), await detail.text()).toBeTruthy();
      const payload = (await detail.json()) as {
        workflow: {
          nodes: Array<{ id: string; transform?: unknown }>;
        };
      };
      return payload.workflow.nodes.find((node) => node.id === "normalize")
        ?.transform;
    })
    .toEqual({
      kind: "string.replace",
      value: "$.workflowTrigger.input.value",
      search: "old",
      replacement: "new",
      all: true,
    });

  await page
    .getByLabel("Run input")
    .fill(JSON.stringify({ value: "old asset old" }, null, 2));
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(
    page.getByText("Test run complete", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Run Console", { exact: true })).toContainText(
    "new asset new",
  );
});

test("creates workflow nodes from canvas palette and reorders selected node", async ({
  page,
  request,
}) => {
  const workflowId = `wf_ui_canvas_palette_${Date.now().toString(36)}`;

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Canvas Palette Smoke",
      triggers: [],
      nodes: [],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto(`/workflows?id=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Canvas Palette Smoke" }),
  ).toBeVisible();

  const canvas = page.getByLabel("Workflow Canvas", { exact: true });
  await expect(canvas).not.toContainText("manual:manual");
  await addWorkflowStep(page, canvas, null, "Manual Trigger");
  await expect(canvas).toContainText("manual:manual");
  await expect(
    canvas.locator('[data-workflow-add-after="trigger:manual"]'),
  ).toBeVisible();
  await addWorkflowStep(page, canvas, "trigger:manual", "Set");
  await expect(
    canvas.locator('[aria-label="Edge from trigger:manual to set_01"]'),
  ).toHaveCount(1);
  await expect(
    canvas.locator('[data-workflow-add-after="set_01"]'),
  ).toBeVisible();
  await addWorkflowStep(page, canvas, "set_01", "Transform");
  await expect(canvas).toContainText("2 edges");
  await expect(canvas).not.toContainText("next");
  await expect
    .poll(() => canvas.locator(".react-flow__edge-path").count())
    .toBe(2);
  await expect
    .poll(async () =>
      canvas.locator(".react-flow__edge-path").evaluateAll((paths) =>
        paths.every((path) => {
          const style = window.getComputedStyle(path);
          const strokeWidth = Number.parseFloat(style.strokeWidth);
          return (
            (path.getAttribute("d") ?? "").length > 0 &&
            style.stroke !== "none" &&
            Number.isFinite(strokeWidth) &&
            strokeWidth > 0
          );
        }),
      ),
    )
    .toBe(true);
  await addWorkflowStep(page, canvas, "transform_02", "MCP Tool");
  await addWorkflowStep(page, canvas, "mcp_demo_echo_03", "Agent Call");
  await addWorkflowStep(page, canvas, null, "If");
  await addWorkflowStep(page, canvas, null, "Foreach");
  await addWorkflowStep(page, canvas, null, "Log");

  await expect(canvas).toContainText("set_01");
  await expect(canvas).toContainText("transform_02");
  await expect(canvas).toContainText("mcp_demo_echo_03");
  await expect(canvas).toContainText(/agent_[A-Za-z0-9_]+_04/);
  await expect(canvas).toContainText("if_05");
  await expect(canvas).toContainText("foreach_06");
  await expect(canvas).toContainText("log_07");
  await expect(canvas).not.toContainText("exit_");

  await canvas.locator('[data-workflow-canvas-node-id="set_01"]').click();
  await canvas
    .getByRole("button", {
      name: "Clone workflow step set_01",
      exact: true,
    })
    .click();
  await expect(canvas).toContainText("set_01_copy");
  await canvas.locator('[data-workflow-canvas-node-id="set_01_copy"]').click();
  await canvas
    .getByRole("button", {
      name: "Delete workflow step set_01_copy",
      exact: true,
    })
    .click();
  await expect(canvas).not.toContainText("set_01_copy");

  await canvas
    .locator('[data-workflow-canvas-node-id="mcp_demo_echo_03"]')
    .click();
  await page
    .getByLabel("Inspector settings mcp_demo_echo_03")
    .getByLabel("mcp_demo_echo_03 MCP input JSON")
    .fill(
      JSON.stringify(
        {
          message: "$.context.value",
          customerId: "$.workflowTrigger.input.customerId",
        },
        null,
        2,
      ),
    );

  await canvas.locator('[data-workflow-canvas-node-id="log_07"]').click();
  await canvas
    .getByRole("button", {
      name: "Move selected workflow node up",
      exact: true,
    })
    .click();

  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect
    .poll(async () => {
      const detail = await request.get(`/api/workflows/${workflowId}`);
      expect(detail.ok(), await detail.text()).toBeTruthy();
      const payload = (await detail.json()) as {
        workflow: {
          nodes: Array<{
            id: string;
            type: string;
            server?: string;
            tool?: string;
            agentId?: string;
            input?: unknown;
          }>;
        };
      };
      return payload.workflow.nodes;
    })
    .toEqual([
      expect.objectContaining({ id: "set_01", type: "builtin.set" }),
      expect.objectContaining({
        id: "transform_02",
        type: "builtin.transform.value_resolve",
      }),
      expect.objectContaining({
        id: "mcp_demo_echo_03",
        type: "mcp.tool",
        server: "demo",
        tool: "echo",
        input: {
          message: "$.context.value",
          customerId: "$.workflowTrigger.input.customerId",
        },
      }),
      expect.objectContaining({
        id: expect.stringMatching(/^agent_[A-Za-z0-9_]+_04$/),
        type: "agent.call",
        agentId: expect.any(String),
      }),
      expect.objectContaining({ id: "if_05", type: "builtin.if" }),
      expect.objectContaining({ id: "log_07", type: "builtin.log.info" }),
      expect.objectContaining({ id: "foreach_06", type: "builtin.foreach" }),
    ]);

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText(/Published v\d+/)).toBeVisible();
  await page.getByLabel("Run input").fill(
    JSON.stringify(
      {
        value: "palette value",
        customerId: "cust_palette",
        enabled: false,
        items: [],
      },
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(
    page.getByText("Test run complete", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Run Console", { exact: true })).toContainText(
    "succeeded",
  );
});

test("autosaves unsaved draft nodes before starting a test run", async ({
  page,
  request,
}) => {
  const workflowId = `wf_ui_autosave_test_${Date.now().toString(36)}`;

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Autosave Test Run",
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  const patchBodies: Array<{ nodes?: Array<{ id: string; type: string }> }> =
    [];
  await page.route(`**/api/workflows/${workflowId}`, async (route) => {
    if (route.request().method() === "PATCH") {
      patchBodies.push(
        route.request().postDataJSON() as {
          nodes?: Array<{ id: string; type: string }>;
        },
      );
    }
    await route.continue();
  });

  await page.goto(`/workflows?id=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Autosave Test Run" }),
  ).toBeVisible();

  const canvas = page.getByLabel("Workflow Canvas", { exact: true });
  await addWorkflowStep(page, canvas, "trigger:manual", "Log");
  await expect(
    canvas.locator('[data-workflow-canvas-node-id="log_01"]'),
  ).toBeVisible();

  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByText("Test run started", { exact: true })).toBeVisible();
  expect(patchBodies).toContainEqual(
    expect.objectContaining({
      nodes: expect.arrayContaining([
        expect.objectContaining({ id: "log_01", type: "builtin.log.info" }),
      ]),
    }),
  );

  await expect
    .poll(async () => {
      const detail = await request.get(`/api/workflows/${workflowId}`);
      expect(detail.ok(), await detail.text()).toBeTruthy();
      const payload = (await detail.json()) as {
        workflow: { nodes: Array<{ id: string; type: string }> };
      };
      return payload.workflow.nodes;
    })
    .toContainEqual(
      expect.objectContaining({ id: "log_01", type: "builtin.log.info" }),
    );

  await expect
    .poll(() => new URL(page.url()).searchParams.get("run"))
    .not.toBeNull();
  const runId = new URL(page.url()).searchParams.get("run");
  expect(runId).not.toBeNull();
  const workflowRunId = runId ?? "";
  await expect
    .poll(async () => {
      const detail = await request.get(`/api/workflow-runs/${workflowRunId}`);
      expect(detail.ok(), await detail.text()).toBeTruthy();
      const payload = (await detail.json()) as {
        run: { status: string };
        steps: Array<{ nodeId: string; status: string }>;
      };
      return {
        runStatus: payload.run.status,
        logStep: payload.steps.find((step) => step.nodeId === "log_01"),
      };
    })
    .toMatchObject({
      runStatus: "succeeded",
      logStep: { nodeId: "log_01", status: "succeeded" },
    });
});

test("saves edited card settings before the next test run", async ({
  page,
  request,
}) => {
  const workflowId = `wf_ui_save_card_settings_${Date.now().toString(36)}`;

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Save Card Settings",
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [
        {
          id: "log_01",
          type: "builtin.log.info",
          message: "old message",
        },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  const patchBodies: Array<{
    nodes?: Array<{ id: string; message?: string }>;
  }> = [];
  await page.route(`**/api/workflows/${workflowId}`, async (route) => {
    if (route.request().method() === "PATCH") {
      patchBodies.push(
        route.request().postDataJSON() as {
          nodes?: Array<{ id: string; message?: string }>;
        },
      );
    }
    await route.continue();
  });

  await page.goto(`/workflows?id=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Save Card Settings" }),
  ).toBeVisible();

  const canvas = page.getByLabel("Workflow Canvas", { exact: true });
  await canvas.locator('[data-workflow-canvas-node-id="log_01"]').click();
  await page
    .getByLabel("Inspector settings log_01")
    .getByLabel("log_01 log message")
    .fill("new message from card settings");
  await page.getByRole("button", { name: "Save", exact: true }).click();

  expect(patchBodies).toContainEqual(
    expect.objectContaining({
      nodes: expect.arrayContaining([
        expect.objectContaining({
          id: "log_01",
          message: "new message from card settings",
        }),
      ]),
    }),
  );

  await expect
    .poll(async () => {
      const detail = await request.get(`/api/workflows/${workflowId}`);
      expect(detail.ok(), await detail.text()).toBeTruthy();
      const payload = (await detail.json()) as {
        workflow: { nodes: Array<{ id: string; message?: string }> };
      };
      return payload.workflow.nodes.find((node) => node.id === "log_01")
        ?.message;
    })
    .toBe("new message from card settings");

  await page.getByRole("button", { name: "Test", exact: true }).click();

  await expect
    .poll(() => new URL(page.url()).searchParams.get("run"))
    .not.toBeNull();
  const runId = new URL(page.url()).searchParams.get("run");
  await expect
    .poll(async () => {
      const detail = await request.get(`/api/workflow-runs/${runId}`);
      expect(detail.ok(), await detail.text()).toBeTruthy();
      const payload = (await detail.json()) as {
        steps: Array<{
          nodeId: string;
          status: string;
          input?: { message?: string };
          logsSummary?: unknown;
        }>;
      };
      return payload.steps.find((step) => step.nodeId === "log_01");
    })
    .toMatchObject({
      nodeId: "log_01",
      status: "succeeded",
      input: { message: "new message from card settings" },
    });
});

test("connects if-else branch references visually from the workflow canvas", async ({
  page,
  request,
}) => {
  const workflowId = `wf_ui_canvas_edges_${Date.now().toString(36)}`;

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Canvas Edge Smoke",
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.risky == true",
          then: [],
          else: [],
        },
        {
          id: "manual_review",
          type: "builtin.log.info",
          message: "manual review",
        },
        {
          id: "auto_approve",
          type: "builtin.log.info",
          message: "auto approve",
        },
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.context",
        },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto(`/workflows?id=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Canvas Edge Smoke" }),
  ).toBeVisible();

  const canvas = page.getByLabel("Workflow Canvas", { exact: true });
  await expect(
    canvas.locator('[data-workflow-add-branch="branch:then"]'),
  ).toBeVisible();
  await expect(
    canvas
      .locator('[data-workflow-add-branch="branch:then"]')
      .locator("xpath=.."),
  ).toContainText("true");
  await expect(
    canvas.locator('[data-workflow-add-branch="branch:else"]'),
  ).toBeVisible();
  await expect(
    canvas
      .locator('[data-workflow-add-branch="branch:else"]')
      .locator("xpath=.."),
  ).toContainText("false");
  await expect(
    canvas.locator('[aria-label="Edge from branch to manual_review"]'),
  ).toHaveCount(0);
  await addWorkflowStep(page, canvas, "branch", "Set", "true");
  await addWorkflowStep(page, canvas, "branch", "Log", "false");
  await clickWorkflowHandles(
    canvas.locator('[data-workflow-source-handle="branch:then"]'),
    canvas.locator('[data-workflow-target-handle="manual_review"]'),
  );
  await clickWorkflowHandles(
    canvas.locator('[data-workflow-source-handle="branch:else"]'),
    canvas.locator('[data-workflow-target-handle="auto_approve"]'),
  );

  await canvas.locator('[data-workflow-canvas-node-id="branch"]').click();
  const branchSettings = page.getByLabel("Inspector settings branch");
  await expect(branchSettings.getByLabel("branch then nodes")).toHaveValue(
    "set_05, manual_review",
  );
  await expect(branchSettings.getByLabel("branch else nodes")).toHaveValue(
    "log_06, auto_approve",
  );

  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect
    .poll(async () => {
      const detail = await request.get(`/api/workflows/${workflowId}`);
      expect(detail.ok(), await detail.text()).toBeTruthy();
      const payload = (await detail.json()) as {
        workflow: {
          nodes: Array<{ id?: string; then?: string[]; else?: string[] }>;
        };
      };
      return payload.workflow.nodes.find((node) => node.id === "branch");
    })
    .toMatchObject({
      then: ["set_05", "manual_review"],
      else: ["log_06", "auto_approve"],
    });

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText(/Published v\d+/)).toBeVisible();
  await page.getByLabel("Run input").fill(
    JSON.stringify(
      {
        risky: false,
      },
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(
    page.getByText("Test run complete", { exact: true }),
  ).toBeVisible();

  const runId = new URL(page.url()).searchParams.get("run");
  expect(runId).toBeTruthy();
  const runDetail = await request.get(`/api/workflow-runs/${runId}`);
  expect(runDetail.ok(), await runDetail.text()).toBeTruthy();
  const runPayload = (await runDetail.json()) as {
    run: { status: string };
    steps: Array<{ nodeId: string; status: string }>;
    events: Array<{ kind: string; payload?: unknown }>;
  };
  expect(runPayload.run.status).toBe("succeeded");
  expect(
    Object.fromEntries(
      runPayload.steps.map((step) => [step.nodeId, step.status]),
    ),
  ).toMatchObject({
    branch: "succeeded",
    set_05: "skipped",
    log_06: "succeeded",
    manual_review: "skipped",
    auto_approve: "succeeded",
    exit: "succeeded",
  });
  expect(runPayload.events).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: "branch_selected",
        payload: expect.objectContaining({
          selected: ["log_06", "auto_approve"],
          skipped: ["set_05", "manual_review"],
        }),
      }),
    ]),
  );
});

test("shows workflow run status overlay on the canvas", async ({
  page,
  request,
}) => {
  const workflowId = `wf_ui_canvas_run_overlay_${Date.now().toString(36)}`;

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Canvas Run Overlay",
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [
        {
          id: "set_input",
          type: "builtin.set",
          assign: { value: "$.workflowTrigger.input.value" },
        },
        {
          id: "log_done",
          type: "builtin.log.info",
          message: "done",
          payload: "$.context.value",
        },
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.context",
        },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto(`/workflows?id=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Canvas Run Overlay" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText(/Published v\d+/)).toBeVisible();
  await page
    .getByLabel("Run input")
    .fill(JSON.stringify({ value: "overlay" }, null, 2));
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(
    page.getByText("Test run complete", { exact: true }),
  ).toBeVisible();
  const runConsole = page.getByLabel("Run Console", { exact: true });
  await expect(
    runConsole.getByRole("button", { name: /set_input/ }),
  ).toBeVisible();

  const canvas = page.getByLabel("Workflow Canvas", { exact: true });
  await expect(
    canvas.locator('[data-workflow-canvas-node-id="set_input"]'),
  ).toHaveAttribute("data-workflow-run-status", "succeeded");
  await expect(
    canvas.locator('[data-workflow-canvas-node-id="log_done"]'),
  ).toContainText("succeeded");
  await expect(
    canvas.locator('[data-workflow-canvas-node-id="exit"]'),
  ).toHaveCount(0);

  const inspector = page.getByLabel("Workflow Inspector", { exact: true });
  await page
    .getByLabel("Run Console", { exact: true })
    .getByRole("button", { name: /log_done/ })
    .click();
  await page
    .getByRole("button", { name: "Exit Run History", exact: true })
    .click();
  await canvas.locator('[data-workflow-canvas-node-id="set_input"]').click();
  await expect(inspector).toContainText("set_input");
  await canvas.locator('[data-workflow-canvas-node-id="log_done"]').click();
  await expect(inspector).toContainText("log_done");
});

test("persists dragged workflow canvas layout metadata", async ({
  page,
  request,
}) => {
  const workflowId = `wf_ui_canvas_layout_${Date.now().toString(36)}`;

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Canvas Layout",
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [
        {
          id: "set_input",
          type: "builtin.set",
          assign: { value: "$.workflowTrigger.input.value" },
        },
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.context",
        },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto(`/workflows?id=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Canvas Layout" }),
  ).toBeVisible();

  const canvas = page.getByLabel("Workflow Canvas", { exact: true });
  const setNode = canvas.locator('[data-workflow-canvas-node-id="set_input"]');
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).toBeTruthy();
  await setNode.dragTo(canvas, {
    targetPosition: {
      x: canvasBox!.width - 80,
      y: canvasBox!.height - 80,
    },
  });

  await page.getByRole("button", { name: "Save", exact: true }).click();

  await expect
    .poll(async () => {
      const detail = await request.get(`/api/workflows/${workflowId}`);
      expect(detail.ok(), await detail.text()).toBeTruthy();
      const payload = (await detail.json()) as {
        workflow: {
          ui?: {
            canvas?: {
              nodes?: {
                set_input?: { position?: { x?: unknown; y?: unknown } };
              };
            };
          };
        };
      };
      return payload.workflow.ui?.canvas?.nodes?.set_input?.position;
    })
    .toEqual({
      x: expect.any(Number),
      y: expect.any(Number),
    });

  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(page.getByText(/Published v\d+/)).toBeVisible();
  await page.getByLabel("Run input").fill(
    JSON.stringify(
      {
        value: "layout",
      },
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(
    page.getByText("Test run complete", { exact: true }),
  ).toBeVisible();
});

test("preserves workflow canvas layout metadata through export and import", async ({
  page,
  request,
}) => {
  const workflowId = `wf_ui_canvas_layout_export_${Date.now().toString(36)}`;

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Canvas Layout Export",
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [{ id: "exit", type: "builtin.exit", status: "succeeded" }],
      ui: {
        canvas: {
          nodes: {
            exit: { position: { x: 120, y: 80 } },
          },
        },
      },
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto(`/workflows?id=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Canvas Layout Export" }),
  ).toBeVisible();

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const exported = JSON.parse(readFileSync(downloadPath!, "utf8")) as {
    workflow?: {
      ui?: unknown;
    };
  };
  expect(exported.workflow?.ui).toEqual({
    canvas: {
      nodes: {
        exit: { position: { x: 120, y: 80 } },
      },
    },
  });

  await page.getByLabel("Import workflow file").setInputFiles(downloadPath!);
  await expect(
    page.getByText("Workflow imported as new draft", { exact: true }),
  ).toBeVisible();
  const importedId = new URL(page.url()).searchParams.get("id");
  expect(importedId).toBeTruthy();
  expect(importedId).not.toBe(workflowId);
  await expect
    .poll(async () => {
      const detail = await request.get(`/api/workflows/${importedId}`);
      expect(detail.ok(), await detail.text()).toBeTruthy();
      const payload = (await detail.json()) as {
        workflow: { ui?: unknown };
      };
      return payload.workflow.ui;
    })
    .toEqual({
      canvas: {
        nodes: {
          exit: { position: { x: 120, y: 80 } },
        },
      },
    });
});

test("opens failed run step evidence from a canvas node", async ({
  page,
  request,
}) => {
  const workflowId = `wf_ui_canvas_failed_overlay_${Date.now().toString(36)}`;

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Canvas Failed Overlay",
      triggers: [{ id: "manual", kind: "manual", enabled: true }],
      nodes: [
        {
          id: "log_customer",
          type: "builtin.log.info",
          message: "About to inspect failed customer",
          payload: "$.workflowTrigger.input.customer",
        },
        {
          id: "route_customer",
          type: "builtin.if_else",
          condition: "$.workflowTrigger.input.customer.riskScore >= 70",
          then: ["missing_customer"],
          else: ["low_customer"],
        },
        {
          id: "low_customer",
          type: "builtin.log.info",
          message: "Low risk customer",
        },
        {
          id: "missing_customer",
          label: "Missing customer lookup",
          type: "builtin.transform.object_pick",
          input: { customer: "$.context.customer.missing" },
          transform: { kind: "value.resolve", value: "$" },
        },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  await page.goto(`/workflows?id=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Canvas Failed Overlay" }),
  ).toBeVisible();
  await page.getByLabel("Run input").fill(
    JSON.stringify(
      {
        customer: {
          id: "cust_failed_canvas",
          name: "Fail Ada",
          riskScore: 82,
        },
      },
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(
    page.getByText("Test run complete", { exact: true }),
  ).toBeVisible();

  const canvas = page.getByLabel("Workflow Canvas", { exact: true });
  const failedNode = canvas.locator(
    '[data-workflow-canvas-node-id="missing_customer"]',
  );
  await expect(failedNode).toHaveAttribute(
    "data-workflow-run-status",
    "failed",
  );
  await expect(failedNode).toContainText("failed");

  await canvas.locator('[data-workflow-canvas-node-id="log_customer"]').click();
  await expect(
    page.getByRole("group", { name: "Selected step metadata" }),
  ).toContainText("node log_customer");

  await failedNode.click();
  await expect(
    page.getByRole("group", { name: "Selected step metadata" }),
  ).toContainText("node missing_customer");
  await expect(
    page.getByRole("group", { name: "Selected step metadata" }),
  ).toContainText("status failed");
  await expect(page.getByRole("group", { name: "Error JSON" })).toContainText(
    "Reference not found: $.context.customer.missing",
  );
});

test("rejects workflow console run deep-links owned by another workflow", async ({
  page,
  request,
}) => {
  const primaryWorkflowId = `wf_ui_run_owner_primary_${Date.now().toString(36)}`;
  const foreignWorkflowId = `wf_ui_run_owner_foreign_${Date.now().toString(36)}`;

  const primary = await request.post("/api/workflows", {
    data: {
      id: primaryWorkflowId,
      name: "Workflow Run Owner Primary",
      nodes: [
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.workflowTrigger.input",
        },
      ],
    },
  });
  expect(primary.ok()).toBeTruthy();

  const foreign = await request.post("/api/workflows", {
    data: {
      id: foreignWorkflowId,
      name: "Workflow Run Owner Foreign",
      nodes: [
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.workflowTrigger.input",
        },
      ],
    },
  });
  expect(foreign.ok()).toBeTruthy();

  const foreignRun = await request.post(
    `/api/workflows/${foreignWorkflowId}/runs/test`,
    { data: { input: { customer: "Foreign Ada" } } },
  );
  expect(foreignRun.ok()).toBeTruthy();
  const foreignRunPayload = (await foreignRun.json()) as {
    run: { id: string };
  };

  await page.goto(
    `/workflows?id=${primaryWorkflowId}&run=${foreignRunPayload.run.id}`,
  );
  await expect(
    page.getByRole("heading", { name: "Workflow Run Owner Primary" }),
  ).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("run"))
    .toBeNull();

  const runConsole = page.getByLabel("Run Console", { exact: true });
  await expect(runConsole).toContainText("No run selected");
  await expect(runConsole).not.toContainText(foreignRunPayload.run.id);
});

test("loads older workflow-scoped run console history pages", async ({
  page,
  request,
}) => {
  const workflowId = `wf_ui_run_console_paged_${Date.now().toString(36)}`;

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Run Console Paged Smoke",
      nodes: [
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.workflowTrigger.input",
        },
      ],
    },
  });
  expect(created.ok()).toBeTruthy();

  for (let index = 0; index < 27; index += 1) {
    const run = await request.post(`/api/workflows/${workflowId}/runs/test`, {
      data: { input: { index } },
    });
    expect(run.ok()).toBeTruthy();
  }

  const olderPage = await request.get(
    `/api/workflows/${workflowId}/runs?limit=25&offset=25`,
  );
  expect(olderPage.ok()).toBeTruthy();
  const olderPayload = (await olderPage.json()) as {
    runs: Array<{ id: string }>;
    hasMore: boolean;
  };
  expect(olderPayload.runs).toHaveLength(2);
  expect(olderPayload.hasMore).toBe(false);
  const olderRunId = olderPayload.runs[0]!.id;

  await page.goto(`/workflows?id=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Run Console Paged Smoke" }),
  ).toBeVisible();
  const runConsole = page.getByLabel("Run Console", { exact: true });
  await expect(runConsole).not.toContainText(olderRunId);
  await runConsole.getByRole("button", { name: "Load more" }).click();
  await expect(runConsole).toContainText(olderRunId);
  await expect(
    runConsole.getByRole("button", { name: "Load more" }),
  ).toHaveCount(0);
});

test("shows pruned artifact errors in the workflow-scoped run console", async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString(36);
  const workflowId = `wf_ui_pruned_artifact_${suffix}`;
  const largeMessage = "x".repeat(70_000);

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Pruned Artifact Smoke",
      nodes: [
        {
          id: "large_echo",
          type: "mcp.tool",
          server: "demo",
          tool: "echo",
          input: {
            message: largeMessage,
            apiKey: "raw-workflow-pruned-artifact-key",
          },
        },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  const run = await request.post(`/api/workflows/${workflowId}/runs/test`, {
    data: { input: { customerId: "cust_workflow_pruned_artifact" } },
  });
  expect(run.ok(), await run.text()).toBeTruthy();
  const detail = (await run.json()) as {
    run: { id: string };
    steps: Array<{
      output?: {
        artifact?: {
          id: string;
          kind: string;
        };
      };
    }>;
    artifacts?: Array<{ id: string; kind: string }>;
  };
  const artifactRef = detail.steps[0]?.output?.artifact;
  expect(artifactRef?.kind).toBe("step_output");
  expect(detail.artifacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: artifactRef?.id,
        kind: "step_output",
      }),
    ]),
  );

  const pruned = await request.post("/api/workflow-artifacts/prune", {
    data: { createdBefore: "2999-01-01T00:00:00.000Z" },
  });
  expect(pruned.ok()).toBeTruthy();

  const contentAfterPrune = await request.get(
    `/api/workflow-runs/${detail.run.id}/artifacts/${artifactRef!.id}`,
  );
  expect(contentAfterPrune.status()).toBe(404);
  expect(await contentAfterPrune.json()).toEqual({
    error: "artifact_not_found",
  });

  await page.goto(`/workflows?id=${workflowId}&run=${detail.run.id}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Pruned Artifact Smoke" }),
  ).toBeVisible();
  const runConsole = page.getByLabel("Run Console", { exact: true });
  const outputJson = runConsole.getByRole("group", { name: "Output JSON" });
  await expect(outputJson).toContainText(artifactRef!.id);

  await outputJson
    .getByRole("button", { name: "Load artifact", exact: true })
    .click();

  await expect(outputJson).toContainText("Artifact unavailable");
  await expect(outputJson).not.toContainText("artifact_not_found");
  await expect(outputJson).toContainText(artifactRef!.id);
  await expect(outputJson).not.toContainText(
    "raw-workflow-pruned-artifact-key",
  );
});

test("filters workflow-scoped run console history by status trigger and date", async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString(36);
  const workflowId = `wf_ui_scoped_filters_${suffix}`;

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Scoped Filters Smoke",
      nodes: [
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.workflowTrigger.input",
        },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  const succeededRun = await request.post(
    `/api/workflows/${workflowId}/runs/test`,
    { data: { input: { customer: "Succeeded Ada" } } },
  );
  expect(succeededRun.ok(), await succeededRun.text()).toBeTruthy();
  const succeededDetail = (await succeededRun.json()) as {
    run: { id: string };
  };
  const failedWorkflow = await request.patch(`/api/workflows/${workflowId}`, {
    data: {
      nodes: [
        {
          id: "exit",
          type: "builtin.exit",
          status: "failed",
          output: "$.workflowTrigger.input",
        },
      ],
    },
  });
  expect(failedWorkflow.ok(), await failedWorkflow.text()).toBeTruthy();
  const failedRun = await request.post(
    `/api/workflows/${workflowId}/runs/test`,
    { data: { input: { customer: "Failed Ada" } } },
  );
  expect(failedRun.ok(), await failedRun.text()).toBeTruthy();
  const failedDetail = (await failedRun.json()) as {
    run: { id: string };
  };

  await page.goto(
    `/workflows?id=${workflowId}&status=failed&triggerId=manual&createdFrom=2000-01-01&createdTo=2999-01-01`,
  );
  await expect(
    page.getByRole("heading", { name: "Workflow Scoped Filters Smoke" }),
  ).toBeVisible();
  const runConsole = page.getByLabel("Run Console", { exact: true });
  await expect(
    runConsole.getByRole("combobox", { name: "Status" }),
  ).toContainText("failed");
  await expect(
    runConsole.getByRole("textbox", { name: "Trigger", exact: true }),
  ).toHaveValue("manual");
  await expect(runConsole.getByLabel("Created from")).toHaveValue("2000-01-01");
  await expect(runConsole.getByLabel("Created to")).toHaveValue("2999-01-01");
  await expect(runConsole).toContainText(failedDetail.run.id);
  await expect(runConsole).not.toContainText(succeededDetail.run.id);
  const failedRunRow = runConsole.getByRole("button", {
    name: new RegExp(failedDetail.run.id),
  });
  await expect(failedRunRow).toContainText("failed");

  await runConsole
    .getByRole("textbox", { name: "Trigger", exact: true })
    .fill("nightly");
  await expect(runConsole.getByText("No runs")).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("triggerId"))
    .toBe("nightly");
});

test("auto-refreshes non-terminal workflow run console details", async ({
  page,
}) => {
  const workflowId = "wf_console_auto_refresh";
  const runId = "run_console_auto_refresh";
  const startedAt = "2026-07-30T10:10:00.000Z";
  const runningRun = workflowRun({
    id: runId,
    workflowId,
    status: "running",
    currentNodeId: "lookup",
    startedAt,
  });
  const succeededRun = workflowRun({
    id: runId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt,
    endedAt: "2026-07-30T10:10:01.000Z",
  });
  let detailRequests = 0;

  await page.route("**/api/workflows/mcp/tools", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tools: [] }),
    }),
  );
  await page.route("**/api/workflows/agents", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agents: [] }),
    }),
  );
  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          {
            id: workflowId,
            version: 1,
            status: "draft",
            name: "Workflow Console Auto Refresh",
            triggers: [{ id: "manual", kind: "manual", enabled: true }],
            nodes: [
              {
                id: "lookup",
                type: "mcp.tool",
                server: "crm",
                tool: "lookup",
                input: { id: "$.workflowTrigger.input.customerId" },
              },
            ],
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        ],
      }),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/triggers`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        triggers: [{ id: "manual", kind: "manual", enabled: true }],
      }),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/runs?**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [runningRun],
        limit: 25,
        offset: 0,
        hasMore: false,
        nextOffset: null,
      }),
    }),
  );
  await page.route(`**/api/workflow-runs/${runId}`, (route) => {
    detailRequests += 1;
    const run = detailRequests <= 2 ? runningRun : succeededRun;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(run)),
    });
  });

  await page.goto(`/workflows?id=${workflowId}&run=${runId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Console Auto Refresh" }),
  ).toBeVisible();
  const runConsole = page.getByLabel("Run Console", { exact: true });
  await expect(runConsole).toContainText("running");
  await expect(runConsole).toContainText("current lookup");
  await expect(
    runConsole.getByRole("button", { name: /lookup .* running/ }),
  ).toBeVisible();

  await expect(runConsole).toContainText("succeeded", { timeout: 5_000 });
  await expect(runConsole).toContainText("current none");
  await expect(
    runConsole.getByRole("button", { name: /lookup .* succeeded/ }),
  ).toBeVisible();
  await runConsole.getByRole("combobox", { name: "Timeline level" }).click();
  await page.getByRole("option", { name: "error" }).click();
  await expect(runConsole.getByText("No error events")).toBeVisible();
  await expect(runConsole.getByText("run_started")).toHaveCount(0);
  expect(detailRequests).toBeGreaterThanOrEqual(3);
});

test("shows empty workflow run console step rail when detail has no attempts", async ({
  page,
}) => {
  const workflowId = "wf_console_empty_steps";
  const runId = "run_console_empty_steps";
  const startedAt = "2026-07-30T10:12:00.000Z";
  const run = workflowRun({
    id: runId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt,
    endedAt: "2026-07-30T10:12:01.000Z",
  });
  const detail = runDetail(run);
  detail.steps = [];

  await page.route("**/api/workflows/mcp/tools", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tools: [] }),
    }),
  );
  await page.route("**/api/workflows/agents", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agents: [] }),
    }),
  );
  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          {
            id: workflowId,
            version: 1,
            status: "draft",
            name: "Workflow Console Empty Steps",
            triggers: [{ id: "manual", kind: "manual", enabled: true }],
            nodes: [],
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        ],
      }),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/triggers`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        triggers: [{ id: "manual", kind: "manual", enabled: true }],
      }),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/runs?**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [run],
        limit: 25,
        offset: 0,
        hasMore: false,
        nextOffset: null,
      }),
    }),
  );
  await page.route(`**/api/workflow-runs/${runId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detail),
    }),
  );

  await page.goto(`/workflows?id=${workflowId}&run=${runId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Console Empty Steps" }),
  ).toBeVisible();
  const runConsole = page.getByLabel("Run Console", { exact: true });
  await expect(runConsole.getByText("No step attempts")).toBeVisible();
  await expect(runConsole.getByText("No selected step")).toBeVisible();
});

test("shows foreach aggregate output in the run console step detail", async ({
  page,
}) => {
  const workflowId = "wf_console_foreach_aggregate";
  const runId = "run_console_foreach_aggregate";
  const startedAt = "2026-07-30T10:18:00.000Z";
  const endedAt = "2026-07-30T10:18:02.000Z";
  const run = workflowRun({
    id: runId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt,
    endedAt,
  });
  const foreachStep = {
    id: `${run.id}:each_asset:1`,
    runId: run.id,
    nodeId: "each_asset",
    attempt: 1,
    status: "succeeded",
    startedAt,
    endedAt,
    durationMs: 2000,
    output: {
      count: 2,
      succeededCount: 2,
      failedCount: 0,
      items: [
        {
          index: 0,
          item: { id: "asset_1", ip: "10.1.2.3" },
          status: "succeeded",
          startedAt: "2026-07-30T10:18:00.100Z",
          endedAt: "2026-07-30T10:18:00.500Z",
          durationMs: 400,
          steps: {
            normalize_asset: { id: "asset_1", route: "internal" },
          },
        },
        {
          index: 1,
          item: { id: "asset_2", ip: "8.8.8.8" },
          status: "succeeded",
          startedAt: "2026-07-30T10:18:00.600Z",
          endedAt: "2026-07-30T10:18:01.000Z",
          durationMs: 400,
          steps: {
            normalize_asset: { id: "asset_2", route: "external" },
          },
        },
      ],
    },
  };
  const detail = {
    run,
    steps: [foreachStep],
    events: [
      {
        id: `${run.id}:event:1`,
        runId: run.id,
        stepRunId: foreachStep.id,
        sequence: 1,
        level: "system",
        kind: "log",
        message: "Foreach item 1 completed",
        payload: foreachStep.output.items[0],
        createdAt: "2026-07-30T10:18:00.500Z",
      },
      {
        id: `${run.id}:event:2`,
        runId: run.id,
        stepRunId: foreachStep.id,
        sequence: 2,
        level: "system",
        kind: "log",
        message: "Foreach item 2 completed",
        payload: foreachStep.output.items[1],
        createdAt: "2026-07-30T10:18:01.000Z",
      },
    ],
    artifacts: [],
  };

  await page.route("**/api/workflows/mcp/tools", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tools: [] }),
    }),
  );
  await page.route("**/api/workflows/agents", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agents: [] }),
    }),
  );
  await page.route(`**/api/workflow-runs/${runId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detail),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/triggers`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        triggers: [{ id: "manual", kind: "manual", enabled: true }],
      }),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/runs?**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [run],
        limit: 25,
        offset: 0,
        hasMore: false,
        nextOffset: null,
      }),
    }),
  );
  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          {
            id: workflowId,
            version: 1,
            status: "draft",
            name: "Workflow Console Foreach Aggregate",
            triggers: [{ id: "manual", kind: "manual", enabled: true }],
            nodes: [
              {
                id: "each_asset",
                type: "builtin.foreach",
                items: "$.workflowTrigger.input.assets",
                itemVar: "asset",
                body: ["normalize_asset"],
              },
              {
                id: "normalize_asset",
                type: "builtin.transform.value_resolve",
                transform: { kind: "value.resolve", value: "$.context.asset" },
              },
            ],
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        ],
      }),
    }),
  );

  await page.goto(`/workflows?id=${workflowId}&run=${runId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Console Foreach Aggregate" }),
  ).toBeVisible();
  const runConsole = page.getByLabel("Run Console", { exact: true });
  await expect(
    runConsole.getByRole("button", { name: /each_asset .* succeeded/ }),
  ).toBeVisible();
  await runConsole
    .getByRole("button", { name: /each_asset .* succeeded/ })
    .click();
  const outputJson = runConsole.getByRole("group", {
    name: "Step output JSON",
  });
  await expect(outputJson).toContainText('"count": 2');
  await expect(outputJson).toContainText('"succeededCount": 2');
  await expect(outputJson).toContainText('"failedCount": 0');
  await expect(outputJson).toContainText('"durationMs": 400');
  await expect(outputJson).toContainText('"asset_1"');
  await expect(outputJson).toContainText('"route": "internal"');
  await expect(outputJson).toContainText('"asset_2"');
  await expect(outputJson).toContainText('"route": "external"');
});

test("keeps selected workflow run console step after cancel", async ({
  page,
}) => {
  const workflowId = "wf_console_cancel_selection";
  const runId = "run_console_cancel_selection";
  const startedAt = "2026-07-30T10:15:00.000Z";
  const runningRun = workflowRun({
    id: runId,
    workflowId,
    status: "running",
    currentNodeId: "lookup",
    startedAt,
  });
  const canceledRun = workflowRun({
    id: runId,
    workflowId,
    status: "canceled",
    currentNodeId: null,
    startedAt,
    endedAt: "2026-07-30T10:15:01.000Z",
  });
  let canceled = false;

  await page.route("**/api/workflows/mcp/tools", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tools: [] }),
    }),
  );
  await page.route("**/api/workflows/agents", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agents: [] }),
    }),
  );
  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          {
            id: workflowId,
            version: 1,
            status: "draft",
            name: "Workflow Console Cancel Selection",
            triggers: [{ id: "manual", kind: "manual", enabled: true }],
            nodes: [
              {
                id: "lookup",
                type: "mcp.tool",
                server: "crm",
                tool: "lookup",
                input: { id: "$.workflowTrigger.input.customerId" },
              },
              {
                id: "notify",
                type: "builtin.log.info",
                message: "Notify customer",
              },
            ],
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        ],
      }),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/triggers`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        triggers: [{ id: "manual", kind: "manual", enabled: true }],
      }),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/runs?**`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [canceled ? canceledRun : runningRun],
        limit: 25,
        offset: 0,
        hasMore: false,
        nextOffset: null,
      }),
    }),
  );
  await page.route(`**/api/workflow-runs/${runId}/cancel`, (route) => {
    canceled = true;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(canceledRun)),
    });
  });
  await page.route(`**/api/workflow-runs/${runId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(canceled ? canceledRun : runningRun)),
    }),
  );

  await page.goto(`/workflows?id=${workflowId}&run=${runId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Console Cancel Selection" }),
  ).toBeVisible();
  const runConsole = page.getByLabel("Run Console", { exact: true });
  await expect(runConsole).toContainText("running");
  await runConsole.getByRole("button", { name: /notify .* queued/ }).click();
  await expect(
    runConsole.getByRole("group", { name: "Selected step metadata" }),
  ).toContainText("node notify");

  await runConsole.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Run canceled", { exact: true })).toBeVisible();
  await expect(runConsole).toContainText("canceled");
  await expect(
    runConsole.getByRole("group", { name: "Selected step metadata" }),
  ).toContainText("node notify");
});

test("keeps loaded workflow run console pages after cancel", async ({
  page,
}) => {
  const workflowId = "wf_console_cancel_loaded_pages";
  const selectedRunId = "run_console_cancel_loaded_pages_selected";
  const olderRunId = "run_console_cancel_loaded_pages_older";
  const startedAt = "2026-07-30T10:25:00.000Z";
  const runningRun = workflowRun({
    id: selectedRunId,
    workflowId,
    status: "running",
    currentNodeId: "lookup",
    startedAt,
  });
  const newestRun = workflowRun({
    id: "run_console_cancel_loaded_pages_newest",
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:26:00.000Z",
    endedAt: "2026-07-30T10:26:01.000Z",
  });
  const olderRun = workflowRun({
    id: olderRunId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:24:00.000Z",
    endedAt: "2026-07-30T10:24:01.000Z",
  });
  const canceledRun = workflowRun({
    id: selectedRunId,
    workflowId,
    status: "canceled",
    currentNodeId: null,
    startedAt,
    endedAt: "2026-07-30T10:25:01.000Z",
  });
  let canceled = false;

  await page.route("**/api/workflows/mcp/tools", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tools: [] }),
    }),
  );
  await page.route("**/api/workflows/agents", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agents: [] }),
    }),
  );
  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          {
            id: workflowId,
            version: 1,
            status: "draft",
            name: "Workflow Console Cancel Loaded Pages",
            triggers: [{ id: "manual", kind: "manual", enabled: true }],
            nodes: [
              {
                id: "lookup",
                type: "mcp.tool",
                server: "crm",
                tool: "lookup",
                input: { id: "$.workflowTrigger.input.customerId" },
              },
              {
                id: "notify",
                type: "builtin.log.info",
                message: "Notify customer",
              },
            ],
            createdAt: startedAt,
            updatedAt: startedAt,
          },
        ],
      }),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/triggers`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        triggers: [{ id: "manual", kind: "manual", enabled: true }],
      }),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/runs?**`, (route) => {
    const url = new URL(route.request().url());
    const offset = url.searchParams.get("offset");
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        offset === "2"
          ? {
              runs: [olderRun],
              limit: 25,
              offset: 2,
              hasMore: false,
              nextOffset: null,
            }
          : {
              runs: [canceled ? canceledRun : runningRun, newestRun],
              limit: 25,
              offset: 0,
              hasMore: true,
              nextOffset: 2,
            },
      ),
    });
  });
  await page.route(`**/api/workflow-runs/${selectedRunId}/cancel`, (route) => {
    canceled = true;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(canceledRun)),
    });
  });
  await page.route(`**/api/workflow-runs/${selectedRunId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(canceled ? canceledRun : runningRun)),
    }),
  );

  await page.goto(`/workflows?id=${workflowId}&run=${selectedRunId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Console Cancel Loaded Pages" }),
  ).toBeVisible();
  const runConsole = page.getByLabel("Run Console", { exact: true });
  const selectedRunRow = runConsole.locator("button").filter({
    hasText: selectedRunId,
  });
  const olderRunRow = runConsole
    .locator("button")
    .filter({ hasText: olderRunId });
  await expect(selectedRunRow).toBeVisible();
  await expect(olderRunRow).toHaveCount(0);
  await runConsole.getByRole("button", { name: "Load more" }).click();
  await expect(olderRunRow).toBeVisible();

  await runConsole.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Run canceled", { exact: true })).toBeVisible();
  await expect(runConsole).toContainText("canceled");
  await expect(olderRunRow).toBeVisible();
});

test("keeps loaded workflow run console pages after rerun", async ({
  page,
}) => {
  const workflowId = "wf_console_rerun_loaded_pages";
  const sourceRunId = "run_console_rerun_loaded_pages_source";
  const rerunRunId = "run_console_rerun_loaded_pages_retry";
  const olderRunId = "run_console_rerun_loaded_pages_older";
  const sourceStartedAt = "2026-07-30T10:30:00.000Z";
  const sourceRun = workflowRun({
    id: sourceRunId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: sourceStartedAt,
    endedAt: "2026-07-30T10:30:01.000Z",
  });
  const newestRun = workflowRun({
    id: "run_console_rerun_loaded_pages_newest",
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:31:00.000Z",
    endedAt: "2026-07-30T10:31:01.000Z",
  });
  const olderRun = workflowRun({
    id: olderRunId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:29:00.000Z",
    endedAt: "2026-07-30T10:29:01.000Z",
  });
  const rerunRun = workflowRun({
    id: rerunRunId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:32:00.000Z",
    endedAt: "2026-07-30T10:32:01.000Z",
  });
  let reran = false;

  await page.route("**/api/workflows/mcp/tools", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tools: [] }),
    }),
  );
  await page.route("**/api/workflows/agents", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agents: [] }),
    }),
  );
  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          {
            id: workflowId,
            version: 1,
            status: "draft",
            name: "Workflow Console Rerun Loaded Pages",
            triggers: [{ id: "manual", kind: "manual", enabled: true }],
            nodes: [
              {
                id: "lookup",
                type: "mcp.tool",
                server: "crm",
                tool: "lookup",
                input: { id: "$.workflowTrigger.input.customerId" },
              },
              {
                id: "notify",
                type: "builtin.log.info",
                message: "Notify customer",
              },
            ],
            createdAt: sourceStartedAt,
            updatedAt: sourceStartedAt,
          },
        ],
      }),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/triggers`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        triggers: [{ id: "manual", kind: "manual", enabled: true }],
      }),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/runs?**`, (route) => {
    const url = new URL(route.request().url());
    const offset = url.searchParams.get("offset");
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        offset === "2"
          ? {
              runs: [olderRun],
              limit: 25,
              offset: 2,
              hasMore: false,
              nextOffset: null,
            }
          : {
              runs: [reran ? rerunRun : sourceRun, newestRun],
              limit: 25,
              offset: 0,
              hasMore: true,
              nextOffset: 2,
            },
      ),
    });
  });
  await page.route(`**/api/workflow-runs/${sourceRunId}/rerun`, (route) => {
    reran = true;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(rerunRun)),
    });
  });
  await page.route(`**/api/workflow-runs/${sourceRunId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(sourceRun)),
    }),
  );
  await page.route(`**/api/workflow-runs/${rerunRunId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(rerunRun)),
    }),
  );

  await page.goto(`/workflows?id=${workflowId}&run=${sourceRunId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Console Rerun Loaded Pages" }),
  ).toBeVisible();
  const runConsole = page.getByLabel("Run Console", { exact: true });
  const rerunRunRow = runConsole
    .locator("button")
    .filter({ hasText: rerunRunId });
  const olderRunRow = runConsole
    .locator("button")
    .filter({ hasText: olderRunId });
  await expect(rerunRunRow).toHaveCount(0);
  await expect(olderRunRow).toHaveCount(0);
  await runConsole.getByRole("button", { name: "Load more" }).click();
  await expect(olderRunRow).toBeVisible();

  await runConsole.getByRole("button", { name: "Rerun", exact: true }).click();
  await expect(
    page.getByText("Run queued from prior input", { exact: true }),
  ).toBeVisible();
  await expect(rerunRunRow).toBeVisible();
  await expect(olderRunRow).toBeVisible();
});

test("keeps loaded workflow run console pages after test run", async ({
  page,
}) => {
  const workflowId = "wf_console_test_loaded_pages";
  const sourceRunId = "run_console_test_loaded_pages_source";
  const testRunId = "run_console_test_loaded_pages_created";
  const olderRunId = "run_console_test_loaded_pages_older";
  const sourceStartedAt = "2026-07-30T10:35:00.000Z";
  const sourceRun = workflowRun({
    id: sourceRunId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: sourceStartedAt,
    endedAt: "2026-07-30T10:35:01.000Z",
  });
  const newestRun = workflowRun({
    id: "run_console_test_loaded_pages_newest",
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:36:00.000Z",
    endedAt: "2026-07-30T10:36:01.000Z",
  });
  const olderRun = workflowRun({
    id: olderRunId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:34:00.000Z",
    endedAt: "2026-07-30T10:34:01.000Z",
  });
  const testRun = workflowRun({
    id: testRunId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:37:00.000Z",
    endedAt: "2026-07-30T10:37:01.000Z",
  });
  let tested = false;

  await page.route("**/api/workflows/mcp/tools", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tools: [] }),
    }),
  );
  await page.route("**/api/workflows/agents", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agents: [] }),
    }),
  );
  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          {
            id: workflowId,
            version: 1,
            status: "draft",
            name: "Workflow Console Test Loaded Pages",
            triggers: [{ id: "manual", kind: "manual", enabled: true }],
            nodes: [
              {
                id: "lookup",
                type: "mcp.tool",
                server: "crm",
                tool: "lookup",
                input: { id: "$.workflowTrigger.input.customerId" },
              },
              {
                id: "notify",
                type: "builtin.log.info",
                message: "Notify customer",
              },
            ],
            createdAt: sourceStartedAt,
            updatedAt: sourceStartedAt,
          },
        ],
      }),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/triggers`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        triggers: [{ id: "manual", kind: "manual", enabled: true }],
      }),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/runs?**`, (route) => {
    const url = new URL(route.request().url());
    const offset = url.searchParams.get("offset");
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        offset === "2"
          ? {
              runs: [olderRun],
              limit: 25,
              offset: 2,
              hasMore: false,
              nextOffset: null,
            }
          : {
              runs: [tested ? testRun : sourceRun, newestRun],
              limit: 25,
              offset: 0,
              hasMore: true,
              nextOffset: 2,
            },
      ),
    });
  });
  await page.route(`**/api/workflows/${workflowId}/runs/test`, (route) => {
    tested = true;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(testRun)),
    });
  });
  await page.route(`**/api/workflow-runs/${sourceRunId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(sourceRun)),
    }),
  );
  await page.route(`**/api/workflow-runs/${testRunId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(testRun)),
    }),
  );

  await page.goto(`/workflows?id=${workflowId}&run=${sourceRunId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Console Test Loaded Pages" }),
  ).toBeVisible();
  const runConsole = page.getByLabel("Run Console", { exact: true });
  const testRunRow = runConsole
    .locator("button")
    .filter({ hasText: testRunId });
  const olderRunRow = runConsole
    .locator("button")
    .filter({ hasText: olderRunId });
  await expect(testRunRow).toHaveCount(0);
  await expect(olderRunRow).toHaveCount(0);
  await runConsole.getByRole("button", { name: "Load more" }).click();
  await expect(olderRunRow).toBeVisible();

  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(
    page.getByText("Test run complete", { exact: true }),
  ).toBeVisible();
  await expect(testRunRow).toBeVisible();
  await expect(olderRunRow).toBeVisible();
});

test("keeps loaded workflow run console pages after trigger run", async ({
  page,
}) => {
  const workflowId = "wf_console_trigger_loaded_pages";
  const sourceRunId = "run_console_trigger_loaded_pages_source";
  const triggerRunId = "run_console_trigger_loaded_pages_created";
  const olderRunId = "run_console_trigger_loaded_pages_older";
  const sourceStartedAt = "2026-07-30T10:40:00.000Z";
  const sourceRun = workflowRun({
    id: sourceRunId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: sourceStartedAt,
    endedAt: "2026-07-30T10:40:01.000Z",
  });
  const newestRun = workflowRun({
    id: "run_console_trigger_loaded_pages_newest",
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:41:00.000Z",
    endedAt: "2026-07-30T10:41:01.000Z",
  });
  const olderRun = workflowRun({
    id: olderRunId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:39:00.000Z",
    endedAt: "2026-07-30T10:39:01.000Z",
  });
  const triggerRun = workflowRun({
    id: triggerRunId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:42:00.000Z",
    endedAt: "2026-07-30T10:42:01.000Z",
  });
  let triggered = false;

  await page.route("**/api/workflows/mcp/tools", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tools: [] }),
    }),
  );
  await page.route("**/api/workflows/agents", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agents: [] }),
    }),
  );
  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          {
            id: workflowId,
            version: 2,
            status: "published",
            name: "Workflow Console Trigger Loaded Pages",
            triggers: [{ id: "manual_review", kind: "manual", enabled: true }],
            nodes: [
              {
                id: "lookup",
                type: "mcp.tool",
                server: "crm",
                tool: "lookup",
                input: { id: "$.workflowTrigger.input.customerId" },
              },
              {
                id: "notify",
                type: "builtin.log.info",
                message: "Notify customer",
              },
            ],
            createdAt: sourceStartedAt,
            updatedAt: sourceStartedAt,
          },
        ],
      }),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/triggers`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        triggers: [
          {
            id: "manual_review",
            kind: "manual",
            enabled: true,
            runnable: true,
          },
        ],
      }),
    }),
  );
  await page.route(`**/api/workflows/${workflowId}/runs?**`, (route) => {
    const url = new URL(route.request().url());
    const offset = url.searchParams.get("offset");
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        offset === "2"
          ? {
              runs: [olderRun],
              limit: 25,
              offset: 2,
              hasMore: false,
              nextOffset: null,
            }
          : {
              runs: [triggered ? triggerRun : sourceRun, newestRun],
              limit: 25,
              offset: 0,
              hasMore: true,
              nextOffset: 2,
            },
      ),
    });
  });
  await page.route(
    `**/api/workflows/${workflowId}/triggers/manual_review/runs`,
    (route) => {
      triggered = true;
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(runDetail(triggerRun)),
      });
    },
  );
  await page.route(`**/api/workflow-runs/${sourceRunId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(sourceRun)),
    }),
  );
  await page.route(`**/api/workflow-runs/${triggerRunId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(triggerRun)),
    }),
  );

  await page.goto(`/workflows?id=${workflowId}&run=${sourceRunId}`);
  await expect(
    page.getByRole("heading", {
      name: "Workflow Console Trigger Loaded Pages",
    }),
  ).toBeVisible();
  const runConsole = page.getByLabel("Run Console", { exact: true });
  const triggerRunRow = runConsole
    .locator("button")
    .filter({ hasText: triggerRunId });
  const olderRunRow = runConsole
    .locator("button")
    .filter({ hasText: olderRunId });
  await expect(triggerRunRow).toHaveCount(0);
  await expect(olderRunRow).toHaveCount(0);
  await runConsole.getByRole("button", { name: "Load more" }).click();
  await expect(olderRunRow).toBeVisible();

  await page
    .getByRole("group", { name: "Trigger manual_review" })
    .getByRole("button", { name: "Run" })
    .click();
  await expect(
    page.getByText("Trigger run complete", { exact: true }),
  ).toBeVisible();
  await expect(triggerRunRow).toBeVisible();
  await expect(olderRunRow).toBeVisible();
});

test("keeps external node actions disabled when no inventory is available", async ({
  page,
  request,
}) => {
  const workflowId = `wf_ui_empty_inventory_${Date.now().toString(36)}`;

  await page.route("**/api/workflows/mcp/tools", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ tools: [] }),
    }),
  );
  await page.route("**/api/workflows/agents", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ agents: [] }),
    }),
  );

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Empty Inventory Smoke",
      nodes: [
        {
          id: "set_customer",
          type: "builtin.set",
          assign: { customer: "$.workflowTrigger.input.customer" },
        },
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.context.customer",
        },
      ],
    },
  });
  expect(created.ok()).toBeTruthy();

  await page.goto(`/workflows?id=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow Empty Inventory Smoke" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Add workflow step", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Add Step", exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Built-in", exact: true }).click();
  await expect(dialog.getByRole("button", { name: "Set", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "Tools", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "MCP Tool", exact: true }),
  ).toBeDisabled();
  await dialog.getByRole("button", { name: "AI", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Agent Call", exact: true }),
  ).toBeDisabled();
  await expect(page.getByText("mcp_server_tool")).toHaveCount(0);
  await expect(page.getByText("agent_agent")).toHaveCount(0);
});

test("runs configured manual workflow triggers from the console", async ({
  page,
  request,
}) => {
  const workflowId = `wf_ui_trigger_${Date.now().toString(36)}`;
  const webhookSecretSha256 =
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

  const invalid = await request.post("/api/workflows", {
    data: {
      id: `${workflowId}_invalid`,
      name: "Invalid Reference Smoke",
      nodes: [
        {
          id: "branch",
          type: "builtin.if",
          condition: "$.workflowTrigger.input.ready",
          then: ["missing_node"],
        },
      ],
    },
  });
  expect(invalid.status()).toBe(400);
  await expect(invalid.json()).resolves.toEqual({
    error: "Node branch then references missing node missing_node",
  });

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow UI Trigger Smoke",
      triggers: [
        {
          id: "manual_review",
          kind: "manual",
          enabled: true,
          inputSchema: {
            type: "object",
            required: ["approvalNote"],
            properties: { approvalNote: { type: "string" } },
          },
        },
        {
          id: "nightly",
          kind: "scheduled",
          enabled: false,
          schedule: { kind: "cron", expr: "0 2 * * *", tz: "UTC" },
        },
      ],
      nodes: [
        {
          id: "set_customer",
          type: "builtin.set",
          assign: { customer: "$.workflowTrigger.input.customer" },
        },
        {
          id: "normalize",
          type: "builtin.transform.value_resolve",
          input: { value: "$.context.customer" },
          transform: { kind: "value.resolve", value: "$" },
          assign: {
            customer: {
              from: "$.steps.normalize.output",
              mode: "replace",
            },
          },
        },
        {
          id: "log_customer",
          label: "Log normalized customer",
          type: "builtin.log.info",
          message: "Customer normalized in workflow console",
          payload: "$.context.customer",
        },
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.context.customer",
        },
        {
          id: "mcp_echo",
          type: "mcp.tool",
          server: "demo",
          tool: "echo",
          input: { message: "$.workflowTrigger.input.customer.name" },
          assign: {
            mcpEcho: {
              from: "$.steps.mcp_echo.output",
              mode: "replace",
            },
          },
        },
        {
          id: "agent_review",
          type: "agent.call",
          agentId: "agent_demo",
          prompt: "Review workflow input",
          input: { customer: "$.context.customer" },
          assign: {
            agentReview: {
              from: "$.steps.agent_review.output",
              mode: "replace",
            },
          },
        },
      ],
    },
  });
  expect(created.ok()).toBeTruthy();

  await page.goto(`/workflows?id=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: "Workflow UI Trigger Smoke" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Paused" })).toBeDisabled();
  await expect(page.getByText("customer <- $.workflowTrigger.input.customer")).toBeVisible();
  await expect(
    page.getByText("customer <- $.steps.normalize.output"),
  ).toBeVisible();
  await expect(page.getByText("mode replace").first()).toBeVisible();

  const nodesJson = page.getByLabel("Nodes JSON");
  const triggersJson = page.getByLabel("Triggers JSON");
  const inputSchemaJson = page.getByLabel("Input Schema JSON");
  await page.getByLabel("set_customer card label").fill("Load customer");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[0]?.label)
    .toBe("Load customer");
  await inputSchemaJson.fill(
    JSON.stringify(
      {
        type: "object",
        required: ["customer"],
        properties: {
          customer: {
            type: "object",
            required: ["id", "name"],
          },
        },
      },
      null,
      2,
    ),
  );
  await expect
    .poll(async () => JSON.parse(await inputSchemaJson.inputValue()).required)
    .toEqual(["customer"]);
  await expect(
    page.getByRole("button", { name: "Move Load customer down" }),
  ).toBeVisible();
  const validTriggersDraft = [
    {
      id: "manual_review",
      kind: "manual",
      enabled: true,
      inputSchema: {
        type: "object",
        required: ["approvalNote"],
        properties: { approvalNote: { type: "string" } },
      },
    },
    {
      id: "nightly",
      kind: "scheduled",
      enabled: true,
      schedule: { kind: "cron", expr: "0 3 * * *", tz: "UTC" },
    },
    {
      id: "incoming",
      kind: "webhook",
      enabled: true,
      path: "/workflow-ui-smoke",
      inputSchema: {
        type: "object",
        required: ["source"],
        properties: { source: { const: "crm" } },
      },
    },
    {
      id: "task_gate",
      kind: "task",
      enabled: false,
      filter: { queue: "support", priority: ["high"] },
    },
  ];
  await triggersJson.fill(JSON.stringify(validTriggersDraft, null, 2));
  await expect
    .poll(async () => JSON.parse(await triggersJson.inputValue())[2]?.id)
    .toBe("incoming");
  await expect
    .poll(async () => JSON.parse(await triggersJson.inputValue())[3]?.id)
    .toBe("task_gate");

  await triggersJson.fill(
    JSON.stringify(
      [
        validTriggersDraft[0],
        { ...validTriggersDraft[0], inputSchema: undefined },
      ],
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Duplicate workflow trigger id: manual_review"),
  ).toBeVisible();

  await triggersJson.fill(
    JSON.stringify(
      [
        validTriggersDraft[0],
        {
          id: "incoming_a",
          kind: "webhook",
          enabled: true,
          path: "crm/customer",
        },
        {
          id: "incoming_b",
          kind: "webhook",
          enabled: false,
          path: "/crm/customer/",
        },
      ],
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Duplicate workflow webhook path: crm/customer"),
  ).toBeVisible();

  let invalidTriggerSavePatchCount = 0;
  let invalidNodeSavePatchCount = 0;
  let importConflictActive = false;
  let importConflictPatchCount = 0;
  await page.route(`**/api/workflows/${workflowId}`, async (route) => {
    const request = route.request();
    if (request.method() === "PATCH") {
      if (importConflictActive) {
        importConflictPatchCount += 1;
      }
      const body = request.postDataJSON() as {
        nodes?: Array<{ id?: string }>;
        triggers?: Array<{ id?: string }>;
      };
      if (body.triggers?.some((trigger) => trigger.id === "bad/save")) {
        invalidTriggerSavePatchCount += 1;
      }
      if (body.nodes?.some((node) => node.id === "log_save_invalid")) {
        invalidNodeSavePatchCount += 1;
      }
    }
    await route.fallback();
  });

  let importNewDraftPostId: string | null = null;
  await page.route("**/api/workflows", async (route) => {
    const request = route.request();
    if (importConflictActive && request.method() === "POST") {
      const body = request.postDataJSON() as { id?: string };
      importNewDraftPostId = typeof body.id === "string" ? body.id : null;
    }
    await route.fallback();
  });

  await triggersJson.fill(
    JSON.stringify(
      [
        validTriggersDraft[0],
        {
          id: "bad/save",
          kind: "webhook",
          enabled: true,
          path: "crm/bad-save",
        },
      ],
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Invalid workflow trigger id: bad/save"),
  ).toBeVisible();
  expect(invalidTriggerSavePatchCount).toBe(0);

  let invalidTriggerPublishPostCount = 0;
  await page.route(`**/api/workflows/${workflowId}/publish`, async (route) => {
    if (route.request().method() === "POST") {
      invalidTriggerPublishPostCount += 1;
    }
    await route.fallback();
  });

  await triggersJson.fill(
    JSON.stringify(
      [
        validTriggersDraft[0],
        {
          id: "bad/publish",
          kind: "webhook",
          enabled: true,
          path: "crm/bad-publish",
        },
      ],
      null,
      2,
    ),
  );
  await page.getByRole("button", { name: "Publish", exact: true }).click();
  await expect(
    page.getByText("Invalid workflow trigger id: bad/publish"),
  ).toBeVisible();
  expect(invalidTriggerPublishPostCount).toBe(0);

  let observingInvalidTriggerTestRun = false;
  let invalidTriggerTestRunPostCount = 0;
  await page.route(
    `**/api/workflows/${workflowId}/runs/test`,
    async (route) => {
      if (
        observingInvalidTriggerTestRun &&
        route.request().method() === "POST"
      ) {
        invalidTriggerTestRunPostCount += 1;
      }
      await route.fallback();
    },
  );

  await triggersJson.fill(
    JSON.stringify(
      [
        validTriggersDraft[0],
        {
          id: "bad/test-run",
          kind: "webhook",
          enabled: true,
          path: "crm/bad-test-run",
        },
      ],
      null,
      2,
    ),
  );
  observingInvalidTriggerTestRun = true;
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(
    page.getByText("Invalid workflow trigger id: bad/test-run"),
  ).toBeVisible();
  observingInvalidTriggerTestRun = false;
  expect(invalidTriggerTestRunPostCount).toBe(0);

  await triggersJson.fill(
    JSON.stringify(
      [
        validTriggersDraft[0],
        {
          id: "incoming_export_a",
          kind: "webhook",
          enabled: true,
          path: "crm/export-only",
        },
        {
          id: "incoming_export_b",
          kind: "webhook",
          enabled: false,
          path: "/crm/export-only/",
        },
      ],
      null,
      2,
    ),
  );
  const noInvalidExportDownload = page
    .waitForEvent("download", { timeout: 500 })
    .then(
      () => false,
      () => true,
    );
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(
    page.getByText("Duplicate workflow webhook path: crm/export-only"),
  ).toBeVisible();
  expect(await noInvalidExportDownload).toBe(true);

  await triggersJson.fill(
    JSON.stringify(
      [
        validTriggersDraft[0],
        {
          id: "bad/trigger",
          kind: "webhook",
          enabled: true,
          path: "crm/bad-trigger",
        },
      ],
      null,
      2,
    ),
  );
  const noInvalidTriggerIdExportDownload = page
    .waitForEvent("download", { timeout: 500 })
    .then(
      () => false,
      () => true,
    );
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(
    page.getByText("Invalid workflow trigger id: bad/trigger"),
  ).toBeVisible();
  expect(await noInvalidTriggerIdExportDownload).toBe(true);

  await triggersJson.fill(
    JSON.stringify(
      [
        validTriggersDraft[0],
        {
          id: "task_export_invalid",
          kind: "task",
          enabled: true,
          filter: { queue: "support" },
        },
      ],
      null,
      2,
    ),
  );
  const noInvalidTriggerSchemaDownload = page
    .waitForEvent("download", { timeout: 500 })
    .then(
      () => false,
      () => true,
    );
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(
    page.getByText(
      "Task trigger task_export_invalid must stay disabled until task dispatch is implemented",
    ),
  ).toBeVisible();
  expect(await noInvalidTriggerSchemaDownload).toBe(true);

  await triggersJson.fill(JSON.stringify(validTriggersDraft, null, 2));
  await expect
    .poll(async () => JSON.parse(await triggersJson.inputValue())[2]?.id)
    .toBe("incoming");
  const scheduledEnabled = page.getByLabel("nightly trigger enabled");
  await expect(scheduledEnabled).toBeChecked();
  await scheduledEnabled.uncheck();
  await expect
    .poll(async () => JSON.parse(await triggersJson.inputValue())[1]?.enabled)
    .toBe(false);
  await scheduledEnabled.check();
  await expect
    .poll(async () => JSON.parse(await triggersJson.inputValue())[1]?.enabled)
    .toBe(true);
  const manualTriggerSchema = page.getByLabel(
    "manual_review trigger input schema",
  );
  await expect(manualTriggerSchema).toHaveValue(/approvalNote/);
  await manualTriggerSchema.fill(
    JSON.stringify(
      {
        type: "object",
        required: ["approvalReason"],
        properties: { approvalReason: { type: "string" } },
      },
      null,
      2,
    ),
  );
  await expect
    .poll(
      async () =>
        JSON.parse(await triggersJson.inputValue())[0]?.inputSchema?.required,
    )
    .toEqual(["approvalReason"]);
  await manualTriggerSchema.fill(
    JSON.stringify(
      {
        type: "object",
        required: ["approvalNote"],
        properties: { approvalNote: { type: "string" } },
      },
      null,
      2,
    ),
  );
  await expect
    .poll(
      async () =>
        JSON.parse(await triggersJson.inputValue())[0]?.inputSchema?.required,
    )
    .toEqual(["approvalNote"]);
  await page.getByLabel("nightly scheduled cron").fill("30 6 * * 1");
  await expect
    .poll(
      async () =>
        JSON.parse(await triggersJson.inputValue())[1]?.schedule?.expr,
    )
    .toBe("30 6 * * 1");
  await page.getByLabel("nightly scheduled cron").fill("");
  await expect
    .poll(
      async () =>
        JSON.parse(await triggersJson.inputValue())[1]?.schedule?.expr,
    )
    .toBe("30 6 * * 1");
  await page.getByLabel("nightly scheduled timezone").fill("Europe/Istanbul");
  await expect
    .poll(
      async () => JSON.parse(await triggersJson.inputValue())[1]?.schedule?.tz,
    )
    .toBe("Europe/Istanbul");
  await page.getByLabel("nightly scheduled input").fill(
    JSON.stringify(
      {
        customer: {
          id: "cust_scheduled",
          name: "Scheduled Ada",
        },
      },
      null,
      2,
    ),
  );
  await expect
    .poll(async () => JSON.parse(await triggersJson.inputValue())[1]?.input)
    .toEqual({
      customer: {
        id: "cust_scheduled",
        name: "Scheduled Ada",
      },
    });
  await page
    .getByLabel("normalize assignment target")
    .fill("normalizedCustomer");
  await expect
    .poll(
      async () =>
        Object.keys(
          JSON.parse(await nodesJson.inputValue())[1]?.assign ?? {},
        )[0],
    )
    .toBe("normalizedCustomer");
  await page
    .getByLabel("normalize assignment target")
    .fill("normalized customer");
  await expect
    .poll(
      async () =>
        Object.keys(
          JSON.parse(await nodesJson.inputValue())[1]?.assign ?? {},
        )[0],
    )
    .toBe("normalizedCustomer");
  await page.getByLabel("normalize assignment target").fill("customer");
  await page
    .getByLabel("normalize assignment source")
    .fill("$.steps.normalize.output.value");
  await expect
    .poll(
      async () =>
        JSON.parse(await nodesJson.inputValue())[1]?.assign?.customer?.from,
    )
    .toBe("$.steps.normalize.output.value");
  await page.getByLabel("normalize assignment source").fill("");
  await expect
    .poll(
      async () =>
        JSON.parse(await nodesJson.inputValue())[1]?.assign?.customer?.from,
    )
    .toBe("$.steps.normalize.output.value");
  await page
    .getByLabel("normalize assignment source")
    .fill("$.steps.normalize.output");
  await page
    .getByLabel("normalize transform input JSON")
    .fill('{\n  "customer": "$.context.customer"\n}');
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[1]?.input)
    .toEqual({ customer: "$.context.customer" });
  await page
    .getByLabel("normalize transform JSON")
    .fill('{\n  "kind": "object_pick",\n  "fields": ["id", "name"]\n}');
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[1]?.transform)
    .toEqual({ kind: "object_pick", fields: ["id", "name"] });
  await page
    .getByRole("combobox", { name: "normalize assignment mode" })
    .click();
  await page.getByRole("option", { name: "merge" }).click();
  await expect
    .poll(
      async () =>
        JSON.parse(await nodesJson.inputValue())[1]?.assign?.customer?.mode,
    )
    .toBe("merge");
  await page
    .getByRole("combobox", { name: "normalize assignment mode" })
    .click();
  await page.getByRole("option", { name: "replace" }).click();
  await page.getByRole("combobox", { name: "exit exit status" }).click();
  await page.getByRole("option", { name: "failed" }).click();
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[3]?.status)
    .toBe("failed");
  await page.getByRole("combobox", { name: "exit exit status" }).click();
  await page.getByRole("option", { name: "succeeded" }).click();
  await page.getByLabel("exit exit output").fill("$.context.customer.id");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[3]?.output)
    .toBe("$.context.customer.id");
  await page.getByLabel("exit exit output").fill("$.context.customer");
  await page.getByLabel("mcp_echo MCP server").fill("qa");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[4]?.server)
    .toBe("qa");
  await page.getByLabel("mcp_echo MCP server").fill("");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[4]?.server)
    .toBe("qa");
  await page.getByLabel("mcp_echo MCP server").fill("demo");
  await page.getByLabel("mcp_echo MCP tool").fill("lookup");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[4]?.tool)
    .toBe("lookup");
  await page.getByLabel("mcp_echo MCP tool").fill("");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[4]?.tool)
    .toBe("lookup");
  await page.getByLabel("mcp_echo MCP tool").fill("echo");
  await expect(page.getByText("Schema Input")).toBeVisible();
  await expect(page.getByLabel("mcp_echo MCP schema message")).toHaveValue(
    "$.workflowTrigger.input.customer.name",
  );
  await page
    .getByLabel("mcp_echo MCP schema message")
    .fill("$.context.customer.name");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[4]?.input)
    .toEqual({ message: "$.context.customer.name" });
  await page.getByLabel("mcp_echo MCP timeout").fill("25000");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[4]?.timeoutMs)
    .toBe(25000);
  await page
    .getByLabel("mcp_echo MCP input JSON")
    .fill('{\n  "message": "$.context.customer.id"\n}');
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[4]?.input)
    .toEqual({ message: "$.context.customer.id" });
  await page.getByLabel("agent_review agent id").fill("agent_qa");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[5]?.agentId)
    .toBe("agent_qa");
  await page.getByLabel("agent_review agent id").fill("");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[5]?.agentId)
    .toBe("agent_qa");
  await page.getByLabel("agent_review agent id").fill("agent_demo");
  await page
    .getByLabel("agent_review agent prompt")
    .fill("Review normalized customer");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[5]?.prompt)
    .toBe("Review normalized customer");
  await page.getByLabel("agent_review agent prompt").fill("");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[5]?.prompt)
    .toBe("Review normalized customer");
  await page
    .getByLabel("agent_review agent prompt")
    .fill("Review workflow input");
  await page.getByLabel("agent_review agent timeout").fill("40000");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[5]?.timeoutMs)
    .toBe(40000);
  await page.getByLabel("agent_review agent timeout").fill("600000");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[5]?.timeoutMs)
    .toBeUndefined();
  await page
    .getByRole("combobox", { name: "agent_review agent picker" })
    .click();
  await expect(page.getByRole("option", { name: /Paused/ })).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[5]?.agentId)
    .toBe("agent_demo");
  await page
    .getByLabel("agent_review agent input JSON")
    .fill('{\n  "customer": "$.context.customer"\n}');
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[5]?.input)
    .toEqual({ customer: "$.context.customer" });
  await page.getByRole("button", { name: "Move normalize up" }).click();
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[0]?.id)
    .toBe("normalize");
  await page.getByRole("button", { name: "Move normalize down" }).click();
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[1]?.id)
    .toBe("normalize");
  await page.getByRole("button", { name: /^Log$/ }).click();
  await expect
    .poll(async () =>
      JSON.parse(await nodesJson.inputValue()).map(
        (node: { id?: string }) => node.id,
      ),
    )
    .toContain("log_07");
  const nodeCards = page.getByLabel("Workflow Node Cards", { exact: true });
  await nodeCards.getByRole("combobox", { name: "log_07 log level" }).click();
  await page.getByRole("option", { name: "error" }).click();
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[6]?.type)
    .toBe("builtin.log.error");
  await nodeCards.getByLabel("log_07 log message").fill("Manual review failed");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[6]?.message)
    .toBe("Manual review failed");
  await nodeCards.getByLabel("log_07 log message").fill("");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[6]?.message)
    .toBe("Manual review failed");
  await nodeCards.getByLabel("log_07 log payload").fill("$.context.customer");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[6]?.payload)
    .toBe("$.context.customer");
  await nodeCards.getByRole("button", { name: "Delete log_07" }).click();
  await expect
    .poll(async () =>
      JSON.parse(await nodesJson.inputValue()).map(
        (node: { id?: string }) => node.id,
      ),
    )
    .not.toContain("log_07");
  await page.getByRole("button", { name: "If", exact: true }).click();
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[6]?.id)
    .toBe("if_07");
  await nodeCards
    .getByLabel("if_07 branch condition")
    .fill("$.workflowTrigger.input.customer.riskScore >= 70");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[6]?.condition)
    .toBe("$.workflowTrigger.input.customer.riskScore >= 70");
  await nodeCards.getByLabel("if_07 branch condition").fill("");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[6]?.condition)
    .toBe("$.workflowTrigger.input.customer.riskScore >= 70");
  await nodeCards
    .getByLabel("if_07 then nodes")
    .fill("mcp_echo, missing_step");
  await expect(page.getByText("invalid refs")).toBeVisible();
  await expect(
    page.getByText("Node if_07 then references missing node missing_step"),
  ).toBeVisible();
  await nodeCards.getByLabel("if_07 then nodes").fill("mcp_echo, exit");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[6]?.then)
    .toEqual(["mcp_echo", "exit"]);
  await nodeCards.getByLabel("if_07 else nodes").fill("agent_review");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[6]?.else)
    .toEqual(["agent_review"]);
  await page.getByRole("button", { name: "Foreach" }).click();
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[7]?.id)
    .toBe("foreach_08");
  await nodeCards
    .getByLabel("foreach_08 foreach items")
    .fill("$.workflowTrigger.input.customers");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[7]?.items)
    .toBe("$.workflowTrigger.input.customers");
  await nodeCards.getByLabel("foreach_08 foreach items").fill("");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[8]?.items)
    .toBe("$.workflowTrigger.input.customers");
  await nodeCards
    .getByLabel("foreach_09 foreach item variable")
    .fill("customer");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[8]?.itemVar)
    .toBe("customer");
  await nodeCards.getByLabel("foreach_09 foreach item variable").fill("");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[8]?.itemVar)
    .toBe("customer");
  await nodeCards
    .getByLabel("foreach_09 foreach body nodes")
    .fill("normalize, exit");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[8]?.body)
    .toEqual(["normalize", "exit"]);
  await nodeCards.getByLabel("foreach_09 foreach concurrency").fill("2");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[8]?.concurrency)
    .toBeUndefined();
  await page.getByRole("button", { name: "Python" }).click();
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[9]?.id)
    .toBe("python_10");
  await nodeCards
    .getByLabel("python_10 python input")
    .fill('{\n  "customer": "$.workflowTrigger.input.customer"\n}');
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[9]?.input)
    .toEqual({ customer: "$.workflowTrigger.input.customer" });
  await nodeCards.getByLabel("python_10 python timeout").fill("45000");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[9]?.timeoutMs)
    .toBe(45000);
  await nodeCards.getByLabel("python_10 python timeout").fill("600000");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[9]?.timeoutMs)
    .toBeUndefined();
  await nodeCards.getByLabel("python_10 python reset").check();
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[9]?.reset)
    .toBe(true);
  await nodeCards
    .getByLabel("python_10 python code")
    .fill("output = {'name': input.get('name')}");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[9]?.code)
    .toBe("output = {'name': input.get('name')}");
  await nodeCards.getByLabel("python_10 python code").fill("");
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[9]?.code)
    .toBe("output = {'name': input.get('name')}");

  const draftTrigger = page.getByRole("group", {
    name: "Trigger manual_review",
  });
  await expect(draftTrigger.getByText("manual_review")).toBeVisible();
  await expect(
    draftTrigger
      .locator('[data-slot="badge"]')
      .filter({ hasText: /^input schema$/ }),
  ).toBeVisible();
  await expect(
    draftTrigger.getByRole("button", { name: "Run" }),
  ).toBeDisabled();
  const webhookEnabled = page.getByLabel("incoming trigger enabled");
  await expect(webhookEnabled).toBeChecked();
  await webhookEnabled.uncheck();
  await expect
    .poll(async () => JSON.parse(await triggersJson.inputValue())[2]?.enabled)
    .toBe(false);
  await webhookEnabled.check();
  await expect
    .poll(async () => JSON.parse(await triggersJson.inputValue())[2]?.enabled)
    .toBe(true);
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Draft saved")).toBeVisible();
  const savedFutureTrigger = page.getByRole("group", {
    name: "Trigger incoming",
  });
  await expect(savedFutureTrigger.getByText("webhook")).toBeVisible();
  await expect(savedFutureTrigger.getByText("enabled")).toBeVisible();
  await expect(
    savedFutureTrigger
      .locator('[data-slot="badge"]')
      .filter({ hasText: /^input schema$/ }),
  ).toBeVisible();
  await expect(page.getByLabel("incoming webhook path")).toHaveValue(
    "/workflow-ui-smoke",
  );
  await page.getByLabel("incoming webhook path").fill("/workflow-ui-smoke-v2");
  await expect
    .poll(async () => JSON.parse(await triggersJson.inputValue())[2]?.path)
    .toBe("/workflow-ui-smoke-v2");
  await page
    .getByLabel("incoming webhook secret sha-256")
    .fill(webhookSecretSha256);
  await expect
    .poll(
      async () => JSON.parse(await triggersJson.inputValue())[2]?.secretSha256,
    )
    .toBe(webhookSecretSha256);
  await page.getByLabel("incoming webhook secret sha-256").fill("not-a-sha");
  await expect
    .poll(
      async () => JSON.parse(await triggersJson.inputValue())[2]?.secretSha256,
    )
    .toBe(webhookSecretSha256);
  const taskFilter = page.getByLabel("task_gate task filter");
  await expect(taskFilter).toHaveValue(/support/);
  await taskFilter.fill(
    JSON.stringify(
      {
        queue: "escalations",
        priority: ["high", "urgent"],
        labels: { region: "emea" },
      },
      null,
      2,
    ),
  );
  await expect
    .poll(async () => JSON.parse(await triggersJson.inputValue())[3]?.filter)
    .toEqual({
      queue: "escalations",
      priority: ["high", "urgent"],
      labels: { region: "emea" },
    });
  const validNodesDraftBeforeExport = await nodesJson.inputValue();
  await nodesJson.fill(
    JSON.stringify(
      [
        {
          id: "log_save_invalid",
          type: "builtin.log.info",
        },
      ],
      null,
      2,
    ),
  );
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[0]?.id)
    .toBe("log_save_invalid");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    page.getByText("Workflow node log_save_invalid needs a message"),
  ).toBeVisible();
  expect(invalidNodeSavePatchCount).toBe(0);
  await nodesJson.fill(validNodesDraftBeforeExport);
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[0]?.id)
    .toBe("set_customer");

  await nodesJson.fill(
    JSON.stringify(
      [
        {
          id: "log_export_invalid",
          type: "builtin.log.info",
        },
      ],
      null,
      2,
    ),
  );
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[0]?.id)
    .toBe("log_export_invalid");
  const noInvalidNodeExportDownload = page
    .waitForEvent("download", { timeout: 500 })
    .then(
      () => false,
      () => true,
    );
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(
    page.getByText("Workflow node log_export_invalid needs a message"),
  ).toBeVisible();
  expect(await noInvalidNodeExportDownload).toBe(true);
  await nodesJson.fill(validNodesDraftBeforeExport);
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[0]?.id)
    .toBe("set_customer");

  await nodesJson.fill(
    JSON.stringify(
      [
        {
          id: "task_deferred_export",
          type: "agent.task",
          agentId: "support",
          prompt: "Open a durable task",
        },
      ],
      null,
      2,
    ),
  );
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[0]?.id)
    .toBe("task_deferred_export");
  const noDeferredAgentTaskExportDownload = page
    .waitForEvent("download", { timeout: 500 })
    .then(
      () => false,
      () => true,
    );
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(
    page.getByText(
      "Workflow node task_deferred_export uses deferred agent.task; agent.task is not available in the first workflow release",
    ),
  ).toBeVisible();
  expect(await noDeferredAgentTaskExportDownload).toBe(true);
  await nodesJson.fill(validNodesDraftBeforeExport);
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[0]?.id)
    .toBe("set_customer");

  await nodesJson.fill(
    JSON.stringify(
      [
        {
          id: "bad/node",
          type: "builtin.log.info",
          message: "Invalid id should not export",
        },
      ],
      null,
      2,
    ),
  );
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[0]?.id)
    .toBe("bad/node");
  const noInvalidNodeIdExportDownload = page
    .waitForEvent("download", { timeout: 500 })
    .then(
      () => false,
      () => true,
    );
  await page.getByRole("button", { name: "Export", exact: true }).click();
  await expect(
    page.getByRole("main").getByText("Invalid workflow node id: bad/node"),
  ).toBeVisible();
  expect(await noInvalidNodeIdExportDownload).toBe(true);
  await nodesJson.fill(validNodesDraftBeforeExport);
  await expect
    .poll(async () => JSON.parse(await nodesJson.inputValue())[0]?.id)
    .toBe("set_customer");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(
    new RegExp(`^workflow-ui-trigger-smoke-${workflowId}-v1\\.json$`),
  );
  const downloadPath = await download.path();
  expect(downloadPath).toBeTruthy();
  const exported = JSON.parse(readFileSync(downloadPath!, "utf8")) as {
    format?: string;
    workflow?: {
      id?: string;
      version?: number;
      status?: string;
      name?: string;
      description?: string;
      inputSchema?: { required?: string[] };
      triggers?: Array<{
        id?: string;
        kind?: string;
        enabled?: boolean;
        inputSchema?: { required?: string[] };
        schedule?: { expr?: string; tz?: string };
        input?: unknown;
        path?: string;
        secretSha256?: string;
        filter?: unknown;
      }>;
      nodes?: Array<{ id?: string; label?: string; type?: string }>;
    };
  };
  expect(exported.format).toBe("openacme.workflow.definition.v1");
  expect(exported.workflow?.id).toBe(workflowId);
  expect(exported.workflow?.version).toBe(1);
  expect(exported.workflow?.status).toBe("draft");
  expect(exported.workflow?.name).toBe("Workflow UI Trigger Smoke");
  expect(exported.workflow).not.toHaveProperty("description");
  expect(exported.workflow?.inputSchema?.required).toEqual(["customer"]);
  expect(exported.workflow?.triggers?.[0]?.inputSchema?.required).toEqual([
    "approvalNote",
  ]);
  expect(exported.workflow?.triggers?.[1]?.schedule).toMatchObject({
    expr: "30 6 * * 1",
    tz: "Europe/Istanbul",
  });
  expect(exported.workflow?.triggers?.[1]?.enabled).toBe(true);
  expect(exported.workflow?.triggers?.[1]?.input).toEqual({
    customer: {
      id: "cust_scheduled",
      name: "Scheduled Ada",
    },
  });
  expect(exported.workflow?.triggers?.[2]).toEqual({
    id: "incoming",
    kind: "webhook",
    enabled: true,
    path: "/workflow-ui-smoke-v2",
    secretSha256: webhookSecretSha256,
    inputSchema: {
      type: "object",
      required: ["source"],
      properties: { source: { const: "crm" } },
    },
  });
  expect(exported.workflow?.triggers?.[3]).toMatchObject({
    id: "task_gate",
    kind: "task",
    enabled: false,
    filter: {
      queue: "escalations",
      priority: ["high", "urgent"],
      labels: { region: "emea" },
    },
  });
  expect(exported.workflow?.nodes?.[0]).toMatchObject({
    id: "set_customer",
    label: "Load customer",
    type: "builtin.set",
  });
  await expect(page.getByText("Workflow exported")).toBeVisible();

  const published = await request.post(`/api/workflows/${workflowId}/publish`, {
    data: {},
  });
  expect(published.ok()).toBeTruthy();

  await page.reload();
  const runnableTrigger = page.getByRole("group", {
    name: "Trigger manual_review",
  });
  await expect(
    runnableTrigger.getByRole("button", { name: "Run" }),
  ).toBeEnabled();
  const validPublishedTriggersDraft = await triggersJson.inputValue();
  let observingInvalidTriggerCardRun = false;
  let invalidTriggerCardRunPostCount = 0;
  await page.route(
    `**/api/workflows/${workflowId}/triggers/manual_review/runs`,
    async (route) => {
      if (
        observingInvalidTriggerCardRun &&
        route.request().method() === "POST"
      ) {
        invalidTriggerCardRunPostCount += 1;
      }
      await route.fallback();
    },
  );
  await triggersJson.fill(
    JSON.stringify(
      [
        exported.workflow?.triggers?.[0],
        {
          id: "bad/trigger-card-run",
          kind: "webhook",
          enabled: true,
          path: "crm/bad-trigger-card-run",
        },
      ],
      null,
      2,
    ),
  );
  await page.getByLabel("Run input").fill(
    JSON.stringify(
      {
        customer: {
          id: "cust_1",
          name: "Ada",
          riskScore: 42,
        },
        approvalNote: "Reviewed in console",
      },
      null,
      2,
    ),
  );
  observingInvalidTriggerCardRun = true;
  await runnableTrigger.getByRole("button", { name: "Run" }).click();
  await expect(
    page.getByText("Invalid workflow trigger id: bad/trigger-card-run"),
  ).toBeVisible();
  observingInvalidTriggerCardRun = false;
  expect(invalidTriggerCardRunPostCount).toBe(0);
  await triggersJson.fill(validPublishedTriggersDraft);
  await expect
    .poll(async () => JSON.parse(await triggersJson.inputValue())[2]?.id)
    .toBe("incoming");
  await page.getByLabel("Run input").fill("{}");
  await runnableTrigger.getByRole("button", { name: "Run" }).click();
  await expect(
    page.getByText("Input does not match schema: $.customer is required"),
  ).toBeVisible();
  await page.getByLabel("Run input").fill(
    JSON.stringify(
      {
        customer: {
          id: "cust_1",
          name: "Ada",
          riskScore: 42,
        },
      },
      null,
      2,
    ),
  );
  await runnableTrigger.getByRole("button", { name: "Run" }).click();
  await expect(
    page.getByText(
      "Trigger input does not match schema: $.approvalNote is required",
    ),
  ).toBeVisible();
  await page.getByLabel("Run input").fill(
    JSON.stringify(
      {
        customer: {
          id: "cust_1",
          name: "Ada",
          riskScore: 42,
        },
        approvalNote: "Reviewed in console",
      },
      null,
      2,
    ),
  );
  await runnableTrigger.getByRole("button", { name: "Run" }).click();

  await expect(page.getByText("Trigger run complete")).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("run"))
    .not.toBeNull();
  const selectedRunId = new URL(page.url()).searchParams.get("run")!;
  const runConsole = page.getByLabel("Run Console", { exact: true });
  await expect(runConsole).toContainText("succeeded");
  await expect(runConsole).toContainText("current none");
  await expect(runConsole).toContainText("waiting none");
  const runDetailHeader = runConsole.getByRole("region", {
    name: "Run detail header",
  });
  await expect(runDetailHeader).toContainText("Workflow UI Trigger Smoke");
  await expect(runDetailHeader).toContainText("trigger manual_review");
  const workflowRefreshPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/workflow-runs/${selectedRunId}`) &&
      response.status() === 200,
  );
  await runConsole.getByRole("button", { name: "Refresh" }).click();
  await workflowRefreshPromise;
  const workflowHistoryRow = runConsole
    .locator("button")
    .filter({ hasText: "trigger manual_review" })
    .first();
  await expect(workflowHistoryRow).toBeVisible();
  await expect(workflowHistoryRow).toContainText("v2");
  await expect(workflowHistoryRow).toContainText("published");
  await expect(
    runConsole.getByRole("button", {
      name: /log_customer .*retry 0 .*succeeded/,
    }),
  ).toBeVisible();
  await runConsole
    .getByRole("button", { name: /log_customer .* succeeded/ })
    .click();
  const selectedStepMetadata = runConsole.getByRole("group", {
    name: "Selected step metadata",
  });
  await expect(selectedStepMetadata).toContainText("type builtin.log.info");
  await expect(selectedStepMetadata).toContainText(
    "label Log normalized customer",
  );
  await expect(selectedStepMetadata).toContainText(/duration \d+ms/);
  await expect(selectedStepMetadata).toContainText("started ");
  await expect(selectedStepMetadata).toContainText("ended ");
  await expect(
    runConsole.getByRole("group", { name: "Logs JSON" }),
  ).toContainText("Customer normalized in workflow console");
  await expect(
    runConsole.getByRole("group", { name: "Logs JSON" }),
  ).toContainText('"id": "cust_1"');
  await expect(
    runConsole.getByRole("group", { name: "Trigger JSON" }),
  ).toContainText("manual_review");

  const webhookTrigger = page.getByRole("group", {
    name: "Trigger incoming",
  });
  await expect(
    webhookTrigger.getByRole("button", { name: "Run" }),
  ).toBeEnabled();
  const runInput = page.getByRole("textbox", { name: "Run input" });
  await runInput.fill(
    JSON.stringify(
      {
        source: "manual",
        customer: {
          id: "cust_webhook_blocked",
          name: "Blocked",
        },
      },
      null,
      2,
    ),
  );
  await webhookTrigger.getByRole("button", { name: "Run" }).click();
  await expect(
    page.getByText(
      'Trigger input does not match schema: $.source must equal "crm"',
    ),
  ).toBeVisible();
  await runInput.fill(
    JSON.stringify(
      {
        source: "crm",
        customer: {
          id: "cust_webhook",
          name: "Webhook Ada",
        },
      },
      null,
      2,
    ),
  );
  await webhookTrigger.getByRole("button", { name: "Run" }).click();
  await expect(page.getByText("Trigger run complete")).toBeVisible();
  const webhookHistoryRow = runConsole
    .locator("button")
    .filter({ hasText: "trigger incoming" })
    .first();
  await expect(webhookHistoryRow).toBeVisible();
  await expect(webhookHistoryRow).toContainText("v2");
  await expect(webhookHistoryRow).toContainText("published");
  await expect(
    runConsole.getByRole("group", { name: "Trigger JSON" }),
  ).toContainText("webhook");
  await expect(
    runConsole.getByRole("group", { name: "Trigger JSON" }),
  ).toContainText("incoming");

  const runs = await request.get(`/api/workflows/${workflowId}/runs`);
  expect(runs.ok()).toBeTruthy();
  const payload = (await runs.json()) as {
    runs: Array<{ trigger?: { triggerId?: string } }>;
  };
  expect(payload.runs).toHaveLength(2);
  expect(payload.runs.map((run) => run.trigger?.triggerId).sort()).toEqual([
    "incoming",
    "manual_review",
  ]);

  await page.getByLabel("Import workflow file").setInputFiles({
    name: "invalid-workflow-definition.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        format: "openacme.workflow.definition.v1",
        workflow: {
          name: "Invalid imported workflow",
          triggers: [
            {
              id: "incoming_import_a",
              kind: "webhook",
              enabled: true,
              path: "crm/import-only",
            },
            {
              id: "incoming_import_b",
              kind: "webhook",
              enabled: false,
              path: "/crm/import-only/",
            },
          ],
          nodes: exported.workflow?.nodes ?? [],
        },
      }),
    ),
  });
  await expect(
    page.getByText("Duplicate workflow webhook path: crm/import-only"),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("id")).toBe(workflowId);

  await page.getByLabel("Import workflow file").setInputFiles({
    name: "invalid-workflow-trigger-schema.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        format: "openacme.workflow.definition.v1",
        workflow: {
          name: "Invalid imported trigger schema",
          triggers: [
            {
              id: "task_import_invalid",
              kind: "task",
              enabled: true,
              filter: { queue: "support" },
            },
          ],
          nodes: exported.workflow?.nodes ?? [],
        },
      }),
    ),
  });
  await expect(
    page.getByText(
      "Task trigger task_import_invalid must stay disabled until task dispatch is implemented",
    ),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("id")).toBe(workflowId);

  await page.getByLabel("Import workflow file").setInputFiles({
    name: "invalid-workflow-description.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        format: "openacme.workflow.definition.v1",
        workflow: {
          name: "Invalid imported description",
          description: { text: "not a string" },
          triggers: exported.workflow?.triggers ?? [],
          nodes: exported.workflow?.nodes ?? [],
        },
      }),
    ),
  });
  await expect(
    page.getByText("Imported workflow description must be a string"),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("id")).toBe(workflowId);

  await page.getByLabel("Import workflow file").setInputFiles({
    name: "invalid-workflow-node.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        format: "openacme.workflow.definition.v1",
        workflow: {
          name: "Invalid imported node",
          triggers: exported.workflow?.triggers ?? [],
          nodes: [
            {
              id: "log_import_invalid",
              type: "builtin.log.info",
            },
          ],
        },
      }),
    ),
  });
  await expect(
    page.getByText("Imported workflow node log_import_invalid needs a message"),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("id")).toBe(workflowId);

  await page.getByLabel("Import workflow file").setInputFiles({
    name: "deferred-agent-task-node.json",
    mimeType: "application/json",
    buffer: Buffer.from(
      JSON.stringify({
        format: "openacme.workflow.definition.v1",
        workflow: {
          name: "Deferred agent task workflow",
          triggers: exported.workflow?.triggers ?? [],
          nodes: [
            {
              id: "task_deferred_import",
              type: "agent.task",
              agentId: "support",
              prompt: "Open a durable task",
            },
          ],
        },
      }),
    ),
  });
  await expect(
    page.getByText(
      "Imported workflow node task_deferred_import uses deferred agent.task; agent.task is not available in the first workflow release",
    ),
  ).toBeVisible();
  expect(new URL(page.url()).searchParams.get("id")).toBe(workflowId);

  importConflictActive = true;
  await page.getByLabel("Import workflow file").setInputFiles(downloadPath!);
  await expect(page.getByText("Workflow imported as new draft")).toBeVisible();
  importConflictActive = false;
  expect(importConflictPatchCount).toBe(0);
  expect(importNewDraftPostId).toMatch(/^wf_import_/);
  expect(importNewDraftPostId).not.toBe(workflowId);
  await expect
    .poll(() => new URL(page.url()).searchParams.get("id"))
    .not.toBe(workflowId);
  const importedId = new URL(page.url()).searchParams.get("id");
  expect(importedId).toMatch(/^wf_import_/);
  await expect(
    page.getByRole("heading", { name: "Workflow UI Trigger Smoke" }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Trigger incoming" }).getByText("webhook"),
  ).toBeVisible();
  await expect(
    page
      .getByRole("group", { name: "Trigger incoming" })
      .locator('[data-slot="badge"]')
      .filter({ hasText: /^input schema$/ }),
  ).toBeVisible();
  await expect(page.getByLabel("incoming webhook path")).toHaveValue(
    "/workflow-ui-smoke-v2",
  );
  await expect(page.getByLabel("incoming webhook secret sha-256")).toHaveValue(
    webhookSecretSha256,
  );
  await expect(page.getByLabel("nightly scheduled cron")).toHaveValue(
    "30 6 * * 1",
  );
  await expect(page.getByLabel("nightly scheduled timezone")).toHaveValue(
    "Europe/Istanbul",
  );
  await expect(page.getByLabel("nightly scheduled input")).toHaveValue(
    /cust_scheduled/,
  );
  await expect(page.getByLabel("task_gate task filter")).toHaveValue(
    /escalations/,
  );
  await expect(
    page
      .getByRole("group", { name: "Trigger manual_review" })
      .locator('[data-slot="badge"]')
      .filter({ hasText: /^input schema$/ }),
  ).toBeVisible();
  await expect(page.getByLabel("set_customer card label")).toHaveValue(
    "Load customer",
  );
  await expect
    .poll(async () => JSON.parse(await inputSchemaJson.inputValue()).required)
    .toEqual(["customer"]);
});

async function clickWorkflowHandles(source: Locator, target: Locator) {
  await expect(source).toBeVisible();
  await expect(target).toBeVisible();
  await source.click();
  await target.click();
}

async function addWorkflowStep(
  page: Page,
  canvas: Locator,
  afterNodeId: string | null,
  stepName: string,
  route?: "true" | "false" | "body",
) {
  if (afterNodeId && route) {
    const handle = route === "true" ? "then" : route === "false" ? "else" : route;
    await canvas
      .locator(`[data-workflow-add-branch="${afterNodeId}:${handle}"]`)
      .click();
  } else if (afterNodeId) {
    await canvas.locator(`[data-workflow-add-after="${afterNodeId}"]`).click();
  } else {
    await canvas
      .getByRole("button", { name: "Add workflow step", exact: true })
      .click();
  }
  const dialog = page.getByRole("dialog", {
    name: stepName === "Manual Trigger" ? "Select Trigger" : "Add Step",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  const category = workflowStepTestCategory(stepName);
  if (stepName !== "Manual Trigger") {
    await dialog.getByRole("button", { name: category, exact: true }).click();
  }
  if (stepName === "MCP Tool") {
    await dialog.locator('button[aria-label^="MCP tool "]').first().click();
  } else if (stepName === "Agent Call") {
    await dialog.locator('button[aria-label^="Agent "]').first().click();
  } else {
    await dialog.getByRole("button", { name: stepName, exact: true }).click();
  }
  await expect(dialog).toBeHidden();
}

function workflowStepTestCategory(
  stepName: string,
): "Trigger" | "Built-in" | "Logic" | "AI" | "Tools" {
  if (stepName === "Manual Trigger") return "Trigger";
  if (stepName === "MCP Tool" || stepName.startsWith("MCP tool ")) {
    return "Tools";
  }
  if (stepName === "Agent Call" || stepName.startsWith("Agent ")) return "AI";
  if (["If", "Foreach"].includes(stepName)) return "Logic";
  return "Built-in";
}

function workflowRun({
  id,
  workflowId,
  status,
  currentNodeId,
  startedAt,
  endedAt = null,
}: {
  id: string;
  workflowId: string;
  status: "running" | "succeeded" | "canceled";
  currentNodeId: string | null;
  startedAt: string;
  endedAt?: string | null;
}) {
  return {
    id,
    workflowId,
    workflowVersion: 1,
    definitionSource: "draft",
    mode: "test",
    trigger: { kind: "manual", triggerId: "manual" },
    status,
    input: { customerId: "cust_auto" },
    context:
      status === "succeeded" || status === "canceled"
        ? { customerId: "cust_auto" }
        : {},
    currentNodeId,
    waitingReason: null,
    createdAt: startedAt,
    startedAt,
    endedAt,
  };
}

function runDetail(run: ReturnType<typeof workflowRun>) {
  const lookupStep = {
    id: `${run.id}:lookup:1`,
    runId: run.id,
    nodeId: "lookup",
    attempt: 1,
    status:
      run.status === "succeeded"
        ? "succeeded"
        : run.status === "canceled"
          ? "canceled"
          : "running",
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs:
      run.status === "succeeded" || run.status === "canceled" ? 1000 : null,
    input: { id: "cust_auto" },
    ...(run.status === "succeeded" || run.status === "canceled"
      ? { output: { id: "cust_auto", name: "Auto Ada" } }
      : {}),
  };
  const notifyStep = {
    id: `${run.id}:notify:1`,
    runId: run.id,
    nodeId: "notify",
    attempt: 1,
    status:
      run.status === "succeeded"
        ? "succeeded"
        : run.status === "canceled"
          ? "canceled"
          : "queued",
    startedAt:
      run.status === "succeeded" || run.status === "canceled"
        ? run.startedAt
        : null,
    endedAt: run.endedAt,
    durationMs:
      run.status === "succeeded" || run.status === "canceled" ? 1000 : null,
    ...(run.status === "succeeded" || run.status === "canceled"
      ? { output: { message: "notified" } }
      : {}),
  };
  return {
    run,
    steps: [lookupStep, notifyStep],
    events: [
      {
        id: `${run.id}:event:1`,
        runId: run.id,
        stepRunId: null,
        sequence: 1,
        level: "system",
        kind: "run_started",
        message: "Workflow run started",
        createdAt: run.startedAt,
      },
      {
        id: `${run.id}:event:2`,
        runId: run.id,
        stepRunId: lookupStep.id,
        sequence: 2,
        level: "system",
        kind: "step_started",
        message: "Step lookup started",
        payload: { nodeId: "lookup", nodeType: "mcp.tool" },
        createdAt: run.startedAt,
      },
      ...(run.status === "succeeded" || run.status === "canceled"
        ? [
            {
              id: `${run.id}:event:3`,
              runId: run.id,
              stepRunId: lookupStep.id,
              sequence: 3,
              level: "system",
              kind: "step_completed",
              message: "Step lookup completed",
              payload: { status: "succeeded" },
              createdAt: run.endedAt,
            },
            {
              id: `${run.id}:event:4`,
              runId: run.id,
              stepRunId: notifyStep.id,
              sequence: 4,
              level: "system",
              kind: "step_started",
              message: "Step notify started",
              payload: { nodeId: "notify", nodeType: "builtin.log.info" },
              createdAt: run.endedAt,
            },
            {
              id: `${run.id}:event:5`,
              runId: run.id,
              stepRunId: notifyStep.id,
              sequence: 5,
              level: "system",
              kind: "step_completed",
              message: "Step notify completed",
              payload: { status: "succeeded" },
              createdAt: run.endedAt,
            },
            {
              id: `${run.id}:event:6`,
              runId: run.id,
              stepRunId: null,
              sequence: 6,
              level: "system",
              kind:
                run.status === "canceled" ? "run_canceled" : "run_completed",
              message:
                run.status === "canceled"
                  ? "Workflow run canceled"
                  : "Workflow run completed",
              payload: { status: run.status },
              createdAt: run.endedAt,
            },
          ]
        : []),
    ],
  };
}
