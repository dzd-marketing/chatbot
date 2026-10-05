import "server-only";

import {
  allowedModelIds,
  type ChatModel,
  chatModels,
  getCapabilities,
  type ModelCapabilities,
} from "./models";
import { getNvidiaModels, isNvidiaModel, nvidiaCapabilities } from "./nvidia";

/**
 * Server-side model registry: the curated models in lib/ai/models.ts plus
 * the NVIDIA chat models discovered at runtime (lib/ai/nvidia.ts).
 */

/** The curated or discovered model with this ID, if it may be used. */
export async function findChatModel(
  modelId: string
): Promise<ChatModel | undefined> {
  if (allowedModelIds.has(modelId)) {
    return chatModels.find((model) => model.id === modelId);
  }
  if (isNvidiaModel(modelId)) {
    const nvidiaModels = await getNvidiaModels();
    return nvidiaModels.find((model) => model.id === modelId);
  }
}

/** Capabilities of every selectable model, keyed by model ID. */
export async function getAllCapabilities(): Promise<
  Record<string, ModelCapabilities>
> {
  const [curated, nvidiaModels] = await Promise.all([
    getCapabilities(),
    getNvidiaModels(),
  ]);
  return {
    ...Object.fromEntries(
      nvidiaModels.map((model) => [model.id, nvidiaCapabilities])
    ),
    ...curated,
  };
}
