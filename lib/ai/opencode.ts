import "server-only";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { ReasoningLevel } from "./models";

const DEFAULT_BASE_URL = "https://danuka21-opencode-web.hf.space";
const DEFAULT_MODEL = "opencode/mimo-v2.6-flash-free";
const SESSION_RESET_TIMEOUT_MS = 15_000;

type OpenCodeBody = Record<string, unknown> & {
  messages?: unknown;
  model?: unknown;
};

type OpenCodeModelOptions = {
  reasoningLevel: ReasoningLevel;
  sessionKey: string;
};

function getOpenCodeHfToken() {
  return process.env.OPENCODE_HF_TOKEN?.trim() || undefined;
}

function getOpenCodeBridgeKey() {
  return process.env.BRIDGE_API_KEY?.trim() || undefined;
}

export function hasOpenCodeCredentials() {
  return Boolean(getOpenCodeHfToken() && getOpenCodeBridgeKey());
}

/** Auto-enable when the two server-side credentials exist; keep an opt-out. */
export function isOpenCodeEnabled() {
  return process.env.OPENCODE_DISABLED !== "true" && hasOpenCodeCredentials();
}

function openCodeBaseUrl() {
  const configured = process.env.OPENCODE_BASE_URL?.trim() || DEFAULT_BASE_URL;
  const withoutTrailingSlash = configured.replace(/\/+$/, "");
  const withoutVersion = withoutTrailingSlash.replace(/\/v1$/i, "");
  return `${withoutVersion}/v1`;
}

function openCodeModelId() {
  return process.env.OPENCODE_MODEL?.trim() || DEFAULT_MODEL;
}

