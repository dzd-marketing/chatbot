import "server-only";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ReasoningLevel } from "./models";

const DEFAULT_BASE_URL = "https://danuka21-opencode-web.hf.space/v1";
const DEFAULT_MODEL = "gpt-oss-20b";

export const GPT_OSS_CONTEXT_TOKENS = 8192;
export const GPT_OSS_DEFAULT_OUTPUT_TOKENS = 1024;
const MIN_OUTPUT_TOKENS = 512;
const MAX_OUTPUT_TOKENS = 1536;
const CONTEXT_SAFETY_TOKENS = 512;
const MAX_HISTORY_TURNS = 6;
const READY_POLL_INTERVAL_MS = 2000;
const READY_WAIT_MS = 30_000;
const SHORTENED_NOTE =
  "\n[… older content shortened to fit the model context …]";

export type GptOssFetchOptions = {
  apiKey: string;
  baseUrl: string;
  modelId: string;
  reasoningLevel: ReasoningLevel;
};

type JsonRecord = Record<string, unknown>;
type OpenAIMessage = JsonRecord & { role?: unknown };

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Prefer new names while keeping already-configured private-Space secrets working. */
export function getGptOssHfToken() {
  return (
    process.env.GPT_OSS_HF_TOKEN?.trim() ||
    process.env.OPENCODE_HF_TOKEN?.trim() ||
    undefined
  );
}

export function getGptOssApiKey() {
  return (
    process.env.GPT_OSS_API_KEY?.trim() ||
    process.env.BRIDGE_API_KEY?.trim() ||
    undefined
  );
}

export function hasGptOssCredentials() {
  return Boolean(getGptOssHfToken() && getGptOssApiKey());
}

/** Auto-enable when both server secrets are configured; allow an explicit opt-out. */
export function isGptOssEnabled() {
  return process.env.GPT_OSS_DISABLED !== "true" && hasGptOssCredentials();
}

/** Supports a Space URL with or without the OpenAI-compatible `/v1` suffix. */
export function getGptOssBaseUrl() {
  const configured =
    process.env.GPT_OSS_BASE_URL?.trim() ||
    process.env.OPENCODE_BASE_URL?.trim() ||
    DEFAULT_BASE_URL;
  const withoutTrailingSlash = configured.replace(/\/+$/, "");
  const withoutVersion = withoutTrailingSlash.replace(/\/v1$/i, "");
  return `${withoutVersion}/v1`;
}

export function getGptOssModelId() {
  return process.env.GPT_OSS_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * A rough, deliberately conservative token estimate. ASCII is budgeted at
 * about 3.2 characters per token; non-ASCII characters are budgeted at two
 * tokens each. The margin in fitGptOssContext covers tokenizer variance and
 * the message framing added by llama.cpp.
 */
function estimateTextTokens(text: string) {
  let ascii = 0;
  let nonAscii = 0;
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && codePoint <= 0x7f) {
      ascii += 1;
    } else {
      nonAscii += 1;
    }
  }
  return Math.ceil(ascii / 3.2 + nonAscii * 2);
}

