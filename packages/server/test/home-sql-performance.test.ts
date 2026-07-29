import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { performance } from "node:perf_hooks";
import { ConfigSchema } from "@openacme/config";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import type { AgentManager } from "../src/agent-manager.js";
import type { Hono } from "hono";

let dataDir: string;
let app: Hono;
let manager: AgentManager;
let authToken: string;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-home-sql-"));
  const config = ConfigSchema.parse({
    dataDir,
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  });
  ({ app, manager } = await createApp(config));
  const member = manager.authStore.createMember({
    email: "home-sql@example.com",
    password: "test-password-123",
  });
  authToken = manager.authStore.createSession(member.id).token;
});

afterEach(async () => {
  await manager.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function req(p: string): Promise<Response> {
  return app.request(`http://127.0.0.1${p}`, {
    headers: {
      host: "127.0.0.1",
      authorization: `Bearer ${authToken}`,
    },
  });
}

describe("home SQL task performance", () => {
  it("serves /api/home from SQL with hundreds of tasks and no live markdown files", async () => {
    const session = manager.sessionStore.create("load-agent", {
      title: "Load session",
    });

    for (let i = 0; i < 750; i += 1) {
      await manager.taskStore.create({
        title: `SQL task ${i}`,
        assignee: "load-agent",
        created_by: "acme",
        session_id: session.id,
      });
    }

    const taskDir = path.join(dataDir, "tasks");
    const markdownFiles = existsSync(taskDir)
      ? readdirSync(taskDir).filter((name) => name.endsWith(".md"))
      : [];
    expect(markdownFiles).toEqual([]);

    const start = performance.now();
    const res = await req("/api/home");
    const elapsedMs = performance.now() - start;

    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(1_000);
    const body = (await res.json()) as {
      idle: Array<{ sessionId: string; pendingTaskCount: number }>;
    };
    expect(body.idle).toContainEqual(
      expect.objectContaining({
        sessionId: session.id,
        pendingTaskCount: 750,
      }),
    );
  });
});
