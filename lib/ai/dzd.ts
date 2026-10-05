import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * DZD Learn AI: DZD's own model (gpt-oss-20b) served by a private Hugging
 * Face Space with an OpenAI-compatible Chat Completions API.
 *
 * - Called only from the server (the authenticated /api/chat route). The
 *   Hugging Face READ token is sent as "Authorization: Bearer ..." and never
 *   reaches the browser.
 * - The Space runs its own Web_Search / Web_Fetch tools on the server, so a
 *   request never includes a `tools` array. While it works it streams
 *   progress chunks marked `dzd_progress: true`, and may add `dzd_tool_steps`
 *   and `dzd_timing` telemetry. Those are not part of the answer: the stream
 *   filter below turns them into callbacks and removes them from what the AI
 *   SDK sees.
 */

export const DZD_MODEL_PREFIX = "dzd/";

const DEFAULT_SPACE_URL = "https://danuka21-dzd-learn-ai.hf.space";
const DEFAULT_MODEL = "dzd-learn-gpt-oss-20b";

/** The Space clamps max_tokens to this per generation round. */
export const DZD_MAX_TOKENS_CAP = 1200;
const DEFAULT_MAX_TOKENS = 700;

/**
 * Upstream time limit. The CPU-hosted model can take minutes, especially
 * when it searches the web; this stays below the route's maxDuration (300s)
 * so the student gets a clear message instead of a killed function.
 */
export const DZD_TIMEOUT_MS = 270_000;

/** Only the most recent turns are sent, to keep CPU prompt processing fast. */
export const DZD_HISTORY_MESSAGES = 12;

const MAX_PROGRESS_CHARS = 160;
const MAX_TOOL_STEPS = 20;
const MAX_TOOL_NAME_CHARS = 40;

/**
 * Thrown when the Space takes longer than DZD_TIMEOUT_MS. A plain Error (not
 * an AbortError/TimeoutError), so the AI SDK reports it like any other
 * failure and the route can show a friendly message.
 */
export class DzdTimeoutError extends Error {
  constructor() {
    super("DZD Learn AI did not finish in time");
    this.name = "DzdTimeoutError";
  }
}

export const isDzdModel = (modelId: string) =>
  modelId.startsWith(DZD_MODEL_PREFIX);

/** HF_READ_TOKEN, with HF_TOKEN kept as a fallback for older setups. */
export function getDzdToken() {
  return process.env.HF_READ_TOKEN || process.env.HF_TOKEN || undefined;
}

/** DZD_AI_BASE_URL may be the Space URL with or without the /v1 suffix. */
export function getDzdBaseUrl() {
  const url = (process.env.DZD_AI_BASE_URL || DEFAULT_SPACE_URL).replace(
    /\/+$/,
    ""
  );
  return url.endsWith("/v1") ? url : `${url}/v1`;
}

export function getDzdMaxTokens() {
  const value = Number.parseInt(process.env.DZD_AI_MAX_TOKENS ?? "", 10);
  if (!Number.isFinite(value) || value <= 0) {
    return DEFAULT_MAX_TOKENS;
  }
  return Math.min(value, DZD_MAX_TOKENS_CAP);
}

export type DzdToolStep = { tool: string; ms?: number };

export type DzdTelemetry = {
  toolSteps?: DzdToolStep[];
  totalMs?: number;
};

export type DzdStreamHooks = {
  /** A status line from a `dzd_progress` chunk (not answer text). */
  onProgress?: (text: string) => void;
  /** `dzd_tool_steps` / `dzd_timing`, whenever a chunk carries them. */
  onTelemetry?: (telemetry: DzdTelemetry) => void;
};

/* -------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteMs(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function cleanProgressText(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > MAX_PROGRESS_CHARS
    ? `${text.slice(0, MAX_PROGRESS_CHARS - 1)}…`
    : text;
}

function parseToolSteps(value: unknown): DzdToolStep[] | undefined {
  if (!Array.isArray(value)) {
    return;
  }
  const steps: DzdToolStep[] = [];
  for (const item of value.slice(0, MAX_TOOL_STEPS)) {
    if (isRecord(item) && typeof item.tool === "string" && item.tool.trim()) {
      steps.push({
        ms: finiteMs(item.ms),
        tool: item.tool.trim().slice(0, MAX_TOOL_NAME_CHARS),
      });
    }
  }
  return steps;
}

/** Reads the optional DZD telemetry fields of one parsed chunk. */
export function extractDzdTelemetry(
  chunk: Record<string, unknown>
): DzdTelemetry | null {
  const timing = isRecord(chunk.dzd_timing) ? chunk.dzd_timing : undefined;
  const toolSteps =
    parseToolSteps(chunk.dzd_tool_steps) ?? parseToolSteps(timing?.tools);
  const totalMs = finiteMs(timing?.total_ms);
  if (!toolSteps && totalMs === undefined) {
    return null;
  }
  return { toolSteps, totalMs };
}

