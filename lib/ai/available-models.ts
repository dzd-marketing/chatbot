import "server-only";

import {
  type ChatModel,
  getCapabilities,
  getChatModel,
  type ModelCapabilities,
} from "./models";

/** Resolve a validated student-facing model choice without exposing providers. */
export function findChatModel(modelId: string): ChatModel {
  return getChatModel(modelId);
}

export function getAllCapabilities(): Record<string, ModelCapabilities> {
  return getCapabilities();
}
