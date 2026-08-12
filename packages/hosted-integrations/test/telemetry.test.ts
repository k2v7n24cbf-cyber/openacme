import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createFileHostedIntegrationConfigScopeStore,
  createFileHostedIntegrationDraftStore,
  createFileHostedIntegrationGateway,
  createFileHostedIntegrationGenerationStore,
  createFileHostedIntegrationLockStore,
  createFileHostedIntegrationSecretStore,
  type HostedIntegrationPolicyActor,
  type HostedIntegrationPythonRuntime,
  type HostedIntegrationTelemetry,
  type HostedIntegrationTelemetrySpan,
} from "../src/index.js";

let dataDir: string;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-telemetry-"));
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
  await seedSourceFamily();
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

const actor: HostedIntegrationPolicyActor = {
  id: "agent:analyst",
  kind: "agent",
  roles: ["agent"],
};

describe("hosted integration telemetry", () => {
  it("records success spans with family, tool, generation, actor kind, and no raw args or secrets", async () => {
    const telemetry = new RecordingTelemetry();
    const runtime = fakeRuntime({ result: { count: 2 } });
    const generation = await seedPromotedGeneration();
    await seedConfig();

    await gateway(runtime, telemetry).invoke(
      allowedInvocation({
        generationId: generation.id,
        args: { query: "SECRET_TOKEN raw query" },
      }),
    );

    expect(telemetry.spans).toHaveLength(1);
    expect(telemetry.spans[0]).toMatchObject({
      name: "hosted_integration.invoke",
      status: "ok",
      attributes: expect.objectContaining({
        "openacme.span.type": "hosted_integration_invoke",
        "openacme.hosted_integration.family_id": "qualys",
        "openacme.hosted_integration.tool_name": "qualys_count_assets",
        "openacme.hosted_integration.generation_id": generation.id,
        "openacme.hosted_integration.actor_kind": "agent",
        "openacme.hosted_integration.status": "succeeded",
      }),
    });
    const encoded = JSON.stringify(telemetry);
    expect(encoded).not.toContain("SECRET_TOKEN raw query");
    expect(encoded).not.toContain("token_123");
  });

  it("records policy denied events without runtime dispatch", async () => {
    const telemetry = new RecordingTelemetry();
    const runtime = fakeRuntime({ result: { count: 2 } });
    await seedPromotedGeneration();
    await seedConfig();

    await gateway(runtime, telemetry).invoke({
      ...allowedInvocation(),
      bindings: [],
    });

    expect(runtime.calls).toEqual([]);
    expect(telemetry.spans[0]).toMatchObject({
      status: "error",
      statusMessage: "policy_denied",
      events: [
        {
          name: "openacme.hosted_integration.policy_denied",
          attributes: {
            "openacme.hosted_integration.error_code": "policy_denied",
          },
        },
      ],
    });
  });

  it("increments the large-response metric for artifact responses", async () => {
    const telemetry = new RecordingTelemetry();
    const runtime = fakeRuntime({ result: { blob: "x".repeat(40_000) } });
    const generation = await seedPromotedGeneration();
    await seedConfig();

    await gateway(runtime, telemetry).invoke(
      allowedInvocation({ generationId: generation.id }),
    );

    expect(telemetry.largeResponses).toEqual([
      expect.objectContaining({
        "openacme.hosted_integration.family_id": "qualys",
        "openacme.hosted_integration.tool_name": "qualys_count_assets",
        "openacme.hosted_integration.generation_id": generation.id,
        "openacme.hosted_integration.response_mode": "artifact",
      }),
    ]);
  });
});

class RecordingTelemetry implements HostedIntegrationTelemetry {
  readonly spans: RecordingSpan[] = [];
  readonly largeResponses: Array<Record<string, string | number | boolean>> = [];

  async withInvocationSpan<T>(
    attributes: Record<string, string | number | boolean>,
    fn: (span: HostedIntegrationTelemetrySpan) => Promise<T>,
  ): Promise<T> {
    const span = new RecordingSpan("hosted_integration.invoke", attributes);
    this.spans.push(span);
    return fn(span);
  }

  recordLargeResponse(
    attributes: Record<string, string | number | boolean>,
  ): void {
    this.largeResponses.push(attributes);
  }
}

class RecordingSpan implements HostedIntegrationTelemetrySpan {
  readonly events: Array<{
    name: string;
    attributes?: Record<string, string | number | boolean>;
  }> = [];
  readonly attributes: Record<string, string | number | boolean>;
  status: "ok" | "error" | null = null;
  statusMessage: string | null = null;

  constructor(
    readonly name: string,
    attributes: Record<string, string | number | boolean>,
  ) {
    this.attributes = { ...attributes };
  }

  setAttributes(attributes: Record<string, string | number | boolean>): void {
    Object.assign(this.attributes, attributes);
  }

