import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { isNodeError, safePathSegment } from "./file-access.js";
import {
  HostedIntegrationGenerationProvenanceSchema,
  HostedIntegrationHumanApprovalRecordSchema,
  HostedIntegrationPromotionApprovalTargetSchema,
  type HostedIntegrationApprovalActor,
  type HostedIntegrationDependencyResolution,
  type HostedIntegrationGenerationProvenance,
  type HostedIntegrationHumanApprovalRecord,
  type HostedIntegrationPromotionApprovalTarget,
} from "./schemas.js";
import type { HostedIntegrationValidationResult } from "./validation.js";

export interface FileHostedIntegrationApprovalStoreOptions {
  dataDir: string;
  now?: () => Date;
}

export interface CreateHostedIntegrationApprovalRequest {
  actor: HostedIntegrationApprovalActor;
  target: HostedIntegrationPromotionApprovalTarget;
}

export type CreateHostedIntegrationApprovalResult =
  | { ok: true; approval: HostedIntegrationHumanApprovalRecord }
  | { ok: false; reason: "human_actor_required" };

export interface HostedIntegrationApprovalStore {
  createApproval(
    request: CreateHostedIntegrationApprovalRequest,
  ): Promise<CreateHostedIntegrationApprovalResult>;
  getApproval(
    approvalId: string,
  ): Promise<HostedIntegrationHumanApprovalRecord | null>;
}

export interface EvaluateHostedIntegrationPromotionApprovalInput {
  actor: HostedIntegrationApprovalActor;
  target: HostedIntegrationPromotionApprovalTarget;
  approval?: HostedIntegrationHumanApprovalRecord | null;
}

export type EvaluateHostedIntegrationPromotionApprovalResult =
  | {
      ok: true;
      approvalRequired: boolean;
      approval?: HostedIntegrationHumanApprovalRecord;
    }
  | {
      ok: false;
      reason: "approval_required" | "stale_approval";
      message: string;
    };

export interface BuildHostedIntegrationGenerationProvenanceInput {
  draftId: string;
  draftRevisionId: string;
  promotedBy: string;
  validation: HostedIntegrationValidationResult;
  approval?: HostedIntegrationHumanApprovalRecord;
  dependencyResolution?: HostedIntegrationDependencyResolution;
}

export function createFileHostedIntegrationApprovalStore(
  options: FileHostedIntegrationApprovalStoreOptions,
): HostedIntegrationApprovalStore {
  return new FileHostedIntegrationApprovalStore({
    dataDir: options.dataDir,
    now: options.now ?? (() => new Date()),
  });
}

export function evaluateHostedIntegrationPromotionApproval(
  input: EvaluateHostedIntegrationPromotionApprovalInput,
): EvaluateHostedIntegrationPromotionApprovalResult {
  const target = HostedIntegrationPromotionApprovalTargetSchema.parse(
    input.target,
  );
  if (!requiresHumanApproval(target)) {
    return { ok: true, approvalRequired: false };
  }

  if (!input.approval) {
    return {
      ok: false,
      reason: "approval_required",
      message: "destructive promotion requires human approval",
    };
  }

  if (!approvalMatchesTarget(input.approval, target)) {
    return {
      ok: false,
      reason: "stale_approval",
      message: "approval does not match this draft revision",
    };
  }

  return {
    ok: true,
    approvalRequired: true,
    approval: input.approval,
  };
}

export function buildHostedIntegrationGenerationProvenance(
  input: BuildHostedIntegrationGenerationProvenanceInput,
): HostedIntegrationGenerationProvenance {
  return HostedIntegrationGenerationProvenanceSchema.parse({
    draftId: input.draftId,
    draftRevisionId: input.draftRevisionId,
    promotedBy: input.promotedBy,
    validation: input.validation,
    approval: input.approval,
    dependencyResolution: input.dependencyResolution,
  });
}

class FileHostedIntegrationApprovalStore
  implements HostedIntegrationApprovalStore
{
  private readonly approvalsDir: string;
  private readonly now: () => Date;

  constructor(parts: { dataDir: string; now: () => Date }) {
    this.approvalsDir = path.join(
      parts.dataDir,
      "hosted-integrations",
      "approvals",
    );
    this.now = parts.now;
  }

  async createApproval(
    request: CreateHostedIntegrationApprovalRequest,
  ): Promise<CreateHostedIntegrationApprovalResult> {
    if (request.actor.kind !== "human") {
      return { ok: false, reason: "human_actor_required" };
    }
    const target = HostedIntegrationPromotionApprovalTargetSchema.parse(
      request.target,
    );
    const approval = HostedIntegrationHumanApprovalRecordSchema.parse({
      id: `approval_${randomUUID()}`,
      familyId: target.familyId,
      draftId: target.draftId,
      draftRevisionId: target.draftRevisionId,
      operation: target.operation,
      operationClass: target.operationClass,
      approvedBy: request.actor.id,
      approvedByEmail: request.actor.email,
      approvedAt: this.now().toISOString(),
      target: {
        toolNames: target.toolNames,
        destructiveToolNames: target.destructiveToolNames,
      },
    });
    await this.writeApproval(approval);
    return { ok: true, approval };
  }

  async getApproval(
    approvalId: string,
  ): Promise<HostedIntegrationHumanApprovalRecord | null> {
    try {
      return HostedIntegrationHumanApprovalRecordSchema.parse(
        JSON.parse(await readFile(this.approvalPath(approvalId), "utf-8")),
      );
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") return null;
      throw error;
    }
  }

  private async writeApproval(
    approval: HostedIntegrationHumanApprovalRecord,
  ): Promise<void> {
    await mkdir(this.approvalsDir, { recursive: true });
    const filePath = this.approvalPath(approval.id);
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(approval, null, 2)}\n`, "utf-8");
    await rename(tmpPath, filePath);
  }

  private approvalPath(approvalId: string): string {
    return path.join(
      this.approvalsDir,
      `${safePathSegment("approvalId", approvalId)}.json`,
    );
  }
}

function requiresHumanApproval(
  target: HostedIntegrationPromotionApprovalTarget,
): boolean {
  return (
    target.operationClass === "destructive" ||
    target.destructiveToolNames.length > 0
  );
}

function approvalMatchesTarget(
  approval: HostedIntegrationHumanApprovalRecord,
  target: HostedIntegrationPromotionApprovalTarget,
): boolean {
  return (
    approval.familyId === target.familyId &&
    approval.draftId === target.draftId &&
    approval.draftRevisionId === target.draftRevisionId &&
    approval.operation === target.operation &&
    approval.operationClass === target.operationClass
  );
}
