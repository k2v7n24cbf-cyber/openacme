// Boots a real OpenAcme daemon for Playwright: same Hono app + node-server as
// production, serving the built web bundle (apps/web/out), with the Vercel-SDK
// stub injected via the `resolveModel` seam. No tokens, no network model calls.
//
// Launched by apps/web/playwright.config.ts as its `webServer`. Run from the
// built server dist, so `pnpm build` must have produced packages/server/dist
// and apps/web/out first.
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { serve } from "@hono/node-server";
import { ConfigSchema } from "@openacme/config";
import { createApp } from "../../../dist/index.js";
import { createStubModel } from "./stub-model.mjs";

const PORT = Number(process.env["OPENACME_E2E_PORT"] || 3998);

const requestedDataDir = process.env["OPENACME_E2E_DATA_DIR"];
const dataDir = requestedDataDir
  ? path.resolve(requestedDataDir)
  : mkdtempSync(path.join(tmpdir(), "openacme-web-e2e-"));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
process.env["OPENACME_DATA_DIR"] = dataDir;
// Record only throwaway dirs so Playwright's globalTeardown removes them once
// the run ends. Shared deployed-smoke dirs are intentionally preserved.
if (!requestedDataDir) {
  writeFileSync(path.join(tmpdir(), "openacme-web-e2e.current"), dataDir);
}
process.env["OPENACME_TELEMETRY"] = "";
// Makes /api/keys report a configured provider so the chat page skips the
// first-run setup wizard. Never actually used — resolveModel returns the stub
// for every model call (main turn + title/extractor), so no real request goes
// to OpenRouter.
process.env["OPENROUTER_API_KEY"] = "stub-key";

const config = ConfigSchema.parse({
  dataDir,
  server: { port: PORT, host: "127.0.0.1" },
  // Provider is openrouter to match the configured key above; the actual
  // model call is overridden by resolveModel (the stub).
  model: { provider: "openrouter", model: "anthropic/claude-sonnet-4.6" },
});

const { app, manager } = await createApp(config, {
  resolveModel: () => createStubModel(),
  workflowExecutionPorts: {
    mcp: {
      async listTools() {
        return [
          {
            server: "demo",
            tool: "echo",
            name: "mcp_demo__echo",
            description: "Echo a workflow message",
            inputSchema: {
              type: "object",
              required: ["message"],
              properties: {
                message: { type: "string" },
                customerId: { type: "string" },
              },
            },
          },
        ];
      },
      async callTool(req) {
        return { output: req.input };
      },
    },
  },
});

// Auth is always on. Seed one operator + session, and write a Playwright
// storageState (localStorage bearer) so the browser specs start authenticated.
// Written before serve() so it exists before the health check passes.
const member =
  manager.authStore.getMemberByEmail("e2e@example.com") ??
  manager.authStore.createMember({
    email: "e2e@example.com",
    password: "e2e-password-123",
  });
const authToken = manager.authStore.createSession(member.id).token;
// Session COOKIE (not a localStorage bearer): the browser sends it natively
// on same-origin requests, so it doesn't depend on the app's fetch wrapper
// being active before the first auth check.
writeFileSync(
  path.join(tmpdir(), "openacme-web-e2e.storage.json"),
  JSON.stringify({
    cookies: [
      {
        name: "openacme_session",
        value: authToken,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        secure: false,
        sameSite: "Lax",
        expires: -1,
      },
    ],
    origins: [],
  }),
);

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, async () => {
  // Seed agents so workflow pickers exercise available and disabled states.
  await seedAgent({ id: "helper", name: "Helper" });
  await seedAgent({
    id: "paused",
    name: "Paused",
    instantMessagesEnabled: false,
  });
  // Seed a task so the board renders a real card (not the empty-state preview).
  await manager.taskStore.create({
    title: "Review the Q3 report",
    assignee: "helper",
    created_by: "user",
  });
  console.log(`web-e2e daemon ready on http://127.0.0.1:${PORT}`);
});

async function seedAgent(body) {
  const existing = await fetch(
    `http://127.0.0.1:${PORT}/api/agents/${encodeURIComponent(body.id)}`,
    {
      headers: {
        host: "127.0.0.1",
        authorization: `Bearer ${authToken}`,
      },
    },
  );
  if (existing.status === 200) return;
  const res = await fetch(`http://127.0.0.1:${PORT}/api/agents`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      host: "127.0.0.1",
      authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify(body),
  });
  if (res.status !== 201) {
    console.error(`web-e2e: failed to seed agent ${body.id} (${res.status})`);
    process.exit(1);
  }
}
