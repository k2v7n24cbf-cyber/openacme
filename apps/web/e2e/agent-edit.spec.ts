import { test, expect } from "@playwright/test";

// Completes agent CRUD via the UI (we already cover create + delete): edit the
// seeded agent's role, Save (PUT /api/agents/:id), reload, assert it persisted.
const ROLE_PLACEHOLDER = "Owns X. Good for Y. Redirects Z to @other-agent.";

test("edit an agent's role and persist it", async ({ page }) => {
  await page.goto("/agents?id=helper");

  const role = page.getByPlaceholder(ROLE_PLACEHOLDER);
  await expect(role).toBeVisible();

  const marker = `Reviews PRs ${Date.now().toString().slice(-6)}`;
  await role.fill(marker);
  // The header Save enables once the draft diverges from the saved agent.
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await page.reload();
  await expect(page.getByPlaceholder(ROLE_PLACEHOLDER)).toHaveValue(marker);
});

test("edit an agent's parallel session setting and persist it", async ({ page }) => {
  await page.goto("/agents?id=helper&tab=settings");

  const parallel = page.getByRole("combobox", { name: "Parallel sessions" });
  await expect(parallel).toBeVisible();
  await expect(parallel).toContainText("1");

  await parallel.click();
  await page.getByRole("option", { name: "3", exact: true }).click();
  await expect(
    page.getByText(/Parallel sessions share this agent's workspace/)
  ).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();

  await page.reload();
  const reloaded = page.getByRole("combobox", {
    name: "Parallel sessions",
  });
  await expect(reloaded).toContainText("3");
  await expect(
    page.getByText(/Parallel sessions share this agent's workspace/)
  ).toBeVisible();
});
