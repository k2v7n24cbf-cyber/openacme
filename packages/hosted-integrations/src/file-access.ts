import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface HostedIntegrationFileEntry {
  path: string;
  size: number;
}

export async function listFilesUnderRoot(
  root: string,
): Promise<HostedIntegrationFileEntry[]> {
  const files: HostedIntegrationFileEntry[] = [];

  async function walk(dir: string, rel: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(fullPath, relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(fullPath);
      files.push({ path: relPath, size: info.size });
    }
  }

  await walk(root, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export async function readTextFileUnderRoot(
  root: string,
  requestedPath: string,
  label: string,
): Promise<string> {
  return readFile(resolveInsideRoot(root, requestedPath, label), "utf-8");
}

export function resolveInsideRoot(
  root: string,
  requestedPath: string,
  label: string,
): string {
  if (!requestedPath || path.isAbsolute(requestedPath)) {
    throw new Error(`path escapes ${label}`);
  }
  const absoluteRoot = path.resolve(root);
  const resolved = path.resolve(absoluteRoot, requestedPath);
  const relative = path.relative(absoluteRoot, resolved);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`path escapes ${label}`);
  }
  return resolved;
}

export function safePathSegment(name: string, value: string): string {
  if (
    !value ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    path.isAbsolute(value)
  ) {
    throw new Error(`${name} must be a safe path segment`);
  }
  return value;
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
