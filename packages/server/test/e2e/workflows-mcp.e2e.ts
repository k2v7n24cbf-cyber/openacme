import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { saveGlobalMcpServers } from "@openacme/config";
import { startE2EServer, type E2EServer } from "./support/harness.js";
import { makeClient } from "./support/client.js";
// @ts-expect-error — plain-JS test fixture, no types
import { startMcpHttpServer } from "./support/mcp-http-server.mjs";

describe("Workflow MCP steps (e2e)", () => {
  let srv: E2EServer;
  let c: ReturnType<typeof makeClient>;
  let mcp: { url: string; close: () => Promise<void> };

  beforeAll(async () => {
    mcp = await startMcpHttpServer();
    srv = await startE2EServer();
    c = makeClient(srv.baseUrl);
    saveGlobalMcpServers(srv.dataDir, {
      e2e: { url: mcp.url, transport: "http" },
    });
  });

  afterAll(async () => {
    await srv.close();
    await mcp.close();
  });

  it("discovers and executes a real MCP tool from a workflow run", async () => {
    const tools = await c.json("/api/workflows/mcp/tools");
    expect(tools.tools).toContainEqual(
      expect.objectContaining({
        server: "e2e",
        tool: "echo",
        name: "mcp_e2e__echo",
      }),
    );

    let res = await c.post("/api/workflows", {
      id: "wf_mcp_e2e",
      name: "Workflow MCP E2E",
      nodes: [
        {
          id: "echo_step",
          type: "mcp.tool",
          server: "e2e",
          tool: "echo",
          input: { text: "$.input.text" },
          assign: {
            echoResult: "$.steps.echo_step.output",
          },
        },
      ],
    });
    expect(res.status).toBe(201);

    res = await c.post("/api/workflows/wf_mcp_e2e/runs/test", {
      input: { text: "ping" },
    });
    expect(res.status).toBe(201);
    const detail = await res.json();

    expect(detail.run).toMatchObject({
      status: "succeeded",
      mode: "test",
      context: { echoResult: "echo: ping" },
    });
    expect(detail.steps[0]).toMatchObject({
      nodeId: "echo_step",
      status: "succeeded",
      output: "echo: ping",
    });
    expect(
      detail.events.map((event: { kind: string }) => event.kind),
    ).toContain("step_output");
  });
});
