import { createHash } from "node:crypto";
import {
  HostedIntegrationDependencyResolutionSchema,
  HostedIntegrationRuntimeSettingsSchema,
  type HostedIntegrationDependencyResolution,
  type HostedIntegrationResolvedPythonDependency,
  type HostedIntegrationRuntimeSettings,
} from "./schemas.js";

export interface HostedIntegrationDependencyDiagnostic {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

export type ResolveHostedIntegrationPythonDependenciesResult =
  | {
      ok: true;
      dependencyResolution: HostedIntegrationDependencyResolution;
    }
  | {
      ok: false;
      diagnostics: HostedIntegrationDependencyDiagnostic[];
    };

export function resolveHostedIntegrationPythonDependencies(
  runtimeInput: HostedIntegrationRuntimeSettings,
): ResolveHostedIntegrationPythonDependenciesResult {
  const runtime = HostedIntegrationRuntimeSettingsSchema.parse(runtimeInput);
  const diagnostics: HostedIntegrationDependencyDiagnostic[] = [];
  const allowedPackages = normalizedPackageSet(
    runtime.dependencyPolicy.allowedPackages,
  );
  const deniedPackages = normalizedPackageSet(
    runtime.dependencyPolicy.deniedPackages,
  );
  const seen = new Map<string, number>();
  const dependencies: HostedIntegrationResolvedPythonDependency[] = [];

  runtime.dependencies.forEach((dependency, index) => {
    const normalizedName = normalizePythonPackageName(dependency.name);
    const path = `$.runtime.dependencies.${index}.name`;
    const duplicateIndex = seen.get(normalizedName);
    if (duplicateIndex !== undefined) {
      diagnostics.push(
        errorDiagnostic(
          "dependency_duplicate",
          path,
          `dependency ${normalizedName} duplicates index ${duplicateIndex}`,
        ),
      );
    }
    seen.set(normalizedName, index);

    if (deniedPackages.has(normalizedName)) {
      diagnostics.push(
        errorDiagnostic(
          "dependency_denied",
          path,
          `dependency ${normalizedName} is denied by dependency policy`,
        ),
      );
    }

    if (!allowedPackages.has(normalizedName)) {
      diagnostics.push(
        errorDiagnostic(
          "dependency_not_allowed",
          path,
          `dependency ${normalizedName} is not allowed by dependency policy`,
        ),
      );
    }

    dependencies.push({
      name: dependency.name,
      normalizedName,
      version: dependency.version,
      requirement: `${normalizedName}==${dependency.version}`,
    });
  });

  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const sortedDependencies = [...dependencies].sort((left, right) =>
    left.normalizedName.localeCompare(right.normalizedName),
  );
  const dependencyResolution = HostedIntegrationDependencyResolutionSchema.parse(
    {
      language: "python",
      installDuringInvocation:
        runtime.dependencyPolicy.installDuringInvocation,
      dependencies: sortedDependencies,
      digest: digestDependencies(sortedDependencies),
    },
  );
  return { ok: true, dependencyResolution };
}

export function normalizePythonPackageName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

function normalizedPackageSet(values: string[]): Set<string> {
  return new Set(values.map((value) => normalizePythonPackageName(value)));
}

function digestDependencies(
  dependencies: HostedIntegrationResolvedPythonDependency[],
): string {
  const hash = createHash("sha256")
    .update(JSON.stringify({ language: "python", dependencies }))
    .digest("hex");
  return `sha256:${hash}`;
}

function errorDiagnostic(
  code: string,
  path: string,
  message: string,
): HostedIntegrationDependencyDiagnostic {
  return { severity: "error", code, path, message };
}
