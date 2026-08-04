import { test, expect } from "@playwright/test";

test("loads older global workflow run history pages", async ({
  page,
  request,
}) => {
  const workflowId = `wf_runs_paged_${Date.now().toString(36)}`;

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Workflow Runs Paged Smoke",
      nodes: [
        {
          id: "exit",
          type: "builtin.exit",
          status: "succeeded",
          output: "$.input",
        },
      ],
    },
  });
  expect(created.ok()).toBeTruthy();

  for (let index = 0; index < 27; index += 1) {
    const run = await request.post(`/api/workflows/${workflowId}/runs/test`, {
      data: { input: { index } },
    });
    expect(run.ok()).toBeTruthy();
  }

  const olderPage = await request.get(
    `/api/workflow-runs?workflowId=${workflowId}&limit=25&offset=25`,
  );
  expect(olderPage.ok()).toBeTruthy();
  const olderPayload = (await olderPage.json()) as {
    runs: Array<{ id: string }>;
    hasMore: boolean;
  };
  expect(olderPayload.runs).toHaveLength(2);
  expect(olderPayload.hasMore).toBe(false);
  const olderRunId = olderPayload.runs[0]!.id;

  await page.goto(`/workflow-runs?workflowId=${workflowId}`);
  await expect(
    page.getByRole("heading", { name: "Global run history" }),
  ).toBeVisible();
  await expect(page.getByText(olderRunId)).toHaveCount(0);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(page.getByText(olderRunId)).toBeVisible();
  await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
});

test("auto-refreshes non-terminal global run details", async ({ page }) => {
  const workflowId = "wf_global_auto_refresh";
  const runId = "run_global_auto_refresh";
  const startedAt = "2026-07-30T10:00:00.000Z";
  const runningRun = workflowRun({
    id: runId,
    workflowId,
    status: "running",
    currentNodeId: "lookup",
    startedAt,
  });
  const succeededRun = workflowRun({
    id: runId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt,
    endedAt: "2026-07-30T10:00:01.000Z",
  });
  let detailRequests = 0;

  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          {
            id: workflowId,
            name: "Global Auto Refresh Workflow",
            version: 1,
            status: "draft",
          },
        ],
      }),
    }),
  );
  await page.route("**/api/workflow-runs?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [runningRun],
        limit: 25,
        offset: 0,
        hasMore: false,
        nextOffset: null,
      }),
    }),
  );
  await page.route(`**/api/workflow-runs/${runId}`, (route) => {
    detailRequests += 1;
    const run = detailRequests === 1 ? runningRun : succeededRun;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(run)),
    });
  });

  await page.goto(`/workflow-runs?run=${runId}`);
  await expect(page.getByText("running").first()).toBeVisible();
  await expect(page.getByText("current lookup")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /lookup .* running/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: /notify .* queued/ }).click();
  await expect(
    page.getByRole("group", { name: "Selected step metadata" }),
  ).toContainText("node notify");

  await expect(page.getByText("succeeded").first()).toBeVisible({
    timeout: 5_000,
  });
  await expect(page.getByText("current none")).toBeVisible();
  await expect(
    page.getByRole("button", { name: /lookup .* succeeded/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Selected step metadata" }),
  ).toContainText("node notify");
  await expect(page.getByRole("group", { name: "Output JSON" })).toContainText(
    "notified",
  );
  await page.getByRole("combobox", { name: "Timeline level" }).click();
  await page.getByRole("option", { name: "error" }).click();
  await expect(page.getByText("No error events")).toBeVisible();
  await expect(page.getByText("run_started")).toHaveCount(0);
  expect(detailRequests).toBeGreaterThanOrEqual(2);
});

