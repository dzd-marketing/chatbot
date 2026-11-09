import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4GenerateResult,
  LanguageModelV4Prompt,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
  SharedV4ProviderOptions,
} from "@ai-sdk/provider";
import { APICallError, RetryError } from "ai";
import { createGptOssModel, isGptOssEnabled } from "./gpt-oss";
import type { ReasoningConfig, ReasoningLevel } from "./models";
import {
  createNvidiaModel,
  getNvidiaModels,
  hasNvidiaKey,
  NVIDIA_MODEL_PREFIX,
  nvidiaCapabilities,
  nvidiaReasoningConfig,
  nvidiaReasoningOptions,
} from "./nvidia";
import { createZaiModel, hasZaiKey, ZAI_GLM_FLASH } from "./zai";

/**
 * TheStudent AI automatically routes a reply on the server:
 *
 *   1. NVIDIA candidates (Nemotron, NVIDIA-hosted GPT-OSS, then other
 *      available chat models, best first)
 *   2. The private GPT-OSS tutor Space
 *   3. Z.AI GLM-4.7-Flash
 *
 * TheStudent AI always uses this automatic route. Provider/model IDs stay
 * server-side. A model counts as busy when it is rate limited, errors, refuses
 * the request, or doesn't start answering in time. Nothing has been sent to
 * the student at that point, so the next model takes over invisibly. The first
 * output commits the reply to a model; later tool steps stay with that model.
 *
 * If every model is busy, the whole list is tried again up to 3 more times,
 * after short waits (about 1.5 s, 4 s and 8 s). Models that just failed are
 * remembered for a short while (per server instance) so the next requests go
 * straight to one that works.
 */

/* -------------------------------------------------------------------------- */
/*                                 Model list                                 */
/* -------------------------------------------------------------------------- */

/** NVIDIA model ids (without our "nvidia/" prefix). */
export const PRIMARY_NVIDIA_MODEL = "nvidia/nemotron-3-ultra-550b-a55b";
export const SECONDARY_NVIDIA_MODEL = "openai/gpt-oss-20b";

/** How many "other" NVIDIA models one round may try (keeps waits short). */
const EXTRA_NVIDIA_PER_ROUND = 4;

/** Retry rounds after the first, when every model was busy. */
export const RETRY_DELAYS_MS = [1500, 4000, 8000] as const;
const MAX_RETRY_AFTER_MS = 10_000;

/** Time to the first output before a model counts as busy. */
const FIRST_OUTPUT_MS = {
  primary: 30_000,
  standard: 20_000,
} as const;
/** Voice conversations: someone is waiting on the line, move on sooner. */
const VOICE_FIRST_OUTPUT_MS = {
  primary: 12_000,
  standard: 10_000,
} as const;

/** Don't start another model with less time than this left. */
const MIN_ATTEMPT_MS = 8000;

/** Always-thinking models need room for the thinking plus the answer. */
const MIN_TOKENS_FOR_THINKING_MODELS = 1024;

export type RouteCandidate = {
  /** Internal id, for logs only (never sent to the browser). */
  id: string;
  kind: "nvidia" | "gpt-oss" | "zai";
  tier: "primary" | "secondary" | "extra" | "gpt-oss" | "zai";
  vision: boolean;
  reasoning?: ReasoningConfig;
  /** Cold private Spaces can take longer to start answering. */
  firstOutputMs?: number;
  create: () => LanguageModelV4;
};

const IMAGE_NOTE =
  "[The student attached an image here, but images can't be viewed for this reply. Say so briefly and ask them to type out the question or describe the image.]";

/** Preferred NVIDIA families for step 3, strongest general chat first. */
const PREFERRED_FAMILIES = [
  /deepseek-v3\.[1-9]|deepseek-v[4-9]/,
  /kimi-k2/,
  /qwen3-(235b|next|coder-480b)/,
  /gpt-oss-120b/,
  /nemotron-3-super|nemotron-super/,
  /llama-4-maverick/,
  /\/glm-4\.[5-9]|\/glm-[5-9]/,
  /minimax-m/,
  /mistral-(large|medium)/,
  /llama-3\.3-70b|llama-3\.1-405b/,
  /qwen3/,
  /llama-4-scout/,
  /mistral-small/,
  /gemma-3-27b|gemma-4/,
  /llama-3\.1-70b/,
];

