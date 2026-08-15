import { z } from "zod";
import {
  HostedIntegrationFamilyIdSchema,
  HostedIntegrationToolNameSchema,
  type HostedIntegrationFamilyId,
  type HostedIntegrationToolName,
} from "./schemas.js";

export const HOSTED_TOOL_PREFIX = "hosted_";
export const HOSTED_TOOL_SEPARATOR = "__";
export const HOSTED_TOOL_NAME_MAX_LENGTH = 64;

export interface HostedToolNameParts {
  familyId: HostedIntegrationFamilyId;
  toolName: HostedIntegrationToolName;
}

const ProviderToolNameSchema = z
  .string()
  .min(1)
  .max(HOSTED_TOOL_NAME_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/);

export const HostedToolNameSchema = ProviderToolNameSchema
  .superRefine((value, ctx) => {
    const parsed = parseHostedToolNameParts(value);
    for (const diagnostic of parsed.diagnostics) {
      ctx.addIssue({ code: "custom", message: diagnostic });
    }
  });
export type HostedToolName = z.infer<
  typeof HostedToolNameSchema
>;

export function buildHostedToolName(input: {
  familyId: string;
  toolName: string;
}): HostedToolName {
  const familyId = HostedIntegrationFamilyIdSchema.parse(input.familyId);
  const toolName = HostedIntegrationToolNameSchema.parse(input.toolName);
  const candidate =
    `${HOSTED_TOOL_PREFIX}${familyId}` +
    `${HOSTED_TOOL_SEPARATOR}${toolName}`;
  const parsed = HostedToolNameSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new Error(
      `invalid hosted tool name ${JSON.stringify(candidate)}: ` +
        parsed.error.issues.map((issue) => issue.message).join("; "),
    );
  }
  return parsed.data;
}

export function parseHostedToolName(
  value: string,
): HostedToolNameParts | null {
  if (!HostedToolNameSchema.safeParse(value).success) {
    return null;
  }
  return parseHostedToolNameParts(value).parts;
}

function parseHostedToolNameParts(value: string): {
  parts: HostedToolNameParts | null;
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  if (!value.startsWith(HOSTED_TOOL_PREFIX)) {
    diagnostics.push(
      `hosted tool name must start with ${HOSTED_TOOL_PREFIX}`,
    );
    return { parts: null, diagnostics };
  }
  const withoutPrefix = value.slice(HOSTED_TOOL_PREFIX.length);
  const firstSeparator = withoutPrefix.indexOf(
    HOSTED_TOOL_SEPARATOR,
  );
  if (firstSeparator < 0) {
    diagnostics.push(
      `hosted tool name must contain ${HOSTED_TOOL_SEPARATOR}`,
    );
    return { parts: null, diagnostics };
  }
  if (
    withoutPrefix.indexOf(
      HOSTED_TOOL_SEPARATOR,
      firstSeparator + HOSTED_TOOL_SEPARATOR.length,
    ) >= 0
  ) {
    diagnostics.push(
      `hosted tool name must contain exactly one ${HOSTED_TOOL_SEPARATOR}`,
    );
    return { parts: null, diagnostics };
  }
  const familyId = withoutPrefix.slice(0, firstSeparator);
  const toolName = withoutPrefix.slice(
    firstSeparator + HOSTED_TOOL_SEPARATOR.length,
  );
  const parsedFamily = HostedIntegrationFamilyIdSchema.safeParse(familyId);
  if (!parsedFamily.success) {
    diagnostics.push(`invalid hosted integration family id segment: ${familyId}`);
  }
  const parsedTool = HostedIntegrationToolNameSchema.safeParse(toolName);
  if (!parsedTool.success) {
    diagnostics.push(`invalid native hosted tool name segment: ${toolName}`);
  }
  if (diagnostics.length > 0 || !parsedFamily.success || !parsedTool.success) {
    return { parts: null, diagnostics };
  }
  return {
    parts: { familyId: parsedFamily.data, toolName: parsedTool.data },
    diagnostics: [],
  };
}
