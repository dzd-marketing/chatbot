import "server-only";

import { tool } from "ai";
import { z } from "zod";
import {
  DocumentReadError,
  detectDocumentKind,
  extractDocumentText,
} from "@/lib/documents/extract";
import {
  directDownloadUrl,
  SafeFetchError,
  safeFetch,
} from "@/lib/net/safe-fetch";

/**
 * Reads a PDF or Word file from a link (past papers, marking schemes,
 * syllabi). Google Drive / Docs share links are turned into direct
 * downloads. Long documents are read in parts with `offset`.
 */

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const DEFAULT_CHARS = 12_000;
const MAX_CHARS = 20_000;
const CACHE_SIZE = 20;
const CACHE_TTL_MS = 30 * 60 * 1000;

type CachedDocument = {
  at: number;
  pages?: number;
  text: string;
  title: string;
};

/** Recently read documents (per server instance), so paging is cheap. */
const cache = new Map<string, CachedDocument>();

function remember(url: string, document: CachedDocument) {
  cache.delete(url);
  cache.set(url, document);
  while (cache.size > CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    cache.delete(oldest);
  }
}

function fileNameFrom(url: string, headers: Headers) {
  const disposition = headers.get("content-disposition") ?? "";
  const match =
    disposition.match(/filename\*=UTF-8''([^;]+)/i) ??
    disposition.match(/filename="?([^";]+)"?/i);
  if (match) {
    try {
      return decodeURIComponent(match[1]).trim();
    } catch {
      return match[1].trim();
    }
  }
  try {
    const last = new URL(url).pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : "";
  } catch {
    return "";
  }
}

async function loadDocument(
  url: string,
  signal?: AbortSignal
): Promise<CachedDocument> {
  const cached = cache.get(url);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return cached;
  }

  const response = await safeFetch(directDownloadUrl(url), {
    maxBytes: MAX_FILE_BYTES,
    signal,
    timeoutMs: 25_000,
  });
  if (!response.ok) {
    throw new SafeFetchError(
      response.status === 404 || response.status === 410
        ? "This link is broken (file not found)."
        : `The website refused the request (HTTP ${response.status}).`
    );
  }
  const data = response.body ?? new Uint8Array();
  const mediaType = response.headers.get("content-type") ?? "";
  const name = fileNameFrom(response.url, response.headers);
  const kind = detectDocumentKind({ data, mediaType, name });

  if (kind === "unsupported" && /html/i.test(mediaType)) {
    throw new DocumentReadError(
      response.url.includes("google.com")
        ? "Google Drive didn't give the file directly (it may be private or too large to scan). Share the link with the student instead."
        : "This link is a web page, not a PDF or Word file. Use webFetch to read web pages."
    );
  }

  const { pages, text } = await extractDocumentText({ data, mediaType, name });
  const document = { at: Date.now(), pages, text, title: name || url };
  remember(url, document);
  return document;
}

export const readDocument = tool({
  description:
    "Read the text of a PDF or Word (.docx) file from a link, such as a past paper, marking scheme or syllabus. Works with direct file links and Google Drive / Google Docs share links. Long documents are returned in parts: use the nextOffset value to continue. Scanned PDFs (images only) can't be read.",
  execute: async (input, { abortSignal }) => {
    const maxChars = input.maxChars ?? DEFAULT_CHARS;
    const offset = input.offset ?? 0;
    try {
      const document = await loadDocument(input.url, abortSignal);
      const total = document.text.length;
      if (offset >= total) {
        return {
          error: `Offset ${offset} is past the end of the document (${total} characters).`,
          url: input.url,
        };
      }
      const content = document.text.slice(offset, offset + maxChars);
      const end = offset + content.length;
      return {
        content,
        nextOffset: end < total ? end : undefined,
        pages: document.pages,
        title: document.title,
        totalChars: total,
        truncated: end < total,
        url: input.url,
      };
    } catch (error) {
      const message =
        error instanceof DocumentReadError || error instanceof SafeFetchError
          ? error.message
          : "The document couldn't be read right now.";
      return { error: message, url: input.url };
    }
  },
  inputSchema: z.object({
    maxChars: z
      .number()
      .int()
      .min(1000)
      .max(MAX_CHARS)
      .optional()
      .describe(`Maximum characters to return. Defaults to ${DEFAULT_CHARS}.`),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Where to continue a long document (nextOffset from before)."),
    url: z
      .url({ protocol: /^https?$/ })
      .max(2000)
      .describe("Link to the PDF or Word file (or a Google Drive share link)."),
  }),
});