const SIZE = /(?:^|[-_/])(\d+(?:\.\d+)?)b(?:[-_]|$)/i;

/** Parameter count in billions from the id, if it says. */
function modelSize(id: string) {
  const match = SIZE.exec(id);
  return match ? Number(match[1]) : undefined;
}

/** Ranks NVIDIA ids for step 3: preferred families, then bigger first. */
export function rankExtraModels(ids: string[]) {
  const score = (id: string) => {
    const lower = id.toLowerCase();
    const family = PREFERRED_FAMILIES.findIndex((pattern) =>
      pattern.test(lower)
    );
    const size = modelSize(lower);
    // Very small models answer poorly: only after everything else.
    const small = size !== undefined && size < 8 ? 1 : 0;
    return {
      family: family === -1 ? PREFERRED_FAMILIES.length : family,
      size: size ?? 0,
      small,
    };
  };
  return [...ids].sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    return (
      sa.small - sb.small ||
      sa.family - sb.family ||
      sb.size - sa.size ||
      a.localeCompare(b)
    );
  });
}

function nvidiaCandidate(
  nvidiaId: string,
  tier: RouteCandidate["tier"]
): RouteCandidate {
  return {
    create: () => createNvidiaModel(`${NVIDIA_MODEL_PREFIX}${nvidiaId}`),
    id: `nvidia:${nvidiaId}`,
    kind: "nvidia",
    reasoning: nvidiaReasoningConfig(nvidiaId),
    tier,
    vision: nvidiaCapabilities(nvidiaId).vision,
  };
}

async function nvidiaCatalog() {
  try {
    const models = await getNvidiaModels();
    return models.map((model) => model.id.slice(NVIDIA_MODEL_PREFIX.length));
  } catch {
    return [];
  }
}

export type RoutePurpose = "chat" | "fast" | "voice";

/**
 * The models to try, in order. `fast` is for short helper calls (chat
 * titles, follow-up suggestions): the quick model first and no Space fallback.
 * `voice` (voice conversations) also puts the quick model first, but keeps
 * every fallback.
 * With images, models that can see them go first; the others get a note
 * instead of the image.
 */
export async function buildRoutePlan({
  purpose,
  needsVision,
  reasoningLevel,
}: {
  purpose: RoutePurpose;
  needsVision: boolean;
  reasoningLevel?: ReasoningLevel;
}): Promise<RouteCandidate[]> {
  const plan: RouteCandidate[] = [];

  if (hasNvidiaKey()) {
    const catalog = await nvidiaCatalog();
    // The list only holds models the keys can use. If it couldn't be
    // loaded, the two named models are still tried.
    const listed = (id: string) => catalog.length === 0 || catalog.includes(id);
    const named = (
      purpose === "fast" || purpose === "voice"
        ? [SECONDARY_NVIDIA_MODEL, PRIMARY_NVIDIA_MODEL]
        : [PRIMARY_NVIDIA_MODEL, SECONDARY_NVIDIA_MODEL]
    ).filter(listed);
    const extras = rankExtraModels(catalog.filter((id) => !named.includes(id)));

    const namedCandidates = named.map((id) =>
      nvidiaCandidate(id, id === PRIMARY_NVIDIA_MODEL ? "primary" : "secondary")
    );
    const extraCandidates = extras.map((id) => nvidiaCandidate(id, "extra"));

    if (needsVision) {
      plan.push(
        ...extraCandidates.filter((candidate) => candidate.vision),
        ...namedCandidates,
        ...extraCandidates.filter((candidate) => !candidate.vision)
      );
    } else {
      plan.push(...namedCandidates, ...extraCandidates);
    }
  }

  // The GPT-OSS Space is the first fallback after NVIDIA. It is intentionally
  // skipped for short helper calls so cold starts don't delay titles.
  if (purpose !== "fast" && isGptOssEnabled()) {
    const level = reasoningLevel ?? "low";
    plan.push({
      create: () => createGptOssModel(level),
      // The private Space can take about 22 seconds to cold-start.
      firstOutputMs: purpose === "voice" ? 35_000 : 75_000,
      id: "gpt-oss:hf-space",
      kind: "gpt-oss",
      reasoning: { control: "effort", defaultLevel: "low" },
      tier: "gpt-oss",
      vision: false,
    });
  }

  if (hasZaiKey()) {
    plan.push({
      create: () => createZaiModel(ZAI_GLM_FLASH),
      id: `zai:${ZAI_GLM_FLASH}`,
      kind: "zai",
      reasoning: { control: "toggle", defaultLevel: "high" },
      tier: "zai",
      vision: false,
    });
  }

  return plan;
}