function progressTextOf(chunk: Record<string, unknown>) {
  const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
  const first = isRecord(choices[0]) ? choices[0] : undefined;
  const delta = isRecord(first?.delta) ? first.delta : undefined;
  return cleanProgressText(delta?.content);
}

/**
 * A streaming filter for the Space's Server-Sent Events. Events are parsed
 * incrementally, so network chunks may split lines and events anywhere.
 *
 * - `data: [DONE]` and normal completion chunks are passed through unchanged.
 * - Chunks with top-level `dzd_progress: true` go to `onProgress` and are
 *   dropped, so status text never becomes part of the answer.
 * - `dzd_tool_steps` / `dzd_timing` go to `onTelemetry`; chunks carrying
 *   only telemetry (no `choices`) are dropped.
 */
export function createDzdSseFilter(
  hooks: DzdStreamHooks = {},
  onEnd?: () => void
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  const handleEvent = (
    rawEvent: string,
    controller: TransformStreamDefaultController<Uint8Array>
  ) => {
    const dataLines: string[] = [];
    for (const line of rawEvent.split("\n")) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(line.startsWith("data: ") ? 6 : 5));
      }
    }
    // Comments (keep-alive pings) and events without data are not needed.
    if (dataLines.length === 0) {
      return;
    }

    const data = dataLines.join("\n");
    const forward = () =>
      controller.enqueue(encoder.encode(`data: ${data}\n\n`));

    if (data.trim() === "[DONE]") {
      forward();
      return;
    }

    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      // Let the AI SDK report malformed data as a stream error.
      forward();
      return;
    }
    if (!isRecord(chunk)) {
      forward();
      return;
    }

    const telemetry = extractDzdTelemetry(chunk);
    if (telemetry) {
      hooks.onTelemetry?.(telemetry);
    }

    if (chunk.dzd_progress === true) {
      const text = progressTextOf(chunk);
      if (text) {
        hooks.onProgress?.(text);
      }
      return;
    }

    if (!Array.isArray(chunk.choices) && !("error" in chunk)) {
      return;
    }
    forward();
  };

  const drainEvents = (
    controller: TransformStreamDefaultController<Uint8Array>
  ) => {
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      handleEvent(buffer.slice(0, boundary), controller);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
    }
  };

  return new TransformStream({
    flush(controller) {
      onEnd?.();
      buffer += decoder.decode().replace(/\r\n?/g, "\n");
      drainEvents(controller);
      if (buffer.trim()) {
        handleEvent(buffer, controller);
      }
      buffer = "";
    },
    transform(bytes, controller) {
      buffer += decoder.decode(bytes, { stream: true });
      // Normalise line endings, but keep a trailing "\r" until the next
      // chunk shows whether it is part of "\r\n".
      const pendingCr = buffer.endsWith("\r");
      buffer = (pendingCr ? buffer.slice(0, -1) : buffer).replace(
        /\r\n?/g,
        "\n"
      );
      drainEvents(controller);
      if (pendingCr) {
        buffer += "\r";
      }
    },
  });
}

/**
 * fetch wrapper for the Space: keeps basic chat requests free of `tools`,
 * respects the max_tokens clamp, enforces the upstream time limit, and runs
 * streaming responses through the DZD event filter.
 */
export function createDzdFetch(hooks: DzdStreamHooks = {}): typeof fetch {
  return async (input, init) => {
    let body = init?.body;
    if (typeof body === "string") {
      try {
        const json = JSON.parse(body);
        if (isRecord(json)) {
          // Web search runs inside the Space. Website-owned function calls
          // are a separate flow and are not used with this model.
          json.tools = undefined;
          json.tool_choice = undefined;
          if (typeof json.max_tokens === "number") {
            json.max_tokens = Math.min(json.max_tokens, DZD_MAX_TOKENS_CAP);
          }
          body = JSON.stringify(json);
        }
      } catch {
        /* send the body as-is */
      }
    }

    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(new DzdTimeoutError()),
      DZD_TIMEOUT_MS
    );
    timer.unref?.();
    const clearTimer = () => clearTimeout(timer);
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeout.signal])
      : timeout.signal;

    let response: Response;
    try {
      response = await fetch(input, { ...init, body, signal });
    } catch (error) {
      clearTimer();
      throw error;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (
      !response.ok ||
      !response.body ||
      !contentType.includes("text/event-stream")
    ) {
      return response;
    }

    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    const filter = createDzdSseFilter(hooks, clearTimer);
    return new Response(response.body.pipeThrough(filter), {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  };
}

/** A DZD Learn AI language model for one request, wired to `hooks`. */
export function createDzdModel(hooks: DzdStreamHooks = {}) {
  const token = getDzdToken();
  if (!token) {
    throw new Error("Missing HF_READ_TOKEN environment variable");
  }
  const provider = createOpenAICompatible({
    apiKey: token,
    baseURL: getDzdBaseUrl(),
    fetch: createDzdFetch(hooks),
    name: "dzd",
  });
  return provider(process.env.DZD_AI_MODEL || DEFAULT_MODEL);
}