function estimateTokens(value: unknown) {
  let serialized: string;
  try {
    serialized = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  return estimateTextTokens(serialized ?? "");
}

function sliceToTokenBudget(
  text: string,
  tokenBudget: number,
  fromEnd = false
) {
  if (tokenBudget <= 0 || text.length === 0) {
    return "";
  }
  if (estimateTextTokens(text) <= tokenBudget) {
    return text;
  }

  const characters = Array.from(text);
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = fromEnd
      ? characters.slice(characters.length - middle).join("")
      : characters.slice(0, middle).join("");
    if (estimateTextTokens(candidate) <= tokenBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }

  return fromEnd
    ? characters.slice(characters.length - low).join("")
    : characters.slice(0, low).join("");
}

/** Keep both ends so a long attachment cannot hide the student's actual question. */
function shortenText(text: string, tokenBudget: number, keepSuffix: boolean) {
  if (estimateTextTokens(text) <= tokenBudget) {
    return text;
  }
  const noteTokens = estimateTextTokens(SHORTENED_NOTE);
  const remaining = Math.max(0, tokenBudget - noteTokens);
  if (remaining === 0) {
    return sliceToTokenBudget(text, tokenBudget, keepSuffix);
  }
  if (!keepSuffix) {
    return `${sliceToTokenBudget(text, remaining)}${SHORTENED_NOTE}`;
  }

  const prefixBudget = Math.floor(remaining * 0.65);
  const suffixBudget = remaining - prefixBudget;
  const prefix = sliceToTokenBudget(text, prefixBudget);
  const suffix = sliceToTokenBudget(text, suffixBudget, true);
  return `${prefix}${SHORTENED_NOTE}${suffix}`;
}

function messageRole(message: OpenAIMessage) {
  return typeof message.role === "string" ? message.role : "";
}

function splitIntoTurns(messages: OpenAIMessage[]) {
  const turns: OpenAIMessage[][] = [];
  let turn: OpenAIMessage[] = [];
  for (const message of messages) {
    if (messageRole(message) === "user" && turn.length > 0) {
      turns.push(turn);
      turn = [];
    }
    turn.push(message);
  }
  if (turn.length > 0) {
    turns.push(turn);
  }
  return turns;
}

function totalPromptTokens(
  messages: OpenAIMessage[],
  tools: unknown,
  toolChoice: unknown
) {
  return estimateTokens({ messages, tool_choice: toolChoice, tools });
}

function withClippedContent(message: OpenAIMessage, tokensToRemove: number) {
  const { content } = message;
  if (typeof content === "string") {
    const currentTokens = estimateTextTokens(content);
    const targetTokens = Math.max(32, currentTokens - tokensToRemove);
    return {
      ...message,
      content: shortenText(
        content,
        targetTokens,
        messageRole(message) === "user"
      ),
    };
  }
  if (Array.isArray(content)) {
    const textParts = content.filter(
      (part) => isRecord(part) && typeof part.text === "string"
    );
    if (textParts.length === 0) {
      return message;
    }
    const currentTokens = estimateTokens(textParts);
    const targetTokens = Math.max(32, currentTokens - tokensToRemove);
    let remaining = targetTokens;
    const clipped = content.map((part) => {
      if (!isRecord(part) || typeof part.text !== "string") {
        return part;
      }
      const share = Math.max(32, Math.floor(remaining / textParts.length));
      const text = shortenText(
        part.text,
        share,
        messageRole(message) === "user"
      );
      remaining = Math.max(0, remaining - estimateTextTokens(text));
      return { ...part, text };
    });
    return { ...message, content: clipped };
  }
  return message;
}

function trimTurnToBudget(
  turns: OpenAIMessage[][],
  systemMessages: OpenAIMessage[],
  tools: unknown,
  toolChoice: unknown,
  maxPromptTokens: number
) {
  const selectedTurns = turns.map((turn) => [...turn]);
  const messagesFor = () => [...systemMessages, ...selectedTurns.flat()];
  const promptTokens = () =>
    totalPromptTokens(messagesFor(), tools, toolChoice);

  // First remove complete old turns. The newest student turn and its app-tool
  // calls/results remain together so the OpenAI tool-call transcript is valid.
  while (promptTokens() > maxPromptTokens && selectedTurns.length > 1) {
    selectedTurns.shift();
  }

  if (promptTokens() <= maxPromptTokens) {
    return messagesFor();
  }

  // A large page/document result or attachment can dominate the current turn.
  // Shorten its text payload without removing its tool-call/result structure.
  const currentTurnIndex = Math.max(0, selectedTurns.length - 1);
  const currentTurn = selectedTurns[currentTurnIndex] ?? [];
  const currentUserIndex = currentTurn.findLastIndex(
    (message) => messageRole(message) === "user"
  );
  const clipOrder = currentTurn
    .map((message, index) => ({ index, message }))
    .filter(
      ({ message }) =>
        typeof message.content === "string" || Array.isArray(message.content)
    )
    .sort((a, b) => {
      const rolePriority = (message: OpenAIMessage, index: number) => {
        if (messageRole(message) === "tool") {
          return 0;
        }
        if (messageRole(message) === "assistant") {
          return 1;
        }
        return index === currentUserIndex ? 3 : 2;
      };
      return (
        rolePriority(a.message, a.index) - rolePriority(b.message, b.index) ||
        a.index - b.index
      );
    });

  for (const { index } of clipOrder) {
    const current = selectedTurns[currentTurnIndex]?.[index];
    if (!current) {
      continue;
    }
    const overBudget = promptTokens() - maxPromptTokens;
    if (overBudget <= 0) {
      break;
    }
    const clipped = withClippedContent(current, overBudget + 96);
    selectedTurns[currentTurnIndex][index] = clipped;
  }

  // A very long voice/system prompt is the final thing shortened. Its start
  // and end are both retained so identity and the most recent guardrails stay.
  if (promptTokens() > maxPromptTokens && systemMessages.length > 0) {
    const overBudget = promptTokens() - maxPromptTokens;
    const [firstSystem] = systemMessages;
    if (firstSystem && typeof firstSystem.content === "string") {
      const targetTokens = Math.max(
        512,
        estimateTextTokens(firstSystem.content) - overBudget - 96
      );
      systemMessages[0] = {
        ...firstSystem,
        content: shortenText(firstSystem.content, targetTokens, true),
      };
    }
  }

  return messagesFor();
}

/** Bound the stateless conversation to the Space's reported 8192-token context. */
export function fitGptOssContext(body: JsonRecord, maxOutputTokens: number) {
  if (!Array.isArray(body.messages)) {
    return body;
  }
  const messages = body.messages.filter(isRecord) as OpenAIMessage[];
  const systemMessages = messages.filter((message) =>
    ["system", "developer"].includes(messageRole(message))
  );
  const conversation = messages.filter(
    (message) => !["system", "developer"].includes(messageRole(message))
  );
  const turns = splitIntoTurns(conversation).slice(-MAX_HISTORY_TURNS);
  const maxPromptTokens = Math.max(
    512,
    GPT_OSS_CONTEXT_TOKENS - maxOutputTokens - CONTEXT_SAFETY_TOKENS
  );
  const trimmedMessages = trimTurnToBudget(
    turns,
    systemMessages,
    body.tools,
    body.tool_choice,
    maxPromptTokens
  );
  return { ...body, messages: trimmedMessages };
}

function normalizedOutputTokens(value: unknown) {
  const parsed = typeof value === "number" ? value : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return GPT_OSS_DEFAULT_OUTPUT_TOKENS;
  }
  return Math.min(
    MAX_OUTPUT_TOKENS,
    Math.max(MIN_OUTPUT_TOKENS, Math.floor(parsed))
  );
}