test("loads artifact content from the global run JSON block", async ({
  page,
}) => {
  const workflowId = "wf_global_artifact_content";
  const runId = "run_global_artifact_content";
  const artifactId = "artifact_global_output";
  const run = workflowRun({
    id: runId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:10:00.000Z",
    endedAt: "2026-07-30T10:10:01.000Z",
  });
  const detail = runDetail(run);
  detail.steps[0]!.output = {
    artifact: {
      id: artifactId,
      kind: "step_output",
      path: `runs/${runId}/steps/${detail.steps[0]!.id}/output.json`,
      preview: '{"records":"preview only"}',
      byteLength: 70080,
    },
  };

  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          {
            id: workflowId,
            name: "Global Artifact Content Workflow",
            version: 1,
            status: "draft",
          },
        ],
      }),
    }),
  );
  await page.route("**/api/workflow-runs?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [run],
        limit: 25,
        offset: 0,
        hasMore: false,
        nextOffset: null,
      }),
    }),
  );
  await page.route(`**/api/workflow-runs/${runId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detail),
    }),
  );
  let artifactRequests = 0;
  await page.route(
    `**/api/workflow-runs/${runId}/artifacts/${artifactId}`,
    (route) => {
      artifactRequests += 1;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          artifact: {
            id: artifactId,
            runId,
            stepRunId: detail.steps[0]!.id,
            kind: "step_output",
            path: `runs/${runId}/steps/${detail.steps[0]!.id}/output.json`,
            preview: '{"records":"preview only"}',
            createdAt: "2026-07-30T10:10:01.000Z",
          },
          content: {
            records: "expanded artifact value",
            apiKey: "[redacted]",
          },
        }),
      });
    },
  );
  await page.route(
    `**/api/workflow-runs/${runId}/artifacts/${artifactId}/download`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        headers: {
          "content-disposition": `attachment; filename="${artifactId}.json"`,
        },
        body: `${JSON.stringify(
          {
            records: "downloaded artifact value",
            apiKey: "[redacted]",
          },
          null,
          2,
        )}\n`,
      }),
  );

  await page.goto(`/workflow-runs?run=${runId}`);
  const outputJson = page.getByRole("group", { name: "Output JSON" });
  await expect(outputJson).toContainText("artifact_global_output");
  await expect(outputJson).not.toContainText("expanded artifact value");

  await outputJson
    .getByRole("button", { name: "Load artifact", exact: true })
    .click();

  await expect(outputJson).toContainText("expanded artifact value");
  await expect(outputJson).toContainText("[redacted]");
  await expect(outputJson).not.toContainText("raw-route-download-key");
  expect(artifactRequests).toBe(1);

  const downloadPromise = page.waitForEvent("download");
  await outputJson.getByRole("button", { name: "Download artifact" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe(`${artifactId}.json`);
  expect(download.url()).toContain(
    `/api/workflow-runs/${runId}/artifacts/${artifactId}/download`,
  );
});

test("shows unavailable artifact errors in the global run JSON block", async ({
  page,
}) => {
  const workflowId = "wf_global_artifact_missing";
  const runId = "run_global_artifact_missing";
  const artifactId = "artifact_missing_output";
  const run = workflowRun({
    id: runId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:12:00.000Z",
    endedAt: "2026-07-30T10:12:01.000Z",
  });
  const detail = runDetail(run);
  detail.steps[0]!.output = {
    artifact: {
      id: artifactId,
      kind: "step_output",
      path: `runs/${runId}/steps/${detail.steps[0]!.id}/output.json`,
      preview: '{"records":"preview only"}',
      byteLength: 70080,
    },
  };

  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          {
            id: workflowId,
            name: "Global Missing Artifact Workflow",
            version: 1,
            status: "draft",
          },
        ],
      }),
    }),
  );
  await page.route("**/api/workflow-runs?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [run],
        limit: 25,
        offset: 0,
        hasMore: false,
        nextOffset: null,
      }),
    }),
  );
  await page.route(`**/api/workflow-runs/${runId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(detail),
    }),
  );
  await page.route(
    `**/api/workflow-runs/${runId}/artifacts/${artifactId}`,
    (route) =>
      route.fulfill({
        status: 404,
        contentType: "application/json",
        body: JSON.stringify({ error: "artifact_not_found" }),
      }),
  );

  await page.goto(`/workflow-runs?run=${runId}`);
  const outputJson = page.getByRole("group", { name: "Output JSON" });
  await expect(outputJson).toContainText(artifactId);

  await outputJson
    .getByRole("button", { name: "Load artifact", exact: true })
    .click();

  await expect(outputJson).toContainText("Artifact unavailable");
  await expect(outputJson).not.toContainText("artifact_not_found");
  await expect(outputJson).toContainText(artifactId);
});

