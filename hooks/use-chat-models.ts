"use client";

import { useMemo } from "react";
import useSWR from "swr";
import {
  type ChatModel,
  chatModels,
  MODELS_API_URL,
  type ModelCapabilities,
} from "@/lib/ai/models";

type ModelsResponse = {
  capabilities?: Record<string, ModelCapabilities>;
  extraModels?: ChatModel[];
  /** Demo mode only: every gateway model. */
  models?: ChatModel[];
};

const fetchModels = (url: string): Promise<ModelsResponse> =>
  fetch(url).then((response) => response.json());

/**
 * Branded TheStudent AI choices and their capabilities from /api/models.
 * Every caller shares one request and one SWR cache entry.
 */
export function useChatModels() {
  const { data, isLoading } = useSWR(MODELS_API_URL, fetchModels, {
    dedupingInterval: 3_600_000,
    revalidateOnFocus: false,
  });

  const models = useMemo(() => {
    const extra = Array.isArray(data?.extraModels) ? data.extraModels : [];
    const curatedIds = new Set(chatModels.map((model) => model.id));
    return [
      ...chatModels,
      ...extra.filter((model) => !curatedIds.has(model.id)),
    ];
  }, [data]);

  return {
    capabilities: data?.capabilities,
    /** Demo mode only. */
    demoModels: Array.isArray(data?.models) ? data.models : undefined,
    isLoading,
    models,
  };
}

/** The selectable model with this ID, including discovered ones. */
export function useChatModel(modelId: string) {
  const { capabilities, models, isLoading } = useChatModels();
  return {
    capabilities: capabilities?.[modelId],
    isLoading,
    model: models.find((model) => model.id === modelId),
  };
}