/** Prepare the body for the Space and enforce both its output and context limits. */
export function prepareGptOssRequestBody(
  body: string,
  {
    modelId,
    reasoningLevel,
  }: Pick<GptOssFetchOptions, "modelId" | "reasoningLevel">
) {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) {
      return body;
    }
    const maxTokens = normalizedOutputTokens(parsed.max_tokens);
    const request: JsonRecord = {
      ...parsed,
      max_tokens: maxTokens,
      model: modelId,
      reasoning_effort: reasoningLevel === "off" ? "low" : reasoningLevel,
    };
    if (typeof request.temperature !== "number") {
      request.temperature = 0.3;
    }
    return JSON.stringify(fitGptOssContext(request, maxTokens));
  } catch {
    return body;
  }
}

function cleanHeaders(response: Response) {
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  headers.delete("content-encoding");
  return headers;
}

/** Normalize OpenAI-compatible SSE while preserving streamed reasoning deltas. */
function normalizeGptOssSse(): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const handleFrame = (
    frame: string,
    controller: TransformStreamDefaultController<Uint8Array>
  ) => {
    const lines = frame.split("\n");
    const data = lines
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5))
      .join("\n");
    if (!data || data.trim() === "[DONE]") {
      controller.enqueue(encoder.encode(`${frame}\n\n`));
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      controller.enqueue(encoder.encode(`${frame}\n\n`));
      return;
    }

    const prefix = lines.filter((line) => !line.startsWith("data:")).join("\n");
    const output = [prefix, `data: ${JSON.stringify(parsed)}`]
      .filter(Boolean)
      .join("\n");
    controller.enqueue(encoder.encode(`${output}\n\n`));
  };

  const drain = (
    controller: TransformStreamDefaultController<Uint8Array>,
    flush = false
  ) => {
    let boundary = /\r?\n\r?\n/.exec(buffer);
    while (boundary && boundary.index !== undefined) {
      const [separator = ""] = boundary;
      handleFrame(
        buffer.slice(0, boundary.index).replace(/\r/g, ""),
        controller
      );
      buffer = buffer.slice(boundary.index + separator.length);
      boundary = /\r?\n\r?\n/.exec(buffer);
    }
    if (flush && buffer.trim()) {
      handleFrame(buffer.replace(/\r/g, ""), controller);
      buffer = "";
    }
  };

  return new TransformStream({
    flush(controller) {
      buffer += decoder.decode();
      drain(controller, true);
    },
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      drain(controller);
    },
  });
}