  addEvent(
    name: string,
    attributes?: Record<string, string | number | boolean>,
  ): void {
    this.events.push({ name, attributes });
  }

  recordException(): void {}

  setStatusOk(): void {
    this.status = "ok";
  }

  setStatusError(message: string): void {
    this.status = "error";
    this.statusMessage = message;
  }
}

function gateway(runtime: FakeRuntime, telemetry: HostedIntegrationTelemetry) {
  return createFileHostedIntegrationGateway({
    dataDir,
    runtime,
    telemetry,
    now: () => new Date(nowMs),
  });
}

function allowedInvocation(
  overrides: Partial<
    Parameters<ReturnType<typeof createFileHostedIntegrationGateway>["invoke"]>[0]
  > = {},
) {
  return {
    actor,
    familyId: "qualys",
    toolName: "qualys_count_assets",
    environment: "test",
    args: { query: "severity:5" },
    bindings: [
      {
        agentId: "agent:analyst",
        familyId: "qualys",
        toolName: "qualys_count_assets",
        allowedConfigScopeIds: ["qualys-test"],
        defaultConfigScopeId: "qualys-test",
        environment: "test",
      },
    ],
    ...overrides,
  };
}

async function seedSourceFamily(): Promise<void> {
  const sourceDir = path.join(
    dataDir,
    "hosted-integrations",
    "source",
    "families",
    "qualys",
  );
  await mkdir(sourceDir, { recursive: true });
  await writeFile(path.join(sourceDir, "family.yaml"), familyYaml(), "utf-8");
  await writeFile(path.join(sourceDir, "qualys.py"), "def run(): pass\n");
}

async function seedPromotedGeneration() {
  const lockStore = createFileHostedIntegrationLockStore({
    dataDir,
    now: () => new Date(nowMs),
    createId: () => "lock_1",
  });
  await lockStore.acquireLock({
    familyId: "qualys",
    lockedBy: "agent:tool-developer",
    ttlMs: 60_000,
  });
  const draftStore = createFileHostedIntegrationDraftStore({
    dataDir,
    lockStore,
    now: () => new Date(nowMs),
    createId: () => "draft_1",
  });
  const draft = await draftStore.createDraftFromFiles({
    familyId: "qualys",
    lockId: "lock_1",
    sourceRevisionId: "source_rev_1",
    files: {
      "family.yaml": familyYaml(),
      "qualys.py": "def run(): pass\n",
    },
  });
  if (!draft.ok) throw new Error(draft.reason);
  const promoted = await createFileHostedIntegrationGenerationStore({
    dataDir,
    draftStore,
    now: () => new Date(nowMs),
    createId: () => "gen_1",
  }).promoteDraft({
    draftId: draft.draft.id,
    promotedBy: "agent:tool-developer",
    validation: { ok: true, diagnostics: [] },
  });
  if (!promoted.ok) throw new Error(promoted.reason);
  return promoted.generation;
}

async function seedConfig(): Promise<void> {
  await createFileHostedIntegrationConfigScopeStore({
    dataDir,
    now: () => new Date(nowMs),
  }).upsertConfigScope({
    scopeId: "qualys-test",
    familyId: "qualys",
    environment: "test",
    config: { endpoint: "https://qualys.example.test" },
    secrets: { apiToken: { configured: true } },
    updatedBy: "human:operator",
  });
  await createFileHostedIntegrationSecretStore({ dataDir }).writeHumanOwnedSecrets({
    scopeId: "qualys-test",
    secrets: { apiToken: "token_123" },
    updatedBy: "human:operator",
  });
}

function familyYaml(): string {
  return `
id: qualys
name: Qualys
version: 1
runtime:
  language: python
  entrypoint: qualys.py
  defaultTimeoutMs: 1000
  inlineResultTokenLimit: 8000
  maxConcurrency: 1
  runtimePolicy:
    filesystem: run_dir_and_family_home
    processEnv: tool_context_only
    subprocess: denied
    network: denied
  dependencyPolicy:
    installDuringInvocation: false
tools:
  - name: qualys_count_assets
    title: Count assets
    description: Count assets matching a safe query.
    inputSchema:
      type: object
      properties:
        query:
          type: string
    classification:
      operation: read
      freshness: live
      idempotency: idempotent
      execution: sync
      approval: none
`;
}

interface FakeRuntime {
  calls: Array<{ generationId: string; toolName: string }>;
  callTool: HostedIntegrationPythonRuntime["callTool"];
}

function fakeRuntime(output: {
  result?: unknown;
  error?: { code: "runtime_error" | "timeout" | "tool_bug"; message: string };
}): FakeRuntime {
  const runtime: FakeRuntime = {
    calls: [],
    callTool: async (request) => {
      runtime.calls.push({
        generationId: request.generationId,
        toolName: String(request.toolName),
      });
      if (output.error) return { ok: false, error: output.error };
      return { ok: true, result: output.result ?? null };
    },
  };
  return runtime;
}
