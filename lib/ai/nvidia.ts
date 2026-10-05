import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4Prompt,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { APICallError, RetryError, wrapLanguageModel } from "ai";
import type { ChatModel, ModelCapabilities, ReasoningConfig } from "./models";

/**
 * NVIDIA API catalog (build.nvidia.com): an OpenAI-compatible API at
 * https://integrate.api.nvidia.com/v1, authenticated with NVIDIA_API_KEY and
 * optional extra keys NVIDIA_API_KEY_1, NVIDIA_API_KEY_2, ... (server-side
 * only, never sent to the browser). Requests are spread across the keys, and
 * a key that is rate limited or not allowed to use a model is skipped.
 *
 * The chat models are discovered automatically from GET /v1/models
 * (refreshed hourly). NVIDIA's list has no "free" flag and also includes
 * embedding, safety, parsing and other non-chat models, so those are
 * filtered out by name. Our model IDs are "nvidia/<NVIDIA model id>".
 */

export const NVIDIA_MODEL_PREFIX = "nvidia/";
const DEFAULT_BASE_URL = "https://integrate.api.nvidia.com/v1";

const LIST_TIMEOUT_MS = 8000;
const MEMORY_TTL_MS = 60 * 60 * 1000;

export const isNvidiaModel = (modelId: string) =>
  modelId.startsWith(NVIDIA_MODEL_PREFIX);

/* -------------------------------------------------------------------------- */
/*                                  API keys                                  */
/* -------------------------------------------------------------------------- */

const KEY_NAME = /^NVIDIA_API_KEY(?:_?(\d+))?$/;

/**
 * Every configured key: NVIDIA_API_KEY first, then NVIDIA_API_KEY_1,
 * NVIDIA_API_KEY_2, ... in number order. Empty and duplicate values are
 * ignored.
 */
export function getNvidiaKeys(): string[] {
  const named: { order: number; value: string }[] = [];
  for (const [name, raw] of Object.entries(process.env)) {
    const match = KEY_NAME.exec(name);
    const value = raw?.trim();
    if (match && value) {
      named.push({ order: match[1] ? Number(match[1]) : -1, value });
    }
  }
  named.sort((a, b) => a.order - b.order);
  return [...new Set(named.map((key) => key.value))];
}

export const hasNvidiaKey = () => getNvidiaKeys().length > 0;

/** Skip a key after a rate limit (when NVIDIA doesn't say how long). */
const RATE_LIMIT_COOLDOWN_MS = 30_000;
/** Skip a key that was refused (bad key or no access to that model). */
const REFUSED_COOLDOWN_MS = 10 * 60_000;
const MAX_COOLDOWN_MS = 5 * 60_000;

/**
 * "key|model" (refused for one model) or "key|*" (rate limited or invalid,
 * which applies to the whole account) -> time until which it is skipped.
 */
const keyCooldowns = new Map<string, number>();
let nextKeyIndex = 0;

function cooldownFor(response: Response) {
  if (response.status !== 429) {
    return REFUSED_COOLDOWN_MS;
  }
  const retryAfter = response.headers.get("retry-after");
  const seconds = retryAfter ? Number(retryAfter) : Number.NaN;
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, MAX_COOLDOWN_MS);
  }
  const date = retryAfter ? Date.parse(retryAfter) : Number.NaN;
  if (Number.isFinite(date) && date > Date.now()) {
    return Math.min(date - Date.now(), MAX_COOLDOWN_MS);
  }
  return RATE_LIMIT_COOLDOWN_MS;
}

const ANY_MODEL = "*";

/** Rate limits and invalid keys affect every model of that account. */
const cooldownScope = (status: number, model: string) =>
  status === 429 || status === 401 ? ANY_MODEL : model;

function isCoolingDown(key: string, model: string, now: number) {
  return (
    (keyCooldowns.get(`${key}|${ANY_MODEL}`) ?? 0) > now ||
    (keyCooldowns.get(`${key}|${model}`) ?? 0) > now
  );
}

/** Statuses where another key (another account) may succeed. */
const shouldTryNextKey = (status: number) =>
  status === 429 || status === 401 || status === 403 || status === 404;

function requestedModel(body: RequestInit["body"]) {
  if (typeof body !== "string") {
    return "";
  }
  try {
    const parsed = JSON.parse(body) as { model?: unknown };
    return typeof parsed.model === "string" ? parsed.model : "";
  } catch {
    return "";
  }
}