function isModelNotReady(response: Response) {
  return response
    .clone()
    .json()
    .then((body: unknown) => {
      if (!isRecord(body)) {
        return false;
      }
      const error = isRecord(body.error) ? body.error : undefined;
      const message = typeof error?.message === "string" ? error.message : "";
      return /model not ready/i.test(message) || body.ready === false;
    })
    .catch(() => false);
}

function delay(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("Request aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error("Request aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForModelReady(
  baseUrl: string,
  headers: Headers,
  signal: AbortSignal | null | undefined,
  fetchImpl: typeof fetch
) {
  const deadline = Date.now() + READY_WAIT_MS;
  while (Date.now() < deadline && !signal?.aborted) {
    try {
      // biome-ignore lint/performance/noAwaitInLoops: health checks must poll sequentially until the model is ready.
      await delay(
        Math.min(READY_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())),
        signal ?? undefined
      );
    } catch {
      return false;
    }
    try {
      const response = await fetchImpl(`${baseUrl}/health`, {
        cache: "no-store",
        headers,
        signal: signal ?? undefined,
      });
      if (response.status === 401 || response.status === 404) {
        await response.body?.cancel().catch(() => undefined);
        return false;
      }
      if (response.ok) {
        const health: unknown = await response.json().catch(() => null);
        if (isRecord(health) && health.ready === true) {
          return true;
        }
        if (isRecord(health) && health.ready !== false) {
          return false;
        }
      }
      await response.body?.cancel().catch(() => undefined);
    } catch {
      if (signal?.aborted) {
        return false;
      }
    }
  }
  return false;
}

async function sanitizedErrorResponse(response: Response) {
  const headers = new Headers();
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    headers.set("retry-after", retryAfter);
  }
  await response.body?.cancel().catch(() => undefined);
  return Response.json(
    { error: { message: "GPT-OSS Space request failed" } },
    { headers, status: response.status }
  );
}

async function preservedReasoningJsonResponse(response: Response) {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  if (!isRecord(body)) {
    return response;
  }
  const headers = cleanHeaders(response);
  await response.body?.cancel().catch(() => undefined);
  return new Response(JSON.stringify(body), {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

/**
 * Authenticates server-to-server, fixes the model-specific request fields,
 * waits out the Space's initial model load, and preserves reasoning for the
 * chat's existing streamed reasoning UI.
 */
export function createGptOssFetch(
  options: GptOssFetchOptions,
  fetchImpl: typeof fetch = fetch
): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("X-API-Key", options.apiKey);
    headers.delete("content-length");

    const body =
      typeof init?.body === "string"
        ? prepareGptOssRequestBody(init.body, options)
        : init?.body;
    const requestInit = { ...init, body, headers };
    let response = await fetchImpl(input, requestInit);

    if (response.status === 503 && (await isModelNotReady(response))) {
      const ready = await waitForModelReady(
        options.baseUrl,
        headers,
        init?.signal,
        fetchImpl
      );
      if (ready) {
        await response.body?.cancel().catch(() => undefined);
        response = await fetchImpl(input, requestInit);
      }
    }

    if (!response.ok) {
      return sanitizedErrorResponse(response);
    }

    const contentType = response.headers.get("content-type") ?? "";
    if (contentType.includes("text/event-stream") && response.body) {
      const responseHeaders = cleanHeaders(response);
      return new Response(response.body.pipeThrough(normalizeGptOssSse()), {
        headers: responseHeaders,
        status: response.status,
        statusText: response.statusText,
      });
    }
    if (contentType.includes("application/json")) {
      return preservedReasoningJsonResponse(response);
    }
    return response;
  };
}

/** A stateless GPT-OSS model hosted in the existing private Hugging Face Space. */
export function createGptOssModel(
  reasoningLevel: ReasoningLevel = "low"
): LanguageModelV4 {
  const hfToken = getGptOssHfToken();
  const apiKey = getGptOssApiKey();
  if (!hfToken) {
    throw new Error("Missing GPT_OSS_HF_TOKEN environment variable");
  }
  if (!apiKey) {
    throw new Error("Missing GPT_OSS_API_KEY environment variable");
  }

  const baseUrl = getGptOssBaseUrl();
  const modelId = getGptOssModelId();
  const provider = createOpenAICompatible({
    apiKey: hfToken,
    baseURL: baseUrl,
    fetch: createGptOssFetch({ apiKey, baseUrl, modelId, reasoningLevel }),
    headers: { "X-API-Key": apiKey },
    name: "gpt-oss",
  });
  return provider.chatModel(modelId);
}
