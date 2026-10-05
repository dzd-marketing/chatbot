import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { customProvider, gateway } from "ai";
import { isTestEnvironment } from "../constants";
import type { ChatModel, ReasoningLevel } from "./models";
import { titleModel } from "./models";

const ZAI_MODEL_PREFIX = "zai/";

// Z.AI exposes an OpenAI-compatible Chat Completions API.
// ZAI_BASE_URL is optional; the default is the standard Z.AI API endpoint.
const zai = createOpenAICompatible({
  apiKey: process.env.ZAI_API_KEY,
  baseURL: process.env.ZAI_BASE_URL ?? "https://api.z.ai/api/paas/v4",
  name: "zai",
});

export const myProvider = isTestEnvironment
  ? (() => {
      const {
        chatModel,
        titleModel: mockTitleModel,
      } = require("./models.mock");
      return customProvider({
        languageModels: {
          "chat-model": chatModel,
          "title-model": mockTitleModel,
        },
      });
    })()
  : null;

export function getLanguageModel(modelId: string) {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel(modelId);
  }

  if (modelId.startsWith(ZAI_MODEL_PREFIX)) {
    if (!process.env.ZAI_API_KEY) {
      throw new Error("Missing ZAI_API_KEY environment variable");
    }

    const zaiModelId = modelId.slice(ZAI_MODEL_PREFIX.length);
    return zai(zaiModelId);
  }

  return gateway.languageModel(modelId);
}

export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return getLanguageModel(titleModel.id);
}

type ProviderOptions = Record<string, Record<string, unknown>>;

/**
 * Translates the user's reasoning level into provider-specific request
 * options. `level` must already be resolved for the model
 * (see resolveReasoningLevel).
 */
export function getReasoningProviderOptions(
  model: ChatModel | undefined,
  level: ReasoningLevel | undefined
): ProviderOptions {
  if (!model?.reasoning || !level) {
    return {};
  }

  if (model.id.startsWith(ZAI_MODEL_PREFIX)) {
    // Z.AI GLM-4.7: thinking can only be switched on or off. Unknown keys
    // under the provider name are sent as-is in the request body.
    return {
      zai: { thinking: { type: level === "off" ? "disabled" : "enabled" } },
    };
  }

  if (model.reasoning.control === "effort" && level !== "off") {
    return { openai: { reasoningEffort: level } };
  }

  return {};
}
