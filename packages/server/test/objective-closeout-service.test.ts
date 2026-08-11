import { beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectiveCloseoutService } from "../src/objective-closeout-service.js";
import type { ObjectiveCloseoutReady } from "../src/objective-closeout-watcher.js";

const telemetry = vi.hoisted(() => {
  type SpanRecord = {
    name: string;
    attributes: Record<string, unknown>;
    updates: Record<string, unknown>[];
    exceptions: unknown[];
  };
  const spans: SpanRecord[] = [];
  const withOpenAcmeSpanMock = vi.fn(
    async (
      name: string,
      attributes: Record<string, unknown>,
      fn: (span: {
        setAttributes: (attrs: Record<string, unknown>) => void;
        recordException: (error: unknown) => void;
      }) => unknown,
    ) => {
      const record: SpanRecord = {
        name,
        attributes,
        updates: [],
        exceptions: [],
      };
      spans.push(record);
      return await fn({
        setAttributes: (attrs) => record.updates.push(attrs),
        recordException: (error) => record.exceptions.push(error),
      });
    },
  );
  return { spans, withOpenAcmeSpanMock };
});

vi.mock("@openacme/llm-provider", () => ({
  withOpenAcmeSpan: telemetry.withOpenAcmeSpanMock,
}));

function ready(over: Partial<ObjectiveCloseoutReady> = {}): ObjectiveCloseoutReady {
  return {
    objective: {
      id: "objective-1",
      title: "Ship objective",
      description: "",
      status: "ready_for_closeout",
      ownerAgentId: "owner",
      ownerSessionId: "owner-session",
      createdBy: "owner",
      createdInSessionId: "owner-session",
      closeoutPrompt: "Review before closing.",
      createdAt: "2026-08-11T00:00:00.000Z",
      updatedAt: "2026-08-11T00:00:00.000Z",
      completedAt: null,
      completionSummary: null,
      lastCloseoutFingerprint: "fingerprint-1",
      lastCloseoutBriefJson: null,
      lastCloseoutBriefAt: null,
    },
    fingerprint: "fingerprint-1",
    needsOwnerWake: true,
    reason: "linked_tasks_terminal",
    packet: {
      objective: {
        id: "objective-1",
        title: "Ship objective",
        description: "",
        closeout_prompt: "Review before closing.",
        status: "waiting_on_tasks",
      },
      rollup: {
        linked_task_count: 1,
        terminal_task_count: 1,
        nonterminal_task_count: 0,
      },
      linked_tasks: [
        {
          id: "1",
          title: "Done task",
          status: "done",
          assignee: "owner",
          session_id: "owner-session",
          updated_at: "2026-08-11T00:00:00.000Z",
          closed_at: "2026-08-11T00:00:00.000Z",
          latest_result_comment_excerpt: "Done.",
          latest_system_comment_excerpt: null,
          latest_comment_excerpts: [],
        },
      ],
    },
    ...over,
  };
}

function serviceDeps(over: Record<string, unknown> = {}) {
  const events: Array<{ eventType: string; details?: unknown }> = [];
  const delivered: unknown[] = [];
  const kicks: string[] = [];
  return {
    events,
    delivered,
    kicks,
    watcher: {
      check: vi.fn(async () => ({ scanned: 0, ready: [] })),
    },
    summarizer: {
      summarize: vi.fn(async () => ({
        status: "ok",
        brief: { suggested_owner_action: "close_completed" },
        packedInput: null,
        failureReasons: [],
        compressionUsed: false,
        inputTruncated: false,
      })),
    },
    objectiveStore: {
      appendObjectiveEvent: vi.fn((input: { eventType: string; details?: unknown }) => {
        events.push(input);
        return input;
      }),
      recordCloseoutBrief: vi.fn(),
    },
    inboxStore: {
      deliver: vi.fn((input: unknown) => {
        delivered.push(input);
        return delivered.length;
      }),
    },
    sessionStore: {
      get: vi.fn((id: string) =>
        id === "owner-session" ? { id, agentId: "owner" } : null,
      ),
    },
    dispatcher: {
      kick: vi.fn((reason: string) => kicks.push(reason)),
    },
    ...over,
  };
}