test("shows pruned artifact errors through the deployed global run console", async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString(36);
  const workflowId = `wf_global_pruned_artifact_${suffix}`;
  const largeMessage = "x".repeat(70_000);

  const created = await request.post("/api/workflows", {
    data: {
      id: workflowId,
      name: "Global Pruned Artifact Smoke",
      nodes: [
        {
          id: "large_echo",
          type: "mcp.tool",
          server: "demo",
          tool: "echo",
          input: {
            message: largeMessage,
            apiKey: "raw-web-pruned-artifact-key",
          },
        },
      ],
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();

  const run = await request.post(`/api/workflows/${workflowId}/runs/test`, {
    data: { input: { customerId: "cust_pruned_artifact" } },
  });
  expect(run.ok(), await run.text()).toBeTruthy();
  const detail = (await run.json()) as {
    run: { id: string };
    steps: Array<{
      output?: {
        artifact?: {
          id: string;
          kind: string;
        };
      };
    }>;
    artifacts?: Array<{ id: string; kind: string }>;
  };
  const artifactRef = detail.steps[0]?.output?.artifact;
  expect(artifactRef?.kind).toBe("step_output");
  expect(detail.artifacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: artifactRef?.id,
        kind: "step_output",
      }),
    ]),
  );

  const pruned = await request.post("/api/workflow-artifacts/prune", {
    data: { createdBefore: "2999-01-01T00:00:00.000Z" },
  });
  expect(pruned.ok()).toBeTruthy();

  const contentAfterPrune = await request.get(
    `/api/workflow-runs/${detail.run.id}/artifacts/${artifactRef!.id}`,
  );
  expect(contentAfterPrune.status()).toBe(404);
  expect(await contentAfterPrune.json()).toEqual({
    error: "artifact_not_found",
  });

  const detailAfterPrune = await request.get(
    `/api/workflow-runs/${detail.run.id}`,
  );
  expect(detailAfterPrune.ok()).toBeTruthy();
  const persisted = (await detailAfterPrune.json()) as {
    artifacts?: Array<{ id: string; kind: string }>;
  };
  expect(persisted.artifacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: artifactRef?.id,
        kind: "step_output",
      }),
    ]),
  );

  await page.goto(`/workflow-runs?run=${detail.run.id}`);
  const outputJson = page.getByRole("group", { name: "Output JSON" });
  await expect(outputJson).toContainText(artifactRef!.id);

  await outputJson
    .getByRole("button", { name: "Load artifact", exact: true })
    .click();

  await expect(outputJson).toContainText("Artifact unavailable");
  await expect(outputJson).not.toContainText("artifact_not_found");
  await expect(outputJson).toContainText(artifactRef!.id);
  await expect(outputJson).not.toContainText("raw-web-pruned-artifact-key");
});

test("removes global run rows that no longer match filters after auto-refresh", async ({
  page,
}) => {
  const workflowId = "wf_global_auto_refresh_filter";
  const runId = "run_global_auto_refresh_filter";
  const startedAt = "2026-07-30T10:05:00.000Z";
  const runningRun = workflowRun({
    id: runId,
    workflowId,
    status: "running",
    currentNodeId: "lookup",
    startedAt,
  });
  const succeededRun = workflowRun({
    id: runId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt,
    endedAt: "2026-07-30T10:05:01.000Z",
  });
  let detailRequests = 0;

  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          {
            id: workflowId,
            name: "Global Auto Refresh Filter Workflow",
            version: 1,
            status: "draft",
          },
        ],
      }),
    }),
  );
  await page.route("**/api/workflow-runs?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [runningRun],
        limit: 25,
        offset: 0,
        hasMore: false,
        nextOffset: null,
      }),
    }),
  );
  await page.route(`**/api/workflow-runs/${runId}`, (route) => {
    detailRequests += 1;
    const run = detailRequests === 1 ? runningRun : succeededRun;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(run)),
    });
  });

  await page.goto(`/workflow-runs?status=running&run=${runId}`);
  const runRow = page.locator("button").filter({ hasText: runId });
  await expect(runRow).toBeVisible();
  await expect(page.getByText("current lookup")).toBeVisible();

  await expect(page.getByText("current none")).toBeVisible({ timeout: 5_000 });
  await expect(page.getByText("succeeded").first()).toBeVisible();
  await expect(runRow).toHaveCount(0);
  expect(detailRequests).toBeGreaterThanOrEqual(2);
});

