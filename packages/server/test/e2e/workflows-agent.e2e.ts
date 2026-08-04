import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startE2EServer, type E2EServer } from "./support/harness.js";
import { makeClient } from "./support/client.js";

describe("Workflow agent calls (e2e)", () => {
  let srv: E2EServer;
  let c: ReturnType<typeof makeClient>;

  beforeAll(async () => {
    srv = await startE2EServer();
    c = makeClient(srv.baseUrl);
    await c.createAgent("support", "Support");
  });

  afterAll(async () => {
    await srv.close();
  });

  it("calls an OpenAcme agent from a workflow run and persists the trace", async () => {
    const agents = await c.json("/api/workflows/agents");
    expect(agents.agents).toContainEqual(
      expect.objectContaining({
        id: "support",
        name: "Support",
      }),
    );

    let res = await c.post("/api/workflows", {
      id: "wf_agent_e2e",
      name: "Workflow Agent E2E",
      nodes: [
        {
          id: "ask_support",
          type: "agent.call",
          agentId: "support",
          prompt:
            "Return [[mock:text:workflow support ok]] for {{$.input.customerId}}",
          input: { customerId: "$.input.customerId" },
          assign: {
            support: "$.steps.ask_support.output",
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await c.post("/api/workflows/wf_agent_e2e/runs/test", {
      input: { customerId: "cust_1" },
    });
    expect(res.status).toBe(201);
    const detail = (await res.json()) as {
      run: { id: string; status: string; context: unknown };
      steps: Array<{ nodeId: string; status: string; output?: unknown }>;
      events: Array<{ kind: string }>;
    };

    expect(detail.run.status).toBe("succeeded");
    expect(detail.run.context).toMatchObject({
      support: {
        response: "workflow support ok",
      },
    });
    expect(detail.steps[0]).toMatchObject({
      nodeId: "ask_support",
      status: "succeeded",
      output: {
        response: "workflow support ok",
      },
    });
    expect(detail.events.map((event) => event.kind)).toContain("step_output");

    const support = detail.run.context as {
      support?: { sessionId?: string; assistantMessageId?: string | null };
    };
    expect(support.support?.sessionId).toEqual(expect.any(String));

    const persisted = await c.json(`/api/workflow-runs/${detail.run.id}`);
    expect(persisted.run.status).toBe("succeeded");
    expect(persisted.steps[0].output).toMatchObject({
      response: "workflow support ok",
      sessionId: support.support?.sessionId,
    });
  });
});
