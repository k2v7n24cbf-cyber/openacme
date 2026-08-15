import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

interface ArchivedArtifact {
  kind: "generation" | "source_family" | "draft" | "active_pointer";
  id: string;
  reason: string;
  from: string;
  to?: string;
}

interface RepairedArtifact {
  kind: "generation_metadata";
  id: string;
  reason: string;
  path: string;
}

const dataDir = process.env["OPENACME_DATA_DIR"];
if (!dataDir) {
  throw new Error("OPENACME_DATA_DIR is required");
}

const hostedRoot = path.join(dataDir, "hosted-integrations");
const archiveRoot = path.join(
  dataDir,
  "archived-legacy",
  `hosted-integrations-derived-only-${new Date()
    .toISOString()
    .replaceAll(":", "-")}`,
);
const archived: ArchivedArtifact[] = [];
const repaired: RepairedArtifact[] = [];

await rectifyGenerations();
await rectifySourceFamilies();
await rectifyDrafts();

console.log(
  JSON.stringify(
    {
      ok: true,
      dataDir,
      archiveRoot,
      repaired,
      archived,
    },
    null,
    2,
  ),
);

async function rectifyGenerations(): Promise<void> {
  const generationsDir = path.join(hostedRoot, "generations");
  for (const entry of await safeReadDir(generationsDir)) {
    if (
      !entry.isDirectory() ||
      entry.name === "active" ||
      entry.name === "state" ||
      entry.name.endsWith(".tmp")
    ) {
      continue;
    }
    const generationDir = path.join(generationsDir, entry.name);
    const metadataPath = path.join(generationDir, "metadata.json");
    const metadata = await readJson(metadataPath);
    if (!metadata) continue;
    const familyId = stringValue(metadata["familyId"]) ?? "unknown";
    const dispatch = runtimeDispatch(metadata);
    const familyYaml = await readOptionalText(
      path.join(generationDir, "files", "family.yaml"),
    );
    const entrypoint = runtimeEntrypoint(metadata) ?? entrypointFromYaml(familyYaml);
    const entrypointText = entrypoint
      ? await readOptionalText(path.join(generationDir, "files", entrypoint))
      : null;
    const missingDerivedHandler =
      Boolean(entrypointText?.includes("def call_tool(")) &&
      !Boolean(entrypointText?.match(/^def tool_/m));

    if (dispatch === "derived") {
      delete (metadata["runtime"] as Record<string, unknown>)["handlerDispatch"];
      await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`);
      repaired.push({
        kind: "generation_metadata",
        id: entry.name,
        path: metadataPath,
        reason: "removed redundant runtime.handlerDispatch=derived",
      });
    }

    if (
      dispatch === "legacy_call_tool" ||
      familyYaml?.includes("handlerDispatch: legacy_call_tool") ||
      missingDerivedHandler
    ) {
      await archivePath({
        kind: "generation",
        id: entry.name,
        filePath: generationDir,
        reason:
          dispatch === "legacy_call_tool"
            ? "legacy runtime.handlerDispatch"
            : missingDerivedHandler
              ? "entrypoint has legacy call_tool without deterministic tool handlers"
              : "legacy handlerDispatch in generation family.yaml",
      });
      await removeGenerationState(entry.name);
      await removeActivePointerIfMatches(familyId, entry.name);
    }
  }
}

async function rectifySourceFamilies(): Promise<void> {
  const familiesDir = path.join(hostedRoot, "source", "families");
  for (const entry of await safeReadDir(familiesDir)) {
    if (!entry.isDirectory()) continue;
    const familyDir = path.join(familiesDir, entry.name);
    const familyYaml = await readOptionalText(path.join(familyDir, "family.yaml"));
    const entrypoint = entrypointFromYaml(familyYaml);
    const entrypointText = entrypoint
      ? await readOptionalText(path.join(familyDir, entrypoint))
      : null;
    if (
      familyYaml?.includes("handlerDispatch: legacy_call_tool") ||
      (entrypointText?.includes("def call_tool(") &&
        !entrypointText.match(/^def tool_/m))
    ) {
      await archivePath({
        kind: "source_family",
        id: entry.name,
        filePath: familyDir,
        reason: "source family is not derived-only",
      });
      await archiveSibling("locks", `${entry.name}.json`, "source family archived");
      await archiveSibling(
        "proposed-families",
        `${entry.name}.json`,
        "source family archived",
      );
    }
  }
}

async function rectifyDrafts(): Promise<void> {
  const draftsDir = path.join(hostedRoot, "drafts");
  for (const entry of await safeReadDir(draftsDir)) {
    if (!entry.isDirectory()) continue;
    const draftDir = path.join(draftsDir, entry.name);
    const familyYaml = await readOptionalText(
      path.join(draftDir, "files", "family.yaml"),
    );
    const entrypoint = entrypointFromYaml(familyYaml);
    const entrypointText = entrypoint
      ? await readOptionalText(path.join(draftDir, "files", entrypoint))
      : null;
    if (
      familyYaml?.includes("handlerDispatch: legacy_call_tool") ||
      (entrypointText?.includes("def call_tool(") &&
        !entrypointText.match(/^def tool_/m))
    ) {
      await archivePath({
        kind: "draft",
        id: entry.name,
        filePath: draftDir,
        reason: "draft is not derived-only",
      });
    }
  }
}

async function archiveSibling(
  dirName: string,
  fileName: string,
  reason: string,
): Promise<void> {
  const filePath = path.join(hostedRoot, dirName, fileName);
  await archivePath({
    kind: dirName === "locks" ? "active_pointer" : "source_family",
    id: fileName,
    filePath,
    reason,
  });
}

async function removeGenerationState(generationId: string): Promise<void> {
  await archivePath({
    kind: "active_pointer",
    id: generationId,
    filePath: path.join(hostedRoot, "generations", "state", `${generationId}.json`),
    reason: "generation archived",
  });
}

async function removeActivePointerIfMatches(
  familyId: string,
  generationId: string,
): Promise<void> {
  const pointerPath = path.join(
    hostedRoot,
    "generations",
    "active",
    `${familyId}.json`,
  );
  const pointer = await readJson(pointerPath);
  if (pointer?.["generationId"] !== generationId) return;
  await archivePath({
    kind: "active_pointer",
    id: familyId,
    filePath: pointerPath,
    reason: "active generation archived",
  });
}

async function archivePath(input: {
  kind: ArchivedArtifact["kind"];
  id: string;
  filePath: string;
  reason: string;
}): Promise<void> {
  const relative = path.relative(dataDir!, input.filePath);
  const target = path.join(archiveRoot, relative);
  try {
    await mkdir(path.dirname(target), { recursive: true });
    await rename(input.filePath, target);
    archived.push({
      kind: input.kind,
      id: input.id,
      reason: input.reason,
      from: input.filePath,
      to: target,
    });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
}

async function readOptionalText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf-8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

async function readJson(filePath: string): Promise<Record<string, unknown> | null> {
  const text = await readOptionalText(filePath);
  if (!text) return null;
  return JSON.parse(text) as Record<string, unknown>;
}

async function safeReadDir(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function runtimeDispatch(metadata: Record<string, unknown>): string | null {
  const runtime = metadata["runtime"];
  if (!runtime || typeof runtime !== "object") return null;
  return stringValue((runtime as Record<string, unknown>)["handlerDispatch"]);
}

function runtimeEntrypoint(metadata: Record<string, unknown>): string | null {
  const runtime = metadata["runtime"];
  if (!runtime || typeof runtime !== "object") return null;
  return stringValue((runtime as Record<string, unknown>)["entrypoint"]);
}

function entrypointFromYaml(yaml: string | null): string | null {
  return yaml?.match(/^\s*entrypoint:\s*["']?([^"'\n]+)["']?\s*$/m)?.[1] ?? null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
