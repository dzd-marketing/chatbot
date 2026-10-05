import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { APICallError, RetryError, wrapLanguageModel } from "ai";
import type { ChatModel, ModelCapabilities } from "./models";

/**
 * NVIDIA API catalog (build.nvidia.com): an OpenAI-compatible API at
 * https://integrate.api.nvidia.com/v1, authenticated with NVIDIA_API_KEY
 * (server-side only, never sent to the browser).
 *
 * The chat models are discovered automatically from GET /v1/models
 * (refreshed daily). NVIDIA's list has no "free" flag and also includes
 * embedding, safety, parsing and other non-chat models, so those are
 * filtered out by name. Our model IDs are "nvidia/<NVIDIA model id>".
 */

export const NVIDIA_MODEL_PREFIX = "nvidia/";
const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

const LIST_REVALIDATE_SECONDS = 86_400;
const LIST_TIMEOUT_MS = 8000;
const MEMORY_TTL_MS = 10 * 60 * 1000;

export const isNvidiaModel = (modelId: string) =>
  modelId.startsWith(NVIDIA_MODEL_PREFIX);

export const hasNvidiaKey = () => Boolean(process.env.NVIDIA_API_KEY);

function getNvidiaBaseUrl() {
  return (process.env.NVIDIA_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/* -------------------------------------------------------------------------- */
/*                               Model discovery                              */
/* -------------------------------------------------------------------------- */

/**
 * Models in NVIDIA's list that can't hold a chat: embeddings, rerankers,
 * safety/guard classifiers, reward models, document parsers, image-only
 * vision models, detectors, and base (non-instruct) code/text models.
 */
const NON_CHAT_PATTERNS = [
  /embed/,
  /rerank/,
  /retriever/,
  /guard/,
  /safety/,
  /reward/,
  /parse/,
  /clip/,
  /detector/,
  /deplot/,
  /kosmos/,
  /fuyu/,
  /\bneva\b|\/neva-/,
  /\/vila\b/,
  /calibration/,
  /\/cosmos-/,
  /paligemma/,
  /starcoder/,
  /codegemma/,
  /codellama/,
  /recurrentgemma/,
  /\/gemma-2b$/,
  /\/llama2-70b$/,
  /\/mixtral-8x22b-v0\.1$/,
];

function hiddenModels() {
  return new Set(
    (process.env.NVIDIA_HIDDEN_MODELS ?? "")
      .split(",")
      .map((id) => id.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isChatModelId(id: string) {
  const lower = id.toLowerCase();
  return !NON_CHAT_PATTERNS.some((pattern) => pattern.test(lower));
}

const WORDS: Record<string, string> = {
  ai: "AI",
  chatqa: "ChatQA",
  deepseek: "DeepSeek",
  glm: "GLM",
  gpt: "GPT",
  it: "IT",
  minimax: "MiniMax",
  moe: "MoE",
  nemo: "NeMo",
  oss: "OSS",
  qa: "QA",
  vl: "VL",
};

const SIZE_TOKEN = /^(\d+x)?\d+(\.\d+)?[bkm]$/i;
const ACTIVE_SIZE_TOKEN = /^a\d+(\.\d+)?b$/i;
const VERSION_TOKEN = /^[vk]\d/i;

/** "meta/llama-3.3-70b-instruct" -> "Llama 3.3 70B Instruct". */
export function prettifyModelName(id: string) {
  const name = id.split("/").at(-1) ?? id;
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map((token) => {
      const lower = token.toLowerCase();
      if (WORDS[lower]) {
        return WORDS[lower];
      }
      if (SIZE_TOKEN.test(token) || ACTIVE_SIZE_TOKEN.test(token)) {
        return token.toUpperCase().replace("X", "x");
      }
      if (VERSION_TOKEN.test(token)) {
        return token.toUpperCase();
      }
      return token.charAt(0).toUpperCase() + token.slice(1);
    })
    .join(" ");
}

type NvidiaListedModel = { id?: unknown };

let memoryCache: { at: number; models: ChatModel[] } | null = null;

async function fetchNvidiaModelList(): Promise<ChatModel[]> {
  const response = await fetch(`${getNvidiaBaseUrl()}/models`, {
    headers: { Authorization: `Bearer ${process.env.NVIDIA_API_KEY}` },
    next: { revalidate: LIST_REVALIDATE_SECONDS },
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`NVIDIA model list failed: ${response.status}`);
  }
  const json = (await response.json()) as { data?: NvidiaListedModel[] };
  const hidden = hiddenModels();
  const seen = new Set<string>();
  const models: ChatModel[] = [];
  for (const item of json.data ?? []) {
    if (typeof item.id !== "string") {
      continue;
    }
    const id = item.id.trim();
    if (
      !id ||
      seen.has(id) ||
      !isChatModelId(id) ||
      hidden.has(id.toLowerCase())
    ) {
      continue;
    }
    seen.add(id);
    models.push({
      description: `${id} · via NVIDIA`,
      id: `${NVIDIA_MODEL_PREFIX}${id}`,
      name: prettifyModelName(id),
      provider: "nvidia",
    });
  }
  return models;
}

/**
 * NVIDIA chat models, or [] when NVIDIA_API_KEY isn't set. Cached (Next.js
 * data cache for a day, plus a short in-memory cache). If NVIDIA can't be
 * reached, the last good list is kept.
 */
export async function getNvidiaModels(): Promise<ChatModel[]> {
  if (!hasNvidiaKey()) {
    return [];
  }
  if (memoryCache && Date.now() - memoryCache.at < MEMORY_TTL_MS) {
    return memoryCache.models;
  }
  try {
    const models = await fetchNvidiaModelList();
    memoryCache = { at: Date.now(), models };
    return models;
  } catch {
    return memoryCache?.models ?? [];
  }
}

/**
 * Tools are tried on every NVIDIA model (web search); models that reject
 * them are retried without tools (see createNvidiaModel). NVIDIA models are
 * used as text-only here, and have no reasoning control.
 */
export const nvidiaCapabilities: ModelCapabilities = {
  reasoning: false,
  tools: true,
  vision: false,
};

/* -------------------------------------------------------------------------- */
/*                         Language model with fallbacks                      */
/* -------------------------------------------------------------------------- */

/** Models seen rejecting tools / the system role (per server instance). */
const noToolModels = new Set<string>();
const noSystemRoleModels = new Set<string>();

const TOOLS_UNAVAILABLE_NOTE =
  "Note for this reply: web search, page reading and document tools are not available with this model. Do not say or imply that you searched the web, read a page, or created a document. Answer from your own knowledge, and say so when information may be out of date.";

function unwrapApiError(error: unknown) {
  const inner = RetryError.isInstance(error) ? error.lastError : error;
  return APICallError.isInstance(inner) ? inner : null;
}

function errorText(error: APICallError) {
  return `${error.message} ${error.responseBody ?? ""}`.toLowerCase();
}

function isClientError(error: APICallError) {
  const status = error.statusCode ?? 0;
  return status === 400 || status === 422;
}

function rejectsTools(error: APICallError) {
  return isClientError(error) && /tool|function/.test(errorText(error));
}

function rejectsSystemRole(error: APICallError) {
  return isClientError(error) && /system/.test(errorText(error));
}

function withoutTools(params: LanguageModelV4CallOptions) {
  const hasSystem = params.prompt.some((message) => message.role === "system");
  const firstUser = params.prompt.findIndex(
    (message) => message.role === "user"
  );
  const prompt: LanguageModelV4Prompt = params.prompt.map((message, index) => {
    if (message.role === "system") {
      return {
        ...message,
        content: `${message.content}\n\n${TOOLS_UNAVAILABLE_NOTE}`,
      };
    }
    // System instructions already moved into the first user message.
    if (!hasSystem && index === firstUser && message.role === "user") {
      return {
        ...message,
        content: [
          { text: `${TOOLS_UNAVAILABLE_NOTE}\n\n`, type: "text" as const },
          ...message.content,
        ],
      };
    }
    return message;
  });
  return { ...params, prompt, toolChoice: undefined, tools: undefined };
}

/** Moves system instructions into the first user message. */
function withoutSystemRole(params: LanguageModelV4CallOptions) {
  const system = params.prompt
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n");
  if (!system) {
    return params;
  }
  const rest = params.prompt.filter((message) => message.role !== "system");
  const firstUser = rest.findIndex((message) => message.role === "user");
  if (firstUser === -1) {
    return params;
  }
  const prompt = rest.map((message, index) =>
    index === firstUser && message.role === "user"
      ? {
          ...message,
          content: [
            {
              text: `Instructions:\n${system}\n\n---\n\n`,
              type: "text" as const,
            },
            ...message.content,
          ],
        }
      : message
  );
  return { ...params, prompt };
}

/**
 * The request to retry with when a model rejected tools or the system role,
 * or null when the error isn't one of those.
 */
function fallbackParams(
  nvidiaId: string,
  params: LanguageModelV4CallOptions,
  error: unknown
): LanguageModelV4CallOptions | null {
  const apiError = unwrapApiError(error);
  if (!apiError) {
    return null;
  }
  if (params.tools?.length && rejectsTools(apiError)) {
    noToolModels.add(nvidiaId);
    return withoutTools(params);
  }
  if (
    rejectsSystemRole(apiError) &&
    params.prompt.some((message) => message.role === "system")
  ) {
    noSystemRoleModels.add(nvidiaId);
    return withoutSystemRole(params);
  }
  return null;
}

let nvidiaProvider: ReturnType<typeof createOpenAICompatible> | null = null;

function getProvider() {
  nvidiaProvider ??= createOpenAICompatible({
    apiKey: process.env.NVIDIA_API_KEY,
    baseURL: getNvidiaBaseUrl(),
    name: "nvidia",
  });
  return nvidiaProvider;
}

/**
 * An NVIDIA chat model ("nvidia/<id>"). If the model rejects tools or the
 * system role, the request is retried once without them, and that model is
 * remembered so later requests skip the failing attempt.
 */
export function createNvidiaModel(modelId: string) {
  if (!hasNvidiaKey()) {
    throw new Error("Missing NVIDIA_API_KEY environment variable");
  }
  const nvidiaId = modelId.slice(NVIDIA_MODEL_PREFIX.length);

  return wrapLanguageModel({
    middleware: {
      wrapStream: ({ params, model }) => {
        let current = params;
        if (noToolModels.has(nvidiaId) && current.tools?.length) {
          current = withoutTools(current);
        }
        if (noSystemRoleModels.has(nvidiaId)) {
          current = withoutSystemRole(current);
        }

        const run = async (
          options: LanguageModelV4CallOptions,
          retriesLeft: number
        ): Promise<LanguageModelV4StreamResult> => {
          try {
            return await model.doStream(options);
          } catch (error) {
            const next =
              retriesLeft > 0 ? fallbackParams(nvidiaId, options, error) : null;
            if (!next) {
              throw error;
            }
            return run(next, retriesLeft - 1);
          }
        };

        return run(current, 2);
      },
    },
    model: getProvider()(nvidiaId),
  });
}

/** A student-friendly message for an NVIDIA request that failed. */
export function nvidiaErrorMessage(error: unknown) {
  if (error instanceof Error && error.message.includes("NVIDIA_API_KEY")) {
    return "NVIDIA models aren't set up on this server yet. Please choose another model for now.";
  }
  const apiError = unwrapApiError(error);
  const status = apiError?.statusCode;
  if (status === 429) {
    return "NVIDIA's free tier is busy right now. Please wait a minute and try again, or choose another model.";
  }
  if (status === 401 || status === 403) {
    return "This NVIDIA model isn't available with the current API key. Please choose another model.";
  }
  if (status === 404 || status === 410 || status === 400 || status === 422) {
    return "This NVIDIA model isn't available right now. Please choose another model.";
  }
  return "This NVIDIA model isn't responding right now. Please try again in a moment, or choose another model.";
}
