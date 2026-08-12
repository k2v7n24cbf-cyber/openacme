import type { z } from "zod";
import { getCurrentAgentId } from "./session-context.js";
import type { ToolEntry } from "./types.js";
import type { ToolRegistry } from "./registry.js";

const HOSTED_INTEGRATION_TOOLSET = "hosted-integrations";

export interface HostedIntegrationRegistryTool {
  name: string;
  description: string;
  parameters: z.ZodType;
}

export interface HostedIntegrationRegistrySnapshot {
  familyId: string;
  familyName: string;
  generationId: string;
  tools: HostedIntegrationRegistryTool[];
}

export interface HostedIntegrationToolInvokeRequest {
  actorId: string;
  familyId: string;
  toolName: string;
  generationId: string;
  args: Record<string, unknown>;
}

export type HostedIntegrationToolInvoke = (
  request: HostedIntegrationToolInvokeRequest,
) => Promise<string>;

export type HostedIntegrationRegistrySyncResult =
  | {
      ok: true;
      registeredToolNames: string[];
      removedToolNames: string[];
    }
  | {
      ok: false;
      reason: "tool_name_collision";
      toolName: string;
      existingToolset: string;
    };

export class HostedIntegrationToolRegistryAdapter {
  private readonly registry: ToolRegistry;
  private readonly invoke: HostedIntegrationToolInvoke;
  private readonly registeredByFamily = new Map<string, Set<string>>();

  constructor(options: {
    registry: ToolRegistry;
    invoke: HostedIntegrationToolInvoke;
  }) {
    this.registry = options.registry;
    this.invoke = options.invoke;
  }

  syncFamily(
    snapshot: HostedIntegrationRegistrySnapshot,
  ): HostedIntegrationRegistrySyncResult {
    const previous =
      this.registeredByFamily.get(snapshot.familyId) ?? new Set();
    for (const tool of snapshot.tools) {
      const existing = this.registry.get(tool.name);
      const sameHostedFamily =
        existing?.source?.kind === "hosted_integration" &&
        existing.source.familyId === snapshot.familyId;
      if (existing && !(previous.has(tool.name) || sameHostedFamily)) {
        return {
          ok: false,
          reason: "tool_name_collision",
          toolName: tool.name,
          existingToolset: existing.toolset,
        };
      }
    }

    const next = new Set(snapshot.tools.map((tool) => tool.name));
    const removedToolNames = [...previous].filter((name) => !next.has(name));
    for (const name of removedToolNames) this.registry.deregister(name);

    const registeredToolNames: string[] = [];
    for (const tool of snapshot.tools) {
      this.registry.register(this.createEntry(snapshot, tool));
      registeredToolNames.push(tool.name);
    }
    this.registeredByFamily.set(snapshot.familyId, next);
    return { ok: true, registeredToolNames, removedToolNames };
  }

  removeFamily(familyId: string): string[] {
    const previous = this.registeredByFamily.get(familyId);
    if (!previous) return [];
    const removed = [...previous];
    for (const name of removed) this.registry.deregister(name);
    this.registeredByFamily.delete(familyId);
    return removed;
  }

  clear(): string[] {
    const removed: string[] = [];
    for (const familyId of [...this.registeredByFamily.keys()]) {
      removed.push(...this.removeFamily(familyId));
    }
    return removed;
  }

  private createEntry(
    snapshot: HostedIntegrationRegistrySnapshot,
    tool: HostedIntegrationRegistryTool,
  ): ToolEntry {
    const generationId = snapshot.generationId;
    return {
      name: tool.name,
      toolset: HOSTED_INTEGRATION_TOOLSET,
      description: tool.description,
      parameters: tool.parameters,
      parallelSafe: false,
      source: {
        kind: "hosted_integration",
        familyId: snapshot.familyId,
        familyName: snapshot.familyName,
        generationId,
      },
      handler: async (args) => {
        const actorId = getCurrentAgentId();
        if (!actorId) {
          return JSON.stringify({
            error:
              "hosted integration tools require an active agent tool-call context",
          });
        }
        return this.invoke({
          actorId,
          familyId: snapshot.familyId,
          toolName: tool.name,
          generationId,
          args,
        });
      },
    };
  }
}