describe("ObjectiveCloseoutService", () => {
  beforeEach(() => {
    telemetry.spans.length = 0;
    telemetry.withOpenAcmeSpanMock.mockClear();
  });

  it("runs checks from its own interval", async () => {
    vi.useFakeTimers();
    try {
      const deps = serviceDeps();
      const service = new ObjectiveCloseoutService({
        ...deps,
        intervalMs: 100,
      });

      service.start();
      await vi.advanceTimersByTimeAsync(100);
      await service.drain();

      expect(deps.watcher.check).toHaveBeenCalledTimes(1);
      service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes interval/kick checks and coalesces another pass", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const deps = serviceDeps({
      watcher: {
        check: vi.fn(async () => {
          concurrent += 1;
          maxConcurrent = Math.max(maxConcurrent, concurrent);
          if (maxConcurrent === 1) await first;
          concurrent -= 1;
          return { scanned: 0, ready: [] };
        }),
      },
    });
    const service = new ObjectiveCloseoutService(deps);

    service.start();
    service.kick("first");
    service.kick("second");
    await vi.waitFor(() => expect(deps.watcher.check).toHaveBeenCalledTimes(1));
    releaseFirst();
    await service.drain();

    expect(deps.watcher.check).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1);
  });

  it("passes per-check objective limit and wall-clock budget to watcher", async () => {
    const deps = serviceDeps();
    const service = new ObjectiveCloseoutService({
      ...deps,
      objectiveLimit: 3,
      checkBudgetMs: 25,
    });

    service.start();
    service.kick("test");
    await service.drain();

    expect(deps.watcher.check).toHaveBeenCalledWith({
      limit: 3,
      budgetMs: 25,
    });
  });

  it("delivers owner notice and kicks dispatcher only after inbox delivery", async () => {
    const deps = serviceDeps({
      watcher: {
        check: vi.fn(async () => ({ scanned: 1, ready: [ready()] })),
      },
    });
    const service = new ObjectiveCloseoutService(deps);

    service.start();
    service.kick("test");
    await service.drain();

    expect(deps.inboxStore.deliver).toHaveBeenCalledTimes(1);
    expect(deps.dispatcher.kick).toHaveBeenCalledWith("objective_closeout");
    expect(deps.delivered[0]).toMatchObject({
      agentId: "owner",
      kind: "system_notice",
      source: "system",
      sourceId: "system:objective-closeout",
      relatedSession: "owner-session",
      payload: {
        eventKind: "objective_ready_for_closeout",
        objectiveId: "objective-1",
        linkedTaskIds: ["1"],
        closeoutBrief: { suggested_owner_action: "close_completed" },
      },
    });
    expect(deps.events.map((event) => event.eventType)).toContain(
      "owner_wake_requested",
    );
  });

  it("records check and delivery spans through the existing OpenAcme span helper", async () => {
    const deps = serviceDeps({
      watcher: {
        check: vi.fn(async () => ({ scanned: 1, ready: [ready()] })),
      },
    });
    const service = new ObjectiveCloseoutService({
      ...deps,
      objectiveLimit: 3,
      checkBudgetMs: 25,
    });

    service.start();
    service.kick("test");
    await service.drain();

    const check = telemetry.spans.find(
      (span) => span.name === "objective.closeout.check",
    );
    expect(check?.attributes).toMatchObject({
      "objective.closeout.reason": "test",
      "objective.closeout.limit": 3,
      "objective.closeout.budget_ms": 25,
    });
    expect(check?.updates).toContainEqual(
      expect.objectContaining({
        "objective.closeout.result": "ok",
        "objectives.scanned": 1,
        "objectives.ready": 1,
      }),
    );

    const delivery = telemetry.spans.find(
      (span) => span.name === "objective.closeout.deliver_notice",
    );
    expect(delivery?.attributes).toMatchObject({
      "objective.id": "objective-1",
      "objective.status": "ready_for_closeout",
      "linked_task_count": 1,
      "terminal_task_count": 1,
      "nonterminal_task_count": 0,
    });
    expect(delivery?.updates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          "summary.used": true,
          "summary.input_truncated": false,
          "summary.compression_used": false,
        }),
        expect.objectContaining({
          "objective.closeout.result": "ok",
          "notice.delivered": true,
          "dispatcher.kicked": true,
        }),
      ]),
    );
    expect(telemetry.withOpenAcmeSpanMock).toHaveBeenCalledWith(
      "objective.closeout.check",
      expect.any(Object),
      expect.any(Function),
    );
  });

  it("falls back to agent-wide delivery when owner session is unavailable", async () => {
    const deps = serviceDeps({
      watcher: {
        check: vi.fn(async () => ({ scanned: 1, ready: [ready()] })),
      },
      sessionStore: {
        get: vi.fn(() => null),
      },
    });
    const service = new ObjectiveCloseoutService(deps);

    service.start();
    service.kick("test");
    await service.drain();

    expect(deps.delivered[0]).toMatchObject({
      relatedSession: null,
    });
    expect(deps.events.map((event) => event.eventType)).toContain(
      "owner_session_unavailable",
    );
    expect(deps.events.map((event) => event.eventType)).toContain(
      "owner_wake_requested",
    );
  });

  it("retries delivery on the next check after inbox failure", async () => {
    const deps = serviceDeps({
      watcher: {
        check: vi.fn(async () => ({ scanned: 1, ready: [ready()] })),
      },
    });
    deps.inboxStore.deliver.mockImplementationOnce(() => {
      throw new Error("inbox down");
    });
    const service = new ObjectiveCloseoutService(deps);

    service.start();
    service.kick("first");
    await service.drain();
    expect(deps.dispatcher.kick).not.toHaveBeenCalled();
    expect(deps.events.map((event) => event.eventType)).not.toContain(
      "owner_wake_requested",
    );

    service.kick("retry");
    await service.drain();

    expect(deps.inboxStore.deliver).toHaveBeenCalledTimes(2);
    expect(deps.dispatcher.kick).toHaveBeenCalledWith("objective_closeout");
    expect(deps.events.map((event) => event.eventType)).toContain(
      "owner_wake_requested",
    );
  });

  it("still kicks dispatcher after inbox delivery when ledger append fails", async () => {
    const deps = serviceDeps({
      watcher: {
        check: vi.fn(async () => ({ scanned: 1, ready: [ready()] })),
      },
    });
    deps.objectiveStore.appendObjectiveEvent.mockImplementation(() => {
      throw new Error("ledger down");
    });
    const service = new ObjectiveCloseoutService(deps);

    service.start();
    service.kick("test");
    await service.drain();

    expect(deps.inboxStore.deliver).toHaveBeenCalledTimes(1);
    expect(deps.dispatcher.kick).toHaveBeenCalledWith("objective_closeout");
  });

  it("delivers deterministic wake when summary generation fails", async () => {
    const deps = serviceDeps({
      watcher: {
        check: vi.fn(async () => ({ scanned: 1, ready: [ready()] })),
      },
      summarizer: {
        summarize: vi.fn(async () => ({
          status: "failed",
          brief: null,
          packedInput: null,
          failureReasons: ["model_failed"],
          compressionUsed: false,
          inputTruncated: false,
        })),
      },
    });
    const service = new ObjectiveCloseoutService(deps);

    service.start();
    service.kick("test");
    await service.drain();

    expect(deps.inboxStore.deliver).toHaveBeenCalledTimes(1);
    expect(deps.delivered[0]).toMatchObject({
      payload: { closeoutBrief: null },
    });
    expect(deps.events.map((event) => event.eventType)).toContain(
      "closeout_brief_failed",
    );
    expect(deps.events.map((event) => event.eventType)).toContain(
      "owner_wake_requested",
    );
  });

  it("stops and drains without starting new closeout work", async () => {
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const deps = serviceDeps({
      watcher: {
        check: vi.fn(async () => {
          await inFlight;
          return { scanned: 0, ready: [] };
        }),
      },
    });
    const service = new ObjectiveCloseoutService(deps);

    service.start();
    service.kick("first");
    await vi.waitFor(() => expect(deps.watcher.check).toHaveBeenCalledTimes(1));
    service.stop();
    service.kick("after-stop");
    release();
    await service.drain();

    expect(deps.watcher.check).toHaveBeenCalledTimes(1);
  });
});
