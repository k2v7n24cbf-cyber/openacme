import {
  analyzeAcceptedLiveHostedToolArtifactClaims,
  readLiveHostedToolEvaluationScenarioManifest,
  selectActiveLiveHostedToolEvaluationScenario,
  selectActiveLiveHostedToolEvaluationScenarios,
} from "../test-support/hosted-tools/live-acceptance.js";

const liveEvaluationScenarioManifestPath =
  process.env["OPENACME_LIVE_HOSTED_TOOLS_SCENARIOS"] ??
  new URL(
    "../../../docs/hosted-tools-live-evaluation-scenarios.yaml",
    import.meta.url,
  ).pathname;
const requestedLiveEvaluationScenarioIds = commaSeparatedList(
  process.env["OPENACME_LIVE_HOSTED_TOOLS_SCENARIO_IDS"],
);

async function main(): Promise<void> {
  const manifest = await readLiveHostedToolEvaluationScenarioManifest(
    liveEvaluationScenarioManifestPath,
  );
  const auditedScenarios =
    requestedLiveEvaluationScenarioIds.length > 0
      ? requestedLiveEvaluationScenarioIds.map((scenarioId) =>
          selectActiveLiveHostedToolEvaluationScenario(manifest, scenarioId),
        )
      : selectActiveLiveHostedToolEvaluationScenarios(manifest);
  const diagnostics = await analyzeAcceptedLiveHostedToolArtifactClaims({
    manifest,
    scenarios: auditedScenarios,
  });
  const result = {
    status: diagnostics.length === 0 ? "pass" : "fail",
    manifestPath: liveEvaluationScenarioManifestPath,
    auditedScenarioIds: auditedScenarios.map((scenario) => scenario.id),
    artifactPaths: auditedScenarios.flatMap((scenario) =>
      scenario.acceptedArtifacts.map((artifact) => artifact.path),
    ),
    diagnostics,
  };
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = diagnostics.length === 0 ? 0 : 1;
}

function commaSeparatedList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

main().catch((error: unknown) => {
  console.log(
    JSON.stringify(
      {
        status: "fail",
        manifestPath: liveEvaluationScenarioManifestPath,
        auditedScenarioIds: [],
        artifactPaths: [],
        diagnostics: [error instanceof Error ? error.message : String(error)],
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
});
