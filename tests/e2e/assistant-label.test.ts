import { expect, test } from "@playwright/test";

const studentChoices = [
  "TheStudent AI Auto",
  "TheStudent AI Flash v1",
  "TheStudent AI Study v1",
];

test.describe("Assistant route picker", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("offers only the three branded choices in the composer", async ({
    page,
  }) => {
    const picker = page.getByTestId("model-selector");
    await expect(picker).toBeVisible();
    await expect(picker).toHaveText(studentChoices[0]);

    await picker.click();
    const options = page.getByRole("option");
    await expect(options).toHaveCount(3);
    await expect(options).toHaveText(studentChoices);

    await options.nth(2).click();
    await expect(picker).toHaveText(studentChoices[2]);
  });

  test("exposes no provider or underlying model names in the models API", async ({
    request,
  }) => {
    const response = await request.get("/api/models?v=4");
    const body = await response.json();

    expect(Object.keys(body.capabilities)).toEqual([
      "dzd-learn/auto",
      "dzd-learn/flash-v1",
      "dzd-learn/study-v1",
    ]);
    expect(body.extraModels).toEqual([]);
    expect(JSON.stringify(body)).not.toMatch(/nvidia|opencode|mimo/i);
  });
});
