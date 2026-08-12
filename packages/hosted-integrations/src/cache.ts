import { resolveInsideRoot } from "./file-access.js";
import type { HostedIntegrationToolCache } from "./schemas.js";

export function resolveHostedIntegrationCachePath(input: {
  familyHome: string;
  cache: HostedIntegrationToolCache;
}): string {
  return resolveInsideRoot(input.familyHome, input.cache.path, "family home");
}
