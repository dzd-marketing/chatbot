import { expect, test } from "@playwright/test";

test.describe("Assistant label", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("shows only the fixed TheStudent AI label in the composer", async ({
    page,
  }) => {
    const label = page.getByTestId("assistant-label");
    await expect(label).toBeVisible();
    await expect(label).toHaveText("TheStudent AI");
    await expect(page.getByTestId("model-selector")).toHaveCount(0);
    await expect(page.getByRole("option")).toHaveCount(0);
  });

  test("exposes only the automatic branded route in the models API", async ({
    request,
  }) => {
    const response = await request.get("/api/models?v=6");
    const body = await response.json();

    expect(Object.keys(body.capabilities)).toEqual(["thestudent/auto"]);
    expect(body.extraModels).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/dzd|nvidia|opencode|mimo/i);
  });
});