/* -------------------------------------------------------------------------- */
/*                           Busy models (per server)                         */
/* -------------------------------------------------------------------------- */

/** Candidate id -> time until which other requests skip it. */
const busyUntil = new Map<string, number>();

const BUSY_MS = {
  /** Rate limit without Retry-After, or a server error. */
  busy: 20_000,
  /** Wrong key or model gone: no point retrying soon. */
  refused: 10 * 60_000,
  /** Didn't start answering in time. */
  slow: 45_000,
} as const;

export function isBusy(id: string, now = Date.now()) {
  return (busyUntil.get(id) ?? 0) > now;
}

/** For tests. */
export function resetRouterState() {
  busyUntil.clear();
}

/* -------------------------------------------------------------------------- */
/*                                   Errors                                   */
/* -------------------------------------------------------------------------- */

/** A model produced nothing in time. */
export class FirstOutputTimeoutError extends Error {
  constructor(ms: number) {
    super(`No output within ${Math.round(ms / 1000)}s`);
    this.name = "FirstOutputTimeoutError";
  }
}

class EmptyResponseError extends Error {
  readonly finishReason?: string;
  constructor(finishReason?: string) {
    super("The model returned an empty response");
    this.finishReason = finishReason;
    this.name = "EmptyResponseError";
  }
}

/** Every model was busy, including the retries. */
export class AllModelsBusyError extends Error {
  readonly lastError: unknown;
  readonly attempts: number;
  constructor(lastError: unknown, attempts: number) {
    super(`All models were busy after ${attempts} attempts`, {
      cause: lastError,
    });
    this.name = "AllModelsBusyError";
    this.lastError = lastError;
    this.attempts = attempts;
  }
}

type Failure = {
  /** busy: try again later; refused: not for a while; unsuitable: not this request. */
  kind: "busy" | "refused" | "unsuitable" | "config";
  retryAfterMs?: number;
  label: string;
};

function apiErrorOf(error: unknown) {
  const inner = RetryError.isInstance(error) ? error.lastError : error;
  return APICallError.isInstance(inner) ? inner : null;
}