test("keeps selected global run step after cancel", async ({ page }) => {
  const workflowId = "wf_global_cancel_selection";
  const runId = "run_global_cancel_selection";
  const startedAt = "2026-07-30T10:05:00.000Z";
  const runningRun = workflowRun({
    id: runId,
    workflowId,
    status: "running",
    currentNodeId: "lookup",
    startedAt,
  });
  const canceledRun = workflowRun({
    id: runId,
    workflowId,
    status: "canceled",
    currentNodeId: null,
    startedAt,
    endedAt: "2026-07-30T10:05:01.000Z",
  });
  let canceled = false;

  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          {
            id: workflowId,
            name: "Global Cancel Selection Workflow",
            version: 1,
            status: "draft",
          },
        ],
      }),
    }),
  );
  await page.route("**/api/workflow-runs?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        runs: [canceled ? canceledRun : runningRun],
        limit: 25,
        offset: 0,
        hasMore: false,
        nextOffset: null,
      }),
    }),
  );
  await page.route(`**/api/workflow-runs/${runId}/cancel`, (route) => {
    canceled = true;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(canceledRun)),
    });
  });
  await page.route(`**/api/workflow-runs/${runId}`, (route) => {
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(canceled ? canceledRun : runningRun)),
    });
  });

  await page.goto(`/workflow-runs?run=${runId}`);
  await expect(page.getByText("running").first()).toBeVisible();
  await page.getByRole("button", { name: /notify .* queued/ }).click();
  await expect(
    page.getByRole("group", { name: "Selected step metadata" }),
  ).toContainText("node notify");

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Run canceled", { exact: true })).toBeVisible();
  await expect(page.getByText("canceled").first()).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Selected step metadata" }),
  ).toContainText("node notify");
});

