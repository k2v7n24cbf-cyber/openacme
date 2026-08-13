import { z } from "zod";
import {
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationToolNameSchema,
  type HostedIntegrationFamilyId,
  type HostedIntegrationToolName,
} from "./schemas.js";

export const HOSTED_INTEGRATION_MANAGED_TOOL_PREFIX = "managed_";
export const HOSTED_INTEGRATION_MANAGED_TOOL_SEPARATOR = "__";
export const HOSTED_INTEGRATION_MANAGED_TOOL_NAME_MAX_LENGTH = 64;

export interface HostedIntegrationManagedToolNameParts {
  familyId: HostedIntegrationFamilyId;
  toolName: HostedIntegrationToolName;
}

const ProviderToolNameSchema = z
  .string()
  .min(1)
  .max(HOSTED_INTEGRATION_MANAGED_TOOL_NAME_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/);

export const HostedIntegrationManagedToolNameSchema = ProviderToolNameSchema
  .superRefine((value, ctx) => {
    const parsed = parseManagedToolNameParts(value);
    for (const diagnostic of parsed.diagnostics) {
      ctx.addIssue({ code: "custom", message: diagnostic });
    }
  });
export type HostedIntegrationManagedToolName = z.infer<
  typeof HostedIntegrationManagedToolNameSchema
>;

export function buildHostedIntegrationManagedToolName(input: {
  familyId: string;
  toolName: string;
}): HostedIntegrationManagedToolName {
  const familyId = HostedIntegrationFamilyIdSchema.parse(input.familyId);
  const toolName = HostedIntegrationToolNameSchema.parse(input.toolName);
  const candidate =
    `${HOSTED_INTEGRATION_MANAGED_TOOL_PREFIX}${familyId}` +
    `${HOSTED_INTEGRATION_MANAGED_TOOL_SEPARATOR}${toolName}`;
  const parsed = HostedIntegrationManagedToolNameSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `invalid managed hosted integration tool name ${JSON.stringify(candidate)}: ` +
        parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return parsed.data;
}

export function parseHostedIntegrationManagedToolName(
  value: string,
): HostedIntegrationManagedToolNameParts | null {
  if (!HostedIntegrationManagedToolNameSchema.safeParse(value).success) {
    return null;
  }
  return parseManagedToolNameParts(value).parts;
}

function parseManagedToolNameParts(value: string): {
  parts: HostedIntegrationManagedToolNameParts | null;
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  if (!value.startsWith(HOSTED_INTEGRATION_MANAGED_TOOL_PREFIX)) {
    diagnostics.push(
      `managed hosted integration tool name must start with ${HOSTED_INTEGRATION_MANAGED_TOOL_PREFIX}`,
    );
    return { parts: null, diagnostics };
  }
  const withoutPrefix = value.slice(HOSTED_INTEGRATION_MANAGED_TOOL_PREFIX.length);
  const firstSeparator = withoutPrefix.indexOf(
    HOSTED_INTEGRATION_MANAGED_TOOL_SEPARATOR,
  );
  if (firstSeparator < 0) {
    diagnostics.push(
      `managed hosted integration tool name must contain ${HOSTED_INTEGRATION_MANAGED_TOOL_SEPARATOR}`,
    );
    return { parts: null, diagnostics };
  }
  if (
    withoutPrefix.indexOf(
      HOSTED_INTEGRATION_MANAGED_TOOL_SEPARATOR,
      firstSeparator + HOSTED_INTEGRATION_MANAGED_TOOL_SEPARATOR.length,
    ) >= 0
  ) {
    diagnostics.push(
      `managed hosted integration tool name must contain exactly one ${HOSTED_INTEGRATION_MANAGED_TOOL_SEPARATOR}`,
    );
    return { parts: null, diagnostics };
  }
  const familyId = withoutPrefix.slice(0, firstSeparator);
  const toolName = withoutPrefix.slice(
    firstSeparator + HOSTED_INTEGRATION_MANAGED_TOOL_SEPARATOR.length,
  );
  const parsedFamily = HostedIntegrationFamilyIdSchema.safeParse(familyId);
  if (!parsedFamily.success) {
    diagnostics.push(`invalid hosted integration family id segment: ${familyId}`);
  }
  const parsedTool = HostedIntegrationToolNameSchema.safeParse(toolName);
  if (!parsedTool.success) {
    diagnostics.push(`invalid hosted integration tool name segment: ${toolName}`);
  }
  if (diagnostics.length > 0 || !parsedFamily.success || !parsedTool.success) {
    return { parts: null, diagnostics };
  }
  return {
    parts: { familyId: parsedFamily.data, toolName: parsedTool.data },
    diagnostics: [],
  };
}
