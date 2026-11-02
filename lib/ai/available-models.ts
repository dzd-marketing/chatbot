import "server-only";

import {
  type ChatModel,
  dzdLearnModel,
  getCapabilities,
  type ModelCapabilities,
} from "./models";

/**
 * Students only ever get TheStudent AI; the server routes each reply to a
 * model (lib/ai/router.ts). Model ids from older clients are ignored.
 */
export function findChatModel(_modelId: string): ChatModel {
  return dzdLearnModel;
}

export function getAllCapabilities(): Record<string, ModelCapabilities> {
  return getCapabilities();
}
