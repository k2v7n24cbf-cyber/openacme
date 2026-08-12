import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "@openacme/config";
import { createApp } from "../src/app.js";
import type { AgentManager } from "../src/agent-manager.js";
import type { Hono } from "hono";

let dataDir: string;
let app: Hono;
let manager: AgentManager;
let authToken: string;

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-hosted-routes-"));
  const config = ConfigSchema.parse({
    dataDir,
    model: { provider: "anthropic", model: "claude-sonnet-4-6" },
  });
  ({ app, manager } = await createApp(config));
  const member = manager.authStore.createMember({
    email: "test@example.com",
    password: "test-password-123",
  });
  authToken = manager.authStore.createSession(member.id).token;
});

afterEach(async () => {
  await manager.close();
  rmSync(dataDir, { recursive: true, force: true });
});

function req(p: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("host", "127.0.0.1");
  if (!headers.has("authorization")) {
    headers.set("authorization", `Bearer ${authToken}`);
  }
  return app.request(`http://127.0.0.1${p}`, { ...init, headers });
}

function writeFamily(familyId: string, yaml: string): void {
  const dir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    familyId,
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "family.yaml"), yaml);
}

function familyYaml(id: string, name: string, toolName: string): string {
  return `
id: ${id}
name: ${name}
version: 1
runtime:
  language: python
  entrypoint: ${id}.py
  defaultTimeoutMs: 30000
  inlineResultTokenLimit: 8000
  maxConcurrency: 2
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: declared_egress
  dependencyPolicy:
    installDuringInvocation: false
    allowedPackages: []
tools:
  - name: ${toolName}
    title: ${name} read
    description: Read safe ${name} metadata.
    inputSchema:
      type: object
      properties: {}
      additionalProperties: false
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
`;
}

describe("hosted integrations read-only routes", () => {
  it("lists families from the hosted integrations source catalog", async () => {
    writeFamily("splunk", familyYaml("splunk", "Splunk", "splunk_search"));
    writeFamily("qualys", familyYaml("qualys", "Qualys", "qualys_count_assets"));

    const res = await req("/api/hosted-integrations/families");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      families: [
        {
          id: "qualys",
          name: "Qualys",
          version: 1,
          toolNames: ["qualys_count_assets"],
        },
        {
          id: "splunk",
          name: "Splunk",
          version: 1,
          toolNames: ["splunk_search"],
        },
      ],
    });
  });

  it("returns sanitized family detail and tool metadata", async () => {
    writeFamily("qualys", familyYaml("qualys", "Qualys", "qualys_count_assets"));

    let res = await req("/api/hosted-integrations/families/qualys");
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail).toMatchObject({
      family: {
        summary: {
          id: "qualys",
          toolNames: ["qualys_count_assets"],
        },
      },
    });
    expect(JSON.stringify(detail)).not.toContain("source/families");
    expect(JSON.stringify(detail)).not.toContain("secret");

    res = await req("/api/hosted-integrations/families/qualys/tools");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      tools: [
        {
          name: "qualys_count_assets",
          classification: { operation: "read" },
        },
      ],
    });
  });

  it("404s unknown families and does not expose malformed source contents", async () => {
    writeFamily("broken", "id: Broken Prod\nname: SECRET_TOKEN\nversion: nope\n");

    let res = await req("/api/hosted-integrations/families/missing");
    expect(res.status).toBe(404);

    res = await req("/api/hosted-integrations/families/broken");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });

    res = await req("/api/hosted-integrations/families");
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).not.toContain("SECRET_TOKEN");
  });
});