/**
 * fetch() that adds an NVIDIA key. Keys take turns (round robin); on a rate
 * limit or refusal the same request is sent with the next key, and that key
 * is skipped for a while for that model. If every key fails, the last
 * response is returned so the usual error handling applies.
 */
function fetchWithNvidiaKeys(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const keys = getNvidiaKeys();
  if (keys.length === 0) {
    return Promise.reject(
      new Error("Missing NVIDIA_API_KEY environment variable")
    );
  }
  const model = requestedModel(init?.body);
  const start = nextKeyIndex % keys.length;
  nextKeyIndex = (start + 1) % keys.length;

  const now = Date.now();
  const rotated = keys.map((_, offset) => keys[(start + offset) % keys.length]);
  const ready = rotated.filter((key) => !isCoolingDown(key, model, now));
  const cooling = rotated.filter((key) => !ready.includes(key));
  // Keys that are cooling down are still tried last, rather than failing.
  const order = [...ready, ...cooling];

  const attempt = async (index: number): Promise<Response> => {
    const key = order[index];
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${key}`);
    const response = await fetch(input, { ...init, headers });
    const isLast = index === order.length - 1;
    if (isLast || !shouldTryNextKey(response.status)) {
      if (response.ok) {
        keyCooldowns.delete(`${key}|${model}`);
        keyCooldowns.delete(`${key}|${ANY_MODEL}`);
      }
      return response;
    }
    keyCooldowns.set(
      `${key}|${cooldownScope(response.status, model)}`,
      Date.now() + cooldownFor(response)
    );
    await response.body?.cancel().catch(() => undefined);
    return attempt(index + 1);
  };

  return attempt(0);
}

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
  const response = await fetchWithNvidiaKeys(`${getNvidiaBaseUrl()}/models`, {
    // Not stored in Next's data cache, which outlives deployments and could
    // keep an empty or failed result; the in-memory cache below is enough.
    cache: "no-store",
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
    const reasoning = nvidiaReasoningConfig(id);
    models.push({
      description: `${id} · via NVIDIA`,
      id: `${NVIDIA_MODEL_PREFIX}${id}`,
      name: prettifyModelName(id),
      provider: "nvidia",
      ...(reasoning ? { reasoning } : {}),
    });
  }
  return models;
}

/**
 * NVIDIA chat models, or [] when no NVIDIA key is set. Cached in memory
 * for an hour. If NVIDIA can't be reached, the last good list is kept and
 * the failure is logged (visible in Vercel's function logs).
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
  } catch (error) {
    console.warn(
      "NVIDIA model list unavailable:",
      error instanceof Error ? error.message : error
    );
    return memoryCache?.models ?? [];
  }
}

/* -------------------------------------------------------------------------- */
/*                                Capabilities                                */
/* -------------------------------------------------------------------------- */

/**
 * NVIDIA's model list doesn't say what each model can do, so this is
 * worked out from the model name (family and version).
 */

/** Models that accept images. */
const VISION_PATTERNS = [
  /vision/,
  /(^|[-_/])vl([-_]|$)/,
  /vlm/,
  /omni/,
  /multimodal/,
  /gemma-3-(4|12|27)b/,
  /gemma-3n/,
  /gemma-4/,
  /llama-4/,
  /kimi-k2\.[5-9]/,
  /kimi-k3/,
  /mistral-small-3\.[1-9]/,
  /mistral-medium-3/,
  /pixtral/,
];

/** Thinking can be switched on/off (chat_template_kwargs). */
const THINKING_TOGGLE_PATTERNS = [
  /nemotron-3/,
  /nemotron-nano-3/,
  /\/qwen3(?!.*instruct-2507)/,
  /\/glm-4\.[5-9]/,
  /\/glm-[5-9]/,
  /deepseek-v3\.[1-9]/,
  /deepseek-v[4-9]/,
  /gemma-4/,
  /kimi-k2\.[5-9]/,
  /kimi-k3/,
  /seed-oss/,
];

/** Thinking effort can be chosen (reasoning_effort). */
const REASONING_EFFORT_PATTERNS = [/\/gpt-oss-/];

/** Always think; there is nothing to switch. */
const ALWAYS_THINKING_PATTERNS = [
  /(^|[-/])r1([-_]|$)/,
  /qwq/,
  /thinking/,
  /magistral/,
  /reasoning/,
];

const matchesAny = (patterns: RegExp[], id: string) =>
  patterns.some((pattern) => pattern.test(id));

/** How the reasoning control works for an NVIDIA model id (no prefix). */
export function nvidiaReasoningConfig(id: string): ReasoningConfig | undefined {
  const lower = id.toLowerCase();
  if (matchesAny(REASONING_EFFORT_PATTERNS, lower)) {
    return { control: "effort", defaultLevel: "low" };
  }
  if (matchesAny(THINKING_TOGGLE_PATTERNS, lower)) {
    return { control: "toggle", defaultLevel: "high" };
  }
}

/**
 * Tools are tried on every NVIDIA model (web search); models that reject
 * them are retried without tools (see createNvidiaModel).
 */
export function nvidiaCapabilities(id: string): ModelCapabilities {
  const lower = id.toLowerCase();
  return {
    reasoning:
      Boolean(nvidiaReasoningConfig(lower)) ||
      matchesAny(ALWAYS_THINKING_PATTERNS, lower),
    tools: true,
    vision: matchesAny(VISION_PATTERNS, lower),
  };
}

/** The NVIDIA request options for a reasoning level. */
export function nvidiaReasoningOptions(
  config: ReasoningConfig | undefined,
  level: "off" | "low" | "medium" | "high"
): Record<string, Record<string, unknown>> {
  if (!config) {
    return {};
  }
  if (config.control === "effort") {
    return { nvidia: { reasoningEffort: level === "off" ? "low" : level } };
  }
  const thinking = level !== "off";
  // Different chat templates use different names for the same switch.
  return {
    nvidia: { chat_template_kwargs: { enable_thinking: thinking, thinking } },
  };
}

/* -------------------------------------------------------------------------- */
/*                         Language model with fallbacks                      */
/* -------------------------------------------------------------------------- */

/**
 * Models seen rejecting tools / the system role / the reasoning options
 * (per server instance).
 */
const noToolModels = new Set<string>();
const noSystemRoleModels = new Set<string>();
const noReasoningOptionModels = new Set<string>();

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

function hasReasoningOptions(params: LanguageModelV4CallOptions) {
  const options = params.providerOptions?.nvidia;
  return Boolean(
    options &&
      ("chat_template_kwargs" in options || "reasoningEffort" in options)
  );
}

function withoutReasoningOptions(params: LanguageModelV4CallOptions) {
  const { nvidia: _removed, ...providerOptions } = params.providerOptions ?? {};
  return { ...params, providerOptions };
}

/**
 * The request to retry with when a model rejected tools, the system role or
 * the reasoning options, or null when the error isn't one of those.
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
  if (isClientError(apiError) && hasReasoningOptions(params)) {
    noReasoningOptionModels.add(nvidiaId);
    return withoutReasoningOptions(params);
  }
  return null;
}

let nvidiaProvider: ReturnType<typeof createOpenAICompatible> | null = null;

function getProvider() {
  nvidiaProvider ??= createOpenAICompatible({
    baseURL: getNvidiaBaseUrl(),
    // Adds the API key, switching keys on rate limits (see above).
    fetch: fetchWithNvidiaKeys,
    name: "nvidia",
  });
  return nvidiaProvider;
}

/**
 * An NVIDIA chat model ("nvidia/<id>"). If the model rejects tools, the
 * system role or the reasoning options, the request is retried without them,
 * and that model is remembered so later requests skip the failing attempt.
 * Image URLs are passed through as links (NVIDIA fetches them).
 */
export function createNvidiaModel(modelId: string) {
  if (!hasNvidiaKey()) {
    throw new Error("Missing NVIDIA_API_KEY environment variable");
  }
  const nvidiaId = modelId.slice(NVIDIA_MODEL_PREFIX.length);

  return wrapLanguageModel({
    middleware: {
      overrideSupportedUrls: () => ({ "image/*": [/^https:\/\/.+/] }),
      wrapStream: ({ params, model }) => {
        let current = params;
        if (noToolModels.has(nvidiaId) && current.tools?.length) {
          current = withoutTools(current);
        }
        if (noSystemRoleModels.has(nvidiaId)) {
          current = withoutSystemRole(current);
        }
        if (noReasoningOptionModels.has(nvidiaId)) {
          current = withoutReasoningOptions(current);
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

        return run(current, 3);
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
