import { z } from "zod";
import {
  HostedIntegrationHelpDetailSchema,
  HostedIntegrationParameterHelpRequestSchema,
  HostedIntegrationToolHelpRequestSchema,
  parseHostedIntegrationManagedToolName,
} from "@openacme/hosted-integrations";
import { registry } from "../registry.js";
import { getCurrentAgentId } from "../session-context.js";

export const MANAGED_TOOL_HELP_TOOL_NAME = "managed_tool_help";

export interface ManagedToolHelpRequest {
  actorId: string;
  params: Record<string, unknown>;
}

export interface ManagedToolHelpBindings {
  invoke(request: ManagedToolHelpRequest): Promise<unknown>;
}

let bindings: ManagedToolHelpBindings | null = null;

export function bindManagedToolHelp(b: ManagedToolHelpBindings | null): void {
  bindings = b;
}

const ManagedToolName = z
  .string()
  .min(1)
  .describe(
    "Managed hosted integration tool name, e.g. managed_qualys__qualys_cloud_agent_hostasset_count.",
  )
  .refine(
    (value) => parseHostedIntegrationManagedToolName(value) !== null,
    "must be a managed hosted integration tool name like managed_<family>__<tool>",
  );

const parameters = z
  .object({
    tool_name: ManagedToolName,
    tool_detail: HostedIntegrationHelpDetailSchema.default("summary").describe(
      "Use full before constructing a call, especially for filter/query/body syntax.",
    ),
    include_examples: z
      .boolean()
      .default(false)
      .describe("Whether to include tool-level examples."),
    parameters: z
      .array(HostedIntegrationParameterHelpRequestSchema)
      .nullable()
      .optional()
      .describe(
        "Optional parameter detail requests. Use [{name:'filter_body', detail:'full', include_examples:true}] for parameter-specific help. Omit or pass null to auto-return documented parameters; with tool_detail=full they return full details.",
      ),
  })
  .strict();

registry.register({
  name: MANAGED_TOOL_HELP_TOOL_NAME,
  toolset: "hosted-integration-support",
  description:
    "Get usage help for an allowed managed hosted integration tool. Use this before calling tools with filters, query DSLs, request bodies, pagination, or unfamiliar parameters; request parameter-specific full details through the parameters field.",
  parameters,
  parallelSafe: true,
  handler: async (args) => invokeManagedToolHelp(args),
});

async function invokeManagedToolHelp(
  args: Record<string, unknown>,
): Promise<string> {
  if (!bindings) {
    return JSON.stringify({
      ok: false,
      error: {
        code: "platform_unavailable",
        message:
          "managed tool help is not initialized — ServerRuntime must bind it.",
      },
    });
  }
  const actorId = getCurrentAgentId();
  if (!actorId) {
    return JSON.stringify({
      ok: false,
      error: {
        code: "policy_denied",
        message: "managed tool help requires an active agent context.",
      },
    });
  }
  const parsed = HostedIntegrationToolHelpRequestSchema.parse(
    parameters.parse(args),
  );

  try {
    const result = await bindings.invoke({
      actorId,
      params: parsed,
    });
    return JSON.stringify(result);
  } catch (error) {
    return JSON.stringify({
      ok: false,
      error: {
        code: "runtime_error",
        message: error instanceof Error ? error.message : String(error),
      },
    });
  }
}