function retryAfterMs(error: APICallError) {
  const header =
    error.responseHeaders?.["retry-after"] ??
    error.responseHeaders?.["Retry-After"];
  if (!header) {
    return;
  }
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(header);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function classifyFailure(error: unknown): Failure {
  if (
    error instanceof Error &&
    /Missing \w+ environment variable/.test(error.message)
  ) {
    return { kind: "config", label: "not configured" };
  }
  if (error instanceof FirstOutputTimeoutError) {
    return { kind: "busy", label: "too slow to start" };
  }
  const apiError = apiErrorOf(error);
  const status = apiError?.statusCode;
  if (apiError && status !== undefined) {
    if (status === 429) {
      return {
        kind: "busy",
        label: "rate limited (429)",
        retryAfterMs: retryAfterMs(apiError),
      };
    }
    if (status === 401 || status === 403 || status === 404 || status === 410) {
      return { kind: "refused", label: `refused (${status})` };
    }
    if (status === 400 || status === 413 || status === 422) {
      // Usually this request (too long, or a part the model can't take).
      return { kind: "unsuitable", label: `rejected the request (${status})` };
    }
    return { kind: "busy", label: `server error (${status})` };
  }
  if (error instanceof EmptyResponseError) {
    return { kind: "busy", label: "empty response" };
  }
  const name = error instanceof Error ? error.name : "Error";
  return { kind: "busy", label: `failed (${name})` };
}

function remember(candidate: RouteCandidate, failure: Failure) {
  let ms: number;
  if (failure.kind === "refused" || failure.kind === "config") {
    ms = BUSY_MS.refused;
  } else if (failure.kind === "unsuitable") {
    return;
  } else if (failure.label === "too slow to start") {
    ms = BUSY_MS.slow;
  } else {
    ms = Math.min(failure.retryAfterMs ?? BUSY_MS.busy, 5 * 60_000);
  }
  busyUntil.set(candidate.id, Date.now() + ms);
}

/* -------------------------------------------------------------------------- */
/*                         Adapting a request per model                       */
/* -------------------------------------------------------------------------- */

function isImagePart(part: { type: string; mediaType?: string }) {
  // "image" alone when the exact format isn't known.
  const type = part.mediaType ?? "";
  return (
    part.type === "file" && (type === "image" || type.startsWith("image/"))
  );
}

export function promptHasImages(prompt: LanguageModelV4Prompt) {
  return prompt.some(
    (message) =>
      message.role === "user" &&
      message.content.some((part) => isImagePart(part))
  );
}

/** Replaces images with a short note, for models that can't see. */
function withoutImages(prompt: LanguageModelV4Prompt): LanguageModelV4Prompt {
  return prompt.map((message) => {
    if (message.role !== "user" || !message.content.some(isImagePart)) {
      return message;
    }
    const content = message.content.filter((part) => !isImagePart(part));
    return {
      ...message,
      content: [{ text: IMAGE_NOTE, type: "text" as const }, ...content],
    };
  });
}

/** The level a model gets: "Thinking" is medium effort on effort models. */
function levelFor(config: ReasoningConfig, level: ReasoningLevel) {
  if (config.control === "effort") {
    if (level === "off") {
      return "low";
    }
    return level === "high" ? "medium" : level;
  }
  return level === "off" ? "off" : "high";
}

function reasoningOptionsFor(
  candidate: RouteCandidate,
  level: ReasoningLevel
): SharedV4ProviderOptions {
  const config = candidate.reasoning;
  if (!config) {
    return {};
  }
  const modelLevel = levelFor(config, level);
  if (candidate.kind === "nvidia") {
    return nvidiaReasoningOptions(
      config,
      modelLevel
    ) as SharedV4ProviderOptions;
  }
  if (candidate.kind === "zai") {
    return {
      zai: {
        thinking: { type: modelLevel === "off" ? "disabled" : "enabled" },
      },
    };
  }
  return {};
}

const APP_TOOL_NAMES = new Set([
  "calculate",
  "createDocument",
  "createFlashcards",
  "createQuiz",
  "editDocument",
  "getWeather",
  "readDocument",
  "requestSuggestions",
  "shareFiles",
  "updateDocument",
  "webFetch",
  "webSearch",
]);

/**
 * The GPT-OSS Space is stateless and has no tool executor. Send the normal
 * bounded conversation, and keep only TheStudent's app-executed tool calls
 * and results. Reasoning and provider-native tools are never sent back.
 */
function forGptOss(
  options: LanguageModelV4CallOptions,
  retryAfterLength = false
): LanguageModelV4CallOptions {
  const validToolCallIds = new Set<string>();
  for (const message of options.prompt) {
    if (message.role !== "assistant") {
      continue;
    }
    for (const part of message.content) {
      if (
        part.type === "tool-call" &&
        !part.providerExecuted &&
        APP_TOOL_NAMES.has(part.toolName)
      ) {
        validToolCallIds.add(part.toolCallId);
      }
    }
  }

  const prompt: LanguageModelV4Prompt = [];
  for (const message of options.prompt) {
    if (message.role === "system") {
      prompt.push(message);
    } else if (message.role === "user") {
      const content = message.content.filter((part) => part.type === "text");
      if (content.length > 0) {
        prompt.push({ ...message, content });
      }
    } else if (message.role === "assistant") {
      const content = message.content.filter(
        (part) =>
          (part.type === "text" && part.text.trim()) ||
          (part.type === "tool-call" &&
            !part.providerExecuted &&
            APP_TOOL_NAMES.has(part.toolName))
      );
      if (content.length > 0) {
        prompt.push({ ...message, content });
      }
    } else if (message.role === "tool") {
      const content = message.content.filter(
        (part) =>
          part.type === "tool-result" &&
          validToolCallIds.has(part.toolCallId) &&
          APP_TOOL_NAMES.has(part.toolName)
      );
      if (content.length > 0) {
        prompt.push({ ...message, content });
      }
    }
  }

  const systemMessages = prompt.filter((message) => message.role === "system");
  const turns = prompt.filter((message) => message.role !== "system");
  const latestUserIndex = turns.findLastIndex(
    (message) => message.role === "user"
  );
  const recent =
    retryAfterLength && latestUserIndex >= 0
      ? turns.slice(latestUserIndex)
      : retryAfterLength
        ? turns.slice(-6)
        : turns;
  const maxOutputTokens = retryAfterLength
    ? 1536
    : Math.max(512, options.maxOutputTokens ?? 1024);

  return {
    ...options,
    maxOutputTokens,
    prompt: [...systemMessages, ...recent],
    providerOptions: {},
    tools: options.tools?.filter(
      (tool) => tool.type === "function" && APP_TOOL_NAMES.has(tool.name)
    ),
  };
}

/* -------------------------------------------------------------------------- */
/*                                 The router                                 */
/* -------------------------------------------------------------------------- */

export type RouterEvent =
  | { type: "fallback"; failed: number }
  | { type: "retry-wait"; round: number; delayMs: number };

export type RouterOptions = {
  purpose: RoutePurpose;
  /** The student's reasoning choice ("off" = Fast). */
  reasoningLevel?: ReasoningLevel;
  /** Time (ms since epoch) by which a reply must have started. */
  deadline?: number;
  /** Status for the waiting indicator (never names a model). */
  onEvent?: (event: RouterEvent) => void;
  /** Replaces the real model list (tests). */
  plan?: (needsVision: boolean) => Promise<RouteCandidate[]>;
  /** Replaces the waits (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Replaces the first-output time limits (tests). */
  firstOutputMs?: { primary: number; standard: number };
};

function defaultSleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Stream parts that mean the model really started answering. */
function isOutput(part: LanguageModelV4StreamPart) {
  switch (part.type) {
    case "text-delta":
    case "reasoning-delta":
      return part.delta.length > 0;
    case "tool-input-start":
    case "tool-call":
    case "tool-result":
    case "file":
    case "source":
      return true;
    default:
      return false;
  }
}

function hasGeneratedContent(result: LanguageModelV4GenerateResult) {
  return result.content.some(
    (part) =>
      (part.type === "text" && part.text.trim().length > 0) ||
      part.type === "tool-call"
  );
}

function jitter(ms: number) {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}

/**
 * A one-line summary of an error for the server logs: no request bodies, so
 * students' messages never end up in the logs.
 */
export function describeError(error: unknown): string {
  if (error instanceof AllModelsBusyError) {
    return `${error.message}; last: ${describeError(error.lastError)}`;
  }
  const apiError = apiErrorOf(error);
  if (apiError) {
    const body = (apiError.responseBody ?? "")
      .replace(/\s+/g, " ")
      .slice(0, 200);
    return `HTTP ${apiError.statusCode ?? "?"} ${apiError.message.slice(0, 120)} ${body}`.trim();
  }
  if (error instanceof Error) {
    return `${error.name}: ${error.message.slice(0, 200)}`;
  }
  return String(error).slice(0, 200);
}

function logFailure(
  candidate: RouteCandidate,
  failure: Failure,
  error: unknown
) {
  if (failure.kind === "config") {
    return;
  }
  console.warn(
    `[thestudent-router] ${candidate.id} ${failure.label}; trying the next model. ${describeError(error)}`
  );
}

/**
 * A language model that serves "TheStudent AI" by routing each call through
 * the model list above.
 */
export function createRoutedModel(options: RouterOptions): LanguageModelV4 {
  const level = options.reasoningLevel ?? "off";
  const sleep = options.sleep ?? defaultSleep;
  let planPromise: Promise<RouteCandidate[]> | null = null;
  /** The model that answered the previous step of this reply. */
  let sticky: string | null = null;

  const getPlan = (needsVision: boolean) => {
    planPromise ??= options.plan
      ? options.plan(needsVision)
      : buildRoutePlan({
          needsVision,
          purpose: options.purpose,
          reasoningLevel: level,
        });
    return planPromise;
  };

  const deadline = () =>
    options.deadline ??
    Date.now() + (options.purpose === "fast" ? 45_000 : 240_000);

  const adapt = (
    candidate: RouteCandidate,
    call: LanguageModelV4CallOptions,
    signal: AbortSignal,
    retryAfterEmptyLength = false
  ): LanguageModelV4CallOptions => {
    const { nvidia: _n, zai: _z, ...otherOptions } = call.providerOptions ?? {};
    let params: LanguageModelV4CallOptions = {
      ...call,
      abortSignal: signal,
      prompt:
        !candidate.vision && promptHasImages(call.prompt)
          ? withoutImages(call.prompt)
          : call.prompt,
      providerOptions: {
        ...otherOptions,
        ...reasoningOptionsFor(candidate, level),
      },
    };
    if (candidate.kind === "gpt-oss") {
      params = forGptOss(params, retryAfterEmptyLength);
    }
    if (
      candidate.reasoning?.control === "effort" &&
      params.maxOutputTokens !== undefined &&
      params.maxOutputTokens < MIN_TOKENS_FOR_THINKING_MODELS
    ) {
      params = { ...params, maxOutputTokens: MIN_TOKENS_FOR_THINKING_MODELS };
    }
    return params;
  };

  /** Candidates for one round, in order. */
  const roundOrder = (
    plan: RouteCandidate[],
    excluded: Set<string>,
    round: number
  ) => {
    const now = Date.now();
    const usable = plan.filter((candidate) => !excluded.has(candidate.id));
    const order: RouteCandidate[] = [];
    let extras = 0;
    for (const candidate of usable) {
      if (candidate.tier === "extra") {
        if (extras >= EXTRA_NVIDIA_PER_ROUND || isBusy(candidate.id, now)) {
          continue;
        }
        extras += 1;
        order.push(candidate);
        continue;
      }
      // Busy providers are skipped in the first round and reconsidered on retry.
      if (round === 0 && isBusy(candidate.id, now)) {
        continue;
      }
      order.push(candidate);
    }
    if (round === 0 && sticky) {
      const index = order.findIndex((candidate) => candidate.id === sticky);
      const stickyCandidate =
        index === -1
          ? usable.find((candidate) => candidate.id === sticky)
          : order.splice(index, 1)[0];
      if (stickyCandidate) {
        order.unshift(stickyCandidate);
      }
    }
    return order;
  };

  /**
   * Tries the plan round by round. `attempt` runs one model and returns
   * once it has committed to answering.
   */
  async function route<T>(
    call: LanguageModelV4CallOptions,
    attempt: (
      candidate: RouteCandidate,
      params: (signal: AbortSignal) => LanguageModelV4CallOptions,
      timeoutMs: number
    ) => Promise<T>
  ): Promise<T> {
    const plan = await getPlan(promptHasImages(call.prompt));
    const until = deadline();
    const excluded = new Set<string>();
    const gptOssLengthRetried = new Set<string>();
    let lastError: unknown = new Error("No model is configured");
    let attempts = 0;
    let retryAfter = 0;

    for (let round = 0; round <= RETRY_DELAYS_MS.length; round += 1) {
      if (round > 0) {
        const delayMs = Math.min(
          Math.max(jitter(RETRY_DELAYS_MS[round - 1]), retryAfter),
          MAX_RETRY_AFTER_MS
        );
        if (until - Date.now() < delayMs + MIN_ATTEMPT_MS) {
          break;
        }
        options.onEvent?.({ delayMs, round, type: "retry-wait" });
        // biome-ignore lint/performance/noAwaitInLoops: retry rounds wait in turn
        await sleep(delayMs, call.abortSignal);
        retryAfter = 0;
      }

      const order = roundOrder(plan, excluded, round);
      if (order.length === 0) {
        break;
      }
      for (const candidate of order) {
        const left = until - Date.now();
        // The first try of a reply always gets a chance.
        if (attempts > 0 && left < MIN_ATTEMPT_MS) {
          break;
        }
        const defaultFirstOutputMs = (options.firstOutputMs ??
          (options.purpose === "voice"
            ? VOICE_FIRST_OUTPUT_MS
            : FIRST_OUTPUT_MS))[
          candidate.tier === "primary" ? "primary" : "standard"
        ];
        const firstOutputMs =
          !options.firstOutputMs && candidate.firstOutputMs
            ? candidate.firstOutputMs
            : defaultFirstOutputMs;
        const timeoutMs = options.firstOutputMs
          ? firstOutputMs
          : Math.max(Math.min(firstOutputMs, left), MIN_ATTEMPT_MS);
        attempts += 1;
        try {
          // biome-ignore lint/performance/noAwaitInLoops: models are tried one at a time, in order
          const result = await attempt(
            candidate,
            (signal) =>
              adapt(
                candidate,
                call,
                signal,
                gptOssLengthRetried.has(candidate.id)
              ),
            timeoutMs
          );
          busyUntil.delete(candidate.id);
          if (attempts > 1 || candidate.tier !== "primary") {
            console.info(
              `[thestudent-router] answered by ${candidate.id} (attempt ${attempts})`
            );
          }
          sticky = candidate.id;
          return result;
        } catch (error) {
          if (call.abortSignal?.aborted) {
            throw error;
          }
          const failure = classifyFailure(error);
          remember(candidate, failure);
          logFailure(candidate, failure, error);
          const emptyLength =
            candidate.kind === "gpt-oss" &&
            error instanceof EmptyResponseError &&
            error.finishReason === "length";
          if (emptyLength && !gptOssLengthRetried.has(candidate.id)) {
            // GPT-OSS may spend its first output budget on private reasoning.
            // Retry once with fewer old messages and a larger answer budget.
            gptOssLengthRetried.add(candidate.id);
          } else if (
            failure.kind !== "busy" ||
            (emptyLength && gptOssLengthRetried.has(candidate.id))
          ) {
            excluded.add(candidate.id);
          }
          if (failure.retryAfterMs) {
            retryAfter = Math.max(retryAfter, failure.retryAfterMs);
          }
          if (failure.kind !== "config") {
            lastError = error;
          }
          if (sticky === candidate.id) {
            sticky = null;
          }
          options.onEvent?.({ failed: attempts, type: "fallback" });
        }
      }
    }

    console.error(
      `[thestudent-router] no model could answer after ${attempts} attempts; last: ${describeError(lastError)}`
    );
    throw new AllModelsBusyError(lastError, attempts);
  }

  /** Runs `work` with an abort signal that fires after `timeoutMs`. */
  async function withTimeout<T>(
    call: LanguageModelV4CallOptions,
    timeoutMs: number,
    work: (signal: AbortSignal, commit: () => void) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = new FirstOutputTimeoutError(timeoutMs);
    const timer = setTimeout(() => controller.abort(timeout), timeoutMs);
    const signal = call.abortSignal
      ? AbortSignal.any([call.abortSignal, controller.signal])
      : controller.signal;
    try {
      return await work(signal, () => clearTimeout(timer));
    } catch (error) {
      if (controller.signal.aborted && !call.abortSignal?.aborted) {
        throw timeout;
      }
      controller.abort();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    doGenerate: (call) =>
      route(call, (candidate, params, timeoutMs) =>
        withTimeout(call, timeoutMs * 2, async (signal) => {
          const result = await candidate.create().doGenerate(params(signal));
          if (!hasGeneratedContent(result)) {
            throw new EmptyResponseError(result.finishReason.unified);
          }
          return result;
        })
      ),

    doStream: (call) =>
      route(call, (candidate, params, timeoutMs) =>
        withTimeout(
          call,
          timeoutMs,
          async (signal, commit): Promise<LanguageModelV4StreamResult> => {
            const result = await candidate.create().doStream(params(signal));
            const reader = result.stream.getReader();
            const buffered: LanguageModelV4StreamPart[] = [];
            try {
              // Hold everything back until the model really answers.
              while (true) {
                // biome-ignore lint/performance/noAwaitInLoops: stream parts arrive in order
                const { done, value } = await reader.read();
                if (done) {
                  throw new EmptyResponseError();
                }
                if (value.type === "error") {
                  throw value.error;
                }
                if (value.type === "finish") {
                  throw new EmptyResponseError(value.finishReason.unified);
                }
                buffered.push(value);
                if (isOutput(value)) {
                  break;
                }
              }
            } catch (error) {
              reader.cancel().catch(() => undefined);
              throw error;
            }
            commit();
            return {
              ...result,
              stream: new ReadableStream<LanguageModelV4StreamPart>({
                cancel: (reason) => reader.cancel(reason),
                async pull(controller) {
                  try {
                    const { done, value } = await reader.read();
                    if (done) {
                      controller.close();
                    } else {
                      controller.enqueue(value);
                    }
                  } catch (error) {
                    controller.error(error);
                  }
                },
                start(controller) {
                  for (const part of buffered) {
                    controller.enqueue(part);
                  }
                },
              }),
            };
          }
        )
      ),

    modelId: "thestudent-ai",
    provider: "thestudent-ai",
    specificationVersion: "v4",
    // Image links are passed on as links (the vision models fetch them).
    supportedUrls: { "image/*": [/^https:\/\/.+/] },
  };
}

/** A short, student-friendly message when no model could answer. */
export function routerErrorMessage(error: unknown) {
  if (error instanceof AllModelsBusyError) {
    return "TheStudent AI is very busy right now. Please wait a minute and send your message again.";
  }
  return "TheStudent AI couldn't finish this reply. Please send your message again.";
}
