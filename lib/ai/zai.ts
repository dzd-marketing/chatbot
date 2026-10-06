import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * Z.AI (GLM) through its OpenAI-compatible Chat Completions API.
 * ZAI_API_KEY stays on the server; ZAI_BASE_URL is optional.
 */

export const ZAI_MODEL_PREFIX = "zai/";

/** Z.AI's free model, text only, with a thinking on/off switch. */
export const ZAI_GLM_FLASH = "glm-4.7-flash";

export const hasZaiKey = () => Boolean(process.env.ZAI_API_KEY?.trim());

let zaiProvider: ReturnType<typeof createOpenAICompatible> | null = null;

/** A Z.AI chat model by its Z.AI id (for example "glm-4.7-flash"). */
export function createZaiModel(zaiModelId: string) {
  if (!hasZaiKey()) {
    throw new Error("Missing ZAI_API_KEY environment variable");
  }
  zaiProvider ??= createOpenAICompatible({
    apiKey: process.env.ZAI_API_KEY,
    baseURL: process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/paas/v4",
    name: "zai",
  });
  return zaiProvider(zaiModelId);
}
