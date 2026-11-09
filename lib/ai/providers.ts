import { customProvider } from "ai";
import { isTestEnvironment } from "../constants";
import { createRoutedModel, type RouterOptions } from "./router";

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

/**
 * TheStudent AI. The server automatically tries NVIDIA, GPT-OSS, then Z.AI.
 */
export function getLanguageModel(
  _modelId: string,
  options: Partial<RouterOptions> = {}
) {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("chat-model");
  }
  return createRoutedModel({ purpose: "chat", ...options });
}

/** Quick helper calls (chat titles, follow-up suggestions). */
export function getTitleModel() {
  if (isTestEnvironment && myProvider) {
    return myProvider.languageModel("title-model");
  }
  return createRoutedModel({ purpose: "fast", reasoningLevel: "off" });
}
