import { z } from "zod";
import {
  HostedIntegrationHelpDetailSchema,
  HostedIntegrationParameterHelpRequestSchema,
  HostedIntegrationToolHelpRequestSchema,
  parseHostedToolName,
} from "@openacme/hosted-integrations";
import { registry } from "../registry.js";
import { getCurrentAgentId } from "../session-context.js";
import { sanitizeHostedToolControlPlaneResult } from "./hosted-integration-redaction.js";

export const HOSTED_TOOL_HELP_TOOL_NAME = "hosted_tool_help";

export interface HostedToolHelpRequest {
  actorId: string;
  params: Record<string, unknown>;
}

export interface HostedToolHelpBindings {
  invoke(request: HostedToolHelpRequest): Promise<unknown>;
}

let bindings: HostedToolHelpBindings | null = null;

export function bindHostedToolHelp(b: HostedToolHelpBindings | null): void {
  bindings = b;
}

const HostedToolName = z
  .string()
  .min(1)
  .describe(
    "Hosted tool name, e.g. hosted_qualys__qualys_cloud_agent_hostasset_count.",
  )
  .refine(
    (value) => parseHostedToolName(value) !== null,
    "must be a hosted tool name like hosted_<family>__<tool>",
  );

const parameters = z
  .object({
    tool_name: HostedToolName,
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
        "Optional parameter detail requests. Use [{name:'filter_body', detail:'full', include_examples:true}] for parameter-specific help, [{name:'filter_body.filters.field', query:'software'}] to search shared vocabularies, or [{name:'filter_body.filters.field', value:'asset.name'}] to check exact values. If query and value are both supplied, query is used and value is returned as ignored guidance. If help returns ambiguous_vocabulary, repeat the request with one candidate_parameter_paths value as name. Omit or pass null to auto-return documented parameters; with tool_detail=full they return full details.",
      ),
  })
  .strict();

registry.register({
  name: HOSTED_TOOL_HELP_TOOL_NAME,
  toolset: "hosted-integration-support",
  description:
    "Get usage help for an allowed hosted tool. Use this before calling tools with filters, query DSLs, request bodies, pagination, or unfamiliar parameters; request parameter-specific full details and shared vocabulary search/exact checks through the parameters field. If a vocabulary lookup is ambiguous, retry help with a precise candidate parameter path before calling the hosted tool.",
  parameters,
  parallelSafe: true,
  handler: async (args) => invokeHostedToolHelp(args),
});

async function invokeHostedToolHelp(
  args: Record<string, unknown>,
): Promise<string> {
  if (!bindings) {
    return JSON.stringify({
      ok: false,
      error: {
        code: "platform_unavailable",
        message:
          "hosted tool help is not initialized — ServerRuntime must bind it.",
      },
    });
  }
  const actorId = getCurrentAgentId();
  if (!actorId) {
    return JSON.stringify({
      ok: false,
      error: {
        code: "policy_denied",
        message: "hosted tool help requires an active agent context.",
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
    const rawMessage = error instanceof Error ? error.message : String(error);
    return JSON.stringify({
      ok: false,
      error: {
        code: "runtime_error",
        message: sanitizeHostedToolControlPlaneResult(rawMessage),
      },
    });
  }
}