test("keeps loaded global run pages after cancel", async ({ page }) => {
  const workflowId = "wf_global_cancel_loaded_pages";
  const selectedRunId = "run_global_cancel_loaded_pages_selected";
  const olderRunId = "run_global_cancel_loaded_pages_older";
  const startedAt = "2026-07-30T10:20:00.000Z";
  const runningRun = workflowRun({
    id: selectedRunId,
    workflowId,
    status: "running",
    currentNodeId: "lookup",
    startedAt,
  });
  const newestRun = workflowRun({
    id: "run_global_cancel_loaded_pages_newest",
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:21:00.000Z",
    endedAt: "2026-07-30T10:21:01.000Z",
  });
  const olderRun = workflowRun({
    id: olderRunId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:19:00.000Z",
    endedAt: "2026-07-30T10:19:01.000Z",
  });
  const canceledRun = workflowRun({
    id: selectedRunId,
    workflowId,
    status: "canceled",
    currentNodeId: null,
    startedAt,
    endedAt: "2026-07-30T10:20:01.000Z",
  });
  let canceled = false;

  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          {
            id: workflowId,
            name: "Global Cancel Loaded Pages Workflow",
            version: 1,
            status: "draft",
          },
        ],
      }),
    }),
  );
  await page.route("**/api/workflow-runs?**", (route) => {
    const url = new URL(route.request().url());
    const offset = url.searchParams.get("offset");
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        offset === "2"
          ? {
              runs: [olderRun],
              limit: 25,
              offset: 2,
              hasMore: false,
              nextOffset: null,
            }
          : {
              runs: [canceled ? canceledRun : runningRun, newestRun],
              limit: 25,
              offset: 0,
              hasMore: true,
              nextOffset: 2,
            },
      ),
    });
  });
  await page.route(`**/api/workflow-runs/${selectedRunId}/cancel`, (route) => {
    canceled = true;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(canceledRun)),
    });
  });
  await page.route(`**/api/workflow-runs/${selectedRunId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(canceled ? canceledRun : runningRun)),
    }),
  );

  await page.goto(
    `/workflow-runs?workflowId=${workflowId}&run=${selectedRunId}`,
  );
  const selectedRunRow = page.locator("button").filter({
    hasText: selectedRunId,
  });
  const olderRunRow = page.locator("button").filter({ hasText: olderRunId });
  await expect(selectedRunRow).toBeVisible();
  await expect(olderRunRow).toHaveCount(0);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(olderRunRow).toBeVisible();

  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByText("Run canceled", { exact: true })).toBeVisible();
  await expect(selectedRunRow).toContainText("canceled");
  await expect(olderRunRow).toBeVisible();
});

test("keeps loaded global run pages after rerun", async ({ page }) => {
  const workflowId = "wf_global_rerun_loaded_pages";
  const sourceRunId = "run_global_rerun_loaded_pages_source";
  const rerunRunId = "run_global_rerun_loaded_pages_retry";
  const olderRunId = "run_global_rerun_loaded_pages_older";
  const sourceStartedAt = "2026-07-30T10:45:00.000Z";
  const sourceRun = workflowRun({
    id: sourceRunId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: sourceStartedAt,
    endedAt: "2026-07-30T10:45:01.000Z",
  });
  const newestRun = workflowRun({
    id: "run_global_rerun_loaded_pages_newest",
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:46:00.000Z",
    endedAt: "2026-07-30T10:46:01.000Z",
  });
  const olderRun = workflowRun({
    id: olderRunId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:44:00.000Z",
    endedAt: "2026-07-30T10:44:01.000Z",
  });
  const rerunRun = workflowRun({
    id: rerunRunId,
    workflowId,
    status: "succeeded",
    currentNodeId: null,
    startedAt: "2026-07-30T10:47:00.000Z",
    endedAt: "2026-07-30T10:47:01.000Z",
  });
  let reran = false;

  await page.route("**/api/workflows", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        workflows: [
          {
            id: workflowId,
            name: "Global Rerun Loaded Pages Workflow",
            version: 1,
            status: "draft",
          },
        ],
      }),
    }),
  );
  await page.route("**/api/workflow-runs?**", (route) => {
    const url = new URL(route.request().url());
    const offset = url.searchParams.get("offset");
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(
        offset === "2"
          ? {
              runs: [olderRun],
              limit: 25,
              offset: 2,
              hasMore: false,
              nextOffset: null,
            }
          : {
              runs: [reran ? rerunRun : sourceRun, newestRun],
              limit: 25,
              offset: 0,
              hasMore: true,
              nextOffset: 2,
            },
      ),
    });
  });
  await page.route(`**/api/workflow-runs/${sourceRunId}/rerun`, (route) => {
    reran = true;
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(rerunRun)),
    });
  });
  await page.route(`**/api/workflow-runs/${sourceRunId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(sourceRun)),
    }),
  );
  await page.route(`**/api/workflow-runs/${rerunRunId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(runDetail(rerunRun)),
    }),
  );

  await page.goto(`/workflow-runs?workflowId=${workflowId}&run=${sourceRunId}`);
  await expect(
    page.getByRole("heading", { name: "Global run history" }),
  ).toBeVisible();
  const rerunRunRow = page.locator("button").filter({ hasText: rerunRunId });
  const olderRunRow = page.locator("button").filter({ hasText: olderRunId });
  await expect(rerunRunRow).toHaveCount(0);
  await expect(olderRunRow).toHaveCount(0);
  await page.getByRole("button", { name: "Load more" }).click();
  await expect(olderRunRow).toBeVisible();

  await page.getByRole("button", { name: "Rerun", exact: true }).click();
  await expect(
    page.getByText("Run queued from prior input", { exact: true }),
  ).toBeVisible();
  await expect(rerunRunRow).toBeVisible();
  await expect(olderRunRow).toBeVisible();
});

test("filters global workflow run history and opens failed run details", async ({
  page,
  request,
}) => {
  const suffix = Date.now().toString(36);
  const okWorkflowId = `wf_runs_ok_${suffix}`;
  const failedWorkflowId = `wf_runs_failed_${suffix}`;

  const okCreated = await request.post("/api/workflows", {
    data: {
      id: okWorkflowId,
      name: "Workflow Runs OK Smoke",
      nodes: [
        {
          id: "set_customer",
          type: "builtin.set",
          assign: { customer: "$.input.customer" },
        },
      ],
    },
  });
  expect(okCreated.ok()).toBeTruthy();
  const okRun = await request.post(`/api/workflows/${okWorkflowId}/runs/test`, {
    data: { input: { customer: { id: "cust_ok", name: "Ok Ada" } } },
  });
  expect(okRun.ok()).toBeTruthy();

  const failedCreated = await request.post("/api/workflows", {
    data: {
      id: failedWorkflowId,
      name: "Workflow Runs Failed Smoke",
      nodes: [
        {
          id: "log_customer",
          type: "builtin.log.info",
          message: "About to inspect failed customer",
          payload: "$.input.customer",
        },
        {
          id: "route_customer",
          type: "builtin.if_else",
          condition: "$.input.customer.riskScore >= 70",
          then: ["missing_customer"],
          else: ["low_customer"],
        },
        {
          id: "low_customer",
          type: "builtin.log.info",
          message: "Low risk customer",
        },
        {
          id: "missing_customer",
          label: "Missing customer lookup",
          type: "builtin.transform",
          input: { customer: "$.context.customer.missing" },
          transform: { kind: "identity" },
        },
      ],
    },
  });
  expect(failedCreated.ok()).toBeTruthy();
  const failedRun = await request.post(
    `/api/workflows/${failedWorkflowId}/runs/test`,
    {
      data: {
        input: {
          customer: {
            id: "cust_failed",
            name: "Fail Ada",
            riskScore: 82,
            apiKey: "raw-run-api-key",
          },
        },
      },
    },
  );
  expect(failedRun.ok()).toBeTruthy();
  const failedDetail = (await failedRun.json()) as {
    run: { id: string };
  };

  await page.goto(`/workflow-runs?status=succeeded&run=${failedDetail.run.id}`);
  await expect(
    page.getByRole("heading", { name: "Global run history" }),
  ).toBeVisible();
  await expect(page.getByText(failedDetail.run.id)).toBeVisible();
  await expect(page.getByText("Workflow Runs OK Smoke")).toBeVisible();
  await expect(page.getByText("Workflow Runs Failed Smoke")).toBeVisible();
  expect(new URL(page.url()).searchParams.get("run")).toBe(failedDetail.run.id);

  await page.goto(
    "/workflow-runs?status=failed&triggerId=manual&createdFrom=2000-01-01&createdTo=2999-01-01",
  );

  await expect(
    page.getByRole("heading", { name: "Global run history" }),
  ).toBeVisible();
  const triggerFilter = page.getByRole("textbox", {
    name: "Trigger",
    exact: true,
  });
  await expect(triggerFilter).toHaveValue("manual");
  await expect(page.getByLabel("Created from")).toHaveValue("2000-01-01");
  await expect(page.getByLabel("Created to")).toHaveValue("2999-01-01");
  await expect(
    page.getByRole("button", { name: /Workflow Runs Failed Smoke/ }),
  ).toBeVisible();
  await expect(page.getByText("Workflow Runs OK Smoke")).toHaveCount(0);
  await triggerFilter.fill("nightly");
  await expect(page.getByText("No runs")).toBeVisible();
  await triggerFilter.fill("manual");
  const failedRunRow = page.getByRole("button", {
    name: /Workflow Runs Failed Smoke/,
  });
  await expect(failedRunRow).toBeVisible();
  await expect(failedRunRow).toContainText("trigger manual");
  await expect(failedRunRow).toContainText("v1");
  await expect(failedRunRow).toContainText("draft");
  await expect(
    page.getByRole("button", { name: /missing_customer .* failed/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /missing_customer .* retry 0 .* failed/ }),
  ).toBeVisible();
  await expect(page.getByLabel("missing_customer branch state")).toContainText(
    "branch selected",
  );
  await expect(page.getByLabel("low_customer branch state")).toContainText(
    "branch skipped",
  );
  await expect(
    page.getByText(/duration \d+ms|duration \d+\.\d+s/).first(),
  ).toBeVisible();
  await expect(page.getByText("current none")).toBeVisible();
  await expect(page.getByText("waiting none")).toBeVisible();
  const runDetailHeader = page.getByRole("region", {
    name: "Run detail header",
  });
  await expect(runDetailHeader).toContainText("Workflow Runs Failed Smoke");
  await expect(runDetailHeader).toContainText("trigger manual");
  const globalRefreshPromise = page.waitForResponse(
    (response) =>
      response.url().includes(`/api/workflow-runs/${failedDetail.run.id}`) &&
      response.status() === 200,
  );
  await page.getByRole("button", { name: "Refresh" }).click();
  await globalRefreshPromise;
  await expect(page.getByRole("group", { name: "Logs JSON" })).toBeVisible();
  await expect(
    page
      .locator("pre")
      .filter({ hasText: "About to inspect failed customer" })
      .last(),
  ).toBeVisible();
  await expect(
    page.locator("pre").filter({ hasText: '"id": "cust_failed"' }).first(),
  ).toBeVisible();
  const runInputJson = page.getByRole("group", { name: "Run input JSON" });
  await expect(runInputJson).toContainText("redacted");
  await expect(runInputJson).toContainText('"apiKey": "[redacted]"');
  await expect(runInputJson).not.toContainText("raw-run-api-key");
  const logOutputJson = page.getByRole("group", { name: "Output JSON" });
  await expect(logOutputJson).toContainText("redacted");
  await expect(logOutputJson).not.toContainText("raw-run-api-key");
  const redactedEventPayloadJson = page
    .getByRole("group", { name: /Event #\d+ payload JSON/ })
    .filter({ hasText: '"apiKey": "[redacted]"' })
    .first();
  await expect(redactedEventPayloadJson).toBeVisible();
  await expect(redactedEventPayloadJson).toContainText(/Event #\d+ payload/);
  await expect(redactedEventPayloadJson).not.toContainText("raw-run-api-key");
  await page
    .getByRole("button", { name: /missing_customer .* failed/ })
    .click();
  const selectedStepMetadata = page.getByRole("group", {
    name: "Selected step metadata",
  });
  await expect(selectedStepMetadata).toContainText("type builtin.transform");
  await expect(selectedStepMetadata).toContainText(
    "label Missing customer lookup",
  );
  await expect(selectedStepMetadata).toContainText("branch selected");
  await expect(selectedStepMetadata).toContainText(
    "condition $.input.customer.riskScore >= 70",
  );
  await expect(selectedStepMetadata).toContainText(/duration \d+ms/);
  await expect(selectedStepMetadata).toContainText("started ");
  await expect(selectedStepMetadata).toContainText("ended ");
  await expect(page.getByText("step_failed")).toBeVisible();
  await expect(page.getByRole("group", { name: "Error JSON" })).toContainText(
    "Reference not found: $.context.customer.missing",
  );
  const stepInputJson = page.getByRole("group", {
    name: "Input JSON",
    exact: true,
  });
  await expect(stepInputJson).not.toContainText("raw-run-api-key");

  await page.getByRole("combobox", { name: "Timeline level" }).click();
  await page.getByRole("option", { name: "error" }).click();
  await expect(page.getByText("step_failed")).toBeVisible();
  await expect(
    page.getByLabel(/Event #\d+ step/).filter({ hasText: "missing_customer" }),
  ).toBeVisible();
  await expect(page.getByLabel(/Event #\d+ timestamp/).first()).toContainText(
    "·",
  );
  await expect(
    page
      .getByRole("group", { name: /Event #\d+ payload JSON/ })
      .filter({ hasText: "Reference not found: $.context.customer.missing" }),
  ).toBeVisible();
  await expect(page.getByText("run_started")).toHaveCount(0);

  await page.getByRole("button", { name: "Rerun" }).click();
  await expect(page.getByText("Run queued from prior input")).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).searchParams.get("run"))
    .not.toBe(failedDetail.run.id);
  await expect(
    page.getByRole("button", { name: /Workflow Runs Failed Smoke/ }),
  ).toHaveCount(2);
  await expect(
    page.locator("pre").filter({ hasText: '"id": "cust_failed"' }).last(),
  ).toBeVisible();
  await expect(page.getByText("step_failed")).toBeVisible();
});

function workflowRun({
  id,
  workflowId,
  status,
  currentNodeId,
  startedAt,
  endedAt = null,
}: {
  id: string;
  workflowId: string;
  status: "running" | "succeeded" | "canceled";
  currentNodeId: string | null;
  startedAt: string;
  endedAt?: string | null;
}) {
  return {
    id,
    workflowId,
    workflowVersion: 1,
    definitionSource: "draft",
    mode: "test",
    trigger: { kind: "manual", triggerId: "manual" },
    status,
    input: { customerId: "cust_auto" },
    context:
      status === "succeeded" || status === "canceled"
        ? { customerId: "cust_auto" }
        : {},
    currentNodeId,
    waitingReason: null,
    createdAt: startedAt,
    startedAt,
    endedAt,
  };
}

function runDetail(run: ReturnType<typeof workflowRun>) {
  const lookupStep = {
    id: `${run.id}:lookup:1`,
    runId: run.id,
    nodeId: "lookup",
    attempt: 1,
    status:
      run.status === "succeeded"
        ? "succeeded"
        : run.status === "canceled"
          ? "canceled"
          : "running",
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs:
      run.status === "succeeded" || run.status === "canceled" ? 1000 : null,
    input: { id: "cust_auto" },
    ...(run.status === "succeeded" || run.status === "canceled"
      ? { output: { id: "cust_auto", name: "Auto Ada" } }
      : {}),
  };
  const notifyStep = {
    id: `${run.id}:notify:1`,
    runId: run.id,
    nodeId: "notify",
    attempt: 1,
    status:
      run.status === "succeeded"
        ? "succeeded"
        : run.status === "canceled"
          ? "canceled"
          : "queued",
    startedAt:
      run.status === "succeeded" || run.status === "canceled"
        ? run.startedAt
        : null,
    endedAt: run.endedAt,
    durationMs:
      run.status === "succeeded" || run.status === "canceled" ? 1000 : null,
    ...(run.status === "succeeded" || run.status === "canceled"
      ? { output: { message: "notified" } }
      : {}),
  };
  return {
    run,
    steps: [lookupStep, notifyStep],
    events: [
      {
        id: `${run.id}:event:1`,
        runId: run.id,
        stepRunId: null,
        sequence: 1,
        level: "system",
        kind: "run_started",
        message: "Workflow run started",
        createdAt: run.startedAt,
      },
      {
        id: `${run.id}:event:2`,
        runId: run.id,
        stepRunId: lookupStep.id,
        sequence: 2,
        level: "system",
        kind: "step_started",
        message: "Step lookup started",
        payload: { nodeId: "lookup", nodeType: "mcp.tool" },
        createdAt: run.startedAt,
      },
      ...(run.status === "succeeded" || run.status === "canceled"
        ? [
            {
              id: `${run.id}:event:3`,
              runId: run.id,
              stepRunId: lookupStep.id,
              sequence: 3,
              level: "system",
              kind: "step_completed",
              message: "Step lookup completed",
              payload: { status: "succeeded" },
              createdAt: run.endedAt,
            },
            {
              id: `${run.id}:event:4`,
              runId: run.id,
              stepRunId: notifyStep.id,
              sequence: 4,
              level: "system",
              kind: "step_started",
              message: "Step notify started",
              payload: { nodeId: "notify", nodeType: "builtin.log.info" },
              createdAt: run.endedAt,
            },
            {
              id: `${run.id}:event:5`,
              runId: run.id,
              stepRunId: notifyStep.id,
              sequence: 5,
              level: "system",
              kind: "step_completed",
              message: "Step notify completed",
              payload: { status: "succeeded" },
              createdAt: run.endedAt,
            },
            {
              id: `${run.id}:event:6`,
              runId: run.id,
              stepRunId: null,
              sequence: 6,
              level: "system",
              kind:
                run.status === "canceled" ? "run_canceled" : "run_completed",
              message:
                run.status === "canceled"
                  ? "Workflow run canceled"
                  : "Workflow run completed",
              payload: { status: run.status },
              createdAt: run.endedAt,
            },
          ]
        : []),
    ],
  };
}
