import type { z } from "zod";
import {
  buildHostedToolName,
  type HostedIntegrationRuntimeConfigContract,
} from "@openacme/hosted-integrations";
import { getCurrentAgentId } from "./session-context.js";
import type { ToolEntry } from "./types.js";
import type { ToolRegistry } from "./registry.js";

const HOSTED_INTEGRATION_TOOLSET = "hosted-integrations";

export interface HostedIntegrationRegistryTool {
  name: string;
  description: string;
  parameters: z.ZodType;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface HostedIntegrationRegistrySnapshot {
  familyId: string;
  familyName: string;
  generationId: string;
  runtimeConfig?: HostedIntegrationRuntimeConfigContract;
  tools: HostedIntegrationRegistryTool[];
}

export interface HostedIntegrationToolInvokeRequest {
  actorId: string;
  familyId: string;
  canonicalToolName: string;
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
    const previous = this.currentRegisteredNamesForFamily(snapshot.familyId);
    for (const tool of snapshot.tools) {
      const canonicalToolName = buildHostedToolName({
        familyId: snapshot.familyId,
        toolName: tool.name,
      });
      const existing = this.registry.get(canonicalToolName);
      const sameHostedFamily =
        existing?.source?.kind === "hosted_integration" &&
        existing.source.familyId === snapshot.familyId;
      if (existing && !(previous.has(canonicalToolName) || sameHostedFamily)) {
        return {
          ok: false,
          reason: "tool_name_collision",
          toolName: canonicalToolName,
          existingToolset: existing.toolset,
        };
      }
    }

    const next = new Set(
      snapshot.tools.map((tool) =>
        buildHostedToolName({
          familyId: snapshot.familyId,
          toolName: tool.name,
        }),
      ),
    );
    const removedToolNames = [...previous].filter((name) => !next.has(name));
    for (const name of removedToolNames) this.registry.deregister(name);

    const registeredToolNames: string[] = [];
    for (const tool of snapshot.tools) {
      const entry = this.createEntry(snapshot, tool);
      this.registry.register(entry);
      registeredToolNames.push(entry.name);
    }
    this.registeredByFamily.set(snapshot.familyId, next);
    return { ok: true, registeredToolNames, removedToolNames };
  }

  private currentRegisteredNamesForFamily(familyId: string): Set<string> {
    const names = new Set(this.registeredByFamily.get(familyId) ?? []);
    for (const name of this.registry.getAllToolNames()) {
      const entry = this.registry.get(name);
      if (
        entry?.source?.kind === "hosted_integration" &&
        entry.source.familyId === familyId
      ) {
        names.add(name);
      }
    }
    return names;
  }

  removeFamily(familyId: string): string[] {
    const previous = this.currentRegisteredNamesForFamily(familyId);
    if (previous.size === 0) return [];
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
    const canonicalToolName = buildHostedToolName({
      familyId: snapshot.familyId,
      toolName: tool.name,
    });
    return {
      name: canonicalToolName,
      toolset: HOSTED_INTEGRATION_TOOLSET,
      description: tool.description,
      parameters: tool.parameters,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
      parallelSafe: false,
      source: {
        kind: "hosted_integration",
        familyId: snapshot.familyId,
        familyName: snapshot.familyName,
        toolName: tool.name,
        generationId,
        runtimeConfig: snapshot.runtimeConfig,
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
          canonicalToolName,
          toolName: tool.name,
          generationId,
          args,
        });
      },
    };
  }
}
