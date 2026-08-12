import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHostedIntegrationGenerationProvenance,
  createFileHostedIntegrationApprovalStore,
  evaluateHostedIntegrationPromotionApproval,
  type HostedIntegrationApprovalActor,
  type HostedIntegrationPromotionApprovalTarget,
} from "../src/index.js";

let dataDir: string;
let nowMs = Date.parse("2026-08-12T10:00:00.000Z");

const toolDeveloperAgent: HostedIntegrationApprovalActor = {
  id: "agent:tool-developer",
  kind: "agent",
};

const humanOperator: HostedIntegrationApprovalActor = {
  id: "member_alen",
  kind: "human",
  email: "alen@example.com",
};

const destructivePromotionTarget: HostedIntegrationPromotionApprovalTarget = {
  familyId: "qualys",
  draftId: "draft_123",
  draftRevisionId: "draft_rev_1",
  operation: "promote",
  operationClass: "destructive",
  toolNames: ["qualys_delete_asset"],
  destructiveToolNames: ["qualys_delete_asset"],
};

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "openacme-hosted-approvals-"));
  nowMs = Date.parse("2026-08-12T10:00:00.000Z");
});

afterEach(async () => {
  await rm(dataDir, { recursive: true, force: true });
});

function store() {
  return createFileHostedIntegrationApprovalStore({
    dataDir,
    now: () => new Date(nowMs),
  });
}

describe("hosted integration human approval gate", () => {
  it("does not let the Tool Developer Agent promote destructive changes without human approval", async () => {
    expect(
      evaluateHostedIntegrationPromotionApproval({
        actor: toolDeveloperAgent,
        target: destructivePromotionTarget,
      }),
    ).toEqual({
      ok: false,
      reason: "approval_required",
      message: "destructive promotion requires human approval",
    });

    await expect(
      store().createApproval({
        actor: toolDeveloperAgent,
        target: destructivePromotionTarget,
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "human_actor_required",
    });
  });

  it("records human approval metadata for destructive promotion", async () => {
    const result = await store().createApproval({
      actor: humanOperator,
      target: destructivePromotionTarget,
    });

    expect(result).toMatchObject({
      ok: true,
      approval: {
        familyId: "qualys",
        draftId: "draft_123",
        draftRevisionId: "draft_rev_1",
        operation: "promote",
        operationClass: "destructive",
        approvedBy: "member_alen",
        approvedByEmail: "alen@example.com",
        approvedAt: "2026-08-12T10:00:00.000Z",
        target: {
          toolNames: ["qualys_delete_asset"],
          destructiveToolNames: ["qualys_delete_asset"],
        },
      },
    });
  });

  it("includes approval metadata in generation provenance", async () => {
    const created = await store().createApproval({
      actor: humanOperator,
      target: destructivePromotionTarget,
    });
    if (!created.ok) throw new Error("approval was not created");

    const decision = evaluateHostedIntegrationPromotionApproval({
      actor: toolDeveloperAgent,
      target: destructivePromotionTarget,
      approval: created.approval,
    });
    expect(decision).toMatchObject({ ok: true });

    expect(
      buildHostedIntegrationGenerationProvenance({
        draftId: "draft_123",
        draftRevisionId: "draft_rev_1",
        promotedBy: "agent:tool-developer",
        validation: { ok: true, diagnostics: [] },
        approval: decision.ok ? decision.approval : undefined,
      }),
    ).toMatchObject({
      draftId: "draft_123",
      draftRevisionId: "draft_rev_1",
      promotedBy: "agent:tool-developer",
      approval: {
        approvedBy: "member_alen",
        approvedAt: "2026-08-12T10:00:00.000Z",
      },
    });
  });

  it("rejects stale approval for a different draft revision", async () => {
    const created = await store().createApproval({
      actor: humanOperator,
      target: destructivePromotionTarget,
    });
    if (!created.ok) throw new Error("approval was not created");

    expect(
      evaluateHostedIntegrationPromotionApproval({
        actor: toolDeveloperAgent,
        target: {
          ...destructivePromotionTarget,
          draftRevisionId: "draft_rev_2",
        },
        approval: created.approval,
      }),
    ).toEqual({
      ok: false,
      reason: "stale_approval",
      message: "approval does not match this draft revision",
    });
  });
});
