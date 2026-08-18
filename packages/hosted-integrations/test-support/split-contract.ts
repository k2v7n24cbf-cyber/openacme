import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface SplitHostedContractFixture {
  familyYaml: string;
  toolsYaml: string;
}

export function splitLegacyFamilyFixture(
  input: string,
): SplitHostedContractFixture {
  const parsed = parseYaml(input) as Record<string, any>;
  const tools = Array.isArray(parsed.tools) ? parsed.tools : [];
  const { tools: _tools, ...family } = parsed;
  return {
    familyYaml: stringifyYaml(family),
    toolsYaml: stringifyYaml({
      kind: "openacme.hostedToolFamily",
      version: 1,
      family: { id: parsed.id },
      tools: tools.map((tool: any) => legacyToolToContractTool(parsed.id, tool)),
    }),
  };
}

export function withSplitToolContractFiles(
  files: Record<string, string>,
): Record<string, string> {
  if (!("family.yaml" in files) || "tools.yaml" in files) return files;
  const split = splitLegacyFamilyFixture(files["family.yaml"]);
  return {
    ...files,
    "family.yaml": split.familyYaml,
    "tools.yaml": split.toolsYaml,
  };
}

export async function writeSplitFamilyFixture(
  directory: string,
  familyYaml: string,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  const split = splitLegacyFamilyFixture(familyYaml);
  await writeFile(path.join(directory, "family.yaml"), split.familyYaml, "utf-8");
  await writeFile(path.join(directory, "tools.yaml"), split.toolsYaml, "utf-8");
}

function legacyToolToContractTool(
  familyId: string,
  tool: any,
): Record<string, any> {
  return {
    mcp: {
      name: `hosted_${familyId}__${tool.name}`,
      title: tool.title,
      description: tool.help?.summary ?? tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema ?? {
        type: "object",
        additionalProperties: true,
      },
      annotations: {
        readOnlyHint: tool.classification?.operation === "read",
        destructiveHint: tool.classification?.operation === "destructive",
        idempotentHint: tool.classification?.idempotency === "idempotent",
        openWorldHint: false,
      },
    },
    openacme: {
      toolName: tool.name,
      function: tool.handler ?? `tool_${tool.name}`,
      lifecycle: tool.lifecycle ?? "active",
      classification: tool.classification,
      cache: tool.cache,
      configPolicy: tool.configPolicy,
      fullHelp: tool.help?.full,
      selectWhen: tool.help?.whenToUse ?? ["Use when this hosted tool is requested."],
      doNotSelectWhen:
        tool.help?.whenNotToUse ?? ["Do not use for unrelated hosted tool requests."],
      prerequisites: [],
      parameterHelp: tool.help?.parameters ?? {},
      examples: tool.help?.examples ?? [],
      noExampleJustification: tool.help?.noExampleJustification,
      errors: tool.errors ?? [],
      pagination: tool.pagination,
      providerRef: tool.providerRef,
    },
  };
}
