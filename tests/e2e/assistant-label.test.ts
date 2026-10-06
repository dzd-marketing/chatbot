import { expect, test } from "@playwright/test";

// Students always talk to DZD Learn AI; the server picks the model behind
// each reply, so there is no model picker.
test.describe("Assistant label", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("shows DZD Learn AI in the composer", async ({ page }) => {
    const label = page.getByTestId("assistant-label");
    await expect(label).toBeVisible();
    await expect(label).toHaveText("DZD Learn AI");
  });

  test("has no model picker", async ({ page }) => {
    await expect(page.getByTestId("model-selector")).toHaveCount(0);
    await expect(page.getByPlaceholder("Search models...")).toHaveCount(0);
  });

  test("lists no providers in the models API", async ({ request }) => {
    const response = await request.get("/api/models?v=3");
    const body = await response.json();
    expect(Object.keys(body.capabilities)).toEqual(["dzd-learn/auto"]);
    expect(body.extraModels).toEqual([]);
  });
});
