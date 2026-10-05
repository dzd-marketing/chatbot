import "server-only";

import { createMCPClient } from "@ai-sdk/mcp";
import { tool } from "ai";
import { z } from "zod";

/**
 * Web search + page reading for DZD AI, backed by the public "Tools MCP"
 * Hugging Face Space (alyxsis/Tools), reached over MCP Streamable HTTP.
 *
 * The Space exposes exactly two MCP tools: Tools_Web_Search and
 * Tools_Web_Fetch. We wrap them in our own AI SDK tools instead of passing
 * the raw MCP tool set to the model so we can:
 * - expose a small, student-safe schema (text/news search only),
 * - enforce timeouts (the Space may be cold-starting or rate limited),
 * - cap how much page text goes back into the model context, and
 * - return a readable `{ error }` instead of failing the whole chat turn.
 *
 * No credentials are needed. The Space applies global rate limits
 * (30 searches / 60 fetches per minute) and its own SSRF protection;
 * our server never fetches the target URLs itself.
 */
const MCP_URL = "https://alyxsis-tools.hf.space/gradio_api/mcp/";
const SEARCH_TOOL = "Tools_Web_Search";
const FETCH_TOOL = "Tools_Web_Fetch";

// The Space gives each search a 12s budget and each fetch ~15s; leave
// headroom for MCP session setup and HF queueing.
const CALL_TIMEOUT_MS = 25_000;
const MAX_SEARCH_CHARS = 6000;
const DEFAULT_FETCH_CHARS = 6000;
const MAX_FETCH_CHARS = 12_000;
const FOOTER_ALLOWANCE = 600;

class WebToolError extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new WebToolError(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function truncate(text: string, max: number) {
  if (text.length <= max) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, max).trimEnd()}\n…`, truncated: true };
}

function extractText(result: unknown): { text: string; isError: boolean } {
  if (result && typeof result === "object" && "content" in result) {
    const { content, isError } = result as {
      content: Array<{ type: string; text?: string }>;
      isError?: boolean;
    };
    const text = content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n")
      .trim();
    return { isError: Boolean(isError), text };
  }
  if (result && typeof result === "object" && "toolResult" in result) {
    const value = (result as { toolResult: unknown }).toolResult;
    return {
      isError: false,
      text: typeof value === "string" ? value : JSON.stringify(value),
    };
  }
  return { isError: true, text: "" };
}

async function callWebTool(
  name: string,
  args: Record<string, unknown>,
  abortSignal?: AbortSignal
) {
  const signal = abortSignal
    ? AbortSignal.any([abortSignal, AbortSignal.timeout(CALL_TIMEOUT_MS)])
    : AbortSignal.timeout(CALL_TIMEOUT_MS);

  const run = async () => {
    const client = await createMCPClient({
      clientName: "dzd-learn",
      transport: {
        // Tie every MCP HTTP request (including session setup) to the call's
        // signal, so a stalled Space never leaves a dangling connection.
        fetch: (input, init) =>
          fetch(input, {
            ...init,
            signal: init?.signal
              ? AbortSignal.any([init.signal, signal])
              : signal,
          }),
        redirect: "follow",
        type: "http",
        url: MCP_URL,
      },
    });
    try {
      const result = await client.callTool({
        arguments: args,
        name,
        options: { signal, timeout: CALL_TIMEOUT_MS },
      });
      return extractText(result);
    } finally {
      await client.close().catch(() => undefined);
    }
  };

  let output: { text: string; isError: boolean };
  try {
    // Belt and braces: the race guarantees the tool resolves on time even if
    // a request ignores the abort signal.
    output = await withTimeout(
      run(),
      CALL_TIMEOUT_MS,
      "The web service took too long to respond."
    );
  } catch (error) {
    if (abortSignal?.aborted) {
      throw new WebToolError("The web request was cancelled.", {
        cause: error,
      });
    }
    if (signal.aborted) {
      throw new WebToolError("The web service took too long to respond.", {
        cause: error,
      });
    }
    throw error;
  }
  const { text, isError } = output;

  if (isError || !text) {
    throw new WebToolError(text || "The web service returned no content.");
  }
  // The Space reports its own failures as plain text (rate limits, blocked
  // URLs, unsupported content types) rather than as MCP errors.
  if (/^error\b/i.test(text)) {
    throw new WebToolError(text.slice(0, 300));
  }
  return text;
}

function toErrorMessage(error: unknown) {
  if (error instanceof WebToolError) {
    return error.message;
  }
  if (error instanceof Error && error.name === "AbortError") {
    return "The web request was cancelled or timed out.";
  }
  return "The web service is unavailable right now.";
}

export const webSearch = tool({
  description:
    "Search the web. Returns titles, URLs and snippets for the top results. Use for past papers, marking schemes, syllabi, timetables, news and anything time-sensitive or that needs a source. Use site: in the query to target a website (e.g. 'site:pastpapers.wiki 2019 A/L Physics'). Follow up with webFetch to read a result.",
  execute: async (input, { abortSignal }) => {
    try {
      const text = await callWebTool(
        SEARCH_TOOL,
        // Gradio's MCP bridge treats parameters with empty/zero defaults as
        // required, so every argument is always sent explicitly.
        {
          backend: "auto",
          date_filter: input.dateFilter ?? "any",
          max_results: input.maxResults ?? 5,
          offset: 0,
          page: 1,
          query: input.query,
          search_type: input.type ?? "text",
        },
        abortSignal
      );
      const { text: results, truncated } = truncate(text, MAX_SEARCH_CHARS);
      return { query: input.query, results, truncated };
    } catch (error) {
      return { error: toErrorMessage(error), query: input.query };
    }
  },
  inputSchema: z.object({
    dateFilter: z
      .enum(["any", "day", "week", "month", "year"])
      .optional()
      .describe("Only return results from this period. Defaults to any."),
    maxResults: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("Number of results, 1-10. Defaults to 5."),
    query: z.string().trim().min(1).max(300).describe("The search query."),
    type: z
      .enum(["text", "news"])
      .optional()
      .describe("'text' for web results (default) or 'news' for recent news."),
  }),
});

export const webFetch = tool({
  description:
    "Read a public web page and return its main content as Markdown, including links. Use it on URLs from webSearch results or URLs the student gives you. It cannot read PDFs or images. Share PDF links with the student directly instead of fetching them.",
  execute: async (input, { abortSignal }) => {
    const maxChars = input.maxChars ?? DEFAULT_FETCH_CHARS;
    try {
      const text = await callWebTool(
        FETCH_TOOL,
        // All arguments sent explicitly (see webSearch).
        {
          max_chars: maxChars,
          mode: "Markdown Mode",
          offset: input.offset ?? 0,
          strip_selectors: "",
          url: input.url,
        },
        abortSignal
      );
      // The Space already honours max_chars and appends a "Next cursor"
      // footer for long pages; this is only a safety cap that leaves room
      // for that footer.
      const { text: content, truncated } = truncate(
        text,
        maxChars + FOOTER_ALLOWANCE
      );
      return { content, truncated, url: input.url };
    } catch (error) {
      return { error: toErrorMessage(error), url: input.url };
    }
  },
  inputSchema: z.object({
    maxChars: z
      .number()
      .int()
      .min(500)
      .max(MAX_FETCH_CHARS)
      .optional()
      .describe(
        `Maximum characters to return. Defaults to ${DEFAULT_FETCH_CHARS}.`
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        "Character offset to continue a long page. Use the 'Next cursor' value from a previous result."
      ),
    url: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .describe("The full http(s) URL of the page to read."),
  }),
});

export const webToolNames = ["webSearch", "webFetch"] as const;
