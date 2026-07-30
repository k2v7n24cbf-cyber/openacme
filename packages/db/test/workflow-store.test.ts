import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigSchema } from "@openacme/config";
import { WorkflowRunner } from "@openacme/workflows";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDatabase } from "../src/connection.js";
import { createWorkflowStore, type WorkflowStore } from "../src/index.js";

let dataDir: string;
let db: ReturnType<typeof createDatabase>;
let store: WorkflowStore;

const now = "2026-07-30T00:00:00.000Z";
const later = "2026-07-30T00:01:00.000Z";

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "openacme-workflow-store-"));
  db = createDatabase(
    ConfigSchema.parse({
      dataDir,
      model: { provider: "anthropic", model: "claude-sonnet-4-6" },
    }),
  );
  store = createWorkflowStore(db);
});

afterEach(() => {
  db.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("WorkflowStore definitions", () => {
  it("creates and updates mutable drafts", () => {
    const draft = store.createDraft({
      id: "wf_customer",
      name: "Customer workflow",
      nodes: [{ id: "exit", type: "builtin.exit", status: "succeeded" }],
      now,
    });

    expect(draft).toMatchObject({
      id: "wf_customer",
      version: 1,
      status: "draft",
    });

    const updated = store.updateDraft("wf_customer", {
      name: "Customer workflow v2",
      nodes: [
        {
          id: "set_customer",
          type: "builtin.set",
          assign: { customerId: "$.input.customerId" },
        },
      ],
      now: later,
    });

    expect(updated.name).toBe("Customer workflow v2");
    expect(updated.nodes[0]?.type).toBe("builtin.set");
    expect(updated.updatedAt).toBe(later);
  });

  it("round-trips optional workflow UI metadata and snapshots it on publish", () => {
    store.createDraft({
      id: "wf_layout",
      name: "Layout workflow",
      nodes: [{ id: "exit", type: "builtin.exit", status: "succeeded" }],
      ui: {
        canvas: {
          nodes: {
            exit: { position: { x: 120, y: 80 } },
          },
        },
      },
      now,
    });

    expect(store.getDefinition("wf_layout")?.ui).toEqual({
      canvas: {
        nodes: {
          exit: { position: { x: 120, y: 80 } },
        },
      },
    });

    const updated = store.updateDraft("wf_layout", {
      ui: {
        canvas: {
          nodes: {
            exit: { position: { x: 240, y: 160 } },
          },
        },
      },
      now: later,
    });
    expect(updated.ui).toEqual({
      canvas: {
        nodes: {
          exit: { position: { x: 240, y: 160 } },
        },
      },
    });

    const published = store.publish("wf_layout", "2026-07-30T00:02:00.000Z");
    expect(published.ui).toEqual(updated.ui);

    store.updateDraft("wf_layout", {
      ui: null,
      now: "2026-07-30T00:03:00.000Z",
    });

    expect(store.getDefinition("wf_layout")?.ui).toBeUndefined();
    expect(store.getVersion("wf_layout", 2)?.ui).toEqual(updated.ui);
  });

  it("publishes immutable versions while later drafts remain editable", () => {
    store.createDraft({
      id: "wf_publish",
      name: "Publish me",
      nodes: [{ id: "exit", type: "builtin.exit", status: "succeeded" }],
      now,
    });

    const published = store.publish("wf_publish", later);
    expect(published).toMatchObject({
      version: 2,
      status: "published",
      name: "Publish me",
    });

    store.updateDraft("wf_publish", {
      name: "Draft after publish",
      now: "2026-07-30T00:02:00.000Z",
    });

    expect(store.getDefinition("wf_publish")?.name).toBe("Draft after publish");
    expect(store.getVersion("wf_publish", 2)?.name).toBe("Publish me");
  });
});

describe("WorkflowStore run audit", () => {
  it("persists test/live run metadata, step attempts, events, and filters", () => {
    store.createDraft({
      id: "wf_run",
      name: "Runnable",
      nodes: [{ id: "exit", type: "builtin.exit", status: "succeeded" }],
      now,
    });

    const run = store.createRun({
      id: "run_test",
      workflowId: "wf_run",
      workflowVersion: 1,
      mode: "test",
      input: { customerId: "123" },
      context: {},
      createdAt: now,
    });

    expect(run).toMatchObject({
      id: "run_test",
      definitionSource: "published",
      mode: "test",
      status: "queued",
      trigger: { kind: "manual", triggerId: "manual" },
    });

    const step = store.recordStepAttempt({
      id: "step_1",
      runId: "run_test",
      nodeId: "exit",
      attempt: 1,
      status: "succeeded",
      input: { customerId: "123" },
      output: { ok: true },
      contextDiff: { set: { result: true } },
    });

    expect(step).toMatchObject({
      id: "step_1",
      status: "succeeded",
      output: { ok: true },
      contextDiff: { set: { result: true } },
    });

    store.appendRunEvent({
      id: "event_1",
      runId: "run_test",
      stepRunId: "step_1",
      level: "system",
      kind: "step_completed",
      payload: { ok: true },
      createdAt: later,
    });
    store.appendRunEvent({
      id: "event_2",
      runId: "run_test",
      level: "system",
      kind: "run_completed",
      createdAt: later,
    });

    expect(store.listRuns({ workflowId: "wf_run", mode: "test" })).toHaveLength(
      1,
    );
    expect(store.listStepAttempts("run_test")).toHaveLength(1);
    expect(store.listRunEvents("run_test").map((e) => e.sequence)).toEqual([
      1, 2,
    ]);
  });

  it("persists workflow artifact metadata for run detail inspection", () => {
    store.createRun({
      id: "run_artifact",
      workflowId: "wf_artifact",
      workflowVersion: 1,
      mode: "test",
      input: {},
      context: {},
      createdAt: now,
    });
    store.recordStepAttempt({
      id: "step_artifact",
      runId: "run_artifact",
      nodeId: "large_output",
      attempt: 1,
      status: "succeeded",
      output: {
        artifact: {
          id: "artifact_output",
          kind: "step_output",
        },
      },
    });

    const artifact = store.recordArtifact({
      id: "artifact_output",
      runId: "run_artifact",
      stepRunId: "step_artifact",
      kind: "step_output",
      path: "workflows/run_artifact/step_artifact/output.json",
      preview: '{"records":1000}',
      createdAt: later,
    });

    expect(artifact).toEqual({
      id: "artifact_output",
      runId: "run_artifact",
      stepRunId: "step_artifact",
      kind: "step_output",
      path: "workflows/run_artifact/step_artifact/output.json",
      preview: '{"records":1000}',
      createdAt: later,
    });
    expect(store.listArtifacts("run_artifact")).toEqual([artifact]);
  });

  it("spills large step outputs to workflow artifacts", () => {
    const spillStore = createWorkflowStore(db, {
      artifactRoot: path.join(dataDir, "workflow-artifacts"),
      inlineJsonByteLimit: 160,
      artifactPreviewBytes: 80,
    });
    spillStore.createRun({
      id: "run_spill",
      workflowId: "wf_spill",
      workflowVersion: 1,
      mode: "test",
      input: {},
      context: {},
      createdAt: now,
    });
    const largeOutput = {
      records: Array.from({ length: 4 }, (_, index) => ({
        id: index,
        name: `Customer ${index} ${"x".repeat(80)}`,
        apiKey: `raw-output-key-${index}`,
      })),
    };

    const step = spillStore.recordStepAttempt({
      id: "step_spill",
      runId: "run_spill",
      nodeId: "large_output",
      attempt: 1,
      status: "succeeded",
      output: largeOutput,
      endedAt: later,
    });

    expect(step.output).toMatchObject({
      artifact: {
        id: "step_spill_output",
        kind: "step_output",
        path: "runs/run_spill/steps/step_spill/output.json",
        preview: expect.stringContaining('"records"'),
        byteLength: expect.any(Number),
      },
    });
    expect(JSON.stringify(step.output)).not.toContain("raw-output-key");

    const [artifact] = spillStore.listArtifacts("run_spill");
    expect(artifact).toMatchObject({
      id: "step_spill_output",
      runId: "run_spill",
      stepRunId: "step_spill",
      kind: "step_output",
      path: "runs/run_spill/steps/step_spill/output.json",
      preview: expect.stringContaining('"records"'),
      createdAt: later,
    });

    const artifactPath = path.join(
      dataDir,
      "workflow-artifacts",
      "runs/run_spill/steps/step_spill/output.json",
    );
    expect(existsSync(artifactPath)).toBe(true);
    const artifactJson = readFileSync(artifactPath, "utf8");
    expect(artifactJson).toContain('"[redacted]"');
    expect(artifactJson).not.toContain("raw-output-key");
  });

  it("spills large event payloads to workflow artifacts", () => {
    const spillStore = createWorkflowStore(db, {
      artifactRoot: path.join(dataDir, "workflow-artifacts"),
      inlineJsonByteLimit: 160,
      artifactPreviewBytes: 80,
    });
    spillStore.createRun({
      id: "run_event_spill",
      workflowId: "wf_event_spill",
      workflowVersion: 1,
      mode: "test",
      input: {},
      context: {},
      createdAt: now,
    });
    const largePayload = {
      output: {
        records: "x".repeat(400),
        apiKey: "raw-event-payload-key",
      },
    };

    const event = spillStore.appendRunEvent({
      id: "event_spill",
      runId: "run_event_spill",
      level: "system",
      kind: "step_output",
      payload: largePayload,
      createdAt: later,
    });

    expect(event.payload).toMatchObject({
      artifact: {
        id: "event_spill_payload",
        kind: "event_payload",
        path: "runs/run_event_spill/events/event_spill/payload.json",
        preview: expect.stringContaining('"output"'),
        byteLength: expect.any(Number),
      },
    });
    expect(JSON.stringify(event.payload)).not.toContain(
      "raw-event-payload-key",
    );

    const [artifact] = spillStore.listArtifacts("run_event_spill");
    expect(artifact).toMatchObject({
      id: "event_spill_payload",
      runId: "run_event_spill",
      stepRunId: null,
      kind: "event_payload",
      path: "runs/run_event_spill/events/event_spill/payload.json",
      preview: expect.stringContaining('"output"'),
      createdAt: later,
    });

    const artifactPath = path.join(
      dataDir,
      "workflow-artifacts",
      "runs/run_event_spill/events/event_spill/payload.json",
    );
    expect(existsSync(artifactPath)).toBe(true);
    const artifactJson = readFileSync(artifactPath, "utf8");
    expect(artifactJson).toContain('"[redacted]"');
    expect(artifactJson).not.toContain("raw-event-payload-key");
  });

  it("spills large step errors to workflow artifacts", () => {
    const spillStore = createWorkflowStore(db, {
      artifactRoot: path.join(dataDir, "workflow-artifacts"),
      inlineJsonByteLimit: 160,
      artifactPreviewBytes: 80,
    });
    spillStore.createRun({
      id: "run_error_spill",
      workflowId: "wf_error_spill",
      workflowVersion: 1,
      mode: "test",
      input: {},
      context: {},
      createdAt: now,
    });

    const step = spillStore.recordStepAttempt({
      id: "step_error_spill",
      runId: "run_error_spill",
      nodeId: "large_error",
      attempt: 1,
      status: "failed",
      error: {
        name: "Error",
        message: "large failure",
        details: {
          records: "x".repeat(400),
          apiKey: "raw-step-error-key",
        },
      },
      endedAt: later,
    });

    expect(step.error).toMatchObject({
      artifact: {
        id: "step_error_spill_error",
        kind: "step_error",
        path: "runs/run_error_spill/steps/step_error_spill/error.json",
        preview: expect.stringContaining('"large failure"'),
        byteLength: expect.any(Number),
      },
    });
    expect(JSON.stringify(step.error)).not.toContain("raw-step-error-key");

    const [artifact] = spillStore.listArtifacts("run_error_spill");
    expect(artifact).toMatchObject({
      id: "step_error_spill_error",
      runId: "run_error_spill",
      stepRunId: "step_error_spill",
      kind: "step_error",
      path: "runs/run_error_spill/steps/step_error_spill/error.json",
      preview: expect.stringContaining('"large failure"'),
      createdAt: later,
    });

    const artifactPath = path.join(
      dataDir,
      "workflow-artifacts",
      "runs/run_error_spill/steps/step_error_spill/error.json",
    );
    expect(existsSync(artifactPath)).toBe(true);
    const artifactJson = readFileSync(artifactPath, "utf8");
    expect(artifactJson).toContain('"[redacted]"');
    expect(artifactJson).not.toContain("raw-step-error-key");
  });

  it("spills large step logs summaries to workflow artifacts", () => {
    const spillStore = createWorkflowStore(db, {
      artifactRoot: path.join(dataDir, "workflow-artifacts"),
      inlineJsonByteLimit: 160,
      artifactPreviewBytes: 80,
    });
    spillStore.createRun({
      id: "run_logs_spill",
      workflowId: "wf_logs_spill",
      workflowVersion: 1,
      mode: "test",
      input: {},
      context: {},
      createdAt: now,
    });

    const step = spillStore.recordStepAttempt({
      id: "step_logs_spill",
      runId: "run_logs_spill",
      nodeId: "large_logs",
      attempt: 1,
      status: "succeeded",
      logsSummary: {
        lines: ["large log summary", "x".repeat(400)],
        apiKey: "raw-step-logs-key",
      },
      endedAt: later,
    });

    expect(step.logsSummary).toMatchObject({
      artifact: {
        id: "step_logs_spill_logs_summary",
        kind: "step_logs_summary",
        path: "runs/run_logs_spill/steps/step_logs_spill/logs-summary.json",
        preview: expect.stringContaining('"large log summary"'),
        byteLength: expect.any(Number),
      },
    });
    expect(JSON.stringify(step.logsSummary)).not.toContain("raw-step-logs-key");

    const [artifact] = spillStore.listArtifacts("run_logs_spill");
    expect(artifact).toMatchObject({
      id: "step_logs_spill_logs_summary",
      runId: "run_logs_spill",
      stepRunId: "step_logs_spill",
      kind: "step_logs_summary",
      path: "runs/run_logs_spill/steps/step_logs_spill/logs-summary.json",
      preview: expect.stringContaining('"large log summary"'),
      createdAt: later,
    });

    const artifactPath = path.join(
      dataDir,
      "workflow-artifacts",
      "runs/run_logs_spill/steps/step_logs_spill/logs-summary.json",
    );
    expect(existsSync(artifactPath)).toBe(true);
    const artifactJson = readFileSync(artifactPath, "utf8");
    expect(artifactJson).toContain('"[redacted]"');
    expect(artifactJson).not.toContain("raw-step-logs-key");
  });

  it("spills large step context diffs to workflow artifacts", () => {
    const spillStore = createWorkflowStore(db, {
      artifactRoot: path.join(dataDir, "workflow-artifacts"),
      inlineJsonByteLimit: 160,
      artifactPreviewBytes: 80,
    });
    spillStore.createRun({
      id: "run_context_diff_spill",
      workflowId: "wf_context_diff_spill",
      workflowVersion: 1,
      mode: "test",
      input: {},
      context: {},
      createdAt: now,
    });

    const step = spillStore.recordStepAttempt({
      id: "step_context_diff_spill",
      runId: "run_context_diff_spill",
      nodeId: "large_context_diff",
      attempt: 1,
      status: "succeeded",
      contextDiff: {
        profile: {
          before: null,
          after: {
            id: "cust_context_diff",
            records: "x".repeat(400),
            apiKey: "raw-context-diff-key",
          },
        },
      },
      endedAt: later,
    });

    expect(step.contextDiff).toMatchObject({
      artifact: {
        id: "step_context_diff_spill_context_diff",
        kind: "step_context_diff",
        path: "runs/run_context_diff_spill/steps/step_context_diff_spill/context-diff.json",
        preview: expect.stringContaining('"cust_context_diff"'),
        byteLength: expect.any(Number),
      },
    });
    expect(JSON.stringify(step.contextDiff)).not.toContain(
      "raw-context-diff-key",
    );

    const [artifact] = spillStore.listArtifacts("run_context_diff_spill");
    expect(artifact).toMatchObject({
      id: "step_context_diff_spill_context_diff",
      runId: "run_context_diff_spill",
      stepRunId: "step_context_diff_spill",
      kind: "step_context_diff",
      path: "runs/run_context_diff_spill/steps/step_context_diff_spill/context-diff.json",
      preview: expect.stringContaining('"cust_context_diff"'),
      createdAt: later,
    });

    const artifactPath = path.join(
      dataDir,
      "workflow-artifacts",
      "runs/run_context_diff_spill/steps/step_context_diff_spill/context-diff.json",
    );
    expect(existsSync(artifactPath)).toBe(true);
    const artifactJson = readFileSync(artifactPath, "utf8");
    expect(artifactJson).toContain('"[redacted]"');
    expect(artifactJson).not.toContain("raw-context-diff-key");
  });

  it("prunes old workflow artifact files while preserving audit metadata", () => {
    const artifactRoot = path.join(dataDir, "workflow-artifacts");
    const spillStore = createWorkflowStore(db, {
      artifactRoot,
      inlineJsonByteLimit: 160,
      artifactPreviewBytes: 80,
    });
    spillStore.createRun({
      id: "run_artifact_retention",
      workflowId: "wf_artifact_retention",
      workflowVersion: 1,
      mode: "test",
      input: {},
      context: {},
      createdAt: now,
    });

    const oldStep = spillStore.recordStepAttempt({
      id: "step_artifact_retention_old",
      runId: "run_artifact_retention",
      nodeId: "old_output",
      attempt: 1,
      status: "succeeded",
      output: { records: "x".repeat(400), apiKey: "raw-old-artifact-key" },
      endedAt: "2026-07-30T00:00:10.000Z",
    });
    const freshStep = spillStore.recordStepAttempt({
      id: "step_artifact_retention_fresh",
      runId: "run_artifact_retention",
      nodeId: "fresh_output",
      attempt: 1,
      status: "succeeded",
      output: { records: "x".repeat(400), apiKey: "raw-fresh-artifact-key" },
      endedAt: "2026-07-30T00:03:00.000Z",
    });
    spillStore.recordArtifact({
      id: "missing_artifact",
      runId: "run_artifact_retention",
      kind: "step_output",
      path: "runs/run_artifact_retention/steps/missing/output.json",
      createdAt: "2026-07-30T00:00:20.000Z",
    });
    spillStore.recordArtifact({
      id: "unsafe_artifact",
      runId: "run_artifact_retention",
      kind: "step_output",
      path: "../unsafe-output.json",
      createdAt: "2026-07-30T00:00:30.000Z",
    });

    const oldRef = (
      oldStep.output as { artifact: { id: string; path: string } }
    ).artifact;
    const freshRef = (
      freshStep.output as { artifact: { id: string; path: string } }
    ).artifact;
    const oldPath = path.join(artifactRoot, oldRef.path);
    const freshPath = path.join(artifactRoot, freshRef.path);
    expect(existsSync(oldPath)).toBe(true);
    expect(existsSync(freshPath)).toBe(true);

    const result = (
      spillStore as unknown as {
        pruneArtifactFiles(args: { createdBefore: string }): {
          deletedFiles: number;
          missingFiles: number;
          skippedUnsafePaths: number;
          scannedArtifacts: number;
        };
      }
    ).pruneArtifactFiles({ createdBefore: "2026-07-30T00:01:00.000Z" });

    expect(result).toEqual({
      deletedFiles: 1,
      missingFiles: 1,
      skippedUnsafePaths: 1,
      scannedArtifacts: 3,
    });
    expect(existsSync(oldPath)).toBe(false);
    expect(existsSync(freshPath)).toBe(true);
    expect(spillStore.listArtifacts("run_artifact_retention")).toHaveLength(4);
    expect(
      spillStore.readArtifactContent("run_artifact_retention", oldRef.id),
    ).toBeNull();
    expect(
      spillStore.readArtifactContent("run_artifact_retention", freshRef.id)
        ?.content,
    ).toMatchObject({
      records: expect.any(String),
      apiKey: "[redacted]",
    });
  });

  it("spills large final run context to workflow artifacts", () => {
    const spillStore = createWorkflowStore(db, {
      artifactRoot: path.join(dataDir, "workflow-artifacts"),
      inlineJsonByteLimit: 160,
      artifactPreviewBytes: 80,
    });
    spillStore.createRun({
      id: "run_context_spill",
      workflowId: "wf_context_spill",
      workflowVersion: 1,
      mode: "test",
      input: {},
      context: {},
      createdAt: now,
    });

    const run = spillStore.updateRunState("run_context_spill", {
      status: "succeeded",
      context: {
        customer: {
          id: "cust_context_spill",
          records: "x".repeat(400),
          apiKey: "raw-run-context-key",
        },
      },
      endedAt: later,
    });

    expect(run.context).toMatchObject({
      artifact: {
        id: "run_context_spill_context",
        kind: "run_context",
        path: "runs/run_context_spill/context.json",
        preview: expect.stringContaining('"cust_context_spill"'),
        byteLength: expect.any(Number),
      },
    });
    expect(JSON.stringify(run.context)).not.toContain("raw-run-context-key");

    const [artifact] = spillStore.listArtifacts("run_context_spill");
    expect(artifact).toMatchObject({
      id: "run_context_spill_context",
      runId: "run_context_spill",
      stepRunId: null,
      kind: "run_context",
      path: "runs/run_context_spill/context.json",
      preview: expect.stringContaining('"cust_context_spill"'),
      createdAt: later,
    });

    const artifactPath = path.join(
      dataDir,
      "workflow-artifacts",
      "runs/run_context_spill/context.json",
    );
    expect(existsSync(artifactPath)).toBe(true);
    const artifactJson = readFileSync(artifactPath, "utf8");
    expect(artifactJson).toContain('"[redacted]"');
    expect(artifactJson).not.toContain("raw-run-context-key");
  });

  it("spills large run inputs to workflow artifacts", () => {
    const spillStore = createWorkflowStore(db, {
      artifactRoot: path.join(dataDir, "workflow-artifacts"),
      inlineJsonByteLimit: 160,
      artifactPreviewBytes: 80,
    });

    const run = spillStore.createRun({
      id: "run_input_spill",
      workflowId: "wf_input_spill",
      workflowVersion: 1,
      mode: "test",
      input: {
        customer: {
          id: "cust_input_spill",
          records: "x".repeat(400),
          apiKey: "raw-run-input-key",
        },
      },
      context: {},
      createdAt: now,
    });

    expect(run.input).toMatchObject({
      artifact: {
        id: "run_input_spill_input",
        kind: "run_input",
        path: "runs/run_input_spill/input.json",
        preview: expect.stringContaining('"cust_input_spill"'),
        byteLength: expect.any(Number),
      },
    });
    expect(JSON.stringify(run.input)).not.toContain("raw-run-input-key");

    const [artifact] = spillStore.listArtifacts("run_input_spill");
    expect(artifact).toMatchObject({
      id: "run_input_spill_input",
      runId: "run_input_spill",
      stepRunId: null,
      kind: "run_input",
      path: "runs/run_input_spill/input.json",
      preview: expect.stringContaining('"cust_input_spill"'),
      createdAt: now,
    });

    const artifactPath = path.join(
      dataDir,
      "workflow-artifacts",
      "runs/run_input_spill/input.json",
    );
    expect(existsSync(artifactPath)).toBe(true);
    const artifactJson = readFileSync(artifactPath, "utf8");
    expect(artifactJson).toContain('"[redacted]"');
    expect(artifactJson).not.toContain("raw-run-input-key");
  });

  it("pages run history in deterministic newest-first order", () => {
    store.createDraft({
      id: "wf_page",
      name: "Paged workflow",
      nodes: [{ id: "exit", type: "builtin.exit", status: "succeeded" }],
      now,
    });

    store.createRun({
      id: "run_page_1",
      workflowId: "wf_page",
      workflowVersion: 1,
      mode: "test",
      input: {},
      context: {},
      createdAt: "2026-07-30T00:00:00.000Z",
    });
    store.createRun({
      id: "run_page_2",
      workflowId: "wf_page",
      workflowVersion: 1,
      mode: "test",
      input: {},
      context: {},
      createdAt: "2026-07-30T00:01:00.000Z",
    });
    store.createRun({
      id: "run_page_3",
      workflowId: "wf_page",
      workflowVersion: 1,
      mode: "test",
      input: {},
      context: {},
      createdAt: "2026-07-30T00:02:00.000Z",
    });

    const firstPage = store.listRunsPage({ workflowId: "wf_page", limit: 2 });
    expect(firstPage).toMatchObject({
      limit: 2,
      offset: 0,
      hasMore: true,
      nextOffset: 2,
    });
    expect(firstPage.runs.map((run) => run.id)).toEqual([
      "run_page_3",
      "run_page_2",
    ]);

    const secondPage = store.listRunsPage({
      workflowId: "wf_page",
      limit: 2,
      offset: firstPage.nextOffset ?? 0,
    });
    expect(secondPage).toMatchObject({
      limit: 2,
      offset: 2,
      hasMore: false,
      nextOffset: null,
    });
    expect(secondPage.runs.map((run) => run.id)).toEqual(["run_page_1"]);
  });

  it("paginates triggerId filters by the top-level trigger snapshot id", () => {
    store.createRun({
      id: "run_false_positive_newest",
      workflowId: "wf_trigger_page",
      workflowVersion: 1,
      definitionSource: "published",
      mode: "test",
      trigger: {
        kind: "manual",
        triggerId: "manual_review",
        input: { triggerId: "manual" },
      },
      input: {},
      context: {},
      createdAt: "2026-07-30T00:03:00.000Z",
    });
    store.createRun({
      id: "run_false_positive_middle",
      workflowId: "wf_trigger_page",
      workflowVersion: 1,
      definitionSource: "published",
      mode: "test",
      trigger: {
        kind: "manual",
        triggerId: "manual_review",
        input: { nested: { triggerId: "manual" } },
      },
      input: {},
      context: {},
      createdAt: "2026-07-30T00:02:00.000Z",
    });
    store.createRun({
      id: "run_manual_match",
      workflowId: "wf_trigger_page",
      workflowVersion: 1,
      definitionSource: "published",
      mode: "test",
      trigger: { kind: "manual", triggerId: "manual" },
      input: {},
      context: {},
      createdAt: "2026-07-30T00:01:00.000Z",
    });

    const page = store.listRunsPage({
      workflowId: "wf_trigger_page",
      triggerId: "manual",
      limit: 1,
    });

    expect(page.runs.map((run) => run.id)).toEqual(["run_manual_match"]);
    expect(page).toMatchObject({
      hasMore: false,
      nextOffset: null,
    });
  });

  it("redacts secret-looking keys from run, step, and event trace payloads", () => {
    store.createDraft({
      id: "wf_secret",
      name: "Secret redaction",
      nodes: [{ id: "exit", type: "builtin.exit", status: "succeeded" }],
      now,
    });
    store.createRun({
      id: "run_secret",
      workflowId: "wf_secret",
      workflowVersion: 1,
      definitionSource: "draft",
      mode: "test",
      trigger: {
        kind: "manual",
        triggerId: "manual",
        requestedBy: "codex",
        input: { apiKey: "raw-trigger-key" },
      },
      input: { apiKey: "raw-key", nested: { token: "raw-token" } },
      context: { password: "raw-password" },
      createdAt: now,
    });
    store.recordStepAttempt({
      id: "step_secret",
      runId: "run_secret",
      nodeId: "exit",
      attempt: 1,
      status: "failed",
      input: { authorization: "Bearer raw" },
      error: { secret: "raw-secret" },
      contextDiff: { before: { token: "raw-token" } },
    });
    store.appendRunEvent({
      id: "event_secret",
      runId: "run_secret",
      level: "error",
      kind: "step_failed",
      payload: { password: "raw-password" },
      createdAt: later,
    });

    const run = store.listRuns({ workflowId: "wf_secret" })[0]!;
    expect(JSON.stringify(run)).not.toContain("raw-");
    expect(run.trigger).toMatchObject({
      input: { apiKey: "[redacted]" },
    });
    expect(JSON.stringify(store.listStepAttempts("run_secret"))).not.toContain(
      "raw-",
    );
    expect(JSON.stringify(store.listRunEvents("run_secret"))).not.toContain(
      "raw-",
    );

    db.prepare("UPDATE workflow_runs SET trigger_json = ? WHERE id = ?").run(
      JSON.stringify({
        kind: "manual",
        triggerId: "manual",
        input: { apiKey: "raw-legacy-trigger-key" },
      }),
      "run_secret",
    );

    expect(JSON.stringify(store.getRun("run_secret"))).not.toContain("raw-");
    expect(store.getRun("run_secret")?.trigger).toMatchObject({
      input: { apiKey: "[redacted]" },
    });
    expect(
      JSON.stringify(store.listRuns({ workflowId: "wf_secret" })[0]),
    ).not.toContain("raw-");

    db.prepare(
      "UPDATE workflow_runs SET input_json = ?, context_json = ? WHERE id = ?",
    ).run(
      JSON.stringify({ apiKey: "raw-legacy-run-key" }),
      JSON.stringify({ password: "raw-legacy-context-password" }),
      "run_secret",
    );
    db.prepare(
      `UPDATE workflow_step_attempts
       SET input_json = ?,
           output_json = ?,
           error_json = ?,
           logs_summary_json = ?,
           context_diff_json = ?
       WHERE id = ?`,
    ).run(
      JSON.stringify({ authorization: "raw-legacy-step-auth" }),
      JSON.stringify({ result: { apiKey: "raw-legacy-output-key" } }),
      JSON.stringify({ secret: "raw-legacy-error-secret" }),
      JSON.stringify({ lines: [{ token: "raw-legacy-log-token" }] }),
      JSON.stringify({ after: { password: "raw-legacy-diff-password" } }),
      "step_secret",
    );
    db.prepare(
      "UPDATE workflow_run_events SET payload_json = ? WHERE id = ?",
    ).run(
      JSON.stringify({ authorization: "raw-legacy-event-auth" }),
      "event_secret",
    );

    const legacyRun = store.getRun("run_secret");
    expect(JSON.stringify(legacyRun)).not.toContain("raw-");
    expect(legacyRun?.input).toMatchObject({ apiKey: "[redacted]" });
    expect(legacyRun?.context).toMatchObject({ password: "[redacted]" });
    expect(
      JSON.stringify(store.listRuns({ workflowId: "wf_secret" })[0]),
    ).not.toContain("raw-");
    expect(JSON.stringify(store.listStepAttempts("run_secret"))).not.toContain(
      "raw-",
    );
    expect(JSON.stringify(store.listRunEvents("run_secret"))).not.toContain(
      "raw-",
    );
  });

  it("persists a builtin runner result as durable run audit state", async () => {
    const definition = store.createDraft({
      id: "wf_runner_audit",
      name: "Runner audit",
      nodes: [
        {
          id: "set_customer",
          type: "builtin.set",
          assign: {
            customerId: "$.input.customerId",
          },
        },
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.context.customerId",
        },
      ],
      now,
    });

    const run = store.createRun({
      id: "run_runner_audit",
      workflowId: definition.id,
      workflowVersion: definition.version,
      definitionSource: "draft",
      mode: "test",
      trigger: { kind: "manual", triggerId: "manual", requestedBy: "codex" },
      input: { customerId: "cust_1" },
      status: "running",
      startedAt: now,
      createdAt: now,
    });

    const result = await new WorkflowRunner({
      now: () => later,
    }).run({
      runId: run.id,
      definition,
      input: run.input,
    });

    for (const step of result.stepAttempts) {
      store.recordStepAttempt({
        id: step.id,
        runId: step.runId,
        nodeId: step.nodeId,
        attempt: step.attempt,
        status: step.status,
        startedAt: step.startedAt,
        endedAt: step.endedAt,
        durationMs: step.durationMs,
        input: step.input,
        output: step.output,
        error: step.error,
        logsSummary: step.logsSummary,
        contextDiff: step.contextDiff,
      });
    }

    for (const event of result.events) {
      store.appendRunEvent({
        id: event.id,
        runId: event.runId,
        stepRunId: event.stepRunId,
        sequence: event.sequence,
        level: event.level,
        kind: event.kind,
        message: event.message,
        payload: event.payload,
        createdAt: event.createdAt,
      });
    }

    store.updateRunState(run.id, {
      status: result.status,
      context: result.context,
      endedAt: later,
    });

    const persisted = store.getRun(run.id);
    expect(persisted).toMatchObject({
      id: run.id,
      status: "succeeded",
      context: { customerId: "cust_1" },
      endedAt: later,
    });
    expect(store.listStepAttempts(run.id).map((step) => step.nodeId)).toEqual([
      "set_customer",
      "exit",
    ]);
    expect(store.listRunEvents(run.id).map((event) => event.kind)).toEqual([
      "run_started",
      "step_started",
      "step_completed",
      "step_started",
      "run_completed",
      "step_completed",
    ]);
  });
});