/** Separate chat and voice prompts because the Space applies system text on turn one. */
export function openCodeSessionKey(
  chatId: string,
  mode: "chat" | "voice" = "chat"
) {
  return mode === "voice"
    ? `thestudent:${chatId}:voice`
    : `thestudent:${chatId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFailureSentinel(value: unknown) {
  return typeof value === "string" && /^\s*\[all models failed\]/i.test(value);
}

function outputContainsFailureSentinel(value: unknown) {
  if (!isRecord(value)) {
    return false;
  }
  const choices = Array.isArray(value.choices) ? value.choices : [];
  return choices.some((choice) => {
    if (!isRecord(choice)) {
      return false;
    }
    const delta = isRecord(choice.delta) ? choice.delta : undefined;
    const message = isRecord(choice.message) ? choice.message : undefined;
    return (
      isFailureSentinel(delta?.content) || isFailureSentinel(message?.content)
    );
  });
}

function sseEventHasUpstreamFailure(frame: string) {
  const data = frame
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n");
  if (!data) {
    return false;
  }
  try {
    return outputContainsFailureSentinel(JSON.parse(data));
  } catch {
    return false;
  }
}

async function sanitizeOpenCodeError(response: Response) {
  if (response.body) {
    await response.body.cancel().catch(() => undefined);
  }
  const headers = new Headers();
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    headers.set("retry-after", retryAfter);
  }
  return Response.json(
    { error: { message: "OpenCode Space request failed" } },
    {
      headers,
      status: response.status,
      statusText: response.statusText,
    }
  );
}

/** Convert the Space's HTTP-200 failure sentinel into an upstream error. */
async function failOnBridgeSentinel(response: Response): Promise<Response> {
  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok || !response.body) {
    return response;
  }

  if (contentType.includes("text/event-stream")) {
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    let pending = "";
    const stream = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        flush(controller) {
          pending += decoder.decode();
          if (pending && sseEventHasUpstreamFailure(pending)) {
            controller.error(
              new Error("OpenCode Space models could not answer")
            );
            return;
          }
          if (pending) {
            controller.enqueue(encoder.encode(pending));
          }
        },
        transform(chunk, controller) {
          pending += decoder.decode(chunk, { stream: true });
          while (true) {
            const boundary = /\r?\n\r?\n/.exec(pending);
            if (!boundary || boundary.index === undefined) {
              break;
            }
            const [separator = ""] = boundary;
            if (!separator) {
              break;
            }
            const frame = pending.slice(0, boundary.index);
            pending = pending.slice(boundary.index + separator.length);
            if (sseEventHasUpstreamFailure(frame)) {
              controller.error(
                new Error("OpenCode Space models could not answer")
              );
              return;
            }
            controller.enqueue(encoder.encode(`${frame}${separator}`));
          }
        },
      })
    );
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    headers.delete("content-encoding");
    return new Response(stream, {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  }

  if (contentType.includes("application/json")) {
    const body: unknown = await response
      .clone()
      .json()
      .catch(() => null);
    if (outputContainsFailureSentinel(body)) {
      return Response.json(
        { error: { message: "OpenCode Space models could not answer" } },
        { status: 502 }
      );
    }
  }

  return response;
}

function createBridgeFetch({
  reasoningLevel,
  sessionKey,
}: OpenCodeModelOptions) {
  const bridgeKey = getOpenCodeBridgeKey();
  if (!bridgeKey) {
    throw new Error("Missing BRIDGE_API_KEY environment variable");
  }

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    let body = init?.body;
    if (typeof body === "string") {
      try {
        const parsed: unknown = JSON.parse(body);
        if (isRecord(parsed)) {
          const json = parsed as OpenCodeBody;
          json.model = openCodeModelId();
          json.user = sessionKey;
          // The user-role Space key independently enforces this policy. Keep
          // the request explicit too: the website's tools never reach Space.
          json.tools = false;
          json.tool_choice = "none";
          json.reasoning =
            reasoningLevel === "off"
              ? false
              : reasoningLevel === "high"
                ? "medium"
                : reasoningLevel;
          json.x_opencode = {
            ...(isRecord(json.x_opencode) ? json.x_opencode : {}),
            agent: "tutor",
            attempt_timeout: 25,
            emit_reasoning: false,
            emit_tool_calls: false,
            system_mode: "field",
            timeout: 120,
          };
          body = JSON.stringify(json);
        }
      } catch {
        // Leave a non-JSON body untouched; the provider will report its error.
      }
    }

    const headers = new Headers(init?.headers);
    headers.set("X-API-Key", bridgeKey);
    headers.delete("content-length");
    const response = await fetch(input, { ...init, body, headers });
    if (!response.ok) {
      return sanitizeOpenCodeError(response);
    }
    return failOnBridgeSentinel(response);
  };
}

/** A private Hugging Face Space model, called only by the server-side router. */
export function createOpenCodeModel(
  options: OpenCodeModelOptions
): LanguageModelV4 {
  const hfToken = getOpenCodeHfToken();
  if (!hfToken) {
    throw new Error("Missing OPENCODE_HF_TOKEN environment variable");
  }

  const provider = createOpenAICompatible({
    apiKey: hfToken,
    baseURL: openCodeBaseUrl(),
    fetch: createBridgeFetch(options),
    name: "opencode",
  });
  return provider(openCodeModelId());
}

async function resetOneOpenCodeSession(sessionKey: string) {
  const hfToken = getOpenCodeHfToken();
  const bridgeKey = getOpenCodeBridgeKey();
  if (!hfToken || !bridgeKey) {
    return;
  }

  let response: Response;
  try {
    response = await fetch(`${openCodeBaseUrl()}/session/reset`, {
      body: JSON.stringify({ user: sessionKey }),
      headers: {
        Authorization: `Bearer ${hfToken}`,
        "Content-Type": "application/json",
        "X-API-Key": bridgeKey,
      },
      method: "POST",
      signal: AbortSignal.timeout(SESSION_RESET_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error("Could not verify deletion of the OpenCode session", {
      cause: error,
    });
  }

  if (!response.ok) {
    throw new Error("Could not verify deletion of the OpenCode session");
  }

  let result: unknown;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error("Could not verify deletion of the OpenCode session", {
      cause: error,
    });
  }

  if (
    !isRecord(result) ||
    result.deletion_verified !== true ||
    (Array.isArray(result.failed) && result.failed.length > 0) ||
    (typeof result.failed === "number" && result.failed > 0)
  ) {
    throw new Error("Could not verify deletion of the OpenCode session");
  }
}

/** Delete Space-side sessions before their corresponding website chats. */
export async function resetOpenCodeSessionsForChats(chatIds: string[]) {
  if (chatIds.length === 0) {
    return;
  }
  if (!hasOpenCodeCredentials()) {
    // Legacy explicit-enable deployments may still have Space sessions; never
    // silently delete only the website record if their reset keys went missing.
    if (process.env.OPENCODE_ENABLED === "true") {
      throw new Error("OpenCode session credentials are not configured");
    }
    return;
  }

  const sessionKeys = [...new Set(chatIds)].flatMap((chatId) => [
    openCodeSessionKey(chatId, "chat"),
    openCodeSessionKey(chatId, "voice"),
  ]);
  let next = 0;
  const workerCount = Math.min(5, sessionKeys.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (next < sessionKeys.length) {
      const sessionKey = sessionKeys[next];
      next += 1;
      // biome-ignore lint/performance/noAwaitInLoops: each worker limits concurrent resets to five.
      await resetOneOpenCodeSession(sessionKey);
    }
  });
  const results = await Promise.allSettled(workers);
  if (results.some((result) => result.status === "rejected")) {
    throw new Error("Could not verify deletion of the OpenCode session");
  }
}
